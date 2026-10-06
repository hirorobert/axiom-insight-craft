-- 20261006100000_mapping_and_processing_authority.sql
--
-- S1 of the consolidated implementation blueprint (Revision 2): authorization for account mappings and for the
-- processing fields of a trial balance upload. Forward-only; PENDING HOSTED APPLICATION (no hosted journal number,
-- hash or applied timestamp is stated anywhere until a hosted read confirms it).
--
-- 1. account_mappings is server-written only. Client roles (anon, authenticated) lose INSERT, UPDATE, DELETE and
--    TRUNCATE; the three user_id write policies are dropped; SELECT is by workspace membership (an accepted member, or
--    the owner / a Prepare grant holder through tbu_can_read_prepare), with a personal (company_id NULL) row visible
--    only to the user who wrote it. The only writer is resolve_account_review_batch (SECURITY DEFINER).
-- 2. Review provenance. account_mappings.review_decision_id (nullable) names the account_review_decisions row that
--    professionally reviewed the mapping. A trigger accepts the link only when that decision has the SAME company_id,
--    the SAME account key (account code; the normalized name only when there is no code), an approving action
--    (USER_ACCEPTED_SUGGESTION / USER_MANUAL_CLASSIFICATION), and content equal field for field to the complete
--    mapping content: statement, classification, line_item, normal_balance, is_cash_account, is_retained_earnings,
--    is_payroll_account. A later change to any of those fields (or to the company or account key) that does not
--    carry a new matching decision clears the link. Any role — the service role included — is held to this.
--    A row without a valid link has no review provenance. NOTE: process-trial-balance does not yet read this column;
--    treating unlinked rows as suggestions is engine work (E1), not this migration.
-- 3. resolve_account_review_batch refuses cash-flow statements/classes and statement/class mismatches (22023, named
--    codes), records the resolved complete content on the decision (new_value.mapping), writes the decision first and
--    links the mapping to it, all in one transaction. Signature, SECURITY DEFINER, search_path, authorization, request
--    hash bytes (replay identity) and every result field are unchanged.
-- 4. tbu_request_reprocess(p_upload_id, p_operation_id, p_expected_source_hash): the one browser path to start a new
--    check of an upload. Authorized (accepted member with prepare_close + the processing entitlement; a personal
--    upload: its uploader + entitlement), idempotent per operation id (replay / conflict, refusals recorded in the
--    append-only tb_reprocess_requests), lifecycle-checked under the upload row lock, and atomic: it invalidates the
--    upload's current certification, sets status='processing', is_valid=false, moves a processed/blocked upload back
--    to active_processing and writes a lifecycle event — or changes nothing.
-- 5. tb_certification_invalidations: append-only, one row per invalidated certification. get_authoritative_certification
--    returns nothing when the latest certification of the current upload is invalidated (an older certification is
--    never resurrected); tbu_derived_active_state ignores an invalidated latest certification. Certifications are
--    never edited.
-- 6. trial_balance_uploads processing fields — status, is_valid, processing_result, validation_report,
--    accounting_errors, processed_at (and source_file_hash, already protected) — are server-owned: client roles lose
--    UPDATE on them (column privileges) and a guard trigger refuses any client change to them (and non-default values
--    at a client INSERT), with or without the axiom.tbu_lifecycle_op marker. Service-role processing and the SECURITY
--    DEFINER lifecycle RPCs are unaffected.
-- 7. OD2 backfill: an existing mapping is linked only when the LATEST decision for its company and account key is an
--    approving decision whose content equals the mapping's complete content exactly. Every other row stays unlinked.
--
-- Not addressed here (later stages): stale-worker races and attempt fencing (S2/E2); the engine's use of provenance
-- (E1); the notes/letter processing_result writers (E2); the CONFIRM_ACCOUNT_TREATMENT decision action.

-- ── 1. account_mappings: server-written only, membership read ─────────────────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.account_mappings FROM PUBLIC, anon, authenticated;

DO $revoke_mapping_columns$
DECLARE
  v_col text;
BEGIN
  -- A column-level grant survives a table-level REVOKE; none may remain for a client role.
  FOR v_col IN SELECT a.attname FROM pg_attribute a
                WHERE a.attrelid = 'public.account_mappings'::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
    EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I) ON TABLE public.account_mappings FROM PUBLIC, anon, authenticated', v_col);
  END LOOP;
