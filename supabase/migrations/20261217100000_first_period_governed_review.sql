-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261217100000 — The first-period exception is a GOVERNED REVIEW, not a declaration. AUTHORED, NOT APPLIED to any hosted
-- database. Forward-only; builds on 20261017100000 (sign-off completion), 20261123100000 (server compilation) and
-- 20261216100000 (Ready for Reporting pilot): the stacked base is the pilot head.
--
--   THE DEFECT (reproduced on main f366367 and on the pilot head d688387 before this file): fs_declare_first_period (20261017100000)
--   accepted ANY certificate-of-incorporation reference with ANY issue date, and fs_first_period_declared was true whenever
--   such a declaration was the latest record and CFOClose held no earlier trial balance. A long-established entity that
--   merely began using CFOClose this year could therefore cite its 2018 certificate and suppress COMPARATIVE_PERIOD_MISSING
--   (and the comparatives status moved to first_period_exception). "No earlier CFOClose trial balance" is a fact about the
--   workspace, not about the entity.
--
--   THE REPAIR (the smallest authoritative change): fs_first_period_declared - the ONE predicate behind the blocker, the
--   comparatives status and its dependency hash - now answers true only for a VERIFIED, still-bound first-period review:
--     · structured facts (legal identity, registration date, effective start, the exact reporting dates, basis), cited
--       immutable evidence revisions and a bounded written basis, recorded by a preparer (prepare_close);
--     · a decision by a DIFFERENT approver (approve_certification) taken only while every server rule is met, bound to the
--       entity, the period dates the server reads from the authoritative trial balance, the facts, the cited evidence
--       revisions, the whole evidence set of the period and the rule version (first-period-rules/1);
--     · anything that changes afterwards (new or revised evidence of ANY kind, new facts, a changed company identity, a
--       changed period, earlier-period books appearing, a new rule version) makes the decision stale: the exception stops
--       applying and the blocker names why. Nothing is inferred from a date or a checkbox; a dormant entity qualifies only
--       through the dormancy basis, its evidence and an approver's decision.
--   Legacy declarations (fs_first_period_declarations) are KEPT, append-only and unchanged, but are claims only: they are
--   never promoted to a verified decision. A workspace relying on one sees FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED.
--   A verified first period addresses COMPARATIVES ONLY. Opening balances are a second subject with their own facts,
--   evidence and decision (nil opening, or activity before bookkeeping began, reconciled item by item); while the exception is
--   the comparative requirement's only basis, an unsupported opening is a blocker of its own (OPENING_SUPPORT_*).
--
--   fs_publication_blockers is NOT re-created from a copy: the live definition (document-structure v7 + the server
--   compilation splice 20261123100000 + the readiness splice 20261216100000) is read, one anchored block is replaced
--   (asserted to occur exactly once) with itself plus two calls, and the result is checked to still carry every splice.
--
--   Locks: every writer takes _fs_scope_lock(company, period) FIRST, exactly like the sign-off transition
--   (fs_set_publication_state) and the pilot's input writers, so a change either commits before sign-off evaluates or waits
--   until sign-off has committed. Issued history (publications, bindings, reports, packs) is not touched by this file.
--
-- PREFLIGHT: the new objects do not exist; the sign-off, server-compilation and readiness splices are present; the anchor
-- block occurs exactly once. POSTCONDITION: the same splices are still present and the new calls are in.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

DO $preflight$
DECLARE
  v_def  text;
  v_hits integer;
  c_anchor constant text := E'    IF v_req.comparatives_required AND NOT v_comp_any AND NOT public.fs_first_period_declared(p_company_id, v_report.period_year) THEN\n      v_out := array_append(v_out, ''COMPARATIVE_PERIOD_MISSING'');\n    END IF;';
