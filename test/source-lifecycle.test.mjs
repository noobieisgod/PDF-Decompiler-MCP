import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

test('source handles are distinct, independently closed, and lease one shared generation', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const firstPath = path.join(root, 'first.pdf');
    const secondPath = path.join(root, 'second.pdf');
    const bytes = buildSyntheticPdf({ pages: ['Identical active source bytes'] });
    await fs.writeFile(firstPath, bytes);
    await fs.writeFile(secondPath, bytes);
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const first = await manager.open({ source: firstPath, sourceLabel: 'First label' });
    const samePath = await manager.open({ source: firstPath, sourceLabel: 'Same path label' });
    const second = await manager.open({ source: secondPath, sourceLabel: 'Second label' });
    assert.equal(first.documentId, second.documentId);
    assert.equal(first.extractionFingerprint, second.extractionFingerprint);
    assert.equal(new Set([first.sourceId, samePath.sourceId, second.sourceId]).size, 3);
    assert.equal((await manager.documentInfo(first)).activeSources.length, 3);
    await assert.rejects(manager.closeDocument({ ...first, deleteCache: true }), { code: 'CACHE_GENERATION_IN_USE' });
    assert.equal((await manager.closeDocument(first)).remainingHandles, 2);
    assert.equal((await manager.documentInfo(second)).activeSources.length, 2);
    await assert.rejects(manager.closeDocument({ documentId: first.documentId, extractionFingerprint: first.extractionFingerprint }), { code: 'SOURCE_HANDLE_REQUIRED' });
    await manager.closeDocument(samePath);
    assert.equal((await manager.closeDocument({ ...second, deleteCache: true })).cacheDeleted, true);
    await assert.rejects(manager.closeDocument(second), { code: 'SOURCE_HANDLE_ALREADY_CLOSED' });
});

test('shutdown releases all active source and cache leases', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const source = path.join(root, 'shutdown.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Shutdown lease cleanup'] }));
    const manager = await new DocumentManager(config).init();
    const opened = await manager.open({ source });
    assert.ok(await manager.cache.activeLeases(opened.documentId, opened.extractionFingerprint));
    await manager.close();
    const verifier = await new DocumentManager(config).init();
    t.after(() => verifier.close());
    assert.equal(await verifier.cache.activeLeases(opened.documentId, opened.extractionFingerprint), 0);
});

test('final close waits for existing operations and rejects new work', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none' });
    const source = path.join(root, 'concurrent.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Concurrent lease cleanup'] }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    let release;
    let started;
    const blocker = new Promise(resolve => { release = resolve; });
    const operationStarted = new Promise(resolve => { started = resolve; });
    const operation = manager.withOperation(opened.documentId, opened.extractionFingerprint, () => { started(); return blocker; });
    await operationStarted;
    let closed = false;
    const close = manager.closeDocument(opened).then(value => { closed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, false);
    await assert.rejects(manager.documentInfo(opened), { code: 'closed_document' });
    release();
    await operation;
    assert.equal((await close).remainingHandles, 0);
});
