import mupdf from 'mupdf';
import { createCanvas } from '../pdf/pdfjs-runtime.mjs';

function rgbPixmapToCanvas(pixmap) {
    if (!createCanvas) {
        throw new Error('Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97');
    }
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const channels = pixmap.getNumberOfComponents();
    const alpha = pixmap.getAlpha();
    const stride = pixmap.getStride();
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const src = (y * stride) + (x * channels);
            const dst = ((y * width) + x) * 4;
            rgba[dst] = pixels[src] ?? 255;
            rgba[dst + 1] = pixels[src + 1] ?? rgba[dst];
            rgba[dst + 2] = pixels[src + 2] ?? rgba[dst];
            rgba[dst + 3] = alpha ? (pixels[src + channels - 1] ?? 255) : 255;
        }
    }
    ctx.putImageData(new globalThis.ImageData(rgba, width, height), 0, 0);
    return canvas;
}

export function openMupdfDocument(pdfBytes) {
    return mupdf.Document.openDocument(pdfBytes, 'application/pdf');
}

export function renderMupdfPageToCanvas(mupdfDoc, pageNum, viewport = null) {
    const page = mupdfDoc.loadPage(pageNum - 1);
    const [x0, y0, x1, y1] = page.getBounds();
    const baseWidth = Math.max(1, x1 - x0);
    const baseHeight = Math.max(1, y1 - y0);
    const viewportWidth = viewport?.width ?? baseWidth;
    const viewportHeight = viewport?.height ?? baseHeight;
    const scaleX = viewportWidth / baseWidth;
    const scaleY = viewportHeight / baseHeight;
    const scale = Number.isFinite(scaleX) && Number.isFinite(scaleY)
        ? Math.max(0.01, (scaleX + scaleY) / 2)
        : 1;
    const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
    );
    return rgbPixmapToCanvas(pixmap);
}
