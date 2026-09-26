DO $$
DECLARE v text;
BEGIN
  SELECT current_user || ' | session=' || session_user || ' | super=' || (SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user) INTO v;
  RAISE NOTICE 'MIGRATION_SESSION: %', v;
  CREATE TABLE IF NOT EXISTS public._pr34_probe (id int);
  RAISE NOTICE 'PROBE_OWNER: %', (SELECT tableowner FROM pg_tables WHERE tablename = '_pr34_probe');
END
$$;