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

export function buildMcidMapAndRawItems(textContentItems, pageHeight) {
    const mcidMap = new Map();
    const rawItems = [];
    for (const item of textContentItems) {
        if (!item?.str) {
            continue;
        }
        const x = item.transform?.[4] ?? 0;
        const y = item.transform?.[5] ?? 0;
        const height = item.height ?? Math.hypot(item.transform?.[1] ?? 0, item.transform?.[3] ?? 0) ?? 0;
        const yTop = pageHeight - y - height;
        const entry = {
            str: item.str,
            x,
            yTop,
            w: item.width ?? 0,
            h: height || 12,
            mcid: item.markedContentId ?? null,
        };
        rawItems.push(entry);
        if (entry.mcid != null) {
            const existing = mcidMap.get(entry.mcid);
            if (existing) {
                existing.text = existing.text ? `${existing.text} ${entry.str}` : entry.str;
                existing.yTop = Math.min(existing.yTop, entry.yTop);
            } else {
                mcidMap.set(entry.mcid, { text: entry.str, yTop: entry.yTop });
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
    const { mcidMap, rawItems } = buildMcidMapAndRawItems(textContent?.items ?? [], pageHeight);
    return { pageNum, pdfjsPage, viewport, pageHeight, rawItems, mcidMap };
}
