const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenize(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('und').match(TOKEN_PATTERN) || [];
}

function searchable(element) {
    if (element.type === 'table') return element.text || '';
    if (element.type === 'figure') return element.caption || '';
    return element.text || '';
}

export function buildBm25(model) {
    const metadataText = Object.entries(model.metadata || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
    const supplemental = [
        metadataText && {
            id: 'metadata:document',
            page: 1,
            type: 'metadata',
            readingOrder: -2,
            text: metadataText,
            citation: { documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, pageId: 'page:1', elementId: 'metadata:document', bbox: null },
        },
        ...(model.outline || []).map((entry, index) => ({
            id: `outline:${index + 1}`,
            page: Number(entry.page || 1),
            type: 'outline',
            readingOrder: -1,
            text: entry.title || '',
            citation: { documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, pageId: `page:${Number(entry.page || 1)}`, elementId: `outline:${index + 1}`, bbox: null },
        })),
    ].filter(Boolean);
    const documents = [...model.elements, ...supplemental]
        .map(element => ({
            id: element.id,
            page: element.page,
            type: element.type,
            readingOrder: element.readingOrder,
            text: searchable(element),
            citation: element.citation,
            tokens: tokenize(searchable(element)),
        }))
        .filter(document => document.tokens.length);
    for (const document of documents) {
        const positions = {};
        document.tokens.forEach((token, index) => (positions[token] ||= []).push(index));
        document.positions = positions;
    }
    const documentFrequency = new Map();
    for (const document of documents) {
        for (const token of new Set(document.tokens)) {
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }
    }
    return {
        version: 1,
        averageLength: documents.reduce((sum, item) => sum + item.tokens.length, 0) / Math.max(1, documents.length),
        documentFrequency: Object.fromEntries([...documentFrequency.entries()].sort(([a], [b]) => a.localeCompare(b))),
        documents,
    };
}

export function searchBm25(index, query, options = {}) {
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) return [];
    const k1 = 1.2;
    const b = 0.75;
    const total = index.documents.length;
    const pageSet = options.pages ? new Set(options.pages) : null;
    const typeSet = options.elementTypes ? new Set(options.elementTypes) : null;
    const matches = [];
    for (const document of index.documents) {
        if (pageSet && !pageSet.has(document.page)) continue;
        if (typeSet && !typeSet.has(document.type)) continue;
        const frequencies = new Map();
        document.tokens.forEach(token => frequencies.set(token, (frequencies.get(token) || 0) + 1));
        let score = 0;
        const matchedTerms = [];
        for (const token of queryTokens) {
            const frequency = frequencies.get(token) || 0;
            if (!frequency) continue;
            matchedTerms.push(token);
            const df = index.documentFrequency[token] || 0;
            const idf = Math.log(1 + ((total - df + 0.5) / (df + 0.5)));
            const denominator = frequency + k1 * (1 - b + b * document.tokens.length / Math.max(1, index.averageLength));
            score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0) {
            matches.push({
                id: document.id,
                page: document.page,
                type: document.type,
                readingOrder: document.readingOrder,
                score,
                matchedTerms,
                snippet: document.text.slice(0, options.snippetChars || 500),
                citation: document.citation,
            });
        }
    }
    return matches.sort((a, b) => b.score - a.score || a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
}
