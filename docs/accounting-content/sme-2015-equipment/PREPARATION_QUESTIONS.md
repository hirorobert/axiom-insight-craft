# SME 2015 equipment: preparation questions assessment

**Status:** accounting-content candidate, qualified review pending (author and reviewer unassigned). This assesses the
user-facing questions and field labels in PR #207 at `a7182309367ae75c950bf6ba03e6d1d216811a57` and proposes wording.
It does not change that PR. Requirement rows (R-xx) and acceptance cases (AC-xx) refer to REQUIREMENTS_MATRIX.md and
ACCEPTANCE_CASES.md.

## 1. Assessment method

Each question was read as a junior accountant would meet it on the Schedules page: without the Standard open, without
a senior in the room, and with a trial balance, a fixed asset register and last year's signed statements to hand. Three
tests were applied:

1. **Understandable:** no term that needs the Standard to decode (control, measurement model, accumulated deductions,
   consumption pattern, subclassifications).
2. **Answerable:** the preparer knows which document answers it and what "done" looks like.
3. **Safe:** the question cannot be satisfied by copying a template, a tax table or last year's note, and "none" cannot
   be entered without a basis.

Every question is labelled with its **kind**: *mandatory* (the Standard requires it when applicable), *entity decision*
(the entity must choose and support it), *example* (illustration only; never a default). Nothing here prescribes a useful
life, residual value, method or treatment. Where an illustration uses a number, it is an example.

## 2. The nine questions in `src/lib/preparation/equipmentRequirements.ts:9-80`

### Q1 `recognition` (refs 17.4, 17.5) - R-02, R-03
- **Current wording:** "Does the entity control the equipment, and what supports its recorded value?"
- **Assessment:** fails test 1 ("control" is a defined idea, not everyday language) and test 2 (two questions in one;
  "recorded value" could mean cost, carrying amount or the ledger balance). The evidence hint ("investigate missing items
  rather than creating a balancing asset") is good and should stay.
- **Proposed wording:** "Does the entity own, or have the right to use and keep the benefits of, every item in this
  class? List the documents that show this and what each item cost."
- **Purpose:** establish the 17.4 / 2.27 recognition basis per item before any figure enters the schedule.
- **Accepted evidence:** purchase invoices and receipts, title or registration documents, delivery and commissioning
  records, signed lease or grant agreements, the fixed asset register. Not accepted: a trial-balance balance alone, a
  prior-year note alone.
- **Conditional follow-ups:**
  - An item has no document: record it as an open task; the product must not create a balancing asset (AC-02).
  - An item is used but not owned: go to the lease follow-up (section 4, F-LEASE).
  - An item was donated or grant-funded: go to F-GRANT.
  - Spare parts or stand-by equipment are held: go to F-SPARES (17.5).
- **Kind:** mandatory.

### Q2 `components` (ref 17.16) - R-12
- **Current wording:** "Do significant parts wear out differently and need separate depreciation?"
- **Assessment:** passes test 1 mostly; "significant" and "differently" are undefined for a junior. The evidence hint
  ("explain the grouping decision") is right.
- **Proposed wording:** "Does any item have a major part that will need replacing well before the rest of it (for
  example an engine in a vehicle, or the roof of a building)? If yes, list each such part with its cost and how long it
  is expected to last. If no, say why (for example: items are low value or uniform)."
- **Purpose:** decide whether 17.16 component depreciation applies.
- **Accepted evidence:** register at component level, supplier cost breakdown, maintenance or replacement plan.
- **Conditional follow-ups:** if yes, each component needs its own life (Q4) and any replacement during the year goes to
  F-REPLACE (17.6). The engine and roof are examples (17.6 uses a roof), not a list of required components.
- **Kind:** mandatory when applicable; significance is an entity judgment.

### Q3 `basis` (refs 17.15, 17.15A, 17.15B) - R-10
- **Current wording:** "Which measurement model applies to this entire asset class?" with a select of Cost or
  "Revaluation - separate valuation assessment required" (`EquipmentPreparation.tsx:1193-1206`).
- **Assessment:** "measurement model" fails test 1. The select is clear once understood. The policy draft correctly
  refuses to perform a valuation.
