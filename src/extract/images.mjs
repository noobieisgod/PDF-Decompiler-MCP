import {
    DEBUG_RENDER,
    JPEG_OUTPUT_QUALITY,
    MIN_ENCODED_BYTES_FOR_CROP,
    MIN_ENCODED_BYTES_FOR_PAGE,
    MIN_OPAQUE_PIXEL_RATIO,
    MIN_VISIBLE_PIXEL_RATIO,
    debugRender,
} from '../config/constants.mjs';
import {
    AnnotationMode,
    createCanvas,
    NodeCanvasFactory,
    OPS,
    patchCanvasContext,
} from '../pdf/pdfjs-runtime.mjs';

const KNOWN_RENDER_ENVIRONMENT_PATTERNS = [
    "Cannot read properties of undefined (reading 'createElement')",
    "Cannot read properties of null (reading 'createElement')",
    'document is not defined',
    'createElement is not a function',
];

export function isKnownRenderEnvironmentError(err) {
    const message = err?.message ?? String(err ?? '');
    return KNOWN_RENDER_ENVIRONMENT_PATTERNS.some(pattern => message.includes(pattern));
}
export function classifyRenderFailure(err) {
    const message = err?.message ?? String(err ?? 'Unknown render error');
    if (isKnownRenderEnvironmentError(err)) {
        return {
            knownRuntimeIssue: true,
            message,
            userMessage: 'Image rendering is unavailable in the current runtime',
        };
    }
    return {
        knownRuntimeIssue: false,
        message,
        userMessage: message,
    };
}

function fillCanvasWhite(canvas) {
    const ctx = patchCanvasContext(canvas.getContext('2d'));
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return ctx;
}

export function scaleCanvas(canvas, maxImageDim) {
    if (!maxImageDim || Math.max(canvas.width, canvas.height) <= maxImageDim) {
        return canvas;
    }
    const scale = maxImageDim / Math.max(canvas.width, canvas.height);
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    const scaled = createCanvas(width, height);
    fillCanvasWhite(scaled);
    scaled.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
    return scaled;
}

const JPEG_ENCODE_OPTIONS = { quality: JPEG_OUTPUT_QUALITY };

export async function canvasToBase64Png(canvas) {
    const png = await canvas.encode('png');
    return Buffer.from(png).toString('base64');
}

async function encodeCanvas(canvas, format) {
    if (format === 'jpeg') {
        return canvas.encode('jpeg', JPEG_ENCODE_OPTIONS);
    }
    return canvas.encode('png');
}

function summarizeCanvasPixels(canvas, encodedBytes = 0) {
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const totalPixels = Math.max(1, canvas.width * canvas.height);
    let opaquePixels = 0;
    let nearWhitePixels = 0;
    let visiblePixels = 0;
    let darkPixels = 0;
    for (let idx = 0; idx < data.length; idx += 4) {
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        if (a >= 8) {
            opaquePixels += 1;
        }
        if (a >= 8 && r >= 248 && g >= 248 && b >= 248) {
            nearWhitePixels += 1;
        }
        if (a >= 8 && (r <= 245 || g <= 245 || b <= 245)) {
            visiblePixels += 1;
        }
        if (a >= 8 && (r <= 235 || g <= 235 || b <= 235)) {
            darkPixels += 1;
        }
    }
    return {
        width: canvas.width,
        height: canvas.height,
        totalPixels,
        encodedBytes,
        pngBytes: encodedBytes,
        opaqueRatio: opaquePixels / totalPixels,
        nearWhiteRatio: nearWhitePixels / totalPixels,
        visibleRatio: visiblePixels / totalPixels,
        darkRatio: darkPixels / totalPixels,
    };
}

function isCanvasSuspicious(metrics, kind) {
    const minBytes = kind === 'page' ? MIN_ENCODED_BYTES_FOR_PAGE : MIN_ENCODED_BYTES_FOR_CROP;
    if (metrics.opaqueRatio < MIN_OPAQUE_PIXEL_RATIO) {
        return true;
    }
    if (metrics.visibleRatio < MIN_VISIBLE_PIXEL_RATIO) {
        return true;
    }
    if (metrics.encodedBytes < minBytes) {
        return true;
    }
    return false;
}

