-- INERT forward candidate: not registered/applied. Deploy only after reviewed promotion.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.qbo_connections') IS NULL THEN RAISE EXCEPTION 'QBO_PREREQUISITE_MISSING'; END IF;
END $$;
CREATE TABLE public.qbo_disconnect_operations (
 connection_id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, actor_user_id uuid NOT NULL,
 company_id uuid NOT NULL, realm_id text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 revoke_lease_id uuid, revoke_lease_until timestamptz,
 pending_envelope text, outcome text NOT NULL CHECK(outcome IN ('pending','revoked','local_only')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz
);
REVOKE ALL ON public.qbo_disconnect_operations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.qbo_disconnect_operations TO service_role;
ALTER TABLE public.qbo_disconnect_operations ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.qbo_fiscal_pull_basis (
 reservation_id uuid PRIMARY KEY, period_id uuid NOT NULL, basis jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.qbo_fiscal_pull_basis FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.qbo_fiscal_pull_basis TO service_role;
ALTER TABLE public.qbo_fiscal_pull_basis ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER qbo_fiscal_basis_immutable BEFORE UPDATE OR DELETE ON public.qbo_fiscal_pull_basis FOR EACH ROW EXECUTE FUNCTION public.tbu_append_only_guard();
CREATE TRIGGER qbo_fiscal_basis_no_truncate BEFORE TRUNCATE ON public.qbo_fiscal_pull_basis FOR EACH STATEMENT EXECUTE FUNCTION public.qbo_evidence_no_truncate();
CREATE FUNCTION public.qbo_saved_period(p_actor uuid,p_company uuid,p_period uuid,p_year integer,p_engagement uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.fiscal_periods;
BEGIN
 IF NOT public.qbo_connector_basis(p_actor,p_company) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.fiscal_periods WHERE id=p_period AND company_id=p_company;
 IF NOT FOUND OR p.reporting_start IS NULL OR p.reporting_end IS NULL OR p.reporting_currency IS NULL OR p.dates_basis IS DISTINCT FROM 'confirmed'
    OR extract(year FROM p.reporting_end)::integer<>p_year THEN RETURN NULL; END IF;
 IF p_engagement IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.engagements WHERE id=p_engagement AND company_id=p_company AND fiscal_period_id=p_period) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',p.id,'companyId',p.company_id,'year',p_year,'start',p.reporting_start,'end',p.reporting_end,'currency',p.reporting_currency);
END $$;
CREATE FUNCTION public.qbo_begin_disconnect(p_connection uuid,p_actor uuid,p_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.qbo_connections; o public.qbo_disconnect_operations; ticket uuid;
BEGIN
 SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection;
 IF FOUND THEN PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||c.company_id::text||':'||c.environment||':'||c.realm_id,0)); END IF;
 SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection FOR UPDATE;
 IF NOT FOUND OR NOT public.qbo_connector_basis(p_actor,c.company_id) THEN RETURN jsonb_build_object('outcome','forbidden'); END IF;
 IF p_request IS NULL THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 SELECT * INTO o FROM public.qbo_disconnect_operations WHERE connection_id=c.id;
 IF FOUND THEN
  IF o.request_id<>p_request OR o.actor_user_id<>p_actor THEN RETURN jsonb_build_object('outcome','request_conflict'); END IF;
  IF o.outcome='pending' THEN
   IF o.revoke_lease_until>clock_timestamp() THEN RETURN jsonb_build_object('outcome','revocation_busy'); END IF;
   ticket:=gen_random_uuid(); UPDATE public.qbo_disconnect_operations SET revoke_lease_id=ticket,revoke_lease_until=clock_timestamp()+interval '45 seconds' WHERE connection_id=c.id;
  END IF;
  RETURN jsonb_build_object('outcome',o.outcome,'leaseId',ticket,'envelope',o.pending_envelope,'companyId',c.company_id,'realmId',c.realm_id,'environment',c.environment);
 END IF;
 IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE request_id=p_request) THEN RETURN jsonb_build_object('outcome','request_conflict'); END IF;
 IF c.status='disconnected' THEN RETURN jsonb_build_object('outcome','local_only'); END IF;
 IF c.refresh_lease_until>clock_timestamp() THEN RETURN jsonb_build_object('outcome','busy'); END IF;
 INSERT INTO public.qbo_disconnect_operations(connection_id,request_id,actor_user_id,company_id,realm_id,environment,pending_envelope,outcome)
 VALUES(c.id,p_request,p_actor,c.company_id,c.realm_id,c.environment,c.refresh_token_envelope,CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END);
 UPDATE public.qbo_connections SET status='disconnected',refresh_token_envelope=NULL,envelope_key_id=NULL,refresh_expires_at=NULL,hard_expires_at=NULL,
 refresh_lease_until=NULL,refresh_lease_id=NULL,disconnected_at=clock_timestamp() WHERE id=c.id;
 ticket:=gen_random_uuid(); UPDATE public.qbo_disconnect_operations SET revoke_lease_id=ticket,revoke_lease_until=clock_timestamp()+interval '45 seconds' WHERE connection_id=c.id AND outcome='pending';
 RETURN jsonb_build_object('outcome',CASE WHEN c.refresh_token_envelope IS NULL THEN 'local_only' ELSE 'pending' END,'leaseId',ticket,'envelope',c.refresh_token_envelope,'companyId',c.company_id,'realmId',c.realm_id,'environment',c.environment);