- **Proposed wording:** "After buying equipment, does the entity keep it at what it cost (less depreciation and any
  impairment), or does it regularly revalue it to its current value? The same choice must apply to every item in the
  class."
- **Purpose:** the 17.15 policy election per class; it drives 17.31(a) and the policy note (8.5(a)).
- **Accepted evidence:** the written accounting policy approved by management or the board; the prior-year policy note
  (for consistency, not as authority); for revaluation, the valuation report.
- **Conditional follow-ups:** revaluation chosen: Q9 applies, and the product must say that revaluation gains in other
  comprehensive income are an unsupported reporting case on `main` (`docs/reporting/NOTES_AND_SCHEDULES.md:53-58`), so
  the report cannot currently be finalised on that path (AC-15).
- **Kind:** entity decision; making the choice is mandatory.

### Q4 `estimates` (refs 17.18, 17.19, 17.21) - R-14, R-15, R-17
- **Current wording:** "What useful lives and residual values reflect the way this entity uses the equipment?" with
  free-text fields "Useful lives or supported ranges", "Residual values and how they were estimated", "Why these estimates
  reflect expected use", "Evidence supporting these estimates" (`EquipmentPreparation.tsx:1220-1239`).
- **Assessment:** passes test 3 (the UI says no life or tax rate is assumed, `:1180-1184`, and the evidence hint forbids
  tax rates). Fails test 2: "residual value" is not explained, and a junior does not know what "supported ranges" means
  or how to reason about a life. Free text cannot be checked against the depreciation charge (G-2).
- **Proposed wording, in two parts plus four prompts:**
  - "For how many years (or how many units of output, if usage drives wear) does the entity expect to use this class of
    equipment?"
  - "At the end of that time, what does the entity expect to receive for the items (sale or scrap value after disposal
    costs)? Enter zero only if it genuinely expects nothing."
  - Prompts from 17.21: (a) how heavily will it be used (capacity, output)? (b) how many shifts, and what maintenance is
    planned? (c) could it become obsolete because of technology or market change? (d) is there a legal or contractual
    limit, such as a lease expiry?
- **Purpose:** the entity's own estimates for 17.18, with the 17.21 factors visible; feeds 17.31(c) and the 8.7
  estimates note.
- **Accepted evidence:** replacement plan or capital budget, maintenance records, lease or licence terms, history of
  disposals of similar items, management representation signed by the responsible person. Not accepted as authority:
  tax wear-and-tear classes (the Tanzanian rates in CLAUDE.md section 12 are tax rules), a template's lives, the
  acceptance fixture's placeholder note, last year's note copied without re-assessment.
- **Conditional follow-ups:** if the life, residual value or method changed since last year, go to F-ESTIMATE-CHANGE
  (17.19, 10.18). If the class includes leased items, the lease term caps the life where ownership is not reasonably
  certain (F-LEASE).
- **Kind:** entity estimate (mandatory to have one). Any number shown in guidance is an example.

### Q5 `method` (refs 17.22, 17.23) - R-18
- **Current wording:** "Which depreciation method reflects consumption, and have changed circumstances been
  considered?" with a select of straight-line, reducing balance, units of production (`:1207-1219`).
- **Assessment:** "reflects consumption" fails test 1. The three options match the methods 17.22 names as possibilities;
  they are examples of possible methods, not a closed list in the Standard.
- **Proposed wording:** "Does the entity use up the benefit of this equipment evenly each year (straight-line), more in
  the early years (reducing balance), or in line with how much it produces (units of production)? Has the way it is used
  changed since last year?"
- **Purpose:** the 17.22 method choice and the 17.23 review.
- **Accepted evidence:** usage or output records (required for units of production, with the total expected capacity),
  the prior-year policy, maintenance patterns.
- **Conditional follow-ups:** units of production chosen: ask for total expected output and this year's output (AC-13).
  Method changed: F-ESTIMATE-CHANGE.
- **Kind:** entity decision.

### Q6 `gross` (ref 17.31(d)) - R-22
- **Current wording:** "What are the gross amounts and accumulated deductions at each reporting date?" answered through
  six fields "Opening/Closing gross amount", "accumulated depreciation", "accumulated impairment" (`:1135-1179`).
