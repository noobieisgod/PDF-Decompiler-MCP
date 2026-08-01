import {
    IMAGE_DECORATIVE_AREA_RATIO,
    IMAGE_LARGE_AREA_RATIO,
    OCR_MAX_NATIVE_WORDS,
    OCR_MIN_IMAGE_COVERAGE,
    ROUTE_DENSE_TEXT_WORDS,
    ROUTE_LOW_IMAGE_COVERAGE,
    ROUTE_TEXT_DENSITY,
    ROUTE_VISUAL_IMAGE_COVERAGE,
    SCAN_MAX_NATIVE_WORDS,
    SCAN_MIN_IMAGE_COVERAGE,
} from '../config/constants.mjs';
import { getDominantBlockRole, normalizeLooseText } from './text.mjs';
import { estimateTableLikelihood, pageLooksBlank, pageLooksTableHeavy } from './tables.mjs';

function hashString(text) {
    let hash = 2166136261;
    for (let idx = 0; idx < text.length; idx += 1) {
        hash ^= text.charCodeAt(idx);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function getImageCoverage(placements, viewport) {
    if (!placements.size) {
        return 0;
    }
    const pageArea = Math.max(1, viewport.width * viewport.height);
    let covered = 0;
    for (const placement of placements.values()) {
        covered += Math.max(1, placement.w) * Math.max(1, placement.h);
    }
    return Math.min(1, covered / pageArea);
}

export function buildPageProfile(pageNum, bodyItems, textBlocks, imagePlacements, viewport, annotations, strippedByBoilerplate) {
    const joined = bodyItems.map(item => item.str).join(' ').trim();
    const wordCount = joined ? joined.split(/\s+/).length : 0;
    const textChars = joined.length;
    const imageCoverage = getImageCoverage(imagePlacements, viewport);
    const pageArea = Math.max(1, viewport.width * viewport.height);
    const largestImageCoverage = imagePlacements.size
        ? Math.max(...[...imagePlacements.values()].map(placement => (Math.max(1, placement.w) * Math.max(1, placement.h)) / pageArea))
        : 0;
    const tableLikelihood = estimateTableLikelihood(bodyItems);
    const dominantRole = getDominantBlockRole(textBlocks);
    const textDensity = wordCount / Math.max(1, viewport.width * viewport.height);
    const normalizedBlocks = (textBlocks ?? [])
        .map(block => normalizeLooseText(block.text))
        .filter(Boolean);
    return {
        page: pageNum,
        wordCount,
        textChars,
        textDensity,
        imageCoverage,
        largestImageCoverage,
        tableLikelihood,
        dominantRole,
        contentClassHint: dominantRole === 'list'
            ? 'structured_text'
            : imageCoverage >= 0.25
                && largestImageCoverage >= 0.15
                && wordCount > 0
                && wordCount <= 48
                && textDensity < ROUTE_TEXT_DENSITY
                ? 'visual'
                : imageCoverage >= SCAN_MIN_IMAGE_COVERAGE
                    && wordCount <= SCAN_MAX_NATIVE_WORDS
                    && textDensity < (ROUTE_TEXT_DENSITY * 0.5)
                    ? 'scan_like'
                    : 'text',
        annotationsCount: annotations?.length ?? 0,
        pageFingerprint: hashString(normalizedBlocks.join('|') || `${wordCount}|${imagePlacements.size}|${dominantRole}`),
        strippedByBoilerplate,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
    };
}

export function decidePageRouting(profile) {
    if (pageLooksBlank(profile)) {
        return {
            extractionMode: 'filtered',
            routingMode: 'filtered',
            contentClass: 'blank',
            filteredReason: 'Blank page',
        };
    }
    if (pageLooksTableHeavy(profile)) {
        return {
            extractionMode: 'native',
            routingMode: 'native_table_heavy',
            contentClass: 'table',
            filteredReason: null,
        };
    }
    if (profile.contentClassHint === 'visual'
        || (profile.imageCoverage >= ROUTE_VISUAL_IMAGE_COVERAGE
            && profile.largestImageCoverage >= 0.15
            && profile.wordCount > 0
            && profile.wordCount <= OCR_MAX_NATIVE_WORDS
            && profile.textDensity < ROUTE_TEXT_DENSITY
            && profile.dominantRole !== 'list')) {
        return {
            extractionMode: 'visual_fallback',
            routingMode: 'page_visual_fallback',
            contentClass: 'visual',
            filteredReason: null,
        };
    }
    if (profile.contentClassHint === 'scan_like'
        || (profile.wordCount <= SCAN_MAX_NATIVE_WORDS
            && profile.imageCoverage >= SCAN_MIN_IMAGE_COVERAGE
            && profile.textDensity < (ROUTE_TEXT_DENSITY * 0.5))) {
        return {
            extractionMode: 'ocr',
            routingMode: 'page_ocr',
            contentClass: 'scan_like',
            filteredReason: null,
        };
    }
    if (profile.wordCount >= ROUTE_DENSE_TEXT_WORDS
        && profile.imageCoverage <= ROUTE_LOW_IMAGE_COVERAGE
        && profile.textDensity >= ROUTE_TEXT_DENSITY) {
        return {
            extractionMode: 'native',
            routingMode: 'native_text',
            contentClass: 'dense_text',
            filteredReason: null,
        };
    }
    if (profile.imageCoverage >= ROUTE_VISUAL_IMAGE_COVERAGE) {
        return {
            extractionMode: 'native',
            routingMode: 'native_visual_regions',
            contentClass: 'visual',
            filteredReason: null,
        };
    }
    return {
        extractionMode: 'native',
        routingMode: 'native_text',
        contentClass: profile.dominantRole === 'list' ? 'structured_text' : 'text',
        filteredReason: null,
    };
}

export function classifyRegionKind(placement, caption, pageProfile) {
    const pageArea = Math.max(1, pageProfile.viewportWidth * pageProfile.viewportHeight);
    const areaRatio = (placement.w * placement.h) / pageArea;
    if (areaRatio <= IMAGE_DECORATIVE_AREA_RATIO && !caption) {
        return 'decorative';
    }
    if (caption || pageProfile.tableLikelihood >= 0.45 || pageProfile.textDensity >= ROUTE_TEXT_DENSITY) {
        return 'diagram';
    }
    if (areaRatio >= IMAGE_LARGE_AREA_RATIO) {
        return 'photo';
    }
    return 'graphic';
}

export function shouldTryOcr(routing) {
    return routing.routingMode === 'page_ocr';
}

export function getTargetImageDim(regionKind, pageProfile, maxImageDim, caption) {
    const hardMax = maxImageDim ?? 768;
    if (regionKind === 'decorative') {
        return Math.min(hardMax, 224);
    }
    if (regionKind === 'photo') {
        return Math.min(hardMax, 512);
    }
    if (regionKind === 'diagram') {
        return Math.min(hardMax, pageProfile.textDensity >= ROUTE_TEXT_DENSITY || caption ? 1024 : 896);
    }
    return Math.min(hardMax, 640);
}
