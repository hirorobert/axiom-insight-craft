-- Digest-guarded application of the reviewed, authorized migration
-- supabase/migrations/20260927100000_trial_balance_remove_from_active_use.sql
-- (approved main head 0d2a09eaed9cd6f96790d57bfeb4cf681877b743, SHA-256
--  f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157).
-- The body is read verbatim from the staging table public._pr34_migration_bodies and is executed only
-- when its digest matches exactly. Applying a second time is a no-op (applied_at already set).
DO $pr34_wrap_20260927100000$
DECLARE
  v_name TEXT := '20260927100000_trial_balance_remove_from_active_use.sql';
  v_expected TEXT := 'f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157';
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
$pr34_wrap_20260927100000$;