import fs from 'node:fs/promises';
import { extractPageContent } from '../extract/document.mjs';
import { detectTesseract } from '../extract/ocr.mjs';

const [inputPath, outputPath, optionsJson] = process.argv.slice(2);

try {
    const options = JSON.parse(optionsJson);
    if (options.ocrPolicy === 'required' && !detectTesseract()) throw new Error('Tesseract is required by the OCR policy but is not available on PATH');
    const bytes = await fs.readFile(inputPath);
    const result = await extractPageContent(bytes, options.pages, options.maxImageDim, {
        maxPages: options.maxPages,
        timeBudgetMs: options.timeBudgetMs,
        ocrPolicy: options.ocrPolicy,
        maxDecompressedBytes: options.maxDecompressedBytes,
    });
    await fs.writeFile(outputPath, JSON.stringify({ ok: true, result }), { mode: 0o600 });
} catch (error) {
    await fs.writeFile(outputPath, JSON.stringify({
        ok: false,
        error: { message: error?.message || String(error), stack: error?.stack || null },
    }), { mode: 0o600 }).catch(() => {});
    process.exitCode = 1;
}
