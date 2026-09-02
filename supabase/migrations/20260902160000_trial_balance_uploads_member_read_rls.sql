-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0 SLICE 4B — trial_balance_uploads accepted-member SELECT visibility
--
-- Fixes DEFECT-TRIAL-BALANCE-UPLOAD-MEMBER-READ-RLS-001 (HIGH — workspace-
-- authoritative UI correctness, not a cross-tenant disclosure defect).
--
-- get_authoritative_certification(company_id, period_year) is SECURITY
-- INVOKER (Slice 1, 20260902130000) and its latest_upload CTE reads
-- public.trial_balance_uploads. Under SECURITY INVOKER that read is subject
-- to the CALLING role's own RLS on that table. trial_balance_uploads' only
-- SELECT policy (20251208084402, "Users can view their own uploads") is
-- USING (auth.uid() = user_id) -- scoped to the ORIGINAL UPLOADER, predating
-- this project's firm_members/company multi-tenant model. Every other
-- financial table added since (tb_certifications, engine_runs,
-- idempotency_keys, account_review_decisions) uses the accepted-firm-member
-- pattern instead; this table was simply never upgraded.
--
-- Concrete failure this closes: an accepted firm_members row for company C
-- who did NOT personally upload the trial balance calls
-- get_authoritative_certification(C, year). The RLS-invisible upload row
-- makes latest_upload empty, so the function returns zero rows -- reporting
-- "no authoritative certification exists" even though one genuinely does.
-- This is an availability/correctness defect, not a leak: the function
-- already fails closed correctly for non-members of the company.
--
-- SCOPE: additive only. Adds ONE new SELECT policy. Does not touch INSERT/
-- UPDATE/DELETE policies or grants on this table (a `FOR SELECT` policy
-- structurally cannot affect other operations). Does not touch
-- tb_certifications/engine_runs/idempotency_keys/account_review_decisions
-- RLS or get_authoritative_certification's own SQL -- the fix is entirely
-- at the RLS boundary of the table it depends on, not the function itself.
-- No role filtering (owner/partner/preparer/etc.) -- any accepted workspace
-- member of the company may read the workspace TB needed to see
-- authoritative certification status, matching the existing tbc_select
-- precedent on tb_certifications exactly.
--
-- NULL company_id safety: trial_balance_uploads.company_id is nullable
-- (ADD COLUMN ... REFERENCES companies(id) ON DELETE SET NULL,
-- 20260108144134) -- legacy/orphaned rows exist. The membership predicate
-- below (fm.company_id = trial_balance_uploads.company_id) can never match
-- when company_id IS NULL (NULL = anything is never TRUE in SQL), so this
-- new policy grants no additional visibility to such rows at all -- only
-- the pre-existing uploader-only policy continues to govern them, exactly
-- as required.
--
-- NOT applied to any live database. DEFECT-SAFISHA-MIGRATION-HISTORY-001's
-- external reconciliation gate is unrelated and untouched by this file.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- Additive: the existing "Users can view their own uploads" policy is left
-- completely untouched. RLS policies for the same command are OR'd
-- together -- a row is visible if ANY permissive policy matches, so the
-- original uploader keeps exactly the access they already had.
CREATE POLICY "Accepted workspace members can view company uploads"
  ON public.trial_balance_uploads
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id     = auth.uid()
         AND fm.company_id  = trial_balance_uploads.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP POLICY IF EXISTS "Accepted workspace members can view company uploads" ON public.trial_balance_uploads;
