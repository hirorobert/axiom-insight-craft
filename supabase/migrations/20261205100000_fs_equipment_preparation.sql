-- Authored forward migration; NOT applied hosted. Equipment preparation remains advisory.
-- Advisory workpaper storage + compare-and-set note insertion. Does not add framework support or change readiness.
BEGIN;
CREATE TABLE public.fs_equipment_workpapers (
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  period_year integer NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 120000),
  source_document_id uuid REFERENCES public.financial_statement_documents(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  firm_member_id uuid,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_user_id, request_id)
);
CREATE INDEX fs_equipment_workpaper_latest ON public.fs_equipment_workpapers(company_id,period_year,seq DESC);
ALTER TABLE public.fs_equipment_workpapers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_equipment_workpapers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.fs_equipment_workpapers_seq_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public._fs_equipment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'EQUIPMENT_WORKPAPER_IMMUTABLE' USING ERRCODE='42501'; END; $$;
CREATE TRIGGER fs_equipment_immutable BEFORE UPDATE OR DELETE ON public.fs_equipment_workpapers FOR EACH ROW EXECUTE FUNCTION public._fs_equipment_immutable();
CREATE TRIGGER fs_equipment_no_truncate BEFORE TRUNCATE ON public.fs_equipment_workpapers FOR EACH STATEMENT EXECUTE FUNCTION public._fs_equipment_immutable();
REVOKE ALL ON FUNCTION public._fs_equipment_immutable() FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.fs_equipment_policy_insertions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
 period_year integer NOT NULL, workpaper_id uuid NOT NULL REFERENCES public.fs_equipment_workpapers(id) ON DELETE RESTRICT,
 actor_user_id uuid NOT NULL, request_id uuid NOT NULL, expected_policy_id uuid, requirement_id text NOT NULL, body_sha256 text NOT NULL,
 receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_user_id,request_id)
);
ALTER TABLE public.fs_equipment_policy_insertions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_equipment_policy_insertions FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER fs_equipment_policy_immutable BEFORE UPDATE OR DELETE ON public.fs_equipment_policy_insertions FOR EACH ROW EXECUTE FUNCTION public._fs_equipment_immutable();
CREATE TRIGGER fs_equipment_policy_no_truncate BEFORE TRUNCATE ON public.fs_equipment_policy_insertions FOR EACH STATEMENT EXECUTE FUNCTION public._fs_equipment_immutable();

