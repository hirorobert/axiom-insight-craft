-- CFOClose fs-integrity-r1 staged transport: apply 20261124100000_fs_publication_integrity_gate.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing sign-off bindings and issued packs must be unchanged. One atomic statement.
DO $cfoclose_fsi_transport_fsi_2_integrity_gate$
DECLARE
  c_batch CONSTANT text := 'fsi-2-integrity-gate';
  c_prior CONSTANT text := 'fsi-1-server-compilation';
  c_prior_kinds CONSTANT integer := 3;
  c_predecessor CONSTANT text[] := ARRAY['21325cb1984c8e2e05ecc8ac532b75cc2c30dd1ff5a81b2914a4024f0d80b018', '06f31edbee62d9139645f52041c75eab40c69fa24b20e87faf76acd1e9002a82']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_source text; v_wrapper text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_fsi_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace('cfoclose_fsi_release') IS NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_NOT_INSTALLED: the transport bootstrap is absent; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> c_prior_kinds THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch) <> 2 THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 2 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261124100000_fs_publication_integrity_gate.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 50518 AND s.body_sha256 = 'a71d60eba0dea2347f4c9d519c8e76e2ffa9ec3d986a54281957bb664bf07a03';
  IF v_source IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 52098 AND s.body_sha256 = 'ada364d700f2e3f2bcb0d9a8f8e380cb5f26e1a5e465d919f09a1a7d502233c3';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  v_baseline := (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_fsi_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  IF NOT (position('DOCUMENT_FACT_NOT_COMPOSED' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) > 0) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_POSTCONDITION: % did not install its target', '20261124100000_fs_publication_integrity_gate.sql' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_BASELINE_CHANGED: existing sign-off bindings or issued packs changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_fsi_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_fsi_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261124100000_fs_publication_integrity_gate.sql', 'baseline_sha256', v_baseline,
      'source_sha256', 'a71d60eba0dea2347f4c9d519c8e76e2ffa9ec3d986a54281957bb664bf07a03',
      'wrapper_sha256', 'ada364d700f2e3f2bcb0d9a8f8e380cb5f26e1a5e465d919f09a1a7d502233c3'));
  PERFORM set_config('cfoclose_fsi_release.applying', '', true);
END
$cfoclose_fsi_transport_fsi_2_integrity_gate$;