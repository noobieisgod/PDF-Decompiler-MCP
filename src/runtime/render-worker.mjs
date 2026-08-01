import fs from 'node:fs/promises';
import { createCanvas } from '../pdf/pdfjs-runtime.mjs';
import { openMupdfDocument, renderMupdfPageToCanvas } from '../backend/mupdf-runtime.mjs';
import { scaleCanvas } from '../extract/images.mjs';

const [inputPath, outputPath, optionsJson] = process.argv.slice(2);

try {
    const options = JSON.parse(optionsJson);
    const bytes = await fs.readFile(inputPath);
    const document = openMupdfDocument(bytes);
    let canvas = renderMupdfPageToCanvas(document, options.page);
    if (options.bbox) {
        const x = Math.max(0, Math.floor(options.bbox.x || 0));
        const y = Math.max(0, Math.floor(options.bbox.y ?? options.bbox.yTop ?? 0));
        const width = Math.max(1, Math.min(canvas.width - x, Math.ceil(options.bbox.width || canvas.width)));
        const height = Math.max(1, Math.min(canvas.height - y, Math.ceil(options.bbox.height || canvas.height)));
        const cropped = createCanvas(width, height);
        cropped.getContext('2d').drawImage(canvas, x, y, width, height, 0, 0, width, height);
        canvas = cropped;
    }
    canvas = scaleCanvas(canvas, options.maxDimension);
    const format = options.format === 'jpeg' ? 'jpeg' : 'png';
    const encoded = await canvas.encode(format, format === 'jpeg' ? { quality: 0.75 } : undefined);
    await fs.writeFile(outputPath, JSON.stringify({
        ok: true,
        result: {
            mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
            width: canvas.width,
            height: canvas.height,
            data: Buffer.from(encoded).toString('base64'),
        },
    }), { mode: 0o600 });
} catch (error) {
    await fs.writeFile(outputPath, JSON.stringify({ ok: false, error: { message: error?.message || String(error) } }), { mode: 0o600 }).catch(() => {});
    process.exitCode = 1;
}