CREATE FUNCTION public.fs_equipment_context(p_company_id uuid, p_period_year integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text; v_work jsonb; v_policy jsonb; v_note jsonb; v_schedule_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 v_refusal := public._fs_notes_refusal(p_company_id, auth.uid());
 IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
 SELECT jsonb_build_object('id',w.id,'payload',w.payload,'sourceDocumentId',w.source_document_id,'createdAt',w.created_at) INTO v_work
 FROM public.fs_equipment_workpapers w WHERE w.company_id=p_company_id AND w.period_year=p_period_year ORDER BY w.seq DESC LIMIT 1;
 SELECT jsonb_build_object('id',t.id,'body',t.body,'sourceRef',t.source_ref) INTO v_policy
 FROM public.fs_disclosure_texts t WHERE t.company_id=p_company_id AND t.period_year=p_period_year AND t.requirement_id='smes.note.policies' ORDER BY t.seq DESC LIMIT 1;
 SELECT jsonb_build_object('id',t.id,'body',t.body,'sourceRef',t.source_ref) INTO v_note FROM public.fs_disclosure_texts t WHERE t.company_id=p_company_id AND t.period_year=p_period_year AND t.requirement_id='smes.note.subclassifications' ORDER BY t.seq DESC LIMIT 1;
 SELECT id INTO v_schedule_id FROM public.fs_schedule_submissions WHERE company_id=p_company_id AND period_year=p_period_year AND schedule_id='ppe' ORDER BY seq DESC LIMIT 1;
 RETURN jsonb_build_object('outcome','available','workpaper',v_work,'policy',v_policy,'equipmentNote',v_note,'scheduleId',v_schedule_id);
END; $$;

CREATE FUNCTION public.fs_save_equipment_workpaper(p_company_id uuid,p_period_year integer,p_payload jsonb,p_expected_id uuid,p_source_document_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text; v_prior public.fs_equipment_workpapers; v_current uuid; v_request jsonb; v_id uuid; v_source_sha text; v_at timestamptz;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 v_refusal := public._fs_notes_refusal(p_company_id,auth.uid());
 IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
 IF p_company_id IS NULL OR p_period_year IS NULL OR p_period_year NOT BETWEEN 2000 AND 2100 OR p_request_id IS NULL OR p_payload IS NULL
 OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text)>120000
 OR p_payload->>'contract' IS DISTINCT FROM 'cfoclose-equipment-workpaper/1'
 OR p_payload->>'companyId' IS DISTINCT FROM p_company_id::text OR p_payload->>'periodYear' IS DISTINCT FROM p_period_year::text THEN
 RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 v_request:=jsonb_build_object('payload',p_payload,'expectedId',p_expected_id,'sourceDocumentId',p_source_document_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_request:'||auth.uid()::text||':'||p_request_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:'||p_company_id::text||':'||p_period_year::text,0));
 SELECT * INTO v_prior FROM public.fs_equipment_workpapers WHERE actor_user_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
   IF v_prior.company_id=p_company_id AND v_prior.period_year=p_period_year AND v_prior.request_payload=v_request THEN
     RETURN jsonb_build_object('outcome','recorded','workpaperId',v_prior.id,'sourceRetained',v_prior.source_document_id IS NOT NULL,'createdAt',v_prior.created_at,'replay',true);
   END IF;
   RETURN jsonb_build_object('outcome','request_reused');
 END IF;
 SELECT id INTO v_current FROM public.fs_equipment_workpapers WHERE company_id=p_company_id AND period_year=p_period_year ORDER BY seq DESC LIMIT 1;
 IF v_current IS DISTINCT FROM p_expected_id THEN RETURN jsonb_build_object('outcome','stale','currentId',v_current); END IF;
 IF p_source_document_id IS NOT NULL THEN
   SELECT d.sha256 INTO v_source_sha FROM public.financial_statement_documents d WHERE d.id=p_source_document_id AND d.company_id=p_company_id AND d.status NOT IN ('QUARANTINED','EXTRACTION_FAILED','CLASSIFICATION_FAILED') AND d.superseded_at IS NULL;
   IF NOT FOUND OR v_source_sha IS DISTINCT FROM p_payload#>>'{priorSource,fact,documentSha256}' THEN RETURN jsonb_build_object('outcome','source_mismatch'); END IF;
 END IF;
 INSERT INTO public.fs_equipment_workpapers(company_id,period_year,payload,source_document_id,actor_user_id,firm_member_id,request_id,request_payload)
 VALUES(p_company_id,p_period_year,p_payload,p_source_document_id,auth.uid(),public._cr_member(p_company_id,auth.uid()),p_request_id,v_request) RETURNING id,created_at INTO v_id,v_at;
 RETURN jsonb_build_object('outcome','recorded','workpaperId',v_id,'sourceRetained',p_source_document_id IS NOT NULL,'createdAt',v_at);
END; $$;

