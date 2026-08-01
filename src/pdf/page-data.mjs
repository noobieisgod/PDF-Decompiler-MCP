export async function getDocMetadata(pdfjsDoc) {
    try {
        const { info, metadata } = await pdfjsDoc.getMetadata();
        const clean = value => (typeof value === 'string' && value.trim()) ? value.trim() : null;
        const docMetadata = {};
        if (clean(info?.Title)) {
            docMetadata.title = clean(info.Title);
        }
        if (clean(info?.Author)) {
            docMetadata.author = clean(info.Author);
        }
        if (clean(info?.Subject)) {
            docMetadata.subject = clean(info.Subject);
        }
        if (clean(info?.Keywords)) {
            docMetadata.keywords = clean(info.Keywords);
        }
        if (clean(info?.Creator)) {
            docMetadata.creator = clean(info.Creator);
        }
        if (clean(info?.CreationDate)) {
            docMetadata.creationDate = clean(info.CreationDate);
        }
        if (clean(info?.ModDate)) {
            docMetadata.modDate = clean(info.ModDate);
        }
        if (metadata) {
            if (!docMetadata.title && clean(metadata.get?.('dc:title'))) {
                docMetadata.title = clean(metadata.get('dc:title'));
            }
            if (!docMetadata.author && clean(metadata.get?.('dc:creator'))) {
                docMetadata.author = clean(metadata.get('dc:creator'));
            }
        }
        return Object.keys(docMetadata).length ? docMetadata : null;
    } catch {
        return null;
    }
}

export async function getDocOutline(pdfjsDoc) {
    try {
        const rawOutline = await pdfjsDoc.getOutline();
        if (!rawOutline?.length) {
            return null;
        }
        async function resolvePageNum(dest) {
            try {
                if (!dest) {
                    return null;
                }
                const explicitDest = typeof dest === 'string' ? await pdfjsDoc.getDestination(dest) : dest;
                if (!Array.isArray(explicitDest) || !explicitDest[0]) {
                    return null;
                }
                return (await pdfjsDoc.getPageIndex(explicitDest[0])) + 1;
            } catch {
                return null;
            }
        }
        async function formatItem(item) {
            const page = await resolvePageNum(item.dest);
            const output = { title: item.title };
            if (page !== null) {
                output.page = page;
            }
            if (item.items?.length) {
                output.items = await Promise.all(item.items.map(formatItem));
            }
            return output;
        }
        return await Promise.all(rawOutline.map(formatItem));
    } catch {
        return null;
    }
}

export function buildMcidMapAndRawItems(textContentItems, viewport) {
    const mcidMap = new Map();
    const rawItems = [];
    for (const item of textContentItems) {
        if (!item?.str) {
            continue;
        }
        const bbox = textItemBBox(item, viewport);
        const x = bbox?.x ?? 0;
        const yTop = bbox?.y ?? 0;
        const width = bbox?.width ?? 0;
        const height = bbox?.height ?? 0;
        const entry = {
            str: item.str,
            x,
            yTop,
            w: width,
            h: height || 12,
            bbox,
            mcid: item.markedContentId ?? null,
        };
        rawItems.push(entry);
        if (entry.mcid != null) {
            const existing = mcidMap.get(entry.mcid);
            if (existing) {
                existing.text = existing.text ? `${existing.text} ${entry.str}` : entry.str;
                existing.yTop = Math.min(existing.yTop, entry.yTop);
                if (entry.bbox) {
                    const x1 = Math.min(existing.bbox?.x ?? entry.bbox.x, entry.bbox.x);
                    const y1 = Math.min(existing.bbox?.y ?? entry.bbox.y, entry.bbox.y);
                    const x2 = Math.max((existing.bbox?.x ?? entry.bbox.x) + (existing.bbox?.width ?? 0), entry.bbox.x + entry.bbox.width);
                    const y2 = Math.max((existing.bbox?.y ?? entry.bbox.y) + (existing.bbox?.height ?? 0), entry.bbox.y + entry.bbox.height);
                    existing.bbox = normalizeBBox({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, viewport.width, viewport.height);
                }
            } else {
                mcidMap.set(entry.mcid, { text: entry.str, yTop: entry.yTop, bbox: entry.bbox });
            }
        }
    }
    return { mcidMap, rawItems };
}

export async function loadPageData(pdfjsDoc, pageNum) {
    const pdfjsPage = await pdfjsDoc.getPage(pageNum);
    const viewport = pdfjsPage.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    let textContent;
    try {
        textContent = await pdfjsPage.getTextContent({ includeMarkedContent: true });
    } catch {
        textContent = await pdfjsPage.getTextContent();
    }
    const { mcidMap, rawItems } = buildMcidMapAndRawItems(textContent?.items ?? [], viewport);
    const resolveDestination = async rawDestination => normalizeDestination(pdfjsDoc, rawDestination);
    return { pageNum, pdfjsPage, viewport, pageHeight, rawItems, mcidMap, resolveDestination };
}

function safeDestinationName(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
    return normalized || null;
}

async function explicitDestination(pdfjsDoc, value, kind, name = null) {
    if (!Array.isArray(value) || value.length < 2) return { kind: 'unresolved', name, page: null, x: null, y: null, zoom: null };
    let page = null;
    try {
        page = typeof value[0] === 'number' ? value[0] + 1 : (await pdfjsDoc.getPageIndex(value[0])) + 1;
    } catch {
        return { kind: 'unresolved', name, page: null, x: null, y: null, zoom: null };
    }
    const mode = typeof value[1]?.name === 'string' ? value[1].name : null;
    let x = null;
    let y = null;
    let zoom = null;
    try {
        const targetPage = await pdfjsDoc.getPage(page);
        const targetViewport = targetPage.getViewport({ scale: 1 });
        const rawX = ['XYZ', 'FitV', 'FitBV', 'FitR'].includes(mode) && Number.isFinite(value[2]) ? Number(value[2]) : null;
        const rawY = ['XYZ', 'FitH', 'FitBH'].includes(mode) && Number.isFinite(value[3]) ? Number(value[3]) : null;
        if (rawX !== null || rawY !== null) {
            const point = targetViewport.convertToViewportPoint(rawX ?? 0, rawY ?? targetPage.view?.[3] ?? 0);
            if (rawX !== null) x = Math.round(point[0] * 1000) / 1000;
            if (rawY !== null) y = Math.round(point[1] * 1000) / 1000;
        }
        zoom = mode === 'XYZ' && Number.isFinite(value[4]) ? Number(value[4]) : null;
        targetPage.cleanup();
    } catch {
        x = null;
        y = null;
        zoom = null;
    }
    return { kind, name, page, x, y, zoom };
}

export async function normalizeDestination(pdfjsDoc, rawDestination) {
    if (typeof rawDestination === 'string') {
        const name = safeDestinationName(rawDestination);
        if (!name) return { kind: 'unresolved', name: null, page: null, x: null, y: null, zoom: null };
        try {
            return explicitDestination(pdfjsDoc, await pdfjsDoc.getDestination(rawDestination), 'named', name);
        } catch {
            return { kind: 'unresolved', name, page: null, x: null, y: null, zoom: null };
        }
    }
    return explicitDestination(pdfjsDoc, rawDestination, 'explicit', null);
}
import { normalizeBBox, pdfRectToBBox, textItemBBox } from '../model/geometry.mjs';