END $$;
CREATE FUNCTION public.qbo_finish_disconnect(p_connection uuid,p_actor uuid,p_request uuid,p_lease uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.qbo_disconnect_operations SET outcome='revoked',pending_envelope=NULL,revoke_lease_id=NULL,revoke_lease_until=NULL,completed_at=clock_timestamp()
 WHERE connection_id=p_connection AND request_id=p_request AND actor_user_id=p_actor
 AND public.qbo_connector_basis(p_actor,company_id) AND outcome='pending' AND revoke_lease_id=p_lease AND revoke_lease_until>clock_timestamp();
 RETURN EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE connection_id=p_connection AND request_id=p_request AND actor_user_id=p_actor AND outcome='revoked' AND public.qbo_connector_basis(p_actor,company_id));
END $$;
CREATE OR REPLACE FUNCTION public.qbo_rotate_refresh_token(p_connection_id uuid, p_expected_envelope text, p_new_envelope text, p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.qbo_connections SET refresh_token_envelope = p_new_envelope, envelope_key_id = split_part(p_new_envelope, '.', 2),
         refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at
   WHERE id = p_connection_id AND status = 'active' AND refresh_token_envelope = p_expected_envelope AND refresh_lease_until > clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 1 THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM public.qbo_connections c WHERE c.id = p_connection_id AND c.status = 'active' AND c.refresh_token_envelope = p_new_envelope);
END;
$$;
CREATE OR REPLACE FUNCTION public.qbo_store_connection(p_company_id uuid, p_actor_user_id uuid, p_realm_id text, p_environment text, p_envelope text,
                                            p_refresh_expires_at timestamptz, p_hard_expires_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.qbo_connector_basis(p_actor_user_id, p_company_id) THEN
    RAISE EXCEPTION 'FORBIDDEN: no right to connect QuickBooks in this workspace' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('qbo-connect:'||p_company_id::text||':'||p_environment||':'||p_realm_id,0));
  IF EXISTS(SELECT 1 FROM public.qbo_disconnect_operations WHERE company_id=p_company_id AND realm_id=p_realm_id AND environment=p_environment AND outcome='pending') THEN RAISE EXCEPTION 'QBO_REVOKE_PENDING' USING ERRCODE='PT409'; END IF;
  IF EXISTS(SELECT 1 FROM public.qbo_connections WHERE company_id=p_company_id AND realm_id=p_realm_id AND environment=p_environment AND refresh_lease_until>clock_timestamp()) THEN RAISE EXCEPTION 'QBO_OPERATION_BUSY' USING ERRCODE='PT409'; END IF;
  SELECT id INTO v_id FROM public.qbo_connections
   WHERE company_id = p_company_id AND realm_id = p_realm_id AND environment = p_environment AND status <> 'disconnected' FOR UPDATE;
  IF FOUND THEN
    UPDATE public.qbo_connections SET status = 'active', refresh_token_envelope = p_envelope, envelope_key_id = split_part(p_envelope, '.', 2),
           refresh_expires_at = p_refresh_expires_at, hard_expires_at = p_hard_expires_at, connected_by_user_id = p_actor_user_id, refresh_lease_until = NULL,
           refresh_lease_id = NULL
     WHERE id = v_id;
  ELSE
    INSERT INTO public.qbo_connections (company_id, connected_by_user_id, realm_id, environment, status, refresh_token_envelope, envelope_key_id, refresh_expires_at, hard_expires_at)
    VALUES (p_company_id, p_actor_user_id, p_realm_id, p_environment, 'active', p_envelope, split_part(p_envelope, '.', 2), p_refresh_expires_at, p_hard_expires_at)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.qbo_disconnect(p_connection_id uuid,p_actor_user_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.qbo_connections WHERE id=p_connection_id AND public.qbo_connector_basis(p_actor_user_id,company_id)) THEN RETURN 'forbidden'; END IF;
 RETURN 'revoke_required';
