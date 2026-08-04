# Changelog

## Unreleased

- Added a `doctor` command and server-level text-first workflow instructions.
- Added two licensed real-world evaluation PDFs plus an external, checksum-recorded TSMC annual-report sample.
- Separated blocking Windows CI from visible best-effort macOS, Linux, and Linux OCR status.
- Simplified the README opening and added copyable desktop-client configuration.

## 3.0.0

- Renamed Lightweight PDF MCP for Claude AI to PDF Decompiler MCP.
- Replaced the one-call `extract_pdf_content` interface with seven composable tools.
- Added exact extraction generations, canonical records, citations, immutable resources, hard budgets, signed cursors, partial decomposition, content-addressed cache, BM25, and optional pinned semantic retrieval.
- Changed local-file access from permissive behavior to deny-by-default allow roots with real-path enforcement.
- Added persistent, ephemeral, and no-cache lifecycle modes.
- Migrated to the official MCP TypeScript SDK v2 packages and Node.js 22 or 24.
- Added npm and MCPB inspection, generated schemas, an SPDX SBOM, checksums, security tests, cross-platform CI, and complete migration documentation.
- Added canonical format version 3 and extraction revision 3 with displayed-page geometry, structured internal destinations, normalized annotation metadata, semantic heading, list, and code blocks, OCR source relationships, and explicit public output schemas.
- Added bounded raster and vector operator analysis, approximate or unknown coverage labels, deferred generation-bound page visuals, and real table, image, column, rotation, link, annotation, malformed, encrypted, and OCR fixtures.
- Added deterministic Markdown projection without another extraction backend. Paged Markdown is budgeted once in structured content, while complete generation-bound exports use full tables, atomic cache publication, checksums, independent serializer fingerprints, and hard generation limits.
- Added one-based inclusive table slicing with resumable signed cursors, repeated header context, and canonical cell identity.
- Added fair round-robin multi-page budgeting, grouped BM25 context, warning deduplication, and separate document, requested-scope, and retrieval completion fields.
- Fixed required OCR for native pages containing raster text, table-of-contents false positives, and prototype-named BM25 terms.
- Corrected textual and spread-table recovery, section-bounded column order, OCR confidence and provenance, cursor-only page continuation, open completion semantics, and independent complete-response byte and token enforcement under canonical format 4.
- Added enumerated sanitized parser failures and top-level worker containment for rejection, exception, timeout, crash, missing output, malformed output, and stderr noise.
- Added independent process-local source handles, safe descriptors, operation leases, atomic active-generation deletion checks, and opt-in sanitized close timing.
- Made Windows Node.js 22 and 24 the blocking CI matrix; macOS, Linux, and remote Linux OCR jobs remain best-effort until executed successfully.

Historical Git tags retain their original contents and names.
