# PDF Decompiler MCP

PDF Decompiler MCP is a local-first Model Context Protocol server for bounded, cited PDF decomposition and selective retrieval. It converts an exact PDF byte stream into authoritative canonical JSON containing pages, semantic text blocks, tables and cells, figures, links, annotations, metadata, outlines, OCR relationships, and on-demand renders. Markdown is a deterministic projection of that model, not a separate extraction backend.

## Requirements

- Node.js 22 or 24.
- Windows 10/11 (Older versions remain untested)
- npm 10 or newer.
- Optional Tesseract executable on `PATH` for OCR.
- Optional `@huggingface/transformers@4.2.0` peer dependency for semantic retrieval.

IMPORTANT: I do not have a Apple or Linux machine to validate macOS and Linux compatibility, so use at your own risk!

Node.js 18 and 20 are not supported. The server uses the stable MCP TypeScript SDK v2 packages, pinned at 2.0.0, whose server package requires Node.js 20 or newer. This project deliberately tests and supports the active Node.js 22 and 24 release lines.

## Install from source

```powershell
git clone https://github.com/noobieisgod/PDF-Decompiler-MCP.git
cd PDF-Decompiler-MCP
npm ci
npm test
node src/index.mjs --allow-root C:\path\to\pdfs
```

The server uses stdio. Protocol messages are written to stdout and diagnostics are restricted to stderr.

## Seven composable tools

| Tool | Purpose |
|---|---|
| `pdf_open` | Validate, decompose, index, resume, or load an exact PDF generation. |
| `pdf_document_info` | Report metadata, decomposition, diagnostics, cache state, leases, and resource lifetime. |
| `pdf_search` | Search with deterministic BM25, optional semantic retrieval, or reciprocal-rank fusion. |
| `pdf_get_pages` | Return selected cited elements as structured data or Markdown in text, balanced, or fidelity mode under explicit budgets. |
| `pdf_get_element` | Resolve one element, including bounded table slices, only in its expected extraction generation. |
| `pdf_render_page` | Render a bounded page or crop as PNG or JPEG, returned inline only by explicit request. |
| `pdf_close` | Release an open document and optionally delete its persistent generation. |

Every successful tool result uses the same structured envelope:

```json
{
  "schemaVersion": "3.0.0",
  "operation": "pdf_search",
  "documentId": "doc_<sha256>",
  "extractionFingerprint": "<sha256>",
  "data": {},
  "citations": [],
  "warnings": [],
  "diagnostics": null,
  "omissions": [],
  "budget": null,
  "completion": {
    "documentComplete": true,
    "requestedScopeComplete": true,
    "resultComplete": true
  },
  "nextCursor": null
}
```

The server also returns a bounded compact text fallback. Every returned element has a citation containing its document, extraction generation, page, element ID, and location when available. The common envelope is the sole owner of citations, warnings, diagnostics, omissions, budget, completion, and continuation. Generated schemas are in [`schemas/`](schemas/), and the complete contract is in [`docs/TOOLS.md`](docs/TOOLS.md).

The legacy `extract_pdf_content` tool has been removed and is not aliased. See [`MIGRATION.md`](MIGRATION.md) for side-by-side workflows, renamed settings, client examples, and cases that no longer have a one-call equivalent.

## Document and generation identity

`documentId` is derived from exact PDF bytes. `extractionFingerprint` binds the schema version, extractor version, deterministic dependency fingerprint, OCR policy, and relevant configuration. Element IDs are stable only when all of those inputs and deterministic dependency behavior remain unchanged.

Every element, citation, asset, render, canonical export, and `pdf-decompiler://` resource URI carries the extraction fingerprint. A reference from another generation returns a structured stale-reference error. Active cached generations are immutable and protected by leases during retrieval, rendering, rebuilds, deletion, and eviction.

Canonical format version 4 and extraction revision 4 preserve displayed-page geometry and invalidate earlier canonical cache entries. Public bboxes use PDF points after CropBox and rotation, with a top-left origin. Link text is string or null, internal destinations are structured, and annotation subtype, content, geometry, authorship, dates, color, flags, and reply provenance are retained where available. Blocks represent headings, text, ordered or unordered lists, and code independently from native or OCR origin. Image-region OCR references its canonical figure. Page OCR reports accepted, partial, rejected, or not-attempted region status, and rejected text is not indexed or returned. Reading-order, table, OCR-confidence, and link-overlap thresholds are named internal heuristics, not public constants.

Raster and vector content share one bounded PDF.js operator inspection. Vector bounds may be conservative and are labeled exact, approximate, or unknown. Meaningful vector-only pages are never blank. Uncertain visual pages emit `visual_unknown` and expose a deferred, budgeted, generation-bound render without eager full-page rendering during decomposition.

Malformed input returns one enumerated sanitized `PDF_*` parser code. Worker rejection, exception, timeout, crash, missing output, malformed output, and stderr noise are contained without exposing raw parser details.

## Partial decomposition and budgets

`pdf_open` can decompose selected page intervals. The document remains partial until its extraction cursor processes every missing interval, while `resultComplete` remains true because the open response itself is not retrieval pagination. Search and retrieval operate on the available generation without pretending omitted pages were processed.

