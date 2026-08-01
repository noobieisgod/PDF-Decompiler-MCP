# Privacy and Cache Lifecycle

PDF Decompiler MCP has no telemetry. It does not call an AI service. Network access occurs only when the caller opens an HTTPS PDF or when semantic model download is explicitly enabled.

## Data stored

Depending on the document and enabled features, state can contain the original PDF, source hash, local source path while active, extracted text, OCR text, metadata, outlines, annotations, links, tables, cells, images, page and crop renders, BM25 terms and positions, semantic embeddings, warnings, diagnostics, cursor keys, access timestamps, and deletion tombstones.

`pdf_document_info` reports cache mode, exact generation location, permission status, retention, maximum size, active leases, stored data categories, and resource lifetime.

## Modes

| Mode | Reusable persistent cache | Active state | Resource lifetime |
|---|---|---|---|
| `persistent` | Yes | Memory plus generation directory | Until that generation is deleted, evicted, corrupted, or administratively unavailable |
| `ephemeral` | No | Memory plus an owner-restricted process directory | While the owning process and document state remain active |
| `none` | No | Memory or an owner-restricted document working directory | Only for the active document lifetime in the owning process |

No-cache mode never writes document data into the persistent cache tree. Its state remains usable by `pdf_search`, `pdf_get_pages`, `pdf_get_element`, `pdf_render_page`, decomposition continuation, and `pdf_close`. Closing one document does not delete another document's state.

Process-local state is removed when its document closes, the server shuts down, or an unrecoverable failure invalidates it. On later startup, abandoned temporary directories older than 24 hours are removed only when their owner fingerprint matches, their recorded process is not alive, and their age is validated.

## Permissions and multiple users

POSIX cache roots use mode `0700`; cache files use `0600`. Windows uses `icacls` to remove inherited access and grant the current account full access. Initialization fails when a persistent cache cannot be restricted unless `PDF_DECOMPILER_ALLOW_SHARED_CACHE_ROOT=true` explicitly accepts that risk.

Persistent data is placed under `users/<owner-fingerprint>` even when multiple operating-system users point to one parent directory. Sharing one owner namespace across users is unsupported. Multiple processes for the same owner coordinate through lock files and generation leases.

## Retention, size, and deletion

Persistent defaults are 30 days and 2 GiB. LRU eviction removes expired or least-recently-used generations until both bounds are satisfied. Active leases are never evicted or deleted.

`pdf_close` preserves persistent cache by default. `deleteCache: true` deletes the exact generation after its final lease is released. Deletion returns whether removal occurred and whether absence was verified. Tombstones distinguish deleted, evicted, closed, and corrupt state. The implementation does not claim forensic erasure on flash storage, journaling filesystems, snapshots, or backups.

Backups can retain PDFs, text, images, and embeddings beyond configured retention. Exclude the cache directory from backups when that is not acceptable. Use full-disk encryption for devices that may store sensitive documents. Administrative backup and encryption policy is outside this server.

## Corruption and recovery

Manifests verify canonical data and extracted asset hashes. A corrupt generation is deleted without being served and must be opened again. The server never silently regenerates an old resource URI under a new extraction fingerprint.
