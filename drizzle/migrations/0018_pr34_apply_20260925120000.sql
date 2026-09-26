-- Applies authorized migration 20260925120000_reporting_pack_issuance_binding.sql
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed file at head c2c1e8e171f4c23b428d7affc14ae3ee103020ed.
DO $pr34$
DECLARE
  v_name TEXT := '20260925120000_reporting_pack_issuance_binding.sql';
  v_expected TEXT := '2be7dc36c3fbf9432b8eb606f35c2139bd834301ad7416694adc3a163b2550d3';
  v_body TEXT;
  v_sha  TEXT;
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex')
    INTO v_body, v_sha
    FROM public._pr34_migration_bodies WHERE name = v_name;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'PR34: authorized body % is not staged. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
  IF v_sha <> v_expected THEN
    RAISE EXCEPTION 'PR34: staged body % digest % does not match the reviewed digest %. Nothing was changed.', v_name, v_sha, v_expected USING ERRCODE = '55000';
  END IF;
  IF (SELECT applied_at FROM public._pr34_migration_bodies WHERE name = v_name) IS NOT NULL THEN
    RAISE EXCEPTION 'PR34: % is already recorded as applied. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
  EXECUTE v_body;
  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34$;