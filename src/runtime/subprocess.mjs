import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PdfDecompilerError } from '../core/errors.mjs';
import { isParserErrorPayload, parserErrorPayload } from './parser-errors.mjs';

const execFileAsync = promisify(execFile);

function parserFailure(code, details = {}) {
    const parser = parserErrorPayload(code, details.diagnosticId);
    return new PdfDecompilerError(parser.code, parser.message, { parser, ...(details.enforcement ? { enforcement: details.enforcement } : {}) });
}

export async function readExtractionWorkerResult({ output, exitCode, stderr = '', config, enforcement }) {
    const stat = await fs.stat(output).catch(() => null);
    if (!stat || stat.size > Math.min(256 * 1024 * 1024, config.maxDecompressedBytes)) throw parserFailure('PDF_PARSER_CRASH', { enforcement });
    let payload;
    try {
        payload = JSON.parse(await fs.readFile(output, 'utf8'));
    } catch {
        if (config.debug && stderr) console.error('[pdf-parser-worker]', stderr);
        throw parserFailure('PDF_PARSER_CRASH', { enforcement });
    }
    if (!payload.ok || exitCode !== 0) {
        if (config.debug && stderr) console.error('[pdf-parser-worker]', stderr);
        if (isParserErrorPayload(payload.error)) throw new PdfDecompilerError(payload.error.code, payload.error.message, { parser: payload.error, enforcement });
        throw parserFailure('PDF_PARSER_CRASH', { enforcement });
    }
    if (!payload.result || !Array.isArray(payload.result.pages) || !Number.isInteger(payload.result.totalPages)) throw parserFailure('PDF_PARSER_CRASH', { enforcement });
    return payload.result;
}

async function workingSet(pid) {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { timeout: 2000, windowsHide: true });
            return Number(stdout.trim());
        }
        const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 });
        return Number(stdout.trim()) * 1024;
    } catch {
        return null;
    }
}

async function linuxPrlimitAvailable() {
    return process.platform === 'linux' && fs.access('/usr/bin/prlimit').then(() => true, () => false);
}

export async function runExtractionSubprocess(pdfBytes, config, options = {}) {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-extract-'));
    await fs.chmod(work, 0o700).catch(() => {});
    const input = path.join(work, 'source.pdf');
    const output = path.join(work, 'result.json');
    await fs.writeFile(input, pdfBytes, { mode: 0o600 });
    const worker = fileURLToPath(new URL('./extract-worker.mjs', import.meta.url));
    const workerOptions = JSON.stringify({
        pages: options.pages,
        maxImageDim: Math.min(options.maxImageDim || 1200, 4096),
        maxPages: config.maxPages,
        ocrPolicy: config.ocrPolicy,
        maxDecompressedBytes: config.maxDecompressedBytes,
        timeBudgetMs: Math.max(1000, config.extractionTimeoutMs - 2000),
    });
    const usePrlimit = await linuxPrlimitAvailable();
    const command = usePrlimit ? '/usr/bin/prlimit' : process.execPath;
    const args = usePrlimit
        ? [`--as=${config.subprocessMemoryBytes}`, '--', process.execPath, worker, input, output, workerOptions]
        : [worker, input, output, workerOptions];
    const enforcement = {
        wallClock: 'hard-runtime-termination',
        documentSize: 'hard-pre-enforced',
        pageCount: 'hard-runtime-enforced-before-page-processing',
        imageDimension: 'hard-runtime-enforced',
        decompression: 'hard-runtime-enforced-at-page-boundaries',
        memory: usePrlimit ? 'operating-system-enforced' : 'monitored-best-effort-then-termination',
    };
    let child;
    let stderr = '';
    let exceededMemory = false;
    let timedOut = false;
    let timer;
    let monitor;
    let monitoring = false;
    try {
        child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
        timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, config.extractionTimeoutMs);
        monitor = setInterval(async () => {
            if (monitoring) return;
            monitoring = true;
            const bytes = await workingSet(child.pid);
            if (bytes !== null && bytes > config.subprocessMemoryBytes) {
                exceededMemory = true;
                child.kill('SIGKILL');
            }
            monitoring = false;
        }, 250);
        const exitCode = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', code => resolve(code));
        });
        if (timedOut) throw parserFailure('PDF_PARSER_TIMEOUT', { enforcement });
        if (exceededMemory) throw new PdfDecompilerError('subprocess_memory_limit', 'PDF decomposition exceeded the memory threshold.', { enforcement });
        return { result: await readExtractionWorkerResult({ output, exitCode, stderr, config, enforcement }), diagnostics: { enforcement } };
    } finally {
        clearTimeout(timer);
        clearInterval(monitor);
        await fs.rm(work, { recursive: true, force: true });
    }
}

export async function runRenderSubprocess(pdfBytes, config, options) {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-decompiler-render-'));
    await fs.chmod(work, 0o700).catch(() => {});
    const input = path.join(work, 'source.pdf');
    const output = path.join(work, 'render.json');
    await fs.writeFile(input, pdfBytes, { mode: 0o600 });
    const worker = fileURLToPath(new URL('./render-worker.mjs', import.meta.url));
    const usePrlimit = await linuxPrlimitAvailable();
    const command = usePrlimit ? '/usr/bin/prlimit' : process.execPath;
    const args = usePrlimit
        ? [`--as=${config.subprocessMemoryBytes}`, '--', process.execPath, worker, input, output, JSON.stringify(options)]
        : [worker, input, output, JSON.stringify(options)];
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let timedOut = false;
    let exceededMemory = false;
    let monitoring = false;
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.min(config.extractionTimeoutMs, 30_000));
    const monitor = setInterval(async () => {
        if (monitoring) return;
        monitoring = true;
        const bytes = await workingSet(child.pid);
        if (bytes !== null && bytes > config.subprocessMemoryBytes) { exceededMemory = true; child.kill('SIGKILL'); }
        monitoring = false;
    }, 250);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        if (timedOut) throw new PdfDecompilerError('subprocess_timeout', 'Page rendering exceeded the wall-clock limit.');
        if (exceededMemory) throw new PdfDecompilerError('subprocess_memory_limit', 'Page rendering exceeded the memory threshold.');
        const payload = await fs.readFile(output, 'utf8').then(JSON.parse, () => null);
        if (code !== 0 || !payload?.ok) throw new PdfDecompilerError('render_failed', 'Page rendering failed.', config.debug ? { stderr, worker: payload?.error } : undefined);
        return { ...payload.result, enforcement: { wallClock: 'hard-runtime-termination', imageDimension: 'hard-runtime-enforced', memory: usePrlimit ? 'operating-system-enforced' : 'monitored-best-effort-then-termination' } };
    } finally {
        clearTimeout(timer);
        clearInterval(monitor);
        await fs.rm(work, { recursive: true, force: true });
    }
}
