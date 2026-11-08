# Returning-client integration (draft; nothing applied, merged or deployed)

**Stack.** `origin/main` f366367 ← **#255** (Ready for Reporting pilot, `d688387`) ← **#256** (first-period governed review, `5ea96b2`) ← this branch
(`feat/returning-client-integration`). #255 and #256 are unchanged. Review `git diff fix/first-period-comparatives-signoff...` to isolate this change.

## What the journey exposed, and the smallest fix for each

| # | Found by running the journey | Fix here |
|---|---|---|
| 1 | An opening difference classified *unposted audit adjustment* was treated as merely **explained**: the scope went READY and FINAL was not held although the opening position lacked the approved adjustment. | `engine.ts`: it is a **confirmed** finding (`OPENING_ADJUSTMENT_UNPOSTED`) resolved only by an effective correction or a verified ledger fix. An unresolved required difference holds REVIEWED and FINAL. One finding, one next action (`present.ts`). |
| 2 | The same economic item booked in QuickBooks **another way** (as current-year expense) and not linked to the correction was silently ignored. | `engine.ts`: for an *opening* correction an unlinked, non-cash journal that repeats its amount on a moved account is `candidate_needs_confirmation` (the scope stays open). A **linked** journal plus an approved residual treatment is `completed_by_residual`. Other scopes keep the exact-effect rule (acceptance case E2-L5 still passes). |
| 3 | Statements **issued outside CFOClose** could be restated, but nothing tied the restatement to what was issued (its anchor was a free-text reference). | Migration `20261218100000_issued_comparative_schedules.sql` (authored, not applied): a hash-addressed issued-comparative record (document hash, structured schedule, per-line adjustment evidence), a restatement **derived** from it and handed to the existing two-person workflow, a reconciliation, and a sign-off blocker `COMPARATIVE_NOT_AS_ISSUED_EXTERNAL`. |

## Proof (`scripts/db-proof/returningClientJourney.mjs`, 30 assertions, embedded PostgreSQL 18.4)

Real server path only: the real trial-balance engine certifies each year **once**; Close Review proposes and a different person approves; the prior pack goes REVIEWED → FINAL
in CFOClose; Check my books runs the real engine over the stored inputs; the report is prepared by the browser's own builder code, compiled by the server compiler, and signed off by
`fs_set_publication_state`. Synthetic prior-year accrual **100.00** (Dr 6100 / Cr 2000), no settlement.

| Figure (minor units, exponent 2) | Value |
|---|---|
| FY2025 pack as issued: payable / expense line / profit | 320,000 / 1,000,000 / 500,000 |
| FY2026 **comparative** (preview and FINAL): payable / expense line / profit | 320,000 / 1,000,000 / 500,000 (as reported by the ledger: 310,000 / 990,000 / 510,000) |
| FY2026 **before** the correction: payable / profit | 310,000 / 510,000 |
| FY2026 **after**: payable / 3100 opening equity (credit) / 6100 / profit | 320,000 / 1,090,000 / 240,000 / **510,000 (unchanged)** |
| FY2026 equity: opening / profit / closing | 2,090,000 / 510,000 / 2,600,000 (comparative 1,660,000 / 500,000 / 2,090,000) |

Source **A** (prior pack FINAL in CFOClose): FINAL reached; both bindings carry the preview's dependencies identity and the approved comparative status; the issued pack (its FINAL
publication and document hash), the opening bridge (hash-addressed input) and the correction (one adjustment) are separate records; the FINAL manifest binds the readiness run and review.
Source **B** (issued elsewhere): the issued record, the derived restatement (`issued:<id>`), the bridge (citing the issued id) and the correction are four separate records; the comparative
equals the issued schedule line by line with the figures as reported kept beside; **FINAL is not reached** — see gap 1.

QuickBooks later carrying the journal as current-year expense: **linked** + approved residual → payable 320,000, 6100 = 240,000 (zero current-year expense from the item), opening equity reduced by
100.00, one effective correction, engine agrees, scope READY. **Unlinked** same-amount journal → `candidate_needs_confirmation`, scope held.
Boundary: one finding / one next action; independent checks stay READY; drafting continues; an unresolved difference blocks REVIEWED and FINAL; a ledger re-dating that changes no account total
changes the content digest, the review goes stale (`RFR_REVIEW_STALE`) and FINAL is refused until the reviewed content is current; repeated imports, retried proposals and retried approvals apply nothing twice.

## Separate from this work — what #256 proves and what the compiler still prevents

* #256 proves, at the **comparatives blocker**, that the first-period exception is a verified, bound decision (old-certificate bypass closed; legitimate pre-bookkeeping activity reconciled; dormancy
  and contradictory evidence handled; openings independent). It does **not** make a first-period IFRS-for-SMEs report signable.
* The statement-evidence engine builds the cash-flow roll-forward and the equity statement from comparative balances (`CASHFLOW_ROLLFORWARD_BALANCE_MISSING`, `STATEMENT_EVIDENCE_MISSING:smes.set.scf/socie`).
  No first-period path exists. Changing it edits financial calculations **and** the pinned compiler closure (`statementCompiler.generated.mjs`, whose digest is recorded in migration `20261123100000`).
  **Tracked as its own task; not changed here.** Before any change, verify the applicable framework basis against the current IFRS for SMEs text (comparative information, statement of cash flows,
  statement of changes in equity; the edition the period resolves to) — none of it is quoted or relied on here.

## Open gaps (stated, not hidden)

1. **DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001 (new, found by source B).** Any restated comparative stops at the statement compiler: the restatement line exists in the comparative column only, so the
   canonical `subtotal-casting` rule reports `INSUFFICIENT_EVIDENCE` on exactly the restated lines (`BLOCKING_FINDINGS:2`, `RECONCILIATION_UNMET:2`, `SERVER_COMPILATION_FINDINGS`). Pre-existing; the proof
   asserts the exact stop. The rule lives in the compiler closure, so a fix is a coordinated release (rule + regenerated bundle + digest re-pin), not a side effect of this PR.
2. **DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001 (registered earlier, PR #215).** An account that exists in one period only blocks sign-off, so the accrual is booked on two existing two-period
   accounts (6100 Professional fees, 2000 Trade payables). A dedicated accrual account cannot be used until that is fixed. A line that exists in one period only also needs the registered explicit-nil row
   (the FY2026 evidence carries nil loan-repayment and dividend rows).
3. **Browser journey: not run end to end.** See the PR description. The existing harnesses cannot put Trial Balance Review, Check my books and the report preview on one disposable backend:
   Trial Balance Review runs on an in-memory synthetic backend, the reporting pages on the PostgreSQL bridge.
4. **QuickBooks sandbox: NOT_RUN.** No authenticated sandbox company or recorded run exists (the connector is off); the QuickBooks cases use constructed ledger exports with the journal link in the posting.
5. **External document intake.** The issued document is bound by its SHA-256 and the adjustment evidence by reference and hash; **no file upload, storage or reading of the issued PDF exists**, so a reviewer
   still agrees the schedule to the document by eye (the approval is recorded). The approved prior-year figure for source A is still supplied to Check my books by the importer/settings (the bridge input);
   deriving it automatically from the prior FINAL's adjusted trial balance is not built.
6. PostgreSQL 18 locally, `postgres:16` in CI. No hosted run.
