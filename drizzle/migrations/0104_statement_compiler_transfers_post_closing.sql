-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261222200000 — The database accepts the statement-compiler identity of 20261222100000's change. AUTHORED, NOT APPLIED to any
-- hosted database. Forward-only; builds on 20261123100000 (server compilation, applied), which pins ONE compiler digest in the
-- receipt table's CHECK and in fs_record_server_compilation. That migration is applied and immutable, so the identity is added here.
--
--   WHY: the compiler closure changed (a deliberate, reviewed change): the evidence schema 1.1.0 ledger with transfers between
--   cash accounts (S2-A01) and canonical rule pack 2.4.0 = 2.2.0 + `comprehensive-income-activity` 1.0.0 (S2-A02). Rule pack
--   2.2.0 is unchanged, so every receipt already recorded stays valid and reproducible.
--
--   WHAT IT DOES: (1) the receipt table accepts exactly two compiler digests; (2) fs_record_server_compilation accepts exactly two
--   (digest, rule pack version, engine version) triples — the original (49fc0852…, 2.2.0, 2.2.0) and the new (NEW, 2.4.0, 2.4.0) —
--   and nothing else. The function is re-created from its LIVE text with two anchored replacements, each asserted to occur exactly
--   once; every other line is unchanged. No row is read, written or rewritten. Nothing is granted. Same pattern as
--   20261220100000 (PR #259, a different identity with rule pack 2.3.0): WHICHEVER OF THE TWO MERGES SECOND must regenerate the
--   bundle (node scripts/buildStatementCompiler.mjs) and widen the accepted identities to main's applied one and its own.
--
--   DEPLOYMENT ORDER (the receipts are refused while either side is missing, never mis-recorded): apply 20261222100000 and this
--   migration, THEN deploy compile-financial-report with the regenerated bundle, THEN publish the frontend. The deployed (old)
--   function keeps working against the new database (old triple accepted).
--
-- Idempotent: already installed (a replay, or a proof that applied it early) is a no-op; anything half-installed fails the
-- postcondition.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $digest_pin$
DECLARE
  v_old   constant text := '49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789';
  v_new   constant text := '12314dadd6e24dff7a13fa2e0b1dfde5d22905a8d4b97bf91894a8508d1488df';
  v_sig   constant text := 'public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)';
  v_con   text;
  v_def   text;
  v_from  text[];
  v_to    text[];
  i       integer;
  v_n     integer;
BEGIN
  IF v_new !~ '^[0-9a-f]{64}$' OR v_new = v_old THEN RAISE EXCEPTION 'PREFLIGHT: the new compiler digest is not a distinct sha-256' USING ERRCODE = 'PT422'; END IF;
  IF to_regclass('public.fs_server_compilations') IS NULL OR to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: 20261123100000 (server compilation) is not installed' USING ERRCODE = 'PT422';
  END IF;
  IF position(v_new IN pg_get_functiondef(v_sig::regprocedure)) > 0 THEN RETURN; END IF;

  -- (1) the receipt table: exactly the two digests (refused if another identity was installed first: widen both together).
  SELECT c.conname INTO v_con FROM pg_constraint c
   WHERE c.conrelid = 'public.fs_server_compilations'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%' || v_old || '%';
  IF v_con IS NULL OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = v_con AND c.conrelid = 'public.fs_server_compilations'::regclass)
       IS DISTINCT FROM format('CHECK ((compiler_sha256 = %L::text))', v_old) THEN
    RAISE EXCEPTION 'PREFLIGHT: the digest CHECK of fs_server_compilations is not the single-digest pin of 20261123100000 (another compiler identity is installed: regenerate and widen both together)' USING ERRCODE = 'PT422';
  END IF;
  EXECUTE format('ALTER TABLE public.fs_server_compilations DROP CONSTRAINT %I', v_con);
  EXECUTE format('ALTER TABLE public.fs_server_compilations ADD CONSTRAINT %I CHECK (compiler_sha256 IN (%L, %L))', v_con, v_old, v_new);

  -- (2) the receipt function, from its LIVE text.
  v_def := pg_get_functiondef(v_sig::regprocedure);
  v_from := ARRAY['IF p_compiler_sha256 IS DISTINCT FROM ''' || v_old || ''' THEN',
                  'OR p_evaluation->>''rulePackVersion'' IS DISTINCT FROM ''2.2.0'' OR p_evaluation->>''engineVersion'' IS DISTINCT FROM ''2.2.0'''];
  v_to := ARRAY['IF p_compiler_sha256 IS NULL OR p_compiler_sha256 NOT IN (''' || v_old || ''', ''' || v_new || ''') THEN',
                'OR NOT coalesce((p_compiler_sha256, p_evaluation->>''rulePackVersion'', p_evaluation->>''engineVersion'') IN ((''' || v_old || ''', ''2.2.0'', ''2.2.0''), (''' || v_new || ''', ''2.4.0'', ''2.4.0'')), false)'];
  FOR i IN 1 .. 2 LOOP
    v_n := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: fs_record_server_compilation anchor % occurs % times, expected 1', i, v_n USING ERRCODE = 'PT422'; END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;
  EXECUTE v_def;

  -- POSTCONDITION: both triples are in the function, the single-digest guard is gone, the table accepts the new digest.
  v_def := pg_get_functiondef(v_sig::regprocedure);
  IF position(v_new IN v_def) = 0 OR position('IS DISTINCT FROM ''' || v_old || '''' IN v_def) > 0 OR position('''2.4.0''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_record_server_compilation does not accept exactly the two compiler identities' USING ERRCODE = 'PT422';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = v_con AND c.conrelid = 'public.fs_server_compilations'::regclass) NOT LIKE '%' || v_new || '%' THEN
    RAISE EXCEPTION 'POSTCONDITION: the receipt table does not accept the new digest' USING ERRCODE = 'PT422';
  END IF;
END
$digest_pin$;
