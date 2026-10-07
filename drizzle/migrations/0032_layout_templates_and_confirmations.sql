-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- I1-A (workbench A2): layout templates, layout confirmations and the '#layout_confirmation' dependency.
--
--   1. layout_templates (layout-template/1) — reusable, versioned manual layouts of a trial-balance file: sheet, header
--      row, the header of each column, the number format and (single Balance column) the sign convention. A template
--      carries no source hash and no row data. Insert-only: an edit is a new version of the same template_key.
--   2. layout_confirmations (layout-confirmation/1) — a person's confirmation that one layout reads one uploaded file:
--      bound to the upload's source hash and to the SHA-256 of the layout resolved against that file (exact column
--      positions). It records the server's full-file validation and the disposition of EVERY source row. Append-only
--      for every role; the newest confirmation of an upload is the one processing uses.
--   3. A new confirmation bumps the dependency '#layout_confirmation:<upload id>' (company scope), so a current result
--      built under another layout becomes "Needs re-check" (S2 read-time authority, unchanged).
--   4. public.layout_save_template / public.layout_record_confirmation — the only writers (service_role, called by the
--      trial-balance-layout Edge Function after it has validated the file itself). The actor is derived here from the
--      signed-in user (tbu_resolve_processing_actor) and needs the prepare_close capability and a current plan.
--   5. tb_snapshot_dependencies accepts the new key (for the run's own upload only); tb_begin_attempt refuses an
--      engine generation below 4 for an upload that has a layout confirmation (an older handler cannot read layouts),
--      before anything is written.
--
-- PREFLIGHT: none of the objects exist yet; the migration refuses if they do (nothing is replaced silently).
-- Release order: this migration → process-trial-balance (generation 4) → trial-balance-layout → frontend. A generation-4
-- handler on a database without this migration refuses before any write (LAYOUT_AUTHORITY_UNAVAILABLE).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.layout_templates') IS NOT NULL OR to_regclass('public.layout_confirmations') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: layout tables already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Templates ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.layout_templates (
  id             UUID        NOT NULL DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL,
  template_key   UUID        NOT NULL,
  version        INTEGER     NOT NULL,
  name           TEXT        NOT NULL,
  format         TEXT        NOT NULL DEFAULT 'layout-template/1',
  profile        JSONB       NOT NULL,
  profile_sha256 TEXT        NOT NULL,
  actor_type     TEXT        NOT NULL,
  firm_member_id UUID        NULL,
  actor_user_id  UUID        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT layout_templates_pkey PRIMARY KEY (id),
  CONSTRAINT fk_lt_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lt_member FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT uq_lt_version UNIQUE (template_key, version),
  CONSTRAINT chk_lt_version CHECK (version > 0),
  CONSTRAINT chk_lt_name CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT chk_lt_format CHECK (format = 'layout-template/1'),
  CONSTRAINT chk_lt_profile CHECK (jsonb_typeof(profile) = 'object' AND profile->>'format' = 'layout-template/1'
                                   AND NOT (profile ? 'sourceFileHash') AND NOT (profile ? 'source_file_hash')),
  CONSTRAINT chk_lt_sha CHECK (profile_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_lt_actor CHECK (
    (actor_type = 'user'           AND firm_member_id IS NOT NULL AND actor_user_id IS NULL) OR
    (actor_type = 'workspace_user' AND actor_user_id  IS NOT NULL AND firm_member_id IS NULL))
);
CREATE INDEX idx_lt_company ON public.layout_templates (company_id, template_key, version DESC);
COMMENT ON TABLE public.layout_templates IS
  'layout-template/1: reusable, versioned manual layouts (no source hash, no row data). Insert-only; written only by public.layout_save_template.';

-- ── 2. Confirmations ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.layout_confirmations (
  id                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  upload_id               UUID        NOT NULL,
  company_id              UUID        NOT NULL,
  confirmation_no         INTEGER     NOT NULL,
  format                  TEXT        NOT NULL DEFAULT 'layout-confirmation/1',
  source_file_hash        TEXT        NOT NULL,
  profile                 JSONB       NOT NULL,
  profile_sha256          TEXT        NOT NULL,
  resolved_profile        JSONB       NOT NULL,
  resolved_profile_sha256 TEXT        NOT NULL,
  template_id             UUID        NULL,
  validation              JSONB       NOT NULL,
  row_dispositions        JSONB       NOT NULL,
  rows_read               INTEGER     NOT NULL,
  actor_type              TEXT        NOT NULL,
  firm_member_id          UUID        NULL,
  actor_user_id           UUID        NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT layout_confirmations_pkey PRIMARY KEY (id),
  CONSTRAINT fk_lc_upload FOREIGN KEY (upload_id) REFERENCES public.trial_balance_uploads(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lc_company FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lc_template FOREIGN KEY (template_id) REFERENCES public.layout_templates(id) ON DELETE RESTRICT,
  CONSTRAINT fk_lc_member FOREIGN KEY (firm_member_id) REFERENCES public.firm_members(id) ON DELETE RESTRICT,
  CONSTRAINT uq_lc_sequence UNIQUE (upload_id, confirmation_no),
  CONSTRAINT chk_lc_no CHECK (confirmation_no > 0),
  CONSTRAINT chk_lc_format CHECK (format = 'layout-confirmation/1'),
  CONSTRAINT chk_lc_hashes CHECK (source_file_hash ~ '^[0-9a-f]{64}$' AND profile_sha256 ~ '^[0-9a-f]{64}$'
                                  AND resolved_profile_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_lc_profile CHECK (jsonb_typeof(profile) = 'object' AND profile->>'format' = 'layout-template/1'),
  CONSTRAINT chk_lc_resolved CHECK (jsonb_typeof(resolved_profile) = 'object' AND resolved_profile->>'format' = 'layout-resolved/1'
                                    AND resolved_profile->>'profileSha256' = profile_sha256),
  CONSTRAINT chk_lc_validation CHECK (jsonb_typeof(validation) = 'object'),
  CONSTRAINT chk_lc_rows CHECK (jsonb_typeof(row_dispositions) = 'array' AND rows_read = jsonb_array_length(row_dispositions)),
  CONSTRAINT chk_lc_actor CHECK (
    (actor_type = 'user'           AND firm_member_id IS NOT NULL AND actor_user_id IS NULL) OR
    (actor_type = 'workspace_user' AND actor_user_id  IS NOT NULL AND firm_member_id IS NULL))
);
CREATE INDEX idx_lc_company ON public.layout_confirmations (company_id, upload_id, confirmation_no DESC);
COMMENT ON TABLE public.layout_confirmations IS
  'layout-confirmation/1: append-only; one row per confirmation of a layout for one uploaded file (source hash + resolved layout hash), with the full-file validation and every source row''s disposition. The newest row (highest confirmation_no) is the layout processing uses.';

-- Append-only for every role, and inserted only by the recording function (marker scoped to its transaction).
CREATE OR REPLACE FUNCTION public.layout_records_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(current_setting('axiom.layout_writer', true), '') <> txid_current()::text THEN
      RAISE EXCEPTION 'LAYOUT_RECORD_FENCED: % rows are written only by the layout functions', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: % is append-only. % is not permitted.', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.layout_records_fence() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_lt_fence BEFORE INSERT OR UPDATE OR DELETE ON public.layout_templates
  FOR EACH ROW EXECUTE FUNCTION public.layout_records_fence();
CREATE TRIGGER trg_lt_no_truncate BEFORE TRUNCATE ON public.layout_templates
  FOR EACH STATEMENT EXECUTE FUNCTION public.layout_records_fence();
CREATE TRIGGER trg_lc_fence BEFORE INSERT OR UPDATE OR DELETE ON public.layout_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.layout_records_fence();
CREATE TRIGGER trg_lc_no_truncate BEFORE TRUNCATE ON public.layout_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION public.layout_records_fence();

ALTER TABLE public.layout_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layout_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.layout_templates, public.layout_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.layout_templates, public.layout_confirmations TO authenticated, service_role;
CREATE POLICY lt_workspace_read ON public.layout_templates FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));
CREATE POLICY lc_workspace_read ON public.layout_confirmations FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));

