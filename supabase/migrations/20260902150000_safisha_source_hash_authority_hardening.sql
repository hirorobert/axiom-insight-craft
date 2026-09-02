-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0 SLICE 2 — SOURCE_FILE_HASH AUTHORITY HARDENING
--
-- Fixes two real defects found in the Slice 2 authority-boundary review of
-- supabase/functions/process-trial-balance/index.ts:
--
--   1. SOURCE_FILE_HASH_DB_WRITE_BOUNDARY: FAIL — trial_balance_uploads'
--      existing "Users can update their own uploads" RLS policy has no
--      WITH CHECK narrower than USING (auth.uid() = user_id), so an
--      authenticated owner can set source_file_hash to ANY value via a
--      direct client update. Fixed with a BEFORE UPDATE trigger scoped to
--      exactly this one column — everything else about that policy and
--      every other column on this table is untouched.
--
--   2. get_authoritative_certification's source-hash predicate permitted
--      authority when the current upload's source_file_hash was NULL
--      ("no signal, don't block" — correct for Slice 1R, when nothing yet
--      populated the column). Now that Slice 2 makes process-trial-balance
--      a real, live writer of that column, an unknown/never-observed
--      current source identity must fail closed, not open. Fixed by
--      changing OR to AND NOT NULL in the one predicate clause; nothing
--      else about the function's structure, ordering, or C1/C2/A-I
--      semantics changes.
--
-- Does NOT edit 20260902130000_safisha_certification_foundation.sql —
-- that file is immutable historical source. This migration re-declares
-- get_authoritative_certification via CREATE OR REPLACE FUNCTION (legal:
-- same signature, same GRANTs already in place from that migration carry
-- forward automatically) and adds one new, narrowly-scoped trigger.
--
-- NOT applied to any live database. DEFECT-SAFISHA-MIGRATION-HISTORY-001
-- remains open and untouched — this migration stays local/GitHub-only
-- until that external gate is reconciled.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. trial_balance_uploads.source_file_hash — write-authority trigger
--
-- Scoped to exactly one column. Every other column on this table remains
-- governed exactly as before by the existing RLS policies — this does not
-- touch, replace, or narrow "Users can update their own uploads", the
-- company_id RESTRICTIVE policies, or any grant. An update that does not
-- touch source_file_hash is completely unaffected by this trigger.
--
-- Authorization check uses current_user, the actual connected PostgreSQL
-- role — never a JWT claim. When Supabase's service_role API key is used
-- (as process-trial-balance's admin client does), PostgREST connects as
-- the real `service_role` database role; an authenticated end-user client
-- connects as the real `authenticated` role and has no path to become
-- `service_role` without possessing the service-role secret itself. This
-- mirrors the role-based GRANT/REVOKE model already established for
-- commit_tb_certification and tb_certifications (Slice 1) rather than
-- inspecting auth.role()'s JWT-claim-derived value.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trial_balance_uploads_protect_source_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- Only source_file_hash is guarded. Any other column change on this row
  -- proceeds exactly as the existing RLS policies already allow.
  IF NEW.source_file_hash IS DISTINCT FROM OLD.source_file_hash
     AND current_user <> 'service_role' THEN
    RAISE EXCEPTION
      'source_file_hash is server-authoritative (set only by process-trial-balance via the service role) and cannot be changed by role %',
      current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_source_file_hash ON public.trial_balance_uploads;
CREATE TRIGGER trg_protect_source_file_hash
  BEFORE UPDATE ON public.trial_balance_uploads
  FOR EACH ROW
  EXECUTE FUNCTION public.trial_balance_uploads_protect_source_hash();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. get_authoritative_certification — fail-closed on unknown source hash
--
-- Structure, CTEs, ordering, and every other predicate are byte-for-byte
-- identical to the Slice 1R version. Only the source-hash clause changes:
--   OLD: current_source_file_hash IS NULL OR current_source_file_hash = ...
--   NEW: current_source_file_hash IS NOT NULL AND current_source_file_hash = ...
-- An unknown current source identity (NULL — never yet observed by any
-- successful process-trial-balance run) now withdraws authority rather
-- than permitting it. See CASE J in the manual verification spec.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_authoritative_certification(
  p_company_id UUID,
  p_period_year INTEGER
) RETURNS SETOF public.tb_certifications
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  -- Step 1: the CURRENT source for this company+period is the most
  -- recently created upload. uploaded_at (TIMESTAMP WITH TIME ZONE NOT
  -- NULL DEFAULT now(), server-assigned at INSERT — confirmed against
  -- 20251207114310_9b5d0843-....sql, not client-supplied) is the ordering
  -- signal; id is a pure determinism tiebreak, not a recency signal. TB
  -- uploads are single-user, human-paced, one-INSERT-per-upload actions
  -- (TrialBalanceUpload.tsx) — a genuine microsecond-level uploaded_at tie
  -- between two DIFFERENT uploads for the same company+period is not a
  -- realistic occurrence this architecture needs to defend against. A
  -- dedicated monotonic sequence on trial_balance_uploads (mirroring
  -- tb_certifications_seq) was deliberately NOT added: that table is
  -- pre-existing, out-of-scope for this slice, and no repository evidence
  -- shows uploaded_at is actually ambiguous in practice — inventing a new
  -- primitive to guard a non-observed failure mode would be unwarranted
  -- architecture. We also carry the upload's CURRENT source_file_hash
  -- forward, to detect drift against what the latest certification
  -- actually certified (Step 3).
  WITH latest_upload AS (
    SELECT id, source_file_hash AS current_source_file_hash
      FROM public.trial_balance_uploads
     WHERE company_id = p_company_id
       AND (p_period_year IS NULL OR period_year = p_period_year)
     ORDER BY uploaded_at DESC, id DESC
     LIMIT 1
  ),
  -- Step 2: the LATEST certification attempt for that current upload,
  -- REGARDLESS of eligibility. Ordering by sequence_no DESC (the
  -- dedicated, gap-free, monotonic tb_certifications_seq — a real total
  -- order across every certification ever committed, unlike a timestamp)
  -- and taking exactly one row is what this function evaluates next. This
  -- is the fix: eligibility is no longer part of the WHERE clause that
  -- selects "latest" — a newer blocking/requires_review attempt for the
  -- same upload MUST be the row considered, not silently stepped over in
  -- favour of an older eligible one.
  latest_certification AS (
    SELECT c.*
      FROM public.tb_certifications c, latest_upload lu
     WHERE c.upload_id = lu.id
     ORDER BY c.sequence_no DESC
     LIMIT 1
  )
  -- Step 3: that ONE latest certification is authoritative only if it is
  -- itself eligible AND its own recorded source_file_hash EXACTLY matches
  -- the upload's current, KNOWN source_file_hash. A NULL current_source_
  -- file_hash means no successful process-trial-balance run has ever
  -- observed this upload's bytes — that is an UNKNOWN current identity,
  -- not "no drift signal, permit it": Slice 2 makes this column a live,
  -- server-authoritative observation, so an unknown identity must fail
  -- closed, exactly like a known mismatch. If the latest certification is
  -- blocking, requires review, has no matching current hash, or the
  -- current hash is unknown, NO row is returned — there is deliberately
  -- no fallback to an older eligible certification for the same current
  -- upload (see C1/C2 analysis and cases A-J in
  -- supabase/tests/safisha_certification_foundation_manual_verification.sql).
  SELECT lc.*
    FROM latest_certification lc, latest_upload lu
   WHERE lc.is_blocking = false
     AND lc.requires_review = false
     AND lu.current_source_file_hash IS NOT NULL
     AND lu.current_source_file_hash = lc.source_file_hash;
$$;

-- Ω∞ Rollback (NOT executed — for reference only):
-- DROP TRIGGER IF EXISTS trg_protect_source_file_hash ON public.trial_balance_uploads;
-- DROP FUNCTION IF EXISTS public.trial_balance_uploads_protect_source_hash();
-- Reverting get_authoritative_certification to the Slice 1R predicate would
-- require restoring the exact 20260902130000 function body verbatim — not
-- inlined here to avoid two competing copies of that logic in one file.
