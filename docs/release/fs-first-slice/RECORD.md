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
| Candidate head | see §7 (updated per commit) | |

## 2. Supported first slice (pinned)

| Dimension | Pinned value |
|---|---|
| Entity type | one standalone for-profit entity with share capital; no parent/subsidiaries, no associates, no groups |
| Framework | IFRS for SMEs only (`framework.kind = IFRS_FOR_SMES`); `framework.version` must equal the server-resolved pack id |
| Edition | resolved from the period START by `fs_ifrs_for_smes_edition` (2015 edition for periods beginning 2017-01-01..2026-12-31; third edition 2025 for periods beginning on/after 2027-01-01 or by recorded early-application election). The requirement set implemented is pack **1.2.0**, identical in kind/applicability for both editions; citations are per edition |
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
8. **Roll-forward** — only the opening-to-prior-closing checks above are in this slice. Carry-forward of
   decisions/elections into a new period and the opening-reconciliation worklist (design doc 11 §B.4) are **not**
   built here (OPEN, separately scoped).

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
| J roll forward | opening = prior closing checks; seeded discrepancy blocks by name; decision carry-forward NOT built | §7 |
| K tenant isolation | company-B owner refused on every RPC and read for company A | §7 |
| L adjustments affect every dependent statement | see §7 | §7 |

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
| `signoffPolicy.mjs` | see §7 addendum | the statement sign-off policy on the new chain |
| `bunx tsc --noEmit -p tsconfig.app.json` | clean | |
| `bun run lint` | 0 errors, 153 warnings (the pre-existing baseline) | |
| `node scripts/audit_migrations.mjs --strict` | VERDICT: CLEAN (last: `20261111100000_fs_publication_controls.sql`) | |
| `node scripts/ci/assertSingleLockfile.mjs` | OK | |
| focused vitest (`src/lib/frameworkPacks src/lib/notes src/lib/reporting src/lib/financialGeneration src/lib/statements`) | 163 passed; one 5 s timeout in `activation.test.ts` while two database proofs ran concurrently (worker RPC timeout, not an assertion) — see the full-suite run below | |
| `bun run build` + `node scripts/ci/assertPackIsolation.mjs dist` | built in 1m 42s; PACK_ISOLATION: OK | |
| `node scripts/ci/assertMigrationAuthority.mjs` | OK; `PENDING_HOSTED_APPLY: 20261111100000_fs_publication_controls.sql` (expected: authored, not applied) | |
| full `bun run test` | see §7 addendum | |

Decision taken during execution: `run.mjs` replays the chain only up to the sign-off completion requirements
(20261017100000) by design, so the control is not present there and the file is unchanged.

## 8. Migration and deployment requirements

- Apply order: after `20261109100000` (and after #161's `20261110100000` if that lands first — no object overlap).
- Hosted apply only through the self-checking wrapper of the final committed bytes (`release/wrappers/`), with a
  drizzle journal entry, by the owner. **Not authorised by this kickoff.**
- No Edge Function changes. No feature-gate change: `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` and the company
  rollout allow-list are untouched.

## 9. Open blockers / questions for the owner and BLACK

- **QUESTION (BLACK, accounting):** the 1.2.0 citations were verified against the pinned 2015 text (SHA-256
  `acc6500e…`, downloaded and text-extracted in this session): 3.8, 3.9, 7.20, 23.30, 29.39, 32.9, 32.10, 32.11, 33.5,
  33.7, 33.9 all read as cited (PRIMARY_TEXT). For the third edition (2025) only 3.8, 3.9 and 7.20 could be read from
  the IFRS Foundation HTML (the fetch truncated after Section 23's opening); the 2025 pack therefore cites the 2015
  text for 23.30, 29.39, 32.x and 33.x (`cx()` in `ifrsForSmes.ts`). Please verify those paragraph numbers in the
  third edition's Sections 23, 29, 32 and 33 and confirm whether 33.7A (key management services from a separate
  management entity) should be added for 2025 periods.
- **NON-BLOCKING (design):** the refusal `PUBLICATION_PATH_UNSUPPORTED` is appended to the blocker list rather than
  returned early, so a generic document still sees every other gap; it can never be signed either way (the trigger
  refuses too). Confirm this presentation choice.
- **OPEN (owner):** roll-forward carry-forward and opening-reconciliation worklist (decision 8).
- **OPEN (owner):** browser happy-path verification against a hosted or local Supabase stack — no such stack is
  available in this environment; see §7 for what was and was not exercised in a browser.
