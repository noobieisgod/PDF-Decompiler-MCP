import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import pkg from '../../package.json' with { type: 'json' };
import { timingComplete, timingContext, timingMark, timingSnapshot } from '../runtime/timing.mjs';
import { PdfDecompilerError, publicError } from '../core/errors.mjs';
import { estimatedTextTokens, resolveBudget } from '../runtime/budget.mjs';
import {
    CloseSchema,
    DocumentInfoSchema,
    GetElementSchema,
    GetPagesSchema,
    OpenSchema,
    RenderPageSchema,
    SearchSchema,
    OutputSchemas,
} from './schemas.mjs';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const BUDGETED_OPERATIONS = new Set(['pdf_search', 'pdf_get_pages', 'pdf_get_element', 'pdf_render_page']);
const REDUCIBLE_OPERATIONS = new Set(['pdf_search', 'pdf_get_pages', 'pdf_get_element']);
const PROTOCOL_WRAPPER_RESERVE_BYTES = 1024;
const PROTOCOL_WRAPPER_RESERVE_TOKENS = estimatedTextTokens(' '.repeat(PROTOCOL_WRAPPER_RESERVE_BYTES));

function envelope(operation, args, data) {
    const {
        citations = data?.citation ? [data.citation] : [],
        warnings = [],
        diagnostics = null,
        omissions = [],
        budget = null,
        nextCursor = null,
        completion = { documentComplete: true, requestedScopeComplete: true, resultComplete: nextCursor === null },
        citation: _citation,
        ...payload
    } = data || {};
    return {
        schemaVersion: '3.0.0',
        operation,
        documentId: data?.documentId || args?.documentId || null,
        extractionFingerprint: data?.extractionFingerprint || args?.extractionFingerprint || null,
        data: payload,
        citations,
        warnings,
        diagnostics,
        omissions,
        budget,
        nextCursor,
        completion,
    };
}

function compactText(value) {
    const data = value.data || {};
    if (data.error) return JSON.stringify({ operation: value.operation, error: data.error, completion: value.completion });
    if (data.outputFormat === 'markdown') {
        return JSON.stringify({
            schemaVersion: value.schemaVersion,
            operation: value.operation,
            documentId: value.documentId,
            extractionFingerprint: value.extractionFingerprint,
            outputFormat: 'markdown',
            pages: data.pages,
            markdownBytes: Buffer.byteLength(data.markdown),
            resourceUris: data.resourceUris,
            completion: value.completion,
            nextCursor: value.nextCursor,
            instruction: value.nextCursor ? 'Call pdf_get_pages again with the document reference and nextCursor; selectors may be omitted.' : 'Markdown retrieval is complete.',
        }).slice(0, 2048);
    }
    const summary = {
        schemaVersion: value.schemaVersion,
        operation: value.operation,
        documentId: value.documentId,
        extractionFingerprint: value.extractionFingerprint,
        pages: data.pages || undefined,
        elementCount: data.elements?.length,
        resultCount: data.results?.length,
        elementId: data.element?.id,
        resourceUri: data.uri,
        sourceId: data.sourceId,
        warningCount: value.warnings.length,
        omissionCount: value.omissions.length,
        nextCursor: value.nextCursor,
        completion: value.completion,
        instruction: value.nextCursor ? value.operation === 'pdf_get_pages'
            ? 'Call pdf_get_pages again with the document reference and nextCursor; selectors may be omitted.'
            : value.operation === 'pdf_open'
                ? 'Call pdf_open again with the returned document reference, sourceId, and nextCursor to continue extraction.'
                : `Call ${value.operation} again with nextCursor and unchanged arguments.` : undefined,
    };
    return JSON.stringify(summary).slice(0, 2048);
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

function stabilizeResult(value, buildResult) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = buildResult();
        const serialized = JSON.stringify(result);
        const measurement = {
            responseBytes: Buffer.byteLength(serialized) + PROTOCOL_WRAPPER_RESERVE_BYTES,
            estimatedTokens: estimatedTextTokens(serialized) + PROTOCOL_WRAPPER_RESERVE_TOKENS,
        };
        if (!value.budget?.usage) return { result, measurement };
        if (value.budget.usage.responseBytes === measurement.responseBytes && value.budget.usage.estimatedTokens === measurement.estimatedTokens) return { result, measurement };
        value.budget.usage.responseBytes = measurement.responseBytes;
        value.budget.usage.estimatedTokens = measurement.estimatedTokens;
    }
    throw new PdfDecompilerError('response_budget_exceeded', 'The complete MCP response budget accounting did not stabilize. Reduce the requested scope.');
}

