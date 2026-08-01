# Tool Reference

Generated input and envelope schemas are in [`schemas/`](../schemas/).

Every tool returns `structuredContent` and a compact JSON text content block. The common envelope contains `schemaVersion`, `operation`, `documentId`, `extractionFingerprint`, `data`, `citations`, `warnings`, `diagnostics`, `omissions`, `budget`, and `nextCursor`.

## `pdf_open`

Accepts a local path or HTTPS source, optional page intervals, OCR policy, refresh flag, image dimension, or partial-decomposition cursor. It returns the exact document and extraction generation, processed-page count, completion state, cache status, diagnostics, and cursor. A selected subset remains a partial generation until continuation processes every missing page.

## `pdf_document_info`

Returns metadata, outline, page classifications, element counts, warnings, decomposition state, cache location and policy, active leases, and resource lifetime.

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

Releases one open reference. The final close removes process-local state. Persistent data is retained unless `deleteCache: true`. Active generation leases prevent deletion until operations finish.

## Resource errors

Resource reads use structured tool or MCP resource errors for `closed_document`, `process_local_resource_expired`, `deleted_generation`, `evicted_generation`, `corrupt_generation`, `stale_extraction_fingerprint`, `cache_generation_missing`, and `missing_asset`. Old URIs are never regenerated under a new fingerprint.

## Default budgets

Defaults are 8,000 estimated text tokens, 1,000,000 response bytes, 20 pages, 200 blocks, 20 tables, 10 figures, 4 renders, and 1,200 image pixels. Hard ceilings are 32,000 tokens, 4,000,000 bytes, 100 pages, 2,000 blocks, 200 tables, 100 figures, 20 renders, and 4,096 pixels. Oversized items are omitted and reported.

Text estimates use UTF-8 bytes divided by four. Image estimates use pixels divided by 750. Both are advisory and are named in results.
