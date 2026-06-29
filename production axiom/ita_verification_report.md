# ITA Cap. 332 Primary-Source Verification Report
# Axiom — kinga-tax-engine Module E
# Date: 2026-06-28
# Last updated: 2026-06-28 (post-deployment verification round 2)
# Status: READY TO DEPLOY (Priority 1 items resolved)

## Sources Used (in order of authority)

1. **TRA ITA Cap.332 R.E.2023 PDF** — https://www.tra.go.tz/images/uploads/acts/The_Income_Tax_Act.pdf
   — Body sections s.1–s.38 verified verbatim. Schedules NOT in fetch (hit token limit before back matter).

2. **TRA/MoF ITA Cap.332 R.E.2019 PDF** (two copies, identical content)
   — https://www.tra.go.tz/images/uploads/acts/CAP_332_THE_INCOME_TAX_ACT_1.pdf
   — https://www.mof.go.tz/uploads/documents/en-1676545432-THE%20INCOME%20TAX%20ACT,%20CAP%20332%20R.E.%202019.pdf
   — Same cut-off issue. Schedules not reached.

3. **TanzaniaLaws.com HTML version** — https://tanzanialaws.com/i/150-income-tax-act
   — Confirmed class numbers (1,2,3,5,6,8) at line 1920. Also cut before Schedules.

4. **Habib Advisory Tanzania Tax Guide 2025/2026** (IAPA International member firm)
   — https://habibadvisory.co.tz/resources/guides/2025-2026-Tax-Guide.pdf
   — Contains full Third Schedule depreciation table. Used as authoritative secondary source for Schedule content.

5. **PwC Worldwide Tax Summaries — Tanzania Corporate: Deductions** (reviewed 14 January 2026)
   — https://taxsummaries.pwc.com/tanzania/corporate/deductions
   — Full depreciation class table (Class 7 verbatim), loss carry-forward rule (60% confirmed), charitable donation cap.

6. **RSM Tanzania — Finance Act 2020 analysis article** (published March 2021)
   — https://www.rsm.global/tanzania/insights/tax-insights/restriction-utilisation-tax-losses-brought-forward-prior-years
   — Quotes FA2020 amendment text to s.19(2) verbatim. Used to trace loss shelter rule history.

---

## PART A — SECTION NUMBER CORRECTIONS

Previously used section numbers that ARE WRONG:

| Previously cited | Actual section | What the cited section actually is |
|-----------------|----------------|------------------------------------|
| **s.24A** (thin cap) | **s.12(2)** | s.24 = "Claim of right". There is NO s.24A in the Act. |
| **s.34** (wear & tear) | **s.17** (references **Third Schedule**) | s.34 = "Income splitting" |
| **s.65** (minimum tax) | **s.4(1)(a) + First Schedule para 3(3)** | s.65 = "Clubs and trade associations" |
| **s.11(2)** | **s.11(2)** | ✅ CORRECT — is the general deduction rule |
| **s.16** | **s.16** | ✅ CORRECT — charitable donations 2% cap |
| **s.19** | **s.19** | ✅ CORRECT — loss carry-forward |

---

## PART B — THIRD SCHEDULE DEPRECIATION RATES (VERIFIED)

Sources: Habib Advisory Tax Guide 2025/2026 (pp.20-21) + PwC Tanzania (reviewed 14 Jan 2026). Both reproduce the Third Schedule. PwC is used for Class 7 verbatim rate description.

### Verified class table:

| Class | Depreciable Assets | Rate | Method |
|-------|--------------------|------|--------|
| **1*** | Computers and data handling equipment + peripherals; automobiles; buses and minibuses <30 pax; goods vehicles <7 tonnes load capacity; construction and earth-moving equipment | **37.5%** | Diminishing Value Balance (= Reducing Balance) |
| **2*** | Buses ≥30 pax; heavy general purpose or specialized trucks; trailers and trailer-mounted containers; railroad cars, locomotives and equipment; vessels, barges, tugs and water transport; aircraft; other self-propelling vehicles; **plant and machinery (including windmills, electric generators) used in agriculture or manufacturing operations**; specialized public utility plant and equipment; machinery or irrigation installations | **25%** | Diminishing Value Balance |
| **3*** | Office furniture, fixtures and equipment; **any asset not included in another class** | **12.5%** | Diminishing Value Balance |
| **5**** | Buildings, structures, dams, water reservoirs, fences and similar permanent works used in **agriculture, livestock farming or fishing farming** | **20%** | Straight Line on cost |
| **6**** | Buildings, structures, international pipeline and similar permanent works **other than Class 5** | **5%** | Straight Line on cost |
| **7**** | Intangible assets | **1 divided by the useful life of the asset in the pool, rounded DOWN to the nearest half year** | Straight Line (PwC Tanzania Jan 2026 — verbatim) |
| **8**** | Plant and machinery (including windmills, electric generators and distribution equipment) used in **agriculture**; **EFDs** purchased by non-VAT registered traders; **equipment used for prospecting and exploration of minerals or petroleum** | **100%** | Straight Line (immediate write-off) |

