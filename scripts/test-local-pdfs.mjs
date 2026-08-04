import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { detectTesseract } from '../src/extract/ocr.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server/create-server.mjs';

function validateMediumOneOcr(state) {
    const page = state.model.pages.find(item => item.number === 16);
    const ocrText = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr').map(element => element.text).join(' ');
    if (page.ocr.status === 'accepted' || page.ocr.status === 'partial') {
        if (!/human event|truths|unalienable|liberty|congress/i.test(ocrText)) throw new Error('Accepted Medium Test One page 16 OCR was not recognizable');
    } else if (ocrText) {
        throw new Error('Rejected Medium Test One page 16 OCR entered canonical text');
    }
    return page.ocr.status;
}

async function correctiveLocalPdfs(root, available) {
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'off', extractionTimeoutMs: 180_000 })).init();
    const server = createServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'local-corrective-profile', version: '1.0.0' });
    await client.connect(clientTransport);
    const handles = [];
    try {
        if (available.includes('Medium Test One.pdf') && detectTesseract()) {
            const opened = await manager.open({ source: path.join(root, 'Medium Test One.pdf'), pages: [{ start: 16, end: 16 }], ocrPolicy: 'required' });
            handles.push(opened, await manager.open({ source: path.join(root, 'Medium Test One.pdf'), pages: [{ start: 16, end: 16 }], ocrPolicy: 'required' }));
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            const page = state.model.pages.find(item => item.number === 16);
            validateMediumOneOcr(state);
            console.log(`corrective OCR: status=${page.ocr.status}; accepted=${page.ocr.acceptedRegions}; rejected=${page.ocr.rejectedRegions}`);
        }
        if (available.includes('Medium Test Two.pdf')) {
            const opened = await manager.open({ source: path.join(root, 'Medium Test Two.pdf'), pages: [{ start: 12, end: 12 }, { start: 15, end: 15 }] });
            handles.push(opened);
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            const tableCounts = Object.fromEntries([12, 15].map(page => [page, state.model.elements.filter(element => element.type === 'table' && element.page === page).length]));
            for (const page of [12, 15]) if (!tableCounts[page]) throw new Error(`Medium Test Two page ${page} did not produce a table`);
            const reference = { documentId: opened.documentId, extractionFingerprint: opened.extractionFingerprint };
            const first = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, pages: [15], mode: 'fidelity', excludeElementTypes: ['figure'], budget: { textBlocks: 5, responseBytes: 12_000, estimatedTokens: 3_000 } } });
            if (!first.structuredContent.nextCursor) throw new Error('Medium Test Two page 15 did not produce a continuation cursor');
            const next = await client.callTool({ name: 'pdf_get_pages', arguments: { ...reference, cursor: first.structuredContent.nextCursor } });
            if (next.isError || (!next.structuredContent.data.elements.length && !next.structuredContent.omissions.length)) throw new Error('Cursor-only continuation made no progress');
            console.log(`corrective Medium Test Two: page12Tables=${tableCounts[12]}; page15Tables=${tableCounts[15]}; cursor=verified`);
        }
        if (available.includes('Heavy Test One.pdf')) {
            const opened = await manager.open({ source: path.join(root, 'Heavy Test One.pdf'), pages: [{ start: 3, end: 3 }, { start: 64, end: 64 }] });
            handles.push(opened);
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            if (state.model.elements.filter(element => element.type === 'table' && element.page === 64).length !== 2) throw new Error('Heavy Test One page 64 did not produce exactly two financial tables');
            if (state.model.elements.some(element => element.type === 'table' && element.page === 3)) throw new Error('Heavy Test One page 3 TOC became a table');
            const toc = state.model.elements.filter(element => element.type === 'block' && element.page === 3);
            const position = prefix => toc.findIndex(element => element.text.startsWith(prefix));
            if (!(position('3.6') > position('3.5') && position('3.9') < position('4.1'))) throw new Error('Heavy Test One page 3 section order is incorrect');
            if (toc.filter(element => ['004', '012', '040', '068'].includes(element.text)).some(element => element.role === 'heading')) throw new Error('Heavy Test One page labels were classified as headings');
            const search = await client.callTool({ name: 'pdf_search', arguments: { documentId: opened.documentId, extractionFingerprint: opened.extractionFingerprint, query: 'Net Income', budget: { estimatedTokens: 4_000 } } });
            if (search.isError || !search.structuredContent.data.results.length || search.structuredContent.budget.usage.estimatedTokens > 4_000) throw new Error('Heavy Test One bounded search failed');
            console.log(`corrective Heavy Test One: page3Order=verified; page64Tables=2; searchTokens=${search.structuredContent.budget.usage.estimatedTokens}`);
        }
        const started = performance.now();
        await Promise.all(handles.map(handle => manager.closeDocument(handle)));
        const closeMs = performance.now() - started;
        if (closeMs > 1_000) throw new Error(`Server-side concurrent close took ${closeMs.toFixed(1)} ms`);
        console.log(`corrective concurrent close: ${closeMs.toFixed(1)} ms`);
    } finally {
        await client.close();
        await server.close();
        await manager.close();
    }

    const smoke = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'off', extractionTimeoutMs: 180_000 })).init();
    try {
        for (const [name, pages] of [['Medium Test Two.pdf', 30], ['Heavy Test One.pdf', 94]]) {
            if (!available.includes(name)) continue;
            const opened = await smoke.open({ source: path.join(root, name) });
            const state = await smoke.requireState(opened.documentId, opened.extractionFingerprint);
            if (!opened.completion.documentComplete || !opened.completion.requestedScopeComplete || !opened.completion.resultComplete || state.model.pages.length !== pages || !state.bm25) throw new Error(`${name} complete-open smoke failed`);
            await smoke.closeDocument(opened);
            console.log(`complete-open smoke: ${name}; pages=${pages}`);
        }
    } finally {
        await smoke.close();
    }
}

