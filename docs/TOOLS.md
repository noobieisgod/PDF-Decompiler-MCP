# Tool Reference

Generated input and envelope schemas are in [`schemas/`](../schemas/).

Every tool returns `structuredContent` and a compact JSON text content block. The common envelope contains `schemaVersion`, `operation`, `documentId`, `extractionFingerprint`, `data`, `citations`, `warnings`, `diagnostics`, `omissions`, `budget`, and `nextCursor`.

## `pdf_open`

Accepts a local path or HTTPS source, optional `sourceLabel`, page intervals, OCR policy, refresh flag, image dimension, or partial-decomposition cursor. Every successful call returns a distinct random process-local `sourceId` and safe descriptor, even when identical bytes share the same document ID and canonical generation. A selected subset remains a partial generation until continuation processes every missing page. Continuation requires its original source handle.

## `pdf_document_info`

Returns metadata, outline, page classifications, visual signals, element counts, warnings, decomposition state, cache location and policy, active leases, all active safe source descriptors for the generation, and resource lifetime.

## `pdf_search`

Requires an exact document reference and query. Strategies are `full_text`, `semantic`, and `hybrid`. Filters include pages and element types. Semantic failure emits a warning and returns BM25 results. Cursors bind a digest of the normalized query and arguments without exposing query text.

## `pdf_get_pages`

Accepts page numbers or ranges, `text`, `balanced`, or `fidelity` mode, element inclusion and exclusion overrides, budgets, and a cursor. It returns deterministic elements and a citation for every returned element.

## `pdf_get_element`

Requires `documentId`, `extractionFingerprint`, and `elementId`. The fingerprint is mandatory. Missing or unavailable-generation IDs return `stale_reference`; they never resolve by ordinal in another generation.

## `pdf_render_page`

Renders a full page or bounding box with format `auto`, `png`, or `jpeg`, bounded dimension, image budget, and `imageDelivery`.

- `auto` image delivery returns a resource link because the selected MCP protocol does not negotiate a generic inline-image capability.
- `inline` returns image content only when explicitly requested and within response bytes.
- `resource` returns an immutable read-only URI.
- The compact text block always contains the URI.

Full-page auto format is PNG. A crop on a page classified as visual may use JPEG quality 0.75. Explicit format overrides auto selection.

## `pdf_close`

`pdf_close(sourceId)` releases only the selected handle. With exactly one handle, `sourceId` may be omitted. With multiple handles, omission returns `SOURCE_HANDLE_REQUIRED`. A repeated close returns `SOURCE_HANDLE_ALREADY_CLOSED`; an unknown or foreign-process handle returns `SOURCE_HANDLE_UNKNOWN`. Closing one handle never invalidates another handle sharing the same generation.

The final close prevents new operations, waits for existing operation leases, releases the generation lease, and removes process-local state. Persistent data is retained unless `deleteCache: true`. Deletion fails atomically with `CACHE_GENERATION_IN_USE` while another handle or operation remains.

## Canonical element records

All public bounding boxes are `{ x, y, width, height }` in displayed-page PDF points, with a top-left origin. Link `text` is string or null. Internal link destinations are structured as `named`, `explicit`, or `unresolved` with bounded name, page, x, y, and zoom fields. External URLs and internal destinations are distinct. Annotation elements preserve normalized subtype, text, bbox, author, dates, RGB color, flags, reply relationship, support status, and PDF.js provenance where available.

Page visual signals expose text presence, raster count and coverage, vector paint count and coverage, annotation count, and warnings. Each coverage measurement is labeled `exact`, `approximate`, or `unknown`. Meaningful vector-only pages are not blank. Unknown visual pages expose `visual_unknown` and a deferred generation-bound page visual.

## Parser errors

Malformed input uses one schema-enforced code:

- `PDF_INVALID_SIGNATURE`
- `PDF_TRUNCATED`
- `PDF_INVALID_XREF`
- `PDF_INVALID_STARTXREF`
- `PDF_UNSUPPORTED_ENCRYPTION`
- `PDF_PASSWORD_REQUIRED`
- `PDF_DECOMPRESSION_LIMIT`
- `PDF_PAGE_LIMIT`
- `PDF_PARSER_TIMEOUT`
- `PDF_PARSER_CRASH`
- `PDF_UNSUPPORTED_FEATURE`
- `PDF_MALFORMED_UNKNOWN`

Each code maps to one sanitized category and safe message with retry, password, and configuration-change flags. Raw parser stderr, exception text, stack traces, and local paths are never public fields. Unknown backend errors use `PDF_MALFORMED_UNKNOWN`; worker protocol failures use `PDF_PARSER_CRASH`.

## Resource errors

Resource reads use structured tool or MCP resource errors for `closed_document`, `process_local_resource_expired`, `deleted_generation`, `evicted_generation`, `corrupt_generation`, `stale_extraction_fingerprint`, `cache_generation_missing`, and `missing_asset`. Old URIs are never regenerated under a new fingerprint.

## Default budgets

Defaults are 8,000 estimated text tokens, 1,000,000 response bytes, 20 pages, 200 blocks, 20 tables, 10 figures, 4 renders, and 1,200 image pixels. Hard ceilings are 32,000 tokens, 4,000,000 bytes, 100 pages, 2,000 blocks, 200 tables, 100 figures, 20 renders, and 4,096 pixels. Oversized items are omitted and reported.

Text estimates use UTF-8 bytes divided by four. Image estimates use pixels divided by 750. Both are advisory and are named in results.