END
$revoke_mapping_columns$;

DROP POLICY IF EXISTS "Users can create their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can update their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can delete their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Users can view their own mappings" ON public.account_mappings;
DROP POLICY IF EXISTS "Workspace members read account mappings" ON public.account_mappings;
CREATE POLICY "Workspace members read account mappings" ON public.account_mappings
  FOR SELECT TO authenticated
  USING (
    (company_id IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.firm_members fm
                WHERE fm.user_id = auth.uid() AND fm.company_id = account_mappings.company_id
                  AND fm.accepted_at IS NOT NULL)
       OR public.tbu_can_read_prepare(company_id)))
    OR (company_id IS NULL AND user_id = auth.uid())
  );

-- Belt and braces: a client role is refused even if a privilege is ever re-granted by mistake.
CREATE OR REPLACE FUNCTION public.account_mappings_client_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Iron Dome: account mappings are written only by the review service (resolve_account_review_batch).'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_account_mappings_client_write_guard ON public.account_mappings;
CREATE TRIGGER trg_account_mappings_client_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.account_mappings_client_write_guard();

-- ── 2. Review provenance ──────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.account_mappings
  ADD COLUMN IF NOT EXISTS review_decision_id uuid NULL
    REFERENCES public.account_review_decisions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_account_mappings_review_decision ON public.account_mappings (review_decision_id);

-- The complete reviewed content a decision asserts. A decision recorded from this migration on carries it explicitly
-- (new_value.mapping, written by the server). An earlier decision is read exactly as the earlier RPC applied it:
-- line_item defaulted to the account name; a flag the decision did not carry is unknown (NULL).
CREATE OR REPLACE FUNCTION public.account_review_decision_content(p_new_value jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN p_new_value IS NULL OR jsonb_typeof(p_new_value) <> 'object' THEN NULL
    WHEN jsonb_typeof(p_new_value->'mapping') = 'object' THEN p_new_value->'mapping'
    ELSE jsonb_build_object(
      'statement',            p_new_value->>'statement',
      'classification',       p_new_value->>'classification',
      'line_item',            COALESCE(p_new_value->>'line_item', p_new_value->>'account_name'),
      'normal_balance',       p_new_value->>'normal_balance',
      'is_cash_account',      CASE lower(p_new_value->>'is_cash_account') WHEN 'true' THEN true WHEN 'false' THEN false END,
      'is_retained_earnings', CASE lower(p_new_value->>'is_retained_earnings') WHEN 'true' THEN true WHEN 'false' THEN false END,
      'is_payroll_account',   CASE lower(p_new_value->>'is_payroll_account') WHEN 'true' THEN true WHEN 'false' THEN false END)
  END;
$$;

CREATE OR REPLACE FUNCTION public.account_mapping_content(
  p_statement public.financial_statement, p_classification public.account_classification, p_line_item text,
  p_normal_balance text, p_is_cash boolean, p_is_retained boolean, p_is_payroll boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'statement', p_statement::text, 'classification', p_classification::text, 'line_item', p_line_item,
    'normal_balance', p_normal_balance, 'is_cash_account', p_is_cash, 'is_retained_earnings', p_is_retained,
    'is_payroll_account', p_is_payroll);
$$;

CREATE OR REPLACE FUNCTION public.account_mappings_provenance_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_decision public.account_review_decisions%ROWTYPE;
  v_content jsonb := public.account_mapping_content(NEW.statement, NEW.classification, NEW.line_item, NEW.normal_balance,
                                                    NEW.is_cash_account, NEW.is_retained_earnings, NEW.is_payroll_account);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.review_decision_id IS NOT DISTINCT FROM OLD.review_decision_id THEN
    -- No new decision accompanies this change: a content, company or key change ends the provenance.
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR COALESCE(NEW.account_code, NEW.normalized_account_name) IS DISTINCT FROM COALESCE(OLD.account_code, OLD.normalized_account_name)
       OR v_content IS DISTINCT FROM public.account_mapping_content(OLD.statement, OLD.classification, OLD.line_item, OLD.normal_balance,
                                                                    OLD.is_cash_account, OLD.is_retained_earnings, OLD.is_payroll_account) THEN
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
DROP TRIGGER IF EXISTS trg_account_mappings_provenance ON public.account_mappings;
CREATE TRIGGER trg_account_mappings_provenance
  BEFORE INSERT OR UPDATE ON public.account_mappings
  FOR EACH ROW EXECUTE FUNCTION public.account_mappings_provenance_guard();

REVOKE ALL ON FUNCTION public.account_mappings_provenance_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_mappings_client_write_guard() FROM PUBLIC, anon, authenticated;

-- ── 3. resolve_account_review_batch: supported combinations, decision first, provenance link ──────────────────────
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

  SELECT tbu.company_id INTO v_upload_company_id
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  -- Replay identity: byte-identical to 20261003100000 (a retry of an earlier request still replays).
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
                 coalesce(elem->>'is_payroll_account','~'),
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
       ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION', 'MARK_NON_REPORTING_ACCOUNT') THEN
      RAISE EXCEPTION 'INVALID_DECISION_ACTION: %', coalesce(v_decision_action, 'NULL') USING ERRCODE = '22023';
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
             ELSE (v_previous->>'is_payroll_account')::boolean END);

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
        is_cash_account, is_retained_earnings, is_payroll_account,
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
        confidence_source        = 'user_approved',
        approved_at              = now(),
        review_decision_id       = EXCLUDED.review_decision_id,
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

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
    'non_reporting_decisions_recorded', v_non_reporting_count
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$function$;

