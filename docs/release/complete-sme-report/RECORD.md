# One complete SME report: record

Branch `feat/complete-sme-report` (from main `db6cef7`, 2026-10-28). Scope: finish ONE complete SME report through the
product's existing controls and nothing else; identify, not build, what the product lacks. No broad feature was added.
No merge, deployment, hosted apply, Lovable contact or paid API use.

## 1. What was asked, what was done

| # | Asked | Done | Where |
|---|---|---|---|
| 1 | Finish equipment on the published test company's synthetic register: opening reconciliation, depreciation, applicable questions, proposed notes; save, reload, verify retention | Done on a disposable replica of the hosted demo company's acceptance-r1 engagement (the hosted company is not reachable from this repository: no credentials, no readback). The register (`equipment-guided-start-r1/fixtures`, E-001) is prepared through `fs_save_equipment_workpaper_v2` / `fs_commit_equipment_preparation_v2`: the server recalculates E-001 at 2,000.00, the schedule reconciles to the 14,000.00 line, the three whole notes are written from the page's own proposals, seven answers recorded as facts; a draft is read back identical and the recorded preparation is read back identical after a fresh read. In the real browser (headless Chrome over the loopback bridge) the page is left and opened again and the recorded preparation is restored exactly. The hosted run is an owner-run script. | `scripts/db-proof/completeSmeReport.mjs` cases `c1.equipment.*`; `scripts/browser-acceptance/equipmentJourney.mjs` check "after leaving the page and opening it again…"; `HOSTED_RUN.md` |
| 2 | Resolve the 15 outstanding note requirements; never "not applicable" to clear a blocker | Every requirement of the pack (32 rows: 22 notes-section rows, 5 statement rows, the period rule, 4 comprehensive-income decisions) is enumerated before and after, with the control used (section 3). Every decision carries its basis; case 2 makes the related-party and post-period requirements APPLICABLE with disclosures. The count 15 on the hosted company could not be read from here; on the replica the product's own status after the acceptance setup lists 13 placeholder-worded disclosures and 2 statements awaiting evidence, 15 rows that are not final (section 3). | cases `*.notes.outstanding-before`, `*.notes.every-requirement-resolved`; `evidence/completeSmeReport.evidence.json` |
| 3 | Complete comparatives and statement reconciliations (prior-year figures; cash flow, equity, supporting schedules) | The six evidence files (ledgers, equity movements, cash map, prior-period statements) stored; every row of EXPECTED_TOTALS.csv equal on the stored document, current and comparative; eight cross-statement ties asserted directly on the document (section 4); the sign-off rules report no blocker. | cases `*.statements.*` |
| 4 | Run authorised review and issuance under the existing policy; preserve historical FINAL records; verify the downloaded pack against its recorded seal | Policy in force `separate_approvers`; partner REVIEWED; the partner's own FINAL refused (`SIGNOFF_SEPARATE_APPROVERS_REQUIRED`); owner FINAL. Official pack issued through the browser client's path with the Edge Function's own module over the proof database; the saved bytes hash to the sealed digest; verify intact/official; retrieve returns the same bytes. A later wording change leaves the FINAL publication, binding, report row, issuance row and sealed bytes byte-identical. | cases `*.review.*`, `*.issuance.*`, `*.final.*` |
| 5 | Obtain accountant acceptance; then test a second, materially different SME case without coaching | Accountant acceptance is NOT obtained: no qualified accountant has reviewed this work (section 7). The second case (Mwanza Agro, section 5) ran through the same runner with new data only and exposed three product gaps, one of them a sign-off blocker (section 6). | `static.one-runner-no-case-branch`; `case2-mwanza-agro/` |

## 2. Boundary

- Hosted: the demo company (`659daa94-…`) is the only company with reporting enabled; nothing here can reach it. Case 1
  replicates its acceptance-r1 engagement from the same files and the same setup steps (ACCEPTANCE_R1_DEMO_SETUP.md,
  Path B), including the placeholder wording and the one-row PPE schedule, then completes it. `HOSTED_RUN.md` is the
  owner-run counterpart, step by step with expected screen text.
- Disposable: embedded PostgreSQL (CI: an empty loopback database), the whole migration chain, the real
  `process-trial-balance` handler, the real RPCs under the users' own `auth.uid()`, the real `reportingPackSeal.mjs`
  module with an in-memory private bucket.
- Synthetic: every figure, name and wording is invented for the test and says so.

## 3. The requirements, before and after (case 1; case 2 in the evidence file)

Status words are the product's (`fs_notes_status`). "Placeholder" marks wording from `notes_wording_FY2025.csv`, which
that file itself labels "NOT a reviewed disclosure". The 13 placeholder disclosures plus the two statements awaiting
evidence are the 15 rows that are not final after the acceptance setup; the fixture's `(acceptance placeholder)` marker
appears on 11 of the 13 (compliance and identification carry different placeholder text), which is why the proof's
automatic count reads 11.

