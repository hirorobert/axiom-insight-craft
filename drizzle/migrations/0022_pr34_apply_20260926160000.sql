-- Digest-guarded application of the reviewed, authorized migration
-- supabase/migrations/20260926160000_trial_balance_processing_entitlement_wall.sql
-- (approved head f21a58f7a8e9e2aa09840e5af716e445f6ab0b8b, SHA-256
--  d032fb0821210b59937e8f513d5de126fb31bbcffff151a91d459dd33914e868).
-- The body is read verbatim from the staging table public._pr34_migration_bodies and is executed only
-- when its digest matches exactly. Applying a second time is a no-op (applied_at already set).
DO $pr34_wrap_20260926160000$
DECLARE
  v_name TEXT := '20260926160000_trial_balance_processing_entitlement_wall.sql';
  v_expected TEXT := 'd032fb0821210b59937e8f513d5de126fb31bbcffff151a91d459dd33914e868';
  v_body TEXT;
  v_sha TEXT;
  v_applied TIMESTAMPTZ;
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), applied_at
    INTO v_body, v_sha, v_applied
  FROM public._pr34_migration_bodies WHERE name = v_name;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'refused: reviewed migration body % is not staged', v_name USING ERRCODE = '55000';
  END IF;
  IF v_sha IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'refused: staged body digest % does not match the authorized digest %', v_sha, v_expected USING ERRCODE = '55000';
  END IF;
  IF v_applied IS NOT NULL THEN
    RAISE NOTICE 'already applied at %, nothing to do', v_applied;
    RETURN;
  END IF;

  EXECUTE v_body;

  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34_wrap_20260926160000$;