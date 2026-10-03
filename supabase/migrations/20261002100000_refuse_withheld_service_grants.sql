-- 20261002100000_refuse_withheld_service_grants.sql
--
-- Tax computation, Compliance review, Filing package and Monitoring are withheld from customers (frontend boundary:
-- src/lib/workspace/moduleAvailability.ts — the customer scope is Trial balance review). This migration makes the
-- database refuse every NEW grant of those four services through ONE authoritative availability boundary:
--
--   public.capability_customer_available(capability)  the ONLY list of withheld capabilities in the database;
--   public.assert_capability_available(capability)    raises exactly SQLSTATE PT422, message SERVICE_NOT_AVAILABLE.
--
-- It is enforced at every entry, in this order:
--   · open_engagement_with_scope — after authentication, input validation and authorization (an unauthorized caller
--     still gets the established FORBIDDEN and learns nothing), and BEFORE the advisory lock, fiscal-period creation,
--     engagement creation and any grant: a refused request writes nothing at all;
--   · grant_engagement_capability — after authorization (assert_engagement_write_authority), and BEFORE the filing-
--     jurisdiction check, the duplicate-grant check and the mandate insert: a withheld service never reports
--     JURISDICTION_REQUIRED or any other message;
--   · the BEFORE INSERT trigger on engagement_mandate_events — the backstop for any other function and for direct writes
--     by any role (service_role and the table owner included), using the same helper.
-- Both RPC bodies are their current definitions with exactly ONE added line each (proven byte-for-byte by
-- scripts/db-proof/serviceWithholding.mjs); owner and privileges are preserved by CREATE OR REPLACE.
--
-- What it does NOT do:
--   · no existing row is read, changed or removed — the trigger fires on INSERT only, so every historical grant, revoke,
--     engagement and accounting record stays byte-identical and readable (fold_engagement_mandate is unchanged);
--   · no table, edge function, tax calculation or jurisdiction pack is changed or removed;
--   · REVOKE events are unaffected (a service can still be withdrawn), and FINANCIAL_STATEMENTS stays grantable: it is the
--     authority for Prepare and Reconcile. A withdrawn withheld service cannot be granted again.
--
-- Forward-only and replay-safe: every statement is CREATE OR REPLACE; re-applying changes nothing.
-- Re-enabling a service is a separate, reviewed migration that edits capability_customer_available().

CREATE OR REPLACE FUNCTION public.capability_customer_available(p_capability TEXT)
  RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(NOT (p_capability = ANY (ARRAY['TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING'])), true)
$$;

