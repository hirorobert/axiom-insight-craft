-- 20261106100000_trial_balance_drafts.sql — a trial balance stored privately as a DRAFT before it is added to an entity
-- (Phase 2 §5.4, §5.10; owner decision 2026-10-15: unconfirmed drafts are kept 7 days). Forward-only; nothing edited.
--
-- Why: the one-page journey lets a signed-in user drop a file before choosing or creating the entity it belongs to. The
-- existing source reservation (20260923100000) is workspace-scoped (workspaces/<company>/…) and cannot exist before a
-- company. A draft is owner-scoped instead: drafts/<owner>/<draft>/<name>, readable and deletable only by its owner.
--
-- Two operations, each idempotent on its own terms:
--   * RESERVE binds the authorised owner and the file's identity (name, size, SHA-256 of its bytes). The same key with
--     the same identity returns the same draft; the same key with a different identity is refused (conflict). No entity
--     is needed to reserve.
--   * COMMIT is its own record (trial_balance_draft_commits) that binds the draft and its content hash, the target
--     entity, the period (year, period, engagement), the context the user confirmed (entity, period, currency) and, for a
--     replacement, the upload it replaces (registered through retire_trial_balance_upload, which keeps the current
--     trial balance if the replacement fails). The
--     same commit key with changed inputs is refused; the same inputs resume or replay. A draft is committed at most once.
--     The entity's authority is NEVER decided here: the trial-balance-draft Edge Function re-checks it on every call
--     (a replay included) and reserves and registers AS THE USER through the existing workspace functions.
--   * Commit is a recovery protocol, not a distributed transaction. Each step is recorded before the next is taken:
--     begin → workspace reservation recorded → object copied and its SHA-256 verified (recorded) → registered (the
--     reservation is consumed atomically with the upload row) → finished. A retry at any point resumes from what was
--     recorded; registration happens at most once because the reservation is single-use.
--   * Retention: an unconfirmed draft (never committed) expires after trial_balance_draft_retention() = 7 days. The
--     scheduled source sweeper (20260923120000) removes expired, deleted and rejected drafts' objects and, after a commit,
--     the draft's own copy. It only ever deletes the draft's own drafts/ object (under the existing reference rule,
--     tbu_object_referenced). Committing copies the file to a NEW workspace object (workspaces/<company>/…) that the
--     upload is bound to, and a drafts/ path can never be a bound source, so committed financial evidence is never
--     affected by draft cleanup.
--   * Drafts are invisible to every other user and to anonymous callers; there is no client table access at all.
--   * Nothing that exists changes behaviour: no existing table, constraint, policy or grant is altered. The only
--     redefinitions are the three sweeper functions below — the 20261011100000 definitions with exactly the marked
--     [20261106100000] blocks added.

DO $preflight$
BEGIN
  IF to_regprocedure('public.reserve_trial_balance_source(uuid,text)') IS NULL
     OR to_regprocedure('public.register_trial_balance_upload(uuid,integer,integer,uuid,uuid)') IS NULL
     OR to_regprocedure('public.tbu_sweeper_candidates(integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the source upload authority or the source sweeper is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.trial_balance_drafts') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: trial balance drafts are already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The draft and its commits ────────────────────────────────────────────────────────────────────────────────────
-- owner_ref is the owner's id, fixed at reservation (it names the path and scopes the key). owner_user_id is the live
-- account link: SET NULL if the account is removed, which makes the draft unreachable and leaves it to the sweeper.
CREATE TABLE public.trial_balance_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_ref uuid NOT NULL,
  owner_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  object_path text NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_size bigint NOT NULL CHECK (file_size > 0 AND file_size <= 52428800),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committing', 'committed', 'deleted', 'rejected', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Plain history, deliberately NOT a foreign key: tbu_upload_evidence() (20260923100000) treats any row referencing
  -- an upload through a foreign key as processing evidence, which would make an unprocessed upload added from a draft
  -- undeletable — a change to existing lifecycle behaviour. The id is checked when the commit finishes.
  committed_upload_id uuid NULL,
  committed_at timestamptz NULL,
  deleted_at timestamptz NULL,
  rejected_reason text NULL CHECK (rejected_reason IS NULL OR rejected_reason IN ('content_mismatch')),
  swept_at timestamptz NULL,
  CONSTRAINT uq_tbd_owner_key UNIQUE (owner_ref, idempotency_key),
  CONSTRAINT chk_tbd_owner_link CHECK (owner_user_id IS NULL OR owner_user_id = owner_ref),
  CONSTRAINT chk_tbd_path_shape CHECK (object_path LIKE 'drafts/' || owner_ref::text || '/' || id::text || '/%'),
  -- References are SET NULL on delete (an entity or account removed later never blocks on draft history), so these
  -- checks constrain the timestamps, not the references.
  CONSTRAINT chk_tbd_committed CHECK ((state = 'committed') = (committed_at IS NOT NULL)),
  CONSTRAINT chk_tbd_committed_upload CHECK (committed_upload_id IS NULL OR state = 'committed'),
  CONSTRAINT chk_tbd_deleted CHECK ((state = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT chk_tbd_rejected CHECK ((state = 'rejected') = (rejected_reason IS NOT NULL))
);
CREATE INDEX idx_tbd_owner ON public.trial_balance_drafts (owner_user_id, created_at DESC);
CREATE INDEX idx_tbd_sweep ON public.trial_balance_drafts (expires_at) WHERE swept_at IS NULL;

CREATE TABLE public.trial_balance_draft_commits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES public.trial_balance_drafts(id) ON DELETE CASCADE,
  owner_ref uuid NOT NULL,
  commit_key text NOT NULL CHECK (commit_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  company_id uuid NULL REFERENCES public.companies(id) ON DELETE SET NULL,
  target_company_ref uuid NOT NULL,
  period_year integer NOT NULL,
  period_id uuid NULL,
  engagement_id uuid NULL,
  confirmation jsonb NOT NULL,
  -- A REPLACEMENT of the period's active trial balance (registered through retire_trial_balance_upload, which keeps the
  -- current upload if the replacement fails). Plain history, not a foreign key (see trial_balance_drafts.committed_upload_id).
  replaces_upload_id uuid NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'cancelled', 'committed')),
  reservation_id uuid NULL REFERENCES public.trial_balance_source_reservations(id) ON DELETE SET NULL,
  copy_verified_at timestamptz NULL,
  upload_id uuid NULL, -- plain history, not a foreign key (see trial_balance_drafts.committed_upload_id)
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  CONSTRAINT uq_tbdc_owner_key UNIQUE (owner_ref, commit_key),
  CONSTRAINT chk_tbdc_settled CHECK ((state = 'open') = (settled_at IS NULL)),
  CONSTRAINT chk_tbdc_upload CHECK (upload_id IS NULL OR state = 'committed')
);
-- A draft has at most one commit in progress or done.
CREATE UNIQUE INDEX uq_tbdc_one_live_per_draft ON public.trial_balance_draft_commits (draft_id) WHERE state IN ('open', 'committed');

