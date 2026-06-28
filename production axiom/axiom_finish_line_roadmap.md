# Axiom — Finish Line Roadmap
# Tanzania Tax Compliance SaaS: Phase 4 → Production
# Date: 2026-06-28 | Engine: Module E v1.1

---

## STATUS SUMMARY

| Layer | Status | Action Needed |
|-------|--------|---------------|
| Phase 3 — TB processing, KingaFindingsPanel, AddPaymentModal | ✅ LIVE | None |
| Phase 4 — kinga-tax-engine, capital_allowances, KingaTaxPanel | ⚠ READY TO DEPLOY | Run steps below |
| GitHub push | ⚠ PENDING | PowerShell push (see Step 0) |

---

## STEP 0 — PUSH TO GITHUB (YOU DO THIS IN POWERSHELL)

Before pasting anything to Lovable, run this in PowerShell in your project directory:

```powershell
# Clear stale lock file if present
if (Test-Path .git\index.lock) { Remove-Item ".git\index.lock" -Force }

git add -A
git commit -m "Phase 4: kinga-tax-engine v1.1 + verified ITA constants + KingaTaxPanel"
git push origin main
```

Then wait for Lovable to pull the latest commit before pasting the prompt.

---

## STEP 1 — DEPLOY PHASE 4 TO LOVABLE

Paste the full contents of `production axiom/lovable_phase4_prompt.md` into Lovable.
Lovable will:
1. Apply the `20260628100000_tax_engine_schema.sql` migration
2. Deploy the `kinga-tax-engine` edge function
3. Wire `KingaTaxPanel` into Dashboard.tsx below `KingaFindingsPanel`
4. Run SQL verification checks

Expected verification output:
- V1: capital_allowances rowsecurity=true, tax_computations rowsecurity=false ✅
- V2: 4 policies on capital_allowances ✅
- V3: ita_class CHECK = (1,2,3,5,6,8) ✅
- V4: unique index on tax_computations(company_id, upload_id) ✅
- V5: kinga-tax-engine deployed ✅
- V6: no TS errors ✅

---

## STEP 2 — FIRST LIVE DRY RUN (KAMANGA TEST)

After deployment, on Kamanga's trial balance:
1. Click the **Kinga — Corporate Tax (ITA Chapter 332)** panel
2. Click **+ Capital Allowance** and enter at least one asset (e.g. computers at Class 1)
3. Set months overdue = 0
4. Click **Run Tax Analysis**

Validate the preview:
- Accounting PBT matches what you see on the income statement
- Depreciation is detected and added back
- Wear & tear = opening WDV × 37.5% (or cost if first year)
- Taxable income = PBT + add-backs − wear & tear
- CIT = taxable income × 30%
- AMT box shows indicative (1% × turnover) but is NOT applied (says "requires 3-year loss history verification")
- Orange warning boxes appear for: thin cap (if any debt detected), entertainment (if any entertainment accounts)
- Gap = CIT − income tax provision from TB

If dry-run numbers look correct, click **Commit Computation**.

---

## PHASE 5 — REMAINING WORK TO PRODUCTION

### 5A — Multi-period Loss Tracking (AMT Auto-detection)

**Current state:** AMT is flagged as a warning only. CPA must manually determine if 3-year loss trigger applies.

**To build:**
- Add `company_loss_history` table: (company_id, period_year, had_loss BOOLEAN)
- CPA can mark prior years as loss years via a simple UI toggle
- kinga-tax-engine reads this table: if current year + 2 prior years all have had_loss=true → auto-apply AMT
- Add AMT toggle override on KingaTaxPanel for CPA to manually confirm/override

**Complexity:** Low. One table + one query. UI: 2–3 checkboxes.

### 5B — Activate WHT Rule

**Current state:** WHT (undistributed earnings) rule exists in statutory_rules but `verified_at = NULL` — engine skips it.

**To activate:**
```sql
-- Run in Supabase SQL editor after CPA confirms rule text:
UPDATE public.statutory_rules
SET verified_at = now()
WHERE trigger_category = 'wht_undistributed_earnings';
```

**Risk:** Confirm the WHT formula is correct before activating. The kinga-findings-engine will auto-generate WHT findings for all uploaded TBs on next run.

### 5C — Loss Carry-Forward Tracker

**Current state:** Engine assumes no prior losses carried forward.

**To build:**
- `tax_loss_pool` table: (company_id, period_year, loss_incurred_tzs, loss_utilized_tzs, loss_remaining_tzs)
- After each tax computation, engine checks if taxable income > 0 and pulls prior losses
- Applies 60% of taxable income cap (ITA — no time limit on carry-forward period)
- Reduces CIT payable by utilizing prior losses

**Complexity:** Medium. Requires multi-year data to be meaningful.

### 5D — Transfer Pricing Module (Module F)

**Scope:**
- Detect management fees, royalties, technical service fees to related parties
- Flag for arm's-length review (ITA s.33 / transfer pricing rules)
- No fixed % cap (the 2% charitable donation cap does NOT apply to mgmt fees)
- Generate evidence request: "Please provide management fee agreement and comparable fee analysis"

**Complexity:** Medium. Pattern matching already exists; needs evidence request workflow.

### 5E — Client Onboarding & Firm Management

**Current state:** RLS uses `firm_members` table — structure exists but no onboarding UI.

**To build:**
- Invite client (company) to a firm
- CPA firm admin can add/remove preparers
- Client portal (view-only): company sees its own findings, can download PDF report

**Complexity:** Medium-High. Auth flows, email invitations, role management.

