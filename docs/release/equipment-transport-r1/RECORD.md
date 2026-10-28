# Equipment staged installation transport r1 — installed 2026-10-28

## Hosted installation evidence — 2026-10-28 UTC

Owner-authorized installation from merged PR #213, source HEAD `5877ba715e90f4f5911f1211786ca768af10dc80`. Independently confirmed predecessor 88/hash `238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8`; neither target nor the release schema existed. Generator check passed. Prior owner-confirmed database/Storage recovery artifacts remain historical references, not a new restore test.

| Hosted id | Actual native mirror | Bytes | SHA-256 |
|---|---|---:|---|
| 89 | `0088_equipment_staged_transport` | 7,393 | `bdc337e3030a44df205f80dbdc5b3ce50c3eadb0d3599cc57207ccef96a811fc` |
| 90 | `0089_eqp_1_preparation_staged_apply` | 9,348 | `92ea5a25c14dc6b31b8cbcf6160982eedb239df99004215d1cf702ced469c47b` |
| 91 | `0090_eqp_2_multiclass_staged_apply` | 9,755 | `ed1ceb09ff9d1bd85a022e38cff680ed725855df4898061cc97d6830763a3644` |

All three mirrors are byte-identical to the registered transport files (no added final LF). Both generated INSERTs were submitted through the privileged data tool as inert text; database recomputation confirmed 18,476 / 54,129 UTF-8 bytes and the pinned source SHA-256s before execution. Both rows are consumed; exactly two applied events record predecessors 89 and 90. No source was submitted directly as executable SQL.

Postconditions passed: all target tables/functions exist; exposed equipment functions are executable by authenticated only, internal helpers by none of anon/authenticated/service_role. Release schema USAGE and helper EXECUTE remain denied to those three roles. Both atomic applies verified their explicit preserved-table perimeter under SHARE locks (baseline hashes `df93184cbd5dd4467c8158be880297e3c9b214705a14553755236b44cc674b83` and `275644037ef82d0d3ef67c6d6c711cab7584b61f8d5203680569336523a6bb2a`).

Original seq 1/2: two rows; canonical digest unchanged `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`. Canonical bytes are `string_agg(to_jsonb(row)::text, E'\n' ORDER BY seq)` converted to UTF-8, with no trailing newline—not a JSON array. Individual row hashes still match the historical record.

Schedules 2 / definitions 5 / disclosures 9, unchanged hashes respectively `7fe258a74daddf20a78b0d74be46e7d201c1e5a7f08674c1a56ca609c9406710`, `03a924a1ffae276b21f269099010ac7d30c92b9bd8241aea007b4a693f4763dc`, `5e0a0ce8a29cb35610369d96131107a18c92eb483b2dc3e1387a3736de8b2e51`. New workpaper and answer tables are empty. Actual runtime settings preserved: reporting kill switch false, beta reporting true/revision 4, general/beta AI false, commercial state CUSTOMER_PAYMENTS_ENABLED. This installation neither endorses nor changes those settings. No file operation, financial correction, function deployment, paid call, publication or activation occurred.

Backend installation prerequisite is satisfied; publication remains separately authorized. Authenticated equipment workflow/accounting acceptance and deployed-function source attestation were not performed by this installation.

## Historical candidate record (retained below)

## Purpose and authority

Lovable stopped at approved main `b7ac24017b0b99a8ba2a125066d67e8f44d8284a`: its migrator receives SQL text and cannot load either authored source directly. A previous hand-entered migration had indentation drift. This candidate supplies the repository-required per-release staged transport; it changes neither approved equipment source, application code, old journalled transport, nor applied history.

Charter B1, P6/P7 and §§11.3–11.4: exact identities, transaction ownership, preserved records, honest deployment evidence. The charter remains proposed pending recorded adoption/accounting review. No policy exception is requested. Existing AGENTS.md large-SQL transport rule applies. Owner authorized preparing the installation; this candidate still needs review/CI and owner merge authorization. It does not authorize credits, hosted installation, publication or activation by itself.

## Facts and immutable inputs

Platform-reported hosted predecessor: journal **88**, tag `0087_internal_beta_team_bootstrap`, SHA-256 `238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8`. Not independently queried here. Neither equipment migration installed; two schedule submissions, five definitions, nine disclosure texts reported. Original bindings seq 1/2 remain two rows with canonical UTF-8 digest `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`.

Current reported settings: reporting `kill_switch=false`, AI off, payments `CUSTOMER_PAYMENTS_ENABLED`. These are preservation baselines, not a new decision that payment activation is appropriate. No resetting to older settings; no access/financial/commerce changes in this release. User testing and independent deployed-function attestation remain separate evidence.

| Approved source at b7ac2401 | Bytes | SHA-256 |
|---|---:|---|
| `20261205100000_fs_equipment_preparation.sql` | 18,476 | `6a2a33c7d6c35d917172a1df42561e7d6a4ce2838a96e27764889bc75e61b9f7` |
| `20261206100000_fs_equipment_multiclass.sql` | 54,129 | `c73085b386cb461977b9072b4ec753ea23c0bf8f8474e1693a86fad3f97e585e` |

## Contract and ordered installation (after authorization)

Generator: `scripts/release/equipmentStagedTransport.mjs`; own private schema **cfoclose_eqp_release**. Three newly created helpers only, no generic executor, no application grants changed. Staged tables use RLS with no client policies; PUBLIC/anon/authenticated/service_role have no schema/table/sequence/helper rights.

