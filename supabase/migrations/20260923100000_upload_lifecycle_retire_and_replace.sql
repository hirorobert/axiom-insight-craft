-- ════════════════════════════════════════════════════════════════════════════
-- Trial balance upload lifecycle — retire-and-replace for processed uploads
--
-- ROOT CAUSE this fixes: 20260922180000_discard_trial_balance_authority.sql's
-- discard_trial_balance_upload(uuid) deletes trial_balance_uploads directly.
-- trial_balance_uploads -> tb_certifications is ON DELETE CASCADE
-- (20260902130000_safisha_certification_foundation.sql, fk_tbc_upload), but
-- tb_certifications is unconditionally append-only (trg_tbc_immutable) --
-- including against a delete arriving via cascade. Any upload that has ever
-- been certified (blocked, needs-review, or clean) can therefore NEVER be
-- hard-deleted: the cascade always hits the append-only guard and the whole
-- DELETE aborts. Confirmed live against axiom-omega3-staging-replay during
-- authenticated UI acceptance of PR #32 (2026-09-23): a genuinely certified
-- fixture's discard failed with P0001 "tb_certifications is append-only",
-- uncaught by the RPC's `EXCEPTION WHEN foreign_key_violation` clause (P0001
-- is not 23503), surfacing as a generic retryable DiscardError instead of an
-- honest outcome. This is NOT a defect introduced by this repository's own
-- discard work -- it is a structural contradiction between two independently
-- pre-existing, deliberate Iron Dome invariants (CASCADE vs. append-only)
-- that had never been exercised together until a real certified upload was
-- actually discarded.
--
-- This migration does NOT weaken either invariant. tb_certifications stays
-- append-only. The CASCADE FK is untouched (a genuinely unprocessed upload
-- with no certification history still hard-deletes exactly as before). What
-- changes is that a PROCESSED/CERTIFIED/DEPENDENT upload is no longer hard-
-- deleted at all: it is RETIRED (superseded by a replacement upload), and its
-- certification/evidence history is preserved forever, exactly as the
-- append-only guard already requires.
--
-- ── 1. Formal lifecycle ───────────────────────────────────────────────────
--   ACTIVE_UNPROCESSED  -- uploaded, never processed, no certification.
--   ACTIVE_PROCESSING   -- process-trial-balance has started; not yet certified.
--   ACTIVE_PROCESSED    -- certified, eligible (not blocking, not requires_review).
--   BLOCKED             -- certified, blocking (arithmetic/data-quality failure).
--   RETIRED             -- explicitly retired without a replacement (reserved
--                          for a future admin path; not written by this
--                          migration's own functions, but a legal state so a
--                          future operation can use it without another
--                          migration).
--   SUPERSEDED           -- retired BECAUSE a replacement upload now exists
--                          (superseded_by_upload_id is set).
--   DISCARD_PENDING      -- a hard-discard saga has started (Storage removal
--                          not yet confirmed complete).
--   DISCARDED            -- terminal: the row is about to be/has been removed.
--                          (Present for completeness of the model; in
--                          practice the row is physically deleted once this
--                          state would be reached -- see discard_trial_balance_upload
--                          below -- so no live row is ever actually observed
--                          in this exact state under normal operation.)
--
--   Unknown/contradictory state fails closed: the CHECK constraint below is
--   the only legal vocabulary: nothing else can ever be written, and every
--   function that reasons about lifecycle_state uses an explicit allow-list,
--   never a negative check.
--
-- ── 2. Hard discard vs. retire-and-replace ────────────────────────────────
--   discard_trial_balance_upload/complete_trial_balance_discard: hard-delete
--   saga, permitted ONLY for lifecycle_state = 'active_unprocessed' with zero
--   tb_certifications rows and zero dependent records (statement_sign_offs,
--   safisha_reconciliations, efdms_z_reports -- the three NO ACTION FKs onto
--   trial_balance_uploads, per the same check discard_trial_balance_upload's
--   original foreign_key_violation handling already relied on).
--
--   retire_trial_balance_upload: the ONLY path for anything else. Preserves
--   the old upload row, its certifications and all derived evidence exactly
--   as they are; inserts a brand-new upload row for the replacement file;
--   links them; guarantees exactly one ACTIVE upload per (company_id,
--   period_year) at every instant via a partial unique index enforced by the
--   database itself, not by application discipline.
--
-- Never applied to any live database from this repository -- migrations are
-- committed here; `supabase db push` remains the owner's own action.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── Lifecycle columns on trial_balance_uploads ───────────────────────────────
ALTER TABLE public.trial_balance_uploads
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active_unprocessed',
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS retired_reason text,
  -- DEFERRABLE INITIALLY DEFERRED: retire_trial_balance_upload() sets this on the OLD row before
  -- the NEW row it points to exists (demoting the old row out of the active set first is what makes
  -- uq_one_active_upload_per_period never see both as active at once) — the FK is checked at COMMIT,
  -- by which point the new row exists too, not at the individual UPDATE statement.
  ADD COLUMN IF NOT EXISTS superseded_by_upload_id uuid REFERENCES public.trial_balance_uploads(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN IF NOT EXISTS replaces_upload_id uuid REFERENCES public.trial_balance_uploads(id);

DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_lifecycle_state CHECK (
      lifecycle_state IN (
        'active_unprocessed', 'active_processing', 'active_processed',
        'blocked', 'retired', 'superseded', 'discard_pending', 'discarded'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_no_self_supersede CHECK (superseded_by_upload_id IS NULL OR superseded_by_upload_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_no_self_replace CHECK (replaces_upload_id IS NULL OR replaces_upload_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill existing rows from their real, currently-observable state. Never a guess: a certification
-- row is the ONLY authority for 'blocked'/'active_processed'; its absence with processed_at set is
-- 'active_processing' (processed but not yet certified -- NULL-means-NOT-COMPUTED, not "processed_at
-- implies certified"); a genuinely untouched upload stays 'active_unprocessed'.
UPDATE public.trial_balance_uploads u
   SET lifecycle_state = CASE
     WHEN EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = u.id AND c.is_blocking) THEN 'blocked'
     WHEN EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = u.id AND NOT c.is_blocking) THEN 'active_processed'
     WHEN u.processed_at IS NOT NULL THEN 'active_processing'
     ELSE 'active_unprocessed'
   END
 WHERE lifecycle_state = 'active_unprocessed'; -- only touch rows still at the column default

-- At most one ACTIVE upload per engagement/period -- enforced by the database, not by application
-- discipline. "Active" is the four non-terminal states; retired/superseded/discard_pending/discarded
-- upload rows may coexist freely (they are history, not contenders for "the current upload").
DO $$ BEGIN
  CREATE UNIQUE INDEX uq_one_active_upload_per_period
    ON public.trial_balance_uploads (company_id, period_year)
    WHERE lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
      AND company_id IS NOT NULL AND period_year IS NOT NULL;
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Once superseded_by_upload_id is set it is permanent -- combined with "a terminal lifecycle_state
-- never transitions again" below, this makes a supersession CYCLE structurally impossible: the chain
-- can only ever grow forward from an active upload to a brand-new row, never back onto an existing
-- one, since an existing row that already has a successor can never acquire a different one, and a
-- row that is already SOMEONE's successor is itself still active (uploads only ever supersede
-- forward) until it is in turn superseded going forward.
CREATE OR REPLACE FUNCTION public.trial_balance_upload_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.superseded_by_upload_id IS NOT NULL AND NEW.superseded_by_upload_id IS DISTINCT FROM OLD.superseded_by_upload_id THEN
    RAISE EXCEPTION 'Iron Dome: superseded_by_upload_id is set once and never changed. [id=%]', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.lifecycle_state IN ('retired', 'superseded', 'discarded') AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    RAISE EXCEPTION 'Iron Dome: a retired/superseded/discarded upload cannot change lifecycle_state. [id=%, from=%]', OLD.id, OLD.lifecycle_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tbu_lifecycle_guard ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_lifecycle_guard
  BEFORE UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_lifecycle_guard();

REVOKE ALL ON FUNCTION public.trial_balance_upload_lifecycle_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── Append-only lifecycle audit trail ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_balance_upload_lifecycle_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Deliberately NOT a foreign key, same reasoning as trial_balance_discard_operations.upload_id:
  -- a 'discarded' event must remain a durable record after the row it describes is gone.
  upload_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  from_state text,
  to_state text NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  operation_id uuid
);

ALTER TABLE public.trial_balance_upload_lifecycle_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tbu_lifecycle_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: trial_balance_upload_lifecycle_events is append-only. % is not permitted. [id=%]', TG_OP, OLD.id
    USING ERRCODE = '23001';
END;
$$;

DROP TRIGGER IF EXISTS trg_tbu_lifecycle_events_append_only ON public.trial_balance_upload_lifecycle_events;
CREATE TRIGGER trg_tbu_lifecycle_events_append_only
  BEFORE UPDATE OR DELETE ON public.trial_balance_upload_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.tbu_lifecycle_events_append_only();

REVOKE ALL ON FUNCTION public.tbu_lifecycle_events_append_only() FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY "Accepted workspace members can read lifecycle events"
  ON public.trial_balance_upload_lifecycle_events
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id = auth.uid() AND fm.company_id = trial_balance_upload_lifecycle_events.company_id
         AND fm.accepted_at IS NOT NULL
    )
  );
