# SME 2015 equipment: acceptance cases

**Status:** accounting-content candidate, qualified review pending (author and reviewer unassigned). Every case names
the requirement rows it serves (REQUIREMENTS_MATRIX.md), its inputs, the expected result with arithmetic, and whether PR
#207 at `a7182309367ae75c950bf6ba03e6d1d216811a57` already covers it (with the test or proof that shows it) or whether
it is proposed. Expected results are the arithmetic consequence of the inputs under the cited paragraphs; they are not
accounting advice for any real entity, and every amount is synthetic.

Conventions: currency TZS with exponent 2 (minor units = cents); amounts shown as whole currency units unless stated;
"minor" means the exact integer string the server stores (`16,000.00` = `1600000`). Movement signs follow the pack
(`src/lib/frameworkPacks/ifrsForSmes.ts:209-218`): additions and business combinations increase, disposals and
depreciation decrease, the rest are signed. The existing SME fixture is F1 in the facts table (opening 16,000.00,
depreciation 2,000.00, closing 14,000.00; `docs/release/acceptance-r1/ppe_schedule_FY2025.csv:2`).

## A. Opening bridge and prior report (R-02, R-22, R-27)

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-01 | positive | F1: prior report page confirmed, printed 16,000.00 whole units, prior date = saved prior end, currency TZS; opening 16,000.00; no adjustments; depreciation 2,000.00; closing 14,000.00; server PPE line 14,000.00; gross opening 20,000.00 / acc dep 4,000.00 / imp 0; gross closing 20,000.00 / acc dep 6,000.00 / imp 0; policy answers complete | Bridge agrees (difference 0). Movements agree: 16,000 - 2,000 = 14,000 = server line. Gross agrees at both dates (20,000 - 4,000 = 16,000; 20,000 - 6,000 = 14,000). Schedule row recorded: `{classLabel:"Equipment", openingMinor:"1600000", closingMinor:"1400000", movements:[{kind:"depreciation", amountMinor:"-200000"}]}`; server status `reconciled` (or `reconciled_opening_unverified` without an approved comparative). Expectation added by this document: the depreciation movement (2,000.00) must equal the composed depreciation expense (R-13), which no check performs today. | Covered: `equipment.test.ts:29-56`, `equipmentRequirements.test.ts:25-30`, `EquipmentPreparation.test.ts:157` | existing + proposed tie-out |
| AC-02 | negative | As AC-01 but opening 16,500.00, no adjustments | Bridge state `difference`, difference +500.00; message tells the user to explain with supported adjustments; no balancing asset; Record disabled | Covered: `equipment.test.ts:73-79` (shape), `openingBridge` `:105-118` | existing |
| AC-03 | positive / negative | Prior 16,000.00; adjustment +200.00 with reason "Approved correction J1" and evidence "Journal J1, approval 2026-02-01"; opening 16,200.00. Negative variant: same adjustment with empty evidence | Positive: bridge agrees (16,000 + 200 = 16,200); the prior printed figure is unchanged. Negative: state `incomplete`, "Each opening adjustment needs an exact amount, reason and evidence." Expectation added: a bridge adjustment that changes a comparative amount must be linked to `fs_propose_restatement` before the report can be reviewed (R-27, G-6). | Covered: `equipment.test.ts:57-72`, `:93-113` | existing + proposed link |
| AC-04 | positive / negative | Printed-units normalisation: (a) "16" with units thousands, exponent 2; (b) "16,000" with units thousands; (c) "(2,000)" whole units; (d) "16.1234" with units thousands | (a) 16,000.00 = `1600000`; bridge agrees with opening 16,000.00. (b) 16,000,000.00 = `1600000000`; bridge difference 15,984,000.00; refused. (c) -2,000.00 = `-200000`. (d) `1612340` = 16,123.40. Malformed "1,2", "1e3", "1.001" return null and block confirmation. | Covered: `equipment.test.ts:165-171` | existing |
| AC-23 | negative (proposed) | Prior-year note shows closing gross 20,000.00 and accumulated depreciation 4,000.00; preparer enters opening gross 21,000.00 and acc dep 5,000.00 (net still 16,000.00) | Net bridge agrees but the gross opening does not agree to the prior report by +1,000.00 / +1,000.00; expected: a gross-level bridge difference that blocks until explained (R-22). Today only the net is bridged, so this passes silently. | Not covered | proposed |
| AC-24 | negative | Saved prior end 2025-06-30, saved current start 2025-07-01; user types prior date 2024-12-31 | Anchor = 2025-06-30 (`openingAnchorDate`); fact.periodEnd differs from the anchor; state `incomplete`, "Resolve the entity, period, currency or unit difference". With no prior TB, anchor = day before current start (2026-07-01 gives 2026-06-30; 2024-03-01 gives 2024-02-29) | Covered: `equipment.test.ts:173-178`, `EquipmentPreparation.test.ts:149` | existing |
| AC-25 | negative | Manual source mode, reference text empty | `incomplete`, "A reviewed source reference is required for a manually entered figure."; no document hash or audited status is implied | Covered: `equipment.test.ts:151-163`, `EquipmentPreparation.test.ts:261` | existing |
| AC-26 | negative | PDF page from a different entity's statements (entity name differs from the workspace legal name) | `incomplete`; the figure cannot be confirmed for this entity | Covered: `equipment.test.ts:80-92` | existing |
| AC-30 | proposed | First IFRS for SMEs statements; prior framework closing 15,000.00; fair value elected as deemed cost 20,000.00 at transition | Bridge needs a "transition adjustment" reason category (+5,000.00) with the 35.13 explanation; today the only path is an unnamed adjustment (R-31) | Not covered | proposed |

