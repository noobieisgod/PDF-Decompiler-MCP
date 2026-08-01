import {
    LINK_ANCHOR_BOUNDARY_EPSILON_PT,
    LINK_ANCHOR_MAX_COMPONENT_SCORE_DELTA,
    LINK_ANCHOR_MAX_SAME_LINE_GAP_PT,
    LINK_ANCHOR_MIN_SPAN_OVERLAP_RATIO,
    ROW_Y_TOLERANCE,
} from '../config/constants.mjs';
import { pdfRectToBBox } from '../model/geometry.mjs';

const SUPPORTED_ANNOTATIONS = new Set(['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'FreeText']);
const FLAG_NAMES = [
    [1, 'invisible'], [2, 'hidden'], [4, 'print'], [8, 'no_zoom'], [16, 'no_rotate'],
    [32, 'no_view'], [64, 'read_only'], [128, 'locked'], [256, 'toggle_no_view'], [512, 'locked_contents'],
];

function cleanString(value, max = 4096) {
    const raw = typeof value === 'string' ? value : value?.str;
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
    return cleaned || null;
}

function parsePdfDate(value) {
    const raw = cleanString(value, 64);
    if (!raw) return null;
    const match = /^D:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
    if (!match) {
        const parsed = new Date(raw);
        return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
    }
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2] || 1) - 1, Number(match[3] || 1), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0)));
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function annotationFlags(value) {
    if (!Number.isInteger(value) || value < 0) return null;
    return { raw: value, names: FLAG_NAMES.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name) };
}

function annotationColor(value) {
    if (!value || typeof value.length !== 'number' || value.length < 3) return null;
    const color = Array.from(value).slice(0, 3).map(Number);
    return color.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255) ? color : null;
}

export async function getPageAnnotations(pdfjsPage, viewport, resolveDestination) {
    try {
        const raw = await pdfjsPage.getAnnotations({ intent: 'display' });
        const annotations = [];
        const links = [];
        const warnings = [];
        let widgetCount = 0;
        for (let sourceIndex = 0; sourceIndex < raw.length; sourceIndex += 1) {
            const ann = raw[sourceIndex];
            const subtype = cleanString(ann.subtype, 64) || 'Unknown';
            if (subtype === 'Widget') {
                widgetCount += 1;
                continue;
            }
            if (subtype === 'Popup') continue;
            const bbox = pdfRectToBBox(ann.rect, viewport);
            const sourceId = cleanString(ann.id, 256);
            if (subtype === 'Link') {
                let destination = null;
                if (ann.dest != null) {
                    try {
                        destination = await resolveDestination(ann.dest);
                        if (destination?.kind === 'unresolved') warnings.push({ code: 'link_destination_unresolved', sourceId });
                    } catch {
                        warnings.push({ code: 'link_destination_invalid', sourceId });
                    }
                }
                const url = cleanString(ann.url || ann.unsafeUrl, 8192);
                const overlaidText = cleanString(ann.overlaidText, 4096);
                const annotationText = cleanString(ann.contentsObj || ann.contents, 4096);
                if (!url && !destination && !overlaidText && !annotationText) {
                    warnings.push({ code: 'link_incomplete', sourceId });
                    continue;
                }
                links.push({
                    bbox,
                    url,
                    destination,
                    overlaidText,
                    annotationText,
                    sourceId,
                    subtype,
                    sourceIndex,
                });
                continue;
            }
            annotations.push({
                subtype,
                text: cleanString(ann.contentsObj || ann.contents, 4096),
                bbox,
                page: null,
                author: cleanString(ann.titleObj || ann.title, 512),
                createdAt: parsePdfDate(ann.creationDate),
                modifiedAt: parsePdfDate(ann.modificationDate),
                color: annotationColor(ann.color),
                flags: annotationFlags(ann.annotationFlags),
                parentSourceId: cleanString(ann.parentId, 256),
                replyToSourceId: cleanString(ann.inReplyTo, 256),
                supported: SUPPORTED_ANNOTATIONS.has(subtype),
                provenance: { backend: 'pdfjs', sourceId, sourceSubtype: subtype },
                sourceIndex,
            });
            if (!SUPPORTED_ANNOTATIONS.has(subtype)) warnings.push({ code: 'annotation_fields_partial', sourceId, subtype });
        }
        return { annotations, links, widgetCount, warnings };
    } catch {
        return { annotations: [], links: [], widgetCount: 0, warnings: [{ code: 'annotation_extraction_failed' }] };
    }
}

