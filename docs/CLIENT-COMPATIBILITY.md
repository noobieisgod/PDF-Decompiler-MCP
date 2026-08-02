# Client Compatibility

Launching a process is not sufficient for a compatibility claim. Validation covers tool discovery, input schemas, structured content, compact text fallback, inline images, resource links, large bounded results, cursors, partial decomposition, errors and warnings, shutdown, and protocol-clean stdio.

| Client | Version | Date | Platform | Level | Evidence |
|---|---|---|---|---|---|
| Official MCP TypeScript client | 2.0.0 | 2026-08-02 | Windows build 26200.8655, Node 22.23.1 and 24.14.1 | Automated | Discovery, seven input and output schemas, structured content, bounded Markdown fallback, errors, resources, bounded inline images, cursors, partial work, stdio, and shutdown pass the repository tests |
| MCP Inspector CLI | 2.0.0 | 2026-08-01 | Windows build 26200.8655, Node 24.14.1 | Partial automated | JSON `tools/list` succeeds over stdio and exposes all seven input and output schemas; interactive image, resource, large-result, and shutdown UI behavior is untested |
| 2025-era raw stdio client | Protocol 2025-06-18 | 2026-08-02 | Windows build 26200.8655, Node 22.23.1 and 24.14.1 | Automated | Capability-free initialization, protocol-clean stdout, and clean shutdown pass `test/server-smoke.test.mjs` |
| Claude Desktop | Not recorded | 2026-08-01 | Not tested | Untested | No compatible version claim |
| Codex CLI or desktop client | Desktop package 26.721.4979.0 present | 2026-08-01 | Windows build 26200.8655 | Untested | The packaged executable could not be invoked from this sandbox and no client configuration was changed |

`automated` means a repeatable repository test. `manual` means all relevant behaviors were exercised by a person and recorded. `partial` lists the exact subset tested. `untested` makes no compatibility claim.

Before stable publication, record exact Claude Desktop and Codex client versions and dates, then exercise every behavior in the opening paragraph. A failed behavior must be marked partial with its limitation, not compatible.

Windows is the blocking validation platform for this corrective effort. macOS and Linux CI definitions are retained as best-effort jobs, but no current compatibility claim is made because those jobs were not executed in this workspace. Their filesystem, native-memory, locking, packaging, OCR, and stdio behavior remains unverified until a dated job succeeds.

Image behavior is request driven, not inferred from a nonexistent generic client capability. `auto` returns a resource link and text URI. A client profile may explicitly request inline content after that client has been tested.

Inspector 1.0.0 was also attempted on 2026-08-01. Its package emitted an official v1 deprecation notice and the connection closed before discovery, so it is not listed as compatible.
