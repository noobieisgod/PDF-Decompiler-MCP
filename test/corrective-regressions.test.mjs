import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server/create-server.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { ocrConfidenceStats } from '../src/extract/ocr.mjs';
import { rawDocument, temporaryConfig } from './helpers.mjs';

const fixtureRoot = path.resolve('test/fixtures/generated');

async function fixtureModel(t, name) {
    const { config } = await temporaryConfig(t, { allowRoots: [fixtureRoot], extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source: path.join(fixtureRoot, name), ocrPolicy: 'off' });
    return { manager, opened, state: await manager.requireState(opened.documentId, opened.extractionFingerprint) };
}

test('textual and spread tables are recovered without weakening negative controls', async t => {
    const textual = await fixtureModel(t, 'table-textual-wrapped.pdf');
    const textualTables = textual.state.model.elements.filter(element => element.type === 'table');
    assert.equal(textualTables.length, 1);
    assert.equal(textualTables[0].totalColumns, 3);

    const spread = await fixtureModel(t, 'table-wide-spread.pdf');
    assert.deepEqual(spread.state.model.elements.filter(element => element.type === 'table').map(table => table.totalColumns), [3, 3]);

    const negative = await fixtureModel(t, 'table-negative-controls.pdf');
    assert.equal(negative.state.model.elements.some(element => element.type === 'table'), false);
});

test('section dividers bound column order and numeric page labels remain text', async t => {
    const sample = await fixtureModel(t, 'toc-sectioned-columns.pdf');
    const blocks = sample.state.model.elements.filter(element => element.type === 'block');
    const labels = blocks.filter(block => ['040', '068'].includes(block.text));
    assert.ok(labels.length === 2 && labels.every(block => block.role === 'text'));
    const ordered = blocks.filter(block => /^[34]\.\d/.test(block.text)).map(block => block.text.match(/^[34]\.\d/)[0]);
    assert.deepEqual(ordered, ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8']);
});

test('OCR confidence uses only valid word-level TSV samples', () => {
    const invalid = [
        { level: 1, text: 'page', confidence: -1 },
        { level: 5, text: '', confidence: 99 },
        { level: 5, text: 'bad', confidence: -1 },
        { level: 5, text: 'bad', confidence: Number.NaN },
    ];
    assert.equal(ocrConfidenceStats(invalid).ok, false);
    assert.equal(ocrConfidenceStats(invalid).sampleCount, 0);
    assert.deepEqual(ocrConfidenceStats([{ level: 5, text: 'word', confidence: 90 }]), {
        ok: true, sampleCount: 1, mean: 90, lowConfidenceRatio: 0,
        diagnostics: [{ code: 'ocr_low_sample_count', sampleCount: 1 }], reason: null,
    });
    assert.equal(ocrConfidenceStats([{ level: 5, text: 'word', confidence: 40 }]).ok, false);
    const mixed = ocrConfidenceStats([80, 80, 80, 40].map((confidence, index) => ({ level: 5, text: `word${index}`, confidence })));
    assert.equal(mixed.ok, true);
    assert.equal(mixed.mean, 70);
    assert.equal(mixed.lowConfidenceRatio, 0.25);
});

test('canonical OCR status and provenance remain internally consistent', () => {
    const raw = rawDocument(1);
    raw.pages[0].ocrAttempted = true;
    raw.pages[0].ocrAccepted = true;
    raw.pages[0].ocrReason = 'Some OCR regions were rejected';
    raw.pages[0].ocrRegions = { attempted: 2, accepted: 1, rejected: 1 };
    raw.pages[0].ocrDiagnostics = [{ code: 'ocr_low_sample_count', sampleCount: 2 }];
    raw.pages[0].textBlocks = [{ text: 'Accepted OCR evidence', role: 'ocr', textSource: 'ocr', bbox: { x: 72, y: 72, width: 160, height: 18 }, ocrSource: { scope: 'page' } }];
    const model = buildCanonicalModel(Buffer.from('%PDF-ocr-status'), raw, { extractorVersion: '3.0.0', maxPages: 5000, ocrPolicy: 'required' }, 'deps');
    assert.deepEqual(model.pages[0].ocr, {
        attempted: true, accepted: true, status: 'partial', attemptedRegions: 2, acceptedRegions: 1, rejectedRegions: 1, reason: 'Some OCR regions were rejected',
    });
    const block = model.elements.find(element => element.type === 'block');
    assert.equal(block.textSource, 'ocr');
    assert.equal(block.extractionMethod, 'ocr');
});

test('open completion, cursor-only pages, and exact wire budgets follow the public contract', async t => {
    const { config } = await temporaryConfig(t, { allowRoots: [fixtureRoot], extractionTimeoutMs: 50_000 });
    const manager = await new DocumentManager(config).init();
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'corrective-regressions', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await manager.close(); });

    const opened = await client.callTool({ name: 'pdf_open', arguments: { source: path.join(fixtureRoot, 'oversized-content.pdf'), pages: [{ start: 1, end: 2 }] } });
    assert.equal(opened.structuredContent.completion.documentComplete, false);
    assert.equal(opened.structuredContent.completion.requestedScopeComplete, true);
    assert.equal(opened.structuredContent.completion.resultComplete, true);
    const reference = { documentId: opened.structuredContent.documentId, extractionFingerprint: opened.structuredContent.extractionFingerprint };
    const selection = { ...reference, pages: [1, 2], mode: 'text', budget: { textBlocks: 1, responseBytes: 12_000, estimatedTokens: 3_000 } };
    const first = await client.callTool({ name: 'pdf_get_pages', arguments: selection });
    assert.ok(first.structuredContent.nextCursor);
    const second = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, cursor: first.structuredContent.nextCursor } });
    assert.equal(second.isError, undefined);
    assert.notEqual(second.structuredContent.data.elements[0].id, first.structuredContent.data.elements[0].id);
    const changed = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, cursor: first.structuredContent.nextCursor, mode: 'fidelity' } });
    assert.equal(changed.structuredContent.data.error.code, 'changed_cursor_arguments');

    const search = await client.callTool({ name: 'pdf_search', arguments: { ...reference, query: 'Visible', budget: { responseBytes: 12_000, estimatedTokens: 3_000 } } });
    assert.equal(search.isError, undefined);
    assert.ok(search.structuredContent.budget.usage.responseBytes <= 12_000);
    assert.ok(search.structuredContent.budget.usage.estimatedTokens <= 3_000);
});
