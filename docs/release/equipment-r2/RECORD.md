# Equipment completion r2 — multi-class, evidence-linked preparation

**Status:** draft implementation candidate. Accounting expected results are pending qualified review; the accounting
author and independent reviewer are **unassigned**. Nothing here is a compliance certification; no IFRS for SMEs
compliance is claimed for CFOClose or for any report. No hosted write, migration application, deployment, publication,
Lovable contact or paid API call is part of this work.

**Base:** `origin/main` at `2b8e31cc` (merge of PR #207; PR #208's charter and PR #209's content documents are merged).
**Branch:** `feat/equipment-multiclass-provenance`.

## 1. Dependency on PR #210

PR #210 (`fix/equipment-native-migrator`, draft, open at `29e1b94f`) removes the outer `BEGIN;`/`COMMIT;` from the
unapplied source `20261205100000_fs_equipment_preparation.sql` because Lovable's native migrator owns its transaction.
This branch depends on that corrected baseline and does not modify #210's files (`20261205100000…sql`,
`release/candidates/guided-equipment-r1/workpaper.sql`, `docs/release/guided-equipment-r1/RECORD.md`,
`scripts/db-proof/equipmentPreparation.mjs`, `equipmentMigrationTransport.test.ts`). The new migration
`20261206100000_fs_equipment_multiclass.sql` is written **without** an outer transaction, so it installs the same way
on either baseline; the proof's static case checks this. Merge order: #210 first, then this PR (a merge of this PR on a
baseline still carrying #207's outer transaction is functionally fine on disposable databases but would be refused by
the native migrator at the 20261205100000 step, exactly as #210 describes).

## 2. Charter requirements applied (docs/architecture/CFOCLOSE_DEVELOPMENT_CHARTER.md — proposed, adoption not recorded)

| Requirement | How this slice meets it | Where |
|---|---|---|
| P1/R1 provenance | Every movement names its record (register, ledger account, journal, reviewed workpaper); every class names its accounts; estimates record rationale, factors and evidence; a tax class or template is refused as an estimate | `equipmentSchedule.ts` (`sourcePresent`), `_fs_equipment_v2_problems` (`MOVEMENT_SOURCE_MISSING`, `ESTIMATE_NOT_ENTITY_SPECIFIC`) |
| P2/R2 deterministic calculation | Depreciation calculated from recorded inputs only, exact minor-unit arithmetic, half-up rounding named in the result, fixtures AC-11/12/13 | `depreciation.ts`, `depreciation.test.ts` |
| P3/R7 proposals | Policy, estimates and equipment-note wording generated from confirmed answers; recorded only when a named person saves the WHOLE note | `equipmentProposals.ts`, `EquipmentServerBridge.tsx`, `fs_commit_equipment_preparation_v2` |
| P6 server enforcement | Both roll-forward identities, net identity, disposal tie, destinations tie, class preservation, statement agreement, mandatory answers re-checked by the server before any write | `_fs_equipment_v2_problems` |
| R4 opening bridge | Net bridge kept; gross and accumulated opening amounts bridged to the prior report (AC-23); residual never balanced | `openingGrossBridge`, step 2 of the page |
| R5 movements | Movement accounts admitted only as an identified, reviewed source; two balances never produce a schedule | source types; `classRollForward` |
| R13/G9 change control | Commit bound to the reviewed composition hash (`stale_inputs`), the latest workpaper, schedule and note revisions; a recorded change alters `fs_reporting_dependencies` so a saved version must be recompiled | proof case `issued.final-untouched-by-later-preparation` |
| G4 schedules | opening + movements = closing per class in every column; register (disposal items) ties to the movement; closing ties to the statement line | `ROLLFORWARD_*`, `DISPOSAL_*`, `STATEMENT_CLOSING_MISMATCH` |
| G5 cross-statement | Depreciation reconciled to its destinations (expense lines bounded by the composed line; capitalised amounts); differences explained, never posted | `depreciationTieOut`, `DEPRECIATION_DESTINATIONS_MISMATCH`, `DEPRECIATION_EXCEEDS_LINE` |
| G6 disclosures / L8 answers | Answers recorded as requirement-linked facts (`fs_equipment_answers`), reused by the next period's preparation on explicit review | `fs_equipment_context_v2` (`priorAnswers`), `QuestionPanel` |
| 11.3 atomicity, retries, concurrency | One transaction; request identity with replay and changed-intent refusal; stale refusals by name; unknown outcome keeps its request | proof cases `commit.*`, component tests |
| 11.4 access | Tenant and capability checks on every read and write; viewer, outsider, anon, service_role and revoked preparer proven | proof cases `ctx.*`, `history.append-only-and-api-roles`, `access.revoked-preparer-refused` |
| 11.5 usability | Only applicable questions asked; answered ones kept; each blocker names its next action; prior answers offered for reuse | `evaluateQuestions`, `QuestionPanel` |

