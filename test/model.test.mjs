import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCanonicalModel, extractionFingerprint } from '../src/model/canonical.mjs';
import { rawDocument } from './helpers.mjs';
import { BlockElementSchema } from '../src/server/schemas.mjs';

const bytes = Buffer.from('%PDF-synthetic');
const config = { schemaVersion: '3.0.0', extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'auto' };

test('identifiers are stable only within the documented extraction generation inputs', () => {
    const first = buildCanonicalModel(bytes, rawDocument(), config, 'dependencies');
    const second = buildCanonicalModel(bytes, rawDocument(), config, 'dependencies');
    assert.equal(first.documentId, second.documentId);
    assert.equal(first.extractionFingerprint, second.extractionFingerprint);
    assert.deepEqual(first.elements.map(item => item.id), second.elements.map(item => item.id));
    assert.ok(first.elements.every(item => item.citation.extractionFingerprint === first.extractionFingerprint));
    assert.notEqual(extractionFingerprint({ ...config, extractorVersion: '3.0.1' }, 'dependencies'), first.extractionFingerprint);
    assert.notEqual(extractionFingerprint(config, 'changed-dependencies'), first.extractionFingerprint);
    assert.notEqual(extractionFingerprint({ ...config, ocrPolicy: 'off' }, 'dependencies'), first.extractionFingerprint);
});

test('tables expose deterministic cell records and supplemental fingerprints', () => {
    const model = buildCanonicalModel(bytes, rawDocument(), config, 'dependencies');
    const table = model.elements.find(item => item.type === 'table');
    assert.equal(table.cells[0].id, 'cell:1:1:1:1');
    assert.match(table.contentFingerprint, /^[a-f0-9]{64}$/);
    assert.match(table.locationFingerprint, /^[a-f0-9]{64}$/);
});

test('semantic block schema rejects invalid role, list, code, and OCR combinations', () => {
    const block = buildCanonicalModel(bytes, rawDocument(1), config, 'dependencies').elements.find(element => element.type === 'block');
    assert.equal(BlockElementSchema.safeParse(block).success, true);
    assert.equal(BlockElementSchema.safeParse({ ...block, role: 'heading', headingLevel: null }).success, false);
    assert.equal(BlockElementSchema.safeParse({ ...block, role: 'text', listKind: 'ordered', listLevel: 0, listItemId: 'x' }).success, false);
    assert.equal(BlockElementSchema.safeParse({ ...block, textSource: 'ocr', ocrSource: null }).success, false);
    assert.equal(BlockElementSchema.safeParse({ ...block, role: 'text', codeLanguage: 'js' }).success, false);
});
