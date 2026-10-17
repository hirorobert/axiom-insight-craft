-- 20261108100000_account_identity_codeless_name.sql — accounts with different codes may share a name
-- (authorised processing-integrity repair B, 2026-10-16). Forward-only; nothing existing is edited.
--
-- The defect: an account's identity is account_key = COALESCE(account_code, normalized_account_name) — unique per
-- company (the key index, 20260703120000), and every review write is ON CONFLICT (company_id, account_key). The older
-- partial all-names index (company_id, normalized_account_name) WHERE the name is not NULL (20260703100000, kept "as
-- belt-and-suspenders") enforces a DIFFERENT identity — the name, for every account — so two coded accounts with the
-- same name (4000 "Sales", 4100 "Sales") could not both be reviewed: the second review failed with a raw unique
-- violation (23505), as did renaming a coded account to a name another code already used.
--
-- The repair: that index is replaced by uq_acct_map_company_codeless_name — name uniqueness ONLY where the name IS the
-- identity (account_code IS NULL), NULLS NOT DISTINCT (one global codeless row per name). Nothing else changes: code
-- uniqueness and key uniqueness are untouched; company_id stays in every key (tenant isolation unchanged); no row is
-- rewritten, merged or removed; every account key, decision and its history stays as it is.
--
-- Identity by DEFINITION, never by name (hosted correction, release 96305da). The hosted database carries the
-- 20260703100000 indexes under names no migration in this repository creates (uq_mappings_company_code,
-- uq_mappings_company_name), while a replayed chain carries uq_acct_map_company_code / uq_acct_map_company_norm_name.
-- A name is not proof of equivalence, so every unique index on public.account_mappings that names account_code,
-- account_key or normalized_account_name is classified from the catalog: unique, valid, ready and live; plain key
-- columns in exact order; no INCLUDE columns; default operator classes and the columns' own collations; the exact
-- deparsed predicate; NULLS [NOT] DISTINCT; and no dependent object.
--   KEY        (company_id, account_key), no predicate, NULLS NOT DISTINCT — required, kept unchanged;
--   CODE       (company_id, account_code) WHERE (account_code IS NOT NULL) — required, kept unchanged (KEY already
--              implies it: account_key = account_code for every coded row);
--   ALL-NAMES  (company_id, normalized_account_name) WHERE (normalized_account_name IS NOT NULL) — at least one
--              required; each is dropped by its own catalog name;
--   CODELESS   the target — must be absent before.
-- Any other such unique index, any deviation in the attributes above, or a dependent object on an ALL-NAMES index
-- refuses the whole migration and changes nothing. A postcondition re-reads the catalog and refuses (rolling
-- everything back) unless KEY and CODE are exactly as before, CODELESS is in force and no ALL-NAMES index remains.
-- The whole migration is ONE statement, so it is atomic under any executor.
--
-- Compatibility (inspected, every writer and reader):
--   * The only writer, resolve_account_review_batch (latest 20261007100000), conflicts on (company_id, account_key); it
--     never relied on name uniqueness. Client writes are refused (account_mappings_client_write_guard, 20261006100000).
--   * Every rule the old index enforced for CODELESS rows still holds: their account_key IS the normalized name, so the
--     key index already implied it; the new index states it explicitly.
--   * Readers that key by account_key or account_code (certifiedTbSource cash perimeter, the statements workspace,
--     kinga-findings-engine, get_effective_non_reporting_status by review_account_key) are unaffected.
--   * process-trial-balance's name fallback (Tier 2) used a last-wins Map that was deterministic only because of the
--     old index. Generation 6 of the function (same change set) matches names by counting candidates: zero, one, or
--     several — several is never resolved by picking one; it goes to review. A coded account never takes a decision
--     made for a different code by name.
--   * Older engines (generation 5 and earlier) keep last-wins over coded same-name rows that can now exist; a floor of
--     6 (processing_release_control.min_engine_generation) retires them once generation 6 is deployed.

DO $repair$
DECLARE
  c_code_pred     CONSTANT text := '(account_code IS NOT NULL)';
  c_names_pred    CONSTANT text := '(normalized_account_name IS NOT NULL)';
  c_codeless_pred CONSTANT text := '((account_code IS NULL) AND (normalized_account_name IS NOT NULL))';
  v_rel        regclass := to_regclass('public.account_mappings');
  r            record;
  v_key        text[] := '{}';
  v_code       text[] := '{}';
  v_names      text[] := '{}';
  v_names_def  text[] := '{}';
  v_codeless   text[] := '{}';
  v_key_after  text[] := '{}';
  v_code_after text[] := '{}';
  v_name       text;
BEGIN
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: public.account_mappings is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- ── Preflight: classify every account-identity unique index by its definition ───────────────────────────────────
  FOR r IN
    SELECT c.relname::text AS name,
           pg_get_indexdef(i.indexrelid) AS def,
           i.indisvalid AND i.indisready AND i.indislive AS healthy,
           i.indexprs IS NULL AND i.indnkeyatts = i.indnatts AS plain,
           i.indnullsnotdistinct AS nnd,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
           pg_get_expr(i.indpred, i.indrelid) AS pred,
           NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) x(opc) JOIN pg_opclass o ON o.oid = x.opc WHERE NOT o.opcdefault)
             AS default_opclasses,
           NOT EXISTS (SELECT 1 FROM unnest(i.indkey::int2[], i.indcollation::oid[]) k(attnum, coll)
                         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                        WHERE k.coll IS DISTINCT FROM a.attcollation) AS own_collations,
           NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = i.indexrelid)
             AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) AS free
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = v_rel AND i.indisunique
  LOOP
    IF NOT (r.cols && ARRAY['account_code', 'account_key', 'normalized_account_name']) THEN
      CONTINUE;  -- not an account-identity index (e.g. the primary key)
    END IF;
    IF r.cols = ARRAY['company_id', 'normalized_account_name'] AND r.pred = c_codeless_pred THEN
      v_codeless := v_codeless || r.name;
    ELSIF NOT (r.healthy AND r.plain AND r.default_opclasses AND r.own_collations) THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: account identity index % is not valid, plain and default (%); nothing was changed', r.name, r.def
        USING ERRCODE = 'P0001';
    ELSIF r.cols = ARRAY['company_id', 'account_key'] AND r.pred IS NULL AND r.nnd THEN
      v_key := v_key || r.name;
    ELSIF r.cols = ARRAY['company_id', 'account_code'] AND r.pred = c_code_pred THEN
      v_code := v_code || r.name;
    ELSIF r.cols = ARRAY['company_id', 'normalized_account_name'] AND r.pred = c_names_pred AND r.free THEN
      v_names := v_names || r.name;
      v_names_def := v_names_def || r.def;
    ELSE
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: unique index % on account_mappings is not a recognised account-identity definition (%); nothing was changed', r.name, r.def
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF cardinality(v_codeless) > 0 OR to_regclass('public.uq_acct_map_company_codeless_name') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the codeless name identity is already in force; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_key) = 0 OR cardinality(v_code) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the account key or code identity index is missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF cardinality(v_names) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: no all-names identity index to replace; nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- ── Repair ────────────────────────────────────────────────────────────────────────────────────────────────────────
  CREATE UNIQUE INDEX uq_acct_map_company_codeless_name
    ON public.account_mappings (company_id, normalized_account_name)
    NULLS NOT DISTINCT
    WHERE account_code IS NULL AND normalized_account_name IS NOT NULL;

  FOREACH v_name IN ARRAY v_names LOOP
    EXECUTE format('DROP INDEX public.%I', v_name);
  END LOOP;

  COMMENT ON INDEX public.uq_acct_map_company_codeless_name IS
    'An account without a code is identified by its normalized name: one per company (one global). Accounts with codes '
    'are identified by their code and may share a name (20261108100000).';

  -- ── Postcondition: the end state, re-read from the catalog ─────────────────────────────────────────────────────────
  v_codeless := '{}';
  FOR r IN
    SELECT c.relname::text AS name, i.indisvalid AND i.indisready AND i.indislive AS healthy, i.indnullsnotdistinct AS nnd,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
           pg_get_expr(i.indpred, i.indrelid) AS pred
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = v_rel AND i.indisunique
  LOOP
    IF r.cols = ARRAY['company_id', 'normalized_account_name'] AND r.pred = c_names_pred THEN
      RAISE EXCEPTION 'POSTCONDITION_FAILED: all-names index % remains; everything was rolled back', r.name USING ERRCODE = 'P0001';
    ELSIF r.cols = ARRAY['company_id', 'normalized_account_name'] AND r.pred = c_codeless_pred AND r.healthy AND r.nnd THEN
      v_codeless := v_codeless || r.name;
    ELSIF r.cols = ARRAY['company_id', 'account_key'] AND r.pred IS NULL THEN
      v_key_after := v_key_after || r.name;
    ELSIF r.cols = ARRAY['company_id', 'account_code'] AND r.pred = c_code_pred THEN
      v_code_after := v_code_after || r.name;
    END IF;
  END LOOP;
  IF v_codeless IS DISTINCT FROM ARRAY['uq_acct_map_company_codeless_name']
     OR (SELECT array_agg(x ORDER BY x) FROM unnest(v_key_after) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_key) x)
     OR (SELECT array_agg(x ORDER BY x) FROM unnest(v_code_after) x) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(v_code) x) THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: account identity indexes are not in the expected end state; everything was rolled back'
      USING ERRCODE = 'P0001';
  END IF;
  RAISE NOTICE 'account identity: kept key %, kept code %, replaced % by uq_acct_map_company_codeless_name', v_key, v_code, v_names_def;
END;
$repair$;

-- ── Rollback (manual) ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Only while no two coded rows of one company share a normalized name (otherwise the old index cannot be rebuilt;
-- such rows are distinct accounts and must not be merged to make it fit): re-run the exact CREATE UNIQUE INDEX
-- definition(s) the NOTICE above recorded as replaced (uq_acct_map_company_norm_name on a replayed chain), then
-- DROP INDEX IF EXISTS public.uq_acct_map_company_codeless_name;
