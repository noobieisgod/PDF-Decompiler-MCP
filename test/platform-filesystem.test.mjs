import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CacheManager } from '../src/cache/cache-manager.mjs';
import { resolveLocalPdf } from '../src/security/source.mjs';
import { runExtractionSubprocess } from '../src/runtime/subprocess.mjs';
import { temporaryConfig } from './helpers.mjs';

test('Windows drive casing and alternate separators resolve to the same allowed file', { skip: process.platform !== 'win32' }, async t => {
    const { root, config } = await temporaryConfig(t);
    const source = path.join(root, 'case.pdf');
    await fs.writeFile(source, '%PDF-1.7\n');
    const driveCase = `${source[0] === source[0].toUpperCase() ? source[0].toLowerCase() : source[0].toUpperCase()}${source.slice(1)}`;
    assert.equal((await resolveLocalPdf(driveCase.replaceAll('\\', '/'), config)).path.toLowerCase(), (await fs.realpath(source)).toLowerCase());
});

test('permission-denied roots fail without widening access', { skip: process.platform === 'win32' }, async t => {
    const { root, config } = await temporaryConfig(t, { cacheMode: 'persistent' });
    const denied = path.join(root, 'permission-denied');
    await fs.mkdir(denied, { mode: 0o700 });
    await fs.chmod(denied, 0o500);
    t.after(() => fs.chmod(denied, 0o700));
    const cache = new CacheManager({ ...config, cache: { ...config.cache, directory: denied } });
    await assert.rejects(cache.init());
});

test('failed child processing removes its owner-restricted temporary directory', async t => {
    const { config } = await temporaryConfig(t, { extractionTimeoutMs: 5000 });
    const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('pdf-decompiler-extract-')));
    await assert.rejects(runExtractionSubprocess(Buffer.from('%PDF-malformed'), config), { code: 'PDF_MALFORMED_UNKNOWN' });
    const after = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('pdf-decompiler-extract-') && !before.has(name));
    assert.deepEqual(after, []);
});