| Requirement | Before | Control used | After |
|---|---|---|---|
| smes.note.compliance | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.identification | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.policies | provided (placeholder) | fs_commit_equipment_preparation_v2: reviewed whole note (general policies + `policyProposalV2`) | provided, source "Reviewed equipment workpaper …" |
| smes.note.judgements | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.estimates | provided (placeholder) | fs_commit_equipment_preparation_v2: reviewed whole note (general + `estimatesProposalV2`) | provided |
| smes.note.subclassifications | provided (placeholder) | fs_commit_equipment_preparation_v2: reviewed whole note (general + `equipmentNoteProposalV2`) | provided |
| smes.note.share_capital | decided applicable at setup; provided (placeholder) | fs_record_disclosure | provided |
| smes.schedule.ppe | reconciled (one net row from the fixture) | fs_commit_equipment_preparation_v2: the register-based class through `fs_record_schedule` | reconciled, 14,000.00 = composed line |
| smes.schedule.investment_property_cost / _fair_value, intangibles, provisions | not_applicable (no carrying amount on the composed statement at either date) | none needed: the product decides from the composed statements | not_applicable |
| smes.note.early_application | not_applicable (the edition is applied from its effective date) | none needed | not_applicable |
| smes.note.going_concern | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.authorisation | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.kmp_compensation | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.cash_components | provided (placeholder) | fs_record_disclosure | provided |
| smes.note.income_tax | provided (placeholder); applies because sci.tax_expense carries an amount | fs_record_disclosure | provided |
| smes.note.revenue | provided (placeholder); applies because sci.revenue carries an amount | fs_record_disclosure | provided |
| smes.note.events_after | not_applicable, reason "No non-adjusting event after the synthetic period" (scenario.md: checked to 28 February 2026) | decision kept; the equipment question `events_after` answered none-with-basis | not_applicable |
| smes.note.related_party_control | not_applicable, reason "no parent or controlling party" | decision kept (scenario fact) | not_applicable |
| smes.note.related_party_transactions | not_applicable, reason "No related party transaction in the synthetic periods" | decision kept (scenario fact) | not_applicable |
| smes.sci.5_5_e / 5_5_g / 5_5_h | not_applicable with the fixture's reasons | decisions kept | not_applicable |
| smes.sci.5_5_i | composed | none needed | composed |
| smes.set.sfp / sci / notes; smes.period.annual | composed / derived / satisfied | none needed | unchanged |
| smes.set.socie, smes.set.scf | evidence_missing | the six evidence files on the Sign-off page (step 3) | evidence_present, no blocker |

Case 2 starts from nothing (21 outstanding: 13 missing, 8 undecided) and resolves every row the same way, with
`smes.note.events_after`, `related_party_control` and `related_party_transactions` decided APPLICABLE and worded, and
5.5(e)/(g)/(h) decided not applicable with the entity's own reasons (the M-2 sale is an asset disposal within
continuing operations, not a discontinued operation).

## 4. Figures and reconciliations on the stored document

Case 1 (acceptance-r1, TZS): assets 33,000.00 / 28,800.00; equity 21,000.00 / 16,600.00; liabilities 12,000.00 /
12,200.00; PBT 6,000.00 / 3,800.00; profit 5,100.00 / 3,100.00; operating cash 6,200.00 / 4,700.00; financing
-1,700.00 / -1,700.00; closing cash 12,500.00 / 8,000.00; equity closing 21,000.00 / 16,600.00; PPE schedule 14,000.00.
Case 2 (Mwanza Agro): assets 42,850.00 / 41,850.00; equity 32,450.00 / 30,250.00; liabilities 10,400.00 / 11,600.00;
PBT 4,400.00 / 2,050.00; profit 3,200.00 / 1,250.00; operating 6,506.00 / 4,230.00; investing -13,208.00 / 50.00;
financing -3,000.00 / -1,000.00; closing cash 6,338.00 / 16,040.00; equity closing 32,450.00 / 30,250.00; PPE 27,012.00.

Ties asserted on the document in both cases (all agree): closing cash = financial-position cash (current and
comparative); current opening cash = comparative closing cash; closing equity = financial-position equity (both
periods); PPE schedule closing and opening = the PPE line (current and comparative); the classes' depreciation = the
trial balance's depreciation expense, within its presented line; the sign-off rules (cash roll-forward, equity casting,
schedule, comparative-as-issued) report no blocker.

## 5. Review, issuance and history (both cases)

- Policy `separate_approvers` (the default; `fs_signoff_policy`). REVIEWED by the partner. The partner's FINAL refused:
  "SIGNOFF_SEPARATE_APPROVERS_REQUIRED: the final approval must be recorded by someone other than the reviewer".
  FINAL by the owner. Publications exactly `v3:REVIEWED, v3:FINAL`.
