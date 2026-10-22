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

## 6. Rollout: order, containment, resume, recovery (each step needs its own approval)

Proven by `scripts/db-proof/tbDecisionsRollout.mjs`: the real old and new handlers on one database upgraded step by step,
run twice — the old engine as main `daa23e4` and as the hosted `942764f` closure (both generation 6).

| Step | Action | What happens, and why it is safe |
|---|---|---|
| 1 | Apply `tb-portfolio-a1` (`20261117100000`, wrapper; postcondition `docs/release/tb-portfolio-a1/postcondition.sql`) | Generation 6 keeps certifying through the new triggers; results in force stay in force; the old frontend calls none of it |
| 2 | Apply `tb-decisions-b1` (`20261118100000`, wrapper; postcondition `docs/release/tb-decisions-b1/postcondition.sql`) | **Containment starts here, by construction.** No engine below generation 7 can begin a check (refused before any write, `ENGINE_GENERATION_SUPERSEDED`); an attempt begun before the apply finishes failed and certifies nothing. **Processing pauses** until step 4: a person who uploads sees "This check could not start. Refresh and try again."; nothing is written. Results in force stay in force. An interrupted apply rolls back completely |
| 3 | **Publish the frontend** | Needs steps 1–2 (without them the home reads "unavailable" — fails closed) |
| 4 | Deploy `process-trial-balance` generation 7 (closure `89dfebd2…34e3`) and `trial-balance-layout` with `investigate` (closure `aec4b928…3dab`) | **Processing resumes** (§6.1). Generation-6 instances still answering stay refused for every upload; generation 7 completes the requests they were refused |
| 5 | Raise `min_engine_generation` to 7 (`admin_set_processing_control`; reason; version-checked; it only rises) | Records the floor in the control row as well; containment does not depend on it |

### 6.1 Containment and when processing can safely resume

* **Containment is a property of the migration, not an operator step.** From the moment step 2 commits, the database
  refuses every engine below 7 at begin and turns a below-7 certification at finalize into a failure. No result can be
  certified under superseded rules after that instant — including a file naming another entity, which generation 6 accepts
  today (proven at stage 1 and refused at stage 2). Mutation-checked: restoring the old "only uploads with decisions"
  condition fails two rollout checks.
* **The processing pause** is the interval between step 2 and step 4. Perform steps 2–4 back to back. Uploads made
  during it are stored and stay ready; nothing is lost or half-written.
* **Resume when, and only when, all of these hold** (each is checked, none assumed):
  1. `scripts/release/verifyDeployedClosure.mjs` reports `process-trial-balance` = `89dfebd2…34e3` live;
  2. one real check of a test upload in an internal workspace returns 200 and its run records `engine_generation = 7`;
  3. the decisions postcondition reports `POSTCONDITION OK.`
  Until then the system is safe — paused and fail-closed — never degraded into old rules.
* **Recovery.** Step 1 or 2 interrupted: atomic wrapper (no journal row); re-run it. Frontend published without 1–2: the
  home says unavailable; apply 1–2. Generation 7 deployment failing or rolled back: processing stays paused (older engines
  are refused); redeploy generation 7 — never roll the database back to reopen old engines. Database rollback only before
  any decision or generation-7 certification exists (the migration's documented rollback, which re-opens processing to
  older engines and therefore needs its own approval).

### 6.2 Results accepted under earlier rules — how they are distinguished

* **Server (authoritative):** every certification names its engine run; `engine_runs.engine_generation` records the
  generation that evaluated it. `docs/release/tb-workflow/earlier-rules-inventory.sql` (read-only) lists every period
  whose result in force was evaluated below generation 7 — proven to list exactly the generation-6 results still in force
  and none re-checked or produced by generation 7.
* **Engine record:** from generation 7 each result records `processing_result.ingestion.rules_generation = 7`.
* **Every surface:** a result without the current rules generation is shown as "Checked by an earlier version. Reprocess
  to apply current checks." (Prepare, Overview and hub read `resultVersion.isCurrentCheckSet`): never "Reviewed trial
  balance", never "ready for statement preparation"; the card offers "Check again under the current checks".