## B. Movement schedule (R-13, R-20, R-23, R-32)

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-05 | negative | Opening 16,000.00, closing 14,000.00, no movements, coverage box ticked | movementDifference = 14,000 - 16,000 - 0 = -2,000.00; "The movement schedule does not add up."; nothing is inferred as depreciation | Covered: `equipment.test.ts:115-127` | existing |
| AC-06 | positive (proposed detail) | Opening 14,000.00; additions 5,000.00; disposal of one item (cost 4,000.00, acc dep 2,500.00, carrying 1,500.00, proceeds 1,800.00); depreciation 2,300.00; closing 15,200.00; server line 15,200.00; gross opening 20,000 / 6,000; gross closing 21,000 / 5,800 | Schedule: 14,000 + 5,000 - 1,500 - 2,300 = 15,200; agrees. Gross: 20,000 + 5,000 - 4,000 = 21,000; acc dep 6,000 + 2,300 - 2,500 = 5,800; 21,000 - 5,800 = 15,200; agrees. Gain on disposal = 1,800 - 1,500 = 300.00 in profit or loss, not revenue (17.28, 17.30); expectation: the product captures proceeds and shows the gain; the gross roll-forward (cost removed 4,000, acc dep eliminated 2,500) is checked, not only the two-date gross-to-net (G-1) | Arithmetic of the carrying-amount schedule covered by `reconcileEquipment`; proceeds, gain and gross roll-forward not covered | partly existing, rest proposed |
| AC-07 | negative | (a) additions typed as -5,000.00; (b) depreciation stored as +2,000.00 (bypassing the UI conversion) sent to `fs_record_schedule` | (a) server `invalid_schedule` with `MOVEMENT_SIGN` (increase kind negative); (b) `MOVEMENT_SIGN` (decrease kind positive); nothing stored (`20261019100000:336-338`) | Server-side rule exists on `main`; the UI converts positive entries for decrease kinds (`EquipmentPreparation.tsx:277-291`) | existing (server) |
| AC-08 | negative | Schedule closing 14,000.00; server PPE line 13,500.00 | statementDifference +500.00; "The closing schedule does not agree to the server statement line."; if recorded anyway through the plain editor, status `closing_mismatch` with `SCHEDULE_CLOSING_MISMATCH:ppe` blocker | Covered: `equipment.test.ts:128-137`; server `20261019100000:467-469` | existing |
| AC-33 | negative | Movement "other" -2,000.00 with empty evidence | `incomplete`, "Identify register, ledger or reviewed movement-account evidence for every movement." | Covered: `equipment.test.ts:120-126` | existing |
| AC-27 | negative (proposed) | Entity has two classes: Equipment 14,000.00 and Motor vehicles 9,000.00 (server PPE line 23,000.00). Guided path used for "Equipment" only with closing 14,000.00; or for a merged label "Equipment and vehicles" with closing 23,000.00 | First variant: statement difference -9,000.00, refused (correct). Second variant: arithmetic agrees and the whole schedule is replaced by one merged class; 17.31 and 4.11(a) per-class disclosure is lost without any arithmetic signal. Expected: the guided path refuses to replace a multi-class schedule, or supports classes (G-4) | Replacement confirmation only (`EquipmentPreparation.test.ts:193`) | proposed |
| AC-31 | negative | Composition SHA changes after the preparer reviewed the figures | Save blocked; workpaper kept; "Review refreshed statement figures" required before saving | Covered: `EquipmentPreparation.test.ts:233` | existing |
| AC-32 | positive / negative | Same request id replayed with identical payload; same request id with a changed payload | Replay returns the original receipt with `replay:true`; changed payload returns `request_reused`; concurrent identical saves record one workpaper | Covered: `scripts/db-proof/equipmentPreparation.mjs:101`, `:124`, `:271` (CI container) | existing (candidate SQL) |

