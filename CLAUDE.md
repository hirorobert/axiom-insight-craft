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

**Package manager:** Bun, exactly `bun@1.3.14` (`packageManager` in `package.json`; pinned in every CI job). `bun.lock` is the only
lockfile — see section 14. Never run `npm install`/`npm ci`/`yarn`/`pnpm`; never commit another lockfile.

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

**MAONO is live — corrected 2026-09-04 (Ω∞ Phase 9 reconnaissance).** The
`PHASE_B_LOCKED` / `MAONO_ENABLED` 503 guard this section previously
described does not exist anywhere in the live code — grepped across every
`maono-*` edge function, `safisha-pdf-extract`, and the entire `src/`
tree; `MAONO_ENABLED` appears only in documentation, never in code.
`MonitorWorkspace.tsx` (Stage 7) says so itself: "Always available — no
lock gate." MAONO's UI (`MaonoDashboard` and friends under
`src/components/maono/`) is gated only by a genuine data-readiness check
(a completed, valid upload with a `company_id`), never by a feature flag.
Financial Twin firewall confirmed by reading every write site: every
`maono-*` `.insert`/`.update`/`.rpc` call and RPC definition
(`maono_write_alert`, etc.) targets only MAONO-namespaced tables
(`variance_runs`, `variance_analyses`, `variance_alerts`,
`cashflow_forecasts`, `maono_insights`, `maono_monitor_runs`) — never
`account_mappings`, `account_review_decisions`, `tax_computations`, or any
HESABU/financial-statement authority table. `maono-risk` is deterministic
(`ai_model_used: "deterministic_zscore"`, no LLM). `maono-decide` and
`maono-root-cause` do call Claude, but store the narrative as an
append-only `maono_insights` row alongside `numeric_validation_passed` /
`numeric_validation_detail` — the LLM's claims are checked against real
numbers before being stored as advisory, never as the metric itself. If a
future session finds MAONO genuinely inaccessible, the barrier is
elsewhere (RLS, a company/upload data-readiness edge case, or a live
deploy issue) — not a code-level lock to "unlock."

