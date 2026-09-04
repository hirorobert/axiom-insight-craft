-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 6 — ACCOUNT REVIEW AUTHORITATIVE FLAG PRESERVATION
--
-- Repairs DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001 (CLAUDE.md §9.1) at
-- its root in resolve_account_review_batch (20260816120000). Reuses the
-- exact existing account_mappings schema unchanged — no new column, no new
-- table. This migration ONLY redefines the function body.
--
-- Prior behaviour: the ON CONFLICT DO UPDATE clause unconditionally set
--   is_cash_account = EXCLUDED.is_cash_account
-- and the INSERT VALUES computed EXCLUDED.is_cash_account as
--   coalesce((v_decision->>'is_cash_account')::boolean, false)
-- so ANY decision touching an account (even one only reclassifying its
-- statement/line item) silently overwrote a previously professionally-set
-- is_cash_account / is_retained_earnings / is_payroll_account flag with
-- false, because the frontend previously sent literal `false` for all
-- three keys on every decision.
--
-- Corrected behaviour (paired with buildReviewDecisions.ts now omitting a
-- flag key entirely when the professional did not review that dimension):
--   - On INSERT (no prior account_mappings row): a NOT NULL boolean column
--     still needs a concrete value, and there is no prior truth to
--     protect, so an absent key still defaults to false for a brand-new
--     mapping.
--   - On CONFLICT UPDATE (a prior row exists): a key ABSENT from the
--     decision payload now PRESERVES the current row's value instead of
--     being coalesced to false. A key PRESENT (true or false) still
--     overwrites — that is a genuine, explicit professional decision on
--     that dimension, and latest-effective-wins is the correct semantics
--     for it (same law as every other field this function projects).
--
-- No other clause of resolve_account_review_batch changes: actor
-- resolution, role gating, idempotency, advisory locking, decision
-- logging, and MARK_NON_REPORTING_ACCOUNT handling are byte-for-byte the
-- certified 20260816120000 definition.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

