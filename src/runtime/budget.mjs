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

const HARD_BUDGET = Object.freeze({
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
