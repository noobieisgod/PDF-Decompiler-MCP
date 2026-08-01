import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

test('required OCR policy is exercised when Tesseract integration is enabled', { skip: process.env.PDF_DECOMPILER_TEST_OCR !== '1' }, async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none', ocrPolicy: 'required' });
    const source = path.join(root, 'scan.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['scan'], visualOnly: true }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source, ocrPolicy: 'required' });
    const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
    assert.notEqual(state.model.pages[0].ocr.reason, 'Tesseract not available on PATH');
});