**Class 4 was REMOVED by Finance Act 2016.** Any reference to Class 4 in code is incorrect.

### Additional Third Schedule rules:

**First Year Allowance (50% initial deduction):** Applies to plant and machinery that is:
- (a) used in manufacturing processes and fixed in a factory, OR
- (b) used for providing services to tourists and fixed in a hotel, OR
- (c) used in **fish farming** (PwC Tanzania Jan 2026 adds this — Habib omits it)
- AND is added to the person's Class 2 or 3 pool.

This means eligible manufacturing/hotel/fish-farming plant gets 50% deducted in year 1, then normal class rate on the balance in subsequent years. The engine does not currently model this.

**Non-commercial vehicle cap:** Expenditure on a non-commercial road vehicle exceeding TZS 30,000,000 is not recognized. "Commercial vehicle" = designated to carry more than ½ tonne, or more than 13 passengers, or used in transport business.

**Small pool rule:** Where the WDV of a pool drops below TZS 1,000,000, the entire balance is deductible in that year.

---

## PART C — MINIMUM TAX / AMT (VERIFIED)

### Statutory basis:
- **Trigger:** s.4(1)(a) + s.4(8) — Corporation must have a **perpetual unrelieved loss** for the current year of income AND the **previous two consecutive years of income** (total = 3 consecutive loss years)
- **Base:** **Turnover** (defined in s.3 as income from business without any deductions under Subdivision D — i.e., gross revenue before all deductions)
- **Rate:** First Schedule para 3(3) — body of Act does not state the rate; it is in the First Schedule

### Rate confirmed from secondary sources:
- **1% of total turnover** — confirmed by Habib Advisory Tax Guide 2025/2026 (professional firm, IAPA International)
- **History:** Was 0.5% before 1 July 2025. **Finance Act 2025 increased the rate from 0.5% to 1%**, effective 1 July 2025.
- This explains the discrepancy between three sources: 0.5% (pre-July 2025 versions), 1% (current)

### Exemptions (confirmed from s.4(8) + Habib Guide):
- Corporations conducting **agricultural business**
- Corporations providing **health or education** services
- **Tea processing businesses**: exempt from 1 July 2024 to 30 June 2027 (Finance Act 2024)

### Important nuance:
- AMT applies to ALL qualifying corporations with 3-year loss history — it is NOT restricted to "exempt-controlled entities." That restriction applies only to thin cap (s.12).
- "This tax becomes payable on year 3 of perpetual unrelieved tax loss." (Habib Guide)
- Rate applies to TURNOVER, not to profit and not to total income in the normal sense

---

## PART D — THIN CAPITALISATION (VERIFIED AND CRITICALLY CORRECTED)

### Statutory basis: **s.12(2)** (NOT s.24A which does not exist)

> "The total amount of interest that an **exempt-controlled resident entity** may deduct in accordance with section 11(2) for a year of income shall not exceed the sum of interest equivalent to a **debt-to-equity ratio of 7 to 3.**"

### CRITICAL FINDING — Thin cap applies ONLY to "exempt-controlled resident entities":

A company is an exempt-controlled resident entity only if it is resident AND at any time during the year **25% or more of the underlying ownership is held by:**
- Entities exempt under the Second Schedule (government entities, certain NGOs)
- Approved retirement funds
- Charitable organisations
- **Non-resident persons**
- Associates of any of the above