ALTER TABLE public.trial_balance_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_balance_draft_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_balance_drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.trial_balance_draft_commits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.trial_balance_drafts TO service_role;
GRANT ALL ON public.trial_balance_draft_commits TO service_role;

-- What a draft or a commit is bound to never changes after it is recorded (only lifecycle columns move).
CREATE OR REPLACE FUNCTION public.tbd_bound_fields_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'trial_balance_drafts' THEN
    IF (NEW.id, NEW.owner_ref, NEW.object_path, NEW.file_name, NEW.file_size, NEW.content_sha256, NEW.idempotency_key, NEW.request_hash, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.owner_ref, OLD.object_path, OLD.file_name, OLD.file_size, OLD.content_sha256, OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
      RAISE EXCEPTION 'DRAFT_BINDING_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (NEW.id, NEW.draft_id, NEW.owner_ref, NEW.commit_key, NEW.request_hash, NEW.target_company_ref, NEW.period_year, NEW.period_id, NEW.engagement_id, NEW.confirmation, NEW.replaces_upload_id, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.draft_id, OLD.owner_ref, OLD.commit_key, OLD.request_hash, OLD.target_company_ref, OLD.period_year, OLD.period_id, OLD.engagement_id, OLD.confirmation, OLD.replaces_upload_id, OLD.created_at) THEN
      RAISE EXCEPTION 'DRAFT_COMMIT_BINDING_IMMUTABLE' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_tbd_bound_fields_immutable BEFORE UPDATE ON public.trial_balance_drafts
  FOR EACH ROW EXECUTE FUNCTION public.tbd_bound_fields_immutable();
CREATE TRIGGER trg_tbdc_bound_fields_immutable BEFORE UPDATE ON public.trial_balance_draft_commits
  FOR EACH ROW EXECUTE FUNCTION public.tbd_bound_fields_immutable();

-- The approved retention for unconfirmed drafts (owner decision 2026-10-15). One definition, used everywhere.
CREATE OR REPLACE FUNCTION public.trial_balance_draft_retention()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$ SELECT interval '7 days' $$;

-- The hashes that bind each operation (built-in sha256; a field separator no input can contain).
CREATE OR REPLACE FUNCTION public.tbd_reserve_hash(p_owner uuid, p_name text, p_size bigint, p_sha text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(concat_ws(chr(31), 'reserve.v1', p_owner::text, p_name, p_size::text, p_sha), 'UTF8')), 'hex');
$$;
CREATE OR REPLACE FUNCTION public.tbd_commit_hash(p_draft uuid, p_sha text, p_company uuid, p_year integer, p_period uuid, p_engagement uuid, p_confirmation jsonb, p_replaces uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(concat_ws(chr(31), 'commit.v1', p_draft::text, p_sha, p_company::text, p_year::text,
    COALESCE(p_period::text, '-'), COALESCE(p_engagement::text, '-'), p_confirmation::text, COALESCE(p_replaces::text, '-')), 'UTF8')), 'hex');
