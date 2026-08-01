import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { loadConfig } from '../src/config/runtime.mjs';
import { fetchRemotePdf, resolveLocalPdf, validatePdfBytes } from '../src/security/source.mjs';
import { temporaryConfig } from './helpers.mjs';

async function pdfFile(target) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '%PDF-1.7\n');
}

test('local paths use canonical real paths, deny precedence, and traversal containment', async t => {
    const { root, config } = await temporaryConfig(t);
    const allowed = path.join(root, 'allowed');
    const denied = path.join(allowed, 'denied');
    const outside = path.join(root, 'outside.pdf');
    await pdfFile(path.join(allowed, 'inside.pdf'));
    await pdfFile(path.join(denied, 'secret.pdf'));
    await pdfFile(outside);
    const policy = { ...config, allowRoots: [allowed], denyRoots: [denied] };
    assert.equal((await resolveLocalPdf(path.join(allowed, '.', 'inside.pdf'), policy)).path, await fs.realpath(path.join(allowed, 'inside.pdf')));
    await assert.rejects(resolveLocalPdf(path.join(allowed, '..', 'outside.pdf'), policy), { code: 'path_denied' });
    await assert.rejects(resolveLocalPdf(path.join(denied, 'secret.pdf'), policy), { code: 'path_denied' });
});

test('symlink or junction escape is rejected where the platform permits creating it', async t => {
    const { root, config } = await temporaryConfig(t);
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    await pdfFile(path.join(outside, 'secret.pdf'));
    await fs.mkdir(allowed);
    const link = path.join(allowed, 'escape');
    try {
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`link creation unavailable: ${error.code}`);
        return;
    }
    await assert.rejects(resolveLocalPdf(path.join(link, 'secret.pdf'), { ...config, allowRoots: [allowed] }), { code: 'path_denied' });
});

test('Windows path policy rejects UNC, device names, and alternate streams', { skip: process.platform !== 'win32' }, async t => {
    const { config } = await temporaryConfig(t);
    await assert.rejects(resolveLocalPdf('\\\\server\\share\\file.pdf', config), { code: 'path_denied' });
    await assert.rejects(resolveLocalPdf('NUL.pdf', { ...config, unrestrictedLocalAccess: true }), { code: 'path_denied' });
    await assert.rejects(resolveLocalPdf('C:\\safe\\file.pdf:stream', { ...config, unrestrictedLocalAccess: true }), { code: 'path_denied' });
});

test('remote loading blocks special networks before a connection and binds requests to approved DNS records', async t => {
    const { config } = await temporaryConfig(t);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fc00::1', 'fec0::1', 'fe80::1']) {
        await assert.rejects(fetchRemotePdf(`https://[${address}]/file.pdf`.replace('[127.0.0.1]', '127.0.0.1').replace('[10.0.0.1]', '10.0.0.1').replace('[169.254.1.1]', '169.254.1.1'), config, {
            request: () => { throw new Error('must not connect'); },
        }), { code: 'url_denied' });
    }
    let pinned;
    const response = Readable.from([Buffer.from('%PDF-1.7\n')]);
    response.statusCode = 200;
    response.headers = {};
    await fetchRemotePdf('https://example.test/file.pdf', config, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async (_url, records) => { pinned = records; return response; },
    });
    assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
});

test('invalid numeric limits fail configuration before server startup', () => {
    assert.throws(() => loadConfig({ maxPages: 0 }), /maxPages/);
    assert.throws(() => loadConfig({ maxDocumentBytes: Number.NaN }), /maxDocumentBytes/);
    assert.throws(() => loadConfig({ cacheMaxBytes: Number.POSITIVE_INFINITY }), /cache.maxBytes/);
    assert.equal(loadConfig({ cacheRetentionDays: 0 }).cache.retentionDays, 0);
});

test('every redirect is revalidated and private redirect targets are rejected', async t => {
    const { config } = await temporaryConfig(t);
    const redirect = Readable.from([]);
    redirect.statusCode = 302;
    redirect.headers = { location: 'https://127.0.0.1/secret.pdf' };
    redirect.resume = () => {};
    let requests = 0;
    await assert.rejects(fetchRemotePdf('https://public.test/file.pdf', config, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async () => { requests += 1; return redirect; },
    }), { code: 'url_denied' });
    assert.equal(requests, 1);
});

test('signature and document-size limits are hard pre-parse checks with sanitized error data', async t => {
    const { config } = await temporaryConfig(t, { maxDocumentBytes: 8 });
    assert.throws(() => validatePdfBytes(Buffer.from('not-pdf'), config), { code: 'PDF_INVALID_SIGNATURE' });
    assert.throws(() => validatePdfBytes(Buffer.from('%PDF-12345'), config), { code: 'document_too_large' });
});