CREATE OR REPLACE FUNCTION public.resolve_account_review_batch(
  p_company_id         UUID,
  p_upload_id          UUID,
  p_client_request_id  UUID,
  p_decisions          JSONB
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
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
  v_mappings_written   INTEGER := 0;
  v_decisions_logged   INTEGER := 0;
  v_non_reporting_count INTEGER := 0;
  v_seen_keys          TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- 1. Actor identity — server-derived only. NEVER accept from client.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  -- 2. Resolve accepted firm_members membership + role server-side.
  --    Classification authority: owner/partner/preparer. 'viewer' excluded.
  --    ('manager' is not a value chk_firm_member_role permits and never will match.)
  SELECT fm.id, fm.role
    INTO v_firm_member_id, v_role
    FROM public.firm_members fm
   WHERE fm.user_id     = v_user_id
     AND fm.company_id  = p_company_id
     AND fm.accepted_at IS NOT NULL
   LIMIT 1;

  IF v_firm_member_id IS NULL THEN
    RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
  END IF;

  IF v_role NOT IN ('owner', 'partner', 'preparer') THEN
    RAISE EXCEPTION 'ROLE_NOT_AUTHORIZED_FOR_CLASSIFICATION_DECISIONS' USING ERRCODE = '42501';
  END IF;

  -- 3/4. Resolve upload's authoritative company_id server-side; cross-company
  --      mismatch aborts atomically before anything is read or written.
  SELECT tbu.company_id INTO v_upload_company_id
    FROM public.trial_balance_uploads tbu
   WHERE tbu.id = p_upload_id;

  IF v_upload_company_id IS NULL OR v_upload_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'UPLOAD_COMPANY_MISMATCH' USING ERRCODE = '42501';
  END IF;

  -- Reject empty batches early.
  IF p_decisions IS NULL OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DECISION_BATCH' USING ERRCODE = '22023';
  END IF;

  -- 5. Actor-scoped idempotency check.
  v_request_hash := encode(
    digest(
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
                 coalesce(elem->>'is_cash_account','∅') || '::' ||
                 coalesce(elem->>'is_retained_earnings','∅') || '::' ||
                 coalesce(elem->>'is_payroll_account','∅'),
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
      RETURN v_existing_batch.result_summary;               -- exact replay, nothing written
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 6. Canonicalize decisions: compute review_account_key for each, reject
  --    duplicates within one batch, reject AUTO_MAPPED_RULE (item 9 boundary).
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

  -- 7. Deterministic sorted lock order (deadlock avoidance across concurrent
  --    multi-account batches, regardless of payload ordering).
  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_sorted_keys
    FROM unnest(v_seen_keys) AS k;

  FOREACH v_key IN ARRAY v_sorted_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_company_id::TEXT), hashtext(v_key));
  END LOOP;

  -- 8-11. Under lock: read previous state, apply projection law, log ledger.
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
      INSERT INTO public.account_mappings (
        user_id, company_id, account_code, account_name, normalized_account_name,
        statement, classification, line_item, normal_balance,
        is_cash_account, is_retained_earnings, is_payroll_account,
        confidence_source, approved_at
      ) VALUES (
        v_user_id, p_company_id, v_code, v_decision->>'account_name', v_norm_name,
        (v_decision->>'statement')::public.financial_statement,
        (v_decision->>'classification')::public.account_classification,
        coalesce(v_decision->>'line_item', v_decision->>'account_name'),
        v_decision->>'normal_balance',
        -- Brand-new row: no prior authoritative value to protect. A NOT
        -- NULL boolean column still needs a concrete value.
        coalesce((v_decision->>'is_cash_account')::boolean, false),
        coalesce((v_decision->>'is_retained_earnings')::boolean, false),
        coalesce((v_decision->>'is_payroll_account')::boolean, false),
        'user_approved', now()
      )
      ON CONFLICT (company_id, account_key) DO UPDATE SET
        account_code            = EXCLUDED.account_code,
        account_name             = EXCLUDED.account_name,
        normalized_account_name  = EXCLUDED.normalized_account_name,
        statement                = EXCLUDED.statement,
        classification           = EXCLUDED.classification,
        line_item                = EXCLUDED.line_item,
        normal_balance           = EXCLUDED.normal_balance,
        -- Phase 6 / DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001: a key
        -- ABSENT from this decision's payload means the professional did
        -- not review that dimension this time — PRESERVE the row's
        -- current value rather than overwriting it with a manufactured
        -- false. A key PRESENT (true or false) is an explicit decision on
        -- that dimension and legitimately overwrites, same as every other
        -- field here.
        is_cash_account          = CASE WHEN v_decision ? 'is_cash_account'
                                         THEN (v_decision->>'is_cash_account')::boolean
                                         ELSE public.account_mappings.is_cash_account END,
        is_retained_earnings     = CASE WHEN v_decision ? 'is_retained_earnings'
                                         THEN (v_decision->>'is_retained_earnings')::boolean
                                         ELSE public.account_mappings.is_retained_earnings END,
        is_payroll_account       = CASE WHEN v_decision ? 'is_payroll_account'
                                         THEN (v_decision->>'is_payroll_account')::boolean
                                         ELSE public.account_mappings.is_payroll_account END,
        confidence_source        = 'user_approved',
        approved_at              = now(),
        updated_at               = now();
      v_mappings_written := v_mappings_written + 1;

    ELSIF v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN
      -- Model B: clear ONLY the company-specific projection. company_id is
      -- always p_company_id here, never NULL — a global mapping row can
      -- never satisfy this predicate, structurally.
      DELETE FROM public.account_mappings
       WHERE company_id = p_company_id
         AND account_key = v_review_key;
      v_non_reporting_count := v_non_reporting_count + 1;
    END IF;

    INSERT INTO public.account_review_decisions (
      batch_id, company_id, upload_id, firm_member_id,
      account_code, normalized_account_name, review_account_key,
      proposal_type, decision_action, previous_value, new_value, source, reason
    ) VALUES (
      v_batch_id, p_company_id, p_upload_id, v_firm_member_id,
      v_code, v_norm_name, v_review_key,
      v_proposal_type, v_decision_action, v_previous,
      CASE WHEN v_decision_action = 'MARK_NON_REPORTING_ACCOUNT' THEN NULL ELSE v_decision END,
      v_decision->>'source', v_decision->>'reason'
    );
    v_decisions_logged := v_decisions_logged + 1;
  END LOOP;

  -- 12. Result is deterministic and describes ONLY what this transaction
  --     committed. trial_balance_uploads status is NOT touched here — that
  --     remains process-trial-balance's exclusive responsibility, invoked by
  --     the frontend only after this function returns successfully.
  v_result := jsonb_build_object(
    'batch_id', v_batch_id,
    'mappings_written', v_mappings_written,
    'decisions_logged', v_decisions_logged,
    'non_reporting_decisions_recorded', v_non_reporting_count
  );

  UPDATE public.account_review_batches SET result_summary = v_result WHERE id = v_batch_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_account_review_batch(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_account_review_batch(UUID, UUID, UUID, JSONB) TO authenticated;

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- Restores the 20260816120000 definition verbatim (unconditional overwrite).
-- Not provided inline: re-apply 20260816120000's CREATE OR REPLACE FUNCTION
-- block for public.resolve_account_review_batch if a rollback is ever needed.
