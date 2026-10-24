-- Atomic forward migration. Submit this exact file; all enclosed statements commit or roll back together.
DO $fs_server_compilation_install$
BEGIN
  EXECUTE $fs_server_compilation_payload$
-- Server compilation is required for NEW approvals and NEW official issuance. Existing reports, publications and
-- issued objects remain immutable and readable. No backfill certifies old client documents as server-compiled.
-- Deploy compile-financial-report before enabling reporting after applying this forward migration. Without the
-- function a report can still be saved as a draft, but cannot acquire a new approval or official issuance.
DO $preflight$
BEGIN
  IF to_regclass('public.fs_server_compilations') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: server compilation is already installed';
  END IF;
  IF position('STATEMENT_FIGURE_MISMATCH' IN pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure)) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: existing publication controls are required';
  END IF;
END;
$preflight$;

ALTER TABLE public.financial_statement_audit_events DROP CONSTRAINT chk_fsae_action;
ALTER TABLE public.financial_statement_audit_events ADD CONSTRAINT chk_fsae_action CHECK (action IN
 ('EVIDENCE_INGESTED','REPORT_VERSION_SAVED','DECISION_RECORDED','CORRECTION_GROUP_APPLIED','PUBLICATION_STATE_SET',
  'REVISION_COMMITTED','EVALUATION_RECORDED','SERVER_REPORT_COMPILED'));

CREATE TABLE public.fs_server_compilations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  report_id text NOT NULL,
  report_version integer NOT NULL,
  compiler_version text NOT NULL CHECK (compiler_version = 'financial-report-compiler/1'),
  compiler_sha256 text NOT NULL CHECK (compiler_sha256 = '9d930d6a67215cce7fe2b3d63a9f93b60d4e9114920ea7ad05ae733b229929ea'),
  document_hash text NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
  dependencies_hash text NOT NULL CHECK (dependencies_hash ~ '^[0-9a-f]{64}$'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 = encode(sha256(convert_to(source_snapshot::text, 'UTF8')), 'hex')),
  canonical_document jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  matches boolean NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (report_id, report_version) REFERENCES public.financial_statement_reports(report_id, report_version),
  UNIQUE (report_id, report_version, compiler_version, document_hash, dependencies_hash)
);
ALTER TABLE public.fs_server_compilations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fs_server_compilations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.fs_server_compilations TO authenticated;
CREATE POLICY fs_server_compilation_read ON public.fs_server_compilations FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.get_member_company_ids()));

CREATE FUNCTION public.fs_server_compilation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE: server compilation receipts are append-only' USING ERRCODE='42501'; END;
$$;
REVOKE ALL ON FUNCTION public.fs_server_compilation_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER fs_server_compilation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.fs_server_compilations
  FOR EACH STATEMENT EXECUTE FUNCTION public.fs_server_compilation_immutable();