### 6.3 Earlier results before a new sign-off — decision and enforcement

**Decision (implemented and enforced):** a period whose trial balance in force was evaluated before generation 7 is
**re-checked before any NEW Reviewed or Final sign-off**. History is preserved and nothing is reinterpreted:

* **Never touched:** existing certifications (they stay authoritative), sign-offs already recorded, FINAL versions and
  issued packs. The next year's comparatives use the prior year **as reported/issued**, not re-evaluated.
* **Enforced on the one sign-off write:** `trg_fsp_requires_current_rules` on `financial_statement_publications` refuses
  a new REVIEWED/FINAL state of a trial-balance-derived statement with `TRIAL_BALANCE_RECHECK_REQUIRED:<generation>`,
  before anything is recorded. The sign-off page names it first (`tb_signoff_rules_blocker`, merged into readiness; fails
  closed). Proven in `publicationControls.mjs` (group R): refused with no publication row written and the certification
  untouched; a real re-check through the generation-7 engine clears it; the supported path then signs REVIEWED → FINAL.
* **Affected population at release:** every period whose authoritative trial balance was certified by the hosted engine
  (generation 6 — `942764f`): in practice **every period accepted before the release**. The exact list is the inventory
  query, run read-only immediately before step 2 and attached to the release record.
* **Control implications of a re-check** (all existing controls, unchanged): the re-check invalidates the earlier result
  at once and produces a generation-7 result, which may ask for the entity decision (a file whose title names another
  entity); work bound to the new authority is redone as for any re-check — Close Review findings checked again, approved
  adjustments revalidated, comparatives approved again, and a new statement version saved before sign-off (proven:
  `publicationControls.mjs` R, `closeReviewAuthority.mjs`).