BEGIN
  IF to_regclass('public.fs_first_period_evidence') IS NOT NULL OR to_regclass('public.fs_first_period_claims') IS NOT NULL OR to_regclass('public.fs_first_period_decisions') IS NOT NULL
     OR to_regprocedure('public._fs_first_period_assess(uuid, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the first-period governed review is already applied; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regclass('public.fs_first_period_declarations') IS NULL
     OR to_regprocedure('public.fs_first_period_declared(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_earlier_period_history(uuid, integer)') IS NULL
     OR to_regprocedure('public._fs_scope_lock(uuid, integer)') IS NULL
     OR to_regprocedure('public.get_authoritative_certification(uuid, integer)') IS NULL
     OR to_regprocedure('public.workspace_capability_allowed(uuid, uuid, text)') IS NULL
     OR to_regprocedure('public.fs_rollout_allows(uuid)') IS NULL
     OR to_regprocedure('public._cr_member(uuid, uuid)') IS NULL
     OR to_regprocedure('public.close_review_readable(uuid)') IS NULL
     OR to_regprocedure('public.close_review_events_guard()') IS NULL
     OR to_regprocedure('public._rfr_blockers(uuid, text, integer)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: 20261017100000 (first-period declarations), 20261125100000/20261127100000 (scope lock) and 20261216100000 (readiness pilot) must be applied first; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  IF position('fs_server_compilation_blocker' IN v_def) = 0 OR position('_rfr_blockers' IN v_def) = 0 OR position('DOCUMENT_FACT_NOT_COMPOSED' IN v_def) = 0
     OR position('_fs_document_structure_blockers' IN v_def) = 0 OR position('ACCOUNT_CAPACITY_EXCEEDED' IN v_def) = 0 OR position('REVIEW_COMMENT_UNRESOLVED' IN v_def) = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_publication_blockers lacks the server-compilation, document-structure or readiness splice; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF position('_fs_first_period_pending' IN v_def) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fs_publication_blockers already carries the first-period calls; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  v_hits := (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: expected exactly one comparative-requirement block in fs_publication_blockers, found %; nothing was changed', v_hits USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. Tables (append-only; no client write path) ────────────────────────────────────────────────────────────────────
-- Immutable evidence REVISIONS. A revision never changes; a newer revision of the same (kind, reference) supersedes it, and a
-- retraction is itself a revision. document_sha256 is the hash of the document the reference names (the document itself stays
-- in the firm's private storage; the review binds its hash).
CREATE TABLE public.fs_first_period_evidence (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  kind            TEXT        NOT NULL CHECK (kind IN ('certificate_of_incorporation', 'certificate_of_registration', 'commencement_resolution',
                                'regulatory_commencement_notice', 'dormancy_confirmation', 'prior_activity_record', 'pre_setup_activity_support', 'opening_position_support')),
  reference       TEXT        NOT NULL CHECK (length(btrim(reference)) BETWEEN 3 AND 300),
  issued_on       DATE        NOT NULL,
  -- The date the document establishes: the registration date, the commencement date, the last dormant day, the date of the
  -- activity it records, or the date of the position it supports. Required unless the revision retracts the evidence.
  asserted_date   DATE        NULL,
  document_sha256 TEXT        NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  revision        INTEGER     NOT NULL CHECK (revision >= 1),
  retracted       BOOLEAN     NOT NULL DEFAULT false,
  note            TEXT        NULL CHECK (note IS NULL OR length(note) <= 500),
  request_id      UUID        NOT NULL,
  intent_sha256   TEXT        NOT NULL,
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fpe_revision UNIQUE (company_id, period_year, kind, reference, revision),
  CONSTRAINT uq_fpe_request UNIQUE (actor_user_id, request_id),
  CONSTRAINT chk_fpe_asserted CHECK (retracted OR asserted_date IS NOT NULL)
);
CREATE INDEX idx_fpe_scope ON public.fs_first_period_evidence (company_id, period_year, seq);

-- The facts the preparer states, with the evidence they cite and a bounded written basis for the judgment.
CREATE TABLE public.fs_first_period_claims (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  subject         TEXT        NOT NULL CHECK (subject IN ('first_period', 'opening_balances')),
  facts           JSONB       NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  facts_sha256    TEXT        NOT NULL CHECK (facts_sha256 ~ '^[0-9a-f]{64}$'),
  basis_text      TEXT        NOT NULL CHECK (length(btrim(basis_text)) BETWEEN 20 AND 1500),
  evidence_ids    UUID[]      NOT NULL CHECK (cardinality(evidence_ids) BETWEEN 0 AND 60),
  request_id      UUID        NOT NULL,
  intent_sha256   TEXT        NOT NULL,
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fpc_request UNIQUE (actor_user_id, request_id)
);
CREATE INDEX idx_fpc_scope ON public.fs_first_period_claims (company_id, period_year, subject, seq DESC);

-- The approver's decision on ONE claim. A verified decision carries the binding digest it was taken against.
CREATE TABLE public.fs_first_period_decisions (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq             BIGINT      GENERATED ALWAYS AS IDENTITY,
  company_id      UUID        NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
  period_year     INTEGER     NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  subject         TEXT        NOT NULL CHECK (subject IN ('first_period', 'opening_balances')),
  claim_id        UUID        NOT NULL REFERENCES public.fs_first_period_claims (id) ON DELETE RESTRICT,
  outcome         TEXT        NOT NULL CHECK (outcome IN ('verified', 'not_verified', 'withdrawn')),
  rule_version    TEXT        NOT NULL,
  bound_sha256    TEXT        NULL CHECK (bound_sha256 IS NULL OR bound_sha256 ~ '^[0-9a-f]{64}$'),
  reason          TEXT        NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1500),
  request_id      UUID        NOT NULL,
  intent_sha256   TEXT        NOT NULL,
  actor_user_id   UUID        NOT NULL,
  firm_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_fpd2_request UNIQUE (actor_user_id, request_id),
  CONSTRAINT chk_fpd2_bound CHECK ((outcome = 'verified') = (bound_sha256 IS NOT NULL))
);
CREATE INDEX idx_fpd2_scope ON public.fs_first_period_decisions (company_id, period_year, subject, seq DESC);

CREATE TRIGGER trg_fpe_append_only  BEFORE UPDATE OR DELETE ON public.fs_first_period_evidence  FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpe_no_truncate  BEFORE TRUNCATE ON public.fs_first_period_evidence  FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpc_append_only  BEFORE UPDATE OR DELETE ON public.fs_first_period_claims    FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpc_no_truncate  BEFORE TRUNCATE ON public.fs_first_period_claims    FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpd2_append_only BEFORE UPDATE OR DELETE ON public.fs_first_period_decisions FOR EACH ROW EXECUTE FUNCTION public.close_review_events_guard();
CREATE TRIGGER trg_fpd2_no_truncate BEFORE TRUNCATE ON public.fs_first_period_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.close_review_events_guard();

-- ── 2. Words: one specific next action per unresolved item ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_fp_next_action(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE split_part(p_code, ':', 1)
    WHEN 'FIRST_PERIOD_PERIOD_UNKNOWN' THEN 'Review and certify this period''s trial balance first; the reporting dates come from it.'
    WHEN 'FIRST_PERIOD_EARLIER_BOOKS_EXIST' THEN 'An earlier period''s trial balance exists in this workspace, so this is not a first period. Review the prior year and approve the comparative.'
    WHEN 'FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED' THEN 'Your earlier first-period declaration is kept as a claim only. Record the first-period facts, cite the registration evidence and ask a partner or manager to review them.'
    WHEN 'FIRST_PERIOD_FACTS_MISSING' THEN 'Record the first-period facts (legal name, registration and start dates, the exact reporting dates) and cite the evidence for them.'
    WHEN 'FIRST_PERIOD_ENTITY_NAME_MISMATCH' THEN 'Make the legal name in the facts match the company name in this workspace, or correct the company name.'
    WHEN 'FIRST_PERIOD_ENTITY_TIN_MISMATCH' THEN 'Make the TIN in the facts match the company''s TIN, or correct the company profile.'
    WHEN 'FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING' THEN 'Cite the certificate of incorporation or registration whose date is the registration date in the facts.'
    WHEN 'FIRST_PERIOD_DATES_MISMATCH' THEN 'The facts name different reporting dates from the reviewed trial balance. Record the facts again for the server''s dates.'
    WHEN 'FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE' THEN 'The registration date is before this period begins, so the evidence cited does not show a first period. Prepare comparatives; if the entity was dormant, record the dormancy basis with its evidence.'
    WHEN 'FIRST_PERIOD_START_OUTSIDE_PERIOD' THEN 'The effective start date must fall inside the reporting period and not before the registration date. Correct the facts or the evidence.'
    WHEN 'FIRST_PERIOD_BASIS_MISMATCH' THEN 'The dormancy basis applies only to an entity registered before this period began. Use the incorporated-in-period basis, or correct the registration date.'
    WHEN 'FIRST_PERIOD_COMMENCEMENT_EVIDENCE_MISSING' THEN 'Cite the commencement resolution or the regulator''s commencement notice that establishes the effective start date.'
    WHEN 'FIRST_PERIOD_PRIOR_STATEMENTS_EXIST' THEN 'Financial statements were prepared for an earlier period, so comparatives are required. Prepare the prior year.'
    WHEN 'FIRST_PERIOD_DORMANCY_EVIDENCE_MISSING' THEN 'Cite a dormancy confirmation (for example the tax authority''s dormant status or nil returns) covering the time from registration to the start date.'
    WHEN 'FIRST_PERIOD_DORMANCY_COVERAGE_GAP' THEN 'The dormancy evidence does not cover the whole time from registration to the day before the start date. Cite evidence that does, or correct the dates.'
    WHEN 'FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS' THEN 'A record in the evidence shows activity before the entity''s stated start date. Resolve it: correct the start date with evidence, or prepare comparatives.'
    WHEN 'FIRST_PERIOD_EVIDENCE_SUPERSEDED' THEN 'A cited evidence revision has been replaced or retracted. Record the facts again, citing the current revisions.'
    WHEN 'FIRST_PERIOD_REVIEW_PENDING' THEN 'Ask a partner or manager other than the person who recorded the facts to review and approve them.'
    WHEN 'FIRST_PERIOD_REVIEW_REFUSED' THEN 'The reviewer did not verify the first-period facts. Read the reason, then correct and re-submit them, or prepare comparatives.'
    WHEN 'FIRST_PERIOD_DECISION_STALE' THEN 'The company, period, facts or evidence changed after the approval. Ask the reviewer to review the first-period facts again.'
    WHEN 'FIRST_PERIOD_RULES_CHANGED' THEN 'The first-period rules changed after the approval. Ask the reviewer to review the first-period facts again.'
    WHEN 'OPENING_SUPPORT_FIRST_PERIOD_FACTS_MISSING' THEN 'Record the first-period facts first; the opening-balance support is judged against the effective start date.'
    WHEN 'OPENING_SUPPORT_MISSING' THEN 'Record the opening-balance support: that there were no balances at the start (with evidence), or the activity before bookkeeping began, item by item.'
    WHEN 'OPENING_SUPPORT_EVIDENCE_MISSING' THEN 'Cite the evidence that supports the opening position (an opening statement or the records of each earlier item).'
    WHEN 'OPENING_SUPPORT_ITEM_OUTSIDE_WINDOW' THEN 'Each earlier item must fall between the effective start date and the day before bookkeeping began. Correct the item dates.'
    WHEN 'OPENING_SUPPORT_NOT_RECONCILED' THEN 'The listed items do not add up to the opening position stated. Correct the items or the total.'
    WHEN 'OPENING_SUPPORT_EVIDENCE_SUPERSEDED' THEN 'A cited evidence revision has been replaced or retracted. Record the opening-balance support again, citing the current revisions.'
    WHEN 'OPENING_SUPPORT_REVIEW_PENDING' THEN 'Ask a partner or manager other than the person who recorded the opening-balance support to review and approve it.'
    WHEN 'OPENING_SUPPORT_REVIEW_REFUSED' THEN 'The reviewer did not verify the opening-balance support. Read the reason, then correct and re-submit it.'
    WHEN 'OPENING_SUPPORT_DECISION_STALE' THEN 'The company, period, support or evidence changed after the approval. Ask the reviewer to review the opening-balance support again.'
    WHEN 'OPENING_SUPPORT_RULES_CHANGED' THEN 'The opening-balance rules changed after the approval. Ask the reviewer to review the support again.'
    ELSE NULL END;
$$;

-- ── 3. Helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_fp_norm(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT btrim(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

-- The exact reporting dates the server holds for the period: the authoritative certified trial balance's own period.
CREATE OR REPLACE FUNCTION public._fs_fp_period(p_company_id uuid, p_period_year integer)
RETURNS TABLE (reporting_start date, reporting_end date) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT fp.reporting_start, fp.reporting_end
    FROM public.get_authoritative_certification(p_company_id, p_period_year) c
    JOIN public.trial_balance_uploads u ON u.id = c.upload_id
    JOIN public.fiscal_periods fp ON fp.id = u.period_id
   LIMIT 1;
$$;

-- The latest revision of each (kind, reference) that has not been retracted.
CREATE OR REPLACE FUNCTION public._fs_fp_current_evidence(p_company_id uuid, p_period_year integer)
RETURNS SETOF public.fs_first_period_evidence LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.* FROM public.fs_first_period_evidence e
   WHERE e.company_id = p_company_id AND e.period_year = p_period_year AND NOT e.retracted
     AND e.revision = (SELECT max(x.revision) FROM public.fs_first_period_evidence x
                        WHERE x.company_id = e.company_id AND x.period_year = e.period_year AND x.kind = e.kind AND x.reference = e.reference);
$$;

-- Every evidence revision ever recorded for the scope that bears on the subject (a new revision of ANY such kind - cited or
-- not, whenever it arrives - changes this). The first-period decision rests on identity, commencement, dormancy and
-- prior-activity evidence; the opening decision on opening-support and prior-activity evidence.
CREATE OR REPLACE FUNCTION public._fs_fp_evidence_set_sha(p_company_id uuid, p_period_year integer, p_subject text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(e.id::text || ':' || e.document_sha256 || ':' || e.retracted::text, ',' ORDER BY e.seq), ''), 'UTF8')), 'hex')
    FROM public.fs_first_period_evidence e
   WHERE e.company_id = p_company_id AND e.period_year = p_period_year
     AND e.kind = ANY (CASE WHEN p_subject = 'first_period'
                            THEN ARRAY['certificate_of_incorporation', 'certificate_of_registration', 'commencement_resolution', 'regulatory_commencement_notice', 'dormancy_confirmation', 'prior_activity_record']
                            ELSE ARRAY['pre_setup_activity_support', 'opening_position_support', 'prior_activity_record'] END);
$$;

CREATE OR REPLACE FUNCTION public._fs_fp_is_date(p_text text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
  PERFORM p_text::date;
  RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END;
$$;

-- Shape validation of the facts a claim states (the server never trusts the browser's validation). NULL = valid.
CREATE OR REPLACE FUNCTION public._fs_fp_validate_facts(p_subject text, p_facts jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE
  v_k text; v_item jsonb; v_n integer := 0;
BEGIN
  IF p_facts IS NULL OR jsonb_typeof(p_facts) <> 'object' THEN RETURN 'facts must be an object'; END IF;
  IF p_subject = 'first_period' THEN
    FOR v_k IN SELECT jsonb_object_keys(p_facts) LOOP
      IF v_k NOT IN ('legalName', 'registrationNumber', 'tin', 'basis', 'registrationDate', 'effectiveStart', 'reportingStart', 'reportingEnd', 'priorStatementsPrepared', 'dormantFrom', 'dormantThrough') THEN
        RETURN 'unknown fact ' || left(v_k, 40);
      END IF;
    END LOOP;
    IF jsonb_typeof(p_facts -> 'legalName') IS DISTINCT FROM 'string' OR length(btrim(p_facts ->> 'legalName')) NOT BETWEEN 3 AND 200 THEN RETURN 'legalName'; END IF;
    IF jsonb_typeof(p_facts -> 'registrationNumber') IS DISTINCT FROM 'string' OR length(btrim(p_facts ->> 'registrationNumber')) NOT BETWEEN 3 AND 60 THEN RETURN 'registrationNumber'; END IF;
    IF p_facts ? 'tin' AND jsonb_typeof(p_facts -> 'tin') <> 'null' AND (jsonb_typeof(p_facts -> 'tin') <> 'string' OR (p_facts ->> 'tin') !~ '^[0-9]{9,12}$') THEN RETURN 'tin'; END IF;
    IF (p_facts ->> 'basis') IS NULL OR (p_facts ->> 'basis') NOT IN ('incorporated_in_period', 'commenced_after_dormancy') THEN RETURN 'basis'; END IF;
    FOREACH v_k IN ARRAY ARRAY['registrationDate', 'effectiveStart', 'reportingStart', 'reportingEnd'] LOOP
      IF jsonb_typeof(p_facts -> v_k) IS DISTINCT FROM 'string' OR NOT public._fs_fp_is_date(p_facts ->> v_k) THEN RETURN v_k; END IF;
    END LOOP;
    IF jsonb_typeof(p_facts -> 'priorStatementsPrepared') IS DISTINCT FROM 'boolean' THEN RETURN 'priorStatementsPrepared'; END IF;
    IF p_facts ->> 'basis' = 'commenced_after_dormancy' THEN
      FOREACH v_k IN ARRAY ARRAY['dormantFrom', 'dormantThrough'] LOOP
        IF jsonb_typeof(p_facts -> v_k) IS DISTINCT FROM 'string' OR NOT public._fs_fp_is_date(p_facts ->> v_k) THEN RETURN v_k; END IF;
      END LOOP;
    ELSIF p_facts ? 'dormantFrom' OR p_facts ? 'dormantThrough' THEN
      RETURN 'dormancy facts apply only to the dormancy basis';
    END IF;
    RETURN NULL;
  ELSIF p_subject = 'opening_balances' THEN
    FOR v_k IN SELECT jsonb_object_keys(p_facts) LOOP
      IF v_k NOT IN ('basis', 'bookkeepingStart', 'preSetupNetMinor', 'items') THEN RETURN 'unknown fact ' || left(v_k, 40); END IF;
    END LOOP;
    IF (p_facts ->> 'basis') IS NULL OR (p_facts ->> 'basis') NOT IN ('nil_opening', 'reconciled_pre_setup_activity') THEN RETURN 'basis'; END IF;
    IF jsonb_typeof(p_facts -> 'bookkeepingStart') IS DISTINCT FROM 'string' OR NOT public._fs_fp_is_date(p_facts ->> 'bookkeepingStart') THEN RETURN 'bookkeepingStart'; END IF;
    IF p_facts ->> 'basis' = 'nil_opening' THEN
      IF p_facts ? 'items' OR p_facts ? 'preSetupNetMinor' THEN RETURN 'a nil opening carries no items or total'; END IF;
      RETURN NULL;
    END IF;
    IF jsonb_typeof(p_facts -> 'preSetupNetMinor') IS DISTINCT FROM 'string' OR (p_facts ->> 'preSetupNetMinor') !~ '^-?[0-9]{1,18}$' THEN RETURN 'preSetupNetMinor'; END IF;
    IF jsonb_typeof(p_facts -> 'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_facts -> 'items') NOT BETWEEN 1 AND 50 THEN RETURN 'items'; END IF;
    FOR v_item IN SELECT jsonb_array_elements(p_facts -> 'items') LOOP
      v_n := v_n + 1;
      IF jsonb_typeof(v_item) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('description', 'date', 'amountMinor', 'evidenceId'))
         OR jsonb_typeof(v_item -> 'description') IS DISTINCT FROM 'string' OR length(btrim(v_item ->> 'description')) NOT BETWEEN 3 AND 200
         OR jsonb_typeof(v_item -> 'date') IS DISTINCT FROM 'string' OR NOT public._fs_fp_is_date(v_item ->> 'date')
         OR jsonb_typeof(v_item -> 'amountMinor') IS DISTINCT FROM 'string' OR (v_item ->> 'amountMinor') !~ '^-?[0-9]{1,18}$'
         OR jsonb_typeof(v_item -> 'evidenceId') IS DISTINCT FROM 'string' OR (v_item ->> 'evidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN 'items[' || v_n || ']';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  RETURN 'subject';
END;
$$;

-- ── 4. The first-period assessment: every rule re-evaluated from the server's own data at every use ──────────────────────
-- Returns { subject, rules, state: verified | pending | not_eligible, factIssues: [...], pending: [...], claimId, decisionId,
-- binding }. factIssues are the rule failures; pending adds the review step. A decision can only verify while factIssues is empty.
CREATE OR REPLACE FUNCTION public._fs_first_period_assess(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c_rules constant text := 'first-period-rules/1';
  v_per record; v_co record; v_hist text; v_claim public.fs_first_period_claims; v_dec public.fs_first_period_decisions;
  v_f jsonb; v_issues text[] := '{}'; v_pending text[]; v_basis text;
  v_reg date; v_eff date; v_rs date; v_re date; v_dfrom date; v_dthru date;
  v_legacy boolean; v_n integer; v_bind text; v_state text; v_ncur integer;
BEGIN
  v_hist := public._fs_earlier_period_history(p_company_id, p_period_year);
  IF v_hist IS NOT NULL THEN
    RETURN jsonb_build_object('subject', 'first_period', 'rules', c_rules, 'state', 'not_eligible', 'factIssues', jsonb_build_array('FIRST_PERIOD_EARLIER_BOOKS_EXIST'),
                              'pending', jsonb_build_array('FIRST_PERIOD_EARLIER_BOOKS_EXIST'), 'claimId', NULL, 'decisionId', NULL, 'binding', NULL, 'earlierHistory', v_hist);
  END IF;
  SELECT * INTO v_claim FROM public.fs_first_period_claims c
   WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = 'first_period' ORDER BY c.seq DESC LIMIT 1;
  IF v_claim.id IS NULL THEN
    v_legacy := COALESCE((SELECT d.action = 'declared' FROM public.fs_first_period_declarations d
                           WHERE d.company_id = p_company_id AND d.period_year = p_period_year ORDER BY d.seq DESC LIMIT 1), false);
    v_issues := ARRAY[CASE WHEN v_legacy THEN 'FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED' ELSE 'FIRST_PERIOD_FACTS_MISSING' END];
    RETURN jsonb_build_object('subject', 'first_period', 'rules', c_rules, 'state', 'pending', 'factIssues', to_jsonb(v_issues), 'pending', to_jsonb(v_issues),
                              'claimId', NULL, 'decisionId', NULL, 'binding', NULL);
  END IF;
  SELECT * INTO v_per FROM public._fs_fp_period(p_company_id, p_period_year);
  SELECT c.name, c.tin INTO v_co FROM public.companies c WHERE c.id = p_company_id;
  v_f := v_claim.facts;
  v_basis := v_f ->> 'basis';
  v_reg := (v_f ->> 'registrationDate')::date; v_eff := (v_f ->> 'effectiveStart')::date;
  v_rs := (v_f ->> 'reportingStart')::date; v_re := (v_f ->> 'reportingEnd')::date;

  IF v_per.reporting_start IS NULL OR v_per.reporting_end IS NULL THEN
    v_issues := v_issues || 'FIRST_PERIOD_PERIOD_UNKNOWN'::text;
  ELSIF v_rs IS DISTINCT FROM v_per.reporting_start OR v_re IS DISTINCT FROM v_per.reporting_end THEN
    v_issues := v_issues || ('FIRST_PERIOD_DATES_MISMATCH:' || v_per.reporting_start::text || ':' || v_per.reporting_end::text);
  END IF;
  -- Identity: the company in this workspace is the entity the facts describe.
  IF public._fs_fp_norm(v_f ->> 'legalName') IS DISTINCT FROM public._fs_fp_norm(v_co.name) THEN v_issues := v_issues || 'FIRST_PERIOD_ENTITY_NAME_MISMATCH'::text; END IF;
  IF v_co.tin IS NOT NULL AND btrim(v_co.tin) <> '' AND (v_f ->> 'tin') IS DISTINCT FROM btrim(v_co.tin) THEN v_issues := v_issues || 'FIRST_PERIOD_ENTITY_TIN_MISMATCH'::text; END IF;

  SELECT count(*) INTO v_n FROM unnest(v_claim.evidence_ids) i WHERE NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = i);
  IF v_n > 0 THEN v_issues := v_issues || ('FIRST_PERIOD_EVIDENCE_SUPERSEDED:' || v_n); END IF;
  IF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e
                  WHERE e.id = ANY (v_claim.evidence_ids) AND e.kind IN ('certificate_of_incorporation', 'certificate_of_registration') AND e.asserted_date = v_reg) THEN
    v_issues := v_issues || 'FIRST_PERIOD_IDENTITY_EVIDENCE_MISSING'::text;
  END IF;

  IF v_basis = 'incorporated_in_period' THEN
    IF v_reg < v_rs THEN v_issues := v_issues || 'FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE'::text;
    ELSIF v_reg > v_re OR v_eff < v_reg OR v_eff < v_rs OR v_eff > v_re THEN v_issues := v_issues || 'FIRST_PERIOD_START_OUTSIDE_PERIOD'::text; END IF;
  ELSE
    IF v_reg >= v_rs THEN v_issues := v_issues || 'FIRST_PERIOD_BASIS_MISMATCH'::text;
    ELSIF v_eff < v_rs OR v_eff > v_re THEN v_issues := v_issues || 'FIRST_PERIOD_START_OUTSIDE_PERIOD'::text; END IF;
    IF (v_f ->> 'priorStatementsPrepared')::boolean THEN v_issues := v_issues || 'FIRST_PERIOD_PRIOR_STATEMENTS_EXIST'::text; END IF;
    v_dfrom := (v_f ->> 'dormantFrom')::date; v_dthru := (v_f ->> 'dormantThrough')::date;
    IF v_dfrom IS DISTINCT FROM v_reg OR v_dthru IS DISTINCT FROM (v_eff - 1) THEN
      v_issues := v_issues || 'FIRST_PERIOD_DORMANCY_COVERAGE_GAP'::text;
    ELSIF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = ANY (v_claim.evidence_ids) AND e.kind = 'dormancy_confirmation') THEN
      v_issues := v_issues || 'FIRST_PERIOD_DORMANCY_EVIDENCE_MISSING'::text;
    ELSIF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = ANY (v_claim.evidence_ids) AND e.kind = 'dormancy_confirmation' AND e.asserted_date >= v_dthru) THEN
      v_issues := v_issues || 'FIRST_PERIOD_DORMANCY_COVERAGE_GAP'::text;
    END IF;
  END IF;
  -- The effective start is a stated fact; it is evidenced by the registration itself only when it IS the registration date.
  IF v_eff IS DISTINCT FROM v_reg OR v_basis = 'commenced_after_dormancy' THEN
    IF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e
                    WHERE e.id = ANY (v_claim.evidence_ids) AND e.kind IN ('commencement_resolution', 'regulatory_commencement_notice') AND e.asserted_date = v_eff) THEN
      v_issues := v_issues || 'FIRST_PERIOD_COMMENCEMENT_EVIDENCE_MISSING'::text;
    END IF;
  END IF;
  -- Contradiction: ANY current evidence of the scope (cited or not, whenever it arrived) recording activity before the start.
  -- Activity from the start onward - including before bookkeeping began - is not a contradiction; it is reconciled as an opening.
  SELECT count(*) INTO v_ncur FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.kind = 'prior_activity_record' AND e.asserted_date < v_eff;
  IF v_ncur > 0 THEN v_issues := v_issues || ('FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS:' || v_ncur); END IF;

  -- The binding: everything the decision rests on.
  v_bind := public._fs_fp_binding(p_company_id, p_period_year, 'first_period', v_claim, v_per.reporting_start, v_per.reporting_end, v_co.name, v_co.tin, NULL);
  SELECT * INTO v_dec FROM public.fs_first_period_decisions d WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.subject = 'first_period' AND d.claim_id = v_claim.id ORDER BY d.seq DESC LIMIT 1;
  v_pending := v_issues;
  IF v_dec.id IS NOT NULL AND v_dec.outcome = 'verified' AND (v_dec.bound_sha256 IS DISTINCT FROM v_bind OR v_dec.rule_version IS DISTINCT FROM c_rules) AND NOT ('FIRST_PERIOD_DECISION_STALE' = ANY (v_pending)) THEN
    v_pending := v_pending || CASE WHEN v_dec.rule_version IS DISTINCT FROM c_rules THEN 'FIRST_PERIOD_RULES_CHANGED' ELSE 'FIRST_PERIOD_DECISION_STALE' END;
  ELSIF cardinality(v_issues) = 0 THEN
    IF v_dec.id IS NULL OR v_dec.outcome = 'withdrawn' THEN v_pending := v_pending || 'FIRST_PERIOD_REVIEW_PENDING'::text;
    ELSIF v_dec.outcome = 'not_verified' THEN v_pending := v_pending || 'FIRST_PERIOD_REVIEW_REFUSED'::text;
    END IF;
  END IF;
  v_state := CASE WHEN cardinality(v_pending) = 0 THEN 'verified'
                  WHEN EXISTS (SELECT 1 FROM unnest(v_issues) i WHERE split_part(i, ':', 1) IN ('FIRST_PERIOD_NOT_FIRST_ON_EVIDENCE', 'FIRST_PERIOD_PRIOR_STATEMENTS_EXIST')) THEN 'not_eligible'
                  ELSE 'pending' END;
  RETURN jsonb_build_object('subject', 'first_period', 'rules', c_rules, 'state', v_state, 'factIssues', to_jsonb(v_issues), 'pending', to_jsonb(v_pending),
                            'claimId', v_claim.id, 'decisionId', v_dec.id, 'binding', v_bind);
END;
$$;

-- The digest a decision is bound to. 'first_period' binds the entity, the server's period dates, the claim, the cited revisions,
-- the whole evidence set of the period, the rule version and the absence of earlier books; 'opening_balances' additionally binds
-- the first-period facts its dates rest on.
CREATE OR REPLACE FUNCTION public._fs_fp_binding(p_company_id uuid, p_period_year integer, p_subject text, p_claim public.fs_first_period_claims,
  p_start date, p_end date, p_name text, p_tin text, p_first_period_facts_sha text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'rules', CASE WHEN p_subject = 'first_period' THEN 'first-period-rules/1' ELSE 'opening-balance-rules/1' END,
    'companyId', p_company_id, 'legalName', p_name, 'tin', p_tin, 'periodYear', p_period_year, 'reportingStart', p_start, 'reportingEnd', p_end,
    'claimId', p_claim.id, 'factsSha256', p_claim.facts_sha256, 'basisSha256', encode(sha256(convert_to(p_claim.basis_text, 'UTF8')), 'hex'),
    'cited', COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id, e.kind, e.reference, e.revision, e.document_sha256, e.asserted_date, e.issued_on) ORDER BY e.id)
                         FROM public.fs_first_period_evidence e WHERE e.id = ANY (p_claim.evidence_ids)), '[]'::jsonb),
    'evidenceSet', public._fs_fp_evidence_set_sha(p_company_id, p_period_year, p_subject),
    'earlierHistory', COALESCE(public._fs_earlier_period_history(p_company_id, p_period_year), 'none'),
    'firstPeriodFactsSha256', p_first_period_facts_sha
  )::text, 'UTF8')), 'hex');
