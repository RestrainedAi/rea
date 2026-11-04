---
owner: unassigned
proposed_owner: REA documentation maintainer
status: draft
audience: maintainers and AI agents; repository-public
baseline: 2.0.0-draft.2 supplied archive plus REA checker adaptations
last_verified: 2026-11-03
verified_by: Codex
verification_scope: supplied archive rehashed; 21 shared files matched; existing checker adaptations inspected
---

# Documentation adoption provenance

The user requested adoption of `project-documentation-standard-v2.0.0-draft2.zip` on 2026-10-27 for this REA project. The preserved archive SHA-256 is `05ffd3dc4d5b290d7b7f40b69822f185bd27cd554463d038bf1fdbefd1480211`.

The user supplied the same archive again for the 2026-11-03 documentation refresh. Its SHA-256 was rechecked, and all 21 files in the shared full copy matched the archive byte-for-byte. The existing adoption was reused. The [current audit](../../docs/documentation-audit.md#current-review-2026-11-03) records the file-only scope and remaining gates; no REA process, installation or CI change was needed.

One shared full copy lives at `I:\REA\standards\project-documentation`. Immutable intake and its file/hash manifest remain under `I:\REA\setup\documentation-standard-v2.0.0-draft2`. The prior v1 project working copy was preserved at `I:\REA\setup\documentation-adoption-v1-before-v2`; the earlier original ZIP remains preserved separately. These are historical recovery records, not competing live policies.

The earlier v1 archive's recorded SHA-256 is `725ea8e3d278d44ddb74954bc2ebf51925f573938cdb0f2ca10c769e8d5aa1e4`. Its package validation claims are historical material; they are not repeated as current REA acceptance.

The repository intentionally carries only the reviewed checker, original v2 fixtures, REA route fixtures, route map and project integration. This follows v2's allowance to copy the checker while sharing one maintained standard. Templates are not stamped into unrelated projects or installed globally.

Adaptations:

1. Report labels use portable POSIX separators. The unmodified supplied suite ran 22 tests on Windows with one report-label failure; this correction makes all 22 pass. The original archive/shared package remains unchanged.
2. The explicit route map retains two valid VitePress catalog URLs. Mapped files must still exist inside the root; absent assets, unmapped broken links and escape attempts still fail. Four additional fixtures verify this behavior.
3. The Node wrapper forwards report/strict/date/staleness flags while selecting an already installed interpreter. Normal CI fails on structural errors and leaves warnings visible; no branch protection or approval has been invented.

Page metadata distinguishes reviewed core documentation from legacy semantic review that was not performed. Unknown owners and unreviewed claims remain unknown. External sources were not re-fetched and no exhaustive chat, provider, security or newcomer acceptance is claimed. The local v2 adoption receipt records actual checks, source hashes and outstanding gates.
