---
owner: unassigned
proposed_owner: REA documentation maintainer
status: draft
audience: maintainers and AI agents; repository-public
baseline: 2.0.0-draft.2 with documented REA checker adaptations
last_verified: 2026-11-03
verified_by: Codex
verification_scope: archive/shared-copy hashes, checker source and offline fixtures; no REA execution
---

# Project documentation checks

REA adopts the user-supplied **2.0.0-draft.2** standard. Its single shared copy is at `I:\REA\standards\project-documentation`; the original ZIP and v1 working copy are preserved in the installation's setup area. No global skill was installed, and no other project was scanned or updated.

This directory carries the deliberately copied checker, its fixtures, the two explicit site routes and [provenance](PROVENANCE.md), rather than another full standards/template library. Start project work at [docs/README.md](../../docs/README.md).

For documentation-only work, invoke `scripts/check_docs.py` directly with an existing system Python 3.9+ interpreter. The exact Windows command and expected result are in [development](../../docs/development.md#documentation-only-check). It reads files without starting REA, Node, MCP, Electron or an analysis provider. No new interpreter or global skill was installed for the refresh.

From the source root with the pinned Node/npm:

- `npm run docs:structure`: fail on supported structural defects; show metadata/drift warnings.
- `npm run docs:report`: also print per-page metadata and unverified-claim counts.
- `npm run docs:strict`: treat warnings as failures. It is not the default CI gate while real owners and legacy review remain outstanding.

The optional Node wrapper selects an existing Python 3.9+ interpreter. It performs no installation. The checker is offline/read-only; `--report` prints to stdout. Shell redirection creates the separate local log. A pass is not semantic, security, approval or release acceptance. The file-only 2026-11-03 checks used system Python directly; the checker/test bytes matched the already tested recovery copy.