$$;

-- ── 5. The opening-balance assessment: its own facts, evidence and decision ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fs_opening_assess(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  c_rules constant text := 'opening-balance-rules/1';
  v_per record; v_co record; v_claim public.fs_first_period_claims; v_fp public.fs_first_period_claims; v_dec public.fs_first_period_decisions;
  v_f jsonb; v_issues text[] := '{}'; v_pending text[]; v_eff date; v_bk date; v_basis text; v_item jsonb; v_sum numeric := 0; v_n integer; v_bind text; v_state text;
BEGIN
  SELECT * INTO v_fp FROM public.fs_first_period_claims c WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = 'first_period' ORDER BY c.seq DESC LIMIT 1;
  SELECT * INTO v_claim FROM public.fs_first_period_claims c WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = 'opening_balances' ORDER BY c.seq DESC LIMIT 1;
  IF v_fp.id IS NULL THEN
    RETURN jsonb_build_object('subject', 'opening_balances', 'rules', c_rules, 'state', 'pending', 'factIssues', jsonb_build_array('OPENING_SUPPORT_FIRST_PERIOD_FACTS_MISSING'),
                              'pending', jsonb_build_array('OPENING_SUPPORT_FIRST_PERIOD_FACTS_MISSING'), 'claimId', NULL, 'decisionId', NULL, 'binding', NULL);
  END IF;
  IF v_claim.id IS NULL THEN
    RETURN jsonb_build_object('subject', 'opening_balances', 'rules', c_rules, 'state', 'pending', 'factIssues', jsonb_build_array('OPENING_SUPPORT_MISSING'),
                              'pending', jsonb_build_array('OPENING_SUPPORT_MISSING'), 'claimId', NULL, 'decisionId', NULL, 'binding', NULL);
  END IF;
  SELECT * INTO v_per FROM public._fs_fp_period(p_company_id, p_period_year);
  SELECT c.name, c.tin INTO v_co FROM public.companies c WHERE c.id = p_company_id;
  v_f := v_claim.facts; v_basis := v_f ->> 'basis'; v_bk := (v_f ->> 'bookkeepingStart')::date; v_eff := (v_fp.facts ->> 'effectiveStart')::date;
  SELECT count(*) INTO v_n FROM unnest(v_claim.evidence_ids) i WHERE NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = i);
  IF v_n > 0 THEN v_issues := v_issues || ('OPENING_SUPPORT_EVIDENCE_SUPERSEDED:' || v_n); END IF;
  IF v_basis = 'nil_opening' THEN
    -- Books that begin on or before the entity's start leave no room for earlier activity; the position at the start is nil.
    IF v_bk > v_eff THEN v_issues := v_issues || 'OPENING_SUPPORT_NOT_RECONCILED'::text; END IF;
    IF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = ANY (v_claim.evidence_ids) AND e.kind = 'opening_position_support') THEN
      v_issues := v_issues || 'OPENING_SUPPORT_EVIDENCE_MISSING'::text;
    END IF;
  ELSE
    FOR v_item IN SELECT jsonb_array_elements(v_f -> 'items') LOOP
      v_sum := v_sum + (v_item ->> 'amountMinor')::numeric;
      IF (v_item ->> 'date')::date < v_eff OR (v_item ->> 'date')::date >= v_bk THEN v_issues := v_issues || 'OPENING_SUPPORT_ITEM_OUTSIDE_WINDOW'::text;
      ELSIF NOT EXISTS (SELECT 1 FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e
                         WHERE e.id = (v_item ->> 'evidenceId')::uuid AND e.id = ANY (v_claim.evidence_ids) AND e.kind IN ('pre_setup_activity_support', 'prior_activity_record')
                           AND e.asserted_date = (v_item ->> 'date')::date) THEN
        v_issues := v_issues || 'OPENING_SUPPORT_EVIDENCE_MISSING'::text;
      END IF;
    END LOOP;
    IF v_bk <= v_eff THEN v_issues := v_issues || 'OPENING_SUPPORT_NOT_RECONCILED'::text; END IF;
    IF v_sum <> (v_f ->> 'preSetupNetMinor')::numeric THEN v_issues := v_issues || ('OPENING_SUPPORT_NOT_RECONCILED:' || (v_sum - (v_f ->> 'preSetupNetMinor')::numeric)::text); END IF;
  END IF;
  SELECT array_agg(DISTINCT x) INTO v_issues FROM unnest(v_issues) x;
  v_issues := COALESCE(v_issues, '{}');
  v_bind := public._fs_fp_binding(p_company_id, p_period_year, 'opening_balances', v_claim, v_per.reporting_start, v_per.reporting_end, v_co.name, v_co.tin, v_fp.facts_sha256);
  SELECT * INTO v_dec FROM public.fs_first_period_decisions d WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.subject = 'opening_balances' AND d.claim_id = v_claim.id ORDER BY d.seq DESC LIMIT 1;
  v_pending := v_issues;
  IF v_dec.id IS NOT NULL AND v_dec.outcome = 'verified' AND (v_dec.bound_sha256 IS DISTINCT FROM v_bind OR v_dec.rule_version IS DISTINCT FROM c_rules) THEN
    v_pending := v_pending || CASE WHEN v_dec.rule_version IS DISTINCT FROM c_rules THEN 'OPENING_SUPPORT_RULES_CHANGED' ELSE 'OPENING_SUPPORT_DECISION_STALE' END;
  ELSIF cardinality(v_issues) = 0 THEN
    IF v_dec.id IS NULL OR v_dec.outcome = 'withdrawn' THEN v_pending := v_pending || 'OPENING_SUPPORT_REVIEW_PENDING'::text;
    ELSIF v_dec.outcome = 'not_verified' THEN v_pending := v_pending || 'OPENING_SUPPORT_REVIEW_REFUSED'::text;
    END IF;
  END IF;
  v_state := CASE WHEN cardinality(v_pending) = 0 THEN 'verified' ELSE 'pending' END;
  RETURN jsonb_build_object('subject', 'opening_balances', 'rules', c_rules, 'state', v_state, 'factIssues', to_jsonb(v_issues), 'pending', to_jsonb(v_pending),
                            'claimId', v_claim.id, 'decisionId', v_dec.id, 'binding', v_bind);
