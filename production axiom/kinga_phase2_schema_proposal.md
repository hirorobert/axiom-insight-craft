# Kinga Phase 2 — Schema Proposal
**Status: DRAFT — awaiting approval. No SQL has been executed.**
**Prepared against: engineering handoff brief, kinga_v2_corporate.html (Section 06 Functional Spec), tax_compliance_platform_architecture.md**

---

## Preflight: what this schema reuses vs. creates

Per the handoff brief, the following Axiom tables are reused directly — no new equivalent tables:

| Axiom table | Kinga use |
|---|---|
| `companies` | Client list. No separate `clients` table. |
| `account_mappings` | Rules engine reads `classification` enum values from here. |
| `audit_logs` | Extended with three new enum values: `reconciliation_run`, `evidence_requested`, `response_pack_generated`. (Separate migration, not touched here.) |
| `trial_balance_uploads` | Nullable FK target from `findings.upload_id`; `accounting_errors` JSONB field will be updated by Kinga's reconciliation engine per the Phase 3 integration contract. |

Four genuinely new tables: `statutory_rules`, `efdms_records`, `findings`, `evidence_requests`.

---

## Step 1 — Proposed Table Definitions

---

### Table 1: `statutory_rules`

**Purpose:** Versioned, effective-dated mapping of (trigger category → statute → obligation → rate). The rules engine reads from this table to decide what obligation a ledger entry or EFDMS diff creates. From the prototype rules engine view (Section 04): six active rules cover EFDMS variance diff, SDL at 4%, WHT on professional services at 5%, WHT on rent at 10%, stamp duty at 1%, and the EFD turnover threshold. The table must support future industry-specific packs (tourism levy, medical VAT treatment) as new rows without changing the core engine — per the functional spec: "new rows, not new code."

**Ownership model:** Statutory rules are shared reference data — they represent Tanzanian tax law, not a user's private data. Forcing a `user_id` onto this table would be wrong in the same way that forcing a `user_id` onto a currency exchange rate table would be wrong. This is the one deliberate, documented deviation from the user-owned-row pattern in this schema. See the RLS section for how this is handled safely.

