# Track A release hardening (`track-a-r1`) — release record

Evidence labels (as `docs/architecture/FINANCIAL_REPORTING_MASTER_SPEC.md` §0.1): **S** source · **T** executed here · **R** repository record · **O** owner · **H** hosted (none) · **I** implemented on the branch, not installed · **U** unverified.

**Nothing in this record has been merged, installed on a hosted database, deployed, published or activated.** No hosted migration was applied, no function deployed, no frontend published, no rollout, payment or reporting access changed, no official report issued on hosted infrastructure, no customer record altered.

## A. Verdict

**READY FOR INDEPENDENT REVIEW AS A CANDIDATE; NOT INSTALLED.** The confirmed Track A permission defects (D-01, D-05, D-06) and the related replacement-setting weakness (D-09) are fixed in source with database enforcement that no API role can bypass and that does not depend on any caller-settable value; the release-journal defect (N-04) is fixed; installation is a registered exact-byte transport with preflight, preservation assertions and postconditions, proven to roll back completely on interruption and to retry safely. Remaining before activation: CI green on the exact SHA (A1), deployed-closure verification (A2), the hosted read-only check (A3), installation around the frontend publication (A4), the acceptance window (A5) and the owner's activation decision (A6) — `FINANCIAL_REPORTING_DELIVERY_PLAN.md` §1. One owner/accounting decision is open and fails closed (OD-8).

## 1. Repository

| Item | Value |
|---|---|
| Repository | `hirorobert/axiom-insight-craft` |
| Baseline | `origin/main` `f3d1b4019844fda11395bdc9168e5e3034862efb` (2026-10-24 11:46:59 UTC) |
| Branch | `fix/track-a-release-hardening-20261024` |
| Pull request | https://github.com/hirorobert/axiom-insight-craft/pull/194 (draft) |
| `0a735c9a` | test(release): journal guard reflects applied fs-integrity-r1 (item A) |
| `e7886489` | fix(db): the two migrations, preflight, postconditions, `trackAHardening` proof (first version) |
| `85268f7a` | fix(ui): `companyFramework.ts`, `CompanyManager` |
| `816c9838` | release(track-a-r1): staged transport, registration, CI wiring, test inventories |
| `2e5ccd1d` | docs: this record and the five architecture documents (first version) |
| `8a0c66c3` | fix(db): corrections from the independent review (§8) |
| `5191e68b` | release(track-a-r1): transport re-pinned to `8a0c66c3` (superseded) |
| `fce4c13c` | fix(release): postcondition 2 `tgattr` comparison (found by the transport proof); the hardening proof runs the release checks — **the transport's SOURCE_COMMIT** |
| next commit | release(track-a-r1): transport, registration and literal test identities re-pinned to `fce4c13c` |
| later commits | documentation updates. The PR head is the final SHA |

**Merge constraint.** The staged wrappers name `fce4c13c` in their header comment, so their bytes depend on that commit id. Merge with a merge commit (or fast-forward) so `fce4c13c` stays reachable; a squash merge requires re-pinning `scripts/release/trackAStagedTransport.mjs` (SOURCE_COMMIT and every identity) and re-registering the forms **before** any submission.

## 2. Defects

| ID | Before (baseline) | After (branch) | Class | Proof cases |
|---|---|---|---|---|
| D-01 | Owner could change `companies.reporting_framework` directly at any time; no audit; silently invalidated certified work | Changed only through `set_company_reporting_framework` (owner; audited; idempotent; stale/processing/locked refusals, the lock rule linearized against new certifications and reports); a guard refuses every writer that is not the function's owner role **with this transaction's own audited event** | Fixed (I) | `d1`–`d6`, `e1`–`e3`, `e5`, `e6` |
| D-05 | `service_role` could INSERT/UPDATE/DELETE the FINAL authority pointer and history | Privileges removed; guard trigger (no delete, no re-scope, +1 sequence); deferred scope check from both tables (pointer = latest event; pointer names a FINAL of exactly its version, company and period; no event without a pointer) | Fixed (I) | `b1`, `b2`, `b5`, `b7`, `f1` |
| D-06 | Fifteen history tables without TRUNCATE refusal; `service_role` held TRUNCATE | BEFORE TRUNCATE trigger on each; TRUNCATE revoked from every API role | Fixed (I) | `c1`, `c2` |
| D-09 | Cross-lineage replacement signalled by `cfoclose.fs_replace_authority`, a setting any session can write | Owner-only intent row keyed by the top-level transaction id | Fixed (I) | `b3`, `b4`, `b6` |
| N-04 | `main` failed `releaseJournal.test.ts` (5) and `selfCheckingWrappers.test.ts` (2) | Literal identities and refusal cases; close-out test hides the new transport kinds | Fixed (I, T) | unit suite |
| D-02 | (CFR-MASTER-2) residual mixed authority | Inventory shows consistent blocking except reviewer acceptance of server-detected CRITICAL/HIGH/`INSUFFICIENT_EVIDENCE`, which fails closed | **Downgraded; policy decision OD-8; no code change** | — |
| N-01, O-02 | Refusal copy; 2015 renderer constants | Unchanged | Unresolved (A-H4) | — |

