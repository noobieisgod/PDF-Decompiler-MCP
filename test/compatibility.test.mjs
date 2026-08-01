import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server/create-server.mjs';

test('automated SDK client compatibility covers discovery, schemas, structured output, errors, and shutdown', async () => {
    const doc = `doc_${'d'.repeat(64)}`;
    const generation = 'e'.repeat(64);
    const manager = new Proxy({}, { get: () => async args => ({ documentId: args.documentId || doc, extractionFingerprint: args.extractionFingerprint || generation }) });
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
