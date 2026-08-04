# Licensing and Provenance Review

## Automated findings

- The project metadata and manifest use `AGPL-3.0-only`.
- MuPDF 1.27.0 declares `AGPL-3.0-or-later`, which is compatible with an AGPL distribution but creates Corresponding Source obligations for bundled native or WASM code.
- PDF.js and the optional model family declare Apache-2.0. MCP, Zod, and canvas packages declare permissive licenses.
- Generated fixture source is original programmatic text, geometry, vector content, raster patterns, malformed structures, and deterministic security dictionaries under CC0-1.0.
- The readable OCR raster is rendered with the pinned `LiberationSans-Regular.ttf` distributed in `pdfjs-dist` under its included Liberation font license. The generator records hashes and expected behavior, and package allowlists exclude all test PDFs.
- `npm run license:check` reads every installed package license. `npm run package:verify` generates an SPDX 2.3 SBOM from the isolated production stage.

## Material reviewed

The migration inventory identifies original repository archives, PDFs, and source trees. The 3.0.0 implementation reuses the repository owner's extraction source and adapts official package APIs. No third-party document text is copied into generated synthetic fixtures.

The separate real-world evaluation corpus contains two checked-in PDFs with document-specific licenses and attribution. Medium Test One combines CC BY-SA Wikipedia text, Wikimedia images under the licenses or public-domain claims listed in `evaluation/ATTRIBUTION.md`, project-owned VEXLearn material, and public-domain Declaration of Independence text. Medium Test Two is original VEXLearn material licensed by Eric Lee under CC BY 4.0, excluding third-party marks and depicted interfaces. TSMC's annual report remains download-only because TSMC's terms do not grant republication permission. Evaluation content is excluded from npm and MCPB package allowlists.

Package inspection excludes evaluation PDFs, tests, release archives, and development-only tooling.

## Release-blocking attestations

Publication is not cleared until the repository owner confirms ownership or relicensing authority for all pre-3.0 source and identifies any copied or adapted code not already represented by dependency packages. A maintainer must also choose and document how exact MuPDF 1.27.0 Corresponding Source will accompany or remain durably available for every npm and platform-specific MCPB distribution.

The same review must inspect native canvas binaries and notices on each target platform, verify PDF.js and Tesseract notices, confirm model and tokenizer license files at the pinned commit, and compare npm and MCPB contents against the SBOM. If any ownership or source-distribution requirement cannot be supported, relicensing must not be described as complete and publication must stop.

No legal conclusion is inferred from package metadata alone.