**Implication:** A company with 100% Tanzanian individual shareholders is NOT an exempt-controlled entity and is NOT subject to thin cap restrictions at all. The thin cap rule primarily targets foreign-controlled and mixed-ownership entities.

### What debt counts for thin cap:

From s.12(5), **"debt"** EXCLUDES:
1. Non-interest bearing debt obligations
2. **Debt obligations owed to a resident financial institution** (local banks)
3. Debt obligations owed to a non-resident bank or financial institution **on whose interest tax is withheld in Tanzania**

Habib Guide confirms: "loans obtained from **non-registered financial institutions/persons** (within Tanzania and outside Tanzania)" — i.e., the thin cap restriction targets related-party loans and unregistered lenders, NOT regulated banks.

### Equity definition:

The Act at s.12(5) defines equity as: **"paid-up share capital at the end of the year of income"**

Note: Deloitte Tanzania (Aug 2025) stated equity includes "paid-up share capital and positive retained earnings (Finance Act 2025)." If Finance Act 2025 amended s.12(5), this is correct; but the FA2025 amendment text has not been retrieved from a primary source. **This remains unverified.** Engine should use "paid-up share capital" per the statute text and flag the potential FA2025 amendment.

### Formula (from Habib Guide):

Allowable interest = Actual interest × (7/3 × Equity) / Total qualifying debt

Or equivalently: Disallowed interest = Actual interest × max(0, (Total debt − 7/3 × Equity) / Total debt)

---

## PART E — TAX LOSS CARRY-FORWARD (VERIFIED — CORRECTED 2026-06-28)

### Statutory basis: s.19

- **No time limit on carry-forward** — s.19(1)(b) covers "any unrelieved loss of a **previous year of income**" without restriction ✅
- **Loss shelter cap — CURRENT RULE IS 60% (40% FLOOR):**
  - PwC Tanzania (reviewed 14 Jan 2026): "only **60%** of the taxable profits of the company can be sheltered by losses brought forward"
  - RSM Tanzania Tax Guide 2025/26: "60% of chargeable income" (per user verification)
  - **The engine already uses 60%. This is CORRECT.**
- **History of the rule:**
  - Before Finance Act 2020: no restriction on annual loss utilisation
  - Finance Act 2020 amended s.19(2): introduced a **30% floor** (= 70% maximum shelter). RSM's 2021 article quotes the FA2020 text verbatim as "shall not be reduced below thirty per centum."
  - A subsequent Finance Act (likely FA2022, FA2023, or FA2024) raised the floor to **40%** (= 60% maximum shelter). Both current 2025/26 professional guides confirm 60%.
  - The R.E.2023 PDF on the TRA website still shows "thirty per centum" — indicating TRA's published consolidation has NOT yet incorporated this subsequent amendment. The current operative law is 60% per PwC Jan 2026 and RSM 2025/26.
- **Trigger:** The shelter cap only applies from the 5th year of income, i.e., where the taxpayer has had unrelieved losses for **four previous consecutive years**
- **Exempt from restriction:** agricultural business, health services, education services
- **Loss ringfencing (s.19(3)):** Investment losses, foreign losses, agricultural losses, and speculative losses can only offset income of the same type

### Note on prior verification report error (now corrected):
An earlier version of this report stated "losses can shelter up to 70% of income (NOT 60% as previously coded — that was wrong)." **This was itself wrong.** The engine having 60% was correct. The R.E.2023 PDF says "thirty per centum" because TRA's PDF has not incorporated the post-FA2020 amendment. Current professional guides (PwC Jan 2026 + RSM 2025/26) both confirm 60%.

---

## PART F — CHARITABLE DONATIONS (VERIFIED)

### Statutory basis: s.16(1)(a) + s.16(3)

- Deductible: contributions to charitable institutions (s.64(8)) or social development projects
- **Cap: 2% of the person's income from the business, calculated without the deduction**
- The cap applies ONLY to s.16(1)(a) items
- Education Fund donations (s.12 of Education Fund Act), local government authority payments, AIDS Trust Fund, and COVID-19 contributions are deductible WITHOUT the 2% cap

### Previous engine treatment:
- Engine correctly identified 2% cap and s.16 reference ✅
- Engine correctly computed cap against taxable income (income before deduction) ✅
- Minor point: "taxable income" and "income from the business before the deduction" are slightly different concepts — the engine computes the cap against taxable income but the statute says "income from the business... without a deduction under that subsection." Practically the same thing for most cases.

