# PDF Decompiler MCP

**Structured, selective, multimodal PDF access for AI agents.**

PDF Decompiler MCP is a local-first Model Context Protocol server that decomposes PDF documents into addressable text, tables, figures, annotations, metadata, OCR output, and page-level structures.

Instead of treating a PDF as one large response, the project is being redesigned around a two-step model:

1. Decompose and index the document once.
2. Retrieve only the pages, blocks, tables, figures, or rendered regions needed for the current task.

## Why the project was renamed

The original project claimed to make PDF use substantially cheaper. Testing showed that this was not a reliable universal claim.

A structured multimodal response can cost more than a text-focused PDF path because it may include extracted text, tables, images, screenshots, annotations, page structure, and fallback renders. That additional context can improve document fidelity, especially for charts, diagrams, screenshots, scanned pages, and complex layouts, but it can also increase token consumption.

The new name describes what the server is intended to do without promising a particular cost outcome:

Token use is workload-dependent. It varies with the selected retrieval mode, document type, number and resolution of images, amount of returned text, client implementation, model, and token-accounting method.

## What “decompiler” means here

In this project, **decompiler** means converting a PDF from its page-oriented representation into a canonical document model that exposes useful elements such as:

- document metadata and outline entries
- page text and reading order
- headings and text blocks
- structured tables and cells
- embedded figures and captions
- page renders and cropped regions
- links and annotations
- OCR output for scanned pages
- page dimensions, rotation, and layout coordinates
- stable IDs for pages and document elements

The project does not claim to reconstruct the original source document, authoring application, or editable layout with perfect fidelity.

## Design goals

PDF Decompiler MCP is designed around the following goals:

- **Selective retrieval:** Return only the evidence needed for a task.
- **Multimodal access:** Preserve access to visual content when text alone is insufficient.
- **Stable citations:** Keep every result traceable to its document, page, and source element.
- **Budget awareness:** Enforce configurable limits for text, images, pages, response bytes, and estimated tokens.
- **Local-first operation:** Process documents locally by default and avoid external AI or embedding services unless explicitly configured.
- **Reusable decomposition:** Parse a document once, cache the result, and reuse it across multiple questions.
- **Client independence:** Support MCP-compatible clients without making one model or vendor part of the project identity.
- **Transparent benchmarking:** Compare cost, latency, reliability, and answer quality using reproducible configurations.

## Current and planned capabilities

The next major version is being developed in phases. Do not treat planned items as released until they appear in a tagged release and the compatibility matrix marks them as verified.

| Capability | Legacy releases | Next major version target |
|---|---:|---:|
| Page text extraction | Available | Retained and modularized |
| Metadata and outline extraction | Available | Retained with stable schemas |
| Header and footer filtering | Available | Retained with diagnostics |
| Structured table extraction | Available | Expanded with independent retrieval |
| Embedded image extraction | Available | Expanded with stable figure IDs |
| Full-page visual fallback | Available | Converted to on-demand rendering where possible |
| OCR through Tesseract | Available | Expanded with timeouts and page-level diagnostics |
| Page-range extraction | Available | Replaced by selective page and element retrieval |
| Stable document handles | Not available | Planned |
| Persistent cache | Not available | Planned |
| Text, balanced, and fidelity modes | Not available | Planned |
| Full-text retrieval index | Not available | Planned |
| Optional semantic retrieval | Not available | Planned |
| Token and response budgets | Limited | Planned |
| Continuation cursors | Not available | Planned |
| Page-level and element-level citations | Limited | Planned |
| Client capability fallbacks | Limited | Planned |
| Reproducible benchmark suite | Partial manual tests | Planned |

## Retrieval modes

The next major version will expose retrieval modes as presets over explicit parameters.

### Text mode

Returns text, headings, metadata, annotations, and compact table representations. Images and page renders are omitted unless explicitly requested.

Best for text-heavy reports, papers, books, policies, and contracts.

### Balanced mode

Returns relevant text and tables, then includes figures or page regions when visual evidence is likely to improve the answer.

Best for mixed-layout documents, technical manuals, financial reports, and documents containing occasional charts or screenshots.

### Fidelity mode

Returns all supported elements within an explicitly selected scope, such as a page range or list of element IDs.

Fidelity mode is not intended to dump an unlimited document. It remains subject to configured page, byte, image, and token budgets.

## Target MCP tool surface

The redesigned server is planned around small, composable tools rather than one all-purpose extraction response.

