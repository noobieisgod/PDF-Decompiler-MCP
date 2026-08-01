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
