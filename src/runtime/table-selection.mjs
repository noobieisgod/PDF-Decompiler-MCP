import { estimatedTextTokens, resolveBudget } from './budget.mjs';
import { PdfDecompilerError } from '../core/errors.mjs';

function normalizeSelection(table, requested = {}) {
    const selection = {
        rowStart: requested.rowStart ?? 1,
        rowEnd: requested.rowEnd ?? table.totalRows,
        columnStart: requested.columnStart ?? 1,
        columnEnd: requested.columnEnd ?? table.totalColumns,
        includeHeaders: requested.includeHeaders ?? true,
    };
    if (selection.rowStart > selection.rowEnd || selection.columnStart > selection.columnEnd
        || selection.rowEnd > table.totalRows || selection.columnEnd > table.totalColumns) {
        throw new PdfDecompilerError('INVALID_TABLE_SELECTION', 'The table selection is reversed or outside the canonical table bounds.');
    }
    return selection;
}

function intersects(cell, rows, selection) {
    const cellRowEnd = cell.row + cell.rowSpan - 1;
    const cellColumnEnd = cell.column + cell.columnSpan - 1;
    return rows.some(row => row >= cell.row && row <= cellRowEnd)
        && selection.columnStart <= cellColumnEnd && selection.columnEnd >= cell.column;
}

function sliceElement(table, selection, selectedRows, contextRows) {
    const outputRows = [...contextRows, ...selectedRows];
    const cells = table.cells.filter(cell => {
        if (!intersects(cell, outputRows, selection)) return false;
        const inContext = contextRows.some(row => row >= cell.row && row < cell.row + cell.rowSpan);
        const firstSelectedIntersection = Math.max(cell.row, selection.rowStart);
        return inContext || selectedRows.includes(firstSelectedIntersection);
    }).map(cell => ({
        ...cell,
        contextRow: contextRows.some(row => row >= cell.row && row < cell.row + cell.rowSpan),
        visibleIntersection: {
            rowStart: Math.max(cell.row, Math.min(...outputRows)),
            rowEnd: Math.min(cell.row + cell.rowSpan - 1, Math.max(...outputRows)),
            columnStart: Math.max(cell.column, selection.columnStart),
            columnEnd: Math.min(cell.column + cell.columnSpan - 1, selection.columnEnd),
        },
    }));
    const rows = outputRows.map(row => (table.rows[row - 1] || []).slice(selection.columnStart - 1, selection.columnEnd));
    return {
        ...table,
        rows,
        cells,
        text: rows.map(row => row.join(' | ')).join('\n'),
    };
}

function encodedUsage(value) {
    const encoded = JSON.stringify(value);
    return { responseBytes: Buffer.byteLength(encoded), estimatedTokens: estimatedTextTokens(encoded) };
}

export function selectTable(table, requested, requestedBudget, offset = 0) {
    const selection = normalizeSelection(table, requested);
    const budget = resolveBudget(requestedBudget);
    if (budget.tables < 1) throw new PdfDecompilerError('budget_exhausted', 'The table budget does not permit a table result.');
    const allSelectedRows = Array.from({ length: selection.rowEnd - selection.rowStart + 1 }, (_, index) => selection.rowStart + index);
    const headerRows = selection.includeHeaders && selection.rowStart > table.headerRows
        ? Array.from({ length: table.headerRows }, (_, index) => index + 1) : [];
    const selectedRows = [];
    const omissions = [];
    let contextRows = headerRows;
    let nextOffset = offset;
    let result = sliceElement(table, selection, [], []);
    while (nextOffset < allSelectedRows.length) {
        const row = allSelectedRows[nextOffset];
        let candidate = sliceElement(table, selection, [...selectedRows, row], contextRows);
        let usage = encodedUsage(candidate);
        if (usage.responseBytes > budget.responseBytes || usage.estimatedTokens > budget.estimatedTokens) {
            if (!selectedRows.length && contextRows.length) {
                const withoutContext = sliceElement(table, selection, [row], []);
                const withoutContextUsage = encodedUsage(withoutContext);
                if (withoutContextUsage.responseBytes <= budget.responseBytes && withoutContextUsage.estimatedTokens <= budget.estimatedTokens) {
                    contextRows = [];
                    omissions.push({ id: `${table.id}:header-context`, reason: 'header_context_exceeds_budget' });
                    candidate = withoutContext;
                    usage = withoutContextUsage;
                }
            }
            if (usage.responseBytes > budget.responseBytes || usage.estimatedTokens > budget.estimatedTokens) {
                if (!selectedRows.length) {
                    omissions.push({ id: `${table.id}:row:${row}`, reason: 'table_row_exceeds_budget' });
                    nextOffset += 1;
                    continue;
                }
                break;
            }
        }
        selectedRows.push(row);
        nextOffset += 1;
        result = candidate;
    }
    if (!selectedRows.length) contextRows = [];
    const finalElement = selectedRows.length ? sliceElement(table, selection, selectedRows, contextRows) : result;
    const usage = encodedUsage(finalElement);
    return {
        element: finalElement,
        tableSelection: {
            rowStart: selectedRows[0] ?? selection.rowStart,
            rowEnd: selectedRows.at(-1) ?? selection.rowStart,
            columnStart: selection.columnStart,
            columnEnd: selection.columnEnd,
            contextRows,
            partial: nextOffset < allSelectedRows.length,
            totalRows: table.totalRows,
            totalColumns: table.totalColumns,
        },
        omissions,
        budget: {
            configured: budget,
            usage: { ...usage, pages: 1, tables: 1, tableRows: selectedRows.length + contextRows.length, tableCells: finalElement.cells.length },
            estimators: { text: 'utf8_bytes_divided_by_4', table: 'exact_serialized_json' },
        },
        nextOffset: nextOffset < allSelectedRows.length ? nextOffset : null,
        selectedRows,
    };
}
