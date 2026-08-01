import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { CacheManager } from '../cache/cache-manager.mjs';
import { fingerprint, sha256 } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';
import { buildCanonicalModel, extractionFingerprint, indexModel, mergeCanonicalModels, modelView } from '../model/canonical.mjs';
import { buildBm25, searchBm25 } from '../search/bm25.mjs';
import { buildSemanticIndex, createEmbedder, reciprocalRankFusion, searchSemantic } from '../search/semantic.mjs';
import { loadPdfSource } from '../security/source.mjs';
import { applyResultBudget, resolveBudget } from './budget.mjs';
import { CursorCodec } from './cursor.mjs';
import { runExtractionSubprocess, runRenderSubprocess } from './subprocess.mjs';
import { timingMark } from './timing.mjs';

const dependencyFingerprint = fingerprint({
    node: process.versions.node.split('.')[0],
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
});

function stateKey(documentId, generation) {
    return `${documentId}:${generation}`;
}

function sortElements(elements) {
    return [...elements].sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
}

function missingPageIntervals(totalPages, processedPages) {
    const present = new Set(processedPages);
    const intervals = [];
    let start = null;
    for (let page = 1; page <= totalPages + 1; page += 1) {
        if (page <= totalPages && !present.has(page)) {
            start ??= page;
        } else if (start !== null) {
            intervals.push({ start, end: page - 1 });
            start = null;
        }
    }
    return intervals;
}

export class DocumentManager {
    constructor(config, options = {}) {
        this.config = config;
        this.cache = options.cache || new CacheManager(config);
        this.embedderFactory = options.embedderFactory || createEmbedder;
        this.injectedEmbedder = options.embedder || null;
        this.states = new Map();
        this.currentGeneration = new Map();
        this.closedStates = new Set();
        this.closedHandles = new Map();
    }

    async init() {
        await this.cache.init();
        const keyring = this.cache.cursorKeyring();
        this.cursors = new CursorCodec({ ...keyring, ttlMs: this.config.cursorTtlMs });
        return this;
    }

    generationForCurrentConfig(config = this.config) {
        return extractionFingerprint(config, dependencyFingerprint);
    }

    async activate(model, pdfBytes, bm25, semantic = null, { persisted = false, extractionConfig = this.config } = {}) {
        const key = stateKey(model.documentId, model.extractionFingerprint);
        const existing = this.states.get(key);
        if (existing) return existing;
        if (!model.partial && !persisted) await this.cache.saveGeneration(model, pdfBytes, bm25, semantic);
        const leaseId = !model.partial ? await this.cache.acquireLease(model.documentId, model.extractionFingerprint) : null;
        const state = {
            model,
            pdfBytes,
            bm25,
            semantic,
            embedder: null,
            indexes: indexModel(model),
            derivedAssets: new Map(),
            leaseId,
            handles: new Map(),
            operationCount: 0,
            operationWaiters: [],
            closing: false,
            persisted: persisted || !model.partial,
            extractionConfig,
        };
        this.states.set(key, state);
        this.closedStates.delete(key);
        this.currentGeneration.set(model.documentId, model.extractionFingerprint);
        return state;
    }