-- ── 3. Writers ───────────────────────────────────────────────────────────────────────────────────────────────────────
-- The actor of a layout write: the same processing authority as process-trial-balance (tbu_resolve_processing_actor),
-- plus prepare_close and a current plan. NULL when the user may not write layouts in this workspace.
CREATE OR REPLACE FUNCTION public._layout_actor(p_user_id uuid, p_company_id uuid)
RETURNS TABLE (actor_type text, firm_member_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL
     OR NOT public.workspace_capability_allowed(p_company_id, p_user_id, 'prepare_close') THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT a.actor_type, a.firm_member_id FROM public.tbu_resolve_processing_actor(p_user_id, p_company_id) a LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION public._layout_actor(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Saves version 1 of a new template (p_expected_version 0, a template key chosen by the caller) or the next version of
-- an existing one (expected version = its newest version). A retry of a recorded save replays it.
CREATE OR REPLACE FUNCTION public.layout_save_template(
  p_user_id uuid, p_company_id uuid, p_template_key uuid, p_expected_version integer, p_name text, p_profile jsonb,
  p_profile_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_actor record;
  v_latest public.layout_templates%ROWTYPE;
  v_version integer;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL OR p_template_key IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_profile IS NULL OR p_profile_sha256 IS NULL OR p_name IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_actor FROM public._layout_actor(p_user_id, p_company_id);
  IF v_actor.actor_type IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('layout_templates:' || p_template_key::text, 0));
  IF EXISTS (SELECT 1 FROM public.layout_templates t WHERE t.template_key = p_template_key AND t.company_id <> p_company_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'TEMPLATE_NOT_FOUND');
  END IF;
  SELECT * INTO v_latest FROM public.layout_templates t WHERE t.template_key = p_template_key ORDER BY t.version DESC LIMIT 1;
  IF coalesce(v_latest.version, 0) <> p_expected_version THEN
    IF v_latest.id IS NOT NULL AND v_latest.version = p_expected_version + 1
       AND v_latest.profile_sha256 = p_profile_sha256 AND v_latest.name = btrim(p_name) THEN
      RETURN jsonb_build_object('outcome', 'saved', 'templateId', v_latest.id, 'templateKey', p_template_key,
                                'version', v_latest.version, 'replay', true);
    END IF;
    IF v_latest.id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'TEMPLATE_NOT_FOUND');
    END IF;
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'VERSION_CONFLICT', 'currentVersion', v_latest.version);
  END IF;
  IF v_latest.id IS NOT NULL AND v_latest.profile_sha256 = p_profile_sha256 AND v_latest.name = btrim(p_name) THEN
    RETURN jsonb_build_object('outcome', 'saved', 'templateId', v_latest.id, 'templateKey', p_template_key,
                              'version', v_latest.version, 'unchanged', true);
  END IF;
  v_version := coalesce(v_latest.version, 0) + 1;
  PERFORM set_config('axiom.layout_writer', txid_current()::text, true);
  INSERT INTO public.layout_templates (company_id, template_key, version, name, profile, profile_sha256, actor_type,
                                       firm_member_id, actor_user_id)
  VALUES (p_company_id, p_template_key, v_version, btrim(p_name), p_profile, p_profile_sha256, v_actor.actor_type,
          CASE WHEN v_actor.actor_type = 'user' THEN v_actor.firm_member_id END,
          CASE WHEN v_actor.actor_type = 'workspace_user' THEN p_user_id END)
  RETURNING id INTO v_id;
  PERFORM set_config('axiom.layout_writer', '', true);
  RETURN jsonb_build_object('outcome', 'saved', 'templateId', v_id, 'templateKey', p_template_key, 'version', v_version);
