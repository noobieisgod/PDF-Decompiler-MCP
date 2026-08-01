import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';

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
            const opened = await manager.open({ source: path.join(root, name), pages: [{ start: 1, end: Math.min(name.startsWith('Heavy') ? 3 : 5, 5) }] });
            const state = await manager.requireState(opened.documentId, opened.extractionFingerprint);
            for (const element of state.model.elements) {
                const page = state.indexes.pages.get(element.page);
                const bbox = element.bbox;
                if (bbox && (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > page.width + 0.001 || bbox.y + bbox.height > page.height + 0.001)) throw new Error(`${name} returned out-of-bounds geometry`);
            }
            if (JSON.stringify(state.model).includes(root)) throw new Error(`${name} leaked its local directory`);
            await manager.closeDocument(opened);
            console.log(`validated local sample: ${name}`);
        }
    } finally {
        await manager.close();
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await testLocalPdfs();