- **Assessment:** "accumulated deductions" is not a term a junior will recognise; "gross amount" is ambiguous (gross of
  what?). The blank-versus-zero rule ("Blank is unknown; enter zero only when verified") is correct and must stay.
- **Proposed wording:** "At the start and at the end of the year: what was the total cost of this class before any
  depreciation (the gross carrying amount), how much depreciation had been charged on it in total, and how much
  impairment had been recognised in total? Leave a box empty if you do not know; type 0 only if the register shows
  zero."
- **Purpose:** 17.31(d) amounts and the gross-to-net check (AC-09, AC-10).
- **Accepted evidence:** fixed asset register totals at both dates; the prior-year equipment note for the opening
  amounts.
- **Conditional follow-ups:** opening gross or accumulated figures differ from the prior-year note: explain in the
  opening bridge (AC-23). Impairment exists: F-IMPAIRMENT.
- **Kind:** mandatory.

### Q7 `movements` (ref 17.31(e)) - R-23, R-20
- **Current wording:** "What supported movements explain the change in carrying amount?" answered through eight movement
  fields using the pack's labels (`:996-1017`), a source field and a coverage checkbox.
- **Assessment:** the question itself is fine. The field conventions are not (see section 3, Step 3). Labels such as
  "Acquisitions through business combinations", "Revaluations and impairment recognised or reversed in other
  comprehensive income" and "Transfers to and from investment property at fair value" are the Standard's wording and
  will not be understood without a one-line gloss and a "does this apply?" switch.
- **Proposed wording:** "What happened to this class during the year? For each kind of change give the amount and the
  record it comes from: purchases (additions), sales or scrapping (the carrying amount removed, not the money received),
  depreciation, impairment, transfers, and anything else. The difference between two trial balances is not an answer."
- **Purpose:** 17.31(e) reconciliation with evidence per movement (charter R5).
- **Accepted evidence:** fixed asset register movement report, general ledger movement accounts that the preparer has
  identified and reviewed, disposal records. Not accepted: the net change between two trial balances.
- **Conditional follow-ups:** disposals entered: F-DISPOSAL (proceeds, gain or loss). Additions entered: F-ADDITION-COST
  (what is in the cost; dates available for use). Impairment entered: F-IMPAIRMENT. Business combination or investment
  property transfer entered: outside this slice; must be flagged to a reviewer.
- **Kind:** mandatory.

### Q8 `restrictions` (ref 17.32) - R-24
- **Current wording:** "Are assets restricted or pledged, and are there contractual purchase commitments?"
- **Assessment:** two disclosures in one free-text field; "restricted" and "pledged" are legal terms. The hint "no
  balance in the TB is not proof of none" is right.
- **Proposed wording (two questions):**
  - "Is any equipment used as security for a loan, or does someone else hold title to it or restrict its use? If yes,
    which items and what is their carrying amount?"
  - "Has the entity signed contracts to buy equipment that had not been delivered by the year end? If yes, for what
    total amount?"
- **Purpose:** 17.32(a) and 17.32(b) separately.
- **Accepted evidence:** loan agreements and security schedules, charge or lien registers, board minutes, signed purchase
  orders or contracts. For "none": a dated confirmation from management naming the person who checked.
- **Conditional follow-ups:** security exists: cross-reference to the borrowings note. Commitments exist: F-EVENTS-AFTER
  may also apply.
- **Kind:** mandatory when applicable; always asked.

### Q9 `revaluation` (ref 17.33) - R-25
- **Current wording:** "If revaluation is used, what valuation evidence and additional disclosures are needed?" shown
  only when the basis is revaluation (`equipmentRequirements.ts:139-141`).
- **Assessment:** asking the preparer what disclosures are needed inverts the product's job. The five 17.33 items should
  be asked one by one.
- **Proposed wording:** "For the revalued class: (a) on what date was the valuation effective? (b) was an independent
  valuer involved? (c) what method and main assumptions were used? (d) what would the carrying amount be under the cost
  model? (e) what is the revaluation surplus at the start and end of the year, and are there restrictions on
  distributing it?"