function buildDirectPlacementContext(placement, plan = {}, viewport = null) {
    const pageHeight = viewport?.height ?? 0;
    const pageWidth = viewport?.width ?? 0;
    const placementAreaRatio = pageWidth && pageHeight
        ? (Math.max(1, placement.w) * Math.max(1, placement.h)) / Math.max(1, pageWidth * pageHeight)
        : null;
    const footerBandRatio = pageHeight ? (placement.yTop + Math.max(1, placement.h)) / Math.max(1, pageHeight) : null;
    return {
        regionKind: plan?.regionKind ?? null,
        captionLength: plan?.caption?.length ?? 0,
        placementAreaRatio,
        footerBandRatio,
    };
}

function shouldAcceptDirectObject(details) {
    const reasons = [];
    const directAspect = details.width / Math.max(1, details.height);
    const placementAspect = Math.max(1, details.placement.w) / Math.max(1, details.placement.h);
    const aspectDelta = Math.abs(directAspect - placementAspect);
    if (aspectDelta > 0.35) {
        reasons.push('aspect_mismatch');
    }
    if (details.kind === 1) {
        reasons.push('bitonal_object');
    }
    if (details.metrics.visibleRatio < 0.18) {
        reasons.push('low_visible_ratio');
    }
    if ((details.context.regionKind === 'photo' || details.context.placementAreaRatio >= 0.04) && details.metrics.visibleRatio < 0.35) {
        reasons.push('too_sparse_for_large_or_photo_region');
    }
    if (details.context.footerBandRatio != null
        && details.context.footerBandRatio >= 0.88
        && details.metrics.visibleRatio < 0.3
        && details.context.captionLength >= 80) {
        reasons.push('footer_text_snippet_like');
    }
    if (details.metrics.encodedBytes < 12000 && details.metrics.visibleRatio < 0.22 && details.context.captionLength >= 40) {
        reasons.push('tiny_text_like_payload');
    }
    return {
        accepted: reasons.length === 0,
        reasons,
    };
}

function isSnippetLikeDirectRejection(reasons = []) {
    return reasons.some(reason => [
        'low_visible_ratio',
        'tiny_text_like_payload',
        'footer_text_snippet_like',
        'too_sparse_for_large_or_photo_region',
        'bitonal_object',
    ].includes(reason));
}

async function encodeCanvasWithDiagnostics(canvas, kind, context = {}, format = 'png') {
    const encoded = await encodeCanvas(canvas, format);
    const encodedBytes = Buffer.byteLength(encoded);
    const metrics = summarizeCanvasPixels(canvas, encodedBytes);
    const suspicious = isCanvasSuspicious(metrics, kind);
    if (DEBUG_RENDER || suspicious) {
        debugRender('canvas-summary', JSON.stringify({
            kind,
            ...context,
            ...metrics,
            suspicious,
            format,
        }));
    }
    return {
        ok: !suspicious,
        data: Buffer.from(encoded).toString('base64'),
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        metrics,
        reason: suspicious ? 'Rendered canvas looked blank or too small to trust' : null,
    };
}

async function renderPageCanvasAttempt(pdfjsPage, viewport, useCanvasFactory) {
    if (!createCanvas) {
        throw new Error('Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97');
    }
    debugRender('render-attempt-start', JSON.stringify({
        stage: 'renderPageCanvas',
        strategy: useCanvasFactory ? 'node_canvas_factory' : 'direct_canvas_context',
        width: Math.ceil(viewport.width),
        height: Math.ceil(viewport.height),
    }));
    const fullCanvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const fullCtx = fillCanvasWhite(fullCanvas);
    const renderOptions = {
        canvasContext: fullCtx,
        viewport,
        annotationMode: AnnotationMode?.DISABLE ?? 0,
    };
    if (useCanvasFactory) {
        renderOptions.canvasFactory = new NodeCanvasFactory();
    }
    await pdfjsPage.render(renderOptions).promise;
    return fullCanvas;
}