function intersection(a, b) {
    if (!a || !b) return null;
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.width, b.x + b.width);
    const y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 - x1 <= LINK_ANCHOR_BOUNDARY_EPSILON_PT || y2 - y1 <= LINK_ANCHOR_BOUNDARY_EPSILON_PT) return null;
    return { width: x2 - x1, height: y2 - y1, area: (x2 - x1) * (y2 - y1) };
}

function anchorCandidates(textItems, link) {
    return textItems.map((item, sourceIndex) => {
        const overlap = intersection(item.bbox, link.bbox);
        const area = item.bbox ? item.bbox.width * item.bbox.height : 0;
        const ratio = overlap && area > 0 ? overlap.area / area : 0;
        return { item, sourceIndex, ratio };
    }).filter(candidate => candidate.ratio >= LINK_ANCHOR_MIN_SPAN_OVERLAP_RATIO);
}

function lineClusters(candidates) {
    const sorted = [...candidates].sort((a, b) => a.item.bbox.y - b.item.bbox.y || a.item.bbox.x - b.item.bbox.x || a.sourceIndex - b.sourceIndex);
    const lines = [];
    for (const candidate of sorted) {
        const line = lines.find(value => Math.abs(value.y - candidate.item.bbox.y) <= Math.max(ROW_Y_TOLERANCE, candidate.item.bbox.height * 0.35));
        if (line) {
            line.items.push(candidate);
            line.y = Math.min(line.y, candidate.item.bbox.y);
        } else {
            lines.push({ y: candidate.item.bbox.y, items: [candidate] });
        }
    }
    return lines.map(line => ({
        y: line.y,
        items: line.items.sort((a, b) => a.item.bbox.x - b.item.bbox.x || a.sourceIndex - b.sourceIndex),
    })).sort((a, b) => a.y - b.y);
}

function components(candidates) {
    const result = [];
    for (const line of lineClusters(candidates)) {
        let current = [];
        for (const candidate of line.items) {
            const previous = current.at(-1);
            const gap = previous ? candidate.item.bbox.x - (previous.item.bbox.x + previous.item.bbox.width) : 0;
            const fontGap = previous ? Math.max(LINK_ANCHOR_MAX_SAME_LINE_GAP_PT, Math.min(previous.item.bbox.height, candidate.item.bbox.height) * 0.5) : 0;
            if (previous && gap > fontGap) {
                result.push(current);
                current = [];
            }
            current.push(candidate);
        }
        if (current.length) result.push(current);
    }
    for (let index = 1; index < result.length; index += 1) {
        const previous = result[index - 1];
        const current = result[index];
        const previousBottom = Math.max(...previous.map(value => value.item.bbox.y + value.item.bbox.height));
        const currentTop = Math.min(...current.map(value => value.item.bbox.y));
        const lineHeight = Math.max(...previous.map(value => value.item.bbox.height), ...current.map(value => value.item.bbox.height));
        const xOverlap = Math.min(
            Math.max(...previous.map(value => value.item.bbox.x + value.item.bbox.width)),
            Math.max(...current.map(value => value.item.bbox.x + value.item.bbox.width)),
        ) - Math.max(
            Math.min(...previous.map(value => value.item.bbox.x)),
            Math.min(...current.map(value => value.item.bbox.x)),
        );
        if (currentTop - previousBottom <= lineHeight * 1.5 && xOverlap > 0) {
            previous.push(...current);
            result.splice(index, 1);
            index -= 1;
        }
    }
    return result;
}

