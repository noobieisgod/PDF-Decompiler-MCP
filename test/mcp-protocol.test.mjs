import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client';
import { createServer } from '../src/server/create-server.mjs';

test('official SDK v2 negotiates the immutable resource and structured-content surface', async t => {
    const doc = `doc_${'a'.repeat(64)}`;
    const generation = 'b'.repeat(64);
    const manager = new Proxy({}, { get: (_target, property) => property === 'readResource'
        ? async () => ({ mimeType: 'text/plain', text: 'resource' })
        : async args => ({ documentId: args.documentId || doc, extractionFingerprint: args.extractionFingerprint || generation, protocol: LATEST_PROTOCOL_VERSION }) });
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'protocol-test', version: '1.0.0' });
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });
    assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 1);
    const result = await client.callTool({ name: 'pdf_document_info', arguments: { documentId: doc, extractionFingerprint: generation } });
    assert.equal(result.structuredContent.schemaVersion, '3.0.0');
    assert.equal(result.structuredContent.data.protocol, LATEST_PROTOCOL_VERSION);
});
