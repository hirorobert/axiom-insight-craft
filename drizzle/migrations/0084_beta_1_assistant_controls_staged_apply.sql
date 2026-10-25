-- CFOClose internal-beta-r1 staged transport: apply 20261201100000_assistant_controls.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; sign-off bindings, issued packs, the FINAL authority and its history and every
-- company's framework must be unchanged. One atomic statement.
DO $cfoclose_beta_transport_beta_1_assistant_controls$
DECLARE
  c_batch CONSTANT text := 'beta-1-assistant-controls';
  c_prior CONSTANT text := NULL;
  c_prior_kinds CONSTANT integer := 0;
  c_predecessor CONSTANT text[] := ARRAY['bdbd0020aa9096b38fb553587da68070e9e21ec942e971ea88bd61891fd9b96c', 'a2286d7fa452a7b50d48f02dec1bb2b82f1498db419bfa8fa53a1464d312b519']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_source text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_beta_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_beta_release') IS NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_beta_release.staged_artifacts WHERE batch = c_batch) <> 1 THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 1 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.ai_assistant_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261201100000_assistant_controls.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_beta_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 38510 AND s.body_sha256 = '84695443fc325657b68b159f753a788c16249fac92b0e78176e9876a4994fd3f';
  IF v_source IS NULL THEN RAISE EXCEPTION 'BETA_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  v_baseline := (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(a)::text, chr(10) ORDER BY a.company_id, a.period_year) FROM public.fs_report_authority a), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(e)::text, chr(10) ORDER BY e.seq) FROM public.fs_report_authority_events e), '') || chr(30) ||
      coalesce((SELECT string_agg(c.id::text || ':' || coalesce(c.reporting_framework::text, ''), chr(10) ORDER BY c.id) FROM public.companies c), ''),
    'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_beta_release.applying', c_batch, true);
  EXECUTE v_source;
  IF NOT (to_regclass('public.ai_assistant_settings') IS NOT NULL) THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_POSTCONDITION: % did not install its target', '20261201100000_assistant_controls.sql' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(a)::text, chr(10) ORDER BY a.company_id, a.period_year) FROM public.fs_report_authority a), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(e)::text, chr(10) ORDER BY e.seq) FROM public.fs_report_authority_events e), '') || chr(30) ||
      coalesce((SELECT string_agg(c.id::text || ':' || coalesce(c.reporting_framework::text, ''), chr(10) ORDER BY c.id) FROM public.companies c), ''),
    'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'BETA_TRANSPORT_BASELINE_CHANGED: sign-off bindings, issued packs, the FINAL authority or a company framework changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_beta_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_beta_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261201100000_assistant_controls.sql', 'baseline_sha256', v_baseline,
      'source_sha256', '84695443fc325657b68b159f753a788c16249fac92b0e78176e9876a4994fd3f'));
  PERFORM set_config('cfoclose_beta_release.applying', '', true);
END
$cfoclose_beta_transport_beta_1_assistant_controls$;