END;
$$;

-- The blockers (text codes) the publication gate adds.
CREATE OR REPLACE FUNCTION public._fs_first_period_pending(p_company_id uuid, p_period_year integer)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(array_agg(x ORDER BY o), '{}') FROM jsonb_array_elements_text(public._fs_first_period_assess(p_company_id, p_period_year) -> 'pending') WITH ORDINALITY t(x, o);
$$;
CREATE OR REPLACE FUNCTION public._fs_opening_pending(p_company_id uuid, p_period_year integer)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(array_agg(x ORDER BY o), '{}') FROM jsonb_array_elements_text(public._fs_opening_assess(p_company_id, p_period_year) -> 'pending') WITH ORDINALITY t(x, o);
$$;

-- ── 6. THE predicate. Same signature, volatility and grants as 20261017100000; the meaning is the repair. ─────────────────
CREATE OR REPLACE FUNCTION public.fs_first_period_declared(p_company_id uuid, p_period_year integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((public._fs_first_period_assess(p_company_id, p_period_year) ->> 'state') = 'verified', false);
$$;

-- ── 7. Writers (each takes the scope lock FIRST, like the sign-off transition) ───────────────────────────────────────────
-- Outcomes: recorded | unchanged | replay | forbidden | feature_disabled | invalid_request | request_reused | no_claim | not_ready |
-- separate_approver_required.
CREATE OR REPLACE FUNCTION public.fs_record_first_period_evidence(p_company_id uuid, p_period_year integer, p_kind text, p_reference text,
  p_issued_on date, p_asserted_date date, p_document_sha256 text, p_note text, p_retract boolean, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_intent text; v_prior public.fs_first_period_evidence; v_last public.fs_first_period_evidence; v_rev integer; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_kind IS NULL OR p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 3 AND 300
     OR p_kind NOT IN ('certificate_of_incorporation', 'certificate_of_registration', 'commencement_resolution', 'regulatory_commencement_notice', 'dormancy_confirmation', 'prior_activity_record', 'pre_setup_activity_support', 'opening_position_support')
     OR p_issued_on IS NULL OR p_document_sha256 IS NULL OR p_document_sha256 !~ '^[0-9a-f]{64}$' OR coalesce(p_retract, false) IS NULL
     OR (NOT coalesce(p_retract, false) AND p_asserted_date IS NULL) OR (p_note IS NOT NULL AND length(p_note) > 500) OR p_period_year NOT BETWEEN 2000 AND 2100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  IF p_issued_on > current_date THEN RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', 'issued_on_in_future'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, p_kind, btrim(p_reference), p_issued_on, p_asserted_date, p_document_sha256, p_note, coalesce(p_retract, false))::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_first_period_evidence e WHERE e.actor_user_id = v_uid AND e.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'evidenceId', v_prior.id, 'revision', v_prior.revision); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_last FROM public.fs_first_period_evidence e
   WHERE e.company_id = p_company_id AND e.period_year = p_period_year AND e.kind = p_kind AND e.reference = btrim(p_reference) ORDER BY e.revision DESC LIMIT 1;
  IF coalesce(p_retract, false) THEN
    IF v_last.id IS NULL OR v_last.retracted THEN RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', 'nothing_to_retract'); END IF;
  ELSIF v_last.id IS NOT NULL AND NOT v_last.retracted AND v_last.document_sha256 = p_document_sha256 AND v_last.asserted_date = p_asserted_date AND v_last.issued_on = p_issued_on THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'evidenceId', v_last.id, 'revision', v_last.revision);
  END IF;
  v_rev := coalesce(v_last.revision, 0) + 1;
  INSERT INTO public.fs_first_period_evidence (company_id, period_year, kind, reference, issued_on, asserted_date, document_sha256, revision, retracted, note, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_kind, btrim(p_reference), p_issued_on, CASE WHEN coalesce(p_retract, false) THEN coalesce(p_asserted_date, v_last.asserted_date) ELSE p_asserted_date END,
          p_document_sha256, v_rev, coalesce(p_retract, false), p_note, p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'evidenceId', v_id, 'revision', v_rev);
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_submit_first_period_claim(p_company_id uuid, p_period_year integer, p_subject text, p_facts jsonb, p_basis text,
  p_evidence_ids uuid[], p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_bad text; v_facts_sha text; v_intent text; v_prior public.fs_first_period_claims; v_id uuid; v_ids uuid[]; v_assess jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_subject IS NULL OR p_subject NOT IN ('first_period', 'opening_balances') OR p_period_year NOT BETWEEN 2000 AND 2100
     OR p_basis IS NULL OR length(btrim(p_basis)) NOT BETWEEN 20 AND 1500 OR p_evidence_ids IS NULL OR cardinality(p_evidence_ids) > 60 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  v_bad := public._fs_fp_validate_facts(p_subject, p_facts);
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', v_bad); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  SELECT coalesce(array_agg(DISTINCT i ORDER BY i), '{}') INTO v_ids FROM unnest(p_evidence_ids) i;
  IF (SELECT count(*) FROM public._fs_fp_current_evidence(p_company_id, p_period_year) e WHERE e.id = ANY (v_ids)) <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('outcome', 'invalid_request', 'detail', 'evidence_not_current');
  END IF;
  v_facts_sha := encode(sha256(convert_to(p_facts::text, 'UTF8')), 'hex');
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, p_subject, v_facts_sha, btrim(p_basis), v_ids)::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_first_period_claims c WHERE c.actor_user_id = v_uid AND c.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'claimId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  INSERT INTO public.fs_first_period_claims (company_id, period_year, subject, facts, facts_sha256, basis_text, evidence_ids, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_subject, p_facts, v_facts_sha, btrim(p_basis), v_ids, p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  v_assess := CASE WHEN p_subject = 'first_period' THEN public._fs_first_period_assess(p_company_id, p_period_year) ELSE public._fs_opening_assess(p_company_id, p_period_year) END;
  RETURN jsonb_build_object('outcome', 'recorded', 'claimId', v_id, 'state', v_assess ->> 'state', 'pending', v_assess -> 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_decide_first_period(p_company_id uuid, p_period_year integer, p_subject text, p_verify boolean, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_claim public.fs_first_period_claims; v_assess jsonb; v_intent text; v_prior public.fs_first_period_decisions; v_last public.fs_first_period_decisions;
  v_outcome text; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_subject IS NULL OR p_subject NOT IN ('first_period', 'opening_balances') OR p_verify IS NULL
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1500 OR p_period_year NOT BETWEEN 2000 AND 2100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'approve_certification') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  SELECT * INTO v_claim FROM public.fs_first_period_claims c WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = p_subject ORDER BY c.seq DESC LIMIT 1;
  IF v_claim.id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_claim'); END IF;
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, p_subject, v_claim.id, p_verify, btrim(p_reason))::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_first_period_decisions d WHERE d.actor_user_id = v_uid AND d.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'decisionId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  IF v_claim.actor_user_id = v_uid THEN RETURN jsonb_build_object('outcome', 'separate_approver_required'); END IF;
  v_assess := CASE WHEN p_subject = 'first_period' THEN public._fs_first_period_assess(p_company_id, p_period_year) ELSE public._fs_opening_assess(p_company_id, p_period_year) END;
  IF p_verify AND jsonb_array_length(v_assess -> 'factIssues') > 0 THEN
    RETURN jsonb_build_object('outcome', 'not_ready', 'pending', v_assess -> 'factIssues');
  END IF;
  v_outcome := CASE WHEN p_verify THEN 'verified' ELSE 'not_verified' END;
  SELECT * INTO v_last FROM public.fs_first_period_decisions d WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.subject = p_subject AND d.claim_id = v_claim.id ORDER BY d.seq DESC LIMIT 1;
  IF v_last.id IS NOT NULL AND v_last.outcome = v_outcome AND v_last.bound_sha256 IS NOT DISTINCT FROM (CASE WHEN p_verify THEN v_assess ->> 'binding' END) THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'decisionId', v_last.id);
  END IF;
  INSERT INTO public.fs_first_period_decisions (company_id, period_year, subject, claim_id, outcome, rule_version, bound_sha256, reason, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_subject, v_claim.id, v_outcome, v_assess ->> 'rules', CASE WHEN p_verify THEN v_assess ->> 'binding' END, btrim(p_reason),
          p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'decisionId', v_id, 'verified', p_verify);