-- ── 5. Certification invalidation (append-only) ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tb_certification_invalidations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  certification_id uuid NOT NULL UNIQUE REFERENCES public.tb_certifications(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  upload_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('reprocess_requested')),
  operation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tbci_upload ON public.tb_certification_invalidations (upload_id);
ALTER TABLE public.tb_certification_invalidations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_certification_invalidations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tb_certification_invalidations TO authenticated;
GRANT ALL ON TABLE public.tb_certification_invalidations TO service_role;

-- Whoever may read a certification may read whether it was invalidated (mirrors the two tb_certifications policies),
-- so get_authoritative_certification (SECURITY INVOKER) answers the same for every caller who can see the row.
DROP POLICY IF EXISTS "tbci_select_members" ON public.tb_certification_invalidations;
CREATE POLICY "tbci_select_members" ON public.tb_certification_invalidations
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.firm_members fm
             WHERE fm.user_id = auth.uid() AND fm.company_id = tb_certification_invalidations.company_id
               AND fm.accepted_at IS NOT NULL));
DROP POLICY IF EXISTS "tbci_select_prepare" ON public.tb_certification_invalidations;
CREATE POLICY "tbci_select_prepare" ON public.tb_certification_invalidations
  FOR SELECT TO authenticated USING (public.tbu_can_read_prepare(company_id));

CREATE OR REPLACE FUNCTION public.tb_certification_invalidations_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Removed only together with its certification (the FK cascade); never edited, never deleted on its own.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.id = OLD.certification_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Iron Dome: tb_certification_invalidations is append-only. % is not permitted. [id=%]', TG_OP, OLD.id
    USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbci_append_only ON public.tb_certification_invalidations;
CREATE TRIGGER trg_tbci_append_only
  BEFORE UPDATE OR DELETE ON public.tb_certification_invalidations
  FOR EACH ROW EXECUTE FUNCTION public.tb_certification_invalidations_append_only();
REVOKE ALL ON FUNCTION public.tb_certification_invalidations_append_only() FROM PUBLIC, anon, authenticated;

-- The latest certification of the current upload is authoritative only when it is not invalidated. An invalidated
-- latest certification yields NOTHING: an older certification is never resurrected.
CREATE OR REPLACE FUNCTION public.get_authoritative_certification(p_company_id uuid, p_period_year integer)
 RETURNS SETOF tb_certifications
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH latest_upload AS (
    SELECT id, source_file_hash AS current_source_file_hash
      FROM public.trial_balance_uploads
     WHERE company_id = p_company_id
       AND (p_period_year IS NULL OR period_year = p_period_year)
       AND lifecycle_state IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked')
     ORDER BY uploaded_at DESC, id DESC
     LIMIT 1
  ),
  latest_certification AS (
    SELECT c.*
      FROM public.tb_certifications c, latest_upload lu
     WHERE c.upload_id = lu.id
     ORDER BY c.sequence_no DESC
     LIMIT 1
  )
  SELECT lc.*
    FROM latest_certification lc, latest_upload lu
   WHERE lc.is_blocking = false
     AND lc.requires_review = false
     AND lu.current_source_file_hash IS NOT NULL
     AND lu.current_source_file_hash = lc.source_file_hash
     AND NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = lc.id);
