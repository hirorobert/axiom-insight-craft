-- ════════════════════════════════════════════════════════════════════════════
-- Trial balance upload lifecycle: retire-and-replace, database-authoritative transitions,
-- replacement cancellation and truthful restore.
--
-- ROOT CAUSE: trial_balance_uploads -> tb_certifications is ON DELETE CASCADE (fk_tbc_upload), but
-- tb_certifications is unconditionally append-only (trg_tbc_immutable), including against a cascaded
-- delete. Any upload that has ever been certified can therefore NEVER be hard-deleted. Staging
-- acceptance of PR #32 confirmed this on 2026-09-23: a certified fixture's discard failed with P0001
-- "tb_certifications is append-only". The same cascade would also silently destroy other derived
-- evidence (hesabu_validations, tax_computations, account_review_decisions, ...; every FK onto this
-- table is enumerated at call time below). So a hard delete is only honest for an upload that has
-- produced nothing at all.
--
-- Neither invariant is weakened: tb_certifications stays append-only and the CASCADE FK is untouched.
-- A processed/certified/derived upload is RETIRED (superseded by a replacement) instead of deleted, and
-- its evidence is preserved.
--
-- ── Lifecycle vocabulary (CHECK-enforced) ─────────────────────────────────────────────────────
--   active_unprocessed  uploaded; processing has not started; no evidence exists.
--   active_processing   processing has started (status left 'pending'/'processing', or processed_at /
--                       source_file_hash / processing_result was written); no certification yet.
--   active_processed    latest certification is non-blocking. A review requirement is NOT copied
--                       here: it stays on that certification's own requires_review column, which is
--                       the single authority for it.
--   blocked             latest certification is blocking.
--   retired             no longer current, with no known successor. Written by the legacy backfill.
--                       Terminal.
--   superseded          retired because a specific replacement exists (superseded_by_upload_id).
--                       Terminal, except through cancel_trial_balance_replacement().
--   discard_pending     a hard-discard saga has begun; Storage removal is not yet confirmed.
--   discarded           vocabulary only: the row is physically deleted at this point, and the durable
--                       record is the lifecycle event plus the operation row.
--
-- ── Who may change lifecycle columns ──────────────────────────────────────────────────────────
-- Only sanctioned server code: this migration's backfill, the certification trigger, the guard's own
-- processing-start derivation, and the SECURITY DEFINER RPCs below. Each sets the transaction-local
-- marker axiom.tbu_lifecycle_op. The guard ignores that marker whenever the executing role is a client
-- role (anon/authenticated), so a client cannot forge it. A client INSERT must start at the defaults,
-- and a client UPDATE of any lifecycle column is refused (42501).
--
-- ── Who may perform destructive source operations ─────────────────────────────────────────────
-- tbu_source_manager_membership(company) is the single capability check: an ACCEPTED firm_members row
-- with role owner, partner or manager. That is the same management set used by open_engagement_with_scope
-- and set_company_filing_jurisdiction. preparer, viewer, cross-tenant and anonymous callers are refused.
--
-- ── Actor identity (CLAUDE.md §4.3) ───────────────────────────────────────────────────────────
-- Every lifecycle event and operation records BOTH actor_user_id (auth.uid()) and
-- actor_membership_id (firm_members.id), resolved server-side and never accepted from the client.
-- trial_balance_uploads.user_id on a replacement row keeps that column's existing meaning (the uploading
-- auth user, as TrialBalanceUpload.tsx sets it); the membership identity sits beside it in
-- retired_by_membership_id and in the events.
--
-- Storage and Postgres are two systems; nothing here claims atomicity across them. See each RPC.
--
-- This migration is never applied to production from this repository: `supabase db push` is the owner's action.
-- Pre-flight report for an existing database: scripts/db-preflight/uploadLifecyclePreflight.sql.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── 1. Columns ─────────────────────────────────────────────────────────────────────────────────
-- Actor columns are plain uuids, not FKs: an audit record must never block, or be mutated by, a later
-- auth-user or membership deletion.
ALTER TABLE public.trial_balance_uploads
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active_unprocessed',
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid,
  ADD COLUMN IF NOT EXISTS retired_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS retired_reason text,
  -- DEFERRABLE INITIALLY DEFERRED: retire demotes the OLD row (already pointing at the new id) BEFORE the
  -- new row is inserted, so uq_one_active_upload_per_period (checked per statement) never sees two
  -- actives. The FK is checked at COMMIT, by which point the new row exists. cancel_trial_balance_replacement()
  -- likewise deletes the replacement and clears this link inside one transaction.
  ADD COLUMN IF NOT EXISTS superseded_by_upload_id uuid REFERENCES public.trial_balance_uploads(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN IF NOT EXISTS replaces_upload_id uuid REFERENCES public.trial_balance_uploads(id);

DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_lifecycle_state CHECK (
      lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked',
                          'retired', 'superseded', 'discard_pending', 'discarded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_no_self_supersede CHECK (superseded_by_upload_id IS NULL OR superseded_by_upload_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_no_self_replace CHECK (replaces_upload_id IS NULL OR replaces_upload_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.trial_balance_uploads
    ADD CONSTRAINT chk_tbu_superseded_has_successor CHECK (lifecycle_state <> 'superseded' OR superseded_by_upload_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_tbu_superseded_by ON public.trial_balance_uploads (superseded_by_upload_id) WHERE superseded_by_upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tbu_replaces ON public.trial_balance_uploads (replaces_upload_id) WHERE replaces_upload_id IS NOT NULL;

-- ── 2. Append-only lifecycle audit trail ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_balance_upload_lifecycle_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Not FKs, for the same reason as the actor columns: an event about a deleted upload must outlive it.
  upload_id uuid NOT NULL,
  company_id uuid NOT NULL,
  engagement_id uuid,
  period_year integer,
  from_state text,
  to_state text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'engine', 'migration')),
  actor_user_id uuid,
  actor_membership_id uuid,
  operation_id uuid,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tbule_upload ON public.trial_balance_upload_lifecycle_events (upload_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tbule_company ON public.trial_balance_upload_lifecycle_events (company_id, occurred_at);

ALTER TABLE public.trial_balance_upload_lifecycle_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tbu_lifecycle_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: trial_balance_upload_lifecycle_events is append-only. % is not permitted. [id=%]', TG_OP, OLD.id
    USING ERRCODE = '23001';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_lifecycle_events_append_only ON public.trial_balance_upload_lifecycle_events;
CREATE TRIGGER trg_tbu_lifecycle_events_append_only
  BEFORE UPDATE OR DELETE ON public.trial_balance_upload_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.tbu_lifecycle_events_append_only();

DROP POLICY IF EXISTS "Accepted workspace members can read lifecycle events" ON public.trial_balance_upload_lifecycle_events;
CREATE POLICY "Accepted workspace members can read lifecycle events"
  ON public.trial_balance_upload_lifecycle_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.firm_members fm
                  WHERE fm.user_id = auth.uid() AND fm.company_id = trial_balance_upload_lifecycle_events.company_id
                    AND fm.accepted_at IS NOT NULL));
