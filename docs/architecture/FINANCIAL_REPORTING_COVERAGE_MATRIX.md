# Financial Reporting Coverage Matrix

| | |
|---|---|
| **Document ID** | CFR-COVERAGE-3 (supersedes CFR-COVERAGE-2 and -1, neither committed) |
| **Status** | PROPOSED planning inventory · Baseline `f3d1b40`. The Track A hardening branch (PR #194) changes no requirement row: it hardens authority, history and framework governance, not accounting content |
| **Shared contracts** | Evidence classes, treatment cases, allocation, applicability, materiality, transitions, release authorization: `FINANCIAL_REPORTING_MASTER_SPEC.md` §0, §6, §10. Not restated here. |

## 0. What this matrix is and is not

The 89 rows below (35 IPSAS, 30 IFRS for SMEs, 24 full IFRS — the earlier 88 plus the split of full IFRS presentation into IAS 1 and IFRS 18 profiles) are a **planning inventory at requirement-group level**. They are **not** evidence of complete standards coverage. Each group must be decomposed into individual requirements (column "Remaining decomposition") before any of it can be authorized.

The repository's generated, test-pinned matrix `docs/reporting/COVERAGE_IFRS_FOR_SMES.md` (from `src/lib/frameworkPacks/coverage.ts`) remains the **authoritative requirement-level status** for the existing IFRS for SMEs pack: 59 requirements, `VALIDATED` 0, `IMPLEMENTED_NOT_VALIDATED` 56, `BLOCKED_WHEN_APPLICABLE` 3 (S). Requirement-level matrices for IPSAS and full IFRS will be generated the same way when their packs exist.

## 1. Traceability path (required for every supported requirement)

```
Source requirement (standard version + verified citation)
  → applicability rule (CRL; qualitative-set flag; master §10.6)
  → treatment case or governed judgment (master §10.3)        [skipped only for PRESENTATION-ONLY requirements]
  → evidence (immutable records; master §9.1)
  → calculation (engine capability) or external schedule (validated boundary; master §10.4)
  → presentation and/or disclosure (pack lines, disclosure catalogue)
  → independent fixture (signed; success + rejection; master §10.8)
  → authorized support scope (release authorization; master §6.4)
```

A requirement may be shown to customers as supported only when **every** link exists for the scope.

## 2. Three statuses, kept separate

| Status dimension | Values | Who sets it |
|---|---|---|
| **Implementation** | `IMPLEMENTED_NOT_VALIDATED` · `BLOCKED_WHEN_APPLICABLE` · `MISSING` · `ARCHITECTED` (designed, no code; treated as MISSING) | Engineering, by code existence tests (existing `coverage.ts` mechanism) |
| **Accounting validation** | `NOT_VALIDATED` · `VALIDATED` (signed independent fixture) | Named qualified accounting reviewer |
| **Release authorization** | `NONE` · `LEGACY_OPERATING` · `AUTHORIZED(scope)` · `WITHDRAWN` | Release authorization events (master §6.4) |

**At `f3d1b40`: accounting validation is `NOT_VALIDATED` and release authorization is `NONE` for every row.** The existing IFRS for SMEs 2015 path operates for its rollout scope under what master §6.4 would record as `LEGACY_OPERATING`; that registry does not exist yet (P).

Mode: **N** native capability · **X** validated external schedule · **G** governed judgment · **P** presentation/classification only · **B** blocked by name. Marker **ⓠ** = qualitative set (zero balances never establish non-applicability).

## 3. Verified dates and transition facts (sources in master §0.5)

| Fact | Value | Class |
|---|---|---|
| IFRS for SMEs third edition | Periods beginning on/after 1 Jan 2027; early application permitted; retrospective application with section-specific reliefs (Appendix A): e.g. S3 materiality/aggregation prospective; S9 control-loss reliefs; S11 modified retrospective only for prior IAS 39 users; S12 prospective, no comparative disclosures; S16 reclassification prospective; S17/S18 revenue-based depreciation prohibition prospective; S19 prospective; **S23 choice of modified retrospective or prospective to new contracts, comparatives not restated, legacy-contract policy disclosed**; S26, S28, S29, S30 specific reliefs | Primary summary (IFRS Foundation) + secondary detail (World Bank CFRR). Reviewer must confirm against Appendix A text |
| IFRS 18 | Periods beginning on/after 1 Jan 2027; early application permitted; replaces IAS 1; retrospective; reconciliation of the comparative statement of profit or loss from IAS 1 to IFRS 18 presentation; first-year interim requirements; IAS 7 amendments (operating profit as indirect-method starting point; interest/dividend classification) | Primary summary + secondary (EY). Appendix C paragraph text: Q-3 |
| IPSAS 47 | Original standard: periods beginning on/after **1 Jan 2026**, earlier application permitted (IPSASB May 2023 announcement); replaces IPSAS 9, 11, 23. Paras **194A and 203A added** by *Concessionary Leases and Other Arrangements Conveying Rights over Assets* (Oct 2024), **effective 1 Jan 2027**, earlier application permitted (IPSASB Oct 2024 announcement; amendment table of the 2025 Handbook extract). Paragraph text 194–203A **not retrieved** | Primary summary for dates; **paragraph text, transition methods and early-application conditions: Q-1** (IPSAS spec §5.3) |
| IPSAS 48 | Periods beginning on/after 1 Jan 2026 (para 62); early application only with IPSAS 47 (para 62); transition: **prospective to transfers on/after the date of initial application, or retrospective under IPSAS 3** (para 64); no practical expedients; first-time adopters: IPSAS 33 paras 43A–43B (up to three-year relief) | Primary text |
| IPSAS 43 | Periods beginning on/after 1 Jan 2025 (para 103; early application with IPSAS 41); lessee transition: full retrospective, or retrospective with cumulative effect at date of initial application without restating comparatives (paras 109–111) | Primary text |
| IPSAS 44–46 | 1 Jan 2025; IPSAS 49 1 Jan 2026; IPSAS 50 1 Jan 2027 | Secondary (NBAA Q1-2025) |
| IPSAS applicability | GBE scope exclusion removed from every IPSAS in 2016 ("commercial public sector entities"; applicability per Preface characteristics and jurisdictional determination) | Primary summary |
| Tanzania | NBAA TP No. 3 of 2020: NGOs and Associations apply IPSAS from periods beginning on/after 1 July 2021 (primary). Everything else: Q-2. The 2016 TZS 800 million SME threshold is **historical** | Mixed |

---

## 4. IPSAS (accrual)

Target first scope (owner decision): single controlled entity; approved budget public; FY 1 July 2026 – 30 June 2027 (IPSAS 47/48 mandatory internationally; the Oct 2024 IPSAS 47 amendments not mandatory for it; Tanzanian adoption Q-2). IPSAS-specific detail: `IPSAS_ACCRUAL_SPEC.md`.

| ID | Group (standards) | Trigger | Mode | Impl. | Remaining requirement-level decomposition | Notes / release-blocking |
|---|---|---|---|---|---|---|
| IP-01 | Presentation (IPSAS 1) | Always | P | ARCHITECTED | Statement set; minimum line items; current/non-current; going concern ⓠ; compliance statement; judgements; capital management | Lines are a reviewer decision |
| IP-02 | Cash flow (IPSAS 2) | Always | N | Ledger machinery IMPLEMENTED_NOT_VALIDATED (SMEs); IPSAS classes ARCHITECTED | Operating/investing/financing classes; direct method items; non-cash transactions; cash components | Existing account-by-account roll-forward reused |
| IP-03 | Policies, estimates, errors (IPSAS 3) | Always | G | ARCHITECTED | Policy register items; change classification; disclosure per change type | Depends on change events |
| IP-04 | Foreign currency (IPSAS 4) | FX transactions or foreign operation | N | B | Remeasurement; translation; disclosures | Target R3 |
| IP-05 | Borrowing costs (IPSAS 5) | Borrowings | X | ARCHITECTED | Policy; capitalised amount | |
| IP-06 | Hyperinflation (IPSAS 10) | Hyperinflationary currency | B | B | — | |
| IP-07 | Inventories (IPSAS 12) | Inventory | X | ARCHITECTED | Measurement bases incl. distribution at no/nominal charge; write-downs | |
| IP-08 | Events after reporting date (IPSAS 14) ⓠ | Always | G | Pattern exists (SMEs) | Adjusting vs non-adjusting; authorisation date | |
| IP-09 | Investment property (IPSAS 16) | Balances | X | ARCHITECTED | Model; roll-forward; fair value | |
| IP-10 | Segment reporting (IPSAS 18) | Per IPSAS 18 scope (verify) | N | ARCHITECTED | Applicability rule; segment allocation family | |
| IP-11 | Provisions, contingencies (IPSAS 19) ⓠ | Always for contingencies | X/G | ARCHITECTED | Recognition; roll-forward; contingent items | |
| IP-12 | Related parties (IPSAS 20) ⓠ | Always | G | ARCHITECTED | Identification; KMP remuneration; transactions | |
| IP-13 | Impairment (IPSAS 21, 26) ⓠ | Indicators where assets exist | X/G | ARCHITECTED | Indicator assessment; losses/reversals | † specialist |
| IP-14 | GGS disclosure (IPSAS 22) | Elected | B | B | — | Out of first scope |
| IP-15 | **Budget information (IPSAS 24)** | Approved budget public | N | ARCHITECTED | Comparison per oversight level; comparable-basis actuals; explanations; para 47 targets; basis/period/entity disclosures | **Critical**; IPSAS spec §6 |
| IP-16 | Agriculture (IPSAS 27) | Biological assets | X | B in first scope | — | |
| IP-17 | Financial instruments (IPSAS 41 and disclosures) | Instruments | N/X | ARCHITECTED | Classification; measurement; ECL; risk disclosures incl. liquidity maturity analysis of **contractual (undiscounted) cash flows** | † |
| IP-18 | Intangibles (IPSAS 31) | Balances | X | ARCHITECTED | Roll-forward | |
| IP-19 | Service concessions (IPSAS 32) ⓠ | Any arrangement | G/X | ARCHITECTED | Grantor recognition | † |
| IP-20 | First-time adoption (IPSAS 33) | Prior period not accrual IPSAS | N/X | B | Exemptions incl. 43A–43B for IPSAS 48 | Target R4 |
| IP-21 | Group reporting (IPSAS 34–38) | Controlled entities etc. | N | B | — | Target R4 |
| IP-22 | Employee benefits (IPSAS 39) | Employees | P/X | ARCHITECTED | Short-term; post-employment (actuarial) | † |
| IP-23 | Public sector combinations (IPSAS 40) | Combination | B | B | — | |
| IP-24 | Social benefits (IPSAS 42) | Schemes | X | B in first scope | — | |
| IP-25 | **Leases (IPSAS 43)** ⓠ | Any lease | N/X | ARCHITECTED | Lessee: ROU roll-forward; **lease liability maturity analysis per IPSAS 30 paras 46, AG12 (para 61) — contractual undiscounted amounts, which need not equal the discounted carrying amount; no equality check**; lessor: undiscounted payment maturity analyses (paras 93, 96) and, for finance leases, reconciliation to net investment (para 93); transition per paras 109–111 | |
| IP-26 | Held for sale (IPSAS 44) | Disposal groups | X | ARCHITECTED | Classification; separate presentation | |
| IP-27 | PPE (IPSAS 45) | Balances | N/X | ARCHITECTED | Measurement basis; depreciation; roll-forward by class | |
| IP-28 | Measurement (IPSAS 46) | Cross-cutting | P | ARCHITECTED | Basis disclosures | |
| IP-29 | **Revenue (IPSAS 47)** | Any revenue | G/X | ARCHITECTED | Gateway (binding arrangement); two models; compliance obligations; disaggregation; receivables/liabilities; transition (Q-1); optional early application of the Oct 2024 amendments (rights-of-use in kind, para 203A) | **Critical; blocked by Q-1** |
| IP-30 | **Transfer expenses (IPSAS 48)** | Any transfer expense | G | ARCHITECTED | Binding arrangement gateway; recognition; transition **prospective or retrospective (para 64)** | **Critical** |
| IP-31 | Retirement benefit plans (IPSAS 49) | Entity is a plan | B | B | — | Entity type out of scope |
| IP-32 | Mineral exploration (IPSAS 50) | Activity | B | B | — | |
| IP-33 | Natural resources held for conservation (IPSAS 51) | Resources | B | B | Effective date U | |
| IP-34 | Commitments, guarantees, unrecognized items ⓠ | Always | G | ARCHITECTED | Commitments; guarantees | |
| IP-35 | Comparatives (IPSAS 1) and restatement | Not first period | N | Machinery IMPLEMENTED_NOT_VALIDATED (SMEs) | Restated vs as-reported; reconciliation; no reissue (master §10.5) | |

## 5. IFRS for SMEs

Section numbers follow the 2015 edition; the third edition's section map is confirmed when its source is pinned. Requirement-level status for presentation (S3–S8 and listed disclosures) is in the generated matrix.

| ID | Group (sections) | Trigger | Mode | Impl. | Remaining decomposition | Notes |
|---|---|---|---|---|---|---|
| SM-01 | Scope / eligibility (S1) | Always | P | **MISSING** (no eligibility check) | Public accountability facts; jurisdiction eligibility (Q-2) | Required before any authorization |
| SM-02 | Concepts (S2) | Always | P | Citations only | — | |
| SM-03 | Presentation and statements (S3–S8) | Always | P/N | IMPLEMENTED_NOT_VALIDATED (generated matrix) | Golden fixtures for every requirement | Third edition: S3 materiality/aggregation prospective |
| SM-04 | Consolidated and separate (S9) | Subsidiaries | N | B — **not yet refused by name** (gap) | Control-loss reliefs on transition | Target R3/R4 |
| SM-05 | Policies, estimates, errors (S10) | Always | G | Preparer text only | Policy register; change events; third-edition disclosure reliefs | |
| SM-06 | Basic financial instruments (S11) | Instruments | N/X | ARCHITECTED | Measurement; impairment; third edition ageing and maturity disclosures | |
| SM-07 | Other instruments (S12, 2015) / fair value measurement (S12, third edition) | Fair value measurements; derivatives | X/B | ARCHITECTED / B (hedging) | Third edition: prospective, no comparative disclosures | |
| SM-08 | Inventories (S13) | Inventory | X | ARCHITECTED | — | |
| SM-09 | Associates, joint arrangements (S14–S15) | Interests | X | Presentation IMPLEMENTED_NOT_VALIDATED; measurement ARCHITECTED | Deemed-cost transition relief | |
| SM-10 | Investment property (S16) | Balances | X | Presentation IMPLEMENTED_NOT_VALIDATED | Reclassification prospective (third edition) | |
| SM-11 | PPE (S17) | Balances | X/N | Schedule IMPLEMENTED_NOT_VALIDATED | Revenue-based depreciation prohibition prospective; bearer plants | |
| SM-12 | Intangibles (S18) | Balances | X | Schedule IMPLEMENTED_NOT_VALIDATED | — | |
| SM-13 | Business combinations (S19) | Combination or goodwill | B | B | Third edition prospective | |
| SM-14 | Leases (S20) ⓠ | Any lease | X | ARCHITECTED | Third edition did not align S20 with IFRS 16 | |
| SM-15 | Provisions, contingencies (S21) ⓠ | Always | X/G | ARCHITECTED | — | |
| SM-16 | Liabilities and equity (S22) | Equity | P | IMPLEMENTED_NOT_VALIDATED (presentation) | — | |
| SM-17 | **Revenue (S23)** | Revenue | G/X | ARCHITECTED | Third edition: **choice of modified retrospective or prospective to new contracts; comparatives not restated; legacy policy and revenue disclosed** | Critical for third edition |
| SM-18 | Government grants (S24) | Grants | X | ARCHITECTED | — | |
| SM-19 | Borrowing costs (S25) | Borrowings | P | Citations only | — | |
| SM-20 | Share-based payment (S26) | Plans | B | B | Third edition reliefs listed | |
| SM-21 | Impairment (S27) ⓠ | Indicators | X/G | ARCHITECTED | — | |
| SM-22 | Employee benefits (S28) | Employees | P/X | ARCHITECTED | Modified retrospective for simplified PUC alternative | |
| SM-23 | Income tax (S29) | Taxable entity | X | Lines exist; measurement ARCHITECTED | Uncertain tax positions relief; DTA constraint relief | KINGA withheld (CLAUDE.md §9.1) |
| SM-24 | Foreign currency (S30) | FX | N | B | Exchangeability and advance consideration reliefs | Target R3 |
| SM-25 | Hyperinflation (S31) | — | B | B | — | |
| SM-26 | Events after period (S32) ⓠ | Always | G | IMPLEMENTED_NOT_VALIDATED (preparer-decided) | — | |
| SM-27 | Related parties (S33) ⓠ | Always | G | IMPLEMENTED_NOT_VALIDATED (preparer-decided) | Register | |
| SM-28 | Specialised activities (S34) | Activities | B | B | — | |
| SM-29 | Transition to the Standard (S35) | First-time adopter | N/X | B (a first-period declaration exists; it is not S35 transition) | — | Target R4 |
| SM-30 | **Edition change 2015 → third edition** | Period start ≥ 2027-01-01, or election | G | Edition policy IMPLEMENTED_NOT_VALIDATED (T); publication refused | Per-section transition rules as listed in §3; change events (master §10.5) | O-02 must be fixed first |

## 6. Full IFRS

Two **distinct applicable presentation profiles**: `full_ifrs/ias1` (periods beginning before 1 Jan 2027 without IFRS 18 early application) and `full_ifrs/ifrs18` (periods beginning on/after 1 Jan 2027, or earlier with election). Calendar 2027 is **not** a blanket cutoff: a period beginning 1 July 2026 remains IAS 1 unless IFRS 18 is early applied. Everything is refused today (`PUBLICATION_PATH_UNSUPPORTED`).

| ID | Group | Trigger | Mode | Impl. | Remaining decomposition |
|---|---|---|---|---|---|
| FI-01a | Presentation — IAS 1 profile | Always | P | ARCHITECTED | Statement set, OCI, line items |
| FI-01b | Presentation — IFRS 18 profile | Always | P | ARCHITECTED | Categories; required subtotals; MPM disclosures; aggregation; transition reconciliation of comparative profit or loss (Q-3) |
| FI-02 | Cash flows (IAS 7, as amended by IFRS 18 for the IFRS 18 profile) | Always | N | ARCHITECTED | Direct/indirect; starting point; interest/dividend classification |
| FI-03 | Policies, estimates, errors (IAS 8) | Always | G | ARCHITECTED | — |
| FI-04 | Events after reporting period (IAS 10) ⓠ | Always | G | ARCHITECTED | — |
| FI-05 | Income taxes (IAS 12) | Taxable | X | ARCHITECTED | † |
| FI-06 | PPE, intangibles, investment property, impairment (IAS 16, 38, 40, 36) ⓠ | Balances | N/X | ARCHITECTED | — |
| FI-07 | Inventories (IAS 2) | Balances | X | ARCHITECTED | — |
| FI-08 | Employee benefits (IAS 19) | Employees | X | ARCHITECTED | † |
| FI-09 | Government grants (IAS 20) | Grants | X | ARCHITECTED | — |
| FI-10 | FX (IAS 21), hyperinflation (IAS 29) | FX | N/B | B | Target R3 |
| FI-11 | Borrowing costs (IAS 23) | Qualifying assets | X | ARCHITECTED | — |
| FI-12 | Related parties (IAS 24) ⓠ | Always | G | ARCHITECTED | — |
| FI-13 | EPS (IAS 33), interim (IAS 34), segments (IFRS 8) | In scope | N | ARCHITECTED | Applicability by jurisdiction |
| FI-14 | Provisions (IAS 37) ⓠ | Always | X/G | ARCHITECTED | — |
| FI-15 | Financial instruments (IAS 32, IFRS 7, 9, 13) | Instruments | N/X | ARCHITECTED | Liquidity maturity analysis on contractual undiscounted cash flows † |
| FI-16 | Revenue (IFRS 15) | Revenue | G/X | ARCHITECTED | — |
| FI-17 | Leases (IFRS 16) ⓠ | Leases | N/X | ARCHITECTED | Maturity analysis undiscounted; no equality with carrying amount |
| FI-18 | Group reporting (IAS 27, 28; IFRS 3, 10, 11, 12) | Group | B | B | Target R4 |
| FI-19 | Held for sale (IFRS 5) | Disposal groups | X | ARCHITECTED | — |
| FI-20 | IFRS 2, 17, IAS 41, IFRS 6, IFRS 14 | In scope | B | B | — |
| FI-21 | First-time adoption (IFRS 1) | First IFRS statements | N/X | B | Target R4 |
| FI-22 | Reduced disclosures (IFRS 19) | Eligible subsidiaries | P | ARCHITECTED | Effective 2027 (verify) |
| FI-23 | Eligibility (jurisdiction) | Always | P | ARCHITECTED | Q-2 |

## 7. Cross-framework capabilities

| ID | Capability | Master spec | Impl. |
|---|---|---|---|
| CX-01 | Allocation ledger with conservation and residual rule | §9.3, §6.4 | ARCHITECTED (current one-account-one-line IMPLEMENTED_NOT_VALIDATED) |
| CX-02 | Treatment cases, governed judgments, external schedule boundary | §10.3–§10.4 | ARCHITECTED (five SME schedules are a precursor) |
| CX-03 | Applicability with zero-balance and qualitative-set rules | §10.6 | Partial (SME data- vs preparer-decided requirements) |
| CX-04 | Change events; restatement vs reissue | §10.5 | Restatement machinery IMPLEMENTED_NOT_VALIDATED; change events ARCHITECTED |
| CX-05 | Requirement resolution with jurisdiction and eligibility | §6.3–§6.4 | SME edition policy IMPLEMENTED_NOT_VALIDATED (T) |
| CX-06 | Manifest, canonicalization, replay | §9 | ARCHITECTED |
| CX-07 | FX | — | B |
| CX-08 | Consolidation | — | B |
| CX-09 | Financial-statement materiality (no audit thresholds) | §10.7 | ARCHITECTED |
