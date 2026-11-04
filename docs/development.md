---
owner: unassigned
proposed_owner: REA engineering and QA maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-11-03
verified_by: Codex
verification_scope: offline documentation checks and selected source/receipt review; REA behavior not rerun
---

# Development and verification

## Documentation-only check

Read and edit the files directly. REA, Electron, MCP and analysis providers can stay stopped. Use an existing Python 3.9+ interpreter; the checker needs only its standard library and does not install software, contact the network or execute commands from the pages.

On this host, the existing system interpreter is `C:\Python314\python.exe` (Python 3.14.3). From `I:\REA\source`:

```powershell
Set-Location -LiteralPath 'I:\REA\source'
& 'C:\Python314\python.exe' -B 'tools/project-documentation-standard/scripts/check_docs.py' --root . --docs docs --route-map 'tools/project-documentation-standard/site-routes.json' --report
```

Expected: exit 0 when the supported links, anchors and template checks pass; metadata/drift warnings remain visible. Add `--strict` to make warnings fail. The 2026-11-03 file-only review ran this checker with an explicit date, retained before/after reports and verified the unchanged checker fixtures. No REA process was started. The [audit](documentation-audit.md#current-review-2026-11-03) separates this result from runtime, human review and release acceptance.

## Environment and safe first task

Follow [.nvmrc](../.nvmrc), [package.json](../package.json), [CONTRIBUTING](../CONTRIBUTING.md) and [testing](testing.md). This host uses portable Node 24.18.0/npm 11.16.0 under `I:\REA\tools\node-v24.18.0-win-x64` and source `I:\REA\source`. Selected native inputs/work must meet their provider's filesystem constraints.

A fresh checkout needs locked dependencies (`npm ci`) and `npm run build:cached`. These are **proposed onboarding steps, not a newly performed clean-room install**. Native/optional engines are bring-your-own; do not upgrade unrelated software or replace our fork with the original.

For work that needs engine verification, `npm run desktop:test` is the installed-host first task. It starts actual readers and creates synthetic Samsung, Palm and ZIP inputs under `I:\REA\work\tmp`, checks exports/originals and exercises failure/ownership paths. It does not execute a supplied application or contact a device. **This is an engine test, not the documentation-only check above; it was not run in this review.** Use the pinned Node/npm on PATH and `I:\REA\source` as the working directory:

```powershell
$env:Path = 'I:\REA\tools\node-v24.18.0-win-x64;' + $env:Path
$env:TEMP = 'I:\REA\work\tmp'
$env:TMP = 'I:\REA\work\tmp'
Set-Location -LiteralPath 'I:\REA\source'
npm run desktop:test
```

Expected: exit 0 and 13 passing checks. The v2 adoption receipt records the 2026-10-27 rerun; the earlier installed-host run was on 2026-10-26. This does not establish a fresh-machine installation.

The desktop checks currently target this installed Windows layout. `npm run desktop:check` launches isolated Electron state and drives the real renderer/worker using a supported launch argument to select a synthetic input. It saves local screenshots/receipts and uniquely named synthetic outputs. It does not test the native file picker or establish another platform/clean-machine result.

## Desktop prerequisites

Electron 45.0.0 is app-local under `I:\REA\tools\desktop-runtime`. Its [manifest and lock](../desktop/runtime/package.json) pin dependencies; binaries/licenses stay with the runtime outside Git. Runtime files total 374,097,589 bytes (about 357 MiB), measured on 2026-10-26, excluding cache/state and the existing Node runtime. Self-contained layout does not imply a tiny binary; see the [decision](decisions/0001-desktop-shell.md).

For a future authorized installation, this is a **proposed recipe**, not fresh-install evidence: provision pinned Node, copy `desktop/runtime/package.json` and `desktop/runtime/package-lock.json` into the app-local `tools/desktop-runtime`, run `npm ci --prefix I:\REA\tools\desktop-runtime`, then run that runtime's `I:\REA\tools\desktop-runtime\node_modules\electron\install.js` using pinned Node. Keep npm/Electron caches under `I:\REA\cache` and TEMP/TMP under `I:\REA\work\tmp`. These steps download application dependencies; they must not upgrade unrelated software.

Inter Latin comes from locked VitePress 1.6.4; IBM Plex Mono comes from the preserved `@fontsource/ibm-plex-mono@5.3.0` archive. If missing, obtain it with `npm pack @fontsource/ibm-plex-mono@5.3.0 --pack-destination I:\REA\cache`, then run `npm run desktop:prepare`. Preparation validates exact archive/font hashes, refuses differing files and performs no downloads/global installation. [Font notices](../desktop/assets/fonts/README.md) remain in source; generated binary fonts are ignored.

The documentation helper needs Python 3.9+, standard library only. `npm run docs:structure` selects explicit `REA_DOCS_PYTHON`, the existing app-local Windows Python, or `python3` elsewhere, without installation. Generate existing public documentation assets first in a fresh checkout.

## Command and evidence register

The retained behavior checks were run on 2026-10-26 on baseline `e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6` plus the then-current desktop working files. The v2 documentation/checker adoption was reviewed on 2026-10-27. A later containment-guard refinement has pure-path regression coverage; the old GUI receipt is not a fresh acceptance of every current change. The local v2 receipt records exact hashes, command dates and logs. Version 6.4.0 alone is not a unique working-tree identifier.

| Check                                                                   | Expected                                          | Observed / limit                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run desktop:test`                                                  | Real readers, exports and failure/ownership paths | **13 passed** on Windows/Node 24.18.0: Samsung, Palm PRC, ZIP, source changes, historical/interrupted jobs, immediate/startup cancellation and concurrency.                                                                                                 |
| `npm run desktop:check`                                                 | Real window and inspect-to-findings-to-export     | **10 recorded checks passed**: evidence/content, saved bytes/report, unchanged original, history, keyboard tabs/search/help, minimum-size layout, renderer isolation and no observed failed assets/exceptions. Synthetic input selected by launch argument. |
| `npm run desktop:prepare`                                               | Exact local fonts                                 | Passed; both hashes verified, no downloads/global install.                                                                                                                                                                                                  |
| Python `tools/project-documentation-standard/tests/test_check_docs.py`  | Original helper fixtures                          | **22 passed on 2026-10-27** after the Windows report-label correction; checker behavior only.                                                                                                                                                               |
| Python `tools/project-documentation-standard/tests/test_site_routes.py` | Declared routes; refuse missing/escaping targets  | **4 passed on 2026-10-27**; generated-route integrity and root bounds remain checked.                                                                                                                                                                       |
| `npm run docs:structure`                                                | Supported links/fragments/routes resolve          | Passed during adoption; final counts/result are in the receipt. External links and truth are not checked.                                                                                                                                                   |
| `npm run docs:check`                                                    | Existing generated/fact checks plus structure     | Passed during adoption; final rerun in receipt. Maintained-fork pointers appear in all 19 README languages, preserving parity.                                                                                                                              |
| `npm run check:fast`                                                    | Typecheck/lint/module boundaries                  | Passed during adoption; final rerun in receipt. Warnings are not security/correctness approval.                                                                                                                                                             |
| System Python offline checker, `--report --today 2026-11-03`             | Supported links/anchors and metadata report       | **Passed: 60 pages, 211 local links, 0 structural errors, 84 advisory warnings**; 67 external links skipped. Logs/hashes retained in `I:\REA\setup\documentation-refresh-20261103`. No REA runtime, provider or GUI checks performed. |
| Same direct Python checker with `--strict --today 2026-11-03`             | Warnings fail the diagnostic                      | **Exit 1: 0 structural errors, 84 warnings.** This is the expected warning failure, not a successful strict gate. |
| Unchanged adopted checker fixtures using system Python                  | 22 supplied and 4 route fixtures                 | **26 passed on 2026-11-03** against the C: recovery copy; SHA-256 confirmed the live checker, tests and route map were identical. This tests the helper only. |
| Native picker/drag-drop, screen reader, full disk, real Ghidra UI       | Representative manual/provider acceptance         | **Not accepted/not run**. Native capture returned mismatched target imagery, so that exercise was stopped. Preview-promotion gates remain open.                                                                                                             |

Private inputs/reports/diagnostics stay under `I:\REA\setup` or `work`; do not commit them. A historical receipt proves only its stated scope/revision.

## Documentation v2 checks and sharp edges

From `I:\REA\source` with the pinned Node/npm on PATH:

```powershell
npm run docs:check
npm run docs:report
npm run docs:strict
```

These are the normal Node-based project checks. `docs:check` includes generated-document/fact checks and Turbo; they were not run in this file-only refresh. Use the direct Python command above when REA and its runtimes must remain stopped. The first two commands should exit 0 when their checks pass; they retain metadata/drift warnings. The third is deliberately stricter and is expected to exit 1 while ownership and legacy-review warnings remain. It is an optional diagnostic, not a required release approval or branch-protection rule. `docs:dev` and `docs:preview` start documentation servers and are unnecessary for this offline check.

The checker is based on **2.0.0-draft.2**. `--report` prints metadata; `--strict` fails on warnings; `--stale-days` changes the freshness threshold. It does not establish that an owner is real or that a verification claim is true. See the [adoption audit](documentation-audit.md) for warning disposition and source coverage.

The main sharp edges are host-specific prerequisites, incomplete native-control/provider acceptance, sensitive local job/report paths and absent restore/retention ownership. An output filename such as `report.json` or a caller-supplied example is not a missing source file merely because the drift heuristic reports it. Do not create dummy files, invent owners or refresh dates to manufacture a clean report.

## Requirement-to-check map

| Requirement / risk                           | Canonical evidence                                                                                                                                        | Remaining gate                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Integrity, original preservation, extraction | [Backend regressions](../desktop/test/workbench.test.mjs), [Samsung reader tests](../src/native/samsung/SamsungFirmwareProvider.test.ts), desktop journey | Representative selected inputs/additional profiles                                                           |
| Source identity, cancellation, ownership     | Changed-source, history, interruption, concurrency and startup-close regressions                                                                          | Recursive-directory/race, full-disk and cleanup-failure acceptance; metadata is not a cryptographic snapshot |
| Honest findings/progress/errors              | Saved evidence and [renderer journey](../desktop/test/acceptance.mjs)                                                                                     | Remaining native-dialog and UI error/cancellation paths                                                      |
| Readability/keyboard                         | Figma/rendered screens, arrow tabs, search/help, 1000 x 720                                                                                               | Assistive technology, full keyboard/resize/localization review; no WCAG completion claim                     |
| Documentation                                | Offline fixtures, structure and fact checks                                                                                                               | Human/domain correctness and independent newcomer exercise                                                   |

## Change workflow and troubleshooting

Keep commits/PRs in our own fork. Update canonical docs with material behavior/interface/storage/release changes, or state a specific no-impact reason. Follow [AGENTS](../AGENTS.md); keep private evidence, binaries and build output out of Git.

For generated-site links, verify declared assets/routes rather than deleting valid links. For GUI failures preserve diagnostics: the entry module must finish before readiness; cross-runtime evidence uses JSON. Keep console access while diagnosing preview failures. Follow each provider's setup guide; catalog presence does not establish availability.

Independent onboarding receiver and domain reviewer: **unassigned**. The implementing agent exercised the safe checks; human/domain and independent newcomer acceptance are **not performed**.
