import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { CacheManager } from '../cache/cache-manager.mjs';
import { fingerprint, sha256 } from '../core/crypto.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';
import { buildCanonicalModel, extractionFingerprint, indexModel, mergeCanonicalModels, modelView } from '../model/canonical.mjs';
import { buildBm25, searchBm25 } from '../search/bm25.mjs';
import { MARKDOWN_FORMAT_VERSION, MARKDOWN_SERIALIZER_REVISION, serializeElementMarkdown, serializePagedMarkdown } from '../markdown/serializer.mjs';
import { getFullMarkdownExport, markdownResourceUri } from '../markdown/export.mjs';
import { buildSemanticIndex, createEmbedder, reciprocalRankFusion, searchSemantic } from '../search/semantic.mjs';
import { loadPdfSource } from '../security/source.mjs';
import { applyFairPageBudget, applyResultBudget, HARD_BUDGET, normalizePageOrder, resolveBudget } from './budget.mjs';
import { CursorCodec } from './cursor.mjs';
import { selectTable } from './table-selection.mjs';
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

function completeDocument(model) {
    return model.processedPages === model.totalPages && !model.partial;
}

function requestedPagesComplete(model, pages) {
    const processed = new Set(model.pages.map(page => page.number));
    return pages.every(page => processed.has(page));
}