* **Recommendation for the owner:** after step 4, re-check the inventory's periods that are expected to be signed next
  (open engagements first); leave closed periods with recorded FINAL sign-offs as they are — they need no action and are
  never presented as passing the current checks.

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
| 13 | Direct-RPC bypass, stale generation and omitted-rule refusal | grants; fences; exhaustive finding/rule mapping; bidirectional manifest checks | `findingDecisions.mjs` (every emitted finding maps exactly; unknown, omitted, duplicate and contradictory rules refuse atomically; direct writes refused; generation 8 refused); REQ-G7-OLD-ENGINE-REFUSED | — |
| 14 | Concurrent decisions, reprocessing, lost responses and replay | version check; request ids; `IN_PROGRESS`; finalize guard | `findingDecisions.mjs` (12 parallel decisions → one recorded; lost answer replays; key reuse a conflict; a decision during a running check refused; the late older-engine finalize fails) | — |
| 15 | Investigation lease expiry and failed-worker recovery | lease + fence | `findingDecisions.mjs` (expired lease recovered; late worker fenced out of rows and completion) | — |
| 16 | Investigation: same reader and exact money; included/excluded rows; source locations; parsed amounts; comparable totals; labelled causes; bounded pages; no re-parse; durable reservation | `tbInvestigation.ts`; `tb_investigation_rows`; `ImbalanceInvestigation`; `investigationRows` | REQ-G7-INVESTIGATE (stored rows = row count; page read); `findingDecisions.mjs` (paging; fences); `FindingDecisionControl.test.ts` (rows filtered and keyset-paged; never re-investigated; axe); `investigationRows.test.ts`; journey | — |
| 17 | Preservation of source, audit and issued history; earlier results never presented as passing new checks; re-check before a new sign-off | append-only decisions, policies, investigations; history list; `isCurrentCheckSet` + `rules_generation`; inventory query (§6.2) | `findingDecisions.mjs` (append-only; no truncate); rollout (results in force preserved; inventory lists exactly the generation-6 results in force); `resultVersion.test.ts`; `publicationControls.mjs` R (new sign-off refused until re-checked; issued history unchanged); `readinessReadOnly.mjs` 26/26 (historical client behavior, current-client fail-closed rule absence, generation-6 refusal, final generation-7 REVIEWED/FINAL); `trialBalanceRules.test.ts`; journey (history) | — |
| 18 | Settings out of the task body; engagement-context sidebar | `EngagementContextPanel` in the workspace rail | `EngagementContextPanel.test.ts` (axe); `WorkspaceAccessGate.test.ts`; journey (rail; no settings link in the task; policy change) | — |
| 19 | Current upload vs history; contextual navigation | period-scoped uploads with exact count; history after the checks; Reconcile link; statements handoff | `TrialBalanceSurfaces.test.ts`; journey (history · 2; handoff) | — |
| 20 | Keyboard, screen reader, desktop and mobile | labelled controls; live regions; tables with captions | axe in component tests; journey `widths()` at 1280×900 and 375×812 with screenshots | Automated rules and keyboard paths — not a human screen-reader session |
| 21 | Rollout safety at every stage; old-engine containment as a required gate; when processing resumes; interrupted cutover | §6, §6.1; containment in `tb_begin_attempt` / `tb_finalize_attempt` | `tbDecisionsRollout.mjs` 30/30 with `daa23e4` and with `942764f` (mutation-checked); `s2Authority.mjs` final-schema generation-7 and below-7 fencing; `certificationCapacity.mjs` final-schema generation-7 capacity and atomic invalid-manifest/summary/hash refusals; `releaseOrder.mjs` 17/17; wrapper proofs 32/32 each | — |
| 22 | Unrelated FS and payment controls preserved | no change to their migrations or functions | `closeReviewAuthority.mjs`; `statementComposition.mjs`; `signoffPolicy.mjs`; `h1Authority.mjs`; `layoutAuthority.mjs`; the full vitest suite; CI payment and FS jobs | — |
| 23 | The complete journey through the FS handoff on the integrated isolated stack | journey "Trial Balance workflow" group | CI run on the PR head | Reported with the PR |

## 8. Executed proofs on this branch (PostgreSQL 16)

`findingDecisions.mjs` (final CI count recorded on the reviewed head; exhaustive finding/rule and manifest-agreement suite) · `tbDecisionsRollout.mjs` 30/30 (each old engine) · `publicationControls.mjs` 50/50 · `certificationCapacity.mjs` (final CI count recorded on the reviewed head; historical and final-schema generation-7 capacity suite) · `readinessReadOnly.mjs` 26/26 (historical and final schema stages) · `accountIdentity.mjs` 34/34 · `signoffBinding.mjs` 19/19 · `publicationConcurrency.mjs` 20/20 · `accountCapacity.mjs` 19/19 · `tbHandlerCharacterization.mjs` 45/45 ·
`engagementPortfolio.mjs` 28/28 · `closeReviewAuthority.mjs` 100/100 · `layoutAuthority.mjs` 38/38 · `h1Authority.mjs`
61/61 · `statementComposition.mjs` 37/37 · `signoffPolicy.mjs` 24/24 · `releaseOrder.mjs` 17/17 · wrapper proofs
`tb-portfolio-a1` 32/32 and `tb-decisions-b1` 32/32. Typecheck clean; lint 0 errors (157 warnings — the existing baseline).

## 9. Known limitations (stated, not hidden)

* Clearing-balance evidence is a reference the preparer records — not an independently matched bank transaction
  (`DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`, unchanged).
* Processing pauses between applying `tb-decisions-b1` and deploying generation 7 (§6.1) — by design: fail-closed rather
  than certifying under superseded rules.
* Results accepted before the release stay in force and are not re-evaluated; a new sign-off requires a re-check (§6.3).
* The database trusts the service-role engine for the parse (the manifest proves complete reporting, not its truth).
* Accessibility is checked by automated rules (axe) and keyboard paths in tests, not by a human screen-reader session.