-- Bounded source snapshot for the trusted compiler. Only the named immutable version's CURRENT evidence and
-- the disclosure texts actually selected by the notes authority are read; no truncated client page is an input.
CREATE FUNCTION public._fs_server_compile_snapshot(p_company_id uuid,p_report_id text,p_report_version integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.financial_statement_reports; c jsonb; n jsonb; d jsonb; i jsonb; e jsonb; t jsonb; v_rows bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));
  SELECT * INTO r FROM public.financial_statement_reports WHERE company_id=p_company_id AND report_id=p_report_id AND report_version=p_report_version;
  IF r.id IS NULL THEN RAISE EXCEPTION 'REPORT_VERSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF p_report_version <> (SELECT max(report_version) FROM public.financial_statement_reports WHERE report_id=p_report_id) THEN
    RAISE EXCEPTION 'STALE_REPORT_VERSION' USING ERRCODE='PT409';
  END IF;
  IF cardinality(r.evidence_batch_ids)>64 THEN RAISE EXCEPTION 'EVIDENCE_BATCH_LIMIT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(r.evidence_batch_ids) x(id) LEFT JOIN public.financial_evidence_batches b ON b.evidence_batch_id=x.id AND b.company_id=p_company_id
      WHERE b.evidence_batch_id IS NULL OR EXISTS(SELECT 1 FROM public.financial_evidence_batches newer WHERE newer.company_id=b.company_id
        AND newer.reporting_period_id=b.reporting_period_id AND newer.evidence_type=b.evidence_type AND newer.period_role=b.period_role
        AND newer.series_key=b.series_key AND newer.version>b.version)) THEN
    RAISE EXCEPTION 'EVIDENCE_SUPERSEDED_OR_MISSING' USING ERRCODE='PT409';
  END IF;
  SELECT coalesce(sum(jsonb_array_length(b.batch_document->'rows')),0) INTO v_rows FROM public.financial_evidence_batches b
    WHERE b.company_id=p_company_id AND b.evidence_batch_id=ANY(r.evidence_batch_ids);
  IF v_rows>(public.fs_work_bounds()->>'evidenceRowsPerVersion')::bigint THEN RAISE EXCEPTION 'EVIDENCE_ROWS_PER_VERSION_LIMIT' USING ERRCODE='22023'; END IF;
  c:=public.fs_statement_composition(p_company_id,r.period_year);
  n:=public.fs_notes_status(p_company_id,r.period_year);
  d:=public.fs_reporting_dependencies(p_company_id,r.period_year);
  i:=public.fs_reporting_input(p_company_id,r.period_year);
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.evidence_batch_id),'[]'::jsonb) INTO e FROM public.financial_evidence_batches b
    WHERE b.company_id=p_company_id AND b.evidence_batch_id=ANY(r.evidence_batch_ids);
  SELECT coalesce(jsonb_agg(jsonb_build_object('requirementId',x.requirement_id,'textId',x.id::text,'body',x.body,'sourceRef',x.source_ref) ORDER BY x.id),'[]'::jsonb)
    INTO t FROM public.fs_disclosure_texts x WHERE x.company_id=p_company_id AND x.period_year=r.period_year
      AND x.id::text IN (SELECT q->>'textId' FROM jsonb_array_elements(coalesce(n->'requirements','[]'::jsonb)) q);
  RETURN jsonb_build_object('saved',to_jsonb(r),'companyName',(SELECT name FROM public.companies WHERE id=p_company_id),
    'composition',c,'notes',n,'dependencies',d,'input',i,'evidence',e,'disclosures',t);