$function$;

CREATE OR REPLACE FUNCTION public.tbu_derived_active_state(p_upload trial_balance_uploads)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    (SELECT CASE WHEN EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = c.id) THEN NULL
                 WHEN c.is_blocking THEN 'blocked' ELSE 'active_processed' END
       FROM public.tb_certifications c WHERE c.upload_id = p_upload.id
      ORDER BY c.sequence_no DESC LIMIT 1),
    CASE WHEN p_upload.processed_at IS NOT NULL
           OR p_upload.source_file_hash IS NOT NULL
           OR p_upload.processing_result IS NOT NULL
           OR p_upload.status NOT IN ('pending', 'processing')
         THEN 'active_processing' ELSE 'active_unprocessed' END);
$function$;

-- ── 6. Processing fields are server-owned ─────────────────────────────────────────────────────────────────────────
REVOKE UPDATE ON TABLE public.trial_balance_uploads FROM PUBLIC, anon, authenticated;
DO $upload_column_grants$
DECLARE
  v_col text;
BEGIN
  FOR v_col IN SELECT a.attname FROM pg_attribute a
                WHERE a.attrelid = 'public.trial_balance_uploads'::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON TABLE public.trial_balance_uploads FROM PUBLIC, anon, authenticated', v_col);
    IF v_col NOT IN ('status', 'is_valid', 'processing_result', 'validation_report', 'accounting_errors', 'processed_at', 'source_file_hash') THEN
      -- Every other column keeps exactly the access it had: RLS and the existing guards still decide.
      EXECUTE format('GRANT UPDATE (%I) ON TABLE public.trial_balance_uploads TO authenticated', v_col);
    END IF;
  END LOOP;
END
$upload_column_grants$;

CREATE OR REPLACE FUNCTION public.trial_balance_upload_processing_fields_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Server paths (service role, SECURITY DEFINER RPCs) are not client roles. The axiom.tbu_lifecycle_op marker
  -- confers nothing on a client role.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('pending', 'processing') OR NEW.is_valid IS NOT NULL OR NEW.processing_result IS NOT NULL
       OR NEW.validation_report IS NOT NULL OR NEW.processed_at IS NOT NULL OR NEW.source_file_hash IS NOT NULL
       OR (NEW.accounting_errors IS NOT NULL AND NEW.accounting_errors <> '[]'::jsonb) THEN
      RAISE EXCEPTION 'Iron Dome: a new upload''s processing fields are set by the server only.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.is_valid IS DISTINCT FROM OLD.is_valid
     OR NEW.processing_result IS DISTINCT FROM OLD.processing_result OR NEW.validation_report IS DISTINCT FROM OLD.validation_report
     OR NEW.accounting_errors IS DISTINCT FROM OLD.accounting_errors OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
     OR NEW.source_file_hash IS DISTINCT FROM OLD.source_file_hash THEN
    RAISE EXCEPTION 'Iron Dome: an upload''s processing fields are server-owned; request a new check through tbu_request_reprocess. [id=%]', OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_processing_fields_server_owned ON public.trial_balance_uploads;
CREATE TRIGGER trg_tbu_processing_fields_server_owned
  BEFORE INSERT OR UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_processing_fields_guard();
REVOKE ALL ON FUNCTION public.trial_balance_upload_processing_fields_guard() FROM PUBLIC, anon, authenticated;

-- ── 4. tbu_request_reprocess ──────────────────────────────────────────────────────────────────────────────────────
-- One row per operation id: the request identity (upload, expected source hash, actor) and its recorded outcome. A
-- refusal is recorded too, so retrying the same operation replays it. Server-only; append-only.
CREATE TABLE IF NOT EXISTS public.tb_reprocess_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  upload_id uuid NOT NULL,            -- not an FK: the record outlives the upload it names
  company_id uuid,                    -- NULL for a personal upload (or an upload that does not exist)
  actor_user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'refused')),
  code text NOT NULL,
  invalidated_certification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tbrr_accepted_code CHECK ((outcome = 'accepted') = (code = 'ACCEPTED'))
);
CREATE INDEX IF NOT EXISTS idx_tbrr_upload ON public.tb_reprocess_requests (upload_id, created_at);
ALTER TABLE public.tb_reprocess_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_reprocess_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tb_reprocess_requests TO service_role;