Hard limits apply to document bytes, page counts, page selection, wall-clock processing, subprocess output, response bytes, rendered pages, image dimensions, and decompressed output at page boundaries. Native memory enforcement is operating-system enforced through `prlimit` on supported Linux hosts. Windows and macOS monitor working set and terminate the child after a threshold violation, so they provide bounded best-effort enforcement rather than a false hard-memory guarantee. The enforcement class is returned in diagnostics.

Result budgets cover estimated text tokens, complete wire-response bytes, pages, text blocks, tables, figures, rendered pages, and image dimensions. UTF-8 bytes and estimated tokens are measured and enforced independently over the complete MCP response, including protocol reserve. Multi-page retrieval allocates space in deterministic round-robin order. It performs bounded fragment preflight followed by exact final serialization and deterministic reduction if required. Oversized items are omitted with diagnostics and a continuation cursor only when future progress remains.

Cursors are versioned, base64url encoded, expire, and are authenticated with an HMAC key identified by `kid`. They bind the document, extraction generation, operation, normalized arguments, search-query digest, page order, fair-allocation positions, format, table detail, filters, budgets, and relevant serializer versions. Version 3 page cursors carry only the bounded non-sensitive selectors required for cursor-only `pdf_get_pages` continuation. Payloads contain no plaintext query, path, document metadata, Markdown bytes, or extracted content. Cursors are signed, not encrypted. Key rotation may retain the previous key deliberately or retire it and invalidate outstanding cursors.

Completion fields are independent. `documentComplete` means every PDF page is canonical. `requestedScopeComplete` means the pages or regions requested by the operation are canonical. `resultComplete` means the current retrieval cursor chain has no remaining fragments. A fully extracted page with additional retrieval output therefore reports true, true, false.

## Retrieval

BM25 full-text retrieval is local, deterministic, available offline, and indexes normalized element text, positions, metadata, and outline entries.

`pdf_get_pages` defaults to structured output. With `outputFormat: "markdown"`, the full paged Markdown appears once in `structuredContent.data.markdown`; the text block contains only a bounded summary, resource URI, and continuation instructions. Tables may use compact previews. `pdf_get_element.tableSelection` uses one-based inclusive row and column ranges for bounded full-table retrieval, with optional repeated canonical header context across continuations.

A complete-document Markdown resource is available for complete generations. It always uses full tables, is generated atomically, and is checksum verified before publication. Configurable hard bounds cover bytes, serialization time, working buffer, elements, table rows, table cells, and derived-cache entry size. Complete exports fail rather than truncate. Their serializer fingerprint contains only settings that affect full-export bytes or security, so a Markdown-only change does not repeat canonical extraction and compact preview tuning does not invalidate an unchanged full export.

Semantic and hybrid retrieval are optional and disabled by default. The implementation pins the FP32 `onnx-community/all-MiniLM-L6-v2-ONNX` model, exact repository commit, ONNX and tokenizer files, checksums, 384-dimensional mean pooling, and L2 normalization. It does not claim q8 quantization. If the optional package, model files, download, or loading is unavailable, search returns BM25 results with a warning. Hybrid mode uses reciprocal-rank fusion with `k = 60`. See [`docs/SEMANTIC-MODEL.md`](docs/SEMANTIC-MODEL.md) for the immutable artifact manifest and licenses.

## Local-file security

Local access is denied by default until at least one allow root is configured. Paths are resolved to canonical real paths before policy evaluation. Deny roots take precedence over allow roots. Traversal, symlink and junction escapes, device and special paths, Windows reserved names, alternate data streams, and unauthorized UNC paths are rejected. Windows path comparison normalizes drive-letter case and separators.

Configure roots with repeated CLI values:

```powershell
node src/index.mjs --allow-root C:\documents D:\reports --deny-root C:\documents\private
```

Unrestricted local access requires the explicit `--unrestricted-local-access` flag or corresponding environment setting. UNC access requires a separate explicit opt-in. HTTPS loading rejects credentials, non-HTTPS schemes, special or private network ranges, prohibited IPv6 transition ranges, overlong redirects, oversized responses, and DNS rebinding by connecting only to the addresses validated for each redirect.

The server sends no telemetry. Details and threat boundaries are in [`SECURITY.md`](SECURITY.md).

## Cache modes and privacy

| Mode | Behavior | Resource URI lifetime |
|---|---|---|
| `persistent` | Content-addressed immutable generations survive restarts. | Until that generation is deleted, evicted, corrupted, or administratively unavailable. |
| `ephemeral` | Owner-restricted process-local working state supports the multi-call API. | While the owning process and document state remain active. |
| `none` | No reusable persistent cache; each open document retains only isolated process-local state. | Until that document closes or the owning process ends. |

No-cache mode never writes document data into the persistent cache tree. Closing one document does not delete another document's temporary state. Process shutdown and unrecoverable failures clean local state, and startup cleanup removes abandoned process directories only when ownership and age can be validated.

