-- ════════════════════════════════════════════════════════════════════════════
-- Discard trial balance — authoritative server-side boundary
--
-- ROOT CAUSE this fixes (confirmed by reading the live schema, not assumed):
--
--   trial_balance_uploads' DELETE policy ("Users can delete their own
--   uploads", migration 20251208084402) is `USING (auth.uid() = user_id)` --
--   scoped to the ORIGINAL UPLOADER ONLY. This predates the firm_members/
--   company multi-tenant model. Migration 20260902160000 already documented
--   and fixed the exact same staleness for SELECT ("Users can view their own
--   uploads" was uploader-only; it added an additive accepted-member SELECT
--   policy) but explicitly left INSERT/UPDATE/DELETE untouched ("Does not
--   touch INSERT/UPDATE/DELETE policies or grants on this table").
--
--   Concrete failure: any accepted firm member who is NOT the original
--   uploader (a colleague, a partner reviewing someone else's upload)
--   attempts to discard a trial balance. The DELETE RLS policy silently
--   filters the row out of the WHERE clause -- zero rows match, with NO
--   Postgres error (RLS row-filtering is not an error condition). Before
--   this session's own discardUpload() hardening (which added affected-row
--   verification via `.select("id")` on the delete), that zero-row match
--   was indistinguishable from success on the client and could be reported
--   as a completed discard that never actually happened.
--
-- THE DEEPER PROBLEM this migration ALSO fixes (raised explicitly, and
-- correctly, after the affected-row-verification hardening landed): once the
-- client can tell "zero rows deleted", it still cannot safely tell WHY.
-- Distinguishing "already discarded" from "forbidden" by issuing a follow-up
-- SELECT from the CLIENT is unreliable under RLS: RLS filters rows out of
-- visibility rather than raising a distinguishable error, so a row a caller
-- is not authorized to see is INDISTINGUISHABLE, from that caller's own
-- RLS-scoped SELECT, from a row that genuinely does not exist. A client-side
-- "select after zero-row delete" check can therefore misclassify a genuine
-- FORBIDDEN outcome as ALREADY_DISCARDED whenever the caller's own SELECT
-- visibility is narrower than their (attempted) DELETE authority -- exactly
-- the scenario an unaccepted (accepted_at IS NULL) firm_members row would
-- produce, since neither the uploader-only nor the accepted-member SELECT
-- policy would match such a caller either.
--
-- FIX, additive and narrowly scoped, in two parts:
--
--   1. A new, ADDITIVE DELETE policy for accepted firm members -- the exact
--      same predicate pattern 20260902160000 already established and this
--      project reviewed for SELECT, applied here to DELETE. RLS policies for
--      the same command are OR'd together: the original uploader-only policy
--      is untouched and keeps exactly the access it already had.
--
--   2. discard_trial_balance_upload(uuid): a SECURITY DEFINER RPC that
--      performs the existence + authorization decision itself, with FULL
--      visibility (SECURITY DEFINER intentionally bypasses RLS -- this
--      function IS the authorization boundary from here on, checked
--      EXPLICITLY inside its own body against firm_members, never left to
--      RLS to silently filter into an ambiguous "not found"). Returns one of
--      exactly four authoritative outcomes:
--        deleted_now          -- this call performed the delete.
--        already_discarded    -- the row genuinely does not exist (checked
--                                 with full visibility -- never an RLS
--                                 artifact of the caller's own visibility).
--        forbidden             -- the row exists, but the caller has no
--                                 accepted membership in its company.
--        dependency_conflict   -- a NO ACTION foreign key elsewhere in the
--                                 schema refused the delete (existing
--                                 dependent-record behaviour, unchanged --
--                                 this function does not enumerate every
--                                 dependent table; it lets Postgres's own
--                                 constraint enforcement raise the specific,
--                                 already-correct exception class).
--      Storage-object cleanup and the undo receipt's file blob remain
--      client-side (Postgres has no access to Supabase Storage buckets) --
--      this function returns the row snapshot and file_path so the client
--      can still build an exact undo receipt for a genuine deleted_now.
--
-- NOT atomic across the database delete and the storage object removal --
-- these are two separate systems and this migration does not claim
-- otherwise. The row delete (this function) is the authoritative act; the
-- existing client-side storage removal remains best-effort, exactly as
-- documented in DiscardUploadDialog.tsx's own module comment. A future
-- genuinely atomic or saga-tracked storage cleanup is out of scope here.
--
-- STALE_VERSION is not a distinct outcome this function returns: no
-- optimistic-concurrency column (e.g. an updated_at/version check) exists on
-- trial_balance_uploads today, and adding one is a larger schema change out
-- of scope for this fix. A stale target (something changed between the
-- dialog opening and the discard attempt) surfaces as whatever its NEW state
-- authoritatively is -- most commonly already_discarded if it was removed by
-- another actor in the meantime.
--
-- Never applied to any live database from this repository -- migrations are
-- committed here; `supabase db push` remains the owner's own action.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── 1. Additive DELETE policy for accepted firm members ─────────────────────
-- Mirrors 20260902160000's SELECT fix exactly. The pre-existing uploader-only
-- DELETE policy is untouched.
CREATE POLICY "Accepted workspace members can delete company uploads"
  ON public.trial_balance_uploads
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id     = auth.uid()
         AND fm.company_id  = trial_balance_uploads.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );

-- ── 2. Authoritative discard outcome type + RPC ──────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.discard_outcome AS ENUM (
    'deleted_now',
    'already_discarded',
    'forbidden',
    'dependency_conflict'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.discard_trial_balance_upload(p_upload_id uuid)
RETURNS TABLE (
  outcome     public.discard_outcome,
  row_snapshot jsonb,
  file_path    text,
  detail       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_authorized boolean;
BEGIN
  IF p_upload_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::jsonb, NULL::text, 'No upload id supplied.'::text;
    RETURN;
  END IF;

  -- SECURITY DEFINER intentionally bypasses RLS for this read -- this
  -- function IS the authorization boundary from here on; the check below is
  -- explicit, never inferred from what RLS would have filtered.
  SELECT * INTO v_row FROM public.trial_balance_uploads WHERE id = p_upload_id;

  IF v_row.id IS NULL THEN
    -- Authoritative: this function has full visibility, so absence here is
    -- never an artifact of the caller's own RLS-scoped visibility.
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::jsonb, NULL::text, 'This trial balance no longer exists.'::text;
    RETURN;
  END IF;

  -- Explicit authorization check -- the original uploader OR any accepted
  -- firm member of the upload's own company. Same predicate the two RLS
  -- policies (uploader-only DELETE, accepted-member DELETE above) already
  -- encode; checked directly here rather than relying on RLS to enforce it
  -- via a second, RLS-scoped DELETE this function does not perform.
  SELECT
    (v_row.user_id IS NOT NULL AND v_row.user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id     = auth.uid()
         AND fm.company_id  = v_row.company_id
         AND fm.accepted_at IS NOT NULL
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::jsonb, NULL::text, 'You are not authorised to discard this trial balance.'::text;
    RETURN;
  END IF;

  BEGIN
    DELETE FROM public.trial_balance_uploads WHERE id = p_upload_id;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN QUERY SELECT 'dependency_conflict'::public.discard_outcome, NULL::jsonb, NULL::text, 'Other records in this workspace still depend on this trial balance.'::text;
    RETURN;
  END;

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, to_jsonb(v_row), v_row.file_path, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid) FROM PUBLIC, anon;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP FUNCTION IF EXISTS public.discard_trial_balance_upload(uuid);
-- DROP TYPE IF EXISTS public.discard_outcome;
-- DROP POLICY IF EXISTS "Accepted workspace members can delete company uploads" ON public.trial_balance_uploads;