### 5F — PDF Tax Computation Report

**Current state:** All output is on-screen only.

**To build:**
- Downloadable PDF of the ITA waterfall waterfall
- Cover page: company name, period, engine version, CPA name
- Section 1: Tax computation waterfall (PBT → taxable income → CIT → gap)
- Section 2: Capital allowances schedule
- Section 3: Add-backs schedule with ITA sections
- Section 4: Outstanding statutory findings
- Footer: "Prepared by Axiom | kinga-tax-engine Module E v1.1 | Verified against PwC Tanzania (Jan 2026)"

**Complexity:** Medium. Use pdf skill + puppeteer or react-pdf.

### 5G — EFDMS Integration

**Current state:** EFDMS CSV adapter spec written (Module D). Not yet built.

**To build:**
- Upload EFDMS sales receipts CSV
- Cross-reference against TB revenue accounts
- Flag unexplained revenue differences → potential understatement of sales

**Complexity:** High. Requires TRA EFDMS data format to be confirmed.

### 5H — TRA e-Filing Readiness Checklist

Simple checklist generated after each tax computation:
- PAYE returns filed? (from findings)
- SDL returns filed? (from findings)
- VAT returns filed? (from findings)
- CIT provisional returns filed?
- Final CIT return due date
- Outstanding penalties from findings

Auto-generated from the findings table — near-zero additional code.

---

## OPEN TECHNICAL DECISIONS

| Decision | Options | Recommendation |
|----------|---------|----------------|
| AMT 3-year loss trigger | (a) Manual checkboxes | (b) company_loss_history table | Build 5A — the table approach is audit-ready |
| Entertainment disallowance % | (a) Flag only (current) | (b) 100% auto-disallow | Keep as flag-only until TRA guidance confirms |
| Thin cap — local bank debt | CPA manually excludes | Auto-detect via bank name patterns | CPA manual override is safer; bank name detection is fragile |
| Loss carry-forward | Manual entry per year | company_loss_history table | Same table as AMT — build once |
| PDF report | react-pdf | puppeteer | react-pdf is simpler; puppeteer gives exact pixel output |

---

## VERIFIED STATUTORY CONSTANTS (DO NOT CHANGE WITHOUT RE-VERIFICATION)

All constants verified 2026-06-28 against primary sources. DO NOT change without re-verification.

| Constant | Value | Verified Source |
|----------|-------|----------------|
| CIT rate | 30% | PwC Tanzania Jan 2026 |
| Class 1 wear & tear | 37.5% RB | PwC Tanzania Jan 2026 |
| Class 2 wear & tear | 25% RB | PwC Tanzania Jan 2026 |
| Class 3 wear & tear | 12.5% RB | PwC Tanzania Jan 2026 |
| Class 5 wear & tear | 20% SL on cost | PwC Tanzania Jan 2026 |
| Class 6 wear & tear | 5% SL on cost | PwC Tanzania Jan 2026 |
| Class 8 wear & tear | 100% immediate | PwC Tanzania Jan 2026 |
| AMT rate | 1% of TURNOVER | PwC Tanzania Jan 2026 |
| AMT trigger | 3 consecutive loss years | PwC Tanzania Jan 2026 |
| Thin cap ratio | 7:3 (2.333:1) | Deloitte TZ Aug 2025 |
| Thin cap exclusion | Resident bank debt excluded | ITA Cap.332 s.12; Deloitte TZ |
| Charitable donation cap | 2% of TAXABLE INCOME | PwC Tanzania Jan 2026 |
| Loss carry-forward | No time limit; 60%/year cap | PwC Tanzania Jan 2026 |
| Penalty rate | 5% per month on unpaid tax | TAA 2015 s.76 |
| Fines/penalties | 100% non-deductible | ITA s.11(1) |

---

## FINISH LINE CHECKLIST

### Must-have for MVP (minimum viable product to first paying client):

- [x] Phase 1: Branding, auth, dashboard shell
- [x] Phase 2: Schema — statutory_rules, findings, efdms_records, firm_members, tax_payments
- [x] Phase 3: TB processing, kinga-findings-engine, KingaFindingsPanel, payment recording
- [ ] Phase 4: kinga-tax-engine, capital_allowances, KingaTaxPanel (DEPLOY NOW)
- [ ] 5H: TRA e-Filing checklist (near-zero effort, high client value)
- [ ] WHT rule activation (one SQL line — verify rule text first)
- [ ] Firm management (invite client, manage preparers)

### Nice-to-have before Series A demo:
- [ ] PDF tax computation report
- [ ] Loss carry-forward tracker (5C)
- [ ] AMT auto-detection from loss history (5A)
- [ ] Transfer pricing flag (5D)
- [ ] EFDMS integration (5G — requires TRA data format confirmation)

---

## DEPLOYMENT ORDER

```
TODAY:
  1. git push (PowerShell)
  2. Paste lovable_phase4_prompt.md → Lovable
  3. Verify all 6 checks pass
  4. Run dry-run on Kamanga TB
  5. Commit computation if numbers are correct

THIS WEEK:
  6. Activate WHT rule (SQL, 1 line, after verifying rule text)
  7. Build 5H: TRA e-Filing checklist (1 day)
  8. Build firm management / client invite (2–3 days)

NEXT SPRINT:
  9. Build 5A: AMT + loss tracking (1–2 days)
  10. Build 5F: PDF report (2–3 days)
  11. Build 5D: Transfer pricing flag (2–3 days)
  12. EFDMS integration (after TRA data format confirmed)
```
