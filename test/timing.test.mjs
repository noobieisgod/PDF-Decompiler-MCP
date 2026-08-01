import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const fixtureRoot = path.resolve('test/fixtures/generated');

async function runServer(timing) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('src/index.mjs')],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: {
            PDF_DECOMPILER_CACHE_MODE: 'none',
            PDF_DECOMPILER_ALLOW_ROOTS_JSON: JSON.stringify([fixtureRoot]),
            PDF_DECOMPILER_TIMING: timing ? '1' : '0',
        },
    });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'timing-test', version: '1.0.0' });
    await client.connect(transport);
    return { client, stderr: () => stderr };
}

test('timing is disabled by default', async t => {
    const server = await runServer(false);
    t.after(() => server.client.close());
    await server.client.listTools();
    assert.doesNotMatch(server.stderr(), /pdf-decompiler-(?:transport-)?timing/);
});

test('opt-in close timing reports sanitized server and transport phases', async t => {
    const server = await runServer(true);
    t.after(() => server.client.close());
    const source = path.join(fixtureRoot, 'text.pdf');
    const opened = await server.client.callTool({ name: 'pdf_open', arguments: { source, sourceLabel: 'private-label' } });
    assert.equal(opened.isError, undefined);
    const data = opened.structuredContent.data;
    const closed = await server.client.callTool({
        name: 'pdf_close',
        arguments: { documentId: data.documentId, extractionFingerprint: data.extractionFingerprint, sourceId: data.sourceId },
    });
    assert.equal(closed.isError, undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    const logs = server.stderr();
    assert.match(logs, /"operation":"pdf_close"/);
    assert.match(logs, /"document_lookup":/);
    assert.match(logs, /"handle_release":/);
    assert.match(logs, /"lease_release":/);
    assert.match(logs, /"resource_cleanup":/);
    assert.match(logs, /"phase":"stdio_response_completion"/);
    assert.doesNotMatch(logs, /private-label|text\.pdf|extraction correctness/i);
});