function toolHandler(operation, managerCall, { assetResult = false } = {}) {
    return async args => timingContext(operation, async () => {
        timingMark('request_receipt');
        try {
            const requestedBudget = BUDGETED_OPERATIONS.has(operation) ? resolveBudget(args.budget) : null;
            const requestedBytes = requestedBudget?.responseBytes ?? 1_000_000;
            const requestedTokens = requestedBudget?.estimatedTokens ?? Infinity;
            let wireResponseBytes = requestedBytes;
            let wireEstimatedTokens = requestedTokens;
            let delivery = args.imageDelivery;
            for (let attempt = 0; attempt < 8; attempt += 1) {
                const callArgs = REDUCIBLE_OPERATIONS.has(operation) ? { ...args, _wireResponseBytes: wireResponseBytes, _wireEstimatedTokens: wireEstimatedTokens } : args;
                const raw = await managerCall(callArgs);
                timingMark('manager_operation');
                const data = assetResult ? publicAsset(raw) : raw;
                const value = envelope(operation, args, data);
                if (timingSnapshot()) value.diagnostics = { ...(value.diagnostics || {}), ...timingSnapshot() };
                if (assetResult && delivery === 'inline' && Buffer.byteLength(raw.data || '', 'base64') > requestedBytes) delivery = 'resource';
                if (assetResult && args.imageDelivery === 'inline' && delivery !== 'inline') {
                    value.warnings.push({ code: 'inline_image_omitted', message: 'The image exceeded the response budget and was returned as a resource link.' });
                }
                const { result, measurement } = stabilizeResult(value, () => ({
                    content: resultContent(value, assetResult ? raw : null, delivery, requestedBytes),
                    structuredContent: value,
                }));
                if (measurement.responseBytes <= requestedBytes && measurement.estimatedTokens <= requestedTokens) {
                    timingMark('response_serialization');
                    timingComplete();
                    return result;
                }
                if (assetResult && delivery === 'inline') {
                    delivery = 'resource';
                    continue;
                }
                if (!REDUCIBLE_OPERATIONS.has(operation)) throw new PdfDecompilerError('response_budget_exceeded', 'The complete MCP response exceeded the hard response budget. Reduce the requested scope or continue with a cursor.');
                wireResponseBytes = Math.floor(wireResponseBytes * 0.7);
                wireEstimatedTokens = Math.floor(wireEstimatedTokens * 0.7);
            }
            throw new PdfDecompilerError('response_budget_exceeded', 'The complete MCP response exceeded the hard response budget after deterministic fragment reduction. Reduce the requested scope or continue with a cursor.');
        } catch (error) {
            const failure = publicError(error);
            const value = envelope(operation, args, {
                error: failure,
                completion: { documentComplete: false, requestedScopeComplete: false, resultComplete: true },
            });
            const result = { content: [{ type: 'text', text: compactText(value) }], structuredContent: value, isError: true };
            timingMark('response_serialization');
            timingComplete();
            return result;
        }
    });
}

