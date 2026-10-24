# IPSAS Accrual Specification

| | |
|---|---|
| **Document ID** | CFR-IPSAS-4 (supersedes CFR-IPSAS-3, CFR-IPSAS-2 and draft RFC-FW-001; none committed) |
| **Status** | PROPOSED · Track B · provisional |
| **Baseline** | `f3d1b40` (no IPSAS code exists on the baseline or on the Track A branch) |
| **Shared contracts** | `FINANCIAL_REPORTING_MASTER_SPEC.md`: evidence classes §0, identity §6, concurrency §7, manifest §9, treatments/allocation/applicability/materiality/transitions §10, publication §11, operating models §12, open items §13. This document holds IPSAS-specific content only. |
| **Coverage rows** | IP-01…IP-35 (`FINANCIAL_REPORTING_COVERAGE_MATRIX.md` §4) · **Packages** B11, B12 (`FINANCIAL_REPORTING_DELIVERY_PLAN.md` §2) |

## 1. Owner decisions and their consequences

| Decision | Source | Consequence |
|---|---|---|
| First IPSAS customers close FY ending 30 June 2027 (period 1 July 2026 – 30 June 2027) | Owner, 2026-10-24 (O) | The period begins after 1 Jan 2026, so IPSAS 47 and IPSAS 48 are **mandatory internationally** for it (IPSAS 48 para 62, primary text; IPSAS 47: IPSASB announcement of an effective date of 1 January 2026, primary summary — the paragraph text is Q-1). The October 2024 amendments to IPSAS 47 (paras 194A, 203A; effective 1 Jan 2027) are **not mandatory** for this period; applying them early is an election (§5.3). Tanzanian adoption for that period: **Q-2**. The comparative period (1 July 2025 – 30 June 2026) began before 1 Jan 2026: the first close is an **initial-application year**. |
| IPSAS and IFRS for SMEs are priority frameworks | Owner (O) | Delivery plan §3 |

## 2. Applicability and scope

### 2.1 Who applies IPSAS (corrected)

The earlier draft excluded "Government Business Enterprises". That wording is **obsolete**: in April 2016 the IPSASB removed the GBE scope paragraph from every IPSAS, replaced the term with "commercial public sector entities", and described the entities IPSAS are designed for through characteristics in the revised Preface, recognising that jurisdictions decide which standards apply (*The Applicability of IPSASs*, master §0.5). Current scope paragraphs follow this: IPSAS 47 para 3 and IPSAS 48 para 3 apply to an entity that prepares and presents financial statements under the accrual basis.

CFOClose therefore records, per entity, **eligibility facts** (public sector characteristics per the Preface; whether the entity is a commercial public sector entity) and the **jurisdictional requirement** that applies (master §6.3). Known Tanzanian instrument: NBAA Technical Pronouncement No. 3 of 2020 requires NGOs and Associations to apply IPSAS for periods beginning on or after 1 July 2021. The instruments governing central government entities, LGAs and public bodies, and their basis (accrual or cash), are **Q-2**.

### 2.2 First IPSAS scope (when authorized)

Single controlled entity; approved budget publicly available; functional currency = presentation currency; prior period reported under accrual IPSAS; trial-balance-derived provenance.

### 2.3 Refused in the first scope (reason codes)

| Situation | Code | Note |
|---|---|---|
| Approved budget not publicly available | `BUDGET_NOT_PUBLIC_OUT_OF_SCOPE` | **Launch boundary, not a compliance judgment.** IPSAS 24 applies to entities that make approved budgets publicly available and does not require publication (IPSAS 24 paras 2–5, earlier-edition text). Product text: "not supported in this release". |
| Controlled entities, associates, joint arrangements | `GROUP_REPORTING_UNSUPPORTED` | |
| Prior period not accrual IPSAS | `FIRST_TIME_ADOPTION_UNSUPPORTED` | IPSAS 33 incl. paras 43A–43B relief for IPSAS 48 |
| FX operations; functional ≠ presentation currency | `FOREIGN_OPERATION_UNSUPPORTED`, `FUNCTIONAL_CURRENCY_DIFFERS_UNSUPPORTED` | |
| Commercial public sector entity applying IFRS by jurisdictional rule | `ENTITY_INELIGIBLE_FOR_FRAMEWORK` | Only when the jurisdiction profile says so |
| Topics without capability (coverage rows marked B) | `TREATMENT_CAPABILITY_UNSUPPORTED:<topic>` | Blocked only when applicable |