END;
$$;

CREATE OR REPLACE FUNCTION public.fs_withdraw_first_period(p_company_id uuid, p_period_year integer, p_subject text, p_reason text, p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_claim public.fs_first_period_claims; v_last public.fs_first_period_decisions; v_intent text; v_prior public.fs_first_period_decisions; v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_request_id IS NULL OR p_subject IS NULL OR p_subject NOT IN ('first_period', 'opening_balances')
     OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 1500 OR p_period_year NOT BETWEEN 2000 AND 2100 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'approve_certification') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM public._fs_scope_lock(p_company_id, p_period_year);
  SELECT * INTO v_claim FROM public.fs_first_period_claims c WHERE c.company_id = p_company_id AND c.period_year = p_period_year AND c.subject = p_subject ORDER BY c.seq DESC LIMIT 1;
  IF v_claim.id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_claim'); END IF;
  v_intent := encode(sha256(convert_to(jsonb_build_array(p_company_id, p_period_year, p_subject, v_claim.id, 'withdrawn', btrim(p_reason))::text, 'UTF8')), 'hex');
  SELECT * INTO v_prior FROM public.fs_first_period_decisions d WHERE d.actor_user_id = v_uid AND d.request_id = p_request_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.intent_sha256 = v_intent THEN RETURN jsonb_build_object('outcome', 'replay', 'decisionId', v_prior.id); END IF;
    RETURN jsonb_build_object('outcome', 'request_reused');
  END IF;
  SELECT * INTO v_last FROM public.fs_first_period_decisions d WHERE d.company_id = p_company_id AND d.period_year = p_period_year AND d.subject = p_subject AND d.claim_id = v_claim.id ORDER BY d.seq DESC LIMIT 1;
  IF v_last.id IS NULL OR v_last.outcome = 'withdrawn' THEN RETURN jsonb_build_object('outcome', 'unchanged'); END IF;
  INSERT INTO public.fs_first_period_decisions (company_id, period_year, subject, claim_id, outcome, rule_version, bound_sha256, reason, request_id, intent_sha256, actor_user_id, firm_member_id)
  VALUES (p_company_id, p_period_year, p_subject, v_claim.id, 'withdrawn', CASE WHEN p_subject = 'first_period' THEN 'first-period-rules/1' ELSE 'opening-balance-rules/1' END, NULL, btrim(p_reason),
          p_request_id, v_intent, v_uid, public._cr_member(p_company_id, v_uid)) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'decisionId', v_id);
