INSERT INTO cfoclose_tra_release.staged_artifacts(batch, kind, body) VALUES ('tra-2-framework-guard', 'source', $cfoclose_tra_stage_80626d259948579f$-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261128100000 — Track A governed framework change, enforcement (release batch track-a-r1, migration 2 of 2).
-- Apply only AFTER 20261127100000 AND after the frontend that calls set_company_reporting_framework is published
-- (docs/release/track-a-r1/RECORD.md). Forward-only.
--
--   companies.reporting_framework may be changed only by set_company_reporting_framework. The guard reads no setting a
--   session can write. It requires BOTH (1) current_user = the OWNER of that SECURITY DEFINER function — a direct UPDATE by
--   anon, authenticated or service_role runs as that role and is refused — and (2) this transaction's own audited event
--   in company_framework_events for exactly this company, from-value and to-value (written by the function just before
--   its UPDATE; no API role can write that table). So another definer function owned by the same role cannot change the
--   framework without recording the audited event either. Refusal: 42501 FRAMEWORK_CHANGE_REQUIRES_RPC. An UPDATE that
--   does not change the value (other company edits that resend the same framework) is untouched. Company creation (INSERT, create_entity) is untouched.
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
  IF NOT EXISTS (SELECT 1 FROM public.company_framework_events e
                  WHERE e.company_id = NEW.id AND e.txid = pg_current_xact_id()
                    AND e.from_framework IS NOT DISTINCT FROM OLD.reporting_framework::text
                    AND e.to_framework = NEW.reporting_framework::text) THEN
    RAISE EXCEPTION 'FRAMEWORK_CHANGE_REQUIRES_RPC: no audited framework event of this transaction names this change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_company_reporting_framework() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_guard_company_reporting_framework ON public.companies;
CREATE TRIGGER trg_guard_company_reporting_framework BEFORE UPDATE OF reporting_framework ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_reporting_framework();
$cfoclose_tra_stage_80626d259948579f$);
