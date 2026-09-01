# AXIOM Insight Craft — Claude Code Institutional Memory

This file is read automatically by Claude Code at the start of every session.
It contains every architectural decision, constraint, and invariant established
across the full development history of this project. Do not skip it.

---

## 1. What This Project Is

**AXIOM Insight Craft** (also called SAFF ERP internally) is a Tanzania-focused
professional accounting ERP for audit and tax firms. It is not a generic SaaS app.
Every design decision is governed by Tanzania law (ITA Cap.332, Finance Acts,
TRA compliance, IPSAS/IFRS for SMEs) and the Iron Dome Ω∞ architecture.

**Stack:** React + TypeScript + Vite · Supabase (Postgres + Auth + Storage + Edge Functions) · Tailwind CSS + shadcn/ui · Lucide icons

**Repo root:** `C:\Users\user\axiom-insight-craft`

---

## 2. Architecture v3.1 — The 7-Stage Accounting Lifecycle

Every client engagement moves through exactly these stages in order:

| # | Slug | Label | Engine |
|---|------|-------|--------|
| 1 | `prepare` | Prepare Data | process-trial-balance |
| 2 | `reconcile` | Reconcile | SAFISHA (bank + EFDMS) |
| 3 | `statements` | Prepare Statements | HESABU |
| 4 | `tax` | Compute Tax | KINGA |
| 5 | `compliance` | Compliance Review | KINGA findings |
| 6 | `filing` | Prepare Filing | generate-xbrl / filing pack |
| 7 | `monitor` | Monitor | MAONO |

**Canonical source for stage metadata:** `src/lib/workspace/stageMetadata.ts`
This is the single source of truth for slugs, labels, tab labels, short labels,
icons, descriptions, and sequence. Never duplicate this data elsewhere.

**Workspace routing:** `/workspace/:companyId/:periodYear/:stage`
- `companyId` = UUID from `companies` table
- `periodYear` = 4-digit integer (e.g. 2025) — NEVER a DB timestamp or upload ID
- Routing gateway: `src/pages/Dashboard.tsx` (thin gateway only — no panels here)
- Layout shell: `src/pages/workspace/WorkspaceLayout.tsx`
- Command center: `src/pages/workspace/WorkspaceOverview.tsx`

**Workspace state engine:** `src/lib/workspace/deriveWorkspaceState.ts`
Pure deterministic function. Takes DB data, returns `WorkspaceState`.
No side effects. No async. Tested in `deriveWorkspaceState.test.ts`.

---

## 3. Engine Names — Exposure Rules

The four internal engine names are **never** exposed as primary user-facing
navigation labels. They exist in code and DB but not in nav tabs or headings.

| Internal Name | What It Does | Where It Lives |
|---------------|-------------|----------------|
| SAFISHA | Bank reconciliation + EFDMS matching | `supabase/functions/safisha-*` |
| HESABU | Financial statement validation | `supabase/functions/hesabu-validate` |
| KINGA | Tax computation engine (ITA Cap.332) | `supabase/functions/kinga-tax-engine` |
| MAONO | Variance analysis + forecasting | `supabase/functions/maono-*` |

**PHASE_B_LOCKED guard:** `maono-*` and `safisha-pdf-extract` return 503 unless
`MAONO_ENABLED` env var is set. Do not remove this guard.

---

## 4. Iron Dome Ω∞ — Core Invariants

These are non-negotiable. Every edge function, migration, and UI component must
honour all of them. No exceptions, no workarounds.

### 4.1 NULL-means-NOT-COMPUTED
A null value in any computed column means the engine has not run yet.
It does NOT mean zero. It does NOT mean "not applicable".
Never default a computed column to 0, false, or any sentinel.
Never show a computed result unless the engine has explicitly written it.

