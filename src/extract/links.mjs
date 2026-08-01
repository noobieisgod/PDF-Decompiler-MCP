import { ROW_Y_TOLERANCE } from '../config/constants.mjs';

const ANN_LABEL = {
    Text: 'Note',
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'StrikeOut',
    Squiggly: 'Squiggly',
    Link: 'Link',
    FreeText: 'FreeText',
};

export async function getPageAnnotations(pdfjsPage, pageHeight) {
    try {
        const anns = await pdfjsPage.getAnnotations({ intent: 'display' });
        const result = [];
        for (const ann of anns) {
            const subtype = ann.subtype;
            if (subtype === 'Widget' || subtype === 'Popup') {
                continue;
            }
            if (subtype === 'Link' && !ann.url && !ann.contents?.trim()) {
                continue;
            }
            const output = { type: ANN_LABEL[subtype] ?? subtype };
            if (ann.title?.trim()) {
                output.author = ann.title.trim();
            }
            if (ann.contents?.trim()) {
                output.content = ann.contents.trim();
            }
            if (subtype === 'Link' && ann.url) {
                output.url = ann.url;
            }
            if (ann.rect) {
                output.x = ann.rect[0];
                output.x2 = ann.rect[2];
                output.yTop = Math.round(pageHeight - ann.rect[3]);
                output.yBottom = Math.round(pageHeight - ann.rect[1]);
                output.y = output.yTop;
            }
            result.push(output);
        }
        return result;
    } catch {
        return [];
    }
}

function findBestLinkAnchor(textItems, annotation) {
    if (annotation.x == null || annotation.yTop == null) {
        return null;
    }
    let best = null;
    let bestScore = Infinity;
    for (const item of textItems) {
        const itemRight = item.x + (item.w || 0);
        const overlapsX = item.x <= (annotation.x2 ?? annotation.x) && itemRight >= annotation.x;
        const dy = Math.min(Math.abs(item.yTop - annotation.yTop), Math.abs(item.yTop - (annotation.yBottom ?? annotation.yTop)));
        let score = dy * 1000;
        if (overlapsX) {
            score -= 500;
        }
        score += Math.abs(item.x - annotation.x);
        if (score < bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return bestScore <= 8000 ? best : null;
}

export function anchorLinkAnnotations(textItems, annotations) {
    const linkMarkerMap = new Map();
    const links = [];
    let localLinkIdx = 0;
    for (const ann of annotations) {
        if ((ann.type !== 'Link' && !ann.url) || !ann.url) {
            continue;
        }
        const localId = `LNK_LOCAL_${localLinkIdx++}`;
        const anchorItem = findBestLinkAnchor(textItems, ann);
        ann.localId = localId;
        ann.anchored = !!anchorItem;
        links.push({ localId, url: ann.url, anchored: !!anchorItem });
        if (!anchorItem) {
            continue;
        }
        if (!linkMarkerMap.has(anchorItem)) {
            linkMarkerMap.set(anchorItem, []);
        }
        linkMarkerMap.get(anchorItem).push(`[${localId}]`);
    }
    return { linkMarkerMap, links };
}

export function buildPageTextWithLinks(textItems, imagePlacements, tables, imageIds, tableIds, linkMarkerMap) {
    const elements = [];
    for (const item of textItems) {
        elements.push({ yTop: item.yTop, x: item.x, str: item.str });
        const linkMarkers = linkMarkerMap?.get(item) ?? [];
        for (let idx = 0; idx < linkMarkers.length; idx += 1) {
            elements.push({
                yTop: item.yTop,
                x: (item.x ?? 0) + (item.w || 0) + ((idx + 1) * 2),
                str: linkMarkers[idx],
            });
        }
    }
    for (const [name, pos] of imagePlacements.entries()) {
        const id = imageIds.get(name);
        if (id) {
            elements.push({ yTop: pos.yTop, x: pos.x, str: `[${id}]` });
        }
    }
    for (const [idx, table] of tables.entries()) {
        const id = tableIds.get(idx);
        if (id) {
            elements.push({ yTop: table.yTop, x: 0, str: `[${id}]` });
        }
    }
    elements.sort((a, b) => {
        const dy = a.yTop - b.yTop;
        return Math.abs(dy) > ROW_Y_TOLERANCE ? dy : a.x - b.x;
    });
    const lines = [];
    let line = [];
    let lastY = null;
    for (const element of elements) {
        if (lastY !== null && Math.abs(element.yTop - lastY) > ROW_Y_TOLERANCE) {
            if (line.length) {
                lines.push(line.map(entry => entry.str).join(' '));
            }
            line = [];
        }
        line.push(element);
        lastY = element.yTop;
    }
    if (line.length) {
        lines.push(line.map(entry => entry.str).join(' '));
    }
    return lines.join('\n');
}
