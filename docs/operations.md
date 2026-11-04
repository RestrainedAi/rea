---
owner: unassigned
proposed_owner: REA operations maintainer
status: draft
audience: users, maintainers and AI agents; repository-public
baseline: e847121dea2c0ad9b9e9094f8d9c3afdcc3988e6 plus documented working changes
last_verified: 2026-11-03
verified_by: Codex
verification_scope: file/source review and retained migration/lifecycle receipts; no REA execution in this refresh
---

# Local workbench operations

## Installation and launch

The maintained host uses `I:\REA`: source in `source`, dependencies in `tools`, selected inputs in `work\inputs`, output in `work\outputs`, temporary work in `work\tmp`, desktop state in `work\desktop` and verification records in `setup`. Shortcuts and agent configuration/skills use normal Windows/user locations. Keep credentials/full personal configuration out of reports.

**REA Workbench** still runs `Open-REA.ps1`, the console workbench; `rea.ps1` remains the CLI wrapper. The separate **REA Desktop Preview** shortcut opens the GUI; its script is `I:\REA\Open-REA-Desktop.ps1`. The [source launcher](../desktop/launch.ps1) uses the app-local Electron runtime and displays the requested interactive window. Supplied input programs are not launched.

Window/reader-journey automation passed. Native picker/drag-drop, screen reader, full disk and representative Ghidra UI acceptance remain open. The preview does not replace the current console entry point.

## Run only when requested

The desktop application starts when the user opens its shortcut. The installed
`I:\REA\rea.ps1` CLI starts for a command and exits when the command finishes.
On 2026-11-03 the user selected this on-demand operating mode for Codex too.

The personal Codex MCP registration is intentionally retained with
`enabled = false`. Codex can use the installed REA skill and CLI for a requested
investigation without keeping an idle server. A multi-call MCP investigation
can use an owned temporary stdio session; close its target, client and transport
at task completion and check that its child processes ended. Missing permanent
MCP tools in this mode do not require registration repair. Preserve the chosen
mode during setup and maintenance.

Saved configuration and live connections have separate lifetimes. On
2026-11-03 an already-running Codex host restarted cached REA connections after
the disabled setting had been saved. Those idle servers were stopped before
volume maintenance. Fully quit the old Codex instance after changing the
registration if it still has cached connections; a zero-process snapshot alone
does not prove that the host has discarded them. Do not enable the persistent
registration as a workaround. The retained pre-repair process receipt records
executable/parent checks, not a complete open-file-handle inventory.

File-only tasks, including this documentation refresh, do not need REA. Use the
[offline Python checker](development.md#documentation-only-check), and leave
the desktop, CLI, MCP and providers stopped. Do not run a launcher just to
validate a document or display a version.

The native configuration, source and installed skill were backed up before the
change. Real CLI and temporary MCP requests inspected a synthetic Samsung
package successfully; the temporary connection exposed 177 tools and closed
after the request. Existing idle MCP instances were stopped without closing
Codex or the desktop app. Verification and process observations are recorded in
`I:\REA\setup\on-demand-20261103\verification.json`. These are lifecycle checks;
the earlier provider and UI acceptance records keep their original scope.

## First useful operation

Choose a supported file and an absent new output folder. [Samsung](samsung-firmware.md), [Palm](palm-resources.md), [Instyler](instyler-archives.md) and [static archives](static-archives.md) have different profile/platform constraints. A checksum is not publisher/device authentication.

The preview's intended user path is:

1. Open **REA Desktop Preview**, then choose a file/folder. Native picker and drag/drop are implemented; manual acceptance is pending.
2. Choose inspection, extraction or applicable native analysis; check the displayed destination and use a new folder name.
3. Start analysis. Progress stays indeterminate without real measurements. Cancellation waits for the owned worker and cleanup.
4. Review findings, raw observations, hashes and limitations. Historical findings remain readable if the original moves; re-extraction requires selecting the current original again.
5. Extract supported contents into a new folder. Check the result and `report.json`; use **Outputs** to locate the project.

Automation selected synthetic input using the supported `--open-file` launch argument, then drove real UI buttons/worker. It checked exported bytes/report and unchanged source. This does not certify every profile/control.

CLI JSON goes to the terminal unless redirected. Generic artifact extraction may choose adapter-owned temporary output; its returned `output_root` is authoritative. Do not assume every CLI call saves under `work\outputs`. The desktop explicitly exposes a new destination there. See [development](development.md) for commands/results.

## Promotion and recovery

Before full GUI promotion/public release, record exact source/runtime identity, finish native controls and representative failure/provider checks, review data exposure/licenses/footprint, obtain human/domain review and preserve a recoverable launcher/runtime. Reviewer, approver and receiving owner remain unassigned. No package release or branch-protection change was performed.

The original console launcher is retained; the preview shortcut is additive. If preview startup fails, use the console entry while preserving diagnostics and work/output folders. Do not reset source or delete outputs as a generic recovery action. No rollback/restore drill has been accepted.

## Failure triage

| Symptom                            | Safe next action                                                                           | Acceptance limit                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| GUI/worker startup failure         | Preserve diagnostics; check readiness registration and JSON transport; keep console access | Repeat scoped acceptance after repair                 |
| Provider unavailable               | Follow provider path/version/platform/target guidance                                      | No unrelated automatic installation                   |
| Checksum/format refusal            | Preserve report/original; check provenance and profile                                     | Do not force success                                  |
| Source changed/moved               | Read saved findings; deliberately reselect/reinspect                                       | Old findings do not prove current bytes               |
| Conflict, permissions or full disk | Resolve access/capacity; choose an absent authorized destination                           | Preserve existing exports and failed-attempt evidence |
| Interruption or cleanup failure    | Retain exact observations/owned paths; verify residual resources                           | Process exit alone does not prove cleanup             |
| Credential in diagnostics          | Authorized owner rotates it                                                                | Do not repeat it or infer rotation                    |

## Persistence and recovery ownership

Selected paths, filenames, reports and jobs may be sensitive. Retention/deletion rules, backup target and restore cadence are **unassigned/not agreed**. Preserve data; no automatic deletion/review schedule is introduced. A recovery exercise and receiving-owner confirmation remain pending before wider handoff.

## Installation relocation, 2026-11-01

The active self-contained installation is `I:\REA`; outputs are in `I:\REA\work\outputs`. Desktop shortcuts, the CLI PATH entry and the personal Codex REA registration were relocated. The live Codex REA connection was verified aligned with I: on 2026-11-03 before on-demand mode and later volume maintenance. Earlier receipts retain their original D: provenance. The migration record is `I:\REA\setup\migration-20261101\migration.json`.

Defender quarantined an archive-tool source test fixture and the saved SamFw installer; they were not restored or allowed. Runtime acceptance and copy verification have separate recorded scopes. The obsolete D: original was removed on 2026-11-03 after confirming no D:-based REA processes and freshly verifying all 47,311 files in the C: recovery by SHA-256. A live MCP inspection passed after removal. The cleanup receipt is `I:\REA\setup\migration-20261101\cleanup-deletion-20261103.json`.

At cleanup, I: reported `Spot Fix Needed`, so the recovery at `C:\Users\blahn\REA-Recovery-20261101` was retained. The user reported the I: fixes complete and authorized file access on 2026-11-03. This documentation review did not rescan volume health or repeat provider tests; the earlier warning is historical, not a current health finding. Preserve the recovery until separate cleanup is authorized. Volume repair remains separate maintenance; a spot fix takes the volume briefly offline ([Microsoft documentation](https://learn.microsoft.com/en-us/powershell/module/storage/repair-volume)).