## C. Gross amounts (R-22)

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-09 | negative | Opening impairment left blank; everything else as AC-01 | `incomplete`: "gross amounts or deductions are still missing"; blank is not zero | Covered: `equipmentRequirements.test.ts:39-56` | existing |
| AC-10 | negative | As AC-01 but closing acc dep 5,000.00 | closingDifference = 20,000 - 5,000 - 0 - 14,000 = +1,000.00; state `difference` | Covered: `equipmentRequirements.test.ts:31-37` | existing |
| AC-34 | positive (proposed) | Closing gross 20,000.00, acc dep 5,000.00, acc impairment 1,000.00, carrying 14,000.00 | Agrees (20,000 - 5,000 - 1,000 = 14,000). Disclosure expectation: 17.31(d) presents accumulated depreciation aggregated with accumulated impairment (6,000.00); the preview may show them separately as long as the aggregate is also stated | Arithmetic covered; disclosure presentation not | partly |

## D. Estimates, methods and the depreciation charge (R-12, R-14 to R-18, R-26)

These cases give a deterministic expected charge so that a future advisory check can recompute it. The lives and
residual values are synthetic inputs, not recommendations.

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-11 | positive (proposed) | One machine, cost 10,000.00; motor component 4,000.00 with 5-year life; frame 6,000.00 with 15-year life; residual 0; straight-line; full year | Component charge = 4,000/5 + 6,000/15 = 800 + 400 = 1,200.00. Single-asset alternative with a 10-year life would be 1,000.00. Expected: when Q2 is answered "yes", the class charge is checked against the component sum, and the difference (200.00) is surfaced | Free-text answer only | proposed |
| AC-12 | positive (proposed) | Asset cost 12,000.00, residual 0, original life 6 years, straight-line; after 2 years carrying 8,000.00; at the start of year 3 the remaining life is revised to 2 years | New annual charge = 8,000 / 2 = 4,000.00 (prospective, 10.16); prior years not restated; 10.18 disclosure: nature (shorter life) and effect on the current period = 4,000 - 2,000 = +2,000.00 expense. The estimates note names the class and its carrying amount (8.7) | Not covered | proposed |
| AC-13 | positive / negative (proposed) | (a) Cost 9,000.00, residual 1,000.00, life 4 years, straight-line, available for use at the start of the year. (b) Same asset, residual revised to 9,500.00. (c) Units of production: depreciable amount 8,000.00, total expected output 100,000 units, output this year 12,000 units. (d) Asset available for use on day 274 of a 365-day year | (a) 2,000.00 per year. (b) Residual exceeds the carrying amount: charge is 0, never negative. (c) 8,000 x 12,000 / 100,000 = 960.00. (d) Charge starts at the available-for-use date (17.20): pro-rata 2,000 x 92/365 = 504.11 under a daily convention; the convention is an entity policy that must be recorded, so the expected value is "2,000.00 x (days available / days in year) under the recorded convention" | Not covered; no computation exists | proposed |
| AC-35 | negative (proposed) | Useful life entered as "as per TRA class 2 (25%)" or "per KPMG template" | The answer is refused as evidence: tax rates and templates are not the entity's estimate (R-14; Q4 accepted evidence). Expected: a validation message, not silent acceptance | Free text accepted if at least 3 characters | proposed |