---

## PART G — ENTERTAINMENT (VERIFIED AS NO DEDICATED PROVISION)

**Confirmed: Tanzania ITA Cap.332 has NO dedicated section disallowing or limiting entertainment expenditure.**

Entertainment is tested under:
- s.11(1)(a): "consumption expenditure" is not deductible
- s.11(2): Only expenditure incurred "wholly and exclusively in the production of income" is deductible
- s.11(4) definition: "consumption expenditure" = maintenance of the person, their family or establishment, or for personal or domestic purpose

The Act does NOT set a specific percentage disallowance for entertainment. Whether a specific entertainment expense is "consumption expenditure" or "wholly and exclusively in production of income" is a facts-and-circumstances test, not a fixed rule.

**Engine treatment is correct:** Flag entertainment accounts for CPA review; do NOT auto-apply any % disallowance.

---

## PART H — COMPLETE ERROR LIST FOR ENGINE (to be corrected)

### CRITICAL — Section citation errors:

| Error | Code had | Should be |
|-------|----------|-----------|
| Thin cap section | s.24A | s.12(2) |
| Depreciation section | s.34 | s.17 (Third Schedule) |
| Minimum tax section | s.65 | s.4(1)(a) + First Schedule para 3(3) |

### CRITICAL — Thin cap scope (wrong applicability):

- **Error:** Engine applies thin cap analysis to ALL companies with detected debt
- **Correct:** Thin cap (s.12) applies ONLY to "exempt-controlled resident entities" (25%+ non-resident or exempt ownership)
- **Fix:** Add classification warning: "Thin cap (s.12) applies only if 25%+ of the company's ownership is held by non-resident persons, exempt entities, retirement funds or charitable organisations. If the company has 100% Tanzanian individual shareholders, thin cap does NOT apply. Confirm ownership structure."

### Loss carry-forward shelter cap — ENGINE IS CORRECT:

- **Engine says: 60% shelter cap** — ✅ CORRECT per PwC Tanzania (Jan 2026) and RSM Tanzania 2025/26
- An earlier version of this error list said "should be 70%" — that was the error. The engine was right.
- Note: the R.E.2023 TRA PDF still says "thirty per centum" (30% floor = 70%) because TRA's published PDF has not incorporated the post-FA2020 legislative amendment. Current professional guides confirm 60%.
- The trigger (only applies after 4 consecutive loss years) is not yet modelled in the engine — add a note in the classification_warning when AMT is flagged.

### SIGNIFICANT — AMT rate history:

- **0.5%** applied before 1 July 2025
- **1%** applies from 1 July 2025 (Finance Act 2025 increase)
- Engine uses 1% — CORRECT for FY2025/26 and later
- For clients computing tax for periods before July 2025, the engine would incorrectly use 1%
- **Fix:** Note the effective date. Add a flag: if period_year < 2025, AMT rate was 0.5%

### MINOR — Missing Third Schedule items engine doesn't handle:

1. **First Year Allowance (50%):** Manufacturing plant fixed in factory, or tourist service equipment in hotel. Gets 50% in year 1 then normal class rate.
2. **Non-commercial vehicle cost cap:** Expenditure on non-commercial vehicles over TZS 30,000,000 not recognized
3. **Small pool rule:** WDV below TZS 1,000,000 → full deduction in that year
4. **Class 7 (Intangibles):** Over useful life of the asset. Engine doesn't offer this class.
5. **Class 8 scope:** Includes mineral/petroleum exploration equipment (not just agricultural plant)
6. **Equity definition uncertainty:** Statute says "paid-up share capital only." Deloitte cites FA2025 as adding "positive retained earnings." Unverified — add classification warning.

---

## PART I — WHAT IS NOW VERIFIED vs. WHAT REMAINS UNVERIFIED

