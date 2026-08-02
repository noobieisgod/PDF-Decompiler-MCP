import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTable } from '../src/runtime/table-selection.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildCanonicalModel } from '../src/model/canonical.mjs';
import { buildBm25 } from '../src/search/bm25.mjs';
import { rawDocument, temporaryConfig } from './helpers.mjs';

function table() {
    const rows = Array.from({ length: 8 }, (_, row) => Array.from({ length: 3 }, (_, column) => row === 0 ? `Header ${column + 1}` : `R${row + 1}C${column + 1} ${'x'.repeat(40)}`));
    return {
        id: 'table:1:1', type: 'table', totalRows: 8, totalColumns: 3, headerRows: 1, rows,
        cells: rows.flatMap((values, row) => values.map((text, column) => ({ id: `cell:${row + 1}:${column + 1}`, row: row + 1, column: column + 1, rowSpan: row === 0 && column === 0 ? 1 : 1, columnSpan: row === 0 && column === 0 ? 2 : 1, text, bbox: null }))),
        text: rows.map(values => values.join(' | ')).join('\n'),
    };
}

test('table selection uses one-based inclusive ranges and repeats canonical header context without advancing it', () => {
    const source = table();
    const first = selectTable(source, { rowStart: 3, rowEnd: 8, columnStart: 1, columnEnd: 3, includeHeaders: true }, { responseBytes: 2500, estimatedTokens: 1000 }, 0);
    assert.deepEqual(first.tableSelection.contextRows, [1]);
    assert.ok(first.selectedRows.length > 0);
    assert.ok(first.element.cells.filter(cell => cell.contextRow).every(cell => cell.row === 1));
    const second = selectTable(source, { rowStart: 3, rowEnd: 8, columnStart: 1, columnEnd: 3, includeHeaders: true }, { responseBytes: 2500, estimatedTokens: 1000 }, first.nextOffset);
    assert.deepEqual(second.tableSelection.contextRows, [1]);
    assert.equal(new Set([...first.selectedRows, ...second.selectedRows]).size, first.selectedRows.length + second.selectedRows.length);
    assert.ok(second.selectedRows.every(row => !first.selectedRows.includes(row)));
});

test('table selection validates ranges, rejects zero-progress headers, and supports no-header slices', () => {
    const source = table();
    assert.throws(() => selectTable(source, { rowStart: 4, rowEnd: 2 }, {}, 0), { code: 'INVALID_TABLE_SELECTION' });
    const tiny = selectTable(source, { rowStart: 2, rowEnd: 3, includeHeaders: true }, { responseBytes: 10, estimatedTokens: 10 }, 0);
    assert.equal(tiny.tableSelection.contextRows.length, 0);
    assert.equal(tiny.nextOffset, null);
    assert.ok(tiny.omissions.some(omission => omission.reason === 'table_row_exceeds_budget'));
    const without = selectTable(source, { rowStart: 2, rowEnd: 2, includeHeaders: false }, { responseBytes: 2000, estimatedTokens: 1000 }, 0);
    assert.deepEqual(without.tableSelection.contextRows, []);
});

test('pdf_get_element binds table continuations and repeats only header context', async t => {
    const { config } = await temporaryConfig(t, { cacheMode: 'none' });
    const raw = rawDocument(1);
    raw.pages[0].tables = [{ data: Array.from({ length: 30 }, (_, row) => ['Column A', 'Column B'].map((header, column) => row === 0 ? header : `Row ${row + 1} column ${column + 1} ${'x'.repeat(60)}`)) }];
    const bytes = Buffer.from('%PDF-table-cursor');
    const model = buildCanonicalModel(bytes, raw, config, 'deps');
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    await manager.activate(model, bytes, buildBm25(model));
    const reference = { documentId: model.documentId, extractionFingerprint: model.extractionFingerprint, elementId: 'table:1:1', tableSelection: { rowStart: 5, rowEnd: 30, includeHeaders: true }, budget: { responseBytes: 5000, estimatedTokens: 2000 } };
    const selectedRows = [];
    let cursor;
    let first;
    do {
        const page = await manager.getElement({ ...reference, ...(cursor ? { cursor } : {}) });
        first ||= page;
        assert.deepEqual(page.tableSelection.contextRows, [1]);
        selectedRows.push(...Array.from({ length: page.tableSelection.rowEnd - page.tableSelection.rowStart + 1 }, (_, index) => page.tableSelection.rowStart + index));
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(selectedRows).size, 26);
    await assert.rejects(manager.getElement({ ...reference, tableSelection: { rowStart: 6, rowEnd: 30 }, cursor: first.nextCursor }), { code: 'changed_cursor_arguments' });
});