## E. Recognition, cost and subsequent expenditure (R-03, R-04, R-06 to R-09, R-11)

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-17 | positive (proposed) | During the year: routine servicing 300.00; replacement of a major part costing 2,000.00 whose replaced part had a carrying amount of 500.00; a spare part 700.00 expected to be used over 3 years | Servicing: expense (17.15 last sentence). Replacement: addition +2,000.00, derecognition of the replaced part -500.00 (17.6; shown as disposals or other changes with evidence). Spare: PPE addition +700.00 (17.5), not inventory. Net additions in the schedule +2,700.00; decreases -500.00 | Not covered | proposed |
| AC-20 | positive (proposed) | Equipment cost 10,000.00; legal obligation to dismantle at end of use; present value of the estimate 1,500.00 | Addition = 11,500.00 (17.10(c)); provision 1,500.00 recognised (21.4, 21.5) and shown in the provisions schedule; the provisions schedule and the PPE addition appear in the same period | Not covered | proposed |
| AC-21 | positive (proposed) | Price 10,000.00 payable in two years with no stated interest; cash price equivalent 8,900.00 | Addition = 8,900.00 (17.13); 1,100.00 is finance cost over the two years (11.13 financing transaction); the schedule does not show 10,000.00 | Not covered | proposed |
| AC-22 | negative (proposed) | Self-constructed equipment: materials 6,000.00, installation 800.00, interest on the construction loan 400.00, staff training 250.00 | Cost = 6,800.00; interest (25.2, 17.11(e)) and training (17.11(c)) are expensed. Expected: entering 7,450.00 as the addition is flagged when the cost build-up follow-up records interest or training inside it | Not covered | proposed |

## F. Impairment, revaluation, restrictions, leases, grants, events (R-10, R-19, R-24, R-25, R-28 to R-30)

