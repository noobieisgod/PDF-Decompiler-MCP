import { fingerprint, sha256 } from '../core/crypto.mjs';
import { normalizeBBox, unionBBoxes } from './geometry.mjs';

export const SCHEMA_VERSION = '3.0.0';
export const CANONICAL_FORMAT_VERSION = 2;
export const EXTRACTION_REVISION = 2;

function cleanText(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function nullableText(text) {
    const value = cleanText(text);
    return value || null;
}

function elementFingerprints(type, page, bbox, content) {
    return {
        contentFingerprint: fingerprint({ type, content }),
        locationFingerprint: fingerprint({ type, page, bbox: bbox || null }),
    };
}

function citation(documentId, extractionFingerprint, page, elementId, bbox = null) {
    return { documentId, extractionFingerprint, pageId: `page:${page}`, elementId, bbox };
}

function resourceUri(documentId, extractionFingerprint, kind, id) {
    return `pdf-decompiler://document/${documentId}/${extractionFingerprint}/${kind}/${encodeURIComponent(id)}`;
}

function validDestination(value) {
    if (!value || !['named', 'explicit', 'unresolved'].includes(value.kind)) return null;
    return {
        kind: value.kind,
        name: typeof value.name === 'string' ? value.name.slice(0, 256) : null,
        page: Number.isInteger(value.page) && value.page > 0 ? value.page : null,
        x: Number.isFinite(value.x) ? value.x : null,
        y: Number.isFinite(value.y) ? value.y : null,
        zoom: Number.isFinite(value.zoom) && value.zoom >= 0 ? value.zoom : null,
    };
}

function addElement(collection, record, orderHint) {
    collection.push({ ...record, _orderHint: orderHint });
}

function finalizePageElements(collection) {
    const ordered = [...collection].sort((a, b) => a._orderHint - b._orderHint
        || (a.bbox?.y ?? Number.MAX_SAFE_INTEGER) - (b.bbox?.y ?? Number.MAX_SAFE_INTEGER)
        || (a.bbox?.x ?? Number.MAX_SAFE_INTEGER) - (b.bbox?.x ?? Number.MAX_SAFE_INTEGER)
        || a.type.localeCompare(b.type)
        || a.id.localeCompare(b.id));
    return ordered.map(({ _orderHint, ...element }, readingOrder) => ({ ...element, readingOrder }));
}

function insertionHint(blocks, bbox, sourceIndex = 0) {
    if (!bbox || !blocks.length) return (blocks.length + 1) * 1000 + sourceIndex;
    const index = blocks.findIndex(block => block.bbox && block.bbox.y > bbox.y);
    return (index < 0 ? blocks.length : index) * 1000 + 500 + sourceIndex;
}

export function extractionFingerprint(config, dependencyFingerprint) {
    return fingerprint({
        schemaVersion: SCHEMA_VERSION,
        canonicalFormatVersion: CANONICAL_FORMAT_VERSION,
        extractionRevision: EXTRACTION_REVISION,
        extractorVersion: config.extractorVersion,
        dependencyFingerprint,
        extraction: {
            maxPages: config.maxPages,
            ocrPolicy: config.ocrPolicy,
            imagePolicy: 'png-text-jpeg-photo-0.75',
            backend: 'hybrid-mupdf-pdfjs',
        },
    });
}

export function buildCanonicalModel(pdfBytes, raw, config, dependencyFingerprint) {
    const pdfHash = sha256(pdfBytes);
    const documentId = `doc_${pdfHash}`;
    const generation = extractionFingerprint(config, dependencyFingerprint);
    const elements = [];
    const assets = [];
    const pages = [];
    const modelWarnings = [];

    for (const rawPage of [...raw.pages].sort((a, b) => a.page - b.page)) {
        const width = rawPage.pageProfile?.viewportWidth || 0;
        const height = rawPage.pageProfile?.viewportHeight || 0;
        const pageWarnings = [rawPage.fallbackReason, rawPage.filteredReason].filter(Boolean).map(message => ({ code: 'page_warning', message }));
        pageWarnings.push(...(rawPage.warnings || []).map(warning => typeof warning === 'string' ? { code: warning } : warning));
        const page = {
            id: `page:${rawPage.page}`,
            number: rawPage.page,
            width,
            height,
            rotation: rawPage.pageProfile?.rotation || 0,
            extractionMode: rawPage.extractionMode,
            routingMode: rawPage.routingMode,
            contentClass: rawPage.contentClass,
            visualType: rawPage.pageProfile?.visualType || 'none',
            visualSignals: rawPage.pageProfile?.visualSignals || {
                hasText: Boolean(cleanText(rawPage.text)),
                rasterCount: rawPage.images?.length || 0,
                rasterCoverage: { value: null, precision: 'unknown' },
                vectorPaintCount: null,
                vectorCoverage: { value: null, precision: 'unknown' },
                annotationCount: rawPage.annotations?.length || 0,
                warnings: [],
            },
            ocr: {
                attempted: Boolean(rawPage.ocrAttempted),
                accepted: Boolean(rawPage.ocrAccepted),
                reason: rawPage.ocrReason || null,
            },
            diagnostics: { annotationWidgetCount: rawPage.annotationWidgetCount || 0 },
            warnings: pageWarnings,
            elementIds: [],
        };

        const pageElements = [];
        const rawBlocks = Array.isArray(rawPage.textBlocks)
            ? rawPage.textBlocks
            : cleanText(rawPage.text).split(/\n{2,}/).map(text => ({ text, role: rawPage.ocrAccepted ? 'ocr' : 'text', bbox: null }));
        const canonicalBlocks = [];
        rawBlocks.filter(block => cleanText(block.text)).forEach((block, index) => {
            const id = `block:${rawPage.page}:${index + 1}`;
            const bbox = normalizeBBox(block.bbox, width, height);
            if (block.bbox && !bbox) pageWarnings.push({ code: 'invalid_geometry', elementId: id });
            const text = cleanText(block.text);
            const record = {
                id,
                type: 'block',
                role: ['heading', 'text', 'list', 'ocr'].includes(block.role) ? block.role : rawPage.ocrAccepted ? 'ocr' : 'text',
                page: rawPage.page,
                bbox,
                text,
                extractionMethod: rawPage.extractionMode,
                confidence: rawPage.ocrAccepted ? 0.7 : 1,
                citation: citation(documentId, generation, rawPage.page, id, bbox),
                ...elementFingerprints('block', rawPage.page, bbox, text),
            };
            canonicalBlocks.push(record);
            addElement(pageElements, record, index * 1000);
        });

        (rawPage.tables || []).forEach((table, index) => {
            const id = `table:${rawPage.page}:${index + 1}`;
            const rows = table.data || table.rows || [];
            const bbox = normalizeBBox(table.bbox, width, height);
            if (table.bbox && !bbox) pageWarnings.push({ code: 'invalid_geometry', elementId: id });
            const cells = rows.flatMap((row, rowIndex) => row.map((value, columnIndex) => {
                const rawCell = table.cells?.[rowIndex]?.[columnIndex];
                const cellBbox = normalizeBBox(rawCell?.bbox, width, height);
                return {
                    id: `cell:${rawPage.page}:${index + 1}:${rowIndex + 1}:${columnIndex + 1}`,
                    row: rowIndex + 1,
                    column: columnIndex + 1,
                    rowSpan: Number.isInteger(rawCell?.rowSpan) && rawCell.rowSpan > 1 ? rawCell.rowSpan : 1,
                    columnSpan: Number.isInteger(rawCell?.columnSpan) && rawCell.columnSpan > 1 ? rawCell.columnSpan : 1,
                    text: cleanText(value),
                    bbox: cellBbox,
                };
            }));
            const tableBbox = bbox || unionBBoxes(cells.map(cell => cell.bbox), width, height);
            const record = {
                id,
                type: 'table',
                page: rawPage.page,
                bbox: tableBbox,
                rows,
                cells,
                text: rows.map(row => row.join(' | ')).join('\n'),
                citation: citation(documentId, generation, rawPage.page, id, tableBbox),
                ...elementFingerprints('table', rawPage.page, tableBbox, rows),
            };
            addElement(pageElements, record, insertionHint(canonicalBlocks, tableBbox, index));
        });

        const imageRecords = [...(rawPage.images || [])];
        if (rawPage.pageImage) imageRecords.push({ ...rawPage.pageImage, bbox: { x: 0, y: 0, width, height }, regionKind: 'page_visual' });
        const shouldAddDeferredVisual = !rawPage.pageImage
            && imageRecords.length === 0
            && ['vector', 'unknown', 'raster', 'mixed'].includes(page.visualType)
            && ['visual', 'scan_like'].includes(rawPage.contentClass);
        if (shouldAddDeferredVisual) imageRecords.push({ bbox: { x: 0, y: 0, width, height }, regionKind: 'page_visual', deferredRender: true });
        imageRecords.forEach((image, index) => {
            const id = `figure:${rawPage.page}:${index + 1}`;
            const assetId = `asset:${rawPage.page}:figure:${index + 1}`;
            const bbox = normalizeBBox(image.bbox, width, height);
            if (image.bbox && !bbox) pageWarnings.push({ code: 'invalid_geometry', elementId: id });
            const asset = {
                id: assetId,
                kind: image.regionKind === 'page_visual' ? 'page-visual' : 'figure',
                documentId,
                extractionFingerprint: generation,
                mimeType: image.mimeType || 'image/png',
                width: image.width || (image.regionKind === 'page_visual' ? width : 0),
                height: image.height || (image.regionKind === 'page_visual' ? height : 0),
                data: image.data || null,
                sha256: image.data ? sha256(Buffer.from(image.data, 'base64')) : null,
                deferredRender: image.deferredRender ? { page: rawPage.page, format: 'png', maxDimension: 1200 } : null,
                uri: resourceUri(documentId, generation, 'asset', assetId),
            };
            assets.push(asset);
            const caption = nullableText(image.caption);
            const record = {
                id,
                type: 'figure',
                figureKind: image.regionKind === 'page_visual' ? 'page_visual' : 'embedded_image',
                page: rawPage.page,
                bbox,
                caption,
                text: caption,
                asset: { ...asset, data: undefined },
                citation: citation(documentId, generation, rawPage.page, id, bbox),
                ...elementFingerprints('figure', rawPage.page, bbox, { sha256: asset.sha256, caption }),
            };
            addElement(pageElements, record, insertionHint(canonicalBlocks, bbox, index));
        });

        (rawPage.annotations || []).forEach((annotation, index) => {
            const id = `annotation:${rawPage.page}:${index + 1}`;
            const bbox = normalizeBBox(annotation.bbox, width, height);
            if (annotation.bbox && !bbox) pageWarnings.push({ code: 'invalid_geometry', elementId: id });
            const record = {
                id,
                type: 'annotation',
                page: rawPage.page,
                subtype: nullableText(annotation.subtype) || 'Unknown',
                text: nullableText(annotation.text),
                bbox,
                author: nullableText(annotation.author),
                createdAt: annotation.createdAt || null,
                modifiedAt: annotation.modifiedAt || null,
                color: Array.isArray(annotation.color) && annotation.color.length === 3 ? annotation.color : null,
                flags: annotation.flags || null,
                parentSourceId: nullableText(annotation.parentSourceId),
                replyToSourceId: nullableText(annotation.replyToSourceId),
                supported: Boolean(annotation.supported),
                provenance: annotation.provenance || { backend: 'pdfjs', sourceId: null, sourceSubtype: nullableText(annotation.subtype) || 'Unknown' },
                citation: citation(documentId, generation, rawPage.page, id, bbox),
                ...elementFingerprints('annotation', rawPage.page, bbox, annotation),
            };
            addElement(pageElements, record, insertionHint(canonicalBlocks, bbox, index));
        });

        (rawPage.links || []).forEach((link, index) => {
            const id = `link:${rawPage.page}:${index + 1}`;
            const bbox = normalizeBBox(link.bbox, width, height);
            if (link.bbox && !bbox) pageWarnings.push({ code: 'invalid_geometry', elementId: id });
            const destination = validDestination(link.destination);
            const text = nullableText(link.text);
            const record = {
                id,
                type: 'link',
                page: rawPage.page,
                bbox,
                text,
                url: nullableText(link.url),
                destination,
                targetKind: ['external_url', 'internal_destination', 'unknown'].includes(link.targetKind)
                    ? link.targetKind : link.url ? 'external_url' : destination ? 'internal_destination' : 'unknown',
                anchored: Boolean(text),
                annotationText: nullableText(link.annotationText),
                anchorSource: ['overlaid_text', 'geometry_overlap', 'none'].includes(link.anchorSource) ? link.anchorSource : text ? 'geometry_overlap' : 'none',
                provenance: link.provenance || { backend: 'pdfjs', source: 'link_annotation', sourceId: null, subtype: 'Link' },
                citation: citation(documentId, generation, rawPage.page, id, bbox),
                ...elementFingerprints('link', rawPage.page, bbox, link),
            };
            addElement(pageElements, record, insertionHint(canonicalBlocks, bbox, index));
        });

        const finalized = finalizePageElements(pageElements);
        page.elementIds = finalized.map(element => element.id);
        elements.push(...finalized);
        pages.push(page);
        modelWarnings.push(...pageWarnings.map(warning => ({ ...warning, page: rawPage.page })));
    }

    return {
        schemaVersion: SCHEMA_VERSION,
        canonicalFormatVersion: CANONICAL_FORMAT_VERSION,
        extractionRevision: EXTRACTION_REVISION,
        documentId,
        pdfSha256: pdfHash,
        extractionFingerprint: generation,
        dependencyFingerprint,
        metadata: raw.metadata || {},
        outline: raw.outline || [],
        totalPages: raw.totalPages,
        processedPages: pages.length,
        partial: raw.partial || null,
        pages,
        elements,
        assets,
        warnings: modelWarnings,
        createdAt: new Date().toISOString(),
    };
}

export function modelView(model) {
    const assets = model.assets.map(({ data, ...asset }) => asset);
    return { ...model, assets };
}

export function indexModel(model) {
    return {
        pages: new Map(model.pages.map(page => [page.number, page])),
        elements: new Map(model.elements.map(element => [element.id, element])),
        assets: new Map(model.assets.map(asset => [asset.id, asset])),
    };
}

export function mergeCanonicalModels(current, incoming) {
    if (current.documentId !== incoming.documentId || current.extractionFingerprint !== incoming.extractionFingerprint) throw new Error('Cannot merge different document generations');
    const pages = new Map(current.pages.map(page => [page.number, page]));
    incoming.pages.forEach(page => pages.set(page.number, page));
    const elements = new Map(current.elements.map(element => [element.id, element]));
    incoming.elements.forEach(element => elements.set(element.id, element));
    const assets = new Map(current.assets.map(asset => [asset.id, asset]));
    incoming.assets.forEach(asset => assets.set(asset.id, asset));
    return {
        ...current,
        metadata: incoming.metadata || current.metadata,
        outline: incoming.outline?.length ? incoming.outline : current.outline,
        pages: [...pages.values()].sort((a, b) => a.number - b.number),
        elements: [...elements.values()].sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id)),
        assets: [...assets.values()].sort((a, b) => a.id.localeCompare(b.id)),
        processedPages: pages.size,
        partial: incoming.partial,
        warnings: [...current.warnings, ...incoming.warnings],
    };
}
