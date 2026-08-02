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
    const canonicalElements = [...model.elements].sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
    const canonicalIds = new Set(canonicalElements.map(element => element.id));
    const sourceElements = [...canonicalElements, ...supplemental];
    const documents = sourceElements
        .map((element, index) => ({
            id: element.id,
            page: element.page,
            type: element.type,
            readingOrder: element.readingOrder,
            text: searchable(element),
            contextText: canonicalIds.has(element.id)
                ? [sourceElements[index - 1], element, sourceElements[index + 1]]
                    .filter(candidate => candidate?.page === element.page && canonicalIds.has(candidate.id))
                    .map(searchable).filter(Boolean).join('\n')
                : searchable(element),
            citation: element.citation,
            tokens: tokenize(searchable(element)),
        }))
        .filter(document => document.tokens.length);
    for (const document of documents) {
        const positions = Object.create(null);
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
        version: 2,
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
            const snippetChars = options.snippetChars || 500;
            const snippetSource = document.contextText || document.text;
            const normalizedText = snippetSource.normalize('NFKC').toLocaleLowerCase('und');
            const firstMatch = queryTokens.map(token => normalizedText.indexOf(token)).filter(position => position >= 0).sort((a, b) => a - b)[0] ?? 0;
            const start = Math.max(0, firstMatch - Math.floor(snippetChars / 3));
            matches.push({
                id: document.id,
                page: document.page,
                type: document.type,
                readingOrder: document.readingOrder,
                score,
                matchedTerms,
                snippet: snippetSource.slice(start, start + snippetChars),
                citation: document.citation,
                citations: [document.citation],
                contributingElementIds: [document.id],
            });
        }
    }
    const grouped = [];
    for (const match of matches.sort((a, b) => a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id))) {
        const previous = grouped.at(-1);
        if (previous && previous.page === match.page && previous.type !== 'metadata' && previous.type !== 'outline'
            && match.type !== 'metadata' && match.type !== 'outline' && match.readingOrder <= previous.lastReadingOrder + 1) {
            previous.score = Math.max(previous.score, match.score) + Math.min(previous.score, match.score) * 0.1;
            previous.matchedTerms = [...new Set([...previous.matchedTerms, ...match.matchedTerms])];
            previous.contributingElementIds.push(match.id);
            previous.citations.push(match.citation);
            previous.lastReadingOrder = match.readingOrder;
            if (!previous.snippet.includes(match.snippet)) previous.snippet = `${previous.snippet}\n${match.snippet}`.slice(0, options.snippetChars || 500);
        } else {
            grouped.push({ ...match, lastReadingOrder: match.readingOrder });
        }
    }
    const ranked = grouped.map(({ lastReadingOrder, ...result }) => result).sort((a, b) => b.score - a.score || a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
    const seen = new Set();
    return ranked.filter(result => {
        const key = `${result.page}:${result.snippet.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('und')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