- Official pack: `issue_official_reporting_pack` then the `seal-reporting-pack` module (issue, store, seal). Case 1:
  343,244 bytes, SHA-256 `dc75ae19…a790a`, sealed digest identical, verify intact and official, retrieve identical,
  local hash of the retrieved document = sealed hash. Case 2: 370,058 bytes, `4ed30ac7…2253f`, likewise.
- After a later wording change: FINAL rows and sealed bytes byte-identical, verify still intact, the FINAL version is
  stale (`REPORTING_DEPENDENCIES_STALE`, `SERVER_COMPILATION_STALE`), signing it again refused, a new version (v4) saved
  while the history keeps `v3:FINAL`.

## 6. What the second case exposed (identified, not built)

Case 2 was written as new data only; the runner has no case-specific branch (`static.one-runner-no-case-branch` reads
its own source). Three things stopped it before it reached FINAL. Each is a product capability to decide on, not a
fixture to coach around; the case was changed only where no existing control existed, and the change is stated.

**DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001 (sign-off blocker).** An account that exists only in the current
year's trial balance (here the disposal gain, 84200) blocks sign-off: the compiler's `subtotal-casting` rule returns
`INSUFFICIENT_EVIDENCE` on `line:sci:sci.other_income` for the comparative period because the account's detail line has
no comparative fact, while `fs_statement_composition` presents a comparative amount of 0 for the same line from zero
accounts (an inferred zero, against the product's own discipline). The one existing control, a nil-balance row for the
account in the prior trial balance, is dropped at certification (`process-trial-balance`: "Skip pure-zero sentinel
rows"). No existing control resolves it. The case was changed so the prior year also carries the account (a fully
depreciated tool sold for 50.00); that is the only reason case 2 reaches FINAL. A real SME whose chart gains an account
cannot sign off today. Product decision needed: treat an account absent from a certified, complete comparative trial
balance as nil for casting (and present it so), or accept a declared-nil account row.

**GAP-DECLARED-NIL-LINE (existing control, awkward).** A cash-flow line or an equity movement with a figure in one period
and no evidence row in the other (dividends paid; equipment purchases; the comparative had neither) makes the
comparative subtotal, the net increase and the closing cash disappear (`SUBTOTAL_OMITTED_MISSING_LINE`) and the equity
closing fail casting. The existing control is an explicit zero-amount evidence row with the SAME label in both periods
(the equity line's identity includes its description). Used here (comparative ledger rows P6 and P8; a 0.00 dividend
row). A first-class "no such item this period" declaration would be the honest capability.

**GAP-CLASS-LIFE-RANGE.** A class estimate carries one useful life (`ESTIMATE_INCOMPLETE` without a numeric class life;
the estimates proposal states that single life). A class whose items have different lives (the first draft of case 2:
8, 10 and 15 years) cannot be disclosed truthfully through the class estimate although paragraph 17.31(c) allows a range.
The case was changed to uniform lives per class (10 and 5 years). Capability to add: a useful-life range per class.

Also observed, not a gap: re-deciding an already-certified account's classification on the current upload makes the
prior certification stale by design; the product asks only for accounts not yet decided, and the proof does the same.

## 7. Accountant acceptance

Not obtained. No qualified accountant has reviewed the wording, the decisions or the expected figures; the EXPECTED
totals and the register figures are author-calculated. The record lists what an accountant would accept or reject:
the resolution table (section 3), the wording in both `scenario.json` files, the reconciliations (section 4) and the
owner-run script (`HOSTED_RUN.md`). Until that review is recorded, every accounting result here is "pending qualified
review", as the equipment-r2 record already states.

## 8. Evidence and how to run

- `evidence/completeSmeReport.present.json` (28/28, `PROOF RESULT VALID (present)`), `evidence/completeSmeReport.evidence.json`
  (per case: composition, outstanding-before rows, the questions asked, the server's per-item recalculation, the
  resolution table, versions, figures, ties, review, issuance digests, history), `evidence/completeSmeReport.present.log`.
- `evidence/equipmentJourney.results.json` and `.log`: 9/9 in headless Chrome, including "after leaving the page and
  opening it again, the recorded preparation is read back and restored explicitly".
- Run: `DB_PROOF_MODULES_DIR=<dir> bun scripts/db-proof/completeSmeReport.mjs`, then
  `node scripts/ci/validateProofResult.mjs proof-results/completeSmeReport.present.json --manifest scripts/db-proof/completeSmeReport.manifest.mjs --mode present`;
  `node scripts/browser-acceptance/equipmentJourney.mjs <outDir>`. CI runs both (Disposable-DB job; browser-journey job).

## 9. Not done

- Nothing on the hosted company (owner-run script only). No second hosted engagement: case 2 needs a company with a
  year to 30 June, which the owner would have to create.
- The three gaps above are not fixed. Nothing else was added to the product: no migration, no component change.
- Only the equipment schedule is prepared from a register; the other schedules are not applicable in either case.