## 3. Implementation

**`20261127100000_fs_track_a_authority_hardening.sql` (batch 1, additive).** §0 refuses (55000 `TRACK_A_BASELINE_CHANGED`) unless the definitions it replaces are the 20261125 ones and every table exists. §1 `_fs_scope_lock` v2 takes `cfoclose.fr_company:<company>` **shared** before the existing scope key. §2 `fs_authority_replacement_intents` (PK = transaction id + version; every privilege revoked from PUBLIC/anon/authenticated/service_role; append-only; no TRUNCATE) and `_fs_replacement_intent()` (reads only the current transaction's row). §3 `fs_set_publication_state` v5 = the 20261125 body with the one setting read replaced by the intent read; `fs_replace_final_authority` v2 records the intent, refuses a different declaration in the same transaction (`AUTHORITY_MISMATCH`), then calls the transition. §4 `fs_bind_publication` v6 likewise (one-line difference, verified by diff). §5 authority privileges revoked from `service_role` (SELECT kept); `fs_report_authority_guard`; `_fs_authority_scope_check` run at commit by the deferred constraint triggers `trg_fsra_event_consistency` (pointer) and `trg_fsrae_event_consistency` (events). §6 `fs_refuse_truncate()` + trigger + REVOKE on fifteen tables. §7 `company_framework_events` (append-only; RLS read by members/owner; `txid` of the writing transaction) and `set_company_reporting_framework` (read-committed check; `auth.uid()` required; validation; **company lock exclusive**; `companies` row `FOR NO KEY UPDATE`; owner check; idempotent replay / `IDEMPOTENCY_CONFLICT`; `unchanged`; `STALE_FRAMEWORK`; `PROCESSING_IN_PROGRESS` while an attempt-fenced check holds a live lease; `FRAMEWORK_LOCKED` once a decided framework has a certification or saved report; event, then update). `_fs_company_decision_lock`: BEFORE INSERT on `tb_certifications` and `financial_statement_reports` takes the company lock shared, which orders the first certification or report against a framework change. §8 EXECUTE only to `authenticated` for the three member functions; `fs_designate_final_authority` no longer executable by `service_role`.

**`20261128100000_companies_framework_change_guard.sql` (batch 2, enforcement).** Refuses (55000 `TRACK_A_ORDER`) unless batch 1 is present. `guard_company_reporting_framework()` (SECURITY INVOKER): if the value changes, refuse `FRAMEWORK_CHANGE_REQUIRES_RPC` (42501) unless `current_user` is the owner role of `set_company_reporting_framework` **and** `company_framework_events` holds this transaction's own event (`txid = pg_current_xact_id()`) for exactly this company, from-value and to-value. An update that resends the same value passes; INSERT is untouched.

**Frontend.** `src/lib/workspace/companyFramework.ts` is the only browser path (structured outcomes; SQLSTATE mapping; no message parsing); `CompanyManager.tsx` calls it before its direct update, no longer sends `reporting_framework` directly, shows the server's refusal and refuses clearing a recorded framework.

**Release.** `docs/release/track-a-r1/preflight.sql` (read-only; baseline in force, not partly applied, existing pointers consistent with their events and naming a FINAL of their own version, company and period, no event without a pointer, frameworks within the four values), `postcondition-1.sql` (objects, no setting read, intent read in place, triggers enabled incl. the decision-lock triggers, both consistency triggers deferred row-level constraint triggers, TRUNCATE trigger on all nineteen tables, privileges per role, member paths kept, every scope through the commit-time check, batch 2 **absent**), `postcondition-2.sql` (guard present, enabled, a BEFORE UPDATE row trigger scoped by `tgattr` to exactly `reporting_framework`, requiring the transaction's audited event; function owner is not an API role; definer/invoker as designed; no API role is a member of the owner; batch 1 still in force; every scope through the commit-time check). Exercised in both directions on a disposable database (each refuses in the wrong state and passes in the right one, T).

**Transport.** `scripts/release/trackAStagedTransport.mjs` renders `release/staged-transport-tra/` from the committed bytes at `fce4c13c`: a bootstrap (private schema `cfoclose_tra_release`; staged artifacts insert-checked against literal identities; append-only events; no client access; no generic executor) and one apply per migration. Each apply, in one statement: transport lock → journal is exactly the approved predecessor → prior batch consumed → own artifacts locked, unconsumed and exact → target not yet installed → baseline captured (sign-off bindings, consumed issuances, FINAL authority, its events, every company's framework) → [batch 1: preflight] → wrapper → postcondition → target installed → baseline unchanged → consume + event. `releaseJournal.mjs` registers both sources' submission forms and the transport kind `tra_staged_transport`; no journal entry claims them yet.

**Compiler.** No compiler or function source changed: bundle `49fc0852…`, closures `745c8170…` / `cdc5416f…` unchanged (T). No regeneration was required.

## 4. Exact hosted installation sequence (gate A4; not performed)

Preconditions: A1 green on the exact SHA; A2 recorded; A3 recorded with journal head **id 80, hash `5481a1bbbc516140ee7717b65c0eed3adf75353b77d39aa96a32513a4a2ead35`** and `preflight.sql` NOTICE `TRA_PREFLIGHT OK`; kill switch ON.

| Step | Action | Bytes / SHA-256 (no final LF) | Expected result |
|---|---|---|---|
| A4.1 | Submit `release/staged-transport-tra/00_track_a_staged_transport.sql` through the canonical journalled migrator, byte for byte | 7,750 / `b92ec084d09998f6e80c7ac48d3533d6a5123c2d32f569d6efe1f792c787422f` | Journal id 81; schema `cfoclose_tra_release` exists |
| A4.2 | Stage, through the exact-byte channel used for fs-integrity-r1, the seven files in `release/staged-transport-tra/stage/` (each one INSERT; refused unless its body equals the literal identity) | source 44,872 `a3b39b90…`; wrapper 46,454 `2a6a9bfb…`; preflight 6,359 `ce7cbfa1…`; postcondition-1 8,661 `cb55b20e…`; source 3,800 `80626d25…`; wrapper 5,384 `44b17250…`; postcondition-2 3,992 `e6f13ab2…` | Seven rows, unconsumed; seven `staged` events |
| A4.3 | Submit `10_tra_1_authority_hardening_staged_apply.sql` | 7,981 / `636370c97a2dc51db4867f5a5c757eabfff838b4d6cef7ab958067e8834141f9` | Journal id 82; NOTICEs `TRA_PREFLIGHT OK`, `TRA_POSTCONDITION 1 OK`; batch 1 consumed |
| A4.4 | Publish the frontend of the release commit (kill switch stays ON); verify reporting shows disabled; save a framework for an undecided test company through the edit form and see one `company_framework_events` row | — | Publish record; check record |
| A4.5 | Only after A4.4 is verified: submit `20_tra_2_framework_guard_staged_apply.sql` | 7,434 / `7be675f1066aa17090007d039a412b70a2c120fa8fab008d7bfd0ceee1b3523f` | Journal id 83; NOTICE `TRA_POSTCONDITION 2 OK` |
| after | Commit the three journal mirrors as `drizzle/migrations/0080_…`, `0081_…`, `0082_…` and add them to `RELEASE_JOURNAL` as kind `tra_staged_transport` with the hashes above | — | `assertMigrationAuthority` OK with nothing pending |

Failure handling: every apply is one atomic statement — a refusal or interruption leaves nothing applied (T6 `m2`, T7 P3/P4); fix the cause and resubmit the **same bytes**. A different journal head refuses with `TRA_TRANSPORT_WRONG_PREDECESSOR` (re-register; never edit the bytes). A4.5 is never submitted before A4.4. No step is "recovered" by dropping a guard.

## 5. Remaining gates (none performed here)

A1 CI green on the exact SHA of the PR head (on `816c9838` every CI job passed, including the database contract tests and the real-application journey; on `2e5ccd1d`, a documentation-only commit, the journey job failed while **starting the local Supabase stack** and was not re-run; the head after the review corrections must be green before A1 is recorded — see the PR checks). A2 deployed-closure verification (download both functions; `verifyDeployedClosure.mjs`). A3 hosted read-only check. A4 above. A5 temporary acceptance window for the acceptance company only, closed afterwards with reporting disabled. A6 owner activation decision. Lovable-side verification: the published bundle corresponds to the release commit; the company edit form uses the audited function; reporting routes are disabled outside the window.

## 6. Required proofs → evidence

All on a disposable loopback PostgreSQL 16.15; hosted grants emulated by the kit (Supabase default privileges); `auth.uid()` simulated as PostgREST does.

| Required proof | Evidence |
|---|---|
| Unauthorized authority writes fail | `trackAHardening` `b1` (service_role, owner, partner × INSERT/UPDATE/DELETE on pointer, events, intents), `b2` (table owner) |
| Legitimate changes succeed with matching events | `b5` (REPLACED; pointer seq 2; intent with actor), `e1`, `e2` (further replacements), `f1` (ESTABLISHED, REPLACED ×3; pointer = latest event everywhere); `b7` (an event without the pointer, a pointer naming another version's publication, an event for a scope without a pointer: each refused at commit); `publicationAuthority` 18/18, `publicationAuthorityLegacy` (designation) pass |
| UPDATE/DELETE/TRUNCATE protections | `c1` (19 tables × service_role/authenticated/anon and owner trigger, also CASCADE), `c2` |
| Flag spoofing cannot bypass | `b3` (session- and transaction-level setting), `b4`, `b6` |
| Direct framework changes fail | `d1` (owner, service_role; member reaches nothing); `d6` (even the function's owner role: no event, an event for another value, an earlier transaction's event — refused; only the transaction's own matching event passes) |
| Authorized changes audited and invalidate dependencies | `d2` (event fields; certification `dependency_changed`), `d3` (replay; idempotency conflict; unchanged) |
| Cross-tenant attempts fail | `d5` (partner, other workspace's owner, owner on another workspace, service_role, anon; RLS on history) |
| Concurrent framework change and FINAL preserve the invariant | `e1`, `e2` (both interleavings, held transactions), `e3` (two changes), `e4` (other periods unblocked), `e5`, `e6` (a report version being written and a framework change, both interleavings: the lock rule cannot be raced) |
| Existing integrity, authority, legacy, issuance and transport proofs pass | 69 proof runs of the CI steps, all exit 0 (master §0.4 T8), incl. `publicationIntegrityGate` present 40/40 and absent mode VALID, `publicationControls`, `publicationConcurrency`, `signoffBinding`, `reportingClosure`, `tbStagedTransport`, `selfCheckingWrappers` |
| Migration interruption rolls back; retry works | `m2` (failure injected after the last statement: schema, triggers, grants, functions, fixtures unchanged), `m3` (retry applies; repeat refused by preflight); transport proof P3 (failure injected inside the migration through the apply: stage, events and journal rolled back; retry applies), P4 (postcondition failure rolled back) |
| Existing sign-off and issued-pack fixtures unchanged | `m4` (publications, bindings, authority, events, issuances, reviewer decisions, policy events, reports, certifications, companies, stored objects byte-identical; sealed pack verifies intact/official/not superseded), `f1`; transport proof P6 (seeded sign-off binding byte-identical) |
| Full release checks incl. the application journey | Unit suite with CI environment (T9: all pass except 4 `jspdf`-importing tests, absent from this workspace); the application journey runs only in CI — **pending** |

**Limits.** PostgreSQL 16.15 locally (hosted is the platform version). Grants are the kit's emulation of Supabase defaults, not the hosted catalog. The proofs cannot show what the hosted migrator does with a submission beyond the journal-row model used by the transport proof. A DBA or the function owner can disable any trigger (master §4.3).

## 7. Fingerprints

| Artifact | Bytes | SHA-256 |
|---|---|---|
| `supabase/migrations/20261127100000_fs_track_a_authority_hardening.sql` | 44,872 (final-LF-removed 44,871) | `a3b39b90f8a6f2b1e48372203c26618b3f864da22db16d53a96932cc21bd9e99` (`25d4b0badfc9a33fa577bc2dc673c5b71aeeda3e6d05201cf86b7bc70979d4c5`) |
| `supabase/migrations/20261128100000_companies_framework_change_guard.sql` | 3,800 (3,799) | `80626d259948579f39b2a8f32d8df4a4baadcb6592a369801335c70399278d1d` (`2df5f8f228331480b45632df937e14d38d859a5f5af93184e53e212addb87a88`) |
| Wrapper of 20261127100000 at `fce4c13c` | 46,454 | `2a6a9bfb3bbf06e57f1f1093b01401793699443085e5659e01472872ba06016c` |
| Wrapper of 20261128100000 at `fce4c13c` | 5,384 | `44b172503e003cf3477210e6cee76f6bf9079a7f357447b40d689c42e16e6b9e` |
| `preflight.sql` / `postcondition-1.sql` / `postcondition-2.sql` | 6,359 / 8,661 / 3,992 | `ce7cbfa1…9731b5d` / `cb55b20e…9513f33d` / `e6f13ab2…a5324394e` |
| Transport forms (bootstrap / apply 1 / apply 2) | 7,750 / 7,981 / 7,434 | `b92ec084…c787422f` / `636370c9…834141f9` / `7be675f1…b1b3523f` |
| Functions `compile-financial-report` / `seal-reporting-pack` | — | `745c8170…` / `cdc5416f…` (**unchanged**) |
| Compiler bundle | — | `49fc0852…` (**unchanged**) |

## 8. Independent review

A separate reviewer, given only the code (not these conclusions), read both migrations, the checks and the definitions they build on. It found no path for anon, authenticated or service_role around the five claims and confirmed the lock order has no cycle. Its findings and their disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 (medium) | "Locked once certified or reported" could be raced: certification and report writers did not take the company lock, so a change could commit beside an in-flight first certification or report | **Fixed** (`8a0c66c3`): BEFORE INSERT triggers take the company lock shared; proof `e5`, `e6` |
| 2 (low) | `SET CONSTRAINTS ALL IMMEDIATE` inside a transaction makes a legitimate FINAL refuse itself (the pointer is written before its event in the 20261125 bodies) | **Accepted and documented**: self-denial only, unreachable through PostgREST (one statement per call), cannot skip the check. Reordering would change the 20261125 bodies the batch keeps verbatim |
| 3 (low) | The commit-time check ran only on pointer writes and compared only the publication id | **Fixed**: also on event inserts; pointer identity checked against the publication and report; event without pointer refused; preflight checks existing data; proof `b7` |
| 4 (low) | Postcondition 2's column check matched the trigger's own name; missing row bit and deferral flags | **Fixed**: `tgattr`, row bit, `tgconstraint`/`tgdeferrable`/`tginitdeferred` |
| 5 (low) | The guard trusted any definer function owned by the same role | **Fixed**: the guard also requires the transaction's own audited event (the function writes it before its UPDATE); proof `d6` |
| 6 (low) | A legacy running row with no lease would block framework changes forever | **Fixed**: only attempt-fenced runs with a live lease count |
| 7 (info) | `fs_designate_final_authority` executable by service_role; stale comments in the kept bodies; intents grow without bound; refused changes are not recorded; the first decision is allowed after certification | Designation revoked from service_role. Comments left (the bodies stay verbatim). Growth: one small row per replacement. Refusals are returned, not stored (no state change). First decision: by policy (master §5.4) |

## 9. Not done, and why

Not merged; not installed; no function deployed; no frontend published; no rollout, payment or reporting access changed; no hosted report issued; no customer record altered; no hosted read (no hosted connection was available to this work); no Track B work. Not executed here: Deno edge tests, the real-application journey, `buildStatementCompiler --check` (esbuild not installable in this workspace; compiler unchanged). IPSAS 47 paragraphs 194–203A could not be retrieved verbatim (master §0.5, Q-1).