export function createServer(manager) {
    const server = new McpServer({
        name: 'pdf-decompiler-mcp',
        title: 'PDF Decompiler MCP',
        version: pkg.version,
    }, {
        instructions: 'Open the PDF, then start textual work with pdf_search or pdf_get_pages using mode text. Text mode excludes figures and minimizes context use. Escalate only relevant pages to balanced, fidelity, or pdf_render_page when text, omissions, or document information indicates that visual evidence is needed. Close every sourceId when finished.',
    });

    server.registerTool('pdf_open', {
        title: 'Open and decompose PDF',
        description: 'Open an allowed local or HTTPS PDF, decompose it under hard bounds, and return its exact extraction generation. Continue partial work with the returned cursor.',
        inputSchema: OpenSchema,
        outputSchema: OutputSchemas.pdf_open,
        annotations: READ_ONLY,
    }, toolHandler('pdf_open', args => manager.open(args)));

    server.registerTool('pdf_document_info', {
        title: 'Get PDF document information',
        description: 'Return metadata, decomposition counts, cache status, warnings, and generation-bound resource lifetime.',
        inputSchema: DocumentInfoSchema,
        outputSchema: OutputSchemas.pdf_document_info,
        annotations: READ_ONLY,
    }, toolHandler('pdf_document_info', args => manager.documentInfo(args)));

    server.registerTool('pdf_search', {
        title: 'Search decomposed PDF',
        description: 'Search extracted elements with offline BM25, optional semantic retrieval, or reciprocal-rank fused hybrid retrieval.',
        inputSchema: SearchSchema,
        outputSchema: OutputSchemas.pdf_search,
        annotations: READ_ONLY,
    }, toolHandler('pdf_search', args => manager.search(args)));

    server.registerTool('pdf_get_pages', {
        title: 'Get PDF page elements',
        description: 'Return deterministic cited elements for selected pages under explicit response budgets and signed cursors. Start textual questions with mode text, which excludes figures. The default balanced mode adds captioned figure references without inline image bytes. Escalate only relevant pages to fidelity or pdf_render_page when visual evidence is needed.',
        inputSchema: GetPagesSchema,
        outputSchema: OutputSchemas.pdf_get_pages,
        annotations: READ_ONLY,
    }, toolHandler('pdf_get_pages', args => manager.getPages(args)));

    server.registerTool('pdf_get_element', {
        title: 'Get PDF element',
        description: 'Resolve one element only within the supplied immutable extraction generation. Stale references are rejected.',
        inputSchema: GetElementSchema,
        outputSchema: OutputSchemas.pdf_get_element,
        annotations: READ_ONLY,
    }, toolHandler('pdf_get_element', args => manager.getElement(args)));

    server.registerTool('pdf_render_page', {
        title: 'Render PDF page',
        description: 'Render a bounded page or crop only when text retrieval identifies a need for visual evidence. Auto uses a resource because MCP does not negotiate a generic inline-image capability. Inline data is returned only when explicitly requested.',
        inputSchema: RenderPageSchema,
        outputSchema: OutputSchemas.pdf_render_page,
        annotations: READ_ONLY,
    }, toolHandler('pdf_render_page', args => manager.renderPage(args), { assetResult: true }));

    server.registerTool('pdf_close', {
        title: 'Close PDF document',
        description: 'Release the caller reference. Process-local data is deleted when the final reference closes; persistent cache deletion is explicit.',
        inputSchema: CloseSchema,
        outputSchema: OutputSchemas.pdf_close,
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

    server.registerResource('pdf-decompiler-markdown-resource',
        new ResourceTemplate('pdf-decompiler://document/{documentId}/{extractionFingerprint}/markdown/{markdownFormatVersion}/{serializerFingerprint}/full.md', { list: undefined }),
        {
            title: 'PDF Decompiler complete Markdown export',
            description: 'Read-only complete Markdown bound to one extraction generation and serializer fingerprint.',
            mimeType: 'text/markdown',
        },
        async uri => ({ contents: [{ uri: uri.toString(), ...(await manager.readResource(uri.toString())) }] }));

    return server;
}
