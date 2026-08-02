import { PdfDecompilerError } from '../core/errors.mjs';

export const DEFAULT_BUDGET = Object.freeze({
    estimatedTokens: 8_000,
    responseBytes: 1_000_000,
    pages: 20,
    textBlocks: 200,
    tables: 20,
    figures: 10,
    renderedPages: 4,
    imageDimension: 1_200,
});

export const HARD_BUDGET = Object.freeze({
    estimatedTokens: 32_000,
    responseBytes: 4_000_000,
    pages: 100,
    textBlocks: 2_000,
    tables: 200,
    figures: 100,
    renderedPages: 20,
    imageDimension: 4_096,
});

export function resolveBudget(requested = {}) {
    return Object.fromEntries(Object.keys(DEFAULT_BUDGET).map(key => [key, Math.max(0, Math.min(Number(requested[key] ?? DEFAULT_BUDGET[key]), HARD_BUDGET[key]))]));
}

export function estimatedTextTokens(value) {
    return Math.ceil(Buffer.byteLength(String(value || ''), 'utf8') / 4);
}

export function applyResultBudget(items, budget, start = 0) {
    const selected = [];
    const omissions = [];
    let responseBytes = 0;
    let estimatedTokens = 0;
    const counts = { pages: new Set(), textBlocks: 0, tables: 0, figures: 0 };
    for (let index = start; index < items.length; index += 1) {
        const item = items[index];
        const encoded = JSON.stringify(item);
        const bytes = Buffer.byteLength(encoded);
        const tokens = estimatedTextTokens(encoded);
        const nextPages = new Set(counts.pages).add(item.page);
        const next = {
            textBlocks: counts.textBlocks + (item.type === 'block' ? 1 : 0),
            tables: counts.tables + (item.type === 'table' ? 1 : 0),
            figures: counts.figures + (item.type === 'figure' ? 1 : 0),
        };
        const reason = responseBytes + bytes > budget.responseBytes ? 'response_bytes'
            : estimatedTokens + tokens > budget.estimatedTokens ? 'estimated_tokens'
                : nextPages.size > budget.pages ? 'pages'
                    : next.textBlocks > budget.textBlocks ? 'text_blocks'
                        : next.tables > budget.tables ? 'tables'
                            : next.figures > budget.figures ? 'figures' : null;
        if (reason) {
            omissions.push({ id: item.id, reason });
            return {
                items: selected,
                omissions,
                nextOffset: index,
                usage: {
                    responseBytes,
                    estimatedTokens,
                    pages: counts.pages.size,
                    textBlocks: counts.textBlocks,
                    tables: counts.tables,
                    figures: counts.figures,
                },
            };
        }
        selected.push(item);
        responseBytes += bytes;
        estimatedTokens += tokens;
        counts.pages = nextPages;
        counts.textBlocks = next.textBlocks;
        counts.tables = next.tables;
        counts.figures = next.figures;
    }
    return {
        items: selected,
        omissions,
        nextOffset: null,
        usage: { responseBytes, estimatedTokens, pages: counts.pages.size, textBlocks: counts.textBlocks, tables: counts.tables, figures: counts.figures },
    };
}

export function normalizePageOrder(pages, ranges, totalPages, fallbackPages = []) {
    const result = [];
    const seen = new Set();
    const add = page => {
        if (!Number.isInteger(page) || page < 1 || page > totalPages) return;
        if (!seen.has(page)) {
            seen.add(page);
            result.push(page);
        }
    };
    for (const page of pages || []) add(page);
    for (const range of ranges || []) {
        const start = range.start ?? 1;
        const end = range.end ?? totalPages;
        if (end < start) throw new PdfDecompilerError('invalid_page_range', 'A page range end cannot precede its start.');
        for (let page = start; page <= Math.min(end, totalPages); page += 1) add(page);
    }
    if (!result.length) [...fallbackPages].sort((a, b) => a - b).forEach(add);
    return result;
}

function countsFor(item) {
    return {
        textBlocks: item.type === 'block' ? 1 : 0,
        tables: item.type === 'table' ? 1 : 0,
        figures: item.type === 'figure' ? 1 : 0,
    };
}

function fits(usage, delta, budget, includePage) {
    return usage.responseBytes + delta.bytes <= budget.responseBytes
        && usage.estimatedTokens + delta.tokens <= budget.estimatedTokens
        && usage.textBlocks + delta.textBlocks <= budget.textBlocks
        && usage.tables + delta.tables <= budget.tables
        && usage.figures + delta.figures <= budget.figures
        && usage.pages.size + (includePage ? 1 : 0) <= budget.pages;
}

export function applyFairPageBudget(pageItems, budget, position = null, represent = item => ({ value: item })) {
    const offsets = pageItems.map((entry, index) => Number(position?.offsets?.[index] || 0));
    let pageIndex = Number(position?.pageIndex || 0) % Math.max(1, pageItems.length);
    const selected = [];
    const omissions = [];
    const usage = { responseBytes: 0, estimatedTokens: 0, pages: new Set(), textBlocks: 0, tables: 0, figures: 0 };
    let idleVisits = 0;
    const remaining = () => pageItems.some((entry, index) => offsets[index] < entry.items.length);
    while (pageItems.length && remaining() && idleVisits < pageItems.length) {
        const entry = pageItems[pageIndex];
        const offset = offsets[pageIndex];
        let progressed = false;
        if (offset < entry.items.length) {
            const item = entry.items[offset];
            const representation = represent(item, { page: entry.page, offset }) || { value: item };
            const encoded = representation.encoded || JSON.stringify(representation.value);
            const counts = representation.counts || countsFor(item);
            const delta = {
                bytes: representation.bytes ?? Buffer.byteLength(encoded),
                tokens: representation.tokens ?? estimatedTextTokens(encoded),
                ...counts,
            };
            const includePage = !usage.pages.has(entry.page);
            if (fits(usage, delta, budget, includePage)) {
                selected.push(representation.value);
                usage.responseBytes += delta.bytes;
                usage.estimatedTokens += delta.tokens;
                usage.textBlocks += delta.textBlocks;
                usage.tables += delta.tables;
                usage.figures += delta.figures;
                usage.pages.add(entry.page);
                offsets[pageIndex] += 1;
                progressed = true;
            } else {
                const empty = { responseBytes: 0, estimatedTokens: 0, pages: new Set(), textBlocks: 0, tables: 0, figures: 0 };
                if (!fits(empty, delta, budget, true)) {
                    omissions.push({ id: item.id, reason: representation.oversizeReason || 'item_exceeds_budget' });
                    offsets[pageIndex] += 1;
                    progressed = true;
                }
            }
        }
        pageIndex = (pageIndex + 1) % pageItems.length;
        idleVisits = progressed ? 0 : idleVisits + 1;
    }
    const nextPosition = remaining() ? { offsets, pageIndex } : null;
    return {
        items: selected,
        omissions,
        nextPosition,
        usage: { ...usage, pages: usage.pages.size },
    };
}
