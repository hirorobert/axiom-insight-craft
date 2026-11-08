# Returning-client integration (draft; nothing applied, merged or deployed)

**Stack.** `origin/main` f366367 ← **#255** (Ready for Reporting pilot, `d688387`) ← **#256** (first-period governed review, `5ea96b2`) ← this branch
(`feat/returning-client-integration`). #255 and #256 are unchanged. Review `git diff fix/first-period-comparatives-signoff...` to isolate this change.

## What the journey exposed, and the smallest fix for each

| # | Found by running the journey | Fix here |
|---|---|---|
| 1 | An opening difference classified *unposted audit adjustment* was treated as merely **explained**: the scope went READY and FINAL was not held although the opening position lacked the approved adjustment. | `engine.ts`: it is a **confirmed** finding (`OPENING_ADJUSTMENT_UNPOSTED`) resolved only by an effective correction or a verified ledger fix. An unresolved required difference holds REVIEWED and FINAL. One finding, one next action (`present.ts`). |
| 2 | The same economic item booked in QuickBooks **another way** (as current-year expense) and not linked to the correction was silently ignored. | `engine.ts`: for an *opening* correction an unlinked, non-cash journal that repeats its amount on a moved account is `candidate_needs_confirmation` (the scope stays open). A **linked** journal plus an approved residual treatment is `completed_by_residual`. Other scopes keep the exact-effect rule (acceptance case E2-L5 still passes). |
| 3 | Statements **issued outside CFOClose** could be restated, but nothing tied the restatement to what was issued (its anchor was a free-text reference). | Migration `20261218100000_issued_comparative_schedules.sql` (authored, not applied): a hash-addressed issued-comparative record (document hash, structured schedule, per-line adjustment evidence), a restatement **derived** from it and handed to the existing two-person workflow, a reconciliation, and a sign-off blocker `COMPARATIVE_NOT_AS_ISSUED_EXTERNAL`. |

## Browser journeys (`scripts/browser-acceptance/returningClientJourney.mjs`, headless Chrome, source A; default 14 assertions, `--start` 17)

The REAL Check my books view, the REAL Close Review adjustments view and the REAL reporting workbench, over a loopback bridge to a disposable PostgreSQL
(`scripts/db-proof/serveReturning.mjs`, harness `dev-harness/returning`), driven with real mouse and keyboard as a preparer, a partner and the owner **in one
engagement**: three certified years (one upload each; FY2026 still has exactly one upload at the end) and the FY2025 pack FINAL in CFOClose → start checking → pick the
four files (QuickBooks general ledger, last year's approved closing figure, document register, settings) → **one** Check my books click: one check needs attention, TZS 100.00, one next
action, pack / rule pack / ledger Ready → Propose for review (the proposer is not offered Approve) → the partner approves in Adjustments → Check my books again: every required check ready,
payable -320000 / 3100 -1090000 / 6100 240000 (minor units, read from the database), a second press changes nothing → the partner approves the comparative → the preparer saves a new
version (existing builder and server compiler) → the preview shows payables 3,200.00 | 3,200.00 and profit 5,100.00 | 5,000.00 → REVIEWED (partner) → FINAL (owner) → every binding of the
FY2026 report carries one dependencies identity and one comparative status, and the manifest binds the readiness run. Every request stayed on loopback (plus the Inter font CSS/woff2 GETs).
Found by the journey and fixed: the Check my books page did not offer **Propose for review** for the new finding (its presenter did not attach the correction).

### `--start`: from the REAL Trial Balance Review page, the opening position read from the prior FINAL pack

`RETURNING_SCENE=start` builds the same world **without** FY2026's trial balance (three years: 2024 and 2025 certified, the FY2025 pack FINAL in CFOClose; for FY2026 only the entity's period and the open engagement exist, opened through
the real `open_engagement_with_scope`). `dev-harness/returning/vite.start.config.ts` swaps the Supabase client and the auth context for **loopback stand-ins** (`bridgeSupabase.ts`, `startAuth.tsx`); the bridge answers each
call against the disposable PostgreSQL **as `authenticated` with the simulated user's `auth.uid()`** (row-level security, grants and the functions' own checks decide; `scripts/db-proof/lib/pgQuery.mjs`), runs the **real**
`process-trial-balance` handler and the signer's own decision code (`_shared/sourceUpload.ts`), and keeps the uploaded object in `storage.objects`. Then:

1. The **owner** opens the real Prepare page for FY2026, chooses `trial-balance-2026.csv`, presses *Upload and check*: reserve → signed URL → storage → `register_trial_balance_upload` → real check. Asserted from the database:
   **one** FY2026 upload (`active_processed`, workspace-scoped path), one open engagement. (A *preparer* is refused by the server — source files belong to the workspace owner or an explicit `manage_source_files` grant; that is the existing rule, not changed.)
