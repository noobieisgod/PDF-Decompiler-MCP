import {
    COL_X_TOLERANCE,
    ROUTE_TABLE_LIKELIHOOD,
    TABLE_MIN_COLS,
    TABLE_MIN_COV,
    TABLE_MIN_ROWS,
} from '../config/constants.mjs';
import { groupItemsIntoRows } from './text.mjs';

function clusterAnchors(xs, tolerance = COL_X_TOLERANCE) {
    const anchors = [];
    for (const x of [...xs].sort((a, b) => a - b)) {
        const last = anchors[anchors.length - 1];
        if (last !== undefined && Math.abs(x - last) <= tolerance) {
            anchors[anchors.length - 1] = (last + x) / 2;
        } else {
            anchors.push(x);
        }
    }
    return anchors;
}

function mapRowToAnchors(row, anchors, tolerance = COL_X_TOLERANCE * 8) {
    if (!anchors.length) {
        return { filledColumns: new Set(), coverage: 0, cells: [] };
    }
    const cells = new Array(anchors.length).fill('');
    const filledColumns = new Set();
    for (const item of row) {
        let bestIndex = -1;
        let bestDelta = Infinity;
        for (let idx = 0; idx < anchors.length; idx += 1) {
            const delta = Math.abs(item.x - anchors[idx]);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestIndex = idx;
            }
        }
        if (bestIndex === -1 || bestDelta > tolerance) {
            continue;
        }
        filledColumns.add(bestIndex);
        cells[bestIndex] = cells[bestIndex] ? `${cells[bestIndex]} ${item.str}` : item.str;
    }
    return {
        filledColumns,
        coverage: filledColumns.size / Math.max(anchors.length, 1),
        cells,
    };
}

function mergeAnchors(baseAnchors, newAnchors, tolerance = COL_X_TOLERANCE * 8) {
    if (!baseAnchors.length) {
        return [...newAnchors];
    }
    const merged = [...baseAnchors];
    for (const anchor of newAnchors) {
        let matched = false;
        for (let idx = 0; idx < merged.length; idx += 1) {
            if (Math.abs(merged[idx] - anchor) <= tolerance) {
                merged[idx] = (merged[idx] + anchor) / 2;
                matched = true;
                break;
            }
        }
        if (!matched) {
            merged.push(anchor);
        }
    }
    return merged.sort((a, b) => a - b);
}

function buildRowInfo(row) {
    const sorted = [...row]
        .filter(item => item.str?.trim())
        .sort((a, b) => a.x - b.x);
    return {
        items: sorted,
        anchors: clusterAnchors(sorted.map(item => item.x)),
        yTop: sorted.length ? Math.min(...sorted.map(item => item.yTop)) : 0,
        yBottom: sorted.length ? Math.max(...sorted.map(item => item.yTop + (item.h || 12))) : 0,
    };
}

export function estimateTableLikelihood(items) {
    if (items.length < TABLE_MIN_ROWS * TABLE_MIN_COLS) {
        return 0;
    }
    const rows = groupItemsIntoRows(items);
    if (rows.length < TABLE_MIN_ROWS) {
        return 0;
    }
    const anchors = clusterAnchors(rows.flatMap(row => row.map(item => item.x)));
    if (anchors.length < TABLE_MIN_COLS) {
        return 0;
    }
    const rowScores = rows.map(row => {
        return mapRowToAnchors(row, anchors).coverage;
    });
    return rowScores.reduce((sum, score) => sum + score, 0) / rowScores.length;
}

export function normalizeTableRows(rows) {
    const width = Math.max(0, ...rows.map(row => row.length));
    return rows
        .map(row => Array.from({ length: width }, (_, idx) => (row[idx] ?? '').replace(/\s+/g, ' ').trim()))
        .filter(row => row.some(Boolean));
}