## 3. Requirement profile

`ipsas_accrual/2026-handbook` labels the resolved set for periods beginning on or after 1 January 2026 without elections, as adopted by the jurisdiction profile: IPSAS 1–51 in the 2026 Handbook, with IPSAS 9, 11 and 23 superseded by IPSAS 47. Effective dates and their verification class: coverage matrix §3.

## 4. Statements, lines and vocabularies

### 4.1 Statements

| Code | Statement | Source |
|---|---|---|
| `SFP` | Statement of financial position | Allocation family `FACE_LINE` over adjusted TB |
| `SFPERF` | Statement of financial performance (by nature first; by function later via `FUNCTION` family) | Same |
| `SCNA` | Statement of changes in net assets/equity | `EQUITY_MOVEMENTS` evidence with IPSAS vocabulary (§4.3) |
| `SCF` | Cash flow statement (direct method first) | `TRANSACTION_LEDGER` + `CASH_ACCOUNT_MAP` (existing) |
| `SCBA` | Comparison of budget and actual amounts, or budget columns where permitted | §6 |
| Notes | Compliance, policies (policy register), judgements, estimates, requirement-driven disclosures | Pack catalogue + treatment cases |

### 4.2 Proposed lines (reviewer decision; namespace `ipsas26.*`)

- **Assets:** cash and cash equivalents; receivables from transactions with binding arrangements; receivables from transactions without binding arrangements (taxes, transfers); inventories; prepayments; other financial assets; PPE (IPSAS 45); intangibles; investment property; right-of-use assets (IPSAS 43); held for sale (IPSAS 44).
- **Liabilities:** payables; liabilities for unsatisfied obligations under revenue arrangements; transfer liabilities (IPSAS 48); borrowings; lease liabilities; employee benefits; provisions.
- **Net assets/equity:** contributed capital; reserves; accumulated surplus/(deficit).
- **Revenue:** taxes; transfers from other government entities; grants and donations; fees, fines, penalties and licences; sale of goods and services; investment income; other.
- **Expenses:** employee costs; supplies and consumables; depreciation and amortisation; impairment; transfer expenses; finance costs; other.
- **Result:** surplus/(deficit) for the period.

### 4.3 Net-asset movement vocabulary

The existing schema (`src/lib/financialEvidence/schemas.ts:39-49`) uses IFRS vocabulary. The IPSAS pack adds a vocabulary discriminator with: opening balance; surplus/(deficit); contributions from owners; distributions to owners; transfers between components; revaluation; policy changes; error corrections; other; closing balance.

### 4.4 Cash-flow classes

`CASH_FLOW_CLASS` family: operating receipts (taxes; transfers; grants; sales; interest), operating payments (employees; suppliers; transfers; interest), investing, financing. Existing roll-forward and closing-cash ties unchanged.

## 5. Revenue (IPSAS 47) and transfer expenses (IPSAS 48)

### 5.1 Treatment topics (governed judgments; master §10.3)

| Topic | Unit of account | Facts | Conclusion |
|---|---|---|---|
| `IPSAS47.GATEWAY` | Arrangement class | Enforceability by legal or equivalent means; rights and obligations | Binding arrangement yes/no |
| `IPSAS47.WITH_BINDING` | Arrangement or class | Compliance obligations; transaction consideration; allocation; satisfaction pattern | Revenue, liability, receivable |
| `IPSAS47.WITHOUT_BINDING` | Class | Enforceable obligation linked to inflow; increase in net assets | Immediate or deferred recognition |
| `IPSAS47.SERVICES_IN_KIND` | Class | Election; nature | Recognised with disclosures, or not recognised |
| `IPSAS48.TRANSFER` | Agreement or class | Binding arrangement; enforceable right over the recipient's obligations | Expense timing; transfer asset/liability |

