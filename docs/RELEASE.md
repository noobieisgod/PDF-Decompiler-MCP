# Release Procedure

Publication, remote pushes, releases, and tags require separate authorization. Verification scripts never publish.

1. Confirm the worktree contains no unrelated changes and the archival branch remains available.
2. Run `npm ci`, fixture verification, schema generation, `npm audit`, `npm test`, Windows OCR when Tesseract is installed, repository and documentation checks, license review, benchmark, SBOM, package inspection, and release verification on Windows Node 22 and 24. This is the blocking platform gate.
3. Run the configured macOS and Linux jobs when those environments are available. Record them as passed, failed, partial, or unverified. Unavailable best-effort jobs do not block this corrective effort and do not support a compatibility claim.
4. Complete the ownership and Corresponding Source decisions in [`PROVENANCE.md`](PROVENANCE.md).
5. Complete manual Claude Desktop and Codex compatibility rows with exact versions and dates.
6. Run `npm run release:verify -- --release-time` close to publication. The intended npm name must be owned or available. A conflict stops the release and must be reported; scripts never choose another name.
7. Run `npm run package:verify -- <clean-output-directory>`. Inspect npm and MCPB file lists, SPDX SBOM, checksums, native binaries, and licenses.
8. Test each platform-specific MCPB on a clean machine before claiming that package supports the platform.
9. Confirm README commands and package hashes match the tested commit.
10. Obtain explicit publication authorization. Only then may a maintainer remove the `private` guard, publish, push, create a release, or create a release tag.

Never rewrite Git history, delete legacy tags, force-push, or silently change the package name.