-- No client write policy exists; only the SECURITY DEFINER code below inserts.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.trial_balance_upload_lifecycle_events FROM PUBLIC, anon, authenticated;

-- ── 3. Operation records (server saga state; never touched by clients) ────────────────────────
CREATE TABLE IF NOT EXISTS public.trial_balance_upload_operations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('discard', 'cancel_replacement')),
  -- discard:            pending -> completed -> restored  (or pending -> aborted)
  -- cancel_replacement: storage_cleanup_pending -> completed
  state text NOT NULL CHECK (state IN ('pending', 'completed', 'restored', 'aborted', 'storage_cleanup_pending')),
  upload_id uuid NOT NULL,          -- not an FK: must outlive the row it describes
  related_upload_id uuid,           -- cancel_replacement: the predecessor that was restored
  company_id uuid NOT NULL,
  period_year integer,
  actor_user_id uuid NOT NULL,
  actor_membership_id uuid NOT NULL,
  file_path text,
  row_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  restored_at timestamptz,
  restored_by uuid,
  restored_by_membership_id uuid
);
-- At most one in-flight discard per upload: begin's idempotent resume depends on it. Completed and
-- restored discards do not block a later, separate discard of a restored row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tbuo_one_pending_discard
  ON public.trial_balance_upload_operations (upload_id) WHERE kind = 'discard' AND state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tbuo_upload ON public.trial_balance_upload_operations (upload_id);

ALTER TABLE public.trial_balance_upload_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_balance_upload_operations FROM PUBLIC, anon, authenticated;

-- ── 4. Internal helpers (no client role may execute them) ──────────────────────────────────────
-- The one capability check for destructive source-lifecycle operations. Returns the caller's
-- firm_members.id, or NULL when the caller is not permitted, including when auth.uid() IS NULL.
CREATE OR REPLACE FUNCTION public.tbu_source_manager_membership(p_company_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT fm.id
    FROM public.firm_members fm
   WHERE auth.uid() IS NOT NULL
     AND p_company_id IS NOT NULL
     AND fm.user_id = auth.uid()
     AND fm.company_id = p_company_id
     AND fm.accepted_at IS NOT NULL
     AND fm.role IN ('owner', 'partner', 'manager')
   ORDER BY CASE fm.role WHEN 'owner' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, fm.id
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.tbu_record_lifecycle_event(
  p_upload public.trial_balance_uploads, p_from text, p_to text, p_actor_kind text,
  p_actor_user uuid, p_actor_membership uuid, p_operation_id uuid, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.trial_balance_upload_lifecycle_events
    (upload_id, company_id, engagement_id, period_year, from_state, to_state, actor_kind,
     actor_user_id, actor_membership_id, operation_id, reason)
  VALUES (p_upload.id, p_upload.company_id, p_upload.engagement_id, p_upload.period_year, p_from, p_to, p_actor_kind,
          p_actor_user, p_actor_membership, p_operation_id, p_reason);
$$;

-- Lifecycle state implied by the authoritative facts of one upload: its latest certification (by
-- sequence_no), otherwise any processing trace. Used by the backfill, by the discard-abort path, and when
-- cancel_trial_balance_replacement() restores a predecessor.
CREATE OR REPLACE FUNCTION public.tbu_derived_active_state(p_upload public.trial_balance_uploads)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN c.is_blocking THEN 'blocked' ELSE 'active_processed' END
       FROM public.tb_certifications c WHERE c.upload_id = p_upload.id
      ORDER BY c.sequence_no DESC LIMIT 1),
    CASE WHEN p_upload.processed_at IS NOT NULL
           OR p_upload.source_file_hash IS NOT NULL
           OR p_upload.processing_result IS NOT NULL
           OR p_upload.status NOT IN ('pending', 'processing')
         THEN 'active_processing' ELSE 'active_unprocessed' END);
$$;

-- Returns the first place where evidence of processing or derivation exists for an upload, or NULL
-- when there is none. Every FK onto trial_balance_uploads is enumerated from pg_constraint AT CALL TIME,
-- so a future derived table is covered without editing this function. fiscal_periods.active_upload_id is
-- excluded because it is a nullable pointer (ON DELETE SET NULL), not derived evidence.
-- Replacement lineage counts as evidence ('replacement_lineage'), except the single expected link
-- between p_upload_id and p_expected_predecessor, which cancel_trial_balance_replacement() is undoing.
CREATE OR REPLACE FUNCTION public.tbu_upload_evidence(p_upload_id uuid, p_expected_predecessor uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  r record;
  v_found boolean;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN RETURN NULL; END IF;
  IF v_row.processed_at IS NOT NULL OR v_row.source_file_hash IS NOT NULL OR v_row.processing_result IS NOT NULL
     OR v_row.status NOT IN ('pending', 'processing') THEN
    RETURN 'processing_trace';
  END IF;
  IF (v_row.replaces_upload_id IS NOT NULL AND v_row.replaces_upload_id IS DISTINCT FROM p_expected_predecessor)
     OR EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                 WHERE (t.superseded_by_upload_id = p_upload_id OR t.replaces_upload_id = p_upload_id)
                   AND t.id IS DISTINCT FROM p_expected_predecessor) THEN
    RETURN 'replacement_lineage';
  END IF;
  FOR r IN
    SELECT n.nspname AS sch, cl.relname AS tbl, a.attname AS col
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.trial_balance_uploads'::regclass
       AND c.conrelid <> 'public.trial_balance_uploads'::regclass
       AND NOT (c.conrelid = 'public.fiscal_periods'::regclass AND a.attname = 'active_upload_id')
     ORDER BY 1, 2, 3
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', r.sch, r.tbl, r.col) INTO v_found USING p_upload_id;
    IF v_found THEN RETURN r.sch || '.' || r.tbl; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ── 5. Guard: lifecycle columns are server-authoritative ──────────────────────────────────────
