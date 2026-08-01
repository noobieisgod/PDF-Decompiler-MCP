# Changelog

## 3.0.0

- Renamed Lightweight PDF MCP for Claude AI to PDF Decompiler MCP.
- Replaced the one-call `extract_pdf_content` interface with seven composable tools.
- Added exact extraction generations, canonical records, citations, immutable resources, hard budgets, signed cursors, partial decomposition, content-addressed cache, BM25, and optional pinned semantic retrieval.
- Changed local-file access from permissive behavior to deny-by-default allow roots with real-path enforcement.
- Added persistent, ephemeral, and no-cache lifecycle modes.
- Migrated to the official MCP TypeScript SDK v2 packages and Node.js 22 or 24.
- Added npm and MCPB inspection, generated schemas, an SPDX SBOM, checksums, security tests, cross-platform CI, and complete migration documentation.
- Added canonical format version 2 and extraction revision 2 with displayed-page geometry, structured internal destinations, normalized annotation metadata, and explicit public output schemas.
- Added bounded raster and vector operator analysis, approximate or unknown coverage labels, deferred generation-bound page visuals, and real table, image, column, rotation, link, annotation, malformed, encrypted, and OCR fixtures.
- Added enumerated sanitized parser failures and top-level worker containment for rejection, exception, timeout, crash, missing output, malformed output, and stderr noise.
- Added independent process-local source handles, safe descriptors, operation leases, atomic active-generation deletion checks, and opt-in sanitized close timing.
- Made Windows Node.js 22 and 24 the blocking CI matrix; macOS, Linux, and remote Linux OCR jobs remain best-effort until executed successfully.

Historical Git tags retain their original contents and names.
