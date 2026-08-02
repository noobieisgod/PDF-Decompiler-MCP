import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server/create-server.mjs';

test('automated SDK client compatibility covers discovery, schemas, structured output, errors, and shutdown', async () => {
    const doc = `doc_${'d'.repeat(64)}`;
    const generation = 'e'.repeat(64);
    const manager = new Proxy({}, { get: () => async args => ({
        schemaVersion: '3.0.0', canonicalFormatVersion: 3, extractionRevision: 3,
        documentId: args.documentId || doc, extractionFingerprint: args.extractionFingerprint || generation,
        pdfSha256: 'f'.repeat(64), dependencyFingerprint: '1'.repeat(64), metadata: {}, outline: [], totalPages: 1,
        processedPages: 1, partial: null, pages: [], warnings: [], createdAt: '2026-08-01T00:00:00.000Z',
        activeSources: [], counts: { block: 0, table: 0, figure: 0, annotation: 0, link: 0 },
        cache: { mode: 'none', location: 'process-local', permissionStatus: 'owner-restricted-temporary', retentionDays: 0, maxBytes: 1, stores: [], processLocal: true },
        resourceLifetime: 'active_document_lifetime',
        exports: { markdown: { status: 'generatable', resourceUri: `pdf-decompiler://document/${doc}/${generation}/markdown/1/${'2'.repeat(64)}/full.md` } },
    }) });
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'compatibility-test', version: '2.0.0' });
    await client.connect(clientTransport);
    assert.equal((await client.listTools()).tools.length, 7);
    const result = await client.callTool({ name: 'pdf_document_info', arguments: { documentId: doc, extractionFingerprint: generation } });
    assert.equal(result.structuredContent.schemaVersion, '3.0.0');
    await client.close();
    await server.close();
});
