# Third-Party Notices

Exact installed dependency versions and transitive packages are recorded in `package-lock.json` and the generated SPDX SBOM.

| Component | Version or pin | License | Role |
|---|---|---|---|
| MuPDF npm package | 1.27.0 | AGPL-3.0-or-later | PDF parsing and rendering, including native or WASM artifacts |
| PDF.js | 5.5.207 | Apache-2.0 | Structure, text, annotation, and fallback extraction |
| MCP server and core packages | 2.0.0 | MIT | MCP server and protocol implementation |
| Zod | 4.3.6 | MIT | Input and output schemas |
| `@napi-rs/canvas` | 0.1.97 | MIT | Optional native rendering support |
| Tesseract | external 5.x | Apache-2.0 | Optional local OCR executable, not bundled by npm |
| Transformers.js | optional peer 4.2.0 | Apache-2.0 | Explicitly installed semantic retrieval runtime |
| all-MiniLM-L6-v2 ONNX model and tokenizer | exact commit in [`docs/SEMANTIC-MODEL.md`](docs/SEMANTIC-MODEL.md) | Apache-2.0 | Optional local embeddings |
| MCPB CLI | 2.1.2 | MIT | Development-only package validation and bundling |
| Synthetic fixtures | generated | CC0-1.0 | Tests and benchmarks |

The MCPB development tool uses an exact security override for `tmp` 0.2.7. It is omitted from production npm and MCPB contents.

Review each dependency's included license files and the generated SBOM before publication. MuPDF Corresponding Source obligations are a release gate, not satisfied merely by this notice.
