# 3.0.0 Roadmap and Release Gates

This is one 3.0.0 assignment. The gates below are validation checkpoints, not separate releases or reduced scope.

- Repository normalization: source at root, archival branch recorded, migration inventory committed, legacy bundles and duplicates removed.
- Canonical model and decomposition: generation-bound records, stable-within-generation IDs, hybrid extraction, lazy visual renders, hard processing limits.
- Security: deny-by-default path roots, DNS-pinned HTTPS, subprocess isolation, sanitized errors, no telemetry.
- Cache: content-addressed generations, privacy modes, permissions, locks, leases, corruption recovery, LRU, deletion verification.
- Retrieval: persisted BM25, optional pinned FP32 semantic search, BM25 fallback, RRF.
- MCP: exactly seven tools, structured envelopes, citations, read-only resources, explicit image delivery.
- Budgets and cursors: deterministic continuations, hard ceilings, signed query-digest cursors, key rotation.
- Compatibility: automated SDK and Inspector evidence; manual Claude Desktop and Codex rows remain a release gate.
- Packaging: isolated npm and MCPB stages, schema 0.4 validation, SBOM, checksums, file-list inspection.
- Documentation: generated schemas and all referenced documents, with README updated last.
- Release readiness: provenance, native-binary obligations, target-platform MCPB tests, npm name ownership, and explicit publication authorization.

Implementation gates may pass before external release gates. No package is published merely because repository validation passes.
