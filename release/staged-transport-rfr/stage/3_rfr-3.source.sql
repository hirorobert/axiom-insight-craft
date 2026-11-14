INSERT INTO cfoclose_rfr_release.staged_artifacts(batch, kind, body) VALUES ('rfr-3', 'source', $cfoclose_rfr_stage_5374bb124399bfd3$-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Ready for Reporting — pilot (rfr-acceptance/2). AUTHORED, NOT APPLIED to any hosted database.
--
--   A reporting scope (company, period) OPTS IN by recording a scope event. From then on FINAL is blocked until the
--   readiness engine's latest run is CURRENT (its content digest equals the digest recomputed from rows, here, under the
--   scope lock) and every required scope is READY, the REVIEWED mark bound the same content, and — for QuickBooks-bound
--   inputs — a separate expiring source-freshness attestation is bound to that content. Scopes that never opted in are
--   unchanged: nothing here alters an existing workspace.
--
--   Authority: the engine runs in an Edge Function (service role) over rows loaded by rfr_load_inputs and records its result
--   with rfr_record_run, which refuses a run made over stale rows. The browser reads (rfr_status) and writes only evidence
--   and proposals through the functions below; it never writes a financial table.
--
--   Locks. Every writer of a manifest input takes the SCOPE lock (_fs_scope_lock) before it writes, exactly like the FINAL
--   transition: the existing adjustment writers get a trigger that takes it as their rows are written. So a change either
--   commits before FINAL recomputes (FINAL refuses RFR_MANIFEST_STALE) or waits until FINAL has committed (the issued
--   manifest is unchanged and the next version sees the change). Lock order everywhere: [per-adjustment lock] -> company
--   (shared) -> scope. FINAL takes the scope lock first and no writer's per-adjustment lock, so there is no cycle.
--
--   Content vs freshness (audit defect D5). The content digest covers the certification, the applied adjustments, the scope
--   facts and every current input's payload hash. It does NOT cover pull times or pull ids, so a re-pull of identical books
--   leaves it unchanged. The REVIEWED mark records the digest it saw; FINAL must present the same digest. Freshness is a
--   separate attestation, bound to the digest, that expires after ten minutes.
--
-- PREFLIGHT: the objects do not exist yet; the migration refuses if they do.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
BEGIN
  IF to_regclass('public.rfr_scope_events') IS NOT NULL OR to_regclass('public.rfr_inputs') IS NOT NULL OR to_regclass('public.rfr_runs') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: ready-for-reporting objects already exist; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public._fs_scope_lock(uuid,integer)') IS NULL OR to_regprocedure('public.fs_publication_blockers(uuid,text,integer)') IS NULL
     OR to_regprocedure('public._cr_certified_accounts(uuid)') IS NULL OR to_regprocedure('public.close_review_propose_adjustment(uuid,integer,text,text,jsonb,uuid[],uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the reporting and close-review authority this migration builds on is absent' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Tables (append-only; no client write path) ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rfr_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'RFR_APPEND_ONLY: % rows are never changed or removed', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

CREATE TABLE public.rfr_scope_events (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq               BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id        UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year       INTEGER     NOT NULL CHECK (period_year BETWEEN 1990 AND 2200),
  rule_pack_id      TEXT        NOT NULL CHECK (rule_pack_id = 'rfr-pilot-ipsas-accrual'),
  rule_pack_version TEXT        NOT NULL CHECK (rule_pack_version = '1.0.0'),
  facts             JSONB       NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  facts_sha256      TEXT        NOT NULL CHECK (facts_sha256 ~ '^[0-9a-f]{64}$'),
  reason            TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  actor_user_id     UUID        NOT NULL,
  firm_member_id    UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_rfr_scope_events ON public.rfr_scope_events (company_id, period_year, seq DESC);

CREATE TABLE public.rfr_inputs (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL,
  family          TEXT        NOT NULL CHECK (family IN ('ledger_snapshot', 'bank_account', 'evidence', 'opening_bridge', 'cutoff', 'double_charge', 'entry_support', 'deposit', 'obe', 'population', 'citation')),
  key             TEXT        NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  withdrawn       BOOLEAN     NOT NULL DEFAULT false,
  payload         JSONB       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- Computed HERE from the stored payload: the content authority never trusts a hash the caller supplied.
  payload_sha256  TEXT        NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  source          TEXT        NOT NULL CHECK (source IN ('export_file', 'qbo_api', 'manual')),
  file_sha256     TEXT        NULL CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  reason          TEXT        NULL CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 1000),
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  request_id      UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_rfr_inputs_request UNIQUE (actor_user_id, request_id),
  CONSTRAINT chk_rfr_inputs_size CHECK (octet_length(payload::text) <= 8000000),
  CONSTRAINT chk_rfr_inputs_withdrawn_reason CHECK (NOT withdrawn OR reason IS NOT NULL)
);
CREATE INDEX idx_rfr_inputs_current ON public.rfr_inputs (company_id, period_year, family, key, seq DESC);

-- A stable correction identity bound to ONE adjustment. The adjustment (close_review_adjustments) stays the only
-- authority for lines, approval and binding; this row only says which correction it carries out.
CREATE TABLE public.rfr_corrections (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL,
  correction_id   TEXT        NOT NULL CHECK (length(correction_id) BETWEEN 3 AND 200),
  adjustment_id   UUID        NOT NULL UNIQUE REFERENCES public.close_review_adjustments (id) ON DELETE RESTRICT,
  scope           TEXT        NOT NULL CHECK (length(scope) BETWEEN 1 AND 100),
  anchor          TEXT[]      NOT NULL DEFAULT '{}',
  -- Corrections of one bundle are verified in the source TOGETHER: a QuickBooks journal fixes their net effect.
  bundle          TEXT        NULL CHECK (bundle IS NULL OR length(bundle) BETWEEN 3 AND 200),
  -- A residual correction names the declined correction (or bundle) whose partial source fix it completes.
  supersedes      TEXT        NULL CHECK (supersedes IS NULL OR length(supersedes) BETWEEN 3 AND 200),
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_rfr_corrections ON public.rfr_corrections (company_id, period_year, correction_id, seq DESC);

CREATE TABLE public.rfr_runs (
  id                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq               BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id        UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year       INTEGER     NOT NULL,
  content_sha256    TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  rule_pack_id      TEXT        NOT NULL,
  rule_pack_version TEXT        NOT NULL,
  required_scopes   TEXT[]      NOT NULL,
  scopes            JSONB       NOT NULL,
  finalization      JSONB       NOT NULL,
  balances_agree    BOOLEAN     NOT NULL,
  result            JSONB       NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_rfr_runs ON public.rfr_runs (company_id, period_year, seq DESC);

CREATE TABLE public.rfr_reviews (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL,
  report_id       TEXT        NOT NULL,
  report_version  INTEGER     NOT NULL,
  publication_id  UUID        NOT NULL UNIQUE REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  run_id          UUID        NOT NULL REFERENCES public.rfr_runs (id) ON DELETE RESTRICT,
  content_sha256  TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_rfr_reviews ON public.rfr_reviews (report_id, report_version, seq DESC);

CREATE TABLE public.rfr_source_attestations (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq                   BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id            UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year           INTEGER     NOT NULL,
  outcome               TEXT        NOT NULL CHECK (outcome IN ('confirmed', 'changed')),
  tb_fingerprint        TEXT        NULL,
  gl_fingerprint        TEXT        NULL,
  bound_content_sha256  TEXT        NOT NULL CHECK (bound_content_sha256 ~ '^[0-9a-f]{64}$'),
  pulled_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Spec §9.3: an attestation lives at most ten minutes.
  CONSTRAINT chk_rfr_att_life CHECK (expires_at > pulled_at AND expires_at <= pulled_at + interval '10 minutes')
);
CREATE INDEX idx_rfr_att ON public.rfr_source_attestations (company_id, period_year, seq DESC);

CREATE TABLE public.rfr_finalization_manifests (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL,
  publication_id  UUID        NOT NULL UNIQUE REFERENCES public.financial_statement_publications (id) ON DELETE RESTRICT,
  run_id          UUID        NOT NULL REFERENCES public.rfr_runs (id) ON DELETE RESTRICT,
  review_id       UUID        NULL REFERENCES public.rfr_reviews (id) ON DELETE RESTRICT,
  attestation_id  UUID        NULL REFERENCES public.rfr_source_attestations (id) ON DELETE RESTRICT,
  content_sha256  TEXT        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  manifest        JSONB       NOT NULL,
  manifest_sha256 TEXT        NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

DO $guards$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rfr_scope_events', 'rfr_inputs', 'rfr_corrections', 'rfr_runs', 'rfr_reviews', 'rfr_source_attestations', 'rfr_finalization_manifests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_append_only ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.rfr_append_only_guard()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_no_truncate ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_no_truncate BEFORE TRUNCATE ON public.%1$I FOR EACH STATEMENT EXECUTE FUNCTION public.rfr_append_only_guard()', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', t);
  END LOOP;
END;
$guards$;

-- ── 2. Reads and the content digest ──────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._rfr_scope(p_company_id uuid, p_period_year integer)
RETURNS public.rfr_scope_events LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e FROM public.rfr_scope_events e WHERE e.company_id = p_company_id AND e.period_year = p_period_year ORDER BY e.seq DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._rfr_current_inputs(p_company_id uuid, p_period_year integer)
RETURNS SETOF public.rfr_inputs LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.* FROM (
    SELECT DISTINCT ON (x.family, x.key) x.* FROM public.rfr_inputs x
     WHERE x.company_id = p_company_id AND x.period_year = p_period_year
     ORDER BY x.family, x.key, x.seq DESC) i
   WHERE NOT i.withdrawn;
$$;

-- The adjustments that APPLY to the period's authoritative certification, with the correction each carries out.
CREATE OR REPLACE FUNCTION public._rfr_applied_adjustments(p_company_id uuid, p_period_year integer, p_cert uuid)
RETURNS TABLE (adjustment_id uuid, correction_id text, scope text, lines_sha256 text, reverses_correction text, anchor text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT x.id, COALESCE(k.correction_id, x.id::text), COALESCE(k.scope, 'pack'), x.lines_sha256,
         CASE WHEN x.reverses_id IS NULL THEN NULL ELSE COALESCE((SELECT k2.correction_id FROM public.rfr_corrections k2 WHERE k2.adjustment_id = x.reverses_id), x.reverses_id::text) END,
         COALESCE(k.anchor, '{}')
    FROM public.close_review_adjustments x LEFT JOIN public.rfr_corrections k ON k.adjustment_id = x.id
   WHERE x.company_id = p_company_id AND x.period_year = p_period_year AND public._cr_adjustment_applies_to(x.id, p_cert);
$$;

-- THE content digest. Covers what a reviewer reviews; excludes pull times and ids (so a re-pull of identical books is the same content).
CREATE OR REPLACE FUNCTION public.rfr_content_digest(p_company_id uuid, p_period_year integer)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cert uuid;
  v_scope public.rfr_scope_events;
  v_adj text;
  v_inp text;
BEGIN
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  v_scope := public._rfr_scope(p_company_id, p_period_year);
  SELECT COALESCE(string_agg(a.adjustment_id::text || ':' || a.lines_sha256 || ':' || a.correction_id || ':' || COALESCE(a.reverses_correction, '-'), ',' ORDER BY a.adjustment_id), '')
    INTO v_adj FROM public._rfr_applied_adjustments(p_company_id, p_period_year, v_cert) a;
  SELECT COALESCE(string_agg(i.family || '/' || i.key || '=' || i.payload_sha256, ',' ORDER BY i.family, i.key), '')
    INTO v_inp FROM public._rfr_current_inputs(p_company_id, p_period_year) i;
  RETURN encode(sha256(convert_to('rfr-content/1' || E'\n' || COALESCE(v_cert::text, '-') || E'\n' || COALESCE(v_scope.rule_pack_id, '-') || '@' || COALESCE(v_scope.rule_pack_version, '-')
    || '#' || COALESCE(v_scope.facts_sha256, '-') || E'\n' || v_adj || E'\n' || v_inp, 'UTF8')), 'hex');
END;
$$;

-- ── 3. Writers (authenticated; each takes the scope lock before it writes) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rfr_set_scope(p_company_id uuid, p_period_year integer, p_rule_pack_id text, p_rule_pack_version text, p_facts jsonb, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prev public.rfr_scope_events;
  v_sha text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_facts IS NULL OR jsonb_typeof(p_facts) <> 'object' OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  IF p_rule_pack_id IS DISTINCT FROM 'rfr-pilot-ipsas-accrual' OR p_rule_pack_version IS DISTINCT FROM '1.0.0' THEN RETURN jsonb_build_object('outcome', 'unknown_rule_pack'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_facts) k WHERE k NOT IN ('banks', 'banks_requiring_confirmation', 'deposits', 'opening_lines', 'opening_equity', 'suspense_accounts', 'liabilities_completeness', 'payables_settlement')) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', 'unknown scope fact');
  END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_sha := encode(sha256(convert_to(p_facts::text, 'UTF8')), 'hex');
  v_prev := public._rfr_scope(p_company_id, p_period_year);
  IF v_prev.id IS NOT NULL AND v_prev.facts_sha256 = v_sha THEN RETURN jsonb_build_object('outcome', 'unchanged', 'eventId', v_prev.id); END IF;
  INSERT INTO public.rfr_scope_events (company_id, period_year, rule_pack_id, rule_pack_version, facts, facts_sha256, reason, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_rule_pack_id, p_rule_pack_version, p_facts, v_sha, btrim(p_reason), v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'eventId', v_id, 'enabled', v_prev.id IS NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public._rfr_write_input(p_company_id uuid, p_period_year integer, p_family text, p_key text, p_withdrawn boolean, p_payload jsonb,
  p_source text, p_file_sha256 text, p_reason text, p_uid uuid, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prior public.rfr_inputs;
  v_cur public.rfr_inputs;
  v_sha text := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
  v_id uuid;
BEGIN
  SELECT * INTO v_prior FROM public.rfr_inputs i WHERE i.actor_user_id = p_uid AND i.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.company_id = p_company_id AND v_prior.period_year = p_period_year AND v_prior.family = p_family AND v_prior.key = p_key AND v_prior.payload_sha256 = v_sha AND v_prior.withdrawn = p_withdrawn THEN
      RETURN jsonb_build_object('outcome', 'recorded', 'inputId', v_prior.id, 'replay', true);
    END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  SELECT * INTO v_cur FROM public.rfr_inputs i WHERE i.company_id = p_company_id AND i.period_year = p_period_year AND i.family = p_family AND i.key = p_key ORDER BY i.seq DESC LIMIT 1;
  -- Re-importing identical content changes nothing: the same observation is not a new input.
  IF v_cur.id IS NOT NULL AND v_cur.payload_sha256 = v_sha AND v_cur.withdrawn = p_withdrawn THEN RETURN jsonb_build_object('outcome', 'unchanged', 'inputId', v_cur.id); END IF;
  IF p_withdrawn AND (v_cur.id IS NULL OR v_cur.withdrawn) THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  INSERT INTO public.rfr_inputs (company_id, period_year, family, key, withdrawn, payload, payload_sha256, source, file_sha256, reason, actor_user_id, firm_member_id, request_id)
  VALUES (p_company_id, p_period_year, p_family, p_key, p_withdrawn, p_payload, v_sha, p_source, p_file_sha256, p_reason, p_uid, public._cr_member(p_company_id, p_uid), p_request_id) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'inputId', v_id, 'replay', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rfr_register_input(p_company_id uuid, p_period_year integer, p_family text, p_key text, p_payload jsonb, p_source text, p_file_sha256 text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200
     OR p_family NOT IN ('ledger_snapshot', 'bank_account', 'evidence', 'opening_bridge', 'cutoff', 'double_charge', 'entry_support', 'deposit', 'obe', 'population', 'citation')
     OR p_source NOT IN ('export_file', 'manual') OR (p_file_sha256 IS NOT NULL AND p_file_sha256 !~ '^[0-9a-f]{64}$')
     OR octet_length(p_payload::text) > 8000000 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  IF public._rfr_scope(p_company_id, p_period_year) IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  RETURN public._rfr_write_input(p_company_id, p_period_year, p_family, p_key, false, p_payload, p_source, p_file_sha256, NULL, v_uid, p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rfr_withdraw_input(p_company_id uuid, p_period_year integer, p_family text, p_key text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_key IS NULL OR p_family IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1000 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  RETURN public._rfr_write_input(p_company_id, p_period_year, p_family, p_key, true, '{}'::jsonb, 'manual', NULL, btrim(p_reason), v_uid, p_request_id);
END;
$$;

-- A QuickBooks pull records its ledger snapshot through the service role only (the connector is off for customers).
CREATE OR REPLACE FUNCTION public.rfr_register_source_input(p_company_id uuid, p_period_year integer, p_actor_user_id uuid, p_family text, p_key text, p_payload jsonb, p_file_sha256 text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_family NOT IN ('ledger_snapshot') OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF public._rfr_scope(p_company_id, p_period_year) IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  RETURN public._rfr_write_input(p_company_id, p_period_year, p_family, p_key, false, p_payload, 'qbo_api', p_file_sha256, NULL, p_actor_user_id, p_request_id);
END;
$$;

-- A correction: one stable identity carried out by one adjustment. The adjustment is proposed through the existing authority
-- (same lines, same approval policy); this adds the identity, atomically. The same identity proposed again while the first
-- is still proposed or approved answers with the first.
CREATE OR REPLACE FUNCTION public.rfr_propose_correction(p_company_id uuid, p_period_year integer, p_correction_id text, p_scope text, p_anchor text[], p_reason text, p_evidence_ref text,
  p_lines jsonb, p_request_id uuid, p_reverses_correction text DEFAULT NULL, p_bundle text DEFAULT NULL, p_supersedes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_existing public.rfr_corrections;
  v_rev uuid;
  v_r jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_correction_id IS NULL OR length(p_correction_id) NOT BETWEEN 3 AND 200 OR p_scope IS NULL OR length(p_scope) NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF public._rfr_scope(p_company_id, p_period_year) IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  -- The per-identity lock serialises two submissions of the same correction (retry, double click, two tabs).
  PERFORM pg_advisory_xact_lock(hashtextextended('rfr_correction:' || p_company_id::text || ':' || p_period_year::text || ':' || p_correction_id, 0));
  SELECT k.* INTO v_existing FROM public.rfr_corrections k JOIN public.close_review_adjustments x ON x.id = k.adjustment_id
   WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND k.correction_id = p_correction_id
     AND public._cr_adjustment_status(x.id) IN ('proposed', 'approved') ORDER BY k.seq DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_proposed', 'adjustmentId', v_existing.adjustment_id, 'status', public._cr_adjustment_status(v_existing.adjustment_id));
  END IF;
  IF p_reverses_correction IS NOT NULL THEN
    SELECT k.adjustment_id INTO v_rev FROM public.rfr_corrections k WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND k.correction_id = p_reverses_correction ORDER BY k.seq DESC LIMIT 1;
    IF v_rev IS NULL THEN RETURN jsonb_build_object('outcome', 'not_reversible'); END IF;
  END IF;
  v_r := public.close_review_propose_adjustment(p_company_id, p_period_year, p_reason, p_evidence_ref, p_lines, '{}'::uuid[], p_request_id, v_rev);
  IF v_r->>'outcome' = 'proposed' THEN
    INSERT INTO public.rfr_corrections (company_id, period_year, correction_id, adjustment_id, scope, anchor, bundle, supersedes, actor_user_id, firm_member_id)
    VALUES (p_company_id, p_period_year, p_correction_id, (v_r->>'adjustmentId')::uuid, p_scope, COALESCE(p_anchor, '{}'), p_bundle, p_supersedes, v_uid, public._cr_member(p_company_id, v_uid))
    ON CONFLICT (adjustment_id) DO NOTHING;
  END IF;
  RETURN v_r;
END;
$$;

-- ── 4. The existing adjustment writers take the scope lock too (contract C4) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._rfr_adjustment_scope_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_company uuid;
  v_year integer;
BEGIN
  IF TG_TABLE_NAME = 'close_review_adjustments' THEN
    v_company := NEW.company_id; v_year := NEW.period_year;
  ELSIF TG_TABLE_NAME = 'close_review_adjustment_bindings' THEN
    SELECT a.company_id, a.period_year INTO v_company, v_year FROM public.close_review_adjustments a WHERE a.id = NEW.adjustment_id;
  ELSE
    IF NEW.subject_kind <> 'adjustment' OR NEW.event_type NOT IN ('adjustment_approved', 'adjustment_rejected', 'adjustment_withdrawn') THEN RETURN NEW; END IF;
    SELECT a.company_id, a.period_year INTO v_company, v_year FROM public.close_review_adjustments a WHERE a.id = NEW.subject_id::uuid;
  END IF;
  IF v_company IS NOT NULL THEN PERFORM public._fs_scope_lock(v_company, v_year); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_rfr_scope_lock_adjustments ON public.close_review_adjustments;
CREATE TRIGGER trg_rfr_scope_lock_adjustments BEFORE INSERT ON public.close_review_adjustments FOR EACH ROW EXECUTE FUNCTION public._rfr_adjustment_scope_lock();
DROP TRIGGER IF EXISTS trg_rfr_scope_lock_bindings ON public.close_review_adjustment_bindings;
CREATE TRIGGER trg_rfr_scope_lock_bindings BEFORE INSERT ON public.close_review_adjustment_bindings FOR EACH ROW EXECUTE FUNCTION public._rfr_adjustment_scope_lock();
DROP TRIGGER IF EXISTS trg_rfr_scope_lock_events ON public.close_review_events;
CREATE TRIGGER trg_rfr_scope_lock_events BEFORE INSERT ON public.close_review_events FOR EACH ROW
  WHEN (NEW.subject_kind = 'adjustment' AND NEW.event_type IN ('adjustment_approved', 'adjustment_rejected', 'adjustment_withdrawn'))
  EXECUTE FUNCTION public._rfr_adjustment_scope_lock();

-- ── 5. The engine's authority: load rows, record a run over CURRENT rows only (service role) ────────────────────────
CREATE OR REPLACE FUNCTION public.rfr_load_inputs(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_cert uuid;
  v_upload uuid;
  v_per record;
  v_scope public.rfr_scope_events;
BEGIN
  v_scope := public._rfr_scope(p_company_id, p_period_year);
  IF v_scope.id IS NULL THEN RETURN jsonb_build_object('state', 'not_enabled'); END IF;
  SELECT c.id, c.upload_id INTO v_cert, v_upload FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN jsonb_build_object('state', 'no_authority'); END IF;
  SELECT fp.reporting_start, fp.reporting_end, fp.reporting_currency, cr.exponent INTO v_per
    FROM public.trial_balance_uploads u JOIN public.fiscal_periods fp ON fp.id = u.period_id JOIN public.currency_registry cr ON cr.code = fp.reporting_currency WHERE u.id = v_upload;
  IF v_per.reporting_start IS NULL OR v_per.reporting_end IS NULL THEN RETURN jsonb_build_object('state', 'period_unknown'); END IF;
  RETURN jsonb_build_object(
    'state', 'current',
    'period', jsonb_build_object('start', v_per.reporting_start, 'end', v_per.reporting_end, 'currency', v_per.reporting_currency, 'exponent', v_per.exponent),
    'contentSha256', public.rfr_content_digest(p_company_id, p_period_year),
    'certificationId', v_cert,
    'scope', jsonb_build_object('rulePackId', v_scope.rule_pack_id, 'rulePackVersion', v_scope.rule_pack_version, 'facts', v_scope.facts),
    'accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', a.account_key, 'code', a.account_code, 'name', a.account_name, 'classification', a.classification,
                    'debitMinor', a.debit_minor::text, 'creditMinor', a.credit_minor::text) ORDER BY a.account_key) FROM public._cr_certified_accounts(v_cert) a), '[]'::jsonb),
    'inputs', COALESCE((SELECT jsonb_agg(jsonb_build_object('family', i.family, 'key', i.key, 'source', i.source, 'payload', i.payload) ORDER BY i.family, i.key)
                          FROM public._rfr_current_inputs(p_company_id, p_period_year) i), '[]'::jsonb),
    'adjustments', COALESCE((SELECT jsonb_agg(jsonb_build_object('adjustmentId', a.adjustment_id, 'correctionId', a.correction_id, 'scope', a.scope, 'reversesCorrection', a.reverses_correction, 'anchor', to_jsonb(a.anchor),
                    'lines', (SELECT jsonb_agg(jsonb_build_object('account', l.account_key, 'amount', (l.debit_minor - l.credit_minor)::text) ORDER BY l.line_no)
                                FROM public.close_review_adjustment_lines l WHERE l.adjustment_id = a.adjustment_id)) ORDER BY a.adjustment_id)
                          FROM public._rfr_applied_adjustments(p_company_id, p_period_year, v_cert) a), '[]'::jsonb),
    -- Every approved correction that is applied or awaiting revalidation: the source may already carry its fix.
    'corrections', COALESCE((SELECT jsonb_agg(jsonb_build_object('correctionId', k.correction_id, 'bundle', k.bundle, 'supersedes', k.supersedes, 'scope', k.scope, 'anchor', to_jsonb(k.anchor),
                    'binding', public._cr_adjustment_binding_state(x.id, v_cert),
                    'lines', (SELECT jsonb_agg(jsonb_build_object('account', l.account_key, 'amount', (l.debit_minor - l.credit_minor)::text) ORDER BY l.line_no)
                                FROM public.close_review_adjustment_lines l WHERE l.adjustment_id = x.id)) ORDER BY k.correction_id)
                          FROM public.rfr_corrections k JOIN public.close_review_adjustments x ON x.id = k.adjustment_id
                         WHERE k.company_id = p_company_id AND k.period_year = p_period_year AND x.kind = 'adjustment' AND public._cr_adjustment_status(x.id) = 'approved'
                           -- A correction a reviewer declined to carry stays under verification: the source fix IS its proof (verified), or its error still stands.
                           AND public._cr_adjustment_binding_state(x.id, v_cert) IN ('applied', 'requires_revalidation', 'not_carried')), '[]'::jsonb));
END;
$$;

-- The adjusted trial balance the existing reporting workflow reads: certified balance + applied adjustment lines, signed, per account key.
CREATE OR REPLACE FUNCTION public._rfr_layer_balances(p_company_id uuid, p_period_year integer, p_cert uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH cert AS (SELECT a.account_key, (a.debit_minor - a.credit_minor) AS n FROM public._cr_certified_accounts(p_cert) a),
       adj AS (SELECT l.account_key, sum(l.debit_minor - l.credit_minor) AS n
                 FROM public.close_review_adjustments x JOIN public.close_review_adjustment_lines l ON l.adjustment_id = x.id
                WHERE x.company_id = p_company_id AND x.period_year = p_period_year AND public._cr_adjustment_applies_to(x.id, p_cert) GROUP BY l.account_key)
  SELECT COALESCE(jsonb_object_agg(k, (COALESCE(c.n, 0) + COALESCE(a.n, 0))::text), '{}'::jsonb)
    FROM (SELECT account_key AS k FROM cert UNION SELECT account_key FROM adj) u LEFT JOIN cert c ON c.account_key = u.k LEFT JOIN adj a ON a.account_key = u.k;
$$;

CREATE OR REPLACE FUNCTION public.rfr_record_run(p_company_id uuid, p_period_year integer, p_content_sha256 text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_scope public.rfr_scope_events;
  v_cert uuid;
  v_now text;
  v_layer jsonb;
  v_agree boolean := true;
  v_k text;
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' OR p_result IS NULL OR jsonb_typeof(p_result) <> 'object'
     OR jsonb_typeof(p_result->'required_scopes') IS DISTINCT FROM 'array' OR jsonb_typeof(p_result->'scopes') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_result->'finalization') IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'balances') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_scope := public._rfr_scope(p_company_id, p_period_year);
  IF v_scope.id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  SELECT c.id INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN jsonb_build_object('outcome', 'no_authority'); END IF;
  v_now := public.rfr_content_digest(p_company_id, p_period_year);
  -- A run is recorded only over the rows it was computed from: anything that changed since the load makes it worthless.
  IF v_now <> p_content_sha256 THEN RETURN jsonb_build_object('outcome', 'input_changed', 'currentContentSha256', v_now); END IF;
  -- The engine's balances are the one authoritative set; the layer the reporting workflow reads must equal them.
  v_layer := public._rfr_layer_balances(p_company_id, p_period_year, v_cert);
  FOR v_k IN SELECT k FROM (SELECT jsonb_object_keys(v_layer) AS k UNION SELECT jsonb_object_keys(p_result->'balances')) u LOOP
    IF COALESCE(v_layer->>v_k, '0')::numeric IS DISTINCT FROM COALESCE(p_result->'balances'->>v_k, '0')::numeric THEN v_agree := false; EXIT; END IF;
  END LOOP;
  INSERT INTO public.rfr_runs (company_id, period_year, content_sha256, rule_pack_id, rule_pack_version, required_scopes, scopes, finalization, balances_agree, result)
  VALUES (p_company_id, p_period_year, p_content_sha256, v_scope.rule_pack_id, v_scope.rule_pack_version,
          ARRAY(SELECT jsonb_array_elements_text(p_result->'required_scopes')), p_result->'scopes', p_result->'finalization', v_agree, p_result) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'runId', v_id, 'balancesAgree', v_agree);
END;
$$;

-- ── 6. QuickBooks freshness: a separate, expiring attestation bound to the content ─────────────────────────────────
CREATE OR REPLACE FUNCTION public._rfr_bound_fingerprints(p_company_id uuid, p_period_year integer, OUT tb_fingerprint text, OUT gl_fingerprint text, OUT qbo_bound boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_upload uuid;
BEGIN
  SELECT i.payload_sha256 INTO gl_fingerprint FROM public._rfr_current_inputs(p_company_id, p_period_year) i WHERE i.family = 'ledger_snapshot' AND i.source = 'qbo_api' ORDER BY i.seq DESC LIMIT 1;
  SELECT c.upload_id INTO v_upload FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_upload IS NOT NULL AND to_regclass('public.qbo_pulls') IS NOT NULL THEN
    EXECUTE 'SELECT p.result_sha256 FROM public.qbo_pulls p WHERE p.company_id = $1 AND p.upload_id = $2 ORDER BY p.pulled_at DESC LIMIT 1' INTO tb_fingerprint USING p_company_id, v_upload;
  END IF;
  qbo_bound := tb_fingerprint IS NOT NULL OR gl_fingerprint IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.rfr_record_source_attestation(p_company_id uuid, p_period_year integer, p_tb_fingerprint text, p_gl_fingerprint text, p_pulled_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  b record;
  v_digest text;
  v_outcome text;
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_pulled_at IS NULL OR p_pulled_at > clock_timestamp() + interval '1 minute' THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  IF public._rfr_scope(p_company_id, p_period_year) IS NULL THEN RETURN jsonb_build_object('outcome', 'not_enabled'); END IF;
  SELECT * INTO b FROM public._rfr_bound_fingerprints(p_company_id, p_period_year);
  IF NOT b.qbo_bound THEN RETURN jsonb_build_object('outcome', 'not_qbo_bound'); END IF;
  v_digest := public.rfr_content_digest(p_company_id, p_period_year);
  v_outcome := CASE WHEN (b.tb_fingerprint IS NULL OR p_tb_fingerprint IS NOT DISTINCT FROM b.tb_fingerprint) AND (b.gl_fingerprint IS NULL OR p_gl_fingerprint IS NOT DISTINCT FROM b.gl_fingerprint)
                    THEN 'confirmed' ELSE 'changed' END;
  INSERT INTO public.rfr_source_attestations (company_id, period_year, outcome, tb_fingerprint, gl_fingerprint, bound_content_sha256, pulled_at, expires_at)
  VALUES (p_company_id, p_period_year, v_outcome, p_tb_fingerprint, p_gl_fingerprint, v_digest, p_pulled_at, p_pulled_at + interval '10 minutes') RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', v_outcome, 'attestationId', v_id, 'boundContentSha256', v_digest);
END;
$$;

-- ── 7. The blockers (spliced into the existing function; see section 8) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._rfr_blockers(p_company_id uuid, p_report_id text, p_version integer)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_year integer;
  v_scope public.rfr_scope_events;
  v_run public.rfr_runs;
  v_digest text;
  v_out text[] := '{}';
  v_s text;
  v_state text;
  v_rev public.rfr_reviews;
  v_att public.rfr_source_attestations;
  b record;
BEGIN
  SELECT r.period_year INTO v_year FROM public.financial_statement_reports r WHERE r.report_id = p_report_id AND r.report_version = p_version AND r.company_id = p_company_id;
  IF v_year IS NULL THEN RETURN v_out; END IF;
  v_scope := public._rfr_scope(p_company_id, v_year);
  IF v_scope.id IS NULL THEN RETURN v_out; END IF;             -- not opted in: nothing changes
  v_digest := public.rfr_content_digest(p_company_id, v_year);
  SELECT * INTO v_run FROM public.rfr_runs r WHERE r.company_id = p_company_id AND r.period_year = v_year ORDER BY r.seq DESC LIMIT 1;
  IF v_run.id IS NULL THEN RETURN array_append(v_out, 'RFR_NOT_EVALUATED'); END IF;
  IF v_run.content_sha256 <> v_digest THEN RETURN array_append(v_out, 'RFR_MANIFEST_STALE'); END IF;
  FOREACH v_s IN ARRAY v_run.required_scopes LOOP
    IF COALESCE(v_run.scopes->>v_s, 'ABSENT') <> 'READY' THEN v_out := v_out || ('RFR_SCOPE_HELD:' || v_s); END IF;
  END LOOP;
  IF NOT v_run.balances_agree THEN v_out := array_append(v_out, 'RFR_ADJUSTED_TB_DIVERGES'); END IF;
  IF (v_run.finalization->'reasons') ? 'TB_NOT_VALIDATED' THEN v_out := array_append(v_out, 'RFR_TB_NOT_VALIDATED'); END IF;

  -- The final stage (the version is already REVIEWED): the review binds THIS content, and QuickBooks-bound inputs need a fresh attestation.
  SELECT p.state INTO v_state FROM public.financial_statement_publications p WHERE p.report_id = p_report_id AND p.report_version = p_version ORDER BY p.seq DESC LIMIT 1;
  IF v_state = 'REVIEWED' THEN
    SELECT * INTO v_rev FROM public.rfr_reviews rv WHERE rv.report_id = p_report_id AND rv.report_version = p_version ORDER BY rv.seq DESC LIMIT 1;
    IF v_rev.id IS NULL THEN v_out := array_append(v_out, 'RFR_REVIEW_MISSING');
    ELSIF v_rev.content_sha256 <> v_digest THEN v_out := array_append(v_out, 'RFR_REVIEW_STALE'); END IF;
    SELECT * INTO b FROM public._rfr_bound_fingerprints(p_company_id, v_year);
    IF b.qbo_bound THEN
      SELECT * INTO v_att FROM public.rfr_source_attestations a WHERE a.company_id = p_company_id AND a.period_year = v_year ORDER BY a.seq DESC LIMIT 1;
      IF v_att.id IS NULL THEN v_out := array_append(v_out, 'RFR_SOURCE_FRESHNESS_UNDETERMINED');
      ELSIF v_att.outcome <> 'confirmed' THEN v_out := array_append(v_out, 'RFR_SOURCE_CHANGED');
      ELSIF b.tb_fingerprint IS NOT NULL AND v_att.tb_fingerprint IS DISTINCT FROM b.tb_fingerprint THEN v_out := array_append(v_out, 'RFR_SOURCE_CHANGED:tb');
      ELSIF b.gl_fingerprint IS NOT NULL AND v_att.gl_fingerprint IS DISTINCT FROM b.gl_fingerprint THEN v_out := array_append(v_out, 'RFR_SOURCE_CHANGED:gl');
      ELSIF v_att.expires_at <= clock_timestamp() THEN v_out := array_append(v_out, 'RFR_SOURCE_FRESHNESS_STALE');
      ELSIF v_att.bound_content_sha256 <> v_digest THEN v_out := array_append(v_out, 'RFR_SOURCE_FRESHNESS_MISMATCH'); END IF;
    END IF;
  END IF;
  RETURN v_out;
END;
$$;

-- REVIEWED records the content it saw; FINAL stores an immutable manifest, in the same transaction as the transition.
CREATE OR REPLACE FUNCTION public._rfr_on_publication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_year integer;
  v_run public.rfr_runs;
  v_digest text;
  v_rev public.rfr_reviews;
  v_att public.rfr_source_attestations;
  b record;
  v_manifest jsonb;
BEGIN
  IF NEW.state NOT IN ('REVIEWED', 'FINAL') THEN RETURN NEW; END IF;
  SELECT r.period_year INTO v_year FROM public.financial_statement_reports r WHERE r.report_id = NEW.report_id AND r.report_version = NEW.report_version AND r.company_id = NEW.company_id;
  IF v_year IS NULL OR public._rfr_scope(NEW.company_id, v_year) IS NULL THEN RETURN NEW; END IF;
  v_digest := public.rfr_content_digest(NEW.company_id, v_year);
  SELECT * INTO v_run FROM public.rfr_runs r WHERE r.company_id = NEW.company_id AND r.period_year = v_year ORDER BY r.seq DESC LIMIT 1;
  IF v_run.id IS NULL OR v_run.content_sha256 <> v_digest THEN
    RAISE EXCEPTION 'RFR_MANIFEST_STALE: the readiness evaluation no longer matches the books' USING ERRCODE = 'PT409';
  END IF;
  IF NEW.state = 'REVIEWED' THEN
    INSERT INTO public.rfr_reviews (company_id, period_year, report_id, report_version, publication_id, run_id, content_sha256)
    VALUES (NEW.company_id, v_year, NEW.report_id, NEW.report_version, NEW.id, v_run.id, v_digest);
    RETURN NEW;
  END IF;
  SELECT * INTO v_rev FROM public.rfr_reviews rv WHERE rv.report_id = NEW.report_id AND rv.report_version = NEW.report_version ORDER BY rv.seq DESC LIMIT 1;
  IF v_rev.id IS NULL OR v_rev.content_sha256 <> v_digest THEN
    RAISE EXCEPTION 'RFR_REVIEW_STALE: the reviewed content is not the content being finalized' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO b FROM public._rfr_bound_fingerprints(NEW.company_id, v_year);
  IF b.qbo_bound THEN
    SELECT * INTO v_att FROM public.rfr_source_attestations a WHERE a.company_id = NEW.company_id AND a.period_year = v_year ORDER BY a.seq DESC LIMIT 1;
  END IF;
  v_manifest := jsonb_build_object('contract', 'rfr-finalization-manifest/1', 'contentSha256', v_digest, 'runId', v_run.id, 'reviewId', v_rev.id,
    'rulePack', jsonb_build_object('id', v_run.rule_pack_id, 'version', v_run.rule_pack_version), 'requiredScopes', to_jsonb(v_run.required_scopes), 'scopes', v_run.scopes,
    'qboBound', COALESCE(b.qbo_bound, false),
    'sourceFreshness', CASE WHEN v_att.id IS NULL THEN NULL ELSE jsonb_build_object('attestationId', v_att.id, 'pulledAt', v_att.pulled_at, 'expiresAt', v_att.expires_at,
      'note', 'Source re-read at the pulled-at time. An edit made in QuickBooks after that moment and before this commit is not detected.') END);
  INSERT INTO public.rfr_finalization_manifests (company_id, period_year, publication_id, run_id, review_id, attestation_id, content_sha256, manifest, manifest_sha256)
  VALUES (NEW.company_id, v_year, NEW.id, v_run.id, v_rev.id, v_att.id, v_digest, v_manifest, encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex'));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_rfr_on_publication ON public.financial_statement_publications;
CREATE TRIGGER trg_rfr_on_publication AFTER INSERT ON public.financial_statement_publications FOR EACH ROW EXECUTE FUNCTION public._rfr_on_publication();

-- ── 8. Splice the blockers into fs_publication_blockers (one call before its RETURN; asserted, not copied) ───────────
DO $splice$
DECLARE
  v_def text;
  v_new text;
  v_hits integer;
BEGIN
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  IF position('_rfr_blockers' IN v_def) > 0 THEN RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_publication_blockers already carries the readiness blockers' USING ERRCODE = 'P0001'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, E'\n  RETURN v_out;', ''))) / length(E'\n  RETURN v_out;');
  IF v_hits <> 1 THEN RAISE EXCEPTION 'PREFLIGHT_REFUSED: expected exactly one final RETURN v_out in fs_publication_blockers, found %', v_hits USING ERRCODE = 'P0001'; END IF;
  v_new := replace(v_def, E'\n  RETURN v_out;', E'\n  -- [20261225100000] Ready for Reporting: opted-in scopes are blocked until the readiness run is current and READY.\n  v_out := v_out || public._rfr_blockers(p_company_id, p_report_id, p_version);\n  RETURN v_out;');
  EXECUTE v_new;
END;
$splice$;

-- ── 9. Status for the browser (read-only) ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rfr_status(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_scope public.rfr_scope_events;
  v_run public.rfr_runs;
  v_digest text;
  b record;
  v_att public.rfr_source_attestations;
  v_cert uuid;
  v_upload uuid;
  v_per record;
  v_period jsonb;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  SELECT c.id, c.upload_id INTO v_cert, v_upload FROM public.get_authoritative_certification(p_company_id, p_period_year) c;
  IF v_cert IS NULL THEN RETURN jsonb_build_object('state', 'no_authority'); END IF;
  -- The reporting period is the certified trial balance's own: the page never guesses one.
  SELECT fp.reporting_start, fp.reporting_end, fp.reporting_currency, cr.exponent INTO v_per
    FROM public.trial_balance_uploads u JOIN public.fiscal_periods fp ON fp.id = u.period_id JOIN public.currency_registry cr ON cr.code = fp.reporting_currency WHERE u.id = v_upload;
  IF v_per.reporting_start IS NULL OR v_per.reporting_end IS NULL THEN RETURN jsonb_build_object('state', 'period_unknown'); END IF;
  v_period := jsonb_build_object('start', v_per.reporting_start, 'end', v_per.reporting_end, 'currency', v_per.reporting_currency, 'exponent', v_per.exponent);
  v_scope := public._rfr_scope(p_company_id, p_period_year);
  IF v_scope.id IS NULL THEN RETURN jsonb_build_object('state', 'not_enabled', 'period', v_period); END IF;
  v_digest := public.rfr_content_digest(p_company_id, p_period_year);
  SELECT * INTO v_run FROM public.rfr_runs r WHERE r.company_id = p_company_id AND r.period_year = p_period_year ORDER BY r.seq DESC LIMIT 1;
  SELECT * INTO b FROM public._rfr_bound_fingerprints(p_company_id, p_period_year);
  SELECT * INTO v_att FROM public.rfr_source_attestations a WHERE a.company_id = p_company_id AND a.period_year = p_period_year ORDER BY a.seq DESC LIMIT 1;
  RETURN jsonb_build_object('state', CASE WHEN v_run.id IS NULL THEN 'not_evaluated' WHEN v_run.content_sha256 <> v_digest THEN 'stale' ELSE 'current' END,
    'period', v_period,
    'scope', jsonb_build_object('rulePackId', v_scope.rule_pack_id, 'rulePackVersion', v_scope.rule_pack_version, 'facts', v_scope.facts),
    'contentSha256', v_digest,
    'run', CASE WHEN v_run.id IS NULL THEN NULL ELSE jsonb_build_object('id', v_run.id, 'at', v_run.created_at, 'contentSha256', v_run.content_sha256, 'balancesAgree', v_run.balances_agree, 'result', v_run.result) END,
    'qboBound', COALESCE(b.qbo_bound, false),
    'attestation', CASE WHEN v_att.id IS NULL THEN NULL ELSE jsonb_build_object('outcome', v_att.outcome, 'pulledAt', v_att.pulled_at, 'expiresAt', v_att.expires_at, 'boundContentSha256', v_att.bound_content_sha256) END,
    'inputs', COALESCE((SELECT jsonb_agg(jsonb_build_object('family', i.family, 'key', i.key, 'source', i.source, 'payloadSha256', i.payload_sha256, 'at', i.created_at) ORDER BY i.family, i.key)
                          FROM public._rfr_current_inputs(p_company_id, p_period_year) i), '[]'::jsonb));
END;
$$;

-- ── 10. Access ───────────────────────────────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.rfr_append_only_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_scope(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_current_inputs(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_applied_adjustments(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_write_input(uuid, integer, text, text, boolean, jsonb, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_adjustment_scope_lock() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_layer_balances(uuid, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_bound_fingerprints(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_blockers(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rfr_on_publication() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rfr_content_digest(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfr_content_digest(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rfr_load_inputs(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfr_load_inputs(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.rfr_record_run(uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfr_record_run(uuid, integer, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.rfr_record_source_attestation(uuid, integer, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfr_record_source_attestation(uuid, integer, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.rfr_register_source_input(uuid, integer, uuid, text, text, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfr_register_source_input(uuid, integer, uuid, text, text, jsonb, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.rfr_set_scope(uuid, integer, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_set_scope(uuid, integer, text, text, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.rfr_register_input(uuid, integer, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_register_input(uuid, integer, text, text, jsonb, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rfr_withdraw_input(uuid, integer, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_withdraw_input(uuid, integer, text, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rfr_propose_correction(uuid, integer, text, text, text[], text, text, jsonb, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_propose_correction(uuid, integer, text, text, text[], text, text, jsonb, uuid, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.rfr_status(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfr_status(uuid, integer) TO authenticated;
$cfoclose_rfr_stage_5374bb124399bfd3$);
