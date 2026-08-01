import {
    DEDUP_SIMILARITY_MAX_AREA_DELTA_RATIO,
    DEDUP_SIMILARITY_MAX_AREA_RATIO,
    DEDUP_SIMILARITY_MAX_ASPECT_DELTA,
    DEDUP_SIMILARITY_MAX_DIM_DELTA_RATIO,
    DEDUP_SIMILARITY_MIN_HASH_MATCH,
    EXTRACTION_TIME_BUDGET_MS,
    HF_MIN_PAGES,
    HF_MIN_RATIO,
    PAGE_LOAD_CHUNK_SIZE,
    PAGE_PROCESS_CHUNK_SIZE,
    debugTiming,
} from '../config/constants.mjs';
import { openDocumentBackend } from '../backend/document-backend.mjs';
import { collectHFKeyPages, collectHFSamples } from './headers-footers.mjs';
import { hashMatchScore } from './images.mjs';
import { buildPageErrorResult, processOnePage } from './page-processor.mjs';

function ratioDelta(a, b) {
    return Math.abs(a - b) / Math.max(1, Math.max(a, b));
}
function getImageAreaRatio(image, page) {
    const bbox = image.bbox;
    const pageWidth = page.pageProfile?.viewportWidth ?? 0;
    const pageHeight = page.pageProfile?.viewportHeight ?? 0;
    if (!bbox || !pageWidth || !pageHeight || !bbox.width || !bbox.height) {
        return null;
    }
    return (bbox.width * bbox.height) / Math.max(1, pageWidth * pageHeight);
}

function getRawImageAreaRatio(image, pageProfile) {
    const bbox = image.bbox;
    const pageWidth = pageProfile?.viewportWidth ?? 0;
    const pageHeight = pageProfile?.viewportHeight ?? 0;
    if (!bbox || !pageWidth || !pageHeight || !bbox.width || !bbox.height) {
        return null;
    }
    return (bbox.width * bbox.height) / Math.max(1, pageWidth * pageHeight);
}

function getFooterBandRatio(image, pageProfile) {
    const bbox = image.bbox;
    const pageHeight = pageProfile?.viewportHeight ?? 0;
    if (!bbox || !pageHeight) {
        return null;
    }
    return (bbox.y + bbox.height) / Math.max(1, pageHeight);
}

function isRepeatedFooterArtifactCandidate(image, pageProfile) {
    if (!image?.sourceName) {
        return false;
    }
    const areaRatio = getRawImageAreaRatio(image, pageProfile);
    const footerBandRatio = getFooterBandRatio(image, pageProfile);
    const width = image.width ?? image.renderDebug?.directPrimaryMetrics?.width ?? image.bbox?.width ?? 0;
    const height = image.height ?? image.renderDebug?.directPrimaryMetrics?.height ?? image.bbox?.height ?? 0;
    return footerBandRatio != null
        && footerBandRatio >= 0.88
        && areaRatio != null
        && areaRatio <= 0.04
        && width <= 180
        && height <= 150;
}

function suppressRepeatedFooterArtifacts(rawPageResults) {
    const repeatedSources = new Map();
    for (const raw of rawPageResults) {
        for (const image of raw.rawImages ?? []) {
            if (!isRepeatedFooterArtifactCandidate(image, raw.pageProfile)) {
                continue;
            }
            repeatedSources.set(image.sourceName, (repeatedSources.get(image.sourceName) ?? 0) + 1);
        }
    }
    const suppressedSources = new Set(
        [...repeatedSources.entries()]
            .filter(([, count]) => count >= 4)
            .map(([sourceName]) => sourceName),
    );
    if (suppressedSources.size === 0) {
        return;
    }
    for (const raw of rawPageResults) {
        const keptImages = [];
        for (let idx = 0; idx < raw.rawImages.length; idx += 1) {
            const image = raw.rawImages[idx];
            if (suppressedSources.has(image.sourceName) && isRepeatedFooterArtifactCandidate(image, raw.pageProfile)) {
                raw.text = raw.text.replaceAll(`[IMG_LOCAL_${idx}]`, '');
                continue;
            }
            keptImages.push(image);
        }
        raw.rawImages = keptImages;
        raw.text = raw.text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n');
    }
}