-- The person reviews the WHOLE proposed policy note. No automatic "PPE draft = all policies complete" promotion.
-- Existing disclosure writers take this same lock; a changed note refuses instead of losing another writer's work.
CREATE FUNCTION public.fs_record_reviewed_equipment_note(p_company_id uuid,p_period_year integer,p_workpaper_id uuid,p_expected_policy_id uuid,p_body text,p_request_id uuid,p_requirement_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text; v_current uuid; v_result jsonb; v_source text; v_prior public.fs_equipment_policy_insertions; v_body_sha text; v_work jsonb; v_composition jsonb; v_document_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 v_refusal:=public._fs_notes_refusal(p_company_id,auth.uid());
 IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
 IF p_requirement_id IS NULL OR p_requirement_id NOT IN ('smes.note.policies','smes.note.subclassifications') OR p_request_id IS NULL OR p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 20000 THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 v_source:='Reviewed equipment workpaper '||p_workpaper_id::text;
 v_body_sha:=encode(sha256(convert_to(p_body,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_policy_request:'||auth.uid()::text||':'||p_request_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:'||p_company_id::text||':'||p_period_year::text,0));
 SELECT * INTO v_prior FROM public.fs_equipment_policy_insertions WHERE actor_user_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
   IF v_prior.company_id=p_company_id AND v_prior.period_year=p_period_year AND v_prior.workpaper_id=p_workpaper_id AND v_prior.requirement_id=p_requirement_id AND v_prior.expected_policy_id IS NOT DISTINCT FROM p_expected_policy_id AND v_prior.body_sha256=v_body_sha THEN
     RETURN v_prior.receipt||jsonb_build_object('replay',true);
   END IF;
   RETURN jsonb_build_object('outcome','request_reused');
 END IF;
 SELECT payload,source_document_id INTO v_work,v_document_id FROM public.fs_equipment_workpapers WHERE id=p_workpaper_id AND company_id=p_company_id AND period_year=p_period_year;
 IF NOT FOUND THEN RETURN jsonb_build_object('outcome','workpaper_missing'); END IF;
 IF v_work#>>'{priorSource,fact,origin}'='document' AND v_document_id IS NULL THEN RETURN jsonb_build_object('outcome','source_required'); END IF;
 IF v_document_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.financial_statement_documents d WHERE d.id=v_document_id AND d.company_id=p_company_id AND d.sha256=v_work#>>'{priorSource,fact,documentSha256}' AND d.status NOT IN ('QUARANTINED','EXTRACTION_FAILED','CLASSIFICATION_FAILED') AND d.superseded_at IS NULL) THEN RETURN jsonb_build_object('outcome','source_stale'); END IF;
 v_composition:=public.fs_statement_composition(p_company_id,p_period_year);
 IF v_composition->>'state' IS DISTINCT FROM 'composed' OR v_composition#>>'{pack,packId}' IS DISTINCT FROM 'ifrs-for-smes/2015'
 OR v_composition->>'compositionSha256' IS DISTINCT FROM v_work->>'compositionSha256' THEN RETURN jsonb_build_object('outcome','stale_inputs'); END IF;
 SELECT id INTO v_current FROM public.fs_disclosure_texts WHERE company_id=p_company_id AND period_year=p_period_year AND requirement_id=p_requirement_id ORDER BY seq DESC LIMIT 1;
 IF v_current IS DISTINCT FROM p_expected_policy_id THEN RETURN jsonb_build_object('outcome','stale','currentId',v_current); END IF;
 v_result:=public.fs_record_disclosure(p_company_id,p_period_year,p_requirement_id,p_body,v_source,p_request_id);
 IF v_result->>'outcome' IN ('recorded','unchanged') THEN
   INSERT INTO public.fs_equipment_policy_insertions(company_id,period_year,workpaper_id,actor_user_id,request_id,expected_policy_id,requirement_id,body_sha256,receipt)
   VALUES(p_company_id,p_period_year,p_workpaper_id,auth.uid(),p_request_id,p_expected_policy_id,p_requirement_id,v_body_sha,v_result);
 END IF;
 RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION public.fs_equipment_context(uuid,integer),public.fs_save_equipment_workpaper(uuid,integer,jsonb,uuid,uuid,uuid),public.fs_record_reviewed_equipment_note(uuid,integer,uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fs_equipment_context(uuid,integer),public.fs_save_equipment_workpaper(uuid,integer,jsonb,uuid,uuid,uuid),public.fs_record_reviewed_equipment_note(uuid,integer,uuid,uuid,text,uuid,text) TO authenticated;

-- One database transaction: reviewed editor -> workpaper revision + validated schedule + selected reviewed note.
-- Storage upload remains a separate content-addressed intake; a failure here never deletes an original.
CREATE FUNCTION public.fs_commit_equipment_preparation(p_company_id uuid,p_period_year integer,p_payload jsonb,p_expected_id uuid,p_source_document_id uuid,p_expected_note_id uuid,p_body text,p_requirement_id text,p_request_id uuid,p_expected_schedule_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text; v_work jsonb; v_schedule jsonb; v_note jsonb; v_rows jsonb; v_movements jsonb;
 v_schedule_request uuid; v_note_request uuid; v_current_schedule uuid; v_existing_rows jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 v_refusal:=public._fs_notes_refusal(p_company_id,auth.uid());
 IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
 IF p_request_id IS NULL OR jsonb_typeof(p_payload#>'{schedule,movements}') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 v_schedule_request:=md5(p_request_id::text||':schedule')::uuid;
 v_note_request:=md5(p_request_id::text||':note')::uuid;
 -- Reserve every request lock before the period lock, including locks used by standalone writers.
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_request:'||auth.uid()::text||':'||p_request_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_equipment_policy_request:'||auth.uid()::text||':'||v_note_request::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:'||p_company_id::text||':'||p_period_year::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.fs_schedule_submissions WHERE actor_user_id=auth.uid() AND request_id=v_schedule_request) THEN
   SELECT id,rows INTO v_current_schedule,v_existing_rows FROM public.fs_schedule_submissions WHERE company_id=p_company_id AND period_year=p_period_year AND schedule_id='ppe' ORDER BY seq DESC LIMIT 1;
   IF v_current_schedule IS DISTINCT FROM p_expected_schedule_id THEN RETURN jsonb_build_object('outcome','stale_schedule'); END IF;
   IF jsonb_array_length(v_existing_rows)>1 THEN RETURN jsonb_build_object('outcome','multi_class_schedule'); END IF;
 END IF;
 BEGIN
   v_work:=public.fs_save_equipment_workpaper(p_company_id,p_period_year,p_payload,p_expected_id,p_source_document_id,p_request_id);
   IF v_work->>'outcome' IS DISTINCT FROM 'recorded' THEN RAISE SQLSTATE 'P2701' USING MESSAGE=v_work::text; END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('kind',m->>'kind','amountMinor',m->>'amountMinor')),'[]'::jsonb) INTO v_movements FROM jsonb_array_elements(p_payload#>'{schedule,movements}') m;
   v_rows:=jsonb_build_array(jsonb_build_object('classLabel',p_payload#>>'{schedule,classLabel}','openingMinor',p_payload#>>'{openingBridge,openingMinor}','closingMinor',p_payload#>>'{schedule,closingMinor}','movements',v_movements));
   v_schedule:=public.fs_record_schedule(p_company_id,p_period_year,'ppe',v_rows,'Reviewed equipment workpaper '||(v_work->>'workpaperId'),v_schedule_request);
   IF v_schedule->>'outcome' NOT IN ('recorded','unchanged') OR v_schedule->>'outcome' IS NULL THEN RAISE SQLSTATE 'P2701' USING MESSAGE=v_schedule::text; END IF;
   v_note:=public.fs_record_reviewed_equipment_note(p_company_id,p_period_year,(v_work->>'workpaperId')::uuid,p_expected_note_id,p_body,v_note_request,p_requirement_id);
   IF v_note->>'outcome' NOT IN ('recorded','unchanged') OR v_note->>'outcome' IS NULL THEN RAISE SQLSTATE 'P2701' USING MESSAGE=v_note::text; END IF;
   RETURN jsonb_build_object('outcome','recorded','workpaperId',v_work->>'workpaperId','sourceRetained',v_work->'sourceRetained','createdAt',v_work->'createdAt','schedule',v_schedule,'note',v_note,'replay',coalesce(v_work->'replay','false'::jsonb));
 EXCEPTION WHEN SQLSTATE 'P2701' THEN RETURN SQLERRM::jsonb;
 END;
END; $$;
REVOKE ALL ON FUNCTION public.fs_commit_equipment_preparation(uuid,integer,jsonb,uuid,uuid,uuid,text,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fs_commit_equipment_preparation(uuid,integer,jsonb,uuid,uuid,uuid,text,text,uuid,uuid) TO authenticated;
-- Wizard-only create: a newer schedule is never replaced, even if the browser read was stale.
CREATE FUNCTION public.fs_create_equipment_schedule(p_company_id uuid,p_period_year integer,p_rows jsonb,p_source_ref text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_refusal text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE='28000'; END IF;
 v_refusal:=public._fs_notes_refusal(p_company_id,auth.uid());
 IF v_refusal IS NOT NULL THEN RETURN jsonb_build_object('outcome',v_refusal); END IF;
 IF p_request_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 IF jsonb_array_length(p_rows)<>1 THEN RETURN jsonb_build_object('outcome','invalid_request'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('fs_notes:'||p_company_id::text||':'||p_period_year::text,0));
 IF EXISTS(SELECT 1 FROM public.fs_schedule_submissions WHERE company_id=p_company_id AND period_year=p_period_year AND schedule_id='ppe')
 AND NOT EXISTS(SELECT 1 FROM public.fs_schedule_submissions WHERE actor_user_id=auth.uid() AND request_id=p_request_id) THEN
   RETURN jsonb_build_object('outcome','schedule_exists');
 END IF;
 RETURN public.fs_record_schedule(p_company_id,p_period_year,'ppe',p_rows,p_source_ref,p_request_id);
END; $$;
REVOKE ALL ON FUNCTION public.fs_create_equipment_schedule(uuid,integer,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fs_create_equipment_schedule(uuid,integer,jsonb,text,uuid) TO authenticated;
COMMIT;