### 4.2 Sole Write Authority via Edge Functions
Financial data is written only by Supabase Edge Functions.
React components and hooks are READ-ONLY with respect to financial tables.
No `supabase.from('tax_computations').insert(...)` from the frontend.
No `supabase.from('engine_runs').insert(...)` from the frontend.
The only exception: audit log writes by `useAuditLog` hook.

### 4.3 firmMemberId is the Canonical Actor Identity (v2.3)
`firm_members.id` is the actor identity used in ALL financial writes.
`auth.users.id` (Supabase auth UID) is used only for auth lookups.
Every edge function that writes financial data must:
  1. Call `validateAuth(req)` from `_shared/auth.ts`
  2. Call `assertCompanyMembership(supabase, firmMemberId, companyId)`
  3. Use `firmMemberId` in every DB insert (not `userId`)

Never pass `userId` (auth UID) to an edge function as a substitute for
`firmMemberId`. Never accept `firmMemberId` in the request body — derive it
from the auth JWT server-side.

### 4.4 No Silent Defaults
No default fiscal year. No default tax rate. No default exchange rate.
If a required input is missing, the engine must return an error — not a guess.

### 4.5 Stale-Validation Gate
A stage cannot be marked complete if the underlying data has changed since
the last engine run. The `engine_runs` table records the input hash.
If the current input hash differs from the stored hash, the stage reverts
to `in_progress` and must be re-run.

### 4.6 Sign-Off Role Enforcement
Financial sign-offs require `role = 'partner'` or `role = 'manager'` in
`firm_members`. Junior staff cannot sign off. This is enforced by the
`hesabu_gate_before_signoff` trigger on `statement_sign_offs`.

---

## 5. Shared Auth Utilities (`_shared/auth.ts`)

All edge functions import from `supabase/functions/_shared/auth.ts`.
These are the only approved auth utilities:

```typescript
validateAuth(req)           // Extract + verify JWT, return { user, firmMemberId }
assertCompanyMembership(supabase, firmMemberId, companyId)  // RLS guard
checkIdempotency(supabase, key)     // Returns existing result if key seen before
completeIdempotency(supabase, key, result)  // Mark key complete
failIdempotency(supabase, key, error)       // Mark key failed
recordEngineRun(supabase, params)   // Write to engine_runs table
sha256Hex(data)             // Deterministic input hash
canonicalJson(obj)          // Stable JSON serialisation for hashing
```

Do not inline any of this logic. Always import from `_shared/auth.ts`.

---

## 6. Critical Database Tables

### engine_runs
Reproducibility ledger. Every engine invocation writes one row.
Created by migration `20260720200000`.
Columns: `id, function_name, company_id, period_year, input_hash, output_hash, firm_member_id, duration_ms, created_at`

### idempotency_keys
Deduplication table for Edge Function POST retries.
Created by migration `20260720300000`.
An idempotency key is `sha256(functionName + companyId + periodYear + inputHash)`.

### tax_computations
The canonical output table for KINGA.
**`computation_detail`** is the canonical JSONB column. NOT `result_json`.
`result_json` does not exist. Any reference to it is a bug.

### trial_balance_uploads
Columns include: `id, file_name, file_path, file_size, status, user_id,
company_id, company_name, period_year, uploaded_at, validation_report,
accounting_errors, safisha_status`

### statement_sign_offs
Sign-off workflow table. Has the `hesabu_gate_before_signoff` trigger which
enforces that hesabu-validate must pass before a sign-off is accepted.

### five WIP migrations (NOT yet in origin/main)
These must be applied in this exact order before any other WIP work:
1. `20260720100000` — RLS hardening + segregation of duties
2. `20260720200000` — engine_runs reproducibility ledger
3. `20260720300000` — idempotency_keys dedup table
4. `20260720400000` — tenant_events unified audit log
5. `20260720500000` — sync_outbox offline-first queue

---

## 7. Canonical File Map

