import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorCodec } from '../src/runtime/cursor.mjs';

const doc = `doc_${'a'.repeat(64)}`;
const generation = 'b'.repeat(64);
const query = { queryDigest: 'digest-only', filters: ['table'] };
const keyA = Buffer.alloc(32, 1);
const keyB = Buffer.alloc(32, 2);

function codec(options = {}) {
    return new CursorCodec({ activeKeyId: 'a', keys: { a: keyA }, ttlMs: 1000, now: () => 1000, ...options });
}

test('cursor is signed, opaque with respect to the query, bound, and replayable within its TTL', () => {
    const cursor = codec().encode({ documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query, position: 3 });
    const decodedPayload = Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8');
    assert.ok(!decodedPayload.includes('customer secret query'));
    const expected = { documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query };
    assert.equal(codec().decode(cursor, expected), 3);
    assert.equal(codec().decode(cursor, expected), 3);
    assert.throws(() => codec().decode(cursor, { ...expected, documentId: `doc_${'c'.repeat(64)}` }), { code: 'stale_cursor' });
    assert.throws(() => codec().decode(cursor, { ...expected, extractionFingerprint: 'd'.repeat(64) }), { code: 'stale_cursor' });
    assert.throws(() => codec().decode(cursor, { ...expected, operation: 'pdf_get_pages' }), { code: 'stale_cursor' });
    assert.throws(() => codec().decode(cursor, { ...expected, argumentsValue: { ...query, queryDigest: 'changed' } }), { code: 'changed_cursor_arguments' });
});

test('cursor rejects tampering, expiry, and retired keys while deliberate rotation can retain an old key', () => {
    const old = codec().encode({ documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query, position: 1 });
    assert.throws(() => codec().decode(`${old.slice(0, -1)}x`, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query }), { code: 'invalid_cursor' });
    assert.throws(() => codec({ now: () => 3000 }).decode(old, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query }), { code: 'stale_cursor' });
    assert.equal(new CursorCodec({ activeKeyId: 'b', keys: { a: keyA, b: keyB }, now: () => 1000 }).decode(old, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query }), 1);
    assert.throws(() => new CursorCodec({ activeKeyId: 'b', keys: { b: keyB }, now: () => 1000 }).decode(old, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_search', argumentsValue: query }), { code: 'retired_cursor_key' });
});

test('cursor version 3 preserves bounded restorable fair-page state without sensitive payloads', () => {
    const position = { offsets: [2, 1, 0], pageIndex: 2, table: { offset: 4 } };
    const argumentsValue = { pages: [3, 1, 2], outputFormat: 'markdown', tableDetail: 'compact', queryDigest: 'digest-only' };
    const cursor = codec().encode({ documentId: doc, extractionFingerprint: generation, operation: 'pdf_get_pages', argumentsValue, position, restorableArguments: argumentsValue });
    assert.ok(cursor.length <= 4096);
    const decodedPayload = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(decodedPayload.v, 3);
    assert.deepEqual(decodedPayload.r, argumentsValue);
    assert.ok(!JSON.stringify(decodedPayload).includes('secret text'));
    assert.deepEqual(codec().decode(cursor, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_get_pages', argumentsValue }), position);
    assert.deepEqual(codec().decode(cursor, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_get_pages', restoreArguments: true }), { position, argumentsValue });
    assert.throws(() => codec().decode(cursor, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_get_pages', argumentsValue: { ...argumentsValue, pages: [1, 2, 3] } }), { code: 'changed_cursor_arguments' });
    assert.throws(() => codec().decode(cursor, { documentId: doc, extractionFingerprint: generation, operation: 'pdf_get_pages', argumentsValue: { ...argumentsValue, tableDetail: 'full' } }), { code: 'changed_cursor_arguments' });
});