Topic facts are from the IPSASB *At a Glance* summaries (primary summary); topic schemas cite verified paragraphs when authored (B7, `SPEC INCOMPLETE`). CFOClose does not decide enforceability; it enforces completeness, conservation and consequent entries.

### 5.2 Allocation

Revenue and transfer accounts often mix models. Each source amount is allocated in `REVENUE_MODEL` / `TRANSFER_EXPENSE_MODEL` to its case under conservation and the residual rule (master §9.3). Unallocated amounts block only dependent outputs.

### 5.3 Initial application in FY 2026/27

| Standard | Transition (source) | Model in CFOClose |
|---|---|---|
| IPSAS 48 | **Verified (para 64):** choose (a) prospective — apply to transfers on or after the date of initial application, with and without binding arrangements; or (b) retrospective to each prior period presented under IPSAS 3. No practical expedients in paras 62–64. Early application only together with IPSAS 47 (para 62). | Change event `NEW_STANDARD_INITIAL_APPLICATION` with method ∈ {`PROSPECTIVE`, `RETROSPECTIVE_IPSAS3`}; prospective: comparatives as reported under prior policy with disclosure of the change; retrospective: restatement entries via existing restatement machinery |
| IPSAS 47 | See the table below. Transition methods and practical expedients **not verified (Q-1)** | Pack transition rule left empty → `TRANSITION_METHOD_NOT_PERMITTED` for every method until the IPSAS reviewer encodes the verified paragraphs. **No IPSAS report can reach REVIEWED until then.** |

**IPSAS 47 effective date, amendment dates and early application — kept separate (sources: master §0.5):**

| Item | What is established | Class | Consequence for FY 1 July 2026 – 30 June 2027 |
|---|---|---|---|
| Original IPSAS 47 (issued May 2023; supersedes IPSAS 9, 11, 23) | Effective for periods beginning on or after **1 January 2026**; earlier application permitted | Primary summary (IPSASB May 2023 announcement). The paragraph (194) was **not** retrieved | **Mandatory** |
| Conditions on early application of the original standard | IPSAS 48 may be applied early only together with IPSAS 47 (IPSAS 48 para 62, primary text). Any condition stated in IPSAS 47 para 194 itself: **unverified** | Primary (IPSAS 48) / U (IPSAS 47) | Not relevant: the period is not an early-application period |
| Amendments by *Concessionary Leases and Other Arrangements Conveying Rights over Assets* (October 2024): paras **194A and 203A added** (and application guidance) | Effective **1 January 2027**; earlier application permitted | Primary: the amendment table in `C06_IPSAS_47.pdf`; the IPSASB October 2024 announcement | **Not mandatory** (period begins 1 July 2026). Early application is an election recorded as a change event with the conditions of final para 194A |
| Wording of final para 194A (early-application conditions) and 203A (right-of-use transition) | **Unverified.** ED 88 proposed: disclose early application and apply IPSAS 43, 45, 46, 47 and 48 at the same time; 203A applies IPSAS 43's right-of-use transition to rights-of-use in kind | ED text only — **not** used as a requirement | Election blocked (`TRANSITION_METHOD_NOT_PERMITTED`) until the final text is encoded |
| Transition paragraphs of the original standard (between para 194 and 203A) | Not retrieved; methods, expedients and comparative treatment unknown | U (Q-1) | Initial-application method cannot be offered yet |

Comparatives are restated **in the current report** where the chosen method requires it; the FY 2025/26 FINAL report, if issued in CFOClose, is **not reissued or modified** (master §10.5).

## 6. Budget information (IPSAS 24)

Paragraph references are from the IFAC IPSAS 24 publication consulted (an **earlier Handbook edition**, still using GBE wording; current-edition text to be pinned, Q-7).

### 6.1 Model and intake

The budget model is IPSAS-specific and is specified only here: `bu_budgets` (legislative level, budget period, basis `CASH|MODIFIED_CASH|ACCRUAL|MODIFIED_ACCRUAL|COMMITMENT`, classification basis, entity perimeter, approval reference), `bu_budget_versions` (`ORIGINAL|AMENDMENT|FINAL`, approval date and reference, evidence digest), `bu_lines`, `bu_amendments` (cause `REALLOCATION|OTHER`, explanation). Records immutable; lifecycle events and projections per master §6.1.