-- SECURITY INVOKER on purpose: current_user is the real calling role here (inside the RPCs it is the
-- definer, which is exactly what makes those paths sanctioned).
CREATE OR REPLACE FUNCTION public.trial_balance_upload_lifecycle_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_op text := COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '');
  v_sanctioned boolean := v_op <> '' AND current_user NOT IN ('anon', 'authenticated');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_sanctioned AND (
         NEW.lifecycle_state <> 'active_unprocessed' OR NEW.version <> 1
         OR NEW.retired_at IS NOT NULL OR NEW.retired_by IS NOT NULL OR NEW.retired_by_membership_id IS NOT NULL
         OR NEW.retired_reason IS NOT NULL OR NEW.superseded_by_upload_id IS NOT NULL OR NEW.replaces_upload_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Iron Dome: upload lifecycle columns are server-authoritative; a new upload starts active_unprocessed.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_sanctioned THEN
    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.retired_by IS DISTINCT FROM OLD.retired_by
       OR NEW.retired_by_membership_id IS DISTINCT FROM OLD.retired_by_membership_id
       OR NEW.retired_reason IS DISTINCT FROM OLD.retired_reason
       OR NEW.superseded_by_upload_id IS DISTINCT FROM OLD.superseded_by_upload_id
       OR NEW.replaces_upload_id IS DISTINCT FROM OLD.replaces_upload_id THEN
      RAISE EXCEPTION 'Iron Dome: upload lifecycle columns are server-authoritative and cannot be changed by role %. [id=%]', current_user, OLD.id
        USING ERRCODE = '42501';
    END IF;
    -- B2: processing start is derived from the processing facts themselves, never from an Edge Function
    -- remembering to set lifecycle_state. process-trial-balance writes status='validating' first.
    IF OLD.lifecycle_state = 'active_unprocessed' AND (
         (NEW.status IS DISTINCT FROM OLD.status AND NEW.status NOT IN ('pending', 'processing'))
         OR (NEW.processed_at IS NOT NULL AND OLD.processed_at IS NULL)
         OR (NEW.source_file_hash IS NOT NULL AND OLD.source_file_hash IS NULL)
         OR (NEW.processing_result IS NOT NULL AND OLD.processing_result IS NULL)) THEN
      NEW.lifecycle_state := 'active_processing';
      NEW.version := OLD.version + 1;
    END IF;
    RETURN NEW;
  END IF;

  -- Sanctioned server paths remain bound by the structural invariants.
  IF OLD.superseded_by_upload_id IS NOT NULL AND NEW.superseded_by_upload_id IS DISTINCT FROM OLD.superseded_by_upload_id
     AND NOT (v_op = 'cancel_replacement' AND NEW.superseded_by_upload_id IS NULL) THEN
    RAISE EXCEPTION 'Iron Dome: superseded_by_upload_id is set once and only cleared by cancel_trial_balance_replacement. [id=%]', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.lifecycle_state IN ('retired', 'superseded', 'discarded') AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND NOT (v_op = 'cancel_replacement' AND OLD.lifecycle_state = 'superseded'
              AND NEW.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
    RAISE EXCEPTION 'Iron Dome: a retired/superseded/discarded upload cannot change lifecycle_state. [id=%, from=%]', OLD.id, OLD.lifecycle_state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.replaces_upload_id IS DISTINCT FROM OLD.replaces_upload_id THEN
    RAISE EXCEPTION 'Iron Dome: replaces_upload_id is fixed at insert. [id=%]', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tbu_lifecycle_guard ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_lifecycle_guard
  BEFORE INSERT OR UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_lifecycle_guard();

-- Audit trail for the guard's own derived transition (processing start). Sanctioned RPCs and the
-- certification trigger write their own, richer events, so this fires only when no op is set.
CREATE OR REPLACE FUNCTION public.trial_balance_upload_lifecycle_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') = '' THEN
    PERFORM public.tbu_record_lifecycle_event(
      NEW, OLD.lifecycle_state, NEW.lifecycle_state,
      CASE WHEN auth.uid() IS NULL THEN 'engine' ELSE 'user' END,
      auth.uid(),
      (SELECT fm.id FROM public.firm_members fm
        WHERE auth.uid() IS NOT NULL AND fm.user_id = auth.uid() AND fm.company_id = NEW.company_id AND fm.accepted_at IS NOT NULL
        ORDER BY fm.id LIMIT 1),
      NULL, 'Processing started (status ' || COALESCE(NEW.status, 'NULL') || ')');
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_tbu_lifecycle_audit ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_lifecycle_audit
  AFTER UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_lifecycle_audit();

-- ── 6. B2: certification drives lifecycle (database-authoritative) ────────────────────────────
-- Every certification enters through commit_tb_certification(). This AFTER INSERT trigger makes the
-- upload's lifecycle follow it, whichever caller committed it. A certification for an upload that is no
-- longer active (superseded, retired or discard_pending) changes nothing: complete_trial_balance_discard
-- re-checks evidence itself, and terminal states never move.
CREATE OR REPLACE FUNCTION public.tb_certification_drives_upload_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_target text := CASE WHEN NEW.is_blocking THEN 'blocked' ELSE 'active_processed' END;
  v_member uuid;
  v_member_user uuid;
BEGIN
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = NEW.upload_id FOR UPDATE;
  IF v_row.id IS NULL
     OR v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     OR v_row.lifecycle_state = v_target THEN
    RETURN NULL;
  END IF;

  SELECT er.firm_member_id INTO v_member FROM public.engine_runs er WHERE er.id = NEW.engine_run_id;
  SELECT fm.user_id INTO v_member_user FROM public.firm_members fm WHERE fm.id = v_member;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'certification', true);
  UPDATE public.trial_balance_uploads t SET lifecycle_state = v_target, version = t.version + 1 WHERE t.id = v_row.id;
  PERFORM public.tbu_record_lifecycle_event(
    v_row, v_row.lifecycle_state, v_target, 'engine', v_member_user, v_member, NULL,
    'Certification ' || NEW.id::text || ' (is_blocking=' || NEW.is_blocking::text || ', requires_review=' || NEW.requires_review::text || ')');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_tbc_drives_upload_lifecycle ON public.tb_certifications;
CREATE TRIGGER trg_tbc_drives_upload_lifecycle
  AFTER INSERT ON public.tb_certifications
  FOR EACH ROW EXECUTE FUNCTION public.tb_certification_drives_upload_lifecycle();

-- ── 7. B1: backfill existing uploads, then enforce one active upload per period ─────────────────
-- Pre-lifecycle authority rule (traced, not invented): get_authoritative_certification() treats the
-- CURRENT upload for (company_id, period_year) as the one with the latest uploaded_at, ties broken by
-- id DESC. uploaded_at is server-assigned (NOT NULL DEFAULT now()) and id is immutable. The client's
-- resolveActiveUpload() applies the same recency order. Exactly that upload stays active. Every other
-- upload of the same period is RETIRED with an explicit migration reason and NO supersession link,
-- because which upload replaced which was never recorded. Nothing is deleted: every upload,
-- certification and derived record stays where it is. Uploads with a NULL company_id or period_year
-- have no period to be current for, so they keep their processing state and stay outside the unique
-- index, as before.
DO $$
DECLARE
  v_ties integer;
  v_dupes integer;
BEGIN
  PERFORM set_config('axiom.tbu_lifecycle_op', 'migration_backfill', true);

  -- (a) Processing state of every existing upload, derived from its authoritative facts.
  UPDATE public.trial_balance_uploads u
     SET lifecycle_state = public.tbu_derived_active_state(u)
   WHERE u.lifecycle_state = 'active_unprocessed';

  -- (b) Report exact uploaded_at ties at the top of a period. The authority rule resolves them by id,
  --     so they are deterministic rather than ambiguous; they are reported so an operator can see them.
  SELECT count(*) INTO v_ties FROM (
    SELECT s.company_id, s.period_year FROM (
      SELECT company_id, period_year, uploaded_at,
             max(uploaded_at) OVER (PARTITION BY company_id, period_year) AS top_at
        FROM public.trial_balance_uploads
       WHERE company_id IS NOT NULL AND period_year IS NOT NULL) s
     WHERE s.uploaded_at = s.top_at
     GROUP BY s.company_id, s.period_year HAVING count(*) > 1) t;
  IF v_ties > 0 THEN
    RAISE NOTICE 'upload lifecycle backfill: % period(s) have an exact uploaded_at tie at the top; resolved by id DESC exactly as get_authoritative_certification() already did.', v_ties;
  END IF;

  -- (c) Retire every non-current upload of a period.
  WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY company_id, period_year ORDER BY uploaded_at DESC, id DESC) AS rn
      FROM public.trial_balance_uploads
     WHERE company_id IS NOT NULL AND period_year IS NOT NULL
  )
  UPDATE public.trial_balance_uploads u
     SET lifecycle_state = 'retired',
         retired_at = now(),
         retired_reason = 'Lifecycle migration 20260923100000: not the current upload for this company and period under the pre-lifecycle authority rule (latest uploaded_at, then id). Retired with no inferred successor; all evidence preserved.',
         version = u.version + 1
    FROM ranked
   WHERE ranked.id = u.id AND ranked.rn > 1;

  -- (d) One migration event per upload, so every row's starting state is on the audit trail.
  INSERT INTO public.trial_balance_upload_lifecycle_events
    (upload_id, company_id, engagement_id, period_year, from_state, to_state, actor_kind, reason)
  SELECT u.id, u.company_id, u.engagement_id, u.period_year, NULL, u.lifecycle_state, 'migration',
         'Lifecycle migration 20260923100000 backfill'
    FROM public.trial_balance_uploads u
   WHERE u.company_id IS NOT NULL;

  -- (e) Fail closed: the invariant must already hold before the index is created.
  SELECT count(*) INTO v_dupes FROM (
    SELECT 1 FROM public.trial_balance_uploads
     WHERE lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
       AND company_id IS NOT NULL AND period_year IS NOT NULL
     GROUP BY company_id, period_year HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'upload lifecycle backfill: % company/period(s) still have more than one active upload; aborting before the unique index. Run scripts/db-preflight/uploadLifecyclePreflight.sql.', v_dupes
      USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_upload_per_period
  ON public.trial_balance_uploads (company_id, period_year)
  WHERE lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
    AND company_id IS NOT NULL AND period_year IS NOT NULL;

-- ── 8. The current source for certification authority is the ACTIVE upload ────────────────────
-- Body identical to the latest definition (20260902150000, including its fail-closed rule for an unknown
-- source_file_hash): same signature, ordering, search_path and grants. The only change is that
-- a non-active row (retired, superseded or discard_pending) can no longer be "the latest upload".
-- Without it, a restored or reactivated upload could be shadowed by a newer non-active row.
CREATE OR REPLACE FUNCTION public.get_authoritative_certification(
  p_company_id UUID,
  p_period_year INTEGER
) RETURNS SETOF public.tb_certifications
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  WITH latest_upload AS (
    SELECT id, source_file_hash AS current_source_file_hash
      FROM public.trial_balance_uploads
     WHERE company_id = p_company_id
       AND (p_period_year IS NULL OR period_year = p_period_year)
       AND lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     ORDER BY uploaded_at DESC, id DESC
     LIMIT 1
  ),
  latest_certification AS (
    SELECT c.*
      FROM public.tb_certifications c, latest_upload lu
     WHERE c.upload_id = lu.id
     ORDER BY c.sequence_no DESC
     LIMIT 1
  )
  SELECT lc.*
    FROM latest_certification lc, latest_upload lu
   WHERE lc.is_blocking = false
     AND lc.requires_review = false
     AND lu.current_source_file_hash IS NOT NULL
     AND lu.current_source_file_hash = lc.source_file_hash;
$$;
REVOKE ALL ON FUNCTION public.get_authoritative_certification(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_authoritative_certification(UUID, INTEGER) TO authenticated, service_role;

-- ── 9. Deletion only through the discard saga ────────────────────────────────────────────────
-- A direct client DELETE bypassed authorization, the evidence check and the audit trail. No client code
-- issues one (grepped src/ and supabase/functions/), so the saga below is now the only path.
DROP POLICY IF EXISTS "Accepted workspace members can delete company uploads" ON public.trial_balance_uploads;
DROP POLICY IF EXISTS "Users can delete their own uploads" ON public.trial_balance_uploads;

-- ════════════════════════════════════════════════════════════════════════════
-- RPCs. Every one is SECURITY DEFINER, because each must see and change rows the caller's RLS hides and
-- each IS the authorization boundary. search_path is pinned with pg_catalog first, every table reference
-- is schema-qualified, and EXECUTE is granted to authenticated only.
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'replacement_required'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'stale_version'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'discard_pending'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'replacement_cancel_required'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE public.discard_outcome ADD VALUE IF NOT EXISTS 'replaced'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP FUNCTION IF EXISTS public.discard_trial_balance_upload(uuid);

-- ── discard (phase 1 of 2) ───────────────────────────────────────────────────────────────────
-- Eligibility is decided HERE from authoritative tables, never from lifecycle_state alone: any
-- processing trace, certification, derived record or replacement lineage refuses the hard delete.
CREATE OR REPLACE FUNCTION public.discard_trial_balance_upload(p_upload_id uuid, p_expected_version bigint)
RETURNS TABLE (outcome public.discard_outcome, operation_id uuid, row_snapshot jsonb, file_path text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_evidence text;
  v_op uuid;
BEGIN
  IF p_upload_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'No upload id supplied.'::text; RETURN;
  END IF;

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'This trial balance no longer exists.'::text; RETURN;
  END IF;

  v_member := public.tbu_source_manager_membership(v_row.company_id);
  IF v_member IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'Only an owner or partner of this company can remove a trial balance.'::text; RETURN;
  END IF;

  IF v_row.lifecycle_state = 'discard_pending' THEN
    RETURN QUERY SELECT 'discard_pending'::public.discard_outcome, o.id, o.row_snapshot, o.file_path, 'Resuming a previously started discard.'::text
      FROM public.trial_balance_upload_operations o
     WHERE o.upload_id = p_upload_id AND o.kind = 'discard' AND o.state = 'pending';
    RETURN;
  END IF;

  IF v_row.lifecycle_state IN ('retired', 'superseded', 'discarded') THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text, 'This trial balance is no longer active.'::text; RETURN;
  END IF;

  -- Evidence outranks the version check: whatever the caller last saw, an upload with history can never
  -- be hard-deleted, and processing start itself bumps version, so a stale caller must still learn this.
  v_evidence := public.tbu_upload_evidence(p_upload_id, v_row.replaces_upload_id);
  IF v_row.lifecycle_state <> 'active_unprocessed' OR v_evidence IS NOT NULL THEN
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'This trial balance has processing or validation history and cannot be deleted. Upload a replacement instead.'::text; RETURN;
  END IF;

  -- An unprocessed replacement is not an ordinary upload: removing it must restore its predecessor.
  IF v_row.replaces_upload_id IS NOT NULL THEN
    RETURN QUERY SELECT 'replacement_cancel_required'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'This trial balance replaced an earlier one. Cancel the replacement to restore the earlier trial balance.'::text; RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_row.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome, NULL::uuid, NULL::jsonb, NULL::text,
      'This trial balance changed since you last viewed it. Refresh and try again.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard', true);
  UPDATE public.trial_balance_uploads t SET lifecycle_state = 'discard_pending', version = t.version + 1 WHERE t.id = p_upload_id;
  INSERT INTO public.trial_balance_upload_operations
    (kind, state, upload_id, company_id, period_year, actor_user_id, actor_membership_id, file_path, row_snapshot)
  VALUES ('discard', 'pending', p_upload_id, v_row.company_id, v_row.period_year, auth.uid(), v_member, v_row.file_path, to_jsonb(v_row))
  RETURNING id INTO v_op;
  PERFORM public.tbu_record_lifecycle_event(v_row, v_row.lifecycle_state, 'discard_pending', 'user', auth.uid(), v_member, v_op, 'Hard discard started');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'discard_pending'::public.discard_outcome, v_op, to_jsonb(v_row), v_row.file_path, NULL::text;
END;
$$;

-- ── discard (phase 2 of 2) ───────────────────────────────────────────────────────────────────
-- Deletes the row only after the caller reports that Storage removal succeeded. That report is the
-- client's own claim; the database cannot see Storage, so this guarantees ordering, not atomicity.
CREATE OR REPLACE FUNCTION public.complete_trial_balance_discard(p_operation_id uuid, p_storage_removed boolean)
RETURNS TABLE (outcome public.discard_outcome, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_restore text;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'discard' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, 'This discard has already completed or was never started.'::text; RETURN;
  END IF;

  v_member := public.tbu_source_manager_membership(v_op.company_id);
  IF v_member IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, 'Only an owner or partner of this company can remove a trial balance.'::text; RETURN;
  END IF;

  IF v_op.state <> 'pending' THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::text; RETURN;
  END IF;

  IF NOT COALESCE(p_storage_removed, false) THEN
    RETURN QUERY SELECT 'discard_pending'::public.discard_outcome, 'Storage removal has not been confirmed yet. Retry once the file is removed.'::text; RETURN;
  END IF;

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = v_op.upload_id FOR UPDATE;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'discard', true);
  IF v_row.id IS NOT NULL AND public.tbu_upload_evidence(v_row.id) IS NOT NULL THEN
    -- Evidence appeared during the saga: the B2 trigger deliberately leaves a discard_pending row alone.
    -- Abort the discard and put the upload back in the state that evidence implies.
    v_restore := public.tbu_derived_active_state(v_row);
    BEGIN
      UPDATE public.trial_balance_uploads t SET lifecycle_state = v_restore, version = t.version + 1 WHERE t.id = v_row.id;
      UPDATE public.trial_balance_upload_operations o SET state = 'aborted', completed_at = now() WHERE o.id = v_op.id;
      PERFORM public.tbu_record_lifecycle_event(v_row, 'discard_pending', v_restore, 'user', auth.uid(), v_member, v_op.id, 'Discard aborted: evidence appeared during the saga');
    EXCEPTION WHEN unique_violation THEN
      NULL; -- another upload took the period's active slot meanwhile; the row stays discard_pending, outside the active set
    END;
    PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
    RETURN QUERY SELECT 'replacement_required'::public.discard_outcome,
      'This trial balance acquired processing history during the discard. Upload a replacement instead.'::text; RETURN;
  END IF;

  IF v_row.id IS NOT NULL THEN
    DELETE FROM public.trial_balance_uploads t WHERE t.id = v_row.id AND t.lifecycle_state = 'discard_pending';
    PERFORM public.tbu_record_lifecycle_event(v_row, 'discard_pending', 'discarded', 'user', auth.uid(), v_member, v_op.id, 'Hard discard completed');
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'deleted_now'::public.discard_outcome, NULL::text;
END;
$$;

-- ── B4: restore (Undo) ───────────────────────────────────────────────────────────────────────
-- Outcomes: restored | already_restored | conflict_new_active_upload | expired | forbidden |
--           stale_operation | storage_restore_required | terminal_failure.
-- already_restored is returned ONLY after proving that the exact original row exists: id, company,
-- file_path and uploaded_at must match the operation's own snapshot. A unique_violation is never read as success.
CREATE OR REPLACE FUNCTION public.restore_trial_balance_upload(p_operation_id uuid, p_storage_restored boolean)
RETURNS TABLE (outcome text, upload_id uuid, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_member uuid;
  v_snap jsonb;
  v_existing public.trial_balance_uploads%ROWTYPE;
  v_new public.trial_balance_uploads%ROWTYPE;
  v_constraint text;
  c_window constant interval := interval '10 minutes';
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id FOR UPDATE;
  IF v_op.id IS NULL OR v_op.kind <> 'discard' THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::uuid, 'This undo no longer refers to a discard.'::text; RETURN;
  END IF;

  v_member := public.tbu_source_manager_membership(v_op.company_id);
  IF v_member IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, 'Only an owner or partner of this company can restore a trial balance.'::text; RETURN;
  END IF;

  v_snap := v_op.row_snapshot;
  SELECT * INTO v_existing FROM public.trial_balance_uploads t WHERE t.id = v_op.upload_id;

  IF v_op.state = 'restored' OR (v_op.state = 'completed' AND v_existing.id IS NOT NULL) THEN
    IF v_existing.id IS NOT NULL
       AND v_existing.company_id IS NOT DISTINCT FROM (v_snap->>'company_id')::uuid
       AND v_existing.file_path IS NOT DISTINCT FROM (v_snap->>'file_path')
       AND v_existing.uploaded_at IS NOT DISTINCT FROM (v_snap->>'uploaded_at')::timestamptz THEN
      IF v_op.state <> 'restored' THEN
        UPDATE public.trial_balance_upload_operations o
           SET state = 'restored', restored_at = now(), restored_by = auth.uid(), restored_by_membership_id = v_member
         WHERE o.id = v_op.id;
      END IF;
      RETURN QUERY SELECT 'already_restored'::text, v_existing.id, NULL::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The restored record no longer matches the discarded trial balance.'::text; RETURN;
  END IF;

  IF v_op.state <> 'completed' THEN
    RETURN QUERY SELECT 'stale_operation'::text, NULL::uuid, 'The discard has not finished, so there is nothing to undo yet.'::text; RETURN;
  END IF;

  IF v_op.completed_at < now() - c_window THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, 'The undo window for this discard has closed.'::text; RETURN;
  END IF;

  IF v_op.period_year IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.trial_balance_uploads t
        WHERE t.company_id = v_op.company_id AND t.period_year = v_op.period_year
          AND t.lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')) THEN
    RETURN QUERY SELECT 'conflict_new_active_upload'::text, NULL::uuid,
      'Undo cannot proceed because a new trial balance is now active for this period.'::text; RETURN;
  END IF;

  IF NOT COALESCE(p_storage_restored, false) THEN
    RETURN QUERY SELECT 'storage_restore_required'::text, NULL::uuid, 'The original file must be put back before the trial balance can be restored.'::text; RETURN;
  END IF;

  PERFORM set_config('axiom.tbu_lifecycle_op', 'restore', true);
  BEGIN
    INSERT INTO public.trial_balance_uploads
    SELECT * FROM jsonb_populate_record(NULL::public.trial_balance_uploads,
      v_snap || jsonb_build_object('lifecycle_state', 'active_unprocessed', 'version', COALESCE((v_snap->>'version')::bigint, 1) + 2))
    RETURNING * INTO v_new;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
      IF v_constraint = 'uq_one_active_upload_per_period' THEN
        RETURN QUERY SELECT 'conflict_new_active_upload'::text, NULL::uuid,
          'Undo cannot proceed because a new trial balance is now active for this period.'::text; RETURN;
      END IF;
      RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The trial balance could not be restored.'::text; RETURN;
    WHEN OTHERS THEN
      PERFORM set_config('axiom.tbu_lifecycle_op', '', true);
      RETURN QUERY SELECT 'terminal_failure'::text, NULL::uuid, 'The trial balance could not be restored (for example, the period is now locked).'::text; RETURN;
  END;
  UPDATE public.trial_balance_upload_operations o
     SET state = 'restored', restored_at = now(), restored_by = auth.uid(), restored_by_membership_id = v_member
   WHERE o.id = v_op.id;
  PERFORM public.tbu_record_lifecycle_event(v_new, 'discarded', 'active_unprocessed', 'user', auth.uid(), v_member, v_op.id, 'Discard undone');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'restored'::text, v_new.id, NULL::text;
END;
$$;

-- ── Retire and replace ───────────────────────────────────────────────────────────────────────
-- The only path for an upload with any history. It deletes nothing and copies no results. It is
-- idempotent per (old upload, new file path): a retried request with the SAME file returns the same new
-- upload, while a DIFFERENT file racing for the same old upload gets stale_version, never a false success.
CREATE OR REPLACE FUNCTION public.retire_trial_balance_upload(
  p_old_upload_id uuid, p_expected_version bigint,
  p_new_file_name text, p_new_file_path text, p_new_file_size integer, p_reason text DEFAULT NULL)
RETURNS TABLE (outcome public.discard_outcome, new_upload_id uuid, retired_upload_id uuid, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_old public.trial_balance_uploads%ROWTYPE;
  v_new public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_new_id uuid;
BEGIN
  IF p_old_upload_id IS NULL OR p_new_file_name IS NULL OR p_new_file_path IS NULL OR p_new_file_size IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::uuid, 'Missing required fields.'::text; RETURN;
  END IF;

  SELECT * INTO v_old FROM public.trial_balance_uploads t WHERE t.id = p_old_upload_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::uuid, 'The upload being replaced no longer exists.'::text; RETURN;
  END IF;

  v_member := public.tbu_source_manager_membership(v_old.company_id);
  IF v_member IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::public.discard_outcome, NULL::uuid, NULL::uuid,
      'Only an owner or partner of this company can replace a trial balance.'::text; RETURN;
  END IF;

  IF v_old.lifecycle_state = 'superseded' THEN
    IF EXISTS (SELECT 1 FROM public.trial_balance_uploads n WHERE n.id = v_old.superseded_by_upload_id AND n.file_path = p_new_file_path) THEN
      RETURN QUERY SELECT 'replaced'::public.discard_outcome, v_old.superseded_by_upload_id, v_old.id, 'Already replaced.'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome, NULL::uuid, NULL::uuid,
      'This trial balance was already replaced by another upload. Refresh and try again.'::text; RETURN;
  END IF;

  IF v_old.lifecycle_state IN ('retired', 'discard_pending', 'discarded') THEN
    RETURN QUERY SELECT 'already_discarded'::public.discard_outcome, NULL::uuid, NULL::uuid, 'This trial balance is no longer active.'::text; RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_old.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::public.discard_outcome, NULL::uuid, NULL::uuid,
      'This trial balance changed since you last viewed it. Refresh and try again.'::text; RETURN;
  END IF;

  v_new_id := gen_random_uuid();
  PERFORM set_config('axiom.tbu_lifecycle_op', 'retire', true);
  -- Demote first (see the superseded_by_upload_id DEFERRABLE note), then insert the new active row.
  UPDATE public.trial_balance_uploads t
     SET lifecycle_state = 'superseded', retired_at = now(), retired_by = auth.uid(), retired_by_membership_id = v_member,
         retired_reason = p_reason, superseded_by_upload_id = v_new_id, version = t.version + 1
   WHERE t.id = v_old.id;
  INSERT INTO public.trial_balance_uploads (
    id, file_name, file_path, file_size, status, user_id, company_id, company_name, period_year,
    period_id, engagement_id, lifecycle_state, replaces_upload_id
  ) VALUES (
    v_new_id, p_new_file_name, p_new_file_path, p_new_file_size, 'pending', auth.uid(), v_old.company_id, v_old.company_name,
    v_old.period_year, v_old.period_id, v_old.engagement_id, 'active_unprocessed', v_old.id
  ) RETURNING * INTO v_new;
  PERFORM public.tbu_record_lifecycle_event(v_old, v_old.lifecycle_state, 'superseded', 'user', auth.uid(), v_member, NULL, COALESCE(p_reason, 'Replaced'));
  PERFORM public.tbu_record_lifecycle_event(v_new, NULL, 'active_unprocessed', 'user', auth.uid(), v_member, NULL, 'Created as replacement for ' || v_old.id::text);
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'replaced'::public.discard_outcome, v_new_id, v_old.id, NULL::text;
END;
$$;

-- ── B3: cancel an unprocessed replacement, restoring its predecessor ─────────────────────────
-- Outcomes: cancelled | already_cancelled | forbidden | not_a_replacement | replacement_processed |
--           stale_version | lineage_conflict.
-- Atomic in the database: in one transaction the replacement row is deleted, the predecessor's link is
-- cleared, and the predecessor becomes the period's sole active upload again in its evidence-derived
-- state, with every certification untouched. The client removes the replacement's Storage object
-- afterwards and confirms through confirm_trial_balance_storage_cleanup(). Until then the operation stays
-- storage_cleanup_pending, so a failed cleanup is recorded rather than hidden.
CREATE OR REPLACE FUNCTION public.cancel_trial_balance_replacement(p_replacement_upload_id uuid, p_expected_version bigint)
RETURNS TABLE (outcome text, operation_id uuid, restored_upload_id uuid, file_path text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_rep public.trial_balance_uploads%ROWTYPE;
  v_prev public.trial_balance_uploads%ROWTYPE;
  v_prev_id uuid;
  v_member uuid;
  v_restore text;
  v_op uuid;
  v_done public.trial_balance_upload_operations%ROWTYPE;
BEGIN
  SELECT t.replaces_upload_id INTO v_prev_id FROM public.trial_balance_uploads t WHERE t.id = p_replacement_upload_id;
  IF NOT FOUND THEN
    SELECT * INTO v_done FROM public.trial_balance_upload_operations o
     WHERE o.upload_id = p_replacement_upload_id AND o.kind = 'cancel_replacement' ORDER BY o.created_at DESC LIMIT 1;
    IF v_done.id IS NULL THEN
      RETURN QUERY SELECT 'not_a_replacement'::text, NULL::uuid, NULL::uuid, NULL::text, 'This trial balance no longer exists.'::text; RETURN;
    END IF;
    IF public.tbu_source_manager_membership(v_done.company_id) IS NULL THEN
      RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::text, 'Only an owner or partner of this company can cancel a replacement.'::text; RETURN;
    END IF;
    RETURN QUERY SELECT 'already_cancelled'::text, v_done.id, v_done.related_upload_id, v_done.file_path, NULL::text; RETURN;
  END IF;

  -- Lock both lineage rows in a fixed (id) order so concurrent lifecycle operations cannot deadlock.
  PERFORM 1 FROM public.trial_balance_uploads t
   WHERE t.id IN (p_replacement_upload_id, v_prev_id) ORDER BY t.id FOR UPDATE;
  SELECT * INTO v_rep FROM public.trial_balance_uploads t WHERE t.id = p_replacement_upload_id;
  IF v_rep.id IS NULL THEN
    RETURN QUERY SELECT 'stale_version'::text, NULL::uuid, NULL::uuid, NULL::text, 'This trial balance changed. Refresh and try again.'::text; RETURN;
  END IF;

  v_member := public.tbu_source_manager_membership(v_rep.company_id);
  IF v_member IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::text, 'Only an owner or partner of this company can cancel a replacement.'::text; RETURN;
  END IF;

  IF v_rep.replaces_upload_id IS NULL THEN
    RETURN QUERY SELECT 'not_a_replacement'::text, NULL::uuid, NULL::uuid, NULL::text, 'This trial balance did not replace another one.'::text; RETURN;
  END IF;
  SELECT * INTO v_prev FROM public.trial_balance_uploads t WHERE t.id = v_rep.replaces_upload_id;
  IF v_prev.id IS NULL OR v_prev.lifecycle_state <> 'superseded' OR v_prev.superseded_by_upload_id IS DISTINCT FROM v_rep.id THEN
    RETURN QUERY SELECT 'lineage_conflict'::text, NULL::uuid, NULL::uuid, NULL::text,
      'The earlier trial balance is no longer linked to this replacement, so it cannot be restored automatically.'::text; RETURN;
  END IF;

  -- Evidence outranks the version check (processing start bumps version).
  IF v_rep.lifecycle_state <> 'active_unprocessed' OR public.tbu_upload_evidence(v_rep.id, v_prev.id) IS NOT NULL THEN
    RETURN QUERY SELECT 'replacement_processed'::text, NULL::uuid, NULL::uuid, NULL::text,
      'The replacement has already been processed, so it cannot be cancelled. Replace it with another upload instead.'::text; RETURN;
  END IF;

  IF p_expected_version IS NULL OR v_rep.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale_version'::text, NULL::uuid, NULL::uuid, NULL::text, 'This trial balance changed since you last viewed it. Refresh and try again.'::text; RETURN;
  END IF;

  v_restore := public.tbu_derived_active_state(v_prev);

  PERFORM set_config('axiom.tbu_lifecycle_op', 'cancel_replacement', true);
  -- Free the period's active slot first, then reactivate the predecessor. The deferred FK from
  -- v_prev.superseded_by_upload_id is satisfied at COMMIT because the link is cleared below.
  DELETE FROM public.trial_balance_uploads t WHERE t.id = v_rep.id;
  UPDATE public.trial_balance_uploads t
     SET superseded_by_upload_id = NULL, lifecycle_state = v_restore, retired_at = NULL, retired_by = NULL,
         retired_by_membership_id = NULL, retired_reason = NULL, version = t.version + 1
   WHERE t.id = v_prev.id;
  INSERT INTO public.trial_balance_upload_operations
    (kind, state, upload_id, related_upload_id, company_id, period_year, actor_user_id, actor_membership_id, file_path, row_snapshot)
  VALUES ('cancel_replacement', 'storage_cleanup_pending', v_rep.id, v_prev.id, v_rep.company_id, v_rep.period_year,
          auth.uid(), v_member, v_rep.file_path, to_jsonb(v_rep))
  RETURNING id INTO v_op;
  PERFORM public.tbu_record_lifecycle_event(v_rep, v_rep.lifecycle_state, 'discarded', 'user', auth.uid(), v_member, v_op, 'Replacement cancelled');
  PERFORM public.tbu_record_lifecycle_event(v_prev, 'superseded', v_restore, 'user', auth.uid(), v_member, v_op, 'Restored: replacement ' || v_rep.id::text || ' cancelled');
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  RETURN QUERY SELECT 'cancelled'::text, v_op, v_prev.id, v_rep.file_path, NULL::text;
END;
$$;

-- Records that a cancelled replacement's Storage object was removed. Idempotent.
-- Outcomes: completed | already_completed | storage_cleanup_pending | forbidden | stale_operation.
CREATE OR REPLACE FUNCTION public.confirm_trial_balance_storage_cleanup(p_operation_id uuid, p_storage_removed boolean)
RETURNS TABLE (outcome text, detail text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_operation_id AND o.kind = 'cancel_replacement' FOR UPDATE;
  IF v_op.id IS NULL THEN
    RETURN QUERY SELECT 'stale_operation'::text, 'Unknown cleanup operation.'::text; RETURN;
  END IF;
  IF public.tbu_source_manager_membership(v_op.company_id) IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::text; RETURN;
  END IF;
  IF v_op.state = 'completed' THEN
    RETURN QUERY SELECT 'already_completed'::text, NULL::text; RETURN;
  END IF;
  IF NOT COALESCE(p_storage_removed, false) THEN
    RETURN QUERY SELECT 'storage_cleanup_pending'::text, 'The replacement file is still in storage; cleanup can be retried.'::text; RETURN;
  END IF;
  UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
  RETURN QUERY SELECT 'completed'::text, NULL::text;
END;
$$;

-- ── Privileges ───────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.tbu_source_manager_membership(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_record_lifecycle_event(public.trial_balance_uploads, text, text, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_derived_active_state(public.trial_balance_uploads) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_upload_evidence(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_lifecycle_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_lifecycle_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tb_certification_drives_upload_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_lifecycle_events_append_only() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.discard_trial_balance_upload(uuid, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_trial_balance_discard(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_trial_balance_upload(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_trial_balance_replacement(uuid, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_trial_balance_storage_cleanup(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discard_trial_balance_upload(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_trial_balance_discard(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_trial_balance_upload(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_trial_balance_replacement(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_trial_balance_storage_cleanup(uuid, boolean) TO authenticated;

-- ── Rollback (NOT executed; for reference only; review before use) ──────────────────────────
-- Roll back the frontend first. Then:
-- DROP FUNCTION IF EXISTS public.confirm_trial_balance_storage_cleanup(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.cancel_trial_balance_replacement(uuid, bigint);
-- DROP FUNCTION IF EXISTS public.retire_trial_balance_upload(uuid, bigint, text, text, integer, text);
-- DROP FUNCTION IF EXISTS public.restore_trial_balance_upload(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.complete_trial_balance_discard(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.discard_trial_balance_upload(uuid, bigint);
-- DROP TRIGGER IF EXISTS trg_tbc_drives_upload_lifecycle ON public.tb_certifications;
-- DROP TRIGGER IF EXISTS trg_tbu_lifecycle_audit ON public.trial_balance_uploads;
-- DROP TRIGGER IF EXISTS trg_tbu_lifecycle_guard ON public.trial_balance_uploads;
-- DROP INDEX IF EXISTS public.uq_one_active_upload_per_period;
-- Restore the 20260902150000 body of get_authoritative_certification (without the lifecycle filter).
-- Re-create "Users can delete their own uploads" only if direct client deletes are wanted again.
-- Keep the lifecycle columns, trial_balance_upload_lifecycle_events and trial_balance_upload_operations.
-- Once the functions and triggers are gone they are inert, and dropping them destroys lineage and the audit trail.