```
id                        UUID          NOT NULL  DEFAULT gen_random_uuid()  PRIMARY KEY
trigger_category          TEXT          NOT NULL
    -- Human-readable description of what fires this rule.
    -- Matches the "Trigger" column in the prototype rules engine view.
    -- Examples: "Ledger: rent expense", "Payroll register",
    --           "EFDMS sales/purchase feed", "Document: lease agreement",
    --           "Turnover ≥ TZS 11M".
    -- This is TEXT not an enum because rule packs extend it with new
    -- industry triggers ("Ledger: tourism levy") without a schema migration.

trigger_account_classification  account_classification  NULL
    -- Optional link to the existing account_classification enum from
    -- account_mappings. Set this for ledger-triggered rules (e.g.
    -- "Ledger: rent expense" → classification 'operating_expenses').
    -- NULL for EFDMS-feed rules and document-triggered rules, which do
    -- not fire off a ledger account classification.
    -- This is how the rules engine and account_mappings integrate:
    -- a rule fires when an account_mappings row has a matching
    -- classification value for a given GL line. The handoff brief
    -- specifically calls this linkage out as the integration point.

statute                   TEXT          NOT NULL
    -- The specific legal authority. E.g. "ITA CAP 332 s.83(1)(c)",
    -- "SDL Act", "Stamp Duty Act, 1972". Free text to accommodate
    -- statute references that don't fit a clean enum (section numbers,
    -- amendment years). Displayed verbatim in the findings view under
    -- the finding title.

obligation                TEXT          NOT NULL
    -- What the rule requires. E.g. "Withholding tax",
    -- "Skills Development Levy", "Stamp duty", "Continuous variance diff".
    -- Also displayed in the findings view as the obligation label.

rate_pct                  NUMERIC(7,4)  NULL
    -- The applicable rate as a percentage. E.g. 10.0000 for WHT on rent,
    -- 4.0000 for SDL, 1.0000 for stamp duty. NULL for threshold-based
    -- rules where no fixed percentage applies.

rate_is_threshold         BOOLEAN       NOT NULL  DEFAULT false
    -- True for rules where the obligation is triggered by crossing a
    -- monetary threshold rather than applying a percentage.
    -- E.g. "Turnover ≥ TZS 11M → mandatory EFD device".
    -- When true, threshold_amount must be set; rate_pct is NULL.

threshold_amount          NUMERIC(20,2) NULL
    -- The TZS threshold value for threshold-based rules.
    -- E.g. 11,000,000.00 for the EFD device mandate.
    -- NULL for percentage-rate rules.

penalty_rate_pct          NUMERIC(7,4)  NULL
    -- Secondary penalty rate where the statute imposes one on top of the
    -- primary obligation. E.g. 200.0000 for the stamp duty 200% penalty
    -- on late payment. NULL for rules with no statutory penalty rate.
    -- Interest is computed separately at finding-creation time and stored
    -- in findings.interest_amount_tzs, not here.

jurisdiction              TEXT          NOT NULL  DEFAULT 'TZ'
    -- ISO country code. 'TZ' for Tanzania. Designed from day one for
    -- the V4 multi-country expansion (Kenya 'KE', Uganda 'UG').
    -- Every rule query must filter by jurisdiction to prevent a Kenya
    -- rule applying to a Tanzanian company.

industry_pack             TEXT          NULL
    -- NULL for base rules that apply to all industries.
    -- Set for industry-specific packs, e.g. 'tourism', 'medical'.
    -- The rules engine applies base rules (industry_pack IS NULL) plus
    -- any industry_pack rows matching the company's industry tag.
    -- This is the "new rows, not new code" extension mechanism from
    -- the functional spec.

effective_from            DATE          NOT NULL
    -- The first date on which this rule version applies.
    -- A reconciliation run selects the rule whose effective_from ≤ period
    -- date AND whose effective_to IS NULL OR ≥ period date.
    -- This is the core of the effective-dating guarantee: a 2024
    -- reconciliation always selects the rule active during 2024.

effective_to              DATE          NULL
    -- The last date on which this rule version applies.
    -- NULL means "currently in force".
    -- When a new rule version is inserted (e.g. SDL rate changes from
    -- 4% to 4.5%), a trigger sets effective_to on the prior active
    -- row to new_row.effective_from - 1 day. This is the ONLY permitted
    -- update to an existing rule row. The obligation, rate, statute, and
    -- all other substantive fields are immutable once set — corrections
    -- are always new rows with a new effective_from, never overwrites.
    -- This directly implements the architecture doc's requirement:
    -- "never destructively updated, so that a reconciliation run against
    -- 2024 data always uses 2024 rules even if rules change in 2026."

notes                     TEXT          NULL
    -- Free-form documentation about this rule version, e.g.
    -- "SDL rate raised by Finance Act 2025, effective 1 Jan 2026."
    -- Visible to firm administrators reviewing the rules engine.

verified_at               TIMESTAMPTZ   NULL
    -- When was this rule last verified against the actual statute text.
    -- Corresponds to the "Verified" column in the prototype rules engine
    -- view (e.g. "23 Jun 26"). NULL means unverified — the UI should
    -- warn if a rule is unverified before running a reconciliation.

verified_by               UUID          NULL
    -- The user (typically a partner or admin) who last verified this rule.
    -- FK to auth.users. Nullable because new/imported rules may start
    -- unverified.

created_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()

CONSTRAINT statutory_rules_pk PRIMARY KEY (id)
CONSTRAINT chk_rate_or_threshold
    CHECK (rate_is_threshold = true OR rate_pct IS NOT NULL)
    -- Every rule must either have a rate_pct or be a threshold rule.
    -- Prevents accidentally creating a rule with neither.
CONSTRAINT chk_threshold_has_amount
    CHECK (rate_is_threshold = false OR threshold_amount IS NOT NULL)
    -- Threshold rules must have the TZS amount set.
CONSTRAINT chk_effective_dates
    CHECK (effective_to IS NULL OR effective_to > effective_from)
    -- Sanity guard: closing date must be after opening date.
```

**Effective-dating mechanism in full:** When a rule changes (e.g. SDL rate increases), the process is:
1. INSERT a new `statutory_rules` row with the new `effective_from`, new `rate_pct`, and `effective_to = NULL`.
2. A `BEFORE INSERT` trigger fires and sets `effective_to = new_row.effective_from - 1` on any currently-active row with the same `trigger_category`, `jurisdiction`, and `industry_pack`. This is the only mutation ever made to an existing rule row, and it only modifies the interval metadata, never the substantive values (rate, statute, obligation).
3. Old rows are never deleted. A 2024 reconciliation run that queries `WHERE effective_from <= '2024-12-31' AND (effective_to IS NULL OR effective_to >= '2024-01-01')` will always retrieve the 2024 version of the rule, regardless of how many subsequent updates have occurred.

---

### Table 2: `efdms_records`

**Purpose:** Stores ingested EFDMS/EFD sales and purchase transaction records, per company, per period. These are the raw inputs to the reconciliation diff (Findings view, findings 1 and 2: "Sales per EFDMS" and "Total Purchases per EFD"). The architecture doc makes idempotency on ingestion a hard requirement: "duplicate processing must never double-count a transaction." The UNIQUE constraint on `(company_id, efdms_transaction_id)` is the primary enforcement mechanism.

