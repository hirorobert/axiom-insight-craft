-- ============================================================
-- Kinga Phase 2 — New schema tables
-- statutory_rules, efdms_records, findings, evidence_requests
--
-- Migration: 20260625100000_b3e5c891-7f4a-4d2e-9c18-a6f0d2e8b347
-- Author: Axiom / Kinga engineering
-- Date: 2026-06-25
--
-- PURELY ADDITIVE. No existing Axiom table, policy, migration,
-- or frontend file is modified by this migration.
--
-- Dependencies on existing objects (not modified here):
--   public.companies              — FK target for efdms_records, findings
--   public.trial_balance_uploads  — FK target for findings.upload_id
--   public.statutory_rules        — FK target for findings.statutory_rule_id (self, created here)
--   public.account_classification — enum type used by statutory_rules
--   public.update_updated_at_column() — trigger function (created in 20251208084402_*)
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- 0.  TRIGGER FUNCTIONS
--     Defined before the tables that reference them so
--     CREATE TRIGGER can resolve the function name immediately.
-- ════════════════════════════════════════════════════════════

-- ── 0a. Effective-dating: close prior active statutory rule ──────────────
--
-- Fired BEFORE INSERT on statutory_rules.
-- Finds the currently-active row for the same
-- (trigger_category, jurisdiction, industry_pack) combination
-- (active = effective_to IS NULL) and closes its interval by setting
-- effective_to to NEW.effective_from - 1 day.
--
-- Using BEFORE INSERT means the new row is not yet in the table when
-- the UPDATE runs, so the WHERE clause cannot accidentally match the
-- incoming row — no `id <> NEW.id` guard is needed.
--
-- The IS NULL / equality split on industry_pack handles the three cases:
--   • both NULL    → close the default (non-industry-specific) rule
--   • both equal   → close the matching industry-pack rule
--   • one NULL, one not → no match (they are different rule lines)

CREATE OR REPLACE FUNCTION public.close_prior_statutory_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.statutory_rules
  SET    effective_to = NEW.effective_from - 1   -- DATE - INTEGER → DATE (subtract 1 day)
  WHERE  trigger_category = NEW.trigger_category
    AND  jurisdiction     = NEW.jurisdiction
    AND  (
           (industry_pack IS NULL AND NEW.industry_pack IS NULL)
           OR industry_pack = NEW.industry_pack
         )
    AND  effective_to IS NULL;                   -- only touch currently-active rows
  RETURN NEW;
END;
$$;


-- ── 0b. Response-pack readiness: sync findings.response_pack_ready ───────
--
-- Fired AFTER INSERT OR UPDATE on evidence_requests.
-- Sets findings.response_pack_ready = TRUE when current_step >= 3
-- (evidence received), per the prototype spec:
-- "Response Pack generated ONLY when all evidence is Received".
--
-- SECURITY DEFINER so the UPDATE to findings executes with the
-- function definer's privileges, bypassing the invoking user's RLS
-- context. This is correct: this is a system-maintenance write
-- (denormalised flag maintenance), not a user-facing mutation.
-- SET search_path = public guards against search-path injection.

CREATE OR REPLACE FUNCTION public.update_finding_response_pack_ready()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_finding_id UUID;
BEGIN
  -- On INSERT: OLD is null, COALESCE returns NEW.finding_id.
  -- On UPDATE: both exist; we always want the current (new) finding_id.
  v_finding_id := COALESCE(NEW.finding_id, OLD.finding_id);

  UPDATE public.findings
  SET
    response_pack_ready = (
      -- With UNIQUE(finding_id) there is exactly one evidence_requests row
      -- per finding, so MIN == the single value.  The subquery returns NULL
      -- if somehow no row exists (impossible given the trigger context, but
      -- COALESCE makes the intent explicit).
      COALESCE(
        (SELECT MIN(current_step) FROM public.evidence_requests
         WHERE finding_id = v_finding_id),
        0
      ) >= 3
    ),
    updated_at = now()
  WHERE id = v_finding_id;

  RETURN NEW;
END;
$$;


