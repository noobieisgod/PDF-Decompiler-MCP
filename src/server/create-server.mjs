import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import pkg from '../../package.json' with { type: 'json' };
import { publicError } from '../core/errors.mjs';
import {
    CloseSchema,
    DocumentInfoSchema,
    EnvelopeSchema,
    GetElementSchema,
    GetPagesSchema,
    OpenSchema,
    RenderPageSchema,
    SearchSchema,
} from './schemas.mjs';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function envelope(operation, args, data) {
    return {
        schemaVersion: '3.0.0',
        operation,
        documentId: data?.documentId || args?.documentId || null,
        extractionFingerprint: data?.extractionFingerprint || args?.extractionFingerprint || null,
        data,
        citations: data?.citations || data?.citation ? (data.citations || [data.citation]) : [],
        warnings: data?.warnings || [],
        diagnostics: data?.diagnostics || null,
        omissions: data?.omissions || [],
        budget: data?.budget || null,
        nextCursor: data?.nextCursor || null,
    };
}

function compactText(value) {
    const data = value.data || {};
    return JSON.stringify({
        schemaVersion: value.schemaVersion,
        operation: value.operation,
        documentId: value.documentId,
        extractionFingerprint: value.extractionFingerprint,
        data,
        warnings: value.warnings,
        omissions: value.omissions,
        nextCursor: value.nextCursor,
    });
}

function resultContent(value, asset = null, delivery = 'auto', responseBytes = 1_000_000) {
    const content = [{ type: 'text', text: compactText(value) }];
    if (!asset) return content;
    if (delivery === 'inline' && asset.data && Buffer.byteLength(asset.data, 'base64') <= responseBytes) {
        content.push({ type: 'image', data: asset.data, mimeType: asset.mimeType });
    } else {
        content.push({
            type: 'resource_link',
            uri: asset.uri,
            name: asset.id,
            description: 'Immutable extraction-generation-bound PDF asset.',
            mimeType: asset.mimeType,
        });
    }
    return content;
}

function publicAsset(asset) {
    const { data, ...metadata } = asset;
    return metadata;
}

function toolHandler(operation, managerCall, { assetResult = false } = {}) {
    return async args => {
        try {
            const raw = await managerCall(args);
            const data = assetResult ? publicAsset(raw) : raw;
            const value = envelope(operation, args, data);
            const requestedBytes = Math.min(args.budget?.responseBytes || 1_000_000, 4_000_000);
            if (assetResult && args.imageDelivery === 'inline' && Buffer.byteLength(raw.data || '', 'base64') > requestedBytes) {
                value.warnings.push({ code: 'inline_image_omitted', message: 'The image exceeded the response-byte budget and was returned as a resource link.' });
            }
            return {
                content: resultContent(value, assetResult ? raw : null, args.imageDelivery, requestedBytes),
                structuredContent: value,
            };
        } catch (error) {
            const failure = publicError(error);
            const value = envelope(operation, args, { error: failure });
            return { content: [{ type: 'text', text: compactText(value) }], structuredContent: value, isError: true };
        }
    };
}

export function createServer(manager) {
    const server = new McpServer({
        name: 'pdf-decompiler-mcp',
        title: 'PDF Decompiler MCP',
        version: pkg.version,
    });

    server.registerTool('pdf_open', {
        title: 'Open and decompose PDF',
        description: 'Open an allowed local or HTTPS PDF, decompose it under hard bounds, and return its exact extraction generation. Continue partial work with the returned cursor.',
        inputSchema: OpenSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_open', args => manager.open(args)));

    server.registerTool('pdf_document_info', {
        title: 'Get PDF document information',
        description: 'Return metadata, decomposition counts, cache status, warnings, and generation-bound resource lifetime.',
        inputSchema: DocumentInfoSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_document_info', args => manager.documentInfo(args)));

    server.registerTool('pdf_search', {
        title: 'Search decomposed PDF',
        description: 'Search extracted elements with offline BM25, optional semantic retrieval, or reciprocal-rank fused hybrid retrieval.',
        inputSchema: SearchSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_search', args => manager.search(args)));

    server.registerTool('pdf_get_pages', {
        title: 'Get PDF page elements',
        description: 'Return deterministic cited elements for selected pages under explicit response budgets and signed cursors.',
        inputSchema: GetPagesSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_get_pages', args => manager.getPages(args)));

    server.registerTool('pdf_get_element', {
        title: 'Get PDF element',
        description: 'Resolve one element only within the supplied immutable extraction generation. Stale references are rejected.',
        inputSchema: GetElementSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_get_element', args => manager.getElement(args)));

    server.registerTool('pdf_render_page', {
        title: 'Render PDF page',
        description: 'Render a bounded page or crop. Auto uses a resource because MCP does not negotiate a generic inline-image capability. Inline data is returned only when explicitly requested.',
        inputSchema: RenderPageSchema,
        outputSchema: EnvelopeSchema,
        annotations: READ_ONLY,
    }, toolHandler('pdf_render_page', args => manager.renderPage(args), { assetResult: true }));

    server.registerTool('pdf_close', {
        title: 'Close PDF document',
        description: 'Release the caller reference. Process-local data is deleted when the final reference closes; persistent cache deletion is explicit.',
        inputSchema: CloseSchema,
        outputSchema: EnvelopeSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, toolHandler('pdf_close', args => manager.closeDocument(args)));

    server.registerResource('pdf-decompiler-generation-resource',
        new ResourceTemplate('pdf-decompiler://document/{documentId}/{extractionFingerprint}/{kind}/{id}', { list: undefined }),
        {
            title: 'PDF Decompiler immutable resource',
            description: 'Read-only canonical data or an asset bound to one exact extraction generation.',
            mimeType: 'application/octet-stream',
        },
        async uri => ({ contents: [{ uri: uri.toString(), ...(await manager.readResource(uri.toString())) }] }));

    return server;
}