## 3. What changes

### Database (one new forward migration, pending hosted application)
`supabase/migrations/20261206100000_fs_equipment_multiclass.sql` — registered in every exact-name registry
(migrationAuthority, releaseJournal, tbStagedTransport, billingTriggerRepair, migrationReplayCompatibilityGuard count
202→203, persistenceMigrationContract, databaseInert added set, serviceWithholding LATER, trackAHardening
REVIEWED_LATER, omega3/activationReadiness/serviceEnquiry lists).

- `fs_equipment_answers` — append-only facts per (company, period, class, question): status, the answer object
  (text, evidence, who checked, flags), the workpaper revision they came from. RLS, no API-role privileges, immutable
  triggers (reuses `_fs_equipment_immutable`).
- `_fs_equipment_v2_problems(payload, existing_rows, composition, require_complete)` — pure validator, revoked from API
  roles. Codes: `CONTRACT`, `CLASSES_COUNT`, `PAYLOAD_SHAPE`, `CLASS_MALFORMED`, `CLASS_ID_REPEATED`,
  `CLASS_LABEL_REPEATED`, `BALANCE_MALFORMED`, `NET_IDENTITY`, `MOVEMENT_KIND_UNKNOWN`, `MOVEMENT_KIND_REPEATED`,
  `MOVEMENT_MALFORMED`, `MOVEMENT_SIGN`, `MOVEMENT_SOURCE_MISSING`, `ROLLFORWARD_GROSS`,
  `ROLLFORWARD_ACCUMULATED_DEPRECIATION`, `ROLLFORWARD_ACCUMULATED_IMPAIRMENT`, `DISPOSAL_ITEMS_MISSING`,
  `DISPOSAL_MALFORMED`, `DISPOSAL_SOURCE_MISSING`, `DISPOSAL_COST_MISMATCH`, `DISPOSAL_ACCUMULATED_MISMATCH`,
  `DISPOSAL_IMPAIRMENT_MISMATCH`, `ESTIMATE_INCOMPLETE`, `ESTIMATE_NOT_ENTITY_SPECIFIC`, `ANSWER_MALFORMED`,
  `EXPENSED_COSTS_CAPITALISED`, `QUESTION_UNRESOLVED`, `QUESTIONS_UNRESOLVED`, `RETIREMENT_MALFORMED`,
  `CLASS_DROPPED`, `STATEMENT_CLOSING_MISMATCH`, `DESTINATION_MALFORMED`, `DESTINATION_LINE_ABSENT`,
  `DEPRECIATION_EXCEEDS_LINE`, `DEPRECIATION_DESTINATIONS_MISMATCH`.
- `fs_equipment_context_v2` — latest workpaper (any contract), the three notes, the recorded schedule's classes, the
  latest answer per question for this period and the prior period.
- `fs_save_equipment_workpaper_v2` — draft save (contract /2; compare-and-set; replay).
- `fs_commit_equipment_preparation_v2` — ONE transaction: workpaper → every class through the existing
  `fs_record_schedule` authority → answers → up to three reviewed notes through `fs_record_disclosure` (each
  compare-and-set on its latest text, replay-safe by a derived request). Outcomes: `recorded` (with `replay`),
  `request_reused`, `stale`, `stale_schedule`, `stale_note`, `stale_inputs`, `invalid_preparation` (problems named),
  `source_mismatch`, `invalid_schedule`, `invalid_request`, `forbidden`, `feature_disabled`,
  `framework_not_ifrs_for_smes`.

The /1 functions of 20261205100000 are left in place and unused by the page (the single-class wizard path is
superseded; its create-only function remains for the proof of that migration). The v1 question module
`equipmentRequirements.ts` and its test are removed (superseded by `equipmentQuestions.ts`); `equipment.ts` keeps the
opening bridge, amount parsing and formatting the v2 page still uses.

