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
| `e7886489` | fix(db): the two migrations, preflight, postconditions, `trackAHardening` proof — **the transport's SOURCE_COMMIT** |
| `85268f7a` | fix(ui): `companyFramework.ts`, `CompanyManager` |
| `816c9838` | release(track-a-r1): staged transport, registration, CI wiring, test inventories |
| later commits | documentation (this record; the five architecture documents). The PR head is the final SHA |

**Merge constraint.** The staged wrappers name `e7886489` in their header comment, so their bytes depend on that commit id. Merge with a merge commit (or fast-forward) so `e7886489` stays reachable; a squash merge requires re-pinning `scripts/release/trackAStagedTransport.mjs` (SOURCE_COMMIT and every identity) and re-registering the forms **before** any submission.

## 2. Defects

| ID | Before (baseline) | After (branch) | Class | Proof cases |
|---|---|---|---|---|
| D-01 | Owner could change `companies.reporting_framework` directly at any time; no audit; silently invalidated certified work | Changed only through `set_company_reporting_framework` (owner; audited; idempotent; stale/processing/locked refusals); a guard refuses every other writer by role identity | Fixed (I) | `d1`–`d5`, `e1`–`e3` |
| D-05 | `service_role` could INSERT/UPDATE/DELETE the FINAL authority pointer and history | Privileges removed; guard trigger (no delete, no re-scope, +1 sequence); deferred pointer-equals-latest-event check | Fixed (I) | `b1`, `b2`, `b5`, `f1` |
| D-06 | Fifteen history tables without TRUNCATE refusal; `service_role` held TRUNCATE | BEFORE TRUNCATE trigger on each; TRUNCATE revoked from every API role | Fixed (I) | `c1`, `c2` |
| D-09 | Cross-lineage replacement signalled by `cfoclose.fs_replace_authority`, a setting any session can write | Owner-only intent row keyed by the top-level transaction id | Fixed (I) | `b3`, `b4`, `b6` |
| N-04 | `main` failed `releaseJournal.test.ts` (5) and `selfCheckingWrappers.test.ts` (2) | Literal identities and refusal cases; close-out test hides the new transport kinds | Fixed (I, T) | unit suite |
| D-02 | (CFR-MASTER-2) residual mixed authority | Inventory shows consistent blocking except reviewer acceptance of server-detected CRITICAL/HIGH/`INSUFFICIENT_EVIDENCE`, which fails closed | **Downgraded; policy decision OD-8; no code change** | — |
| N-01, O-02 | Refusal copy; 2015 renderer constants | Unchanged | Unresolved (A-H4) | — |

## 3. Implementation

**`20261127100000_fs_track_a_authority_hardening.sql` (batch 1, additive).** §0 refuses (55000 `TRACK_A_BASELINE_CHANGED`) unless the definitions it replaces are the 20261125 ones and every table exists. §1 `_fs_scope_lock` v2 takes `cfoclose.fr_company:<company>` **shared** before the existing scope key. §2 `fs_authority_replacement_intents` (PK = transaction id + version; every privilege revoked from PUBLIC/anon/authenticated/service_role; append-only; no TRUNCATE) and `_fs_replacement_intent()` (reads only the current transaction's row). §3 `fs_set_publication_state` v5 = the 20261125 body with the one setting read replaced by the intent read; `fs_replace_final_authority` v2 records the intent, refuses a different declaration in the same transaction (`AUTHORITY_MISMATCH`), then calls the transition. §4 `fs_bind_publication` v6 likewise (one-line difference, verified by diff). §5 authority privileges revoked from `service_role` (SELECT kept); `fs_report_authority_guard`; deferred `trg_fsra_event_consistency`. §6 `fs_refuse_truncate()` + trigger + REVOKE on fifteen tables. §7 `company_framework_events` (append-only; RLS read by members/owner) and `set_company_reporting_framework` (read-committed check; `auth.uid()` required; validation; **company lock exclusive**; `companies` row `FOR NO KEY UPDATE`; owner check; idempotent replay / `IDEMPOTENCY_CONFLICT`; `unchanged`; `STALE_FRAMEWORK`; `PROCESSING_IN_PROGRESS` while a check's lease is live; `FRAMEWORK_LOCKED` once a decided framework has a certification or saved report; update + event). §8 EXECUTE only to `authenticated` for the three member functions.