export function extractStructTables(structTree, mcidMap) {
    if (!structTree) {
        return [];
    }
    function getCellText(node) {
        if (node.type === 'content') {
            return mcidMap.get(node.id)?.text ?? '';
        }
        return (node.children ?? []).map(getCellText).filter(Boolean).join(' ');
    }
    function getTableMcids(node, ids = new Set()) {
        if (node.type === 'content' && node.id != null) {
            ids.add(node.id);
        }
        for (const child of node.children ?? []) {
            getTableMcids(child, ids);
        }
        return ids;
    }
    const tables = [];
    function walkNode(node) {
        if (node.role === 'Table') {
            const rows = [];
            for (const child of node.children ?? []) {
                const trs = child.role === 'TR'
                    ? [child]
                    : ['TBody', 'THead', 'TFoot'].includes(child.role)
                        ? (child.children ?? []).filter(c => c.role === 'TR')
                        : [];
                for (const tr of trs) {
                    const cells = (tr.children ?? []).filter(c => c.role === 'TD' || c.role === 'TH');
                    if (!cells.length) {
                        continue;
                    }
                    const row = cells.map(cell => getCellText(cell).trim());
                    if (row.some(Boolean)) {
                        rows.push(row);
                    }
                }
            }
            if (rows.length >= TABLE_MIN_ROWS) {
                const mcids = getTableMcids(node);
                let yTop = Infinity;
                let yBottom = 0;
                for (const id of mcids) {
                    const entry = mcidMap.get(id);
                    if (entry?.yTop != null) {
                        yTop = Math.min(yTop, entry.yTop);
                        yBottom = Math.max(yBottom, entry.yTop + 12);
                    }
                }
                tables.push({ rows, mcids, yTop: Number.isFinite(yTop) ? yTop : 0, yBottom: yBottom || 100 });
            }
            return;
        }
        for (const child of node.children ?? []) {
            walkNode(child);
        }
    }
    walkNode(structTree);
    return tables;
}

export function detectTables(items) {
    if (items.length === 0) {
        return { tables: [], nonTableItems: [] };
    }
    const rowInfos = groupItemsIntoRows(items).map(buildRowInfo).filter(row => row.items.length > 0);
    if (rowInfos.length < TABLE_MIN_ROWS) {
        return { tables: [], nonTableItems: items };
    }
    const tables = [];
    const nonTableItems = [];
    let rowIndex = 0;
    while (rowIndex < rowInfos.length) {
        const start = rowInfos[rowIndex];
        if (start.anchors.length < TABLE_MIN_COLS) {
            nonTableItems.push(...start.items);
            rowIndex += 1;
            continue;
        }
        let nextIndex = rowIndex + 1;
        let tableAnchors = [...start.anchors];
        const tableRows = [start];
        while (nextIndex < rowInfos.length) {
            const candidate = rowInfos[nextIndex];
            const mapped = mapRowToAnchors(candidate.items, tableAnchors);
            const candidateHasColumns = candidate.anchors.length >= 2;
            const candidateText = candidate.items.map(item => item.str).join(' ').trim();
            const candidateLooksLikeContinuation = mapped.filledColumns.size >= 1
                && /^[a-z0-9<>=!&|()[\]{}"'.,/-]/.test(candidateText);
            const candidateLooksTableLike = candidateHasColumns && (
                mapped.filledColumns.size >= 2
                || (tableAnchors.length >= 3 && mapped.coverage >= TABLE_MIN_COV)
            )
                || (!candidateHasColumns && candidateLooksLikeContinuation);
            if (!candidateLooksTableLike) {
                break;
            }
            tableRows.push(candidate);
            tableAnchors = mergeAnchors(tableAnchors, candidate.anchors);
            nextIndex += 1;
        }
        if (tableRows.length < TABLE_MIN_ROWS) {
            nonTableItems.push(...tableRows.flatMap(row => row.items));
            rowIndex = nextIndex;
            continue;
        }
        if (tableAnchors.length < TABLE_MIN_COLS) {
            nonTableItems.push(...tableRows.flatMap(row => row.items));
            rowIndex = nextIndex;
            continue;
        }
        const grid = tableRows.map(row => {
            return mapRowToAnchors(row.items, tableAnchors).cells;
        });
        const yTop = Math.min(...tableRows.map(row => row.yTop));
        const yBottom = Math.max(...tableRows.map(row => row.yBottom));
        tables.push({ rows: grid, yTop, yBottom });
        rowIndex = nextIndex;
    }
    return {
        tables,
        nonTableItems,
    };
}

export function pageLooksBlank(profile) {
    return profile.wordCount === 0 && profile.imageCoverage === 0 && profile.annotationsCount === 0;
}

export function pageLooksTableHeavy(profile) {
    return profile.tableLikelihood >= ROUTE_TABLE_LIKELIHOOD;
}