function suppressRepeatedFooterArtifactsFromResults(results) {
    const repeatedSources = new Map();
    for (const page of results) {
        for (const image of page.images) {
            if (!isRepeatedFooterArtifactCandidate(image, page.pageProfile)) {
                continue;
            }
            repeatedSources.set(image.sourceName, (repeatedSources.get(image.sourceName) ?? 0) + 1);
        }
    }
    const suppressedSources = new Set(
        [...repeatedSources.entries()]
            .filter(([, count]) => count >= 4)
            .map(([sourceName]) => sourceName),
    );
    if (suppressedSources.size === 0) {
        return;
    }
    for (const page of results) {
        page.images = page.images.filter((image) => {
            const suppress = suppressedSources.has(image.sourceName) && isRepeatedFooterArtifactCandidate(image, page.pageProfile);
            if (suppress) {
                page.text = page.text.replaceAll(`[${image.id}]`, '');
            }
            return !suppress;
        });
        page.text = page.text
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n');
    }
}

function initializeDedupDebug(pages) {
    for (const page of pages) {
        for (const image of page.images) {
            image.dedupMethod = image.dedupMethod ?? null;
            image.dedupMatch = image.dedupMatch ?? null;
            image.dedupDebug = image.dedupDebug ?? {
                areaRatio: null,
                similarityEligible: false,
                consideredCandidates: [],
                rejectionReasons: [],
            };
        }
    }
}

function collectImagesWithContext(pages) {
    const entries = [];
    for (const page of pages) {
        for (const image of page.images) {
            const areaRatio = getImageAreaRatio(image, page);
            image.dedupDebug.areaRatio = areaRatio;
            image.dedupDebug.similarityEligible = false;
            image.dedupDebug.consideredCandidates = [];
            image.dedupDebug.rejectionReasons = [];
            entries.push({ page, image, areaRatio });
        }
    }
    return entries;
}

function dedupImagesByExactPayload(pages) {
    initializeDedupDebug(pages);
    const seenPayloads = new Map();
    for (const { image } of collectImagesWithContext(pages)) {
        if (!image.data) {
            continue;
        }
        const existingId = seenPayloads.get(image.data);
        if (existingId) {
            image.dedupRef = existingId;
            image.dedupMethod = 'exact';
            image.dedupMatch = { matchedId: existingId };
            image.dedupDebug.consideredCandidates.push({
                id: existingId,
                method: 'exact',
                accepted: true,
            });
            image.data = null;
            continue;
        }
        seenPayloads.set(image.data, image.id);
    }
}

function canSimilarityDedup(entry) {
    if (!entry.image.data) {
        return false;
    }
    if (!entry.image.hashBits) {
        entry.image.dedupDebug.rejectionReasons.push('missing_hash_bits');
        return false;
    }
    if (entry.image.fallbackNeeded) {
        entry.image.dedupDebug.rejectionReasons.push('fallback_image');
        return false;
    }
    if ((entry.areaRatio ?? 1) > DEDUP_SIMILARITY_MAX_AREA_RATIO) {
        return false;
    }
    entry.image.dedupDebug.similarityEligible = true;
    return true;
}

function compareSimilarityCandidate(entry, candidate) {
    if (entry.image.mimeType !== candidate.image.mimeType) {
        return { accepted: false, reason: 'mime_type_mismatch' };
    }
    const widthDelta = ratioDelta(entry.image.width, candidate.image.width);
    if (widthDelta > DEDUP_SIMILARITY_MAX_DIM_DELTA_RATIO) {
        return { accepted: false, reason: 'width_delta_too_large', widthDelta };
    }
    const heightDelta = ratioDelta(entry.image.height, candidate.image.height);
    if (heightDelta > DEDUP_SIMILARITY_MAX_DIM_DELTA_RATIO) {
        return { accepted: false, reason: 'height_delta_too_large', heightDelta };
    }
    const areaDelta = ratioDelta(
        (entry.image.width ?? 0) * (entry.image.height ?? 0),
        (candidate.image.width ?? 0) * (candidate.image.height ?? 0),
    );
    if (areaDelta > DEDUP_SIMILARITY_MAX_AREA_DELTA_RATIO) {
        return { accepted: false, reason: 'area_delta_too_large', areaDelta };
    }
    const aspectDelta = Math.abs((entry.image.width / Math.max(1, entry.image.height)) - (candidate.image.width / Math.max(1, candidate.image.height)));
    if (aspectDelta > DEDUP_SIMILARITY_MAX_ASPECT_DELTA) {
        return { accepted: false, reason: 'aspect_delta_too_large', aspectDelta };
    }
    const hashScore = hashMatchScore(entry.image.hashBits, candidate.image.hashBits);
    if (hashScore < DEDUP_SIMILARITY_MIN_HASH_MATCH) {
        return { accepted: false, reason: 'hash_score_too_low', hashScore };
    }
    return {
        accepted: true,
        hashScore,
        widthDelta,
        heightDelta,
        areaDelta,
        aspectDelta,
    };
}