**`20261128100000_companies_framework_change_guard.sql` (batch 2, enforcement).** Refuses (55000 `TRACK_A_ORDER`) unless batch 1 is present. `guard_company_reporting_framework()` (SECURITY INVOKER): if the value changes and `current_user` is not the owner role of `set_company_reporting_framework`, refuse `FRAMEWORK_CHANGE_REQUIRES_RPC` (42501). An update that resends the same value passes; INSERT is untouched.

**Frontend.** `src/lib/workspace/companyFramework.ts` is the only browser path (structured outcomes; SQLSTATE mapping; no message parsing); `CompanyManager.tsx` calls it before its direct update, no longer sends `reporting_framework` directly, shows the server's refusal and refuses clearing a recorded framework.

**Release.** `docs/release/track-a-r1/preflight.sql` (read-only; baseline in force, not partly applied, existing pointers consistent with their events, frameworks within the four values), `postcondition-1.sql` (objects, no setting read, intent read in place, triggers enabled, TRUNCATE trigger on all nineteen tables, privileges per role, member paths kept, pointer invariant, batch 2 **absent**), `postcondition-2.sql` (guard present, enabled, BEFORE UPDATE OF `reporting_framework`; function owner is not an API role; definer/invoker as designed; no API role is a member of the owner; batch 1 still in force; pointer invariant). Exercised in both directions on a disposable database (each refuses in the wrong state and passes in the right one, T).