export async function renderPageCanvas(pdfjsPage, viewport) {
    let best = null;
    let lastError = null;
    for (const useCanvasFactory of [false, true]) {
        try {
            const canvas = await renderPageCanvasAttempt(pdfjsPage, viewport, useCanvasFactory);
            const encoded = await encodeCanvasWithDiagnostics(canvas, 'page', {
                stage: 'renderPageCanvas',
                strategy: useCanvasFactory ? 'node_canvas_factory' : 'direct_canvas_context',
            }, 'png');
            if (!best || encoded.metrics.pngBytes > best.encoded.metrics.pngBytes) {
                best = { canvas, encoded, useCanvasFactory };
            }
            if (encoded.ok) {
                return canvas;
            }
        } catch (err) {
            lastError = err;
            const classified = classifyRenderFailure(err);
            debugRender('render-attempt-error', JSON.stringify({
                stage: 'renderPageCanvas',
                strategy: useCanvasFactory ? 'node_canvas_factory' : 'direct_canvas_context',
                error: classified.message,
                knownRuntimeIssue: classified.knownRuntimeIssue,
            }));
        }
    }
    if (best?.canvas) {
        return best.canvas;
    }
    throw lastError ?? new Error('Unable to render page canvas');
}

export function cropPlacementFromCanvas(fullCanvas, placement, maxImageDim) {
    const sx = Math.max(0, Math.floor(placement.x));
    const sy = Math.max(0, Math.floor(placement.yTop));
    const sw = Math.max(1, Math.min(fullCanvas.width - sx, Math.ceil(placement.w)));
    const sh = Math.max(1, Math.min(fullCanvas.height - sy, Math.ceil(placement.h)));
    const crop = createCanvas(sw, sh);
    fillCanvasWhite(crop);
    crop.getContext('2d').drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return scaleCanvas(crop, maxImageDim);
}

function imgDataToCanvas(imgData) {
    const { width, height, data, kind } = imgData;
    if (!width || !height || !data) {
        throw new Error('Decoded image object is missing width, height, or pixel data');
    }
    const canvas = createCanvas(width, height);
    const ctx = fillCanvasWhite(canvas);
    const raw = data instanceof Uint8ClampedArray || data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer ?? data);
    let rgba;
    if (!kind || kind === 3) {
        if (raw.length !== width * height * 4) {
            throw new Error(`Unexpected RGBA image length ${raw.length} for ${width}x${height}`);
        }
        rgba = raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw);
    } else if (kind === 2) {
        if (raw.length !== width * height * 3) {
            throw new Error(`Unexpected RGB image length ${raw.length} for ${width}x${height}`);
        }
        rgba = new Uint8ClampedArray(width * height * 4);
        for (let idx = 0; idx < width * height; idx += 1) {
            rgba[idx * 4] = raw[idx * 3];
            rgba[idx * 4 + 1] = raw[idx * 3 + 1];
            rgba[idx * 4 + 2] = raw[idx * 3 + 2];
            rgba[idx * 4 + 3] = 255;
        }
    } else if (kind === 1) {
        const bytesPerRow = (width + 7) >> 3;
        if (raw.length < bytesPerRow * height) {
            throw new Error(`Unexpected bitonal image length ${raw.length} for ${width}x${height}`);
        }
        rgba = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const byte = raw[y * bytesPerRow + (x >> 3)];
                const v = ((byte >> (7 - (x & 7))) & 1) ? 255 : 0;
                const j = (y * width + x) * 4;
                rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
                rgba[j + 3] = 255;
            }
        }
    } else {
        throw new Error(`Unsupported pdf.js image kind: ${kind}`);
    }
    ctx.putImageData(new globalThis.ImageData(rgba, width, height), 0, 0);
    return canvas;
}

