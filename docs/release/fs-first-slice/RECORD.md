# Financial statements — first complete reporting slice: scope and decision record

Maintained by NORMAL (implementation owner). BLACK reviews against this record. One record; findings are
classified BLOCKER / NON-BLOCKING / QUESTION and batched. Evidence labels: SOURCE-INSPECTED / EXECUTED-LOCAL /
CI-PROVEN / HOSTED-VERIFIED / UNKNOWN. A green suite, filename or source module never proves an unexercised case.

## 1. Pinned heads

| What | Value | Evidence |
|---|---|---|
| Baseline (`origin/main`) | `29b0d945c1cbbd58bdca2314b48742c9b474c240` (merge of #169) | git |
| Diff `18bff84..29b0d94` outside `docs/` and `*.md` | **empty** — the FS implementation audited at `02c516a`/`18bff84` is byte-identical here | `git diff --stat 18bff84 origin/main -- . ':!docs' ':!*.md'` |
| Branch / worktree | `feat/fs-first-slice-20261018` at `D:/DevStorage/Temp/claude/fs-slice-20261018` | git worktree |
| Candidate head | `c0fc16e` first implementation; `65914ff` release packaging (wrapper batch `fs-controls-r1`); `a6e8c69`, `e408f04`, `f4acc2f` merge `origin/main` (#173 TB UX release; #175 pricing-p1 with migration 20261110100000; `dd2a29c` its hosted application as drizzle entry 0062); `453aeca` second pass (2015 edition only, adjustment-to-sign-off, prior-FINAL reconciliation, browser journey); the wrapper batch is re-registered from `453aeca`'s committed bytes (`44fd72c`); `a5de686` merges `origin/main` `50282a3` (#177, pricing-p1 journal close-out, hosted id 63) — registry comments and the pending list were the only conflicts; `20261111100000` is the only `PENDING_HOSTED_APPLY`; the final head is the PR's | git; PR #176 (draft) |

## 2. Supported first slice (pinned)

| Dimension | Pinned value |
|---|---|
| Entity type | one standalone for-profit entity with share capital; no parent/subsidiaries, no associates, no groups |
| Framework | IFRS for SMEs only (`framework.kind = IFRS_FOR_SMES`); `framework.version` must equal the server-resolved pack id |
| Edition | **IFRS for SMEs 2015 edition only** (`ifrs-for-smes/2015`): the only edition whose requirement texts are verified against the pinned standard. The edition is still resolved from the period START by `fs_ifrs_for_smes_edition`; a period the policy resolves to the third edition (beginning on/after 2027-01-01, or a recorded early-application election) composes as before but is **refused at sign-off by name** (`FRAMEWORK_EDITION_UNSUPPORTED:ifrs-for-smes/2025`, blockers and binding trigger). Nothing older is presented as verified third-edition support. Pack **1.2.0** |
| Reporting period | one annual period (12 months, `smes.period.annual`); period dates from the company's authoritative reporting input |
| Provenance | `TRIAL_BALANCE_DERIVED` only: the authoritative certified trial balance of the period with approved Close Review adjustments (`fs_reporting_input`) |
| Comparative | exactly one prior period, authoritative (certified) or the approved first-period declaration; comparative approval bound to its identity |
| Evidence families used | TRANSACTION_LEDGER (CURRENT, COMPARATIVE), EQUITY_MOVEMENTS (CURRENT, COMPARATIVE), CASH_ACCOUNT_MAP (CURRENT), PRIOR_PERIOD_STATEMENTS (COMPARATIVE: signed prior-year SCF opening cash) |
| Statements | SFP, SCI (single statement, no OCI), SOCIE, SCF (direct method), notes |
| Supported accounting cases | presentation/classification of reviewed accounts; approved balanced adjustments; movement schedules (PPE, investment property, intangibles, provisions); preparer-supplied disclosure wording with recorded applicability; comparatives with governed restatements |
| Exclusions (refused by name, never composed) | OCI items, discontinued operations, equity-method shares (`REPORTING_CASE_UNSUPPORTED`); full IFRS, IPSAS accrual, IPSAS cash, any non-TB provenance (`PUBLICATION_PATH_UNSUPPORTED`); groups; first-time adoption / transition reliefs; recognition or measurement of anything (tax, ECL, leases, revenue measurement); indirect-method cash flow; more than one comparative |
| Required professional judgements (recorded decisions) | share capital applicability; discontinued operations / OCI / associates' OCI presence; events after the reporting period; parent / ultimate controlling party; related-party transactions; early application |

**Alternative presentations:** the 3.18 statement of income and retained earnings, the two-statement SCI, and the
liquidity presentation are **not** supported in this slice (no verified applicability rule): a document that omits
SOCIE is refused by `MISSING_STATEMENT:STATEMENT_OF_CHANGES_IN_EQUITY`.

**Indirect method:** assessed and not implemented. The existing direct-method route (ledger + cash account map +
account-by-account rollforward) is already built, evidence-bound and reconciled to the trial balance; an indirect
method would need a complete, classified non-cash-movement authority the system does not hold (see
DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001). Decision: keep direct; reconsider only with a product decision.

## 3. Component map (reuse / repair / new)

| Component | Status | Notes |
|---|---|---|
| `fs_reporting_input`, `fs_statement_composition` (SFP/SCI), `fs_notes_status`, `fs_comparatives_status`, `fs_reporting_dependencies`, `fs_publication_blockers`, `fs_set_publication_state`, `fs_bind_publication`, `fs_publication_bindings`, sign-off policy (20261024) | **reused + repaired** | repaired by `20261111100000_fs_publication_controls.sql` (§4) |
| `src/lib/financialGeneration/{cashFlowDirect,equityStatement,cashPerimeter,cashLedgerAuthority}.ts` | **reused** (deterministic browser generators, unchanged) | the server now recomputes every figure they produce and refuses any difference |
| `src/lib/reporting/{prepareVersion,signoff,blockers}.ts`, `financialGeneration/composedReport.ts` | reused; `blockers.ts` extended with the new refusal names | |
| `src/lib/frameworkPacks/ifrsForSmes.ts` | **repaired**: pack 1.2.0 adds the applicable disclosure requirements (§4.4) | pinned to the DB seed by `notesSchedules.mjs` |
| Reporting workbench UI (`src/components/reporting/*`) | reused; no new screens | journey unchanged: statements → notes → schedules → comparatives → sign-off → exports |
| `scripts/db-proof/publicationControls.mjs` | **new** | executed acceptance cases A–L (§6) |
| Release packaging (wrapper batch, drizzle journal entry, CI jobs) | **new** | generated from committed bytes after review (§8) |

Nothing was replaced. No parallel engine, no new prototype.

## 4. Decisions (agreed unless marked OPEN)

1. **Figure authority for SCF and SOCIE** — the server recomputes, from the latest valid evidence batches and the
   composition, every figure the browser generators emit (same fact identities: `fact:line:cf:*:<period>`,
   `fact:line:eq:*:<period>`, `fact:cashperim:*`, `fact:cashroll:*`). `fs_reporting_dependencies/3` binds them;
   `fs_publication_blockers` v3 requires every figure present with exactly its amount and nothing else bound on
   the four statements. A tampered cash-flow or equity figure is `STATEMENT_FIGURE_MISMATCH`; an invented line is
   `STATEMENT_FIGURE_NOT_COMPOSED`.
2. **Server-side ties** (new blockers): SCF closing = cash perimeter of the SFP for each period
   (`CASHFLOW_CLOSING_CASH_TIE`); SCF opening = prior closing (`CASHFLOW_OPENING_NOT_PRIOR_CLOSING`); ledger
   movement = trial-balance movement per cash account (`CASHFLOW_ACCOUNT_ROLLFORWARD`); SOCIE component casting
   (`SOCIE_COMPONENT_DOES_NOT_CAST`); SOCIE closing = SFP total equity (`SOCIE_CLOSING_EQUITY_TIE`); SOCIE result =
   SCI profit or loss (`SOCIE_PROFIT_TIE`); SOCIE opening = prior closing per component
   (`SOCIE_OPENING_NOT_PRIOR_CLOSING`). Nothing is plugged; a difference is a named blocker.
3. **Fail closed on unsupported paths** — any report whose provenance is not `TRIAL_BALANCE_DERIVED` or whose
   framework is not `IFRS_FOR_SMES` gets `PUBLICATION_PATH_UNSUPPORTED:<framework>:<provenance>` from the blockers
   AND the binding trigger refuses it (defence in depth for a direct insert). The IFRS / IPSAS rows of
   `financial_statement_framework_requirements` stay (future architecture) but no longer open a generic path.
4. **Applicable disclosures (pack 1.2.0)** — new requirements, each versioned in `fs_pack_requirements` and mirrored
   in the TypeScript pack: going-concern assessment (3.8/3.9, always), date of authorisation for issue (32.9,
   always), key management personnel compensation (33.7, always), components of cash and cash equivalents (7.20,
   always), income tax components (29.39, decided by the data: applies when the composed tax line is non-zero),
   revenue (23.30, decided by the data: applies when the composed revenue line is non-zero), events after the
   reporting period (32.10–32.11, recorded decision), parent/ultimate controlling party (33.5, recorded decision),
   related-party transactions (33.9, recorded decision). An unmet applicable requirement blocks FINAL by name
   (`REQUIRED_DISCLOSURE_MISSING:*`, `REQUIREMENT_UNDECIDED:*`). Data-decided requirements cannot be decided by hand
   (`not_decidable`). Citation verification status: see §9 (QUESTION for BLACK).
5. **Sign-off / separation of duties** — unchanged: REVIEWED needs `review_close`, FINAL needs
   `approve_certification` (20260925140000); FINAL by the reviewer is refused unless the recorded `solo_owner`
   policy is in force and the approver is the owner (20261024100000). No three-person rule; no new exception.
   Legacy `statement_sign_offs` is not the FS path and is untouched.
6. **Edition binding** — the saved document's `framework.version` must equal the server-resolved pack id
   (`FRAMEWORK_EDITION_MISMATCH` / `FRAMEWORK_EDITION_UNRECORDED`).
7. **Evidence binding** — every evidence batch the server used for a figure must be among the version's
   `evidence_batch_ids` (`EVIDENCE_NOT_BOUND`); a superseded batch is already `EVIDENCE_SUPERSEDED`; two usable
   series of one family/role is `EVIDENCE_SERIES_AMBIGUOUS`; a batch in another currency or scale is
   `EVIDENCE_DENOMINATION_MISMATCH`.
8. **Roll-forward** — implemented in this candidate: `fs_prior_final_reconciliation` compares every comparative line
   AS REPORTED (the prior year's current authority) with the figure the prior year's latest issued FINAL version carries
   for that line; any difference (a prior-year adjustment approved after issue, a changed mapping, a line issued but no
   longer presented) is preserved and named `COMPARATIVE_NOT_AS_ISSUED:<factId>:<difference>` and blocks the new period;
   governed resolutions are a restatement of the comparative or a new issued prior-year version. A company with no issued
   prior year has nothing to reconcile to (`no_prior_final`). Together with the SOCIE/SCF opening-to-prior-closing ties
   this is the "reconcile, never silently carry" rule of design doc 11 §B.4. **Not built:** the carry-forward of
   presentation assignments, policy wording and applicability decisions into the new period with a "carried — re-confirm"
   marker, and the roll-forward worklist UI. Those remain part of the full reporting journey (§9).
9. **Edition** — the 2015 edition is the supported edition; the third edition is refused by name (decision taken
   2026-10-18 after the owner's instruction not to present older requirement texts as verified 2025 support).

## 5. Implementation status (2026-10-18)

| Item | Status |
|---|---|
| Migration `20261111100000_fs_publication_controls.sql` | written; applied in every proof below (EXECUTED-LOCAL on embedded PostgreSQL 16, full chain replay) |
| TS pack 1.2.0 (`ifrsForSmes.ts`), coverage matrix + regenerated `docs/reporting/COVERAGE_IFRS_FOR_SMES.md`, `blockers.ts` texts, `notesStatus.ts` contract /2 or /3 | done; focused vitest (frameworkPacks, notes, reporting, financialGeneration, statements) green; `tsc --noEmit` clean |
| Proof `scripts/db-proof/publicationControls.mjs` (cases A–L) | 37/37 PASS with the control; 23/36 FAIL without it (`PUBLICATION_CONTROLS_ABSENT=1`) — the regression evidence |
| Existing proofs adapted to pack 1.2.0 and the supported-path refusal | `reportingKit.prepareReporting` records 1.2.0 by default; `signoffBinding.mjs` rebuilt on real evidence; `notesSchedules`, `readinessReadOnly`, `signoffPolicy`, `closeReviewAuthority`, acceptance-r1 fixtures extended — results in §7 |
| Release packaging | `docs/release/fs-controls-r1/{preflight,postcondition}.sql` written; CI step for the proof added; wrapper batch registration follows the final commit (§8) |
| Browser journey | not exercised (no Supabase stack reachable from this environment); no UI change was needed for the controls — the workbench already renders every blocker by name (`blockers.ts`) |

## 6. Acceptance matrix (updated with executed evidence in §7)

| Case | Mechanism | Evidence |
|---|---|---|
| A tamper SCF figure → FINAL refuses | `STATEMENT_FIGURE_MISMATCH` on `fact:line:cf:closing:CURRENT` | §7 |
| B tamper SOCIE figure → FINAL refuses | `STATEMENT_FIGURE_MISMATCH` on `fact:line:eq:total-closing:CURRENT` | §7 |
| C replace SCF/SOCIE evidence after REVIEWED | `EVIDENCE_SUPERSEDED`, `REPORTING_DEPENDENCIES_STALE`; FINAL refused; trigger `BINDING_STALE` | §7 |
| D unsupported framework/provenance | `PUBLICATION_PATH_UNSUPPORTED` for IFRS, IPSAS_ACCRUAL, IPSAS_CASH, DOCUMENT_REVIEWED; trigger refuses direct insert | §7 |
| E omit applicable disclosure | `REQUIRED_DISCLOSURE_MISSING:smes.note.going_concern` …; FINAL refused | §7 |
| F unauthorised / same-person approval | preparer `FORBIDDEN`; reviewer's own FINAL `SIGNOFF_SEPARATE_APPROVERS_REQUIRED` | §7 |
| G dependency change | stale approval; old binding never authorises the changed report | §7 |
| H happy path | figures reconcile to hand-computed values; REVIEWED → FINAL; bindings carry document and dependencies hashes | §7 |
| I issued history unchanged | FINAL document hash and bindings unchanged after later versions; bindings immutable | §7 |
| J roll forward | opening = prior closing checks (SCF, SOCIE) and the comparative-as-issued reconciliation to the prior FINAL (J2: a prior-year adjustment approved after issue is preserved and named for exactly the two lines it moved); decision carry-forward NOT built | §7 |
| K tenant isolation | company-B owner refused on every RPC and read for company A | §7 |
| L adjustments affect every dependent statement consistently | L2: an approved adjustment after REVIEWED makes the version stale; the next version carries the recomposed SFP/SCI (profit 5,095.00, payables 3,105.00); the equity statement is refused (`SOCIE_PROFIT_TIE`, `SOCIE_CLOSING_EQUITY_TIE`) until its evidence agrees; then it signs | §7 |
| ED unsupported edition | an early-application election resolves the period to the third edition: `FRAMEWORK_EDITION_UNSUPPORTED`; REVIEWED refused; trigger refuses a direct insert; withdrawing the election restores the 2015 edition | §7 |
| Browser journey | `scripts/browser-acceptance/reportingJourney.mjs` (headless Chrome over the loopback bridge to a disposable database): happy path through statements, notes, schedules, comparatives approval, evidence intake, save, REVIEWED, FINAL, export and PDF; missing-evidence recovery; changed-input recovery; viewer and other-workspace refusals | §7 |

## 7. Execution log

All runs: embedded PostgreSQL 16, the whole migration chain replayed from zero, synthetic data only
(`reportingKit.mjs` trial balances and evidence; nothing client-derived). Label: EXECUTED-LOCAL unless stated.

| Run | Result | What it establishes |
|---|---|---|
| `publicationControls.mjs` (control present) | **37/37 PASS** | cases A, B, C, D, E, F, G, H, I, J, K and L as listed in §6; hand-computed figures: SCF closing 12,500.00 / 8,000.00, net movement 4,500.00 / 3,000.00, operating 6,200.00, financing −1,700.00; SOCIE closing 21,000.00 / 16,600.00, result 5,100.00 / 3,100.00; ledger movement of account 1000 = trial-balance movement = 4,500.00 |
| `publicationControls.mjs` with `PUBLICATION_CONTROLS_ABSENT=1` (chain before the migration) | **FAILED as required: 23 of 36 assertions** — every case in E, H (figure binding), A, B, D, K (new RPC), C (dependency staleness), J and L; F, G, I pass because they rest on pre-existing controls | the regression that each new control prevents; without it a tampered SCF/SOCIE figure, an IPSAS or document-reviewed path and a missing applicable disclosure are NOT refused |
| `closeReviewAuthority.mjs` | **99/99 PASS** | Close Review blockers still isolated on a generic document; that document is now refused by name instead of signed |
| `signoffBinding.mjs` (rebuilt on real evidence through the browser's builder) | **19/19 PASS** | SFP/SCI figure, account, extra-line, unbound and stale refusals; REVIEWED → FINAL with bindings; stale after a change; trigger defence |
| `notesSchedules.mjs` | **40/40 PASS** | pack 1.2.0 vocabulary pinned to the TypeScript pack (50 rows at 1.1.0, 9 at 1.2.0); the nine new statuses and blockers in order; data-decided requirements not decidable by hand |
| `reportingClosure.mjs` | **19/19 PASS** | comprehensive-income decisions; two-step save; approver recording — unchanged behaviour on the new chain |
| `readinessReadOnly.mjs` | **20/20 PASS** | readiness readable through the API; stale after a change |
| `reportingWorkbench.mjs` | **22/22 PASS** | the browser's own workbench flow on the new chain |
| `acceptanceFixtures.mjs` | **17/17 PASS** | the acceptance-r1 fixtures (decisions and wording extended with the 1.2.0 rows) |
| `cashPerimeterScope.mjs` | **12/12 PASS** | per-period cash scope (DEFECT D-3) |
| `statementComposition.mjs`, `comparatives.mjs` | **37/37, 28/28 PASS** | composition and comparatives unchanged |
| `run.mjs` (persistence proof; its chain stops before 20261017 by design, unchanged file) | **279/279 PASS** | |
| `signoffPolicy.mjs` | **24/24 PASS** | the statement sign-off policy on the new chain (its own setup extended with the 1.2.0 wording) |
| `bunx tsc --noEmit -p tsconfig.app.json` | clean | |
| `bun run lint` | 0 errors, 153 warnings (the pre-existing baseline) | |
| `node scripts/audit_migrations.mjs --strict` | VERDICT: CLEAN (last: `20261111100000_fs_publication_controls.sql`) | |
| `node scripts/ci/assertSingleLockfile.mjs` | OK | |
| focused vitest (`src/lib/frameworkPacks src/lib/notes src/lib/reporting src/lib/financialGeneration src/lib/statements`) | 163 passed; one 5 s timeout in `activation.test.ts` while two database proofs ran concurrently (worker RPC timeout, not an assertion) — see the full-suite run below | |
| `bun run build` + `node scripts/ci/assertPackIsolation.mjs dist` | built in 1m 42s; PACK_ISOLATION: OK | |
| `node scripts/ci/assertMigrationAuthority.mjs` | OK; `PENDING_HOSTED_APPLY: 20261111100000_fs_publication_controls.sql` (expected: authored, not applied) | |
| `RELEASE_BATCH=fs-controls-r1 node scripts/db-proof/selfCheckingWrappers.mjs` | **32/32 PASS** — refusals before any statement, injected failures rolled back, hosted-executor model, re-application refused, postcondition, drizzle-orm migrate() | |
| `releaseJournal.test.ts` + `selfCheckingWrappers.test.ts` | 160/160 PASS (the source registered as PENDING hosted application) | |
| control-byte scan of every changed file | clean | |
| full `bun run test` (first run, concurrent with two database proofs) | 25 failures: vitest worker RPC timeouts and 5 s test timeouts under load, plus two deterministic ones — `serviceEnquiryMigrationContract.test.ts` and `activationReadinessMigration.test.ts` pin the exact migration list and needed the new file added (done) | |
| full `bun run test`, generous per-test timeout, before the main merges (`bunx vitest run --testTimeout=120000`) | 5899 passed, 5 failed: 4 × the inertness guard's "base is not an ancestor" (main had moved under the branch — resolved by merging main) and the envelope-guard test, which collects nothing while merge conflict markers are in the tree; every migration-list pin (`persistenceMigrationContract`, `billingTriggerRepairMigration`, `migrationAuthority`, `migrationReplayCompatibilityGuard`, `omega3CheckoutIntervalAuthority`, the two service-enquiry hygiene tests, `databaseInert`) now carries the new file | |
| guards after the merge (`databaseInert`, `inertBase`, `atomicEnvelope`, `migrationAuthority`) | 90/90 PASS | |
| full `bun run test` on the final merged head (`--testTimeout=600000`) | **5907 passed, 2 failed** — `atomicEnvelope.test.ts` (its own 120 s limit) and `migrationAuthority.test.ts` "0023 … any mutation fails closed" (its own 60 s limit): both copy the whole repository per fixture and exceed their hard-coded timeouts only under full-suite load on this Windows machine; both pass in isolation (90/90 with the other guards). No assertion failure anywhere. Release Gate on clean Linux CI is the authoritative run | EXECUTED-LOCAL |
| `RELEASE_BATCH=fs-controls-r1 selfCheckingWrappers.mjs` on the merged tree | **32/32 PASS** | |

### 7.1 Second pass (2026-10-18, after the owner's instruction: edition, adjustment-to-sign-off, roll-forward, browser)

| Run | Result | What it establishes |
|---|---|---|
| `publicationControls.mjs` (extended: ED, L2, J2) | **45/45 PASS** | ED: an early-application election resolves the period to `ifrs-for-smes/2025`; the new version is `FRAMEWORK_EDITION_UNSUPPORTED:ifrs-for-smes/2025`, REVIEWED refused, a direct publication refused by the trigger; withdrawing the election restores 2015. L2: after REVIEWED, a balanced rent-to-payables adjustment (5.00) is proposed and approved; the reviewed version is `REPORTING_INPUT_STALE` + `REPORTING_DEPENDENCIES_STALE` and FINAL is refused; the next version carries the recomposed figures (profit 5,095.00, payables 3,105.00, account 6100 2,405.00) and is refused `SOCIE_PROFIT_TIE:CURRENT:500` / `SOCIE_CLOSING_EQUITY_TIE:CURRENT:500` until re-supplied equity movements agree; then total equity 20,995.00 ties, ready, REVIEWED, FINAL. J2: a second adjustment (2.00) approved after that issue leaves the issued version unchanged; FY2027 certified; `fs_prior_final_reconciliation` names the latest issued FY2026 version and exactly the two moved lines (`COMPARATIVE_NOT_AS_ISSUED:…sfp.trade_and_other_payables:200`, `…sci.operating_expenses_by_function:200`); FY2026 itself has `no_prior_final` |
| `scripts/browser-acceptance/reportingJourney.mjs` (headless Chrome 1280×900, real pages over the loopback bridge, three simulated people) | **20/20 PASS** — evidence in `browser-evidence/` (11 screenshots, draft and sealed packs as PDF, the Exports page print, `results.json`) | statements with composed figures and keyboard lineage; notes recorded through the form; schedule reconciled; preparer cannot approve or sign; reviewer approves comparatives with a reason; **missing-evidence recovery** (the next action asks for the cash-flow and equity evidence; six files validated in the browser, stored as versions 1 and 2, no blocker); REVIEWED then FINAL; sealed pack with approver and binding hashes printed to PDF; draft watermark; **changed-input recovery** (the signed version stays FINAL, the next action asks for a new version and names the stale dependency); viewer read-only; other workspace refused; every request on loopback |
| journey step 7 (reviewer returns comments to the figure) | NOT exercised — the product has no persisted reviewer-comment store (design doc 11 §B.3c); listed in §9 |
| `publicationControls.mjs` with `PUBLICATION_CONTROLS_ABSENT=1` (extended proof; the chain stops before the migration) | **FAILS as required: 28 of 44 checks fail** | regression evidence: every control this migration introduces (figure binding of SCF/SOCIE, evidence binding, pack 1.2.0 statuses, `PUBLICATION_PATH_UNSUPPORTED`, the SCF/SOCIE ties, `FRAMEWORK_EDITION_UNSUPPORTED`, the prior-FINAL reconciliation) is absent without it; the 16 that still pass are behaviour the slice leaves unchanged (sign-off roles, tenant isolation, staleness of the stored document) |
| dependent reporting proofs on the changed chain | **all PASS** — signoffBinding 19/19, closeReviewAuthority 99/99, notesSchedules 40/40, reportingClosure 19/19, readinessReadOnly 20/20, reportingWorkbench 22/22, acceptanceFixtures 17/17, cashPerimeterScope 12/12, statementComposition 37/37, comparatives 28/28, signoffPolicy 24/24, `run.mjs` 279/279 | no earlier reporting behaviour regressed; the generic full-IFRS documents those proofs build are now refused by name (`PUBLICATION_PATH_UNSUPPORTED`) where they used to sign |
| full unit suite on the merged tree (`a5de686`, after #177) | **5908 passed, 2 failed, 10 skipped, 12 todo** — the two failures are `migrationAuthority.test.ts` "parity: loses its corrective statement" (5 s hard-coded timeout) and `atomicEnvelope.test.ts` "refuses every malicious fixture" (120 s hard-coded timeout); both pass when their files run alone (19 files, 1 failed = the pre-merge inertness base, resolved by the merge commit) | load timeouts of guard tests that spawn the migration-authority guard per fixture, not behaviour; CI runs them with its own budget |
| CI on `a2598c2` (CI-PROVEN): "Real application end to end" (local Supabase stack, production build, headless Chrome) | **FAILED at the evidence save** — the page's failure capture (`FAIL-Statements-six-evidence-files….txt` in the `real-app-evidence` artifact) reads "Not finished: DELETE requires a WHERE clause" | a genuine defect of the first candidate that no EXECUTED-LOCAL proof could see: Supabase's API sessions (PostgREST's `authenticator` role) load the `safeupdate` guard, which refuses a DELETE or UPDATE without a WHERE clause even inside a SECURITY DEFINER function; `fs_evidence_statements` reset its temp tables with bare `DELETE FROM pg_temp.fs_ev_*;` (11 statements). The embedded-PostgreSQL proofs and the loopback browser journey talk to PostgreSQL directly and never load that guard. **Fixed:** every one now reads `DELETE FROM … WHERE true;`; the proof gained a static contract refusing any bare DELETE/UPDATE in the migration; the journey's own sequence (non-calendar periods, distinct codes, the reclassification, pack 1.2.0 notes) was replayed on the embedded database through the browser's save code — saved and ready — so the only difference was the API-session guard. The two later journey failures (REVIEWED, FINAL, the layout re-check's `Version null`) cascade from the unsaved version |
| CI on `a2598c2` (CI-PROVEN): "Disposable-DB Contract Tests" | **FAILED in `serviceWithholding.mjs`'s static contract** — its pinned list of reviewed later migrations ended at `20261110100000`; the publication-controls migration was not named | fixed by naming it (that proof's LATER list); re-run locally 119/119 |
| every other CI job on `a2598c2` | PASS — Release Gate (frozen install, full suite), Lint/Build/Typecheck, Golden Fixtures, Migration Audit, Edge-function checks, Conflict-marker check | |
| wrapper batch `fs-controls-r1` re-registered from `453aeca9…`'s committed bytes | **32/32 PASS** (`scripts/db-proof/selfCheckingWrappers.mjs`, fs-controls-r1 branch); `selfCheckingWrapper.mjs --check` clean; `assertMigrationAuthority.mjs` OK (60 drizzle entries mirrored, `PENDING_HOSTED_APPLY: 20261111100000`) | wrapper 88,769 B SHA-256 `06e2dbb2…` enclosing the 87,201 B source `42edba2b…`; the apply-and-register, refusal-before-any-statement, rollback and postcondition behaviour holds for the repackaged bytes |
| CI on PR #176 | the first push failed only `databaseInert.test.ts` (the new migration and proof were not yet registered as reviewed) and then went CONFLICTING when #175 merged; both addressed by the merge commit `e408f04`. On `a2598c2` (after #177) seven jobs passed and two failed: the real-stack journey (the safeupdate DELETE defect, fixed) and the service-withholding static contract (list extended) — see §7.1. CI on the final head: see the PR | CI-PROVEN on `a2598c2`; the fixed head's run is the authority |

Decision taken during execution: `run.mjs` replays the chain only up to the sign-off completion requirements
(20261017100000) by design, so the control is not present there and the file is unchanged.

## 8. Migration and deployment requirements

- Apply order: after `20261110100000` (pricing-p1, merged to main as #175, applied hosted on 2026-10-18 as drizzle entry 0062 / hosted id 63 — `dd2a29c`, closed out by #177 `50282a3`, mirrored in `RELEASE_JOURNAL`); no object overlap. `20261111100000` is the only batch still PENDING hosted application.
- Hosted apply only through the self-checking wrapper of the committed bytes, by the owner, with
  `docs/release/fs-controls-r1/preflight.sql` before and `postcondition.sql` after. **Not authorised by this kickoff.**
- Batch `fs-controls-r1` registered in `scripts/release/selfCheckingWrapper.mjs` at the implementation commit
  `453aeca96465ec666b9148fa90b8bdf78281e86b`: source 87,201 B SHA-256 `42edba2b…`, wrapper
  `release/wrappers/20261111100000_fs_publication_controls.wrapper.sql` 88,769 B SHA-256 `06e2dbb2…`; all four submission
  forms in `scripts/ci/releaseJournal.mjs`; `selfCheckingWrapper.mjs --check` clean; the migration-authority guard lists
  the source as `PENDING_HOSTED_APPLY` (expected until the owner applies it; the drizzle journal entry is written by the
  apply tool, never here).
- No Edge Function changes. No feature-gate change: `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` and the company
  rollout allow-list are untouched.

## 9. Classification and remaining kickoff requirements

**Classification: control-repair candidate with the first reporting slice's server controls complete; the full
reporting journey is unfinished.** Every kickoff requirement is listed below with its status, so nothing is hidden.

| Kickoff requirement | Status |
|---|---|
| Authoritative figures across every supported statement (SFP, SCI, SOCIE, SCF) | DONE — server recomposition and binding; A, B, H, L, L2 executed |
| Dependency binding and stale approval (inputs, mappings, adjustments, evidence, allocations, framework/edition/rules, statements, disclosures) | DONE — C, G, L2 executed; edition bound |
| Fail closed for unsupported paths | DONE — D executed (blockers and trigger) |
| Authorised sign-off and separation of duties | UNCHANGED and re-proven — F |
| Applicable disclosures, versioned, with recorded applicability | DONE for the 2015 edition (pack 1.2.0) — E; the third edition is not verified and is refused |
| Cash flows and equity: indirect method | ASSESSED, not implemented — the direct method is the supported route (§2) |
| Comparatives: signed prior-year cash-flow comparatives, prior-closing reconciliation | DONE — J, J2 |
| Roll-forward: compatible treatment reused, period evidence refreshed | PARTIAL — opening/comparative reconciliation done (J2); carry-forward of decisions/wording with re-confirmation and the worklist UI NOT built |
| Customer journey steps 1–10 | PARTIAL — steps 1–6 and 9 exercised in the browser journey (happy path, missing evidence, changed input); step 7 "return reviewer comments to the affected figure" has no persisted reviewer-comment store in the product (design doc 11 §B.3c) and is NOT built; step 8 re-review of changed content is the stale-version path; step 10 roll-forward partial |
| Rendering, exports, reproduction | UNCHANGED from the reporting release (sealed pack, PDF, lineage-tagged exports; the browser journey prints the sealed pack); byte-identical independently generated formats not promised |
| AI and server exposure | no model call anywhere in this slice; the `policy-compass` / MAONO findings of doc 12 untouched (separate track) |
| Privacy cleanup (#171) | separate track; synthetic data only here |
| Hosted application, activation, merge | NOT authorised; nothing applied |

## 9a. Open blockers / questions for the owner and BLACK

- **RESOLVED (edition):** the 1.2.0 citations are verified against the pinned 2015 text (SHA-256 `acc6500e…`): 3.8,
  3.9, 7.20, 23.30, 29.39, 32.9, 32.10, 32.11, 33.5, 33.7, 33.9 all read as cited (PRIMARY_TEXT). The third edition's
  text was reachable only through Section 7, so the third edition is **not** a supported edition of this slice: a report
  composed under it is refused by name. Supporting the third edition is a later item that needs its Sections 23, 29,
  32 and 33 verified (including 33.7A).
- **OPEN (owner):** the decision carry-forward and the roll-forward worklist UI; the persisted reviewer-comment store
  for journey step 7.
- **NON-BLOCKING (design):** the refusal `PUBLICATION_PATH_UNSUPPORTED` is appended to the blocker list rather than
  returned early, so a generic document still sees every other gap; it can never be signed either way (the trigger
  refuses too). Confirm this presentation choice.
- **NOTE:** the browser journey runs the real workbench pages against a disposable PostgreSQL through a loopback bridge
  with a simulated identity header (not GoTrue); hosted/staging browser acceptance remains a separate owner-run step.
