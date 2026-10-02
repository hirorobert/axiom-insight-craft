-- 20261002100000_refuse_withheld_service_grants.sql
--
-- Tax computation, Compliance review, Filing package and Monitoring are withheld from customers (frontend boundary:
-- src/lib/workspace/moduleAvailability.ts — the customer scope is Trial balance review). This migration makes the
-- database refuse every NEW grant of those four services, whatever the path: open_engagement_with_scope,
-- grant_engagement_capability, any other function, or a direct write by any role (service_role and the table owner
-- included). Every grant path ends in one INSERT of a 'GRANT' row
-- into public.engagement_mandate_events, so the refusal sits there, once.
--
-- What it does NOT do:
--   · no existing row is read, changed or removed — the trigger fires on INSERT only, so every historical grant, revoke,
--     engagement and accounting record stays byte-identical and readable (fold_engagement_mandate is unchanged);
--   · no backend function, table, RPC, edge function, tax calculation or jurisdiction pack is changed or removed;
--   · REVOKE events are unaffected (a service can still be withdrawn), and FINANCIAL_STATEMENTS stays grantable: it is the
--     authority for Prepare and Reconcile. A withdrawn withheld service cannot be granted again.
-- A refused request is atomic: the calling transaction rolls back, so open_engagement_with_scope creates no engagement,
-- period or grant when it names a withheld service.
--
-- Controlled error: SQLSTATE PT422, message SERVICE_NOT_AVAILABLE — no internal wording.
-- Forward-only and replay-safe: CREATE OR REPLACE for both the function and the trigger; re-applying changes nothing.
-- Re-enabling a service is a separate, reviewed migration.

CREATE OR REPLACE FUNCTION public.refuse_withheld_service_grant()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.action = 'GRANT' AND NEW.capability IN ('TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
    RAISE EXCEPTION 'SERVICE_NOT_AVAILABLE' USING ERRCODE = 'PT422';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_withheld_service_grant() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE TRIGGER trg_refuse_withheld_service_grant
  BEFORE INSERT ON public.engagement_mandate_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_withheld_service_grant();