```
src/
  lib/
    workspace/
      stageMetadata.ts        ← CANONICAL stage slugs/labels/icons/sequence
      types.ts                ← WorkspaceMission, MissionStatus, WorkspaceState
      deriveWorkspaceState.ts ← Pure state engine (no async, no side effects)
    computeComplianceScore.ts ← Pure scoring engine (no DB writes)
    computeWearTear.ts        ← Pure W&T calculator (ITA s.34 rates)
    normalizeAccountName.ts   ← Account name normalisation

  pages/
    Dashboard.tsx             ← Auth gateway only. Routes to /workspace. NO panels.
    workspace/
      WorkspaceLayout.tsx     ← Shell: top bar + stage tab nav + <Outlet>
      WorkspaceOverview.tsx   ← Command center: next action + 7-row progress table
      PrepareWorkspace.tsx    ← Stage 1
      ReconcileWorkspace.tsx  ← Stage 2
      StatementsWorkspace.tsx ← Stage 3 (has known TS bug — see section 9)
      TaxWorkspace.tsx        ← Stage 4
      ComplianceWorkspace.tsx ← Stage 5
      FilingWorkspace.tsx     ← Stage 6
      MonitorWorkspace.tsx    ← Stage 7

  components/
    TrialBalanceUpload.tsx    ← Upload component. Has TIN gate + duplicate detection.
    SaffLogo.tsx              ← Inline SVG logo. Single source of truth for branding.
    Header.tsx                ← PUBLIC header only. Not used inside workspace.
    safisha/
      SafishaGate.tsx         ← Post-upload evidence gate. Cannot be skipped.

  contexts/
    WorkspaceContext.tsx      ← React context wrapping useWorkspaceData
  hooks/
    useWorkspaceData.ts       ← Authoritative DB reads for workspace state
  constants/
    copy.ts                   ← All user-visible copy strings. Nav labels live here.

supabase/
  functions/
    _shared/
      auth.ts                 ← CANONICAL shared auth utilities (see section 5)
    kinga-tax-engine/         ← ITA Cap.332 engine. Has idempotency + engine_runs.
    process-trial-balance/    ← TB ingestion + classification
    hesabu-validate/          ← H-01 to H-12 assurance assertions
    safisha-ingest/           ← Bank statement CSV/XLSX → safisha_transactions
    safisha-efdms-ingest/     ← EFDMS Z-Report → safisha_transactions (service role)
    safisha-match/            ← 6-tier fuzzy matching engine
    generate-xbrl/            ← XBRL filing pack generator
  migrations/                 ← All migrations. Apply in filename order.
```

---

## 8. Absolute Prohibitions

These are hard stops. If a task description would require any of these, refuse
and ask the user to confirm before proceeding.

1. **Do not modify financial engine calculations** (kinga-tax-engine rates,
   thresholds, waterfall logic) without an explicit statutory reference.

2. **Do not alter DB schema** unless Architecture v3.1 explicitly requires it.
   No new columns on financial tables without a migration file.

3. **Do not weaken authentication, RLS, firm-member identity, sign-off gates,
   stale-validation gates, or filing locks.** Ever.

4. **Do not expose SAFISHA, HESABU, KINGA, or MAONO as primary user navigation
   labels.** These names are internal. Users see "Reconcile", "Statements",
   "Compute Tax", "Monitor".

5. **Do not move CapitalAllowancesRegister out of the Tax stage.**

6. **Do not delete Compliance functionality.**

7. **WorkspaceOverview must have exactly one dominant operational CTA.**
   Never show two primary action buttons simultaneously.

8. **Header.tsx is the public header only.** It must never appear inside the
   authenticated workspace. WorkspaceLayout.tsx has its own header.

9. **Do not reference `result_json`** anywhere. The canonical column is
   `computation_detail` in `tax_computations`.

10. **Do not use `auth.users.id` as the actor identity** in any financial write.
    Always use `firm_members.id` (`firmMemberId`).

11. **Do not write financial data from React components or hooks.**
    All financial writes go through Edge Functions.

12. **`safisha-efdms-ingest` uses service role.** This is intentional — TIN
    anti-impersonation requires it. Do not change this to anon key.

