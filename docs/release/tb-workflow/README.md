# Trial Balance workflow — release candidate (Track A and Track B)

**Status: release candidate on branch `feat/tb-workflow` (draft PR). NOTHING here is applied, deployed, published or
activated.** Migration application, function deployment, the enforcement floor and Publish are separate, explicitly
approved steps (§6). All data used anywhere in this work is invented.

## 1. What changes for a person

| Before | After |
|---|---|
| The account home routed from unbounded client reads | `get_account_home`: exact totals with bounded samples; the route (resume, start, shared, chooser, first run) is decided from the totals, never from a truncated list |
| The home listed every engagement | A server-paged engagements list: literal search, status/purpose/period filters, three sorts, keyset Previous/Next, exact count, a notice when the list moved while paging; a withheld service says "Service no longer offered" and offers no action |
| Upload was a card on the home | A focused page, `/upload`; saved (unchecked) uploads listed with a confirmed removal; a new entity matching an existing name is asked about first |
| Settings links sat in the middle of task pages | The workspace rail states the engagement (entity, period dates, currency, framework) with its settings: period/currency, company details, the clearing-balance policy |
| Findings were all "review notes" | Each finding says whether it **must be decided** (rule + workspace policy, computed by the server): a differing entity name — required; a clearing/in-transit balance — an optional review note unless the workspace requires an explanation; amount-free trailing text — an optional acknowledgement; an amount-bearing row without an account — blocking (`MISSING_ACCOUNT_CODE`), never a decision |
| An imbalance said "correct the file" | Plus **"Look for likely causes in this file"**: read vs printed totals, a labelled possible cause, leads by row, and every row read (included and excluded, source row, exact amounts, exclusion reason) page by page — never a plug, never a claim about the ledger |
| A wrong-entity file could only be confirmed or ignored | "Different entity" blocks it, with the way out: remove it here and find the right engagement |
| History was mixed with the current result | The current result and its checks first; "Upload history · N" (exact, this period) after them; a note when only the most recent are shown |
| An accepted trial balance ended there | "Continue to financial statements", only where the server enables reporting |

## 2. Accounting-integrity rules this implements

* No plug, suspense entry or balanced journal is offered for an imbalance; an out-of-balance source stays blocked even
  if a balanced draft journal is proposed (no authority → `no_authority`).
* No silent row drop: amount-free trailing text acknowledged as "not part of the trial balance" stays recorded with its
  rows; "part of the trial balance" blocks with a layout correction; a page number outside the amount columns is a
  recognised footer, not a finding; footer-like text carrying an amount is refused as a row without an account.
* An account name is never proof of error: a clearing balance is a review indicator, explained (optionally, or as the
  workspace policy requires) with evidence — never reclassified or removed. **A recorded evidence reference is what the
  preparer wrote; it is not a matched bank transaction and the system does not check the document** (said in the UI).
* Nothing claims the originating ledger is unbalanced: investigation results are about **this file**.
* A decision changes no amount, row, account or mapping.

## 3. The requirement and decision model (20261118100000)

* **Rules** `tb_decision_rules` (fixed): `ENTITY_NAME_DIFFERS` always; `CLEARING_ACCOUNT_BALANCE` by policy;
  `UNRECOGNISED_TRAILING_TEXT` never. **Actions** `tb_decision_actions` (fixed): same/different entity; not part/part of
  the trial balance; explained.
* **Policy** `tb_finding_policies` (append-only) via `set_tb_finding_policy`: review authority, a reason, the expected
  revision, idempotent; a change bumps `#finding_policy`, so results evaluated under the old policy lose authority at once.
* **Requirement** `tb_finding_required(company, code)` — the engine states it on each finding (`decision_required`) and
  finalize **recomputes and compares** it.
* **Decisions** `tb_finding_decisions` (append-only) via `record_tb_finding_decision`: actor from `auth.uid()` with
  `prepare_close`; identity from the certification's own stored findings; bound to the upload, its source hash, its layout
  revision and (entity findings) the company identity revision; refused while a check runs (`IN_PROGRESS`) and on any
  result that is not the latest uninvalidated one (`STALE_EVALUATION`); version-checked; replay-safe; the result it was
  made against is invalidated in the same transaction.
