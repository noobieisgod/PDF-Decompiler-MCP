import { CAPTION_MAX_DIST } from '../config/constants.mjs';

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
    return lines;
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

export function buildTextBlocks(items) {
    const lines = buildTextLines(items);
    if (lines.length === 0) {
        return [];
    }
    const blocks = [];
    let current = null;
    for (const lineItems of lines) {
        const text = lineItems.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
        if (!text) {
            continue;
        }
        const yTop = Math.min(...lineItems.map(item => item.yTop));
        const yBottom = Math.max(...lineItems.map(item => item.yTop + (item.h || 12)));
        const x = Math.min(...lineItems.map(item => item.x));
        if (!current) {
            current = { text, yTop, yBottom, x };
            continue;
        }
        const gap = yTop - current.yBottom;
        const aligned = Math.abs(x - current.x) <= 20;
        if (gap <= 10 && aligned) {
            current.text = `${current.text}\n${text}`;
            current.yBottom = yBottom;
            current.x = Math.min(current.x, x);
        } else {
            blocks.push({
                ...current,
                role: classifyBlockRole(current.text),
            });
            current = { text, yTop, yBottom, x };
        }
    }
    if (current) {
        blocks.push({
            ...current,
            role: classifyBlockRole(current.text),
        });
    }
    return blocks;
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