**Transport.** `scripts/release/trackAStagedTransport.mjs` renders `release/staged-transport-tra/` from the committed bytes at `e7886489`: a bootstrap (private schema `cfoclose_tra_release`; staged artifacts insert-checked against literal identities; append-only events; no client access; no generic executor) and one apply per migration. Each apply, in one statement: transport lock → journal is exactly the approved predecessor → prior batch consumed → own artifacts locked, unconsumed and exact → target not yet installed → baseline captured (sign-off bindings, consumed issuances, FINAL authority, its events, every company's framework) → [batch 1: preflight] → wrapper → postcondition → target installed → baseline unchanged → consume + event. `releaseJournal.mjs` registers both sources' submission forms and the transport kind `tra_staged_transport`; no journal entry claims them yet.

**Compiler.** No compiler or function source changed: bundle `49fc0852…`, closures `745c8170…` / `cdc5416f…` unchanged (T). No regeneration was required.

## 4. Exact hosted installation sequence (gate A4; not performed)

Preconditions: A1 green on the exact SHA; A2 recorded; A3 recorded with journal head **id 80, hash `5481a1bbbc516140ee7717b65c0eed3adf75353b77d39aa96a32513a4a2ead35`** and `preflight.sql` NOTICE `TRA_PREFLIGHT OK`; kill switch ON.

| Step | Action | Bytes / SHA-256 (no final LF) | Expected result |
|---|---|---|---|
| A4.1 | Submit `release/staged-transport-tra/00_track_a_staged_transport.sql` through the canonical journalled migrator, byte for byte | 7,750 / `7b51e2c625e371779d7f67cfc8c2d150181ac1812da556d64e3f40f79390533e` | Journal id 81; schema `cfoclose_tra_release` exists |
| A4.2 | Stage, through the exact-byte channel used for fs-integrity-r1, the seven files in `release/staged-transport-tra/stage/` (each one INSERT; refused unless its body equals the literal identity) | source 40,457 `72c11b68…`; wrapper 42,039 `32778550…`; preflight 5,041 `2d8dd0b1…`; postcondition-1 7,584 `33cacc16…`; source 3,043 `e5ff3729…`; wrapper 4,627 `9c500a69…`; postcondition-2 3,532 `168f3c29…` | Seven rows, unconsumed; seven `staged` events |
| A4.3 | Submit `10_tra_1_authority_hardening_staged_apply.sql` | 7,981 / `3f27a234df1a744c5651dc7755126b46d1924cf922d93a6d42198c4d7c1cbd9b` | Journal id 82; NOTICEs `TRA_PREFLIGHT OK`, `TRA_POSTCONDITION 1 OK`; batch 1 consumed |
| A4.4 | Publish the frontend of the release commit (kill switch stays ON); verify reporting shows disabled; save a framework for an undecided test company through the edit form and see one `company_framework_events` row | — | Publish record; check record |
| A4.5 | Only after A4.4 is verified: submit `20_tra_2_framework_guard_staged_apply.sql` | 7,434 / `d4952e29098cc841c236e0a9f9d7fec7ede69ae9b838c5b0ed509532e3702f86` | Journal id 83; NOTICE `TRA_POSTCONDITION 2 OK` |
| after | Commit the three journal mirrors as `drizzle/migrations/0080_…`, `0081_…`, `0082_…` and add them to `RELEASE_JOURNAL` as kind `tra_staged_transport` with the hashes above | — | `assertMigrationAuthority` OK with nothing pending |

Failure handling: every apply is one atomic statement — a refusal or interruption leaves nothing applied (T6 `m2`, T7 P3/P4); fix the cause and resubmit the **same bytes**. A different journal head refuses with `TRA_TRANSPORT_WRONG_PREDECESSOR` (re-register; never edit the bytes). A4.5 is never submitted before A4.4. No step is "recovered" by dropping a guard.

## 5. Remaining gates (none performed here)

A1 CI green on the exact SHA (PR #194; at the time of writing the release gate, lint/build/type check, golden fixtures, edge checks and migration audit had passed on `816c9838`; the database contract tests and the application journey were still running — **not claimed**). A2 deployed-closure verification (download both functions; `verifyDeployedClosure.mjs`). A3 hosted read-only check. A4 above. A5 temporary acceptance window for the acceptance company only, closed afterwards with reporting disabled. A6 owner activation decision. Lovable-side verification: the published bundle corresponds to the release commit; the company edit form uses the audited function; reporting routes are disabled outside the window.

## 6. Required proofs → evidence

All on a disposable loopback PostgreSQL 16.15; hosted grants emulated by the kit (Supabase default privileges); `auth.uid()` simulated as PostgREST does.

| Required proof | Evidence |
|---|---|
| Unauthorized authority writes fail | `trackAHardening` `b1` (service_role, owner, partner × INSERT/UPDATE/DELETE on pointer, events, intents), `b2` (table owner) |
| Legitimate changes succeed with matching events | `b5` (REPLACED; pointer seq 2; intent with actor), `e1`, `e2` (further replacements), `f1` (ESTABLISHED, REPLACED ×3; pointer = latest event everywhere); `publicationAuthority` 18/18, `publicationAuthorityLegacy` (designation) pass |
| UPDATE/DELETE/TRUNCATE protections | `c1` (19 tables × service_role/authenticated/anon and owner trigger, also CASCADE), `c2` |
| Flag spoofing cannot bypass | `b3` (session- and transaction-level setting), `b4`, `b6` |
| Direct framework changes fail | `d1` (owner, service_role; member reaches nothing) |
| Authorized changes audited and invalidate dependencies | `d2` (event fields; certification `dependency_changed`), `d3` (replay; idempotency conflict; unchanged) |
| Cross-tenant attempts fail | `d5` (partner, other workspace's owner, owner on another workspace, service_role, anon; RLS on history) |
| Concurrent framework change and FINAL preserve the invariant | `e1`, `e2` (both interleavings, held transactions), `e3` (two changes), `e4` (other periods unblocked) |
| Existing integrity, authority, legacy, issuance and transport proofs pass | 69 proof runs of the CI steps, all exit 0 (master §0.4 T8), incl. `publicationIntegrityGate` present 40/40 and absent mode VALID, `publicationControls`, `publicationConcurrency`, `signoffBinding`, `reportingClosure`, `tbStagedTransport`, `selfCheckingWrappers` |
| Migration interruption rolls back; retry works | `m2` (failure injected after the last statement: schema, triggers, grants, functions, fixtures unchanged), `m3` (retry applies; repeat refused by preflight); transport proof P3 (failure injected inside the migration through the apply: stage, events and journal rolled back; retry applies), P4 (postcondition failure rolled back) |
| Existing sign-off and issued-pack fixtures unchanged | `m4` (publications, bindings, authority, events, issuances, reviewer decisions, policy events, reports, certifications, companies, stored objects byte-identical; sealed pack verifies intact/official/not superseded), `f1`; transport proof P6 (seeded sign-off binding byte-identical) |
| Full release checks incl. the application journey | Unit suite with CI environment (T9: all pass except 4 `jspdf`-importing tests, absent from this workspace); the application journey runs only in CI — **pending** |

**Limits.** PostgreSQL 16.15 locally (hosted is the platform version). Grants are the kit's emulation of Supabase defaults, not the hosted catalog. The proofs cannot show what the hosted migrator does with a submission beyond the journal-row model used by the transport proof. A DBA or the function owner can disable any trigger (master §4.3).

## 7. Fingerprints

| Artifact | Bytes | SHA-256 |
|---|---|---|
| `supabase/migrations/20261127100000_fs_track_a_authority_hardening.sql` | 40,457 (final-LF-removed 40,456) | `72c11b685b17261d2932d7b1182c4fea649096a2ba1b3ff06270d89ac7da4d4a` (`49c7c2f22709b57101afea09ed405480e0531fdebbb872d4638eb5bf6c10dbcb`) |
| `supabase/migrations/20261128100000_companies_framework_change_guard.sql` | 3,043 (3,042) | `e5ff37296d50e152f86c89652eb238b27ba66b2161bb1bd8aa71e9daf4918d41` (`79b3ea94d8eb0f3438b4ab3d4611aacce3af5d50eba1fa89e34ca29e83eb1377`) |
| Wrapper of 20261127100000 at `e7886489` | 42,039 | `32778550bbc96fb570244bdb9a04d19c522fe4540e1e1f89ea47e2539ce33d68` |
| Wrapper of 20261128100000 at `e7886489` | 4,627 | `9c500a69706228fd029067133e35a3271906631510cd272797c37f216c68107a` |
| `preflight.sql` / `postcondition-1.sql` / `postcondition-2.sql` | 5,041 / 7,584 / 3,532 | `2d8dd0b1…4e7861` / `33cacc16…ca57d` / `168f3c29…abe7` |
| Transport forms (bootstrap / apply 1 / apply 2) | 7,750 / 7,981 / 7,434 | `7b51e2c6…0533e` / `3f27a234…cbd9b` / `d4952e29…02f86` |
| Functions `compile-financial-report` / `seal-reporting-pack` | — | `745c8170…` / `cdc5416f…` (**unchanged**) |
| Compiler bundle | — | `49fc0852…` (**unchanged**) |

## 8. Not done, and why

Not merged; not installed; no function deployed; no frontend published; no rollout, payment or reporting access changed; no hosted report issued; no customer record altered; no hosted read (no hosted connection was available to this work); no Track B work. Not executed here: Deno edge tests, the real-application journey, `buildStatementCompiler --check` (esbuild not installable in this workspace; compiler unchanged). IPSAS 47 paragraphs 194–203A could not be retrieved verbatim (master §0.5, Q-1).