* **No carry-forward across files**: `tb_current_finding_decisions` returns only the upload's own decisions whose context
  is unchanged. A shared company never authorizes a file-specific confirmation. The same file re-checked with unchanged
  context reuses its decisions; a replacement file, a renamed entity or a changed layout needs a new decision.

## 4. Finalize and the trusted-handler boundary

From generation 7, `tb_finalize_attempt` refuses a certification unless its evaluation (`tb-evaluation/1`) names every
rule of `tb_evaluation_rules(7)` exactly once, agrees with the findings, gives every decision-taking finding a subject and
the database's own requirement, cites only current decisions, blocks on a non-resolving decision, and — when accepted —
leaves no required finding undecided. A generation above 7 is refused at begin and finalize. An engine below 7 is refused
at begin for an upload with decisions, and a run below 7 that finishes after a decision exists ends failed
(`DECISIONS_REQUIRE_CURRENT_ENGINE`) — defence in depth: through the public paths a decision never coexists with a running
check (both proven; the guard mutation-tested). **Boundary:** the database cannot re-parse the file; it verifies
everything above and trusts the service-role engine for the parse itself, as for every earlier generation.

## 5. Investigation

`tb_investigations`: a durable reservation (`uq_tbi_one_running`, one running per upload) with a recoverable lease; an
expired reservation is abandoned by the next request and its worker fenced out at completion; a completed investigation
of an evaluation is reused. The reader's rows are stored once (`tb_investigation_add_rows`, ≤ 2,000 per call, ≤ 20,000,
contiguous ordinals; completion checks the count) with the same reader and exact minor-unit amounts as processing, and
read in keyset pages (`get_tb_investigation_rows`, ≤ 200; all/included/excluded; the UI uses 50). Result
`tb-investigation/2`: read vs printed totals and a possible cause (`export_totals_do_not_balance`,
`reading_differs_from_printed_totals`, `reading_agrees_with_printed_totals`, `no_printed_totals`).

## 6. Rollout: order, enforcement, recovery (each step needs its own approval)

Proven by `scripts/db-proof/tbDecisionsRollout.mjs`: the real old and new handlers on one database upgraded step by step,
run twice — the old engine as main `daa23e4` and as the hosted `942764f` closure (both generation 6).

| Step | Action | Safe because |
|---|---|---|
| 1 | Apply `tb-portfolio-a1` (`20261117100000`, wrapper; postcondition `docs/release/tb-portfolio-a1/postcondition.sql`) | Generation 6 keeps certifying through the new triggers; results in force stay in force; the old frontend calls none of it |
| 2 | Apply `tb-decisions-b1` (`20261118100000`, wrapper; postcondition `docs/release/tb-decisions-b1/postcondition.sql`) | An interrupted apply rolls back completely; generation 6 serves exactly as before (same file, same outcome — compared); results in force need no manifest; no decision can be recorded on a generation-6 result |
| 3 | **Publish the frontend** | Needs steps 1–2 (without them the home reads "unavailable" — fails closed). With generation 6 live, generation-6 findings carry no decision identity, so no decision control is offered |
| 4 | Deploy `process-trial-balance` generation 7 (closure `01ac6e4e…6bd7`) and `trial-balance-layout` with `investigate` (closure `aec4b928…3dab`) | Mixed fleet: generation 7 certifies with the manifest; a generation-6 instance is refused before any write for an upload with decisions and still serves uploads without; generation 7 completes the refused request. **Must follow step 3:** the main-branch frontend shows a generation-7 accepted-with-notes result as "Processing results need verification" (fails closed, never falsely accepted) |
| 5 | Raise `min_engine_generation` to 7 (`admin_set_processing_control`; reason; version-checked; it only rises) | Generation 6 refused for every upload before any write; generation 7 serves the same request; earlier results stay in force |

**When enforcement activates.** The required entity decision, the manifest and the database-computed requirements apply
to every result **generation 7 produces** from step 4. From step 5 every new check is generation 7.

### 6.1 Containing the old engine during the cutover