function dedupe(values) {
    return [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
}

function pageRanges(pages) {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    const ranges = [];
    for (const page of sorted) {
        const last = ranges.at(-1);
        if (last && page === last[1] + 1) last[1] = page;
        else ranges.push([page, page]);
    }
    return ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(',');
}

function summarizePageWarnings(pages) {
    const groups = new Map();
    for (const page of pages) for (const warning of page.warnings || []) {
        const { page: _page, ...base } = warning;
        const key = JSON.stringify(base);
        if (!groups.has(key)) groups.set(key, { base, pages: [] });
        groups.get(key).pages.push(page.number);
    }
    return [...groups.values()].map(group => group.pages.length === 1
        ? { ...group.base, page: group.pages[0] }
        : { ...group.base, message: `${group.base.message ? `${group.base.message} ` : ''}Affected pages: ${pageRanges(group.pages)}.` });
}

function compactTable(table) {
    const rows = table.rows.slice(0, 6).map(row => row.slice(0, 8));
    return {
        ...table,
        rows,
        cells: table.cells.filter(cell => cell.row <= 6 && cell.column <= 8),
        text: rows.map(row => row.join(' | ')).join('\n'),
        preview: { rowStart: 1, rowEnd: rows.length, columnStart: 1, columnEnd: Math.max(0, ...rows.map(row => row.length)), partial: table.totalRows > rows.length || table.totalColumns > 8 },
    };
}

function buildBm25Safely(model, debug = false) {
    try {
        return buildBm25(model);
    } catch (error) {
        const diagnosticId = randomUUID();
        if (debug) console.error(`[pdf-index:${diagnosticId}]`, error?.stack || error);
        throw new PdfDecompilerError('INDEX_BUILD_FAILED', 'The extracted document could not be indexed.', { stage: 'bm25', retryable: true, diagnosticId });
    }
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

function openScopePages(intervals, totalPages) {
    if (!intervals?.length) return Array.from({ length: totalPages }, (_, index) => index + 1);
    const pages = new Set();
    for (const interval of intervals) {
        const start = interval.start ?? 1;
        const end = interval.end ?? totalPages;
        for (let page = start; page <= Math.min(end, totalPages); page += 1) pages.add(page);
    }
    return [...pages];
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

    async bm25ForCached(cached) {
        if (cached.bm25?.version === 2) return cached.bm25;
        const bm25 = buildBm25Safely(cached.model, this.config.debug);
        await this.cache.saveBm25Index(cached.model.documentId, cached.model.extractionFingerprint, bm25);
        return bm25;
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
            return this.openResult(active, descriptor, { cacheHit: true, requestedPages: openScopePages(args.pages, active.model.totalPages) });
        }
        if (!args.refresh && this.config.cache.mode === 'persistent') {
            const cached = await this.cache.loadGeneration(documentId, generation);
            if (cached) {
                const state = await this.activate(cached.model, cached.pdfBytes, await this.bm25ForCached(cached), cached.semantic, { persisted: true, extractionConfig });
                this.addSourceHandle(state, descriptor);
                return this.openResult(state, descriptor, { cacheHit: true, requestedPages: openScopePages(args.pages, state.model.totalPages) });
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
        const bm25 = buildBm25Safely(model, this.config.debug);
        const state = await this.activate(model, loaded.bytes, bm25, null, { extractionConfig });
        this.addSourceHandle(state, descriptor);
        state.diagnostics = extracted.diagnostics;
        return this.openResult(state, descriptor, { cacheHit: false, requestedPages: openScopePages(args.pages, state.model.totalPages) });
    }

    openResult(state, descriptor, { cacheHit, requestedPages = [] }) {
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
            nextCursor,
            cacheHit,
            sourceId: descriptor.sourceId,
            sourceDescriptor: descriptor,
            cache: this.cache.status(state.model),
            diagnostics: state.diagnostics || null,
            warnings: summarizePageWarnings(state.model.pages),
            completion: {
                documentComplete: completeDocument(state.model),
                requestedScopeComplete: requestedPagesComplete(state.model, requestedPages),
                resultComplete: true,
            },
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
        state.bm25 = buildBm25Safely(state.model, this.config.debug);
        state.indexes = indexModel(state.model);
        state.diagnostics = extracted.diagnostics;
        if (!state.model.partial && !state.persisted) {
            await this.cache.saveGeneration(state.model, state.pdfBytes, state.bm25, state.semantic);
            state.leaseId = await this.cache.acquireLease(state.model.documentId, state.model.extractionFingerprint);
            state.persisted = true;
        }
        return this.openResult(state, descriptor, { cacheHit: false, requestedPages: openScopePages(pages, state.model.totalPages) });
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
        return this.activate(cached.model, cached.pdfBytes, await this.bm25ForCached(cached), cached.semantic, { persisted: true });
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
        const { elements: _elements, assets: _assets, warnings, ...document } = modelView(state.model);
        const markdownUri = markdownResourceUri(state.model);
        const serializerFingerprint = markdownUri.split('/').at(-2);
        const cachedMarkdown = completeDocument(state.model) ? await this.cache.loadDerivedMarkdown(state.model.documentId, state.model.extractionFingerprint, serializerFingerprint) : null;
        const tableRows = state.model.elements.filter(element => element.type === 'table').reduce((sum, table) => sum + table.totalRows, 0);
        const tableCells = state.model.elements.filter(element => element.type === 'table').reduce((sum, table) => sum + table.cells.length, 0);
        const exportWithinLimits = state.model.elements.length <= this.config.markdown.maxElements
            && tableRows <= this.config.markdown.maxTableRows && tableCells <= this.config.markdown.maxTableCells;
        return {
            ...document,
            counts,
            activeSources: [...state.handles.values()],
            cache: { ...this.cache.status(state.model), activeLeases: await this.cache.activeLeases(state.model.documentId, state.model.extractionFingerprint) },
            resourceLifetime: this.config.cache.mode === 'persistent' ? 'until_generation_deleted_or_evicted' : this.config.cache.mode === 'ephemeral' ? 'owning_process_and_document_lifetime' : 'active_document_lifetime',
            exports: {
                markdown: {
                    status: cachedMarkdown ? 'ready' : !completeDocument(state.model) ? 'partial_generation' : exportWithinLimits ? 'generatable' : 'unavailable_limit',
                    resourceUri: completeDocument(state.model) && exportWithinLimits ? markdownUri : null,
                },
            },
            warnings: summarizePageWarnings(state.model.pages),
            completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true },
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
        const requestedBudget = resolveBudget(args.budget);
        const selectionBudget = {
            ...requestedBudget,
            responseBytes: Math.min(requestedBudget.responseBytes, Math.floor((args._wireResponseBytes ?? requestedBudget.responseBytes) * 0.65)),
            estimatedTokens: Math.min(requestedBudget.estimatedTokens, Math.floor((args._wireEstimatedTokens ?? requestedBudget.estimatedTokens) * 0.65)),
        };
        const bounded = applyResultBudget(results, selectionBudget, start);
        const nextCursor = bounded.nextOffset === null ? null : this.cursors.encode({ documentId: state.model.documentId, extractionFingerprint: state.model.extractionFingerprint, operation: 'pdf_search', argumentsValue: cursorArguments, position: bounded.nextOffset });
        const scopePages = args.pages?.length ? args.pages : Array.from({ length: state.model.totalPages }, (_, index) => index + 1);
        return {
            query: args.query,
            strategy,
            results: bounded.items,
            citations: dedupe(bounded.items.flatMap(result => result.citations || [result.citation])),
            warnings,
            omissions: bounded.omissions,
            budget: { configured: requestedBudget, usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4' } },
            nextCursor,
            completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: requestedPagesComplete(state.model, scopePages), resultComplete: nextCursor === null },
        };
        });
    }

    async getPages(args) {
        return this.withOperation(args.documentId, args.extractionFingerprint, async state => {
        const restored = args.cursor ? this.cursors.decode(args.cursor, {
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_get_pages',
            restoreArguments: true,
        }) : null;
        const restoredArguments = restored?.argumentsValue;
        const pageInput = args.pages || (!args.pageRanges ? restoredArguments?.pages : null);
        if ((pageInput || []).some(page => page > state.model.totalPages)) throw new PdfDecompilerError('page_unavailable', 'A requested page exceeds the document page count.');
        const requestedPages = normalizePageOrder(pageInput, args.pageRanges, state.model.totalPages, state.model.pages.map(page => page.number));
        if (requestedPages.length > HARD_BUDGET.pages) throw new PdfDecompilerError('budget_exhausted', 'The requested page scope exceeds the hard page limit.');
        const requested = new Set(requestedPages);
        const scoped = sortElements(state.model.elements.filter(element => requested.has(element.page)));
        let elements = scoped;
        const mode = args.mode || restoredArguments?.mode || 'balanced';
        const outputFormat = args.outputFormat || restoredArguments?.outputFormat || 'structured';
        const tableDetail = args.tableDetail || restoredArguments?.tableDetail || (outputFormat === 'markdown' ? 'compact' : 'full');
        const includeElementTypes = args.includeElementTypes || restoredArguments?.includeElementTypes;
        const excludeElementTypes = args.excludeElementTypes || restoredArguments?.excludeElementTypes;
        if (mode === 'text') elements = elements.filter(element => element.type !== 'figure');
        if (mode === 'balanced') elements = elements.filter(element => element.type !== 'figure' || element.caption);
        if (includeElementTypes?.length) {
            const include = new Set(includeElementTypes);
            const selectedIds = new Set(elements.map(element => element.id));
            elements = sortElements([...elements, ...scoped.filter(element => include.has(element.type) && !selectedIds.has(element.id))]);
        }
        if (excludeElementTypes?.length) {
            const exclude = new Set(excludeElementTypes);
            elements = elements.filter(element => !exclude.has(element.type));
        }
        const requestedBudget = args.budget || restoredArguments?.requestedBudget;
        const resolvedBudget = resolveBudget(requestedBudget);
        const cursorArguments = {
            pages: requestedPages,
            mode,
            outputFormat,
            tableDetail,
            includeElementTypes: includeElementTypes || null,
            excludeElementTypes: excludeElementTypes || null,
            requestedBudget: resolvedBudget,
            hardBudgetFingerprint: fingerprint(HARD_BUDGET),
            canonicalFormatVersion: state.model.canonicalFormatVersion,
            extractionRevision: state.model.extractionRevision,
            markdownFormatVersion: outputFormat === 'markdown' ? MARKDOWN_FORMAT_VERSION : null,
            markdownSerializerRevision: outputFormat === 'markdown' ? MARKDOWN_SERIALIZER_REVISION : null,
        };
        if (restoredArguments && fingerprint(restoredArguments) !== fingerprint(cursorArguments)) throw new PdfDecompilerError('changed_cursor_arguments', 'The cursor arguments have changed.');
        const position = restored?.position || { offsets: requestedPages.map(() => 0), pageIndex: 0 };
        const pageItems = requestedPages.map(page => ({ page, items: elements.filter(element => element.page === page) }));
        const wireResponseBytes = Math.min(resolvedBudget.responseBytes, args._wireResponseBytes ?? resolvedBudget.responseBytes);
        const preCapBudget = {
            ...resolvedBudget,
            responseBytes: Math.floor(wireResponseBytes * 0.65),
            estimatedTokens: Math.min(resolvedBudget.estimatedTokens, Math.floor((args._wireEstimatedTokens ?? resolvedBudget.estimatedTokens) * 0.65)),
        };
        const bounded = applyFairPageBudget(pageItems, preCapBudget, position, element => {
            const value = element.type === 'table' && tableDetail === 'compact' ? compactTable(element) : element;
            const fragment = outputFormat === 'markdown' ? serializeElementMarkdown(value, { tableDetail }) : null;
            const encoded = outputFormat === 'markdown' ? fragment : JSON.stringify(value);
            return {
                value: { element: value, markdown: fragment },
                encoded,
                bytes: Math.ceil(Buffer.byteLength(encoded) * 1.15) + Buffer.byteLength(JSON.stringify(value.citation)) + 256,
                counts: {
                    textBlocks: value.type === 'block' ? 1 : 0,
                    tables: value.type === 'table' ? 1 : 0,
                    figures: value.type === 'figure' ? 1 : 0,
                },
            };
        });
        const selected = bounded.items.map(item => item.element);
        const selectedIds = new Set(selected.map(element => element.id));
        const relationshipOmissions = selected.filter(element => element.type === 'block' && element.ocrSource?.scope === 'image'
            && element.ocrSource.figureId && !selectedIds.has(element.ocrSource.figureId))
            .map(element => ({ id: element.ocrSource.figureId, reason: 'associated_figure_omitted' }));
        const nextCursor = bounded.nextPosition === null ? null : this.cursors.encode({
            documentId: state.model.documentId,
            extractionFingerprint: state.model.extractionFingerprint,
            operation: 'pdf_get_pages',
            argumentsValue: cursorArguments,
            position: bounded.nextPosition,
            restorableArguments: cursorArguments,
        });
        const resourceUris = dedupe([
            ...(completeDocument(state.model) ? [markdownResourceUri(state.model)] : []),
            ...selected.filter(element => element.type === 'figure').map(element => element.asset.uri),
        ]);
        const data = outputFormat === 'markdown' ? {
            outputFormat,
            markdownFormatVersion: MARKDOWN_FORMAT_VERSION,
            pages: requestedPages,
            markdown: serializePagedMarkdown(selected, requestedPages, { tableDetail }),
            resourceUris,
        } : {
            outputFormat,
            mode,
            pages: requestedPages,
            elements: selected,
        };
        return {
            ...data,
            citations: selected.map(item => item.citation),
            warnings: summarizePageWarnings(state.model.pages.filter(page => requested.has(page.number))),
            omissions: dedupe([...bounded.omissions, ...relationshipOmissions]),
            budget: { configured: resolvedBudget, usage: bounded.usage, estimators: { text: 'utf8_bytes_divided_by_4', response: 'bounded_fragment_preflight_then_exact_wire_serialization' } },
            nextCursor,
            completion: {
                documentComplete: completeDocument(state.model),
                requestedScopeComplete: requestedPagesComplete(state.model, requestedPages),
                resultComplete: nextCursor === null,
            },
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
                if (element.type !== 'table') {
                    if (args.tableSelection) throw new PdfDecompilerError('TABLE_SELECTION_NOT_APPLICABLE', 'tableSelection is valid only for table elements.');
                    if (args.cursor) throw new PdfDecompilerError('changed_cursor_arguments', 'This element does not use a continuation cursor.');
                    return {
                        element,
                        tableSelection: null,
                        citations: [element.citation],
                        completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true },
                    };
                }
                const resolvedBudget = resolveBudget(args.budget);
                const cursorArguments = {
                    elementId: args.elementId,
                    tableSelection: args.tableSelection || null,
                    requestedBudget: args.budget || null,
                    hardBudgetFingerprint: fingerprint(HARD_BUDGET),
                };
                const cursorPosition = args.cursor ? this.cursors.decode(args.cursor, {
                    documentId: state.model.documentId,
                    extractionFingerprint: state.model.extractionFingerprint,
                    operation: 'pdf_get_element',
                    argumentsValue: cursorArguments,
                }) : { offset: 0 };
                const boundedBudget = {
                    ...resolvedBudget,
                    responseBytes: Math.floor(Math.min(resolvedBudget.responseBytes, args._wireResponseBytes ?? resolvedBudget.responseBytes) * 0.65),
                    estimatedTokens: Math.floor(Math.min(resolvedBudget.estimatedTokens, args._wireEstimatedTokens ?? resolvedBudget.estimatedTokens) * 0.65),
                };
                const selected = selectTable(element, args.tableSelection || {}, boundedBudget, cursorPosition.offset || 0);
                const nextCursor = selected.nextOffset === null ? null : this.cursors.encode({
                    documentId: state.model.documentId,
                    extractionFingerprint: state.model.extractionFingerprint,
                    operation: 'pdf_get_element',
                    argumentsValue: cursorArguments,
                    position: { offset: selected.nextOffset },
                });
                return {
                    element: selected.element,
                    tableSelection: selected.tableSelection,
                    citations: [element.citation],
                    omissions: selected.omissions,
                    budget: { ...selected.budget, configured: resolvedBudget },
                    nextCursor,
                    completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: nextCursor === null },
                };
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
        return { ...asset, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
        });
    }

    async readResource(uri) {
        const generationMatch = /^pdf-decompiler:\/\/document\/(doc_[a-f0-9]{64})\/([a-f0-9]{64})\/(asset|canonical)\/(.+)$/.exec(uri);
        const markdownMatch = /^pdf-decompiler:\/\/document\/(doc_[a-f0-9]{64})\/([a-f0-9]{64})\/markdown\/(\d+)\/([a-f0-9]{64})\/full\.md$/.exec(uri);
        if (!generationMatch && !markdownMatch) throw new PdfDecompilerError('invalid_resource_uri', 'The resource URI is invalid.');
        const documentId = (generationMatch || markdownMatch)[1];
        const generation = (generationMatch || markdownMatch)[2];
        const kind = markdownMatch ? 'markdown' : generationMatch[3];
        const id = generationMatch ? decodeURIComponent(generationMatch[4]) : markdownMatch[4];
        if (markdownMatch && Number(markdownMatch[3]) !== MARKDOWN_FORMAT_VERSION) throw new PdfDecompilerError('stale_markdown_resource', 'The Markdown format version is unavailable.');
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
            if (kind === 'markdown') {
                if (!completeDocument(state.model)) throw new PdfDecompilerError('MARKDOWN_SERIALIZATION_FAILED', 'A complete Markdown export requires a complete canonical document. Use paged Markdown retrieval with cursors.');
                const exported = await getFullMarkdownExport(state.model, this.cache, this.config, id);
                return { mimeType: 'text/markdown', text: exported.text };
            }
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
        if (state.handles.size > 0) return { closed: true, sourceId, remainingHandles: state.handles.size, cacheDeleted: false, deletionVerified: true, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
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
        return { closed: true, sourceId, remainingHandles: 0, cacheDeleted: deletion.deleted, deletionVerified: deletion.verified, completion: { documentComplete: completeDocument(state.model), requestedScopeComplete: true, resultComplete: true } };
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