```
id                        UUID          NOT NULL  DEFAULT gen_random_uuid()  PRIMARY KEY
company_id                UUID          NOT NULL
    -- FK → public.companies(id) ON DELETE RESTRICT.
    -- RESTRICT not CASCADE because deleting a company with ingested
    -- EFDMS records would destroy financial audit evidence. The company
    -- must be explicitly cleaned up through a controlled process, not
    -- cascaded away.

efdms_transaction_id      TEXT          NOT NULL
    -- The TRA-assigned identifier for this EFDMS transaction (receipt
    -- number, EFD serial + sequence, or equivalent). This is the
    -- idempotency key: if the same transaction is submitted twice (e.g.
    -- from a re-upload of the same EFDMS export batch), the UNIQUE
    -- constraint on (company_id, efdms_transaction_id) raises a conflict
    -- rather than silently inserting a duplicate, protecting the
    -- reconciliation totals.

record_type               TEXT          NOT NULL
    CHECK (record_type IN ('sale', 'purchase'))
    -- Whether this is an outgoing sale or an incoming purchase from the
    -- EFD/EFDMS perspective. Drives which side of the reconciliation diff
    -- this record contributes to.

transaction_date          DATE          NOT NULL
    -- The date of the transaction as reported by EFDMS.

period_year               INTEGER       NOT NULL
    -- Denormalized year from transaction_date. Stored explicitly to make
    -- period aggregation queries (e.g. "total sales for FY2024") fast
    -- without a date function in the WHERE clause, which would prevent
    -- index use.

period_month              INTEGER       NOT NULL  CHECK (period_month BETWEEN 1 AND 12)
    -- Denormalized month from transaction_date. Same rationale as
    -- period_year.

amount_tzs                NUMERIC(20,2) NOT NULL
    -- The transaction amount in Tanzanian Shillings. NUMERIC(20,2) gives
    -- 18 digits before the decimal — large enough for any realistic TZS
    -- amount (the largest finding in the prototype is ~TZS 103M; this
    -- handles up to TZS 10^18). No floating-point: financial amounts
    -- are always exact decimals.

vat_amount_tzs            NUMERIC(20,2) NOT NULL  DEFAULT 0
    -- VAT component of the transaction if separately identified in the
    -- EFDMS record. Zero if not applicable or not separately reported.

counterparty_tin          TEXT          NULL
    -- TIN of the buyer (for sales) or supplier (for purchases) as
    -- recorded in EFDMS. Useful for cross-referencing against TRA's
    -- records during an audit response.

counterparty_name         TEXT          NULL
    -- Name of the counterparty as recorded in EFDMS. Stored for
    -- human-readable traceability; TIN is the authoritative identifier.

efd_device_id             TEXT          NULL
    -- Serial number of the EFD/VFD device that generated this record,
    -- if available. Relevant for the "Turnover ≥ TZS 11M → mandatory
    -- fiscal device" rule check.

raw_payload               JSONB         NULL
    -- The full original ingested record exactly as received from the
    -- EFDMS export or API. Stored for complete traceability: the
    -- architecture doc requires that "given the same inputs and rule
    -- version, output must be identical every time" — this field makes
    -- that reproducible by preserving the source data.

source_batch_id           TEXT          NULL
    -- An identifier grouping records from the same import operation
    -- (e.g. a UUID generated at ingestion time for a CSV upload).
    -- Allows the ingestion layer to roll back an entire batch if a
    -- processing error is detected after partial insertion.

ingested_by               UUID          NULL  DEFAULT auth.uid()
    -- The user or service account that performed the ingestion.
    -- DEFAULT auth.uid() following the Fix 2 pattern from tonight:
    -- the server derives identity from the JWT, the client does not
    -- supply this in the payload. NULL-safe for ingestion via service
    -- role (Edge Functions running without a user JWT).

created_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()

CONSTRAINT efdms_records_pk PRIMARY KEY (id)
CONSTRAINT uq_efdms_idempotency UNIQUE (company_id, efdms_transaction_id)
    -- The idempotency constraint. Any attempt to insert a record with
    -- the same TRA transaction ID for the same company is rejected at
    -- the database layer, not silently dropped or overwritten.
```

**No UPDATE or DELETE policies.** Like `audit_logs`, EFDMS records are financial evidence. Once ingested, a record is immutable. Corrections are handled by: (1) a corrected record with a new `efdms_transaction_id`, or (2) a manual finding noting the discrepancy. The RLS plan specifies no UPDATE or DELETE policies for authenticated users.

---

### Table 3: `findings`

**Purpose:** One row per detected variance or rule trigger, for a specific company and period. Generated by either mechanism described in the functional spec: (a) a reconciliation diff between GL and EFDMS/EFD data, or (b) a statutory obligation triggered by a ledger account classification matching a rule. Every finding stores enough structured data to trace the number back to source records — the functional spec is explicit: "Every finding stores its source records, so a user can trace the number back to the original transactions, not just see a final figure."

The nullable FK to `trial_balance_uploads.id` is correct because findings of type `efdms_diff` can originate from EFDMS records compared against period-level GL figures without any trial balance upload being involved. The FK is set when the GL figures came from a specific upload (enabling drill-through to the Axiom side), and NULL when the comparison was done against direct ledger data.