export async function testLocalPdfs() {
    const root = path.resolve(process.env.PDF_DECOMPILER_LOCAL_PDF_DIR || 'evaluation/pdfs');
    const names = ['Heavy Test One.pdf', 'Medium Test One.pdf', 'Medium Test Two.pdf'];
    const available = [];
    for (const name of names) if (await fs.access(path.join(root, name)).then(() => true, () => false)) available.push(name);
    if (!available.length) {
        console.log('SKIP: optional local PDFs are unavailable');
        return;
    }
    if (process.argv[2] === 'corrective') return correctiveLocalPdfs(root, available);
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'off', extractionTimeoutMs: 50_000 })).init();
    try {
        for (const name of available) {
            const startedAt = Date.now();
            const source = path.join(root, name);
            const sha256 = createHash('sha256').update(await fs.readFile(source)).digest('hex');
            const opened = await manager.open({ source });
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            if (!opened.completion.documentComplete || state.model.pages.length !== state.model.totalPages) throw new Error(`${name} did not complete every page`);
            for (const element of state.model.elements) {
                const page = state.indexes.pages.get(element.page);
                const bbox = element.bbox;
                if (bbox && (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > page.width + 0.001 || bbox.y + bbox.height > page.height + 0.001)) throw new Error(`${name} returned out-of-bounds geometry`);
            }
            const search = await manager.search({ ...opened, query: name === 'Medium Test Two.pdf' ? 'constructor' : name.startsWith('Heavy') ? 'revenue' : 'Declaration' });
            if (!search.results.length) throw new Error(`${name} produced no real-world search result`);
            const firstPages = await manager.getPages({ ...opened, pages: state.model.pages.slice(0, Math.min(3, state.model.totalPages)).map(page => page.number), outputFormat: 'markdown', mode: 'fidelity' });
            if (!firstPages.markdown || firstPages.completion.requestedScopeComplete !== true) throw new Error(`${name} did not produce bounded Markdown`);
            if (name === 'Heavy Test One.pdf') {
                const toc = state.model.elements.filter(element => element.page === 3);
                if (toc.some(element => element.type === 'table')) throw new Error(`${name} table of contents was misclassified as a table`);
                const text = toc.map(element => element.text || '').join('\n');
                for (const heading of ['Operational Highlights', 'Financial Highlights and Analysis', 'Corporate Sustainability']) if (!text.includes(heading)) throw new Error(`${name} lost a table-of-contents section`);
            }
            if (JSON.stringify(state.model).includes(root)) throw new Error(`${name} leaked its local directory`);
            await manager.closeDocument(opened);
            console.log(`validated local sample: ${name}; sha256=${sha256}; pages=${state.model.totalPages}; ms=${Date.now() - startedAt}`);
        }
        if (available.includes('Medium Test One.pdf') && detectTesseract()) {
            const opened = await manager.open({ source: path.join(root, 'Medium Test One.pdf'), pages: [{ start: 16, end: 16 }], ocrPolicy: 'required' });
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            const status = validateMediumOneOcr(state);
            await manager.closeDocument(opened);
            console.log(`validated local image OCR outcome: Medium Test One.pdf page 16; status=${status}`);
        }
    } finally {
        await manager.close();
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await testLocalPdfs();
