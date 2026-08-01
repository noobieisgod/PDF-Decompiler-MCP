function clean(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getMupdfDocMetadata(mupdfDoc) {
    const metadata = {};
    const mappings = [
        ['info:Title', 'title'],
        ['info:Author', 'author'],
        ['info:Subject', 'subject'],
        ['info:Keywords', 'keywords'],
        ['info:Creator', 'creator'],
        ['info:CreationDate', 'creationDate'],
        ['info:ModDate', 'modDate'],
    ];
    for (const [sourceKey, outputKey] of mappings) {
        const value = clean(mupdfDoc.getMetaData(sourceKey));
        if (value) {
            metadata[outputKey] = value;
        }
    }
    return Object.keys(metadata).length ? metadata : null;
}

function mapOutlineItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return null;
    }
    return items.map((item) => {
        const output = { title: (item.title ?? '').trim() || 'Untitled' };
        if (typeof item.page === 'number' && Number.isFinite(item.page)) {
            output.page = item.page + 1;
        }
        const children = mapOutlineItems(item.down ?? item.items ?? null);
        if (children?.length) {
            output.items = children;
        }
        return output;
    });
}

export function getMupdfDocOutline(mupdfDoc) {
    try {
        const outline = mupdfDoc.loadOutline();
        return mapOutlineItems(outline);
    } catch {
        return null;
    }
}