| Tool | Purpose |
|---|---|
| `pdf_open` | Validate, decompose, index, or load a PDF from cache and return a document handle. |
| `pdf_document_info` | Return metadata, outline, page classifications, element counts, warnings, and cache information. |
| `pdf_search` | Search text, headings, OCR, captions, annotations, and table cells under explicit filters and budgets. |
| `pdf_get_pages` | Retrieve selected pages using text, balanced, or fidelity settings. |
| `pdf_get_element` | Retrieve identified text blocks, tables, figures, annotations, or regions. |
| `pdf_render_page` | Render a page or bounding box only when visual inspection is needed. |
| `pdf_close` | Release an active document session and optionally preserve or remove cached state. |

The legacy `extract_pdf_content` tool may remain temporarily as a deprecated compatibility wrapper during migration. Its final availability will be documented in release notes.

## Canonical document model

A decomposed document is expected to contain stable, serializable records for:

- document identity, source, hash, metadata, outline, and warnings
- pages, dimensions, rotation, extraction method, and content classification
- text blocks, bounding boxes, reading order, and heading information
- tables, cells, headers, confidence, and optional rendered previews
- figures, captions, dimensions, hashes, and deduplication references
- annotations, links, authors, contents, and coordinates
- citations that connect every result to a page and element ID

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the target architecture.

## Selective retrieval and RAG

The planned retrieval layer will index:

- page text
- text blocks and headings
- OCR output
- figure captions
- annotation text
- table headers and cells
- metadata and outline entries

The initial implementation should use deterministic local full-text retrieval. Optional embeddings may be added later for semantic or hybrid ranking.

Semantic retrieval will remain optional. The base server should work without an external embedding service or API key.

## Budget controls

Retrieval requests are planned to support limits such as:

- maximum estimated output tokens
- maximum response bytes
- maximum pages
- maximum text blocks
- maximum tables
- maximum figures
- maximum rendered pages
- maximum image dimensions

Responses should report what was returned, what was omitted, why it was omitted, the estimated budget used, and whether more results are available through a continuation cursor.

Token estimates are approximate unless a client or model-specific tokenizer is configured.

## Page and element citations

Every retrieved result should remain traceable to its source through:

- document ID
- page number
- element ID
- element type
- bounding box where applicable
- source excerpt or label
- retrieval score where applicable

Generated summaries should cite underlying source elements rather than becoming the only evidence record.

## Installation

The source tree and installation process are being normalized for the next major version. Until a tagged pre-release is published, use the latest legacy release for existing behavior or follow the development instructions after the new source layout lands.

### Development installation target

Requirements:

- Node.js 18 or later
- npm
- Tesseract 5.x for OCR support
- a supported native canvas package for image extraction and rendering

```bash
# After the repository is renamed
git clone https://github.com/noobieisgod/PDF-Decompiler-MCP.git
cd PDF-Decompiler-MCP
npm install
npm run build
```

Run the server through stdio:

```bash
node dist/server.js --stdio
```

The exact entry point may change before the first pre-release. Tagged releases are the source of truth for installation commands.

## MCP client configuration

A development configuration is expected to use a local Node.js entry point:

```json
{
  "mcpServers": {
    "pdf-decompiler": {
      "command": "node",
      "args": [
        "C:/path/to/PDF-Decompiler-MCP/dist/server.js",
        "--stdio"
      ]
    }
  }
}
```

Use forward slashes in Windows JSON paths. Restart the MCP client after changing its configuration.

A future npm-published configuration may look like this:

```json
{
  "mcpServers": {
    "pdf-decompiler": {
      "command": "npx",
      "args": [
        "-y",
        "pdf-decompiler-mcp",
        "--stdio"
      ]
    }
  }
}
```

Do not use the npm example until the package is published and its release notes confirm the command.

## Example workflows

These examples describe the intended redesigned workflow.

### Open and inspect a document

```text
Open this PDF with PDF Decompiler MCP and report its page count, outline, number of tables, number of figures, and any scanned pages: PDF_PATH
```

### Text-focused analysis

```text
Use text mode to find the document's recommendations. Cite the relevant pages and do not retrieve images unless the text is insufficient.
```

### Table retrieval

```text
Search this document for the revenue table, retrieve the structured table, and cite its page and table ID.
```

### Visual analysis

```text
Find the figure discussing system architecture. Retrieve the caption and relevant text first, then retrieve the figure if visual inspection is necessary.
```

### Budget-controlled retrieval

```text
Answer using at most the configured retrieval budget. Prefer relevant text and tables, omit decorative images, and list any evidence that could not fit.
```

## Supported PDF categories

The benchmark suite will include:

- text-heavy documents
- image-heavy documents
- scanned documents
- table-heavy documents
- mixed-content reports
- multi-column papers
- forms
- financial reports
- manuals
- slide decks exported as PDF
- documents with unusual fonts or rotations
- large and malformed PDFs