END;
$$;

-- The read model of the page: both subjects, each pending item with its one next action, and the legacy declaration.
CREATE OR REPLACE FUNCTION public.fs_first_period_status(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_fp jsonb; v_op jsonb; v_leg record;
BEGIN
  IF NOT public.close_review_readable(p_company_id) THEN RETURN jsonb_build_object('state', 'unavailable'); END IF;
  v_fp := public._fs_first_period_assess(p_company_id, p_period_year);
  v_op := public._fs_opening_assess(p_company_id, p_period_year);
  SELECT d.action, d.evidence_kind, d.evidence_ref, d.evidence_date, d.created_at INTO v_leg FROM public.fs_first_period_declarations d
   WHERE d.company_id = p_company_id AND d.period_year = p_period_year ORDER BY d.seq DESC LIMIT 1;
  RETURN jsonb_build_object('state', 'evaluated', 'periodYear', p_period_year,
    'firstPeriod', v_fp - 'binding' || jsonb_build_object('items', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', split_part(x, ':', 1), 'detail', nullif(substr(x, length(split_part(x, ':', 1)) + 2), ''), 'nextAction', public._fs_fp_next_action(x)) ORDER BY o)
                                                                        FROM jsonb_array_elements_text(v_fp -> 'pending') WITH ORDINALITY t(x, o)), '[]'::jsonb)),
    'openingBalances', v_op - 'binding' || jsonb_build_object('items', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', split_part(x, ':', 1), 'detail', nullif(substr(x, length(split_part(x, ':', 1)) + 2), ''), 'nextAction', public._fs_fp_next_action(x)) ORDER BY o)
                                                                           FROM jsonb_array_elements_text(v_op -> 'pending') WITH ORDINALITY t(x, o)), '[]'::jsonb)),
    'legacyDeclaration', CASE WHEN v_leg.action IS NULL THEN NULL ELSE jsonb_build_object('action', v_leg.action, 'evidenceKind', v_leg.evidence_kind, 'evidenceRef', v_leg.evidence_ref,
                          'evidenceDate', v_leg.evidence_date, 'recordedAt', v_leg.created_at, 'satisfiesRequirement', false) END);
