import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { MODEL, buildSemanticIndex, reciprocalRankFusion, searchSemantic } from '../src/search/semantic.mjs';
import { rawDocument } from './helpers.mjs';

const config = { extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'auto' };
const model = buildCanonicalModel(Buffer.from('%PDF-semantic'), rawDocument(), config, 'deps');
const embedder = async texts => texts.map(text => text.includes('page 1') ? [1, 0] : text.includes('page 2') ? [0, 1] : [1, 0]);

test('semantic ranking and reciprocal-rank fusion are deterministic with an injected offline embedder', async () => {
    const index = await buildSemanticIndex(model, embedder);
    const result = await searchSemantic(index, 'page 1', embedder);
    assert.equal(result[0].page, 1);
    assert.deepEqual(reciprocalRankFusion([result, [...result].reverse()], 60), reciprocalRankFusion([result, [...result].reverse()], 60));
    assert.equal(MODEL.dtype, 'fp32');
    assert.equal(MODEL.dimension, 384);
    assert.equal(MODEL.revision.length, 40);
    assert.ok(!Object.keys(MODEL.files).some(name => /q8/i.test(name)));
    assert.equal(Object.values(MODEL.files).reduce((sum, file) => sum + file.bytes, 0), MODEL.expectedBytes);
});
