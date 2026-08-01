import { fingerprint, sha256 } from '../core/crypto.mjs';

export const SCHEMA_VERSION = '3.0.0';

function cleanText(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function elementFingerprints(type, page, bbox, content) {
    return {
        contentFingerprint: fingerprint({ type, content }),
        locationFingerprint: fingerprint({ type, page, bbox: bbox || null }),
    };
}

function citation(documentId, extractionFingerprint, page, elementId, bbox = null) {
    return {
        documentId,
        extractionFingerprint,
        pageId: `page:${page}`,
        elementId,
        bbox,
    };
}

function resourceUri(documentId, extractionFingerprint, kind, id) {
    return `pdf-decompiler://document/${documentId}/${extractionFingerprint}/${kind}/${encodeURIComponent(id)}`;
}

function addElement(target, record) {
    target.elements.push(record);
    target.elementIds.push(record.id);
}

export function extractionFingerprint(config, dependencyFingerprint) {
    return fingerprint({
        schemaVersion: SCHEMA_VERSION,
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

    for (const rawPage of [...raw.pages].sort((a, b) => a.page - b.page)) {
        const page = {
            id: `page:${rawPage.page}`,
            number: rawPage.page,
            width: rawPage.pageProfile?.viewportWidth || 0,
            height: rawPage.pageProfile?.viewportHeight || 0,
            rotation: rawPage.pageProfile?.rotation || 0,
            extractionMode: rawPage.extractionMode,
            routingMode: rawPage.routingMode,
            contentClass: rawPage.contentClass,
            ocr: {
                attempted: Boolean(rawPage.ocrAttempted),
                accepted: Boolean(rawPage.ocrAccepted),
                reason: rawPage.ocrReason || null,
            },
            warnings: [rawPage.fallbackReason, rawPage.filteredReason].filter(Boolean),
            elementIds: [],
        };

        const paragraphs = cleanText(rawPage.text).split(/\n{2,}/).map(cleanText).filter(Boolean);
        paragraphs.forEach((text, index) => {
            const id = `block:${rawPage.page}:${index + 1}`;
            addElement({ elements, elementIds: page.elementIds }, {
                id,
                type: 'block',
                page: rawPage.page,
                readingOrder: page.elementIds.length,
                bbox: null,
                text,
                extractionMethod: rawPage.extractionMode,
                confidence: rawPage.ocrAccepted ? 0.7 : 1,
                citation: citation(documentId, generation, rawPage.page, id),
                ...elementFingerprints('block', rawPage.page, null, text),
            });
        });

        (rawPage.tables || []).forEach((table, index) => {
            const id = `table:${rawPage.page}:${index + 1}`;
            const rows = table.data || [];
            const cells = rows.flatMap((row, rowIndex) => row.map((value, columnIndex) => ({
                id: `cell:${rawPage.page}:${index + 1}:${rowIndex + 1}:${columnIndex + 1}`,
                row: rowIndex + 1,
                column: columnIndex + 1,
                text: cleanText(value),
            })));
            addElement({ elements, elementIds: page.elementIds }, {
                id,
                type: 'table',
                page: rawPage.page,
                readingOrder: page.elementIds.length,
                bbox: table.bbox || null,
                rows,
                cells,
                text: rows.map(row => row.join(' | ')).join('\n'),
                citation: citation(documentId, generation, rawPage.page, id, table.bbox || null),
                ...elementFingerprints('table', rawPage.page, table.bbox, rows),
            });
        });

        (rawPage.images || []).forEach((image, index) => {
            const id = `figure:${rawPage.page}:${index + 1}`;
            const assetId = `asset:${rawPage.page}:figure:${index + 1}`;
            const asset = {
                id: assetId,
                kind: 'figure',
                documentId,
                extractionFingerprint: generation,
                mimeType: image.mimeType || 'image/png',
                width: image.width || 0,
                height: image.height || 0,
                data: image.data || null,
                sha256: image.data ? sha256(Buffer.from(image.data, 'base64')) : null,
                uri: resourceUri(documentId, generation, 'asset', assetId),
            };
            assets.push(asset);
            addElement({ elements, elementIds: page.elementIds }, {
                id,
                type: 'figure',
                page: rawPage.page,
                readingOrder: page.elementIds.length,
                bbox: image.bbox || null,
                caption: image.caption || '',
                text: image.caption || '',
                asset: { ...asset, data: undefined, extractionFingerprint: generation },
                citation: citation(documentId, generation, rawPage.page, id, image.bbox || null),
                ...elementFingerprints('figure', rawPage.page, image.bbox, { sha256: asset.sha256, caption: image.caption || '' }),
            });
        });

        (rawPage.annotations || []).forEach((annotation, index) => {
            const id = `annotation:${rawPage.page}:${index + 1}`;
            addElement({ elements, elementIds: page.elementIds }, {
                id,
                type: 'annotation',
                page: rawPage.page,
                readingOrder: page.elementIds.length,
                bbox: annotation.bbox || annotation.rect || null,
                text: cleanText(annotation.contents || annotation.text || annotation.title),
                subtype: annotation.subtype || null,
                citation: citation(documentId, generation, rawPage.page, id, annotation.bbox || annotation.rect || null),
                ...elementFingerprints('annotation', rawPage.page, annotation.bbox || annotation.rect, annotation),
            });
        });

        (rawPage.links || []).forEach((link, index) => {
            const id = `link:${rawPage.page}:${index + 1}`;
            addElement({ elements, elementIds: page.elementIds }, {
                id,
                type: 'link',
                page: rawPage.page,
                readingOrder: page.elementIds.length,
                bbox: link.bbox || null,
                text: link.anchored || link.url || '',
                url: link.url || null,
                citation: citation(documentId, generation, rawPage.page, id, link.bbox || null),
                ...elementFingerprints('link', rawPage.page, link.bbox, link),
            });
        });

        pages.push(page);
    }

    return {
        schemaVersion: SCHEMA_VERSION,
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
        warnings: pages.flatMap(page => page.warnings.map(message => ({ code: 'page_warning', page: page.number, message }))),
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
    if (current.documentId !== incoming.documentId || current.extractionFingerprint !== incoming.extractionFingerprint) {
        throw new Error('Cannot merge different document generations');
    }
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
