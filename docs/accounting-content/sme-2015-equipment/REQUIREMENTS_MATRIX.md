# SME 2015 equipment coverage: requirements matrix

**Status:** accounting-content candidate. Prepared 2026-10-27 as evidence for charter Step 0 (facts table, gap list) and B5
(framework register rows) of the development charter candidate in PR #208. Qualified accounting review has not happened:
the accounting author and independent reviewer columns are **unassigned** throughout. Nothing in this document is a
compliance certification, and no claim of IFRS for SMEs compliance is made for CFOClose, for PR #207, or for any report.

**Scope:** property, plant and equipment under the IFRS for SMEs 2015 edition (pack `ifrs-for-smes/2015`, the only
edition the server composes, reviews and finalises; rule pack 2.2.0), as prepared through the Financial Statements
workspace. Full IFRS, the third edition (2025) and IPSAS are out of scope.

## 0. What was reviewed

| Item | Identity |
|---|---|
| `main` base of this branch | `fb7c547565826b417ca01619713720760de3d166` (merge of PR #205, 2026-10-27) |
| PR #207 head (read-only, `git show`) | `a7182309367ae75c950bf6ba03e6d1d216811a57`, branch `feat/guided-equipment-preparation`, draft, merge-base = `fb7c547` |
| PR #208 head (charter candidate) | `b01ed189065a7e9f67727bf9af209f214adc84ac`, branch `docs/development-charter-v4`, draft, open, no reviews, not merged. **Adoption is not recorded**; the charter's own text says existing repository controls remain authoritative until adoption. |
| Authoritative text | IFRS for SMEs 2015 edition, the PDF already pinned by `src/lib/frameworkPacks/ifrsForSmes.ts:16-26` (SHA-256 `acc6500e58f9090eddc8e2b55bc531f93e718d320c7c40c695898bb82235eb9f`, 1,027,941 bytes). Re-fetched 2026-10-27 from the pinned URL; the bytes hash identically to the repository pin. Paragraph numbers below were read from this text (Section 17 at extracted-text lines 5525-5945; dependent sections located by paragraph number). |
| Educational material | IFRS Foundation, *Module 17 Property, Plant and Equipment* (Supporting Material for the IFRS for SMEs Standard, version 2018-06), fetched 2026-10-27 from the URL used by `src/lib/preparation/equipmentRequirements.ts:5` in PR #207 (SHA-256 `41e48f069c7ef4e739f003b0646d50f2e409ef731e40afa0289615d3dade8732`). The module states it is based on the Standard as issued in October 2015. It is staff material, not approved by the Board, and is used here only to confirm the 2015 amendments to Section 17 (spare parts wording, replacement-cost indicator, revaluation option, cost-model investment property disclosures). It is never cited as the requirement. |
| Hosted evidence | `docs/release/fs-first-slice/HOSTED_EVIDENCE_2026-10-21.md` (staged transports applied hosted). Nothing hosted was read in this session. |

Verification convention in this document: `[2015 text]` means the paragraph was read from the pinned 2015 PDF on
2026-10-27. Paraphrases are short on purpose; the cited paragraph is the authority.

## 1. Baseline: facts table

Status vocabulary follows charter section 2: `deployed` (applied to the hosted project per recorded evidence),
`merged-not-deployed`, `branch`, `candidate` (PR #207, inert), `not built`, plus `unverified` where this session could
not establish the status. Repository evidence and hosted evidence are kept in separate columns.

### 1.1 Implemented on `main` (fb7c547)

| # | Capability | Repository evidence (file:line) | Hosted evidence | Status |
|---|---|---|---|---|
| F1 | PPE presentation line `sfp.property_plant_and_equipment` (4.2(e)); presented only when reviewed accounts are assigned | `src/lib/frameworkPacks/ifrsForSmes.ts:87`, `:180`; `docs/reporting/COVERAGE_IFRS_FOR_SMES.md` row `smes.sfp.4_2_e` (status IMPLEMENTED_NOT_VALIDATED) | FS first slice applied hosted 2026-10-21 (`HOSTED_EVIDENCE_2026-10-21.md:53-62`, hosted ids 65-70); not read back in this session | deployed (per record) |
| F2 | PPE movement schedule definition: eight movement kinds mirroring 17.31(e)(i)-(viii) with sign rules | `src/lib/frameworkPacks/ifrsForSmes.ts:209-220`; seed `supabase/migrations/20261019100000_fs_notes_and_schedules.sql:109` | as F1 (the applied controls/journey batches depend on this function set); not independently read back | deployed (per record) |
| F3 | `fs_record_schedule`: exact integer minor units, known kinds at most once, sign rule, opening + movements = closing per class, class labels unique, idempotent per request, append-only | `20261019100000_fs_notes_and_schedules.sql:284-380` (regex `:305`, sign `:336-338`, repeated kind `:341-343`, adds up `:344-347`, replay `:364-371`, unchanged `:372-374`) | as F2 | deployed (per record) |
| F4 | Schedule reconciliation at status time: `closing_mismatch`, `opening_mismatch`, `reconciled`, `reconciled_opening_unverified`; `not_applicable` when the composed line is zero at both dates | `20261019100000_fs_notes_and_schedules.sql:453-478`; `docs/reporting/NOTES_AND_SCHEDULES.md:21-33` | as F2 | deployed (per record) |
| F5 | Requirement `smes.schedule.ppe` cites 17.31(e); applicability decided from the composed line | `ifrsForSmes.ts:130-131` | as F2 | deployed (per record) |
| F6 | Disclosures tracked as the preparer's own wording, verbatim with source: policies (8.5), judgements (8.6), estimates (8.7), subclassifications (4.11) via `fs_record_disclosure`; missing wording blocks | `ifrsForSmes.ts:119-124`; `COVERAGE_IFRS_FOR_SMES.md` rows `smes.note.policies`, `.judgements`, `.estimates`, `.subclassifications` | as F2 | deployed (per record) |
| F7 | Comparatives: database-composed prior year, two-person restatements beside as-reported figures, reviewer approval | `supabase/migrations/20261020100000_fs_comparatives.sql:54` (restatements table), `:167` (`fs_propose_restatement`), `:226` (`fs_decide_restatement`), `:437` (`fs_comparatives_status`); `COVERAGE_IFRS_FOR_SMES.md` row `smes.comparatives` | as F2 | deployed (per record) |
| F8 | Period dates on the reporting input (`reportingStart`, `reportingEnd`) | `supabase/migrations/20261016100000_fs_reporting_input.sql:72`; `src/lib/reporting/signoff.ts:50` | as F2 | deployed (per record) |
| F9 | Multi-class schedule editor on the Schedules page (any number of classes, any cited movement) | `src/components/reporting/SchedulesView.tsx` (`Entry`, the `recordSchedule` call; at the #207 head lines 94-97) | front end: Lovable deploys `main`; not verified in a browser this session | deployed (per CLAUDE.md section 11), unverified in browser |
| F10 | Existing controlled SME fixture: class `Equipment`, opening 16,000.00, depreciation (2,000.00), closing 14,000.00, source "Fixed asset register 2025 (synthetic)"; placeholder note wording ("Historical cost (acceptance placeholder)", "Useful lives of equipment (acceptance placeholder)") | `docs/release/acceptance-r1/ppe_schedule_FY2025.csv:2`; `docs/release/acceptance-r1/notes_wording_FY2025.csv` rows `smes.note.policies`, `.estimates`; loaded by `scripts/db-proof/acceptanceFixtures.mjs:86-95` | hosted acceptance fixtures proof runs in CI only (`.github/workflows/ci.yml:1234`) | merged (fixture) |
| F11 | Validation status of every SME requirement: no requirement is VALIDATED by a named qualified reviewer | `docs/reporting/COVERAGE_IFRS_FOR_SMES.md:5`, `:14`; `docs/reporting/IFRS_FOR_SMES_PACK.md:38-41` | n/a | fact |

### 1.2 Candidate in PR #207 (a718230), inert

| # | Capability | Repository evidence (file:line at a718230) | Hosted evidence | Status |
|---|---|---|---|---|
| C1 | Guided equipment preparation on the Schedules page; admitted only for a composed `ifrs-for-smes/2015` report and `prepare_close` capability; five steps (Prior report, Opening bridge, Movements, Policy, Save and complete) | `src/components/reporting/EquipmentPreparation.tsx:48-56` (gate), `:638-655` (steps), `:32` (uses the `ppe` definition from the pack) | none; not merged, not deployed | candidate |
| C2 | Prior-report page reading on device (PDF.js text, Tesseract English OCR when text is thin or forced); bounds 20 MiB, 200 pages, 2,000,000 pixels, 120 s | `src/lib/preparation/priorReport.ts:2-4`, `:34-167`; `docs/release/guided-equipment-r1/RECORD.md:34-47` | none | candidate |
| C3 | Source fact for the prior closing carrying amount: document SHA-256 + page, or a manual reviewed reference; entity, period end, currency and printed units must match the workspace; explicit confirmation checkbox | `src/lib/preparation/equipment.ts:3-17`, `:42-119`; `EquipmentPreparation.tsx:248-265`, `:870-895` | none | candidate |
| C4 | Opening bridge: prior closing + signed, reasoned, evidenced adjustments must equal the current opening; residual is a difference, never a balancing entry; anchor date from saved prior end or the day before the saved current start | `equipment.ts:42-119` (`:105-118` arithmetic), `:244-254` (`openingAnchorDate`); `EquipmentPreparation.tsx:160-180`, `:902-982` | none | candidate |
| C5 | Movement reconciliation: opening + movements = closing and closing = server PPE line, checked independently; decrease kinds entered as positive and stored negative; evidence text required; "movement coverage" confirmation | `equipment.ts:122-173`; `EquipmentPreparation.tsx:277-291`, `:1042-1058` | none | candidate |
| C6 | Gross-to-net check at both dates: gross less accumulated depreciation less accumulated impairment = carrying amount; blank is unknown, zero must be typed | `src/lib/preparation/equipmentRequirements.ts:82-123`; `EquipmentPreparation.tsx:1135-1179` | none | candidate |
| C7 | Nine preparation questions with paragraph references (17.4/17.5, 17.16, 17.15-17.15B, 17.18/17.19/17.21, 17.22/17.23, 17.31(d), 17.31(e), 17.32, 17.33), content version `sme-2015-equipment-preparation/1`, source status "independent-accountant-review-pending"; revaluation question conditional on the revaluation basis | `equipmentRequirements.ts:2-80`, `:125-166` | none | candidate |
| C8 | Structured policy answers (asset class, basis cost/revaluation, method straight-line/reducing-balance/units-of-production, useful lives, residual values, rationale, evidence) and an original-wording policy draft; no useful life or tax rate is defaulted | `equipment.ts:24-32`, `:175-201`; `EquipmentPreparation.tsx:1180-1262` | none | candidate |
| C9 | Equipment disclosure preview (gross, accumulated deductions, carrying amounts, movements, component and restriction answers, revaluation answer when applicable) | `EquipmentPreparation.tsx:473-493` | none | candidate |
| C10 | Schedule save through the existing `fs_record_schedule` authority, one class only, whole-schedule replacement confirmation when a schedule already exists | `EquipmentPreparation.tsx:495-556`, `:1292-1305` | none | candidate |
| C11 | Inert SQL: append-only `fs_equipment_workpapers`, `fs_equipment_policy_insertions`, `fs_equipment_context`, `fs_save_equipment_workpaper`, compare-and-set `fs_record_reviewed_equipment_note` (into `smes.note.policies` or `smes.note.subclassifications`), transactional `fs_commit_equipment_preparation` (workpaper + `fs_record_schedule('ppe', ...)` + reviewed note) | `release/candidates/guided-equipment-r1/workpaper.sql:4-26`, `:28-37`, `:39-53`, `:55-86`, `:90-124`, `:130-161` | none; "UNAPPLIED CANDIDATE" (`workpaper.sql:1`) | candidate |
| C12 | Disposable-database proof of C11 (27 named checks: cross-company refusal, replay, stale refusal, rollback of a refused schedule or stale note, source digest mismatch, revoked preparer) | `scripts/db-proof/equipmentPreparation.mjs` (checks at lines 19-468, e.g. `:293` "a refused schedule rolls back its newly inserted workpaper") | CI container only (`RECORD.md:115`) | candidate |
| C13 | Optional original-PDF retention through the existing `financial-statement-intake` function; receipt linked only after the server verifies company and fingerprint | `EquipmentPreparation.tsx:429-455`; `workpaper.sql:79-82`, `:111-112` | none; depends on accepted firm membership and a configured scanner (`RECORD.md:112`) | candidate |

### 1.3 Absent or unverified (neither on `main` nor in #207)

| # | Capability | Evidence of absence | Status |
|---|---|---|---|
| A1 | Any depreciation computation (straight-line, diminishing balance, units of production), useful-life or residual-value register per class, or depreciation start/cease logic | No depreciation calculator under `src/lib/preparation/`, `src/lib/frameworkPacks/` or the SME migrations; #207 accepts the charge as an entered movement only (`equipment.ts:122-173`) | not built |
| A2 | Component accounting (allocation of cost to major components and separate depreciation) | Question only (`equipmentRequirements.ts:18-25`), free text answer | not built |
| A3 | Cost build-up at recognition (purchase price, directly attributable costs, dismantling estimate, excluded costs, borrowing costs expensed, deferred-payment present value, exchanges) | No cost model anywhere; #207 starts from carrying amounts | not built |
| A4 | Gross roll-forward (cost and accumulated depreciation columns with additions, disposals at cost, accumulated depreciation eliminated on disposal) | #207 checks gross-to-net at two dates only (`equipmentRequirements.ts:90-123`); no movement in gross | not built |
| A5 | Impairment indicator assessment, recoverable amount, loss or reversal, 27.32/27.33 disclosure | Movement kinds exist (`ifrsForSmes.ts:213`, `:215`); no assessment or disclosure requirement row for 27.32 in the pack (`ifrsForSmes.ts:69-164`) | not built |
| A6 | Disposal gain or loss (net proceeds less carrying amount) and its P&L presentation | None; #207 evidence text warns disposal carrying amount is not proceeds (`equipmentRequirements.ts:61-62`) | not built |
| A7 | Revaluation surplus tracking, OCI mechanics, 17.33 disclosures | Conditional question only (`equipmentRequirements.ts:72-79`); OCI cases are `REPORTING_CASE_UNSUPPORTED` on `main` (`docs/reporting/NOTES_AND_SCHEDULES.md:53-58`) | not built (unsupported case) |
| A8 | Restricted title, pledges, contractual commitments register (17.32) | Question only (`equipmentRequirements.ts:64-70`) | not built |
| A9 | Change in accounting estimate disclosure (10.18) linked to a changed useful life, residual value or method | None | not built |
| A10 | Finance-lease assets within PPE (Section 20), government grants of equipment (Section 24), transition deemed cost (35.10(c),(d)) | No pack requirement rows for Sections 20, 24 or 35 (`ifrsForSmes.ts:69-164`) | not built |
| A11 | Per-class disclosure where an entity has more than one class (17.31 "for each class"; 4.11(a)) within the guided path | #207 is single class and replaces the whole schedule (`EquipmentPreparation.tsx:608-613`, `:1292-1305`); the multi-class editor (F9) has no questions, bridge or gross check | partial (F9 + C10) |
| A12 | Structured answer storage (charter L8) for the nine questions as reusable facts | #207 stores answers inside the workpaper JSON payload (`workpaper.sql:4-17`), not as requirement-linked answers | candidate (JSON only) |
| A13 | Browser acceptance of the guided path, accountant usability test | `RECORD.md:71`, `:82-83`: not done | unverified |

## 2. Requirement matrix

Legend for the **Kind** attribute: *mandatory* (the Standard requires it when applicable), *entity decision* (an
accounting policy choice or estimate the entity must make and support), *example* (illustrative only; never a default).
"Deterministic" means the result follows from confirmed facts by arithmetic; "judgment" means a professional must decide
and the product may only record the decision, its reason and its evidence.

Each row names the paragraph read from the pinned 2015 text. Dependencies on other sections are stated explicitly;
Section 17 does not cover recognition criteria, estimates, impairment, leases, grants, borrowing costs, events after the
period or transition on its own.

### R-01 Definition and scope of PPE
| Attribute | Content |
|---|---|
| Source | 17.1, 17.2, 17.3 [2015 text]; Section 16 for the investment property boundary |
| Applicability | Always, for any tangible asset held for use in production, supply, rental or administration and expected to be used in more than one period. Biological assets and mineral rights excluded. Investment property whose fair value cannot be measured reliably without undue cost or effort is accounted for under Section 17 but disclosed separately (17.31 opening words). |
| Facts and evidence | Asset register or listing by item or class; intended use; any rental-to-others arrangement (investment property test). |
| Judgment / calculation | Judgment (classification). |
| Preparation question | "Is every item in this class held and used by the entity for its own operations or administration, rather than held for sale, for rental as investment property, or as agricultural or mineral assets?" |
| Affects | Class composition; SFP caption 4.2(e) vs 4.2(ea)/(f); schedule `ppe` vs `investment_property_cost`. |
| Reconciliation / review | Class listing agrees to the accounts assigned to `sfp.property_plant_and_equipment`; review when the use of an item changes (transfer kinds in the schedule). |
| #207 support | None; the asset class is a free-text label (`equipment.ts:25`). |
| Remaining gap | No classification question; investment-property-at-cost and owner-occupied property share the same movement vocabulary without a class-level distinction. |
| Acceptance | AC-27 |
| Kind | mandatory (definition); class boundaries are entity decisions |
| Author / reviewer | unassigned / unassigned |

### R-02 Recognition and control
| Attribute | Content |
|---|---|
| Source | 17.4 [2015 text], which applies 2.27; 2.37 [2015 text] |
| Applicability | Always, per item: recognise cost as an asset only if future economic benefits are probable and cost is reliably measurable. |
| Facts and evidence | Purchase invoices, grant or donation agreements, title or control evidence, delivery and commissioning records. A trial-balance balance is not evidence of control. |
| Judgment / calculation | Judgment (probability, control); measurement reliability is factual. |
| Preparation question | See PREPARATION_QUESTIONS.md Q1. |
| Affects | Whether an item enters the schedule at all; opening bridge (unexplained residuals must not become assets). |
| Reconciliation / review | Register to ledger agreement; items without evidence are open tasks, never balancing entries. |
| #207 support | Question `recognition` (`equipmentRequirements.ts:10-17`) with evidence guidance; bridge refuses to invent a balancing asset (`equipment.ts:113-115`, test `equipment.test.ts:73-79`). |
| Remaining gap | Answer is one free-text field; no per-item evidence link; no distinction between "we control it" (judgment) and "cost is measurable" (fact). |
| Acceptance | AC-02, AC-03, AC-26 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-03 Spare parts, stand-by and servicing equipment
| Attribute | Content |
|---|---|
| Source | 17.5 [2015 text] (wording aligned by the 2015 Amendments; confirmed in Module 17's change list) |
| Applicability | Conditional: the entity holds spares or stand-by equipment. |
| Facts and evidence | Inventory and register listings; expected use over more than one period. |
| Judgment / calculation | Judgment (PPE definition vs inventory). |
| Preparation question | "Does the entity hold spare parts, stand-by equipment or servicing equipment? If yes, which items meet the PPE definition (used over more than one period) and which are inventory?" |
| Affects | Class composition; inventories caption; schedule additions. |
| Reconciliation / review | Items moved between inventories and PPE appear as transfers ("other changes" in the schedule) with evidence. |
| #207 support | 17.5 is cited inside the recognition question but the question does not ask about spares. |
| Remaining gap | Conditional follow-up missing. |
| Acceptance | AC-17 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-04 Replacement parts and major inspections
| Attribute | Content |
|---|---|
| Source | 17.6, 17.7 [2015 text] (replacement-cost indicator added by the 2015 Amendments) |
| Applicability | Conditional: parts replaced at intervals, or regular major inspections as a condition of operating. |
| Facts and evidence | Invoices for replacements or inspections; the carrying amount of the replaced part or previous inspection (or the replacement cost as an indicator when impracticable). |
| Judgment / calculation | Judgment on whether the replacement gives incremental future benefits; derecognition amount is deterministic once the replaced part's carrying amount is known. |
| Preparation question | "During the period, were any significant parts replaced or major inspections performed? For each: cost, date, and the carrying amount of the part or inspection it replaced." |
| Affects | Schedule: additions (replacement) and disposals or other changes (derecognised part); P&L for day-to-day servicing (R-11). |
| Reconciliation / review | Addition and derecognition recorded in the same period; review if a replaced part was never derecognised. |
| #207 support | None beyond the `additions` and `disposals` kinds. |
| Remaining gap | No question; no guidance distinguishing repair (expense) from replacement (capitalise and derecognise). |
| Acceptance | AC-17 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-05 Land and buildings are separate assets
| Attribute | Content |
|---|---|
| Source | 17.8, 17.16 (land not depreciated, with exceptions) [2015 text] |
| Applicability | Conditional: the entity owns property. |
| Facts and evidence | Title deeds, valuation or purchase split between land and buildings. |
| Judgment / calculation | Allocation of a combined purchase price is a judgment; land depreciation is a rule (none, except quarries and landfill). |
| Preparation question | "Does any class include land? If land and buildings were acquired together, how was the cost split, and is land excluded from depreciation?" |
| Affects | Separate classes; depreciation charge; useful-life disclosure (17.31(c)). |
| Reconciliation / review | Land class carries no depreciation movement. |
| #207 support | None (equipment focus). |
| Remaining gap | Out of the equipment slice; must be a documented limitation of the guided path, not a silent assumption. |
| Acceptance | none proposed in the equipment slice |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-06 Initial measurement at cost and the elements of cost
| Attribute | Content |
|---|---|
| Source | 17.9, 17.10(a)-(c) [2015 text] |
| Applicability | Always for additions. |
| Facts and evidence | Purchase price net of discounts, import duties and non-refundable taxes; directly attributable costs (site preparation, delivery, installation, testing); initial dismantling estimate (see R-08). |
| Judgment / calculation | Deterministic given the invoices; judgment on what is "directly attributable". |
| Preparation question | "For each addition, what is the purchase price after discounts, and which directly attributable costs (delivery, installation, testing, site preparation) were added? Which costs were deliberately excluded?" |
| Affects | Schedule additions; gross carrying amount (17.31(d)); policy note (measurement basis). |
| Reconciliation / review | Additions in the schedule agree to the sum of capitalised invoices in the register. |
| #207 support | None; additions are entered as one amount. |
| Remaining gap | No cost build-up; no check that capitalised costs exclude the 17.11 items. |
| Acceptance | AC-21, AC-22 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-07 Costs that are expensed; borrowing costs
| Attribute | Content |
|---|---|
| Source | 17.11(a)-(e), 17.12 [2015 text]; 25.2 [2015 text] (all borrowing costs expensed when incurred) |
| Applicability | Always for additions; the borrowing-cost rule applies whenever construction is financed. |
| Facts and evidence | Invoices for opening a facility, advertising, training, administration; interest on construction financing. |
| Judgment / calculation | Rule-based; deterministic once costs are identified. |
| Preparation question | "Do any capitalised amounts include start-up, training, advertising, administration or interest costs? Under the 2015 edition these are expensed." |
| Affects | Schedule additions; P&L. |
| Reconciliation / review | Capitalised total excludes the listed items; finance costs line (5.5(b)) carries the interest. |
| #207 support | None. |
| Remaining gap | Mandatory rule with no prompt. Note for the reference assessment: full-IFRS illustrative statements capitalise borrowing costs under IAS 23; that treatment must not be imported. |
| Acceptance | AC-22 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-08 Dismantling, removal and site restoration
| Attribute | Content |
|---|---|
| Source | 17.10(c) [2015 text]; 21.4, 21.5 [2015 text] (provision recognised; cost may be part of PPE); 21.14 [2015 text] (provision reconciliation) |
| Applicability | Conditional: a legal or constructive obligation to dismantle or restore exists. |
| Facts and evidence | Lease or licence terms, environmental obligations, estimate of cost and timing, discount basis. |
| Judgment / calculation | Judgment on existence and estimate; present-value arithmetic is deterministic once inputs are fixed. |
| Preparation question | "Is the entity obliged to dismantle equipment or restore a site at the end of its use? If yes, what is the estimated cost, when is it expected, and is the obligation recorded as a provision?" |
| Affects | PPE cost and schedule additions; provisions caption 4.2(p); provisions schedule (`smes.schedule.provisions`); policy note. |
| Reconciliation / review | The provision movement and the capitalised amount are recorded in the same period; the provisions schedule ties. |
| #207 support | None. |
| Remaining gap | No conditional question; no link to the provisions schedule that already exists on `main` (`ifrsForSmes.ts:240-245`). |
| Acceptance | AC-20 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-09 Deferred payment and exchanges of assets
| Attribute | Content |
|---|---|
| Source | 17.13, 17.14 [2015 text]; 11.13 [2015 text] (financing transaction measured at present value) |
| Applicability | Conditional: payment beyond normal credit terms, or acquisition by exchange of non-monetary assets. |
| Facts and evidence | Payment terms, cash price equivalent or discount rate; fair values in an exchange; commercial substance assessment. |
| Judgment / calculation | Judgment on normal credit terms and commercial substance; present value and fair-value measurement deterministic once inputs are fixed. |
| Preparation question | "Was any addition paid for over a period longer than normal credit terms, or acquired by giving up another asset? If yes, what is the cash price equivalent (or fair value), and how was it determined?" |
| Affects | Additions amount; finance costs; other financial liabilities caption 4.2(m). |
| Reconciliation / review | Addition equals the cash price equivalent, not the nominal contract price. |
| #207 support | None. |
| Remaining gap | Conditional follow-up missing. |
| Acceptance | AC-21 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-10 Measurement model chosen per class; revaluation option
| Attribute | Content |
|---|---|
| Source | 17.15, 17.15A (cost model), 17.15B-17.15D (revaluation model, added by the 2015 Amendments) [2015 text]; Section 10 treats the first application of a revaluation policy as a revaluation under Section 17, not as a Section 10 policy change (text at extracted lines 3113-3116) |
| Applicability | Always: the entity must choose a model for each entire class. Revaluation sub-rows apply only when that model is chosen. |
| Facts and evidence | Approved accounting policy; for revaluation: valuation report, date, valuer, methods, regularity. |
| Judgment / calculation | Policy choice is an entity decision; revaluation accounting (OCI vs profit or loss) is rule-based. |
| Preparation question | See PREPARATION_QUESTIONS.md Q3. |
| Affects | Policy note 8.5(a); schedule kind `revaluations_and_oci_impairment`; 17.33 disclosures; OCI presentation 5.5(g) (currently an unsupported case on `main`). |
| Reconciliation / review | Model applied to the whole class; if revalued, surplus movement agrees to OCI; cost-model comparison amount (17.33(d)) available. |
| #207 support | `basis` select with cost or revaluation (`EquipmentPreparation.tsx:1193-1206`); revaluation question conditional (`equipmentRequirements.ts:139-141`); the policy draft labels revaluation as needing a separate assessment (`equipment.ts:193-196`). |
| Remaining gap | Choosing "revaluation" does not route to the unsupported-OCI stop on `main`; no 17.33(a)-(e) structured answers; no surplus tracking. |
| Acceptance | AC-15 |
| Kind | entity decision (choice is mandatory) |
| Author / reviewer | unassigned / unassigned |

### R-11 Day-to-day servicing expensed
| Attribute | Content |
|---|---|
| Source | 17.15 (last sentence) [2015 text] |
| Applicability | Always. |
| Facts and evidence | Repairs and maintenance ledger; invoices. |
| Judgment / calculation | Rule; judgment at the boundary with R-04 replacements. |
| Preparation question | "Were repairs and maintenance expensed, and were any amounts capitalised that are in fact day-to-day servicing?" |
| Affects | P&L expense lines; schedule additions. |
| Reconciliation / review | Capitalised additions contain no routine servicing. |
| #207 support | None. |
| Remaining gap | Should be a follow-up under the additions question. |
| Acceptance | AC-17 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-12 Components with different consumption patterns
| Attribute | Content |
|---|---|
| Source | 17.16 [2015 text] (and the cross-reference in 17.6) |
| Applicability | Conditional: major components of an item have significantly different patterns of consumption. |
| Facts and evidence | Register at component level, maintenance plan, cost allocation per component, useful life per component. |
| Judgment / calculation | Judgment on significance; depreciation per component deterministic once allocated. |
| Preparation question | See PREPARATION_QUESTIONS.md Q2. |
| Affects | Depreciation charge; useful lives disclosure 17.31(c) (per component where relevant); estimates note 8.7. |
| Reconciliation / review | Sum of component depreciation equals the class charge; review when a component is replaced (R-04). |
| #207 support | Question `components` (`equipmentRequirements.ts:18-25`), free text. |
| Remaining gap | No component register or calculation; the answer "none" needs an evidence basis. |
| Acceptance | AC-11 |
| Kind | mandatory when applicable; significance is a judgment |
| Author / reviewer | unassigned / unassigned |

### R-13 Where the depreciation charge goes
| Attribute | Content |
|---|---|
| Source | 17.17 [2015 text]; 5.11 [2015 text] (expense analysis by nature or function); inclusion in inventories is referenced by 17.17 (Section 13) |
| Applicability | Always. |
| Facts and evidence | Expense analysis basis chosen for the report; manufacturing use of equipment. |
| Judgment / calculation | Rule-based once the basis is chosen. |
| Preparation question | "Is any equipment used in production so that its depreciation belongs in cost of inventories or cost of sales rather than in a separate depreciation line?" |
| Affects | SCI lines `sci.depreciation_and_amortisation` (by nature) or cost of sales / by function (`ifrsForSmes.ts:197-201`); the schedule `depreciation` kind must equal the period charge regardless of where it is presented. |
| Reconciliation / review | Schedule depreciation = sum of depreciation expense lines plus depreciation capitalised into inventories. |
| #207 support | None; the schedule's depreciation amount is not tied to any SCI line. |
| Remaining gap | Missing tie-out between the schedule depreciation movement and the composed expense lines (charter G5). |
| Acceptance | AC-01 (tie-out expectation), AC-13 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-14 Depreciable amount, residual value, useful life
| Attribute | Content |
|---|---|
| Source | 17.18 [2015 text] (systematic allocation of the depreciable amount over the useful life); the glossary definitions of depreciable amount and residual value apply |
| Applicability | Always for depreciable classes. |
| Facts and evidence | Entity's expected use; residual value estimate; useful life per class or item. |
| Judgment / calculation | Residual value and useful life are entity estimates (judgment). The charge is deterministic once method, cost, residual value and life are fixed. |
| Preparation question | See PREPARATION_QUESTIONS.md Q4. A useful life from a template, a tax table or another entity is an *example*, never a default. |
| Affects | Depreciation movement; 17.31(c) disclosure; 8.7 estimates note; policy note. |
| Reconciliation / review | Charge recomputed from register inputs equals the schedule movement; estimates reviewed when indicators exist (R-15). |
| #207 support | Free-text `usefulLife` and `residualValue` with rationale and evidence required (`equipment.ts:179-191`); the UI states that no useful life or tax rate is assumed (`EquipmentPreparation.tsx:1180-1184`). |
| Remaining gap | No structured per-class values (number and unit); no computation; the acceptance fixture's note "Useful lives of equipment (acceptance placeholder)" is a placeholder, not content (`notes_wording_FY2025.csv`). |
| Acceptance | AC-12, AC-13 |
| Kind | entity estimate (mandatory to have one) |
| Author / reviewer | unassigned / unassigned |

### R-15 Review of estimates; change in accounting estimate
| Attribute | Content |
|---|---|
| Source | 17.19 (indicators: change in use, unexpected wear, technology, market prices; amend prospectively) [2015 text]; 10.15, 10.16, 10.17 (prospective recognition) and 10.18 (disclose nature and effect) [2015 text] |
| Applicability | Conditional: indicators present or expectations changed. |
| Facts and evidence | Evidence of the indicator; revised estimate; effect on the current period and, if practicable, future periods. |
| Judgment / calculation | Indicator and revised estimate are judgment; the prospective effect is deterministic. |
| Preparation question | "Since the last reporting date, has anything changed how long or how the entity will use this class (new use, heavy wear, obsolescence, price changes)? If yes, what is the revised life, residual value or method, and what is the effect on this year's depreciation?" |
| Affects | Depreciation movement; a 10.18 disclosure (no pack requirement row exists for it today); 8.7 estimates note. |
| Reconciliation / review | The disclosed current-period effect equals the recomputed charge difference; comparatives are not restated. |
| #207 support | 17.19 cited under `estimates`; the `method` question mentions changed circumstances (`equipmentRequirements.ts:41-48`). |
| Remaining gap | No separate change-in-estimate path; no disclosure row for 10.18. |
| Acceptance | AC-12 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-16 When depreciation starts and stops
| Attribute | Content |
|---|---|
| Source | 17.20 [2015 text] |
| Applicability | Always. |
| Facts and evidence | Available-for-use date per addition; derecognition date; idle assets (depreciation continues unless fully depreciated; usage methods may give zero). |
| Judgment / calculation | Date facts; the pro-rata charge is deterministic. |
| Preparation question | "For each addition, when was it in the location and condition to operate as intended? Was any asset idle or retired but not derecognised?" |
| Affects | Depreciation movement; register. |
| Reconciliation / review | Charge for additions starts at the available-for-use date, not the invoice date. |
| #207 support | `method` evidence text mentions available-for-use dates (`equipmentRequirements.ts:46-47`). |
| Remaining gap | No date capture per addition. |
| Acceptance | AC-13 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-17 Factors in determining useful life
| Attribute | Content |
|---|---|
| Source | 17.21(a)-(d) [2015 text]: expected usage, physical wear and tear, technical or commercial obsolescence, legal or similar limits |
| Applicability | Always when estimating a useful life. |
| Facts and evidence | Capacity or output expectations, shift patterns and maintenance programme, obsolescence assessment, lease or licence expiry dates. |
| Judgment / calculation | Judgment. |
| Preparation question | Folded into Q4 (PREPARATION_QUESTIONS.md) as four prompts. |
| Affects | 17.31(c); 8.7. |
| Reconciliation / review | Legal limits (lease term) cap the life for leased assets (R-28). |
| #207 support | `rationale` and `evidence` free text; the UI hint lists use, condition, maintenance, obsolescence and legal limits (`EquipmentPreparation.tsx:1180-1184`). |
| Remaining gap | Factors are not captured separately; "legal limits" is not linked to lease terms. |
| Acceptance | AC-13, AC-18 |
| Kind | mandatory considerations; the resulting life is an entity estimate |
| Author / reviewer | unassigned / unassigned |

### R-18 Depreciation method and its review
| Attribute | Content |
|---|---|
| Source | 17.22 (method reflects the consumption pattern; straight-line, diminishing balance, usage methods named as possibilities) [2015 text]; 17.23 (review on indication of a significant change; change in estimate) [2015 text] |
| Applicability | Always. |
| Facts and evidence | Usage pattern; evidence of a changed pattern. |
| Judgment / calculation | Method choice is an entity decision (judgment); the charge is deterministic. |
| Preparation question | See PREPARATION_QUESTIONS.md Q5. |
| Affects | 17.31(b) disclosure; policy note; depreciation movement. |
| Reconciliation / review | A method change is prospective and disclosed (R-15). |
| #207 support | `method` select with three options (`EquipmentPreparation.tsx:1207-1219`); `rationale` required. |
| Remaining gap | Units-of-production needs a capacity basis that is not captured; no computation. |
| Acceptance | AC-13 |
| Kind | entity decision |
| Author / reviewer | unassigned / unassigned |

### R-19 Impairment
| Attribute | Content |
|---|---|
| Source | 17.24 [2015 text] applies Section 27: 27.5 (reduce to recoverable amount), 27.7 (assess indicators at each reporting date), 27.8 (cash-generating unit), 27.9 (minimum indicators, including (e) obsolescence or damage and (f) idle assets, restructuring, earlier disposal plans), 27.21 (CGU loss allocation), 27.30 (reversal assessment), 27.32-27.33 (disclosure per class, PPE listed in 27.33(b)) [2015 text]; 17.25 (compensation for impaired or lost items in profit or loss when receivable); 17.26 (plan to dispose early is an indicator) |
| Applicability | Assessment is mandatory at every reporting date; measurement only when an indicator exists. |
| Facts and evidence | Indicator review (internal and external); recoverable amount workings (fair value less costs to sell or value in use); compensation receivable. |
| Judgment / calculation | Indicator assessment and recoverable amount are judgment (governed workpaper, charter L9); loss, allocation and reversal cap are deterministic. |
| Preparation question | "At the reporting date, is there any sign that equipment is worth less than its carrying amount (damage, obsolescence, idle, plans to sell early, market decline)? If yes, what is the recoverable amount and who prepared it?" and "Was any impairment recognised in a prior year that may have reversed?" |
| Affects | Schedule kinds `impairment_profit_or_loss` and `revaluations_and_oci_impairment`; accumulated impairment in 17.31(d); 27.32 disclosure (no pack row exists); SCI line placement. |
| Reconciliation / review | Impairment movement equals the recognised loss; accumulated impairment at the end date equals opening plus loss less reversals and amounts eliminated on disposal. |
| #207 support | Accumulated impairment fields at both dates (`equipmentRequirements.ts:82-89`); movement kinds from the pack; no assessment. |
| Remaining gap | No indicator question; no 27.32 disclosure row; no reversal cap. |
| Acceptance | AC-14, AC-28 |
| Kind | mandatory (assessment); measurement is a judgment |
| Author / reviewer | unassigned / unassigned |

### R-20 Derecognition and disposals
| Attribute | Content |
|---|---|
| Source | 17.27 (on disposal or when no future benefits are expected), 17.28 (gain or loss in profit or loss, not revenue), 17.29 (disposal date per Section 23 criteria; sale and leaseback per Section 20), 17.30 (gain or loss = net disposal proceeds less carrying amount) [2015 text] |
| Applicability | Conditional: disposals, scrapping, loss or retirement during the period. |
| Facts and evidence | Disposal agreements, proceeds, date of transfer of risks and rewards, carrying amount at disposal (cost and accumulated depreciation of the item). |
| Judgment / calculation | The disposal date can require judgment; the gain or loss is deterministic. |
| Preparation question | "Which items were sold, scrapped, lost or withdrawn from use during the period? For each: date, cost, accumulated depreciation, proceeds. The schedule needs the carrying amount removed; the income statement needs the gain or loss." |
| Affects | Schedule `disposals` (carrying amount); gross roll-forward (cost removed, accumulated depreciation eliminated); SCI other income or expense line; cash-flow investing proceeds. |
| Reconciliation / review | Disposal carrying amount in the schedule = cost removed less accumulated depreciation eliminated; proceeds less carrying amount = recognised gain or loss. |
| #207 support | `disposals` kind; evidence text warns that the disposal carrying amount is not proceeds (`equipmentRequirements.ts:61-62`). |
| Remaining gap | No proceeds capture, no gain or loss computation, no gross roll-forward of the disposed item. |
| Acceptance | AC-06 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-21 Disclosure per class: bases, methods, lives or rates
| Attribute | Content |
|---|---|
| Source | 17.31(a), (b), (c) [2015 text], for each class determined under 4.11(a) [2015 text]; 8.5(a)-(b) (measurement bases and relevant policies) [2015 text] |
| Applicability | Always when the entity has PPE. |
| Facts and evidence | Approved policy; per-class method; per-class lives or rates. |
| Judgment / calculation | Disclosure content follows from entity decisions. |
| Preparation question | Covered by Q3, Q4, Q5. |
| Affects | Policy note `smes.note.policies` (free wording on `main`); the candidate's policy draft. |
| Reconciliation / review | Disclosed lives agree to the register inputs used for the charge; every class in the schedule has a disclosed basis, method and life. |
| #207 support | The policy draft composes basis, method, lives, residual values, rationale and evidence into one sentence block (`equipment.ts:197-199`); the insertion proposal preserves the existing policy note (`workpaperClient.ts:151-165`). |
| Remaining gap | Single class; residual values and "rationale" are mixed into policy wording although 17.31 requires bases, methods and lives, while rationale belongs with 8.7 estimates; lives are free text so a "rate" alternative cannot be checked. |
| Acceptance | AC-01, AC-27 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-22 Gross carrying amount and accumulated depreciation (with impairment) at both dates
| Attribute | Content |
|---|---|
| Source | 17.31(d) [2015 text]: gross carrying amount and accumulated depreciation aggregated with accumulated impairment, at the beginning and end of the period; 3.14 comparatives apply to these amounts |
| Applicability | Always when the entity has PPE. |
| Facts and evidence | Register totals at both dates; prior-year note for the opening figures. |
| Judgment / calculation | Deterministic. |
| Preparation question | See PREPARATION_QUESTIONS.md Q6. |
| Affects | Equipment note; opening bridge (opening gross and accumulated amounts must agree to the prior report, not only the net). |
| Reconciliation / review | gross less accumulated depreciation less accumulated impairment = carrying amount at each date; opening gross = prior closing gross unless bridged. |
| #207 support | `grossReconciliation` at both dates, blank refused, zero must be typed (`equipmentRequirements.ts:90-123`, tests `:25-57`). |
| Remaining gap | Opening gross and accumulated figures are not bridged to the prior report (only the net carrying amount is); no gross roll-forward through the period (A4). |
| Acceptance | AC-01, AC-09, AC-10, AC-23 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-23 Reconciliation of the carrying amount (the movement schedule)
| Attribute | Content |
|---|---|
| Source | 17.31(e)(i)-(viii) [2015 text]; the reconciliation need not be presented for prior periods (17.31, final sentence) |
| Applicability | Always when the entity has PPE at either date (the pack decides this from the composed line, `20261019100000:457-458`). |
| Facts and evidence | Register or ledger movements by kind; a reviewed movement-account working paper where the chart carries movement accounts (charter R5). |
| Judgment / calculation | Classifying a movement into a kind can require judgment; the arithmetic is deterministic. |
| Preparation question | See PREPARATION_QUESTIONS.md Q7. |
| Affects | Schedule `ppe`; SFP line; SCI depreciation and impairment; cash-flow investing lines. |
| Reconciliation / review | opening + movements = closing (server-enforced, `20261019100000:344-347`); closing = composed line (`:467-469`); opening = composed prior line when a comparative exists (`:470-475`); prior period reconciliation not required. |
| #207 support | Movement entry with sign conversion (`EquipmentPreparation.tsx:277-291`), coverage confirmation (`:1042-1058`), independent check of the internal sum and the server line (`equipment.ts:155-160`), two-TB net change refused as a movement (`equipment.test.ts:115-127`). |
| Remaining gap | Movements are amounts without source rows; the coverage checkbox is the only completeness control; the depreciation movement is not tied to the SCI charge (R-13); kinds (iii)-(vi) have no guidance on when they apply. |
| Acceptance | AC-01, AC-05, AC-06, AC-07, AC-08, AC-33 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-24 Restrictions, pledges and contractual commitments
| Attribute | Content |
|---|---|
| Source | 17.32(a), (b) [2015 text]; 17.32(c) concerns cost-model investment property and is out of scope here |
| Applicability | Always asked; the disclosure applies when such items exist. A trial balance cannot show either. |
| Facts and evidence | Loan agreements and security registers; signed purchase contracts for equipment not yet delivered; management confirmation when none. |
| Judgment / calculation | Factual once the documents are reviewed. |
| Preparation question | See PREPARATION_QUESTIONS.md Q8. |
| Affects | Equipment note; borrowings note cross-reference. |
| Reconciliation / review | Pledged carrying amounts are a subset of the class carrying amount; commitments are not in the schedule. |
| #207 support | Question `restrictions` (`equipmentRequirements.ts:64-70`), free text, included in the disclosure preview (`EquipmentPreparation.tsx:485`). |
| Remaining gap | One field for two different disclosures (carrying amount pledged vs commitment amount); "none" has no evidence requirement beyond text length. |
| Acceptance | AC-16 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-25 Revaluation disclosures
| Attribute | Content |
|---|---|
| Source | 17.33(a)-(e) [2015 text] (effective date, independent valuer involvement, methods and significant assumptions, cost-model carrying amount per revalued class, revaluation surplus movement and distribution restrictions) |
| Applicability | Conditional: items stated at revalued amounts. |
| Facts and evidence | Valuation report; surplus ledger; cost-model shadow carrying amount. |
| Judgment / calculation | Valuation is a governed workpaper (judgment); the surplus roll-forward is deterministic. |
| Preparation question | See PREPARATION_QUESTIONS.md Q9. |
| Affects | Equipment note; OCI line (unsupported case on `main`); equity (revaluation surplus). |
| Reconciliation / review | Surplus movement = OCI revaluation items; the cost-model amount is independently derivable from the register. |
| #207 support | Conditional free-text question (`equipmentRequirements.ts:72-79`); the preview adds "Valuation information" when applicable. |
| Remaining gap | Five required items collapsed into one field; no stop at the unsupported OCI case. |
| Acceptance | AC-15 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-26 Judgements and key sources of estimation uncertainty
| Attribute | Content |
|---|---|
| Source | 8.6, 8.7 [2015 text] |
| Applicability | Always; useful lives and residual values are typical estimation-uncertainty items; component significance and capitalisation boundaries are typical judgements. |
| Facts and evidence | The entity's estimates and the carrying amounts they affect. |
| Judgment / calculation | Judgment. |
| Preparation question | "Which of your equipment estimates could change materially within the next year, and what carrying amount do they affect?" |
| Affects | Notes `smes.note.judgements`, `smes.note.estimates` (both free wording on `main`). |
| Reconciliation / review | The carrying amount quoted in the estimates note equals the class carrying amount in the schedule. |
| #207 support | None; the candidate writes only into `smes.note.policies` or `smes.note.subclassifications` (`workpaper.sql:97`). |
| Remaining gap | Estimates and judgements are not derived from the structured answers. |
| Acceptance | AC-12 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-27 Comparatives, prior-report figures and the opening bridge
| Attribute | Content |
|---|---|
| Source | 3.14 [2015 text] (comparative information for all amounts presented); 10.21-10.23 [2015 text] (prior-period errors corrected retrospectively, restating comparatives or the earliest opening balances); 3.23(c)-(e) (period, presentation currency, rounding level displayed on the source report) |
| Applicability | Always; the opening carrying amount must agree to the prior published closing amount unless an authorised restatement, scope change or identified error bridges it (charter R4). |
| Facts and evidence | Prior-year statements (page reference, printed amount, currency, units); approved adjustments with evidence; the governed restatement path on `main` (F7). |
| Judgment / calculation | Bridge items are judgment (authorised corrections); the residual is deterministic. |
| Preparation question | Step 1 and Step 2 of the candidate; see PREPARATION_QUESTIONS.md section 3. |
| Affects | Schedule opening; comparatives approval; restatement records. |
| Reconciliation / review | Residual must be zero after evidenced items; a browser bridge is never an approval (`RECORD.md:17`, `:80`); any comparative change goes through `fs_propose_restatement` / `fs_decide_restatement`. |
| #207 support | `openingBridge` with entity, date, currency, unit and confirmation checks (`equipment.ts:42-119`); anchor date (`:244-254`); printed-units normalisation (`:218-241`). |
| Remaining gap | The bridge covers the net carrying amount only (not gross and accumulated amounts, R-22); adjustments recorded in the workpaper are not linked to a restatement proposal; the first-period case (no prior report) has no explicit path other than "incomplete". |
| Acceptance | AC-02, AC-03, AC-04, AC-23, AC-24, AC-25, AC-26 |
| Kind | mandatory |
| Author / reviewer | unassigned / unassigned |

### R-28 Finance leases (lessee)
| Attribute | Content |
|---|---|
| Source | 20.9 (recognise asset and liability at the lower of fair value and present value of minimum lease payments), 20.10 (rate implicit or incremental borrowing rate), 20.11 (apportion payments), 20.12 (depreciate under Section 17; shorter of lease term and useful life when ownership is not reasonably certain; impairment under Section 27), 20.13 (lessee disclosures: net carrying amount per class, maturity bands, description) and the statement that Sections 17, 18, 27 and 34 disclosures also apply to leased assets [2015 text, extracted lines 6711-6770] |
| Applicability | Conditional: equipment held under finance leases. |
| Facts and evidence | Lease agreements, payment schedules, rates, ownership transfer terms. |
| Judgment / calculation | Lease classification and rate are judgment; present value and depreciation deterministic. |
| Preparation question | "Is any equipment held under a lease that transfers substantially all risks and rewards? If yes: fair value, present value of minimum payments, lease term, and whether ownership transfers at the end." |
| Affects | PPE class (leased assets within a class or a separate class); other financial liabilities 4.2(m); finance costs 5.5(b); 20.13 disclosures (no pack row exists). |
| Reconciliation / review | Depreciation period capped by the lease term where ownership is not reasonably certain; net carrying amount per class disclosed. |
| #207 support | None. |
| Remaining gap | Conditional follow-up and pack rows missing. Note for the reference assessment: full-IFRS illustrative statements present right-of-use assets under IFRS 16; that model must not be imported into the 2015 edition's finance/operating split. |
| Acceptance | AC-18 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-29 Government grants related to equipment
| Attribute | Content |
|---|---|
| Source | 24.4(a)-(c) (recognised in income when receivable or when performance conditions are met; grants received early are liabilities), 24.5 (measured at the fair value of the asset received or receivable), 24.6 (disclosures) [2015 text] |
| Applicability | Conditional: equipment received or funded by government grants. |
| Facts and evidence | Grant agreement, conditions, fair value of the asset received. |
| Judgment / calculation | The conditions assessment is judgment; recognition timing follows the rule. |
| Preparation question | "Was any equipment funded or donated by a government body? If yes, what conditions attach, and has the grant been recognised in income or as a liability?" |
| Affects | Additions at fair value; other income; liabilities; 24.6 disclosures (no pack row). |
| Reconciliation / review | The asset is not shown net of the grant; grant income or liability agrees to the agreement. Note for the reference assessment: full IFRS (IAS 20) allows deducting the grant from the asset; that option must not be imported. |
| #207 support | None. |
| Remaining gap | Conditional follow-up and pack rows missing. |
| Acceptance | AC-19 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-30 Events after the end of the reporting period
| Attribute | Content |
|---|---|
| Source | 32.10 (disclose the nature and financial effect of each category of non-adjusting event), 32.11(c) (major purchases, disposals or plans to dispose of assets listed as examples) [2015 text]; 32.5 (adjusting events) |
| Applicability | Conditional: significant equipment purchases, disposals or losses between the reporting date and authorisation. |
| Facts and evidence | Post-year-end contracts, board minutes, insurance claims. |
| Judgment / calculation | Judgment (adjusting vs non-adjusting). |
| Preparation question | "Between the year end and the date these statements are authorised, did the entity buy, sell, lose or commit to major equipment?" |
| Affects | Existing pack requirement `smes.note.events_after` (`ifrsForSmes.ts:158-159`, recorded decision). |
| Reconciliation / review | None arithmetic; consistency with commitments (R-24). |
| #207 support | None. |
| Remaining gap | An equipment-specific prompt should feed the existing events-after decision, not a new requirement. |
| Acceptance | AC-29 |
| Kind | mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-31 Transition: deemed cost
| Attribute | Content |
|---|---|
| Source | 35.7 (recognise and measure under the Standard at the date of transition), 35.10(c) (fair value as deemed cost), 35.10(d) (previous revaluation as deemed cost), 35.13 (explain the transition's effect) [2015 text, extracted lines 12278-12381, 12522-12524] |
| Applicability | Conditional: first-time adoption of the IFRS for SMEs in the reporting period. |
| Facts and evidence | Date of transition; election per item or class; fair value or previous revaluation evidence. |
| Judgment / calculation | The election is an entity decision; the deemed cost becomes the gross carrying amount basis. |
| Preparation question | "Is this the entity's first set of IFRS for SMEs financial statements? If yes, did the entity elect fair value or a previous revaluation as deemed cost for any equipment at the transition date?" |
| Affects | Opening bridge (prior framework figures vs transition figures); 17.31(a) measurement basis; 35.13 explanation (no pack row). |
| Reconciliation / review | Transition adjustments reconcile the prior-framework closing to the Standard's opening (a bridge category of its own). |
| #207 support | None; the bridge assumes a prior report under the same framework. |
| Remaining gap | First-time adoption is not a recognised bridge reason. |
| Acceptance | AC-30 |
| Kind | entity decision (election); disclosure mandatory when applicable |
| Author / reviewer | unassigned / unassigned |

### R-32 Presentation on the statements
| Attribute | Content |
|---|---|
| Source | 4.2(e) (PPE line item), 4.4 (current/non-current split), 4.11(a) (subclassification of PPE in classes appropriate to the entity), 5.5 and 5.11 (expense analysis), 3.23 (identification: period, currency, rounding) [2015 text] |
| Applicability | Always. |
| Facts and evidence | Presentation assignments; expense-analysis basis; classes. |
| Judgment / calculation | Class definition is an entity decision; placement is rule-based. |
| Preparation question | "Which classes of equipment does the entity report (for example by nature of use), and are all equipment accounts assigned to the PPE line?" |
| Affects | `sfp.property_plant_and_equipment` (non-current, `ifrsForSmes.ts:180`); `smes.note.subclassifications`; SCI depreciation presentation. |
| Reconciliation / review | Sum of class carrying amounts = SFP line (server-enforced at the schedule level). |
| #207 support | Closing agreed to the server line (`EquipmentPreparation.tsx:65-71`); single class. |
| Remaining gap | Per-class presentation in the guided path (A11). |
| Acceptance | AC-08, AC-27 |
| Kind | mandatory; classes are an entity decision |
| Author / reviewer | unassigned / unassigned |

## 3. Gap list summary (charter section 2.4 format)

| Gap | Requirement rows | Repository location that would change (not edited here) |
|---|---|---|
| G-1 Movement and gross schedules are entered totals with no per-item or per-row source; depreciation not tied to the SCI charge; no gross roll-forward through disposals | R-13, R-20, R-22, R-23 | `src/lib/preparation/equipment.ts`, `src/lib/preparation/equipmentRequirements.ts`, `src/components/reporting/EquipmentPreparation.tsx`, pack `ifrsForSmes.ts` (schedule definition), a successor migration to `20261019100000` |
| G-2 Entity estimates are free text: no structured per-class lives, residual values, method basis; no deterministic depreciation check | R-14, R-16, R-17, R-18 | `equipment.ts` (`EquipmentPolicy`), `editorSchema.ts`, UI step 4 |
| G-3 Conditional requirements have no follow-up question: spares, replacements, dismantling, deferred payment, exchanges, borrowing costs, impairment indicators, leases, grants, transition, events after period | R-03, R-04, R-07, R-08, R-09, R-11, R-19, R-28, R-29, R-30, R-31 | `equipmentRequirements.ts` (questions), pack requirement rows for 10.18, 20.13, 24.6, 27.32, 35.13 |
| G-4 Single class only in the guided path; 17.31 and 4.11(a) are per class | R-01, R-21, R-32 | `EquipmentPreparation.tsx`, `workpaper.sql` (`fs_commit_equipment_preparation` row construction `:152-154`) |
| G-5 Answers live in a JSON workpaper, not as reusable requirement-linked facts (charter L8) feeding 8.5/8.6/8.7 and 17.31(a)-(c) | R-21, R-26 | `workpaper.sql`, `workpaperClient.ts`, notes insertion |
| G-6 Opening bridge covers the net carrying amount only and is not linked to the restatement path | R-22, R-27 | `equipment.ts` (`openingBridge`), `20261020100000` consumers |
| G-7 Revaluation choice does not stop at the unsupported-OCI case; 17.33 items collapsed | R-10, R-25 | `equipmentRequirements.ts`, `EquipmentPreparation.tsx`, `NOTES_AND_SCHEDULES.md` cases |

HANDOFF.md ranks the five most important of these.

## 4. Things this document does not claim

- That any requirement is VALIDATED. `docs/reporting/COVERAGE_IFRS_FOR_SMES.md:5` records none.
- That PR #207 is correct, complete or ready to merge; it was read, not executed, and its CI result was not checked here.
- That the hosted project has the schedule functions: that is inferred from the 2026-10-21 record only.
- That the paraphrases above replace the Standard. Every row must be re-read against the cited paragraph by the
  accounting author and the independent reviewer before it enters the framework register.
