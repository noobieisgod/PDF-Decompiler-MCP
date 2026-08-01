import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

let createCanvas = null;
try {
    const canvasModule = await import('../../node_modules/@napi-rs/canvas/index.js');
    createCanvas = canvasModule.createCanvas ?? canvasModule.default?.createCanvas ?? null;
    if (canvasModule.DOMMatrix) {
        globalThis.DOMMatrix = canvasModule.DOMMatrix;
    }
    if (canvasModule.Path2D) {
        globalThis.Path2D = canvasModule.Path2D;
    }
    if (canvasModule.ImageData) {
        globalThis.ImageData = canvasModule.ImageData;
    }
    if (canvasModule.Image) {
        globalThis.Image = canvasModule.Image;
    }
    globalThis.createImageBitmap = async function createImageBitmapCompat(source) {
        const width = source?.width ?? source?.naturalWidth ?? 1;
        const height = source?.height ?? source?.naturalHeight ?? 1;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        try {
            if (source instanceof globalThis.ImageData) {
                ctx.putImageData(source, 0, 0);
            } else {
                const raw = source?.data ?? source?.rgba;
                if (raw && raw.length > 0) {
                    const bytes = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw.buffer ?? raw);
                    ctx.putImageData(new globalThis.ImageData(bytes, width, height), 0, 0);
                }
            }
        } catch {
        }
        return canvas;
    };
} catch {
}

if (typeof globalThis.DOMMatrix === 'undefined') {
    await import('../../pdfjs-polyfill.mjs');
}

const pdfjs = await import('../../node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const { getDocument, VerbosityLevel, OPS, GlobalWorkerOptions, AnnotationMode } = pdfjs;

try {
    const workerPath = fileURLToPath(new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url));
    if (GlobalWorkerOptions && !GlobalWorkerOptions.workerSrc) {
        GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    }
} catch {
}

const LOCAL_FONT_DIR = fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

export class LocalStandardFontDataFactory {
    async fetch({ filename }) {
        return fs.readFileSync(path.join(LOCAL_FONT_DIR, filename));
    }
}

export function patchCanvasContext(ctx) {
    return ctx;
}

export class NodeCanvasFactory {
    create(width, height) {
        const canvas = createCanvas(width, height);
        const context = patchCanvasContext(canvas.getContext('2d'));
        return { canvas, context };
    }

    reset(holder, width, height) {
        holder.canvas.width = width;
        holder.canvas.height = height;
    }

    destroy(holder) {
        holder.canvas.width = 0;
        holder.canvas.height = 0;
    }
}

export {
    AnnotationMode,
    createCanvas,
    getDocument,
    OPS,
    VerbosityLevel,
};
