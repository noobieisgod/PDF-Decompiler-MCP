# Release Procedure

Publication, remote pushes, releases, and tags require separate authorization. Verification scripts never publish.

1. Confirm the worktree contains no unrelated changes and the archival branch remains available.
2. Run `npm ci`, `npm audit`, `npm test`, `npm run check`, `npm run docs:check`, `npm run license:check`, and `npm run benchmark` on Node 22 and 24 across Windows, macOS, and Linux.
3. Complete the ownership and Corresponding Source decisions in [`PROVENANCE.md`](PROVENANCE.md).
4. Complete manual Claude Desktop and Codex compatibility rows with exact versions and dates.
5. Run `npm run release:verify -- --release-time` close to publication. The intended npm name must be owned or available. A conflict stops the release and must be reported; scripts never choose another name.
6. Run `npm run package:verify -- <clean-output-directory>`. Inspect npm and MCPB file lists, SPDX SBOM, checksums, native binaries, and licenses.
7. Test the MCPB on a clean machine for every target platform. Native packages make the bundle platform specific even though the manifest names three supported platforms; build and inspect on each target.
8. Confirm README commands and package hashes match the tested commit.
9. Obtain explicit publication authorization. Only then may a maintainer remove the `private` guard, publish, push, create a release, or create a release tag.

Never rewrite Git history, delete legacy tags, force-push, or silently change the package name.