-- ── 0c. Finding-id immutability: block re-pointing an evidence request ───
--
-- Fired BEFORE UPDATE on evidence_requests, but ONLY when finding_id
-- actually changes (WHEN clause on the trigger — more efficient than
-- checking inside the function body, and the intent is self-documenting).
--
-- Raises an integrity_constraint_violation so the caller receives a
-- clear error rather than a generic permission denial.
-- Also provides a DB-layer backstop for the adversarial UPDATE attack
-- described in the RLS review (User B changing finding_id to point at
-- User A's finding in a single statement), independent of the RLS
-- WITH CHECK that already blocks cross-user re-points.

CREATE OR REPLACE FUNCTION public.prevent_finding_id_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'finding_id is immutable on evidence_requests (row %). '
    'Open a new evidence_request for the target finding instead '
    'of re-pointing an existing one.',
    OLD.id
  USING ERRCODE = 'integrity_constraint_violation';
  RETURN NULL; -- unreachable; required by plpgsql syntax
END;
$$;


-- ════════════════════════════════════════════════════════════
-- 1.  statutory_rules
-- ════════════════════════════════════════════════════════════
--
-- Shared reference data — NOT user-owned.
-- Tax law is the same for every firm; there is no user_id on this table.
-- This is intentional, not an oversight: see schema proposal §1.
--
-- Rows are effective-dated (effective_from / effective_to).
-- Substantive fields (rate, statute, obligation) are immutable after
-- INSERT; the only permitted post-insert mutation is setting effective_to
-- when a new version supersedes the row, and that is handled by the
-- close_prior_statutory_rule trigger — not by application code.
--
-- Rule management (INSERT) is restricted to the service role.
-- SELECT is open to all authenticated users.

CREATE TABLE public.statutory_rules (
  id                             UUID           NOT NULL DEFAULT gen_random_uuid(),

  -- Classification
  trigger_category               TEXT           NOT NULL,
  -- Human-readable: 'efdms_sales_variance', 'efdms_purchase_variance',
  -- 'sdl', 'wht_professional_services', 'wht_rent', 'stamp_duty', etc.

  trigger_account_classification public.account_classification NULL,
  -- Optional link to account_mappings.classification for the rules engine
  -- to detect an obligation from a ledger category without manual tagging.
  -- NULL for rules that fire on EFDMS diffs rather than ledger categories.

  -- Statutory basis
  statute                        TEXT           NOT NULL,
  -- e.g. 'Income Tax Act CAP 332 s.82', 'Stamp Duty Act 1972 s.12'
  obligation                     TEXT           NOT NULL,
  -- Human-readable description of what is owed.

  -- Rate / threshold (mutually exclusive, enforced by CHECKs below)
  rate_is_threshold              BOOLEAN        NOT NULL DEFAULT false,
  rate_pct                       NUMERIC(7,4)   NULL,
  -- Percentage as a decimal: 5.0000 = 5%, 0.1667 = 1/6th VAT fraction.
  -- NULL when rate_is_threshold = true.
  threshold_amount               NUMERIC(20,2)  NULL,
  -- TZS value for threshold-based rules (e.g. EFD registration at TZS 11M).
  -- NULL when rate_is_threshold = false.

  -- Penalty
  penalty_rate_pct               NUMERIC(7,4)   NULL,
  -- e.g. 200.0000 = 200% penalty for stamp-duty non-compliance.
  -- NULL when no statutory penalty applies.

  -- Versioning
  jurisdiction                   TEXT           NOT NULL DEFAULT 'TZ',
  -- ISO country code.  'TZ' for Tanzania; 'KE', 'UG' for future V4 packs.
  industry_pack                  TEXT           NULL,
  -- NULL = applies to all industries.
  -- Non-null = industry-specific override (e.g. 'tourism', 'mining').
  effective_from                 DATE           NOT NULL,
  effective_to                   DATE           NULL,
  -- NULL = currently active.  Set automatically by the trigger when a new
  -- version is inserted for the same trigger_category/jurisdiction/pack.

  -- Governance
  notes                          TEXT           NULL,
  verified_at                    TIMESTAMPTZ    NULL,
  verified_by                    UUID           NULL,
  -- UUID of the staff member / counsel who confirmed the rule is current.

  created_at                     TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT statutory_rules_pk PRIMARY KEY (id),

  -- Either a percentage rate OR a threshold amount must be provided.
  CONSTRAINT chk_rate_or_threshold
    CHECK (rate_is_threshold = true OR rate_pct IS NOT NULL),

  -- Threshold-based rules must supply the threshold amount.
  CONSTRAINT chk_threshold_has_amount
    CHECK (rate_is_threshold = false OR threshold_amount IS NOT NULL),

  -- effective_to, if set, must be strictly after effective_from.
  CONSTRAINT chk_effective_dates
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE public.statutory_rules IS
  'Versioned, effective-dated statutory obligation rules. Shared reference '
  'data — not user-owned. INSERT/UPDATE/DELETE restricted to service role; '
  'substantive fields are immutable after insert.';

ALTER TABLE public.statutory_rules ENABLE ROW LEVEL SECURITY;

-- Effective-dating trigger
CREATE TRIGGER trg_close_prior_statutory_rule
BEFORE INSERT ON public.statutory_rules
FOR EACH ROW
EXECUTE FUNCTION public.close_prior_statutory_rule();

-- ── RLS policies ─────────────────────────────────────────────────────────

-- SELECT: all authenticated users may read rules (shared reference data).
CREATE POLICY "Authenticated users can read statutory rules"
ON public.statutory_rules
FOR SELECT
TO authenticated
USING (true);

-- No INSERT / UPDATE / DELETE policies for the `authenticated` role.
-- Rule management is performed via the service role key only.

-- ── Indexes ───────────────────────────────────────────────────────────────

-- Partial UNIQUE index enforcing at most one active (effective_to IS NULL)
-- rule per (trigger_category, jurisdiction, industry_pack).
-- NULLS NOT DISTINCT (PostgreSQL 15+) means two rows where industry_pack
-- IS NULL are treated as duplicates — only one default rule per
-- category/jurisdiction may be active at a time.
-- Also serves as the primary fast-path lookup for the rules engine.
CREATE UNIQUE INDEX uq_statutory_rule_active
ON public.statutory_rules (trigger_category, jurisdiction, industry_pack)
NULLS NOT DISTINCT
WHERE effective_to IS NULL;

-- Full history index for reconciliation queries that need a specific
-- historical rule version: "which rule applied in period X?"
CREATE INDEX idx_statutory_rules_history
ON public.statutory_rules (trigger_category, jurisdiction, effective_from, effective_to);


-- ════════════════════════════════════════════════════════════
-- 2.  efdms_records
-- ════════════════════════════════════════════════════════════
--
-- One row per EFDMS transaction ingested for a company.
-- APPEND-ONLY: no UPDATE or DELETE policies for any role.
-- Idempotency enforced by UNIQUE(company_id, efdms_transaction_id).

CREATE TABLE public.efdms_records (
  id                    UUID           NOT NULL DEFAULT gen_random_uuid(),

  -- Ownership
  company_id            UUID           NOT NULL,
  -- FK → companies.id; ON DELETE RESTRICT because deleting a company while
  -- EFDMS records exist would destroy financial evidence.

  -- EFDMS identity
  efdms_transaction_id  TEXT           NOT NULL,
  -- The TRA-assigned transaction identifier from the EFDMS feed.
  -- Combined with company_id as the idempotency key (see UNIQUE below).

  record_type           TEXT           NOT NULL,
  -- 'sale' or 'purchase' — the two EFDMS streams.

  -- Date / period
  transaction_date      DATE           NOT NULL,
  period_year           INTEGER        NOT NULL,
  period_month          INTEGER        NOT NULL,
  -- Denormalized from transaction_date for fast period-range queries.
  -- Enforced consistent with transaction_date by chk_period_consistency.

  -- Amounts (TZS, NUMERIC(20,2) per architecture doc)
  amount_tzs            NUMERIC(20,2)  NOT NULL,
  vat_amount_tzs        NUMERIC(20,2)  NOT NULL DEFAULT 0,

  -- Counterparty (may be absent for some EFDMS transaction types)
  counterparty_tin      TEXT           NULL,
  counterparty_name     TEXT           NULL,

  -- Device and batch metadata
  efd_device_id         TEXT           NULL,
  source_batch_id       TEXT           NULL,
  -- Identifier for the import batch; allows batch-level rollback queries.

  -- Raw payload for audit / reprocessing
  raw_payload           JSONB          NULL,
  -- Full original EFDMS record as received; never modified after insert.

  -- Provenance
  ingested_by           UUID           NULL DEFAULT auth.uid(),
  -- Set server-side from JWT; NULL when ingested via service role pipeline.

  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT efdms_records_pk PRIMARY KEY (id),

  CONSTRAINT fk_efdms_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies (id)
    ON DELETE RESTRICT,

  -- Idempotency: re-ingesting the same EFDMS transaction is a no-op.
  CONSTRAINT uq_efdms_idempotency
    UNIQUE (company_id, efdms_transaction_id),

  CONSTRAINT chk_efdms_record_type
    CHECK (record_type IN ('sale', 'purchase')),

  CONSTRAINT chk_efdms_period_month
    CHECK (period_month BETWEEN 1 AND 12),

  -- Enforce that denormalized period columns match transaction_date.
  CONSTRAINT chk_efdms_period_consistency
    CHECK (
      period_year  = EXTRACT(YEAR  FROM transaction_date)::INTEGER
      AND period_month = EXTRACT(MONTH FROM transaction_date)::INTEGER
    )
);

COMMENT ON TABLE public.efdms_records IS
  'Append-only store of EFDMS sales and purchase transactions per company. '
  'Idempotency enforced by UNIQUE(company_id, efdms_transaction_id). '
  'No UPDATE or DELETE policies exist for any role.';

ALTER TABLE public.efdms_records ENABLE ROW LEVEL SECURITY;

-- ── RLS policies ─────────────────────────────────────────────────────────

CREATE POLICY "Users can view EFDMS records for their companies"
ON public.efdms_records
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can ingest EFDMS records for their companies"
ON public.efdms_records
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- RESTRICTIVE defense-in-depth: ANDs unconditionally with all PERMISSIVE
-- policies.  Ensures a future misconfigured PERMISSIVE policy cannot grant
-- cross-company insert access regardless of what it says.
CREATE POLICY "efdms_company_ownership_insert"
ON public.efdms_records AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- No UPDATE or DELETE policies — append-only financial evidence.

-- ── Indexes ───────────────────────────────────────────────────────────────

-- Required for the RLS join: every SELECT on efdms_records appends a
-- WHERE company_id IN (SELECT id FROM companies WHERE user_id = auth.uid()).
-- Without this index, the planner cannot efficiently resolve the semi-join.
CREATE INDEX idx_efdms_records_company_id
ON public.efdms_records (company_id);

-- Composite index for reconciliation queries: all sales for company X in
-- FY2024, all purchases for company Y in month M, etc.
CREATE INDEX idx_efdms_records_company_period
ON public.efdms_records (company_id, period_year, period_month, record_type);

-- Sparse index for batch-rollback queries.
CREATE INDEX idx_efdms_records_batch
ON public.efdms_records (source_batch_id)
WHERE source_batch_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════
-- 3.  findings
-- ════════════════════════════════════════════════════════════
--
-- One row per detected compliance variance or rule-trigger event.
-- APPEND-ONLY from a deletion standpoint: no DELETE policy exists.
-- Resolution is tracked by setting status = 'resolved', not by deleting.
--
-- Three FK relationships:
--   company_id        NOT NULL  → companies         ON DELETE RESTRICT
--   statutory_rule_id NULL      → statutory_rules   ON DELETE RESTRICT
--   upload_id         NULL      → trial_balance_uploads ON DELETE SET NULL
-- The upload_id RESTRICTIVE RLS mirrors the Fix-4 pattern applied to
-- trial_balance_uploads on account_corrections.

CREATE TABLE public.findings (
  id                       UUID           NOT NULL DEFAULT gen_random_uuid(),

  -- Ownership
  company_id               UUID           NOT NULL,
  -- FK → companies.id.  NOT NULL: every finding belongs to a company.

  -- Links to source evidence
  statutory_rule_id        UUID           NULL,
  -- FK → statutory_rules.id.  NULL for manual findings or EFDMS diffs
  -- that do not map to a specific named statutory obligation.
  -- ON DELETE RESTRICT: rule versions must not be deleted while
  -- findings reference them (preserves audit reproducibility).

  upload_id                UUID           NULL,
  -- FK → trial_balance_uploads.id.  NULL for EFDMS-vs-EFDMS diffs that
  -- don't require a trial-balance upload.
  -- ON DELETE SET NULL: if an upload is deleted, the finding survives
  -- (with upload_id cleared) rather than being cascade-deleted.

  -- Classification
  finding_type             TEXT           NOT NULL,
  -- 'efdms_diff'    — GL amount vs EFDMS amount variance
  -- 'rule_trigger'  — statutory obligation detected by rules engine
  -- 'manual'        — preparer-entered finding (TRA notice upload, etc.)

  title                    TEXT           NOT NULL,
  -- Short human-readable label, e.g. "Sales EFDMS variance Q1 2024".

  statute_reference        TEXT           NULL,
  -- Populated from statutory_rules.statute when finding_type='rule_trigger';
  -- may be manually entered for 'manual' findings.

  -- Period covered by this finding
  period_start             DATE           NOT NULL,
  period_end               DATE           NOT NULL,

  -- Financial amounts (all TZS, NUMERIC(20,2) per architecture doc)
  exposure_amount_tzs      NUMERIC(20,2)  NOT NULL,
  -- The total amount at risk / owed.  Always populated; the primary sort key
  -- for risk-prioritised portfolio dashboards.

  base_amount_tzs          NUMERIC(20,2)  NULL,
  -- GL or EFDMS base from which the obligation is calculated.
  comparison_amount_tzs    NUMERIC(20,2)  NULL,
  -- EFDMS or GL counter-value for diff findings; NULL for pure rule triggers.
  computed_obligation_tzs  NUMERIC(20,2)  NULL,
  -- Principal tax / levy obligation (before interest and penalty).
  interest_amount_tzs      NUMERIC(20,2)  NULL,
  penalty_amount_tzs       NUMERIC(20,2)  NULL,

  -- Calculation detail (stores the input variables used to compute the
  -- obligation, e.g. {"salary_base": 50000000, "months_delayed": 3}).
  source_detail            JSONB          NOT NULL DEFAULT '{}',

  -- Workflow
  status                   TEXT           NOT NULL DEFAULT 'open',
  -- 'open' | 'in_progress' | 'resolved' | 'disputed'

  response_pack_ready      BOOLEAN        NOT NULL DEFAULT false,
  -- Trigger-maintained flag.  Set to TRUE by trg_update_response_pack_ready
  -- when the linked evidence_request reaches current_step >= 3 (evidence
  -- received).  Application gate: check this flag before generating the
  -- PDF response pack.  Never set directly by application code.

  -- Cross-references
  related_finding_ids      UUID[]         NULL,
  -- Array of other finding IDs related to this one (e.g. SDL + WHT from
  -- the same payroll period).  Informational; no FK enforcement.

  -- TRA notice metadata (populated when finding is derived from a notice)
  tra_notice_ref           TEXT           NULL,
  assigned_to_user_id      UUID           NULL,
  tra_notice_date          DATE           NULL,

  -- Provenance
  created_by               UUID           NOT NULL DEFAULT auth.uid(),
  created_at               TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT findings_pk PRIMARY KEY (id),

  CONSTRAINT fk_findings_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_findings_statutory_rule
    FOREIGN KEY (statutory_rule_id)
    REFERENCES public.statutory_rules (id)
    ON DELETE RESTRICT,

  CONSTRAINT fk_findings_upload
    FOREIGN KEY (upload_id)
    REFERENCES public.trial_balance_uploads (id)
    ON DELETE SET NULL,

  CONSTRAINT chk_finding_type
    CHECK (finding_type IN ('efdms_diff', 'rule_trigger', 'manual')),

  CONSTRAINT chk_finding_status
    CHECK (status IN ('open', 'in_progress', 'resolved', 'disputed')),

  CONSTRAINT chk_finding_period_order
    CHECK (period_end >= period_start),

  CONSTRAINT chk_exposure_nonneg
    CHECK (exposure_amount_tzs >= 0)
);

COMMENT ON TABLE public.findings IS
  'One row per detected compliance variance or rule-trigger event. '
  'Append-only: no DELETE policy.  Resolution tracked via status = resolved. '
  'response_pack_ready is trigger-maintained — never set by application code.';

ALTER TABLE public.findings ENABLE ROW LEVEL SECURITY;

-- updated_at trigger (reuses the function defined in 20251208084402_*)
CREATE TRIGGER update_findings_updated_at
BEFORE UPDATE ON public.findings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS policies ─────────────────────────────────────────────────────────

-- SELECT: company-ownership chain.
CREATE POLICY "Users can view findings for their companies"
ON public.findings
FOR SELECT
TO authenticated
USING (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- INSERT PERMISSIVE: company must belong to the authenticated user.
CREATE POLICY "Users can create findings for their companies"
ON public.findings
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- INSERT RESTRICTIVE: upload_id, if set, must reference an upload owned by
-- the authenticated user.  Mirrors the Fix-4 RESTRICTIVE pattern.
-- IS NULL case permits EFDMS-diff findings that have no associated upload.
CREATE POLICY "findings_upload_ownership_insert"
ON public.findings AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  upload_id IS NULL
  OR upload_id IN (
    SELECT id FROM public.trial_balance_uploads WHERE user_id = auth.uid()
  )
);

-- UPDATE PERMISSIVE: company-ownership chain on both pre- and post-update row.
CREATE POLICY "Users can update findings for their companies"
ON public.findings
FOR UPDATE
TO authenticated
USING (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- UPDATE RESTRICTIVE: upload_id ownership on the post-update row.
-- Prevents a user from re-pointing upload_id to another user's upload.
CREATE POLICY "findings_upload_ownership_update"
ON public.findings AS RESTRICTIVE
FOR UPDATE
TO authenticated
WITH CHECK (
  upload_id IS NULL
  OR upload_id IN (
    SELECT id FROM public.trial_balance_uploads WHERE user_id = auth.uid()
  )
);

-- No DELETE policy for any role.

-- ── Indexes ───────────────────────────────────────────────────────────────

-- Required for the RLS join on every query against findings.
CREATE INDEX idx_findings_company_id
ON public.findings (company_id);

-- Dashboard query: open findings per company (partial — excludes resolved).
CREATE INDEX idx_findings_company_status
ON public.findings (company_id, status)
WHERE status <> 'resolved';

-- Period-range queries: "all findings for company X overlapping FY2024".
CREATE INDEX idx_findings_company_period
ON public.findings (company_id, period_start, period_end);

-- Group findings from the same TRA notice.
CREATE INDEX idx_findings_tra_notice
ON public.findings (tra_notice_ref)
WHERE tra_notice_ref IS NOT NULL;

-- Audit query: "which findings reference this rule version?"
CREATE INDEX idx_findings_statutory_rule
ON public.findings (statutory_rule_id)
WHERE statutory_rule_id IS NOT NULL;


-- ════════════════════════════════════════════════════════════
-- 4.  evidence_requests
-- ════════════════════════════════════════════════════════════
--
-- One row per finding (enforced by UNIQUE(finding_id)).
-- Tracks the six-step evidence collection and response workflow.
-- APPEND-ONLY from a deletion standpoint: no DELETE policy.
-- Each step has its own timestamp(s) and actor UUID columns.
--
-- RLS uses a two-hop ownership chain:
--   evidence_requests.finding_id
--     → findings.company_id
--     → companies.user_id = auth.uid()
-- Both PERMISSIVE and RESTRICTIVE policies carry WITH CHECK on UPDATE so
-- that a user cannot re-point finding_id to another user's finding in a
-- single UPDATE statement (USING checks pre-update row; WITH CHECK checks
-- post-update row independently).
--
-- The prevent_finding_id_change trigger provides an additional DB-layer
-- backstop making finding_id immutable regardless of RLS context.

CREATE TABLE public.evidence_requests (
  id                      UUID           NOT NULL DEFAULT gen_random_uuid(),

  -- One evidence request per finding; enforced by the UNIQUE below.
  -- UNIQUE(finding_id) creates an implicit B-tree index usable for all
  -- finding_id lookups — no separate idx_evidence_requests_finding_id
  -- is created (it would be redundant).
  finding_id              UUID           NOT NULL,

  -- Documents requested from the client (free-text list)
  documents_requested     TEXT[]         NOT NULL DEFAULT '{}',

  -- Current step in the six-step workflow (1–6)
  current_step            SMALLINT       NOT NULL DEFAULT 1,

  -- ── Step 1: Evidence Requested ──────────────────────────────────────
  step1_requested_at      TIMESTAMPTZ    NULL,
  step1_requested_by      UUID           NULL,
  -- The preparer who formally requested the evidence package.

  -- ── Step 2: Awaiting Client ─────────────────────────────────────────
  -- Step 2 begins automatically when step 1 completes; no explicit
  -- step2_started_at (step1_requested_at serves that purpose).
  step2_last_reminder_at  TIMESTAMPTZ    NULL,
  step2_reminder_count    SMALLINT       NOT NULL DEFAULT 0,
  -- Incremented each time the automated reminder engine re-notifies the client.

  -- ── Step 3: Evidence Received ────────────────────────────────────────
  step3_received_at       TIMESTAMPTZ    NULL,
  step3_received_by       UUID           NULL,
  -- The preparer who confirmed receipt.  Triggers response_pack_ready = true.

  -- ── Step 4: Preparer Review ──────────────────────────────────────────
  step4_review_started_at TIMESTAMPTZ    NULL,
  step4_reviewed_at       TIMESTAMPTZ    NULL,
  step4_reviewed_by       UUID           NULL,

  -- ── Step 5: Partner Sign-off ─────────────────────────────────────────
  step5_signoff_at        TIMESTAMPTZ    NULL,
  step5_signed_by         UUID           NULL,

  -- ── Step 6: Submitted to TRA ─────────────────────────────────────────
  step6_submitted_at      TIMESTAMPTZ    NULL,
  step6_submitted_by      UUID           NULL,
  step6_submission_ref    TEXT           NULL,
  -- TRA acknowledgement reference / receipt number.

  notes                   TEXT           NULL,

  -- Provenance
  created_by              UUID           NOT NULL DEFAULT auth.uid(),
  created_at              TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT evidence_requests_pk PRIMARY KEY (id),

  CONSTRAINT fk_evidence_finding
    FOREIGN KEY (finding_id)
    REFERENCES public.findings (id)
    ON DELETE RESTRICT,
  -- RESTRICT (not CASCADE): deleting a finding while an evidence request
  -- exists against it is almost certainly an application error.

  -- One evidence request per finding — the entire six-step workflow for
  -- a finding is tracked in a single row.
  CONSTRAINT uq_one_request_per_finding
    UNIQUE (finding_id),
  -- This UNIQUE constraint creates an implicit B-tree index on finding_id
  -- (named "uq_one_request_per_finding") that is fully usable for lookups.
  -- No separate index on finding_id is created.

  CONSTRAINT chk_current_step
    CHECK (current_step BETWEEN 1 AND 6),

  CONSTRAINT chk_step2_reminder_nonneg
    CHECK (step2_reminder_count >= 0)
);

COMMENT ON TABLE public.evidence_requests IS
  'Six-step evidence workflow tracker: one row per finding. '
  'finding_id is immutable after insert (enforced by trigger). '
  'No DELETE policy — the accumulated step history is the product moat.';

ALTER TABLE public.evidence_requests ENABLE ROW LEVEL SECURITY;

-- ── Triggers ──────────────────────────────────────────────────────────────

-- updated_at (reuses function from 20251208084402_*)
CREATE TRIGGER update_evidence_requests_updated_at
BEFORE UPDATE ON public.evidence_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- finding_id immutability
-- WHEN clause: only invoke the function when finding_id actually changes,
-- avoiding a function call overhead on every unrelated UPDATE.
-- IS DISTINCT FROM handles NULLs correctly (finding_id is NOT NULL, but
-- the idiom is correct practice).
CREATE TRIGGER trg_prevent_finding_id_change
BEFORE UPDATE ON public.evidence_requests
FOR EACH ROW
WHEN (NEW.finding_id IS DISTINCT FROM OLD.finding_id)
EXECUTE FUNCTION public.prevent_finding_id_change();

-- response_pack_ready maintenance
-- Fires AFTER INSERT (to sync initial state) and AFTER UPDATE (on any
-- column change that might represent a step transition).
-- The function itself reads current_step; firing on all updates is safe
-- since the cost is a single-row UPDATE on findings via the UNIQUE index.
CREATE TRIGGER trg_update_response_pack_ready
AFTER INSERT OR UPDATE ON public.evidence_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_finding_response_pack_ready();

-- ── RLS policies ─────────────────────────────────────────────────────────

-- SELECT: two-hop ownership chain.
CREATE POLICY "Users can view evidence requests for their findings"
ON public.evidence_requests
FOR SELECT
TO authenticated
USING (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
);

-- INSERT PERMISSIVE: two-hop chain.
-- The planner materialises auth.uid() once, resolves company IDs (indexed
-- on companies.user_id), then finding IDs (indexed on findings.company_id),
-- then evaluates the new row's finding_id against that set.
CREATE POLICY "Users can create evidence requests for their findings"
ON public.evidence_requests
FOR INSERT
TO authenticated
WITH CHECK (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
);

-- INSERT RESTRICTIVE: defense-in-depth.
-- ANDs unconditionally with all PERMISSIVE policies.  If a future
-- misconfigured PERMISSIVE policy somehow passes, this catches it.
CREATE POLICY "evidence_requests_finding_ownership_insert"
ON public.evidence_requests AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
);

-- UPDATE PERMISSIVE
-- USING  → evaluates pre-update row  (can the user touch this row?)
-- WITH CHECK → evaluates post-update row (is the new state valid?)
-- Both use the same two-hop chain.  The WITH CHECK independently catches
-- the adversarial finding_id re-point attack even if the immutability
-- trigger is somehow bypassed.
CREATE POLICY "Users can update evidence requests for their findings"
ON public.evidence_requests
FOR UPDATE
TO authenticated
USING (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
)
WITH CHECK (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
);

-- UPDATE RESTRICTIVE: defense-in-depth WITH CHECK on post-update values.
CREATE POLICY "evidence_requests_finding_ownership_update"
ON public.evidence_requests AS RESTRICTIVE
FOR UPDATE
TO authenticated
WITH CHECK (
  finding_id IN (
    SELECT id FROM public.findings
    WHERE company_id IN (
      SELECT id FROM public.companies WHERE user_id = auth.uid()
    )
  )
);

-- No DELETE policy for any role.

-- ── Indexes ───────────────────────────────────────────────────────────────

-- NOTE: UNIQUE(finding_id) above creates an implicit B-tree index named
-- "uq_one_request_per_finding".  PostgreSQL uses this index for all
-- finding_id lookups (equality, joins, RLS semi-joins).  A separate
-- idx_evidence_requests_finding_id would be a duplicate and is NOT created.

-- Partial index for firm-wide "outstanding items" dashboard view:
-- all evidence requests not yet submitted (steps 1–5 are open work).
CREATE INDEX idx_evidence_requests_outstanding
ON public.evidence_requests (current_step, step1_requested_at)
WHERE current_step < 6;

-- Sparse index for the automated reminder engine: find requests that have
-- been sent (step1_requested_at IS NOT NULL) but not yet received
-- (step3_received_at IS NULL), ordered by when they were originally sent.
CREATE INDEX idx_evidence_requests_awaiting_client
ON public.evidence_requests (step1_requested_at)
WHERE step1_requested_at IS NOT NULL
  AND step3_received_at  IS NULL;


-- ════════════════════════════════════════════════════════════
-- END OF MIGRATION
-- ════════════════════════════════════════════════════════════
--
-- NEXT STEPS (separate migrations, not part of this file):
--   1. Extend audit_action enum:
--        ALTER TYPE public.audit_action ADD VALUE 'reconciliation_run';
--        ALTER TYPE public.audit_action ADD VALUE 'evidence_requested';
--        ALTER TYPE public.audit_action ADD VALUE 'response_pack_generated';
--   2. Create edge functions for EFDMS ingestion pipeline, findings
--      generation engine, and evidence-request step-transition handlers.
--   3. Phase 3: add external_verification_status field to
--      trial_balance_uploads linking Kinga findings back to Axiom UI.