END;
$$;
REVOKE ALL ON FUNCTION public.layout_save_template(uuid, uuid, uuid, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.layout_save_template(uuid, uuid, uuid, integer, text, jsonb, text) TO service_role;

-- Records a confirmation. Serialized with tb_begin_attempt (same per-upload lock), so a confirmation never lands inside
-- an attempt's window unnoticed: the handler re-reads the newest confirmation after its dependency snapshot.
CREATE OR REPLACE FUNCTION public.layout_record_confirmation(
  p_user_id uuid, p_upload_id uuid, p_expected_confirmation_no integer, p_source_file_hash text, p_profile jsonb,
  p_profile_sha256 text, p_resolved_profile jsonb, p_resolved_profile_sha256 text, p_template_id uuid,
  p_validation jsonb, p_row_dispositions jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_actor record;
  v_latest public.layout_confirmations%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_cert uuid;
  v_cert_run uuid;
  v_id uuid;
  v_no integer;
BEGIN
  IF p_user_id IS NULL OR p_upload_id IS NULL OR p_expected_confirmation_no IS NULL OR p_expected_confirmation_no < 0
     OR p_source_file_hash IS NULL OR p_profile IS NULL OR p_profile_sha256 IS NULL OR p_resolved_profile IS NULL
     OR p_resolved_profile_sha256 IS NULL OR p_validation IS NULL OR p_row_dispositions IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  -- The server's own validation must have found the layout fits the file.
  IF coalesce((p_validation->>'layoutFits')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'LAYOUT_DOES_NOT_FIT');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tb_begin_attempt'), hashtext(p_upload_id::text));
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.id IS NULL OR v_row.company_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND');
  END IF;
  SELECT * INTO v_actor FROM public._layout_actor(p_user_id, v_row.company_id);
  IF v_actor.actor_type IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'FORBIDDEN');
  END IF;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_ACTIVE');
  END IF;
  IF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_source_file_hash THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'SOURCE_CHANGED');
  END IF;
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id;
    IF v_cur.status = 'running' AND v_cur.lease_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS');
    END IF;
  END IF;
  -- A certification in force that did not record this upload's layout dependency (made before layouts existed) cannot
  -- be marked stale by a confirmation: a re-check is requested first (tbu_request_reprocess).
  SELECT c.id, c.engine_run_id INTO v_cert, v_cert_run FROM public.tb_certifications c
   WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert)
     AND NOT EXISTS (SELECT 1 FROM public.engine_run_dependencies d
                      WHERE d.engine_run_id = v_cert_run AND d.scope = v_row.company_id::text
                        AND d.dep_key = '#layout_confirmation:' || p_upload_id::text) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REPROCESS_REQUIRED');
  END IF;
  IF p_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.layout_templates t WHERE t.id = p_template_id AND t.company_id = v_row.company_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'TEMPLATE_NOT_FOUND');
  END IF;

  SELECT * INTO v_latest FROM public.layout_confirmations c WHERE c.upload_id = p_upload_id ORDER BY c.confirmation_no DESC LIMIT 1;
  IF coalesce(v_latest.confirmation_no, 0) <> p_expected_confirmation_no THEN
    -- The same confirmation retried after it was recorded replays it (idempotent); anything else is a conflict.
    IF v_latest.id IS NOT NULL AND v_latest.confirmation_no = p_expected_confirmation_no + 1
       AND v_latest.resolved_profile_sha256 = p_resolved_profile_sha256 AND v_latest.source_file_hash = p_source_file_hash
       AND v_latest.template_id IS NOT DISTINCT FROM p_template_id THEN
      RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_latest.id, 'confirmationNo', v_latest.confirmation_no, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'VERSION_CONFLICT', 'currentConfirmationNo', coalesce(v_latest.confirmation_no, 0));
  END IF;
  IF v_latest.id IS NOT NULL AND v_latest.resolved_profile_sha256 = p_resolved_profile_sha256
     AND v_latest.source_file_hash = p_source_file_hash AND v_latest.template_id IS NOT DISTINCT FROM p_template_id THEN
    RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_latest.id, 'confirmationNo', v_latest.confirmation_no, 'unchanged', true);
  END IF;

  v_no := coalesce(v_latest.confirmation_no, 0) + 1;
  PERFORM set_config('axiom.layout_writer', txid_current()::text, true);
  INSERT INTO public.layout_confirmations (upload_id, company_id, confirmation_no, source_file_hash, profile, profile_sha256,
                                           resolved_profile, resolved_profile_sha256, template_id, validation,
                                           row_dispositions, rows_read, actor_type, firm_member_id, actor_user_id)
  VALUES (p_upload_id, v_row.company_id, v_no, p_source_file_hash, p_profile, p_profile_sha256, p_resolved_profile,
          p_resolved_profile_sha256, p_template_id, p_validation, p_row_dispositions, jsonb_array_length(p_row_dispositions),
          v_actor.actor_type, CASE WHEN v_actor.actor_type = 'user' THEN v_actor.firm_member_id END,
          CASE WHEN v_actor.actor_type = 'workspace_user' THEN p_user_id END)
  RETURNING id INTO v_id;
  PERFORM set_config('axiom.layout_writer', '', true);
  PERFORM public._tb_bump_dependency(v_row.company_id::text, '#layout_confirmation:' || p_upload_id::text);
  RETURN jsonb_build_object('outcome', 'confirmed', 'confirmationId', v_id, 'confirmationNo', v_no);
