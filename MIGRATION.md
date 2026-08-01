# Migration to PDF Decompiler MCP 3.0.0

Version 3.0.0 is a breaking rebrand and workflow change from Lightweight PDF MCP for Claude AI. The old `extract_pdf_content` tool is removed. It is not registered, aliased, or wrapped.

## Renamed surfaces

| Before | 3.0.0 |
|---|---|
| Package and repository identity based on `lightweight-pdf` | `pdf-decompiler-mcp` |
| Executable `pdf-extract-addon.mjs` | `pdf-decompiler-mcp` or `node src/index.mjs` |
| MCP server key `lightweight-pdf` | `pdf-decompiler` |
| Environment prefix associated with the old product | `PDF_DECOMPILER_` variables in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) |
| One call to `extract_pdf_content` | Seven-tool open, inspect, retrieve, render, close workflow |
| One eager text and image response | Structured generations, citations, budgets, cursors, and resources |

No old environment-variable alias is provided. Update configuration explicitly so a stale insecure setting cannot be accepted silently.

## Workflow mapping

| Old use case | New workflow |
|---|---|
| Extract all text | `pdf_open`, then `pdf_get_pages` in `text` mode with cursors, then `pdf_close` |
| Extract a page range | `pdf_open`, then `pdf_get_pages` with `pages` or `pageRanges` |
| Find a fact | `pdf_open`, `pdf_search`, `pdf_get_element` or `pdf_get_pages` for evidence |
| Extract tables | `pdf_search` with table terms or filters, then `pdf_get_element` for each table |
| Return images | Search or retrieve figure records, then read their immutable resource URI |
| Read a visually complex page | `pdf_render_page` after text and table retrieval |
| Continue a large extraction | Call `pdf_open` again with its signed continuation cursor and exact generation |
| Remove temporary data | `pdf_close`; no-cache and ephemeral state is removed at final close |
| Delete reusable cache | `pdf_close` with `deleteCache: true` |

There is no direct one-call equivalent for returning an unbounded document plus every image. This behavior was removed because it conflicts with hard budgets, selective retrieval, stable references, and large-result compatibility.

## Side-by-side requests and responses

Old request:

```json
{
  "name": "extract_pdf_content",
  "arguments": {
    "url": "C:/Documents/report.pdf",
    "pages": [{ "start": 1, "end": 5 }]
  }
}
```

New open request:

```json
{
  "name": "pdf_open",
  "arguments": {
    "source": "C:/Documents/report.pdf",
    "pages": [{ "start": 1, "end": 5 }]
  }
}
```

New response excerpt:

```json
{
  "schemaVersion": "3.0.0",
  "operation": "pdf_open",
  "documentId": "doc_<sha256>",
  "extractionFingerprint": "<generation-sha256>",
  "data": {
    "processedPages": 5,
    "complete": false,
    "nextCursor": "<signed-cursor>"
  }
}
```

Page retrieval request:

```json
{
  "name": "pdf_get_pages",
  "arguments": {
    "documentId": "doc_<sha256>",
    "extractionFingerprint": "<generation-sha256>",
    "pageRanges": [{ "start": 1, "end": 5 }],
    "mode": "balanced",
    "budget": { "responseBytes": 500000 }
  }
}
```

Unlike the old response, every element includes a generation-bound citation and every asset uses a generation-bound URI. Continue with `nextCursor` until it is null.

## Client configuration

Before:

```json
{
  "mcpServers": {
    "lightweight-pdf": {
      "command": "node",
      "args": ["C:/old/pdf-extract-addon.mjs", "--stdio"]
    }
  }
}
```

After:

```json
{
  "mcpServers": {
    "pdf-decompiler": {
      "command": "node",
      "args": ["C:/PDF-Decompiler-MCP/src/index.mjs", "--allow-root", "C:/Documents"]
    }
  }
}
```

Node.js 18 and 20 configurations must move to Node.js 22 or 24. Update clients to retain both `documentId` and `extractionFingerprint` with every element reference.