```
id                        UUID          NOT NULL  DEFAULT gen_random_uuid()  PRIMARY KEY
company_id                UUID          NOT NULL
    -- FK → public.companies(id) ON DELETE RESTRICT.
    -- Primary ownership anchor for RLS. All access control flows through
    -- this column: "can the requesting user see this finding?" resolves
    -- to "does this company belong to them?". RESTRICT on delete for the
    -- same reason as efdms_records: findings are financial evidence and
    -- must not be cascade-deleted when a company record is modified.

statutory_rule_id         UUID          NULL
    -- FK → public.statutory_rules(id) ON DELETE RESTRICT.
    -- The specific rule version that was active during the finding's
    -- period and whose trigger fired (for rule_trigger findings), or the
    -- rule that defines the variance check (for efdms_diff findings —
    -- e.g. the "EFDMS sales/purchase feed → continuous variance diff"
    -- rule). Nullable because a manually-added finding (type 'manual',
    -- e.g. copied directly from a TRA notice before the rule is
    -- configured in the system) may not yet have a matching rule row.
    -- RESTRICT on delete because deleting a rule that a finding was
    -- evaluated against would break the audit trail.

upload_id                 UUID          NULL
    -- FK → public.trial_balance_uploads(id) ON DELETE SET NULL.
    -- Set when the GL figures for this finding came from a specific
    -- Axiom trial balance upload. Nullable because not every finding
    -- originates from a trial balance: EFDMS-vs-direct-ledger diffs
    -- do not. SET NULL on delete: if the upload is deleted, the finding
    -- is preserved (its own financial figures are stored here), but the
    -- direct link to the Axiom upload is severed.

finding_type              TEXT          NOT NULL
    CHECK (finding_type IN ('efdms_diff', 'rule_trigger', 'manual'))
    -- efdms_diff: source (a) — detected by reconciliation engine
    --   comparing GL vs EFDMS/EFD data. Findings 1 and 2 in prototype.
    -- rule_trigger: source (b) — fired by a ledger account classification
    --   matching a statutory_rules row. Findings 3–6 in prototype.
    -- manual: added directly from a TRA notice without going through
    --   the reconciliation engine (e.g. on first onboarding a client
    --   with an existing open notice).

title                     TEXT          NOT NULL
    -- Human-readable title, matching the prototype finding header format.
    -- E.g. "Sales: Accounts vs EFDMS variance" or
    -- "WHT on rent — unapplied". Entered by the engine or the preparer.

statute_reference         TEXT          NULL
    -- Denormalized copy of the relevant statute string for display
    -- purposes, e.g. "ITA CAP 332 s.82(1)". Copied from the linked
    -- statutory_rule at finding creation time. Denormalized so the
    -- findings view can display this without a JOIN, and so the display
    -- is stable even if the rule is later updated (new version inserted).

period_start              DATE          NOT NULL
    -- Start of the period covered by this finding. Using DATE not
    -- year/month integers to handle both monthly (2024-01-01 to
    -- 2024-01-31) and annual (2024-01-01 to 2024-12-31) findings
    -- within the same column.

period_end                DATE          NOT NULL
    -- End of the period covered by this finding.
    CONSTRAINT chk_period_order CHECK (period_end >= period_start)

-- Financial figures (top-level typed columns for aggregation queries)
exposure_amount_tzs       NUMERIC(20,2) NOT NULL
    -- The total amount at risk — the headline number shown in the
    -- findings view (e.g. TZS 289,302 for the sales variance finding,
    -- TZS 3,397,291 for SDL including interest). This is the number
    -- that drives the portfolio dashboard's "Open Exposure" total.
    -- Always positive; represents a liability or deficit.

base_amount_tzs           NUMERIC(20,2) NULL
    -- The GL-side or payroll-side base figure from which the obligation
    -- or variance derives. For efdms_diff: the GL amount (e.g. "Sales
    -- per Accounts: TZS 210,759,498"). For rule_trigger: the taxable
    -- base (e.g. "Salaries & wages: TZS 107,731,300").

comparison_amount_tzs     NUMERIC(20,2) NULL
    -- The EFDMS/EFD-side figure for efdms_diff findings (e.g. "Sales
    -- per EFDMS: TZS 211,048,800.05"). NULL for rule_trigger findings
    -- where there is no second-source figure to compare against.

computed_obligation_tzs   NUMERIC(20,2) NULL
    -- The statutory obligation amount before interest/penalty. For
    -- rule_trigger: e.g. "SDL computed: TZS 3,231,939" (= 4% × base).
    -- NULL for efdms_diff findings where the exposure is the variance
    -- itself, not a computed obligation.

interest_amount_tzs       NUMERIC(20,2) NULL
    -- Interest component of the total exposure, where the statute
    -- provides for interest on late payment. E.g. the difference
    -- between SDL computed (TZS 3,231,939) and SDL payable including
    -- interest (TZS 3,397,291) = TZS 165,352.

penalty_amount_tzs        NUMERIC(20,2) NULL
    -- Penalty component, where the statute imposes a separate penalty.
    -- E.g. stamp duty: TZS 236,000 (200% of TZS 118,000 stamp duty).
    -- Stored separately from interest so the response pack can
    -- itemize them distinctly, as TRA notices do.

source_detail             JSONB         NOT NULL  DEFAULT '{}'
    -- Full structured detail for traceability, flexible by finding_type.
    -- For efdms_diff: {"ledger_amount": ..., "efdms_amount": ...,
    --   "difference": ..., "efdms_record_ids": [...]}
    -- For rule_trigger: {"base_amount": ..., "rate_applied": ...,
    --   "months_delayed": ..., "interest_calc_basis": ...,
    --   "payroll_period": ..., "expense_lines": [...]}
    -- For manual: {"tra_notice_text": ..., "raw_finding": ...}
    -- The typed columns above are denormalized from this JSONB for
    -- query performance. source_detail is the authoritative source for
    -- the full calculation trace.

status                    TEXT          NOT NULL  DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'disputed'))
    -- open: finding detected, not yet actioned.
    -- in_progress: evidence workflow is active.
    -- resolved: response submitted to TRA and accepted.
    -- disputed: client or firm is contesting the finding.
    -- Findings are NEVER deleted. Close with status='resolved', not DELETE.

response_pack_ready       BOOLEAN       NOT NULL  DEFAULT false
    -- True when all linked evidence_requests for this finding have
    -- reached step 3 (Evidence Received) or beyond. Maintained
    -- automatically by a trigger on evidence_requests — never set
    -- directly by application code. The response pack generator checks
    -- this flag before proceeding. See "Response Pack Blocking" below.

related_finding_ids       UUID[]        NULL
    -- Array of other finding IDs that are related to this one.
    -- Used for cross-references like "Linked to Finding 6 (same lease
    -- document)" shown in the prototype. Array rather than a junction
    -- table because this is a lightweight display annotation, not a
    -- relationship with its own attributes.

tra_notice_ref            TEXT          NULL
    -- TRA notice reference number, e.g. "TRA/REF/2024-001". Allows
    -- all findings from the same TRA notice to be grouped and tracked
    -- against a single response deadline.

tra_notice_date           DATE          NULL
    -- Date of the TRA notice. Together with tra_notice_ref, establishes
    -- the 14-day statutory response window displayed in the prototype
    -- as "9 / 14 days remaining".

assigned_to_user_id       UUID          NULL
    -- The preparer assigned to this finding. FK to auth.users.
    -- Used for workflow routing and display (e.g. "assigned to
    -- J. Massawe" in the prototype evidence workflow panel).
    -- Not an RLS anchor — all firm members with access to the company
    -- can see all findings; assignment is a workflow concern, not an
    -- access control one.

created_by                UUID          NOT NULL  DEFAULT auth.uid()
    -- Who created this finding. DEFAULT auth.uid() per Fix 2 pattern:
    -- server-derived, client does not supply this.

created_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()
updated_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()

CONSTRAINT findings_pk PRIMARY KEY (id)
```