2. A **fixture step, not a page**, records what follows the trial balance and has its own journeys (Close Review findings explained, notes, evidence, a first draft version).
3. The preparer starts checking **without typing any opening line**, imports only the QuickBooks ledger, and presses **Use last year's FINAL pack**: `rfr_import_prior_pack` reads the approved position from the prior FINAL publication itself
   (basis `prior_final:<report>@v<n>;doc:<document hash>;input:<input hash>`), one bridge line per asset/liability account, classified from the pack's own approved adjustment (reproduced, not typed).
4. One check → **one finding** (`OPENING_ADJUSTMENT_UNPOSTED`, `opening:acct-2000`, TZS 100.00) → propose → a second person approves → check again: **one effective correction** (`corrections = 1`, `adjustments = 1`), payable −320000, opening equity −1090000, 6100 240000.
5. The partner approves the comparative, the preparer saves a version, REVIEWED, FINAL. **The FINAL page shows the same exact strings as the preview** (payables 3,200.00 | 3,200.00; profit 5,100.00 | 5,000.00), every binding of the report carries **one**
   comparative identity, and the books still hold **one** FY2026 upload.

**What the browser runs do NOT cover (stated):** the production app shell, workspace layout and the account home (the engagement is opened by the bridge's setup through the real function, and the engagement-mandate context is stubbed with that
engagement); GoTrue sign-in (identities are simulated); Edge Function deployment (functions are played in process by the bridge); account review of *unmapped* accounts on the Prepare page (every FY2026 account is already reviewed);
source B in the browser; the QuickBooks link cases in the browser (database proof only). **Authenticated QuickBooks: NOT_RUN** (no sandbox company or recorded run exists; the connector is off).

## Proof (`scripts/db-proof/returningClientJourney.mjs`, 38 assertions, embedded PostgreSQL 18.4 locally; `postgres:16` in CI)

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

## Source B: why an external schedule that AGREES with the issued statements entered through the restatement path

Traced in `20261020100000_fs_comparatives.sql` (`fs_statement_composition`, v2/v3): the comparative column is composed **only** from (a) the certified prior-year ledger accounts and (b) rows of kind `restatement` from
`_fs_approved_restatements`. A line with any `restatement` row is presented as `restated: true` with the ledger figure kept as `asReportedMinor`. There was no third source: nothing could say "the comparative is what was **issued**".
So when the prior-year ledger differs from the issued statements (here: an approved audit accrual that was never booked in the ledger), the only way to make the comparative equal the issued figures was to propose a *restatement* of that
difference. Consequences, each reproduced in the proof: the line is labelled restated although nothing was corrected (the issued figure **is** the original figure); nothing tied the delta to the issued document (free-text reference);
and the line then reaches the compiler's `subtotal-casting` rule as a restated comparative (gap 1).

`20261218100000` separates the two meanings. **Importing issued comparatives** records the issued document hash, the structured schedule and per-line adjustment evidence (`fs_record_issued_comparative`); the deltas are *derived*
from it (`fs_propose_restatement_from_issued`, reference `issued:<id>`) and `fs_issued_comparative_reconciliation` shows the comparative equals the issued schedule line by line with the ledger figures beside it. That import
**needs no restatement authorization** (`fs_authorize_restatement` answers `issued_import_needs_no_authorization`). A **genuine restatement** (a figure that differs from the issued schedule — a prior-period error corrected) goes through
the ordinary two-person workflow **and** is blocked (`RESTATEMENT_NOT_AUTHORIZED`, `COMPARATIVE_NOT_AS_ISSUED_EXTERNAL`) until a third person with `approve_certification` authorizes it with a basis and evidence; the proposer, the
restatement's approver and an import are all refused as authorizer. Proven in group **B2** of the database proof (the TRACE assertion, then the genuine +50.00 restatement: blocked → refused authorizers → authorized → exact reconciliation
325,000 = 320,000 issued + 5,000 authorized).

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
3. **Browser journeys.** Source A now runs end to end from the real Trial Balance Review page (`--start`). Not browser-run: source B; the QuickBooks link cases; the account home and workspace layout; unmapped-account review on the Prepare page.
4. **QuickBooks sandbox: NOT_RUN.** No authenticated sandbox company or recorded run exists (the connector is off); the QuickBooks cases use constructed ledger exports with the journal link in the posting.
5. **External document intake.** The issued document is bound by its SHA-256 and the adjustment evidence by reference and hash; **no file upload, storage or reading of the issued PDF exists**, so a reviewer still agrees the schedule to the document
   by eye (the approval is recorded). For source **A** the approved prior-year position is now **derived from the prior FINAL pack** (`rfr_import_prior_pack`, migration `20261219100000`); for source B it is still supplied.
6. **Compiler follow-up.** The pinned compiler (`statementCompiler.generated.mjs`, digest recorded in migration `20261123100000`) is not changed here. The one client-side tolerance for a comparative with no dates (`signoff.ts`, part of the
   bundled closure) was removed from this stack and moves, with the restatement-casting and one-period-line fixes and their regression proofs, to a separate follow-up (see its PR). Until it lands a first-period/restated report cannot be signed.
7. PostgreSQL 18 locally, `postgres:16` in CI. No hosted run.
