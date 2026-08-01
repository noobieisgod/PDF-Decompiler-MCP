import { loadConfig } from '../src/config/runtime.mjs';
import { DocumentManager } from '../src/runtime/document-manager.mjs';

const source = process.argv[2];
if (!source) {
    console.error('Usage: node scripts/verify-extract.mjs <pdf-path-or-https-url>');
    process.exitCode = 1;
} else {
    const manager = await new DocumentManager(loadConfig({
        allowRoots: [process.cwd()],
        cacheMode: 'none',
    })).init();
    try {
        const opened = await manager.open({ source });
        const info = await manager.documentInfo(opened);
        const pages = await manager.getPages(opened);
        console.log(JSON.stringify({ opened, counts: info.counts, returnedElements: pages.elements.length, omissions: pages.omissions }, null, 2));
    } finally {
        await manager.close();
    }
}