---

### Table 4: `evidence_requests`

**Purpose:** The six-step workflow tracker, one row per finding. From the functional spec: "Each finding has its own six-step tracked process: request, awaiting client, received, preparer review, partner sign-off, submitted." The spec also states: "every status change is timestamped" and "each step change is logged to the immutable audit trail with timestamp and actor." The schema implements this with a dedicated timestamp + actor column pair for each step, not a single status enum — so the audit trail shows the exact moment and person for every transition.

**One row per finding.** A finding can require multiple documents (e.g. the SDL finding needs both a payroll register and employment contracts). These are listed in `documents_requested` as a text array. The six workflow steps apply to the entire evidence collection for that finding, not to individual documents.

```
id                        UUID          NOT NULL  DEFAULT gen_random_uuid()  PRIMARY KEY
finding_id                UUID          NOT NULL
    -- FK → public.findings(id) ON DELETE RESTRICT.
    -- The finding this evidence workflow belongs to. RESTRICT on delete
    -- because deleting a finding with an active evidence workflow would
    -- destroy audit-trail records.
    -- UNIQUE(finding_id) is intentional: exactly one evidence_request
    -- per finding. If a finding's evidence needs to be re-requested
    -- (e.g. client sent wrong documents), the existing row is updated
    -- (resetting step3 columns and rolling back current_step), not a
    -- new row created. This preserves the complete history in the
    -- step-level timestamp columns.

documents_requested       TEXT[]        NOT NULL  DEFAULT '{}'
    -- List of document descriptions requested from the client.
    -- E.g. '{"EFDMS batch export (2024)"}' for Finding 1,
    -- '{"Payroll register FY2024 (12 monthly batches)",
    --   "Employment contracts for all 24 listed staff"}' for Finding 3.
    -- Text array rather than a child table because documents at this
    -- stage are descriptions, not tracked entities in their own right.
    -- A future evidence_documents child table can be added in Phase 3
    -- if individual document-level tracking is needed.

current_step              SMALLINT      NOT NULL  DEFAULT 1
    CHECK (current_step BETWEEN 1 AND 6)
    -- The current active step. Updated whenever a step transition occurs.
    -- Exists for efficient querying ("show all findings at step 2") and
    -- as the source for the portfolio dashboard's "Documents Outstanding"
    -- count. The step-level timestamp columns are the authoritative
    -- history; current_step is the denormalized present state.

-- ── Step 1: Evidence Requested ─────────────────────────────────────────────
step1_requested_at        TIMESTAMPTZ   NULL
    -- When the evidence request was sent to the client. Set when the
    -- preparer initiates the request. NULL before step 1 is triggered.

step1_requested_by        UUID          NULL
    -- The preparer (auth.users.id) who initiated the request.
    -- This is the "actor" record required by the functional spec.

-- ── Step 2: Awaiting Client ────────────────────────────────────────────────
-- Step 2 is entered automatically when step 1 completes (no separate
-- actor action). Tracked via reminder metadata rather than an entered-by
-- column, because the transition is automatic.

step2_last_reminder_at    TIMESTAMPTZ   NULL
    -- Timestamp of the most recent automated reminder sent to the client.
    -- The prototype shows "Reminder sent 22 Jun · 1 outstanding".
    -- Updated each time the reminder engine fires.

step2_reminder_count      SMALLINT      NOT NULL  DEFAULT 0
    -- Total number of reminders sent. Displayed in the workflow panel
    -- and used by the reminder engine to escalate or flag stale requests.

-- ── Step 3: Evidence Received ──────────────────────────────────────────────
step3_received_at         TIMESTAMPTZ   NULL
    -- When the evidence was confirmed received. This is the gate that
    -- triggers response_pack_ready on the parent finding (see trigger
    -- description below). NULL until the preparer or system marks
    -- evidence as received.

step3_received_by         UUID          NULL
    -- Who confirmed receipt (typically the preparer).

-- ── Step 4: Preparer Review ────────────────────────────────────────────────
step4_review_started_at   TIMESTAMPTZ   NULL
    -- When the preparer began reviewing the received evidence. Separate
    -- from step3_received_at because review may start some time after
    -- receipt (e.g. preparer picks it up the next morning).

step4_reviewed_at         TIMESTAMPTZ   NULL
    -- When the preparer completed their review and the response draft
    -- was finalised. This is the gate before step 5.

step4_reviewed_by         UUID          NULL
    -- The preparer who completed the review.

-- ── Step 5: Partner Sign-off ───────────────────────────────────────────────
step5_signoff_at          TIMESTAMPTZ   NULL
    -- When the partner signed off the response. The architecture doc
    -- specifies "segregation of duties supported in the product itself
    -- (preparer vs. approver roles)" — this column is the database
    -- record of that segregation. No submission to TRA is possible
    -- without this timestamp being set.

step5_signed_by           UUID          NULL
    -- The partner (auth.users.id) who signed off. The application layer
    -- must verify this user has the 'partner' role before allowing this
    -- field to be set.

-- ── Step 6: Submitted to TRA ──────────────────────────────────────────────
step6_submitted_at        TIMESTAMPTZ   NULL
    -- When the response pack was submitted to TRA. The final step.
    -- Setting this triggers status='resolved' on the parent finding
    -- (or 'disputed' if TRA rejects — handled in application logic).

step6_submitted_by        UUID          NULL
    -- Who performed the submission.

step6_submission_ref      TEXT          NULL
    -- TRA's acknowledgement reference for the submission, if provided.
    -- Stored for future dispute resolution.

notes                     TEXT          NULL
    -- Free-form notes on this evidence request. E.g. "Client contacted
    -- via WhatsApp on 22 Jun — confirmed sending documents by Friday."

created_by                UUID          NOT NULL  DEFAULT auth.uid()
    -- Per Fix 2 pattern. Server-derived from JWT.

created_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()
updated_at                TIMESTAMPTZ   NOT NULL  DEFAULT now()

CONSTRAINT evidence_requests_pk PRIMARY KEY (id)
CONSTRAINT uq_one_request_per_finding UNIQUE (finding_id)
    -- Exactly one evidence workflow per finding. See rationale above.
```

