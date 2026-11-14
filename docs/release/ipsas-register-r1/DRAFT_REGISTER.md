# IPSAS (accrual) framework register: DRAFT for the author and reviewer

> **STATUS: DRAFT. UNSIGNED. NOT ACCOUNTING ADVICE.** Prepared by the engineering assistant from what the CODE does on `main` on 2026-10-31.
> Nothing here has been written or checked by an accountant. **Every "proposed status" below is a claim about the software, not about IPSAS.**
> Until the author has supplied the citations and the reviewer has signed a row, that row is **not** `supported` and the product must not claim it
> (charter R11, R12). I have **not** verified any paragraph reference: the citation column is deliberately empty for the author to fill.

Charter reference: `docs/architecture/CFOCLOSE_DEVELOPMENT_CHARTER.md`, entity L7 (FrameworkRegister), rules R11 and R12, build item B6, section 9.
Planning inventory for the wider IPSAS list: `docs/architecture/FINANCIAL_REPORTING_COVERAGE_MATRIX.md` section 4 (rows IP-01 .. IP-30).

## Who

| Role | Name | Qualification and registration | Independence declaration | Date |
|---|---|---|---|---|
| Accounting author | Humphrey (named by the team 2026-10-31) | _to be completed_ | n/a | |
| Independent reviewer | Sawe (named by the team 2026-10-31) | _to be completed_ | _Reviewer confirms they did not write these rows and have no interest in the entity used for the test_ | |
| Technical owner (B6) | _not yet named_ | | | |

## How to use this document (for Humphrey and Sawe)

For each row below:

1. **Author:** read "What the product does", then (a) confirm or change *when it applies*, (b) write the **authoritative source citation** (standard, edition, paragraph), (c) say whether the treatment is correct, in your words, (d) check the expected results in the named test or fixture, (e) mark **Agree / Change needed / Cannot support**.
2. **Reviewer:** repeat independently, without reading the author's marks first, then compare and sign.
3. **Changes:** you comment; engineers change the code and re-run the tests. You never edit code.
4. A row becomes `supported` only when: citation present, author marked Agree, reviewer marked Agree and signed, and the named test passes.

Statuses (charter L7): `supported` / `external-workpaper` / `unsupported` / `not-assessed`. "Proposed" below means what the code seems to implement, **not** a decision.

## Scope of this draft

Only the three IPSAS areas that were actually built: **PPE (cost model)**, **revenue and grants by period**, and **presentation (statement review)**. Everything else in the IPSAS list is `not-assessed` or `unsupported`; see the last section. This draft says nothing about IFRS for SMEs.

## Summary

| Row | Area | What it covers | Proposed status | Evidence (tests / fixtures) |
|---|---|---|---|---|
| PPE-1 | PPE (matrix IP-27) | Measurement model: cost only | supported (cost) / unsupported (revaluation) | `src/lib/ipsasAccrual/ipsasAccrual.test.ts` |
| PPE-2 | PPE | Entity questions that route out of the product | unsupported if answered "yes" | same |
| PPE-3 | PPE | Depreciation from the entity's own estimates | supported | same |
| PPE-4 | PPE | Roll-forward by class and disposals | supported | same |
| PPE-5 | PPE | Reconciliation to the certified trial balance | supported | same |
| PPE-6 | PPE | Opening bridge from the published closing figures | supported | same |
| PPE-7 | PPE | Generated policy note and statement line | external-workpaper (draft wording) | `policyNote.ts`; only referenced by `ipsasAccrual.test.ts`, no dedicated test found |
| REV-1 | Revenue and grants (IP-29) | Which vocabulary applies, by period start | supported (reviewed range only) | `src/lib/ipsasAccrual/grants.test.ts`, `grants.fixture.ts` |
| REV-2 | Revenue and grants | Classification with basis and evidence | supported | same |
| REV-3 | Revenue and grants | Revenue measure | supported | same |
| REV-4 | Revenue and grants | Liability and receivable | supported | same |
| REV-5 | Revenue and grants | Obligations and evidence of satisfaction | supported | same |
| REV-6 | Revenue and grants | Prior cumulative revenue and reversals | supported (input) / unsupported (reversal) | same |
| REV-7 | Revenue and grants | Situations left open on purpose | unsupported | same |
| REV-8 | Revenue and grants | Reconciliation to the certified trial balance | supported | same |
| REV-9 | Revenue and grants | Reviewer confirmation of each grant | control, not a requirement | same |
| PRES-1 | Presentation (IP-01) | Caption vocabulary, 37 captions (a draft list) | external-workpaper (draft) | `scripts/db-proof/ipsasStatementReview.mjs` |
| PRES-2 | Presentation | Assigning every account to a caption or a reviewed zero | supported | same |
| PRES-3 | Presentation | When statements are composed, and the totals | supported | same |
| PRES-4 | Presentation | Comparatives | external-workpaper (reference only) | same |
| PRES-5 | Presentation | Why official issuance is refused | unsupported | same |

