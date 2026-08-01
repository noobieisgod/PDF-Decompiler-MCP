# Configuration Reference

Local file access is denied by default until at least one allow root is configured. Deny roots always take precedence. Unrestricted access is an explicit opt-in.

| Environment variable | Default | Meaning |
|---|---:|---|
| `PDF_DECOMPILER_ALLOW_ROOTS_JSON` | `[]` | JSON array of local directories that may contain source PDFs |
| `PDF_DECOMPILER_DENY_ROOTS_JSON` | `[]` | JSON array of denied directories, evaluated after real-path resolution |
| `PDF_DECOMPILER_UNRESTRICTED_LOCAL_ACCESS` | `false` | Opt in to local access outside allow roots; deny roots still apply |
| `PDF_DECOMPILER_ALLOW_UNC` | `false` | Permit UNC sources after all other path checks |
| `PDF_DECOMPILER_MAX_DOCUMENT_BYTES` | `262144000` | Hard PDF byte limit |
| `PDF_DECOMPILER_MAX_PAGES` | `5000` | Hard page-count limit |
| `PDF_DECOMPILER_MAX_DECOMPRESSED_BYTES` | `536870912` | Hard accepted decompressed page-output limit |
| `PDF_DECOMPILER_EXTRACTION_TIMEOUT_MS` | `50000` | Child-process wall-clock deadline |
| `PDF_DECOMPILER_SUBPROCESS_MEMORY_BYTES` | `2147483648` | Native-process memory threshold |
| `PDF_DECOMPILER_OCR_POLICY` | `auto` | `auto`, `off`, or `required` |
| `PDF_DECOMPILER_CACHE_MODE` | `persistent` | `persistent`, `ephemeral`, or `none` |
| `PDF_DECOMPILER_CACHE_DIR` | platform user cache | Persistent cache parent |
| `PDF_DECOMPILER_CACHE_RETENTION_DAYS` | `30` | Persistent LRU retention |
| `PDF_DECOMPILER_CACHE_MAX_BYTES` | `2147483648` | Persistent LRU size bound |
| `PDF_DECOMPILER_ALLOW_SHARED_CACHE_ROOT` | `false` | Accept a persistent root whose owner-only permissions cannot be verified |
| `PDF_DECOMPILER_SEMANTIC_ENABLED` | `false` | Enable semantic and hybrid ranking |
| `PDF_DECOMPILER_SEMANTIC_ALLOW_DOWNLOAD` | `false` | Permit first-use download of the pinned model |
| `PDF_DECOMPILER_CURSOR_TTL_MS` | `3600000` | Signed cursor validity period |
| `PDF_DECOMPILER_DEBUG` | `false` | Put detailed child diagnostics on stderr; never stdout |

Boolean variables accept `1` or `true`.

The executable also accepts `--allow-root`, `--deny-root`, `--cache-mode`, `--cache-directory`, `--unrestricted-local-access`, `--allow-unc`, and `--debug`. Multiple roots may follow one root option until the next option. The MCPB manifest uses this form so the host can pass user-selected directories without weakening the default policy.

Example:

```powershell
$env:PDF_DECOMPILER_ALLOW_ROOTS_JSON='["C:/Documents/PDFs"]'
$env:PDF_DECOMPILER_CACHE_MODE='none'
node src/index.mjs
```

Configuration affecting extraction changes `extractionFingerprint`. References retained from another generation are rejected instead of being resolved against the current model.