    sourceDescriptor(loaded, sourceLabel) {
        const supplied = typeof sourceLabel === 'string' ? sourceLabel.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) : '';
        const sourceKind = loaded.sourceUrl ? 'https' : 'local';
        const basename = loaded.sourcePath ? path.basename(loaded.sourcePath) : null;
        const host = loaded.sourceUrl ? new URL(loaded.sourceUrl).host : null;
        return {
            sourceId: randomUUID(),
            sourceKind,
            sourceLabel: supplied || basename || host || 'PDF source',
            basename,
            host,
            callerProvidedLabel: Boolean(supplied),
        };
    }

    addSourceHandle(state, descriptor) {
        state.handles.set(descriptor.sourceId, descriptor);
        this.closedHandles.delete(descriptor.sourceId);
        this.closedStates.delete(stateKey(state.model.documentId, state.model.extractionFingerprint));
        return descriptor;
    }

    async open(args) {
        if (args.cursor) return this.continueOpen(args);
        const loaded = await loadPdfSource(args.source, this.config);
        const descriptor = this.sourceDescriptor(loaded, args.sourceLabel);
        const documentId = `doc_${sha256(loaded.bytes)}`;
        const extractionConfig = { ...this.config, ocrPolicy: args.ocrPolicy || this.config.ocrPolicy };
        const generation = this.generationForCurrentConfig(extractionConfig);
        const key = stateKey(documentId, generation);
        const active = this.states.get(key);
        if (active) {
            if (active.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            if (args.refresh) throw new PdfDecompilerError('active_generation', 'Close the active extraction generation before refreshing it.');
            this.addSourceHandle(active, descriptor);
            return this.openResult(active, descriptor, { cacheHit: true });
        }
        if (!args.refresh && this.config.cache.mode === 'persistent') {
            const cached = await this.cache.loadGeneration(documentId, generation);
            if (cached) {
                const state = await this.activate(cached.model, cached.pdfBytes, cached.bm25 || buildBm25(cached.model), cached.semantic, { persisted: true, extractionConfig });
                this.addSourceHandle(state, descriptor);
                return this.openResult(state, descriptor, { cacheHit: true });
            }
        }
        if (args.refresh && this.config.cache.mode === 'persistent' && await this.cache.generationExists(documentId, generation)) {
            await this.cache.deleteGeneration(documentId, generation, { reason: 'deleted' });
        }
        const extracted = await runExtractionSubprocess(loaded.bytes, extractionConfig, { pages: args.pages, maxImageDim: args.maxImageDimension });
        const extractedPages = extracted.result.pages.map(page => page.page);
        const missing = missingPageIntervals(extracted.result.totalPages, extractedPages);
        if (!extracted.result.partial && missing.length) {
            extracted.result.partial = {
                timedOut: false,
                selectionIncomplete: true,
                nextPage: missing[0].start,
                processedPages: extractedPages.length,
                remainingPages: extracted.result.totalPages - extractedPages.length,
            };
        }
        const model = buildCanonicalModel(loaded.bytes, extracted.result, extractionConfig, dependencyFingerprint);
        const bm25 = buildBm25(model);
        const state = await this.activate(model, loaded.bytes, bm25, null, { extractionConfig });
        this.addSourceHandle(state, descriptor);
        state.diagnostics = extracted.diagnostics;
        return this.openResult(state, descriptor, { cacheHit: false });
    }

    openResult(state, descriptor, { cacheHit }) {
        const nextCursor = state.model.partial?.nextPage
            ? this.cursors.encode({
                documentId: state.model.documentId,
                extractionFingerprint: state.model.extractionFingerprint,
                operation: 'pdf_open',
                argumentsValue: { documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, sourceId: descriptor.sourceId },
                position: state.model.partial.nextPage,
            }) : null;
        return {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            totalPages: state.model.totalPages,
            processedPages: state.model.processedPages,
            complete: !state.model.partial,
            nextCursor,
            cacheHit,
            sourceId: descriptor.sourceId,
            sourceDescriptor: descriptor,
            cache: this.cache.status(state.model),
            diagnostics: state.diagnostics || null,
        };
    }

    async continueOpen(args) {
        if (!args.documentId || !args.extractionFingerprint || !args.sourceId) throw new PdfDecompilerError('invalid_cursor_context', 'Continuation requires documentId, extractionFingerprint, and sourceId.');
        const state = await this.requireState(args.documentId, args.extractionFingerprint);
        const descriptor = state.handles.get(args.sourceId);
        if (!descriptor) throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
        const nextPage = this.cursors.decode(args.cursor, {
            documentId: args.documentId,
            extractionFingerprint: args.extractionFingerprint,
            operation: 'pdf_open',
            argumentsValue: { documentId: args.documentId, extractionFingerprint: args.extractionFingerprint, sourceId: args.sourceId },
        });
        if (nextPage !== state.model.partial?.nextPage) throw new PdfDecompilerError('stale_cursor', 'The decomposition cursor no longer matches document state.');
        const pages = missingPageIntervals(state.model.totalPages, state.model.pages.map(page => page.number));
        const extracted = await runExtractionSubprocess(state.pdfBytes, state.extractionConfig, {
            pages,
            maxImageDim: args.maxImageDimension,
        });
        const incoming = buildCanonicalModel(state.pdfBytes, extracted.result, state.extractionConfig, dependencyFingerprint);
        state.model = mergeCanonicalModels(state.model, incoming);
        const missing = missingPageIntervals(state.model.totalPages, state.model.pages.map(page => page.number));
        if (!state.model.partial && missing.length) {
            state.model.partial = {
                timedOut: false,
                selectionIncomplete: true,
                nextPage: missing[0].start,
                processedPages: state.model.pages.length,
                remainingPages: missing.reduce((sum, interval) => sum + interval.end - interval.start + 1, 0),
            };
        }
        state.bm25 = buildBm25(state.model);
        state.indexes = indexModel(state.model);
        state.diagnostics = extracted.diagnostics;
        if (!state.model.partial && !state.persisted) {
            await this.cache.saveGeneration(state.model, state.pdfBytes, state.bm25, state.semantic);
            state.leaseId = await this.cache.acquireLease(state.model.documentId, state.model.extractionFingerprint);
            state.persisted = true;
        }
        return this.openResult(state, descriptor, { cacheHit: false });
    }

    async requireState(documentId, generation = null) {
        const selectedGeneration = generation || this.currentGeneration.get(documentId);
        if (!selectedGeneration) throw new PdfDecompilerError('closed_document', 'The document is not open.');
        if (this.closedStates.has(stateKey(documentId, selectedGeneration))) throw new PdfDecompilerError('closed_document', 'The document is closed. Open it again before using document tools.');
        const state = this.states.get(stateKey(documentId, selectedGeneration));
        if (state) {
            if (state.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            return state;
        }
        if (this.config.cache.mode !== 'persistent') throw new PdfDecompilerError('expired_process_state', 'The process-local document state has expired.');
        const cached = await this.cache.loadGeneration(documentId, selectedGeneration);
        if (!cached) throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
        return this.activate(cached.model, cached.pdfBytes, cached.bm25 || buildBm25(cached.model), cached.semantic, { persisted: true });
    }

    async withOperation(documentId, generation, callback) {
        const state = await this.requireState(documentId, generation);
        state.operationCount += 1;
        try {
            return await callback(state);
        } finally {
            state.operationCount -= 1;
            if (state.operationCount === 0) state.operationWaiters.splice(0).forEach(resolve => resolve());
        }
    }

    async waitForOperations(state) {
        if (state.operationCount === 0) return;
        await new Promise(resolve => state.operationWaiters.push(resolve));
    }

    async documentInfo(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const counts = Object.fromEntries(['block', 'table', 'figure', 'annotation', 'link'].map(type => [type, state.model.elements.filter(item => item.type === type).length]));
        const { elements: _elements, assets: _assets, ...document } = modelView(state.model);
        return {
            ...document,
            counts,
            activeSources: [...state.handles.values()],
            cache: { ...this.cache.status(state.model), activeLeases: await this.cache.activeLeases(state.model.documentId, state.model.extractionFingerprint) },
            resourceLifetime: this.config.cache.mode === 'persistent' ? 'until_generation_deleted_or_evicted' : this.config.cache.mode === 'ephemeral' ? 'owning_process_and_document_lifetime' : 'active_document_lifetime',
        };
        });
    }

    async search(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const strategy = args.strategy || 'full_text';
        const options = { pages: args.pages, elementTypes: args.elementTypes };
        const warnings = [];
        const bm25Results = searchBm25(state.bm25, args.query, options);
        let results = bm25Results;
        if (strategy === 'semantic' || strategy === 'hybrid') {
            if (!this.config.semantic.enabled) {
                warnings.push({ code: 'semantic_disabled', message: 'Semantic retrieval is disabled; BM25 results were returned.' });
            } else {
                try {
                    state.embedder ||= await this.embedderFactory(this.config, path.join(this.cache.root, 'models'), this.injectedEmbedder);
                    if (!state.semantic) {
                        state.semantic = await buildSemanticIndex(state.model, state.embedder);
                        if (state.persisted) await this.cache.saveSemanticIndex(state.model.documentId, state.model.extractionFingerprint, state.semantic);
                    }
                    const semanticResults = await searchSemantic(state.semantic, args.query, state.embedder, options);
                    results = strategy === 'semantic' ? semanticResults : reciprocalRankFusion([bm25Results, semanticResults], 60);
                } catch {
                    warnings.push({ code: 'semantic_unavailable', message: 'Semantic retrieval failed; BM25 results were returned.' });
                    results = bm25Results;
                }
            }
        }
        const cursorArguments = { queryDigest: fingerprint(String(args.query).normalize('NFKC')), strategy, pages: args.pages || null, elementTypes: args.elementTypes || null, budget: args.budget || null };
        const start = args.cursor ? this.cursors.decode(args.cursor, {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_search',
            argumentsValue: cursorArguments,
        }) : 0;
        const bounded = applyResultBudget(results, resolveBudget(args.budget), start);
        return {
            query: args.query,
            strategy,
            results: bounded.items,
            warnings,
            omissions: bounded.omissions,
            budget: { configured: resolveBudget(args.budget), usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4' } },
            nextCursor: bounded.nextOffset === null ? null : this.cursors.encode({ documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, operation: 'pdf_search', argumentsValue: cursorArguments, position: bounded.nextOffset }),
        };
        });
    }

    async getPages(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const requested = new Set(args.pages || []);
        for (const range of args.pageRanges || []) {
            const start = range.start ?? 1;
            const end = range.end ?? state.model.totalPages;
            if (end < start) throw new PdfDecompilerError('invalid_page_range', 'A page range end cannot precede its start.');
            for (let page = start; page <= Math.min(end, state.model.totalPages); page += 1) requested.add(page);
        }
        if (!requested.size) state.model.pages.forEach(page => requested.add(page.number));
        if ([...requested].some(page => page > state.model.totalPages)) throw new PdfDecompilerError('page_unavailable', 'A requested page exceeds the document page count.');
        const scoped = sortElements(state.model.elements.filter(element => requested.has(element.page)));
        let elements = scoped;
        const mode = args.mode || 'balanced';
        if (mode === 'text') elements = elements.filter(element => element.type !== 'figure');
        if (mode === 'balanced') elements = elements.filter(element => element.type !== 'figure' || element.caption);
        if (args.includeElementTypes?.length) {
            const include = new Set(args.includeElementTypes);
            const selectedIds = new Set(elements.map(element => element.id));
            elements = sortElements([...elements, ...scoped.filter(element => include.has(element.type) && !selectedIds.has(element.id))]);
        }
        if (args.excludeElementTypes?.length) {
            const exclude = new Set(args.excludeElementTypes);
            elements = elements.filter(element => !exclude.has(element.type));
        }
        const cursorArguments = {
            pages: [...requested].sort((a, b) => a - b),
            mode,
            includeElementTypes: args.includeElementTypes || null,
            excludeElementTypes: args.excludeElementTypes || null,
            budget: args.budget || null,
        };
        const start = args.cursor ? this.cursors.decode(args.cursor, { documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, operation: 'pdf_get_pages', argumentsValue: cursorArguments }) : 0;
        const bounded = applyResultBudget(elements, resolveBudget(args.budget), start);
        return {
            mode,
            pages: [...requested].sort((a, b) => a - b),
            elements: bounded.items,
            citations: bounded.items.map(item => item.citation),
            omissions: bounded.omissions,
            budget: { configured: resolveBudget(args.budget), usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4' } },
            nextCursor: bounded.nextOffset === null ? null : this.cursors.encode({ documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, operation: 'pdf_get_pages', argumentsValue: cursorArguments, position: bounded.nextOffset }),
        };
        });
    }

    async getElement(args) {
        if (!args.extractionFingerprint) throw new PdfDecompilerError('missing_extraction_fingerprint', 'pdf_get_element requires extractionFingerprint.');
        const current = this.currentGeneration.get(args.documentId);
        if (current && current !== args.extractionFingerprint && !this.states.has(stateKey(args.documentId, args.extractionFingerprint))) {
            throw new PdfDecompilerError('stale_reference', 'The element reference belongs to a different extraction generation.');
        }
        try {
            return await this.withOperation(args.documentId, args.extractionFingerprint, async state => {
                const element = state.indexes.elements.get(args.elementId);
                if (!element) throw new PdfDecompilerError('stale_reference', 'The element does not exist in the requested extraction generation.');
                return element;
            });
        } catch (error) {
            if (['cache_generation_missing', 'expired_process_state', 'stale_extraction_fingerprint'].includes(error.code)) {
                throw new PdfDecompilerError('stale_reference', 'The element reference belongs to an unavailable extraction generation.');
            }
            throw error;
        }
    }

    async renderPage(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const bbox = Array.isArray(args.bbox) ? { x: args.bbox[0], y: args.bbox[1], width: args.bbox[2], height: args.bbox[3] } : args.bbox || null;
        const pageRecord = state.indexes.pages.get(args.page);
        if (!pageRecord) throw new PdfDecompilerError('page_unavailable', 'The page has not been decomposed or does not exist.');
        const budget = resolveBudget(args.budget);
        if (budget.renderedPages < 1) throw new PdfDecompilerError('budget_exhausted', 'The rendered-page budget is zero.');
        const format = args.format === 'jpeg' ? 'jpeg'
            : args.format === 'png' ? 'png'
                : bbox && pageRecord.contentClass === 'visual' ? 'jpeg' : 'png';
        const maxDimension = Math.min(args.maxDimension || budget.imageDimension, budget.imageDimension, 4096);
        if (maxDimension < 64) throw new PdfDecompilerError('budget_exhausted', 'The image-dimension budget is below the minimum render size.');
        const renderKey = fingerprint({ page: args.page, bbox, format, maxDimension });
        const id = `render:${args.page}:${renderKey.slice(0, 24)}`;
        let asset = state.derivedAssets.get(id);
        if (!asset) {
            const rendered = await runRenderSubprocess(state.pdfBytes, this.config, { page: args.page, bbox, format, maxDimension });
            asset = {
                id,
                kind: 'page-render',
                documentId: state.model.documentId,
                extractionFingerprint: state.model.extractionFingerprint,
                mimeType: rendered.mimeType,
                width: rendered.width,
                height: rendered.height,
                data: rendered.data,
                sha256: sha256(Buffer.from(rendered.data, 'base64')),
                uri: `pdf-decompiler://document/${state.model.documentId}/${state.model.extractionFingerprint}/asset/${encodeURIComponent(id)}`,
                enforcement: rendered.enforcement,
                budget: {
                    configured: budget,
                    usage: {
                        renderedPages: 1,
                        imageDimension: Math.max(rendered.width, rendered.height),
                        encodedImageBytes: Buffer.byteLength(rendered.data, 'base64'),
                        estimatedImageTokens: Math.ceil((rendered.width * rendered.height) / 750),
                    },
                    estimators: { image: 'generic_pixels_divided_by_750_advisory' },
                },
            };
            state.derivedAssets.set(id, asset);
            if (this.config.cache.mode === 'persistent') await this.cache.saveDerivedAsset(asset);
        }
        return asset;
        });
    }

    async readResource(uri) {
        const match = /^pdf-decompiler:\/\/document\/(doc_[a-f0-9]{64})\/([a-f0-9]{64})\/(asset|canonical)\/(.+)$/.exec(uri);
        if (!match) throw new PdfDecompilerError('invalid_resource_uri', 'The resource URI is invalid.');
        const [, documentId, generation, kind, encodedId] = match;
        const id = decodeURIComponent(encodedId);
        let state = this.states.get(stateKey(documentId, generation));
        const activeState = state || null;
        let temporaryLease = null;
        if (activeState) {
            if (activeState.closing) throw new PdfDecompilerError('closed_document', 'The document generation is closing.');
            activeState.operationCount += 1;
        }
        if (!state) {
            const reason = await this.cache.unavailableReason(documentId, generation);
            if (this.config.cache.mode !== 'persistent') {
                const current = this.currentGeneration.get(documentId);
                const code = reason === 'closed' ? 'closed_document'
                    : reason === 'deleted' ? 'deleted_generation'
                        : current && current !== generation ? 'stale_extraction_fingerprint' : 'process_local_resource_expired';
                throw new PdfDecompilerError(code, 'The process-local resource is no longer available.');
            }
            if (!(await this.cache.generationExists(documentId, generation))) {
                const codes = { evicted: 'evicted_generation', deleted: 'deleted_generation', corrupt: 'corrupt_generation' };
                const current = this.currentGeneration.get(documentId);
                throw new PdfDecompilerError(codes[reason] || (current && current !== generation ? 'stale_extraction_fingerprint' : 'cache_generation_missing'), 'The extraction generation is unavailable.');
            }
            temporaryLease = await this.cache.acquireLease(documentId, generation);
            const cached = await this.cache.loadGeneration(documentId, generation);
            if (!cached) {
                await this.cache.releaseLease(temporaryLease);
                throw new PdfDecompilerError('cache_generation_missing', 'The extraction generation is unavailable.');
            }
            state = { model: cached.model, pdfBytes: cached.pdfBytes, indexes: indexModel(cached.model), derivedAssets: new Map() };
        }
        try {
            if (kind === 'canonical') return { mimeType: 'application/json', text: JSON.stringify(modelView(state.model), null, 2) };
            let asset = state.derivedAssets.get(id) || state.indexes.assets.get(id);
            if ((!asset || !asset.data) && this.config.cache.mode === 'persistent') asset = await this.cache.loadDerivedAsset(documentId, generation, id) || asset;
            if (asset?.deferredRender && !asset.data) {
                const rendered = await runRenderSubprocess(state.pdfBytes, this.config, asset.deferredRender);
                asset = {
                    ...asset,
                    data: rendered.data,
                    mimeType: rendered.mimeType,
                    width: rendered.width,
                    height: rendered.height,
                    sha256: sha256(Buffer.from(rendered.data, 'base64')),
                };
                state.derivedAssets.set(id, asset);
                if (this.config.cache.mode === 'persistent') await this.cache.saveDerivedAsset(asset);
            }
            if (!asset?.data) throw new PdfDecompilerError('missing_asset', 'The requested asset is unavailable.');
            return { mimeType: asset.mimeType, blob: asset.data };
        } finally {
            if (activeState) {
                activeState.operationCount -= 1;
                if (activeState.operationCount === 0) activeState.operationWaiters.splice(0).forEach(resolve => resolve());
            }
            if (temporaryLease) await this.cache.releaseLease(temporaryLease);
        }
    }

    async closeDocument(args) {
        timingMark('document_lookup');
        const key = stateKey(args.documentId, args.extractionFingerprint);
        const state = this.states.get(key);
        if (!state) {
            if (args.sourceId && this.closedHandles.has(args.sourceId)) throw new PdfDecompilerError('SOURCE_HANDLE_ALREADY_CLOSED', 'The source handle is already closed.');
            if (args.sourceId) throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
            throw new PdfDecompilerError('closed_document', 'The document is not open.');
        }
        let sourceId = args.sourceId;
        if (!sourceId) {
            if (state.handles.size !== 1) throw new PdfDecompilerError('SOURCE_HANDLE_REQUIRED', 'sourceId is required when multiple source handles are active.');
            sourceId = state.handles.keys().next().value;
        }
        if (!state.handles.has(sourceId)) {
            if (this.closedHandles.has(sourceId)) throw new PdfDecompilerError('SOURCE_HANDLE_ALREADY_CLOSED', 'The source handle is already closed.');
            throw new PdfDecompilerError('SOURCE_HANDLE_UNKNOWN', 'The source handle is unavailable.');
        }
        if (args.deleteCache && (state.handles.size > 1 || state.operationCount > 0)) {
            throw new PdfDecompilerError('CACHE_GENERATION_IN_USE', 'The extraction generation has active source handles or operations.');
        }
        state.handles.delete(sourceId);
        timingMark('handle_release');
        this.closedHandles.set(sourceId, Date.now());
        while (this.closedHandles.size > 1024) this.closedHandles.delete(this.closedHandles.keys().next().value);
        if (state.handles.size > 0) return { closed: true, sourceId, remainingHandles: state.handles.size, cacheDeleted: false, deletionVerified: true };
        state.closing = true;
        await this.waitForOperations(state);
        if (state.leaseId) await this.cache.releaseLease(state.leaseId);
        timingMark('lease_release');
        this.states.delete(key);
        this.closedStates.add(key);
        if (this.currentGeneration.get(state.model.documentId) === state.model.extractionFingerprint) this.currentGeneration.delete(state.model.documentId);
        let deletion = { deleted: false, verified: true };
        if (args.deleteCache) deletion = await this.cache.deleteGeneration(state.model.documentId, state.model.extractionFingerprint, { ignoreMissing: true, reason: 'deleted' });
        else await this.cache.cleanupDocumentState(state.model.documentId, state.model.extractionFingerprint);
        timingMark(args.deleteCache ? 'cache_deletion' : 'resource_cleanup');
        return { closed: true, sourceId, remainingHandles: 0, cacheDeleted: deletion.deleted, deletionVerified: deletion.verified };
    }

    async close() {
        for (const state of this.states.values()) {
            state.closing = true;
            state.handles.clear();
            await this.waitForOperations(state);
            if (state.leaseId) await this.cache.releaseLease(state.leaseId);
        }
        this.states.clear();
        this.currentGeneration.clear();
        await this.cache.close();
    }
}
