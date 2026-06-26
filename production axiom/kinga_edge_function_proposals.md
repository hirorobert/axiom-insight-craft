# Kinga Edge Function Design Proposals
**Status:** Design / pseudocode only — no deployable code, no execution  
**Date:** 2026-06-25  
**Scope:** Three functions operating on the four live Kinga tables  
**Constraint:** Stop after each proposal for review before proceeding  

---

## Context: auth.uid() inside Edge Functions using the service role key

This is the most important clarifying point before any function design:

When an Edge Function calls Supabase using the **service role key** (not the user's JWT), `auth.uid()` returns **NULL** inside the database session. The service role key sets the PostgreSQL role to `service_role`, which bypasses RLS entirely but does **not** populate the JWT claims that `auth.uid()` reads from `current_setting('request.jwt.claims', true)`.

Consequence for the `ingested_by` column default (`DEFAULT auth.uid()`): if the Edge Function uses the service role key for its database client, the default will resolve to NULL. The function must therefore **explicitly pass the calling user's UUID in the INSERT statement** rather than relying on the column default.

The pattern used in all three functions below:
1. Extract the calling user's identity from the incoming request's `Authorization` header (the user's JWT, not the service role key)
2. Validate it server-side using Supabase Auth
3. Use the **service role key** for all database writes (to bypass RLS for bulk operations)
4. Pass the validated user UUID explicitly in every write that records provenance

This separates authentication (who is calling) from authorization (what they can write), which is the correct pattern for server-side functions that need elevated write privileges.

---

## Function 1: EFDMS Ingestion (`ingest-efdms-batch`)

### Purpose
Accept a batch of EFDMS transaction records for a company/period, validate ownership, and insert into `efdms_records` with idempotency handling.

### Format flag
The TRA EFDMS export format is not standardized in this design — **flag for human confirmation before implementation.** Two likely formats:
- **CSV:** Column headers match field names; rows are individual transactions
- **JSON:** Array of transaction objects

The function should support both via a `Content-Type` or `format` parameter, with a shared internal normalisation step that produces a common record shape regardless of input format. This is implemented as a separate internal function (not an Edge Function) so it can be unit-tested independently.

### Pseudocode

```
FUNCTION ingest-efdms-batch(request):

  // ── Step 1: Authenticate the calling user ──────────────────────────────
  jwt = extract Bearer token from request Authorization header
  IF jwt is missing or malformed:
    RETURN 401 Unauthorized

  user = supabase.auth.getUser(jwt)          // validates against Supabase Auth
  IF user.error OR user.data.user is null:
    RETURN 401 Unauthorized

  calling_user_id = user.data.user.id        // UUID; used for ingested_by

  // ── Step 2: Parse request body ──────────────────────────────────────────
  body = parse JSON from request body
  company_id     = body.company_id           // UUID
  source_batch_id = body.source_batch_id     // TEXT; caller-supplied idempotency key
                                             // for this batch (e.g. "EFDMS-2024-Q1-001")
  records        = body.records              // array of raw transaction objects
  format         = body.format ?? "json"     // "csv" or "json"

  IF company_id is missing:
    RETURN 400 Bad Request "company_id is required"
  IF records is empty or not an array:
    RETURN 400 Bad Request "records must be a non-empty array"
  IF source_batch_id is missing:
    RETURN 400 Bad Request "source_batch_id is required for batch traceability"

  // ── Step 3: Authorise — calling user must own the target company ────────
  // Use service_role client to bypass RLS for this lookup, then explicitly
  // check ownership. This is the enforcement point — service role bypasses RLS.
  company = serviceRoleClient
    .from("companies")
    .select("id, user_id")
    .eq("id", company_id)
    .single()

  IF company.error OR company.data is null:
    RETURN 404 Not Found "company not found"

  IF company.data.user_id != calling_user_id:
    RETURN 403 Forbidden "company does not belong to the authenticated user"
    // Do not leak whether the company exists for other users (403 vs 404 policy:
    // since we checked existence first and then ownership, the 403 is fine here
    // because the company does exist — we're not confirming it to a stranger)

  // ── Step 4: Normalise records ───────────────────────────────────────────
  // Convert raw EFDMS export rows into the efdms_records schema shape.
  // This is the format-dependent step; isolate it as a pure function.
  normalised = []
  parse_errors = []

  FOR EACH raw_record IN records:
    result = normalise_efdms_record(raw_record, company_id, calling_user_id, source_batch_id)
    IF result.error:
      parse_errors.append({ raw: raw_record, error: result.error })
    ELSE:
      normalised.append(result.record)

  IF parse_errors.length > 0 AND normalised.length == 0:
    RETURN 422 Unprocessable Entity { parse_errors }
    // Fail fast if everything is unparseable

  // ── Step 5: Insert with idempotency (ON CONFLICT DO NOTHING) ───────────
  // The UNIQUE(company_id, efdms_transaction_id) constraint is the idempotency key.
  // ON CONFLICT DO NOTHING: skip duplicates without raising an error.
  // We need to know how many were actually inserted vs. skipped, so we use
  // INSERT ... ON CONFLICT DO NOTHING RETURNING id to count real inserts.

  insert_result = serviceRoleClient
    .from("efdms_records")
    .insert(normalised)
    .onConflict("company_id, efdms_transaction_id")
    .ignoreDuplicates()           // Supabase client: maps to ON CONFLICT DO NOTHING
    .select("id")                 // RETURNING id — only inserted rows come back

  IF insert_result.error:
    RETURN 500 Internal Server Error { error: insert_result.error.message }

  inserted_count = insert_result.data.length
  skipped_count  = normalised.length - inserted_count

  // ── Step 6: Return summary ──────────────────────────────────────────────
  RETURN 200 OK {
    source_batch_id:  source_batch_id,
    submitted:        records.length,
    parsed:           normalised.length,
    inserted:         inserted_count,
    skipped_duplicates: skipped_count,
    parse_errors:     parse_errors,      // [] if none
    parse_error_count: parse_errors.length
  }

// ── Normalise helper ──────────────────────────────────────────────────────
FUNCTION normalise_efdms_record(raw, company_id, ingested_by, source_batch_id):
  // Field mapping from TRA EFDMS export → efdms_records schema.
  // CONFIRM actual field names against the real TRA export format.
  
  efdms_transaction_id = raw["Transaction ID"] ?? raw.transaction_id
  transaction_date     = parse DATE from raw["Date"] ?? raw.transaction_date
  record_type          = normalise_record_type(raw["Type"] ?? raw.record_type)
                         // "sale"/"S"/"SALE" → "sale"; "purchase"/"P"/"PURCHASE" → "purchase"
  amount_tzs           = parse NUMERIC from raw["Amount"] ?? raw.amount_tzs
  vat_amount_tzs       = parse NUMERIC from raw["VAT"] ?? raw.vat_amount ?? 0
  counterparty_tin     = raw["TIN"] ?? raw.counterparty_tin ?? NULL
  counterparty_name    = raw["Name"] ?? raw.counterparty_name ?? NULL
  efd_device_id        = raw["Device ID"] ?? raw.efd_device_id ?? NULL

  IF any required field (efdms_transaction_id, transaction_date, record_type, amount_tzs) is NULL:
    RETURN { error: "missing required field: <field_name>" }

  IF record_type NOT IN ("sale", "purchase"):
    RETURN { error: "unrecognised record_type: <value>" }

  IF amount_tzs < 0:
    RETURN { error: "amount_tzs must be non-negative" }

  period_year  = YEAR(transaction_date)
  period_month = MONTH(transaction_date)

  RETURN {
    record: {
      company_id,
      efdms_transaction_id,
      record_type,
      transaction_date,
      period_year,
      period_month,
      amount_tzs,
      vat_amount_tzs,
      counterparty_tin,
      counterparty_name,
      efd_device_id,
      source_batch_id,
      raw_payload:  raw,            // store original for audit / reprocessing
      ingested_by:  ingested_by     // set explicitly — auth.uid() = NULL in service role context
    }
  }
```

### Key design decisions

**`ingested_by` set explicitly, not via DEFAULT.** As established above, `auth.uid()` returns NULL in a service-role database session. The calling user's UUID is extracted from their JWT in Step 1 and passed as a literal value in the INSERT. The column DEFAULT is a safety net for direct (non-Edge-Function) inserts by authenticated users, not for this function.

**`source_batch_id` is required, not optional.** If a bad batch is ingested (wrong period, malformed amounts, wrong company), the standard remediation query is `SELECT id FROM efdms_records WHERE source_batch_id = 'EFDMS-2024-Q1-001'` followed by a service-role-only soft-delete or correction. Making `source_batch_id` required at the Edge Function level enforces this affordance upfront rather than discovering its absence during an incident.

**ON CONFLICT DO NOTHING + RETURNING id** gives exact insert/skip counts without a separate COUNT query. The skipped_count = submitted - returned rows.

**Parse errors are non-fatal if some rows succeed.** If 98 of 100 rows parse correctly, insert 98 and report the 2 errors in the response. The caller can fix and re-submit only the failed rows. The exception: if ALL rows fail parsing, return 422 immediately without attempting any insert.

---

## Function 2: Findings Generation (`generate-findings`)

### Purpose
Given a company and period, compare EFDMS totals against GL figures to produce `efdms_diff` findings, and scan ledger classifications against active statutory rules to produce `rule_trigger` findings. Idempotent — safe to run multiple times against the same period.

### Idempotency key for a finding

A finding is uniquely identified by the combination:
`(company_id, finding_type, trigger_category_or_diff_axis, period_start, period_end)`

For `efdms_diff`: `(company_id, 'efdms_diff', record_type, period_start, period_end)`  
For `rule_trigger`: `(company_id, 'rule_trigger', statutory_rule_id, period_start, period_end)`

**Implementation:** Before inserting a finding, check whether a row already exists with the same `(company_id, finding_type, period_start, period_end, source_detail->>'diff_axis')` or `(company_id, finding_type, period_start, period_end, statutory_rule_id)`. If it exists:
- If `status = 'open'` or `'in_progress'`: update the exposure amount (the numbers may have changed since the last run if GL data was corrected), but do not create a duplicate
- If `status = 'resolved'` or `'disputed'`: do not overwrite — create a new finding only if the variance has re-opened (i.e. the recalculated exposure exceeds the materiality threshold again)

This means no UNIQUE constraint enforces idempotency at the DB level — the logic lives in the function. A future migration could add a partial unique index on `(company_id, finding_type, period_start, period_end, statutory_rule_id)` WHERE `status != 'resolved'` if this becomes error-prone.

### Pseudocode

```
FUNCTION generate-findings(request):

  // ── Step 1 & 2: Auth + ownership check (same as Function 1) ────────────
  calling_user_id = authenticate(request)
  company_id      = body.company_id
  period_start    = body.period_start    // DATE "2024-01-01"
  period_end      = body.period_end      // DATE "2024-12-31"
  materiality_tzs = body.materiality_threshold_tzs ?? 500000  // TZS 500K default
  gl_source       = body.gl_source       // "upload" | "direct"
  upload_id       = body.upload_id ?? NULL  // required if gl_source = "upload"

  verify company ownership (same as Function 1 Step 3)

  // ── Module A: EFDMS diff findings ──────────────────────────────────────

  // A1. Sum EFDMS records for this company/period
  efdms_sales = SUM(amount_tzs) FROM efdms_records
    WHERE company_id = company_id
      AND period_start <= transaction_date <= period_end
      AND record_type = 'sale'

  efdms_purchases = SUM(amount_tzs) FROM efdms_records
    WHERE company_id = company_id
      AND period_start <= transaction_date <= period_end
      AND record_type = 'purchase'

  // A2. Get GL totals
  IF gl_source = "upload":
    // Extract revenue and COGS/purchases totals from trial_balance_uploads
    // validation_report JSONB (already computed by Axiom's process-trial-balance function)
    upload = SELECT validation_report FROM trial_balance_uploads WHERE id = upload_id
    gl_sales     = upload.validation_report.income_statement.revenue_total
    gl_purchases = upload.validation_report.income_statement.cogs_total
  ELSE IF gl_source = "direct":
    // Caller supplies GL totals directly in the request body
    gl_sales     = body.gl_sales_tzs
    gl_purchases = body.gl_purchases_tzs

  // A3. Compute variances and create findings where above materiality
  FOR EACH (diff_axis, efdms_total, gl_total) IN [
    ("sales",     efdms_sales,     gl_sales),
    ("purchases", efdms_purchases, gl_purchases)
  ]:
    variance = ABS(gl_total - efdms_total)

    IF variance < materiality_tzs:
      CONTINUE   // below threshold — no finding

    existing = find_existing_finding(company_id, 'efdms_diff', diff_axis, period_start, period_end)

    IF existing AND existing.status IN ('open', 'in_progress'):
      UPDATE findings SET
        exposure_amount_tzs     = variance,
        base_amount_tzs         = gl_total,
        comparison_amount_tzs   = efdms_total,
        source_detail           = { diff_axis, gl_total, efdms_total, materiality_tzs },
        updated_at              = now()
      WHERE id = existing.id
    ELSE IF existing AND existing.status IN ('resolved', 'disputed'):
      // Re-opened variance: create new finding, do not overwrite the resolved one
      INSERT INTO findings ( ... new row ... )
    ELSE:
      INSERT INTO findings (
        company_id, upload_id, finding_type, title, period_start, period_end,
        exposure_amount_tzs, base_amount_tzs, comparison_amount_tzs,
        source_detail, status, created_by
      ) VALUES (
        company_id,
        upload_id,
        'efdms_diff',
        CASE diff_axis
          WHEN 'sales'     THEN 'Sales EFDMS variance ' || period_label
          WHEN 'purchases' THEN 'Purchases EFDMS variance ' || period_label
        END,
        period_start, period_end,
        variance,
        gl_total,       -- base_amount_tzs
        efdms_total,    -- comparison_amount_tzs
        { diff_axis, gl_total, efdms_total, materiality_tzs },  -- source_detail JSONB
        'open',
        calling_user_id
      )

  // ── Module B: Rule-trigger findings ────────────────────────────────────

  // B1. Get all active statutory rules for this jurisdiction and period
  active_rules = SELECT * FROM statutory_rules
    WHERE jurisdiction = 'TZ'
      AND effective_from <= period_end
      AND (effective_to IS NULL OR effective_to >= period_start)
      AND trigger_account_classification IS NOT NULL
      // Only rules that link to an account classification can be auto-triggered.
      // Rules without trigger_account_classification require manual finding entry.

  // B2. For each rule, check whether matching account_mappings exist for this user
  FOR EACH rule IN active_rules:

    matching_accounts = SELECT am.* FROM account_mappings am
      WHERE am.user_id = calling_user_id
        AND am.classification = rule.trigger_account_classification

    IF matching_accounts is empty:
      CONTINUE   // no ledger accounts mapped to this classification → no trigger

    // B3. Sum GL amounts for those accounts in this period
    // (Requires access to trial balance line-item data, not just totals.)
    // This is the integration point with Axiom's trial_balance_uploads:
    // the account-level amounts live in validation_report JSONB.
    // ⚠ GAP: the current validation_report structure may not expose
    //   per-account amounts, only category totals. This needs a
    //   pre-implementation data-contract check against the actual
    //   process-trial-balance output shape. Flag before building.

    account_total_tzs = SUM of GL amounts for matching accounts in period

    // B4. Compute obligation
    IF rule.rate_is_threshold:
      // Threshold rules: obligation exists if account_total >= threshold_amount
      IF account_total_tzs < rule.threshold_amount:
        CONTINUE
      obligation_amount = NULL    // threshold met, but no rate-based amount
      exposure          = 0       // flag for review rather than a TZS amount
    ELSE:
      obligation_amount = account_total_tzs * (rule.rate_pct / 100)
      exposure          = obligation_amount  // simplified; interest/penalty separate

    // B5. Idempotency check and upsert (same pattern as Module A)
    existing = find_existing_finding(company_id, 'rule_trigger', rule.id, period_start, period_end)

    IF existing AND existing.status IN ('open', 'in_progress'):
      UPDATE findings SET
        exposure_amount_tzs    = exposure,
        computed_obligation_tzs = obligation_amount,
        base_amount_tzs        = account_total_tzs,
        source_detail          = { rule_id: rule.id, account_total_tzs, matching_accounts: [ids] },
        updated_at             = now()
      WHERE id = existing.id
    ELSE IF NOT existing:
      INSERT INTO findings (
        company_id, statutory_rule_id, upload_id, finding_type,
        title, statute_reference, period_start, period_end,
        exposure_amount_tzs, base_amount_tzs, computed_obligation_tzs,
        source_detail, status, created_by
      ) VALUES (
        company_id,
        rule.id,
        upload_id,
        'rule_trigger',
        rule.obligation || ' — ' || period_label,
        rule.statute,
        period_start, period_end,
        exposure,
        account_total_tzs,
        obligation_amount,
        { rule_id: rule.id, account_total_tzs, matching_accounts: [ids] },
        'open',
        calling_user_id
      )

  // ── Return summary ──────────────────────────────────────────────────────
  RETURN 200 OK {
    company_id,
    period: { start: period_start, end: period_end },
    efdms_diff_findings: { created, updated, below_materiality },
    rule_trigger_findings: { created, updated, no_matching_accounts },
    gaps: [ "validation_report per-account structure needs confirmation" ]
  }
```

### Key design decisions

**Materiality threshold is a runtime parameter, not a hardcoded constant.** Different clients have different materiality levels. Default of TZS 500,000 is a starting point; the calling application should pass the client's configured threshold.

**`source_detail` JSONB is the calculation audit trail.** Every finding stores the exact inputs used to compute the obligation: GL totals, EFDMS totals, account IDs, rule ID. This is the "reproducible calculation" requirement from the architecture doc — a TRA dispute can be defended by re-running the exact same numbers.

**Gap flagged — per-account GL amounts.** The current `validation_report` JSONB in `trial_balance_uploads` stores category-level totals (revenue, COGS, etc.) — not individual account-level amounts. Rule triggers need individual account amounts (e.g. "rent expense account 5040 total for the period"). This is a pre-implementation data contract question: either extend the validation_report structure, or require the caller to pass account-level amounts directly in the request body. **This gap must be resolved before Function 2 can be fully implemented.**

---

## Function 3: Evidence Request Step-Transition Handler (`advance-evidence-step`)

### Purpose
Advance an `evidence_requests` row from its current step to the next (or record sub-step events like reminders). Enforces who is allowed to trigger each transition and validates that prerequisite conditions are met.

### Roles gap — flagged

There is currently **no roles table** in the schema. The six-step workflow references three roles from the Kinga prototype: **Preparer**, **Partner**, and **Client**. There is no `user_roles` or `firm_members` table yet.

Current state: `companies.user_id` identifies the owner of a company (who functions as the Preparer in solo-firm mode). There is no way to distinguish a Partner from a Preparer, or to record that a user is the assigned Client contact, without a new table.

**This is a design gap that must be resolved before the Partner sign-off step (Step 5) can enforce role-based access.** Options:
1. Add a `firm_members` table: `(id, firm_owner_user_id, member_user_id, role TEXT CHECK IN ('preparer', 'partner', 'client'))` — the firm owner is the `companies.user_id`; partners and clients are additional members
2. Add a `role TEXT` column to `profiles` (simpler; only works for single-firm users)
3. For Phase 2 MVP: skip role enforcement on steps 3-5 and let any authenticated user who can see the finding advance the step — document as a known limitation

This document flags Option 1 as the right long-term design. The pseudocode below notes where role checks should be inserted once the table exists.

### Step transition rules

| From → To | Trigger | Actor | Condition |
|-----------|---------|-------|-----------|
| 0 → 1 | Create evidence_request row | Preparer | finding must exist and be open |
| 1 → 2 | Automatic on step 1 completion | System | step1_requested_at set → current_step = 2 |
| 2 → reminder | Send reminder | System / Preparer | current_step = 2; increments step2_reminder_count |
| 2 → 3 | Evidence received | Preparer | current_step = 2; documents confirmed received |
| 3 → 4 | Start review | Preparer | current_step = 3 |
| 4 → 5 | Partner sign-off | **Partner** (role check required — gap above) | current_step = 4 |
| 5 → 6 | Submitted to TRA | Preparer or Partner | current_step = 5; step6_submission_ref required |

### Pseudocode

```
FUNCTION advance-evidence-step(request):

  // ── Step 1 & 2: Auth + parse ────────────────────────────────────────────
  calling_user_id    = authenticate(request)
  evidence_request_id = body.evidence_request_id
  action             = body.action
  // action values: "request_evidence" | "send_reminder" | "mark_received"
  //                "start_review"     | "sign_off"      | "submit_to_tra"
  payload            = body.payload ?? {}
  // action-specific data: submission_ref for submit_to_tra, etc.

  // ── Step 3: Load the evidence_request and its parent finding ───────────
  er = SELECT er.*, f.company_id, f.status AS finding_status
       FROM evidence_requests er
       JOIN findings f ON f.id = er.finding_id
       WHERE er.id = evidence_request_id

  IF er is null:
    RETURN 404 Not Found

  // ── Step 4: Verify calling user owns the parent company ────────────────
  company = SELECT user_id FROM companies WHERE id = er.company_id
  IF company.user_id != calling_user_id:
    // ⚠ Role gap: once firm_members exists, also accept firm members of this company
    RETURN 403 Forbidden

  // ── Step 5: Dispatch by action ─────────────────────────────────────────

  SWITCH action:

    CASE "send_reminder":
      IF er.current_step != 2:
        RETURN 400 "send_reminder is only valid at step 2 (awaiting client)"
      UPDATE evidence_requests SET
        step2_last_reminder_at = now(),
        step2_reminder_count   = step2_reminder_count + 1,
        updated_at             = now()
      WHERE id = evidence_request_id
      // Note: does NOT advance current_step. Step 2 persists until evidence is received.
      RETURN 200 { new_reminder_count: step2_reminder_count + 1 }

    CASE "mark_received":
      IF er.current_step != 2:
        RETURN 400 "mark_received is only valid at step 2"
      UPDATE evidence_requests SET
        current_step       = 3,
        step3_received_at  = now(),
        step3_received_by  = calling_user_id,
        updated_at         = now()
      WHERE id = evidence_request_id
      // ↑ This UPDATE fires trg_update_response_pack_ready on findings:
      //   current_step 3 >= 3 → findings.response_pack_ready = true
      RETURN 200 { current_step: 3, response_pack_ready: true }

    CASE "start_review":
      IF er.current_step != 3:
        RETURN 400 "start_review is only valid at step 3"
      UPDATE evidence_requests SET
        current_step            = 4,
        step4_review_started_at = now(),
        updated_at              = now()
      WHERE id = evidence_request_id
      RETURN 200 { current_step: 4 }

    CASE "sign_off":
      IF er.current_step != 4:
        RETURN 400 "sign_off is only valid at step 4"
      // ⚠ Role gap: once firm_members exists, verify calling_user_id has role='partner'
      //   for this firm. Without that table, any authenticated firm member can sign off.
      UPDATE evidence_requests SET
        current_step      = 5,
        step4_reviewed_at = now(),
        step4_reviewed_by = calling_user_id,
        step5_signoff_at  = now(),
        step5_signed_by   = calling_user_id,
        updated_at        = now()
      WHERE id = evidence_request_id
      RETURN 200 { current_step: 5 }

    CASE "submit_to_tra":
      IF er.current_step != 5:
        RETURN 400 "submit_to_tra is only valid at step 5"
      submission_ref = payload.submission_ref
      IF submission_ref is null or empty:
        RETURN 400 "submission_ref is required for TRA submission"
      UPDATE evidence_requests SET
        current_step          = 6,
        step6_submitted_at    = now(),
        step6_submitted_by    = calling_user_id,
        step6_submission_ref  = submission_ref,
        updated_at            = now()
      WHERE id = evidence_request_id
      // Also update the parent finding status to 'resolved' (or leave 'in_progress'
      // — policy decision: does step 6 mean fully resolved or pending TRA response?)
      // ⚠ Flagged as a policy decision: recommend 'in_progress' until TRA confirms
      //   acceptance, then a separate "mark_resolved" action closes the finding.
      RETURN 200 { current_step: 6, submission_ref }

    DEFAULT:
      RETURN 400 "unrecognised action: <action>"
```

### Key design decisions

**One function handles all step transitions, not six.** The `action` parameter dispatches to the correct transition. This avoids six separately-deployed functions that all share the same auth, ownership check, and evidence_request loading boilerplate.

**`current_step` is the canonical state machine position.** The step timestamp columns (`step3_received_at`, etc.) are audit record columns — they record when an event occurred. `current_step` is the state machine value. Both are written atomically in a single UPDATE to prevent split-brain.

**Reminder events do not advance `current_step`.** Step 2 is the waiting period. Reminders are events within step 2, not transitions to step 3. This is why `step2_reminder_count` and `step2_last_reminder_at` exist as separate columns rather than a step2 timestamp pair.

**Step 5 → 6 requires `submission_ref`.** The TRA submission reference is the only external evidence that submission actually happened. Requiring it at the database layer (enforced in the function, not by a DB constraint) prevents the workflow from being marked submitted without a traceable reference number.

**`finding.status` at step 6 is a policy decision, flagged.** Recommend `'in_progress'` (TRA has it, but hasn't confirmed acceptance) → separate `mark_resolved` action updates `finding.status = 'resolved'` when TRA confirms. This preserves the audit trail for the TRA-response period.

---

## Gaps and open decisions summary

| Gap | Severity | Resolution path |
|-----|----------|-----------------|
| TRA EFDMS export format (CSV vs JSON, exact field names) | Blocking for Function 1 | Confirm with TRA or test against a real export file |
| `validation_report` per-account structure | Blocking for Function 2 rule triggers | Data contract check against process-trial-balance output |
| `firm_members` / roles table | Blocking for Function 3 step 5 role enforcement | Design as separate schema migration before Partner sign-off is enforced |
| `finding.status` at step 6 completion | Policy decision | Product decision: resolved immediately vs. pending TRA confirmation |
| Idempotency key for findings (no DB-level UNIQUE constraint yet) | Low severity for MVP; increases risk at scale | Add partial unique index in a future migration if race conditions appear |

---

## Phase 3 candidate (not designed this session)

**`vat_refund_claims` tracker:** The TZS 1.4–1.5 trillion VAT refund backlog with 12–24 month real-world processing times is a documented, recurring workflow problem for firms that have over-withheld or over-paid VAT. A tracker table would record submission date, amount claimed, TRA acknowledgment reference, follow-up history, and eventual outcome per claim per company. Kinga already holds the underlying VAT transaction data in `efdms_records`, making it the natural home for this tracker. The table design would follow the same append-only, RLS-protected, audit-trailed pattern as `evidence_requests`. Flagged as Phase 3 — not scoped, not built this session.
