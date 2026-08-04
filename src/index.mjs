#!/usr/bin/env node
import fs from 'node:fs/promises';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from './config/runtime.mjs';
import { detectTesseract } from './extract/ocr.mjs';
import { DocumentManager } from './runtime/document-manager.mjs';
import { createServer } from './server/create-server.mjs';
import { TimedTransport } from './runtime/timing.mjs';

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
        transport: new TimedTransport(new StdioServerTransport()),
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

export async function runDoctor(overrides = {}) {
    const config = loadConfig(overrides);
    const checks = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'node', status: [22, 24].includes(major) ? 'pass' : 'fail', detail: `Node.js ${process.versions.node}; supported majors are 22 and 24` });
    for (const [kind, roots] of [['allow root', config.allowRoots], ['deny root', config.denyRoots]]) {
        for (const root of roots) {
            try {
                const stat = await fs.stat(await fs.realpath(root));
                checks.push({ name: kind, status: stat.isDirectory() ? 'pass' : 'fail', detail: `${root} ${stat.isDirectory() ? 'is accessible' : 'is not a directory'}` });
            } catch {
                checks.push({ name: kind, status: 'fail', detail: `${root} is not an accessible directory` });
            }
        }
    }
    if (!config.allowRoots.length && !config.unrestrictedLocalAccess) {
        checks.push({ name: 'local access', status: 'warn', detail: 'No allow root is configured, so local PDF access is denied' });
    } else {
        checks.push({ name: 'local access', status: 'pass', detail: config.unrestrictedLocalAccess ? 'Unrestricted local access is enabled explicitly' : `${config.allowRoots.length} allow root(s) configured` });
    }
    let manager;
    try {
        manager = await new DocumentManager(config).init();
        checks.push({ name: 'startup', status: 'pass', detail: `Server state and ${config.cache.mode} cache initialized` });
    } catch {
        checks.push({ name: 'startup', status: 'fail', detail: 'Server state or cache initialization failed' });
    } finally {
        await manager?.close().catch(() => {});
    }
    checks.push({ name: 'ocr', status: detectTesseract() ? 'pass' : 'warn', detail: detectTesseract() ? 'Tesseract is available' : 'Tesseract is not available; native PDF text still works' });
    return { name: pkg.name, version: pkg.version, ready: !checks.some(check => check.status === 'fail'), checks };
}

function printDoctor(report) {
    console.log(`PDF Decompiler MCP ${report.version} doctor`);
    for (const check of report.checks) console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
    console.log(report.ready ? 'READY' : 'NOT READY');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const command = args[0] === 'doctor' ? runDoctor(parseArgs(args.slice(1))).then(report => {
        printDoctor(report);
        if (!report.ready) process.exitCode = 1;
    }) : main(parseArgs(args));
    command.catch(error => {
        console.error(`[pdf-decompiler-mcp] ${error.message}`);
        process.exitCode = 1;
    });
}
