# Contributing

Use Node.js 22 or 24 and install with `npm ci`. Before submitting changes, run `npm test`, `npm run check`, `npm run docs:check`, `npm run license:check`, and `npm audit`.

Changes to schemas, extraction, paths, networking, cursors, cache state, native processes, or packaging require focused tests. Use synthetic or redistributable fixtures and record their provenance. Do not add telemetry, remote AI calls, unbounded processing, unsupported performance claims, committed dependency trees, archives, or generated release bundles.

Breaking public changes require migration examples. Security reports belong in private GitHub Security Advisories, not public issues.