CREATE OR REPLACE FUNCTION public.assert_capability_available(p_capability TEXT)
  RETURNS VOID
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.capability_customer_available(p_capability) THEN
    RAISE EXCEPTION 'SERVICE_NOT_AVAILABLE' USING ERRCODE = 'PT422';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.capability_customer_available(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_capability_available(TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.open_engagement_with_scope(p_company_id uuid, p_period_year integer, p_capabilities text[], p_engagement_type text DEFAULT 'composite'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member   UUID;
  v_period   UUID;
  v_eng      UUID;
  v_created  BOOLEAN := false;
  v_cap      TEXT;
  v_caps     TEXT[];
  v_granted  TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_year IS NULL OR p_period_year < 2000 OR p_period_year > 2100 THEN
    RAISE EXCEPTION 'INVALID: reporting year out of range' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO v_caps FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) c;
  IF v_caps IS NULL OR array_length(v_caps, 1) = 0 THEN
    RAISE EXCEPTION 'INVALID: choose at least one service' USING ERRCODE = '22023';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF v_cap NOT IN ('FINANCIAL_STATEMENTS', 'TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
      RAISE EXCEPTION 'INVALID: unknown service %', v_cap USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 1. authorise from the session (never from the request)
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: choosing services needs the review_close capability in this workspace and a current plan' USING ERRCODE = '42501';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP PERFORM public.assert_capability_available(v_cap); END LOOP;

  -- 2. serialise on the company × year identity: every concurrent request for the same workspace queues here
  PERFORM pg_advisory_xact_lock(hashtextextended('open_engagement:' || p_company_id::text || ':' || p_period_year::text, 0));

  -- 3. the reporting period of record (earliest wins; the (company, year-end) UNIQUE key is the backstop)
  SELECT p.id INTO v_period FROM public.fiscal_periods p
   WHERE p.company_id = p_company_id
     AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = p_period_year
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_period IS NULL THEN
    INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by)
    VALUES (p_company_id, make_date(p_period_year, 12, 31), make_date(p_period_year, 1, 1), make_date(p_period_year, 12, 31), 'FY' || p_period_year::text, auth.uid())
    ON CONFLICT (company_id, fiscal_year_end) DO NOTHING
    RETURNING id INTO v_period;
    IF v_period IS NULL THEN
      SELECT p.id INTO v_period FROM public.fiscal_periods p
       WHERE p.company_id = p_company_id AND p.fiscal_year_end = make_date(p_period_year, 12, 31);
    END IF;
  END IF;

  -- 4. the open engagement, or exactly one new one (uq_engagements_one_open_per_period is the invariant)
  SELECT g.id INTO v_eng FROM public.engagements g WHERE g.fiscal_period_id = v_period AND g.status = 'open';
  IF v_eng IS NULL THEN
    INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id)
    VALUES (v_period, p_company_id, COALESCE(p_engagement_type, 'composite'), v_member)
    RETURNING id INTO v_eng;
    v_created := true;
  END IF;

  -- 5. grants: only what is missing (each goes through the validated, jurisdiction-aware command)
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.capability) e.action FROM public.engagement_mandate_events e
         WHERE e.engagement_id = v_eng AND e.capability = v_cap ORDER BY e.capability, e.sequence_no DESC
      ) l WHERE l.action = 'GRANT'
    ) THEN
      PERFORM public.grant_engagement_capability(v_eng, v_cap, 'Selected when the workspace was set up');
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(x.capability ORDER BY x.capability), ARRAY[]::TEXT[]) INTO v_granted FROM (
    SELECT DISTINCT ON (e.capability) e.capability, e.action FROM public.engagement_mandate_events e
     WHERE e.engagement_id = v_eng ORDER BY e.capability, e.sequence_no DESC
  ) x WHERE x.action = 'GRANT';

  RETURN jsonb_build_object('engagementId', v_eng, 'periodId', v_period, 'created', v_created, 'granted', to_jsonb(v_granted));
END;
$function$;

CREATE OR REPLACE FUNCTION public.grant_engagement_capability(p_engagement_id uuid, p_capability text, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member  UUID;
  v_current TEXT;
  v_id      UUID;
  v_j       TEXT;
BEGIN
  v_member := public.assert_engagement_write_authority(p_engagement_id);
  PERFORM public.assert_capability_available(p_capability);

  IF public.capability_needs_jurisdiction(p_capability) THEN
    SELECT c.filing_jurisdiction INTO v_j
      FROM public.companies c JOIN public.engagements g ON g.company_id = c.id WHERE g.id = p_engagement_id;
    IF v_j IS NULL THEN
      RAISE EXCEPTION 'JURISDICTION_REQUIRED: select the filing jurisdiction before adding %.', p_capability
        USING ERRCODE = 'PT422';
    END IF;
  END IF;

  SELECT action INTO v_current
  FROM public.engagement_mandate_events
  WHERE engagement_id = p_engagement_id AND capability = p_capability
  ORDER BY sequence_no DESC LIMIT 1;

  IF v_current = 'GRANT' THEN
    RAISE EXCEPTION
      'Capability % is already part of this engagement. A professional file must not record a change that did not occur.',
      p_capability USING ERRCODE = 'restrict_violation';
  END IF;

  INSERT INTO public.engagement_mandate_events (
    engagement_id, capability, action, sequence_no, actor_member_id, reason
  ) VALUES (
    p_engagement_id, p_capability, 'GRANT',
    public.next_engagement_sequence(p_engagement_id), v_member, p_reason
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- The backstop. SECURITY DEFINER so that a direct write by ANY role reaches the (client-revoked) helper; it reads only
-- NEW and decides nothing but availability.
CREATE OR REPLACE FUNCTION public.refuse_withheld_service_grant()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.action = 'GRANT' THEN
    PERFORM public.assert_capability_available(NEW.capability);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_withheld_service_grant() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE TRIGGER trg_refuse_withheld_service_grant
  BEFORE INSERT ON public.engagement_mandate_events
  FOR EACH ROW EXECUTE FUNCTION public.refuse_withheld_service_grant();