### Pure modules (`src/lib/preparation/`)
`equipmentSchedule.ts` (class roll-forward identities, disposal results, destinations tie-out, class preservation,
gross bridge), `depreciation.ts` (calculator), `equipmentQuestions.ts` (catalogue with triggers; paragraph references
re-read against the pinned 2015 text on 2026-10-27), `equipmentProposals.ts` (wording), `equipmentEditor.ts`
(typed-text → exact model; loading recorded classes), `equipmentModel.ts` (types), `editorSchema.ts` (/2 restore),
`workpaperClient.ts` (v2 calls, refusal words).

### Pages
`EquipmentPreparation.tsx` (six steps: prior report with optional gross/accumulated figures; opening bridge with
categorised adjustments including a transition adjustment; classes and movements; depreciation destinations;
questions; proposals and save), `equipment/ClassEditor.tsx`, `equipment/QuestionPanel.tsx`,
`EquipmentServerBridge.tsx`. One entry convention: fixed-direction kinds take positive amounts; the 'either' kinds take
signed amounts per column. The carrying-amount effect of every movement is derived from its three columns, never typed.

### Harness and journey
`scripts/db-proof/serveReporting.mjs` exposes the three v2 functions; `dev-harness/reporting/main.tsx` gains `nav=off`
(no sidebar) for the phone-width check; `scripts/browser-acceptance/equipmentJourney.mjs` drives the real page.

## 4. Requirement-to-test matrix

Requirement rows (R-xx) and acceptance cases (AC-xx) are those of `docs/accounting-content/sme-2015-equipment/`.
"Proof" = `scripts/db-proof/equipmentMulticlass.mjs` case id; "Journey" = `scripts/browser-acceptance/equipmentJourney.mjs`.

| Outcome / requirement | Unit test | Proof case | Journey check |
|---|---|---|---|
| 1 Multiple classes: load and preserve existing classes (R-01, R-21, R-32; AC-27) | `EquipmentPreparation.test` "loads the recorded class…", "never collapses…" | `ctx.existing-classes-loaded`, `commit.class-dropped-refused`, `commit.retire-class-with-reason` | load, race (third class loaded) |
| 1 Stable identities; concurrent changes; unsaved work retained after refusal | "keeps every edit after a server refusal…", bridge tests | `commit.stale-workpaper-schedule-note-refused`, `commit.multiclass-recorded-concurrently` | race |
| 2 Gross cost, accumulated depreciation and impairment at both dates; net identity (R-22; AC-09, AC-10, AC-34) | `equipmentSchedule.test` net identity cases | `commit.rollforward-difference-refused` (NET_IDENTITY path), `BALANCE_MALFORMED` | classes |
| 2 Movements linked to sources; both roll-forwards; no invented balancing movement (R-23, R-13; AC-05, AC-06, AC-33) | roll-forward, source and difference cases | `commit.missing-movement-never-balanced`, `commit.rollforward-difference-refused` | typo difference |
| 2 Transfers, revaluation/OCI, other, business combinations (signed columns) | `MOVEMENT_SIGN` case; editor convention | schedule authority sign rule (AC-07) | — |
| 3 Structured estimates; tax class refused (R-14 to R-18; AC-35) | `equipmentQuestions.test` estimate cases | `commit.tax-class-estimate-refused` | — |
| 3 Deterministic depreciation; components; part-year; change in estimate (AC-11, AC-12, AC-13) | `depreciation.test` (10 cases) | — (advisory; compared on the page) | — |
| 3 Calculated vs register-supplied charge distinguished | `ClassEditor` charge status; `chargeSource` required | `ESTIMATE_INCOMPLETE` | — |
| 4 Depreciation destinations incl. capitalised (R-13) | `depreciationTieOut` cases | `commit.destinations-mismatch-refused`, `commit.disposal-gain-and-capitalised-depreciation` | tie-out |
| 4 Disposal proceeds, carrying amount, gain/loss from confirmed inputs (R-20; AC-06) | `disposalResults` cases; unresolved proceeds | `commit.disposal-gain-and-capitalised-depreciation` | — |
| 5 Conditional questions with triggers; impairment every period; follow-ups (R-03…R-31; AC-14…AC-30) | `equipmentQuestions.test` trigger cases | `commit.unresolved-question-refuses-notes` | questions (only applicable asked) |
| 5 Answers reused; only unresolved shown | "offers last year's recorded answer…" | `answers.reused-next-period` | — |
| 6 Original policy/disclosure proposals; other note content preserved | `equipmentProposals.test`; bridge "whole-note" test | `commit.notes-whole-and-preserving` | record |
| 6 Bound to source revisions; recheck on change | "a changed statement keeps the workpaper…" | `commit.stale-inputs-refused`, `issued.final-untouched-by-later-preparation` | — |
| Replay, lost response, idempotent retry (11.3) | "a lost response keeps the request identity…" | `commit.replay-returns-receipt`, `commit.changed-intent-refused` | — |
| Cross-company, viewer, revoked access (11.4) | "does not expose the preparation to a reader" | `ctx.viewer-outsider-refused`, `commit.cross-company-refused`, `access.revoked-preparer-refused`, `history.append-only-and-api-roles` | viewer |
| Issued history preserved | — | `history.earlier-records-preserved`, `issued.final-untouched-by-later-preparation` | — |
| Native-migrator compatibility (no outer transaction; no bare DELETE/UPDATE) | — | `static.no-outer-transaction-no-bare-write` | — |