---

## PPE: cost-model preparation (matrix IP-27)

Code: `src/lib/ipsasAccrual/ppeWorkpaper.ts`, `openingBridge.ts`, `policyNote.ts`. The product names standards **at standard level only**.

**PPE-1 Measurement model.**
- *Does:* each asset class must state `cost` or `revaluation`. Only the cost model is computed. `revaluation` stops with `REVALUATION_MODEL_NOT_SUPPORTED`; a blank model stops with `MEASUREMENT_MODEL_REQUIRED`; an estimate that does not state the cost basis stops with `MEASUREMENT_BASIS_MISMATCH`.
- *Applies when:* the entity has PPE balances.
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-2 Entity questions that route out.**
- *Does:* five questions. Heritage assets, infrastructure assets, impairment indicators and held-for-sale items, if answered "yes", make the work **unsupported** (they route to IPSAS 45 heritage/infrastructure requirements, IPSAS 21/26 impairment, IPSAS 44). Commitments and restrictions are a disclosure prompt only and do not stop the work.
- *Author question:* is this the right set of exclusions for the first scope? Is anything missing?
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-3 Depreciation.**
- *Does:* the entity's **own** useful life, rate, residual value and convention are required inputs and must be confirmed by management. The calculator never supplies one (`ESTIMATE_MISSING`, `ESTIMATE_BASIS_MISSING`, `ESTIMATE_UNCONFIRMED`, `CONVENTION_REQUIRED`). The register charge must agree with the depreciation expense in the trial balance, or the difference must be explained (`CHARGE_SOURCE_REQUIRED`, `CHARGE_DIFFERENCE_UNEXPLAINED`, `TB_DEPRECIATION_DIFFERENCE`, `REGISTER_CHARGE_INCOMPLETE`, `DEPRECIATION_MOVEMENT_NOT_EXACT`).
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-4 Roll-forward and disposals.**
- *Does:* per class, opening + movements = closing. Movement kinds carried: additions, disposals, impairment through profit or loss, depreciation, other. Any other kind is refused (`UNSUPPORTED_MOVEMENT_KIND`). A roll-forward that does not agree stops the work (`ROLL_FORWARD_DIFFERENCE`, `ROLL_FORWARD_INCOMPLETE`). A disposal needs its proceeds (`DISPOSAL_PROCEEDS_UNKNOWN`); gain or loss is computed from them. Items must add to the class (`ITEMS_COST_NOT_CLASS_GROSS`, `ITEMS_ACCUMULATED_NOT_CLASS_OPENING`).
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-5 Reconciliation to the certified trial balance.**
- *Does:* opening and closing carrying amounts and depreciation expense are read from the certified trial balance and must agree (`TB_CARRYING_OPENING`, `TB_CARRYING_CLOSING`, `TB_DEPRECIATION`). A figure that cannot be read is "unknown", never zero.
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-6 Opening bridge.**
- *Does:* each opening line is compared with the prior period's published closing figure. Status per line: `agrees`, `bridged`, `unexplained`, `published-unconfirmed`, `published-missing`, `opening-missing`. A difference can be bridged only by a recorded item of kind reclassification, prior-period error, policy transition, scope change or posted journal, each with an authority reference and evidence. Blockers: `NO_OPENING_LINES`, `OPENING_FIGURE_MISSING`, `OPENING_RESIDUAL_UNEXPLAINED`, `PUBLISHED_FIGURE_MISSING`, `PUBLISHED_FIGURE_UNCONFIRMED`.
- *Author question:* are these five bridge kinds right and complete? Is "scope change" ever acceptable without more?
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PPE-7 Policy note and statement line.**
- *Does:* generates a draft policy note and the statement line from **confirmed** facts only, labelled "Prepared from confirmed facts, review required". Unresolved blocks stay marked unresolved. Note numbering and cross-references are not built.
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

