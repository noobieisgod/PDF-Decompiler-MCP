import { fingerprint } from '../core/crypto.mjs';

export const MARKDOWN_FORMAT_VERSION = 1;
export const MARKDOWN_SERIALIZER_REVISION = 1;

const SAFE_EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value) {
    return String(value ?? '').normalize('NFC').replace(CONTROL_CHARACTERS, '').replace(/\r\n?/g, '\n');
}

function escapeHtml(value) {
    return clean(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeInline(value) {
    return escapeHtml(value)
        .replace(/([\\`*_[\]{}()#+.!|>~-])/g, '\\$1')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeTableCell(value) {
    return escapeHtml(value).replaceAll('|', '&#124;').replaceAll('\n', '<br>');
}

function safeUrl(value) {
    if (!value) return null;
    try {
        const parsed = new URL(clean(value));
        return SAFE_EXTERNAL_SCHEMES.has(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : null;
    } catch {
        return null;
    }
}

function marker(id) {
    const safe = String(id || '').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160);
    return `<!-- pdf-decompiler element=${safe} -->`;
}

function codeBlock(element) {
    const text = clean(element.text);
    const backticks = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
    const tildes = Math.max(0, ...[...text.matchAll(/~+/g)].map(match => match[0].length));
    const useTilde = tildes < backticks;
    const length = Math.max(3, (useTilde ? tildes : backticks) + 1);
    const language = /^[a-z0-9_+-]{1,32}$/.test(element.codeLanguage || '') ? element.codeLanguage : '';
    if (length > 32) return text.split('\n').map(line => `    ${line}`).join('\n');
    const fence = (useTilde ? '~' : '`').repeat(length);
    return `${fence}${language}\n${text}\n${fence}`;
}

function listBlock(element) {
    const indent = ' '.repeat(Math.max(0, Math.min(32, element.listLevel || 0)) * 4);
    const prefix = element.listContinuation ? '    '
        : element.listKind === 'ordered' ? `${element.listOrdinal || element.listStart || 1}. ` : '- ';
    const lines = clean(element.text).split('\n');
    const first = element.listKind === 'ordered' ? lines[0].replace(/^\s*\d+[.)]\s+/, '') : lines[0].replace(/^\s*[-*+]\s+/, '');
    return `${indent}${prefix}${escapeInline(first)}${lines.slice(1).map(line => `\n${indent}    ${escapeInline(line)}`).join('')}`;
}

function tableHasSpans(table) {
    return (table.cells || []).some(cell => cell.rowSpan > 1 || cell.columnSpan > 1);
}

function markdownTable(table) {
    const rows = table.rows || [];
    if (!rows.length) return '(empty table)';
    const width = Math.max(1, ...rows.map(row => row.length));
    const normalized = rows.map(row => Array.from({ length: width }, (_, index) => escapeTableCell(row[index] || '')));
    return [
        `| ${normalized[0].join(' | ')} |`,
        `| ${normalized[0].map(() => '---').join(' | ')} |`,
        ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
    ].join('\n');
}

function htmlTable(table) {
    const byStart = new Map((table.cells || []).map(cell => [`${cell.row}:${cell.column}`, cell]));
    const covered = new Set();
    const lines = ['<table>'];
    for (let row = 1; row <= (table.rows || []).length; row += 1) {
        lines.push('  <tr>');
        for (let column = 1; column <= (table.rows[row - 1] || []).length; column += 1) {
            if (covered.has(`${row}:${column}`)) continue;
            const cell = byStart.get(`${row}:${column}`) || { text: table.rows[row - 1][column - 1], rowSpan: 1, columnSpan: 1 };
            for (let y = row; y < row + cell.rowSpan; y += 1) for (let x = column; x < column + cell.columnSpan; x += 1) {
                if (y !== row || x !== column) covered.add(`${y}:${x}`);
            }
            const attributes = `${cell.rowSpan > 1 ? ` rowspan="${Number(cell.rowSpan)}"` : ''}${cell.columnSpan > 1 ? ` colspan="${Number(cell.columnSpan)}"` : ''}`;
            lines.push(`    <td${attributes}>${escapeHtml(cell.text).replaceAll('\n', '<br>')}</td>`);
        }
        lines.push('  </tr>');
    }
    lines.push('</table>');
    return lines.join('\n');
}

function tableBlock(element, tableDetail) {
    if (tableDetail === 'compact') {
        const rows = (element.rows || []).slice(0, 6).map(row => row.slice(0, 8));
        const compact = { ...element, rows, cells: (element.cells || []).filter(cell => cell.row <= 6 && cell.column <= 8) };
        const preview = tableHasSpans(compact) ? htmlTable(compact) : markdownTable(compact);
        const truncated = element.totalRows > rows.length || element.totalColumns > Math.max(0, ...rows.map(row => row.length));
        return `${preview}${truncated ? `\n\n[Full table: ${element.id}; ${element.totalRows} rows by ${element.totalColumns} columns]` : ''}`;
    }
    return tableHasSpans(element) ? htmlTable(element) : markdownTable(element);
}

export function serializeElementMarkdown(element, { tableDetail = 'compact' } = {}) {
    let body;
    if (element.type === 'block') {
        if (element.role === 'heading') body = `${'#'.repeat(element.headingLevel || 2)} ${escapeInline(element.text)}`;
        else if (element.role === 'list') body = listBlock(element);
        else if (element.role === 'code') body = codeBlock(element);
        else body = escapeInline(element.text);
    } else if (element.type === 'table') {
        body = tableBlock(element, tableDetail);
    } else if (element.type === 'figure') {
        const alt = escapeInline(element.caption || `Figure on page ${element.page}`);
        body = `![${alt}](${element.asset.uri})`;
    } else if (element.type === 'annotation') {
        body = clean(element.text || element.subtype || 'Annotation').split('\n').map(line => `> ${escapeInline(line)}`).join('\n');
    } else if (element.type === 'link') {
        const label = escapeInline(element.text || element.annotationText || 'Link');
        const external = safeUrl(element.url);
        if (external) body = `[${label}](${external.replace(/[()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)})`;
        else if (element.destination?.page) body = `[${label}](#page-${element.destination.page})`;
        else body = label;
    } else {
        body = '';
    }
    return `${marker(element.id)}\n${body}`;
}

export function pageAnchor(page) {
    return `<!-- pdf-decompiler page=${page} -->\n<a id="page-${page}"></a>`;
}

export function serializePagedMarkdown(elements, pages, options = {}) {
    const byPage = new Map(pages.map(page => [page, []]));
    for (const element of elements) if (byPage.has(element.page)) byPage.get(element.page).push(element);
    const parts = [];
    for (const page of pages) {
        const pageElements = byPage.get(page) || [];
        if (!pageElements.length) continue;
        parts.push(pageAnchor(page), ...pageElements.map(element => serializeElementMarkdown(element, options)));
    }
    return parts.join('\n\n');
}

export function fullExportIdentity(extractionFingerprint, settings = {}) {
    return fingerprint({
        extractionFingerprint,
        markdownFormatVersion: MARKDOWN_FORMAT_VERSION,
        serializerRevision: MARKDOWN_SERIALIZER_REVISION,
        fullTableRepresentationRevision: settings.fullTableRepresentationRevision ?? 1,
        headingRepresentationRevision: settings.headingRepresentationRevision ?? 1,
        listRepresentationRevision: settings.listRepresentationRevision ?? 1,
        codeBlockRepresentationRevision: settings.codeBlockRepresentationRevision ?? 1,
        imageLinkRepresentationRevision: settings.imageLinkRepresentationRevision ?? 1,
        annotationRepresentationRevision: settings.annotationRepresentationRevision ?? 1,
        escapingRevision: settings.escapingRevision ?? 1,
        urlPolicyRevision: settings.urlPolicyRevision ?? 1,
        imageLinkRepresentation: settings.imageLinkRepresentation ?? 'generation_resource_uri',
    });
}

export function *fullMarkdownChunks(model) {
    const elementsByPage = new Map(model.pages.map(page => [page.number, []]));
    for (const element of model.elements) elementsByPage.get(element.page)?.push(element);
    for (const page of model.pages) {
        yield `${pageAnchor(page.number)}\n\n`;
        for (const element of elementsByPage.get(page.number) || []) yield `${serializeElementMarkdown(element, { tableDetail: 'full' })}\n\n`;
    }
}
