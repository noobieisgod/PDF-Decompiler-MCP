import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { buildBm25, searchBm25, tokenize } from '../src/search/bm25.mjs';
import { rawDocument } from './helpers.mjs';

const config = { extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'auto' };
const model = buildCanonicalModel(Buffer.from('%PDF-alpha'), rawDocument(), config, 'deps');

test('BM25 is deterministic, Unicode normalized, positioned, and indexes metadata and outlines', () => {
    assert.deepEqual(tokenize('ＲＥＶＥＮＵＥ café'), ['revenue', 'café']);
    const index = buildBm25(model);
    assert.deepEqual(index, buildBm25(model));
    assert.ok(index.documents.every(document => Object.keys(document.positions).length));
    assert.equal(searchBm25(index, 'Revenue Overview')[0].type, 'outline');
    assert.equal(searchBm25(index, 'Synthetic Alpha')[0].type, 'metadata');
    assert.ok(searchBm25(index, 'deterministic').every(result => result.citation.extractionFingerprint === model.extractionFingerprint));
});

test('BM25 indexes prototype-named tokens without object prototype collisions', () => {
    const constructorModel = buildCanonicalModel(Buffer.from('%PDF-constructor'), {
        ...rawDocument(1),
        pages: [{ ...rawDocument(1).pages[0], text: 'constructor prototype toString', textBlocks: [{ text: 'constructor prototype toString', role: 'text', bbox: { x: 10, y: 10, width: 200, height: 20 } }] }],
    }, config, 'deps');
    const index = buildBm25(constructorModel);
    assert.equal(index.version, 2);
    assert.ok(searchBm25(index, 'constructor')[0].snippet.includes('constructor'));
});

test('BM25 snippets include neighboring values and adjacent hits are grouped without repeated page fragments', () => {
    const raw = rawDocument(1);
    raw.pages[0].tables = [];
    raw.pages[0].textBlocks = [
        { text: 'Net Income', role: 'text', bbox: { x: 10, y: 10, width: 100, height: 10 } },
        { text: 'NT$1,173.27 billion', role: 'text', bbox: { x: 120, y: 10, width: 150, height: 10 } },
        { text: 'Net Income attributable', role: 'text', bbox: { x: 10, y: 30, width: 170, height: 10 } },
    ];
    const local = buildCanonicalModel(Buffer.from('%PDF-search-context'), raw, config, 'deps');
    const results = searchBm25(buildBm25(local), 'Net Income');
    assert.ok(results[0].snippet.includes('NT$1,173.27 billion'));
    assert.equal(new Set(results.map(result => `${result.page}:${result.snippet}`)).size, results.length);
    assert.ok(results.every(result => result.contributingElementIds.length >= 1));
});
