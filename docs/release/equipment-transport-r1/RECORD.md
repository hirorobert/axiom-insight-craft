# Equipment staged installation transport r1 — candidate, NOT installed

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
- This local environment could not start PostgreSQL as an unprivileged user (user switching denied). Database proof is **pending CI**, not locally passed. Hosted verification and accounting acceptance remain unperformed.
- Local combined candidate: full unit suite **6,653 passed**, 10 skipped, 12 todo (401 passing files); typecheck passed; lint 0 errors / 180 existing warnings; production build and pack isolation passed; single-lockfile authority, generator and release-journal checks passed. Real PostgreSQL proof remains pending CI. No hosted or paid calls.
