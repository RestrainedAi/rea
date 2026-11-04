---
owner: unassigned
proposed_owner: REA maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-11-03
verified_by: Codex
verification_scope: documentation, selected source and retained receipts; offline links checked; no REA execution
---

# REA project documentation

REA inspects local applications and packages, preserves the originals, and records what its readers can establish. This is the maintained [RestrainedAi/rea](https://github.com/RestrainedAi/rea) workbench.

**Stage: Active**, reviewed 2026-11-03. The CLI/MCP engine is maintained and the Windows GUI is a local preview. REA runs when needed; reading or updating its documentation does not require starting it. This review used files and an offline checker. Behavior evidence keeps its original dates; release and handoff remain incomplete.

## Start here

| You need to know                                          | Canonical page                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| Purpose, demonstrated state, scope and next milestone      | [Project brief](project.md)                                  |
| How the code and trust boundaries fit together             | [Engineering](engineering.md)                                |
| How to run a safe first task and interpret test results    | [Development](development.md)                                |
| Launchers, outputs, failures and data recovery             | [Operations](operations.md)                                  |
| What was reviewed, what remains unknown and who should act | [Documentation audit](documentation-audit.md)                |
| Why this desktop implementation is being tried             | [Proposed desktop decision](decisions/0001-desktop-shell.md) |

For AI work, read applicable instruction files, this map, the brief, relevant engineering/decisions, development/runbook, and the exact source or contract. A link does not mean its target has been reviewed.

For a file-only documentation task, start with the [offline documentation check](development.md#documentation-only-check). For application work, use the [on-demand operating guide](operations.md#run-only-when-requested). The installed folder is `I:\REA`; the desktop's default output folder is `I:\REA\work\outputs`. [Operations](operations.md) owns the layout and CLI output exceptions.

## Version, ownership and sharp edges

The source baseline is `e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6` plus the `codex/desktop-workbench` working changes. Version 6.4.0 alone does not identify this fork's working files. The local adoption receipt records hashes and actual commands; [development](development.md#command-and-evidence-register) owns the verification register.

Accountable owners are **unassigned**. Page metadata proposes roles; it does not assign them. Until an owner is confirmed, keep unresolved decisions in the [audit](documentation-audit.md) for the project owner to route.

The installed-host setup has been exercised; a fresh-machine installation has not. Native picker/drag-drop, complete accessibility, storage-failure and representative Ghidra UI acceptance remain open. Historical UI tests are evidence for their recorded scope, not a claim every provider or current working change has been accepted.

## Existing references

Keep these specialized sources canonical:

- [Installation](installation.md), [CLI](cli.md), [Ghidra](ghidra-provider.md) and [Windows provider limits](windows-ghidra-p0.md).
- [Palm resources](palm-resources.md), [Instyler](instyler-archives.md), [Samsung](samsung-firmware.md) and [Inno/7z](static-archives.md).
- [Managed code](managed-code-analysis.md), [JavaScript](javascript-application-workflows.md), [Android](android-analysis.md) and [firmware](firmware-analysis.md).
- [Tool design](tool-design.md), [MCP contracts](mcp-contracts.md), [testing](testing.md), [contributing](../CONTRIBUTING.md) and [release conventions](releasing.md).

The [website landing page](index.md) remains a separate publishing entry. Inherited upstream acquisition examples do not override our [fork policy](../AGENTS.md#fork-ownership).

## Documentation standard and coverage

We use **2.0.0-draft.2**, the user-supplied draft, with one shared copy at `I:\REA\standards\project-documentation`. Start with `I:\REA\standards\project-documentation\SKILL.md` and its craft guide when locally available. This is a local resource, not a globally installed skill or an assumed dependency of another project. The repository carries only [checker/adoption guidance](../tools/project-documentation-standard/README.md), fixtures and its own docs; [provenance](../tools/project-documentation-standard/PROVENANCE.md) records the supplied archive and adaptations.

Core pages were reviewed again on 2026-11-03 for documentation structure, selected source references and consistency with retained migration/lifecycle evidence. The [current audit](documentation-audit.md#current-review-2026-11-03) records the coverage, checks and unresolved gates. **Legacy guides with `last_verified: never` received metadata only; their semantics were not revalidated.** They remain available, visibly unreviewed. External links and all other project chats were not exhaustively checked.

Use `npm run docs:report` for metadata/drift findings. Warnings about unassigned owners and documented non-repository example/runtime paths remain visible; the audit records their disposition. `npm run docs:strict` is available for a future mature gate and is expected to fail while those warnings remain. Review on relevant behavior, interface, security, dependency, scope or ownership changes; no recurring review schedule has been created.
