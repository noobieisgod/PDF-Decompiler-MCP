import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/config/runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';
import { buildSyntheticPdf } from '../test/fixtures/generate-fixtures.mjs';

async function directoryBytes(root) {
    let bytes = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
        const target = path.join(root, entry.name);
        bytes += entry.isDirectory() ? await directoryBytes(target) : (await fs.stat(target)).size;
    }
    return bytes;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-benchmark-'));
const source = path.join(root, 'benchmark.pdf');
await fs.writeFile(source, buildSyntheticPdf({ pages: ['Alpha benchmark evidence', 'Revenue benchmark evidence', 'Citation benchmark evidence'] }));
const config = loadConfig({ cacheMode: 'persistent', allowRoots: [root], cacheDirectory: path.join(root, 'cache'), extractionTimeoutMs: 50_000 });
const manager = await new DocumentManager(config).init();
try {
    const coldStart = performance.now();
    const cold = await manager.open({ source });
    const coldMs = performance.now() - coldStart;
    await manager.closeDocument(cold);
    const warmStart = performance.now();
    const warm = await manager.open({ source });
    const warmMs = performance.now() - warmStart;
    const searchStart = performance.now();
    const search = await manager.search({ ...warm, query: 'Revenue evidence' });
    const searchMs = performance.now() - searchStart;
    const output = {
        schemaVersion: 1,
        configuration: { node: process.version, platform: process.platform, arch: process.arch, cacheMode: 'persistent', semantic: false, repetitions: 1 },
        measurements: {
            coldOpenMs: coldMs,
            warmOpenMs: warmMs,
            searchMs,
            rssBytes: process.memoryUsage().rss,
            cacheBytes: await directoryBytes(manager.cache.root),
            searchResponseBytes: Buffer.byteLength(JSON.stringify(search)),
        },
        quality: {
            expectedTopPage: 2,
            actualTopPage: search.results[0]?.page || null,
            citationCorrect: search.results[0]?.citation?.documentId === warm.documentId,
            extractionComplete: warm.complete,
        },
        claims: 'No comparative performance claim is made by this output.',
    };
    console.log(JSON.stringify(output, null, 2));
} finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
}
