import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicError } from '../src/core/errors.mjs';
import { PARSER_ERRORS, parserErrorPayload } from '../src/runtime/parser-errors.mjs';
import { readExtractionWorkerResult } from '../src/runtime/subprocess.mjs';
import { OutputSchemas } from '../src/server/schemas.mjs';
import { loadConfig } from '../src/config/runtime.mjs';
import { validatePdfBytes } from '../src/security/source.mjs';
import { buildPageErrorResult } from '../src/extract/page-processor.mjs';

const fixtureRoot = path.resolve('test/fixtures/generated');

test('page failures never expose exception text or internal paths', () => {
    const result = buildPageErrorResult({ pageNum: 1, pdfjsPage: { cleanup() {} }, rawItems: [], viewport: { width: 612, height: 792, rotation: 0 } }, new Error('C:\\private\\document.pdf parser stack detail'));
    assert.equal(result.fallbackReason, 'Page extraction failed');
    assert.equal(result.text, '(Page extraction failed)');
    assert.doesNotMatch(JSON.stringify(result), /private|parser stack/i);
});

test('malformed fixture preflight uses stable sanitized parser codes', async () => {
    const config = loadConfig({ maxDocumentBytes: 20_000_000 });
    const expected = {
        'invalid-signature.pdf': 'PDF_INVALID_SIGNATURE',
        'truncated.pdf': 'PDF_TRUNCATED',
        'invalid-xref.pdf': 'PDF_INVALID_XREF',
        'missing-startxref.pdf': 'PDF_INVALID_STARTXREF',
    };
    for (const [name, code] of Object.entries(expected)) {
        const bytes = await fs.readFile(path.join(fixtureRoot, name));
        assert.throws(() => validatePdfBytes(bytes, config), { code });
    }
});

test('parent worker-result handling contains missing, malformed, and unknown failures', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-worker-result-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { maxDecompressedBytes: 1_000_000, debug: false };
    const enforcement = { wallClock: 'hard-runtime-termination' };
    const output = path.join(root, 'result.json');
    await assert.rejects(readExtractionWorkerResult({ output, exitCode: 1, stderr: 'C:\\secret\\parser.err', config, enforcement }), error => publicError(error).code === 'PDF_PARSER_CRASH');
    await fs.writeFile(output, '{bad json');
    await assert.rejects(readExtractionWorkerResult({ output, exitCode: 1, stderr: 'raw parser stderr', config, enforcement }), error => {
        const value = publicError(error);
        return value.code === 'PDF_PARSER_CRASH' && !JSON.stringify(value).includes('stderr');
    });
    await fs.writeFile(output, JSON.stringify({ ok: false, error: { code: 'PDF_BACKEND_RANDOM', message: 'raw' } }));
    await assert.rejects(readExtractionWorkerResult({ output, exitCode: 1, config, enforcement }), error => publicError(error).code === 'PDF_PARSER_CRASH');
    const structured = parserErrorPayload('PDF_INVALID_XREF');
    await fs.writeFile(output, JSON.stringify({ ok: false, error: structured }));
    await assert.rejects(readExtractionWorkerResult({ output, exitCode: 1, config, enforcement }), error => assert.deepEqual(publicError(error), structured) === undefined);
});

test('worker writes one structured failure and keeps stdout clean', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-worker-process-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'source.pdf');
    const output = path.join(root, 'result.json');
    await fs.writeFile(input, '%PDF-1.7\ninvalid');
    const worker = fileURLToPath(new URL('../src/runtime/extract-worker.mjs', import.meta.url));
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, input, output, '{invalid-json'], { windowsHide: true });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', value => stdout.push(value));
        child.stderr.on('data', value => stderr.push(value));
        child.once('error', reject);
        child.once('exit', code => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const payload = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(payload.ok, false);
    assert.ok(PARSER_ERRORS[payload.error.code]);
});

test('output schemas reject undocumented parser codes', () => {
    const envelope = {
        schemaVersion: '3.0.0', operation: 'pdf_open', documentId: null, extractionFingerprint: null,
        data: { error: { code: 'PDF_BACKEND_RANDOM', message: 'unsafe' } }, citations: [], warnings: [], diagnostics: null,
        omissions: [], budget: null, nextCursor: null,
    };
    assert.equal(OutputSchemas.pdf_open.safeParse(envelope).success, false);
});
