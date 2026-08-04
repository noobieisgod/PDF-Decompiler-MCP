# Real-world evaluation set

This directory complements the deterministic synthetic fixtures with documents that resemble actual user workloads. It is not included in npm or MCPB packages.

Two redistributable samples are committed:

- `Medium Test One.pdf` combines attributed Wikipedia and Wikimedia material, project-owned VEXLearn reference material, and public-domain Declaration of Independence text. See `ATTRIBUTION.md` before reuse.
- `Medium Test Two.pdf` is the project author's original VEXLearn guide, licensed under CC BY 4.0. Third-party names, trademarks, and depicted interfaces remain the property of their owners.

The TSMC annual report is not committed because TSMC's site terms do not grant republication rights. Download the full report from the [official 2024 Annual Report page](https://investor.tsmc.com/static/annualReports/2024/english/index.html) and save it as `evaluation/pdfs/Heavy Test One.pdf`.

The manifest records the SHA-256 of the copy validated in August 2026. TSMC may update the downloadable file without changing its title, so record the actual hash reported by your run when it differs from the historical baseline.

Run the corpus checks with:

```powershell
npm run evaluation:verify
npm run test:local-pdfs
```

The local test command runs the two included samples and also runs Heavy Test One when it is present. Missing download-only samples are reported by absence rather than treated as checked-in content.

The repository's AGPL license does not replace the document licenses recorded in `manifest.json` and `ATTRIBUTION.md`.
