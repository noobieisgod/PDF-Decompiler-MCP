import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { createServer } from '../src/server/create-server.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

const TOOL_NAMES = ['pdf_open', 'pdf_document_info', 'pdf_search', 'pdf_get_pages', 'pdf_get_element', 'pdf_render_page', 'pdf_close'];

async function connected(t) {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const source = path.join(root, 'workflow.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['Composable MCP workflow evidence'], link: true }));
    const manager = await new DocumentManager(config).init();
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'pdf-decompiler-tests', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await manager.close(); });
    return { client, source };
}

test('all seven tools expose input and output schemas and complete the new workflow', async t => {
    const { client, source } = await connected(t);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), TOOL_NAMES);
    assert.ok(tools.every(tool => tool.inputSchema?.type === 'object' && tool.outputSchema?.type === 'object'));
    assert.ok(!tools.some(tool => tool.name === 'extract_pdf_content'));

    const open = await client.callTool({ name: 'pdf_open', arguments: { source } });
    assert.equal(open.isError, undefined);
    assert.equal(open.structuredContent.operation, 'pdf_open');
    const reference = { documentId: open.structuredContent.documentId, extractionFingerprint: open.structuredContent.extractionFingerprint };
    const info = await client.callTool({ name: 'pdf_document_info', arguments: reference });
    assert.equal(info.structuredContent.data.cache.mode, 'persistent');
    const search = await client.callTool({ name: 'pdf_search', arguments: { ...reference, query: 'workflow', strategy: 'full_text' } });
    assert.ok(search.structuredContent.data.results.length);
    const pages = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, pages: [1], mode: 'fidelity' } });
    const element = pages.structuredContent.data.elements[0];
    assert.equal(element.citation.extractionFingerprint, reference.extractionFingerprint);
    const one = await client.callTool({ name: 'pdf_get_element', arguments: { ...reference, elementId: element.id } });
    assert.equal(one.structuredContent.data.element.id, element.id);

    const linked = await client.callTool({ name: 'pdf_render_page', arguments: { ...reference, page: 1, maxDimension: 256, imageDelivery: 'auto' } });
    const resource = linked.content.find(item => item.type === 'resource_link');
    assert.ok(resource.uri.includes(reference.extractionFingerprint));
    assert.ok(linked.content[0].text.includes(resource.uri));
    assert.ok((await client.readResource({ uri: resource.uri })).contents[0].blob);
    const inline = await client.callTool({ name: 'pdf_render_page', arguments: { ...reference, page: 1, maxDimension: 128, imageDelivery: 'inline' } });
    assert.ok(inline.content.some(item => item.type === 'image'));
    const closed = await client.callTool({ name: 'pdf_close', arguments: reference });
    assert.equal(closed.structuredContent.data.closed, true);
    assert.ok((await client.readResource({ uri: resource.uri })).contents[0].blob);
    const afterClose = await client.callTool({ name: 'pdf_search', arguments: { ...reference, query: 'workflow' } });
    assert.equal(afterClose.isError, true);
    assert.equal(afterClose.structuredContent.data.error.code, 'closed_document');
});

test('tool errors are structured and sanitized', async t => {
    const { client } = await connected(t);
    const result = await client.callTool({ name: 'pdf_open', arguments: { source: 'missing.pdf' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.error.code, 'source_not_found');
    assert.ok(!JSON.stringify(result).includes('node:internal'));
});
