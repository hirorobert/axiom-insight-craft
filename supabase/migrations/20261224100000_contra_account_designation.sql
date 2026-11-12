-- 20261224100000_contra_account_designation.sql
--
-- S2-A05 (second-pass hostile validation, 2026-11-11): a reviewed contra-account designation, so that Close Review check A01
-- tests the side a reviewer said the account belongs on. Forward-only; PENDING HOSTED APPLICATION (no hosted journal number,
-- hash or applied timestamp is stated anywhere until a hosted read confirms it).
--
-- The defect. A01 (20261014100000) raised every account whose class-side balance is negative (class_side_minor < 0). A
-- correctly signed contra account — accumulated depreciation or an allowance for doubtful debts, a credit inside an asset
-- class — was therefore always raised as a sign error, while a contra account carrying the WRONG sign (accumulated
-- depreciation in debit, which composes as a positive asset) raised nothing. No reviewed fact said an account is a contra
-- account; the repair adds that fact and changes nothing else.
--
-- Framework note: this changes a review check, not recognition, measurement or presentation. IFRS for SMEs (2015 edition)
-- para 2.52 treats measuring assets net of valuation allowances (e.g. allowances for doubtful debts) as not offsetting —
-- citation unverified (the standard's text is not in this repository).
--
-- 1. account_mappings.is_contra_account boolean NULL — tri-state exactly like is_cash_account / is_retained_earnings /
--    is_payroll_account (20260904120000): NULL = not reviewed, TRUE = reviewed as a contra account (it reduces its class, so
--    its expected balance is opposite to the class's normal side), FALSE = reviewed as not a contra account. Added NULL with
--    no default: every existing mapping reads NULL and nothing is back-filled. Written only by resolve_account_review_batch
--    (client INSERT/UPDATE on account_mappings stay revoked since 20261006100000; the column gets no client grant).
-- 2. The reviewed content of a mapping (account_mapping_content / account_review_decision_content, S1 provenance) gains the
--    eighth field. A decision recorded before this migration carries seven fields and is read as NOT reviewing the
--    designation (NULL), which is exactly what an existing mapping holds — so every existing review link stays valid. The
--    seven-argument account_mapping_content is kept (same signature) and answers the eight-field content with NULL.
-- 3. resolve_account_review_batch (re-created from 20261007100000 with only the marked S2-A05 changes): a decision that
--    carries is_contra_account sets it; a decision that does not carry it keeps the mapping's existing value (NULL when there
--    is none) — the Phase 6 preservation rule, never a manufactured false. Replay identity: a request element WITHOUT the key
--    hashes byte for byte as before; an element WITH it also hashes '::contra:' and its value, so the same request id with a
--    different designation is refused (IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD) instead of replayed. Signature,
--    SECURITY DEFINER, search_path, authorization, the per-account advisory locks (company × account key, taken in sorted
--    order) and every result field are unchanged.
-- 4. close_review_refresh_findings (re-created from 20261014100000 with only the A01 branch changed): an account designated
--    contra (TRUE) is raised when its class-side balance carries the class's NORMAL sign (class_side_minor > 0 — the flipped
--    contra) and not when it is on the opposite side (<= 0); its finding records detail {"contraAccount": true}. FALSE and
--    NULL are tested exactly as before (class_side_minor < 0, the closing-stock treatment exception, detail {}), so an
--    unreviewed contra account keeps prompting review. A03, A10, T01, the run key, the catalogue version
--    (tb-anomaly-catalogue/1), rule_version 1 and the advisory lock are unchanged.
--
-- Not changed: composition, presentation and the reporting input (fs_reporting_input carries no new field: adding one would
-- change every stored server-compilation snapshot). Existing findings runs stay current: for NULL — every existing mapping —
-- A01 is byte-identical, and a designation is recorded through a review decision, which bumps the account's dependency
-- revision (20261008100000), so the trial balance is checked again (a new certification) before any run can use it.
--
-- PREFLIGHT: the column does not exist yet; the migration refuses if it does.

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.account_mappings'::regclass AND attname = 'is_contra_account' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: account_mappings.is_contra_account already exists; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure('public.resolve_account_review_batch(uuid, uuid, uuid, jsonb)') IS NULL
     OR to_regprocedure('public.close_review_refresh_findings(uuid, integer)') IS NULL
     OR to_regprocedure('public.account_mapping_content(public.financial_statement, public.account_classification, text, text, boolean, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the account review or close review functions are missing; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
END;
$preflight$;

-- ── 1. The reviewed designation ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_mappings ADD COLUMN is_contra_account boolean NULL;
COMMENT ON COLUMN public.account_mappings.is_contra_account IS
  'Reviewed contra-account designation (S2-A05). NULL = not reviewed; TRUE = a contra account (expected balance opposite to its class); FALSE = not a contra account. Written only by resolve_account_review_batch.';
-- A column-level grant survives a table-level REVOKE; none is created for a client role (belt and braces).
REVOKE INSERT (is_contra_account), UPDATE (is_contra_account) ON TABLE public.account_mappings FROM PUBLIC, anon, authenticated;

-- ── 2. The complete reviewed content: eight fields ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.account_mapping_content(
  p_statement public.financial_statement, p_classification public.account_classification, p_line_item text,
  p_normal_balance text, p_is_cash boolean, p_is_retained boolean, p_is_payroll boolean, p_is_contra boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'statement', p_statement::text, 'classification', p_classification::text, 'line_item', p_line_item,
    'normal_balance', p_normal_balance, 'is_cash_account', p_is_cash, 'is_retained_earnings', p_is_retained,
    'is_payroll_account', p_is_payroll, 'is_contra_account', p_is_contra);
$$;

-- The seven-argument form (unchanged signature): the same content with the designation not reviewed (NULL).
CREATE OR REPLACE FUNCTION public.account_mapping_content(
  p_statement public.financial_statement, p_classification public.account_classification, p_line_item text,
  p_normal_balance text, p_is_cash boolean, p_is_retained boolean, p_is_payroll boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT public.account_mapping_content(p_statement, p_classification, p_line_item, p_normal_balance, p_is_cash, p_is_retained, p_is_payroll, NULL::boolean);
$$;

-- A decision's reviewed content. A decision recorded before 20261224100000 did not review the designation: NULL.
CREATE OR REPLACE FUNCTION public.account_review_decision_content(p_new_value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_new_value IS NULL OR jsonb_typeof(p_new_value) <> 'object' THEN NULL
    WHEN jsonb_typeof(p_new_value->'mapping') = 'object'
      THEN (p_new_value->'mapping') || jsonb_build_object('is_contra_account', p_new_value->'mapping'->'is_contra_account')
    ELSE jsonb_build_object(
      'statement',            p_new_value->>'statement',
      'classification',       p_new_value->>'classification',
      'line_item',            COALESCE(p_new_value->>'line_item', p_new_value->>'account_name'),
      'normal_balance',       p_new_value->>'normal_balance',
      'is_cash_account',      CASE lower(p_new_value->>'is_cash_account') WHEN 'true' THEN true WHEN 'false' THEN false END,
      'is_retained_earnings', CASE lower(p_new_value->>'is_retained_earnings') WHEN 'true' THEN true WHEN 'false' THEN false END,
      'is_payroll_account',   CASE lower(p_new_value->>'is_payroll_account') WHEN 'true' THEN true WHEN 'false' THEN false END,
      'is_contra_account',    CASE lower(p_new_value->>'is_contra_account') WHEN 'true' THEN true WHEN 'false' THEN false END)
  END;
$$;

-- The S1 provenance guard (20261006100000), re-created with the eight-field content (S2-A05: NEW/OLD.is_contra_account).
CREATE OR REPLACE FUNCTION public.account_mappings_provenance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_decision public.account_review_decisions%ROWTYPE;
  v_content jsonb := public.account_mapping_content(NEW.statement, NEW.classification, NEW.line_item, NEW.normal_balance,
                                                    NEW.is_cash_account, NEW.is_retained_earnings, NEW.is_payroll_account,
                                                    NEW.is_contra_account); -- S2-A05
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.review_decision_id IS NOT DISTINCT FROM OLD.review_decision_id THEN
    -- No new decision accompanies this change: a content, company or key change ends the provenance.
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR COALESCE(NEW.account_code, NEW.normalized_account_name) IS DISTINCT FROM COALESCE(OLD.account_code, OLD.normalized_account_name)
       OR v_content IS DISTINCT FROM public.account_mapping_content(OLD.statement, OLD.classification, OLD.line_item, OLD.normal_balance,
                                                                    OLD.is_cash_account, OLD.is_retained_earnings, OLD.is_payroll_account,
                                                                    OLD.is_contra_account) THEN -- S2-A05
      NEW.review_decision_id := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.review_decision_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_decision FROM public.account_review_decisions d WHERE d.id = NEW.review_decision_id;
  IF v_decision.id IS NULL
     OR NEW.company_id IS NULL OR v_decision.company_id IS DISTINCT FROM NEW.company_id
     OR v_decision.review_account_key IS DISTINCT FROM COALESCE(NEW.account_code, NEW.normalized_account_name)
     OR v_decision.decision_action NOT IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION')
     OR public.account_review_decision_content(v_decision.new_value) IS DISTINCT FROM v_content THEN
    RAISE EXCEPTION 'MAPPING_PROVENANCE_MISMATCH: decision % does not review this mapping''s company, account and complete content', NEW.review_decision_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. resolve_account_review_batch: 20261007100000 + the designation (marked S2-A05) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(p_company_id uuid, p_upload_id uuid, p_client_request_id uuid, p_decisions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_id            UUID := auth.uid();
  v_firm_member_id     UUID;
  v_role               TEXT;
  v_upload_company_id  UUID;
  v_request_hash       TEXT;
  v_existing_batch      RECORD;
  v_batch_id           UUID;
  v_result             JSONB;
  v_decision           JSONB;
  v_sorted_keys        TEXT[];
  v_key                TEXT;
  v_code               TEXT;
  v_norm_name          TEXT;
  v_review_key         TEXT;
  v_proposal_type      TEXT;
  v_decision_action    TEXT;
  v_previous           JSONB;
  v_statement          TEXT;
  v_classification     TEXT;
  v_content            JSONB;
  v_decision_id        UUID;
  v_mappings_written   INTEGER := 0;
  v_decisions_logged   INTEGER := 0;
  v_non_reporting_count INTEGER := 0;
  v_seen_keys          TEXT[] := ARRAY[]::TEXT[];
  v_upload_result      JSONB;
  v_upload_hash        TEXT;
  v_req                JSONB;
  v_treatments_recorded INTEGER := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT fm.id, fm.role
    INTO v_firm_member_id, v_role
    FROM public.firm_members fm
   WHERE fm.user_id     = v_user_id
     AND fm.company_id  = p_company_id
     AND fm.accepted_at IS NOT NULL
     AND public.named_user_access_active(fm.company_id, fm.user_id)
   LIMIT 1;

  IF v_firm_member_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;

  IF NOT public.workspace_capability_allowed(p_company_id, v_user_id, 'prepare_close') THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
  END IF;

  -- H1b: the upload's server-owned result and source hash, for treatment confirmations (read without a lock: the review
  -- path takes key locks first; the engine re-validates every treatment against current facts when it uses one).
  SELECT tbu.company_id, tbu.processing_result, tbu.source_file_hash INTO v_upload_company_id, v_upload_result, v_upload_hash
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  -- Replay identity: byte-identical to 20261003100000 for every element without is_contra_account (a retry of an earlier
  -- request still replays); S2-A05 appends the designation only for an element that carries it.
  v_request_hash := encode(
    extensions.digest(
      p_company_id::TEXT || '|' || p_upload_id::TEXT || '|' ||
      (
        SELECT string_agg(
                 coalesce(elem->>'account_code','') || '::' ||
                 coalesce(elem->>'account_name','') || '::' ||
                 coalesce(elem->>'proposal_type','NONE') || '::' ||
                 coalesce(elem->>'decision_action','') || '::' ||
                 coalesce(elem->>'statement','') || '::' ||
                 coalesce(elem->>'classification','') || '::' ||
                 coalesce(elem->>'line_item','') || '::' ||
                 coalesce(elem->>'normal_balance','') || '::' ||
                 coalesce(elem->>'reason','') || '::' ||
                 coalesce(elem->>'is_cash_account','~') || '::' ||
                 coalesce(elem->>'is_retained_earnings','~') || '::' ||
                 coalesce(elem->>'is_payroll_account','~') ||
                 CASE WHEN elem->>'decision_action' = 'CONFIRM_ACCOUNT_TREATMENT'
                      THEN '::' || coalesce(elem->>'treatment_request_id','') || '::' || coalesce(elem->>'treatment','')
                      ELSE '' END ||
                 -- S2-A05: only an element that carries the designation hashes it (every earlier request hashes as before).
                 CASE WHEN elem ? 'is_contra_account'
                      THEN '::contra:' || coalesce(elem->>'is_contra_account','~')
                      ELSE '' END,
                 '|' ORDER BY
                   coalesce(elem->>'account_code', elem->>'account_name')
               )
          FROM jsonb_array_elements(p_decisions) elem
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT * INTO v_existing_batch
    FROM public.account_review_batches
   WHERE upload_id = p_upload_id
     AND firm_member_id = v_firm_member_id
     AND client_request_id = p_client_request_id
   LIMIT 1;

  IF FOUND THEN
    IF v_existing_batch.request_hash = v_request_hash THEN
      RETURN v_existing_batch.result_summary;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE = '22023';
    END IF;
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');
    IF v_proposal_type = 'AUTO_MAPPED_RULE' THEN
      RAISE EXCEPTION 'AUTO_MAPPED_RULE_NOT_AUTHORIZED_IN_PHASE_2A' USING ERRCODE = '42501';
    END IF;

    v_decision_action := v_decision->>'decision_action';
    IF v_decision_action IS NULL OR v_decision_action NOT IN
       ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT', 'CONFIRM_ACCOUNT_TREATMENT') THEN
      RAISE EXCEPTION 'INVALID_DECISION_ACTION: %', coalesce(v_decision_action, 'NULL') USING ERRCODE = '22023';
    END IF;

    -- H1b: a treatment confirmation keeps the account as mapped. It names the engine's treatment request and states why.
    IF v_decision_action = 'CONFIRM_ACCOUNT_TREATMENT' THEN
      IF v_decision->>'treatment' IS DISTINCT FROM 'keep_as_mapped' THEN
        RAISE EXCEPTION 'UNSUPPORTED_TREATMENT: %', coalesce(v_decision->>'treatment', 'NULL') USING ERRCODE = '22023';
      END IF;
      IF coalesce(v_decision->>'treatment_request_id', '') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_ID_REQUIRED' USING ERRCODE = '22023';
      END IF;
      IF length(btrim(coalesce(v_decision->>'reason', ''))) NOT BETWEEN 3 AND 500 THEN
        RAISE EXCEPTION 'TREATMENT_REASON_REQUIRED' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- S1: only the supported statement/class pairs are accepted. Cash-flow lines are derived, never mapped.
    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      v_statement := v_decision->>'statement';
      v_classification := v_decision->>'classification';
      IF v_statement = 'cash_flow'
         OR v_classification IN ('operating_activities', 'investing_activities', 'financing_activities') THEN
        RAISE EXCEPTION 'UNSUPPORTED_CASH_FLOW_CLASSIFICATION: %', coalesce(v_classification, v_statement) USING ERRCODE = '22023';
      END IF;
      -- COALESCE: a missing statement or class is a mismatch, never an unknown that slips through.
      IF NOT COALESCE((v_statement = 'balance_sheet' AND v_classification IN
                 ('current_assets', 'non_current_assets', 'current_liabilities', 'non_current_liabilities', 'equity'))
           OR (v_statement = 'income_statement' AND v_classification IN
                 ('revenue', 'cost_of_goods_sold', 'operating_expenses', 'other_income', 'taxes')), false) THEN
        RAISE EXCEPTION 'STATEMENT_CLASSIFICATION_MISMATCH: % / %', coalesce(v_statement, 'NULL'), coalesce(v_classification, 'NULL')
          USING ERRCODE = '22023';
      END IF;
    END IF;

    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);

    IF v_review_key = '' THEN
      RAISE EXCEPTION 'ACCOUNT_IDENTITY_UNRESOLVABLE' USING ERRCODE = '22023';
    END IF;

    IF v_review_key = ANY(v_seen_keys) THEN
      RAISE EXCEPTION 'DUPLICATE_ACCOUNT_IN_BATCH: %', v_review_key USING ERRCODE = '22023';
    END IF;
    v_seen_keys := v_seen_keys || v_review_key;
  END LOOP;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_sorted_keys
    FROM unnest(v_seen_keys) AS k;

  FOREACH v_key IN ARRAY v_sorted_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::TEXT), hashtext(v_key));
  END LOOP;

  INSERT INTO public.account_review_batches (
    id, client_request_id, request_hash, company_id, upload_id, firm_member_id, result_summary
  ) VALUES (
    gen_random_uuid(), p_client_request_id, v_request_hash, p_company_id, p_upload_id, v_firm_member_id, '{}'::jsonb
  ) RETURNING id INTO v_batch_id;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_code := NULLIF(trim(coalesce(v_decision->>'account_code', '')), '');
    v_norm_name := lower(trim(regexp_replace(regexp_replace(
                     coalesce(v_decision->>'account_name', ''), '[[:punct:]]', '', 'g'),
                     '\s+', ' ', 'g')));
    v_review_key := COALESCE(v_code, v_norm_name);
    v_decision_action := v_decision->>'decision_action';
    v_proposal_type := coalesce(v_decision->>'proposal_type', 'NONE');

    SELECT to_jsonb(am.*) INTO v_previous
      FROM public.account_mappings am
     WHERE am.company_id = p_company_id
       AND am.account_key = v_review_key
     LIMIT 1;

    IF v_decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION') THEN
      -- The complete content this decision makes current: line_item defaults to the account name; a flag the
      -- decision does not carry keeps the existing mapping's value (NULL when there is none) — as before S1.
      v_content := public.account_mapping_content(
        (v_decision->>'statement')::public.financial_statement,
        (v_decision->>'classification')::public.account_classification,
        coalesce(v_decision->>'line_item', v_decision->>'account_name'),
        v_decision->>'normal_balance',
        CASE WHEN v_decision ? 'is_cash_account' THEN (v_decision->>'is_cash_account')::boolean
             ELSE (v_previous->>'is_cash_account')::boolean END,
        CASE WHEN v_decision ? 'is_retained_earnings' THEN (v_decision->>'is_retained_earnings')::boolean
             ELSE (v_previous->>'is_retained_earnings')::boolean END,
        CASE WHEN v_decision ? 'is_payroll_account' THEN (v_decision->>'is_payroll_account')::boolean
             ELSE (v_previous->>'is_payroll_account')::boolean END,
        -- S2-A05: the contra designation, under the same rule (not carried → the mapping's existing value).
        CASE WHEN v_decision ? 'is_contra_account' THEN (v_decision->>'is_contra_account')::boolean
             ELSE (v_previous->>'is_contra_account')::boolean END);

      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous,
        (v_decision - 'mapping') || jsonb_build_object('mapping', v_content),
        v_decision->>'source', v_decision->>'reason'
      ) RETURNING id INTO v_decision_id;

      INSERT INTO public.account_mappings (
        user_id, company_id, account_code, account_name, normalized_account_name,
        statement, classification, line_item, normal_balance,
        is_cash_account, is_retained_earnings, is_payroll_account, is_contra_account,
        confidence_source, approved_at, review_decision_id
      ) VALUES (
        v_user_id, p_company_id, v_code, v_decision->>'account_name', v_norm_name,
        (v_content->>'statement')::public.financial_statement,
        (v_content->>'classification')::public.account_classification,
        v_content->>'line_item',
        v_content->>'normal_balance',
        (v_content->>'is_cash_account')::boolean,
        (v_content->>'is_retained_earnings')::boolean,
        (v_content->>'is_payroll_account')::boolean,
        (v_content->>'is_contra_account')::boolean,
        'user_approved', now(), v_decision_id
      )
      ON CONFLICT (company_id, account_key) DO UPDATE SET
        account_code             = EXCLUDED.account_code,
        account_name             = EXCLUDED.account_name,
        normalized_account_name  = EXCLUDED.normalized_account_name,
        statement                = EXCLUDED.statement,
        classification           = EXCLUDED.classification,
        line_item                = EXCLUDED.line_item,
        normal_balance           = EXCLUDED.normal_balance,
        is_cash_account          = EXCLUDED.is_cash_account,
        is_retained_earnings     = EXCLUDED.is_retained_earnings,
        is_payroll_account       = EXCLUDED.is_payroll_account,
        is_contra_account        = EXCLUDED.is_contra_account,
        confidence_source        = 'user_approved',
        approved_at              = now(),
        review_decision_id       = EXCLUDED.review_decision_id,
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

    ELSIF v_decision_action = 'CONFIRM_ACCOUNT_TREATMENT' THEN
      -- The request must be one the engine emitted for THIS upload's current result, for this account, against this
      -- upload's current source bytes and the mapping's current review decision; its id must recompute exactly.
      SELECT r INTO v_req
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_upload_result->'treatment_requests') = 'array'
                                       THEN v_upload_result->'treatment_requests' ELSE '[]'::jsonb END) r
       WHERE r->>'request_id' = v_decision->>'treatment_request_id'
       LIMIT 1;
      IF v_req IS NULL THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_NOT_FOUND' USING ERRCODE = '22023';
      END IF;
      IF v_req->>'company_id' IS DISTINCT FROM p_company_id::text OR v_req->>'upload_id' IS DISTINCT FROM p_upload_id::text
         OR v_req->>'source_file_hash' IS DISTINCT FROM v_upload_hash OR v_req->>'account_key' IS DISTINCT FROM v_review_key THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_MISMATCH' USING ERRCODE = '22023';
      END IF;
      IF public.treatment_request_id(v_req) IS DISTINCT FROM v_req->>'request_id' THEN
        RAISE EXCEPTION 'TREATMENT_REQUEST_INVALID' USING ERRCODE = '22023';
      END IF;
      IF v_previous IS NULL OR (v_previous->>'review_decision_id') IS DISTINCT FROM v_req->>'mapping_decision_id' THEN
        RAISE EXCEPTION 'TREATMENT_MAPPING_CHANGED' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous,
        jsonb_build_object('treatment', 'keep_as_mapped', 'reason', btrim(v_decision->>'reason'),
                           'request_id', v_req->>'request_id', 'request', v_req),
        v_decision->>'source', v_decision->>'reason'
      );
      v_treatments_recorded := v_treatments_recorded + 1;

    ELSIF v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN
      DELETE FROM public.account_mappings
       WHERE company_id = p_company_id
         AND account_key = v_review_key;
      v_non_reporting_count := v_non_reporting_count + 1;

      INSERT INTO public.account_review_decisions (
        batch_id, company_id, upload_id, firm_member_id,
        account_code, normalized_account_name, review_account_key,
        proposal_type, decision_action, previous_value, new_value, source, reason
      ) VALUES (
        v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
        v_code, v_norm_name, v_review_key,
        v_proposal_type, v_decision_action, v_previous, NULL,
        v_decision->>'source', v_decision->>'reason'
      );
    END IF;
    v_decisions_logged := v_decisions_logged + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'batch_id', v_batch_id,
    'mappings_written', v_mappings_written,
    'decisions_logged', v_decisions_logged,
    'non_reporting_decisions_recorded', v_non_reporting_count,
    'treatments_recorded', v_treatments_recorded
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.resolve_account_review_batch(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_account_review_batch(uuid, uuid, uuid, jsonb) TO authenticated;

-- ── 4. close_review_refresh_findings: 20261014100000 with A01 testing the reviewed expected side (marked S2-A05) ─────
CREATE OR REPLACE FUNCTION public.close_review_refresh_findings(p_company_id uuid, p_period_year integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cert public.tb_certifications%ROWTYPE;
  v_prior public.tb_certifications%ROWTYPE;
  v_upload public.trial_balance_uploads%ROWTYPE;
  v_run public.close_review_finding_runs%ROWTYPE;
  v_currency text;
  v_exponent integer;
  v_treated text[];
  v_status jsonb;
  v_member uuid;
  v_n integer;
  v_scope text;
  v_t01 boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000'; END IF;
  IF p_company_id IS NULL OR p_period_year IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid_request'); END IF;
  IF NOT public.workspace_capability_allowed(p_company_id, v_uid, 'prepare_close') THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  IF NOT public.fs_rollout_allows(p_company_id) THEN RETURN jsonb_build_object('outcome', 'feature_disabled'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('close_review_findings:' || p_company_id::text || ':' || p_period_year::text, 0));

  SELECT * INTO v_cert FROM public.get_authoritative_certification(p_company_id, p_period_year);
  IF v_cert.id IS NULL THEN RETURN jsonb_build_object('outcome', 'no_authority'); END IF;
  SELECT * INTO v_prior FROM public.get_authoritative_certification(p_company_id, p_period_year - 1);
  v_scope := public._cr_scope_key(p_company_id);
  v_t01 := v_scope = 'T01=on';
  SELECT * INTO v_run FROM public.close_review_finding_runs r WHERE r.id = public._cr_current_run(p_company_id, p_period_year);
  IF v_run.id IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'unchanged', 'runId', v_run.id); END IF;

  IF EXISTS (SELECT 1 FROM public._cr_certified_accounts(v_cert.id) a WHERE NOT a.exact) THEN
    RETURN jsonb_build_object('outcome', 'legacy_certification');
  END IF;
  SELECT * INTO v_upload FROM public.trial_balance_uploads t WHERE t.id = v_cert.upload_id;
  SELECT p.reporting_currency INTO v_currency FROM public.fiscal_periods p WHERE p.id = v_upload.period_id AND p.company_id = p_company_id;
  SELECT cr.exponent INTO v_exponent FROM public.currency_registry cr WHERE cr.code = v_currency;
  IF v_currency IS NULL OR v_exponent IS NULL THEN RETURN jsonb_build_object('outcome', 'currency_unknown'); END IF;

  -- Closing-stock credits a reviewer confirmed as kept (H1b): their account keys.
  SELECT COALESCE(array_agg(DISTINCT req->>'account_key'), '{}') INTO v_treated
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_upload.processing_result->'treatment_requests') = 'array'
                                   THEN v_upload.processing_result->'treatment_requests' ELSE '[]'::jsonb END) req
   WHERE req->>'request_id' IN (SELECT t.request_id FROM public.get_confirmed_treatments(p_company_id,
           ARRAY(SELECT x->>'request_id' FROM jsonb_array_elements(v_upload.processing_result->'treatment_requests') x)) t);

  v_status := jsonb_build_object(
    'A01', jsonb_build_object('kind', 'risk_indicator', 'status', 'evaluated', 'evaluated', true),
    'A02', jsonb_build_object('kind', 'risk_indicator', 'status', 'not_evaluated', 'evaluated', false, 'reason', 'No authoritative suspense or clearing designation exists for accounts.'),
    'A03', jsonb_build_object('kind', 'deterministic_error', 'status', 'evaluated', 'evaluated', true),
    'A04', jsonb_build_object('kind', 'deterministic_error', 'status', 'not_evaluated', 'evaluated', false, 'reason', CASE WHEN v_prior.id IS NULL
      THEN 'No authoritative prior-year trial balance.'
      ELSE 'Needs the framework pack''s trial-balance basis (before or after closing entries).' END),
    'A05', jsonb_build_object('kind', 'risk_indicator', 'status', 'not_evaluated', 'evaluated', false, 'reason', 'Needs the framework pack''s materiality threshold.'),
    'A06', jsonb_build_object('kind', 'risk_indicator', 'status', 'not_evaluated', 'evaluated', false, 'reason', 'Needs the framework pack''s variance threshold.'),
    'A07', jsonb_build_object('kind', 'deterministic_error', 'status', 'excluded', 'evaluated', false, 'reason', 'Cannot occur on a certified trial balance: account names are unique per workspace in the classification authority, and duplicate names are refused at intake.'),
    'A08', jsonb_build_object('kind', 'risk_indicator', 'status', 'not_evaluated', 'evaluated', false, 'reason', 'Needs the framework pack''s round-amount threshold.'),
    'A09', jsonb_build_object('kind', 'risk_indicator', 'status', 'not_evaluated', 'evaluated', false, 'reason', 'Needs the framework pack''s statutory liability classes.'),
    'A10', jsonb_build_object('kind', 'risk_indicator', 'status', 'evaluated', 'evaluated', true),
    'T01', CASE WHEN v_t01 THEN jsonb_build_object('kind', 'evidence_requirement', 'status', 'evaluated', 'evaluated', true)
           ELSE jsonb_build_object('kind', 'evidence_requirement', 'status', 'not_required', 'evaluated', false,
                                   'reason', 'No reviewed requirement scopes the income-tax computation workpaper to this workspace.') END);

  v_member := public._cr_member(p_company_id, v_uid);
  INSERT INTO public.close_review_finding_runs (company_id, period_year, upload_id, certification_id, prior_certification_id,
    catalogue_version, currency, exponent, rule_status, scope_key, generated_by, firm_member_id)
  VALUES (p_company_id, p_period_year, v_cert.upload_id, v_cert.id, v_prior.id, 'tb-anomaly-catalogue/1', v_currency, v_exponent, v_status, v_scope, v_uid, v_member)
  RETURNING * INTO v_run;

  INSERT INTO public.close_review_findings (run_id, company_id, rule_id, rule_version, finding_key, severity, kind, mandatory, required_resolution,
    account_key, account_code, account_name, classification, debit_minor, credit_minor, class_side_minor, detail)
  -- A01 abnormal sign. S2-A05: tested against the reviewed expected side. An account designated contra (TRUE) expects the
  -- side opposite to its class (class side <= 0) and is raised when it carries the class's normal sign (> 0: the flipped
  -- contra); FALSE and NULL (not reviewed) are tested exactly as before (< 0, the confirmed closing-stock credit excepted).
  SELECT v_run.id, p_company_id, 'A01', 1, 'A01:' || a.account_key, 'warning', 'risk_indicator', false, 'explanation',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor,
         CASE WHEN m.is_contra_account IS TRUE THEN jsonb_build_object('contraAccount', true) ELSE '{}'::jsonb END
    FROM public._cr_certified_accounts(v_cert.id) a
    LEFT JOIN public.account_mappings m ON m.company_id = p_company_id AND m.account_key = a.account_key
   WHERE CASE WHEN m.is_contra_account IS TRUE THEN a.class_side_minor > 0
              ELSE a.class_side_minor < 0 AND NOT (a.account_key = ANY (v_treated)) END
  UNION ALL
  -- A03 negative cash (designated cash, mapped as an asset, in credit)
  SELECT v_run.id, p_company_id, 'A03', 1, 'A03:' || a.account_key, 'blocking', 'deterministic_error', true, 'review',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor, '{}'::jsonb
    FROM public._cr_certified_accounts(v_cert.id) a
    JOIN public.account_mappings m ON m.company_id = p_company_id AND m.account_key = a.account_key
   WHERE m.is_cash_account IS TRUE AND a.classification IN ('current_assets', 'non_current_assets') AND a.debit_minor < a.credit_minor
  UNION ALL
  -- A10 machine classification
  SELECT v_run.id, p_company_id, 'A10', 1, 'A10:' || a.account_key, 'warning', 'risk_indicator', false, 'explanation',
         a.account_key, a.account_code, a.account_name, a.classification, a.debit_minor, a.credit_minor, a.class_side_minor,
         jsonb_build_object('evidenceTier', a.max_tier)
    FROM public._cr_certified_accounts(v_cert.id) a
   WHERE a.max_tier >= 4
  UNION ALL
  -- T01 income-tax computation workpaper (one per period, listing the tax accounts with a balance)
  SELECT v_run.id, p_company_id, 'T01', 1, 'T01', 'blocking', 'evidence_requirement', true, 'evidence', NULL, NULL, NULL, 'taxes', NULL, NULL, NULL,
         jsonb_build_object('accounts', jsonb_agg(jsonb_build_object('accountKey', a.account_key, 'accountName', a.account_name,
           'debitMinor', a.debit_minor::text, 'creditMinor', a.credit_minor::text) ORDER BY a.account_key))
    FROM public._cr_certified_accounts(v_cert.id) a
   WHERE v_t01 AND a.classification = 'taxes' AND a.debit_minor <> a.credit_minor
  HAVING count(*) > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM public._close_review_append(p_company_id, 'upload', v_cert.upload_id::text, 'findings_generated', NULL, NULL,
    jsonb_build_object('runId', v_run.id, 'certificationId', v_cert.id, 'priorCertificationId', v_prior.id, 'findings', v_n,
                       'catalogue', 'tb-anomaly-catalogue/1', 'scope', v_scope), v_uid, v_member, NULL);
  RETURN jsonb_build_object('outcome', 'generated', 'runId', v_run.id, 'findings', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.close_review_refresh_findings(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_review_refresh_findings(uuid, integer) TO authenticated;
