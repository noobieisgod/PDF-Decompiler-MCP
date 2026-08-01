import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extractPageContent } from '../extract/document.mjs';
import { detectTesseract } from '../extract/ocr.mjs';
import { classifyParserFailure, parserErrorPayload } from './parser-errors.mjs';

const [inputPath, outputPath, optionsJson] = process.argv.slice(2);
let finalized = false;

async function finalize(payload, exitCode) {
    if (finalized) return;
    finalized = true;
    const temporary = `${outputPath}.${process.pid}.tmp`;
    const encoded = JSON.stringify(payload);
    await fs.writeFile(temporary, encoded, { mode: 0o600 });
    await fs.rename(temporary, outputPath);
    process.exitCode = exitCode;
}

async function fail(error) {
    const diagnosticId = randomUUID();
    if (process.env.PDF_DECOMPILER_DEBUG === '1') console.error(`[pdf-parser:${diagnosticId}]`, error?.stack || error);
    await finalize({ ok: false, error: parserErrorPayload(classifyParserFailure(error), diagnosticId) }, 1).catch(() => {
        process.exitCode = 1;
    });
}

process.once('uncaughtException', error => { void fail(error); });
process.once('unhandledRejection', error => { void fail(error); });

async function main() {
    const options = JSON.parse(optionsJson);
    if (options.ocrPolicy === 'required' && !detectTesseract()) throw new Error('Tesseract is required by the OCR policy but is not available on PATH');
    const bytes = await fs.readFile(inputPath);
    const result = await extractPageContent(bytes, options.pages, options.maxImageDim, {
        maxPages: options.maxPages,
        timeBudgetMs: options.timeBudgetMs,
        ocrPolicy: options.ocrPolicy,
        maxDecompressedBytes: options.maxDecompressedBytes,
    });
    await finalize({ ok: true, result }, 0);
}

await main().catch(fail);