No PDF parser can guarantee correct handling of every file. Unsupported, malformed, encrypted, or unusually complex PDFs should produce structured warnings or partial results rather than silent failure.

## Security model

PDF processing can expose local files, download remote content, invoke OCR subprocesses, consume large amounts of memory, and parse hostile input.

The redesigned server is expected to provide:

- configurable allowed filesystem roots
- optional denial of arbitrary absolute paths
- PDF signature and size checks
- download, redirect, and timeout limits
- blocking for loopback, private, and link-local remote addresses
- OCR and rendering timeouts
- page, image, memory, and decompression limits
- temporary-file cleanup
- sanitized errors
- no telemetry by default

Review [`SECURITY.md`](SECURITY.md) before deploying the server in a shared or networked environment.

## Privacy

The project is local-first. The intended default is to process PDF content on the machine running the MCP server.

Remote URLs require the server to download the file. Optional embedding providers, if enabled in the future, may receive extracted text according to their configuration and policies. Such integrations must be disabled by default and clearly documented.

See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Client compatibility

The project intends to support multiple MCP-compatible clients, including coding assistants and desktop applications. Support will be claimed only after a client has passed the documented compatibility checks.

See [`docs/CLIENT-COMPATIBILITY.md`](docs/CLIENT-COMPATIBILITY.md) for the verification matrix.

## Benchmarking policy

The project will not publish broad cost or quality claims without reproducible evidence.

Every comparison should identify:

- client and version
- model and exact model identifier
- provider and API path
- PDF processing mode
- visual and citation settings
- PDF Decompiler MCP version and mode
- token and response budgets
- image resolution
- cache state
- hardware and operating system
- number of repetitions

Benchmarks should measure:

- tool-result bytes and tokens
- cold and warm latency
- extraction and retrieval reliability
- peak memory and cache use
- text, table, and visual answer quality
- retrieval precision and recall
- citation correctness

See [`docs/BENCHMARKING.md`](docs/BENCHMARKING.md).

## Repository structure target

```text
PDF-Decompiler-MCP/
  src/
    server/
    tools/
    extraction/
    models/
    retrieval/
    ranking/
    caching/
    rendering/
    ocr/
    security/
    clients/
    utilities/
  tests/
    unit/
    integration/
    fixtures/
    benchmarks/
  docs/
  examples/
  scripts/
  schemas/
  .github/
  README.md
  CONTRIBUTING.md
  SECURITY.md
  SUPPORT.md
  CODE_OF_CONDUCT.md
  GOVERNANCE.md
  CHANGELOG.md
  MIGRATION.md
  ROADMAP.md
  LICENSE
```

## Roadmap

The redesign is divided into three phases:

1. Rebrand, normalize the repository, modularize extraction, and define the canonical document model.
2. Add document handles, caching, selective retrieval, retrieval modes, citations, budgets, reliability controls, and security protections.
3. Verify multiple clients, publish reproducible benchmarks, stabilize schemas, and prepare the first stable release.

See [`ROADMAP.md`](ROADMAP.md) for completion criteria.

## Migration

Users of Lightweight PDF MCP for Claude AI should read [`MIGRATION.md`](MIGRATION.md) before changing repository URLs, MCP server keys, package names, entry points, or tool calls.

## Contributing

Contributions are welcome after the source tree is restored and the development workflow is documented.

Before opening a pull request:

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md).
2. Add or update tests.
3. Describe any schema, token, security, or compatibility impact.
4. Avoid unsupported performance claims.
5. Include reproducible fixtures or instructions for PDF-specific bugs when licensing permits.

## Support and security

- General questions and troubleshooting: [`SUPPORT.md`](SUPPORT.md)
- Vulnerability reporting: [`SECURITY.md`](SECURITY.md)
- Community expectations: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Project decisions: [`GOVERNANCE.md`](GOVERNANCE.md)

## License

PDF Decompiler MCP is licensed under the GNU Affero General Public License v3.0 only, unless the repository owner explicitly changes the license in a future commit.

Keep the repository's exact `LICENSE` file as the legal source of truth. Ensure `package.json`, release artifacts, and documentation use the SPDX identifier `AGPL-3.0-only`.

## Acknowledgment of the previous project

PDF Decompiler MCP began as **Lightweight PDF MCP for Claude AI**. The original project explored local preprocessing of PDF text, tables, links, images, OCR output, and page fallbacks for Claude Desktop.

The rebrand reflects what was learned from testing: more document fidelity can require more context, and efficiency should come from selective retrieval and explicit budgets rather than a universal lightweight claim.
