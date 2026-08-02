import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

test('no-cache mode supports the complete multi-call API and cleans only the closed document', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none' });
    const firstPath = path.join(root, 'first.pdf');
    const secondPath = path.join(root, 'second.pdf');
    await fs.writeFile(firstPath, buildSyntheticPdf({ pages: ['Alpha first page', 'Alpha second page'] }));
    await fs.writeFile(secondPath, buildSyntheticPdf({ pages: ['Beta active document'] }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const first = await manager.open({ source: firstPath, pages: [{ start: 1, end: 1 }] });
    const second = await manager.open({ source: secondPath });
    assert.equal(first.completion.documentComplete, false);
    assert.equal(first.completion.requestedScopeComplete, true);
    assert.equal(first.completion.resultComplete, false);
    assert.ok(first.nextCursor);
    assert.equal((await manager.search({ ...first, query: 'Alpha' })).results[0].page, 1);
    assert.equal((await manager.getPages({ ...first, pages: [1] })).elements[0].citation.extractionFingerprint, first.extractionFingerprint);
    const continued = await manager.open({ ...first, cursor: first.nextCursor });
    assert.equal(continued.completion.documentComplete, true);
    assert.equal(continued.processedPages, 2);
    const element = (await manager.getPages({ ...continued, pages: [2] })).elements[0];
    assert.equal((await manager.getElement({ ...continued, elementId: element.id })).element.id, element.id);
    await assert.rejects(manager.getElement({ ...continued, elementId: 'block:2:999' }), { code: 'stale_reference' });
    const rendered = await manager.renderPage({ ...continued, page: 1, format: 'auto', maxDimension: 320 });
    assert.equal(rendered.extractionFingerprint, continued.extractionFingerprint);
    assert.equal((await manager.readResource(rendered.uri)).mimeType, 'image/png');
    await manager.closeDocument(continued);
    await assert.rejects(manager.readResource(rendered.uri), { code: 'closed_document' });
    assert.equal((await manager.search({ ...second, query: 'Beta' })).results.length, 1);
});

test('identical bytes are stable on cold and warm persistent-cache opens', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const source = path.join(root, 'stable.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Stable extraction evidence'] }));
    const firstManager = await new DocumentManager(config).init();
    const cold = await firstManager.open({ source });
    const coldIds = (await firstManager.getPages(cold)).elements.map(item => item.id);
    await firstManager.closeDocument(cold);
    await firstManager.close();
    const secondManager = await new DocumentManager(config).init();
    t.after(() => secondManager.close());
    const warm = await secondManager.open({ source });
    assert.equal(warm.cacheHit, true);
    assert.equal(warm.documentId, cold.documentId);
    assert.equal(warm.extractionFingerprint, cold.extractionFingerprint);
    assert.deepEqual((await secondManager.getPages(warm)).elements.map(item => item.id), coldIds);
});

test('decomposition records visual pages without eager page-render assets', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none' });
    const source = path.join(root, 'visual.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['visual'], visualOnly: true }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source, ocrPolicy: 'off' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    assert.ok(state.model.pages[0].contentClass);
    assert.ok(!state.model.assets.some(asset => asset.kind === 'page-render'));
});

test('refresh replaces only an inactive persistent generation', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const source = path.join(root, 'refresh.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Refresh behavior'] }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    await assert.rejects(manager.open({ source, refresh: true }), { code: 'active_generation' });
    await manager.closeDocument(opened);
    const refreshed = await manager.open({ source, refresh: true });
    assert.equal(refreshed.cacheHit, false);
    assert.equal(refreshed.extractionFingerprint, opened.extractionFingerprint);
});

test('requestedScopeComplete reports extraction state while resultComplete reports retrieval pagination', async t => {
    const root = path.resolve('test/fixtures/generated');
    const { config } = await temporaryConfig(t, { cacheMode: 'none', allowRoots: [root] });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source: path.join(root, 'oversized-content.pdf') });
    const page = await manager.getPages({ ...opened, pages: [1, 2], budget: { textBlocks: 1, responseBytes: 100_000 } });
    assert.equal(page.completion.documentComplete, true);
    assert.equal(page.completion.requestedScopeComplete, true);
    assert.equal(page.completion.resultComplete, false);
    assert.ok(page.nextCursor);
    await assert.rejects(manager.getPages({ ...opened, pages: [2, 1], budget: { textBlocks: 1, responseBytes: 100_000 }, cursor: page.nextCursor }), { code: 'changed_cursor_arguments' });
    await assert.rejects(manager.getPages({ ...opened, pages: [1, 2], outputFormat: 'markdown', budget: { textBlocks: 1, responseBytes: 100_000 }, cursor: page.nextCursor }), { code: 'changed_cursor_arguments' });
    const ids = page.elements.map(element => element.id);
    let cursor = page.nextCursor;
    while (cursor) {
        const next = await manager.getPages({ ...opened, pages: [1, 2], budget: { textBlocks: 1, responseBytes: 100_000 }, cursor });
        assert.ok(next.elements.length || next.omissions.length);
        ids.push(...next.elements.map(element => element.id));
        cursor = next.nextCursor;
    }
    assert.equal(new Set(ids).size, ids.length);
});