function resolveObjAsync(objs, name, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(`Timed out resolving image object ${name}`)), timeoutMs);
        try {
            const direct = objs.get?.(name);
            if (direct !== undefined) {
                finish(resolve, direct);
                return;
            }
        } catch {
        }
        try {
            objs.get(name, (value) => finish(resolve, value));
        } catch (err) {
            finish(reject, err);
        }
    });
}

function resolveObjSync(objs, name) {
    try {
        const direct = objs?.get?.(name);
        return direct === undefined ? null : direct;
    } catch {
        return null;
    }
}

function getResolvedImageObject(pdfjsPage, name) {
    return resolveObjSync(pdfjsPage.objs, name) ?? resolveObjSync(pdfjsPage.commonObjs, name);
}

async function renderResolvedObjectImage(imgData, name, targetDim, context = {}, extractionMethod = 'direct_object_fallback') {
    if (!(imgData?.data instanceof Uint8ClampedArray || imgData?.data instanceof Uint8Array)) {
        throw new Error(`Direct image object ${name} did not expose raw pixel data`);
    }
    const canvas = scaleCanvas(imgDataToCanvas(imgData), targetDim);
    const encoded = await encodeCanvasWithDiagnostics(canvas, 'crop', {
        stage: extractionMethod,
        imageName: name,
        ...context,
    }, 'png');
    if (!encoded.ok) {
        throw new Error(encoded.reason ?? 'Direct image extraction produced a blank canvas');
    }
    return {
        data: encoded.data,
        mimeType: encoded.mimeType,
        hashBits: imageHashBits(canvas),
        error: null,
        extractionMethod,
    };
}

async function renderResolvedObjectImageWithTrust(imgData, name, targetDim, placement, plan, viewport, context = {}, extractionMethod = 'direct_object_primary') {
    if (!(imgData?.data instanceof Uint8ClampedArray || imgData?.data instanceof Uint8Array)) {
        throw new Error(`Direct image object ${name} did not expose raw pixel data`);
    }
    const canvas = scaleCanvas(imgDataToCanvas(imgData), targetDim);
    const encoded = await encodeCanvasWithDiagnostics(canvas, 'crop', {
        stage: extractionMethod,
        imageName: name,
        ...context,
    });
    const directMetrics = encoded.metrics;
    const trustContext = buildDirectPlacementContext(placement, plan, viewport);
    const trust = shouldAcceptDirectObject({
        kind: imgData.kind ?? null,
        width: directMetrics.width || canvas.width || imgData.width || 0,
        height: directMetrics.height || canvas.height || imgData.height || 0,
        metrics: directMetrics,
        placement,
        context: trustContext,
    });
    return {
        data: encoded.data,
        mimeType: encoded.mimeType,
        hashBits: imageHashBits(canvas),
        error: null,
        extractionMethod,
        renderDebug: {
            attemptedDirectPrimary: extractionMethod === 'direct_object_primary',
            directPrimaryAccepted: trust.accepted,
            directPrimaryRejectedReasons: trust.reasons,
            directPrimaryMetrics: {
                width: directMetrics.width,
                height: directMetrics.height,
                encodedBytes: directMetrics.encodedBytes,
                pngBytes: directMetrics.pngBytes,
                visibleRatio: directMetrics.visibleRatio,
                opaqueRatio: directMetrics.opaqueRatio,
                kind: imgData.kind ?? null,
                regionKind: trustContext.regionKind,
                captionLength: trustContext.captionLength,
                placementAreaRatio: trustContext.placementAreaRatio,
                footerBandRatio: trustContext.footerBandRatio,
            },
        },
    };
}

async function renderDirectObjectImage(pdfjsPage, name, targetDim, context = {}) {
    let directError = null;
    let imgData = null;
    try {
        imgData = await resolveObjAsync(pdfjsPage.objs, name);
    } catch (err) {
        directError = err;
    }
    if (!imgData) {
        try {
            imgData = await resolveObjAsync(pdfjsPage.commonObjs, name);
        } catch (err) {
            if (!directError) {
                directError = err;
            }
        }
    }
    if (!imgData) {
        throw directError ?? new Error(`Direct image object ${name} did not expose raw pixel data`);
    }
    return renderResolvedObjectImage(imgData, name, targetDim, context, 'direct_object_fallback');
}