1. Recheck hosted history and both pending sources; if state differs, reconcile rather than repeat. Confirm recovery references and original seq 1/2 canonical digest with the previously recorded verification query. Snapshot existing schedules, definitions, disclosures and settings.
2. Apply `release/staged-transport-equipment/00_equipment_staged_transport.sql` through the native migrator. Expected journal **89**, only if 88 is still the exact predecessor. Verify actual recorded bytes; only the migrator's one final LF is registered as an alternative. Any other transport drift is unresolved, not passed.
3. Load both generated files under `release/staged-transport-equipment/stage/` as **inert data**. A source is never executed by staging. The insert trigger recomputes UTF-8 length and digest and rejects any altered body before storing it. This is why text submission of a staging INSERT is safe against accidental byte drift, whereas direct submission of executable source was not. Prefer a parameterized privileged connection reading the exact files, if available. No browser/service client receives staging access. Confirm two exact, unconsumed rows before continuing. Never claim STAGED without those checks.
4. Apply `10_eqp_1_preparation_staged_apply.sql` (expected **90**), then `20_eqp_2_multiclass_staged_apply.sql` (expected **91**) through the native migrator. Each is one DO statement under the migrator transaction: serialize transport, lock/check predecessor id and hash, require prior consumption, lock own stage, recompute source length/digest from body, reject uncertain/installed target, capture explicit preservation perimeter under SHARE locks, execute approved source, verify target, compare perimeter, mark consumed and append event. A failure rolls back that statement and consumption. Earlier committed entries remain installed; batches are not atomic together.
5. Reconcile all three actual journal entries, two consumption records and two applied events, preserve original bindings and application/settings snapshots. Register actual mirrors/metadata in Drizzle and `RELEASE_JOURNAL` as **equipment_staged_transport** only after real installation. No future mirror is fabricated in this PR. Authority supports that kind, with coverage checks against the pinned authored sources; a temporary fixture tests registration without declaring hosted application.
6. Run generator check, migration authority, release-journal checks and affected tests after registration. Commit bookkeeping and name final SHA. Frontend publication is separately authorized after backend verification. Complete normal authenticated equipment journey and accountant acceptance afterwards.

Do not hand-edit source or applied history, disable guards, replace schedules, alter disclosure text, repeat earlier migrations, deploy unrelated edge functions, activate AI/payments/reporting, or use paid provider calls. An unknown installation response requires reading journal/schema/staging status; never blindly retry.

## Preservation perimeter and limits

Each apply compares sorted JSON rows (UTF-8 SHA-256), with SHARE locks on the explicit relations: companies, publication bindings, all pack issuances, FINAL authority/events, schedule definitions/submissions, disclosure texts, reporting rollout state/company list/audit, assistant settings, internal-beta policy and commercial platform state. Batch 2 additionally preserves any workpapers/policy insertion receipts already recorded after batch 1. Locks are held only for the migration transaction. They can briefly block writes; lock acquisition failure stops installation. This is not a claim that every database object or all Storage bytes were attested. The original two-row external baseline remains a separate identity check.

New helper/table creation is expected. Transport stage/applied events and migrator journal rows are expected deltas. No business row inserts are needed for installation. An unexpected delta stops publication and requires investigation; committed earlier transactions cannot be undone by a later postcondition.

## Validation

- Nine targeted deterministic tests: pinned source/working-copy parity; five generated files; literal registrations; inert staging; restricted bootstrap helpers; predecessor/re-hash/execution ordering; explicit preserved tables; altered mirror/source refusal; migration-authority future-registration fixture; current sources still pending.
- New `equipmentTransport` PostgreSQL proof, 21 named manifest cases, on the real pre-equipment migration chain: wrong id/hash, private rights incl. service role/sequences, missing/altered/unknown stage, source inertness, immutable evidence, order, direct metadata tamper, late failure for both batches, hostile DDL hook causing baseline failure, source application, duplicate refusal, unrelated journal entry, concurrent second apply (one success), and preserved seeded schedule/disclosure/settings. Structured results are validated against the manifest in CI.
- This local environment could not start PostgreSQL as an unprivileged user (user switching denied). Database proof passed in CI run 40660971856 on 2661c494 (21/21, structured result valid), not locally. Final amended-head CI is still required. Hosted verification and accounting acceptance remain unperformed.
- Local combined candidate: full unit suite **6,653 passed**, 10 skipped, 12 todo (401 passing files); typecheck passed; lint 0 errors / 180 existing warnings; production build and pack isolation passed; single-lockfile authority, generator and release-journal checks passed. Real PostgreSQL proof subsequently passed 21/21 on 2661c494; final amended-head CI is required. No hosted or paid calls.

### Exact-base guard registration

Initial CI correctly refused the three new release/proof script paths: they had not yet been named in the automation-surface guard. This amendment registers exactly those three files; it changes no comparison base, scanner or refusal behavior and introduces no prefix/glob exception. Re-run against explicit base b7ac2401 and require final-SHA CI.

The exact-base guard + transport tests passed 21/21 after registration. CI run 40660971856 completed the new equipment database proof successfully on 2661c494; its pending full-run status and the initial guard failure are not full clearance. No SQL/transport/proof body changed in the guard amendment.
