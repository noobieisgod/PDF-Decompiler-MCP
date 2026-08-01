import {
    CAPTION_MAX_DIST,
    MIN_COLUMN_GUTTER_LINE_COUNT,
    MIN_COLUMN_GUTTER_PAGE_HEIGHT_RATIO,
    MIN_COLUMN_GUTTER_PT,
    SPANNING_BLOCK_WIDTH_RATIO,
} from '../config/constants.mjs';
import { unionBBoxes } from '../model/geometry.mjs';

export function getTextStats(items) {
    const joined = items.map(item => item.str).join(' ').trim();
    const chars = joined.length;
    const words = joined ? joined.split(/\s+/).length : 0;
    const alnum = (joined.match(/[A-Za-z0-9]/g) ?? []).length;
    const printable = (joined.match(/[ -~]/g) ?? []).length;
    return {
        text: joined,
        chars,
        words,
        printable,
        alnumRatio: printable > 0 ? alnum / printable : 0,
    };
}

function buildTextLines(items) {
    if (items.length === 0) {
        return [];
    }
    const sorted = [...items].sort((a, b) => {
        const dy = a.yTop - b.yTop;
        return Math.abs(dy) > 4 ? dy : a.x - b.x;
    });
    const lines = [];
    let current = [];
    let currentY = sorted[0].yTop;
    for (const item of sorted) {
        if (current.length > 0 && Math.abs(item.yTop - currentY) > 4) {
            lines.push(current.sort((a, b) => a.x - b.x));
            current = [];
        }
        current.push(item);
        currentY = current.length === 1 ? item.yTop : Math.min(currentY, item.yTop);
    }
    if (current.length > 0) {
        lines.push(current.sort((a, b) => a.x - b.x));
    }
    return lines.flatMap(line => {
        const segments = [];
        let segment = [];
        for (const item of line) {
            const previous = segment.at(-1);
            const gap = previous ? item.x - (previous.x + (previous.w || 0)) : 0;
            if (previous && gap >= MIN_COLUMN_GUTTER_PT) {
                segments.push(segment);
                segment = [];
            }
            segment.push(item);
        }
        if (segment.length) segments.push(segment);
        return segments;
    });
}

function classifyBlockRole(text) {
    const trimmed = text.trim();
    if (!trimmed) {
        return 'text';
    }
    if (/^[-*]\s+\S/.test(trimmed) || /^\d+\.\s+\S/.test(trimmed)) {
        return 'list';
    }
    if (trimmed.length <= 80 && /^(?:[A-Z0-9][A-Z0-9\s,:;()/-]+)$/.test(trimmed)) {
        return 'heading';
    }
    return 'text';
}

function orderBlocks(blocks, viewport) {
    const width = viewport?.width || 0;
    const height = viewport?.height || 0;
    const spanning = blocks.filter(block => block.role === 'heading' || (width > 0 && block.bbox?.width / width >= SPANNING_BLOCK_WIDTH_RATIO));
    const candidates = blocks.filter(block => !spanning.includes(block) && block.bbox);
    const starts = [...new Set(candidates.map(block => block.bbox.x))].sort((a, b) => a - b);
    let split = null;
    let largestGap = 0;
    for (let index = 1; index < starts.length; index += 1) {
        const gap = starts[index] - starts[index - 1];
        if (gap > largestGap) {
            largestGap = gap;
            split = (starts[index] + starts[index - 1]) / 2;
        }
    }
    const left = split === null ? [] : candidates.filter(block => block.bbox.x + block.bbox.width / 2 < split);
    const right = split === null ? [] : candidates.filter(block => block.bbox.x + block.bbox.width / 2 >= split);
    const coverage = values => values.length ? (Math.max(...values.map(block => block.bbox.y + block.bbox.height)) - Math.min(...values.map(block => block.bbox.y))) / Math.max(1, height) : 0;
    const hasColumns = largestGap >= MIN_COLUMN_GUTTER_PT
        && left.length >= MIN_COLUMN_GUTTER_LINE_COUNT
        && right.length >= MIN_COLUMN_GUTTER_LINE_COUNT
        && Math.max(coverage(left), coverage(right)) >= MIN_COLUMN_GUTTER_PAGE_HEIGHT_RATIO;
    if (!hasColumns) {
        const ordered = [...blocks].sort((a, b) => a.bbox?.y - b.bbox?.y || a.bbox?.x - b.bbox?.x || a.sourceIndex - b.sourceIndex);
        const ambiguous = split !== null && largestGap >= MIN_COLUMN_GUTTER_PT && left.length && right.length;
        return { blocks: ordered, warnings: ambiguous ? [{ code: 'layout_ambiguous' }] : [] };
    }
    const columnSort = values => [...values].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.sourceIndex - b.sourceIndex);
    const firstColumnY = Math.min(...candidates.map(block => block.bbox.y));
    const lastColumnY = Math.max(...candidates.map(block => block.bbox.y + block.bbox.height));
    const before = columnSort(spanning.filter(block => block.bbox.y + block.bbox.height <= firstColumnY));
    const after = columnSort(spanning.filter(block => block.bbox.y >= lastColumnY));
    const middle = columnSort(spanning.filter(block => !before.includes(block) && !after.includes(block)));
    return { blocks: [...before, ...columnSort(left), ...columnSort(right), ...middle, ...after], warnings: middle.length ? [{ code: 'layout_ambiguous' }] : [] };
}