- **Purpose:** 17.33(a)-(e).
- **Accepted evidence:** valuation report, surplus ledger, cost-model shadow register.
- **Conditional follow-ups:** the unsupported-OCI stop (Q3).
- **Kind:** mandatory when applicable.

## 3. Step-level labels and conventions (`src/components/reporting/EquipmentPreparation.tsx`)

| Location | Current | Assessment | Proposal |
|---|---|---|---|
| Step 1 source select (`:670-688`) | "Reviewed figure from another available record" | Vague: which record? | "A figure from last year's ledger or register, with its reference" |
| Step 1 amount (`:821`) | "Equipment carrying amount as printed at that date" | "Carrying amount" needs a gloss for juniors | "Equipment net amount as printed (cost less depreciation; sometimes called net book value)" |
| Step 1 units (`:847-861`) | "Units printed in the source" with whole / thousands / millions | Good; the normalised preview (`:864-868`) is the right control | Keep; add "Look for 'TZS '000' or similar in the column heading" |
| Step 1 confirm (`:870-895`) | Long sentence naming entity, date, currency, units, amount | Correct content; long | Split into four short checkboxes or keep one with line breaks |
| Step 2 heading (`:902`) | "Explain the opening position" | Does not say what is being compared | "Agree this year's opening amount to last year's closing amount" |
| Step 2 adjustment amount (`:925-929`) | "Signed adjustment amount" | "Signed" is jargon | "Adjustment amount (use a minus sign to reduce the opening amount)" |
| Step 2 anchor message (`:969-974`) | "record the period dates in Trial Balance intake before saving" | A product-operation instruction inside an accounting step (charter A4 Log B risk) | Link directly to the intake page; show the saved dates |
| Step 3 sign convention (`:996-1017`) | "(positive amount for a decrease)" on depreciation and disposals; "(signed amount)" on 'either' kinds | Two conventions on one form; a junior will type -2,000 for depreciation (accepted, stored negative) or 2,000 for an impairment reversal (stored as a decrease). Reducing-balance users will not know what "either" means | One convention: amounts always positive; each row has "Increases / Decreases the carrying amount" shown as fixed text for fixed-sign kinds and as a choice for 'either' kinds |
| Step 3 blank vs zero (`:990-995`) | "Leave unused movement fields blank; enter a known zero as zero" | Correct distinction, easy to miss | Per-row state: "Not applicable / Zero (checked) / Amount" |
| Step 3 coverage checkbox (`:1042-1058`) | "I checked that these movements cover every change..." | This is the only completeness control (G-1) | Keep, and add the source row reference per movement |
| Step 4 counter (`:1078-1082`) | "Equipment preparation inputs: N still need attention" | Fine | Keep |
| Step 4 gross hint (`:1137-1141`) | "Enter accumulated deductions as positive amounts..." | "Deductions" again | "Enter depreciation and impairment totals as positive numbers" |
| Step 4 policy fields (`:1220-1239`) | Four free-text boxes | See Q4 | Structured life (number + years/units) and residual value (amount or percentage) per class, plus the four 17.21 prompts |
| Step 5 replacement (`:1292-1305`) | "Replace the existing whole PPE schedule with this one asset class. I have included every relevant equipment amount." | Dangerous for multi-class entities: a junior may confirm and silently drop a class (AC-27) | Block when the existing schedule has more than one class; otherwise keep |
| Disclosure preview (`:473-493`) | Gross figures printed as typed; carrying amounts formatted | Inconsistent presentation in one note | Format every amount through `formatMinor` |
| Server bridge target (`EquipmentServerBridge.tsx:291-306`) | "Equipment within subclassifications and asset disclosures" | Pack jargon from the 4.11 label | "Equipment note (classes, cost, depreciation and movements)" |

## 4. Proposed conditional follow-up questions not in #207

Each has a trigger, a purpose, accepted evidence and the requirement it serves. None is asked unless its trigger fires
(charter 11.5: ask only unanswered applicable questions).