## 5. Evidence (local, on this branch; CI evidence is recorded on the PR against the exact head)

- Unit: `bun run test` full suite — see the PR for the count on the exact head.
- Proof: `DB_PROOF_MODULES_DIR=… bun scripts/db-proof/equipmentMulticlass.mjs` — 26/26 cases, structured result
  `PROOF RESULT VALID (present)` against `equipmentMulticlass.manifest.mjs` (embedded PostgreSQL 16).
- Journey: `node scripts/browser-acceptance/equipmentJourney.mjs` — see the PR for the check count on the exact head;
  screenshots `01-loaded-class` … `07-width-375` in the evidence folder.
- `bunx tsc --noEmit -p tsconfig.app.json`, `bun run lint`, `bun run build`, `node scripts/ci/assertPackIsolation.mjs dist`,
  `node scripts/ci/assertMigrationAuthority.mjs`, `node scripts/ci/assertSingleLockfile.mjs`.

Failing-before / passing-after (confirmed gaps of #209, reproduced on `main` by reading the code and now covered):
- G-3 single class replaced a multi-class schedule: before, `fs_commit_equipment_preparation` built exactly one row;
  after, `CLASS_DROPPED` refuses a missing class (proof `commit.class-dropped-refused`; component test "never collapses…").
- G-1 two-snapshot gross check: before, `grossReconciliation` compared two dates only; after, `ROLLFORWARD_*` and
  `DISPOSAL_*` check the movement through cost and accumulated deductions (proof `commit.rollforward-difference-refused`,
  `commit.disposal-gain-and-capitalised-depreciation`).
- G-1 depreciation untied: before, no destination check; after, `DEPRECIATION_DESTINATIONS_MISMATCH` (proof
  `commit.destinations-mismatch-refused`).
- G-2 free-text estimates: before, "as per TRA class 2" accepted; after, `ESTIMATE_NOT_ENTITY_SPECIFIC` (proof
  `commit.tax-class-estimate-refused`, unit AC-35).
- G-5 answers not facts: before, JSON only; after, `fs_equipment_answers` and `priorAnswers` (proof
  `answers.reused-next-period`).

## 6. Accountant acceptance script (synthetic entity; 20–30 minutes)

Preconditions: a composed IFRS for SMEs 2015 report with a recorded one-class PPE schedule (the harness seed:
Equipment 16,000.00 → 14,000.00; composed PPE line 14,000.00; depreciation 2,000.00 presented in distribution,
administrative and other expenses 9,900.00). A preparer signs in. Log every question you would have asked CFOClose
staff (charter A4 Log B) and every accounting question for management (Log C).

1. Financial Statements › Schedules › **Start guided equipment preparation**.
2. Step 1: choose "A figure from last year's ledger or register", reference "Signed FY2025 statements, note 9 page 14",
   date 2025-12-31, amount 16,000.00, TZS, whole units; tick the confirmation. Optional: enter the printed gross 20,000.00
   and accumulated 4,000.00 — step 2 then bridges the gross amounts too.
3. **Read the recorded preparation**, then **Load the recorded classes**. Expect: Equipment with 16,000.00 / 14,000.00
   and the recorded depreciation 2,000.00; empty gross boxes; no life or rate pre-filled.
4. Step 3: split Equipment into Equipment and Motor vehicles (Add a class). Equipment: opening 12,500 / 2,500 / 0 /
   10,000; closing 12,500 / 3,750 / 0 / 8,750; depreciation 1,250 from the register report. Motor vehicles: 7,500 /
   1,500 / 0 / 6,000; 7,500 / 2,250 / 0 / 5,250; depreciation 750. Name the accounts. Expect each class "all agree" and
   the statement check "agree to the server statement line". Type 1,000 instead of 1,250 once: expect "difference
   25000" named and nothing changed for you; correct it; re-tick the coverage box.
5. Estimates per class: cost; straight-line; 10 years; residual 0; full period; charge from the register; "no" change;
   rationale and evidence. Try "as per TRA class 2": expect the refusal. For a component case, choose "calculated here"
   and add two components (4,000 over 5 years; 6,000 over 15 years): expect 1,200.00 and a named difference from the
   schedule's charge.
6. Step 4: add a destination "Distribution, administrative and other expenses (by function)" 2,000.00 with the ledger
   reference. Expect "account for the whole charge". Try 1,500.00: expect the difference named.
7. Step 5: answer the five entity questions (restrictions, commitments, impairment assessment, events after the period,
   framework history) and recognition/components per class. For "none", give who checked and what. Expect no lease,
   grant, spares, addition or disposal questions unless you set those facts. Add an addition of 500.00 to Equipment:
   expect the cost question; tick "replacement" and "interest included": expect the replacement follow-up and the stop
   on expensed items.
8. Step 6: read the three proposals; **Prepare the three note proposals**; read each WHOLE note (existing wording first);
   tick reviewed; **Record every class, the answers and the reviewed notes together**. Expect "Recorded: workpaper …",
   the PPE schedule status "Reconciled" with two classes, and the notes carrying the existing wording plus the section.
9. Have a colleague record a different schedule meanwhile, then save again: expect "The equipment schedule changed…",
   every figure retained, and the colleague's class loaded on re-reading.
10. Next period: Read the recorded preparation and expect last year's answers offered for explicit reuse.

Expected results above are arithmetic on synthetic inputs; they are not accounting advice and await the accounting
author's signature.

## 7. Unsupported cases and limitations (honest list)

- **Revaluation model**: selectable and disclosed as unsupported; revaluation gains in other comprehensive income remain
  `REPORTING_CASE_UNSUPPORTED` on `main`; no surplus tracking; 17.33 items are one reviewed answer, not five fields.
- **Land and buildings** (17.8, land not depreciated): no separate treatment; a class may be named "Land" but nothing
  prevents a depreciation movement on it (documented limitation, R-05).
- **Investment property at cost**: shares the movement vocabulary; no class-level distinction (R-01).
- **Business combinations and transfers to investment property**: accepted as signed columns with a source; no
  Section 19 / 16 logic.
- **Impairment measurement**: recorded as an answer with a governed-workpaper reference; the reversal cap (27.30) is a
  question, not a calculation; no cash-generating-unit allocation.
- **Finance leases, grants, dismantling, deferred payment, transition**: follow-up questions and policy sentences only;
  no present-value calculation, no provision schedule link, no restatement proposal is created from the bridge
  (adjustments remain workpaper facts; restatements go through Comparatives as before).
- **Conditional questions** are evaluated in the browser; the server enforces the always-mandatory ones
  (`QUESTION_UNRESOLVED`) and refuses when the browser reports unresolved conditional ones (`QUESTIONS_UNRESOLVED`); a
  tampering client could omit a conditional question — the recorded answers make that visible, not impossible.
- **Depreciation calculation** is advisory: compared with the schedule's charge on the page, never written into the
  schedule; the server stores the declared items but does not recompute.
- **Pack rows** for 10.18, 20.13, 24.6, 27.32, 35.13 are not added (register slice, separate PR per #209 §5.4); the
  proposals carry the wording into the existing policies / estimates / subclassifications notes.
- **Events after the period** feeds the proposal text; the `smes.note.events_after` decision is still recorded on Notes.
- **Payload bound**: the workpaper table's 120,000-byte limit (20261205100000) applies; roughly 10–20 classes with
  items and answers fit; the server refuses larger payloads (`invalid_request`).
- **Accessibility and widths**: checked in the journey at 1280 and 375 px without the harness sidebar; the real
  workspace shell was not exercised (no local Supabase stack here); the Real-application e2e job does not yet cover
  this page.
- **Hosted**: nothing applied, deployed or published; the 20261205100000 and 20261206100000 sources are pending; CI's
  disposable PostgreSQL is the only database these ran on.

## 8. What this record does not claim
That any requirement is validated, that any report complies, that the hosted project matches `main`, or that the
expected results suit any real entity.
