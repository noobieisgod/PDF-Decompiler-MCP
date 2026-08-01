#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/runtime.mjs';
import { DocumentManager } from './runtime/document-manager.mjs';
import { createServer } from './server/create-server.mjs';

export function parseArgs(args) {
    const overrides = {};
    const listOptions = new Map([['--allow-root', 'allowRoots'], ['--deny-root', 'denyRoots']]);
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (listOptions.has(option)) {
            const key = listOptions.get(option);
            overrides[key] ||= [];
            while (args[index + 1] && !args[index + 1].startsWith('--')) overrides[key].push(args[++index]);
            if (!overrides[key].length) throw new Error(`${option} requires at least one directory`);
        } else if (option === '--cache-mode') {
            overrides.cacheMode = args[++index];
        } else if (option === '--cache-directory') {
            overrides.cacheDirectory = args[++index];
        } else if (option === '--unrestricted-local-access') {
            overrides.unrestrictedLocalAccess = true;
        } else if (option === '--allow-unc') {
            overrides.allowUnc = true;
        } else if (option === '--debug') {
            overrides.debug = true;
        } else {
            throw new Error(`Unknown command-line option: ${option}`);
        }
    }
    return overrides;
}

export async function main(overrides = parseArgs(process.argv.slice(2))) {
    const config = loadConfig(overrides);
    const manager = await new DocumentManager(config).init();
    const handle = serveStdio(() => createServer(manager), {
        legacy: 'serve',
        onerror: error => console.error(`[pdf-decompiler-mcp] ${config.debug ? error.stack : error.message}`),
    });
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        await handle.close().catch(() => {});
        await manager.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.once('beforeExit', close);
    return { handle, manager, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(`[pdf-decompiler-mcp] ${error.message}`);
        process.exitCode = 1;
    });
}
