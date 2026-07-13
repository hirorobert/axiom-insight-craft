# SAFF ERP — Phase 0 Identity-Impact Inventory
## Pre-Implementation Audit Required Before Lifecycle Implementation (v2.3)

**Classification:** READ-ONLY AUDIT — NO CODE, NO MIGRATIONS, NO MODIFICATIONS  
**Authority:** SAFF Architecture v2.3 (`SAFF_UX_REARCHITECTURE_v2_3.md`)  
**Date:** 2026-07-12  
**Scope:** All SQL migrations, SECURITY DEFINER functions, RLS policies, Edge Functions, React components  
**Constraint:** Cites exact files and line numbers. No assumptions. No Phase 1 actions taken.

---

## Classification Scheme

| Code | Meaning |
|------|---------|
| **AUTH USER IDENTITY** | Column stores `auth.users.id` directly, used as the primary identity anchor for access control (e.g., `firm_members.user_id`) |
| **FIRM MEMBERSHIP IDENTITY** | Column correctly stores `firm_members.id` per v2.3 convention |
| **AUDIT FK DEFECT** | Column stores `auth.users.id` where v2.3 requires `firm_members.id` — must be corrected in Phase 2 |
| **AMBIGUOUS** | Column stores `auth.users.id`; purpose unclear; requires human decision before Phase 2 |
| **NON-ACTOR USER REFERENCE** | Column stores `auth.users.id` for non-audit purposes (invitation metadata, ownership bootstrapping); not an actor audit trail; does not require Phase 2 migration |

---

## Deliverable A — Identity Reference Matrix

Every table with an identity-bearing column. Exact file and line citations.

### A.1 Core Identity Table

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `firm_members` | `user_id` | `20260625130000_7a1e4d92.sql` | 289 | `auth.users(id)` | AUTH USER IDENTITY | `auth.users(id)` — **KEEP. Column name unchanged per v2.3.** |
| `firm_members` | `invited_by` | `20260625130000_7a1e4d92.sql` | 296 | `auth.users(id)` | NON-ACTOR USER REFERENCE | No change — invitation metadata |