| Id | Type | Inputs | Expected result | #207 today | Status |
|---|---|---|---|---|---|
| AC-14 | positive (proposed) | Carrying amount 14,000.00 at the reporting date; indicator: machine damaged; recoverable amount 11,000.00 (governed workpaper) | Impairment loss 3,000.00 in profit or loss (27.5); movement `impairment_profit_or_loss` `-300000`; accumulated impairment at the end 3,000.00; 27.32(a) disclosure names the amount and the line item. Reversal case next year: recoverable amount 13,500.00 but the carrying amount that would have existed without the impairment is 12,600.00: reversal limited to 12,600.00 less the current carrying amount (27.30), never above it | Movement kind exists; no assessment, cap or disclosure | proposed |
| AC-28 | positive (proposed) | Board decides in November to sell a machine in March, earlier than planned | 17.26 / 27.9(f): an impairment indicator; the F-IMPAIRMENT follow-up must fire and a recoverable amount must be considered; depreciation continues until derecognition (17.20) | Not covered | proposed |
| AC-15 | positive / negative | Basis = revaluation (positive: the revaluation question appears; negative: basis = cost, the question is absent). Extended: revalued class, surplus 2,500.00 at the start, revaluation increase 1,000.00 this year | Existing: conditional question behaviour. Expected additions: 17.33(a)-(e) answered individually; movement `revaluations_and_oci_impairment` `+100000`; surplus 3,500.00 at the end; and the product stops at the unsupported OCI case on `main` (`REPORTING_CASE_UNSUPPORTED:smes.sci.5_5_g`) instead of presenting a finalisable report | Conditional question covered: `equipmentRequirements.test.ts:58-80`; the rest not | partly |
| AC-16 | positive / negative (proposed) | (a) Equipment with carrying amount 5,000.00 pledged for a bank loan; signed contract for a 3,000.00 machine not yet delivered. (b) Nothing pledged, no contracts; management confirmation dated and signed | (a) 17.32(a): pledged carrying amount 5,000.00 disclosed; 17.32(b): commitment 3,000.00 disclosed; the commitment is not in the schedule. (b) "None" accepted only with the confirmation reference; a blank or "n/a" without a basis is incomplete | One free-text field with a 3-character minimum | proposed |
| AC-18 | positive (proposed) | Machine under a finance lease: fair value 8,000.00; present value of minimum lease payments 7,600.00; lease term 4 years; useful life 6 years; no transfer of ownership | Recognise 7,600.00 (lower of the two, 20.9); depreciate over 4 years (20.12): 1,900.00 per year; the lease liability is a financial liability (4.2(m)); 20.13(a) discloses the net carrying amount of leased equipment per class | Not covered | proposed |
| AC-19 | positive (proposed) | Equipment costing 10,000.00 bought with a government grant of 2,000.00 that has no future performance conditions | Addition 10,000.00 (not net of the grant); grant income 2,000.00 when receivable (24.4(a)); 24.6(a) discloses the grant. With a performance condition not yet met: liability 2,000.00 (24.4(c)) and 24.6(b) discloses the unfulfilled condition | Not covered | proposed |
| AC-29 | positive (proposed) | A 6,000.00 machine ordered and delivered 20 days after the year end | Non-adjusting event (32.10, 32.11(c)): nature and amount disclosed through the existing `smes.note.events_after` decision; no change to the schedule | Not covered in the guided path | proposed |

## G. Server and workflow controls already proven for the candidate (for completeness)

These are not accounting cases but are listed so the handoff does not re-propose them.

| Id | Behaviour | Where proven |
|---|---|---|
| AC-40 | A refused schedule rolls back the newly inserted workpaper; a stale note rolls back both | `scripts/db-proof/equipmentPreparation.mjs:293`, `:323` |
| AC-41 | A newer schedule is refused before any atomic write (`stale_schedule`) | `:344` |
| AC-42 | Whole-note review preserves existing wording; another writer's newer text causes refusal, not overwrite | `:173`, `:193`, `:206`; `workpaperClient.test.ts:4` |
| AC-43 | A mismatched source digest is refused; a missing original is never claimed retained | `:453`, `:120` |
| AC-44 | Viewer, outsider and revoked preparer read no preparation data | `:81`, `:468` |
| AC-45 | An unknown write outcome keeps its request identity and is retried unchanged | `EquipmentPreparation.test.ts:182`, `EquipmentServerBridge.test.ts:157` |

## H. Coverage summary

| Area | Existing cases | Proposed cases |
|---|---|---|
| Opening bridge and prior report | AC-01 to AC-04, AC-24 to AC-26 | AC-23, AC-30 |
| Movement schedule | AC-05, AC-07, AC-08, AC-31 to AC-33 | AC-06 (proceeds, gross roll-forward), AC-27 |
| Gross amounts | AC-09, AC-10 | AC-34 |
| Estimates and depreciation | none | AC-11, AC-12, AC-13, AC-35 |
| Recognition and cost | none | AC-17, AC-20, AC-21, AC-22 |
| Impairment, revaluation, restrictions, leases, grants, events | AC-15 (conditional question only) | AC-14, AC-16, AC-18, AC-19, AC-28, AC-29 |

Every proposed case needs its expected result re-derived and signed by the accounting author and checked by the
independent reviewer before it becomes a golden fixture (charter section 6).