## Revenue and grants by period (matrix IP-29)

Code: `src/lib/ipsasAccrual/grants.ts`, SQL twin in migration `20261208100000_ipsas_grants.sql`. Source document: `docs/release/ipsas-accrual-chain-r1/GRANTS.md`. Its own "remaining accounting-review gaps" section already says **no paragraph-level mapping has been reviewed**.

**REV-1 Which vocabulary applies.**
- *Does:* the **reporting period start** comes from the certified upload, never typed. Start before 1 Jan 2026: "restriction-only" or "enforceable-condition" (the IPSAS 23 vocabulary). From 1 Jan 2026: "binding-arrangement", "without-binding-with-present-obligation", "without-binding-no-present-obligation" (the IPSAS 47 vocabulary). A classification from the other set stops the work (`CLASSIFICATION_PERIOD_MISMATCH`). Only periods starting from 1 Jan 2024 to before 1 Jan 2027 are reviewed (`PERIOD_PROFILE_NOT_REVIEWED` outside).
- *Author question:* is the 1 Jan 2026 split right for this entity (early application, Tanzanian adoption date)? Is the reviewed range right?
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-2 Classification.** *Does:* every grant needs a classification, a written basis (at least 8 characters), and evidence (`GRANT_CLASSIFICATION_REQUIRED`, `GRANT_BASIS_MISSING`, `AGREEMENT_EVIDENCE_MISSING`). Duplicate grant ids or references are refused. *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-3 Revenue measure.**
- *Does:* where a grant has obligations, revenue is the **sum of the amounts evidenced as satisfied** per obligation. For a pure restriction or "no present obligation", revenue is the resources recognised. **Cash received and expenditure never enter the formula.** Period revenue = cumulative revenue minus prior cumulative revenue.
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-4 Liability and receivable.** *Does:* liability = recognised resources minus cumulative revenue (so a restriction alone is not a liability; an unsatisfied condition is). Receivable = recognised resources minus cash received. *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-5 Obligations and satisfaction.**
- *Does:* obligation amounts must add up to the consideration (`OBLIGATION_ALLOCATION_MISMATCH`, `OBLIGATIONS_REQUIRED`); satisfied may not exceed allocated (`OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION`); each satisfied amount needs a stated basis (milestone delivered, output measure, time elapsed, agreement-stated expenditure) and evidence (`SATISFACTION_EVIDENCE_MISSING`). Obligations on a classification with none are refused (`OBLIGATIONS_CONTRADICT_CLASSIFICATION`).
- *Author question:* is this list of satisfaction bases complete and appropriate?
- *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-6 Prior cumulative revenue and reversals.** *Does:* prior cumulative revenue is a typed, **evidenced input** (`PRIOR_REVENUE_EVIDENCE_MISSING`), not read from an issued prior schedule. If it exceeds the current cumulative figure, the work stops and a workpaper is required (`REVENUE_REVERSAL_WORKPAPER_REQUIRED`). *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-7 Left open on purpose (all `unsupported`, each stops the work).**
Variable consideration, financing, agency, non-cash resources, modification, collection doubt (credit loss), foreign currency (`COMPLEX_GRANT_WORKPAPER_REQUIRED`, `COMPLEXITY_UNANSWERED`); grants not fully funded (`NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED`); cash above recognised resources (`CASH_EXCEEDS_RECOGNISED_RESOURCES`); early application of the new standard and first-period transition (`ENTITY_QUESTION_UNRESOLVED`, `SPECIALISED_ROUTE_REQUIRED`). Not built at all: multi-year conditional funding, receivable impairment, grants in kind, pass-through grants, transfer expenses (the paying side), donor or fund views. *Author question:* which of these does the first test entity actually have? *Author:* ____  *Reviewer:* ____

**REV-8 Reconciliation.** *Does:* total period revenue, total liability and total receivable must each tie **exactly** to certified trial-balance sums over the account keys the preparer chose (`TB_GRANT_REVENUE_DIFFERENCE`, `TB_GRANT_LIABILITY_DIFFERENCE`, `TB_GRANT_RECEIVABLE_DIFFERENCE`; unknown if a key is missing). There is no "explained difference" escape in this slice. *Citation:* ______  *Author:* ____  *Reviewer:* ____