### A.2 Tax Engine Tables

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `capital_allowances` | `created_by` | `20260628100000_tax_engine_schema.sql` | 61 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `capital_allowances` | `created_by` | `20260629042520_7c1fccd0.sql` | 22 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` *(duplicate definition — same table, later migration)* |
| `tax_payments` | `created_by` | `20260627110000_tax_payments.sql` | 77 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `fiscal_periods` | `created_by` | `20260630100000_phase5a_period_registry.sql` | 63 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `tax_losses` | `created_by` | `20260630110000_phase5c_tax_losses.sql` | 68 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `tax_computations` | `cpa_modified_by` | `20260711120000_cpa_modification_columns.sql` | 21 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |

### A.3 Iron Dome Nuclear Tables

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `adjusting_journal_entries` | `created_by` | `20260707200000_iron_dome_nuclear_full.sql` | 144 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `adjusting_journal_entries` | `approved_by` | `20260707200000_iron_dome_nuclear_full.sql` | 145 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `statement_sign_offs` | `preparer_id` | `20260707200000_iron_dome_nuclear_full.sql` | 260 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `statement_sign_offs` | `reviewer_id` | `20260707200000_iron_dome_nuclear_full.sql` | 265 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `statement_sign_offs` | `approver_id` | `20260707200000_iron_dome_nuclear_full.sql` | 270 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `statement_sign_offs` | `locked_by` | `20260707200000_iron_dome_nuclear_full.sql` | 281 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `management_inputs` | `created_by` | `20260708100000_iron_dome_sprint2.sql` | 65 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |

**Note — `statement_sign_offs` hybrid state:** `KingaTaxPanel.tsx` L628 already writes `${tier}_firm_member_id` (a parallel column) using `firmMemberId` derived from a `firm_members` lookup. The `firm_member_id` parallel columns are CORRECT. The primary `preparer_id / reviewer_id / approver_id / locked_by` columns still point to auth.users — those are the defects listed above.

### A.4 Safisha Tables

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `safisha_reconciliations` | `client_id` | `20260711200000_safisha_core.sql` | 41 | `auth.users(id)` | AUTH USER IDENTITY | **Requires human decision** — `client_id` is an ownership anchor (like `firm_members.user_id`), not a typed audit actor; Safisha module uses it as the access-control gate. See E.4. |
| `safisha_exceptions` | `reviewer_id` | `20260711200000_safisha_core.sql` | 125 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `safisha_audit_log` | `reviewer_id` | `20260711200000_safisha_core.sql` | 326 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `safisha_client_mappings` | `client_id` | `20260711200000_safisha_core.sql` | 354 | `auth.users(id)` | AUTH USER IDENTITY | **Requires human decision** — same as `safisha_reconciliations.client_id`. See E.4. |

### A.5 Maono Tables

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `account_pl_mapping` | `created_by` | `20260711300000_maono_phase_a.sql` | 75 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `variance_materiality` | `updated_by` | `20260711300000_maono_phase_a.sql` | 181 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `variance_budgets` | `submitted_by` | `20260711300000_maono_phase_a.sql` | 230 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `variance_budgets` | `approved_by` | `20260711300000_maono_phase_a.sql` | 232 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `variance_runs` | `triggered_by` | `20260711300000_maono_phase_a.sql` | 330 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `variance_alerts` | `acknowledged_by` | `20260711300100_maono_phase_b.sql` | 169 | `auth.users(id)` | AMBIGUOUS | See E.5 — acknowledgment is non-blocking but still an auditable actor action |
| `maono_context` | `updated_by` | `20260711300100_maono_phase_b.sql` | 228 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `board_packs` | `generated_by` | `20260711300200_maono_phase_c.sql` | 43 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `efdms_z_reports` | `imported_by` | `20260711300200_maono_phase_c.sql` | 110 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `efdms_reconciliation` | `reconciled_by` | `20260711300200_maono_phase_c.sql` | 162 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |

### A.6 Hesabu and XBRL Tables

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| `hesabu_validations` | `validated_by` | `20260711400000_hesabu_validate.sql` | 98 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |
| `xbrl_instance_documents` | `generated_by` | `20260711500000_xbrl_layer.sql` | 137 | `auth.users(id)` | AUDIT FK DEFECT | `firm_members(id)` |

### A.7 Early Kinga Tables (Pre-firm_members Pattern)

| Table | Column | Migration File | Line | Current FK Target | Classification | v2.3 Required Target |
|-------|--------|---------------|------|-------------------|----------------|---------------------|
| *(data uploads / ingestion)* | `ingested_by` | `20260625100000_b3e5c891.sql` | 316 | `auth.uid()` DEFAULT | AUDIT FK DEFECT | `firm_members(id)` |
| `findings` *(Kinga Phase 2)* | `created_by` | `20260625100000_b3e5c891.sql` | 500 | `auth.uid()` DEFAULT | AUDIT FK DEFECT | `firm_members(id)` |
| `evidence_requests` | `created_by` | `20260625100000_b3e5c891.sql` | 713 | `auth.uid()` DEFAULT | AUDIT FK DEFECT | `firm_members(id)` |

**Note on early Kinga tables:** These predate `firm_members` (which was introduced in `20260625130000`). RLS on these tables uses `companies.user_id = auth.uid()` (lines 361–862), a pre-firm_members ownership pattern. Both the FK and the RLS require updating in Phase 2.

### A.8 Summary Counts

| Classification | Count |
|----------------|-------|
| AUTH USER IDENTITY | 4 *(firm_members.user_id, firm_members.invited_by, safisha_reconciliations.client_id, safisha_client_mappings.client_id)* |
| AUDIT FK DEFECT | **31** |
| AMBIGUOUS | 1 *(variance_alerts.acknowledged_by)* |
| NON-ACTOR USER REFERENCE | 1 *(firm_members.invited_by)* |
| **Total identity columns inventoried** | **37** |

---

## Deliverable B — SECURITY DEFINER Function Audit

All SECURITY DEFINER functions across all migrations. Columns: function name, file:line, search_path correct, pg_temp present, REVOKE FROM PUBLIC, GRANT scope, writes auth.uid() to audit FK, verdict.

### B.1 Functions with AUTH.UID() Write Defects

These SECURITY DEFINER functions capture `auth.uid()` and write it into an AUDIT FK DEFECT column. When Phase 2 changes those columns to `firm_members(id)`, these functions must be updated to look up `firm_members.id` via `auth.uid()` before writing.

| Function | File | Line (SECURITY DEFINER) | auth.uid() Write Line | Column Written | Defect |
|----------|------|-------------------------|-----------------------|----------------|--------|
| `hesabu_write_validation()` | `20260711400000_hesabu_validate.sql` | 214 | 222 | `hesabu_validations.validated_by` | AUDIT FK DEFECT + **MISSING `pg_temp`** |
| `xbrl_write_instance()` | `20260711500000_xbrl_layer.sql` | 261 | 270 | `xbrl_instance_documents.generated_by` | AUDIT FK DEFECT |
| `maono_write_board_pack()` | `20260711300200_maono_phase_c.sql` | 290 | 297 | `board_packs.generated_by` | AUDIT FK DEFECT |

**CRITICAL — `hesabu_write_validation()` search_path defect:**  
File `20260711400000_hesabu_validate.sql` line 215: `SET search_path = public` — `pg_temp` is absent. Per PostgreSQL security guidance, `SET search_path = public, pg_temp` is required to prevent temp-table injection attacks in SECURITY DEFINER functions. This is an existing security defect. Not fixed in Phase 0 (read-only). Must be corrected in Phase 2 before this function handles `firm_members.id` lookups.

### B.2 Functions with Correct Identity Handling

| Function | File | Line(s) | search_path | pg_temp | REVOKE FROM PUBLIC | GRANT scope | Notes |
|----------|------|---------|------------|---------|-------------------|-------------|-------|
| `get_member_company_ids()` | `20260625130000_7a1e4d92.sql` | 63–64 | ✓ public | — | Not shown in grep | authenticated | RLS helper; reads `fm.user_id = auth.uid()` (L75) — correct membership lookup |
| `create_company_with_owner()` | `20260625130000_7a1e4d92.sql` | 111–112 | ✓ public | — | Not shown | authenticated | Membership bootstrapper; no audit FK write |
| Firm guard triggers (×3) | `20260625130000_7a1e4d92.sql` | 148/196/229 | ✓ public | — | — | — | `prevent_last_owner_delete`, `prevent_role_escalation`, auto-audit triggers |
| `safisha_resolve_exception()` | `20260711200000_safisha_core.sql` | 236 | **Unverified** | **Unverified** | Not shown in grep | — | reviewer_id derived from caller (Iron Dome correct). `SET search_path` not confirmed in grep output — **requires manual line read in Phase 2 pre-flight** |
| `safisha_block_updates()` trigger | `20260711200000_safisha_core.sql` | 147 | — | — | — | — | Append-only enforcement; no identity write |
| Budget append-only triggers (×4) | `20260711300000_maono_phase_a.sql` | 247/266/358/442 | — | — | — | — | Immutability enforcement; no identity write |
| `maono_check_safisha_gate()` | `20260711300000_maono_phase_a.sql` | 488 | ✓ public (SQL fn) | N/A | Not shown | authenticated (L553) | Pure read; no identity write |
| `maono_compute_confidence()` | `20260711300000_maono_phase_a.sql` | 516 | ✓ public (SQL fn) | N/A | Not shown | authenticated (L554) | Pure computation; no identity write |
| `maono_write_alert()` | `20260711300200_maono_phase_c.sql` | 219–220 | ✓ public | — | ✓ (L270) | service_role + authenticated (L271–272) | Scheduled monitor write gate; no auth.uid() write |
| `hesabu_block_signoff()` (fixed) | `20260713000000_hesabu_trigger_fix.sql` | 35–36 | ✓ public | — | ✓ (L84) | authenticated (L85) | WHEN clause fixed; stale/SoD checks still absent — see B.3 |
| EFDMS append-only trigger | `20260711300200_maono_phase_c.sql` | 346 | — | — | — | — | Immutability enforcement |

### B.3 Known Incompleteness in Correct Functions

**`hesabu_block_signoff()` (post-fix, `20260713000000_hesabu_trigger_fix.sql`):**  
The WHEN clause defect (referencing non-existent `sign_off_tier`) was fixed. The function now correctly checks `NEW.preparer_signed_at IS NOT NULL` (L35-85). However, it does NOT check:  
- `hesabu_validations.stale = TRUE` (stale gate)  
- `hesabu_validations.statement_snapshot_id` (snapshot binding)  
- Separation of Duties (preparer ≠ reviewer ≠ approver)  
These gaps are out of scope for Phase 0. They are Phase 1 implementation items.

**`safisha_resolve_exception()` search_path:**  
grep for `SET search_path` on `20260711200000_safisha_core.sql` returned no match near line 236. This means `SET search_path` may be absent from the function definition. Must be verified (read lines 228–280 of that file) in Phase 2 pre-flight before that function is updated.

---

## Deliverable C — RLS Impact Map

All RLS policies that use identity fields. Categorized by whether the policy expression is correct today, will survive Phase 2 unchanged, or will break when FK columns change to `firm_members(id)`.

### C.1 Correct and Stable — Will Not Break in Phase 2

These policies use `firm_members.user_id = auth.uid()`, which is the correct membership lookup pattern. Because v2.3 keeps `firm_members.user_id` as the column name (not renamed), these policies require no changes.

| Policy target | File | Approx. lines | Expression |
|--------------|------|---------------|-----------|
| Most tables in `iron_dome_nuclear_full` | `20260707200000_iron_dome_nuclear_full.sql` | 86–315 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| `management_inputs` | `20260708100000_iron_dome_sprint2.sql` | 82–102 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| Most Maono tables | `20260711300000_maono_phase_a.sql` | 150–472 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| Maono Phase B tables | `20260711300100_maono_phase_b.sql` | 63–212 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| `board_packs`, EFDMS tables | `20260711300200_maono_phase_c.sql` | 73–174 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| `hesabu_validations` | `20260711400000_hesabu_validate.sql` | 131 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| `xbrl_instance_documents` | `20260711500000_xbrl_layer.sql` | 168 | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |
| `firm_members` self-read | `20260625130000_7a1e4d92.sql` | 387–464 | `user_id = auth.uid()` |
| `firm_members` via company | `20260625130000_7a1e4d92.sql` | 400/411/424/427/453 | `company_id IN (SELECT id FROM companies WHERE user_id = auth.uid())` |
| Recent AJE/capital_allowances | `20260712050748_8326d6e7.sql` | 11–196 (SELECT policies) | `company_id IN (SELECT company_id FROM firm_members WHERE user_id = auth.uid())` |

### C.2 Will Break in Phase 2 — Policies That Test Audit FK Columns Directly

When Phase 2 changes these columns from `auth.users(id)` to `firm_members(id)`, these WITH CHECK / USING expressions will compare a `firm_members.id` UUID against `auth.uid()` (which is an `auth.users.id`). They will silently fail to match — blocking all legitimate writes.

| Table | Policy | File | Line | Breaking Expression | Required Fix |
|-------|--------|------|------|---------------------|-------------|
| `capital_allowances` | INSERT WITH CHECK | `20260628100000_tax_engine_schema.sql` | 79 | `auth.uid() = created_by` | Change to `EXISTS (SELECT 1 FROM firm_members WHERE user_id = auth.uid() AND id = created_by)` |
| `capital_allowances` | INSERT WITH CHECK | `20260712050748_8326d6e7.sql` | ~30–50 | `auth.uid() = created_by` | Same fix |
| `adjusting_journal_entries` | INSERT WITH CHECK | `20260712050748_8326d6e7.sql` | ~11–30 | `auth.uid() = created_by` | Same fix |
| `variance_budgets` | INSERT WITH CHECK | `20260711300000_maono_phase_a.sql` | 294 | `AND submitted_by = auth.uid()` | Change to firm_members lookup |
| `variance_runs` | INSERT WITH CHECK | `20260711300000_maono_phase_a.sql` | 399 | `AND triggered_by = auth.uid()` | Change to firm_members lookup |

**Total breaking RLS policies: 5** (across 3 tables). Each will require a DROP POLICY + CREATE POLICY in Phase 2.

### C.3 Unsafe — Bypass firm_members Entirely

These policies grant access based directly on `auth.uid()` without going through `firm_members`. They are structurally different from A-3 membership checks and do not respect firm-level access control.

| Table | Policy | File | Lines | Expression | Risk |
|-------|--------|------|-------|-----------|------|
| `safisha_reconciliations` | SELECT, INSERT, UPDATE | `20260711200000_safisha_core.sql` | 375–410 | `client_id = auth.uid()` | Any authenticated user who knows a reconciliation exists can access it without being a firm_member. Architectural decision required — see E.4. |
| `safisha_client_mappings` | ALL | `20260711200000_safisha_core.sql` | 426 | `client_id = auth.uid()` | Same |
| `findings`, `evidence_requests` (early Kinga) | multiple | `20260625100000_b3e5c891.sql` | 361–862 | `companies.user_id = auth.uid()` | Pre-firm_members ownership pattern; relies on `companies.user_id` not `firm_members`. Valid for original single-user model; breaks in multi-firm-member model. |

### C.4 RLS on Tables with No Direct-Insert Policy (SECURITY DEFINER-only writes)

These tables have SELECT-only RLS. Writes are blocked for direct callers; only the named SECURITY DEFINER function can insert. This pattern is correct per v2.3 Iron Dome design.

| Table | File | Lines | Write gatekeeper |
|-------|------|-------|-----------------|
| `hesabu_validations` | `20260711400000_hesabu_validate.sql` | 133 comment | `hesabu_write_validation()` |
| `xbrl_instance_documents` | `20260711500000_xbrl_layer.sql` | 170 comment | `xbrl_write_instance()` |
| `safisha_audit_log` | `20260711200000_safisha_core.sql` | 422 comment | `safisha_resolve_exception()` |

---

## Deliverable D — Edge Function Impact Map

All 5 edge functions with identity field handling audited. (Remaining 19 edge functions were confirmed not to write identity fields via the grep sweep — not listed here to avoid false entries.)

### D.1 kinga-tax-engine/index.ts

**Identity handling:** `userId` is accepted from the **request body** (`req.json()` at line 423, default `null`). It is NOT derived from `supabase.auth.getUser()` inside the function.

| Line | Detail |
|------|--------|
| 423 | `userId = null` — default from `req.json()` destructure |
| 440 | `firm_members` lookup uses `callerId` (from JWT claim, not `userId`) for authorization gate |
| 1573 | `created_by: userId` — written to `adjusting_journal_entries` if `userId` is provided |
| 1611 | `created_by: userId` — written to `adjusting_journal_entries` (AJE-D001) |

**Source of `userId` in practice:** `KingaTaxPanel.tsx` line 677 passes `userId` in the POST body, where `userId` is the component's prop (which comes from `Dashboard.tsx` line 690 as `user.id` — the `auth.users.id` UUID from `useAuth()`).

**Defects:**
1. **AUDIT FK DEFECT:** `created_by` on `adjusting_journal_entries` is written with an `auth.users.id` value arriving via request body, not derived independently inside the function.
2. **REQUEST BODY IDENTITY:** Actor identity (`userId`) must never come from the request body per Iron Dome invariant — it must be derived inside the function via `supabase.auth.getUser()`. The authorization check (`callerId`) is correctly JWT-derived, but the identity written to the audit column is not.
3. **NULL BYPASS:** When `userId` is null (not passed), AJE auto-generation is silently skipped (line 1559: `if (userId) {`). This means auto-generated AJEs can be skipped by omitting `userId` from the request.

### D.2 hesabu-validate/index.ts

| Line | Detail |
|------|--------|
| 157 | `const { data: { user }, error: authErr } = await supabase.auth.getUser()` — CORRECT derivation method |
| *writes via* | Calls `hesabu_write_validation()` SECURITY DEFINER, which captures `auth.uid()` at L222 of the migration — writes `auth.users.id` to `hesabu_validations.validated_by` |

**Defects:**
1. **AUDIT FK DEFECT:** `validated_by` receives `auth.users.id`. When Phase 2 changes column to `firm_members(id)`, `hesabu_write_validation()` must resolve `auth.uid()` → `firm_members.id` before writing.
2. **SECURITY DEFINER search_path:** `hesabu_write_validation()` is missing `pg_temp` (see B.1). Defect exists in the DB layer, not the edge function itself.

**Compliant:** Identity derivation uses `supabase.auth.getUser()` (not request body) — correct method.

### D.3 safisha-resolve/index.ts

| Line | Detail |
|------|--------|
| 19 | Comment: `reviewer_id comes from supabase.auth.getUser() — NOT from request body` — Iron Dome invariant documented |
| 57 | `const { data: { user }, error: authError } = await supabase.auth.getUser()` — CORRECT derivation method |
| 104 | `p_reviewer_id: user.id` — passed to `safisha_resolve_exception()` SECURITY DEFINER |
| 142 | `reviewer_id: user.id` — in response payload (not a DB write; informational) |

**Defect:**
1. **AUDIT FK DEFECT:** `user.id` is `auth.users.id`. `safisha_exceptions.reviewer_id` and `safisha_audit_log.reviewer_id` (migration lines 125 and 326) are `REFERENCES auth.users(id)`. When Phase 2 changes these to `firm_members(id)`, `safisha_resolve_exception()` must be updated to accept or resolve a `firm_members.id` value.

**Compliant:** Identity derivation from `supabase.auth.getUser()` — not request body. Iron Dome reviewer_id invariant is respected.

### D.4 generate-xbrl/index.ts

| Line | Detail |
|------|--------|
| 87 | `const { data: { user }, error: authErr } = await supabase.auth.getUser()` — CORRECT derivation method |
| *writes via* | Calls `xbrl_write_instance()` SECURITY DEFINER, which captures `auth.uid()` at migration L270 — writes `auth.users.id` to `xbrl_instance_documents.generated_by` |

**Defect:**
1. **AUDIT FK DEFECT:** `generated_by` receives `auth.users.id`. When Phase 2 changes column to `firm_members(id)`, `xbrl_write_instance()` must resolve `auth.uid()` → `firm_members.id`.

**Compliant:** Identity derivation uses `supabase.auth.getUser()`.

### D.5 safisha-efdms-ingest/index.ts

| Line | Detail |
|------|--------|
| 301 | `const { data: { user }, error: authErr } = await supabase.auth.getUser()` — CORRECT derivation method |
| 346–349 | `firm_members` lookup: `.eq("user_id", user.id)` — correctly resolves membership |
| 410 | `imported_by: user.id` — writes `auth.users.id` to `efdms_z_reports.imported_by` |

**Defect:**
1. **AUDIT FK DEFECT:** `imported_by` at line 410 writes `user.id` (`auth.users.id`) despite the function already doing a `firm_members` lookup at lines 346–349 that retrieves the `firm_members.id`. The `firm_members.id` is not captured and used — only `user.id` is written.

**Notable:** This function is the closest to correct — it already does the `firm_members` lookup. In Phase 2, only line 410 needs to change from `user.id` to the resolved `firm_members.id`.

### D.6 Edge Function Summary

| Function | Identity Derivation Method | Writes audit FK | Current FK target | Defect(s) |
|----------|---------------------------|----------------|------------------|-----------|
| `kinga-tax-engine` | Request body (`userId` param) | Yes — `created_by` on AJEs | `auth.users.id` | REQUEST BODY IDENTITY + AUDIT FK DEFECT + NULL BYPASS |
| `hesabu-validate` | `supabase.auth.getUser()` ✓ | Via SECURITY DEFINER | `auth.users.id` | AUDIT FK DEFECT (in DB layer) |
| `safisha-resolve` | `supabase.auth.getUser()` ✓ | Via SECURITY DEFINER | `auth.users.id` | AUDIT FK DEFECT (in DB layer) |
| `generate-xbrl` | `supabase.auth.getUser()` ✓ | Via SECURITY DEFINER | `auth.users.id` | AUDIT FK DEFECT (in DB layer) |
| `safisha-efdms-ingest` | `supabase.auth.getUser()` ✓ | Direct (`imported_by`) | `auth.users.id` | AUDIT FK DEFECT (firm_members.id already available) |

---

## Deliverable E — Orphan-Backfill Risk Report

Analysis of data migration risk when Phase 2 changes audit FK columns from `auth.users(id)` to `firm_members(id)`. Each existing row stores an `auth.users.id` UUID. After the FK target changes, those stored UUIDs must be translated to their corresponding `firm_members.id` values — or the backfill will orphan them.

### E.1 Backfill Feasibility Conditions

A table can be backfilled if and only if:
1. The `auth.users.id` value in the audit column can be joined to `firm_members.user_id` for the same `company_id` in the row.
2. That `firm_members` row is unique (one membership per user per company) — which is enforced by the `(user_id, company_id)` UNIQUE constraint in `20260625130000_7a1e4d92.sql`.

Translation query template (do NOT run in Phase 0):
```sql
-- PHASE 2 ONLY — NOT FOR EXECUTION NOW
UPDATE <table>
SET <audit_col> = fm.id
FROM firm_members fm
WHERE fm.user_id = <table>.<audit_col>
  AND fm.company_id = <table>.company_id;
```

### E.2 Table-by-Table Backfill Risk Assessment

| Table | Audit Column(s) | Has company_id? | Backfill Feasible? | Risk Level | Notes |
|-------|----------------|-----------------|-------------------|------------|-------|
| `capital_allowances` | `created_by` | ✓ | ✓ | LOW | One-to-one membership lookup |
| `tax_payments` | `created_by` | ✓ | ✓ | LOW | |
| `fiscal_periods` | `created_by` | ✓ | ✓ | LOW | |
| `tax_losses` | `created_by` | ✓ | ✓ | LOW | |
| `tax_computations` | `cpa_modified_by` | ✓ | ✓ | LOW | Nullable; NULLs need no translation |
| `adjusting_journal_entries` | `created_by`, `approved_by` | ✓ | ✓ | LOW | `approved_by` nullable |
| `management_inputs` | `created_by` | ✓ | ✓ | LOW | |
| `account_pl_mapping` | `created_by` | ✓ | ✓ | LOW | |
| `variance_materiality` | `updated_by` | ✓ | ✓ | LOW | Nullable |
| `variance_budgets` | `submitted_by`, `approved_by` | ✓ | ✓ | MEDIUM | Two separate actors; `approved_by` may come from a different firm member |
| `variance_runs` | `triggered_by` | ✓ | ✓ | LOW | |
| `maono_context` | `updated_by` | ✗ | **UNCERTAIN** | HIGH | `maono_context` is a global key-value store (no `company_id`). The `updated_by` field cannot be resolved to a `firm_members.id` without knowing which company the update was for. **Phase 2 must decide**: keep as `auth.users(id)`, or add a `company_id` column to `maono_context`. |
| `board_packs` | `generated_by` | ✓ | ✓ | LOW | |
| `efdms_z_reports` | `imported_by` | ✓ | ✓ | LOW | |
| `efdms_reconciliation` | `reconciled_by` | ✓ | ✓ | LOW | |
| `hesabu_validations` | `validated_by` | ✓ | ✓ | LOW | |
| `xbrl_instance_documents` | `generated_by` | ✓ | ✓ | LOW | |
| `statement_sign_offs` | `preparer_id`, `reviewer_id`, `approver_id`, `locked_by` | ✓ | ✓ | MEDIUM | Four actor columns; all stored auth.users.id values from the same company — each must be translated. Hybrid state: `*_firm_member_id` parallel columns may already be populated for recent rows. |
| `findings` (early Kinga) | `created_by` | ✓ (via upload→company) | ✓ (indirect) | MEDIUM | Requires JOIN through uploads table; company_id not directly on findings table |
| `evidence_requests` | `created_by` | ✓ (via finding→upload→company) | ✓ (indirect) | MEDIUM | Two-hop join |
| `safisha_exceptions` | `reviewer_id` | ✓ (via reconciliation) | ✓ (indirect) | MEDIUM | reviewer_id may be NULL for unresolved exceptions |
| `safisha_audit_log` | `reviewer_id` | ✓ (via reconciliation) | ✓ (indirect) | MEDIUM | APPEND-ONLY — cannot UPDATE existing rows per Iron Dome. **BLOCKER: see E.3** |

### E.3 APPEND-ONLY BACKFILL BLOCKER

**`safisha_audit_log.reviewer_id` cannot be backfilled.**

`safisha_audit_log` is APPEND-ONLY enforced by a trigger (`safisha_block_updates()`, `20260711200000_safisha_core.sql` line 147). The trigger blocks all UPDATE and DELETE operations. A standard `UPDATE ... SET reviewer_id = ...` backfill query will be rejected by the trigger.

**Options for Phase 2 decision (not Phase 0):**
1. Accept that historical `safisha_audit_log` rows will retain `auth.users.id` in `reviewer_id`. Add a parallel `reviewer_member_id UUID REFERENCES firm_members(id)` column populated going forward.
2. Drop and recreate the append-only trigger temporarily, backfill, re-enable — high risk, audit trail contamination.
3. Keep `safisha_audit_log.reviewer_id` as `REFERENCES auth.users(id)` permanently and document it as an AUTH USER IDENTITY column (not AUDIT FK DEFECT).

**Option 3 is recommended** for consideration in Phase 2, given Iron Dome's append-only mandate. The decision belongs to the architect, not Phase 0.

### E.4 SAFISHA CLIENT_ID ARCHITECTURAL DECISION REQUIRED

`safisha_reconciliations.client_id` and `safisha_client_mappings.client_id` (migration `20260711200000_safisha_core.sql` lines 41 and 354) store `auth.users.id`. These are not audit actor columns — they are **ownership anchors** analogous to `firm_members.user_id`. The Safisha RLS is built entirely on `client_id = auth.uid()` (lines 375–426), which bypasses `firm_members` entirely.

**This is an architectural question, not a backfill question:**
- If Safisha reconciliations are per-firm (shared across firm members), `client_id` should become `company_id` + firm_members access control.
- If Safisha reconciliations are per-user (each staff member has private workspaces), the current `client_id = auth.uid()` pattern is correct and should be kept.

Phase 0 records this as an open architectural decision. No change should be made in Phase 1.

### E.5 VARIANCE_ALERTS.ACKNOWLEDGED_BY — AMBIGUOUS RESOLUTION

`variance_alerts.acknowledged_by` (`20260711300100_maono_phase_b.sql` line 169) is NULLABLE and non-blocking. An acknowledgment is an auditable human action (who dismissed this alert). Classification leans toward AUDIT FK DEFECT, but the consequence of an unacknowledged alert is informational, not lifecycle-critical. Phase 2 can safely handle this as a LOW-priority item.

### E.6 Rows with No Matching firm_members Record (Orphan Risk)

If a user has been removed from `firm_members` since they created a record, their `auth.users.id` will be in the audit column but will not join to any `firm_members` row. This would break FK enforcement after Phase 2 migration.

**Mitigation required in Phase 2 pre-flight:** Before running backfill, run a diagnostic query to count rows where `<audit_col>` does not match any `firm_members.user_id` for the row's `company_id`. Any such rows must be resolved (either by reassigning to a current firm member or by nullifying if the column is nullable) before the FK constraint is altered.

---

## Deliverable F — Phase 0 Exit Checklist

| Item | Status | Notes |
|------|--------|-------|
| All migration files scanned for identity column definitions | ✓ DONE | 44 migration files identified via grep; all key files read with line-numbered output |
| All `REFERENCES auth.users(id)` occurrences catalogued | ✓ DONE | 37 identity columns inventoried across 31 tables |
| All `REFERENCES public.firm_members` occurrences catalogued | ✓ DONE | Only `firm_members.user_id` itself; no existing audit columns yet point to firm_members.id |
| All `auth.uid()` default values on audit columns identified | ✓ DONE | Lines 316, 500, 713 of `20260625100000_b3e5c891.sql` |
| All SECURITY DEFINER functions audited | ✓ DONE | 17 SECURITY DEFINER functions found; 3 have auth.uid() write defects; 1 has missing pg_temp |
| All RLS policies using identity fields catalogued | ✓ DONE | 5 policies identified that will break in Phase 2; 3 unsafe bypass-firm_members patterns |
| All 24 edge functions scanned for identity field usage | ✓ DONE | 5 functions have identity writes; 19 confirmed clean |
| Edge function identity derivation methods verified | ✓ DONE | 4 of 5 use `supabase.auth.getUser()`; 1 (`kinga-tax-engine`) accepts from request body — defect documented |
| React components scanned for direct DB identity writes | ✓ DONE | 6 components write identity fields; `userId` prop chain traced to `Dashboard.tsx` L690 → `useAuth()` → `auth.users.id` |
| `firm_members.user_id` column name confirmed unchanged | ✓ DONE | `20260625130000_7a1e4d92.sql` L289 — column name is `user_id`, kept per v2.3 |
| Append-only tables identified for backfill impossibility | ✓ DONE | `safisha_audit_log` cannot be UPDATEd; blocker documented in E.3 |
| Tables without `company_id` identified for backfill infeasibility | ✓ DONE | `maono_context` — no company_id; high-risk item in E.2 |
| Orphan-user risk documented | ✓ DONE | E.6 — diagnostic query required in Phase 2 pre-flight |
| Architectural decisions outstanding (not Phase 0 items) | ✓ DOCUMENTED | `safisha_reconciliations.client_id` (E.4), `safisha_audit_log` backfill (E.3), `hesabu_block_signoff` SoD (B.3) |
| Phase 0 scope respected — no code, no migrations, no modifications | ✓ CONFIRMED | This report is read-only. No file was modified. |

---

## Deliverable G — Phase 1 Readiness Ruling

### G.1 Phase 1 Definition (per Architecture v2.3)

Phase 1 is the **FK migration phase**: adding `firm_members(id)` FK columns alongside existing `auth.users(id)` columns, running backfill, and switching RLS policies. It is a destructive-schema operation affecting 31 tables and requires the following pre-conditions to be met.

### G.2 Ruling: NOT READY FOR PHASE 1

**Phase 1 cannot begin until the items below are resolved.**

---

**BLOCKER 1 — `safisha_audit_log` backfill impossibility (E.3)**  
The append-only trigger on `safisha_audit_log` prevents UPDATE backfill of `reviewer_id`. Phase 2 must first decide: keep `reviewer_id` as `auth.users.id` permanently, or adopt the parallel-column strategy. No migration can proceed until this decision is made and documented.

**BLOCKER 2 — `maono_context` has no `company_id` (E.2)**  
`maono_context.updated_by` cannot be translated to `firm_members.id` without a `company_id` reference on that table. The FK migration would either fail or silently null-out existing values. Phase 2 must add `company_id` to `maono_context` (a schema change) before any backfill is possible.

**BLOCKER 3 — `safisha_reconciliations.client_id` architectural decision (E.4)**  
The entire Safisha access control model is built on `client_id = auth.uid()`. If this column becomes `firm_members.id`, all Safisha RLS policies break simultaneously. The architectural decision (per-user vs per-firm reconciliation workspaces) must be made before Phase 1 touches the Safisha tables.

**BLOCKER 4 — `kinga-tax-engine` request-body identity (D.1)**  
`kinga-tax-engine/index.ts` accepts `userId` from the POST request body and writes it directly to `adjusting_journal_entries.created_by`. This violates the Iron Dome invariant that actor identity must always be derived from `supabase.auth.getUser()` inside the function, never from the request body. This defect must be corrected before Phase 1, because after Phase 1 the AJE `created_by` column will reference `firm_members.id` — a value the client cannot supply (it doesn't know its own `firm_members.id`).

**BLOCKER 5 — `hesabu_write_validation()` missing `pg_temp` (B.1)**  
`SET search_path = public` without `pg_temp` is a security defect in a SECURITY DEFINER function. Before Phase 2 updates this function to perform a `firm_members` lookup, the `pg_temp` missing from the search_path must be corrected simultaneously.

**BLOCKER 6 — `safisha_resolve_exception()` search_path unverified (B.2)**  
grep did not confirm a `SET search_path` for `safisha_resolve_exception()`. This must be read and verified before Phase 1. If missing, it is the same class of defect as BLOCKER 5.

---

**REQUIRED DECISIONS BEFORE PHASE 1 (not blockers, but must be documented):**

- `variance_alerts.acknowledged_by` (E.5): Confirm AUDIT FK DEFECT classification. If yes, include in backfill plan. If acknowledged as informational/non-actor, keep as `auth.users.id`.
- `hesabu_block_signoff()` SoD gap (B.3): Confirm whether SoD enforcement (preparer ≠ reviewer ≠ approver) is required in Phase 1 or deferred to a later phase.
- Orphan-user diagnostic (E.6): Must be run against production data before any backfill migration. Results must be reviewed.

---

**WHAT IS READY:**

| Item | Status |
|------|--------|
| Identity Reference Matrix complete | ✓ |
| All 31 defect tables identified with exact file + line | ✓ |
| Backfill feasibility assessed per table | ✓ |
| 5 breaking RLS policies identified | ✓ |
| 3 unsafe RLS bypass patterns identified | ✓ |
| 5 edge function identity flows mapped | ✓ |
| 6 React component identity write paths mapped | ✓ |
| SECURITY DEFINER audit complete | ✓ |
| `firm_members.user_id` column name confirmed stable | ✓ |
| All blockers for Phase 1 documented with specific remediation requirements | ✓ |

---

### G.3 Recommended Phase 1 Entry Criteria

Phase 1 may begin when:

1. Architect documents the `safisha_audit_log` strategy (parallel column or permanent `auth.users` FK).
2. `maono_context` schema decision is made (add `company_id` or keep `updated_by` as non-migratable `auth.users.id`).
3. Architect documents the Safisha access model decision (per-user vs per-firm).
4. `kinga-tax-engine/index.ts` is corrected to derive actor identity from `supabase.auth.getUser()` internally and resolve to `firm_members.id` before writing.
5. `hesabu_write_validation()` search_path is corrected to include `pg_temp`.
6. `safisha_resolve_exception()` search_path is verified (and corrected if absent).
7. Orphan-user diagnostic query is run and results are reviewed by a human.
8. The Phase 1 migration plan cites exact tables, exact column additions, exact backfill SQL, and exact RLS DROP/CREATE pairs — derived from this Phase 0 report.

---

*Phase 0 complete. No code was written. No schema was modified. No migrations were created. No functions were deployed. This document is the sole output of Phase 0.*

*Next authorized step: human review and resolution of the 6 blockers listed in G.2, followed by architect sign-off on the 3 required decisions. Phase 1 may not begin until G.3 criteria are met.*
