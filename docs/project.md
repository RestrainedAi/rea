---
owner: unassigned
proposed_owner: REA product maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-11-03
verified_by: Codex
verification_scope: intent reconciled with selected source and retained receipts; no REA execution
---

# Project brief and current state

REA helps a person understand an application or package, preserve evidence and safely extract supported contents. Development belongs to our maintained fork; [operations](operations.md) owns the installed layout and launch paths.

## One-screen view

- **Stage:** Active. The engine is maintained; the Windows GUI is a local preview.
- **Status reviewed 2026-11-03:** the installation is at `I:\REA`. REA is standalone and starts for requested work; its persistent personal Codex MCP registration is intentionally disabled. Selected reader workflows and the earlier automated GUI journey have dated evidence in [development](development.md#command-and-evidence-register). This file-only review did not rerun them.
- **Next milestone:** accept native file selection/drag-drop and representative failure, accessibility and provider cases before promoting the preview.
- **Top risks:** fresh-machine setup is not accepted; native-control automation was stopped after a capture/target mismatch; accountable owners and data recovery policy remain unassigned.
- **Decision requested:** none for this documentation update. Release and handoff gates remain open.

The [six-page Figma direction](https://www.figma.com/design/H6muUNyi0TgFNBAQGAzv1K/REA-Workbench?node-id=3-52) and implementation were authorized in the current REA chat. The six tasks are Workbench, Analysis Setup, Running Analysis, Findings, Export and Outputs. Design examples are illustrative; live counts must come from actual REA results.

## Scope and acceptance

| Requirement                                                                      | State                                                           | Observable acceptance and evidence                                                                                                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect selected local inputs and preserve originals                             | Implemented; selected profiles verified                         | Actual Samsung, Palm PRC and ZIP reader checks; unchanged source bytes. See the development register.                                                                 |
| Extract supported content into a new destination with durable evidence           | Implemented; selected profiles verified                         | Saved bytes match the fixture/report, original remains unchanged, conflicting/malformed cases are refused.                                                            |
| Keep failures, cancellation and interrupted history truthful                     | Implemented; selected regressions verified                      | Changed-source, cancellation, concurrency and historical-record regressions; broader race/cleanup/storage coverage remains open.                                      |
| Provide six usable desktop views                                                 | Implemented preview; scoped automated journey verified          | Real Windows window, inspect → findings → export → saved output, keyboard/size checks. [Desktop module](../desktop/README.md).                                        |
| Native file selection, full accessibility and representative Ghidra UI operation | Implemented or available by provider; acceptance incomplete     | Finish actual native-control/provider and assistive-technology checks; retain failures and limitations.                                                               |
| Keep our fork and compact local layout                                           | Authorized constraint; installed layout/source policy inspected | Own-fork remote/policy, app-local dependencies and explicit output destinations. Electron's footprint tradeoff is in the [decision](decisions/0001-desktop-shell.md). |
| Run independently and only when needed                                           | Accepted user constraint; configuration and lifecycle receipts inspected | Desktop/CLI remain separate entry points; task-owned MCP sessions close after use. [Operations](operations.md#run-only-when-requested) records the cached-session caveat and acceptance limits. |
| Maintain documentation while REA remains stopped                                 | Verified for this documentation task                           | Offline Python link/metadata checks and file review only; no desktop, REA CLI, MCP server or provider launched. Results are in the development register. |

This change does not execute supplied proprietary programs, flash devices, recover accounts, establish publisher authenticity from checksums, reconstruct complete proprietary source, or finish the separate Palm-to-Windows/mobile conversion.

## Risks and next actions

The [audit](documentation-audit.md#prioritized-open-work) is the one gap/ownership register. The [engineering overview](engineering.md) owns trust boundaries and identity limits; [development](development.md) owns commands and exact results. Do not promote a planned command, installed engine, passing structure check or old receipt into a current runtime guarantee.

The [desktop-shell decision](decisions/0001-desktop-shell.md) remains proposed for formal acceptance. Human/domain review, independent receiving-owner confirmation and appropriate operational recovery evidence are not complete.