END;
$$;

-- ── 8. Splice the first-period calls into fs_publication_blockers (the live text is the base; asserted, not copied) ───────────
DO $splice$
DECLARE
  v_def text;
  v_new text;
  c_anchor constant text := E'    IF v_req.comparatives_required AND NOT v_comp_any AND NOT public.fs_first_period_declared(p_company_id, v_report.period_year) THEN\n      v_out := array_append(v_out, ''COMPARATIVE_PERIOD_MISSING'');\n    END IF;';
  c_repl   constant text := E'    IF v_req.comparatives_required AND NOT v_comp_any AND NOT public.fs_first_period_declared(p_company_id, v_report.period_year) THEN\n      v_out := array_append(v_out, ''COMPARATIVE_PERIOD_MISSING'');\n      -- [20261217100000] Why the first-period exception is not in force: each unresolved item by name (never a silent default).\n      v_out := v_out || public._fs_first_period_pending(p_company_id, v_report.period_year);\n    END IF;\n    -- [20261217100000] A verified first period addresses the COMPARATIVES only: while it is the comparative requirement''s basis, the opening balances need their own verified support.\n    IF v_req.comparatives_required AND NOT v_comp_any AND public.fs_first_period_declared(p_company_id, v_report.period_year) THEN\n      v_out := v_out || public._fs_opening_pending(p_company_id, v_report.period_year);\n    END IF;';