---

### Response Pack Blocking — Design Decision

**Question:** How to enforce at the database level that a response pack cannot be generated/exported while linked evidence is still outstanding?

**Decision: trigger-maintained `findings.response_pack_ready` flag, enforced by the application layer gate.**

**Why not a CHECK constraint?** A CHECK constraint can only reference columns in its own table. The evidence state lives in `evidence_requests`; the export action applies to a finding or a future `response_packs` table. No CHECK constraint can reach across this boundary. Ruled out as primary enforcement.

**Why not pure application layer?** The application layer (an Edge Function, an API route) is the right place for the business logic check, but it is the wrong place to be the *sole* enforcement. Direct Supabase client calls, future admin tools, or an Edge Function bug can all bypass an application-layer-only gate. The architecture doc is explicit that enforcement must be at the database layer for a system holding client financial records.

**Recommended design:**

A `BEFORE UPDATE` trigger on `evidence_requests` fires whenever `current_step` changes. It recalculates `findings.response_pack_ready` for the parent finding:

- Sets `findings.response_pack_ready = true` if the evidence_request's `current_step >= 3` (Evidence Received or beyond), meaning evidence is in hand.
- Sets `findings.response_pack_ready = false` if the step regresses below 3 (e.g. more evidence is needed — unlikely but possible).

