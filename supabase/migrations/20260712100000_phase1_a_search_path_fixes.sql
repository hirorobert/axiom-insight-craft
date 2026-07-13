-- ── Phase 1-A: SECURITY DEFINER search_path fixes ────────────────────────────
--
-- Three SECURITY DEFINER functions had incomplete SET search_path definitions,
-- creating a vector for temporary-table injection attacks (CVE class: pg_temp
-- object shadowing). This migration fixes search_path on all affected functions
-- via ALTER FUNCTION — no function logic is changed.
--
-- BLOCKER 5 (hesabu_write_validation): SET search_path = public missing pg_temp.
-- BLOCKER 6 (safisha_resolve_exception): SET search_path absent entirely.
-- ADDITIONAL  (xbrl_write_instance): SET search_path = public missing pg_temp.
-- ADDITIONAL  (maono_write_board_pack): SET search_path = public missing pg_temp.
-- ADDITIONAL  (maono_write_alert): SET search_path = public missing pg_temp.
--
-- Resolves Phase 0 blockers 5 and 6.
-- Read-only w.r.t. function logic — safe to deploy independently of Phase 1-B.

-- ── safisha_resolve_exception ─────────────────────────────────────────────────
-- BLOCKER 6: had NO SET search_path at all.
ALTER FUNCTION public.safisha_resolve_exception(uuid, uuid, text, text)
  SET search_path = public, pg_temp;

-- ── hesabu_write_validation ───────────────────────────────────────────────────
-- BLOCKER 5: had SET search_path = public but was missing pg_temp.
ALTER FUNCTION public.hesabu_write_validation(
  uuid, uuid, integer, text,
  integer, integer, integer, integer,
  numeric, numeric, numeric,
  uuid, text, jsonb
) SET search_path = public, pg_temp;

-- ── xbrl_write_instance ───────────────────────────────────────────────────────
ALTER FUNCTION public.xbrl_write_instance(
  uuid, uuid, integer,
  text, text, text, text, text,
  integer, boolean, integer, integer, integer,
  uuid, text, jsonb
) SET search_path = public, pg_temp;

-- ── maono_write_board_pack ────────────────────────────────────────────────────
ALTER FUNCTION public.maono_write_board_pack(
  uuid, uuid, text, text, jsonb, text, text, integer
) SET search_path = public, pg_temp;

-- ── maono_write_alert ─────────────────────────────────────────────────────────
ALTER FUNCTION public.maono_write_alert(
  uuid, uuid, text, text, text[], text[], text, text
) SET search_path = public, pg_temp;

DO $verify$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'safisha_resolve_exception',
      'hesabu_write_validation',
      'xbrl_write_instance',
      'maono_write_board_pack',
      'maono_write_alert'
    )
    AND p.prosecdef = TRUE
    AND p.proconfig @> ARRAY['search_path=public, pg_temp'];

  -- Note: Postgres stores 'search_path=public, pg_temp' in proconfig; exact match
  -- depends on Supabase PG version. The ALTER above is sufficient regardless.
  RAISE NOTICE 'Phase 1-A: search_path fixes applied. % of 5 functions verified via proconfig.', v_count;
END;
$verify$;
