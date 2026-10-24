-- CFOClose fs-integrity-r1 staged transport: apply 20261123100000_fs_server_compilation.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing sign-off bindings and issued packs must be unchanged. One atomic statement.
DO $cfoclose_fsi_transport_fsi_1_server_compilation$
DECLARE
  c_batch CONSTANT text := 'fsi-1-server-compilation';
  c_prior CONSTANT text := NULL;
  c_prior_kinds CONSTANT integer := 0;
  c_predecessor CONSTANT text[] := ARRAY['8001cf3edcb607f62187c14eb4be57993c5f3f8e59d4b15d896d5a493a10e4c8', 'b52bfce78558469a20593e2237bdfd21c2eb07de615c56f378e04ca5ef695edf']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_source text; v_wrapper text; v_preflight text;
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
  IF (SELECT count(*) FROM cfoclose_fsi_release.staged_artifacts WHERE batch = c_batch) <> 3 THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly 3 staged artifacts; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.fs_server_compilations') IS NOT NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261123100000_fs_server_compilation.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 23305 AND s.body_sha256 = '7e25c896d34365c7ade29ee095f397a9d85979c74a5d2f5c8a9565ec1501e172';
  IF v_source IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 24869 AND s.body_sha256 = 'e008e54c68ac17ee25d095357ef35f45a308f7a648222bef85db7f0b9cb961f2';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_preflight FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'preflight' AND s.consumed_at IS NULL
     AND s.body_bytes = 6556 AND s.body_sha256 = '70f69d9e875080109d680d935c44dc33894bf484b163e7e196caa7d3fa25032d';
  IF v_preflight IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % preflight is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  v_baseline := (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_fsi_release.applying', c_batch, true);
  EXECUTE v_preflight;
  EXECUTE v_wrapper;
  IF NOT (to_regclass('public.fs_server_compilations') IS NOT NULL) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_POSTCONDITION: % did not install its target', '20261123100000_fs_server_compilation.sql' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_BASELINE_CHANGED: existing sign-off bindings or issued packs changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_fsi_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_fsi_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261123100000_fs_server_compilation.sql', 'baseline_sha256', v_baseline,
      'source_sha256', '7e25c896d34365c7ade29ee095f397a9d85979c74a5d2f5c8a9565ec1501e172',
      'wrapper_sha256', 'e008e54c68ac17ee25d095357ef35f45a308f7a648222bef85db7f0b9cb961f2',
      'preflight_sha256', '70f69d9e875080109d680d935c44dc33894bf484b163e7e196caa7d3fa25032d'));
  PERFORM set_config('cfoclose_fsi_release.applying', '', true);
END
$cfoclose_fsi_transport_fsi_1_server_compilation$;