Persistent generations use atomic staging and replacement, hashes, corruption recovery, locks, leases, configurable retention, size-bounded LRU eviction, and active-document protection. Cache status reports the location, permission result, retention, size limit, and stored data classes. On supported POSIX systems directories use mode `0700` and files `0600`; Windows uses owner ACLs through `icacls`. Shared roots are rejected by default and require an explicit opt-in, but each OS user still receives a separate namespace.

Every successful `pdf_open` returns a distinct process-local `sourceId` and safe descriptor, even when byte-identical opens share canonical data. `pdf_close(sourceId)` releases only that handle. The final handle prevents new work, waits for existing operations, releases the generation lease, and then removes process-local state. Source descriptors never affect canonical identity, indexes, citations, resources, or cache keys.

The cache can contain original PDFs, extracted text, images, renders, Markdown exports, indexes, metadata, and embeddings. Review backup policy and enable full-disk encryption where document sensitivity requires it. [`docs/PRIVACY.md`](docs/PRIVACY.md) lists exactly what is stored, retention behavior, deletion semantics, and verification limits.

## Image delivery and resources

The selected MCP SDK and protocol do not negotiate a generic inline-image capability. `imageDelivery: "auto"` therefore returns an immutable read-only resource link plus a textual URI fallback. `imageDelivery: "inline"` is an explicit caller choice and remains bounded by response and image budgets. `imageDelivery: "resource"` always returns the URI.

Old resource URIs are never silently regenerated under another extraction fingerprint. Structured errors distinguish closed documents, expired process-local state, deleted or evicted generations, stale fingerprints, corrupt generations, and missing assets.

## Configuration

CLI options:

```text
--allow-root <dir...>
--deny-root <dir...>
--cache-mode persistent|ephemeral|none
--cache-directory <dir>
--unrestricted-local-access
--allow-unc
--debug
```

Environment variables use the `PDF_DECOMPILER_` prefix. Root lists are JSON arrays. Numeric values are validated as finite positive limits before the server starts. `PDF_DECOMPILER_TIMING=1` adds sanitized operation and stdio phase durations to stderr without logging paths, labels, queries, or extracted content. See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for every variable, default, precedence rule, and security implication.

## Development and validation

```powershell
npm ci
npm run fixtures:generate
npm run fixtures:verify
npm run schemas:generate
npm test
$env:PDF_DECOMPILER_TEST_OCR='1'; npm run test:ocr
npm run test:local-pdfs
npm run check
npm run docs:check
npm run license:check
npm audit --audit-level=high
npm run benchmark
npm run package:verify -- artifacts\package-verification
```

Forty-four deterministic fixtures are generated from source with hashes, intended features, expected classifications, geometry requirements, warnings, errors, and licensing metadata. They contain no third-party document content. The ignored `Heavy Test One.pdf`, `Medium Test One.pdf`, and `Medium Test Two.pdf` files are optional local integration samples and are excluded from Git and package allowlists.

CI requires Node.js 22 and 24 on Windows for extraction, geometry, security, cache, packaging, MCP, and available OCR validation. macOS, Linux, and remote Linux OCR jobs remain configured as best-effort coverage. Unexecuted platform-specific behavior is reported as unverified. Tests run only where the host supports drive casing, UNC paths, symlinks, junctions, ACLs, permission denial, process monitoring, and atomic filesystem semantics.

The official MCP TypeScript client 2.0.0 passes the automated protocol suite. MCP Inspector CLI 2.0.0 completes JSON `tools/list` over stdio and exposes all seven input and output schemas. Other Inspector behaviors and external desktop clients remain explicitly partial or untested in [`docs/CLIENT-COMPATIBILITY.md`](docs/CLIENT-COMPATIBILITY.md).

Benchmark output reports one observed cold open, warm open, and search measurement with fixture and runtime details. It does not claim a median or universal latency, accuracy, or token savings. See [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md).

## Packaging and release status

The repository can build and inspect an npm tarball and MCPB bundle, generate SHA-256 checksums, and produce an SPDX SBOM without publishing. `package.json` remains private so publication cannot occur accidentally. Package-name availability and ownership must be checked immediately before an authorized release. A name conflict must be reported and must not trigger an automatic rename or publication under another name.

Relicensing and publication remain gated by the ownership, provenance, dependency, native binary, MuPDF, PDF.js, OCR, fixture, bundled asset, model, tokenizer, notice, source-distribution, npm-content, MCPB-content, and SBOM review in [`docs/PROVENANCE.md`](docs/PROVENANCE.md). See [`docs/RELEASE.md`](docs/RELEASE.md) for the complete release gate.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/TOOLS.md`](docs/TOOLS.md)
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)
- [`docs/PRIVACY.md`](docs/PRIVACY.md)
- [`docs/CLIENT-COMPATIBILITY.md`](docs/CLIENT-COMPATIBILITY.md)
- [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md)
- [`SECURITY.md`](SECURITY.md)
- [`MIGRATION.md`](MIGRATION.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`SUPPORT.md`](SUPPORT.md)
- [`ROADMAP.md`](ROADMAP.md)

## License

The repository declares `AGPL-3.0-only`. Publication and any statement that relicensing is complete remain blocked until the provenance review supports that conclusion. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
