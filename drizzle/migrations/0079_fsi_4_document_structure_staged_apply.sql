-- CFOClose fs-integrity-r1 staged transport: apply 20261126100000_fs_document_structure.sql. GENERATED; do not edit.
-- Exact staged bytes are checked before execution; existing sign-off bindings and issued packs must be unchanged. One atomic statement.
DO $cfoclose_fsi_transport_fsi_4_document_structure$
DECLARE
  c_batch CONSTANT text := 'fsi-4-document-structure';
  c_prior CONSTANT text := 'fsi-3-final-authority';
  c_prior_kinds CONSTANT integer := 2;
  c_predecessor CONSTANT text[] := ARRAY['b592d692c0b63614aee8ec67cd46e09272e9527571c9b6bef28ce3fd8bdc0f69', 'a2b3ba596dbfdd972e9a0d7a767f961ed8cd92958f14d7b5771168d49f97f2fd']::text[];
  v_n bigint; v_pred_id bigint; v_baseline text; v_source text; v_wrapper text; v_postcondition text;
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
  IF to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_UNCERTAIN_STATE: % appears installed without a consumed transport record', '20261126100000_fs_document_structure.sql' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 62060 AND s.body_sha256 = '81ffd8ecdb4ad6ef292a8608dabb9a9cc7f41f4dfa972f66ec5d2cae398dcb39';
  IF v_source IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 63624 AND s.body_sha256 = '9025d0bede105b0c85a8d7fb6525cabab4d2a9f27f154183b9fbd13b0294c2bc';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_postcondition FROM cfoclose_fsi_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'postcondition' AND s.consumed_at IS NULL
     AND s.body_bytes = 9618 AND s.body_sha256 = '05326ba1407b0ddfeba3a3fcc08780e5ffa789b1277af9e1f496b77c88e5bc6a';
  IF v_postcondition IS NULL THEN RAISE EXCEPTION 'FSI_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % postcondition is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  v_baseline := (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex'));
  PERFORM set_config('cfoclose_fsi_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;
  IF NOT (to_regprocedure('public._fs_document_structure_blockers(uuid, integer, jsonb, text[])') IS NOT NULL) THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_POSTCONDITION: % did not install its target', '20261126100000_fs_document_structure.sql' USING ERRCODE = '55000';
  END IF;
  IF (SELECT encode(sha256(convert_to(
      coalesce((SELECT string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq) FROM public.fs_publication_bindings f), '') || chr(30) ||
      coalesce((SELECT string_agg(to_jsonb(i)::text, chr(10) ORDER BY i.id) FROM public.reporting_pack_issuances i WHERE i.consumed_at IS NOT NULL), ''),
    'UTF8')), 'hex')) IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'FSI_TRANSPORT_BASELINE_CHANGED: existing sign-off bindings or issued packs changed; rolled back' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_fsi_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_fsi_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id, 'source', '20261126100000_fs_document_structure.sql', 'baseline_sha256', v_baseline,
      'source_sha256', '81ffd8ecdb4ad6ef292a8608dabb9a9cc7f41f4dfa972f66ec5d2cae398dcb39',
      'wrapper_sha256', '9025d0bede105b0c85a8d7fb6525cabab4d2a9f27f154183b9fbd13b0294c2bc',
      'postcondition_sha256', '05326ba1407b0ddfeba3a3fcc08780e5ffa789b1277af9e1f496b77c88e5bc6a'));
  PERFORM set_config('cfoclose_fsi_release.applying', '', true);
END
$cfoclose_fsi_transport_fsi_4_document_structure$;