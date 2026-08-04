import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('stdio stays protocol-clean, accepts a 2025-era opening, and shuts down', async () => {
    const child = spawn(process.execPath, [path.resolve('src/index.mjs')], {
        env: { ...process.env, PDF_DECOMPILER_CACHE_MODE: 'none' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-smoke', version: '1.0.0' } } })}\n`);
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":1') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(stdout, /"protocolVersion":"2025-06-18"/);
    assert.match(stdout, /start textual work with pdf_search or pdf_get_pages using mode text/);
    assert.doesNotMatch(stdout, /pdf-decompiler-mcp\]/);
    child.stdin.end();
    const exitCode = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
});