---

## 9. Known Pre-Existing TypeScript Errors (Do Not Fix Without Task)

These errors exist in origin/main and are NOT caused by recent changes.
Do not fix them as a side effect of other work — they need separate tasks.

- `StatementsWorkspace.tsx`: destructures `{ upload, workspaceState }` but JSX
  uses `company`, `companyId`, `periodYear` — compile blocker, needs its own task
- `SaffLogo.tsx`: missing SVG asset imports (brand assets not committed)
- `AvatarUpload.tsx`: CSS side-effect import
- `ErrorBoundary.tsx`, `PageErrorBoundary.tsx`: `import.meta.env.DEV` type
- `ExportStatements.tsx`: missing `xlsx` module types
- `KingaFindingsPanel.tsx`, `SafishaGate.tsx`, etc.: `VITE_SUPABASE_URL` not in
  `ImportMetaEnv` (needs vite-env.d.ts update)
- `integrations/supabase/client.ts`: same env var types issue

### 9.1 Registered Live Defects (Do Not Fix Opportunistically)

**DEFECT-KINGA-MAPPING-TENANCY-001** — Severity: HIGH — Status: OPEN / PRE-EXISTING

`supabase/functions/kinga-findings-engine/index.ts` reads `account_mappings`
for its `is_retained_earnings`/`is_payroll_account` override checks using
`.eq("user_id", companyUserId)` only — **no `company_id` filter**. Where one
firm/user operates multiple companies, an account mapping from one company
may potentially influence KINGA WHT/SDL processing for another company via a
shared account code.

Discovered during the Phase 2A professional-review-authority audit
(2026-08-16). Not introduced by Phase 2A, not fixed by Phase 2A — this is a
pre-existing gap in `kinga-findings-engine` itself. Do not modify that file
as a side effect of other work; it needs its own task with its own review of
`kinga-tax-engine`'s statutory calculation surface.

Phase 2A migration identity reconciliation: see `MIGRATION_RECONCILIATION.md`.

---

## 10. Current Project State (as of 2026-07-25)

### What is complete and deployed
- Architecture v3.1 routing shell (WorkspaceLayout + WorkspaceOverview + 7 stage pages)
- deriveWorkspaceState.ts deterministic engine with 14-path coverage
- KINGA tax engine with idempotency + engine_runs hash (ITA Cap.332 / FA2026)
- SAFISHA 6-stage pipeline (ingest → match → categorize → score → resolve → gate)
- HESABU H-01 to H-12 assurance assertions
- MAONO variance + cashflow + risk + decide engines (Phase B locked behind env var)
- XBRL filing pack generator (Tanzania taxonomy)
- Iron Dome Strikes 1–7 (RLS hardening, engine_runs, idempotency, tenant_events, sync_outbox)
- 8-fix UX pass (FY2001 fix, TIN gate, unified 7-row progress, BLOCKED reasons,
  jargon removal, responsive tabs, visible logout, duplicate filename detection)

### Completed 8-fix UX changes (committed, not yet pushed)
Files changed:
- `src/pages/Dashboard.tsx` — year-range guard on resolvePeriodYear
- `src/lib/workspace/stageMetadata.ts` — shortLabel on all 7 stages
- `src/pages/workspace/WorkspaceLayout.tsx` — UserMenu + responsive tabs + StatusDot tooltips
- `src/pages/workspace/WorkspaceOverview.tsx` — unified rows + BLOCKED reason + plain English
- `src/components/TrialBalanceUpload.tsx` — TIN gate + duplicate detection

### Pending tasks (not yet done)
- **Task #106**: Deploy Sprint 2 — `git push origin main` then `supabase db push`
  then deploy 7 edge functions (user must run these commands)
- **Task #255**: Phase C — re-home panels by accounting stage inside each workspace page
- **Task #256**: Phase D — acceptance tests + certification pass
- **StatementsWorkspace.tsx TS bug**: destructuring mismatch (own task needed)

