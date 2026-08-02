import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { fullExportIdentity, serializeElementMarkdown } from '../src/markdown/serializer.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { createServer } from '../src/server/create-server.mjs';
import { buildSyntheticPdf } from './fixtures/generate-fixtures.mjs';
import { temporaryConfig } from './helpers.mjs';

test('Markdown escaping is context-specific and full export identity ignores compact preview settings', () => {
    const base = { id: 'block:1:1', page: 1 };
    assert.ok(!serializeElementMarkdown({ ...base, type: 'block', role: 'text', text: '<script>x</script> ![x](file:///c:/secret)' }).includes('<script>'));
    const link = serializeElementMarkdown({ ...base, type: 'link', text: 'unsafe', url: 'javascript:alert(1)', destination: null });
    assert.ok(!link.includes('javascript:'));
    const code = serializeElementMarkdown({ ...base, type: 'block', role: 'code', text: '```\nvalue\n```', codeLanguage: 'js' });
    assert.match(code, /~~~js/);
    const generation = 'a'.repeat(64);
    assert.equal(fullExportIdentity(generation, { compactTableRows: 5 }), fullExportIdentity(generation, { compactTableRows: 50 }));
    assert.notEqual(fullExportIdentity(generation), fullExportIdentity(generation, { escapingRevision: 2 }));
});

test('paged Markdown appears once in structured content and complete resources are atomic and generation-bound', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none' });
    const source = path.join(root, 'markdown.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['MARKDOWN UNIQUE PAYLOAD'] }));
    const manager = await new DocumentManager(config).init();
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'markdown-test', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await manager.close(); });
    const opened = await client.callTool({ name: 'pdf_open', arguments: { source } });
    const reference = { documentId: opened.structuredContent.documentId, extractionFingerprint: opened.structuredContent.extractionFingerprint };
    const response = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, pages: [1], outputFormat: 'markdown' } });
    assert.equal(response.structuredContent.data.outputFormat, 'markdown');
    assert.match(response.structuredContent.data.markdown, /MARKDOWN UNIQUE PAYLOAD/);
    assert.equal((JSON.stringify(response).match(/MARKDOWN UNIQUE PAYLOAD/g) || []).length, 1, 'Markdown appears only in structured content');
    assert.ok(response.content[0].text.length <= 2048);
    const uri = response.structuredContent.data.resourceUris.find(value => value.endsWith('/full.md'));
    const first = await client.readResource({ uri });
    const second = await client.readResource({ uri });
    assert.equal(first.contents[0].text, second.contents[0].text);
    assert.match(first.contents[0].text, /MARKDOWN UNIQUE PAYLOAD/);
});

test('complete Markdown export fails instead of truncating beyond its hard configured size', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none', markdownMaxBytes: 64, markdownMaxCacheEntryBytes: 64 });
    const source = path.join(root, 'large-markdown.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['A complete export that is deliberately longer than sixty four bytes.'] }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const pages = await manager.getPages({ ...opened, outputFormat: 'markdown' });
    const uri = pages.resourceUris.find(value => value.endsWith('/full.md'));
    await assert.rejects(manager.readResource(uri), { code: 'MARKDOWN_EXPORT_TOO_LARGE' });
});

test('complete Markdown export rejects an element before exceeding the serializer working buffer', async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'none', markdownMaxBytes: 1_000_000, markdownMaxBufferBytes: 256 });
    const source = path.join(root, 'buffer-bound-markdown.pdf');
    await fs.writeFile(source, buildSyntheticPdf({ pages: ['A source element that is deliberately too large for the configured serializer working buffer.'] }));
    const manager = await new DocumentManager(config).init();
    t.after(() => manager.close());
    const opened = await manager.open({ source });
    const pages = await manager.getPages({ ...opened, outputFormat: 'markdown' });
    const uri = pages.resourceUris.find(value => value.endsWith('/full.md'));
    await assert.rejects(manager.readResource(uri), { code: 'MARKDOWN_SERIALIZATION_MEMORY_LIMIT' });
});

test('paged Markdown stays within the complete wire budget and makes deterministic cursor progress', async t => {
    const fixtureRoot = path.resolve('test/fixtures/generated');
    const { config } = await temporaryConfig(t, { cacheMode: 'none', allowRoots: [fixtureRoot] });
    const manager = await new DocumentManager(config).init();
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'markdown-budget-test', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); await manager.close(); });
    const opened = await client.callTool({ name: 'pdf_open', arguments: { source: path.join(fixtureRoot, 'oversized-content.pdf') } });
    const reference = { documentId: opened.structuredContent.documentId, extractionFingerprint: opened.structuredContent.extractionFingerprint };
    const markers = [];
    let cursor;
    do {
        const response = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, pages: [1, 2, 3, 4], outputFormat: 'markdown', budget: { responseBytes: 12_000, estimatedTokens: 3000 }, ...(cursor ? { cursor } : {}) } });
        assert.equal(response.isError, undefined);
        assert.ok(Buffer.byteLength(JSON.stringify(response)) + 1024 <= 12_000);
        markers.push(...[...response.structuredContent.data.markdown.matchAll(/element=([^ ]+) -->/g)].map(match => match[1]));
        assert.ok(response.structuredContent.data.markdown.length || response.structuredContent.omissions.length);
        cursor = response.structuredContent.nextCursor;
    } while (cursor);
    assert.equal(new Set(markers).size, markers.length);
});

test('exact wire overflow rebuilds paged Markdown with fewer progress fragments', async t => {
    let calls = 0;
    const manager = {
        getPages: async args => {
            calls += 1;
            const reduced = Number.isFinite(args._wireResponseBytes);
            return {
                documentId: 'doc_' + 'a'.repeat(64),
                extractionFingerprint: 'b'.repeat(64),
                outputFormat: 'markdown',
                markdownFormatVersion: 1,
                pages: [1],
                markdown: reduced ? 'bounded' : 'x'.repeat(20_000),
                resourceUris: [],
                citations: [],
                warnings: [],
                omissions: [],
                budget: { configured: { responseBytes: 8000 }, usage: { responseBytes: 0, estimatedTokens: 0 }, estimators: {} },
                nextCursor: reduced ? 'continued' : null,
                completion: { documentComplete: true, requestedScopeComplete: true, resultComplete: !reduced },
            };
        },
    };
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'wire-rebuild-test', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });
    const response = await client.callTool({
        name: 'pdf_get_pages',
        arguments: { documentId: 'doc_' + 'a'.repeat(64), extractionFingerprint: 'b'.repeat(64), pages: [1], outputFormat: 'markdown', budget: { responseBytes: 8000 } },
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.data.markdown, 'bounded');
    assert.equal(response.structuredContent.completion.requestedScopeComplete, true);
    assert.equal(response.structuredContent.completion.resultComplete, false);
    assert.ok(calls > 1);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) + 1024 <= 8000);
});