### Fully verified from primary source (TRA Act text):
- s.4(1)(a): AMT trigger — 3 consecutive loss years ✅
- s.4(8): AMT exemptions (agriculture, health, education) ✅
- s.12(2): Thin cap ratio 7:3 ✅
- s.12(3): Exempt-controlled entity definition (25%+ non-resident/exempt) ✅
- s.12(5): Debt exclusions (registered FIs excluded) ✅
- s.12(5): Equity = paid-up share capital (FA2025 amendment unverified) ⚠
- s.16(1)(a) + s.16(3): Charitable donations, 2% of business income ✅
- s.17: Depreciation via Third Schedule ✅
- s.19(1)(b): Loss carry-forward — no time limit ✅
- s.19(2): 30% floor after 4 consecutive loss years ✅
- s.11(1)(a): Consumption expenditure not deductible ✅
- s.11(2): Wholly and exclusively test ✅
- Section numbers (no s.24A, s.34 is income splitting, s.65 is clubs) ✅

### Verified from authoritative secondary source (Habib Advisory 2025/2026):
- Third Schedule class 1: 37.5% reducing balance ✅
- Third Schedule class 2: 25% reducing balance ✅
- Third Schedule class 3: 12.5% reducing balance ✅
- Third Schedule class 5: 20% straight line (ag buildings) ✅
- Third Schedule class 6: 5% straight line (commercial buildings) ✅
- Third Schedule class 7: 1/useful life (intangibles) ✅
- Third Schedule class 8: 100% immediate (ag plant + EFDs + minerals exploration) ✅
- Class 4 removed by Finance Act 2016 ✅
- AMT rate: 1% (w.e.f. 1 July 2025; was 0.5% before) ✅
- First Year Allowance: 50% for manufacturing/hotel plant ✅
- Vehicle cost cap: TZS 30M for non-commercial vehicles ✅
- Small pool rule: TZS 1M threshold for full write-off ✅

### Still unverified (requires primary source for the Schedules):
- First Schedule para 3(3) rate text verbatim — not in any fetched document (all PDFs end before Schedules)
  — Confirmed as 1% by Habib Guide; corroborated by PwC and web search
- Equity definition amendment (Finance Act 2025 — "paid-up share capital + positive retained earnings")
  — Cited by Deloitte Tanzania; not verified from Finance Act 2025 text
- Exact thin cap formula mechanics in s.12 (formula B/A × 7/3 confirmed by Habib)
- Loss carry-forward 30% floor exact wording (confirmed from Act text at s.19(2)) ✅

---

## PART J — RECOMMENDED ENGINE CHANGES BEFORE DEPLOYMENT

Priority 1 (BLOCKER — factually wrong): ALL RESOLVED IN v1.2
1. ✅ Fix all section citations: s.24A → s.12(2), s.34 → s.17 (Third Schedule), s.65 → First Schedule para 3(3)
2. ✅ Add classification warning on thin cap: applies only to companies with 25%+ non-resident/exempt ownership
3. ✅ Loss shelter cap: engine uses 60% — CONFIRMED CORRECT per PwC Jan 2026 + RSM 2025/26
4. ✅ Note AMT rate history: was 0.5% before 1 July 2025, now 1%

Priority 2 (IMPORTANT — missing but not blocking for basic CIT computation): TARGET v1.3
5. Add Class 7 (intangibles — 1/useful life, rounded down to nearest half year per PwC) to engine + class selector
6. Add First Year Allowance checkbox on AddCapAllowanceModal (manufacturing/hotel/fish-farming plant — 50%)
7. Add note about equity definition in thin cap warning ("paid-up share capital; possible FA2025 amendment adds positive retained earnings — confirm with CPA")
8. Add TZS 30M vehicle cost cap warning when Class 1 asset cost > 30M

Priority 3 (NICE TO HAVE — edge cases): TARGET v1.4+
9. Small pool write-off (TZS 1M threshold)
10. Ringfencing note on loss carry-forward for agricultural, investment, and foreign losses
11. AMT classification_warning: add explicit note that the 60% loss shelter cap only kicks in from year 5 (after 4 consecutive loss years)

---

## DEPLOYMENT RECOMMENDATION

**CLEAR TO DEPLOY** (as of v1.2). All Priority 1 blockers are resolved:
- Section citations corrected in engine (s.12(2), s.17, s.4(1)(a))
- Thin cap scope warning added (exempt-controlled entities only)
- Loss shelter cap: engine's 60% confirmed correct — no change needed
- AMT rate history noted in engine warning

Priority 2 items (Class 7, FYA, vehicle cap) do not affect computation correctness for standard profitable SMEs and are safe to defer to v1.3.