async function renderDirectObjectImagePrimary(pdfjsPage, name, targetDim, placement, plan, viewport, context = {}) {
    debugRender('direct-object-primary-start', JSON.stringify({
        stage: 'direct-object-primary',
        imageName: name,
        ...context,
    }));
    const resolved = getResolvedImageObject(pdfjsPage, name);
    if (!resolved) {
        throw new Error(`Direct image object ${name} was not pre-resolved`);
    }
    return renderResolvedObjectImageWithTrust(resolved, name, targetDim, placement, plan, viewport, context, 'direct_object_primary');
}

async function renderDirectObjectImageAfterRender(pdfjsPage, name, targetDim, placement, plan, viewport, context = {}) {
    debugRender('direct-object-after-render-start', JSON.stringify({
        stage: 'direct-object-after-render',
        imageName: name,
        ...context,
    }));
    let resolved = getResolvedImageObject(pdfjsPage, name);
    if (!resolved) {
        try {
            resolved = await resolveObjAsync(pdfjsPage.objs, name, 250);
        } catch {
        }
    }
    if (!resolved) {
        try {
            resolved = await resolveObjAsync(pdfjsPage.commonObjs, name, 250);
        } catch {
        }
    }
    if (!resolved) {
        throw new Error(`Direct image object ${name} was still unavailable after page render`);
    }
    return renderResolvedObjectImageWithTrust(resolved, name, targetDim, placement, plan, viewport, context, 'direct_object_primary');
}

export function imageHashBits(canvas) {
    const sample = scaleCanvas(canvas, 9);
    const ctx = sample.getContext('2d');
    const { data } = ctx.getImageData(0, 0, sample.width, sample.height);
    const gray = [];
    for (let idx = 0; idx < data.length; idx += 4) {
        gray.push((data[idx] * 0.299) + (data[idx + 1] * 0.587) + (data[idx + 2] * 0.114));
    }
    let bits = '';
    for (let y = 0; y < sample.height; y += 1) {
        for (let x = 0; x < sample.width - 1; x += 1) {
            const left = gray[(y * sample.width) + x];
            const right = gray[(y * sample.width) + x + 1];
            bits += left > right ? '1' : '0';
        }
    }
    return bits;
}

export function hashMatchScore(a, b) {
    if (!a || !b || a.length !== b.length) {
        return 0;
    }
    let matches = 0;
    for (let idx = 0; idx < a.length; idx += 1) {
        if (a[idx] === b[idx]) {
            matches += 1;
        }
    }
    return (matches / a.length) * 100;
}