export function buildTextBlocks(items, viewport = null) {
    const lines = buildTextLines(items);
    if (lines.length === 0) {
        return { blocks: [], warnings: [] };
    }
    const blocks = [];
    let current = null;
    for (const lineItems of lines) {
        const text = lineItems.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!text) {
            continue;
        }
        const bbox = unionBBoxes(lineItems.map(item => item.bbox), viewport?.width, viewport?.height);
        const yTop = bbox?.y ?? Math.min(...lineItems.map(item => item.yTop));
        const yBottom = bbox ? bbox.y + bbox.height : Math.max(...lineItems.map(item => item.yTop + (item.h || 12)));
        const x = bbox?.x ?? Math.min(...lineItems.map(item => item.x));
        const sourceIndex = Math.min(...lineItems.map(item => items.indexOf(item)).filter(index => index >= 0));
        if (!current) {
            current = { text, yTop, yBottom, x, bboxes: [bbox], spans: [...lineItems], sourceIndex };
            continue;
        }
        const gap = yTop - current.yBottom;
        const aligned = Math.abs(x - current.x) <= 20;
        if (gap <= 10 && aligned) {
            current.text = `${current.text}\n${text}`;
            current.yBottom = yBottom;
            current.x = Math.min(current.x, x);
            current.bboxes.push(bbox);
            current.spans.push(...lineItems);
            current.sourceIndex = Math.min(current.sourceIndex, sourceIndex);
        } else {
            blocks.push({
                ...current,
                bbox: unionBBoxes(current.bboxes, viewport?.width, viewport?.height),
                role: classifyBlockRole(current.text),
            });
            current = { text, yTop, yBottom, x, bboxes: [bbox], spans: [...lineItems], sourceIndex };
        }
    }
    if (current) {
        blocks.push({
            ...current,
            bbox: unionBBoxes(current.bboxes, viewport?.width, viewport?.height),
            role: classifyBlockRole(current.text),
        });
    }
    return orderBlocks(blocks.map(({ bboxes, ...block }) => block), viewport);
}

export function normalizeLooseText(text) {
    return text
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .trim()
        .toLowerCase();
}

export function getDominantBlockRole(textBlocks) {
    if (!textBlocks.length) {
        return 'text';
    }
    const counts = new Map();
    for (const block of textBlocks) {
        counts.set(block.role, (counts.get(block.role) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'text';
}

export function groupItemsIntoRows(items) {
    const sorted = [...items].sort((a, b) => {
        const dy = a.yTop - b.yTop;
        return Math.abs(dy) > 4 ? dy : a.x - b.x;
    });
    const rows = [];
    for (const item of sorted) {
        const row = rows.find(existing => Math.abs(existing[0].yTop - item.yTop) <= 4);
        if (row) {
            row.push(item);
        } else {
            rows.push([item]);
        }
    }
    return rows;
}

export function findCaptionForImage(imagePos, textBlocks) {
    const candidates = textBlocks.filter(block => {
        const verticallyClose = Math.abs(block.yTop - (imagePos.yTop + imagePos.h)) <= CAPTION_MAX_DIST
            || Math.abs((block.yBottom ?? block.yTop) - imagePos.yTop) <= CAPTION_MAX_DIST;
        const horizontallyNear = block.x <= imagePos.x + imagePos.w + 48
            && block.x + 480 >= imagePos.x - 48;
        return verticallyClose && horizontallyNear;
    });
    const match = candidates.sort((a, b) => Math.abs(a.yTop - imagePos.yTop) - Math.abs(b.yTop - imagePos.yTop))[0];
    return match?.text?.replace(/\s+/g, ' ').trim() || null;
}