END;
$$;
REVOKE ALL ON FUNCTION public.layout_record_confirmation(uuid, uuid, integer, text, jsonb, text, jsonb, text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.layout_record_confirmation(uuid, uuid, integer, text, jsonb, text, jsonb, text, uuid, jsonb, jsonb) TO service_role;

-- ── 4. S2 functions: the new dependency key, and the engine generation that can read layouts ─────────────────────────
-- Each is its S2 (20261008100000) definition with exactly the marked lines changed (layoutMigrationContract.test.ts).
CREATE OR REPLACE FUNCTION public.tb_snapshot_dependencies(p_engine_run_id uuid, p_keys jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run public.engine_runs%ROWTYPE;
  r record;
  v_n integer := 0;
BEGIN
  IF p_keys IS NULL OR jsonb_typeof(p_keys) <> 'array' OR jsonb_array_length(p_keys) = 0 OR jsonb_array_length(p_keys) > 20000 THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_run FROM public.engine_runs er WHERE er.id = p_engine_run_id;
  IF v_run.id IS NULL OR v_run.attempt_no IS NULL OR v_run.status <> 'running'
     OR NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.id = v_run.source_record_id AND t.current_engine_run_id = v_run.id) THEN
    RAISE EXCEPTION 'ATTEMPT_NOT_CURRENT' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS (SELECT 1 FROM public.engine_run_dependencies d WHERE d.engine_run_id = p_engine_run_id) THEN
    RAISE EXCEPTION 'DEPENDENCIES_ALREADY_RECORDED' USING ERRCODE = '55000';
  END IF;
  -- Each entry must be this company's scope or the shared scope, with a known key form.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e
              WHERE jsonb_typeof(e) <> 'object' OR (e->>'scope') IS NULL OR (e->>'key') IS NULL
                 OR (e->>'scope') NOT IN (v_run.company_id::text, 'global')
                 OR (e->>'key') !~ '^(code:.+|name:.*|#framework|#currency|#dictionary|#layout_confirmation:[0-9a-f-]{36})$'
                 -- A2: the layout key names the run's own upload, in the company's scope.
                 OR ((e->>'key') LIKE '#layout_confirmation:%' AND ((e->>'scope') <> v_run.company_id::text
                      OR substring(e->>'key' FROM 22) <> v_run.source_record_id::text))) THEN
    RAISE EXCEPTION 'INVALID_DEPENDENCIES' USING ERRCODE = '22023';
  END IF;
  -- L2: the review RPC's per-account advisory lock (company scope), in sorted order, so a review in flight on the same
  -- account completes first. Shared-chart keys are not written by the review RPC.
  FOR r IN
    SELECT DISTINCT substring(e->>'key' FROM 6) AS k
      FROM jsonb_array_elements(p_keys) e
     WHERE e->>'scope' = v_run.company_id::text AND (e->>'key' LIKE 'code:%' OR e->>'key' LIKE 'name:%')
     ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_run.company_id::text), hashtext(r.k));
  END LOOP;
  INSERT INTO public.engine_run_dependencies (engine_run_id, scope, dep_key, revision)
  SELECT DISTINCT ON (e->>'scope', e->>'key') p_engine_run_id, e->>'scope', e->>'key', coalesce(rv.revision, 0)
    FROM jsonb_array_elements(p_keys) e
    LEFT JOIN public.tb_dependency_revisions rv ON rv.scope = e->>'scope' AND rv.dep_key = e->>'key'
   ORDER BY e->>'scope', e->>'key';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('recorded', v_n);
