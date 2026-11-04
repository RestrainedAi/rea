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

# REA desktop workbench (local preview)

The six-page shell follows the [Figma direction](https://www.figma.com/design/H6muUNyi0TgFNBAQGAzv1K/REA-Workbench?node-id=3-52). Start with the [documentation map](../docs/README.md) and [operations](../docs/operations.md).

The actual Windows window and inspect â†’ findings â†’ verified export flow pass scoped automation. Thirteen backend tests cover Samsung, Palm PRC and ZIP readers plus source changes, cancellation, history and concurrency. Native picker/drag-drop, screen-reader, storage-failure and real Ghidra UI acceptance remain open. This is a local preview, not a public release or full accessibility/security approval.

- `main.mjs` / `preload.cjs`: local protocol, isolated renderer, native dialogs and named IPC.
- `engine.mjs` / `worker.mjs`: source-identity metadata, owned jobs, existing services and durable reports. JSON crosses runtimes; ownership continues through worker closure.
- `renderer.js`, `index.html`, `styles.css`: six primary views, history, tools, errors and keyboard interactions.
- `test/workbench.test.mjs`: actual readers and meaningful negative/ownership regressions.
- `test/acceptance.mjs`: Windows renderer/worker journey with synthetic input through the launch argument.
- `runtime`: pinned metadata; installed Electron remains under the app's tools folder.
- `prepare-fonts.mjs` / `assets`: local Figma SVGs, verified generated fonts and notices.
- `launch.ps1`: interactive Windows startup using the app-local runtime.

On the maintained host, use `I:\REA\Open-REA-Desktop.ps1` or **REA Desktop Preview**. The original console launcher remains available. [Development](../docs/development.md) records prerequisites, commands/results and clean-install limits. Runtime binaries and generated WOFF2 fonts are not committed.
