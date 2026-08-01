import { ROUTE_TEXT_DENSITY, HF_MAX_WORDS } from '../config/constants.mjs';
import { hfSignature } from './headers-footers.mjs';
import { classifyRenderFailure, encodePageImage, isKnownRenderEnvironmentError, renderPageImages, renderPageCanvas, scaleCanvas, getImagePlacements } from './images.mjs';
import { anchorLinkAnnotations, buildPageTextWithLinks, getPageAnnotations } from './links.mjs';
import { detectTesseract, runTesseractOcr } from './ocr.mjs';
import { buildPageProfile, classifyRegionKind, decidePageRouting, getTargetImageDim, shouldTryOcr } from './router.mjs';
import { detectTables, extractStructTables, normalizeTableRows } from './tables.mjs';
import { buildTextBlocks, findCaptionForImage } from './text.mjs';

function buildRuntimeRenderNotice(kind) {
    return `(${kind} unavailable in the current runtime)`;
}
export async function processOnePage({ pageNum, pdfjsPage, viewport, pageHeight, rawItems, mcidMap, renderPageCanvas: renderPageCanvasOverride }, hfPositions, maxImageDim, options = {}) {
    const {
        allowImageRendering = true,
        allowOcr = true,
        allowVisualFallback = true,
    } = options;
    const bodyItems = hfPositions.size > 0
        ? rawItems.filter(item => {
            const sig = hfSignature(item, pageHeight);
            return !sig || !hfPositions.has(sig) || item.str.trim().split(/\s+/).length > HF_MAX_WORDS;
        })
        : rawItems;
    const strippedByBoilerplate = rawItems.length ? (rawItems.length - bodyItems.length) / rawItems.length : 0;
    const renderFullPageCanvas = async () => renderPageCanvasOverride ? renderPageCanvasOverride() : renderPageCanvas(pdfjsPage, viewport);

    const [imagePlacements, annotations] = await Promise.all([
        getImagePlacements(pdfjsPage, pageHeight),
        getPageAnnotations(pdfjsPage, pageHeight),
    ]);
    const textBlocks = buildTextBlocks(bodyItems);
    const pageProfile = buildPageProfile(pageNum, bodyItems, textBlocks, imagePlacements, viewport, annotations, strippedByBoilerplate);
    const routing = decidePageRouting(pageProfile);
    let extractionMode = routing.extractionMode;
    let routingMode = routing.routingMode;
    let contentClass = routing.contentClass;
    let fallbackReason = null;
    let filteredReason = routing.filteredReason ?? null;
    let rawPageImage = null;
    let rawImages = [];
    let rawTables = [];
    let rawLinks = [];
    let pageText = '';
    let ocrAttempted = false;
    let ocrAccepted = false;
    let ocrReason = null;
    let cachedFullCanvas = null;

    if (extractionMode === 'filtered') {
        pageText = '';
    }

    if (shouldTryOcr(routing)) {
        if (!allowOcr) {
            extractionMode = 'visual_fallback';
            routingMode = 'page_visual_fallback';
            contentClass = 'scan_like';
            ocrReason = 'OCR skipped because extraction had already exhausted its available work budget';
        } else if (!detectTesseract()) {
            extractionMode = 'visual_fallback';
            routingMode = 'page_visual_fallback';
            contentClass = 'scan_like';
            ocrReason = 'Tesseract not available on PATH';
        } else {
            ocrAttempted = true;
            try {
                cachedFullCanvas = await renderFullPageCanvas();
                const ocrCanvas = scaleCanvas(cachedFullCanvas, Math.min(maxImageDim ?? 1400, 1400));
                const ocrPng = await ocrCanvas.encode('png');
                const ocrResult = await runTesseractOcr(Buffer.from(ocrPng), pageNum);
                if (ocrResult.ok) {
                    extractionMode = 'ocr';
                    routingMode = 'page_ocr';
                    contentClass = 'ocr_text';
                    ocrAccepted = true;
                    pageText = ocrResult.text;
                } else {
                    extractionMode = 'visual_fallback';
                    routingMode = 'page_visual_fallback';
                    contentClass = 'scan_like';
                    ocrReason = ocrResult.reason;
                }
            } catch (err) {
                extractionMode = 'visual_fallback';
                routingMode = 'page_visual_fallback';
                contentClass = 'scan_like';
                const classified = classifyRenderFailure(err);
                ocrReason = classified.knownRuntimeIssue
                    ? `${classified.userMessage}; OCR could not render the page`
                    : classified.message;
            }
        }
    }

    if (extractionMode === 'visual_fallback') {
        fallbackReason = ocrReason ?? 'Low-text page routed to whole-page visual fallback';
        if (!allowVisualFallback) {
            fallbackReason = `${fallbackReason}; eager visual fallback is disabled`;
            pageText = '(Visual content available through pdf_render_page)';
        } else {
            try {
                const fullCanvas = cachedFullCanvas ?? await renderFullPageCanvas();
                const fallbackMaxDim = pageProfile.textDensity >= ROUTE_TEXT_DENSITY
                    ? Math.min(maxImageDim ?? 1400, 1400)
                    : Math.min(maxImageDim ?? 960, 960);
                const scaledPageCanvas = scaleCanvas(fullCanvas, fallbackMaxDim);
                const encodedPage = await encodePageImage(scaledPageCanvas, {
                    stage: 'visual-fallback-page',
                    page: pageNum,
                });
                if (encodedPage.ok) {
                    rawPageImage = {
                        width: scaledPageCanvas.width,
                        height: scaledPageCanvas.height,
                        data: encodedPage.data,
                        mimeType: encodedPage.mimeType,
                        extractionMethod: 'full_page_screenshot',
                    };
                    pageText = '[PAGE_IMAGE_LOCAL_0]\n(Page rendered as an image for visual reading)';
                } else {
                    const visualImages = await renderPageImages(pdfjsPage, viewport, imagePlacements, undefined, maxImageDim);
                    let best = null;
                    for (const [name, pos] of imagePlacements.entries()) {
                        const img = visualImages.get(name);
                        if (!img?.data) {
                            continue;
                        }
                        const area = Math.max(1, Math.ceil(pos.w * pos.h));
                        if (!best || area > best.area) {
                            best = {
                                area,
                                width: Math.max(1, Math.ceil(pos.w)),
                                height: Math.max(1, Math.ceil(pos.h)),
                                data: img.data,
                                mimeType: img.mimeType ?? 'image/jpeg',
                                extractionMethod: img.extractionMethod ?? 'largest_region_fallback',
                            };
                        }
                    }
                    if (best) {
                        rawPageImage = {
                            width: best.width,
                            height: best.height,
                            data: best.data,
                            mimeType: best.mimeType,
                            extractionMethod: 'largest_region_fallback',
                        };
                        fallbackReason = `${fallbackReason}; whole-page screenshot was unusable, used largest extracted image region`;
                        pageText = '[PAGE_IMAGE_LOCAL_0]\n(Page rendered as an image for visual reading)';
                    } else {
                        fallbackReason = `${fallbackReason}; visual render failed to produce a usable image`;
                        pageText = '(Visual fallback failed: no usable page image could be produced)';
                    }
                }
            } catch (err) {
                const classified = classifyRenderFailure(err);
                fallbackReason = `${fallbackReason}; visual fallback error: ${classified.message}`;
                if (classified.knownRuntimeIssue || isKnownRenderEnvironmentError(err)) {
                    pageText = buildRuntimeRenderNotice('Visual fallback');
                } else {
                    pageText = `(Visual fallback failed: ${classified.message})`;
                }
            }
        }
    }

    if (extractionMode === 'native') {
        const structTree = await pdfjsPage.getStructTree();
        const structTables = extractStructTables(structTree, mcidMap);
        let tables;
        let nonTableItems;
        if (structTables.length > 0) {
            const tableMcids = new Set(structTables.flatMap(table => [...table.mcids]));
            tables = structTables;
            nonTableItems = bodyItems.filter(item => item.mcid == null || !tableMcids.has(item.mcid));
        } else {
            ({ tables, nonTableItems } = detectTables(bodyItems));
        }
        const normalizedTables = tables.map(table => ({ ...table, rows: normalizeTableRows(table.rows) }));
        const imagePlans = new Map();
        const activePlacements = new Map();
        for (const [name, placement] of imagePlacements.entries()) {
            const caption = findCaptionForImage(placement, textBlocks);
            const regionKind = classifyRegionKind(placement, caption, pageProfile);
            activePlacements.set(name, placement);
            imagePlans.set(name, {
                caption,
                regionKind,
                targetMaxDim: getTargetImageDim(regionKind, pageProfile, maxImageDim, caption),
            });
        }
        const imageIds = new Map();
        let localImageIdx = 0;
        rawImages = [];
        if (allowImageRendering) {
            const renderedImages = await renderPageImages(pdfjsPage, viewport, activePlacements, imagePlans, maxImageDim, { page: pageNum }, { renderPageCanvasOverride: renderFullPageCanvas });
            for (const [name, placement] of activePlacements.entries()) {
                const localId = `IMG_LOCAL_${localImageIdx++}`;
                const img = renderedImages.get(name) ?? { data: null, mimeType: null, error: 'Image render failed', extractionMethod: 'failed' };
                imageIds.set(name, localId);
                const plan = imagePlans.get(name);
                const area = Math.ceil(placement.w * placement.h);
                const ratio = placement.h ? placement.w / placement.h : 1;
                const base = {
                    hashBits: img.hashBits ?? null,
                    area,
                    ratio,
                    bbox: { x: placement.x, y: placement.yTop, width: placement.w, height: placement.h },
                    caption: plan?.caption ?? null,
                    regionKind: plan?.regionKind ?? null,
                    sourceName: placement.sourceName ?? name,
                    placementId: placement.placementId ?? name,
                    renderDebug: img.renderDebug ?? null,
                };
                rawImages.push(img.data
                    ? {
                        ...base,
                        width: Math.ceil(placement.w),
                        height: Math.ceil(placement.h),
                        data: img.data,
                        mimeType: img.mimeType ?? 'image/png',
                        fallbackNeeded: false,
                        fallbackReason: null,
                        extractionMethod: img.extractionMethod ?? 'screenshot_crop',
                    }
                    : {
                        ...base,
                        hashBits: null,
                        width: null,
                        height: null,
                        data: null,
                        mimeType: null,
                        fallbackNeeded: true,
                        fallbackReason: img.error ?? 'Canvas unavailable; install @napi-rs/canvas-win32-x64-msvc@0.1.97',
                        extractionMethod: img.extractionMethod ?? 'failed',
                    });
            }
        }
        const { linkMarkerMap, links } = anchorLinkAnnotations(nonTableItems, annotations);
        rawLinks = links;
        const tableIds = new Map();
        let localTableIdx = 0;
        rawTables = [];
        for (let idx = 0; idx < normalizedTables.length; idx += 1) {
            tableIds.set(idx, `TBL_LOCAL_${localTableIdx++}`);
            rawTables.push({
                rows: normalizedTables[idx].rows,
                bbox: {
                    x: 0,
                    y: normalizedTables[idx].yTop,
                    width: viewport.width,
                    height: normalizedTables[idx].yBottom - normalizedTables[idx].yTop,
                },
            });
        }
        pageText = buildPageTextWithLinks(nonTableItems, activePlacements, normalizedTables, imageIds, tableIds, linkMarkerMap);
    }

    pdfjsPage.cleanup();
    return {
        page: pageNum,
        extractionMode,
        routingMode,
        contentClass,
        fallbackReason,
        filteredReason,
        ocrAttempted,
        ocrAccepted,
        ocrReason,
        text: pageText,
        annotations,
        pageProfile,
        rawImages,
        rawTables,
        rawLinks,
        rawPageImage,
    };
}

export function buildPageErrorResult(pageData, err) {
    try {
        pageData.pdfjsPage.cleanup();
    } catch {
    }
    return {
        page: pageData.pageNum,
        extractionMode: 'error',
        routingMode: 'page_error',
        contentClass: 'error',
        fallbackReason: err?.message ?? String(err),
        filteredReason: null,
        ocrAttempted: false,
        ocrAccepted: false,
        ocrReason: null,
        text: `(Page extraction failed: ${err?.message ?? err})`,
        annotations: [],
        pageProfile: {
            page: pageData.pageNum,
            wordCount: pageData.rawItems?.length ?? 0,
            textChars: 0,
            textDensity: 0,
            imageCoverage: 0,
            tableLikelihood: 0,
            dominantRole: 'text',
            contentClassHint: 'text',
            annotationsCount: 0,
            viewportWidth: pageData.viewport?.width ?? 0,
            viewportHeight: pageData.viewport?.height ?? 0,
        },
        rawImages: [],
        rawTables: [],
        rawLinks: [],
        rawPageImage: null,
    };
}