CREATE OR REPLACE FUNCTION public.tb_reprocess_requests_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: tb_reprocess_requests is append-only. % is not permitted. [id=%]', TG_OP, OLD.id
    USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbrr_append_only ON public.tb_reprocess_requests;
CREATE TRIGGER trg_tbrr_append_only
  BEFORE UPDATE OR DELETE ON public.tb_reprocess_requests
  FOR EACH ROW EXECUTE FUNCTION public.tb_reprocess_requests_append_only();
REVOKE ALL ON FUNCTION public.tb_reprocess_requests_append_only() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tbu_request_reprocess(p_upload_id uuid, p_operation_id uuid, p_expected_source_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text;
  v_prior public.tb_reprocess_requests%ROWTYPE;
  v_row public.trial_balance_uploads%ROWTYPE;
  v_member uuid;
  v_basis text;
  v_code text;
  v_cert uuid;
  v_to text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;
  IF p_upload_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST: upload id and operation id are required' USING ERRCODE = '22023';
  END IF;

  -- Same operation id → one decision at a time (taken before the upload lock; nothing else takes this lock).
  PERFORM pg_advisory_xact_lock(hashtext('tbu_request_reprocess'), hashtext(p_operation_id::text));
  v_hash := encode(extensions.digest(p_upload_id::text || '|' || COALESCE(p_expected_source_hash, '') || '|' || v_uid::text, 'sha256'), 'hex');

  SELECT * INTO v_prior FROM public.tb_reprocess_requests r WHERE r.operation_id = p_operation_id;
  IF v_prior.id IS NOT NULL THEN
    IF v_prior.request_hash <> v_hash THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'code', 'IDEMPOTENCY_KEY_REUSED', 'upload_id', p_upload_id,
                                'operation_id', p_operation_id, 'invalidated_certification_id', NULL);
    END IF;
    RETURN jsonb_build_object('outcome', CASE WHEN v_prior.outcome = 'accepted' THEN 'replayed' ELSE 'refused' END,
                              'code', v_prior.code, 'upload_id', v_prior.upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', v_prior.invalidated_certification_id, 'replayed', true);
  END IF;

  -- Authorization (read without a lock first: a caller with no authority never holds the upload lock).
  SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id;
  IF v_row.id IS NULL THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  ELSIF v_row.company_id IS NOT NULL THEN
    SELECT fm.id INTO v_member FROM public.firm_members fm
     WHERE fm.user_id = v_uid AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL
       AND public.named_user_access_active(fm.company_id, fm.user_id)
     ORDER BY fm.id LIMIT 1;
    IF v_member IS NULL THEN
      v_code := 'NOT_A_MEMBER_OF_COMPANY';
    ELSIF NOT public.has_workspace_capability(v_row.company_id, v_uid, 'prepare_close') THEN
      v_code := 'CAPABILITY_REQUIRED';
    END IF;
  ELSIF v_row.user_id IS DISTINCT FROM v_uid THEN
    v_code := 'NOT_A_MEMBER_OF_COMPANY';
  END IF;
  IF v_code IS NULL AND COALESCE((public.authorize_trial_balance_processing(v_uid, p_upload_id))->>'allowed', 'false') <> 'true' THEN
    v_code := 'ENTITLEMENT_REQUIRED';
  END IF;

  IF v_code IS NULL THEN
    -- Lifecycle checks under the upload row lock (upload lock only, the global lock order).
    SELECT * INTO v_row FROM public.trial_balance_uploads t WHERE t.id = p_upload_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.lifecycle_state NOT IN ('active_unprocessed', 'active_processing', 'active_processed', 'blocked') THEN
      v_code := 'UPLOAD_NOT_ACTIVE';
    ELSIF NOT public.tbu_upload_source_bound(p_upload_id) THEN
      v_code := 'SOURCE_NOT_BOUND';
    ELSIF v_row.source_file_hash IS NOT NULL AND v_row.source_file_hash IS DISTINCT FROM p_expected_source_hash THEN
      v_code := 'SOURCE_CHANGED';
    ELSIF v_row.status = 'validating'
       OR EXISTS (SELECT 1 FROM public.trial_balance_upload_operations o
                   WHERE o.upload_id = p_upload_id AND o.state IN ('pending', 'purging', 'storage_cleanup_pending')) THEN
      -- A processing worker has claimed the upload, or a discard / sweeper / storage-cleanup claim is held.
      v_code := 'IN_PROGRESS';
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code)
    VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'refused', v_code);
    RETURN jsonb_build_object('outcome', 'refused', 'code', v_code, 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                              'invalidated_certification_id', NULL);
  END IF;

  -- Accepted: invalidate the upload's current certification (kept unchanged as history), mark the upload for a new
  -- check, and record it — one transaction.
  SELECT c.id INTO v_cert FROM public.tb_certifications c
   WHERE c.upload_id = p_upload_id ORDER BY c.sequence_no DESC LIMIT 1;
  IF v_cert IS NOT NULL AND EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = v_cert) THEN
    v_cert := NULL; -- already invalidated by an earlier request
  END IF;
  IF v_cert IS NOT NULL THEN
    INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id)
    SELECT c.id, c.company_id, c.upload_id, 'reprocess_requested', p_operation_id, v_uid FROM public.tb_certifications c WHERE c.id = v_cert;
  END IF;

  v_to := CASE WHEN v_row.lifecycle_state IN ('active_processed', 'blocked') THEN 'active_processing' ELSE v_row.lifecycle_state END;
  PERFORM set_config('axiom.tbu_lifecycle_op', 'reprocess_request', true);
  UPDATE public.trial_balance_uploads t
     SET status = 'processing', is_valid = false,
         lifecycle_state = v_to,
         version = CASE WHEN v_to IS DISTINCT FROM v_row.lifecycle_state THEN t.version + 1 ELSE t.version END
   WHERE t.id = p_upload_id;
  v_basis := CASE WHEN EXISTS (SELECT 1 FROM public.companies c WHERE c.id = v_row.company_id AND c.user_id = v_uid)
                  THEN 'workspace_owner' ELSE 'explicit_capability' END;
  PERFORM public.tbu_log_event(p_upload_id, v_row.company_id, v_row.engagement_id, v_row.period_year,
    v_row.lifecycle_state, v_to, 'user', v_uid, v_member, v_basis, 'prepare_close', 'applied', p_operation_id,
    'Reprocess requested' || CASE WHEN v_cert IS NOT NULL THEN '; certification ' || v_cert::text || ' invalidated' ELSE '' END);
  PERFORM set_config('axiom.tbu_lifecycle_op', '', true);

  INSERT INTO public.tb_reprocess_requests (operation_id, request_hash, upload_id, company_id, actor_user_id, outcome, code, invalidated_certification_id)
  VALUES (p_operation_id, v_hash, p_upload_id, v_row.company_id, v_uid, 'accepted', 'ACCEPTED', v_cert);

  RETURN jsonb_build_object('outcome', 'accepted', 'code', 'ACCEPTED', 'upload_id', p_upload_id, 'operation_id', p_operation_id,
                            'invalidated_certification_id', v_cert);