function dedupImagesBySimilarity(pages) {
    const entries = collectImagesWithContext(pages);
    const kept = [];
    for (const entry of entries) {
        if (!entry.image.data || entry.image.dedupMethod === 'exact') {
            continue;
        }
        if (!canSimilarityDedup(entry)) {
            if (!entry.image.dedupDebug.rejectionReasons.length) {
                entry.image.dedupDebug.rejectionReasons.push('not_similarity_eligible');
            }
            kept.push(entry);
            continue;
        }
        let best = null;
        for (const candidate of kept) {
            if (!candidate.image.data || !canSimilarityDedup(candidate)) {
                continue;
            }
            const comparison = compareSimilarityCandidate(entry, candidate);
            entry.image.dedupDebug.consideredCandidates.push({
                id: candidate.image.id,
                method: 'similarity',
                accepted: comparison.accepted,
                reason: comparison.reason ?? null,
                hashScore: comparison.hashScore ?? null,
            });
            if (!comparison.accepted) {
                continue;
            }
            if (!best || comparison.hashScore > best.comparison.hashScore) {
                best = { candidate, comparison };
            }
        }
        if (best) {
            entry.image.dedupRef = best.candidate.image.id;
            entry.image.dedupMethod = 'similarity';
            entry.image.dedupMatch = {
                matchedId: best.candidate.image.id,
                hashScore: best.comparison.hashScore,
                widthDelta: best.comparison.widthDelta,
                heightDelta: best.comparison.heightDelta,
                areaDelta: best.comparison.areaDelta,
                aspectDelta: best.comparison.aspectDelta,
            };
            entry.image.data = null;
            continue;
        }
        entry.image.dedupDebug.rejectionReasons.push('no_similarity_match_found');
        kept.push(entry);
    }
}

async function tryLoadPageData(documentBackend, pageNum) {
    try {
        return await documentBackend.loadPageData(pageNum);
    } catch (err) {
        return { pageNum, error: err };
    }
}

function buildLoadErrorResult(pageNum, err) {
    return {
        page: pageNum,
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
            page: pageNum,
            wordCount: 0,
            textChars: 0,
            textDensity: 0,
            imageCoverage: 0,
            tableLikelihood: 0,
            dominantRole: 'text',
            contentClassHint: 'text',
            annotationsCount: 0,
            viewportWidth: 0,
            viewportHeight: 0,
        },
        rawImages: [],
        rawTables: [],
        rawLinks: [],
        rawPageImage: null,
    };
}

