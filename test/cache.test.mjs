import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CacheManager } from '../src/cache/cache-manager.mjs';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { buildBm25 } from '../src/search/bm25.mjs';
import { rawDocument, temporaryConfig } from './helpers.mjs';

function modelWithAsset() {
    const raw = rawDocument(1);
    raw.pages[0].images.push({ data: Buffer.from('synthetic-image').toString('base64'), mimeType: 'image/png', width: 2, height: 2, caption: 'Evidence', bbox: [0, 0, 2, 2] });
    return buildCanonicalModel(Buffer.from('%PDF-cache'), raw, { extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'auto' }, 'deps');
}

test('canonical cache version 1 is never served under format version 2', async t => {
    const { config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const cache = await new CacheManager(config).init();
    t.after(() => cache.close());
    const model = modelWithAsset();
    await cache.saveGeneration(model, Buffer.from('%PDF-cache'), buildBm25(model));
    const manifestPath = path.join(cache.generationPath(model.documentId, model.extractionFingerprint), 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.version = 1;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal(await cache.generationExists(model.documentId, model.extractionFingerprint), false);
    assert.equal(await cache.loadGeneration(model.documentId, model.extractionFingerprint), null);
});

test('persistent cache is atomic, generation immutable, corruption-aware, and lease protected', async t => {
    const { config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const first = await new CacheManager(config).init();
    const second = await new CacheManager(config).init();
    t.after(() => first.close());
    t.after(() => second.close());
    const model = modelWithAsset();
    const pdf = Buffer.from('%PDF-cache');
    await Promise.all([first.saveGeneration(model, pdf, buildBm25(model)), second.saveGeneration(model, pdf, buildBm25(model))]);
    const loaded = await second.loadGeneration(model.documentId, model.extractionFingerprint);
    assert.equal(loaded.model.documentId, model.documentId);
    assert.equal(loaded.model.assets[0].data, model.assets[0].data);
    const lease = await first.acquireLease(model.documentId, model.extractionFingerprint);
    await assert.rejects(second.deleteGeneration(model.documentId, model.extractionFingerprint), { code: 'CACHE_GENERATION_IN_USE' });
    first.config.cache.maxBytes = 1;
    assert.deepEqual((await first.evict()).removed, []);
    assert.equal(await first.generationExists(model.documentId, model.extractionFingerprint), true);
    await first.releaseLease(lease);
    const derived = { id: 'render:1:test', documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, mimeType: 'image/png', data: Buffer.from('render').toString('base64'), sha256: 'a' };
    const { sha256 } = await import('../src/core/crypto.mjs');
    derived.sha256 = sha256(Buffer.from(derived.data, 'base64'));
    await first.saveDerivedAsset(derived);
    assert.equal((await second.loadDerivedAsset(model.documentId, model.extractionFingerprint, derived.id)).id, derived.id);
    await fs.writeFile(path.join(first.generationPath(model.documentId, model.extractionFingerprint), 'canonical.json'), '{}');
    assert.equal(await first.loadGeneration(model.documentId, model.extractionFingerprint), null);
    assert.equal(await first.unavailableReason(model.documentId, model.extractionFingerprint), 'corrupt');
});

test('process-local cache modes never use the configured persistent tree and remove only their own state', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none' });
    const one = await new CacheManager(config).init();
    const two = await new CacheManager(config).init();
    assert.notEqual(one.root, two.root);
    assert.ok(!one.root.startsWith(path.join(root, 'cache')));
    const oneRoot = one.root;
    const twoRoot = two.root;
    await one.close();
    await assert.rejects(fs.access(oneRoot));
    await fs.access(twoRoot);
    await two.close();
});
