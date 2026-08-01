import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { PdfDecompilerError } from '../core/errors.mjs';
import { parserErrorPayload } from '../runtime/parser-errors.mjs';

const WINDOWS_DEVICE = /^(?:\\\\[.?]\\|\\\\\?\\GLOBALROOT|(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$))/i;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const POSIX_SPECIAL_ROOTS = ['/dev', '/proc', '/sys'];

function normalizeCompare(value) {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inside(root, candidate) {
    const rel = path.relative(normalizeCompare(root), normalizeCompare(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function canonicalRoot(root) {
    return fs.realpath(path.resolve(root));
}

export async function resolveLocalPdf(source, config) {
    if (source.includes('\0')) throw new PdfDecompilerError('path_denied', 'The local path is invalid.');
    if (process.platform === 'win32' && WINDOWS_DEVICE.test(source)) {
        throw new PdfDecompilerError('path_denied', 'Device and special paths are not allowed.');
    }
    if (process.platform === 'win32') {
        const components = source.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean);
        if (components.some(component => WINDOWS_RESERVED_COMPONENT.test(component)) || source.slice(2).includes(':')) {
            throw new PdfDecompilerError('path_denied', 'Reserved names and alternate data streams are not allowed.');
        }
    }
    const isUnc = process.platform === 'win32' && /^\\\\/.test(source);
    if (isUnc && !config.allowUnc) throw new PdfDecompilerError('path_denied', 'UNC paths are disabled.');
    const resolved = await fs.realpath(path.resolve(source)).catch(() => {
        throw new PdfDecompilerError('source_not_found', 'The local PDF does not exist.');
    });
    if (process.platform !== 'win32' && POSIX_SPECIAL_ROOTS.some(root => inside(root, resolved))) {
        throw new PdfDecompilerError('path_denied', 'Device and special filesystem paths are not allowed.');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new PdfDecompilerError('path_denied', 'The source must be a regular file.');
    const denyRoots = await Promise.all(config.denyRoots.map(canonicalRoot));
    if (denyRoots.some(root => inside(root, resolved))) throw new PdfDecompilerError('path_denied', 'The local path is denied by policy.');
    if (!config.unrestrictedLocalAccess) {
        const allowRoots = await Promise.all(config.allowRoots.map(canonicalRoot));
        if (!allowRoots.some(root => inside(root, resolved))) {
            throw new PdfDecompilerError('path_denied', 'The local path is outside configured allow roots.');
        }
    }
    if (stat.size > config.maxDocumentBytes) throw new PdfDecompilerError('document_too_large', 'The PDF exceeds the configured size limit.');
    return { path: resolved, size: stat.size };
}

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
]) {
    blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

function ipDenied(ip) {
    const value = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return blockedAddresses.check(mapped[1], 'ipv4');
    return net.isIPv4(value) ? blockedAddresses.check(value, 'ipv4') : blockedAddresses.check(value, 'ipv6');
}

async function validateRemoteUrl(url, lookup = dns.lookup) {
    if (url.protocol !== 'https:') throw new PdfDecompilerError('url_denied', 'Only HTTPS PDF URLs are allowed.');
    if (url.username || url.password) throw new PdfDecompilerError('url_denied', 'URL credentials are not allowed.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const records = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
    if (!records.length || records.some(record => ipDenied(record.address))) {
        throw new PdfDecompilerError('url_denied', 'The URL resolves to a prohibited network address.');
    }
    return records.map(record => ({ address: record.address, family: record.family || net.isIP(record.address) }));
}

function requestPinned(url, records, timeoutMs) {
    return new Promise((resolve, reject) => {
        const request = https.request(url, {
            method: 'GET',
            headers: { accept: 'application/pdf' },
            servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
            lookup(_hostname, options, callback) {
                if (options?.all) callback(null, records);
                else callback(null, records[0].address, records[0].family);
            },
        }, resolve);
        request.setTimeout(timeoutMs, () => request.destroy(new PdfDecompilerError('fetch_timeout', 'The HTTPS source exceeded the download deadline.')));
        request.once('error', reject);
        request.end();
    });
}

export async function fetchRemotePdf(source, config, options = {}) {
    let url;
    try { url = new URL(source); } catch { throw new PdfDecompilerError('invalid_source', 'The source must be a local path or HTTPS URL.'); }
    const timeoutMs = options.timeoutMs ?? 30_000;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
        const records = await validateRemoteUrl(url, options.lookup);
        const response = await (options.request || requestPinned)(url, records, timeoutMs);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            const location = response.headers.location;
            if (!location || redirects === 5) throw new PdfDecompilerError('redirect_denied', 'The PDF URL exceeded the redirect limit.');
            url = new URL(location, url);
            continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            throw new PdfDecompilerError('fetch_failed', `The HTTPS source returned status ${response.statusCode}.`);
        }
        const contentLength = Number(response.headers['content-length'] || 0);
        if (contentLength > config.maxDocumentBytes) throw new PdfDecompilerError('document_too_large', 'The PDF exceeds the configured size limit.');
        const chunks = [];
        let total = 0;
        for await (const chunk of response) {
            total += chunk.length;
            if (total > config.maxDocumentBytes) {
                response.destroy();
                throw new PdfDecompilerError('document_too_large', 'The PDF exceeds the configured size limit.');
            }
            chunks.push(chunk);
        }
        return { bytes: Buffer.concat(chunks), sourceUrl: url.toString() };
    }
    throw new PdfDecompilerError('fetch_failed', 'The HTTPS source could not be loaded.');
}

export function validatePdfBytes(bytes, config) {
    if (bytes.length > config.maxDocumentBytes) throw new PdfDecompilerError('document_too_large', 'The PDF exceeds the configured size limit.');
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        const parser = parserErrorPayload('PDF_INVALID_SIGNATURE');
        throw new PdfDecompilerError(parser.code, parser.message, { parser });
    }
    const tail = bytes.subarray(Math.max(0, bytes.length - 4096)).toString('latin1');
    if (!/%%EOF\s*$/.test(tail)) {
        const parser = parserErrorPayload('PDF_TRUNCATED');
        throw new PdfDecompilerError(parser.code, parser.message, { parser });
    }
    const startMatch = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
    if (!startMatch) {
        const parser = parserErrorPayload('PDF_INVALID_STARTXREF');
        throw new PdfDecompilerError(parser.code, parser.message, { parser });
    }
    const offset = Number(startMatch[1]);
    const xrefHead = bytes.subarray(offset, Math.min(bytes.length, offset + 4096)).toString('latin1');
    if (!Number.isSafeInteger(offset) || offset < 5 || offset >= bytes.length || (!xrefHead.startsWith('xref') && !/^\d+\s+\d+\s+obj\b/.test(xrefHead))) {
        const parser = parserErrorPayload('PDF_INVALID_STARTXREF');
        throw new PdfDecompilerError(parser.code, parser.message, { parser });
    }
    if (xrefHead.startsWith('xref')) {
        const lines = xrefHead.split(/\r?\n/);
        const section = /^(\d+)\s+(\d+)\s*$/.exec(lines[1] || '');
        if (!section || !/^\d{10}\s+\d{5}\s+[fn]\s*$/.test(lines[2] || '')) {
            const parser = parserErrorPayload('PDF_INVALID_XREF');
            throw new PdfDecompilerError(parser.code, parser.message, { parser });
        }
    }
}

export async function loadPdfSource(source, config) {
    if (/^https:/i.test(source)) {
        const loaded = await fetchRemotePdf(source, config);
        validatePdfBytes(loaded.bytes, config);
        return loaded;
    }
    const local = await resolveLocalPdf(source, config);
    const bytes = await fs.readFile(local.path);
    validatePdfBytes(bytes, config);
    return { bytes, sourcePath: local.path };
}