**REV-9 Reviewer confirmation (a control).** *Does:* a person with the review capability confirms ONE grant's exact content, bound to the period start; any change voids the confirmation (`GRANT_ASSESSMENT_UNCONFIRMED`). Preparer entries are proposals until then. *Reviewer:* ____

## Presentation: statement review (matrix IP-01)

Code: migration `20261210100000_ipsas_statement_review.sql` and `StatementReviewWorkspace.tsx`. Work plan: `docs/release/ipsas-statement-review-r1/WORK_PLAN.md`.

**PRES-1 Caption vocabulary.** *Does:* 37 captions (24 for the statement of financial position, 13 for the statement of financial performance) for the statement of financial position (SFP) and statement of financial performance (SFPERF), each tied to a section: current and non-current assets, current and non-current liabilities, equity, income, expense. The source file itself calls this a **"draft vocabulary, not the minimum/full requirement universe"**. *Author question:* what is missing against the minimum line items for the first scope? (Listed in the next block.) *Citation:* ______  *Author:* ____  *Reviewer:* ____

The captions: cash and equivalents; receivables (current, non-current); inventories; prepayments; other assets (current, non-current); PPE; intangibles; right-of-use; investment property; payables and accruals; grant or revenue-arrangement liabilities (current, non-current); borrowings (current, non-current); lease liabilities (current, non-current); other liabilities (current, non-current); contributed capital; reserves; fund balances; accumulated surplus or deficit; tax revenue; grants and transfers revenue; donations; fees and services; investment income; other revenue; employee expenses; supplies and services; depreciation and amortisation; impairment; transfer expenses; finance costs; other expenses.

**PRES-2 Assignment.** *Does:* the preparer assigns every account to a caption **of the same section** as the account's classification. A zero-balance account may instead carry a reviewed zero disposition ("movement source reviewed" or "non-reporting reviewed") with a written reason of at least 8 characters. Status per account: `presented`, `reviewed_zero`, `unassigned`, `needs_confirmation` (when the source changed since the last save). *Author question:* are zero dispositions acceptable at all, and with what reason? *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PRES-3 Composition and totals.** *Does:* statements are composed only when every account is `presented` or `reviewed_zero` **and** the trial balance balances (difference zero). Totals: assets, liabilities, net assets = equity + revenue - expenses, surplus = revenue - expenses. Otherwise the state is `incomplete` and no totals are shown, only the balance difference. *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PRES-4 Comparatives.** *Does:* the prior period is usable only if it exists, has the same currency and exponent, and ends the day before the current period starts. It is labelled **"Prior certified TB, reference only, not an audited comparative"**. Transition handling for comparatives is not built. *Citation:* ______  *Author:* ____  *Reviewer:* ____

**PRES-5 Why official issuance is refused.** The screen states four reasons: (1) the full IPSAS requirement register and accounting acceptance are outstanding; (2) trial-balance completeness and the pre-close performance basis need confirmation, because a balanced trial balance does not prove complete revenue and expenses; (3) cash-flow and component net-assets workpapers, budget applicability, complete notes and comparative transition handling are not integrated; (4) the reviewed approval and frozen-issuance path is not integrated. *Author question:* once this register is signed, which of these four still remain? *Author:* ____  *Reviewer:* ____

---

## Not built / not assessed (so nobody assumes otherwise)

From the planning matrix, these IPSAS rows have **no product support** today and are `not-assessed` or `unsupported` until someone decides otherwise: **IP-02 cash flow (IPSAS 2)**, **IP-15 budget information (IPSAS 24, marked Critical in the matrix)**, **IP-30 transfer expenses (IPSAS 48)**, and the rest of IP-03 .. IP-26, IP-28 (policies and errors, foreign currency, borrowing costs, inventories, provisions, related parties, impairment, financial instruments, leases, employee benefits, first-time adoption, group reporting and others). The matrix's own first scope (a single controlled entity with a public approved budget) means **IP-15 matters**; the first test entity will show whether a budget comparison is required.

## Sign-off

| | Author | Reviewer |
|---|---|---|
| Name and qualification | | |
| All rows above marked | | |
| Rows changed or refused (list) | | |
| Signature | | |
| Date | | |