The response pack generator (Edge Function or application route) then:
1. Fetches the finding and checks `response_pack_ready = true` before proceeding. If false, returns an error.
2. Optionally: a `BEFORE INSERT` trigger on a future `response_packs` table performs the same check at the DB layer — a hard block that cannot be bypassed even by direct DB writes.

**Why a trigger over an EXCLUSION constraint or other DB mechanism?** The constraint that needs to be checked (`all evidence received`) depends on the state of a related row in `evidence_requests`, not on the values of columns in the same table or a simple domain check. A trigger is the correct tool for cross-table derived state in PostgreSQL. The cost is low: `response_pack_ready` is recomputed only when evidence step state changes, which is an infrequent operation.

**Summary:** trigger keeps the flag current, application layer reads it. Defense in depth. Neither alone is sufficient; together they are.

---

## Step 2 — RLS Plan (prose, no SQL)

All four new tables follow the corrected patterns established tonight. The central principle: ownership chains must be verified through `companies`, not by a bare `user_id` on the row itself. RESTRICTIVE policies are used wherever a foreign key introduces a cross-ownership risk that a PERMISSIVE policy cannot safely close.

---

### `statutory_rules` — shared reference data, not user-owned

**Rationale for deviation from user-owned-row pattern:** Statutory rules represent Tanzanian tax law. Every authenticated user of the system — regardless of which company they manage — must be able to read the same rule set. A `user_id` on this table would be both wrong (one user does not "own" a law) and harmful (each user would create their own rule set, defeating the versioned, firm-wide rules engine entirely).

**SELECT:** A single PERMISSIVE policy grants SELECT to all `authenticated` users with no `USING` condition beyond role membership. Any logged-in user can read any rule. This is intentional and correct.

**INSERT / UPDATE / DELETE:** No policies exist for the `authenticated` role. The Supabase `anon` and `authenticated` roles cannot modify rules. The service role key — used only in Supabase Edge Functions running server-side — bypasses RLS and manages rule data. This means rule management is an admin-only operation in Phase 2: new rule versions are added by the Kinga team via a controlled process, not by end users through the UI. This directly implements the architecture doc's requirement that "statutory rule engine requires ongoing legal maintenance, not just initial build."

This is the only table in the Kinga schema with this access pattern. It is documented explicitly here so future engineers do not mistake the absence of INSERT policies for an oversight.

---

### `efdms_records` — company-chained ownership, append-only

**SELECT:** PERMISSIVE policy checks `company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())`. Users see only EFDMS records for companies they own. This is the canonical companies-ownership chain from the corrected Axiom RLS patterns.

**INSERT:** Two-policy pattern mirroring `uploads_company_ownership_insert` from tonight's Fix 3.

The PERMISSIVE INSERT policy checks `company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())`. This is the baseline: users can only ingest records for their own companies.