export async function renderPageImages(pdfjsPage, viewport, placements, imagePlans, maxImageDim, context = {}, options = {}) {
    const result = new Map();
    if (placements.size === 0) {
        return result;
    }
    if (!createCanvas) {
        for (const name of placements.keys()) {
            result.set(name, {
                data: null,
                mimeType: null,
                error: 'Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97',
                extractionMethod: 'failed',
            });
        }
        return result;
    }
    const directFallbackCache = new Map();
    let fullCanvas = null;
    let fullCanvasFailure = null;
    for (const [name, placement] of placements) {
        try {
            const plan = imagePlans?.get(name);
            const targetDim = plan?.targetMaxDim ?? maxImageDim;
            const sourceName = placement.sourceName ?? name;
            let directPrimaryError = null;
            try {
                const directPrimary = await renderDirectObjectImagePrimary(
                    pdfjsPage,
                    sourceName,
                    targetDim,
                    placement,
                    plan,
                    viewport,
                    {
                        imageName: name,
                        bbox: placement,
                        ...context,
                    },
                );
                if (directPrimary.renderDebug?.directPrimaryAccepted === false) {
                    throw new Error(`Direct image object ${sourceName} rejected: ${directPrimary.renderDebug.directPrimaryRejectedReasons.join(',')}`);
                }
                debugRender('direct-object-primary-success', JSON.stringify({
                    stage: 'direct-object-primary',
                    imageName: name,
                    sourceName,
                    extractionMethod: directPrimary.extractionMethod,
                    ...context,
                }));
                result.set(name, directPrimary);
                continue;
            } catch (err) {
                directPrimaryError = err;
                const classified = classifyRenderFailure(err);
                debugRender('direct-object-primary-failure', JSON.stringify({
                    stage: 'direct-object-primary',
                    imageName: name,
                    sourceName,
                    error: classified.message,
                    knownRuntimeIssue: classified.knownRuntimeIssue,
                    ...context,
                }));
            }

            if (!fullCanvas && !fullCanvasFailure) {
                try {
                    debugRender('render-page-images-start', JSON.stringify({
                        stage: 'renderPageImages',
                        placements: placements.size,
                        ...context,
                    }));
                    fullCanvas = renderPageCanvasOverride ? await renderPageCanvasOverride() : await renderPageCanvas(pdfjsPage, viewport);
                } catch (err) {
                    fullCanvasFailure = err;
                }
            }

            if (!fullCanvas) {
                const classified = classifyRenderFailure(fullCanvasFailure ?? directPrimaryError);
                result.set(name, {
                    data: null,
                    mimeType: null,
                    error: `Extract error: ${classified.userMessage}`,
                    extractionMethod: 'failed',
                });
                continue;
            }

            if (directPrimaryError) {
                let directAfterRenderRejected = null;
                try {
                    const directAfterRender = await renderDirectObjectImageAfterRender(
                        pdfjsPage,
                        sourceName,
                        targetDim,
                        placement,
                        plan,
                        viewport,
                        {
                            imageName: name,
                            bbox: placement,
                            ...context,
                        },
                    );
                    if (directAfterRender.renderDebug?.directPrimaryAccepted === false) {
                        directAfterRenderRejected = directAfterRender;
                        throw new Error(`Direct image object ${sourceName} rejected after render: ${directAfterRender.renderDebug.directPrimaryRejectedReasons.join(',')}`);
                    }
                    debugRender('direct-object-after-render-success', JSON.stringify({
                        stage: 'direct-object-after-render',
                        imageName: name,
                        sourceName,
                        extractionMethod: directAfterRender.extractionMethod,
                        ...context,
                    }));
                    result.set(name, directAfterRender);
                    continue;
                } catch (err) {
                    const classified = classifyRenderFailure(err);
                    debugRender('direct-object-after-render-failure', JSON.stringify({
                        stage: 'direct-object-after-render',
                        imageName: name,
                        sourceName,
                        error: classified.message,
                        knownRuntimeIssue: classified.knownRuntimeIssue,
                        ...context,
                    }));
                    if (directAfterRenderRejected?.renderDebug?.directPrimaryRejectedReasons
                        && isSnippetLikeDirectRejection(directAfterRenderRejected.renderDebug.directPrimaryRejectedReasons)) {
                        result.set(name, {
                            data: null,
                            mimeType: null,
                            error: 'Extract error: Direct PDF image object did not resemble a standalone image',
                            extractionMethod: 'failed',
                            renderDebug: directAfterRenderRejected.renderDebug,
                        });
                        continue;
                    }
                }
            }

            debugRender('screenshot-fallback-start', JSON.stringify({
                stage: 'screenshot-fallback',
                imageName: name,
                sourceName,
                reason: directPrimaryError?.message ?? 'direct-object-primary-unavailable',
                ...context,
            }));
            const renderedCanvas = cropPlacementFromCanvas(fullCanvas, placement, targetDim);
            const encodedCrop = await encodeCanvasWithDiagnostics(renderedCanvas, 'crop', {
                stage: 'screenshot-crop',
                imageName: name,
                bbox: placement,
                ...context,
            }, 'jpeg');
            if (encodedCrop.ok) {
                result.set(name, {
                    data: encodedCrop.data,
                    mimeType: encodedCrop.mimeType,
                    hashBits: imageHashBits(renderedCanvas),
                    error: null,
                    extractionMethod: 'screenshot_crop',
                    renderDebug: {
                        attemptedDirectPrimary: true,
                        directPrimaryAccepted: false,
                        directPrimaryRejectedReasons: directPrimaryError ? [directPrimaryError.message] : [],
                        directPrimaryMetrics: null,
                    },
                });
                continue;
            }
            debugRender('crop-fallback', JSON.stringify({
                imageName: name,
                bbox: placement,
                reason: encodedCrop.reason,
                ...context,
            }));
            const cacheKey = `${sourceName}:${targetDim ?? 'default'}`;
            let direct = directFallbackCache.get(cacheKey);
            if (!direct) {
                const resolved = getResolvedImageObject(pdfjsPage, sourceName);
                direct = resolved
                    ? await renderResolvedObjectImageWithTrust(resolved, sourceName, targetDim, placement, plan, viewport, {
                        imageName: name,
                        bbox: placement,
                        ...context,
                    }, 'direct_object_fallback')
                    : await renderDirectObjectImage(pdfjsPage, sourceName, targetDim, {
                        imageName: name,
                        bbox: placement,
                        ...context,
                    });
                directFallbackCache.set(cacheKey, direct);
            }
            result.set(name, directPrimaryError
                ? {
                    ...direct,
                    renderDebug: {
                        attemptedDirectPrimary: true,
                        directPrimaryAccepted: false,
                        directPrimaryRejectedReasons: [directPrimaryError.message],
                        directPrimaryMetrics: direct.renderDebug?.directPrimaryMetrics ?? null,
                    },
                }
                : direct);
        } catch (err) {
            const classified = classifyRenderFailure(err);
            result.set(name, {
                data: null,
                mimeType: null,
                error: `Extract error: ${classified.userMessage}`,
                extractionMethod: 'failed',
                renderDebug: {
                    attemptedDirectPrimary: true,
                    directPrimaryAccepted: false,
                    directPrimaryRejectedReasons: [classified.message],
                    directPrimaryMetrics: null,
                },
            });
        }
    }
    return result;
}