### WIP branch (`recover-wip-20260720`) — Integration Authority
A recovery branch exists that is 3 commits ahead / 45 commits behind origin/main.
Common ancestor: `bc4693f`. The 5 WIP migrations are NOT in origin/main.
Integration plan: create fresh branch from origin/main HEAD (`e9d6ff0`),
cherry-pick only the 5 migration files in order, then take all other files
from origin/main. Do NOT rebase the WIP branch directly.

---

## 11. Deploy Procedure

### Frontend
```bash
git add -A
git commit -m "your message"
git push origin main
```
Lovable.dev auto-deploys from main.

### Database migrations
```bash
supabase db push
```
Always run AFTER pushing migrations to git. Always apply in filename order.

### Edge functions (deploy individually)
```bash
supabase functions deploy kinga-tax-engine
supabase functions deploy process-trial-balance
supabase functions deploy hesabu-validate
supabase functions deploy safisha-ingest
supabase functions deploy safisha-efdms-ingest
supabase functions deploy safisha-match
supabase functions deploy generate-xbrl
```

### Verify after deploy
```bash
# Check function health
supabase functions list

# Run TypeScript check (pre-existing errors are acceptable — see section 9)
node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
```

---

## 12. Tanzania Regulatory Context

- **ITA Cap.332**: Income Tax Act, Tanzania. Main corporate tax statute.
- **Finance Act 2026**: Enacted. Updated KINGA constants (rates, thresholds).
  CIT rate 30% (unchanged). Minimum tax 0.5% of turnover (s.65). 
  Presumptive tax threshold TZS 200M (FA2026 s.31).
- **TRA**: Tanzania Revenue Authority. EFDMS = Electronic Fiscal Device Management System.
- **TIN**: Tanzania Revenue Authority Tax Identification Number. 9-12 digits.
  Placeholder sentinel "PUT-REAL-TRA-TIN-HERE" must never reach production.
- **IPSAS**: International Public Sector Accounting Standards (for LGA/government clients).
- **GFRS**: Government Financial Reporting System (Tanzania LGA chart of accounts).
- **SDL**: Skills Development Levy (account range ~6050). Statutory payable.
- **NSSF/PPF/WCF**: Statutory retirement/social security funds. Treated as payables.
- **VAT**: Standard rate 18%. EFDMS Z-Reports are the source documents for VAT reconciliation.
- **Withholding tax**: Service payments to residents (5%) and non-residents (15%).
- **Thin capitalisation**: ITA s.24A — debt:equity 3:1 ratio. Interest disallowance above cap.
  (Note: frontend ThinCapWorkpaper shows gated state only — no frontend computation.)
- **Transfer pricing**: ITA s.33 management fees cap (1% of turnover or arm's length).
- **Installment tax**: ITA s.88 — quarterly payments due Mar/Jun/Sep/Dec.
- **Loss carry-forward**: Indefinite carry-forward of assessed losses under ITA.
- **Wear and tear**: ITA s.34 — Class 1 (37.5%), Class 2 (25%), Class 3 (12.5%), Class 4 (5%).

---

## 13. Key Constraints for New Tasks

Before starting any new task, verify:

1. Does it touch a financial engine calculation? → need statutory reference
2. Does it write to DB from frontend? → forbidden, must be Edge Function
3. Does it use `auth.users.id` as actor? → wrong, must be `firm_members.id`
4. Does it expose an engine name (SAFISHA/HESABU/KINGA/MAONO) in nav? → forbidden
5. Does it alter the stage sequence or slug? → update stageMetadata.ts ONLY
6. Does it add a new DB column? → needs a migration file with timestamp
7. Does it touch WorkspaceOverview? → must maintain exactly one dominant CTA
8. Does it bypass SafishaGate? → forbidden, the gate is non-skippable

When in doubt: read Iron Dome Ω∞ rules in section 4 first.
