-- Applies authorized prerequisite 20260915100000_financial_statement_documents.sql
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed Git blob cc830915b2cc7a93b25a0b4514458f056294b9fb at head
-- c2c1e8e171f4c23b428d7affc14ae3ee103020ed (18569 bytes).
DO $pr34$
DECLARE
  v_name TEXT := '20260915100000_financial_statement_documents.sql';
  v_expected TEXT := 'e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712';
  v_body TEXT;
  v_sha  TEXT;
  v_bytes INT;
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), octet_length(body)
    INTO v_body, v_sha, v_bytes
    FROM public._pr34_migration_bodies WHERE name = v_name;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'PR34: authorized body % is not staged. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
  IF v_sha <> v_expected THEN
    RAISE EXCEPTION 'PR34: staged body % digest % does not match the authorized digest %. Nothing was changed.', v_name, v_sha, v_expected USING ERRCODE = '55000';
  END IF;
  IF v_bytes <> 18569 THEN
    RAISE EXCEPTION 'PR34: staged body % has % bytes, expected 18569. Nothing was changed.', v_name, v_bytes USING ERRCODE = '55000';
  END IF;
  EXECUTE v_body;
  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34$;