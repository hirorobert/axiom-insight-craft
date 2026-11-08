-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261220100000 — The database accepts a SECOND statement-compiler identity. AUTHORED, NOT APPLIED to any hosted database.
-- Forward-only; builds on 20261123100000 (server compilation, applied as drizzle 0076), which pins ONE compiler digest in the receipt table's
-- CHECK and in fs_record_server_compilation. That migration is applied and immutable, so the second identity is added here.
--
--   WHY: the compiler closure changed (a deliberate, reviewed change): a composed line may declare, per period, that a casting child with no
--   row in that period contributed nothing (StatementLine.castingNilPeriodIds; rule subtotal-casting 1.1.0 in canonical rule pack 2.3.0). This repairs
--   DEFECT-FS-RESTATED-COMPARATIVE-CASTING-001 (a restated comparative could not be signed) and
--   DEFECT-FS-NEW-ACCOUNT-COMPARATIVE-CASTING-001 (an account in one period only blocked sign-off). Rule pack 2.2.0 is unchanged
--   (version 1.0.0 of the rule ignores the declaration), so every receipt already recorded stays valid and reproducible.
--
--   WHAT IT DOES: (1) the receipt table accepts exactly two compiler digests; (2) fs_record_server_compilation accepts exactly two
--   (digest, rule pack version, engine version) triples - the original (49fc0852…, 2.2.0, 2.2.0) and the new (NEW, 2.3.0, 2.3.0) - and
--   nothing else. The function is re-created from its LIVE text with three anchored replacements, each asserted to occur exactly once; every
--   other line is unchanged. No row is read, written or rewritten. Nothing is granted.
--
--   DEPLOYMENT ORDER (the receipts are refused while either side is missing, never mis-recorded): apply this migration, THEN deploy
--   compile-financial-report with the regenerated bundle. The old function keeps working against the new database (old triple accepted).
--
-- PREFLIGHT: the receipt table, its single-digest CHECK and the function exist with the original pins; the new digest is a valid
-- sha-256. POSTCONDITION: the CHECK and the function accept both triples and refuse any other.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $digest_pin$
DECLARE
  v_old   constant text := '49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789';
  v_new   constant text := '112c5847675ecffa10048fd65012dfc9cc31377fbcf23e3d462cfc8fd95db9cc';
  v_con   text;
  v_def   text;
  v_new_def text;
  v_n     integer;
BEGIN
  IF v_new !~ '^[0-9a-f]{64}$' OR v_new = v_old THEN RAISE EXCEPTION 'PREFLIGHT: the new compiler digest is not a distinct sha-256' USING ERRCODE = 'PT422'; END IF;
  IF to_regclass('public.fs_server_compilations') IS NULL OR to_regprocedure('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: 20261123100000 (server compilation) is not installed' USING ERRCODE = 'PT422';
  END IF;

  -- (1) the receipt table: exactly the two digests.
  SELECT c.conname INTO v_con FROM pg_constraint c
   WHERE c.conrelid = 'public.fs_server_compilations'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%' || v_old || '%';
  IF v_con IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: the single-digest CHECK of fs_server_compilations was not found' USING ERRCODE = 'PT422'; END IF;
  EXECUTE format('ALTER TABLE public.fs_server_compilations DROP CONSTRAINT %I', v_con);
  EXECUTE format('ALTER TABLE public.fs_server_compilations ADD CONSTRAINT %I CHECK (compiler_sha256 IN (%L, %L))', v_con, v_old, v_new);

  -- (2) the receipt function, from its LIVE text.
  v_def := pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  v_new_def := v_def;

  v_n := (length(v_new_def) - length(replace(v_new_def, 'IF p_compiler_sha256 IS DISTINCT FROM ''' || v_old || ''' THEN', ''))) / length('IF p_compiler_sha256 IS DISTINCT FROM ''' || v_old || ''' THEN');
  IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: the digest guard occurs % times, expected 1', v_n USING ERRCODE = 'PT422'; END IF;
  v_new_def := replace(v_new_def, 'IF p_compiler_sha256 IS DISTINCT FROM ''' || v_old || ''' THEN',
                       'IF p_compiler_sha256 IS NULL OR p_compiler_sha256 NOT IN (''' || v_old || ''', ''' || v_new || ''') THEN');

  v_n := (length(v_new_def) - length(replace(v_new_def, 'OR p_evaluation->>''rulePackVersion'' IS DISTINCT FROM ''2.2.0'' OR p_evaluation->>''engineVersion'' IS DISTINCT FROM ''2.2.0''', ''))) / length('OR p_evaluation->>''rulePackVersion'' IS DISTINCT FROM ''2.2.0'' OR p_evaluation->>''engineVersion'' IS DISTINCT FROM ''2.2.0''');
  IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: the rule pack guard occurs % times, expected 1', v_n USING ERRCODE = 'PT422'; END IF;
  v_new_def := replace(v_new_def, 'OR p_evaluation->>''rulePackVersion'' IS DISTINCT FROM ''2.2.0'' OR p_evaluation->>''engineVersion'' IS DISTINCT FROM ''2.2.0''',
                       'OR NOT coalesce((p_compiler_sha256, p_evaluation->>''rulePackVersion'', p_evaluation->>''engineVersion'') IN ((''' || v_old || ''', ''2.2.0'', ''2.2.0''), (''' || v_new || ''', ''2.3.0'', ''2.3.0'')), false)');

  EXECUTE v_new_def;

  -- POSTCONDITION: both triples are in the function and the single-digest guard is gone.
  v_def := pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position(v_new IN v_def) = 0 OR position('IS DISTINCT FROM ''' || v_old || '''' IN v_def) > 0 OR position('''2.3.0''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_record_server_compilation does not accept exactly the two compiler identities' USING ERRCODE = 'PT422';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = v_con AND c.conrelid = 'public.fs_server_compilations'::regclass) NOT LIKE '%' || v_new || '%' THEN
    RAISE EXCEPTION 'POSTCONDITION: the receipt table does not accept the new digest' USING ERRCODE = 'PT422';
  END IF;
END
$digest_pin$;
