# Financial Reporting Master Specification

| | |
|---|---|
| **Document ID** | CFR-MASTER-3 (supersedes CFR-MASTER-2 and CFR-MASTER-1, neither committed) |
| **Status** | Architecture plus the record of the Track A hardening **implemented in source on a branch** (release batch `track-a-r1`, draft PR #194). Track B sections remain PROPOSED and authorize nothing. **Nothing described here has been merged, installed on a hosted database, deployed, published or activated.** |
| **Baseline** | `hirorobert/axiom-insight-craft` `origin/main` **`f3d1b4019844fda11395bdc9168e5e3034862efb`** (2026-10-24 11:46:59 UTC, "Applied all 4 reporting batches") |
| **Implementation** | Branch `fix/track-a-release-hardening-20261024` from that baseline; draft PR https://github.com/hirorobert/axiom-insight-craft/pull/194; release record `docs/release/track-a-r1/RECORD.md` |
| **Companions** | `FINANCIAL_REPORTING_COVERAGE_MATRIX.md` · `FINANCIAL_REPORTING_DELIVERY_PLAN.md` · `IPSAS_ACCRUAL_SPEC.md` · `FINANCIAL_REPORTING_REVIEW_RESPONSE.md` |
| **Authority** | This document is the single authoritative location for shared contracts: evidence classes (§0), findings register (§3), trust model (§4), security contracts (§5), identity model (§6), concurrency and idempotency (§7), compiler and audit trust (§8), manifest and replay (§9), accounting architecture (§10), publication and recovery (§11), operating models (§12), open items (§13). Companions reference these sections and do not restate them. |

---

## 0. Evidence baseline

### 0.1 Evidence classes

Every factual statement in the five documents carries one of these classes.

| Code | Class | Meaning |
|---|---|---|
| **S** | Implemented in source | Present at the baseline commit; read, not necessarily executed |
| **T** | Demonstrated by executed tests | Executed during this assignment; command and result in §0.4 |
| **R** | Recorded in release evidence | Stated by a committed repository record (`docs/release/**`, `drizzle/migrations/**`, `scripts/ci/releaseJournal.mjs`); not re-executed |
| **O** | Owner-supplied | Stated by the owner on 2026-10-24; not independently rechecked unless marked |
| **H** | Independently verified on hosted infrastructure | **No fact in these documents carries H.** This assignment had no hosted access. |
| **I** | Implemented on the branch | Present on `fix/track-a-release-hardening-20261024` (PR #194); proven only on disposable infrastructure; **not merged, not installed** |
| **P** | Proposed | Specified here; does not exist |
| **U** | Unverified | Could not be established; the consequence is stated |
| **X** | Unsupported | Not provided; must be refused by name when encountered |

### 0.2 Repository and commits

| Item | Value | Class |
|---|---|---|
| Authoritative repository | `hirorobert/axiom-insight-craft` (remote of the owner's checkout `~/axiom-insight-craft`) | S |
| Inspected commit | `f3d1b40` = `origin/main` at 2026-10-24 (fetched 15:00 EAT), inspected in an isolated read-only clone | S |
| Owner's working tree | `~/axiom-insight-craft` on `feat/workspace-ux-hardening` at `b32aa4f` with uncommitted work. **Not modified.** | S |
| Commits made by this work | Branch `fix/track-a-release-hardening-20261024` (from `f3d1b40`), draft PR #194. Commits listed in `docs/release/track-a-r1/RECORD.md` §1; this document is committed on that branch. Nothing merged | S |
| Previous drafts | CFR-MASTER-1 and CFR-MASTER-2 and their companions were delivered as files on 2026-10-24 and never committed. | S |

### 0.3 Release position

The owner supplied the following release position. Each item is checked against what the repository itself records.

| Item | Class | Repository check |
|---|---|---|
| PRs #190, #192, #193 merged | O, S | Merge commits present on `main` (`70ad854` #190, `27f48f7` #192, `09e6cf5` #193) |
| #191 closed; its changes landed through #192 | O | `refs/pull/191/head` = `0225ee4`; `857fba4` "Merge PR #191 … into the publication-integrity candidate" is an ancestor of `27f48f7` (S) |
| Reporting migrations installed through canonical journalled steps 77–80 with approved hashes | O, R | `drizzle/migrations/0076`–`0079` (`fsi_1`…`fsi_4`) exist; `scripts/ci/releaseJournal.mjs:376-380` pins their SHA-256 values and records hosted ids 77–80; bootstrap `0075` = hosted id 76 (`TRANSPORT_RECOVERY_VERIFICATION.md` §1). Hosted journal not read here (no H). |
| Both historical sign-off bindings preserved, unchanged fingerprint | O | Each staged apply refuses unless existing bindings are byte-identical afterwards (R, `TRANSPORT_RECOVERY_VERIFICATION.md` §1); hosted outcome not checked here |
| Global reporting kill switch ON | O, R | `TRANSPORT_RECOVERY_VERIFICATION.md`: `kill_switch = true` at last read |
| Both reporting functions reported deployed; deployed-source verification pending | O, R | `RECORD.md` "Release preparation": "Deployed-source verification: NOT VERIFIED. No exception has been approved." Tool `scripts/release/verifyDeployedClosure.mjs` exists (S) |
| Matching new frontend publication unverified | O | — |
| Hosted acceptance and official issuance outstanding | O, R | `RECORD.md`: hosted inventory "0 issued packs" |
| Earlier integrated candidate passed automated database and browser CI | O | Not rechecked. Does not cover later commits — see finding **N-04**: at `f3d1b40`, `releaseJournal.test.ts` fails 5 tests (T) and `selfCheckingWrappers.test.ts` 2 (T); both corrected on the branch (I, T) |

Repository text that still says these migrations are "UNAPPLIED hosted" (CLAUDE.md §9.1 entries for `DEFECT-FS-*`) is **stale** relative to `f3d1b40`'s journal mirrors. These documents do not rely on it.

### 0.4 Tests and probes executed during this assignment (T)

All in an isolated clone; database work on a disposable loopback PostgreSQL 16.15 cluster using the repository's own proof kit (`scripts/db-proof/lib/reportingKit.mjs`, external mode). The kit emulates Supabase default privileges (`ALTER DEFAULT PRIVILEGES … GRANT ALL … TO anon, authenticated, service_role`, `reportingKit.mjs:92-94`); hosted grants were **not** read.

| # | Commit | Command | Result |
|---|---|---|---|
| T1 | `27f48f7` | `vitest run src/lib/frameworkPacks src/lib/reporting src/lib/statements src/lib/financialStatementsWorkspace` | 411 passed, 10 skipped (PostgreSQL-dependent) |
| T2 | `27f48f7` | `vitest run` (full) | 6,245 passed, 4 failed (missing `jspdf` in this workspace's install — environment), 10 skipped |
| T3 | `f3d1b40` | T1 suites + `verifyDeployedClosure`, `fsIntegrityStagedTransport`, `migrationAuthority`, `releaseJournal` tests, with CI's environment variables and network guard | 488 passed, **5 failed** (`releaseJournal.test.ts`: expects 58 entries and four pending reporting migrations; repository now has 63 entries and none pending) — **finding N-04** |
| T4 | `f3d1b40` | `scripts/db-proof/publicationIntegrityGate.mjs` | **40/40 PASS**, incl. W1 (tampered documents saved with an empty browser evaluation refused) |
| T5 | `f3d1b40` | Investigation probe (scratch file outside the repository): full migration chain → effective grants, RLS, triggers; D-01, D-05, D-06 reproductions; all mutating probes rolled back | Results in §3 |
| T6 | branch | `scripts/db-proof/trackAHardening.mjs` (new; installs `track-a-r1` on a database that already holds a FINAL, a sign-off and a sealed pack made by the previous definitions) → `validateProofResult.mjs --mode present` | **24/24 PASS**, VALID |
| T7 | branch | `scripts/db-proof/trackAStagedTransport.mjs` (new; production-equivalent base at hosted journal id 80) | **37/37 PASS** |
| T8 | branch | Every `scripts/db-proof/*` step of `.github/workflows/ci.yml` (69 runs incl. `publicationIntegrityGate` present 40/40 and absent mode VALID, `publicationAuthority`, `publicationAuthorityLegacy`, `publicationControls`, `publicationConcurrency`, `run.mjs`, `serviceWithholding`, `s2Authority`, `signoffBinding`, `signoffPolicy`, `tbStagedTransport`, `selfCheckingWrappers`, `tbDecisionsRollout` both modes) | **All exit 0.** `periodCurrencyCorrection` failed 2 timing checks when run 5-way parallel and passed alone; `serviceWithholding`'s migration inventory was updated for the two new migrations |
| T9 | branch | `vitest run` (full) with CI's environment and network guard | All pass except 4 tests that import `jspdf`, absent from this workspace's install (environment; same as T2) |
| T10 | branch | `bunx tsc --noEmit -p tsconfig.app.json`; `bun run lint`; `node scripts/ci/assertMigrationAuthority.mjs`; `node scripts/release/trackAStagedTransport.mjs --check` | tsc: only 5 missing-module errors (`jspdf`, `@lovable.dev/cloud-auth-js`, not installed here); lint 0 errors; migration authority OK, pending = the two `track-a-r1` sources; transport OK |
| T11 | branch | Function closures recomputed from the branch (`verifyDeployedClosure.deployedClosure`) | `compile-financial-report` `745c8170…`, `seal-reporting-pack` `cdc5416f…` (unchanged); compiler bundle `49fc0852…` unchanged |

**Not executed:** Deno edge tests, `scripts/db-contract-tests`, real-app e2e and browser journeys (the CI run of PR #194 executes them; this document does not claim its result), `node scripts/buildStatementCompiler.mjs --check` (esbuild is not installable here; the compiler sources and bundle are unchanged, T11), any hosted check, any accounting fixture.

### 0.5 Standards and jurisdiction sources consulted (verification date 2026-10-24)

| Source | Used for | Verification class |
|---|---|---|
| IFAC, IPSAS 48 *Transfer Expenses* (2025 Handbook extract, `ifacweb…/2024-12/C10-IPSAS-48.pdf`) paras 3–4, 62–64 | Scope; effective date; transition | Primary text |
| IFAC, IPSAS 47 *Revenue* (2025 Handbook extract https://ifacweb.blob.core.windows.net/publicfiles/2025-04/C06_IPSAS_47.pdf, "includes amendments … issued up to January 31, 2025") | Scope para 3; the amendment table: paragraphs **194A and 203A were added by *Concessionary Leases and Other Arrangements Conveying Rights over Assets* (October 2024)** | Primary text. **Paragraphs 194–203A themselves were NOT retrieved:** the available retrieval tool extracts the PDF only to paragraph 180 (attempted 2026-10-24 at several offsets). Not quoted anywhere in these documents |
| IPSASB news, *IPSASB Issues Package of Revenue and Transfer Expense Related Pronouncements* (May 2023) | IPSAS 47 and IPSAS 48 "have an effective date of January 1, 2026"; "Earlier application is permitted" | Primary summary (standard setter) |
| IPSASB news, *IPSASB Issues Final Pronouncement on Concessionary Leases and Other Arrangements Conveying Rights over Assets* (October 2024) | "The amendments to IPSAS 43 and IPSAS 47 have an effective date of January 1, 2027"; "Earlier application is permitted" | Primary summary (standard setter) |
| IPSASB ED 88 (March 2024) proposed paragraphs 194A, 203A | Proposed (not final) early-application condition and right-of-use transition wording | **Exposure draft only — never used as the requirement** |
| IFAC, IPSAS 43 *Leases* (2025 Handbook extract `B16_IPSAS_43.pdf`) paras 61, 93, 96, 103, 106, 109–111 | Maturity analyses; transition | Primary text |
| IFAC, IPSAS 24 (IFAC publication `ipsas-24-presentation-of.pdf`) paras 2–5, 14–16, 21–23, 29–30, 39–53 | Budget comparison | Primary text of an **earlier Handbook edition** (still uses GBE wording); current-edition text to be pinned |
| IPSASB, *The Applicability of IPSASs* (April 2016) | GBE exclusion removed from scope sections; "commercial public sector entities"; jurisdictional determination | Primary summary |
| IPSASB, 2026 Handbook contents page | IPSAS 1–51, SRS 1 | Primary summary |
| IFRS Foundation, IFRS 18 page and HTML standard (contents only) | Effective 1 Jan 2027; early application; replaces IAS 1; Appendix C exists | Primary summary; **Appendix C text not retrieved** |
| EY, *Applying IFRS: A closer look at IFRS 18* (July 2025) | Retrospective application; comparative reconciliation of profit or loss; first-year interim requirements; IAS 7 consequential amendments | Secondary |
| IFRS Foundation, *Overview of the third edition of the IFRS for SMEs* | Effective 1 Jan 2027; early application; retrospective with relief in S9, S12, S19, S23 (examples) | Primary summary |
| World Bank CFRR, *IFRS for SMEs Update (3rd edition)* (2026) | Appendix A transition reliefs by section | Secondary |
| NBAA Technical Pronouncement No. 3 of 2020 | NGOs and Associations must apply IPSAS for periods beginning on or after 1 July 2021 | Primary (jurisdiction) |
| NBAA Technical Updates Q1 2025 | IPSAS 43–50 effective dates; IPSAS 48 early application requires IPSAS 47 | Secondary (jurisdiction body summarizing IPSASB) |
| IFRS Foundation jurisdiction profile, Tanzania (last updated 16 June 2016) | Historical: full IFRS for listed companies; IFRS for SMEs permitted below TZS 800 million total assets | **Historical; not a current rule** |

---

## 1. Purpose, tracks and non-claims

CFOClose turns certified accounting data into general-purpose financial statements that a qualified preparer reviews, approves and issues. This document specifies the architecture for IFRS for SMEs, IPSAS accrual and full IFRS, and the evidence that permits each release decision.

**Two tracks are kept separate.**

- **Track A — the existing restricted reporting-integrity release.** IFRS for SMEs 2015, trial-balance-derived, current rollout scope. It finishes with gates A1–A6 (delivery plan §1): exact-candidate checks (A1), deployed-function verification (A2), a read-only hosted state check (A3), installation of the hardening batch `track-a-r1` around the frontend publication with reporting disabled (A4), a temporary acceptance window for the acceptance company only, after which reporting returns to disabled (A5), and an approved activation decision (A6). **Acceptance is not activation.** Track A does **not** depend on Track B architecture. It does depend on the findings that affect its scope (§3). The confirmed permission defects D-01, D-05, D-06 and the replacement-setting weakness D-09 are **fixed in source** by release batch `track-a-r1` (I; delivery plan §1, gate A4); risk acceptance is not the default disposition.
- **Track B — expanded accounting support.** Treatment decisions, allocation, applicability, transitions, framework content, independent accounting validation. All Track B engineering is **provisional**. This documentation authorizes none of it.

**Non-claims.** Nothing here is failure-proof, permanently complete or beyond redesign. The architecture provides explicit invariants, controlled extension points (§10.2, §8) and testable boundaries (§7.7, §11.6). At the baseline, **no framework has an authorized support scope**: the generated SME coverage matrix records zero `VALIDATED` requirements (`docs/reporting/COVERAGE_IFRS_FOR_SMES.md`, S).

---

## 2. Current state at `f3d1b40` (summary)

Detail with file references was established at `27f48f7`; the commits to `f3d1b40` changed release transport, release records, journal mirrors, `src/integrations/supabase/types.ts` and the deployed-closure verifier, but no reporting SQL or reporting TypeScript logic (`git diff --stat 27f48f7 f3d1b40`, S).

| Area | State | Class |
|---|---|---|
| Framework selection | `companies.reporting_framework` (four values or NULL); `fiscal_periods.reporting_framework` unused by reporting. At `f3d1b40` a change after processing is locked only in the browser (`companyFieldLock.ts`); see D-01. On the branch: changed only through `set_company_reporting_framework` (I) | S, T, I |
| Editions | TS packs `ifrs-for-smes/2015` and `/2025`; edition policy by period start with explicit early-application election (`editionPolicy.ts:150-159`; SQL `_fs_smes_edition_decide`, `20261018100000…sql:138-148`); only `/2015` can reach REVIEWED/FINAL | S, T (policy tests) |
| TB certification | Append-only, attempt-fenced, dependency-revision staleness (`20260902130000`, `20261008100000`) | S |
| Adjustments | `close_review_adjustments`, balanced minor units, two-person or owner self-approval, bound to certification | S |
| Evidence | `financial_evidence_batches`; client-declared `validation_status`; server compiler revalidates | S |
| Presentation | `fs_presentation_assignments`: one account → one line, company-scoped | S |
| Composition | SQL figure authority; server compiler (`compile-financial-report`) rebuilds the canonical document and records a service-only receipt | S, T (T4) |
| Publication | `fs_set_publication_state` v4; `trg_fsp_bind` → `fs_bind_publication` v5 (**the assessment's `trg_fsp_binding_guard` does not exist**); blockers v7 with server-compilation splice; FINAL authority per (company, period_year) | S, T (T4) |
| Issuance | issue → prepare → store (`upsert:false`) → seal (regenerate and hash) → verify/retrieve by re-hash | S, T (T4 W4) |
| Hosted | Migrations `20261123`–`20261126` applied as hosted ids 77–80 | O, R |
| Track A hardening | `20261127100000`, `20261128100000` and their staged transport (expected hosted ids 81–83) authored on the branch; **not applied** | I, T (T6, T7) |

---

## 3. Findings register (authoritative)

Each finding: **(1)** source at `f3d1b40`; **(2)** actor and effective privileges; **(3)** entry point and preconditions; **(4)** existing compensating controls; **(5)** invariant allegedly violated; **(6)** executed reproduction; **(7)** classification; **(8)** proposed correction and proof obligation.

Classifications: **CONFIRMED DEFECT** (a stated invariant is violated by an executable path) · **DESIGN WEAKNESS** (no invariant is violated today, but a control depends on something weaker than it should) · **AUDITABILITY IMPROVEMENT** · **UNVERIFIED HYPOTHESIS** · **WITHDRAWN** (the earlier claim was wrong).

### D-01 — Reporting framework changeable by the company owner at any time

1. RLS policy "Users can update their own companies" `FOR UPDATE … USING (auth.uid() = user_id)` (`20260719100834_…sql:137`); browser edit `src/components/CompanyManager.tsx:331-347`; client lock `src/lib/accounting/companyFieldLock.ts:42-47`; dependency bump trigger `trg_companies_dependency_bump` AFTER UPDATE OF reporting_framework (`20261008100000…sql:362-375`).
2. `authenticated` holds table-level `SELECT, INSERT, UPDATE, DELETE, TRUNCATE` on `companies` (T5, emulated defaults); `has_column_privilege('authenticated','public.companies','reporting_framework','UPDATE')` = true. RLS restricts UPDATE to the owner (`user_id`); accepted members get no row (T5).
3. PostgREST `PATCH /companies` or the CompanyManager edit form, as the owner.
4. The change bumps the `#framework` dependency, so the current certification stops being authoritative (T5: `certificationAuthoritativeAfter = false`); composition then returns `state: unavailable` (T5); `fs_bind_publication` refuses any report whose document framework is not `IFRS_FOR_SMES` or whose dependencies are stale. **No mis-stated report can be finalised through this path.**
5. "The framework decision for a period is a governed, auditable, historically stable decision." Violated: the change is unaudited beyond the dependency bump, needs no capability beyond ownership, has no history, and can silently invalidate certified work.
6. **Reproduced (T5):** certified FY2026 TB → owner `UPDATE … SET reporting_framework='ipsas_accrual'` → allowed; certification no longer authoritative.
7. **CONFIRMED DEFECT** (governance and auditability; not a publication bypass).
8. **Correction — IMPLEMENTED (I), not installed.** Column-level `REVOKE UPDATE (reporting_framework)` is **ineffective** while the table-level UPDATE grant exists (T5). CFR-MASTER-2 described the `filing_jurisdiction` guard as a setting-based "only the RPC may write" check; that description was **wrong**: `guard_company_filing_jurisdiction` (`20260920100000…sql:44-73`) refuses a change by business state for every writer and does not restrict the writer, so it cannot express "only the audited function may write". A setting-based check was also rejected, because a setting is not authorization (§4.2). Implemented instead: `set_company_reporting_framework(company, framework, expected_framework, reason, request_id)` (`20261127100000` §7; SECURITY DEFINER; existing owner authorization `companies.user_id = auth.uid()` — the policy recorded in §5.4; append-only `company_framework_events`; idempotent per request; refuses `STALE_FRAMEWORK`, `PROCESSING_IN_PROGRESS`, and `FRAMEWORK_LOCKED` once a decided framework has any certification or saved report), and the guard `trg_guard_company_reporting_framework` (`20261128100000`) that refuses any change unless `current_user` is the **owner role of that function** — an identity no API role can assume. Sequence in §5.4. **Proof (T6):** `d1`–`d5`, `e1`–`e3`: owner and `service_role` direct UPDATE refused (`FRAMEWORK_CHANGE_REQUIRES_RPC`, 42501), other company edits succeed; the RPC records the event and the certification it affects loses authority (`dependency_changed`); replay and idempotency conflict; stale, locked, processing, invalid, member, outsider, service and anonymous attempts refused; tenant reads isolated; concurrent changes serialise.

### D-02 — Client-supplied evaluation findings and evidence statuses (re-assessed)

1. `fs_unresolved_blocking_count` / `fs_unmet_reconciliation_count` read the evaluation saved with the version (`20260919110000`); blockers v7 call them (`20261126100000…sql:639-641`) and add `EVIDENCE_NOT_VALID` from the client-declared `validation_status` (`:448`). `fs_server_compilation_blocker` (`20261123100000…sql:195-224`), spliced as the last blocker.
2. `authenticated` members with `prepare_close` save versions and evaluations through `fs_commit_revision`.
3. Saving a version with an evaluation reporting no findings, or evidence declared VALID.
4. The server-compilation blocker independently requires: a receipt for this exact version with `matches = true` and `canonical_document = report_document`; current dependencies and legal name; latest version; an unchanged source snapshot; and **no actionable finding** with outcome `INSUFFICIENT_EVIDENCE`, severity `CRITICAL`/`HIGH`, or one of nine core reconciliation rules. The compiler revalidates evidence (`serverCompilation.ts:19-34`) and refuses invalid evidence. Client findings and statuses can only **add** blockers.
5. The earlier claim was "client-supplied values authorize publication".
6. **T4:** W1 cases save tampered documents with an evaluation reporting nothing; all are refused. No executable path defeating the server controls was found.
7. **Downgraded to DESIGN WEAKNESS (mixed authority).** Residual concern: a server-compiler finding below HIGH that is not one of the nine listed rules blocks only if the client's own evaluation reports it as blocking. Whether any such finding is *meant* to block is a policy question (U).
8. **Rule-to-blocking inventory (S, branch investigation; no code changed).** Server receipt (`fs_server_compilation_blocker`): blocks on any actionable finding with outcome `INSUFFICIENT_EVIDENCE` or severity `CRITICAL`/`HIGH`, or of one of the nine core rules, **ignoring reviewer decisions**. Client counts (`fs_unresolved_blocking_count` + `fs_unmet_reconciliation_count`): the same union, **minus findings whose latest reviewer decision is `ACCEPT_FINDING`/`REJECT_FINDING`** (decisions apply to the first count only).

| Rule | Severities emitted | Core rule (blocks at any severity) | Non-core MEDIUM/LOW |
|---|---|---|---|
| sfp-equation | CRITICAL, HIGH, MEDIUM | yes | — |
| subtotal-casting | HIGH, MEDIUM | yes | — |
| note-to-face-reconciliation | HIGH, MEDIUM | yes | — |
| movement-reconciliation | HIGH, MEDIUM | yes | — |
| schedule-casting | HIGH, MEDIUM | yes | — |
| equity-closing-tie | CRITICAL, HIGH | yes | — |
| equity-profit-tie | HIGH | yes | — |
| cashflow-closing-cash-reconciliation | CRITICAL, HIGH | yes | — |
| cashflow-account-rollforward | CRITICAL | yes | — |
| comparative-period-alignment | HIGH | no | none emitted |
| currency-scale-consistency | CRITICAL | no | none emitted |
| duplicate-detection | HIGH, MEDIUM | no | MEDIUM blocks in neither path |
| missing-comparative-detection | MEDIUM | no | blocks in neither path |
| orphaned-note-reference-detection | HIGH, LOW | no | LOW blocks in neither path |

Several rules also emit `INSUFFICIENT_EVIDENCE`, which blocks in both paths. **Conclusion:** the earlier residual ("a finding below HIGH outside the nine rules blocks only if the client reports it") is **withdrawn** — such findings block in neither path, consistently. The **only discrepancy** is reviewer acceptance: a reviewer-accepted non-core CRITICAL/HIGH or `INSUFFICIENT_EVIDENCE` finding still blocks on the server while the client shows it cleared. This fails closed (no publication is permitted that the server would refuse). The established contract does not say whether reviewer acceptance may clear a server-detected high-severity finding, so **no code was changed**; it is recorded as owner/accounting policy decision **OD-8** (§13). Until decided, the product can show "ready" in the browser while FINAL is refused by the server receipt; the refusal names the finding.

### D-03 — No preparer ≠ approver rule (re-assessed)

1. `fs_bind_publication` v5 (`20261125100000…sql:410-433`).
2. REVIEWED needs `review_close`; FINAL needs `approve_certification`.
3. Normal sign-off.
4. FINAL approver must differ from the REVIEWED approver unless the recorded `solo_owner` policy applies and the approver is the owner. Two distinct people therefore always sign in non-solo workspaces; the preparer may be one of them.
5. A three-person rule was assumed, but no such invariant is stated anywhere in the repository.
6. Not applicable.
7. **WITHDRAWN as a defect.** The existing rule is a coherent two-person policy. Whether the preparer may be the reviewer is an **owner policy decision** (§12, OD-3).
8. Policy options are in §12.

### D-04 — Solo-owner exception reads `firm_members.role = 'owner'`

1. `20261125100000…sql:426`.
2. Owner title is integrity-guarded: no UPDATE assigns the owner title or moves a membership (CLAUDE.md §9.3, B-1…B-7; `firm_members_update_guard`).
3. FINAL by the reviewer under `solo_owner` policy.
4. The title cannot be self-assigned; CLAUDE.md permits owner-title integrity guards ("Only the owner-title integrity guards read the title").
5. "Capabilities, never titles" (CLAUDE.md §9.3).
6. Not reproduced.
7. **DESIGN WEAKNESS** (consistency), not a privilege defect. Note CLAUDE.md §4.6 (partner/manager titles) also contradicts §9.3; §9.3 describes the implemented model.
8. Replace the title test with `companies.user_id = auth.uid()` or a dedicated capability, as part of the operating-model work (§12). **Proof:** same outcomes across the solo-policy matrix.

### D-05 — `service_role` can UPDATE and DELETE the FINAL-authority pointer

1. `fs_report_authority` (`20261125100000…sql:52-62`); TRUNCATE trigger only (`:84`); `REVOKE ALL … FROM PUBLIC, anon, authenticated` (`:89`) — `service_role` not named.
2. **T5 (emulated defaults):** `service_role` holds `SELECT, INSERT, UPDATE, DELETE, TRUNCATE`; `rolbypassrls = true`. On hosted: **U**.
3. Any holder of the service-role credential (edge functions, operators) issuing SQL through PostgREST or a direct connection.
4. TRUNCATE is refused by trigger (T5). Authority events are append-only by trigger (`trg_fsrae_append_only`, `trg_fsrae_no_truncate`), so a pointer change leaves no matching event. Readers use the pointer (`_fs_authority_relation`).
5. "The scope's FINAL authority changes only through `_fs_claim_final_authority` with an event."
6. **Reproduced (T5):** `UPDATE public.fs_report_authority …` and `DELETE …` as `service_role` executed without privilege or trigger refusal (rolled back).
7. **CONFIRMED DEFECT (defence in depth)** under the emulated grants. Exposure is limited to service-credential holders, who are trusted for other writes, so this is not an authenticated-user bypass. Hosted grant state: **U**.
8. **Correction — IMPLEMENTED (I), not installed** (`20261127100000` §5). `service_role` loses INSERT/UPDATE/DELETE/TRUNCATE on `fs_report_authority` and `fs_report_authority_events` (SELECT kept); writers remain the SECURITY DEFINER functions, which run as their owner. Independent of privileges and of any session setting: `fs_report_authority_guard` refuses DELETE, a change of scope identity and any sequence step other than +1; the **deferred** constraint trigger `fs_report_authority_event_consistency` requires, at commit, that the pointer names the publication of the scope's latest non-conflict authority event (`AUTHORITY_POINTER_WITHOUT_EVENT`). The earlier proposal (a transaction-local flag) was **rejected**: a flag is not authorization (§4). **Proof (T6):** `b1` every write by `service_role`, owner and partner refused (42501); `b2` even the table owner cannot delete, re-scope, skip, or move the pointer without an event; `b5` a legitimate replacement moves pointer and event together; `f1` pointer = latest event for every scope after all scenarios; `m4` existing authority unchanged by installation. Hosted grant posture still read at gate A3 (Q-8), but the installed batch removes the exposure whatever it is.

### D-06 — Append-only tables lacking TRUNCATE protection (narrowed)

1. Append-only triggers cover UPDATE/DELETE only on `financial_statement_reports`, `financial_statement_publications`, `financial_evidence_batches`, `financial_statement_evaluations`, `tb_certifications` (T5 trigger list).
2. **T5:** `authenticated` has SELECT only on these. `service_role` holds TRUNCATE on all five.
3. Service-credential holder.
4. Foreign-key cascades incidentally block some truncates: publications (cascade reaches `reporting_pack_issuances`, where service_role lacks privilege) and reports (cascade reaches `fs_server_compilations`) are refused (T5). Newer tables (`fs_publication_bindings`, authority events, adjustments, assignments, compilations) have TRUNCATE triggers or no service-role grant.
5. "Append-only evidence and certifications cannot be erased."
6. **Reproduced (T5, rolled back):** `TRUNCATE … CASCADE` as `service_role` executed on `tb_certifications` (cascading to `tb_certification_invalidations`), `financial_statement_evaluations`, `financial_evidence_batches`.
7. **CONFIRMED DEFECT (defence in depth)** for those three tables under the emulated grants; hosted **U**. Earlier wording ("base fs tables") was imprecise. **Broadened on the branch:** a catalog audit of every reporting and certification history table found **fifteen** without a TRUNCATE refusal (`financial_evidence_batches`, `financial_statement_audit_events`, `financial_statement_correction_groups`, `financial_statement_documents`, `financial_statement_evaluations`, `financial_statement_framework_requirements`, `financial_statement_publications`, `financial_statement_reports`, `financial_statement_reviewer_decisions`, `financial_statements_rollout_audit`, `fs_signoff_policy_events`, `tb_certification_findings`, `tb_certification_invalidations`, `tb_certifications`, `tb_reprocess_requests`). RLS never applies to TRUNCATE.
8. **Correction — IMPLEMENTED (I), not installed** (`20261127100000` §6): a BEFORE TRUNCATE statement trigger (`fs_refuse_truncate`, `APPEND_ONLY`, 42501) on each of the fifteen and `REVOKE TRUNCATE … FROM PUBLIC, anon, authenticated, service_role`. Existing UPDATE/DELETE rules unchanged. **Proof (T6 `c1`, `c2`):** TRUNCATE of all fifteen plus the four authority/framework history tables refused for `service_role`, `authenticated` and `anon` (privilege) and for the table owner (trigger, also with CASCADE); row counts unchanged; UPDATE/DELETE of authority, intent and framework history refused.

### D-07 — Designation of FINAL authority (re-assessed)

1. `fs_designate_final_authority` (`20261125100000…sql:346-379`).
2. `approve_certification`.
3. Only when the scope is `unresolved` (legacy multi-lineage FINALs from the backfill).
4. It selects among **existing FINAL publications**, each of which passed the blockers and separation rules in force when it became FINAL. It inserts no publication and changes no document.
5. The earlier claim was "designation bypasses blockers".
6. Not applicable.
7. **Downgraded to AUDITABILITY IMPROVEMENT.** It is logged as `PUBLICATION_STATE_SET` with `authorityDesignated: true`; a distinct audit action and a second approver are improvements, not corrections of a bypass. Whether any hosted scope is `unresolved`: **U** (hosted inventory records 2 publications).
8. Distinct audit action `AUTHORITY_DESIGNATED`; optional two-person rule per §12.

### D-08 — Binding does not reference the compilation receipt id

1. `fs_publication_bindings` columns (`20261125100000…sql:431-440`).
2–5. Approval is tied to the receipt only through `document_hash` and the dependencies hash.
6. Not applicable.
7. **AUDITABILITY IMPROVEMENT.**
8. Store `compilation_receipt_id` on the binding.

### D-09 — Cross-lineage replacement signalled by a caller-settable setting

1. `fs_replace_final_authority` (`20261125100000…sql:322-340`) sets `cfoclose.fs_replace_authority` with `set_config(…, true)`; `fs_set_publication_state` v4 and `fs_bind_publication` v5 read it with `current_setting` (`:290`, `:447`).
2. Any session can set a custom setting; `authenticated` members with `approve_certification` can call `fs_set_publication_state` directly.
3. A member sets the setting, then calls `fs_set_publication_state(…, 'FINAL', …)` for a competing lineage.
4. The same capability, blocker and separation checks run as for `fs_replace_final_authority`, and the replacement is audited with `replacesFinal`; the caller gains nothing the named entry point would not give the same caller.
5. "Authorization never derives from a value the caller controls" (§4, §5.1 rule 8).
6. Analysis (S); the hardened replacement is proven in T6 `b3`, `b4`, `b6`.
7. **DESIGN WEAKNESS** — no privilege gain demonstrated; the weakness is that the replacement *intent* was forgeable state.
8. **Correction — IMPLEMENTED (I), not installed** (`20261127100000` §2–§4): `fs_replace_final_authority` v2 records the intent as a row in `fs_authority_replacement_intents`, keyed by the top-level transaction id (`pg_current_xact_id()`), writable and readable only by the function owner (all privileges revoked from every API role; append-only; no TRUNCATE). `fs_set_publication_state` v5 and `fs_bind_publication` v6 are the 20261125 bodies with the setting read replaced by `_fs_replacement_intent(…)` (diff verified to one line each). **Proof (T6):** `b3` setting the former setting at session and transaction level and asking a plain FINAL of the competing lineage → `AUTHORITY_CONFLICT`, nothing recorded; `b4` no API role can execute the intent helper or the scope lock, read the intents, or (for `service_role`, `anon`) execute the replacement; `b6` a committed intent authorises nothing later and two different declarations in one transaction are refused `AUTHORITY_MISMATCH` and roll back.

### O-01 — Compiler digest is self-declared

1. `compile-financial-report/handler.ts:59` sends the digest; `fs_server_compilations.compiler_sha256` CHECK pins `49fc0852…` (`20261123100000…sql:31`).
2–4. The database cannot attest which code ran. Compensating controls: SQL recomputes every figure and the presentation skeleton (blockers v6/v7); `verifyDeployedClosure.mjs` can establish artifact correspondence by download (S).
7. **DESIGN WEAKNESS, accepted with stated limits** (§8).

### O-02 — Client renderers use 2015 constants regardless of edition

`StatementsView.tsx:143`, `SchedulesView.tsx`, `RollforwardPanel.tsx`; `sealedPack.ts:24` falls back on period start only for documents without a recorded version. **DESIGN WEAKNESS**; harmless while 2015 and 2025 lines are identical; must be fixed before any 2025-edition authorization.

### N-01 — Misleading refusal copy

`StatementsView.tsx:26` shows "The IFRS for SMEs edition cannot be decided for this period" for any non-SME framework. **CONFIRMED DEFECT (product truthfulness).**

### N-04 — `main` at `f3d1b40` fails its own release-journal tests

1. `src/lib/__tests__/releaseJournal.test.ts` expects 58 entries and the four reporting migrations pending; `f3d1b40` adds journal mirrors `0075`–`0079` and their registry entries.
6. **T3:** 5 failures with assertion errors (not environment).
7. **CONFIRMED DEFECT (release gate).** CI's release gate runs the full suite with no baseline-failure allowance (CLAUDE.md §14), so the exact candidate on `main` is not green. A second symptom on the branch's full run: `selfCheckingWrappers.test.ts` (2 tests) hid only the older transport kinds and failed once `0075`–`0079` existed.
8. **Corrected (I, T).** Commit `0a735c9a`: the journal test pins the five applied entries by **literal** bytes and SHA-256 (from `TRANSPORT_RECOVERY_VERIFICATION.md` §1, not from the implementation under test) and proves refusal of an altered byte, a wrong batch under a tag, a raw source, an altered covered source, and missing, reordered and duplicated entries; the wrapper close-out test hides the `fsi_`/`tra_` transport entries too. **Track A gate A1.**

### N-05 — CLAUDE.md contradictions

§11 deploy procedure (`supabase db push`) contradicts §9.4 (journalled migrator only); §4.6 (title-based sign-off) contradicts §9.3 (capabilities); §9.1 still calls `20261123`–`20261126` unapplied. **AUDITABILITY IMPROVEMENT**; not corrected by this work (the branch adds only the file-map line for `companyFramework.ts` to CLAUDE.md).

---

## 4. Actor and trust model

### 4.1 Actor classes

| Actor | How it reaches the database | Effective identity | Can | Cannot (by these controls) | Controls that resist this actor |
|---|---|---|---|---|---|
| **Authenticated end user** | PostgREST / RPC with a user JWT (browser) | role `authenticated`; `auth.uid()` from the verified JWT | Call EXECUTE-granted RPCs; read via RLS; the company owner may UPDATE own `companies` row (except the framework, after `20261128100000`) | Write reporting or authority tables directly; bypass capability checks inside SECURITY DEFINER functions; read other tenants; TRUNCATE anything | RLS; grants; SECURITY DEFINER checks; triggers |
| **Service API credential** | PostgREST or an Edge Function using the service-role key | role `service_role`; **no** `auth.uid()`; bypasses RLS | Everything its grants allow (edge functions use it to record compilation receipts and seal packs) | After `track-a-r1`: write the FINAL authority, its history or the replacement intents; TRUNCATE any history table; change a framework; execute the member-only decision functions | Grants and triggers only (triggers fire for `service_role`). **Grant gaps are exposures to this actor (D-05, D-06 at the baseline)** |
| **Direct SQL connection** | Supabase SQL editor, the hosted migration tool, CLI, a database connection string | In Supabase normally role `postgres`, the role that owns the migrations' functions and tables | Whatever that role can do — it is the function owner (next row) | — | Only the journalled release process, preflight/postcondition, and who holds the connection |
| **Function owner** | The identity a SECURITY DEFINER function runs as (`current_user` inside it); the migration-applying role | Owner of tables and definer functions | Alter or drop owned objects; disable its triggers; write past every trigger it can disable | — | Nothing inside the database. Controlled by migration review and the journalled release process |
| **Database administrator / platform** | `supabase_admin`, superuser, the platform operator | Superuser | Anything, including rewriting rows and hashes and `session_replication_role = replica` | — | Only external controls: backups, external anchoring (§8.4), platform access control, separation of operator duties |
| **Deployment operator** | Release runner; function deployment; frontend publication | Holds the means to act as the rows above | Apply migrations through the journalled runner; deploy edge functions; publish frontend | Apply unregistered bytes (the journal guard and the staged transport refuse) | Release journal pinning; staged exact-byte transport; preflight/postcondition; independent verification of deployed closures (§8.2) |

### 4.2 Flags are not authorization

A custom setting (`set_config('cfoclose.x', …)`), a request header, a function argument or any other value the caller can write **never** authorizes anything. `set_config` is available to every session, including `authenticated` callers of PostgREST RPCs. Authorization derives only from: `auth.uid()` (from the verified JWT) plus capabilities; privileges (GRANT/REVOKE) on the effective role; and, where "only this function may write" is required, the **role identity** `current_user` compared with the owner of the reviewed SECURITY DEFINER function (an API role cannot become that role). The baseline violated this once in the reporting domain (D-09, the replacement setting), now replaced by an owner-only intent row; CFR-MASTER-2's own proposals for D-01 and D-05 (transaction-local flags) would have repeated it and were not implemented.

### 4.3 Statement of limits

Database triggers, RLS and append-only rules protect against end users and constrain the service credential. They do **not** protect against the function owner, a direct SQL connection as that owner, or an administrator, who can disable them (the proofs show the triggers bind the table owner only for actions that do not disable them first). Claims of immutability in these documents mean "immutable to every actor below function owner". Removing or disabling a guard is never a recovery procedure (§5.4, delivery plan §1).

---

## 5. Security contracts

### 5.1 SECURITY DEFINER functions

Every new or redefined function in the reporting domain must satisfy:

1. **Owner:** the migration-applying role (as today). No function is owned by a login role used by applications.
2. **Search path:** `SET search_path = pg_catalog, public` (existing convention). `pg_temp` is not on the path.
3. **Qualification:** every table, function and type referenced is schema-qualified (`public.x`); operators on user types are avoided or qualified.
4. **EXECUTE:** `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role`, then grant explicitly to the intended role only. Internal helpers (`_…`) are granted to nobody.
5. **Actor derivation:** from `auth.uid()` only; never from an argument. Membership via `fs_actor_member_id` or the capability resolver.
6. **Tenant checks:** every id argument is resolved with `company_id = p_company_id` in the same predicate; mismatches return the same refusal as absence (no existence oracle).
7. **Isolation:** functions that make authority decisions call `tb_require_read_committed()` (existing pattern) before any lock or write.
8. **No authorization from session state:** no function or trigger reads a session setting, header or argument as authorization (§4.2). A "called through the reviewed function" check compares `current_user` with that function's owner, or reads a row only that owner can write, keyed to the current transaction (`fs_authority_replacement_intents`).

### 5.2 Grants on reporting tables

New tables: `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`; `GRANT SELECT … TO authenticated` where RLS-filtered reading is required; no client or service-role write grants; writes through functions only. The baseline gaps D-05 and D-06 are corrected by the forward migration `20261127100000` (I, not installed).

### 5.3 Append-only enforcement

Append-only = BEFORE UPDATE OR DELETE row trigger **and** BEFORE TRUNCATE statement trigger **and** no TRUNCATE grant to client or service roles. A table is described as append-only in these documents only if a DB proof attempts all three operations for every role and observes refusal. `trackAHardening.mjs` `c1`/`c2` is that proof for the nineteen tables of D-06 and D-05 (T6).

### 5.4 Framework-column control (D-01): policy and installation sequence — IMPLEMENTED (I), not installed

**Policy.** The reporting framework of a company is changed only by the company's owner (`companies.user_id = auth.uid()`, the existing ownership authorization; no new capability was invented — OD-4 can later widen it to a capability by a reviewed migration). A change records `company_framework_events` (from, to, actor, request id, reason 8–500 characters; append-only; readable by members and the owner of that company only). Setting the first framework of an undecided company is always permitted to the owner; **changing a decided framework is refused once any certification or saved report exists** (`FRAMEWORK_LOCKED`; a corrected engagement is the route). A change is refused while a trial-balance check holds a live lease (`PROCESSING_IN_PROGRESS`) and when the caller's expected current value is stale (`STALE_FRAMEWORK`). Every change bumps the `#framework` dependency, so a certification that consulted it stops being authoritative (existing `trg_companies_dependency_bump`). Clearing a decided framework is not offered.

**Installation sequence (delivery plan gate A4).** Additive server → frontend → enforcement:

1. **Batch 1 = `20261127100000`** (staged apply `tra_1`): the function, the event table, the authority, intent and TRUNCATE hardening. Preflight before it and postcondition 1 after it run in the same transaction. Old frontends keep working: their direct update of the framework is still accepted until batch 2.
2. **Frontend publication:** `CompanyManager` calls `changeReportingFramework` (`src/lib/workspace/companyFramework.ts`, the only browser path) and no longer sends `reporting_framework` in its direct update.
3. **Batch 2 = `20261128100000`** (staged apply `tra_2`): `trg_guard_company_reporting_framework` refuses any change of the value unless `current_user` is the owner of `set_company_reporting_framework` (`FRAMEWORK_CHANGE_REQUIRES_RPC`, 42501). Name, code, TIN, fiscal year end, currency and other columns stay directly editable under the existing RLS; company creation (`create_entity`) is untouched. Postcondition 2 runs in the same transaction.

**Failure and recovery are forward only.** An interrupted or refused apply rolls back completely (T6 `m2`, T7 P3/P4) and is retried after the cause is fixed. If batch 2 is installed and a client still sends a framework change directly, that client is refused with a structured code — the remedy is to publish the correct frontend, **not** to drop the guard. Dropping or disabling the guard is not a recovery procedure; any change to it is a new reviewed forward migration through the same transport.

**Proof (T6):** `m1`–`m4`, `d1`–`d5`, `e1`–`e3` (§3 D-01).

---

## 6. Identity and immutability model

### 6.1 Pattern (applies to every governed object below)

1. **Immutable record** — content row, never updated or deleted (§5.3 enforcement). Identity: surrogate id plus `content_digest` (§9.2).
2. **Append-only lifecycle events** — `(object_id, seq, event_type, payload, actor, recorded_at)`, `UNIQUE(object_id, seq)`. Events carry business effect; records never change.
3. **Current-state projection** — a derived table maintained only by the event-writing function, in the same transaction, under the object's serialization lock (§7). It is **rebuildable** by replaying events; a `fs_projection_check(object_kind)` function compares projection with replay and is a blocker when they differ.
4. **Two time axes** — *effective period* (business validity, e.g. the reporting periods a decision governs) and *recorded time* (`recorded_at`, transaction time). Historical questions are answered "as recorded at time t" from events, never from the projection.
5. **References** — manifests and reports reference **record ids and content digests**, never the projection. No manifest references mutable content behind a stable identifier.

### 6.2 Why the earlier model was contradictory

CFR-MASTER-1 proposed an append-only decision table with a mutable `state = 'ACTIVE'` column and an exclusion constraint over active rows. Superseding a decision would have required updating `state` on an "immutable" row. The corrected design moves `state` into events and the exclusion constraint onto the projection.

### 6.3 Framework decisions (Track B; D-01 RPC is the Track A precursor)

| Element | Specification |
|---|---|
| Record `fr_framework_decisions` | `decision_id`, `company_id`, `effective_from` (period start), `effective_to` (NULL = open), `framework_id`, `jurisdiction_profile_revision_id`, `eligibility_facts`, `elections`, `content_digest`, `recorded_by`, `recorded_at`. Immutable. |
| Events `fr_framework_decision_events` | `PROPOSED`, `APPROVED`, `SUPERSEDED(by_decision_id)`, `REVOKED(reason)` |
| Projection `fr_framework_decision_current` | `(company_id, effective daterange, decision_id)` with `EXCLUDE USING gist (company_id WITH =, effective WITH &&)` |
| Supersession | One function, in one transaction, under the company framework lock (§7.2 L2): insert the new record; append `APPROVED` for it and `SUPERSEDED` for each overlapped decision; delete and insert the affected projection rows (the projection is not append-only; it is derived). The exclusion constraint on the projection rejects any overlap the function failed to resolve, rolling the whole transaction back. |
| Tenant qualification | Composite FK `(company_id, decision_id)` from events and projection to records; `superseded_by` must have the same `company_id`. |
| Historical preservation | Reports and manifests reference `decision_id` + digest; superseding a decision never changes which decision a sealed report used. |
| Superseding a period with certified or reported work | Refused unless a change event (§10.5) is recorded and approved in the same transaction. |
| Competing changes | Both take L2 for the company; the second sees the first's projection; if its expected projection version (argument) differs → `STALE_FRAMEWORK_DECISION`, no write. |

### 6.4 Other governed objects

| Object | Record | Events | Projection | Lock (§7.2) |
|---|---|---|---|---|
| Standard version | `fr_standard_versions` (content incl. effective dates, source digest) | `VERIFIED`, `CORRECTED_BY` | none | registry L1 |
| Jurisdiction profile revision | `fr_jurisdiction_profile_revisions` (adoption instrument refs, eligibility rule CRL, local dates, verification record) | `VERIFIED`, `SUPERSEDED`, `WITHDRAWN` | current revision per (jurisdiction, framework) | L1 |
| Pack revision | `fr_pack_revisions` + `fr_pack_content` (immutable content keyed by revision) | none (release is separate) | none | L1 |
| Engine version | `fr_engine_versions` (compiler bundle digest, function closure digests, SQL contract identity = hosted journal id + migration digests, capability versions, git commit) | `ACTIVATED`, `DEACTIVATED(reason)` | active set | L1 |
| Release authorization | `fr_release_authorizations` (pack revision, jurisdiction profile revision, scope definition, sign-off document digest, coverage snapshot digest) | `AUTHORIZED`, `RESTRICTED`, `WITHDRAWN(severity)`, `LEGACY_OPERATING` | current authorization per (pack revision, profile revision, scope) | L1 |
| Treatment case | `tr_case_revisions` (complete content per revision) | `SUBMITTED`, `APPROVED`, `RETURNED`, `REOPENED(cause digests)`, `SUPERSEDED` | current revision per case | L3 (company-period) |
| Allocation set | `al_allocation_revisions` (all allocations of the revision) | `PROPOSED`, `APPROVED`, `SUPERSEDED` | current revision per (company, period, family) | L3 |

---

## 7. Concurrency and idempotency contracts

### 7.1 Isolation assumption

All authority-deciding transactions run at **READ COMMITTED** and call `tb_require_read_committed()` first (existing PT412 pattern). Locks acquired before any read that decides authority ensure each decision reads state committed before the lock was granted.

### 7.2 Serialization keys and global acquisition order

Transaction-scoped advisory locks (`pg_advisory_xact_lock` / `_shared`), always acquired in this order and never in reverse. Status: **I** = implemented on the branch (`20261127100000`), **S** = existing at the baseline, **P** = proposed (Track B).

| Order | Key | Shared by | Exclusive by | Status |
|---|---|---|---|---|
| L1 | `cfoclose.fr_registry` (one global key) | Every publication transition, save, compilation receipt, framework decision (to read authorizations, engine set and profiles stably) | Release authorization events, pack withdrawal, engine activation/deactivation, profile revision changes | P |
| L2 | `cfoclose.fr_company:<company_id>` | **Every scope decision**: `_fs_scope_lock` v2 takes it shared before L3, so publication transitions, explicit replacement, designation, the authority claim, issue and seal all hold it | `set_company_reporting_framework` (and, in Track B, framework decisions) | **I** |
| L3 | `cfoclose.fs_report_authority:<company>:<year>` (`_fs_scope_lock`) | — | Publication transitions, replacement, designation, issuance, seal; treatment and allocation approvals for that period (P) | S |
| L4 | `financial_statement_reports:<report_id>` (lineage lock) | — | Save (`fs_commit_revision`), transitions | S |
| L5 | `financial_statement_publications:<id>:<ver>` (version lock) | — | Transitions | S |
| L6 | `tb_official_output_lock` | — | FINAL, seal, TB removal | S |
| L7 | Row locks (`FOR UPDATE` / `FOR NO KEY UPDATE`) on the specific rows changed | — | e.g. the issuance row (seal), the `companies` row (framework change, after L2) | S, I |

**Implemented order and why it has no cycle.** Scope decisions: (row lock on the issuance row, seal only) → L2 shared → L3 → L4 → L5 → L6. Framework change: L2 exclusive → `companies` row `FOR NO KEY UPDATE`; it takes no L3–L6 and no issuance row, and the reporting paths' foreign-key checks take only `FOR KEY SHARE` on the `companies` row, which does not conflict with `FOR NO KEY UPDATE`. So a framework change and a scope decision of the same company serialise on L2 (whichever holds it first commits first; the other then re-reads committed state), and no wait-for cycle exists. Proven with held transactions in both interleavings (T6 `e1`, `e2`) and for two framework changes (`e3`). Track B will re-sequence seal to L3 → L6 → row and add L1 outermost, with its own held-transaction proof.

**Multi-period scope.** The framework is a company-level fact, so one company key (L2) covers every period: a framework change excludes every scope decision of every period of that company at once, and needs no ordering among periods. Scope decisions for **different** periods of one company share L2 and therefore do not block each other (T6 `e4`). An operation that must hold more than one period's scope (Track B: a restatement that changes a prior period's authority, a multi-period framework decision with an effective range) takes L2 once, then L3 for each affected `period_year` in **ascending** order, before any L4; a function that needs a later period's lock after an earlier one never releases and re-acquires out of order.

**Invariant this protects.** "No FINAL is recorded under a framework other than the company's committed framework, and no framework change commits while a scope decision that read the previous value is in flight." A FINAL that read the framework holds L2 shared until commit; the framework change cannot commit in between. After a change, the dependency bump makes the earlier certification non-authoritative, so later scope decisions refuse until re-certified.

### 7.3 Linearization points and outcomes

| Operation | Locks | Revision check | Linearization point | Competing outcome |
|---|---|---|---|---|
| Save version | L1s, L3, L4 | `p_expected_report_version` (existing) | Insert of report row | Loser: `STALE_VERSION` |
| Evidence replacement | L1s, L3, L4 | expected series head | Insert of superseding batch | Loser: `STALE_VERSION`; approvals on manifests naming the old head become stale (§9) |
| Treatment approval | L1s, L3 | expected case revision + manifest component digests | Approval event insert | Loser: `STALE_CASE_REVISION` |
| Allocation change | L1s, L3 | expected allocation revision | Revision insert | Loser: `STALE_ALLOCATION` |
| Framework decision (Track B) | L1s, L2x | expected projection version | Projection rewrite | Loser: `STALE_FRAMEWORK_DECISION` |
| Framework change (Track A, **I**) | L2x, `companies` row | `p_expected_framework`; request id | `UPDATE companies` + event insert | Loser waits, then `STALE_FRAMEWORK` (T6 `e3`); `FRAMEWORK_LOCKED` once certified or reported; `PROCESSING_IN_PROGRESS` while a check holds a live lease |
| Publication transition | (L1s, P), L2s (**I**), L3, L4, L5, (L6 for FINAL) | expected manifest digest (P) | Publication insert | Loser: `STALE_CANDIDATE` / `ALREADY_FINAL` / `AUTHORITY_CONFLICT` |
| Engine deactivation / pack withdrawal | L1x | expected current authorization event seq | Event insert | Publications that committed first stand; publications after see the withdrawal and refuse |

### 7.4 Deadlock and serialization failure

Fixed order prevents lock-order deadlocks among these operations. Any `40P01` (deadlock) or `40001` (serialization failure) aborts the transaction entirely; the client retries the **same request with the same idempotency key** up to 3 times with jittered backoff (existing pattern `processingInvoke.ts`). Retries are safe because of §7.5.

### 7.5 Idempotency contract

`fs_requests(scope_kind text, company_id uuid, actor_user_id uuid, idempotency_key uuid, request_digest text, result jsonb, created_at, PRIMARY KEY (scope_kind, company_id, actor_user_id, idempotency_key))`.

- **Request digest:** SHA-256 of `cfoclose-canon/1` serialization (§9.2) of `{scope_kind, function, arguments}` with the key itself excluded.
- **Atomic reservation:** the function's first write is `INSERT … ON CONFLICT DO NOTHING RETURNING` in the **same transaction** as the action. A concurrent identical request blocks on the uncommitted unique-index entry until the first commits or aborts (PostgreSQL unique-index wait semantics); it then sees either the committed row (→ replay) or no row (→ proceeds).
- **Same key, same digest:** return stored `result` after re-checking current access (below).
- **Same key, different digest:** `IDEMPOTENCY_CONFLICT`, no effect.
- **Response loss after commit:** the retry replays; no duplicate action.
- **In progress across systems** (issuance; §11.4) uses a job row with a lease instead of a single transaction.
- **Replay authorization:** before returning a stored result, the function re-runs its authorization step; an actor who lost access receives `ACCESS_DENIED` and no stored content.
- **Retention:** rows are kept with the audit trail; keys are UUIDs generated per user action by the client and reused on retry.

### 7.6 Existing coverage

`fs_commit_revision` already has `p_idempotency_key` with `uq_fscg_idem` and `group_hash` (S). Comments, prior-FINAL acceptances, roll-forward and issuances use `(company, actor, request_id)` uniqueness (S). `fs_set_publication_state` has no key; replay = "same state as now" (S). Track A does not require changing these; Track B unifies them on §7.5.

### 7.7 Held-transaction proof scenarios (extend `scripts/db-proof/publicationAuthority.mjs` patterns)

Executed on the branch (T6): framework change held → FINAL replacement waits → proceeds after commit (`e1`); FINAL replacement held → framework change waits → refused `FRAMEWORK_LOCKED` (`e2`); two framework changes → second waits → `STALE_FRAMEWORK` (`e3`); other period not blocked by the company lock, exclusive company lock blocked (`e4`). The scenarios below remain **future**:

1. Two sessions submit the same FINAL with the same key; first held open → second waits → first commits → second returns identical result; one publication row.
2. Same key, different reason text → `IDEMPOTENCY_CONFLICT`.
3. FINAL committed, client connection dropped before response → retry returns the result; one row.
4. Withdrawal (L1x) held; FINAL (L1s) waits; withdrawal commits → FINAL refuses. Reverse interleaving → FINAL stands, withdrawal commits after.
5. Evidence replacement committed between candidate load and FINAL → `STALE_CANDIDATE`.
6. Competing framework decisions → one succeeds; other `STALE_FRAMEWORK_DECISION`.
7. Member removed after a committed request; replay → `ACCESS_DENIED`, no result.
8. Seal and FINAL replacement interleavings under the re-sequenced seal order (existing `a11`/`a12` cases preserved).
9. Deadlock injection: verify no cycle exists among all §7.3 operations (lock-graph test), and retry behaviour on forced `40001`.

---

## 8. Compiler, artifact, signing and audit trust model

### 8.1 Five distinct things

| Layer | Identity | What establishes it | What it does **not** establish |
|---|---|---|---|
| 1 Approved source | git commit on `main` after review | Merge record; branch protection (U: settings not in repo) | That anything was built or deployed |
| 2 Built artifact | **Compiler bundle digest** = SHA-256 of `supabase/functions/_shared/statementCompiler.generated.mjs` bytes (`49fc0852…`; drift-checked by `scripts/buildStatementCompiler.mjs --check`) and **function closure fingerprint** = SHA-256 over sorted `"<sha256>  <path>"` lines of the transitive relative imports of a function's `index.ts` (`scripts/release/functionClosure.mjs`; `compile-financial-report` `745c8170…`, `seal-reporting-pack` `cdc5416f…`) | Reproducible build from layer 1 | Deployment |
| 3 Deployed artifact | Closure fingerprint computed over the downloaded function (`verifyDeployedClosure.mjs`) | Download + recompute at a point in time | Later redeployments; what executes |
| 4 Runtime execution | — | **Nothing in CFOClose attests execution.** The receipt's `compiler_sha256` is sent by the running function itself (O-01) | — |
| 5 Accounting correctness | Validated fixtures (§10.8) | Independent accounting review | Anything about layers 1–4 |

The bundle digest is a component of the closure; a matching bundle digest never proves a closure is deployed (stated in `verifyDeployedClosure.mjs`).

### 8.2 Track A position

Gate **A2** (delivery plan §1) requires layer 3 for both reporting functions: download, compute closure, compare with `745c8170…` and `cdc5416f…`, record result. Layer 4 remains unattested; the compensating control is SQL recomputation of figures and presentation skeleton (blockers v6/v7). Disclosure wording and policies are preparer text and are not server-verified (stated in `20261126100000` header). `track-a-r1` changes no function source and no compiler source: the required closures stay `745c8170…` and `cdc5416f…` and the bundle `49fc0852…` (T11), so A2 is unaffected by it.

### 8.3 Independently trusted signatures — **deferred by scope decision DS-1**

**DS-1 (recorded 2026-10-24, owner instruction for this release):** independently trusted signing is **out of scope** for Track A and for the first Track B releases; it is a deferred scope decision, not an omission, and is listed in §13. No signing is specified for those releases. If added later, the design must satisfy all of:

1. Signer authorization enforced **outside** the reporting database (separate service and identity provider).
2. Keys in a managed KMS/HSM; signing service has no database write access; operators cannot export keys; key administration separated from release operation.
3. Signed payload = `{manifest_digest, document_hash, artifact digests, closure fingerprints, publication_id, issued_at}`; the signer independently recomputes `document_hash` from a manifest replay (§9.6) in its own environment before signing. **A compromised database can request a signature but cannot obtain one for content the signer's own replay does not reproduce.**
4. Replay protection: signer records `(publication_id, manifest_digest)` and refuses re-signing different content for the same publication.
5. Rotation with overlapping validity; revocation list published outside the database; verification tool checks chain, revocation and recomputation.
Until then, "official" means "sealed by CFOClose's database with verified stored bytes", nothing stronger.

### 8.4 Audit chains and external anchoring

A database-local hash chain detects accidental corruption and tampering by actors below function owner. It does **not** protect against an administrator who rewrites rows and hashes together. Optional control (Track B, owner decision OD-6): periodically export `(table, last seq, chain head digest)` to an external append-only store outside the database administrator's control (e.g. object storage with retention lock in a separate account); verification compares replayed heads with anchored heads. Without it, the protection claim is limited to the narrower statement above.

---

## 9. Manifest, canonicalization and replay

### 9.1 Manifest schema `cfoclose-manifest/1`

```json
{
  "manifestVersion": "cfoclose-manifest/1",
  "canonicalization": "cfoclose-canon/1",
  "company": { "id": "uuid", "legalNameDigest": "hex" },
  "period": { "year": 2026, "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "framework": { "decisionId": "uuid", "decisionDigest": "hex", "jurisdictionProfileRevisionId": "uuid|null", "resolvedRequirementSetDigest": "hex|null" },
  "pack": { "packRevisionId": "string", "contentDigest": "hex" },
  "engine": { "gitCommit": "40-hex", "compilerBundleSha256": "hex", "closures": { "compile-financial-report": "hex" }, "sqlContract": { "journalId": 80, "journalHash": "hex" }, "rulePackVersion": "2.2.0" },
  "inputs": {
    "certification": { "id": "uuid", "outputHash": "hex", "sourceFileHash": "hex" },
    "priorCertification": { "id": "uuid|null", "outputHash": "hex|null" },
    "adjustments": [ { "id": "uuid", "revision": 1, "digest": "hex" } ],
    "allocations": [ { "family": "FACE_LINE", "revisionId": "uuid", "digest": "hex" } ],
    "treatmentCases": [ { "caseId": "uuid", "revision": 1, "digest": "hex" } ],
    "applicability": [ { "requirementKey": "string", "decisionDigest": "hex" } ],
    "evidence": [ { "series": "string", "batchId": "uuid", "documentHash": "hex", "sourceBytesSha256": "hex" } ],
    "comparatives": { "approvalDigest": "hex|null", "changeEvents": ["uuid"] },
    "materiality": { "revisionId": "uuid|null", "digest": "hex|null" },
    "presentation": { "currency": "TZS", "exponent": 2, "scale": "UNITS", "roundingMode": "HALF_AWAY_FROM_ZERO" }
  }
}
```

**Extensions (`cfoclose-manifest/1`, additional members of `inputs`; each `null` when not applicable to the report):**

```json
{
  "policies": { "accountingPolicyRegisterRevisionId": "uuid|null", "digest": "hex|null", "signoffPolicyEventId": "uuid", "elections": [ { "electionId": "uuid", "digest": "hex" } ] },
  "budgets": { "budgetVersions": [ { "budgetId": "uuid", "versionId": "uuid", "kind": "ORIGINAL|AMENDMENT|FINAL", "digest": "hex" } ], "comparableActualsDigest": "hex|null", "reconciliationTargetsDigest": "hex|null" },
  "reconciliationInputs": { "cashAccountMap": { "batchId": "uuid", "documentHash": "hex" }, "bankReconciliations": [ { "accountCode": "string", "evidenceBatchId": "uuid", "documentHash": "hex" } ], "reviewerFindingDecisions": [ { "findingId": "uuid", "decisionId": "uuid" } ] },
  "fx": { "rateSetRevisionId": "uuid", "source": "string", "digest": "hex", "functionalCurrency": "TZS", "presentationCurrency": "TZS" },
  "group": { "perimeterRevisionId": "uuid", "entities": [ { "companyId": "uuid", "ownershipDigest": "hex" } ], "eliminationSetDigest": "hex", "componentManifestDigests": ["hex"] }
}
```

`policies` makes the policy register, elections and the sign-off policy in force part of what was approved; `budgets` binds IPSAS 24 budget versions, the comparable-basis actuals and the reconciliation targets (`IPSAS_ACCRUAL_SPEC.md` §6); `reconciliationInputs` binds the evidence the reconciliation rules consumed and the reviewer finding decisions the readiness relied on; `fx` binds the exact rate set (Track B, B14); `group` binds the consolidation perimeter and the manifests of the component reports (B15), so a group report is reproducible only from its components' recorded manifests.

Arrays are sorted by their first key field (code-point order). `null` means "not applicable to this report", never "unknown". The manifest is stored immutably (`fs_manifests`, §6.1) and its digest is bound to the report version, the compilation receipt and every approval.

### 9.2 Canonicalization `cfoclose-canon/1`

Extends existing `canonicalJson` (`src/lib/shared/canonicalHash.ts:24`; `supabase/functions/_shared/hash.ts:36`). Implementations in TypeScript (browser and Deno) must produce identical bytes, proven by a shared corpus test.

1. **Input parsing.** Reject duplicate object keys at parse time (strict parser; `JSON.parse` silently keeps the last and must not be used for manifest input).
2. **Unicode.** All strings, **including object keys**, are normalized to NFC. After normalization, two keys of one object that become equal is a **rejection** (`CANON_KEY_COLLISION`), not a merge. Unpaired surrogates are rejected.
3. **Objects.** Keys sorted by Unicode code point of the NFC form.
4. **Numbers.** JSON numbers are rejected in monetary, decimal and identifier positions. Integers representing minor units are base-10 strings, regex `^(0|-?[1-9][0-9]*)$`, with |value| < 10^30. Decimals are strings `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$` (no exponent, no trailing fractional zeros, no `-0`).
5. **Dates** `YYYY-MM-DD`; timestamps are excluded from deterministic content.
6. **Output.** UTF-8, no BOM, no whitespace. Digest = SHA-256 over `"cfoclose-canon/1\n" + output`.

**Two identities for evidence:** `sourceBytesSha256` (exact uploaded bytes, never normalized) identifies *what was received*; `documentHash` (canonical parsed document) identifies *what was used*. Both are in the manifest; replay uses `documentHash`, provenance uses `sourceBytesSha256`.

### 9.3 Arithmetic

- Monetary values: arbitrary-precision integers in minor units (TS `bigint`; SQL `numeric` with `trunc(x)=x` checks), bound |x| < 10^30; exceeding → `NUMERIC_BOUND_EXCEEDED`.
- Intermediate decimals (rates, ratios, PV factors, FX): exact decimal with declared scale ≤ 18 and ≤ 38 significant digits; rounding only by explicit `round(value, scale, mode)`.
- **Allocation residuals:** for a source amount `A` (may be negative) split by non-negative weights `w_i` summing to `W > 0`: compute `q_i = trunc(A·w_i / W)` toward zero; residual `r = A − Σq_i` (|r| < n); distribute `sign(r)` one minor unit at a time to targets ordered by descending fractional remainder magnitude, ties by target key code-point order. Negative weights are rejected; zero `W` is rejected. Result sums exactly to `A`.
- **Negative allocations:** a target amount may be negative only where the source is negative or the pack line declares contra behaviour; a positive source producing a negative target is rejected (`ALLOCATION_SIGN_INVALID`).

### 9.4 Deterministic errors

Validation collects all refusal codes. The returned list is sorted by `(severity rank, code, parameters)` in code-point order; the **primary** refusal is the first element. Refusals never depend on hash-map iteration order or query plan order (every SQL query feeding refusals has an explicit `ORDER BY`).

### 9.5 Document content versus issuance metadata

`document_hash` covers the canonical report document only. Issuance envelopes (timestamps, request ids, issuing user, storage path, renderer timing) are hashed separately. Replay compares `document_hash`.

### 9.6 Replay: obtaining historical executable behaviour

A version string does not preserve an overwritten SQL implementation. Replay therefore rebuilds the historical executable environment:

1. **TypeScript compiler:** checkout `engine.gitCommit`, rebuild the bundle, verify `compilerBundleSha256`, run it in a pinned Deno version recorded with the engine version.
2. **SQL contract:** create a disposable database and apply the authored migration chain up to the migration set whose journal mirror matches `sqlContract.journalId` and `journalHash` (the release journal pins wrapper digests per id). This reproduces the SQL function bodies in force.
3. **Pack content:** read the immutable pack revision rows (or, for the existing TS pack, the pack source at `gitCommit`).
4. **Inputs:** read the immutable records named by the manifest (all are append-only).
5. **Compare:** recomputed `document_hash` = recorded `document_hash`.

**Isolation.** Replay runs in a disposable environment created for it: a new database and runtime with **no network egress**, no production credentials and no write path back to production. Its only input is an exported **replay bundle** (the manifest plus every record and file the manifest names), each item verified against its digest before use; anything missing makes the replay `REPLAY_INCOMPLETE`, never a best effort. Replay output is a comparison record (`MATCH` / `REPLAY_MISMATCH` with the first differing path), written to the replay environment and attached to the original publication only as a separate append-only verification record. Replay never creates, changes or supersedes a publication, authority or pack.

**Retention obligations:** git history of `main` (never rewritten), the authored migrations and journal mirrors (already pinned as immutable by `appliedMigrationsImmutable.test.ts`), Deno version per engine version, and pack revisions. **Withdrawal and deactivation do not delete** any of these; replay of withdrawn revisions and deactivated engines remains possible and never creates a publication.

**Historical versions without manifests** (every version before manifests ship): replay uses the existing identities (`document_hash`, `dependenciesSha256`, `inputSha256`, receipt `source_snapshot`) at the commit recorded in release evidence for the period; results are labelled `LEGACY_REPLAY` (document identity only; inputs not fully enumerated).

---

## 10. Accounting architecture (Track B, provisional)

### 10.1 Chain

Source records → treatment decisions and supporting schedules → approved adjustments → adjusted TB → allocation → statements and disclosures → validated publication. CFOClose holds conclusions about the books, their evidence, and the entries that bring the certified TB to the reported position; it is not an ERP.

### 10.2 Controlled extension points

| Extension point | Mechanism | Review |
|---|---|---|
| New requirement content | Pack revision (data) | Accounting technical review + release authorization (§6.4) |
| New calculation | Engine capability (reviewed code, versioned, statutory reference per CLAUDE.md §8.1) | Engineering + accounting review; engine version activation |
| New treatment topic | Topic schema in pack + governed judgment workflow (§10.3) | Accounting review |
| New jurisdiction | Jurisdiction profile revision with verification record | Jurisdiction adviser |
| Framework policy in orchestration | **Not an extension point.** Orchestration consults resolved requirement sets and authorizations; framework identifiers appear only in registries, packs, capabilities, adapters, tests and seed migrations |

Pack rules use the restricted, typed rule language CRL/1 (types `Money`, `Decimal`, `Integer`, `Boolean`, `Date`, `Enum`, bounded `Set/List`; three-valued logic with `KNOWN/MISSING/UNKNOWN/NOT_APPLICABLE`; explicit `round`; capability calls only from an allowlist bound to the engine version; acyclic dependencies; resource limits with deterministic `RULE_RESOURCE_LIMIT`; no loops beyond bounded aggregation, no I/O, no SQL or JS). Its full grammar is an incomplete specification (delivery plan WP-B4).

### 10.3 Treatment cases and governed judgments

A treatment case records: entity, period, unit of account (`ACCOUNT`, `TRANSACTION_SET`, `CONTRACT/ARRANGEMENT`, `INSTRUMENT`, `ASSET/CLASS`, `ENTITY`, `REPORTING_ADJUSTMENT`); facts and terms; applicable standard versions and verified citations; recognition/derecognition conclusion; measurement basis, method and assumptions; policy election reference; estimates, uncertainty and sensitivity where required; calculation (`NATIVE` capability run or `EXTERNAL` schedule); evidence digests; proposed entries (materialised as `close_review_adjustments` proposals); presentation consequences (allocations); disclosure consequences; preparer submission and reviewer decision (per §12 operating model); supersession and reopening when any dependency digest changes. Identity and lifecycle per §6.4.

A **governed judgment** is a treatment case whose conclusion is not computed: CFOClose enforces that facts, conclusion, rationale, evidence and reviewer decision exist and are consistent with the topic schema; it does not decide the conclusion.

### 10.4 External schedules — validation boundary (shown in product and review pack)

| CFOClose validates and blocks on failure | Preparer and reviewer remain professionally responsible |
|---|---|
| Schema conformance; casting of rows and columns; opening = prior closing or approved opening adjustment; closing ties to allocated TB amounts; currency, exponent, period and entity match; file digest; preparer and tool identity; presence of disclosure data fields | Model and method appropriateness; assumptions; population completeness beyond stated controls; correctness of data inside the external tool |

### 10.5 Changes, transitions, restatement versus reissue

**Change events** record kind (`FIRST_TIME_ADOPTION`, `NEW_STANDARD_INITIAL_APPLICATION`, `EDITION_CHANGE`, `FRAMEWORK_CHANGE`, `POLICY_CHANGE_REQUIRED`, `POLICY_CHANGE_VOLUNTARY`, `ESTIMATE_CHANGE`, `ERROR_CORRECTION`), date of initial application, method and practical expedients — **each permitted by the pack's transition rule for that standard version, per standard** — opening adjustments, comparative treatment and required disclosures.

**Restating comparatives in the current report is distinct from reissuing the prior-year report.** The system supports the first without forcing the second:

| Aspect | Restated comparatives (current report) | Reissue / replacement of prior-year report |
|---|---|---|
| Prior-year FINAL | **Untouched**: document, bindings, sealed packs, authority remain immutable and retrievable | Superseded by a new FINAL for the prior period (existing succession or explicit replacement) |
| Current report | Comparative column = original as-reported amounts + approved restatement entries (existing `fs_comparative_restatements`, two-person), linked to change events | Unchanged |
| Reconciliation | Original-to-restated reconciliation per affected line, generated from as-reported + restatement entries (existing `asReportedMinor` retained) | Not applicable |
| Authority | Prior-year authority pointer unchanged | Pointer moves per FINAL authority rules |
| Approvals | Restatement approvals + comparative approval bound to `comparative_sha256` | Full sign-off of the prior period |
| Disclosures | Transition/change disclosures per standard; third statement of financial position where the profile requires it | Prior-period report disclosures |

### 10.6 Applicability

Every requirement in the resolved set has exactly one current decision per entity-period: `APPLICABLE` (with fulfilment), `NOT_APPLICABLE` (data trigger or preparer with reason), `UNDECIDED` (blocks). **Zero balances never establish non-applicability** unless all hold: no period activity on related accounts; zero comparative; no treatment case for the topic; and the requirement is not in the qualitative set (unrecognized items, commitments, contingencies, guarantees, related parties, events after the reporting date, going concern, service concessions, and any requirement flagged `NEVER_AUTO_NOT_APPLICABLE`).

### 10.7 Materiality

**Financial-statement materiality** (information whose omission, misstatement or obscuring could reasonably be expected to influence users' decisions) is a preparer judgment recorded per entity-period with quantitative reference points, qualitative factors and approval. It drives variance-explanation thresholds, aggregation choices and bulk-review limits. **Audit concepts (performance materiality, clearly trivial thresholds) are out of scope**: CFOClose is a preparer tool. Materiality never auto-decides non-applicability of qualitative requirements.

### 10.8 Independent accounting validation

A requirement is `VALIDATED` only when an independently prepared fixture (inputs and expected outputs prepared outside the code and signed by a named qualified reviewer before the compiler is run) passes. Fixtures cover success cases built from coherent generated transactions and rejection cases with deliberately inconsistent evidence. Arbitrary balanced TBs are not valid inputs for cash-flow, net-asset or budget invariants.

---

## 11. Publication and recovery

### 11.1 Report states and permitted transitions (existing, retained)

| From → To | Who | Conditions |
|---|---|---|
| (none) → DRAFT | `prepare_close` | New version saved |
| DRAFT → REVIEWED | `review_close` | Blockers empty; receipt current |
| REVIEWED → DRAFT | `review_close` | Reason ≥ 8 chars |
| REVIEWED → FINAL | `approve_certification`; separation per §12 | Blockers empty; latest version; scope authority rules |
| FINAL → (new FINAL in same lineage) | as above | Succession (`SUCCEEDED`) |
| FINAL (other lineage) | as above + explicit replacement | `REPLACED` naming the exact holder |
| unresolved scope → designated | `approve_certification` | Legacy only (D-07) |

FINAL is terminal per version. **Report retraction** (a FINAL found to be wrong with no replacement yet) is a new append-only `AUTHORITY_NOTICE` event attached to the FINAL; it never modifies the document or sealed packs; verify/retrieve disclose it. *(P; owner decision on who may record it, OD-5.)* **Release withdrawal** (§6.4) is distinct: it governs future use of a pack revision, not existing reports.

### 11.2 Atomic transition contract

All paths to REVIEWED and FINAL execute, in one database transaction: idempotency reservation (§7.5); authorization (§5.1); locks (§7.2); version and manifest checks (§7.3); server-only blocker recomputation; separation-of-duties policy (§12); publication insert; binding with receipt id; authority claim; audit event; idempotency result. Existing triggers remain as defence in depth and call the same validation.

### 11.3 Database and storage are not one transaction

Issuance spans PostgreSQL and object storage. It is a **recoverable workflow**, not an atomic operation.

### 11.4 Issuance workflow

Job record `is_jobs(job_id, company_id, final_publication_id, artifact_kind, renderer_closure_digest, idempotency_key, state, attempts, lease_owner, lease_expires_at, fence, last_error_code, object_path, object_sha256, byte_size)`.

**Fencing tokens.** `fence bigint` increases by one every time a lease is granted (including takeover after expiry), in the same statement that sets `lease_owner` and `lease_expires_at`, and is returned to the worker. Every later worker write is conditional on `job_id = $job AND fence = $mine AND state = $expected` and must affect exactly one row; zero rows means the worker has been fenced off and it stops without retrying. The storage path includes `job_id` and the content digest, so a fenced worker that is still uploading can at most write identical bytes (refused as existing) or bytes that never become referenced. The seal function requires the job's current fence and `STORED` state and verifies the stored object's size and digest itself; a seal attempt carrying an older fence is refused `FENCED`. Lease expiry alone never lets two workers both complete a state transition.

| State | Entered by | Next |
|---|---|---|
| `REQUESTED` | Issue RPC (L3, authority check, `final_publication_id` bound) | `RENDERING` when a worker takes a lease |
| `RENDERING` (leased) | Worker | `STORED` after upload and read-back verify; `FAILED_RETRYABLE` on error; lease expiry returns it to `REQUESTED` |
| `STORED` | Worker records path, digest, size | `SEALED` via seal function; `FAILED_RETRYABLE` |
| `SEALED` | Seal function (L3 → L6 → row lock; verifies storage metadata size and the digest recorded at store) | terminal |
| `FAILED_RETRYABLE` | Any step | `REQUESTED` after backoff; after 5 attempts → `NEEDS_OPERATOR` |
| `NEEDS_OPERATOR` | Retry limit | Operator action: retry, or close as `ABANDONED` with reason (audited) |

| Situation | Behaviour |
|---|---|
| Incomplete upload | Never visible as official: only `SEALED` jobs are listed as official packs |
| Worker crash | Lease expires; another worker takes a new lease (fence + 1) and resumes from the recorded state; the old worker's late writes match no row (fenced); upload path is content-addressed so re-upload of identical bytes is idempotent |
| Upload success, response lost | Worker reads back the object; identical bytes → proceeds to `STORED` |
| Seal failure | Job stays `STORED`; retried; object never official until sealed |
| Duplicate requests | Unique `(final_publication_id, artifact_kind, renderer_closure_digest)` + idempotency key → existing job returned |
| Existing object with conflicting bytes | `OBJECT_CONFLICT`; nothing overwritten or deleted (existing behaviour); operator investigates |
| Orphans | Sweeper lists objects without a `SEALED` job (existing `reporting_pack_storage_orphans`) and objects of `ABANDONED` jobs; deletion only by operator after review, audited |
| Permissions | Before seal: object readable only by service role. After seal: readable through verify/retrieve functions that check membership; never public |
| Withdrawal or retraction notices | Separate records returned by verify/retrieve; the sealed artifact bytes are never modified |

### 11.5 Rendered PDF/XLSX binding

Renderers run outside SQL. A rendered artifact is bound by the record `(document_hash, renderer_closure_digest, output_sha256)`. SQL verifies stored bytes against `output_sha256`; it does not and cannot verify that the bytes depict the document. **Independent verification** = re-render the canonical document with the same renderer closure in a clean environment and byte-compare; this requires deterministic renderers (fixed fonts, no embedded timestamps or random identifiers), which is a renderer acceptance criterion. Until a renderer meets it, its outputs are labelled "rendered copy; canonical JSON is authoritative". The existing official artifact is the database-generated canonical JSON (S).

### 11.6 Recovery proofs (future)

Fault injection at each state boundary; lease expiry with two workers, the first resuming after the takeover (all its writes refused by fence); response loss after upload; conflicting object; sweeper reconciliation; retry exhaustion to `NEEDS_OPERATOR`; post-seal permission checks; verify with notices.

---

## 12. Operating models and separation of duties

| Model | Who | Rule | Disclosure |
|---|---|---|---|
| **Team** | ≥ 2 people with capabilities | REVIEWED and FINAL by different people (existing rule). Preparer may review (current behaviour) unless the workspace elects "preparer cannot review" (P) | Approver names on bindings (existing) |
| **Solo practitioner** | 1 person (owner) | Recorded `solo_owner` policy (existing); FINAL by the reviewer permitted | `same_approver` recorded (existing); **disclosure in issued pack that one person prepared, reviewed and approved** (P) |
| **Material judgments** | — | Material treatment cases require a reviewer decision; in solo model, an explicit self-review attestation per case (P) | Listed in review pack |

Capability checks only (§5.1); no titles. **Owner decisions:** OD-3 (whether "preparer cannot review" is offered or required for some plans), OD-4 (capability for framework changes), OD-5 (who may record a retraction notice). No universal three-person rule is imposed.

**Workflow principles** (Track B user interface; delivery plan §2): one clear next action from server state (existing `nextAction.ts` pattern); saved drafts and resumption (existing draft protocol); prior-year reuse as `CARRIED` items with change review; reviewer attention on exceptions and material judgments; no re-entry of facts already held; refusal messages in the entity's framework vocabulary; no unsupported framework offered for final sign-off.

---

## 13. Open items (authoritative register)

| ID | Item | Owner | Consequence until resolved |
|---|---|---|---|
| Q-1 | IPSAS 47 effective-date and transition text (paras 194–203A, incl. 194A and 203A) not retrieved verbatim (§0.5). Verified: effective 1 Jan 2026; 194A/203A added Oct 2024, amendments effective 1 Jan 2027; earlier application permitted. Unverified: the transition methods, practical expedients and any early-application conditions in the final text (`IPSAS_ACCRUAL_SPEC.md` §5.3) | IPSAS technical reviewer | IPSAS pack cannot be authorized; no IPSAS report can reach REVIEWED |
| Q-2 | Tanzanian requirements: framework for public sector entities and LGAs; NBAA TP No. 1 of 2015 / No. 1 of 2018 content; current IFRS for SMEs eligibility criteria; adoption of SME third edition, IPSAS 2026 Handbook standards, IFRS 18 | Tanzanian jurisdiction adviser | No Tanzanian jurisdiction profile revision can be verified; no TZ support scope can be authorized. The 2016 TZS 800 million figure is historical and must not be enforced |
| Q-3 | IFRS 18 Appendix C paragraph text (primary) | IFRS technical reviewer | Full IFRS IFRS-18 profile cannot be authorized |
| Q-4 | Runtime attestation of compiler execution | Engineering | Residual reliance on SQL recomputation (§8.2) |
| Q-5 | Licensing to display standards text | Owner / legal | Citations by reference only |
| Q-6 | Pilot IPSAS entity: budget basis and levels of legislative oversight | Owner | IPSAS fixture design incomplete |
| Q-7 | IPSAS 24 current-Handbook text pin (consulted text is an earlier edition) | IPSAS reviewer | IPSAS 24 citations remain `PRIMARY_EARLIER_EDITION` |
| Q-8 | Hosted effective grants on `fs_report_authority` and the history tables before installation | Release operator (gate A3) | Records the pre-installation exposure; `track-a-r1` removes it whatever it is |
| OD-1 | D-05/D-06/D-09 disposition | — | **Resolved: fixed** (`20261127100000`, I). Installed at gate A4 before the acceptance window A5; risk acceptance is not the disposition |
| OD-2 | D-01 disposition | — | **Resolved: fixed** (`20261127100000` + `20261128100000`, I). Installed at A4 before A5 |
| OD-3…OD-5 | Operating-model decisions (§12) | Owner | Defaults remain current behaviour |
| OD-6 | External audit-chain anchoring | Owner | Narrower audit protection claim (§8.4) |
| OD-7 | Committed customer scope for Track B (IPSAS pilot FY ending 30 June 2027 is recorded; SME third edition customers unknown) | Owner | Delivery prioritization (delivery plan §3) |
| OD-8 | May a reviewer's `ACCEPT_FINDING` clear a server-detected non-core CRITICAL/HIGH or `INSUFFICIENT_EVIDENCE` finding? Today: client readiness clears it, the server receipt keeps blocking (§3 D-02) | Owner with accounting reviewer | Fails closed: such a report cannot reach REVIEWED/FINAL; the browser can show "ready" while the server refuses with the finding named. Any change is a reviewed migration (and possibly a compiler change, which re-opens A2) |
| DS-1 | Independently trusted signing | Owner | **Deferred by decision** (§8.3). "Official" means sealed by the CFOClose database with verified stored bytes |

---

## 14. Self-audit

| Check | Result |
|---|---|
| Mutable content behind immutable identities | Removed: state lives in events; projections are derived and rebuildable; manifests reference records + digests (§6, §9.1) |
| Contradictory transitions | One transition table (§11.1); retraction ≠ release withdrawal ≠ replacement |
| Authorization boundaries | Actor matrix (§4); definer rules (§5.1); limits stated |
| Lock protocol completeness | Every mutating operation in §7.3 maps to keys in §7.2; withdrawal participates via L1 |
| Manifest completeness | Inputs of §10 all appear in §9.1; engine identity includes SQL contract (journal id + hash) and git commit |
| Unsupported claims | No support scope claimed; H class empty; stale "unapplied" statements identified |
| Conclusions from balanced numbers | Rejected (§10.1, §10.6, §10.8) |
| Future tests described as done | §0.4 lists only executed work; §7.7, §11.6 marked future |
| Findings accuracy | D-02, D-03, D-07 downgraded or withdrawn; D-01, D-05, D-06, N-04 reproduced; D-02 residual withdrawn after the rule inventory, replaced by OD-8; D-06 broadened to fifteen tables; D-09 added |
| Flags as authorization | None in the implemented Track A paths (§4.2); CFR-MASTER-2's flag-based proposals for D-01/D-05 not implemented; its description of the `filing_jurisdiction` guard corrected |
| Implemented versus installed | Every Track A fix carries class I (branch) and T (disposable proof); none carries H; installation is delivery plan gate A4 |
| Recovery wording | No guard removal is described as recovery (§4.3, §5.4; delivery plan §1) |
