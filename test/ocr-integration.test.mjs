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
    assert.equal(state.model.pages[0].ocr.status, 'accepted');
    assert.equal(state.model.pages[0].ocr.attemptedRegions, state.model.pages[0].ocr.acceptedRegions + state.model.pages[0].ocr.rejectedRegions);
    const blocks = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr');
    assert.ok(blocks.length > 0);
    assert.match(blocks.map(block => block.text).join(' '), /OCR SUCCESS TEXT/i);
    assert.ok(blocks.every(block => block.bbox && block.bbox.width > 0 && block.bbox.height > 0));
    assert.ok(blocks.every(block => block.citation.bbox));
    assert.ok(blocks.every(block => block.extractionMethod === 'ocr'));
});

test('required OCR links image-region text to its canonical figure without duplicating native text', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const root = path.resolve('test/fixtures/generated');
    const config = loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'required', extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    for (const name of ['image-ocr.pdf', 'multiple-image-ocr.pdf']) {
        const opened = await manager.open({ source: path.join(root, name), ocrPolicy: 'required' });
        const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
        const ocrBlocks = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr' && element.ocrSource?.scope === 'image');
        assert.ok(ocrBlocks.length > 0, name);
        assert.equal(state.model.pages[0].ocr.attemptedRegions, state.model.pages[0].ocr.acceptedRegions + state.model.pages[0].ocr.rejectedRegions);
        assert.ok(['accepted', 'partial'].includes(state.model.pages[0].ocr.status));
        assert.ok(ocrBlocks.every(block => block.extractionMethod === 'ocr'));
        assert.ok(ocrBlocks.every(block => state.indexes.elements.get(block.ocrSource.figureId)?.type === 'figure'));
        assert.ok(ocrBlocks.every(block => block.bbox && block.ocrSource.bbox));
        const markdown = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity' });
        for (const block of ocrBlocks) {
            const figure = state.indexes.elements.get(block.ocrSource.figureId);
            assert.ok(markdown.markdown.indexOf(figure.asset.uri) < markdown.markdown.indexOf(`element=${block.id}`));
            assert.equal(markdown.markdown.split(`element=${block.id}`).length - 1, 1);
        }
        if (name === 'image-ocr.pdf') {
            const first = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity', budget: { responseBytes: 2200, estimatedTokens: 2000 } });
            const second = await manager.getPages({ ...opened, pages: [1], outputFormat: 'markdown', mode: 'fidelity', budget: { responseBytes: 2200, estimatedTokens: 2000 }, cursor: first.nextCursor });
            const figure = state.indexes.elements.get(ocrBlocks[0].ocrSource.figureId);
            assert.match(first.markdown, new RegExp(`element=${figure.id}`));
            assert.doesNotMatch(first.markdown, new RegExp(`element=${ocrBlocks[0].id}`));
            assert.match(second.markdown, new RegExp(`element=${ocrBlocks[0].id}`));
            assert.ok(second.omissions.some(omission => omission.id === figure.id && omission.reason === 'associated_figure_omitted'));
            assert.equal(second.nextCursor, null);
        }
        await manager.closeDocument(opened);
    }
});