END $$;
CREATE FUNCTION public.qbo_record_fiscal_pull_intent(p_period_id uuid,p_fiscal_basis jsonb,p_reservation_id uuid,p_connection_id uuid,p_actor_user_id uuid,p_realm_id text,p_environment text,p_start_date date,p_end_date date,p_accounting_method text,p_minor_version integer,p_currency text,p_account_count integer,p_raw_sha256 text,p_canonical_sha256 text,p_result_sha256 text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.qbo_connections; p public.fiscal_periods; existing public.qbo_fiscal_pull_basis; v uuid;
BEGIN
 SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection_id FOR UPDATE;
 IF NOT FOUND OR c.status<>'active' OR c.refresh_lease_until IS NULL OR c.refresh_lease_until<=clock_timestamp() OR c.realm_id<>p_realm_id OR c.environment<>p_environment THEN RAISE EXCEPTION 'QBO_CONNECTION_UNAVAILABLE'; END IF;
 SELECT * INTO p FROM public.fiscal_periods WHERE id=p_period_id AND company_id=c.company_id FOR SHARE;
 IF NOT FOUND OR p.dates_basis IS DISTINCT FROM 'confirmed' OR p.reporting_start IS DISTINCT FROM p_start_date OR p.reporting_end IS DISTINCT FROM p_end_date OR p.reporting_currency IS DISTINCT FROM p_currency
 OR (p_fiscal_basis->>'kind') IS DISTINCT FROM 'fiscal-ytd-as-of'
 OR (p_fiscal_basis->>'fiscalStart') IS DISTINCT FROM p_start_date::text OR (p_fiscal_basis->>'asOf') IS DISTINCT FROM p_end_date::text
 OR (p_fiscal_basis->>'currency') IS DISTINCT FROM p_currency OR (p_fiscal_basis->>'accountingMethod') IS DISTINCT FROM p_accounting_method
 OR (p_fiscal_basis->>'operationLeaseId') IS DISTINCT FROM c.refresh_lease_id::text
 OR coalesce(p_fiscal_basis->>'preferencesSha256','') !~ '^[a-f0-9]{64}$'
 OR coalesce(p_fiscal_basis->>'fiscalStartMonth','') !~ '^([1-9]|1[0-2])$'
 OR extract(month FROM p_start_date)::integer<>(p_fiscal_basis->>'fiscalStartMonth')::integer OR extract(day FROM p_start_date)<>1
 OR p_end_date >= (p_start_date+interval '1 year')::date
 THEN RAISE EXCEPTION 'QBO_FISCAL_BASIS_MISMATCH'; END IF;
 SELECT * INTO existing FROM public.qbo_fiscal_pull_basis WHERE reservation_id=p_reservation_id;
 IF FOUND AND (existing.basis IS DISTINCT FROM p_fiscal_basis OR existing.period_id<>p_period_id) THEN RAISE EXCEPTION 'QBO_BASIS_CONFLICT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.trial_balance_source_reservations WHERE id=p_reservation_id AND company_id=c.company_id AND actor_user_id=p_actor_user_id) THEN RAISE EXCEPTION 'QBO_SCOPE_MISMATCH'; END IF;
 v:=public.qbo_record_pull_intent(p_reservation_id,p_connection_id,p_actor_user_id,p_realm_id,p_environment,p_start_date,p_end_date,p_accounting_method,p_minor_version,p_currency,p_account_count,p_raw_sha256,p_canonical_sha256,p_result_sha256);
 INSERT INTO public.qbo_fiscal_pull_basis(reservation_id,period_id,basis) VALUES(p_reservation_id,p_period_id,p_fiscal_basis) ON CONFLICT DO NOTHING;
 RETURN v;
END $$;
CREATE FUNCTION public.qbo_fence_upload_registration() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.qbo_connections; i public.qbo_pull_intents; p public.fiscal_periods;
BEGIN
 SELECT * INTO i FROM public.qbo_pull_intents WHERE company_id=NEW.company_id AND reservation_id IN
 (SELECT id FROM public.trial_balance_source_reservations WHERE object_path=NEW.file_path);
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO c FROM public.qbo_connections WHERE id=i.connection_id FOR UPDATE;
 IF NOT FOUND OR c.status<>'active' OR c.refresh_lease_until IS NULL OR c.refresh_lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'QBO_CONNECTION_UNAVAILABLE'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.qbo_fiscal_pull_basis WHERE reservation_id=i.reservation_id AND period_id=NEW.period_id AND basis->>'operationLeaseId'=c.refresh_lease_id::text) THEN RAISE EXCEPTION 'QBO_FISCAL_BASIS_REQUIRED'; END IF;
 SELECT * INTO p FROM public.fiscal_periods WHERE id=NEW.period_id AND company_id=NEW.company_id FOR SHARE;
 IF NOT FOUND OR p.dates_basis IS DISTINCT FROM 'confirmed' OR p.reporting_start IS DISTINCT FROM i.start_date OR p.reporting_end IS DISTINCT FROM i.end_date OR p.reporting_currency IS DISTINCT FROM i.currency THEN RAISE EXCEPTION 'QBO_PERIOD_CHANGED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER qbo_fence_upload_registration BEFORE INSERT ON public.trial_balance_uploads FOR EACH ROW EXECUTE FUNCTION public.qbo_fence_upload_registration();