* **What the database refuses at every stage** (proven by `tbDecisionsRollout.mjs` with both generation-6 closures): an
  engine below 7 cannot begin a check of an upload that has a decision; a run below 7 that finishes after a decision
  exists ends failed and certifies nothing; a generation above 7 is refused; from step 5 every engine below 7 is refused
  for every upload — each refusal before any write. A decision is refused while any check runs and binds only to the
  latest uninvalidated result, so an old engine can never certify past a recorded decision.
* **What an old engine can still do** between steps 4 and 5: certify an upload that has no decision, exactly as today
  (proven: generation 6 accepts a file naming another entity). That result is identifiable (§6.2) and never shown as
  passing the current checks.
* **Narrowing that window (available, optional):** the existing processing hold (`admin_set_processing_control`:
  `hold` with canary companies; reason; version-checked; proven by `h1Authority.mjs`) can pause processing for everyone
  except named canary companies from step 4 until step 5, so no old-engine result is produced in the window. Step 5
  follows as soon as the generation-7 closure is verified live (`scripts/release/verifyDeployedClosure.mjs`).

### 6.2 Results accepted under earlier rules — how they are distinguished

* **Server (authoritative):** every certification names its engine run; `engine_runs.engine_generation` records the
  generation that evaluated it. `docs/release/tb-workflow/earlier-rules-inventory.sql` (read-only) lists every period
  whose result in force was evaluated below generation 7 — proven to list exactly the generation-6 results still in force
  and none re-checked or produced by generation 7.
* **Engine record:** from generation 7 each result records `processing_result.ingestion.rules_generation = 7`.
* **Every surface:** a result without the current rules generation is shown as **"Checked by an earlier version.
  Reprocess to apply current checks."** (Prepare, Overview and hub read the one fact `resultVersion.isCurrentCheckSet`):
  never "Reviewed trial balance", never "ready for statement preparation", no balance claim; the card offers **"Check
  again under the current checks"** (the one reprocess path). Unit-tested in `resultVersion.test.ts`.

### 6.3 Compatibility and re-check policy for downstream use

1. **Preserved, not re-evaluated.** Results accepted before the release keep their history, approvals and authority.
   Nothing is invalidated, rewritten or re-labelled in the database by this release.
2. **Compatible downstream.** Close Review, the financial-statements reporting input and sign-off continue to accept the
   authoritative result whatever its generation — their controls are unchanged by this release. No surface states that
   such a result passed the generation-7 checks.
3. **Re-check is explicit.** A person (or the owner, from the inventory) re-checks a period through "Check again under
   the current checks". The re-check invalidates the earlier result at once and produces a generation-7 result, which may
   ask for the entity decision; work bound to the earlier result follows the existing rules (the reporting input becomes
   stale; approved adjustments require revalidation — proven by `closeReviewAuthority.mjs`).
4. **Owner decision recorded for release review:** whether any period must be re-checked before its next Reviewed/Final
   sign-off. This candidate does **not** enforce that (it would change financial-statements controls); the inventory gives
   the list to act on.

