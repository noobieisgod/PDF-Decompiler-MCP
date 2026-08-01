import {
    FOOTER_ZONE_PT,
    HEADER_ZONE_PT,
    HF_MAX_WORDS,
    HF_Y_BUCKET,
} from '../config/constants.mjs';

function hfKey(item, pageHeight) {
    const fromTop = item.yTop;
    const fromBottom = pageHeight - item.yTop;
    if (fromTop < HEADER_ZONE_PT) {
        return `H${Math.round(fromTop / HF_Y_BUCKET)}`;
    }
    if (fromBottom < FOOTER_ZONE_PT) {
        return `F${Math.round(fromBottom / HF_Y_BUCKET)}`;
    }
    return null;
}

function normalizeHFText(text) {
    return text
        .trim()
        .replace(/\d+/g, '#')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

export function hfSignature(item, pageHeight) {
    const key = hfKey(item, pageHeight);
    if (!key) {
        return null;
    }
    const norm = normalizeHFText(item.str);
    if (!norm) {
        return null;
    }
    return `${key}|${norm}`;
}

export function collectHFKeyPages(rawItems, pageHeight, pageIndex, keyPages) {
    for (const item of rawItems) {
        const sig = hfSignature(item, pageHeight);
        if (!sig) {
            continue;
        }
        if (!keyPages.has(sig)) {
            keyPages.set(sig, new Set());
        }
        keyPages.get(sig).add(pageIndex);
    }
}

export function collectHFSamples(rawItems, pageHeight, hfPositions, headerSamples, footerSamples) {
    let foundPageNums = false;
    for (const item of rawItems) {
        const sig = hfSignature(item, pageHeight);
        if (!sig || !hfPositions.has(sig)) {
            continue;
        }
        const [bucket] = sig.split('|');
        const text = item.str.trim();
        if (/^\d+$/.test(text)) {
            foundPageNums = true;
            continue;
        }
        if (text.split(/\s+/).length > HF_MAX_WORDS) {
            continue;
        }
        if (bucket.startsWith('H')) {
            headerSamples.add(text);
        } else if (bucket.startsWith('F')) {
            footerSamples.add(text);
        }
    }
    return foundPageNums;
}
