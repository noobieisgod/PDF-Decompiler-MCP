import os from 'node:os';
import path from 'node:path';

const parseBoolean = value => value === '1' || value === 'true';

function parseJsonArray(value, name) {
    if (!value) return [];
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(`${name} must be a JSON array`);
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
        throw new Error(`${name} must be a JSON array of strings`);
    }
    return parsed;
}

function number(value, name, { min = 1 } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be a finite number greater than or equal to ${min}`);
    return parsed;
}

function boundedNumber(value, name, defaultValue, hardMaximum) {
    const parsed = number(value ?? defaultValue, name);
    if (parsed > hardMaximum) throw new Error(`${name} must not exceed ${hardMaximum}`);
    return parsed;
}

function defaultCacheDir() {
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'pdf-decompiler-mcp');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', 'pdf-decompiler-mcp');
    }
    return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pdf-decompiler-mcp');
}

export function loadConfig(overrides = {}) {
    const env = process.env;
    const cacheMode = overrides.cacheMode || env.PDF_DECOMPILER_CACHE_MODE || 'persistent';
    if (!['persistent', 'ephemeral', 'none'].includes(cacheMode)) {
        throw new Error('cache.mode must be persistent, ephemeral, or none');
    }
    const ocrPolicy = overrides.ocrPolicy || env.PDF_DECOMPILER_OCR_POLICY || 'auto';
    if (!['auto', 'off', 'required'].includes(ocrPolicy)) throw new Error('ocrPolicy must be auto, off, or required');
    const config = {
        schemaVersion: '3.0.0',
        extractorVersion: '3.0.0',
        ocrPolicy,
        allowRoots: overrides.allowRoots ?? parseJsonArray(env.PDF_DECOMPILER_ALLOW_ROOTS_JSON, 'PDF_DECOMPILER_ALLOW_ROOTS_JSON'),
        denyRoots: overrides.denyRoots ?? parseJsonArray(env.PDF_DECOMPILER_DENY_ROOTS_JSON, 'PDF_DECOMPILER_DENY_ROOTS_JSON'),
        unrestrictedLocalAccess: overrides.unrestrictedLocalAccess ?? parseBoolean(env.PDF_DECOMPILER_UNRESTRICTED_LOCAL_ACCESS),
        allowUnc: overrides.allowUnc ?? parseBoolean(env.PDF_DECOMPILER_ALLOW_UNC),
        maxDocumentBytes: number(overrides.maxDocumentBytes ?? env.PDF_DECOMPILER_MAX_DOCUMENT_BYTES ?? 250 * 1024 * 1024, 'maxDocumentBytes'),
        maxPages: number(overrides.maxPages ?? env.PDF_DECOMPILER_MAX_PAGES ?? 5000, 'maxPages'),
        maxDecompressedBytes: number(overrides.maxDecompressedBytes ?? env.PDF_DECOMPILER_MAX_DECOMPRESSED_BYTES ?? 512 * 1024 * 1024, 'maxDecompressedBytes'),
        extractionTimeoutMs: number(overrides.extractionTimeoutMs ?? env.PDF_DECOMPILER_EXTRACTION_TIMEOUT_MS ?? 50_000, 'extractionTimeoutMs'),
        subprocessMemoryBytes: number(overrides.subprocessMemoryBytes ?? env.PDF_DECOMPILER_SUBPROCESS_MEMORY_BYTES ?? 2 * 1024 * 1024 * 1024, 'subprocessMemoryBytes'),
        cache: {
            mode: cacheMode,
            directory: path.resolve(overrides.cacheDirectory || env.PDF_DECOMPILER_CACHE_DIR || defaultCacheDir()),
            retentionDays: number(overrides.cacheRetentionDays ?? env.PDF_DECOMPILER_CACHE_RETENTION_DAYS ?? 30, 'cache.retentionDays', { min: 0 }),
            maxBytes: number(overrides.cacheMaxBytes ?? env.PDF_DECOMPILER_CACHE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024, 'cache.maxBytes'),
            allowSharedRoot: overrides.allowSharedCacheRoot ?? parseBoolean(env.PDF_DECOMPILER_ALLOW_SHARED_CACHE_ROOT),
        },
        semantic: {
            enabled: overrides.semanticEnabled ?? parseBoolean(env.PDF_DECOMPILER_SEMANTIC_ENABLED),
            allowDownload: overrides.semanticAllowDownload ?? parseBoolean(env.PDF_DECOMPILER_SEMANTIC_ALLOW_DOWNLOAD),
        },
        cursorTtlMs: number(overrides.cursorTtlMs ?? env.PDF_DECOMPILER_CURSOR_TTL_MS ?? 3_600_000, 'cursorTtlMs'),
        markdown: {
            maxBytes: boundedNumber(overrides.markdownMaxBytes ?? env.PDF_DECOMPILER_MARKDOWN_MAX_BYTES, 'markdown.maxBytes', 16 * 1024 * 1024, 64 * 1024 * 1024),
            timeoutMs: boundedNumber(overrides.markdownTimeoutMs ?? env.PDF_DECOMPILER_MARKDOWN_TIMEOUT_MS, 'markdown.timeoutMs', 30_000, 120_000),
            maxBufferBytes: boundedNumber(overrides.markdownMaxBufferBytes ?? env.PDF_DECOMPILER_MARKDOWN_MAX_BUFFER_BYTES, 'markdown.maxBufferBytes', 8 * 1024 * 1024, 32 * 1024 * 1024),
            maxElements: boundedNumber(overrides.markdownMaxElements ?? env.PDF_DECOMPILER_MARKDOWN_MAX_ELEMENTS, 'markdown.maxElements', 100_000, 500_000),
            maxTableRows: boundedNumber(overrides.markdownMaxTableRows ?? env.PDF_DECOMPILER_MARKDOWN_MAX_TABLE_ROWS, 'markdown.maxTableRows', 50_000, 250_000),
            maxTableCells: boundedNumber(overrides.markdownMaxTableCells ?? env.PDF_DECOMPILER_MARKDOWN_MAX_TABLE_CELLS, 'markdown.maxTableCells', 500_000, 2_000_000),
            maxCacheEntryBytes: boundedNumber(overrides.markdownMaxCacheEntryBytes ?? env.PDF_DECOMPILER_MARKDOWN_MAX_CACHE_ENTRY_BYTES, 'markdown.maxCacheEntryBytes', 16 * 1024 * 1024, 64 * 1024 * 1024),
        },
        debug: overrides.debug ?? parseBoolean(env.PDF_DECOMPILER_DEBUG),
    };
    return config;
}
