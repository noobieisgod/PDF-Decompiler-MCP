import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/runtime.mjs';

export async function temporaryConfig(t, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-test-'));
    t?.after?.(() => fs.rm(root, { recursive: true, force: true }));
    return {
        root,
        config: loadConfig({
            cacheMode: 'none',
            allowRoots: [root],
            cacheDirectory: path.join(root, 'cache'),
            extractionTimeoutMs: 50_000,
            ...overrides,
        }),
    };
}

export function rawDocument(pageCount = 2) {
    return {
        totalPages: pageCount,
        requestedPages: pageCount,
        metadata: { title: 'Synthetic Alpha' },
        outline: [{ title: 'Revenue Overview', page: 1 }],
        partial: null,
        pages: Array.from({ length: pageCount }, (_, index) => ({
            page: index + 1,
            extractionMode: 'native',
            routingMode: 'native_text',
            contentClass: 'dense_text',
            text: `Alpha page ${index + 1} revenue deterministic evidence`,
            images: [],
            tables: index === 0 ? [{ data: [['Quarter', 'Revenue'], ['Q1', '100']], bbox: [0, 0, 20, 20] }] : [],
            links: [],
            annotations: [],
            pageImage: null,
            pageProfile: { viewportWidth: 612, viewportHeight: 792, rotation: 0 },
        })),
    };
}
