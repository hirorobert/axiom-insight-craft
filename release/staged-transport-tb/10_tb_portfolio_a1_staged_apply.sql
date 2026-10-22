-- CFOClose Trial Balance staged transport: apply tb-portfolio-a1. GENERATED; do not edit.
-- Exact source, wrapper and postcondition bytes are checked before execution; this is one atomic statement.
DO $cfoclose_tb_transport_tb_portfolio_a1$
DECLARE
  c_batch CONSTANT text := 'tb-portfolio-a1';
  c_prior CONSTANT text := NULL;
  c_predecessor CONSTANT text[] := ARRAY['b1e2a1351880e13ccfa7823a38433cdfb4118d019fd2a5aeb7ff0a31796cb7d0', '3207bbc8f4a12885b64cccc365ba251a7582682e09dc0fddf7a63dc26733da28']::text[];
  v_n bigint; v_pred_id bigint; v_source text; v_wrapper text; v_postcondition text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_tb_release_transport', 0));
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_JOURNAL_MISSING: drizzle.__drizzle_migrations is not visible; nothing was changed' USING ERRCODE = '55000';
  END IF;
  -- Serialize the predecessor check and journal append against every writer, including other migration tools.
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;
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
  IF to_regclass('public.portfolio_revisions') IS NOT NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_UNCERTAIN_STATE: % already exists without a consumed transport record', 'public.portfolio_revisions' USING ERRCODE = '55000';
  END IF;
  SELECT s.body INTO v_source FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'source' AND s.consumed_at IS NULL
     AND s.body_bytes = 26579 AND s.body_sha256 = 'a9eb6ca77c26a29e7c6f4230e0466fa4320e07d5537ec1f2a6baafaf989873f7';
  IF v_source IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % source is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_wrapper FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'wrapper' AND s.consumed_at IS NULL
     AND s.body_bytes = 28141 AND s.body_sha256 = 'c07611e571c7c65bf986a47ea6105b9c99e7c898d65c18f53c9afc652d34e08d';
  IF v_wrapper IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % wrapper is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  SELECT s.body INTO v_postcondition FROM cfoclose_tb_release.staged_artifacts s
   WHERE s.batch = c_batch AND s.kind = 'postcondition' AND s.consumed_at IS NULL
     AND s.body_bytes = 4473 AND s.body_sha256 = '80c6181a3f03261aa1e90fe404c97720cb9e8263ba5bde51c55c93d6553dc36e';
  IF v_postcondition IS NULL THEN RAISE EXCEPTION 'TB_TRANSPORT_STAGE_MISSING_OR_MODIFIED: % postcondition is absent or modified; nothing was changed', c_batch USING ERRCODE = '55000'; END IF;
  PERFORM set_config('cfoclose_tb_release.applying', c_batch, true);
  EXECUTE v_wrapper;
  EXECUTE v_postcondition;
  IF to_regclass('public.portfolio_revisions') IS NULL THEN
    RAISE EXCEPTION 'TB_TRANSPORT_POSTCONDITION: % was not created', 'public.portfolio_revisions' USING ERRCODE = '55000';
  END IF;
  UPDATE cfoclose_tb_release.staged_artifacts SET consumed_at = clock_timestamp() WHERE batch = c_batch;
  INSERT INTO cfoclose_tb_release.transport_events(batch, event, detail)
    VALUES (c_batch, 'applied', jsonb_build_object('predecessor_journal_id', v_pred_id,
      'source_sha256', 'a9eb6ca77c26a29e7c6f4230e0466fa4320e07d5537ec1f2a6baafaf989873f7', 'wrapper_sha256', 'c07611e571c7c65bf986a47ea6105b9c99e7c898d65c18f53c9afc652d34e08d', 'postcondition_sha256', '80c6181a3f03261aa1e90fe404c97720cb9e8263ba5bde51c55c93d6553dc36e'));
  PERFORM set_config('cfoclose_tb_release.applying', '', true);
END
$cfoclose_tb_transport_tb_portfolio_a1$;