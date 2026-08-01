# Architecture

PDF Decompiler MCP 3.0.0 is a native ESM, local stdio server. It uses the official MCP TypeScript SDK v2 packages, a hybrid MuPDF and PDF.js extractor, a canonical generation model, a content-addressed cache, and bounded retrieval.

## Processing flow

1. `pdf_open` validates a local real path or an HTTPS source.
2. The exact PDF bytes produce `documentId = doc_<sha256>`.
3. Schema, extractor, dependency, OCR, and relevant extraction settings produce `extractionFingerprint`.
4. A child process extracts pages with hard document, page, deadline, image, output, and decompressed-result limits. Native memory enforcement is classified per platform.
5. Extraction output becomes deterministic page, block, table, cell, figure, annotation, link, asset, warning, diagnostic, and citation records.
6. BM25 is built immediately. Semantic indexing is optional, lazy, and disabled by default.
7. Tools retrieve bounded subsets. Signed cursors continue results without placing queries or paths in their payload.
8. Assets and exported canonical records use immutable generation-bound `pdf-decompiler://` resource URIs.

## Canonical identity contract

Identifiers are identical when the PDF bytes, schema version, extractor version, relevant configuration fingerprint, dependency fingerprint, and deterministic dependency behavior are identical. Ordinal element IDs are not promised to survive extractor, schema, dependency, or relevant configuration changes. Content and location fingerprints supplement ordinals for comparison without enlarging the public ID.

Every external element, citation, asset, render, canonical export, and resource URI carries `extractionFingerprint`. An old reference is never resolved against a different generation. Active generation leases prevent deletion and eviction. Rebuilds use a new directory and never overwrite leased records or assets.

## Storage layout

Persistent mode uses the platform user cache directory under an owner namespace:

```text
users/<owner-fingerprint>/
  documents/<documentId>/<extractionFingerprint>/
    source.pdf
    canonical.json
    bm25.json
    assets/
    manifest.json
    leases/
  derived/<documentId>/<extractionFingerprint>/
  indexes/<documentId>/<extractionFingerprint>/
  tombstones/
  locks/
  cursor-keys.json
```

Writes use a staging path followed by atomic rename. Per-generation locks serialize writers. Manifests hash the source, canonical JSON, and extracted assets. Corruption deletes the affected generation and records a tombstone. Derived renders and semantic indexes are immutable adjuncts keyed by the exact generation.

Ephemeral and no-cache modes use owner-restricted process directories outside the persistent tree. See [Privacy](PRIVACY.md) for lifecycle details.

## Retrieval

BM25 tokenizes Unicode text with NFKC normalization, persists term positions, and indexes blocks, tables and cells, OCR text, captions, annotations, metadata, and outline entries. Ordering is score, page, reading order, then ID. Semantic search uses cosine-equivalent dot product over normalized vectors. Hybrid search uses reciprocal-rank fusion with `k = 60`.

The three page modes are:

- `text`: omits figures unless explicitly included.
- `balanced`: includes text, tables, and captioned figures.
- `fidelity`: includes all supported elements in reading order within the requested scope.

Mode defaults are applied first, inclusion and exclusion overrides second, and hard budgets last.

## MCP behavior

All seven tools return a structured envelope and compact JSON text fallback. Rendering returns an inline MCP image only after explicit `imageDelivery: "inline"`. The protocol has no generic negotiated inline-image capability, so `auto` conservatively returns a resource link and a textual URI. Resources are read-only.

The stdio entry uses `serveStdio`, supports the MCP 2026 protocol era implemented by SDK v2, and accepts supported 2025-era openings through the SDK legacy path.