-- No INSERT/UPDATE/DELETE policy for any client role: every row is written exclusively by the
-- SECURITY DEFINER functions below, which bypass RLS by design; the append-only trigger is what
-- actually protects this table's history against mutation, RLS never has to.

-- ── Discard saga tracking (server state, never read/written directly by clients) ────────────────
CREATE TABLE IF NOT EXISTS public.trial_balance_discard_operations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Deliberately NOT a foreign key: this row is the durable record that a discard happened, and it
  -- must survive the upload row's own deletion (row_snapshot already captures what that row looked
  -- like). UNIQUE still enforces "one in-flight operation per upload" for begin's idempotent resume.
  upload_id uuid NOT NULL UNIQUE,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
  file_path text,
  row_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE public.trial_balance_discard_operations ENABLE ROW LEVEL SECURITY;
-- No policies at all: zero client roles may touch this table directly, ever. Only the two
-- SECURITY DEFINER functions below (which bypass RLS) read or write it.
REVOKE ALL ON public.trial_balance_discard_operations FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- discard_outcome: extended, not replaced. Existing four values keep their exact prior meaning;
-- 'replacement_required' and 'stale_version' are new, distinct outcomes (never folded into a
-- generic retryable failure); 'discard_pending' is the saga's own internal "proceed" signal.
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'replacement_required'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'stale_version'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'discard_pending'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- discard_trial_balance_upload(uuid, bigint) -- REPLACES the 20260922180000 signature. Now the
-- "begin" half of a two-phase saga, and the sole eligibility authority: an upload with ANY
-- certification or dependent record is refused with 'replacement_required', never attempted.
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.discard_trial_balance_upload(uuid);