$$;
-- The confirmed context: exactly entity, period and currency, each a non-empty string the user saw and confirmed.
CREATE OR REPLACE FUNCTION public.tbd_confirmation_valid(p jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object'
     AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k) = ARRAY['currency', 'entity', 'period']
     AND (SELECT bool_and(jsonb_typeof(v) = 'string' AND length(v #>> '{}') BETWEEN 1 AND 200) FROM jsonb_each(p) e(k, v));
$$;

-- ── 2. Reserve (owner): idempotent per key, bound to the file's identity ────────────────────────────────────────────
-- Outcomes: reserved | replayed | conflict | forbidden | invalid_request.
CREATE OR REPLACE FUNCTION public.reserve_trial_balance_draft(p_file_name text, p_file_size bigint, p_content_sha256 text, p_idempotency_key text)
RETURNS TABLE (outcome text, draft_id uuid, object_path text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing public.trial_balance_drafts%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_hash text;
  v_exp timestamptz := now() + public.trial_balance_draft_retention();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = v_uid) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::text, NULL::timestamptz; RETURN;
  END IF;
  IF p_file_name IS NULL OR length(p_file_name) NOT BETWEEN 1 AND 255 OR p_file_size IS NULL OR p_file_size <= 0 OR p_file_size > 52428800
     OR p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$'
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::text, NULL::timestamptz; RETURN;
  END IF;
  v_hash := public.tbd_reserve_hash(v_uid, p_file_name, p_file_size, p_content_sha256);
  -- Serialise one owner's reservations under one key, so concurrent retries converge on one draft.
  PERFORM pg_advisory_xact_lock(hashtext('tb_draft:' || v_uid::text || ':' || p_idempotency_key));
  SELECT * INTO v_existing FROM public.trial_balance_drafts d WHERE d.owner_ref = v_uid AND d.idempotency_key = p_idempotency_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.request_hash = v_hash THEN
      RETURN QUERY SELECT 'replayed'::text, v_existing.id, v_existing.object_path, v_existing.expires_at; RETURN;
    END IF;
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::text, NULL::timestamptz; RETURN;
  END IF;
  v_path := 'drafts/' || v_uid::text || '/' || v_id::text || '/' || public.tbu_safe_object_name(p_file_name);
  INSERT INTO public.trial_balance_drafts (id, owner_ref, owner_user_id, object_path, file_name, file_size, content_sha256, idempotency_key, request_hash, expires_at)
  VALUES (v_id, v_uid, v_uid, v_path, p_file_name, p_file_size, p_content_sha256, p_idempotency_key, v_hash, v_exp);
  RETURN QUERY SELECT 'reserved'::text, v_id, v_path, v_exp;
END;
$$;

-- ── 3. Read, list and delete (owner only) ───────────────────────────────────────────────────────────────────────────
-- Another user's draft answers exactly like a missing one (existence is never revealed).
CREATE OR REPLACE FUNCTION public.get_trial_balance_draft(p_draft_id uuid)
RETURNS TABLE (draft_id uuid, file_name text, file_size bigint, state text, expires_at timestamptz, stored boolean, committed_upload_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id, d.file_name, d.file_size,
         CASE WHEN d.state = 'reserved' AND d.expires_at <= now() THEN 'expired' ELSE d.state END,
         d.expires_at, public.tbu_storage_object_exists(d.object_path), d.committed_upload_id
    FROM public.trial_balance_drafts d
   WHERE d.id = p_draft_id AND d.owner_user_id = auth.uid();
$$;

-- The owner's drafts that can still be used (newest first), for recovery after a reload.
CREATE OR REPLACE FUNCTION public.list_trial_balance_drafts()
RETURNS TABLE (draft_id uuid, file_name text, file_size bigint, state text, created_at timestamptz, expires_at timestamptz, stored boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.id, d.file_name, d.file_size, d.state, d.created_at, d.expires_at, public.tbu_storage_object_exists(d.object_path)
    FROM public.trial_balance_drafts d
   WHERE d.owner_user_id = auth.uid() AND d.state IN ('reserved', 'committing') AND d.expires_at > now()
   ORDER BY d.created_at DESC LIMIT 20;
$$;

-- Outcomes: deleted | already_deleted | not_found | not_eligible (a draft being committed, or committed, is not deleted).
-- The object itself is removed by the scheduled sweeper (only the service role deletes storage objects).
CREATE OR REPLACE FUNCTION public.delete_trial_balance_draft(p_draft_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v public.trial_balance_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.trial_balance_drafts d WHERE d.id = p_draft_id AND d.owner_user_id = auth.uid() FOR UPDATE;
  IF v.id IS NULL THEN RETURN 'not_found'; END IF;
  IF v.state = 'deleted' THEN RETURN 'already_deleted'; END IF;
  IF v.state NOT IN ('reserved', 'expired') THEN RETURN 'not_eligible'; END IF;
  UPDATE public.trial_balance_drafts d SET state = 'deleted', deleted_at = now() WHERE d.id = v.id;
  RETURN 'deleted';
END;
$$;

-- ── 4. Sign and commit (service role, called by the trial-balance-draft Edge Function) ───────────────────────────────
-- What may be signed: only an unexpired, reserved draft of this very user whose object is not stored yet.
CREATE OR REPLACE FUNCTION public.tbd_sign_target(p_draft_id uuid, p_user_id uuid)
RETURNS TABLE (object_path text, signable boolean, stored boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.object_path, (d.state = 'reserved' AND d.expires_at > now()), public.tbu_storage_object_exists(d.object_path)
    FROM public.trial_balance_drafts d WHERE d.id = p_draft_id AND d.owner_user_id = p_user_id;
$$;

-- Begin, resume or replay a commit. Outcomes: started | resume | already_committed | conflict | not_found | expired |
-- object_missing | not_eligible | invalid_request. reservation_state: none | live | expired | consumed.
CREATE OR REPLACE FUNCTION public.tbd_begin_commit(
  p_draft_id uuid, p_user_id uuid, p_commit_key text, p_company_id uuid, p_period_year integer,
  p_period_id uuid, p_engagement_id uuid, p_confirmation jsonb, p_replaces_upload_id uuid DEFAULT NULL)
RETURNS TABLE (outcome text, commit_id uuid, object_path text, file_name text, file_size bigint, content_sha256 text,
               reservation_id uuid, reservation_state text, copy_verified boolean, upload_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v public.trial_balance_drafts%ROWTYPE;
  c public.trial_balance_draft_commits%ROWTYPE;
  v_hash text;
  v_rstate text;
  v_new uuid;
BEGIN
  IF p_draft_id IS NULL OR p_user_id IS NULL OR p_company_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 1900 AND 2200
     OR p_commit_key IS NULL OR p_commit_key !~ '^[A-Za-z0-9_-]{16,64}$' OR NOT COALESCE(public.tbd_confirmation_valid(p_confirmation), false) THEN
    RETURN QUERY SELECT 'invalid_request'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v FROM public.trial_balance_drafts d WHERE d.id = p_draft_id AND d.owner_user_id = p_user_id FOR UPDATE;
  IF v.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  v_hash := public.tbd_commit_hash(v.id, v.content_sha256, p_company_id, p_period_year, p_period_id, p_engagement_id, p_confirmation, p_replaces_upload_id);

  -- The key is bound to its first inputs, on any draft: the same key with changed inputs is a conflict.
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.owner_ref = v.owner_ref AND k.commit_key = p_commit_key;
  IF c.id IS NOT NULL AND (c.draft_id <> v.id OR c.request_hash <> v_hash) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  -- A key whose commit was cancelled stays spent: resending it never starts the commit again (a new key does).
  IF c.id IS NOT NULL AND c.state = 'cancelled' THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;

  -- The draft's live commit (open or committed), whichever key started it.
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.draft_id = v.id AND k.state IN ('open', 'committed') FOR UPDATE;
  IF c.id IS NOT NULL THEN
    IF c.request_hash <> v_hash THEN
      -- Committed (or being committed) to something else: a draft is committed at most once.
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
    END IF;
    SELECT CASE WHEN r.id IS NULL THEN 'none' WHEN r.consumed_at IS NOT NULL THEN 'consumed' WHEN r.expires_at <= now() THEN 'expired' ELSE 'live' END
      INTO v_rstate FROM (SELECT 1) one LEFT JOIN public.trial_balance_source_reservations r ON r.id = c.reservation_id;
    RETURN QUERY SELECT (CASE WHEN c.state = 'committed' THEN 'already_committed' ELSE 'resume' END)::text, c.id, v.object_path, v.file_name,
      v.file_size, v.content_sha256, c.reservation_id, v_rstate, c.copy_verified_at IS NOT NULL, c.upload_id;
    RETURN;
  END IF;

  IF v.state <> 'reserved' THEN
    RETURN QUERY SELECT (CASE WHEN v.state = 'expired' THEN 'expired' ELSE 'not_eligible' END)::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  IF NOT public.tbu_storage_object_exists(v.object_path) THEN
    RETURN QUERY SELECT 'object_missing'::text, NULL::uuid, NULL::text, NULL::text, NULL::bigint, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.trial_balance_draft_commits (draft_id, owner_ref, commit_key, request_hash, company_id, target_company_ref, period_year, period_id, engagement_id, confirmation, replaces_upload_id)
  VALUES (v.id, v.owner_ref, p_commit_key, v_hash, p_company_id, p_company_id, p_period_year, p_period_id, p_engagement_id, p_confirmation, p_replaces_upload_id)
  RETURNING id INTO v_new;
  UPDATE public.trial_balance_drafts d SET state = 'committing' WHERE d.id = v.id;
  RETURN QUERY SELECT 'started'::text, v_new, v.object_path, v.file_name, v.file_size, v.content_sha256, NULL::uuid, 'none'::text, false, NULL::uuid;
END;
$$;

-- Records the workspace reservation an open commit uses. A different one later is refused, unless the recorded one
-- expired unconsumed (a resumed commit then reserves again; the expired reservation's object is reclaimed by the
-- sweeper as before). Recording a new reservation resets the copy verification (it was for the old object).
-- Outcomes: recorded | already_recorded | conflict | not_found.
CREATE OR REPLACE FUNCTION public.tbd_record_commit_reservation(p_commit_id uuid, p_user_id uuid, p_reservation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c public.trial_balance_draft_commits%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
  v_draft public.trial_balance_drafts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.id = p_commit_id FOR UPDATE;
  SELECT * INTO v_draft FROM public.trial_balance_drafts d WHERE d.id = c.draft_id;
  IF c.id IS NULL OR v_draft.owner_user_id IS DISTINCT FROM p_user_id OR c.state <> 'open' THEN RETURN 'not_found'; END IF;
  IF c.reservation_id = p_reservation_id THEN RETURN 'already_recorded'; END IF;
  IF c.reservation_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.trial_balance_source_reservations r
        WHERE r.id = c.reservation_id AND r.consumed_at IS NULL AND r.expires_at <= now()) THEN
    RETURN 'conflict';
  END IF;
  SELECT * INTO v_res FROM public.trial_balance_source_reservations r WHERE r.id = p_reservation_id;
  -- The reservation must be this user's, unconsumed, for the entity the commit is bound to, for this file.
  IF v_res.id IS NULL OR v_res.consumed_at IS NOT NULL OR v_res.actor_user_id <> p_user_id
     OR v_res.company_id IS DISTINCT FROM c.target_company_ref OR v_res.file_name <> v_draft.file_name THEN
    RETURN 'conflict';
  END IF;
  UPDATE public.trial_balance_draft_commits k SET reservation_id = p_reservation_id, copy_verified_at = NULL WHERE k.id = c.id;
  RETURN 'recorded';
END;
$$;

-- Records that the workspace copy exists and its bytes hash to the draft's content hash (as computed by the Edge
-- Function, which read the object back). Outcomes: verified | already_verified | mismatch | object_missing | not_found.
CREATE OR REPLACE FUNCTION public.tbd_record_copy_verified(p_commit_id uuid, p_user_id uuid, p_copy_sha256 text, p_copy_size bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c public.trial_balance_draft_commits%ROWTYPE;
  v_draft public.trial_balance_drafts%ROWTYPE;
  v_path text;
BEGIN
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.id = p_commit_id FOR UPDATE;
  SELECT * INTO v_draft FROM public.trial_balance_drafts d WHERE d.id = c.draft_id;
  IF c.id IS NULL OR v_draft.owner_user_id IS DISTINCT FROM p_user_id OR c.state <> 'open' OR c.reservation_id IS NULL THEN RETURN 'not_found'; END IF;
  IF p_copy_sha256 IS DISTINCT FROM v_draft.content_sha256 OR p_copy_size IS DISTINCT FROM v_draft.file_size THEN RETURN 'mismatch'; END IF;
  SELECT r.object_path INTO v_path FROM public.trial_balance_source_reservations r WHERE r.id = c.reservation_id;
  IF NOT public.tbu_storage_object_exists(v_path) THEN RETURN 'object_missing'; END IF;
  IF c.copy_verified_at IS NOT NULL THEN RETURN 'already_verified'; END IF;
  UPDATE public.trial_balance_draft_commits k SET copy_verified_at = now() WHERE k.id = c.id;
  RETURN 'verified';
END;
$$;

-- Finishes a commit once the workspace registered the upload from this commit's reservation, with exactly the bound
-- period. Outcomes: committed | already_committed | mismatch | not_verified | not_found.
CREATE OR REPLACE FUNCTION public.tbd_finish_commit(p_commit_id uuid, p_user_id uuid, p_upload_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c public.trial_balance_draft_commits%ROWTYPE;
  v_draft public.trial_balance_drafts%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.id = p_commit_id FOR UPDATE;
  SELECT * INTO v_draft FROM public.trial_balance_drafts d WHERE d.id = c.draft_id FOR UPDATE;
  IF c.id IS NULL OR v_draft.owner_user_id IS DISTINCT FROM p_user_id THEN RETURN 'not_found'; END IF;
  IF c.state = 'committed' THEN RETURN CASE WHEN c.upload_id = p_upload_id THEN 'already_committed' ELSE 'mismatch' END; END IF;
  IF c.state <> 'open' OR c.reservation_id IS NULL THEN RETURN 'not_found'; END IF;
  SELECT * INTO v_res FROM public.trial_balance_source_reservations r WHERE r.id = c.reservation_id;
  IF v_res.consumed_by_upload_id IS DISTINCT FROM p_upload_id
     OR NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                     WHERE t.id = p_upload_id AND t.company_id = c.target_company_ref AND t.file_path = v_res.object_path
                       AND t.period_year = c.period_year AND t.period_id IS NOT DISTINCT FROM COALESCE(c.period_id, t.period_id)
                       AND t.engagement_id IS NOT DISTINCT FROM COALESCE(c.engagement_id, t.engagement_id)
                       AND t.file_size = v_draft.file_size
                       -- A replacement must be exactly the replacement of the bound upload; a first upload replaces nothing.
                       AND t.replaces_upload_id IS NOT DISTINCT FROM c.replaces_upload_id) THEN
    RETURN 'mismatch';
  END IF;
  IF c.copy_verified_at IS NULL THEN RETURN 'not_verified'; END IF;
  UPDATE public.trial_balance_draft_commits k SET state = 'committed', upload_id = p_upload_id, settled_at = now() WHERE k.id = c.id;
  UPDATE public.trial_balance_drafts d SET state = 'committed', committed_upload_id = p_upload_id, committed_at = now() WHERE d.id = v_draft.id;
  RETURN 'committed';
END;
$$;

-- Cancels an open commit whose reservation was never consumed (e.g. the period already has an active trial balance and
-- the user chooses another target). The draft is reserved again until its own expiry; an unconsumed workspace
-- reservation (and its copied object) is reclaimed by the existing reservation sweep. A registered commit is never
-- cancelled. Outcomes: cancelled | already_cancelled | not_eligible | not_found.
CREATE OR REPLACE FUNCTION public.tbd_cancel_commit(p_commit_id uuid, p_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c public.trial_balance_draft_commits%ROWTYPE;
  v_draft public.trial_balance_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v_draft FROM public.trial_balance_drafts d
   WHERE d.id = (SELECT k.draft_id FROM public.trial_balance_draft_commits k WHERE k.id = p_commit_id) FOR UPDATE;
  SELECT * INTO c FROM public.trial_balance_draft_commits k WHERE k.id = p_commit_id FOR UPDATE;
  IF c.id IS NULL OR v_draft.owner_user_id IS DISTINCT FROM p_user_id THEN RETURN 'not_found'; END IF;
  IF c.state = 'cancelled' THEN RETURN 'already_cancelled'; END IF;
  IF c.state <> 'open' OR EXISTS (SELECT 1 FROM public.trial_balance_source_reservations r WHERE r.id = c.reservation_id AND r.consumed_at IS NOT NULL) THEN
    RETURN 'not_eligible';
  END IF;
  UPDATE public.trial_balance_draft_commits k SET state = 'cancelled', settled_at = now() WHERE k.id = c.id;
  UPDATE public.trial_balance_drafts d SET state = 'reserved' WHERE d.id = v_draft.id AND d.state = 'committing';
  RETURN 'cancelled';
END;
$$;

-- The stored draft's bytes do not match the identity it was reserved with (the Edge Function read it back): the draft
-- can never be committed; its object is removed by the sweeper. Never applies once registered.
-- Outcomes: rejected | already_rejected | not_eligible | not_found.
CREATE OR REPLACE FUNCTION public.tbd_reject_draft(p_draft_id uuid, p_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v public.trial_balance_drafts%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.trial_balance_drafts d WHERE d.id = p_draft_id AND d.owner_user_id = p_user_id FOR UPDATE;
  IF v.id IS NULL THEN RETURN 'not_found'; END IF;
  IF v.state = 'rejected' THEN RETURN 'already_rejected'; END IF;
  IF v.state NOT IN ('reserved', 'committing') OR EXISTS (
       SELECT 1 FROM public.trial_balance_draft_commits k JOIN public.trial_balance_source_reservations r ON r.id = k.reservation_id
        WHERE k.draft_id = v.id AND k.state = 'open' AND r.consumed_at IS NOT NULL) THEN
    RETURN 'not_eligible';
  END IF;
  UPDATE public.trial_balance_draft_commits k SET state = 'cancelled', settled_at = now() WHERE k.draft_id = v.id AND k.state = 'open';
  UPDATE public.trial_balance_drafts d SET state = 'rejected', rejected_reason = 'content_mismatch' WHERE d.id = v.id;
  RETURN 'rejected';
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_trial_balance_draft(text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_trial_balance_draft(text, bigint, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_trial_balance_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_balance_draft(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_trial_balance_drafts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_trial_balance_drafts() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.delete_trial_balance_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_trial_balance_draft(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trial_balance_draft_retention() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trial_balance_draft_retention() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.tbd_bound_fields_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbd_reserve_hash(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbd_commit_hash(uuid, text, uuid, integer, uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbd_confirmation_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_reserve_hash(uuid, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbd_commit_hash(uuid, text, uuid, integer, uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.tbd_confirmation_valid(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_sign_target(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_sign_target(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_begin_commit(uuid, uuid, text, uuid, integer, uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_begin_commit(uuid, uuid, text, uuid, integer, uuid, uuid, jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_record_commit_reservation(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_record_commit_reservation(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_record_copy_verified(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_record_copy_verified(uuid, uuid, text, bigint) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_finish_commit(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_finish_commit(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_cancel_commit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_cancel_commit(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.tbd_reject_draft(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_reject_draft(uuid, uuid) TO service_role;

-- A commit past retention with nothing in flight: no open commit holds a live, unconsumed workspace reservation. Either
-- it was registered (the reservation was consumed) and only the final record is missing, or it never got that far.
CREATE OR REPLACE FUNCTION public.tbd_commit_abandoned(p_draft_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.trial_balance_draft_commits k
      JOIN public.trial_balance_source_reservations r ON r.id = k.reservation_id
     WHERE k.draft_id = p_draft_id AND k.state = 'open' AND r.consumed_at IS NULL AND r.expires_at > now());
$$;
REVOKE ALL ON FUNCTION public.tbd_commit_abandoned(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tbd_commit_abandoned(uuid) TO service_role;

-- ── 5. The scheduled sweeper: expired, deleted, rejected and committed drafts ────────────────────────────────────────
-- 20261011100000's candidates, plus [20261106100000] 'draft'.
CREATE OR REPLACE FUNCTION public.tbu_sweeper_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (kind text, target_id uuid, object_path text, delete_object boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH lim AS (SELECT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500) AS n),
  d AS (
    SELECT 'discard'::text AS kind, o.id, o.file_path AS path FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state IN ('completed', 'purging') AND o.completed_at <= now() - public.tbu_undo_window()
     ORDER BY o.completed_at LIMIT (SELECT n FROM lim)),
  c AS (
    SELECT 'cancel_replacement'::text, o.id, o.file_path FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'cancel_replacement' AND o.state = 'storage_cleanup_pending'
       AND o.created_at <= now() - public.tbu_cleanup_sweep_grace()
     ORDER BY o.created_at LIMIT (SELECT n FROM lim)),
  r AS (
    SELECT 'reservation'::text, s.id, s.object_path FROM public.trial_balance_source_reservations s
     WHERE s.consumed_at IS NULL AND s.expires_at <= now() - public.tbu_reservation_sweep_grace()
       AND (s.swept_at IS NULL
            OR (s.expires_at > now() - interval '1 day' AND public.tbu_storage_object_exists(s.object_path)))
     ORDER BY s.expires_at LIMIT (SELECT n FROM lim)),
  p AS (
    -- F-04: a discard left pending (the browser never completed it) is resolved, never deleted by the sweeper.
    SELECT 'stale_discard'::text, o.id, NULL::text FROM public.trial_balance_upload_operations o
     WHERE o.kind = 'discard' AND o.state = 'pending' AND o.created_at <= now() - public.tbu_stale_discard_grace()
     ORDER BY o.created_at LIMIT (SELECT n FROM lim)),
  s AS (
    -- I1-B: a shared source whose last reference has ended (and every undo window with it).
    SELECT 'source_object'::text, so.id, so.storage_path FROM public.tb_source_objects so
     WHERE so.state IN ('active', 'purge_pending') AND public.tbu_source_object_unreferenced(so.id)
     ORDER BY so.created_at LIMIT (SELECT n FROM lim)),
  -- [20261106100000] a draft past retention (never committed), deleted by its owner, rejected, left by a removed
  -- account, or committed (its own drafts/ copy; the committed upload's file is the workspace copy, never this one). A
  -- commit in progress is never touched; one abandoned past retention (nothing in flight) is settled by the claim.
  dr AS (
    SELECT 'draft'::text, t.id, t.object_path FROM public.trial_balance_drafts t
     WHERE t.swept_at IS NULL
       AND ((t.state IN ('reserved', 'expired') AND (t.expires_at <= now() OR t.owner_user_id IS NULL))
            OR t.state IN ('deleted', 'rejected', 'committed')
            OR (t.state = 'committing' AND t.expires_at <= now() AND public.tbd_commit_abandoned(t.id)))
     ORDER BY t.expires_at LIMIT (SELECT n FROM lim))
  SELECT x.kind, x.id, x.path,
         x.path IS NOT NULL AND public.tbu_storage_object_exists(x.path) AND NOT public.tbu_object_referenced(x.path)
    FROM (SELECT * FROM d UNION ALL SELECT * FROM c UNION ALL SELECT * FROM r UNION ALL SELECT * FROM p
          UNION ALL SELECT * FROM s UNION ALL SELECT * FROM dr) x;
$$;

-- 20261011100000's claim, plus [20261106100000] 'draft' (locks the draft; an unconfirmed one past retention becomes
-- 'expired' so it can never be signed or committed again; an abandoned commit is settled first: committed to the upload
-- its reservation registered, otherwise cancelled and the draft expired).
CREATE OR REPLACE FUNCTION public.tbu_sweeper_claim(p_kind text, p_target_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_path text;
  v_state text;
  v_draft public.trial_balance_drafts%ROWTYPE;
  v_commit public.trial_balance_draft_commits%ROWTYPE;
  v_upload uuid;
BEGIN
  IF p_kind = 'discard' THEN
    RETURN CASE WHEN public.tbu_claim_discard_purge(p_target_id) = 'claimed' THEN 'claimed' ELSE 'not_eligible' END;
  ELSIF p_kind = 'cancel_replacement' THEN
    SELECT o.file_path INTO v_path FROM public.trial_balance_upload_operations o
     WHERE o.id = p_target_id AND o.kind = 'cancel_replacement' AND o.state = 'storage_cleanup_pending' FOR UPDATE;
    RETURN CASE WHEN v_path IS NOT NULL AND NOT public.tbu_object_referenced(v_path) THEN 'claimed' ELSE 'not_eligible' END;
  ELSIF p_kind = 'reservation' THEN
    SELECT s.object_path INTO v_path FROM public.trial_balance_source_reservations s
     WHERE s.id = p_target_id AND s.consumed_at IS NULL AND s.expires_at <= now() - public.tbu_reservation_sweep_grace() FOR UPDATE;
    RETURN CASE WHEN v_path IS NOT NULL AND NOT public.tbu_object_referenced(v_path) THEN 'claimed' ELSE 'not_eligible' END;
  ELSIF p_kind = 'source_object' THEN
    SELECT so.state INTO v_state FROM public.tb_source_objects so WHERE so.id = p_target_id FOR UPDATE;
    IF v_state NOT IN ('active', 'purge_pending') OR NOT public.tbu_source_object_unreferenced(p_target_id) THEN
      RETURN 'not_eligible';
    END IF;
    IF v_state = 'active' THEN
      UPDATE public.tb_source_objects so SET state = 'purge_pending', purge_claimed_at = now() WHERE so.id = p_target_id;
    END IF;
    RETURN 'claimed';
  -- [20261106100000]
  ELSIF p_kind = 'draft' THEN
    SELECT * INTO v_draft FROM public.trial_balance_drafts t WHERE t.id = p_target_id FOR UPDATE;
    IF v_draft.id IS NULL OR v_draft.swept_at IS NOT NULL
       OR (v_draft.state IN ('reserved', 'expired') AND v_draft.expires_at > now() AND v_draft.owner_user_id IS NOT NULL)
       OR (v_draft.state = 'committing' AND (v_draft.expires_at > now() OR NOT public.tbd_commit_abandoned(v_draft.id)))
       OR public.tbu_object_referenced(v_draft.object_path) THEN
      RETURN 'not_eligible';
    END IF;
    IF v_draft.state = 'committing' THEN
      SELECT * INTO v_commit FROM public.trial_balance_draft_commits k WHERE k.draft_id = v_draft.id AND k.state = 'open' FOR UPDATE;
      SELECT r.consumed_by_upload_id INTO v_upload FROM public.trial_balance_source_reservations r
       WHERE r.id = v_commit.reservation_id AND r.consumed_at IS NOT NULL;
      IF v_upload IS NOT NULL THEN
        UPDATE public.trial_balance_draft_commits k SET state = 'committed', upload_id = v_upload, settled_at = now() WHERE k.id = v_commit.id;
        UPDATE public.trial_balance_drafts t SET state = 'committed', committed_upload_id = v_upload, committed_at = now() WHERE t.id = v_draft.id;
      ELSE
        UPDATE public.trial_balance_draft_commits k SET state = 'cancelled', settled_at = now() WHERE k.id = v_commit.id;
        UPDATE public.trial_balance_drafts t SET state = 'expired' WHERE t.id = v_draft.id;
      END IF;
    ELSIF v_draft.state = 'reserved' THEN
      UPDATE public.trial_balance_drafts t SET state = 'expired' WHERE t.id = v_draft.id;
    END IF;
    RETURN 'claimed';
  END IF;
  RETURN 'not_eligible';
END;
$$;

-- 20261011100000's completion, plus [20261106100000] 'draft'.
CREATE OR REPLACE FUNCTION public.tbu_sweeper_complete(p_kind text, p_target_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_op public.trial_balance_upload_operations%ROWTYPE;
  v_res public.trial_balance_source_reservations%ROWTYPE;
  v_obj public.tb_source_objects%ROWTYPE;
  v_upload uuid;
  v_draft public.trial_balance_drafts%ROWTYPE;
BEGIN
  IF p_kind = 'stale_discard' THEN
    -- S2 lock order: the upload (L4) before the operation (L6).
    SELECT o.upload_id INTO v_upload FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard';
    PERFORM 1 FROM public.trial_balance_uploads t WHERE t.id = v_upload FOR UPDATE;
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = 'discard' FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_op.state <> 'pending' OR v_op.created_at > now() - public.tbu_stale_discard_grace() THEN RETURN 'not_eligible'; END IF;
    RETURN public.tbu_abort_discard(v_op.id, 'engine', NULL, 'Discard never completed; resolved by the scheduled source sweeper');
  END IF;

  IF p_kind IN ('discard', 'cancel_replacement') THEN
    SELECT * INTO v_op FROM public.trial_balance_upload_operations o WHERE o.id = p_target_id AND o.kind = p_kind FOR UPDATE;
    IF v_op.id IS NULL THEN RETURN 'stale'; END IF;

    IF p_kind = 'discard' THEN
      IF v_op.state = 'purged' THEN RETURN 'already_done'; END IF;
      IF v_op.state NOT IN ('completed', 'purging') OR v_op.completed_at > now() - public.tbu_undo_window() THEN RETURN 'not_eligible'; END IF;
      IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
      UPDATE public.trial_balance_upload_operations o SET state = 'purged' WHERE o.id = v_op.id;
      PERFORM public.tbu_log_event(v_op.upload_id, v_op.company_id, NULL, v_op.period_year, 'discarded', 'discarded',
        'engine', NULL, NULL, 'engine', NULL, 'applied', v_op.id, 'Discarded source purged by the scheduled source sweeper after the undo window');
      RETURN 'purged';
    END IF;

    IF v_op.state = 'completed' THEN RETURN 'already_done'; END IF;
    IF v_op.state <> 'storage_cleanup_pending' THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_op.file_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_upload_operations o SET state = 'completed', completed_at = now() WHERE o.id = v_op.id;
    RETURN 'completed';
  END IF;

  IF p_kind = 'reservation' THEN
    SELECT * INTO v_res FROM public.trial_balance_source_reservations s WHERE s.id = p_target_id FOR UPDATE;
    IF v_res.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_res.consumed_at IS NOT NULL OR v_res.expires_at > now() - public.tbu_reservation_sweep_grace() THEN RETURN 'not_eligible'; END IF;
    IF public.tbu_storage_object_exists(v_res.object_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_source_reservations s SET swept_at = now() WHERE s.id = v_res.id;
    RETURN 'reclaimed';
  END IF;

  IF p_kind = 'source_object' THEN
    SELECT * INTO v_obj FROM public.tb_source_objects so WHERE so.id = p_target_id FOR UPDATE;
    IF v_obj.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_obj.state = 'purged' THEN RETURN 'already_done'; END IF;
    IF NOT public.tbu_source_object_unreferenced(v_obj.id) THEN
      IF v_obj.state = 'purge_pending' THEN
        UPDATE public.tb_source_objects so SET state = 'active', purge_claimed_at = NULL WHERE so.id = v_obj.id;
      END IF;
      RETURN 'not_eligible';
    END IF;
    IF public.tbu_storage_object_exists(v_obj.storage_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.tb_source_objects so SET state = 'purged', purged_at = now() WHERE so.id = v_obj.id;
    RETURN 'purged';
  END IF;

  -- [20261106100000] a draft's own drafts/ object is gone: the draft is swept (its row and history are kept).
  IF p_kind = 'draft' THEN
    SELECT * INTO v_draft FROM public.trial_balance_drafts t WHERE t.id = p_target_id FOR UPDATE;
    IF v_draft.id IS NULL THEN RETURN 'stale'; END IF;
    IF v_draft.swept_at IS NOT NULL THEN RETURN 'already_done'; END IF;
    -- (A draft with no object to delete reaches here without a claim, so expiry is also applied here.)
    IF v_draft.state = 'committing'
       OR (v_draft.state IN ('reserved', 'expired') AND v_draft.expires_at > now() AND v_draft.owner_user_id IS NOT NULL) THEN
      RETURN 'not_eligible';
    END IF;
    IF public.tbu_storage_object_exists(v_draft.object_path) THEN RETURN 'storage_cleanup_pending'; END IF;
    UPDATE public.trial_balance_drafts t
       SET swept_at = now(), state = CASE WHEN t.state = 'reserved' THEN 'expired' ELSE t.state END
     WHERE t.id = v_draft.id;
    RETURN 'reclaimed';
  END IF;

  RETURN 'invalid_request';
END;
$function$;