BEGIN
  v_def := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the comparative-requirement block is not present exactly once' USING ERRCODE = 'P0001';
  END IF;
  v_new := replace(v_def, c_anchor, c_repl);
  EXECUTE v_new;
END;
$splice$;

-- ── 9. Access ──────────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.fs_first_period_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_first_period_claims    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fs_first_period_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fs_first_period_evidence, public.fs_first_period_claims, public.fs_first_period_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.fs_first_period_evidence, public.fs_first_period_claims, public.fs_first_period_decisions TO authenticated, service_role;
CREATE POLICY fpe_read  ON public.fs_first_period_evidence  FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fpc_read  ON public.fs_first_period_claims    FOR SELECT TO authenticated USING (public.close_review_readable(company_id));
CREATE POLICY fpd2_read ON public.fs_first_period_decisions FOR SELECT TO authenticated USING (public.close_review_readable(company_id));

REVOKE ALL ON FUNCTION public._fs_fp_next_action(text), public._fs_fp_norm(text), public._fs_fp_period(uuid, integer), public._fs_fp_current_evidence(uuid, integer),
  public._fs_fp_evidence_set_sha(uuid, integer, text), public._fs_fp_is_date(text), public._fs_fp_validate_facts(text, jsonb),
  public._fs_first_period_assess(uuid, integer), public._fs_opening_assess(uuid, integer), public._fs_first_period_pending(uuid, integer), public._fs_opening_pending(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._fs_fp_binding(uuid, integer, text, public.fs_first_period_claims, date, date, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_first_period_declared(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_first_period_declared(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fs_record_first_period_evidence(uuid, integer, text, text, date, date, text, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_record_first_period_evidence(uuid, integer, text, text, date, date, text, text, boolean, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_submit_first_period_claim(uuid, integer, text, jsonb, text, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_submit_first_period_claim(uuid, integer, text, jsonb, text, uuid[], uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_withdraw_first_period(uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_withdraw_first_period(uuid, integer, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_first_period_status(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fs_first_period_status(uuid, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.fs_publication_blockers(uuid, text, integer) FROM PUBLIC, anon, authenticated;

DO $postcondition$
DECLARE
  v_def text := pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure);
BEGIN
  IF position('_fs_first_period_pending' IN v_def) = 0 OR position('_fs_opening_pending' IN v_def) = 0
     OR position('fs_server_compilation_blocker' IN v_def) = 0 OR position('_rfr_blockers' IN v_def) = 0
     OR position('_fs_document_structure_blockers' IN v_def) = 0 OR position('DOCUMENT_FACT_NOT_COMPOSED' IN v_def) = 0
     OR position('ACCOUNT_CAPACITY_EXCEEDED' IN v_def) = 0 OR position('REVIEW_COMMENT_UNRESOLVED' IN v_def) = 0
     OR has_function_privilege('authenticated', 'public.fs_publication_blockers(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._fs_first_period_assess(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fs_decide_first_period(uuid, integer, text, boolean, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fs_first_period_declared(uuid, integer)', 'EXECUTE')
     OR position('_fs_first_period_assess' IN pg_get_functiondef('public.fs_first_period_declared(uuid, integer)'::regprocedure)) = 0
     OR (SELECT count(*) FROM public.fs_first_period_claims) <> 0 OR (SELECT count(*) FROM public.fs_first_period_decisions) <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION_FAILED: the first-period governed review is not in the expected state' USING ERRCODE = 'P0001';
  END IF;
END;
$postcondition$;