function componentText(component) {
    const seen = new Set();
    const lines = lineClusters(component.filter(candidate => {
        const key = `${candidate.item.str}\0${candidate.item.bbox.x}\0${candidate.item.bbox.y}\0${candidate.item.bbox.width}\0${candidate.item.bbox.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }));
    return lines.map(line => line.items.map(value => cleanString(value.item.str, 1024)).filter(Boolean).join(' ')).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function anchorLinkAnnotations(textItems, rawLinks) {
    const linkMarkerMap = new Map();
    const warnings = [];
    const claimed = new Map();
    const prepared = rawLinks.map((link, linkIndex) => {
        if (link.overlaidText) return { link, linkIndex, text: link.overlaidText, candidates: [], score: Infinity };
        const groups = components(anchorCandidates(textItems, link)).map(items => ({ items, score: items.reduce((sum, value) => sum + value.ratio, 0) })).sort((a, b) => b.score - a.score);
        if (groups.length > 1 && (groups[0].score - groups[1].score) / Math.max(groups[0].score, 1) <= LINK_ANCHOR_MAX_COMPONENT_SCORE_DELTA) {
            warnings.push({ code: 'link_anchor_ambiguous', sourceId: link.sourceId });
            return { link, linkIndex, text: null, candidates: [], score: 0 };
        }
        const candidates = groups[0]?.items || [];
        return { link, linkIndex, text: componentText(candidates) || null, candidates, score: groups[0]?.score || 0 };
    });
    for (const entry of prepared) {
        for (const candidate of entry.candidates) {
            const current = claimed.get(candidate.item);
            const choice = { entry, ratio: candidate.ratio, area: entry.link.bbox.width * entry.link.bbox.height };
            if (!current || choice.ratio > current.ratio || (choice.ratio === current.ratio && choice.area < current.area)
                || (choice.ratio === current.ratio && choice.area === current.area && entry.linkIndex < current.entry.linkIndex)) claimed.set(candidate.item, choice);
        }
    }
    const links = [];
    for (const entry of prepared) {
        const owned = entry.candidates.filter(candidate => claimed.get(candidate.item)?.entry === entry);
        const text = entry.link.overlaidText || componentText(owned) || (entry.candidates.length ? null : entry.text);
        const localId = `LNK_LOCAL_${links.length}`;
        const first = owned.sort((a, b) => a.item.bbox.y - b.item.bbox.y || a.item.bbox.x - b.item.bbox.x)[0]?.item;
        if (first) {
            if (!linkMarkerMap.has(first)) linkMarkerMap.set(first, []);
            linkMarkerMap.get(first).push(`[${localId}]`);
        }
        const targetKind = entry.link.url ? 'external_url' : entry.link.destination ? 'internal_destination' : 'unknown';
        if (targetKind === 'unknown' && !text) {
            warnings.push({ code: 'link_incomplete', sourceId: entry.link.sourceId });
            continue;
        }
        links.push({
            localId,
            bbox: entry.link.bbox,
            text,
            url: entry.link.url,
            destination: entry.link.destination,
            targetKind,
            anchored: Boolean(text),
            annotationText: entry.link.annotationText,
            anchorSource: entry.link.overlaidText ? 'overlaid_text' : text ? 'geometry_overlap' : 'none',
            provenance: { backend: 'pdfjs', source: 'link_annotation', sourceId: entry.link.sourceId, subtype: entry.link.subtype },
            sourceIndex: entry.link.sourceIndex,
        });
    }
    return { linkMarkerMap, links, warnings };
}

export function buildPageTextWithLinks(textItems, imagePlacements, tables, imageIds, tableIds, linkMarkerMap) {
    const elements = [];
    for (const item of textItems) {
        elements.push({ yTop: item.yTop, x: item.x, str: item.str });
        const linkMarkers = linkMarkerMap?.get(item) ?? [];
        for (let idx = 0; idx < linkMarkers.length; idx += 1) {
            elements.push({ yTop: item.yTop, x: item.x + item.w + ((idx + 1) * 2), str: linkMarkers[idx] });
        }
    }
    for (const [name, pos] of imagePlacements.entries()) {
        const id = imageIds.get(name);
        if (id) elements.push({ yTop: pos.yTop, x: pos.x, str: `[${id}]` });
    }
    for (const [idx, table] of tables.entries()) {
        const id = tableIds.get(idx);
        if (id) elements.push({ yTop: table.yTop, x: table.x ?? 0, str: `[${id}]` });
    }
    elements.sort((a, b) => Math.abs(a.yTop - b.yTop) > ROW_Y_TOLERANCE ? a.yTop - b.yTop : a.x - b.x);
    const lines = [];
    let line = [];
    let lastY = null;
    for (const element of elements) {
        if (lastY !== null && Math.abs(element.yTop - lastY) > ROW_Y_TOLERANCE) {
            if (line.length) lines.push(line.map(entry => entry.str).join(' '));
            line = [];
        }
        line.push(element);
        lastY = element.yTop;
    }
    if (line.length) lines.push(line.map(entry => entry.str).join(' '));
    return lines.join('\n');
}
