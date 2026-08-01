# Security Policy and Deployment Model

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include private document contents in a public issue.

## Local-file policy

The default is deny. A local PDF must resolve inside a configured allow root unless unrestricted local access is explicitly enabled. The server obtains the canonical real path before policy checks, so symlinks and Windows junctions cannot escape an allowed root. Deny roots are checked first and take precedence.

Windows comparisons normalize drive-letter and path case. UNC paths are disabled unless explicitly enabled. Device paths, global-root paths, reserved components, and alternate data streams are rejected. POSIX device and virtual filesystem roots `/dev`, `/proc`, and `/sys` are rejected. Traversal and alternate separators are evaluated through platform path resolution. Only regular files are accepted.

Unrestricted local access is enabled only with `PDF_DECOMPILER_UNRESTRICTED_LOCAL_ACCESS=true` or the matching executable option. Deny roots, device restrictions, file type, PDF signature, and size limits still apply.

## HTTPS policy

Remote sources must use HTTPS without URL credentials. DNS is resolved before connecting. Every returned address is rejected if it is loopback, private, link-local, carrier-grade NAT, documentation, benchmark, multicast, reserved, or unspecified. The HTTPS connection uses the approved resolution through a pinned lookup callback while preserving TLS hostname verification. Every redirect repeats URL and DNS validation. Redirects are limited to five. Header and streamed byte limits are both enforced.

No network request occurs for ordinary full-text operation. Semantic model download requires both semantic enablement and download permission.

## Processing limits

| Limit | Enforcement class |
|---|---|
| PDF bytes and signature | Hard, before parsing |
| Page count | Hard, before page processing |
| Wall-clock deadline | Hard runtime deadline followed by child termination |
| Image dimension | Hard in renderer |
| Accepted decompressed page output | Hard runtime limit at page-chunk boundaries |
| Child result bytes | Hard before parent acceptance |
| Linux native address space | Operating-system-enforced with `prlimit` when available |
| Windows and macOS native memory | Monitored best effort followed by termination |

The configured memory threshold is never left unenforced. Diagnostics report the actual enforcement class. Windows and macOS do not receive a hard-memory claim. A native parser can allocate inside one page before the decompressed-output boundary; that allocation is bounded by the platform memory enforcement class.

OCR, parsing, and rendering run outside the MCP server process. Temporary directories are owner restricted and removed in `finally` blocks. Errors returned to tools omit stacks, local paths, child stderr, and native diagnostics. Debug details go only to stderr when explicitly enabled. Stdout remains MCP protocol traffic.

## Cursors

Cursors are versioned base64url payloads authenticated with HMAC-SHA-256. They bind document ID, extraction fingerprint, operation, normalized argument digest, offset, issue time, expiry, and cursor-key ID. They do not contain plaintext queries, paths, metadata, or extracted content.

Cursors are signed, not encrypted. Their minimal routing fields are inspectable. Replay within the validity period is allowed and returns the same deterministic continuation. Changing the query, filters, budgets, operation, document, or generation rejects the cursor. Key rotation may retain old keys for a deliberate transition or retire them immediately. Unknown and retired key IDs are rejected.

## Cache security

See [Privacy and Cache Lifecycle](docs/PRIVACY.md). Owner-only permissions are required by default. Atomic writes, hashes, locks, leases, LRU, tombstones, and exact-generation resource resolution prevent partial and cross-generation reads.

## Supported versions

Security fixes target supported 3.x releases. Legacy tags remain historical and are not rewritten. Node.js 22 and 24 are supported. Node.js 18 and 20 are not supported by this 3.0.0 build.
