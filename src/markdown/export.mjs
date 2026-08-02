import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PdfDecompilerError } from '../core/errors.mjs';
import { fullExportIdentity, fullMarkdownChunks, MARKDOWN_FORMAT_VERSION } from './serializer.mjs';

export function markdownResourceUri(model) {
    const serializerFingerprint = fullExportIdentity(model.extractionFingerprint);
    return `pdf-decompiler://document/${model.documentId}/${model.extractionFingerprint}/markdown/${MARKDOWN_FORMAT_VERSION}/${serializerFingerprint}/full.md`;
}

function exportError(code, message) {
    return new PdfDecompilerError(code, message);
}

function conservativeElementBytes(element, limit) {
    const stack = [element];
    let bytes = 0;
    while (stack.length && bytes <= limit) {
        const value = stack.pop();
        if (typeof value === 'string') bytes += Buffer.byteLength(value) * 6 + 32;
        else if (Array.isArray(value)) {
            bytes += value.length * 32;
            stack.push(...value);
        } else if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            bytes += entries.length * 128;
            for (const [key, child] of entries) {
                bytes += Buffer.byteLength(key) * 2;
                stack.push(child);
            }
        } else bytes += 32;
    }
    return bytes;
}

export async function getFullMarkdownExport(model, cache, config, expectedFingerprint = null) {
    const serializerFingerprint = fullExportIdentity(model.extractionFingerprint);
    if (expectedFingerprint && expectedFingerprint !== serializerFingerprint) {
        const old = await cache.loadDerivedMarkdown(model.documentId, model.extractionFingerprint, expectedFingerprint);
        if (old) return { ...old, serializerFingerprint: expectedFingerprint };
        throw exportError('stale_markdown_resource', 'The requested Markdown serializer generation is unavailable.');
    }
    const cached = await cache.loadDerivedMarkdown(model.documentId, model.extractionFingerprint, serializerFingerprint);
    if (cached) return { ...cached, serializerFingerprint };
    const limits = config.markdown;
    const tables = model.elements.filter(element => element.type === 'table');
    const tableRows = tables.reduce((sum, table) => sum + table.totalRows, 0);
    const tableCells = tables.reduce((sum, table) => sum + table.cells.length, 0);
    if (model.elements.length > limits.maxElements || tableRows > limits.maxTableRows || tableCells > limits.maxTableCells) {
        throw exportError('MARKDOWN_EXPORT_TOO_LARGE', 'The complete Markdown export exceeds configured element or table limits. Use paged Markdown retrieval with cursors.');
    }
    if (model.elements.some(element => conservativeElementBytes(element, limits.maxBufferBytes) > limits.maxBufferBytes)) {
        throw exportError('MARKDOWN_SERIALIZATION_MEMORY_LIMIT', 'A Markdown export fragment exceeds the bounded serializer working buffer. Use paged Markdown retrieval with cursors.');
    }
    const tempPath = await cache.createDerivedTempFile(model.documentId, model.extractionFingerprint);
    const handle = await fs.open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    const startedAt = Date.now();
    let bytes = 0;
    try {
        for (const chunk of fullMarkdownChunks(model)) {
            if (Date.now() - startedAt > limits.timeoutMs) throw exportError('MARKDOWN_SERIALIZATION_TIMEOUT', 'The complete Markdown export exceeded its serialization deadline. Use paged Markdown retrieval with cursors.');
            const encoded = Buffer.from(chunk, 'utf8');
            if (encoded.length > limits.maxBufferBytes) throw exportError('MARKDOWN_SERIALIZATION_MEMORY_LIMIT', 'A Markdown export fragment exceeded the serializer buffer limit. Use paged Markdown retrieval with cursors.');
            bytes += encoded.length;
            if (bytes > Math.min(limits.maxBytes, limits.maxCacheEntryBytes)) throw exportError('MARKDOWN_EXPORT_TOO_LARGE', 'The complete Markdown export exceeds the configured byte limit. Use paged Markdown retrieval with cursors.');
            hash.update(encoded);
            await handle.write(encoded);
        }
        await handle.sync();
        await handle.close();
        const sha256 = hash.digest('hex');
        const saved = await cache.saveDerivedMarkdown(model.documentId, model.extractionFingerprint, serializerFingerprint, tempPath, {
            bytes,
            sha256,
            markdownFormatVersion: MARKDOWN_FORMAT_VERSION,
        });
        return { ...saved, serializerFingerprint };
    } catch (error) {
        await handle.close().catch(() => {});
        if (error instanceof PdfDecompilerError) throw error;
        throw exportError(error?.code === 'ENOSPC' || error?.code === 'EACCES' ? 'MARKDOWN_CACHE_WRITE_FAILED' : 'MARKDOWN_SERIALIZATION_FAILED', 'The complete Markdown export could not be generated.');
    } finally {
        await fs.rm(tempPath, { force: true }).catch(() => {});
    }
}
