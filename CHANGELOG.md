# Changelog

## 3.0.0

- Renamed Lightweight PDF MCP for Claude AI to PDF Decompiler MCP.
- Replaced the one-call `extract_pdf_content` interface with seven composable tools.
- Added exact extraction generations, canonical records, citations, immutable resources, hard budgets, signed cursors, partial decomposition, content-addressed cache, BM25, and optional pinned semantic retrieval.
- Changed local-file access from permissive behavior to deny-by-default allow roots with real-path enforcement.
- Added persistent, ephemeral, and no-cache lifecycle modes.
- Migrated to the official MCP TypeScript SDK v2 packages and Node.js 22 or 24.
- Added npm and MCPB inspection, generated schemas, an SPDX SBOM, checksums, security tests, cross-platform CI, and complete migration documentation.

Historical Git tags retain their original contents and names.
