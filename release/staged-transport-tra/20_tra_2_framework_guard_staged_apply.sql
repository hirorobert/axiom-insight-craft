-- CFOClose track-a-r1 staged transport: apply 20261128100000_companies_framework_change_guard.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; sign-off bindings, issued packs, the FINAL authority and its history and every
-- company's framework must be unchanged. One atomic statement.
DO $cfoclose_tra_transport_tra_2_framework_guard$
DECLARE
  c_batch CONSTANT text := 'tra-2-framework-guard';
  c_prior CONSTANT text := 'tra-1-authority-hardening';
  c_prior_kinds CONSTANT integer := 4;
  c_predecessor CONSTANT text[] := ARRAY['d9fbd2c4617c62d98e44ee00d16d67be2c178d9467386901423c86f6b792cbf0', 'ba9ec4050a8c95b63cc0492067ff89ec370d3e24cf7e06bfccd17bd35a28a849']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_source text; v_wrapper text; v_postcondition text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_tra_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_tra_release') IS NULL THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_tra_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_tra_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_tra_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_tra_release.staged_artifacts WHERE batch = c_batch) <> 3 THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 3 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.guard_company_reporting_framework()') IS NOT NULL THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261128100000_companies_framework_change_guard.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_tra_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 3800 AND s.body_sha256 = '80626d259948579f39b2a8f32d8df4a4baadcb6592a369801335c70399278d1d';
  IF v_source IS NULL THEN RAISE EXCEPTION 'TRA_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_tra_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 5384 AND s.body_sha256 = 'c4148e95d336b9292e391d3493c6c196b257ae80468fb32eb342436c62887fa5';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'TRA_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_postcondition FROM cfoclose_tra_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'postcondition' AND s.consumed_at IS NULL
     AND s.body_bytes = 3906 AND s.body_sha256 = '1694dcdd9901410547d24fff444c22c1c2c00a735ee176c6e703fe4617949155';
  IF v_postcondition IS NULL THEN RAISE EXCEPTION 'TRA_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % postcondition is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  v_baseline := (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(a)::text, chr(10) ORDER BY a.company_id, a.period_year) FROM public.fs_report_authority a), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(e)::text, chr(10) ORDER BY e.seq) FROM public.fs_report_authority_events e), '') || chr(30) ||
      coalesce((SELECT string_agg(c.id::text || ':' || coalesce(c.reporting_framework::text, ''), chr(10) ORDER BY c.id) FROM public.companies c), ''),
    'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_tra_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;
  IF NOT (to_regprocedure('public.guard_company_reporting_framework()') IS NOT NULL) THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_POSTCONDITION: % did not install its target', '20261128100000_companies_framework_change_guard.sql' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(a)::text, chr(10) ORDER BY a.company_id, a.period_year) FROM public.fs_report_authority a), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(e)::text, chr(10) ORDER BY e.seq) FROM public.fs_report_authority_events e), '') || chr(30) ||
      coalesce((SELECT string_agg(c.id::text || ':' || coalesce(c.reporting_framework::text, ''), chr(10) ORDER BY c.id) FROM public.companies c), ''),
    'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'TRA_TRANSPORT_BASELINE_CHANGED: sign-off bindings, issued packs, the FINAL authority or a company framework changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_tra_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_tra_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261128100000_companies_framework_change_guard.sql', 'baseline_sha256', v_baseline,
      'source_sha256', '80626d259948579f39b2a8f32d8df4a4baadcb6592a369801335c70399278d1d',
      'wrapper_sha256', 'c4148e95d336b9292e391d3493c6c196b257ae80468fb32eb342436c62887fa5',
      'postcondition_sha256', '1694dcdd9901410547d24fff444c22c1c2c00a735ee176c6e703fe4617949155'));
  PERFORM set_config('cfoclose_tra_release.applying', '', true);
END
$cfoclose_tra_transport_tra_2_framework_guard$;