CREATE OR REPLACE FUNCTION public.discard_trial_balance_upload(p_upload_id uuid, p_expected_version bigint)
RETURNS TABLE (
  outcome       public.discard_outcome,
  operation_id  uuid,
  row_snapshot  jsonb,
  file_path     text,
  detail        text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_authorized boolean;
  v_dependency_table text;
  v_operation_id uuid;
BEGIN
  IF p_upload_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'No upload id supplied.'::text;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.trial_balance_uploads WHERE id = p_upload_id FOR UPDATE;

  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'This trial balance no longer exists.'::text;
    RETURN;
  END IF;

  SELECT
    (v_row.user_id IS NOT NULL AND v_row.user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id = auth.uid() AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'You are not authorised to discard this trial balance.'::text;
    RETURN;
  END IF;

  -- Idempotent resume: an operation already exists for this upload (a prior begin call that never
  -- reached finalize) -- return the SAME operation rather than starting a second one.
  IF v_row.lifecycle_state = 'discard_pending' THEN
    RETURN QUERY
      SELECT 'discard_pending'::public.discard_outcome, o.id, o.row_snapshot, o.file_path, 'Resuming a previously started discard.'::text
        FROM public.trial_balance_discard_operations o
       WHERE o.upload_id = p_upload_id AND o.state = 'pending';
    RETURN;
  END IF;

  IF v_row.lifecycle_state IN ('retired', 'superseded', 'discarded') THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'This trial balance is no longer active.'::text;
    RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_row.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'This trial balance changed since you last viewed it. Refresh and try again.'::text;
    RETURN;
  END IF;

  -- Anything beyond active_unprocessed carries processing/certification authority a hard delete
  -- cannot honestly remove (tb_certifications is append-only, by design, unconditionally).
  IF v_row.lifecycle_state <> 'active_unprocessed' THEN
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'This trial balance has validation history and cannot be deleted. Upload a replacement instead.'::text;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = p_upload_id) THEN
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'This trial balance has certification history and cannot be deleted. Upload a replacement instead.'::text;
    RETURN;
  END IF;

  SELECT tbl INTO v_dependency_table FROM (
    SELECT 'statement_sign_offs' AS tbl WHERE EXISTS (SELECT 1 FROM public.statement_sign_offs d WHERE d.upload_id = p_upload_id)
    UNION ALL
    SELECT 'safisha_reconciliations' WHERE EXISTS (SELECT 1 FROM public.safisha_reconciliations d WHERE d.tb_upload_id = p_upload_id)
    UNION ALL
    SELECT 'efdms_z_reports' WHERE EXISTS (SELECT 1 FROM public.efdms_z_reports d WHERE d.upload_id = p_upload_id)
  ) deps LIMIT 1;

  IF v_dependency_table IS NOT NULL THEN
    RETURN QUERY SELECT 'dependency_conflict'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'Other records in this workspace still depend on this trial balance.'::text;
    RETURN;
  END IF;

  UPDATE public.trial_balance_uploads
     SET lifecycle_state = 'discard_pending', version = version + 1
   WHERE id = p_upload_id;

  INSERT INTO public.trial_balance_discard_operations (upload_id, company_id, actor_user_id, file_path, row_snapshot)
  VALUES (p_upload_id, v_row.company_id, auth.uid(), v_row.file_path, to_jsonb(v_row))
  ON CONFLICT (upload_id) DO UPDATE SET state = 'pending'
  RETURNING id INTO v_operation_id;

  RETURN QUERY
    SELECT 'discard_pending'::public.discard_outcome, v_operation_id, o.row_snapshot, o.file_path, NULL::text
      FROM public.trial_balance_discard_operations o
     WHERE o.id = v_operation_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid, bigint) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid, bigint) FROM PUBLIC, anon;