END;
$$;
REVOKE ALL ON FUNCTION public._fs_server_compile_snapshot(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;

-- Public compilation entry: only an active compiler-capable actor may obtain the snapshot.
-- The internal reader is also used by approval/issuance guards, without granting it to API roles.
CREATE FUNCTION public.fs_server_compile_input(p_company_id uuid,p_report_id text,p_report_version integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.workspace_capability_allowed(p_company_id,auth.uid(),'prepare_close')
      OR public.workspace_capability_allowed(p_company_id,auth.uid(),'review_close')
      OR public.workspace_capability_allowed(p_company_id,auth.uid(),'approve_certification')) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF (public.financial_statements_workspace_access(p_company_id)->>'enabled') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'REPORTING_ACCESS_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN public._fs_server_compile_snapshot(p_company_id,p_report_id,p_report_version);
END;
$$;
REVOKE ALL ON FUNCTION public.fs_server_compile_input(uuid,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fs_server_compile_input(uuid,text,integer) TO authenticated;

-- ONLY the trusted Edge Function can record this result. The actor is derived from its verified user JWT, never its body.
CREATE FUNCTION public.fs_record_server_compilation(p_actor uuid, p_company_id uuid, p_report_id text, p_report_version integer,
  p_document_hash text, p_dependencies_hash text, p_canonical_document jsonb, p_evaluation jsonb, p_source_snapshot jsonb, p_compiler_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r public.financial_statement_reports;
  d jsonb;
  c public.fs_server_compilations;
  v_sub text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_actor uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || p_report_id));
  IF NOT (public.workspace_capability_allowed(p_company_id,p_actor,'prepare_close')
          OR public.workspace_capability_allowed(p_company_id,p_actor,'review_close')
          OR public.workspace_capability_allowed(p_company_id,p_actor,'approve_certification')) THEN
    RAISE EXCEPTION 'FORBIDDEN: active reporting capability required' USING ERRCODE='42501';
  END IF;
  -- These reads run with the verified actor's identity, not an unscoped service identity. Settings are local to this RPC.
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',p_actor,'role','service_role')::text, true);
  IF (public.financial_statements_workspace_access(p_company_id)->>'enabled') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FORBIDDEN: reporting rollout is disabled' USING ERRCODE='42501';
  END IF;
  SELECT * INTO r FROM public.financial_statement_reports WHERE company_id=p_company_id AND report_id=p_report_id AND report_version=p_report_version;
  IF r.id IS NULL OR r.document_hash IS DISTINCT FROM p_document_hash THEN RAISE EXCEPTION 'SERVER_COMPILATION_SOURCE_CHANGED' USING ERRCODE='PT409'; END IF;
  IF p_report_version <> (SELECT max(report_version) FROM public.financial_statement_reports WHERE report_id=p_report_id) THEN
    RAISE EXCEPTION 'STALE_REPORT_VERSION' USING ERRCODE='PT409';
  END IF;
  d := public.fs_reporting_dependencies(p_company_id,r.period_year);
  IF d->>'state' IS DISTINCT FROM 'current' OR d->>'dependenciesSha256' IS DISTINCT FROM p_dependencies_hash
     OR r.report_document#>>'{reportingDependencies,dependenciesSha256}' IS DISTINCT FROM p_dependencies_hash THEN
    RAISE EXCEPTION 'SERVER_COMPILATION_SOURCE_CHANGED' USING ERRCODE='PT409';
  END IF;
  -- Bind the complete source, including evidence rows and disclosure texts, not only an aggregate dependency ID.
  -- The same bounded reader runs again under the receipt transaction's lineage lock and verified actor.
  IF p_source_snapshot IS NULL OR p_source_snapshot IS DISTINCT FROM public.fs_server_compile_input(p_company_id,p_report_id,p_report_version) THEN
    RAISE EXCEPTION 'SERVER_COMPILATION_SNAPSHOT_CHANGED' USING ERRCODE='PT409';
  END IF;
  IF p_compiler_sha256 IS DISTINCT FROM '9d930d6a67215cce7fe2b3d63a9f93b60d4e9114920ea7ad05ae733b229929ea' THEN
    RAISE EXCEPTION 'SERVER_COMPILER_DIGEST_UNSUPPORTED' USING ERRCODE='PT409';
  END IF;
  IF d->>'packId' IS DISTINCT FROM 'ifrs-for-smes/2015' OR jsonb_typeof(p_canonical_document) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evaluation->'findings') IS DISTINCT FROM 'array'
     OR p_evaluation->>'rulePackId' IS DISTINCT FROM 'canonical-statement-rules'
     OR p_evaluation->>'rulePackVersion' IS DISTINCT FROM '2.2.0' OR p_evaluation->>'engineVersion' IS DISTINCT FROM '2.2.0'
     OR coalesce(p_evaluation->>'inputHash','') !~ '^[0-9a-f]{64}$'
     OR p_canonical_document#>>'{reportIdentity,companyId}' IS DISTINCT FROM p_company_id::text
     OR p_canonical_document#>>'{reportIdentity,reportId}' IS DISTINCT FROM p_report_id
     OR p_canonical_document#>>'{reportIdentity,reportVersion}' IS DISTINCT FROM p_report_version::text
     OR p_canonical_document#>>'{reportingDependencies,dependenciesSha256}' IS DISTINCT FROM p_dependencies_hash
     OR p_canonical_document#>>'{entity,legalName}' IS DISTINCT FROM (SELECT name FROM public.companies WHERE id=p_company_id) THEN
    RAISE EXCEPTION 'SERVER_COMPILATION_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.fs_server_compilations WHERE report_id=p_report_id AND report_version=p_report_version
    AND compiler_version='financial-report-compiler/1' AND document_hash=p_document_hash AND dependencies_hash=p_dependencies_hash;
  IF c.id IS NOT NULL THEN
    IF c.canonical_document IS DISTINCT FROM p_canonical_document OR c.evaluation IS DISTINCT FROM p_evaluation
       OR c.source_snapshot IS DISTINCT FROM p_source_snapshot THEN
      RAISE EXCEPTION 'SERVER_COMPILATION_REPLAY_CONFLICT' USING ERRCODE='PT409';
    END IF;
  ELSE
    INSERT INTO public.fs_server_compilations(company_id,report_id,report_version,compiler_version,compiler_sha256,document_hash,dependencies_hash,
      source_snapshot,source_snapshot_sha256,canonical_document,evaluation,matches,actor_user_id)
    VALUES(p_company_id,p_report_id,p_report_version,'financial-report-compiler/1',p_compiler_sha256,p_document_hash,p_dependencies_hash,
      p_source_snapshot,encode(sha256(convert_to(p_source_snapshot::text, 'UTF8')), 'hex'),p_canonical_document,p_evaluation,p_canonical_document=r.report_document AND p_evaluation->>'inputHash'=r.content_hash,p_actor) RETURNING * INTO c;
    v_actor := public.fs_actor_member_id(p_company_id);
    PERFORM public.fs_audit_event(p_company_id,p_report_id,'SERVER_REPORT_COMPILED',jsonb_build_object('compilationId',c.id::text,
      'reportVersion',p_report_version,'compilerVersion',c.compiler_version,'compilerSha256',c.compiler_sha256,'sourceSnapshotSha256',c.source_snapshot_sha256,'matches',c.matches,'documentHash',p_document_hash,'dependenciesHash',p_dependencies_hash),v_actor);
  END IF;
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  RETURN jsonb_build_object('outcome','compiled','matches',c.matches,'compilationId',c.id::text,'sourceSnapshotSha256',c.source_snapshot_sha256,'compilerSha256',c.compiler_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text) TO service_role;

