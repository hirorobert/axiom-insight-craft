-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261222200000 — The database accepts the THIRD statement-compiler identity: the compiler that carries both the restated-comparative
-- casting change (20261220100000, PR #259) and the transfers / post-closing change (20261222100000, PR #268). AUTHORED, NOT APPLIED to
-- any hosted database. Forward-only; builds on 20261123100000 (server compilation, applied; pins ONE digest) and on 20261220100000 (the
-- second identity). Both are immutable once applied, so the third identity is added here.
--
--   WHY: the compiler closure changed again (a deliberate, reviewed change): the evidence schema 1.1.0 ledger with transfers between
--   cash accounts (S2-A01) and canonical rule pack 2.4.0 = 2.3.0 + `comprehensive-income-activity` 1.0.0 (S2-A02); 2.3.0 is 2.2.0 +
--   `subtotal-casting` 1.1.0 (declared-nil casting). Rule packs 2.2.0 and 2.3.0 are unchanged, so every receipt already recorded
--   stays valid and reproducible. INTEGRATION NOTE: this file was authored by PR #268 as the SECOND identity (original → 2.4.0)
--   beside a reserved 2.3.0; once #259's identity exists in the same chain it is the THIRD, and it widens #259's state instead of
--   the original single-digest state (the original text said: "WHICHEVER OF THE TWO MERGES SECOND must regenerate the bundle and
--   widen the accepted identities to main's applied one and its own"). Neither earlier identity has been applied to any hosted database.
--
--   WHAT IT DOES: (1) the receipt table accepts exactly three compiler digests; (2) fs_record_server_compilation accepts exactly three
--   (digest, rule pack version, engine version) triples — the original (49fc0852…, 2.2.0, 2.2.0), #259's (112c5847…, 2.3.0, 2.3.0) and
--   the new (NEW, 2.4.0, 2.4.0) — and nothing else. The function is re-created from its LIVE text with two anchored replacements, each
--   asserted to occur exactly once; every other line is unchanged. No row is read, written or rewritten. Nothing is granted.
--
--   DEPLOYMENT ORDER (the receipts are refused while either side is missing, never mis-recorded): apply 20261220100000,
--   20261222100000 and this migration, THEN deploy compile-financial-report with the regenerated bundle, THEN publish the frontend.
--   The deployed (older) function keeps working against the new database (its triple is still accepted).
--
-- Idempotent: already installed (a replay, or a proof that applied it early) is a no-op; anything half-installed fails the
-- postcondition. Refused (PREFLIGHT) unless the second identity (20261220100000) is the installed state.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $digest_pin$
DECLARE
  v_old   constant text := '49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789';
  v_mid   constant text := '112c5847675ecffa10048fd65012dfc9cc31377fbcf23e3d462cfc8fd95db9cc';
  v_new   constant text := '9f79ce716e232177c71a7e469e1b30ba779d4e7fc605e0fae07fe09cc67165be';
  v_sig   constant text := 'public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)';
  v_con   text;
  v_def   text;
  v_from  text[];
  v_to    text[];
  i       integer;
  v_n     integer;
BEGIN
  IF v_new !~ '^[0-9a-f]{64}$' OR v_new IN (v_old, v_mid) THEN RAISE EXCEPTION 'PREFLIGHT: the new compiler digest is not a distinct sha-256' USING ERRCODE = 'PT422'; END IF;
  IF to_regclass('public.fs_server_compilations') IS NULL OR to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: 20261123100000 (server compilation) is not installed' USING ERRCODE = 'PT422';
  END IF;
  IF position(v_new IN pg_get_functiondef(v_sig::regprocedure)) > 0 THEN RETURN; END IF;

  -- (1) the receipt table: exactly the original and the second digest before this file (refused otherwise: widen the identities together).
  SELECT c.conname INTO v_con FROM pg_constraint c
   WHERE c.conrelid = 'public.fs_server_compilations'::regclass AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%' || v_old || '%' AND pg_get_constraintdef(c.oid) LIKE '%' || v_mid || '%';
  IF v_con IS NULL OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = v_con AND c.conrelid = 'public.fs_server_compilations'::regclass)
       IS DISTINCT FROM format('CHECK ((compiler_sha256 = ANY (ARRAY[%L::text, %L::text])))', v_old, v_mid) THEN
    RAISE EXCEPTION 'PREFLIGHT: the digest CHECK of fs_server_compilations is not the two-digest pin of 20261220100000 (apply 20261220100000 first; another compiler identity is installed: widen all together)' USING ERRCODE = 'PT422';
  END IF;
  EXECUTE format('ALTER TABLE public.fs_server_compilations DROP CONSTRAINT %I', v_con);
  EXECUTE format('ALTER TABLE public.fs_server_compilations ADD CONSTRAINT %I CHECK (compiler_sha256 IN (%L, %L, %L))', v_con, v_old, v_mid, v_new);

  -- (2) the receipt function, from its LIVE text (the two-identity text written by 20261220100000).
  v_def := pg_get_functiondef(v_sig::regprocedure);
  v_from := ARRAY['IF p_compiler_sha256 IS NULL OR p_compiler_sha256 NOT IN (''' || v_old || ''', ''' || v_mid || ''') THEN',
                  'OR NOT coalesce((p_compiler_sha256, p_evaluation->>''rulePackVersion'', p_evaluation->>''engineVersion'') IN ((''' || v_old || ''', ''2.2.0'', ''2.2.0''), (''' || v_mid || ''', ''2.3.0'', ''2.3.0'')), false)'];
  v_to := ARRAY['IF p_compiler_sha256 IS NULL OR p_compiler_sha256 NOT IN (''' || v_old || ''', ''' || v_mid || ''', ''' || v_new || ''') THEN',
                'OR NOT coalesce((p_compiler_sha256, p_evaluation->>''rulePackVersion'', p_evaluation->>''engineVersion'') IN ((''' || v_old || ''', ''2.2.0'', ''2.2.0''), (''' || v_mid || ''', ''2.3.0'', ''2.3.0''), (''' || v_new || ''', ''2.4.0'', ''2.4.0'')), false)'];
  FOR i IN 1 .. 2 LOOP
    v_n := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    IF v_n <> 1 THEN RAISE EXCEPTION 'PREFLIGHT: fs_record_server_compilation anchor % occurs % times, expected 1 (is 20261220100000 installed?)', i, v_n USING ERRCODE = 'PT422'; END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;
  EXECUTE v_def;

  -- POSTCONDITION: the three triples are in the function, the earlier two-identity guards are gone, the table accepts the new digest.
  v_def := pg_get_functiondef(v_sig::regprocedure);
  IF position(v_new IN v_def) = 0 OR position(v_mid IN v_def) = 0 OR position(v_old IN v_def) = 0
     OR position('IS DISTINCT FROM ''' || v_old || '''' IN v_def) > 0
     OR position('NOT IN (''' || v_old || ''', ''' || v_mid || ''') THEN' IN v_def) > 0
     OR position('''2.4.0''' IN v_def) = 0 OR position('''2.3.0''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION: fs_record_server_compilation does not accept exactly the three compiler identities' USING ERRCODE = 'PT422';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conname = v_con AND c.conrelid = 'public.fs_server_compilations'::regclass) NOT LIKE '%' || v_new || '%' THEN
    RAISE EXCEPTION 'POSTCONDITION: the receipt table does not accept the new digest' USING ERRCODE = 'PT422';
  END IF;
END
$digest_pin$;
