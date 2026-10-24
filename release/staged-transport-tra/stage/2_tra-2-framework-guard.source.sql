INSERT INTO cfoclose_tra_release.staged_artifacts(batch, kind, body) VALUES ('tra-2-framework-guard', 'source', $cfoclose_tra_stage_e5ff37296d50e152$-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261128100000 — Track A governed framework change, enforcement (release batch track-a-r1, migration 2 of 2).
-- Apply only AFTER 20261127100000 AND after the frontend that calls set_company_reporting_framework is published
-- (docs/release/track-a-r1/RECORD.md). Forward-only.
--
--   companies.reporting_framework may be changed only by set_company_reporting_framework. The guard does not read any
--   setting a session can write: it compares current_user with the OWNER of that SECURITY DEFINER function. A direct UPDATE
--   by anon, authenticated or service_role runs as that role and is refused (42501 FRAMEWORK_CHANGE_REQUIRES_RPC); inside
--   the function the update runs as its owner and passes. An UPDATE that does not change the value (other company edits that
--   resend the same framework) is untouched. Company creation (INSERT, create_entity) is untouched.
--   LIMIT: the function owner and a database administrator can still update directly; they are outside this control.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $pre$
BEGIN
  IF to_regprocedure('public.set_company_reporting_framework(uuid,text,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'TRACK_A_ORDER: apply 20261127100000 first' USING ERRCODE = '55000';
  END IF;
END;
$pre$;

CREATE OR REPLACE FUNCTION public.guard_company_reporting_framework()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_writer name;
BEGIN
  IF NEW.reporting_framework IS NOT DISTINCT FROM OLD.reporting_framework THEN
    RETURN NEW;
  END IF;
  SELECT pg_get_userbyid(p.proowner) INTO v_writer FROM pg_proc p
   WHERE p.oid = 'public.set_company_reporting_framework(uuid,text,text,text,uuid)'::regprocedure;
  IF v_writer IS NULL OR current_user IS DISTINCT FROM v_writer THEN
    RAISE EXCEPTION 'FRAMEWORK_CHANGE_REQUIRES_RPC: the reporting framework changes only through set_company_reporting_framework (audited)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_company_reporting_framework() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_company_reporting_framework ON public.companies;
CREATE TRIGGER trg_guard_company_reporting_framework BEFORE UPDATE OF reporting_framework ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_reporting_framework();
$cfoclose_tra_stage_e5ff37296d50e152$);