**Interrupted cutover — recovery.** Step 1 or 2 interrupted: the wrapper is atomic (no journal row; wrapper proofs and the
rollout proof); re-run it. Frontend published without 1–2: the home says unavailable; apply 1–2. Step 4 rolled back to
generation 6 after decisions exist: those uploads are refused (before any write) until generation 7 is redeployed, others
work; redeploy generation 7 — no data repair. Step 5 before generation 7 is live everywhere: checks are refused (fail
closed) until it is; the floor cannot be lowered. Database rollback only before any decision or generation-7
certification exists (the migration's documented rollback); afterwards roll forward only.

## 7. Requirement-to-evidence checklist (the entire authorized scope)

**Impl** = implementation; **Test** = executed evidence on this branch (PostgreSQL 16, invented data); **Lim** =
remaining limitation. "Journey" = the local-stack browser journey (`scripts/e2e/localStackJourney.mjs`), which runs only
in CI (this host has no Docker); its status is the CI run on the PR head, reported with the PR.

| # | Requirement | Impl | Test | Lim |
|---|---|---|---|---|
| 1 | 100+ engagements with genuine server-side pagination | `list_portfolio_engagements` (keyset, view token); `EngagementPortfolio` | `engagementPortfolio.mjs` 28/28 (130 engagements; every sort; filters; counts; timing); `EngagementPortfolio.test.ts`; journey | — |
| 2 | Bounded routing (single-engagement redirect, first run, entity selection) with explicit completeness | `get_account_home` totals + samples; `decideAccountHomeRoute`; `list_portfolio_entities` | `engagementPortfolio.mjs` (home); `accountHome.test.ts`; `moduleAvailability.test.ts`; `Dashboard.test.ts` | — |
| 3 | Focused upload; saved uploads; entity pre-check | `/upload`; saved drafts; entity pre-check | Journey (focused upload, saved uploads); unit tests | — |
| 4 | Each finding with its actual resolution action | `FindingDecisionControl` (decide / explain / acknowledge); layout correction link; classification; investigation; wrong-entity recovery | `FindingDecisionControl.test.ts`; `TrialBalanceSurfaces.test.ts`; journey | — |
| 5 | Severity model: entity required; clearing a review indicator; evidence only by explicit policy; trailing text distinct from amount-bearing rows | `tb_decision_rules`; `tb_finding_policies`; engine `decision_required`; `MISSING_ACCOUNT_CODE` | `findingDecisions.mjs` (policy; requirement recomputed; review indicators accepted); REQ-G7-DECISIONS-REQUIRED, REQ-G7-CLEARING-POLICY; `printedReportFooter.test.ts`; journey (required vs optional; policy) | — |
| 6 | Genuine wrong-entity upload vs supported alternative name | entity decision same/different; `ENTITY_WRONG_DESTINATION` | REQ-G7-WRONG-ENTITY; REQ-G7-DECIDE-AND-RECHECK; journey (same entity accepted; different entity blocked with recovery) | — |
| 7 | Footer page number outside the amount columns vs ambiguous amount-bearing rows | footer rules; `MISSING_ACCOUNT_CODE` | `printedReportFooter.test.ts` (a page number beyond the amount columns is a footer with no issue; "Page 2" with an amount is refused); `phase1Acceptance.test.ts` | — |
| 8 | Layout-caused imbalance vs inconsistent source export | investigation cause (read vs printed totals) | `imbalanceInvestigation.test.ts` (LAYOUT-CAUSED; INCONSISTENT EXPORT); REQ-G7-INVESTIGATE; journey (cause shown) | — |
| 9 | Legitimate cash in transit with supporting evidence | clearing explanation (nature, explanation, evidence kind, reference) | `findingDecisions.mjs`; journey (optional explanation accepted and cited; required under policy) | Evidence is a recorded reference, not a matched bank transaction (`DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`) — labelled so in the UI |
| 10 | Balanced base plus an approved accrual/depreciation adjustment | Close Review adjustments (propose, approval policy, adjusted layer) | `closeReviewAuthority.mjs` 100/100 (accrual proposed and approved; layer applied with lineage; certified amounts unchanged; re-check requires revalidation) | Exercised in the journey's financial-statements group, not for the trial-balance group's company |
| 11 | Unbalanced source stays blocked despite a balanced draft journal | propose requires authority | `closeReviewAuthority.mjs` (real engine blocks on `TRIAL_BALANCE_IMBALANCE`; a balanced journal for the whole difference is refused `no_authority`; nothing recorded; nothing authoritative) | — |
| 12 | Unchanged decisions carried forward; changed context or source invalidated | `tb_current_finding_decisions` | `findingDecisions.mjs` (same-input reuse; replacement file; changed title; changed layout; rename); REQ-G7-RENAME-INVALIDATES; REQ-G7-REPLACEMENT-NOT-CARRIED; journey (rename; replacement) | — |
| 13 | Direct-RPC bypass, stale generation and omitted-rule refusal | grants; fences; manifest checks | `findingDecisions.mjs` (direct writes refused; manifest refusals; generation 8 refused); REQ-G7-OLD-ENGINE-REFUSED | — |
| 14 | Concurrent decisions, reprocessing, lost responses and replay | version check; request ids; `IN_PROGRESS`; finalize guard | `findingDecisions.mjs` (12 parallel decisions → one recorded; lost answer replays; key reuse a conflict; a decision during a running check refused; the late older-engine finalize fails) | — |
| 15 | Investigation lease expiry and failed-worker recovery | lease + fence | `findingDecisions.mjs` (expired lease recovered; late worker fenced out of rows and completion) | — |
| 16 | Investigation: same reader and exact money; included/excluded rows; source locations; parsed amounts; comparable totals; labelled causes; bounded pages; no re-parse; durable reservation | `tbInvestigation.ts`; `tb_investigation_rows`; `ImbalanceInvestigation`; `investigationRows` | REQ-G7-INVESTIGATE (stored rows = row count; page read); `findingDecisions.mjs` (paging; fences); `FindingDecisionControl.test.ts` (rows filtered and keyset-paged; never re-investigated; axe); `investigationRows.test.ts`; journey | — |
| 17 | Preservation of source, audit and issued history; earlier results never presented as passing new checks | append-only decisions, policies, investigations; history list; `isCurrentCheckSet` + `rules_generation`; inventory query (§6.2) | `findingDecisions.mjs` (append-only; no truncate); rollout (results in force preserved; inventory lists exactly the generation-6 results in force); `resultVersion.test.ts`; journey (history) | Results in force are not re-evaluated retroactively (by design; §6.3) |
| 18 | Settings out of the task body; engagement-context sidebar | `EngagementContextPanel` in the workspace rail | `EngagementContextPanel.test.ts` (axe); `WorkspaceAccessGate.test.ts`; journey (rail; no settings link in the task; policy change) | — |
| 19 | Current upload vs history; contextual navigation | period-scoped uploads with exact count; history after the checks; Reconcile link; statements handoff | `TrialBalanceSurfaces.test.ts`; journey (history · 2; handoff) | — |
| 20 | Keyboard, screen reader, desktop and mobile | labelled controls; live regions; tables with captions | axe in component tests; journey `widths()` at 1280×900 and 375×812 with screenshots | Automated rules and keyboard paths — not a human screen-reader session |
| 21 | Rollout safety at every stage; enforcement timing; old-engine containment; interrupted cutover | §6, §6.1 | `tbDecisionsRollout.mjs` 27/27 with `daa23e4` and with `942764f`; `releaseOrder.mjs` 17/17; wrapper proofs 32/32 each | — |
| 22 | Unrelated FS and payment controls preserved | no change to their migrations or functions | `closeReviewAuthority.mjs`; `statementComposition.mjs`; `signoffPolicy.mjs`; `h1Authority.mjs`; `layoutAuthority.mjs`; the full vitest suite; CI payment and FS jobs | — |
| 23 | The complete journey through the FS handoff on the integrated isolated stack | journey "Trial Balance workflow" group | CI run on the PR head | Reported with the PR |

## 8. Executed proofs on this branch (PostgreSQL 16)

`findingDecisions.mjs` 54/54 · `tbDecisionsRollout.mjs` 27/27 (each old engine) · `tbHandlerCharacterization.mjs` 45/45 ·
`engagementPortfolio.mjs` 28/28 · `closeReviewAuthority.mjs` 100/100 · `layoutAuthority.mjs` 38/38 · `h1Authority.mjs`
61/61 · `statementComposition.mjs` 37/37 · `signoffPolicy.mjs` 24/24 · `releaseOrder.mjs` 17/17 · wrapper proofs
`tb-portfolio-a1` 32/32 and `tb-decisions-b1` 32/32. Typecheck clean; lint 0 errors (157 warnings — the existing baseline).

## 9. Known limitations (stated, not hidden)

* Clearing-balance evidence is a reference the preparer records — not an independently matched bank transaction
  (`DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`, unchanged).
* Until the floor is raised (step 5), a generation-6 instance still answering certifies uploads without decisions as
  before, including a file naming another entity — contained and identifiable (§6.1, §6.2); results already in force are
  not re-evaluated (§6.3).
* The database trusts the service-role engine for the parse (the manifest proves complete reporting, not its truth).
* Accessibility is checked by automated rules (axe) and keyboard paths in tests, not by a human screen-reader session.