-- A client's later evaluation cannot replace this server evaluation. Mandatory server failures cannot be waived by
-- adding a browser reviewer decision. Existing, more specific accounting and approval blockers continue to run too.
CREATE FUNCTION public.fs_server_compilation_blocker(p_company_id uuid,p_report_id text,p_report_version integer)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.financial_statement_reports; c public.fs_server_compilations; d jsonb; tb_blocker text;
BEGIN
  SELECT * INTO r FROM public.financial_statement_reports WHERE company_id=p_company_id AND report_id=p_report_id AND report_version=p_report_version;
  IF r.id IS NULL THEN RETURN 'REPORT_VERSION_NOT_FOUND'; END IF;
  tb_blocker := public._tb_signoff_rules_blocker(p_company_id,p_report_id,p_report_version);
  IF tb_blocker IS NOT NULL THEN RETURN tb_blocker; END IF;
  SELECT * INTO c FROM public.fs_server_compilations WHERE company_id=p_company_id AND report_id=p_report_id AND report_version=p_report_version
    AND compiler_version='financial-report-compiler/1' AND document_hash=r.document_hash ORDER BY id DESC LIMIT 1;
  IF c.id IS NULL THEN RETURN 'SERVER_COMPILATION_REQUIRED'; END IF;
  IF NOT c.matches OR c.canonical_document IS DISTINCT FROM r.report_document THEN RETURN 'SERVER_DOCUMENT_MISMATCH'; END IF;
  d := public.fs_reporting_dependencies(p_company_id,r.period_year);
  IF c.dependencies_hash IS DISTINCT FROM d->>'dependenciesSha256' OR d->>'state' IS DISTINCT FROM 'current'
     OR c.canonical_document#>>'{entity,legalName}' IS DISTINCT FROM (SELECT name FROM public.companies WHERE id=p_company_id) THEN
    RETURN 'SERVER_COMPILATION_STALE';
  END IF;
  IF p_report_version <> (SELECT max(report_version) FROM public.financial_statement_reports WHERE report_id=p_report_id) THEN
    RETURN 'SERVER_COMPILATION_STALE';
  END IF;
  IF c.source_snapshot IS DISTINCT FROM public._fs_server_compile_snapshot(p_company_id,p_report_id,p_report_version) THEN
    RETURN 'SERVER_COMPILATION_SNAPSHOT_CHANGED';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(c.evaluation->'findings') f WHERE f->>'actionable'='true'
      AND (f->>'outcome'='INSUFFICIENT_EVIDENCE' OR f->>'failureSeverity' IN ('CRITICAL','HIGH') OR f->>'ruleId' IN ('note-to-face-reconciliation','movement-reconciliation','schedule-casting','equity-closing-tie','equity-profit-tie','cashflow-closing-cash-reconciliation','cashflow-account-rollforward','subtotal-casting','sfp-equation'))) THEN
    RETURN 'SERVER_COMPILATION_FINDINGS';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fs_server_compilation_blocker(uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the complete, current blocker implementation, including capacity/read-only and comment checks. Only append
-- this independent authority. Assert the exact splice count so no unknown function body is silently patched.
DO $install$
DECLARE v_def text; v_tail text := '  RETURN v_out;';
BEGIN
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure);
  IF (length(v_def)-length(replace(v_def,v_tail,'')))/length(v_tail) <> 1 THEN RAISE EXCEPTION 'PREFLIGHT_REFUSED: unknown publication blocker body'; END IF;
  EXECUTE replace(v_def,v_tail,E'  v_txt := public.fs_server_compilation_blocker(p_company_id,p_report_id,p_version);\n  IF v_txt IS NOT NULL THEN v_out := array_append(v_out,v_txt); END IF;\n  RETURN v_out;');
