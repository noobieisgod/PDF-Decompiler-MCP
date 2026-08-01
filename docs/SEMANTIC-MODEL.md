# Optional Semantic Model Pin

Semantic retrieval is disabled by default. Base installation does not install Transformers.js. To opt in, install exact peer package `@huggingface/transformers@4.2.0`, set `PDF_DECOMPILER_SEMANTIC_ENABLED=true`, and separately allow first-use download if required.

The implementation is pinned as follows:

- Repository: `onnx-community/all-MiniLM-L6-v2-ONNX`
- Revision: `aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f`
- Precision: FP32, not q8
- ONNX files: `onnx/model.onnx` and `onnx/model.onnx_data`
- Embedding dimension: 384
- Pooling: attention-mask-aware mean pooling through the Transformers.js feature-extraction pipeline
- Normalization: L2 normalization before dot-product similarity
- Expected selected download: 91,086,568 bytes
- Model and tokenizer license: Apache-2.0

| File | Bytes | SHA-256 |
|---|---:|---|
| `onnx/model.onnx` | 56,796 | `2f019cf6217537cc4bfc7f5192f21dea1e18445177edaab0bc6163a813e5c7a1` |
| `onnx/model.onnx_data` | 90,261,504 | `60c758432aa596c30a122942dfe594c457d4d713f890926f1c5f920bd496c8de` |
| `config.json` | 794 | `fe5da868b77bdb104140822a5af0837cb6450ad6de8ff3dfcc8dd44ddd3e3ae7` |
| `special_tokens_map.json` | 695 | `5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a` |
| `tokenizer.json` | 533,808 | `07805d116826679de90b4edeb2222269c4b8753bc0981be4399f732b2708e904` |
| `tokenizer_config.json` | 1,463 | `e10bb633ba0d7f69ed342ae7de607f36b39ce53b455fbda69c71700bf57e6f66` |
| `vocab.txt` | 231,508 | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |

These values were verified against the exact revision on 2026-08-01. If download, package import, or model loading fails, the server emits `semantic_unavailable` and returns BM25 results. Full-text search stays offline.
