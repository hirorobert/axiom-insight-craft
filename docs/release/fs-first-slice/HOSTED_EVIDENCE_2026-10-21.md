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

The closure digest is computed over the repository source that was deployed. No connected tool returns a deployed
bundle, its source or a deployment attestation: the backend tools offer deploy, delete, invoke, logs and Deno tests only.
The deploy tool's `source_sha256` is "files and settings" with no documented algorithm; it was not reproducible from the
function directories (with or without `_shared`) by any line-list scheme tried, so it is NOT compared with the closure.
Live: seal-reporting-pack serves deployment version 47 (edge log, 17:10:58 UTC); both functions answer 401 without a
session. `retrieve` was not exercised (no issuance exists; see below). Capability gap: no download of a deployed bundle,
so `verifyDeployedClosure.mjs` cannot run here; it needs the CLI (`supabase functions download`) with owner credentials.

## Backend read-only checks (postgres reads; NOT authenticated UI acceptance)

- Bindings, row by row (SHA-256 of `to_jsonb(row)::text`): seq 1 REVIEWED v6 `77bbb1ef71b89ab160fe27e418a65a300c5988e07ee08807c45c826f22c00138`;
  seq 2 FINAL v6 `d217672c17ebf06293ec80aa5317175042b8728516ed158d9bebc58d84a89fbd`. Both: document ca9c61fe…16d6,
  dependencies 27eb64df…242f, approver = owner, approved 2026-10-09T14:11:09Z / 14:11:46Z. Complete digest unchanged.
- Saved FINAL integrity: `financial_statement_reports` v6 `document_hash` ca9c61fe4982845aa055e561a5ff2232ddf6e8539311ad9f24cec1dc9cb016d6
  equals the SHA-256 recomputed from its stored document, and equals both bindings' `document_sha256`.
- Official issuances for the demo company: none. Retrieving an existing official pack is therefore not testable; the
  first issue + seal + verify + retrieve is a NEW write and needs an authenticated owner session.
- Privileges: the three `cfoclose_release` helpers are executable by `postgres` only; no client role has USAGE on the
  schema. `anon` can execute none of fs_work_bounds / fs_account_capacity / fs_statement_composition /
  fs_evidence_statements; `authenticated` can (they refuse inside unless the session's workspace is allowed and enabled);
  the internal `_fs_memo_get` / `_fs_statement_composition_compute` are executable by neither client role.
- Capacity / bounds: the owner's direct postgres read before release found 29 company-period rows, over_capacity = [],
  demo FY2025 18 current + 18 comparative accounts. Re-calling the bounds function here is refused to the read-only role
  (no EXECUTE), and was not worked around.
- Gates: demo and test company disabled, kill switch false.

## Acceptance (browser journey NOT RUN)

- Preflight `07_acceptance_preflight.sql` (owner-run): PATH_A, FY2025 with comparative FY2024, TZS.
- J1–J6 do NOT need a second person. They need the demo company enabled and the owner signed in to the app. They were
  not run because the demo company is disabled until the deployed copies are confirmed, and the owner's session cannot
  be used here.
- J7 (REVIEWED then FINAL): the demo company has one accepted member (the owner, who holds prepare_close, review_close,
  approve_certification, issue_reporting_pack and manage_members) and no capability grants. No sign-off policy event is
  recorded, so the default `separate_approvers` applies: FINAL by the person who recorded REVIEWED is refused
  (SIGNOFF_SEPARATE_APPROVERS_REQUIRED). The policy also allows `solo_owner` (the owner signs both, and every pack
  discloses it), but only if the owner records it explicitly. Either way, this is the owner's decision:
  - Two people: invite a real person to the demo workspace with Partner or Manager (holds review_close); they accept and
    sign REVIEWED, then the owner signs FINAL.
  - Solo owner: on Sign-off (`/workspace/659daa94-116c-4803-99f8-157e0bdd4c62/2025/signoff`) choose "Allow the owner to
    review and approve (solo owner)", give a reason and confirm the statement. This does not test role separation.

## Verdict

NOT READY TO PUBLISH. Open: (1) deployed-bundle closure verification of the two functions, which no connected tool can
do (CLI download, then `verifyDeployedClosure.mjs`); (2) the owner enables the demo company once (1) is done, and runs
J1–J11 signed in, including issue / verify / retrieve; (3) for J7, the owner chooses between a real second reviewer and
recording solo-owner sign-off.
