-- CFOClose Trial Balance staged transport: apply tb-decisions-b1. GENERATED; do not edit.
-- Exact source, wrapper and postcondition bytes are checked before execution; this is one atomic statement.
DO $cfoclose_tb_transport_tb_decisions_b1$
DECLARE
  c_batch CONSTANT text := 'tb-decisions-b1';
  c_prior CONSTANT text := 'tb-portfolio-a1';
  c_predecessor CONSTANT text[] := ARRAY['766d850ae427416d5f06a3d99cfc8ef8d8817f988a086cbfa80bccfb9bd23351', '1256018f69a7e61fdfd38f87d1aea6716a6df24ecdccb50bfd47f065fd3d3088']::text[];
  v_n bigint; v_pred_id bigint; v_source text; v_wrapper text; v_postcondition text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_tb_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), max(j.id) INTO v_n, v_pred_id FROM drizzle.__drizzle_migrations j WHERE j.hash = ANY (c_predecessor);
  IF v_n <> 1
     OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations j WHERE j.id > v_pred_id
                AND j.xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'TB_TRANSPORT_WRONG_PREDECESSOR: journal is not exactly the approved predecessor; nothing was changed' USING ERRCODE = '55000';
  END IF;
  IF c_prior IS NOT NULL AND (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_prior AND consumed_at IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_PRIOR_NOT_APPLIED: % must be applied before %; nothing was changed', c_prior, c_batch USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch FOR UPDATE;
  IF (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch AND consumed_at IS NOT NULL) = 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_ALREADY_APPLIED: % was already applied; nothing was changed', c_batch USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM cfoclose_tb_release.staged_artifacts WHERE batch = c_batch) <> 3 THEN
    RAISE EXCEPTION 'TB_TRANSPORT_UNCERTAIN_STAGE: % does not have exactly three immutable artifacts', c_batch USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.tb_decision_actions') IS NOT NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_UNCERTAIN_STATE: % already exists without a consumed transport record', 'public.tb_decision_actions' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 99185 AND s.body_sha256 = '223d15e3e7ee2d941af1c4152f7c206b6aceabee96624ae990b8ddf4282db216';
  IF v_source IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 100714 AND s.body_sha256 = 'dab3fa1720468119b5f24f97ed045c2116f7a086c75125e1db9f45f9b5b8e4d8';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_postcondition FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'postcondition' AND s.consumed_at IS NULL
     AND s.body_bytes = 11218 AND s.body_sha256 = '1cd683a26f3c22c22c2e8f9e9a9508b52087d4c678891c5f4aee92088937a98f';
  IF v_postcondition IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % postcondition is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  PERFORM set_config('cfoclose_tb_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;
  IF to_regclass('public.tb_decision_actions') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_POSTCONDITION: % was not created', 'public.tb_decision_actions' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_tb_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_tb_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id,
      'source_sha256', '223d15e3e7ee2d941af1c4152f7c206b6aceabee96624ae990b8ddf4282db216', 'wrapper_sha256', 'dab3fa1720468119b5f24f97ed045c2116f7a086c75125e1db9f45f9b5b8e4d8', 'postcondition_sha256', '1cd683a26f3c22c22c2e8f9e9a9508b52087d4c678891c5f4aee92088937a98f'));
  PERFORM set_config('cfoclose_tb_release.applying', '', true);
END
$cfoclose_tb_transport_tb_decisions_b1$;