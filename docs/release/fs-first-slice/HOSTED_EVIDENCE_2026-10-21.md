# FS first slice — hosted evidence, 2026-10-21 (UTC)

Target: Lovable Cloud backend (one instance serves preview and published app). Frontend NOT published.
Backup observed by the owner (screenshot): completed 2026-10-20 00:35:28 UTC, Restore available. Nothing restored.

## Database (DONE)

Applied through the hosted migrator, each submitted once in its registered no-final-LF form; each mirror byte-identical
to `release/staged-transport/` at reviewed 78e923d (originals from daa23e4, unchanged).

| Hosted id | Tag | SHA-256 | when (ms) |
|---|---|---|---|
| 65 | 0064_fs_release_staged_transport | ea6e6ec703b42a9e2d100d2be70c609587d551655a56c89bf605c719afffaf32 | 1792601984044 |
| 66 | 0065_fs_controls_r1_staged_apply | c845a02ca49f43bb5b55e69ad26a77b6af32f3fcda45f9fb0bdb74eee8ce9653 | 1792602300202 |
| 67 | 0066_fs_journey_r1_staged_apply | a421b7f9587f54d6c14077976ad2f42f2e5d8641fd2394b682b7cc5092d3217b | 1792602338481 |
| 68 | 0067_fs_bounds_r1_staged_apply | 1c6cb96f22e317b35d3c2e2b574ea99786500c5df46ce5d44b61bee418377d54 | 1792602377600 |
| 69 | 0068_fs_capacity_r1_staged_apply | 0589f056ef0165c6b52adeb5d146a8cc58267682ba6b91c3cd7e2ffc96833008 | 1792602414913 |
| 70 | 0069_fs_memo_r1_staged_apply | dbff469ea43ae9c2f364cb602165c727d29cc6a96eade7d7f7217af4b0e2a496 | 1792602453026 |

- `cfoclose_release`: 15/15 artifacts consumed; applied events seq 16–20 with predecessor ids 65–69. Schema, tables and
  the three helpers privileged to `postgres` only; RLS on; no client USAGE.
- Each batch ran its staged preflight, ORIGINAL wrapper and staged postcondition in one transaction (any failure would
  have rolled back the batch and its stage state).
- Sign-offs: 2 bindings, complete-row digest de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642 before and
  after every batch (REVIEWED v6 and FINAL v6 of fsr-2025-659daa94…, approver = the company owner).
- Registered in `scripts/ci/releaseJournal.mjs` (kind `staged_transport`, pinned SHA-256). MIGRATION_AUTHORITY: OK (65
  entries; PENDING_HOSTED_APPLY: none). STAGED_TRANSPORT: OK (21 files). Focused tests 34/34.

## Edge Functions (DEPLOYED; deployed-bundle closure NOT independently verified)

| Function | Source closure (functionClosure.mjs) | Required | Deploy tool `source_sha256` (different algorithm) |
|---|---|---|---|
| process-trial-balance | e2553c3b559a9bead72f5afd022d568419c0a6ea1b542ea25a6ade1a7b975bd8 | equal | 18fba268cf0cf337a0bed2c45acd613983e570627990e54f396f85776a7d5b22 |
| seal-reporting-pack | dd4f0855705566a92b4cddcf3b045760dff40d6cc01d29a950a90ae295ec3e0d | equal | 5ac191f47bed942d34eb67a0a9dd9f6d8391cb9222c8dc3c620a011c046c1833 |

The closure digest is computed over the repository source that was deployed. The deployed bundle itself was not
downloaded (no CLI/access token in this environment), so `verifyDeployedClosure.mjs` was NOT run against it. Live
answers after deploy: both functions respond (unauthenticated: 401). The `retrieve` action was not exercised with a
real session.

## Acceptance (NOT RUN — blocker)

- Preflight `07_acceptance_preflight.sql` (owner-run): PATH_A, FY2025 with comparative FY2024, TZS.
- Demo company `659daa94…` has exactly ONE accepted member: its owner. Since fs-controls-r1, REVIEWED and FINAL require
  separate approvers (SIGNOFF_SEPARATE_APPROVERS_REQUIRED), so J7 (and any new REVIEWED → FINAL) cannot be performed
  with real, role-separated people. The procedure forbids creating an account for this purpose; adding a genuine
  reviewer is an owner decision.
- Reporting gates at end of session: demo `659daa94…` disabled; test company `e18d3218…` disabled; kill switch false.
  The demo was NOT re-enabled because acceptance cannot proceed and the deployed bundle is not verified.

## Verdict

NOT READY TO PUBLISH. Open: (1) a genuine second person with `review_close` on the demo workspace (owner action), then
the browser journey J1–J11 including issue / verify / retrieve; (2) deployed-bundle closure verification of the two
functions (download with the CLI, then `verifyDeployedClosure.mjs`); (3) re-enable the demo company only after (2).
