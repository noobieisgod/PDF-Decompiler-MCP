import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { detectTesseract } from '../src/extract/ocr.mjs';

export async function testLocalPdfs() {
    const root = path.resolve(process.env.PDF_DECOMPILER_LOCAL_PDF_DIR || 'test/fixtures/generated');
    const names = ['Heavy Test One.pdf', 'Medium Test One.pdf', 'Medium Test Two.pdf'];
    const available = [];
    for (const name of names) if (await fs.access(path.join(root, name)).then(() => true, () => false)) available.push(name);
    if (!available.length) {
        console.log('SKIP: optional local PDFs are unavailable');
        return;
    }
    const manager = await new DocumentManager(loadConfig({ cacheMode: 'none', allowRoots: [root], ocrPolicy: 'off', extractionTimeoutMs: 50_000 })).init();
    try {
        for (const name of available) {
            const startedAt = Date.now();
            const opened = await manager.open({ source: path.join(root, name) });
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
            console.log(`validated local sample: ${name}; pages=${state.model.totalPages}; ms=${Date.now() - startedAt}`);
        }
        if (available.includes('Medium Test One.pdf') && detectTesseract()) {
            const opened = await manager.open({ source: path.join(root, 'Medium Test One.pdf'), pages: [{ start: 16, end: 16 }], ocrPolicy: 'required' });
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            const ocrText = state.model.elements.filter(element => element.type === 'block' && element.textSource === 'ocr').map(element => element.text).join(' ');
            if (!/human event|truths|unalienable|liberty/i.test(ocrText)) throw new Error('Medium Test One page 16 image OCR did not recover Declaration text');
            await manager.closeDocument(opened);
            console.log('validated local image OCR: Medium Test One.pdf page 16');
        }
    } finally {
        await manager.close();
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await testLocalPdfs();