END;
$$;

CREATE OR REPLACE FUNCTION public.tb_begin_attempt(
  p_upload_id uuid, p_client_request_id uuid, p_request_hash text, p_input_hash text, p_source_file_hash text,
  p_engine_version text, p_engine_generation integer, p_actor_type text, p_firm_member_id uuid, p_actor_user_id uuid,
  p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_row public.trial_balance_uploads%ROWTYPE;
  v_key public.idempotency_keys%ROWTYPE;
  v_cur public.engine_runs%ROWTYPE;
  v_cert uuid;
  v_run uuid;
  v_started timestamptz;
  v_key_id uuid;
  v_attempt integer;
  v_constraint text;
BEGIN
  IF p_upload_id IS NULL OR p_client_request_id IS NULL OR p_request_hash IS NULL OR p_engine_version IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF p_source_file_hash IS NULL OR p_source_file_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'INVALID_LEASE' USING ERRCODE = '22023';
  END IF;

  -- L1: one begin per upload at a time.
  PERFORM pg_advisory_xact_lock(hashtext('tb_begin_attempt'), hashtext(p_upload_id::text));

  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_FOUND');
  END IF;
  IF v_row.company_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'COMPANY_REQUIRED');
  END IF;
  -- A2: an engine generation below 4 cannot read layout confirmations, so it never processes an upload that has one
  -- (refused here, before anything is written).
  IF coalesce(p_engine_generation, 0) < 4 AND EXISTS (SELECT 1 FROM public.layout_confirmations lc WHERE lc.upload_id = p_upload_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'LAYOUT_REQUIRES_CURRENT_ENGINE');
  END IF;

  -- Idempotency: the same request replays its recorded outcome; reuse with other content is a conflict.
  SELECT * INTO v_key FROM public.idempotency_keys k
   WHERE k.company_id = v_row.company_id AND k.function_name = 'process-trial-balance'
     AND k.client_request_id = p_client_request_id
     AND k.firm_member_id IS NOT DISTINCT FROM p_firm_member_id AND k.actor_user_id IS NOT DISTINCT FROM p_actor_user_id;
  IF v_key.id IS NOT NULL THEN
    IF v_key.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
    END IF;
    IF v_key.status = 'reserved' THEN
      RETURN jsonb_build_object('outcome', 'in_progress', 'engine_run_id', v_key.engine_run_id);
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'result', coalesce(v_key.replay_result, jsonb_build_object('status', v_key.status)));
  END IF;

  -- L4: the upload.
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
  IF v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'UPLOAD_NOT_ACTIVE');
  END IF;
  IF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_source_file_hash THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'SOURCE_CHANGED');
  END IF;
  -- A new attempt never runs over a certification still in force: re-checks go through tbu_request_reprocess first.
  SELECT c.id INTO v_cert FROM public.tb_certifications c WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'REPROCESS_REQUIRED');
  END IF;
  -- L7: the current attempt, if one is running.
  IF v_row.current_engine_run_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM public.engine_runs er WHERE er.id = v_row.current_engine_run_id FOR UPDATE;
    IF v_cur.status = 'running' THEN
      IF v_cur.lease_expires_at > now() THEN
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS', 'engine_run_id', v_cur.id);
      END IF;
      PERFORM public._tb_abandon_run(v_cur.id, 'LEASE_EXPIRED');
    END IF;
  END IF;

  PERFORM public._tb_attempt_writer(true);
  v_attempt := v_row.processing_attempt + 1;
  -- The run, its key and the upload's pointer are one unit: the same request id claimed concurrently for ANOTHER upload
  -- (the per-upload lock above does not serialize that) loses on uq_ik_claim and is a recorded conflict, with nothing left
  -- behind — never a raw error.
  BEGIN
    INSERT INTO public.engine_runs (company_id, firm_member_id, actor_user_id, actor_type, function_name, engine_version,
                                    engine_generation, input_hash, period_year, source_table, source_record_id, attempt_no,
                                    lease_expires_at)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance', p_engine_version,
            p_engine_generation, p_input_hash, v_row.period_year, 'trial_balance_uploads', p_upload_id, v_attempt,
            now() + make_interval(secs => p_lease_seconds))
    RETURNING id, started_at INTO v_run, v_started;
    INSERT INTO public.idempotency_keys (company_id, firm_member_id, actor_user_id, actor_type, function_name,
                                         client_request_id, request_hash, input_hash, engine_run_id)
    VALUES (v_row.company_id, p_firm_member_id, p_actor_user_id, p_actor_type, 'process-trial-balance',
            p_client_request_id, p_request_hash, p_input_hash, v_run)
    RETURNING id INTO v_key_id;
    UPDATE public.trial_balance_uploads t
       SET current_engine_run_id = v_run, processing_attempt = v_attempt, status = 'validating',
           source_file_hash = coalesce(t.source_file_hash, p_source_file_hash)
     WHERE t.id = p_upload_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'uq_ik_claim' THEN RAISE; END IF;
    PERFORM public._tb_attempt_writer(false);
    RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED');
  END;
  PERFORM public._tb_attempt_writer(false);

  RETURN jsonb_build_object('outcome', 'claimed', 'engine_run_id', v_run, 'key_id', v_key_id, 'started_at', v_started,
                            'attempt_no', v_attempt, 'prior_status', v_row.status);
END;
$$;