A RESTRICTIVE INSERT policy applies the same check independently: `company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())`. Why RESTRICTIVE when the PERMISSIVE check is identical? Because the EFDMS ingestion path may be an Edge Function that accepts `company_id` in the payload. Without a RESTRICTIVE policy, if a second PERMISSIVE policy were ever added for a different purpose (e.g., a service role path that's misconfigured), the OR-based semantics of PERMISSIVE policies could allow a cross-company write. The RESTRICTIVE policy ANDs with all PERMISSIVE policies unconditionally, closing that future gap before it can open — exactly the reasoning applied to Fix 3 tonight.

**UPDATE / DELETE:** No policies. EFDMS records are append-only financial evidence. A user cannot modify or delete an ingested transaction record. Corrections go through findings and response packs, not overwrites. Same design as `audit_logs`.

---

### `findings` — company-chained ownership, with nullable-FK RESTRICTIVE policy

**SELECT:** PERMISSIVE policy checks `company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())`. Same pattern as `efdms_records`.

**INSERT:** Two policies.

PERMISSIVE INSERT: `company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())`.

RESTRICTIVE INSERT for `upload_id` ownership: `upload_id IS NULL OR upload_id IN (SELECT id FROM public.trial_balance_uploads WHERE user_id = auth.uid())`. This closes exactly the gap class identified and fixed tonight for `account_corrections` (Fix 4): without this RESTRICTIVE policy, any authenticated user who knows another user's `trial_balance_upload` UUID could link a finding to it. With `upload_id` nullable, the `IS NULL` branch is essential — it allows findings that have no upload association to pass through without error. This is the `corrections_upload_ownership_insert` pattern applied to `findings`.

`statutory_rule_id` does NOT need a RESTRICTIVE ownership policy because statutory rules are shared reference data — there is no per-user ownership to verify. Any authenticated user can reference any rule in a finding.

**UPDATE:** PERMISSIVE policy checks the same `company_id` chain. The expected mutations are `status` updates (open → in_progress → resolved), `response_pack_ready` trigger updates, and `tra_notice_ref` / `assigned_to_user_id` edits. The RESTRICTIVE `upload_id` check also applies to UPDATE to prevent a user from re-linking a finding to another user's upload.

**DELETE:** No policy. Findings are permanent records. Status `resolved` is the close mechanism, not deletion.

---

### `evidence_requests` — two-hop ownership chain through findings → companies

`evidence_requests` has no `company_id` column and no `user_id` column. Its ownership must be established by chaining through `findings` → `companies`. This is one hop deeper than anything in the existing Axiom schema, but the pattern is structurally identical — it just applies the chain recursively.

**SELECT:** PERMISSIVE policy: `finding_id IN (SELECT id FROM public.findings WHERE company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid()))`. A user sees evidence_requests only for findings that belong to companies they own.

**INSERT:** Two policies.

PERMISSIVE INSERT: same two-hop chain as SELECT.

RESTRICTIVE INSERT: same two-hop chain. This closes the same gap class as `corrections_upload_ownership_insert` at one level deeper: without the RESTRICTIVE policy, a user who knows another user's `finding_id` UUID could create an evidence_request against their finding — inserting into someone else's workflow. The RESTRICTIVE policy prevents this regardless of how many PERMISSIVE policies exist.

**UPDATE:** PERMISSIVE policy using the same two-hop chain. Step transitions (updating `current_step`, setting step timestamp columns) are the primary update path. The trigger that maintains `findings.response_pack_ready` fires as a side-effect of these updates.

**DELETE:** No policy. Evidence requests are the workflow audit trail — the accumulated history of who requested what, when, and what reminders were sent. This history is what the functional spec describes as the product's switching-cost moat: "it isn't the reconciliation math, it's the accumulated record of every request, reminder, and response across every client and every finding — switching tools means losing that trail."

---

## Step 3 — Combined Schema + RLS Summary for Review

### New tables

| Table | Rows owned by | RLS anchor | Append-only? |
|---|---|---|---|
| `statutory_rules` | Nobody (shared ref data) | None — SELECT open to all `authenticated`, no write policies for authenticated role | No (admin-managed) |
| `efdms_records` | User via company | `company_id → companies.user_id` | Yes — no UPDATE/DELETE policies |
| `findings` | User via company | `company_id → companies.user_id` | No — status updates allowed; no DELETE |
| `evidence_requests` | User via finding → company | `finding_id → findings.company_id → companies.user_id` | No — step updates allowed; no DELETE |

### RESTRICTIVE policies (cross-FK ownership verification)

| Table | RESTRICTIVE policy covers | Closes which gap |
|---|---|---|
| `efdms_records` | `company_id` on INSERT/UPDATE | User cannot ingest records for a company they don't own |
| `findings` | `company_id` on INSERT/UPDATE | User cannot create findings for a company they don't own |
| `findings` | `upload_id IS NULL OR upload_id → user's own uploads` | User cannot link a finding to another user's trial balance upload |
| `evidence_requests` | `finding_id → user's own findings` (two-hop) | User cannot create/update evidence requests on another user's findings |

### Effective-dating guarantee

A reconciliation run against period P applies the rule where `effective_from ≤ P AND (effective_to IS NULL OR effective_to ≥ P)`. Old rule rows are never updated in their substantive values. `effective_to` is the only column a trigger may set on an existing rule row, and only to close an interval. Rate, obligation, and statute values are immutable from the moment of INSERT.

### Response pack blocking

`findings.response_pack_ready` is maintained by a trigger on `evidence_requests`. The application layer checks this flag before generating any response pack. No response pack can be assembled while `current_step < 3` for the linked evidence request.

### Existing tables untouched

No existing migration files, no existing table definitions, no frontend code has been modified. The `audit_action` enum extension (`reconciliation_run`, `evidence_requested`, `response_pack_generated`) is planned as a separate migration and is not included here.

---

*Awaiting approval before any `CREATE TABLE`, `CREATE POLICY`, or other database statement is executed.*
