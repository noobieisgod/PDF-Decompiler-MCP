# Benchmarking

Run:

```bash
npm run benchmark
```

The command emits machine-readable JSON with the exact Node version, platform, cache and semantic settings, cold and warm open latency, search latency, process RSS, cache bytes, response bytes, extraction completion, expected retrieval page, and citation check. The current command performs one measured repetition, uses a generated CC0 fixture, and makes no comparative claim. It does not report a median until the harness is configured for multiple repetitions.

Any published result must additionally record hardware, operating system build, client and version, model identifier, provider and API path, PDF category, retrieval mode, image delivery, budgets, cache state, repetition count, median and dispersion, peak child memory method, fixture revision, and PDF Decompiler MCP commit.

Comparisons must measure at least tool-result bytes, estimated and provider-reported tokens when available, cold and warm latency, extraction reliability, retrieval precision and recall, table and visual quality, citation correctness, peak memory, and cache use. Do not publish universal cost, quality, or speed claims from one document, one client, or advisory token estimates.

## Real-world corpus

The checked-in [`evaluation`](../evaluation/) corpus supplements synthetic fixtures with two licensed user documents. A third sample, TSMC's 2024 Annual Report, is downloaded from TSMC and checksum verified locally because redistribution is not permitted by the site's terms. The manifest records exact hashes, sizes, page counts, licenses, provenance, and intended feature coverage.

Run `npm run evaluation:verify` to validate the committed samples. Download the heavy report from the official page and save it at the manifest's local path before `npm run test:local-pdfs`. Results must state which samples were present, their actual hashes, the commit, runtime, platform, cache state, and whether Tesseract was available.