Intake: canonical template; optional AI extraction from the published budget as `FILLS_REQUIRED_DECISION` proposals accepted line by line; control totals entered independently and required to equal accepted lines. Existing evidence kind `BUDGET` carries the source file (source-byte identity, master §9.2).

### 6.2 Presentation

Separate SCBA when budget and statements are not on a comparable basis (para 23); budget columns on primary statements only when basis, classification, entity and period are all comparable (paras 21–22); one comparison per level of legislative oversight (para 14); optional variance column (para 15); explanation of original-to-final changes (para 29).

### 6.3 Comparable-basis actuals

For cash or modified-cash budgets, actuals are computed from the transaction ledger allocated to budget lines, subject to controls: full date coverage of the budget period; every TB cash account reconciled account by account (existing rule); inter-account transfers identified and excluded; reversals paired; duplicates refused (existing replay identity); every ledger row allocated to exactly one budget line (conservation). A ledger total tying to cash does not by itself prove complete or correctly classified actuals. Externally prepared actuals follow the external schedule contract (master §10.4) plus budget-line code matching.

### 6.4 Explanations and disclosures

Material differences explained (para 14(c)) unless explained in a cross-referenced public document; threshold from **financial-statement materiality** (master §10.7; no audit thresholds). Budgetary basis and classification (para 39); budget period (para 43); entities included (para 45).

### 6.5 Reconciliation (para 47), each target separately

| Budget basis | Targets |
|---|---|
| Accrual | Total revenues; total expenses; net cash flows from operating, investing and financing activities |
| Other | Net cash flows from operating, investing and financing activities, to the IPSAS 2 statement (para 51) |

For each target: comparable-basis actual + basis + timing + entity (+ presentation, para 48) differences = statement amount, exactly. Failure → `BUDGET_RECONCILIATION_UNMET:<target>`; targets never combined. Not required when basis, period, entity and format all match (para 50). Prior-period comparisons not required (paras 52–53).

## 7. Leases (IPSAS 43) disclosures — corrected

Lessee lease-liability maturity analysis is presented separately from other financial liabilities, applying IPSAS 30 paras 46 and AG12 (IPSAS 43 para 61). Lessor maturity analyses are of **undiscounted** lease payments; finance-lease lessors reconcile undiscounted payments to the net investment (paras 93, 96). **CFOClose does not require a maturity analysis to equal the discounted carrying amount**; the only equality checks are: lessor finance-lease reconciliation (undiscounted payments − unearned finance revenue ± discounted unguaranteed residual = net investment) and lease-liability roll-forward.

## 8. Workflow stages (master §12 principles)

| Stage | IPSAS work |
|---|---|
| 1 Entity and framework | Eligibility facts; jurisdiction requirement; budget-publicity declaration |
| 2 Source data | TB; transaction ledger; cash account map; approved budgets and amendments |
| 3 Treatments | IPSAS 47 gateway and model cases; IPSAS 48 cases; PPE, leases, provisions, employee benefits; initial-application change events |
| 4 Allocation | Face lines; revenue and transfer models; cash-flow classes; budget classification |
| 5 Statements | SFP, SFPERF, SCNA, SCF; comparatives per transition method |
| 6 Notes | Applicability decisions incl. qualitative set |
| 7 Budget and review | SCBA, explanations, per-target reconciliation; review; FINAL |
| 8 Issuance | Official pack (master §11) |

Carry-forward reuses approved arrangement-class cases, allocations and budget-line mappings as `CARRIED` items with change review.

## 9. Proof obligations (future)

Independent fixture signed before the compiler runs, covering: mixed-model revenue in one account; IPSAS 48 prospective and retrospective variants; PPE roll-forward; lessee lease liability with maturity analysis not equal to carrying amount (accepted) and lessor reconciliation (checked); related parties with zero balances; commitments with nothing recognised; cash budget with basis, timing and entity differences. Rejection variants: offsetting errors across reconciliation targets; uncovered cash account; duplicate ledger rows; amendment without cause; non-conserving allocation; IPSAS 47 transition attempted before Q-1 is resolved; early application of the October 2024 amendments elected without the verified para 194A conditions.