END;
$$;
REVOKE ALL ON FUNCTION public.tbu_request_reprocess(uuid, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.tbu_request_reprocess(uuid, uuid, text) TO authenticated;

-- ── 7. OD2 backfill: exact matches only ──────────────────────────────────────────────────────────────────────────
-- Link a mapping only when the LATEST decision for its company and account key approves exactly its complete content.
-- updated_at is left as it was (this records provenance; it does not change the mapping).
ALTER TABLE public.account_mappings DISABLE TRIGGER update_account_mappings_updated_at;
UPDATE public.account_mappings am
   SET review_decision_id = d.id
  FROM (SELECT DISTINCT ON (x.company_id, x.review_account_key) x.id, x.company_id, x.review_account_key, x.decision_action, x.new_value
          FROM public.account_review_decisions x
         ORDER BY x.company_id, x.review_account_key, x.sequence_no DESC) d
 WHERE am.review_decision_id IS NULL
   AND am.company_id IS NOT NULL
   AND d.company_id = am.company_id
   AND d.review_account_key = COALESCE(am.account_code, am.normalized_account_name)
   AND d.decision_action IN ('USER_ACCEPTED_SUGGESTION', 'USER_MANUAL_CLASSIFICATION')
   AND public.account_review_decision_content(d.new_value)
       = public.account_mapping_content(am.statement, am.classification, am.line_item, am.normal_balance,
                                        am.is_cash_account, am.is_retained_earnings, am.is_payroll_account);
ALTER TABLE public.account_mappings ENABLE TRIGGER update_account_mappings_updated_at;
