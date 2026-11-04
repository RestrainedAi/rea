---
owner: unassigned
proposed_owner: REA architecture maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-10-27
verified_by: Codex
verification_scope: documentation and source-reference review; behavior evidence keeps its recorded date
---

# ADR 0001: Desktop workbench shell

- Status: **proposed**; Electron is used in the locally tested implementation preview.
- Decision owner / approver: **unassigned**. Proposed role: REA maintainer.
- Recorded: 2026-10-26 by Codex. This is not a backdated human approval.
- Audience/access: engineering, QA and product maintainers; repository-public.
- Review trigger: launch findings, dependency/security support changes, footprint constraints or release review.

## Context and drivers

The user authorized implementation of the six-page Figma workbench, prefers compact self-contained software under `I:\REA`, and expects native Windows file selection, readable findings and a reliable inspect-to-export workflow. Existing REA application services should remain the semantic owner.

## Options and current implementation choice

1. Electron shell with local HTML/CSS/JavaScript, a restricted preload and an owned portable Node worker. This reuses the web-style Figma layout and native dialogs, at the cost of a bundled Chromium/runtime footprint and updates.
2. Native Windows UI/WebView2 shell. Potentially smaller when a system runtime is suitable, but needs a separate host/binding/deployment path and platform-specific validation.
3. Local browser interface. Reuses a system browser but adds a local service/origin lifecycle and needs a separate native-dialog/desktop integration solution.

Codex chose option 1 for the implementation experiment and stated it in the current chat. The user authorized continuing implementation; that does not establish a separate formal technology decision or release approval. Promote this ADR to accepted only after an accountable owner reviews the evidence and tradeoffs.

## Consequences and acceptance

Keep app data, runtime/cache and outputs under the application folder; retain normal OS/user integrations where needed. Do not load remote code, expose raw IPC/Node APIs, execute supplied inputs or replace source-domain contracts with UI heuristics. Electron source configuration alone does not prove runtime containment.

A real Electron window and automated inspect-to-export journey now pass scoped acceptance. The current Electron 45.0.0 runtime occupies about 357 MiB (374,097,589 bytes), excluding cache/state and existing Node; measured on 2026-10-26. This is a self-contained layout, with a material footprint tradeoff. Native-dialog/drag-drop, remaining failure/provider and assistive-technology checks, footprint/license review and owner acceptance remain required before treating this decision as release-ready. No alternative has been silently ruled out.

Canonical context: [engineering](../engineering.md), [project status](../project.md), [operations](../operations.md).