| Id | Trigger | Question | Purpose / requirement | Accepted evidence |
|---|---|---|---|---|
| F-SPARES | Q1 answer mentions spares, stand-by or servicing equipment | "Which spare parts or stand-by items are expected to be used for more than one year?" | 17.5 (R-03) | Inventory and register listings |
| F-REPLACE | Q7 additions include a replacement part or inspection | "What part or inspection was replaced, and what was its remaining carrying amount?" | 17.6, 17.7 (R-04) | Invoices; register entry for the replaced part |
| F-ADDITION-COST | Q7 additions entered | "What is included in the cost of each addition (price after discounts, delivery, installation, testing)? Were any start-up, training, advertising, administration or interest costs included? When was each item ready for use?" | 17.9-17.12, 17.20, 25.2 (R-06, R-07, R-16) | Invoices; commissioning record |
| F-DEFERRED | An addition is paid over more than normal credit terms or by exchange | "What is the cash price today (or the fair value of the asset given up), and how was it determined?" | 17.13, 17.14, 11.13 (R-09) | Contract; discount-rate working |
| F-DISMANTLE | The entity must remove equipment or restore a site when use ends | "What will it cost, when, and is a provision recorded?" | 17.10(c), 21.4-21.5, 21.14 (R-08) | Lease or licence terms; estimate working |
| F-DISPOSAL | Q7 disposals entered | "For each item sold, scrapped or lost: date, original cost, depreciation to date, money received." | 17.27-17.30 (R-20) | Sale agreement; receipt; register entry |
| F-IMPAIRMENT | Always asked once per period (assessment is mandatory); measurement questions only if an indicator exists | "Is there any sign that equipment is worth less than its carrying amount (damage, obsolete, idle, planned early sale, market fall)? If yes, what is the recoverable amount and who prepared it?" | 17.24-17.26, 27.5-27.9, 27.30, 27.32 (R-19) | Indicator checklist signed by management; recoverable-amount working (governed workpaper) |
| F-ESTIMATE-CHANGE | Q4 or Q5 differs from the prior year | "What changed, what is the new estimate, and what is the effect on this year's depreciation?" | 17.19, 17.23, 10.16-10.18 (R-15) | Revised schedule; evidence of the indicator |
| F-LEASE | Q1 shows items used but not owned | "Does the lease transfer substantially all the risks and rewards of ownership? If yes: fair value, present value of minimum payments, term, and whether ownership transfers." | 20.9-20.13 (R-28) | Lease agreement; payment schedule |
| F-GRANT | Q1 shows government funding or donation | "What conditions attach to the grant, and has it been recognised in income or as a liability?" | 24.4-24.6 (R-29) | Grant agreement |
| F-EVENTS-AFTER | Always asked once per period, feeding the existing `smes.note.events_after` decision | "After the year end but before these statements are authorised, did the entity buy, sell, lose or commit to major equipment?" | 32.10-32.11 (R-30) | Board minutes; contracts |
| F-TRANSITION | The report is the entity's first under the IFRS for SMEs | "Did the entity elect fair value or a previous revaluation as deemed cost for any equipment at the transition date?" | 35.7, 35.10(c)-(d), 35.13 (R-31) | Transition working; valuation |
| F-CLASSES | Always asked before Step 3 | "How many classes of equipment does the entity report, and which accounts belong to each?" | 4.11(a), 17.31 per class (R-01, R-32) | Register; presentation assignments |

## 5. Cross-cutting rules the questions must respect

- **Unknown, none and zero are three states.** The candidate's blank-versus-zero rule for gross amounts and movements
  is correct; every new question needs the same (an empty answer is not "none").
- **"None" needs evidence.** Restrictions, commitments, components, impairment indicators and events after the period
  can all be "none"; each "none" must name who checked and what was checked.
- **Templates are examples.** Any illustrative report, prior-year note, tax table or fixture value is an example. The
  product must never pre-fill a life, rate, residual value or method from one.
- **Questions about operating the product are defects** (charter A4). Instructions such as "record the period dates in
  Trial Balance intake" belong in a link or an automatic read, not in an accounting step.
- **Paragraph references stay visible but secondary.** The candidate shows "Source reference: 17.31(d)" with a link to
  Module 17 (`EquipmentPreparation.tsx:1123-1130`). The link points to educational material, not the Standard; it should
  name the Standard paragraph and say the module is a guide (see HANDOFF.md section 6 on licensing).