export async function extractPageContent(pdfBytes, requestedPages, maxImageDim, options = {}) {
    const startedAt = Date.now();
    debugTiming('extract:start', `bytes=${pdfBytes.length}`);
    const documentBackend = await openDocumentBackend(pdfBytes, { preferredBackend: 'hybrid' });
    debugTiming('extract:getDocument', `${Date.now() - startedAt}ms`);
    const totalPages = documentBackend.getTotalPages();
    if (totalPages > (options.maxPages ?? 5000)) {
        await documentBackend.close?.();
        throw new Error(`Document page count ${totalPages} exceeds limit ${options.maxPages ?? 5000}`);
    }
    const timeBudgetMs = options.timeBudgetMs ?? EXTRACTION_TIME_BUDGET_MS;
    let pageNums;
    if (!requestedPages || requestedPages.length === 0) {
        pageNums = Array.from({ length: totalPages }, (_, idx) => idx + 1);
    } else {
        const set = new Set();
        for (const interval of requestedPages) {
            const start = Math.max(1, interval.start ?? 1);
            const end = Math.min(totalPages, interval.end ?? totalPages);
            for (let page = start; page <= end; page += 1) {
                set.add(page);
            }
        }
        pageNums = [...set].sort((a, b) => a - b);
    }
    const requestedPageCount = pageNums.length;
    const [docMetadata, docOutline] = await Promise.all([
        documentBackend.getMetadata(),
        documentBackend.getOutline(),
    ]);
    debugTiming('extract:metadata-outline', `${Date.now() - startedAt}ms`);

    const extractionStartMs = Date.now();
    const keyPages = new Map();
    let timedOut = false;
    let nextPage = null;
    for (let idx = 0; idx < pageNums.length; idx += PAGE_LOAD_CHUNK_SIZE) {
        if (Date.now() - extractionStartMs > timeBudgetMs) {
            timedOut = true;
            nextPage = pageNums[idx] ?? null;
            break;
        }
        const chunkPageNums = pageNums.slice(idx, idx + PAGE_LOAD_CHUNK_SIZE);
        const chunkPageData = await Promise.all(chunkPageNums.map(pageNum => tryLoadPageData(documentBackend, pageNum)));
        debugTiming('extract:hf-pass', `pages=${chunkPageNums.join(',')}`, `${Date.now() - startedAt}ms`);
        for (const pageData of chunkPageData) {
            if (pageData.error) {
                continue;
            }
            collectHFKeyPages(pageData.rawItems, pageData.pageHeight, pageData.pageNum, keyPages);
            pageData.pdfjsPage?.cleanup?.();
        }
        if (Date.now() - extractionStartMs > timeBudgetMs && idx + PAGE_LOAD_CHUNK_SIZE < pageNums.length) {
            timedOut = true;
            nextPage = pageNums[idx + PAGE_LOAD_CHUNK_SIZE] ?? null;
            break;
        }
    }

    const hfPositions = timedOut ? new Set() : (() => {
        const minPages = Math.max(HF_MIN_PAGES, Math.ceil(pageNums.length * HF_MIN_RATIO));
        const result = new Set();
        for (const [key, pages] of keyPages) {
            if (pages.size >= minPages) {
                result.add(key);
            }
        }
        return result;
    })();

    const hfHeaderSamples = new Set();
    const hfFooterSamples = new Set();
    let hfHasPageNums = false;
    const rawPageResults = [];
    let decompressedBytes = 0;
    const processUntil = timedOut && nextPage != null ? pageNums.indexOf(nextPage) : pageNums.length;
    for (let idx = 0; idx < processUntil; idx += PAGE_PROCESS_CHUNK_SIZE) {
        if (Date.now() - extractionStartMs > timeBudgetMs && rawPageResults.length > 0) {
            timedOut = true;
            nextPage = pageNums[idx] ?? null;
            break;
        }
        const chunkPageNums = pageNums.slice(idx, Math.min(idx + PAGE_PROCESS_CHUNK_SIZE, processUntil));
        const chunk = await Promise.all(chunkPageNums.map(pageNum => tryLoadPageData(documentBackend, pageNum)));
        debugTiming('extract:process-load', `pages=${chunkPageNums.join(',')}`, `${Date.now() - startedAt}ms`);
        if (hfPositions.size > 0) {
            for (const pageData of chunk) {
                if (pageData.error) {
                    continue;
                }
                if (collectHFSamples(pageData.rawItems, pageData.pageHeight, hfPositions, hfHeaderSamples, hfFooterSamples)) {
                    hfHasPageNums = true;
                }
            }
        }
        const remainingBudgetMs = timeBudgetMs - (Date.now() - extractionStartMs);
        const budgetStillAvailable = remainingBudgetMs > 0;
        const pageOptions = {
            allowImageRendering: true,
            allowOcr: budgetStillAvailable && options.ocrPolicy !== 'off',
            allowVisualFallback: false,
        };
        const chunkResults = await Promise.all(chunk.map(async (pageData) => {
            if (pageData.error) {
                return buildLoadErrorResult(pageData.pageNum, pageData.error);
            }
            try {
                return await processOnePage(pageData, hfPositions, maxImageDim, pageOptions);
            } catch (err) {
                return buildPageErrorResult(pageData, err);
            }
        }));
        debugTiming('extract:process-done', `pages=${chunkPageNums.join(',')}`, `${Date.now() - startedAt}ms`);
        rawPageResults.push(...chunkResults);
        decompressedBytes += Buffer.byteLength(JSON.stringify(chunkResults));
        if (decompressedBytes > (options.maxDecompressedBytes ?? 512 * 1024 * 1024)) {
            await documentBackend.destroy();
            throw new Error(`Decompressed page output exceeded limit ${options.maxDecompressedBytes ?? 512 * 1024 * 1024}`);
        }
        if (Date.now() - extractionStartMs > timeBudgetMs && idx + PAGE_PROCESS_CHUNK_SIZE < processUntil) {
            timedOut = true;
            nextPage = pageNums[idx + PAGE_PROCESS_CHUNK_SIZE] ?? null;
            break;
        }
    }

    suppressRepeatedFooterArtifacts(rawPageResults);

    let globalImageIdx = 1;
    let globalTableIdx = 1;
    let globalPageImageIdx = 1;
    let globalLinkIdx = 1;
    const results = [];
    for (const raw of rawPageResults) {
        const imageIdMap = new Map();
        const imageResults = [];
        for (let idx = 0; idx < raw.rawImages.length; idx += 1) {
            const img = raw.rawImages[idx];
            const id = `IMAGE_${globalImageIdx++}`;
            imageIdMap.set(idx, id);
            imageResults.push({
                id,
                width: img.width,
                height: img.height,
                data: img.data,
                mimeType: img.mimeType,
                hashBits: img.hashBits ?? null,
                fallbackNeeded: img.fallbackNeeded,
                fallbackReason: img.fallbackReason,
                bbox: img.bbox,
                caption: img.caption,
                dedupRef: null,
                dedupMethod: null,
                dedupMatch: null,
                dedupDebug: null,
                regionKind: img.regionKind,
                sourceName: img.sourceName ?? null,
                placementId: img.placementId ?? null,
                renderDebug: img.renderDebug ?? null,
                extractionMethod: img.extractionMethod ?? 'failed',
            });
        }

        const tableIdMap = new Map();
        const tableResults = [];
        for (let idx = 0; idx < raw.rawTables.length; idx += 1) {
            const id = `TABLE_${globalTableIdx++}`;
            tableIdMap.set(idx, id);
            tableResults.push({ id, data: raw.rawTables[idx].rows, bbox: raw.rawTables[idx].bbox });
        }

        const annotations = (raw.annotations ?? []).map(annotation => ({ ...annotation }));
        let pageImage = null;
        let pageImageId = null;
        if (raw.rawPageImage) {
            pageImageId = `PAGE_IMAGE_${globalPageImageIdx++}`;
            pageImage = { id: pageImageId, ...raw.rawPageImage };
        }

        let text = raw.text;
        for (const [localIdx, id] of imageIdMap) {
            text = text.replaceAll(`[IMG_LOCAL_${localIdx}]`, `[${id}]`);
        }
        for (const [localIdx, id] of tableIdMap) {
            text = text.replaceAll(`[TBL_LOCAL_${localIdx}]`, `[${id}]`);
        }

        const linkResults = [];
        for (let idx = 0; idx < (raw.rawLinks?.length ?? 0); idx += 1) {
            const rawLink = raw.rawLinks[idx];
            const id = `LINK_${globalLinkIdx++}`;
            text = text.replaceAll(`[${rawLink.localId}]`, `[${id}]`);
            for (const annotation of annotations) {
                if (annotation.localId === rawLink.localId) {
                    annotation.finalId = id;
                }
            }
            linkResults.push({ id, url: rawLink.url, anchored: rawLink.anchored });
        }
        if (pageImageId) {
            text = text.replace('[PAGE_IMAGE_LOCAL_0]', `[${pageImageId}]`);
        }

        results.push({
            page: raw.page,
            extractionMode: raw.extractionMode,
            routingMode: raw.routingMode,
            contentClass: raw.contentClass,
            fallbackReason: raw.fallbackReason,
            filteredReason: raw.filteredReason,
            ocrAttempted: raw.ocrAttempted,
            ocrAccepted: raw.ocrAccepted,
            ocrReason: raw.ocrReason,
            text,
            images: imageResults,
            tables: tableResults,
            pageImage,
            links: linkResults,
            annotations,
            pageProfile: raw.pageProfile,
        });
    }

    suppressRepeatedFooterArtifactsFromResults(results);
    dedupImagesByExactPayload(results);
    dedupImagesBySimilarity(results);

    await documentBackend.destroy();
    debugTiming('extract:done', `${Date.now() - startedAt}ms`);
    return {
        totalPages,
        requestedPages: requestedPageCount,
        metadata: docMetadata,
        outline: docOutline,
        strippedHF: {
            headers: [...hfHeaderSamples],
            footers: [...hfFooterSamples],
            hasPageNums: hfHasPageNums,
        },
        partial: timedOut ? {
            timedOut: true,
            nextPage,
            processedPages: results.length,
            remainingPages: Math.max(0, requestedPageCount - results.length),
        } : null,
        pages: results,
    };
}