-- ════════════════════════════════════════════════════════════════════════════
-- complete_trial_balance_discard -- the finalize half. Only ever deletes a row this same saga
-- already proved eligible (active_unprocessed, no certification, no dependents) at begin time; a
-- concurrent certification between begin and finalize is not possible (nothing else can write
-- tb_certifications for an upload once it is 'discard_pending', since no engine reads a
-- discard_pending upload as its current target). Requires explicit confirmation that Storage
-- removal already succeeded -- this function will not delete the database row otherwise, so
-- "success" is never reported while Storage cleanup is unknown.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.complete_trial_balance_discard(p_operation_id uuid, p_storage_removed boolean)
RETURNS TABLE (outcome public.discard_outcome, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_op public.trial_balance_discard_operations%ROWTYPE;
  v_authorized boolean;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_discard_operations WHERE id = p_operation_id FOR UPDATE;

  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, 'This discard has already completed or was never started.'::text;
    RETURN;
  END IF;

  SELECT
    (v_op.actor_user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id = auth.uid() AND fm.company_id = v_op.company_id AND fm.accepted_at IS NOT NULL
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, 'You are not authorised to complete this discard.'::text;
    RETURN;
  END IF;

  IF v_op.state = 'completed' THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::text; -- idempotent replay
    RETURN;
  END IF;

  IF NOT COALESCE(p_storage_removed, false) THEN
    RETURN QUERY SELECT 'discard_pending'::public.discard_outcome, 'Storage removal has not been confirmed yet. Retry once the file is removed.'::text;
    RETURN;
  END IF;

  -- Defense in depth: re-confirm no certification exists immediately before the delete, in case one
  -- somehow landed during the (narrow, expected-empty) window between begin and finalize. This never
  -- weakens the append-only guarantee -- it is a redundant check on TOP of it, never a substitute.
  IF EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = v_op.upload_id) THEN
    UPDATE public.trial_balance_uploads SET lifecycle_state = 'blocked' WHERE id = v_op.upload_id AND lifecycle_state = 'discard_pending';
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome, 'This trial balance acquired certification history during discard. Upload a replacement instead.'::text;
    RETURN;
  END IF;

  DELETE FROM public.trial_balance_uploads WHERE id = v_op.upload_id AND lifecycle_state = 'discard_pending';

  UPDATE public.trial_balance_discard_operations SET state = 'completed', completed_at = now() WHERE id = p_operation_id;

  INSERT INTO public.trial_balance_upload_lifecycle_events (upload_id, company_id, from_state, to_state, actor_user_id, reason, operation_id)
  VALUES (v_op.upload_id, v_op.company_id, 'discard_pending', 'discarded', auth.uid(), 'Hard discard completed', p_operation_id);

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_trial_balance_discard(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_trial_balance_discard(uuid, boolean) FROM PUBLIC, anon;

-- ════════════════════════════════════════════════════════════════════════════
-- retire_trial_balance_upload -- the ONLY path for a processed/certified/dependent upload. Never
-- deletes anything; preserves the old row and every one of its certifications/derived results
-- exactly as they are, and creates a brand-new upload row for the replacement file. The partial
-- unique index (uq_one_active_upload_per_period) guarantees atomically, within this one
-- transaction, that the moment the new row becomes active the old one is no longer counted as
-- active -- there is never a window with zero or two active uploads for this engagement/period.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.retire_trial_balance_upload(
  p_old_upload_id uuid,
  p_expected_version bigint,
  p_new_file_name text,
  p_new_file_path text,
  p_new_file_size integer,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  outcome            public.discard_outcome,
  new_upload_id      uuid,
  retired_upload_id  uuid,
  detail             text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_old public.trial_balance_uploads%ROWTYPE;
  v_new_id uuid;
  v_authorized boolean;
BEGIN
  IF p_old_upload_id IS NULL OR p_new_file_name IS NULL OR p_new_file_path IS NULL OR p_new_file_size IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::uuid, 'Missing required fields.'::text;
    RETURN;
  END IF;

  SELECT * INTO v_old FROM public.trial_balance_uploads WHERE id = p_old_upload_id FOR UPDATE;

  IF v_old.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::uuid, 'The upload being replaced no longer exists.'::text;
    RETURN;
  END IF;

  SELECT
    (v_old.user_id IS NOT NULL AND v_old.user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id = auth.uid() AND fm.company_id = v_old.company_id AND fm.accepted_at IS NOT NULL
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::uuid, 'You are not authorised to replace this trial balance.'::text;
    RETURN;
  END IF;

  -- Idempotent: this exact replacement already happened (a retried request after the response was
  -- lost) -- return the SAME new upload id, never create a second replacement.
  IF v_old.lifecycle_state = 'superseded' AND v_old.superseded_by_upload_id IS NOT NULL THEN
    RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, v_old.superseded_by_upload_id, v_old.id, 'Already replaced.'::text;
    RETURN;
  END IF;

  IF v_old.lifecycle_state IN ('retired', 'discard_pending', 'discarded') THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::uuid, 'This trial balance is no longer active.'::text;
    RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_old.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome, NULL::uuid, NULL::uuid, 'This trial balance changed since you last viewed it. Refresh and try again.'::text;
    RETURN;
  END IF;

  -- ID generated up front so the OLD row can be demoted out of the active set BEFORE the new row
  -- enters it — uq_one_active_upload_per_period is checked per-statement, so inserting the new
  -- active row before the old one is retired would collide with itself for the instant both are
  -- "active" in the same (company_id, period_year). Demoting first, then inserting, never creates
  -- that window.
  v_new_id := gen_random_uuid();

  UPDATE public.trial_balance_uploads
     SET lifecycle_state = 'superseded', retired_at = now(), retired_by = auth.uid(),
         retired_reason = p_reason, superseded_by_upload_id = v_new_id, version = version + 1
   WHERE id = v_old.id;

  INSERT INTO public.trial_balance_uploads (
    id, file_name, file_path, file_size, status, user_id, company_id, company_name, period_year,
    lifecycle_state, replaces_upload_id
  ) VALUES (
    v_new_id, p_new_file_name, p_new_file_path, p_new_file_size, 'pending', auth.uid(), v_old.company_id, v_old.company_name, v_old.period_year,
    'active_unprocessed', v_old.id
  );

  INSERT INTO public.trial_balance_upload_lifecycle_events (upload_id, company_id, from_state, to_state, actor_user_id, reason)
  VALUES (v_old.id, v_old.company_id, v_old.lifecycle_state, 'superseded', auth.uid(), p_reason);
  INSERT INTO public.trial_balance_upload_lifecycle_events (upload_id, company_id, from_state, to_state, actor_user_id, reason)
  VALUES (v_new_id, v_old.company_id, NULL, 'active_unprocessed', auth.uid(), 'Created as replacement for ' || v_old.id::text);

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, v_new_id, v_old.id, NULL::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text) FROM PUBLIC, anon;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP FUNCTION IF EXISTS public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text);
-- DROP FUNCTION IF EXISTS public.complete_trial_balance_discard(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.discard_trial_balance_upload(uuid, bigint);
-- (no rollback to the OLD single-arg discard_trial_balance_upload(uuid): its own rollback already
--  covered dropping it; recreating it would resurrect the confirmed defect this migration fixes)
-- DROP TABLE IF EXISTS public.trial_balance_discard_operations;
-- DROP TRIGGER IF EXISTS trg_tbu_lifecycle_events_append_only ON public.trial_balance_upload_lifecycle_events;
-- DROP FUNCTION IF EXISTS public.tbu_lifecycle_events_append_only();
-- DROP TABLE IF EXISTS public.trial_balance_upload_lifecycle_events;
-- DROP TRIGGER IF EXISTS trg_tbu_lifecycle_guard ON public.trial_balance_uploads;
-- DROP FUNCTION IF EXISTS public.trial_balance_upload_lifecycle_guard();
-- DROP INDEX IF EXISTS public.uq_one_active_upload_per_period;
