export const ROW_Y_TOLERANCE = 4;
export const COL_X_TOLERANCE = 6;
export const TABLE_MIN_ROWS = 2;
export const TABLE_MIN_COLS = 2;
export const TABLE_MIN_COV = 0.6;
export const SCAN_MAX_NATIVE_WORDS = 10;
export const SCAN_MIN_IMAGE_COVERAGE = 0.70;
export const CAPTION_MAX_DIST = 42;
export const HEADER_ZONE_PT = 60;
export const FOOTER_ZONE_PT = 60;
export const HF_Y_BUCKET = 5;
export const HF_MIN_PAGES = 2;
export const HF_MIN_RATIO = 0.40;
export const HF_MAX_WORDS = 10;
export const ROUTE_TABLE_LIKELIHOOD = 0.45;
export const ROUTE_DENSE_TEXT_WORDS = 120;
export const ROUTE_LOW_IMAGE_COVERAGE = 0.08;
export const ROUTE_VISUAL_IMAGE_COVERAGE = 0.18;
export const ROUTE_TEXT_DENSITY = 0.00022;
export const IMAGE_DECORATIVE_AREA_RATIO = 0.015;
export const IMAGE_LARGE_AREA_RATIO = 0.20;
export const DEDUP_SIMILARITY_MIN_HASH_MATCH = Number(process.env.PDF_DEDUP_SIMILARITY_MIN_HASH_MATCH ?? 80);
export const DEDUP_SIMILARITY_MAX_DIM_DELTA_RATIO = Number(process.env.PDF_DEDUP_SIMILARITY_MAX_DIM_DELTA_RATIO ?? 0.12);
export const DEDUP_SIMILARITY_MAX_AREA_DELTA_RATIO = Number(process.env.PDF_DEDUP_SIMILARITY_MAX_AREA_DELTA_RATIO ?? 0.18);
export const DEDUP_SIMILARITY_MAX_ASPECT_DELTA = Number(process.env.PDF_DEDUP_SIMILARITY_MAX_ASPECT_DELTA ?? 0.08);
export const DEDUP_SIMILARITY_MAX_AREA_RATIO = Number(process.env.PDF_DEDUP_SIMILARITY_MAX_AREA_RATIO ?? 0.08);
export const OCR_MAX_NATIVE_WORDS = 24;
export const OCR_MIN_IMAGE_COVERAGE = 0.08;
export const OCR_MIN_WORDS = 6;
export const OCR_MIN_CHARS = 25;
export const OCR_MIN_ALNUM_RATIO = 0.30;
export const OCR_MAX_REPEATED_RATIO = 0.50;
export const OCR_MIN_WORDLIKE_RATIO = 0.45;
export const OCR_MAX_SYMBOL_HEAVY_RATIO = 0.35;
export const OCR_MAX_SHORT_TOKEN_RATIO = 0.55;
export const OCR_MAX_CORRUPTED_LINE_RATIO = 0.5;
export const OCR_MIN_MEAN_CONFIDENCE = 70;
export const OCR_LOW_CONFIDENCE_THRESHOLD = 50;
export const OCR_MAX_LOW_CONFIDENCE_RATIO = 0.25;
export const PAGE_LOAD_CHUNK_SIZE = Number(process.env.PDF_PAGE_LOAD_CHUNK_SIZE ?? 1);
export const PAGE_PROCESS_CHUNK_SIZE = Number(process.env.PDF_PAGE_PROCESS_CHUNK_SIZE ?? 1);
export const EXTRACTION_TIME_BUDGET_MS = Number(process.env.PDF_EXTRACT_BUDGET_MS ?? 50000);
export const REMOTE_FETCH_TIMEOUT_MS = Number(process.env.PDF_REMOTE_FETCH_TIMEOUT_MS ?? 15000);
export const MAX_FETCH_REDIRECTS = Number(process.env.PDF_REMOTE_FETCH_REDIRECTS ?? 5);
export const DEBUG_TIMING = process.env.PDF_EXTRACT_DEBUG_TIMING === '1';
export const DEBUG_RENDER = process.env.PDF_EXTRACT_DEBUG_RENDER === '1';
export const MIN_VISIBLE_PIXEL_RATIO = Number(process.env.PDF_MIN_VISIBLE_PIXEL_RATIO ?? 0.002);
export const MIN_OPAQUE_PIXEL_RATIO = Number(process.env.PDF_MIN_OPAQUE_PIXEL_RATIO ?? 0.01);
export const JPEG_OUTPUT_QUALITY = Number(process.env.PDF_JPEG_OUTPUT_QUALITY ?? 0.75);
export const MIN_ENCODED_BYTES_FOR_CROP = Number(process.env.PDF_MIN_ENCODED_BYTES_FOR_CROP ?? process.env.PDF_MIN_PNG_BYTES_FOR_CROP ?? 700);
export const MIN_ENCODED_BYTES_FOR_PAGE = Number(process.env.PDF_MIN_ENCODED_BYTES_FOR_PAGE ?? process.env.PDF_MIN_PNG_BYTES_FOR_PAGE ?? 2500);
// Internal layout heuristics. They are intentionally tunable and are not public schema contracts.
export const MIN_COLUMN_GUTTER_PT = Number(process.env.PDF_MIN_COLUMN_GUTTER_PT ?? 18);
export const MIN_COLUMN_GUTTER_LINE_COUNT = Number(process.env.PDF_MIN_COLUMN_GUTTER_LINE_COUNT ?? 3);
export const MIN_COLUMN_GUTTER_PAGE_HEIGHT_RATIO = Number(process.env.PDF_MIN_COLUMN_GUTTER_PAGE_HEIGHT_RATIO ?? 0.25);
export const SPANNING_BLOCK_WIDTH_RATIO = Number(process.env.PDF_SPANNING_BLOCK_WIDTH_RATIO ?? 0.70);
export const LINK_ANCHOR_MIN_SPAN_OVERLAP_RATIO = Number(process.env.PDF_LINK_ANCHOR_MIN_SPAN_OVERLAP_RATIO ?? 0.50);
export const LINK_ANCHOR_BOUNDARY_EPSILON_PT = Number(process.env.PDF_LINK_ANCHOR_BOUNDARY_EPSILON_PT ?? 0.25);
export const LINK_ANCHOR_MAX_SAME_LINE_GAP_PT = Number(process.env.PDF_LINK_ANCHOR_MAX_SAME_LINE_GAP_PT ?? 4);
export const LINK_ANCHOR_MAX_COMPONENT_SCORE_DELTA = Number(process.env.PDF_LINK_ANCHOR_MAX_COMPONENT_SCORE_DELTA ?? 0.10);
export const VECTOR_MIXED_REGION_RATIO = Number(process.env.PDF_VECTOR_MIXED_REGION_RATIO ?? 0.01);
export const VECTOR_MIXED_AGGREGATE_RATIO = Number(process.env.PDF_VECTOR_MIXED_AGGREGATE_RATIO ?? 0.02);

export function debugTiming(...parts) {
    if (!DEBUG_TIMING) {
        return;
    }
    console.error('[timing]', ...parts);
}

export function debugRender(...parts) {
    if (!DEBUG_RENDER) {
        return;
    }
    console.error('[render]', ...parts);
}