REVOKE ALL ON FUNCTION public.qbo_saved_period(uuid,uuid,uuid,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_saved_period(uuid,uuid,uuid,integer,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.qbo_begin_disconnect(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_begin_disconnect(uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.qbo_finish_disconnect(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_finish_disconnect(uuid,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_record_fiscal_pull_intent(uuid,jsonb,uuid,uuid,uuid,text,text,date,date,text,integer,text,integer,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.qbo_fence_upload_registration() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.qbo_rotate_leased_token(p_connection_id uuid,p_lease_id uuid,p_expected_envelope text,p_new_envelope text,p_refresh_expires_at timestamptz,p_hard_expires_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.qbo_connections;
BEGIN
 SELECT * INTO c FROM public.qbo_connections WHERE id=p_connection_id FOR UPDATE;
 IF NOT FOUND OR c.status<>'active' OR c.refresh_lease_id IS DISTINCT FROM p_lease_id OR c.refresh_lease_until IS NULL OR c.refresh_lease_until<=clock_timestamp() THEN RETURN false; END IF;
 RETURN public.qbo_rotate_refresh_token(p_connection_id,p_expected_envelope,p_new_envelope,p_refresh_expires_at,p_hard_expires_at);
END $$;
REVOKE ALL ON FUNCTION public.qbo_rotate_leased_token(uuid,uuid,text,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.qbo_rotate_leased_token(uuid,uuid,text,text,timestamptz,timestamptz) TO service_role;
CREATE FUNCTION public.qbo_pending_disconnect(p_company uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('connectionId',connection_id,'requestId',request_id)
 FROM public.qbo_disconnect_operations WHERE company_id=p_company AND actor_user_id=auth.uid() AND outcome='pending'
 AND public.qbo_connector_basis(auth.uid(),p_company) ORDER BY created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.qbo_pending_disconnect(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.qbo_pending_disconnect(uuid) TO authenticated;
COMMIT;
