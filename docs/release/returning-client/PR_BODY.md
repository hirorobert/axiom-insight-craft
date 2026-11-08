**Draft. Base: #256 (`fix/first-period-comparatives-signoff`, `5ea96b2`) ← #255 (`d688387`) ← main `f366367`.** #255 and #256 are untouched and keep their scopes. 3 commits here: `8a8a1b0`, `7f257f3`, `6cfa380` (tested head). Authored only: nothing applied, merged, deployed or published; no production migration.

## What this adds
- **Engine** (`readiness/engine.ts`, `present.ts`): an opening difference classified *unposted audit adjustment* is a **confirmed** finding that holds the scope (and so REVIEWED/FINAL) until its correction applies or the ledger carries a verified fix; an unlinked non-cash journal that repeats an opening correction's amount is a candidate that stays open. The page now offers "Propose for review" for it (found by the browser run).
- **Migration `20261218100000_issued_comparative_schedules.sql`** (authored, not applied): statements issued outside CFOClose become a hash-bound comparative source (document hash, structured schedule, per-line adjustment evidence) → a derived restatement for the existing two-person workflow → reconciliation → blocker `COMPARATIVE_NOT_AS_ISSUED_EXTERNAL`. `fs_publication_blockers` spliced from the live text, not copied.
- **Proofs:** `returningClientJourney.mjs` (30), `scripts/browser-acceptance/returningClientJourney.mjs` (13), bridge `serveReturning.mjs`, harness `dev-harness/returning`, unit tests, CI steps. Details and figures: `docs/release/returning-client/README.md`.

## Exact figures (synthetic prior-year accrual 100.00, Dr 6100 / Cr 2000, no settlement; minor units)
| | comparative (FY2025, preview = FINAL) | FY2026 before | FY2026 after |
|---|---|---|---|
| payable 2000 | 320,000 | 310,000 | **320,000** |
| expense line (6100 = 250,000 / 240,000) | 1,000,000 | – | 6100 = 240,000 |
| opening equity 3100 (credit) | – | 1,100,000 | **1,090,000** |
| profit | 500,000 | 510,000 | **510,000 (unchanged)** |
| equity opening / profit / closing | 1,660,000 / 500,000 / 2,090,000 | – | 2,090,000 / 510,000 / 2,600,000 |

## Results
- **Browser (headless Chrome, 13/13, source A):** one engagement, FY2026 has one upload; one finding, TZS 100.00, one next action; proposer not offered Approve; partner approves; every check ready; second press changes nothing; comparative approved; saved, REVIEWED, FINAL; one dependencies identity + one comparative status across bindings; loopback only.
- **Database (embedded PostgreSQL 18.4, 30/30):** A (prior pack FINAL in CFOClose); QuickBooks later booking the journal as current-year expense — **linked + approved residual** → payable 320,000, 6100 = 240,000, opening equity −100.00, one effective correction; **unlinked** same-amount journal stays open; unresolved difference blocks REVIEWED/FINAL; a ledger re-dating that changes no total → `RFR_REVIEW_STALE`; repeated imports / proposals / approvals apply nothing twice. Source B up to the gap below.
- Also green on this stack: first-period 54, readiness 28, publicationControls 71, trackA 29, comparatives 28, closeReview 100; acceptance runner 71/71, audit regression 17/17; readiness unit tests 134. tsc clean.

## Gaps (stated, not hidden)
1. **Source B stops at the compiler:** any restated comparative fails the `subtotal-casting` rule (restatement line exists in one column) — `BLOCKING_FINDINGS:2`. New, pre-existing, tracked as **DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001**; the fix lives in the pinned compiler closure (digest recorded in migration 20261123100000), so it is a coordinated release, not changed here.
2. **Trial Balance Review page is not in the browser run** (its harness is an in-memory synthetic backend). The run starts at Check my books on the already-certified trial balances. Source B and the QuickBooks link cases are not run in the browser. Identities are simulated (no GoTrue); the Edge Function is played in process.
3. **Accrual accounts:** booked on existing two-period accounts 6100 / 2000 because an account present in one period only blocks sign-off (registered DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001); one-period-only lines need the registered explicit-nil row.
4. **First-period result stays separate:** #256 proves the comparatives blocker (verified, bound decision); a first-period report still cannot be signed because the cash-flow / equity statement engine builds from comparative balances. **Tracked separately, unchanged here;** the applicable IFRS for SMEs basis must be verified before any reporting behaviour changes.
5. **QuickBooks sandbox: NOT_RUN** (no authenticated company or recorded run). **External document intake:** the issued PDF is bound by hash only — no upload/storage/reading, and the schedule is agreed to the document by eye; source A's approved figure still reaches Check my books as a file (not derived automatically from the prior FINAL).
6. CI is `postgres:16`; local runs are 18.4. #256's base is not `main`, so this PR's own CI may not trigger until the stack lands.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