END;
$install$;

-- The table trigger protects direct writes too. AFTER INSERT runs after the existing binding trigger, preserving its
-- more specific refusals; any failure rolls the publication and binding back together. The canonical RPC holds this lock.
CREATE FUNCTION public.fs_require_server_compilation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE b text;
BEGIN
  IF NEW.state NOT IN ('REVIEWED','FINAL') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('financial_statement_reports:' || NEW.report_id));
  b := public.fs_server_compilation_blocker(NEW.company_id,NEW.report_id,NEW.report_version);
  IF b IS NOT NULL THEN RAISE EXCEPTION 'PUBLICATION_BLOCKED: %',b USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fs_require_server_compilation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_fsp_server_compilation AFTER INSERT ON public.financial_statement_publications FOR EACH ROW EXECUTE FUNCTION public.fs_require_server_compilation();

-- A pre-existing FINAL row is historical evidence, not a compiler receipt. New official issuances require one too.
-- Already issued objects and their verify/retrieve paths are unaffected; no report, approval or issuance is rewritten.
CREATE FUNCTION public.fs_require_compiled_issuance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.final_publication_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.financial_statement_publications p JOIN public.financial_statement_reports r USING(report_id,report_version)
    JOIN public.fs_server_compilations c ON c.report_id=r.report_id AND c.report_version=r.report_version AND c.company_id=r.company_id
     AND c.compiler_version='financial-report-compiler/1' AND c.document_hash=r.document_hash AND c.matches AND c.canonical_document=r.report_document
    WHERE p.id=NEW.final_publication_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.evaluation->'findings') f
      WHERE f->>'actionable'='true' AND (f->>'outcome'='INSUFFICIENT_EVIDENCE' OR f->>'failureSeverity' IN ('CRITICAL','HIGH') OR f->>'ruleId' IN ('note-to-face-reconciliation','movement-reconciliation','schedule-casting','equity-closing-tie','equity-profit-tie','cashflow-closing-cash-reconciliation','cashflow-account-rollforward','subtotal-casting','sfp-equation')))
  ) THEN RAISE EXCEPTION 'SERVER_COMPILATION_REQUIRED: official issuance requires a compiled report' USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fs_require_compiled_issuance() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER trg_rpi_server_compilation BEFORE INSERT ON public.reporting_pack_issuances FOR EACH ROW EXECUTE FUNCTION public.fs_require_compiled_issuance();

DO $server_compilation_postcondition$
BEGIN
  IF has_function_privilege('authenticated','public._fs_server_compile_snapshot(uuid,text,integer)','EXECUTE')
     OR has_function_privilege('service_role','public._fs_server_compile_snapshot(uuid,text,integer)','EXECUTE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.fs_server_compilations'::regclass)
     OR has_function_privilege('authenticated','public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)','EXECUTE')
     OR has_table_privilege('authenticated','public.fs_server_compilations','INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role','public.fs_server_compilations','INSERT,UPDATE,DELETE,TRUNCATE')
     OR position('fs_server_compilation_blocker' IN pg_get_functiondef('public.fs_publication_blockers(uuid,text,integer)'::regprocedure))=0
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.financial_statement_publications'::regclass AND tgname='trg_fsp_server_compilation' AND tgenabled='O')
     OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.reporting_pack_issuances'::regclass AND tgname='trg_rpi_server_compilation' AND tgenabled='O') THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: independent server compilation is not enforced';
  END IF;
END;
$server_compilation_postcondition$;

$fs_server_compilation_payload$;
END;
$fs_server_compilation_install$;