export async function encodePageImage(canvas, context = {}) {
    return encodeCanvasWithDiagnostics(canvas, 'page', context, 'png');
}

export async function getImagePlacements(pdfjsPage, pageHeight) {
    const placements = new Map();
    let ops;
    try {
        ops = await pdfjsPage.getOperatorList();
    } catch {
        return placements;
    }
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const mul = (a, b) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    for (let idx = 0; idx < ops.fnArray.length; idx += 1) {
        const fn = ops.fnArray[idx];
        const args = ops.argsArray[idx];
        if (fn === OPS.save) {
            stack.push([...ctm]);
        } else if (fn === OPS.restore) {
            if (stack.length) {
                ctm = stack.pop();
            }
        } else if (fn === OPS.transform) {
            ctm = mul(ctm, args);
        } else if (fn === OPS.paintImageXObject) {
            const sourceName = args[0];
            const imgW = Math.abs(ctm[0]) || Math.abs(ctm[2]) || 1;
            const imgH = Math.abs(ctm[3]) || Math.abs(ctm[1]) || 1;
            const imgX = ctm[4];
            const imgY = ctm[5];
            const yTop = pageHeight - imgY - imgH;
            const drawIndex = placements.size;
            const placementId = `${sourceName}#${drawIndex}`;
            placements.set(placementId, { x: imgX, yTop, w: imgW, h: imgH, sourceName, placementId });
        }
    }
    return placements;
}

export async function inspectCanvasForDebug(canvas, kind, context = {}) {
    const encoded = await encodeCanvasWithDiagnostics(canvas, kind, context);
    return {
        ...encoded.metrics,
        suspicious: !encoded.ok,
        reason: encoded.reason,
    };
}
