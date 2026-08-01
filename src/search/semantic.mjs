import { pathToFileURL } from 'node:url';

export const MODEL = Object.freeze({
    repository: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
    dtype: 'fp32',
    dimension: 384,
    pooling: 'mean',
    normalize: true,
    expectedBytes: 91_086_568,
    license: 'Apache-2.0',
    files: {
        'onnx/model.onnx': { bytes: 56_796, sha256: '2f019cf6217537cc4bfc7f5192f21dea1e18445177edaab0bc6163a813e5c7a1' },
        'onnx/model.onnx_data': { bytes: 90_261_504, sha256: '60c758432aa596c30a122942dfe594c457d4d713f890926f1c5f920bd496c8de' },
        'config.json': { bytes: 794, sha256: 'fe5da868b77bdb104140822a5af0837cb6450ad6de8ff3dfcc8dd44ddd3e3ae7' },
        'special_tokens_map.json': { bytes: 695, sha256: '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a' },
        'tokenizer.json': { bytes: 533_808, sha256: '07805d116826679de90b4edeb2222269c4b8753bc0981be4399f732b2708e904' },
        'tokenizer_config.json': { bytes: 1_463, sha256: 'e10bb633ba0d7f69ed342ae7de607f36b39ce53b455fbda69c71700bf57e6f66' },
        'vocab.txt': { bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' },
    },
});

function dot(a, b) {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
    return sum;
}

export async function createEmbedder(config, cacheDirectory, injected = null) {
    if (injected) return injected;
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = cacheDirectory;
    env.allowRemoteModels = Boolean(config.semantic.allowDownload);
    env.allowLocalModels = true;
    if (!config.semantic.allowDownload) env.localModelPath = pathToFileURL(cacheDirectory).href;
    const extractor = await pipeline('feature-extraction', MODEL.repository, {
        revision: MODEL.revision,
        dtype: MODEL.dtype,
    });
    return async texts => {
        const tensor = await extractor(texts, { pooling: MODEL.pooling, normalize: MODEL.normalize });
        const values = tensor.tolist();
        if (values.some(vector => vector.length !== MODEL.dimension)) throw new Error('Unexpected semantic embedding dimension');
        return values;
    };
}

export async function buildSemanticIndex(model, embedder) {
    const documents = model.elements.filter(element => String(element.text || element.caption || '').trim());
    const embeddings = await embedder(documents.map(element => element.text || element.caption));
    return {
        version: 1,
        model: MODEL,
        documents: documents.map((element, index) => ({
            id: element.id,
            page: element.page,
            type: element.type,
            readingOrder: element.readingOrder,
            citation: element.citation,
            text: element.text || element.caption,
            embedding: embeddings[index],
        })),
    };
}

export async function searchSemantic(index, query, embedder, options = {}) {
    const [queryEmbedding] = await embedder([query]);
    const pageSet = options.pages ? new Set(options.pages) : null;
    const typeSet = options.elementTypes ? new Set(options.elementTypes) : null;
    return index.documents
        .filter(document => (!pageSet || pageSet.has(document.page)) && (!typeSet || typeSet.has(document.type)))
        .map(document => ({
            id: document.id,
            page: document.page,
            type: document.type,
            readingOrder: document.readingOrder,
            score: dot(queryEmbedding, document.embedding),
            snippet: document.text.slice(0, options.snippetChars || 500),
            citation: document.citation,
        }))
        .sort((a, b) => b.score - a.score || a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
}

export function reciprocalRankFusion(rankings, k = 60) {
    const combined = new Map();
    for (const ranking of rankings) {
        ranking.forEach((item, index) => {
            const current = combined.get(item.id) || { ...item, score: 0, componentScores: [] };
            current.score += 1 / (k + index + 1);
            current.componentScores.push(item.score);
            combined.set(item.id, current);
        });
    }
    return [...combined.values()].sort((a, b) => b.score - a.score || a.page - b.page || a.readingOrder - b.readingOrder || a.id.localeCompare(b.id));
}