**MAONO authority status — repair-forward, 2026-09-04.** MAONO is
advisory and non-authoritative; treat every figure it shows as MAONO's
own analysis, not an accounting fact, unless independently proven
otherwise (`src/lib/accounting/maonoAnalyticalContract.ts`'s
`hasAuthoritativeAccountingProvenance()`/`assessMaonoInputTrust()` encode
this: a result type alone — including "observed" — never proves
authority; only an explicitly-confirmed, currently-certified upstream
source does). Do **not** claim "SAFISHA → HESABU → MAONO" is a proven,
enforced authority chain in production — `maono-compute` reads
`period_closing_balances` (a genuine KINGA/HESABU-authoritative,
persisted closing-balance table also consumed by `hesabu-validate` and
`generate-xbrl`) but ALSO reads `account_classifications` and
`account_pl_mapping`, two tables with **no migration file anywhere in
this repository** and read by no function other than `maono-*` — their
relationship to the certified `account_mappings`/`account_review_decisions`
chain (Phases 6/8) cannot be verified from this repo; see
`DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001` (§9.1, still OPEN,
non-blocking — HESABU boundary and certification freshness remain
LIMITED_NONBLOCKING, not PASS). `MaonoDashboard` binds every displayed
run to the exact workspace `companyId` + `periodYear` (previously
company-only, which could surface a different fiscal year's analytics —
fixed), and `variance_alerts` is scoped by `run_id`, not `company_id`
alone, in both `MaonoDashboard.tsx` and `maono-decide` (previously a
different fiscal period's alerts could contaminate the current run's
view/decision narrative — fixed; `variance_alerts.run_id` references
`variance_runs(id)` directly, migration `20260711163133`). `tax_computations`
reads in `maono-risk`/`maono-cashflow` use the canonical `computation_detail`
column, scoped to the exact variance run's own uploads
(`.in("upload_id", run.tb_upload_ids)` — the correct column is `upload_id`;
`tb_upload_id` does not exist on this table, verified against
`20260628100000_tax_engine_schema.sql`'s `UNIQUE (company_id, upload_id)`).
PAYE/VAT/SDL/WHT are read via `readOptionalTaxAmount()`
(`supabase/functions/_shared/maonoAnalyticalContract.ts`), which returns
`null` — never a fabricated `0` — for an absent or non-finite key; the
three TRA risk signals that consume them (`sdl_base_erosion`, `vat_gap`,
`paye_zero_with_personnel_costs`) explicitly refuse to fire when the
underlying figure is `null`, and the cash-flow forecast's
`statutory_this_month` response field preserves `null` rather than
reporting a false zero obligation. Confirmed, not merely suspected:
`kinga-tax-engine/index.ts` never computes `sdl_liability`/`vat_liability`/
`paye_total`/`wht_total` anywhere (the sole "sdl" hit is a static rate
constant, not a computed liability) — so today these four fields will
always correctly resolve to unavailable; if a future `kinga-tax-engine`
version starts populating them, `readOptionalTaxAmount()` picks them up
without further changes. KINGA absence never blocks core MAONO
variance/cashflow/risk computation — confirmed unchanged.

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

**Scoped exception: trial balance upload lifecycle (PR #32).** CFOClose is a user-based platform, open to solo
users, businesses and teams. A firm, a firm membership, or a title such as partner or manager must never be
required to use it. For the upload lifecycle operations (discard, restore, replace, cancel replacement, Storage
cleanup), the capability grants of `20260923100000`, and trial balance VALIDATION (`process-trial-balance`,
`20260923120000`):
- the actor identity is `auth.uid()` (`actor_user_id`);
- `actor_membership_id` is nullable compatibility metadata;
- authority is the single predicate `can_user_act_on_workspace(user, workspace, capability)`. It holds for the
  workspace owner (`companies.user_id`) or for an explicit, unrevoked `workspace_capability_grants` row. It never
  holds because of a firm membership or a title.
- `process-trial-balance` resolves its actor with `tbu_resolve_processing_actor`: an accepted firm member keeps the
  firm-member actor exactly as before; otherwise the owner or a `prepare_trial_balance`/`manage_source_files` grant
  holder runs as `actor_type = 'workspace_user'` with `engine_runs`/`idempotency_keys.actor_user_id` = the JWT user
  and NO `firm_member_id`. No firm_members row is ever created for them.
- Workspace ACCESS for those grants (`20260923130000`): `get_workspace_access(workspace)` is the one resolver the
  workspace shell uses (owner → every stage; accepted member → every stage under the existing rules, unchanged;
  an active `manage_source_files`/`prepare_trial_balance` grant → **Prepare only**), returning minimal metadata
  (no TIN/code/owner/billing). `list_shared_workspaces()` is discovery. Grant holders read only
  `trial_balance_uploads` and `tb_certifications` of the granted workspace. Nothing else (companies row,
  engagements, reconciliation, statements, tax, sign-off, billing, grant administration) is opened by a grant.
  The browser only narrows (`src/lib/workspace/workspaceAccess.ts`, `WorkspaceAccessGate`, `StageScopeGate`).

Everything else keeps this section's rule until the platform-wide migration below replaces it.
**Deferred (separate mission, after PR #32):** move every remaining role-label predicate onto explicit workspace
capabilities:
- the 15 migrations with RLS/function checks on `fm.role`;
- `get_member_company_ids`;
- `assertCompanyMembership` and the 7 edge functions that read `firm_members`;
- `engagements.created_by_member_id`;
- this section's actor model.

Do not do this as a side effect of other work. The sign-off, approval, reconciliation, statement and compliance
boundaries (§4.6) change only in that mission, with their own review.

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

### workspace_setup_authority (PR #25 — unapplied to the hosted backend until explicitly approved)
`20260920100000_workspace_setup_authority.sql` — `uq_engagements_one_open_per_period`, transactional
`open_engagement_with_scope`, engagement-scoped append-only `engagement_setup_events`, `companies.filing_jurisdiction`.
Proven by `scripts/db-proof/setupAuthority.mjs`. Only Lovable/the owner applies it.

### service_enquiries (Phase 1 service enquiry and expert intake — unapplied until explicitly approved)
`20260921100000_service_enquiry_intake.sql` — the ONE enquiry authority: `service_enquiries`, append-only
`service_enquiry_events`, a transactional notification outbox, and a NEW separate **`platform_staff_members`** authority
(a company owner/admin/member is never platform staff; nobody is seeded; enrolment is a `service_role` operator action).
No client role — and not even `service_role` — can write these tables directly; submission is the `submit-service-enquiry`
Edge Function and every status change is one locked, matrix-validated function. Proven by
`scripts/db-proof/serviceEnquiries.mjs`. Runbook, activation checklist and limitations:
`docs/operations/SERVICE_ENQUIRY_PHASE1.md`. The staff queue is `/admin/enquiries` (not linked from public navigation).

### trial_balance_uploads lifecycle (PR #32 — unapplied to the hosted backend until explicitly approved)
`20260923100000_upload_lifecycle_retire_and_replace.sql` — `lifecycle_state` (8 CHECK-enforced states) is
server-authoritative: only the migration backfill, the `tb_certifications` AFTER INSERT trigger, the processing-start
derivation in `trg_tbu_lifecycle_guard` and the SECURITY DEFINER RPCs may change it (client roles get 42501).
`uq_one_active_upload_per_period`; hard discard only for uploads with no evidence (every FK onto the table is checked
at call time); `retire_trial_balance_upload` / `cancel_trial_balance_replacement` / `restore_trial_balance_upload`;
source-file operations are authorized by `can_user_act_on_workspace`: the workspace owner (`companies.user_id`) or an
explicit `manage_source_files` grant in `workspace_capability_grants` (owner-only `grant_/revoke_workspace_capability`;
one active grant per workspace, grantee and capability). No firm membership or title is ever consulted (§4.3 scoped
exception). Events record `actor_user_id`, `authority_basis`, `authority_capability` and `outcome` (denials
included); `actor_membership_id` is nullable metadata. Storage evidence is read by the server from `storage.objects`;
the `trial-balance-storage-cleanup` Edge Function does the authorized service-role deletion of the operation-bound
object only. New sources are workspace-scoped (`workspaces/<workspace>/<source>/<name>`): `reserve_trial_balance_source`
→ `trial-balance-source-signer` (signed single-object URL) → `register_trial_balance_upload` / `retire_trial_balance_upload`,
so a `manage_source_files` grantee can upload and replace; legacy `<uploader>/<name>` objects stay bound. Discard
RETAINS the source for the undo window (any authorized user restores the exact object); purge happens only once the
discard is terminal. `20260923120000` adds the scheduled, server-only sweeper: pg_cron → `tbu_run_source_sweeper()` mints a
single-use ticket → pg_net → `trial-balance-source-sweeper`, which deletes exactly what `tbu_sweeper_candidates()` lists
(terminal discards, unfinished cancel cleanups, objects of expired unconsumed reservations), verifies absence, then records
it (`tbu_sweeper_complete`). No key is stored; the function URL is set once per environment with
`tbu_configure_source_sweeper(url)` (service_role). The browser never sweeps. Release control:
`scripts/sweeper_readiness.mjs` reports NOT READY unless the function is deployed, the project-specific URL is
configured, the cron job is active and a ticketed health sweep succeeds (CI runs it on staging). Production, by the
owner only, after the migrations are applied and `trial-balance-source-sweeper` is deployed:
`SELECT public.tbu_configure_source_sweeper('https://<production-ref>.supabase.co/functions/v1/trial-balance-source-sweeper');`
(as service_role), then `SWEEPER_SUPABASE_URL=… SWEEPER_SUPABASE_SERVICE_ROLE_KEY=… node scripts/sweeper_readiness.mjs --owner`. The functions are deployed to staging-replay
`hplriydtdelehepgttul` only. Proven by `scripts/db-proof/uploadLifecycle.mjs` (local PostgreSQL) and `scripts/upload_lifecycle_staging.mjs` (hosted staging, manual CI job); pre-flight
report for an existing database: `scripts/db-preflight/uploadLifecyclePreflight.sql`. Apply together with
`20260922180000`. Only Lovable/the owner applies it.
`20260923140000_upload_lifecycle_hardening.sql` (security-review F-01..F-05): a non-active upload is immutable outside a
sanctioned lifecycle op (`trg_tbu_history_immutable`), cannot be certified, and can never be `fiscal_periods.active_upload_id`;
`process-trial-balance` answers 409 for it (`_shared/uploadLifecycle.ts`) and the UI offers no Retry. Uploader-only
policies cover personal (company-less) rows only, so a revoked grantee loses every workspace row. Purges CLAIM the
discard (`purging`) under the op lock before any deletion; restore refuses a claimed discard; referenced objects are
never deletable. A discard pending past 15 minutes is resolved by the sweeper (`stale_discard`: back to active, or
retired). The 20260923100000 backfill refuses to run while a fiscal period names an upload it would retire (preflight §7–9).
`20260923150000_upload_pointer_and_source_binding.sql` (re-review N-01/N-02): `trg_tbu_sync_fiscal_period_pointer` clears
every `fiscal_periods.active_upload_id` naming an upload the moment it leaves the active states (re-pointing on return
only under the existing 'valid' promotion rule, into an empty slot); `kinga-comparative-engine` refuses a stale pointer.
A source path is bound only to its own consumed workspace reservation or its uploader's `<user_id>/` folder
(`tbu_source_path_bound`): clients cannot insert any other path or re-point one, `process-trial-balance` answers 409
`source_not_bound` before touching storage, and only bound references hold objects from cleanup. Both it and
20260923100000 refuse bad existing data as their FIRST statement (no DDL before it). Deployment order:
`docs/release/PR32_UPLOAD_LIFECYCLE_DEPLOYMENT.md`.
`20260923160000_personal_upload_lifecycle_audit.sql`: the workspace-scoped lifecycle ledger (company_id NOT NULL) gets no event
for a company-less personal upload; before it, processing any personal upload failed (23502 → 500).
`20260923170000_upload_binding_and_personal_authority.sql` (final correction): once `company_id` is set, NO caller role (incl.
service_role) may change company_id/period_id/period_year/fiscal_year_end/user_id/file_path, and a personal row can never be
attached (`trg_tbu_workspace_binding_immutable`; only sanctioned owner-run lifecycle ops and the real ON DELETE SET NULL pass).
One path authority (`tbu_path_well_formed` → `tbu_source_path_bound` → `tbu_bound_storage_path`/`tbu_object_referenced`;
TS mirror `_shared/sourcePath.ts`, shared corpus); `..` is refused only as a whole segment. `tbu_log_event` is a no-op without a
workspace. `process-trial-balance` processes a personal upload only for its `user_id` (403, identical for missing rows).

### five WIP migrations (NOT yet in origin/main)
These must be applied in this exact order before any other WIP work:
1. `20260720100000` — RLS hardening + segregation of duties
2. `20260720200000` — engine_runs reproducibility ledger
3. `20260720300000` — idempotency_keys dedup table
4. `20260720400000` — tenant_events unified audit log
5. `20260720500000` — sync_outbox offline-first queue

---

## 7. Canonical File Map

This map is verified by `src/lib/__tests__/claudeFileMap.test.ts`: every path below must exist, and every non-test file in
`src/jurisdiction-packs/tz/` and `src/lib/workspace/` must be listed. Update both together.

```
src/
  lib/
    workspace/
      stageMetadata.ts        ← CANONICAL stage slugs/labels/icons/sequence
      types.ts                ← WorkspaceMission, MissionStatus, WorkspaceState
      deriveWorkspaceState.ts ← Pure state engine (no async, no side effects)
      fetchWorkspaceSnapshot.ts ← The one-shot async read pipeline (company → uploads → active upload → sign-offs → certification → deriveWorkspaceState) behind a single workspace's WorkspaceState. Used by both useWorkspaceData.ts (single workspace) and useActiveEngagements.ts (the returning-user hub) — single implementation, no second copy.
      resolveReturningUserRoute.ts ← Pure returning-user routing decision (resume / chooser / start_single_company / first_run) behind Dashboard.tsx
      deriveOrientationSummary.ts ← Pure projection of Service/Current stage/Current status/last completed milestone for the WorkspaceOverview orientation strip
      workflowAcceptanceFixtures.ts ← Deterministic UploadSnapshot fixtures covering all 11 deriveWorkspaceState paths (incl. contradiction/missing-certification/stale-processing), fed to the internal WorkspaceStatesAcceptance gallery
      concurrencyLimit.ts      ← Bounded-fan-out worker pool (mapWithConcurrencyLimit) + fail-closed-on-any-failure aggregation (aggregateSettledResults) — the returning-user hub's query-safety primitives
      onboardingState.ts      ← Pure launch state machine (LAUNCHPAD/DATA_CHOICE/IMPORT_PENDING/EMPTY_WORKSPACE/ACTIVE) + LAUNCH_COPY
      navigation.ts           ← Navigation derived from the persisted engagement scope
      mandate.ts              ← Engagement capabilities registry (CAPABILITY_OUTCOMES) + mandate projection
      engagementScopeChange.ts ← Pure decision behind EngagementScopeDialog's three modes (declare/add/amend): added/removed capabilities, and that only a withdrawal via "amend" requires a reason
      workspaceSetupClient.ts ← ONLY client path to workspace setup RPCs (open_engagement_with_scope, data start, jurisdiction)
      workspaceAccess.ts      ← Server-decided workspace access (owner / member / Prepare-only grant) + shared-workspace discovery (PR #32)
      certificationCheckPresentation.ts ← Presentation only: 4 required certification layers counted; L5/L6 shown as neutral informational assessments (never a pass)
      certificationRevalidationGuard.ts ← Certification revalidation guard
      computeCertificationReadiness.ts  ← Certification readiness (pure)
      computePreflight.ts     ← Preflight checks (pure)
      discardSuppression.ts   ← Discarded-upload suppression rules
      resolveActiveUpload.ts  ← Which upload is the active one
      resolveNextActionDestination.ts ← Next-action routing
      sourceUpload.ts         ← ONLY browser path for a trial balance source: reserve → signed workspace-scoped upload → register
      classificationPresentation.ts   ← Pure deterministic 7-state classification presentation (FAILED/PROCESSING/INCONSISTENT/COMPLETE_WITH_REVIEW/PARTIAL/COMPLETE_NO_REVIEW/NOT_COMPUTED) for WorkspaceOverview. "Classified" means mapping_completeness.mapped_accounts (Tier 1-5) — never summary.auto_classified (Tier 4-5 only).
      classificationAcceptanceFixtures.ts ← Deterministic fixture inputs (one per classification state) for the internal /internal/acceptance/classification-states dev-only page. No Supabase, no randomness.
      classificationAcceptanceGate.ts ← Gate for that page: renderable only in a dev build (import.meta.env.DEV) — no flag, never enabled in production.
    jurisdiction/
      registry.ts             ← Filing-jurisdiction registry: ISO codes, which services need one, which have a pack
      packLoader.ts           ← ONLY module allowed to import a pack (dynamic import() only)
      packTypes.ts            ← Jurisdiction pack contract (panels by id)
      taxProfile.ts           ← Tax-profile warnings (conditional on jurisdiction, never global)
    computeComplianceScore.ts ← Pure scoring engine (no DB writes)
    normalizeAccountName.ts   ← Account name normalisation

  jurisdiction-packs/
    tz/                       ← THE Tanzania pack. Loaded only when TZ is explicitly selected. All Tanzanian statutory code lives here.
      tzPack.tsx              ← Pack manifest (default export) — the lazy chunk entry
      KingaTaxPanel.tsx       ← Tax computation panel (ITA Cap.332)
      KingaComparativePanel.tsx ← Multi-year comparative / AMT
      KingaFindingsPanel.tsx  ← Compliance findings
      TaxLossPanel.tsx        ← Assessed-loss carry-forward
      TransferPricingPanel.tsx ← ITA s.33 workpaper
      ThinCapWorkpaper.tsx    ← ITA s.24A workpaper (gated state only)
      AddBacksWorkpaper.tsx   ← Add-backs workpaper
      CapitalAllowancesRegister.tsx ← Capital allowances (still rendered in the Tax stage, via JurisdictionPanel)
      computeWearTear.ts      ← Pure W&T calculator (ITA s.34 rates) — moved here from src/lib/
      EvidenceRequestPanel.tsx ← Evidence requests
      TRAAuditReadinessPanel.tsx ← Audit readiness
      TRAFilingChecklist.tsx  ← Filing checklist
      EFDMSReconciliationPanel.tsx ← EFDMS reconciliation
      PaymentLedgerPanel.tsx  ← Payment ledger
      ClientSummaryPanel.tsx  ← Client summary (Compliance stage)
      FilingCalendarPanel.tsx ← Filing calendar (Monitor stage)
      PolicyCompass.tsx       ← Policy assistant (currently unrouted)
      filingTerms.ts          ← Filing terminology configuration
      generateTaxComputationPDF.ts ← Tax computation PDF

  pages/
    Dashboard.tsx             ← Auth gateway only. Routes to /workspace. NO panels.
    workspace/
      WorkspaceLayout.tsx     ← Shell: top bar + derived stage nav + <Outlet>
      WorkspaceOverview.tsx   ← Command center: ONE dominant decision (launchpad / data choice / next action)
      EngagementHub.tsx       ← Returning-user chooser, rendered by Dashboard.tsx when the routing decision is ambiguous (>1 open engagement, or 0 open + >1 company)
      PrepareWorkspace.tsx    ← Stage 1
      ReconcileWorkspace.tsx  ← Stage 2
      StatementsWorkspace.tsx ← Stage 3
      TaxWorkspace.tsx        ← Stage 4
      ComplianceWorkspace.tsx ← Stage 5
      FilingWorkspace.tsx     ← Stage 6
      MonitorWorkspace.tsx    ← Stage 7

  components/
    TrialBalanceUpload.tsx    ← Upload component. Has TIN gate + duplicate detection.
    CFOCloseWordmark.tsx      ← CFOClose wordmark. Single source of truth for branding (SaffLogo.tsx was removed in the rebrand).
    Header.tsx                ← PUBLIC header only. Not used inside workspace.
    jurisdiction/
      JurisdictionPanel.tsx   ← JurisdictionPanel/JurisdictionGate: the only way a stage page reaches a pack
      FilingJurisdictionSetting.tsx ← Neutral "Filing jurisdiction" setting
    workspace/
      ServiceLaunchpad.tsx    ← "What would you like to complete?" (services from the canonical registry)
      DataChoiceCard.tsx      ← The one data question
      EngagementScopeDialog.tsx ← "Manage services"
      StageScopeGate.tsx      ← Stage URL cannot bypass scope
      FirstRunEngagement.tsx  ← Zero-company first-run form
    safisha/
      SafishaGate.tsx         ← Post-upload evidence gate. Cannot be skipped.

  contexts/
    WorkspaceContext.tsx      ← React context wrapping useWorkspaceData
  hooks/
    useWorkspaceData.ts       ← Authoritative DB reads for workspace state
    useActiveEngagements.ts   ← Every open engagement across every company the member belongs to, each resolved via fetchWorkspaceSnapshot — the returning-user hub's data source
    useDataStart.ts           ← Engagement-scoped data-start decision (server-authoritative)
    useEngagementMandate.ts   ← Engagement scope; creation goes through open_engagement_with_scope
    useJurisdictionPack.ts    ← Loads the selected jurisdiction's pack through packLoader
  constants/
    copy.ts                   ← All user-visible copy strings. Nav labels live here.

scripts/
  ci/
    assertSingleLockfile.mjs  ← CI guard: bun is the only package manager, bun.lock the only lockfile
    packageManagerAuthority.mjs ← The checks behind that guard
    assertPackIsolation.mjs   ← Build guard: the pack is a separate lazy chunk; entry chunks carry no statutory wording
  db-proof/
    run.mjs                   ← Financial-statements persistence proof (real PostgreSQL)
    setupAuthority.mjs        ← Workspace setup authority proof (25-way concurrency, role/RLS matrix)
    uploadLifecycle.mjs       ← Upload lifecycle proof (legacy upgrade, B1–B4, capability matrix, concurrency)
  db-preflight/
    uploadLifecyclePreflight.sql ← Read-only report of what the lifecycle backfill would retire

supabase/
  functions/
    _shared/
      auth.ts                 ← CANONICAL shared auth utilities (see section 5)
    kinga-tax-engine/         ← ITA Cap.332 engine. Has idempotency + engine_runs.
    process-trial-balance/    ← TB ingestion + classification
    trial-balance-storage-cleanup/ ← Authorized, server-verified removal of an upload operation's bound file (PR #32)
    trial-balance-source-signer/   ← Single-object signed upload URL for a reserved workspace-scoped source (PR #32)
    trial-balance-source-sweeper/  ← Scheduled, ticketed, server-only purge/reclaim of source objects (PR #32)
    hesabu-validate/          ← H-01 to H-12 assurance assertions
    safisha-ingest/           ← Bank statement CSV/XLSX → safisha_transactions
    safisha-efdms-ingest/     ← EFDMS Z-Report → safisha_transactions (service role)
    safisha-match/            ← 6-tier fuzzy matching engine
    generate-xbrl/            ← XBRL filing pack generator
  migrations/                 ← All migrations. Apply in filename order.
```

**Moved by the first-run remediation (PR #25):** every Tanzanian statutory module now lives under
`src/jurisdiction-packs/tz/` (previously `src/components/*` and `src/lib/*`): `KingaTaxPanel`, `KingaComparativePanel`,
`KingaFindingsPanel`, `TaxLossPanel`, `TransferPricingPanel`, `ThinCapWorkpaper`, `AddBacksWorkpaper`,
`CapitalAllowancesRegister`, `EvidenceRequestPanel`, `TRAAuditReadinessPanel`, `TRAFilingChecklist`,
`EFDMSReconciliationPanel`, `PaymentLedgerPanel`, `ClientSummaryPanel`, `FilingCalendarPanel`, `PolicyCompass`,
`computeWearTear.ts` (+ its test), `filingTerms.ts` (+ its test, from `src/lib/jurisdiction/`) and
`generateTaxComputationPDF.ts` (from `src/lib/`). Global code must never import them directly — only `packLoader` may,
and only through dynamic `import()` (enforced by `src/lib/jurisdiction/jurisdictionBoundary.test.ts`).

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

5. **Do not move CapitalAllowancesRegister out of the Tax stage.** (The file lives in the TZ pack directory but is still rendered
   by `TaxWorkspace` through `JurisdictionPanel` — the stage placement is what this rule protects.)

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

**Corrected 2026-09-22 (canonical-workflow remediation, PR #31 continuation).** Every item this
section previously listed is STALE: `bunx tsc --noEmit -p tsconfig.app.json` returns zero errors
against the live tree (verified repeatedly this session, including after touching
`StatementsWorkspace.tsx`'s own sibling stage pages). Specifically checked and confirmed false:
`StatementsWorkspace.tsx` destructures `{ upload, uploads, workspaceState, companyId, periodYear,
company }` — every one of those is used in its JSX; there is no mismatch, and it compiles cleanly
(and is now exercised directly by `src/pages/workspace/stageLockGate.test.ts`). `SaffLogo.tsx` does
not exist in this repository (removed in the rebrand — see §7's file map). If a future session hits
a genuine, currently-reproducible TypeScript error anywhere, it is NEW and should be triaged on its
own merits — do not assume it matches an entry that used to be here.

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

**DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001** — Severity: HIGH — Status: OPEN / MISSING CAPABILITY

`safisha_transactions` (`supabase/migrations/20260711200000_safisha_core.sql`)
is real, immutable, hash-verified evidence, but it is **not** the
period-complete, classified cash-movement ledger V5 Phase 5's dual-engine
cash-flow requirement needs. Specifically:
- Rows are scoped per `reconciliation_id` → one `tb_upload_id` — whichever
  bank/cash accounts a firm chose to reconcile for that upload, not every
  cash-account movement for the full reporting period.
- `source_id = 'tb'` rows are the trial balance re-ingested as rows — not
  independent evidence; only `bank`/`subledger`/`momo` rows are genuinely
  external.
- No `presentationCode`/`accountNature`/cash-flow classification authority
  attaches at the row level — the table exists to prove bank-reconciliation
  match quality, not to feed a P&L-adjacent cash-flow statement.
- No opening-balance-carry-forward row concept; no certification gate
  equivalent to `tb_certifications` scoped to this table specifically.

Consequence: V5 Phase 5's `hesabu-cashflow-present` (IAS 7/IPSAS 2 primary
statement) and `hesabu-cashflow-reconcile` (indirect-method reconciliation)
cannot honestly produce two *independently derived* operating-cash-flow
numbers today — both `kinga-tax-engine.scfEngine` (live) and
`cashFlowEngines.ts` (pure, dormant, certified Phase 5 Slice 1) derive
operating CF from the same TB/IS/BS deltas via the same indirect method.
Genuine independence (e.g. a direct-method presentation) requires a
complete, period-scoped, professionally-classified cash-movement
transaction ledger that does not exist in this repository.

Discovered during the V5 Phase 5 Gate 1 dual-engine closure investigation
(2026-09-04), on branch `phase5-cashflow-foundation-20260903` /
main `14375160c7aa3b55774bf9142e984989f4fb7d90`. Not introduced by, and not
fixable within, Phase 5 Slice 1 (`cashFlowEngines.ts` — certified, correctly
does not claim independence it cannot support). Building this ledger is a
future SAFISHA/ledger-completeness capability with its own scope, its own
schema design, and its own certification pass — do not attempt it as a side
effect of Phase 5 or any other in-flight work.

Related, separately registered: **DEFECT-KINGA-COMPARATIVE-ENGINE-ZERO-SUBSTITUTION-001**
(`supabase/functions/kinga-comparative-engine/index.ts`) — a different,
unrelated live defect in a different comparative-period engine, found during
Phase 4.

**Status update — financial-statements workspace (2026-09-19, branch
`codex/financial-statements-production-readiness`):** the gap above is NOT
closed for SAFISHA itself — `safisha_transactions` is still not a
period-complete, classified cash-movement ledger. The financial-statements
workspace no longer depends on it: cash flow is built from an explicit
transaction-ledger *evidence family* (controlled CSV/XLSX intake, row
provenance), the cash perimeter from an explicit cash account map, and
completeness is enforced per account — each cash account's ledger movement
must equal its trial-balance movement between the two reviewed trial
balances (rule `cashflow-account-rollforward`, rule pack 2.2.0); ledger rows
naming a non-cash account, a missing balance or conflicting opening cash fail
closed, and the server refuses Reviewed/Final while that authority is missing.
The remaining limitation is unchanged in kind: the ledger is preparer-supplied
evidence reconciled to the trial balance, not independently extracted from the
bank, so two independently *derived* operating-cash-flow numbers still need a
source that does not exist here. See
`docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md` §6.

**DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001** — Severity: HIGH — Status:
OPEN / AUTHORITATIVE PROJECTION CORRUPTION (repair in progress on the same
branch that registers this entry — see Phase 6 below)

`src/lib/accounting/buildReviewDecisions.ts` — `buildReviewDecision()`
unconditionally emits:
```
is_cash_account: false,
is_retained_earnings: false,
is_payroll_account: false,
```
on every decision payload it builds, regardless of what the professional
actually reviewed. `src/components/AccountReviewPanel.tsx` — the live
Account Review workflow — currently has no professional input capable of
setting these three authoritative flags `true`; there is no UI path to
express "this is a cash account," "this is the retained-earnings account,"
or "this is a payroll account" at all.
`resolve_account_review_batch` (`supabase/migrations/20260816120000_account_review_authority.sql`)
persists the resulting decision/projection into `account_mappings` via
`INSERT ... ON CONFLICT (company_id, account_key) DO UPDATE SET
is_cash_account = EXCLUDED.is_cash_account, ...` — an unconditional
overwrite, so every reviewed decision (even one only about statement/
classification) replaces any existing authoritative flag value on that
account with `false`.

Consequences:
1. genuine cash accounts can be persisted as non-cash;
2. genuine retained-earnings / accumulated-surplus accounts can be
   persisted with false authority;
3. genuine payroll accounts can be persisted with false authority;
4. Phase 5's cash-perimeter authority can therefore be contaminated by the
   live Account Review workflow;
5. professional review can make authoritative `account_mappings` less
   correct than the source/machine state.

This is **not** a Phase 5 HESABU defect. HESABU correctly requires
caller-supplied cash-perimeter authority — it never invents one. The defect
is in the upstream professional Account Review authority that produces
`account_mappings`. Repair owner: **V5 Phase 6**. The repair does not
create a separate mapping authority — it corrects `buildReviewDecision()`
and `resolve_account_review_batch()`'s existing UPSERT logic in place, so
that a review decision no longer manufactures `false` for a flag the
professional never reviewed.

Discovered during the V5 Phase 6 Reversible Account Review Gate 0
discovery (2026-09-04), on branch `phase6-reversible-account-review-20260904` /
main `382f9a71415de11714a20a6e5ed818e95d376795`.

**DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001** — Severity: HIGH —
Status: OPEN / UNVERIFIED AUTHORITY CHAIN (scope corrected 2026-09-06,
PPG-1 — see note at end)

`supabase/functions/maono-compute/index.ts` reads account-level
classification data from two tables, `account_classifications` and
`account_pl_mapping`, that have **no `CREATE TABLE` migration anywhere in
`supabase/migrations/`** — grepped across the full migration history,
zero matches. No function other than `maono-*` reads or writes either
table. `maono-compute`'s own header comment documents the pipeline as
`trial_balance_uploads → account_classifications`, confirming they are
TB-derived, but nothing in this repository proves they are kept in sync
with, or derived from, the certified `account_mappings` /
`account_review_decisions` authority chain (Phases 2A/6/8). `maono-compute`
separately reads `period_closing_balances` (a real, KINGA-written,
`hesabu-validate`/`generate-xbrl`-trusted authoritative closing-balance
table) — so MAONO's variance computation is a MIX of at least one
provably authoritative source and at least two unverifiable ones in the
same pipeline.

Consequence: the claim "MAONO consumes SAFISHA → HESABU → MAONO" cannot
be fully proven from this repository as it stands; the untracked tables
could be a legitimate, currently-correct MAONO-side projection, or a
stale/orphaned artifact from an earlier architecture iteration that no
longer reflects the current classification authority. Live schema
inspection (this session had none) is required to resolve this — do not
assume either direction without it.

Discovered during the V5 Phase 9 MAONO Unlock repair-forward
(2026-09-04), on branch `phase9-maono-live-20260904` / main
`16ccdfc475dc10c171b35b7860ab77fe98d0239b`. Not fixed here: rewriting
`maono-compute`'s data-sourcing logic without live database access to
verify the change would risk an unverifiable regression in an
already-deployed financial function — exactly the failure mode this
repository's own discipline (`controlledActivation.ts`'s docstring,
Phase 8) explicitly warns against.

**Scope correction (PPG-1, 2026-09-06):** this entry originally also named
`maono-cashflow/index.ts`. Verified false as of the current repository:
`maono-cashflow` reads exclusively through
`supabase/functions/_shared/certifiedTbSource.ts`, whose own header states
it was "Created to remove MAONO's legacy dependency on
`public.account_classifications`" for exactly this defect — grepped
`maono-cashflow/index.ts` for `.from("account_classifications")`/
`.from("account_pl_mapping")`, zero matches (the one textual hit is a
comment referencing a different, already-fixed defect). This defect
remains open for `maono-compute` only; do not assume it still applies to
`maono-cashflow` without re-checking.

**DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001** — Severity:
MEDIUM (partially repaired) — Status: PARTIALLY FIXED / RESIDUAL
LIMITATION REGISTERED

Lovable's overnight PPG-1 review claimed `maono-cashflow` "classifies all
non-cash current assets as receivables and all current liabilities as
payables, potentially counting inventory/prepayments/tax balances
incorrectly and double-counting tax flows." Forensically confirmed TRUE
against `supabase/functions/maono-cashflow/index.ts` (now
`_shared/maonoCashflowMath.ts`'s `bucketCurrentBalances()`): the live
`account_classification` enum has exactly two current-balance values
(`current_assets`, `current_liabilities`) with no sub-split — grepped
every migration for `ALTER TYPE public.account_classification`, zero
hits — and `account_mappings` carries only three professional tri-state
flags (`is_cash_account`, `is_retained_earnings`, `is_payroll_account`),
none distinguishing inventory/prepayment/tax-receivable/tax-payable from
trade receivables/payables. `account_mappings.line_item` is free text,
not a controlled vocabulary — using it as authority would reintroduce the
exact account-name heuristic `maono-cashflow`'s own header already
documents removing.

**Fixed (PPG-1):** the one part of this claim that WAS fixable with
existing data — PAYE/VAT/SDL/WHT amounts known via `tax_computations`
were being swept into the generic current-liability bucket AND placed on
their own exact statutory due date, a genuine double-count. `_shared/
maonoCashflowMath.ts`'s `excludeScheduledTaxFromCurrentLiabilities()` now
excludes the known scheduled tax total from the generic bucket before it
is spread across the generic payment curve, so each is represented
exactly once. Covered by 14 unit tests
(`src/lib/accounting/maonoCashflowMath.test.ts`).

**NOT fixed, registered as a genuine data-authority gap (not guessed
around):** distinguishing trade receivables from inventory/prepayments/
tax receivables within `current_assets`, and trade payables from any
OTHER (non-statutory-scheduled) tax-like liability within
`current_liabilities`, requires classification evidence that does not
exist anywhere in this system's live schema today. Per this repository's
own UNKNOWN != ZERO != FALSE discipline, inventing a heuristic (free-text
`line_item` matching) or a brand-new professional-review classification
authority was judged out of scope for a stabilization repair pass — the
former would be exactly the kind of non-authoritative guess this
project's discipline forbids, the latter is a new feature (new migration
+ new review UI), not a repair of the confirmed defect. Every
`maono-cashflow` response now honestly discloses this via
`balance_authority.receivable_classification_limitation` and
`.payable_classification_limitation` — the aggregate is never claimed to
be verified trade receivables/payables. Closing this fully requires
either a new professional tri-state classification flag (mirroring
`is_payroll_account`'s precedent) or a genuine account_classification
enum extension — a future, explicitly product-owned decision, not
something to half-build here.

### 9.2 Registered Commercial Go-Live Gates

**LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE** — not a code
defect; a commercial acceptance gate. `/terms` and `/privacy`
(`src/pages/Terms.tsx`, `src/pages/Privacy.tsx`, Wave Ω1) contain
conservative, non-fabricated, technically-accurate content describing the
service as it exists today, and are considered technically production-ready
(no customer-facing development-scaffolding language remains on either
page). They have NOT been reviewed by a qualified lawyer. Do not represent
either page as legally reviewed or approved, and do not launch a paid
subscription flow (Ω2 or later) before that review happens — the routes
being live and well-written is orthogonal to the professional-review gate
still being open.

**MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION** — Wave Ω1
built a full commercial entitlement architecture (live under Lovable's
applied identity `supabase/migrations/20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql`;
the source-authored file is quarantined at
`supabase/migrations_historical/20260904180000_commercial_foundation_wave_omega1.sql.historical`
as of the PPG-1 pass — see `docs/operations/PPG1_STABILIZATION_REPORT.md`
§Finding 3)
capable of gating a second company behind `MULTI_COMPANY` entitlement, but
an initial candidate's server-side enforcement trigger was removed in the
Ω1-R repair pass because the underlying commercial policy (how many
companies a FREE workspace may hold) was never product-approved — shipping
it would have silently changed live company-creation behavior for every
existing user. Company creation is currently unrestricted (unchanged from
pre-Ω1 behavior). Before wiring this policy, a product decision is needed;
implementing it afterward is additive (one `BEFORE INSERT` trigger calling
the already-built `_resolve_entitlement_for_owner()`), not a schema change.
**Superseded in source (unapplied to hosted DBs):** the product decision now exists
and `20260925100000` enforces it as `ENTITY_CAPACITY` (see §9.3). Until that
migration is applied by the owner, hosted company creation stays unrestricted.

### 9.3 CFO Close Capabilities, Walls and Pricing (`20260925100000`–`20260925150000`, unapplied to hosted DBs)

- **Canonical capability codes** (`commercial_capabilities`; frontend mirror `src/lib/commercial/featureRegistry.ts`):
  `CLOSE_ASSURANCE` and `COMPARATIVE_REPORTING` (included in every plan, never charged separately — but never free:
  with no current plan they are refused like everything else), `STATEMENT_CERTIFICATION`
  (Close Certification), `REPORTING_PACK_EXPORT` (Reporting Pack) and `CLOSE_INSIGHTS` (Close Insights), which are
  paid, and the capacities `ENTITY_CAPACITY` and `NAMED_USER_SEATS`. Legacy codes (`SAFISHA_*`, `HESABU_*`, `MAONO_INTELLIGENCE`, `MULTI_COMPANY`,
  `MULTI_PERIOD`) resolve only through `commercial_capability_aliases` / `commercial_canonical_capability()`.
- **No free plan, one matrix (`20260925130000`):** the Free plan is retired (kept for history, `sales_mode = 'retired'`,
  never offered, never provisioned; `chk_cp_no_free_sales`). Open FREE licences were ended (EXPIRED, audited
  `FREE_PLAN_RETIRED`); no customer row was deleted. No current plan = read-only: existing data and issued outputs stay
  readable, entity capacity 0, only the holder active, no new operation. There is no trial.
  `commercial_plan_features` is the ONE plan × capability matrix the resolver reads (plan features `CLEAN_PDF`,
  `EXCEL_EXPORT`, `FILING_PACKS`, `MANAGEMENT_LETTERS`, `MULTI_ENTITY_REPORTING`, `CONSOLIDATION` (no plan),
  `REGIONAL_PACKS`); `reporting_pack_kind_features` binds each official format to its feature. Unknown plan,
  capability or missing matrix row fails closed. The pricing page renders the mirror in `pricingCatalogue.ts`.
- **Capabilities, never titles (`20260925140000`):** `workspace_member_capabilities` stores `prepare_close`,
  `review_close`, `approve_certification`, `issue_reporting_pack`, `manage_members` per person (append-only;
  `grant_member_capability` / `revoke_member_capability`). `manage_billing` is the account holder. `firm_members.role`
  is display metadata and a starting template only. `has_workspace_capability` (reads) and
  `workspace_capability_allowed` (held + current plan, for writes) replace every title check in 30 RLS policies and
  the authority functions; `close_assurance_wall` refuses new uploads, reconciliations, validations, tax computations,
  closing balances and findings without a plan. Only the owner-title integrity guards read the title.
  `reconciliation_write_wall` (BEFORE INSERT / UPDATE / DELETE on every `safisha_*` reconciliation table and the three
  `efdms_*` tables) refuses every reconciliation mutation — match, categorize, score, resolve, ingest, direct table,
  service role, RPC — without a current plan (PT402) or without `prepare_close` (42501); `safisha_resolve_exception`
  checks the reviewer the same way. Reads are untouched.
- **Free transition and production interlock:** the transition is FREE -> EXPIRED_READ_ONLY; no plan is ever granted
  by a migration. `20260925130000` and `20260925140000` are each one atomic DO statement; over open Free licences the
  retirement statement itself consumes a durable, environment-bound, single-use `deployment_approvals` row recorded by
  `admin_record_deployment_approval` (inventory must match) — no setting can stand in for it
  (`docs/release/PR34_STAGING_DEPLOYMENT_PLAN.md` §0). No application role (anon, authenticated, service_role) may
  INSERT / UPDATE / DELETE `deployment_approvals`; a row is created only through that function (insert guard), and its
  approver must be the calling, active commercial administrator (FK to `commercial_admins(user_id)`). A true database
  superuser stays outside every application-level control.
- **Security corrections N-1 / N-2:** an OFFICIAL Reporting Pack contains only bytes the DATABASE generates from the
  authoritative saved output named by its closed `output_ref` (`_official_reporting_pack_document`: today
  `financial_statements_data` from a saved `fs-report:<id>:v<n>`, source proven by its `document_hash`, timestamps in
  UTC). `seal_reporting_pack_server(user, issuance, storage_path)` takes no hash and no bytes — it regenerates and hashes
  the document itself; `seal-reporting-pack` accepts only `{ action, issuance_id }` JSON, stores the database's bytes and
  checks the stored object before sealing; `verify_reporting_pack` re-derives the canonical hash and requires the stored
  object (`storage.objects`, exact size). The seal trigger itself refuses any hash, size or path that is not the
  canonical document's, whoever writes it; a seal needs its stored object (`object_missing`). An object left by an
  interrupted request is never official, is listed by `reporting_pack_storage_orphans()` (service role) and is reused
  on retry only when it is exactly the canonical bytes (foreign unsealed bytes are replaced; sealed objects never are). Every browser-rendered
  format is `official_sealing_unavailable` and is delivered as a labelled WORKING COPY after `issue_reporting_pack`.
  `has_workspace_capability` — the one resolver behind every capability-backed policy — requires an accepted
  (`accepted_at IS NOT NULL`), uncancelled membership of that workspace, an active named user and an open grant;
  pending, expired, cancelled, suspended, revoked and removed people, and explicit workspace grants, hold no workspace
  capability. Technical debt (separate task, not changed here): ten older SECURITY DEFINER functions have no pinned
  search path — `enforce_budget_immutability`, `enforce_budget_no_delete`, the six `maono_block_*_mutation` triggers
  (alert, analysis, board_pack, insight, monitor_run, run), `maono_check_safisha_gate(uuid[])` and
  `maono_compute_confidence(uuid, integer)`. None calls or is called by anything this delta changed.
- **Security corrections (B-1..B-7):** an invitee can change only `accepted_at` on their own pending membership
  (`firm_members_update_guard`); no UPDATE assigns the owner title or moves a membership; a title change never adds or
  restores a capability. Reconciliation / EFDMS scope bindings are immutable and UPDATE / DELETE are authorized on the
  row's existing scope. Closed per-kind `output_ref` scheme; verify-by-rehash detects object substitution;
  `consume_reporting_pack_issuance` (client hash) is removed (official bytes: see N-1 above). `safisha_append_evidence_file`
  pins its search path and its errors fail the ingest. Plan changes and financial writes serialise on one advisory key
  per account (expiry linearization). "Request access" leads to `/request-access`, never to sign-up. Until checkout exists, every CTA is non-transactional
  (`CHECKOUT_AVAILABLE = false`, "Request access" / "Contact sales"); nothing renders Buy, Subscribe or Start free.
- **One authority:** `_authorize_paid_action(user, company, capability)` = session ∧ workspace access
  (`_workspace_access_basis`: creator, accepted member or capability grant; never an occupational title) ∧
  entitlement. It returns stable codes (`ALLOWED`, `ENTITLEMENT_REQUIRED`, `WORKSPACE_ACCESS_DENIED`, …). DB walls raise
  SQLSTATE `PT402` with the capability in `DETAIL`. Edge Functions use `_shared/paidAction.ts` (HTTP 402 JSON body
  `{status: "entitlement_required", capability}`). The UI reads only these structured fields
  (`src/lib/commercial/paidActions.ts`). Never parse message text.
- **Walls:**
  - Close Certification is enforced by the `statement_sign_offs` sign-off events and by FINAL publication inserts.
  - Reporting Pack: without an official issuance only the in-app preview exists. A browser can always rebuild a look-alike file from data it
    already shows, so the wall protects the OFFICIAL pack (`20260925120000`):
    - `issue_reporting_pack(workspace, period, kind, output_ref, request_id)` binds an issuance to the user,
      workspace, period, saved output / version (`fs-report:<id>:v<n>` is checked to exist) and format, with a
      10-minute expiry.
    - `consume_reporting_pack_issuance` seals it once with the SHA-256 of the exact bytes, re-checking every binding
      and the entitlement.
    - `verify_reporting_pack(sha256)` answers whether a file is official.
    - Every issue, seal and refusal is an append-only `reporting_pack_issuance_events` row.

    Every download site (statement JSON / CSV / Excel / PDF, board pack, management letter, disclosure notes, tax
    computation, tax workpaper schedules) goes through `deliverReportingPack` (`src/lib/commercial/requestReportingPack.ts`):
    issue → build → hash → seal → save. Nothing is saved unless sealed. `generate-xbrl` and `generate-management-letter`
    are gated server-side. The financial-statements workspace stays database-inert: its host page supplies the
    deliverer.

    Any printing outside an official issuance carries `DRAFT — NOT CERTIFIED — NOT FOR FILING OR CLIENT ISSUE` on every printed page (the
    statements print CSS, `DraftPrintMark` in `WorkspaceLayout`, and the board pack print). Not deliverables (never
    gated): the blank TB template and exports of the user's own inputs (account mappings, upload list).
  - Close Insights is enforced by the `maono-*` analysis functions and the triggers on their output tables.
    `maono-monitor` skips non-entitled workspaces.
  - Entity capacity is enforced by `trg_companies_entity_capacity` (advisory lock per account). Capacities: Solo 1,
    Practice 5, Firm 25, Enterprise by override, legacy PAID 25; no current plan 0. Create through the idempotent `create_entity` RPC.
  - Named-user seats: every plan includes exactly ONE named user (Enterprise negotiated). Practice and Firm may add
    purchased seats (`commercial_licences.additional_seats`, set by the audited `admin_set_licence_additional_seats`
    until a payment provider exists; Enterprise's negotiated seats by `admin_grant_named_user_seats_override`).
    `allowed_named_users = included_seats + additional_seats`; Solo is always 1 and can buy nothing; no current plan
    means the holder only; unknown or
    malformed quantities fail closed. `named_user_seat_wall` (on `firm_members` and
    `workspace_capability_grants`, advisory lock per account) refuses a new person on invitation, direct insert,
    grant, re-pointing and acceptance, and any new membership or grant for a suspended person.
  - Active-seat invariant (`20260925110000`): `active_named_users <= included_seats + additional_seats`, always.
    - `named_user_access_active(workspace, user)` is the single predicate. The account holder is always active; a
      person with an open `named_user_billing_suspensions` row is not; an account whose capacity is undetermined, or
      whose non-suspended people exceed the allowance, has only its holder active (live, no job).
    - It is enforced by one RESTRICTIVE policy on `firm_members` (covers every RLS policy that sub-selects
      `firm_members`), one added conjunct in each of 19 SECURITY DEFINER access functions (the proof checks that
      nothing else changed), and `isNamedUserActive` in the Edge Functions' service-role membership checks.
    - Unplanned loss (expiry, cancellation, admin plan change, override loss) is materialised by
      `reconcile_named_user_allowance`: BEFORE and AFTER triggers on licences and overrides record `ENTITLEMENT_LOST`
      suspensions for everyone but the holder. A planned reduction is `admin_prepare_planned_reduction` (the holder's
      selection against the future allowance) before `admin_set_licence_additional_seats`; a reduction without it is
      refused (`SELECTION_REQUIRED`).
    - Reactivation is only ever the account holder's explicit, roster-version-checked `choose_active_named_users`.
      Restoring capacity reactivates no one.
    - Memberships, grants, attribution and history are never deleted; suspensions are append-only (lifted, never
      removed).
  - Invitations: a pending invitation reserves a seat only until `invitation_expires_at`
    (`invitation_reservation_ttl()`, 7 days — product decision) and while not cancelled.
    - The account holder cancels with `cancel_workspace_invitation`.
    - `invite-firm-member` runs: seat pre-check → an unconfirmed account → `reserve_workspace_invitation` → email; an
      email failure calls `release_workspace_invitation`. Reissuing refreshes the same row.
    - Acceptance goes through `accept_workspace_invitations` and is refused once the invitation has expired or been
      cancelled.
  - Service identities and scheduled jobs never hold a seat. Each person has their own sign-in; nothing designs or
    advertises shared credentials. No assignment or reviewer workflow.
  - Nothing is free and nothing is separately paywalled beyond the matrix: comparatives are in every plan. Expiry or
    downgrade makes the workspace read-only (new work needs a plan) and suspends people beyond the allowance (see the invariant
    above); it never deletes or rewrites anything. Billing never writes accounting data.
- **Pricing catalogue:** `src/lib/commercial/pricingCatalogue.ts` is the only place prices live. It is mirrored exactly
  by the migrations (`pricingCatalogue.test.ts`): SOLO $49/$490 (1 entity, 1 user, no seats), PRACTICE $99/$990 (5),
  FIRM $299/$2,990 (25), ENTERPRISE contact sales,
  in USD; one included named user each; additional named users $20/month or $200/year on Practice and Firm
  (`commercial_additional_seat_prices`, separate from base-plan offers). There is no free plan and no trial. No checkout
  exists and nothing is purchasable.
- **Comparative endpoint:** `comparative-assurance-engine` is canonical. `kinga-comparative-engine` is a thin adapter
  that serves the same `_shared/comparativeAssurance.ts` handler, with no HTTP hop and no writes. Retire it only after
  30 days with no requests following the frontend release.
- **Customer-visible names:** SAFISHA/HESABU/MAONO/KINGA never appear in customer-visible strings. This is enforced by
  `scripts/ci/legacyNameSweep.mjs` (string literals, downloaded file names, `index.html` / robots / sitemap; legacy
  routes are immediate redirects under the robots-disallowed `/workspace/`) and
  `src/lib/__tests__/customerVisibleLegacyNames.test.ts`.
- **Proof:** `scripts/db-proof/entitlements.mjs` (the `100000`–`120000` layer), `scripts/db-proof/billingSuspension.mjs`
  and `scripts/db-proof/planCapabilities.mjs` (no free plan, matrix, capabilities, grants) run on real PostgreSQL
  (CI disposable-DB job). Staging plan: `docs/release/PR34_STAGING_DEPLOYMENT_PLAN.md`. Role-check review:
  `docs/release/PR34_AUTHORIZATION_CAPABILITY_REVIEW.md`.

### 9.4 Migration authority

- `supabase/migrations/` is the AUTHORED source of truth. Every schema change is written there, forward-only, and CI
  replays it.
- `drizzle/migrations/` is Lovable's apply journal for the hosted database (drizzle-kit, `LOVABLE_DB_MIGRATION_URL`).
  Lovable adds an entry when it applies a source migration. Never hand-edit it; never run `drizzle-kit push` or
  `migrate` (the Drizzle schema file is empty, so a push could propose dropping everything).
- `scripts/ci/assertMigrationAuthority.mjs` (CI, and `src/lib/__tests__/migrationAuthority.test.ts`) proves every
  journal entry mirrors one source migration in order with no gap, and lists newer sources as `PENDING_HOSTED_APPLY`.
- **MIGRATION-AUTHORITY-DRIFT-0006** (RESOLVED forward by `20260925150000`, pending hosted apply): Drizzle `0006`
  revokes EXECUTE on `can_user_act_on_workspace(uuid, uuid, text)` from `PUBLIC, anon` but not from `authenticated`.
  The forward migration sets EXECUTE on it and `workspace_authority_basis` to `service_role` only (their only callers
  are service-role Edge Functions and definer functions) and fails if any other role can still execute them. The guard
  requires the corrective statements, and refuses any source or journal entry that grants these predicates to anyone
  but `service_role` or re-creates them without the revoke.

**OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE** —
`src/lib/observability/correlationId.ts` (Wave Ω1) provides a genuine,
non-cosmetic correlation-id/log-context foundation — wired into
`useBillingSummary`'s error path today, threading a real `correlationId`
through `logWithContext()` on RPC failure. No external observability
provider (Sentry or otherwise) is integrated, and none should be added as a
side effect of unrelated work. Wiring an actual provider, and threading
`correlationId`/`companyId`/`periodYear`/`engineRunId` more broadly through
Edge Functions and the accounting engines, is deferred to Ω2 or a
dedicated pre-go-live observability pass — not silently expanded here.

**PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED** — PPG-1 (2026-09-06)
confirmed `supabase/config.toml` has no `[auth.email]`/SMTP block and no
custom transactional-email provider (SendGrid/Postmark/Resend/Mailgun) is
referenced anywhere in this repository — signup confirmation emails are
sent via Supabase's own default built-in mailer, which carries a low
hourly send-rate cap. The application-side symptom (a raw, unactionable
provider error shown to the user on a rate-limited signup or resend) is
fixed source-side — see `src/lib/auth/translateAuthError.ts` — but the
underlying cause (low send cap) is infrastructure, not application code,
and cannot be changed from this repository. Before real-volume signups,
configure custom SMTP under Supabase Dashboard → Authentication → Email
Settings (or the equivalent Lovable-managed path) with a transactional
email provider; do not invent or commit SMTP credentials here.

---

## 10. Current Project State (as of 2026-07-25)

### What is complete and deployed
- Architecture v3.1 routing shell (WorkspaceLayout + WorkspaceOverview + 7 stage pages)
- deriveWorkspaceState.ts deterministic engine with 14-path coverage
- KINGA tax engine with idempotency + engine_runs hash (ITA Cap.332 / FA2026)
- SAFISHA 6-stage pipeline (ingest → match → categorize → score → resolve → gate)
- HESABU H-01 to H-12 assurance assertions
- MAONO variance + cashflow + risk + monitor + decide + root-cause engines — live, not env-var-gated (see section 3)
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

# Install exactly what the lockfile says, then the release gate (must be zero failures)
bun install --frozen-lockfile
bunx tsc --noEmit -p tsconfig.app.json
bun run lint
bun run test
bun run build
node scripts/ci/assertPackIsolation.mjs dist
node scripts/ci/assertSingleLockfile.mjs
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

---

## 14. Repository Integrity

- **One package manager: Bun `1.3.14`.** Evidence: `bun.lock` is the only lockfile that installs frozen against `package.json`
  (`bun.lockb` and `package-lock.json` were both stale and are removed); the newest lockfile commit is Lovable's bot writing
  `bun.lock`; every CI job already used Bun. `packageManager` in `package.json` and every `bun-version` in
  `.github/workflows/ci.yml` must match exactly. Enforced by `scripts/ci/assertSingleLockfile.mjs` and
  `src/lib/__tests__/packageManagerAuthority.test.ts` (which reject any other lockfile, a floating Bun version, an unfrozen
  `bun install`, and any `npm`/`yarn`/`pnpm`/`npx` in a workflow). `deno.lock` belongs to the Deno edge functions and is allowed.
- **Line endings:** `.gitattributes` forces LF; do not commit CRLF.
- **Release gate:** the CI `Release Gate` job runs the frozen install, jurisdiction audits, lint, typecheck, the full suite,
  the build and the pack-isolation guard. There is no "baseline failure" allowance.
- **File map (section 7)** is verified by `src/lib/__tests__/claudeFileMap.test.ts`; keep it accurate when moving files.
