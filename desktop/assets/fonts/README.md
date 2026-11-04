---
owner: unassigned
proposed_owner: REA desktop maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-10-27
verified_by: Codex
verification_scope: documentation and source-reference review; behavior evidence keeps its recorded date
---

# App-local fonts

The interface uses Inter Latin from the locked VitePress 1.6.4 dependency and IBM Plex Mono Latin 400 from `@fontsource/ibm-plex-mono@5.3.0`. Their license notices are retained here. Generated WOFF2 files are ignored by Git under the repository's no-binaries policy.

`npm run desktop:prepare` validates exact SHA-256 values and restores the fonts from the installed VitePress package and the preserved app-local npm archive. It performs no downloads or global installation and refuses to overwrite differing files. Missing prerequisites produce an actionable error. See the [development guide](../../../docs/development.md) for the maintained-host setup boundary.
