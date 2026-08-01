import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { loadConfig } from '../src/config/runtime.mjs';

test('required OCR policy is exercised when Tesseract integration is enabled', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const root = path.resolve('test/fixtures/generated');
    const config = loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'required', extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source: path.join(root, 'scan-readable.pdf'), ocrPolicy: 'required' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    assert.equal(state.model.pages[0].ocr.accepted, true);
    const blocks = state.model.elements.filter(element => element.type === 'block' && element.role === 'ocr');
    assert.ok(blocks.length > 0);
    assert.match(blocks.map(block => block.text).join(' '), /OCR SUCCESS TEXT/i);
    assert.ok(blocks.every(block => block.bbox && block.bbox.width > 0 && block.bbox.height > 0));
    assert.ok(blocks.every(block => block.citation.bbox));
});
