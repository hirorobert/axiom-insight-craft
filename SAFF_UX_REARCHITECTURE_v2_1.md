# SAFF ERP — IRON DOME NUCLEAR UX RE-ARCHITECTURE
## Version 2.1 · Final Architecture · 2026-07-13

> **BASIS:** Version 2.0 was conditionally approved. This document applies 11 mandatory amendments before implementation authority is granted. No code. No file modifications. This document supersedes v2.0.

---

# DELIVERABLE 1 — AMENDED ANNUAL ENGAGEMENT LIFECYCLE

## 1.1 Revised State Machine

```
ONBOARDING
    │  Trigger: engagement record created; company + fiscal_year assigned
    │  Authority: transition_engine.advance()
    ▼
DATA_INTAKE
    │  Trigger: process-trial-balance completes; upload_hash recorded
    │  Authority: transition_engine.advance()
    ▼
RECONCILED
    │  Trigger: SAFISHA gate passes; all exceptions resolved or documented
    │  Authority: transition_engine.advance() — safisha-score fires this
    ▼
DRAFT_STATEMENTS_READY
    │  Trigger: FS Renderer completes first run; statement_version = 1
    │           Management inputs registered (may be empty at this stage)
    │  Authority: transition_engine.advance()
    ▼
DRAFT_HESABU_PASSED
    │  Trigger: hesabu-validate(context=draft) → all H-01 to H-12 pass
    │           Validation record stored with statement_version, input_hash
    │           This is an advisory checkpoint — NOT a sign-off gate
    │  Authority: transition_engine.advance() — hesabu-validate fires this
    ▼
TAX_COMPUTED_DRAFT                              ← NEW in v2.1
    │  Trigger: KINGA commits computation; tax_computations row written
    │           Statutory rate versions recorded at time of commit
    │           Gated items flagged (rates unverified, debt inputs missing, etc.)
    │  Authority: transition_engine.advance() — kinga-tax-engine fires this
    ▼
TAX_FINALIZED                                   ← NEW in v2.1
    │  Trigger: CPA explicitly finalizes:
    │           - all workpapers reviewed and annotated
    │           - no unresolved gated item affecting the tax result
    │           - statutory rule versions frozen at this computation version
    │           - tax AJEs generated from this exact computation version
    │           - tax_computation_finalized_at and finalized_by recorded
    │           Transition blocked if any GATED item has no resolution record
    │  Authority: transition_engine.advance() — requires cpa or partner role
    ▼
TAX_ADJUSTMENTS_APPLIED
    │  Trigger: All KINGA-generated tax AJEs reviewed by CPA
    │           Approved AJEs written to adjusting_journal_entries
    │           approved_aje_set_hash computed from the full approved set
    │           Rejected AJEs recorded with rejection reason (audit trail)
    │  Authority: transition_engine.advance() — requires cpa or partner role
    ▼
STATEMENT_SNAPSHOT_CREATED                      ← NEW in v2.1
    │  Trigger: FS Renderer re-runs incorporating all approved tax AJEs
    │           Snapshot sealed: statements_json + snapshot_hash persisted
    │           statement_snapshots row created and locked (immutable)
    │           All downstream artifacts MUST reference this snapshot_id
    │  Authority: transition_engine.advance() — FS Renderer fires this
    ▼
FINAL_HESABU_PASSED
    │  Trigger: hesabu-validate(context=final, snapshot_id=X)
    │           Validates the snapshot — not a dynamic render
    │           Result bound to snapshot_id; stale if snapshot superseded
    │           All H-01 to H-12 must pass; no advisory failures
    │  Authority: transition_engine.advance() — hesabu-validate fires this
    ▼
STATEMENTS_SIGNED
    │  Trigger: Tier 1 → Tier 2 → Tier 3 sign-off chain complete
    │           Each signature references statement_snapshot_id explicitly
    │           Separation-of-duties constraints enforced (Section 7)
    │           Period locked: no further AJEs, no new snapshots, no re-render
    │           A superseding snapshot invalidates all unsigned tiers
    │  Authority: transition_engine.advance() — DB trigger fires on Tier 3
    ▼
TAX_SIGNED
    │  Trigger: Tax sign-off chain complete (may differ from FS signatories)
    │           Tax sign-off also references snapshot_id (statements unchanged)
    │  Authority: transition_engine.advance() — DB trigger fires on tax approval
    ▼
FILING_PACKAGE_READY
    │  Trigger: filing_packages row created with all three components:
    │           disclosure_notes_id (approved), management_letter_id (if applicable),
    │           xbrl_instance_id (state=VALIDATED)
    │           All components reference same statement_snapshot_id
    │           TRA checklist: all applicable gates pass
    │           package_hash computed; package_version assigned
    │  Authority: transition_engine.advance()
    ▼
READY_FOR_MANUAL_SUBMISSION
    │  Trigger: CPA downloads package; confirms package is complete
    │           System records package_downloaded_at; does not submit
    │  Authority: transition_engine.advance() — CPA action required
    ▼
FILED
       Trigger: CPA records submission evidence in filing_submissions:
               return_type, submission_reference, submitted_at, submitted_by,
               acknowledgement_file_id, acknowledgement_hash, submission_channel
               filing_submissions.package_version must match current package
       Authority: transition_engine.advance() — requires cpa or partner role
```

## 1.2 Invalidation Cascade

If any of the following occur after STATEMENT_SNAPSHOT_CREATED, a cascade fires:

```
Change Event                        → Effect
─────────────────────────────────────────────────────────────────────────
New tax computation committed       → TAX_COMPUTED_DRAFT (regression)
                                      Existing snapshot superseded
                                      All unsigned sign-off tiers void
                                      Final HESABU result stale
                                      Unsigned filing packages void
                                      XBRL instances in DRAFT/GENERATED state void

Management input changed            → STATEMENT_SNAPSHOT_CREATED (regression)
                                      New snapshot required
                                      Same tax computation may be reused
                                      but snapshot_hash changes

AJE set changed (after finalization)→ TAX_ADJUSTMENTS_APPLIED (regression)
                                      New snapshot required
                                      Tax finalization may still stand
                                      but aje_set_hash changes

HESABU engine redeployed            → Final HESABU result stale (stale_reason=engine_updated)
                                      Snapshot itself remains valid
                                      HESABU must re-run against same snapshot

Snapshot signed (Tier 3)            → Immutable. No regression permitted.
                                      A new engagement year must be created
                                      for any post-sign-off correction.
```

## 1.3 Permitted Regressions (Before Sign-Off)

| From State | To State | Trigger | Who May Trigger |
|---|---|---|---|
| DRAFT_HESABU_PASSED | DRAFT_STATEMENTS_READY | Management input changed | accountant, cpa |
| TAX_COMPUTED_DRAFT | TAX_COMPUTED_DRAFT | Re-commit (new version) | cpa, partner |
| TAX_FINALIZED | TAX_COMPUTED_DRAFT | CPA reverts finalization | cpa, partner (with reason) |
| TAX_ADJUSTMENTS_APPLIED | TAX_FINALIZED | AJE rejected | cpa |
| STATEMENT_SNAPSHOT_CREATED | TAX_ADJUSTMENTS_APPLIED | Snapshot invalidated by tax change | system (cascade) |
| FINAL_HESABU_PASSED | STATEMENT_SNAPSHOT_CREATED | HESABU stale (engine updated) | system |
| FILING_PACKAGE_READY | TAX_SIGNED | New XBRL instance required (taxonomy change) | cpa, partner |

## 1.4 Blocked Transitions — Iron Dome

```
RECONCILED               →→ STATEMENTS_SIGNED       BLOCKED (must pass all intermediate states)
DRAFT_HESABU_PASSED      →→ STATEMENTS_SIGNED       BLOCKED (tax must complete + snapshot required)
TAX_COMPUTED_DRAFT       →→ STATEMENT_SNAPSHOT_CREATED BLOCKED (must reach TAX_FINALIZED first)
TAX_FINALIZED            →→ STATEMENTS_SIGNED       BLOCKED (AJEs + snapshot + final HESABU required)
STATEMENT_SNAPSHOT_CREATED →→ STATEMENTS_SIGNED     BLOCKED (final HESABU must pass against snapshot)
FILING_PACKAGE_READY     →→ FILED                   BLOCKED (filing_submissions evidence required)
[Any state]              →→ FILED                   BLOCKED without filing_submissions record
[Any state] via frontend →→ [Any state]             BLOCKED (transitions only via transition_engine)
```

---

# DELIVERABLE 2 — IMMUTABLE STATEMENT SNAPSHOT MODEL

## 2.1 Purpose

No person may review, validate, sign, or file dynamically rendered statements. Every approval act — HESABU validation, sign-off, PDF export, disclosure notes generation, XBRL generation, filing package assembly — must reference a single immutable snapshot. If the snapshot changes, a new snapshot is created and all approval acts must start over.

## 2.2 Snapshot Record

```
statement_snapshots {
  -- Identity
  id                        UUID PK
  engagement_id             UUID FK → engagements NOT NULL
  statement_version         INTEGER NOT NULL    -- monotonic per engagement

  -- Source provenance (what went into this snapshot)
  source_upload_id          UUID FK → trial_balance_uploads NOT NULL
  source_upload_hash        TEXT NOT NULL       -- SHA-256 of uploaded TB file
  tax_computation_id        UUID FK → tax_computations NOT NULL
  tax_computation_version   INTEGER NOT NULL    -- version within that computation
  approved_aje_set_hash     TEXT NOT NULL       -- SHA-256 of all approved AJE IDs + versions
  management_input_hash     TEXT NOT NULL       -- SHA-256 of management input values
  reporting_framework       TEXT NOT NULL       -- FULL_IFRS | IFRS_FOR_SMES | IPSAS_ACCRUAL | IPSAS_CASH
  renderer_version          TEXT NOT NULL       -- semver of FS Renderer at time of run

  -- The statements (immutable after creation)
  statements_json           JSONB NOT NULL      -- full statement data: SFP, P&L, SCF, SOCIE
  statement_hash            TEXT NOT NULL       -- SHA-256 of statements_json (integrity check)
  snapshot_hash             TEXT NOT NULL       -- SHA-256 of all fields above combined

  -- Versioning chain
  supersedes_snapshot_id    UUID FK → statement_snapshots   -- null if first version
  superseded_at             TIMESTAMPTZ         -- set when a newer snapshot is created
  superseded_by_id          UUID FK → statement_snapshots

  -- Status
  is_current                BOOLEAN NOT NULL DEFAULT TRUE
  status                    TEXT NOT NULL DEFAULT 'ACTIVE'
                            CHECK IN ('ACTIVE','SUPERSEDED','SIGNED')
  signed_at                 TIMESTAMPTZ         -- set on Tier 3 sign-off
  locked                    BOOLEAN NOT NULL DEFAULT FALSE  -- TRUE after Tier 3 sign-off

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL
  created_by_function       TEXT NOT NULL       -- 'fs-renderer' always; never a user
  renderer_request_id       TEXT NOT NULL       -- request_id from FS Renderer invocation

  CONSTRAINT snapshot_hash_unique UNIQUE (snapshot_hash)
  CONSTRAINT no_self_supersede CHECK (supersedes_snapshot_id <> id)
}
```

## 2.3 Append-Only Enforcement

```sql
-- Enforced by trigger: no UPDATE or DELETE on statement_snapshots
-- Exception: superseded_at, superseded_by_id, status, signed_at, locked
-- may be set in one direction only (NULL → value; never value → NULL)
-- statements_json and snapshot_hash are permanently immutable after INSERT
```

## 2.4 Downstream References

Every downstream artifact must carry `statement_snapshot_id`:

| Artifact | Field | Constraint |
|---|---|---|
| hesabu_validations (final) | statement_snapshot_id | NOT NULL when context='final' |
| statement_sign_offs | statement_snapshot_id | NOT NULL; must match current snapshot |
| filing_packages | statement_snapshot_id | NOT NULL |
| xbrl_instances | statement_snapshot_id | NOT NULL |
| disclosure_notes | statement_snapshot_id | NOT NULL |
| management_letters | statement_snapshot_id | NOT NULL when applicable |
| pdf_exports | statement_snapshot_id | NOT NULL |

## 2.5 Signing Against a Snapshot

The sign-off trigger `hesabu_block_signoff()` must verify:

```
1. statement_snapshot_id provided on the sign-off attempt
2. That snapshot_id exists in statement_snapshots
3. snapshot.locked = FALSE (not already signed at Tier 3)
4. snapshot.status = 'ACTIVE' (not superseded)
5. A final HESABU validation exists for that exact snapshot_id with:
   - gate_satisfied = TRUE
   - stale = FALSE
   - context = 'final'
6. Separation-of-duties rules pass (see Section 7)
```

If any check fails, the INSERT is rejected with a structured error identifying which check failed.

## 2.6 Snapshot Supersession

When a new snapshot is created (because tax changed or management inputs changed):

```
1. New statement_snapshots row inserted (supersedes_snapshot_id = old snapshot id)
2. Old snapshot: status → 'SUPERSEDED', superseded_at = NOW(), superseded_by_id = new id
3. engagements.current_snapshot_id → new id
4. All unsigned statement_sign_offs for the old snapshot are voided (status='VOID')
5. All final HESABU validations for the old snapshot: stale = TRUE, stale_reason = 'snapshot_superseded'
6. All filing_packages where is_current = TRUE and signed_at IS NULL: is_current = FALSE, voided_at = NOW()
7. XBRL instances in DRAFT or GENERATED state: stale = TRUE
```

---

# DELIVERABLE 3 — TAX FINALIZATION RULES

## 3.1 States

```
TAX_COMPUTED_DRAFT
  KINGA has committed a computation. The computation record exists and is
  immutable (kinga never overwrites). But:
  - workpapers may still have unreviewed items
  - gated items may be unresolved
  - tax AJEs have not yet been generated
  - this computation version is a working draft only

TAX_FINALIZED
  All of the following are true:
  - all workpapers reviewed (capital allowances, thin cap, add-backs, loss pool, instalment)
  - no unresolved GATED items affecting the tax result
    (a GATED item may be documented as "not applicable with reason" — it need not be resolved
     by providing the missing rate, but the gating must be explicitly acknowledged)
  - all statutory rule versions used in this computation are recorded in
    tax_computation_statutory_refs (see schema, Section 9)
  - tax AJEs generated from this exact computation version
  - tax_computation_finalized_at and finalized_by recorded
  - computation version frozen: kinga will not overwrite this record
```

## 3.2 Finalization Contract

The CPA finalizes a computation by calling `finalize_tax_computation()` SECURITY DEFINER, which:

```
1. Checks role IN ('cpa', 'partner') for current user
2. Confirms no unresolved GATED items (gated_resolutions table has a record for each)
3. Reads all statutory_rules rows used in this computation; inserts into
   tax_computation_statutory_refs (rate, verified_at, legislation_reference)
4. Sets tax_computations.finalized_at = NOW(), finalized_by = auth.uid()
5. Sets tax_computations.computation_version_frozen = TRUE
6. Calls generate_tax_ajes() to produce current tax provision, DTA, and DTL AJEs
7. Records transition: TAX_COMPUTED_DRAFT → TAX_FINALIZED via transition_engine
8. Returns finalization_token (used in next step to approve AJEs)
```

The function is transactional. If any step fails, the entire finalization rolls back.

## 3.3 Effect of New Tax Computation After Finalization

A new KINGA commit after finalization:
- Creates a new tax_computations row (always append-only; prior rows never modified)
- Sets engagement state → TAX_COMPUTED_DRAFT
- Voids all tax AJEs derived from the prior finalized version (status='VOID')
- Marks the prior finalized computation as superseded
- Triggers invalidation cascade (Deliverable 1, Section 1.2)
- Records why the finalization was superseded (triggering_record_id = new computation id)

A CPA may not suppress this cascade. There is no "force finalize" option.

## 3.4 Gated Item Resolution

Each GATED item in the tax computation must be either:

```
RESOLVED        ← Rate or input now available; computation re-run
NOT_APPLICABLE  ← CPA documents why this item does not apply to this engagement
                  (e.g., "Thin cap: company has no related-party debt")
DEFERRED        ← Item known but cannot be resolved this period; disclosed in tax note
                  Requires: deferral_reason, responsible_party, expected_resolution_date
```

Only GATED items with status RESOLVED or NOT_APPLICABLE clear the finalization gate.
A DEFERRED item blocks finalization and blocks FILING_PACKAGE_READY.

## 3.5 Statutory Rate Snapshot

At finalization, `tax_computation_statutory_refs` records:

```
tax_computation_statutory_refs {
  id
  tax_computation_id
  statutory_rule_id         FK → statutory_rules
  rate_category             TEXT   -- e.g. 'CIT_STANDARD', 'THIN_CAP_RATIO', 'WTT_CLASS_A'
  rate_value                NUMERIC
  legislation_reference     TEXT   -- e.g. 'ITA Cap.332 s.12(2)'
  verified_at               TIMESTAMPTZ  -- copied from statutory_rules.verified_at at time of finalization
  effective_from            DATE
  captured_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
}
```

This is the evidence that the correct rate was used at the time of computation. It is immutable after creation.

---

# DELIVERABLE 4 — FILING AND XBRL VERSION MODELS

## 4.1 Filing Package Versioning

v2.0 used UNIQUE(engagement_id). That is replaced by a versioned chain.

```
filing_packages {
  id                        UUID PK
  engagement_id             UUID FK → engagements NOT NULL
  package_version           INTEGER NOT NULL    -- monotonic per engagement
  statement_snapshot_id     UUID FK → statement_snapshots NOT NULL
  package_state             TEXT NOT NULL DEFAULT 'ASSEMBLING'
                            CHECK IN ('ASSEMBLING','COMPLETE','SUPERSEDED','VOIDED')
  is_current                BOOLEAN NOT NULL DEFAULT TRUE

  -- Components (all reference same statement_snapshot_id)
  disclosure_notes_id       UUID FK → disclosure_notes
  management_letter_id      UUID FK → management_letters     -- nullable if NOT_APPLICABLE
  xbrl_instance_id          UUID FK → xbrl_instances        -- must be in VALIDATED state

  -- Checklist results
  checklist_results         JSONB   -- gate_id → {status, evidence_id, notes}
                            -- status IN ('APPLICABLE','NOT_APPLICABLE','PASS','FAIL','EVIDENCE_REQUIRED')
  checklist_passed_at       TIMESTAMPTZ
  checklist_passed_by       UUID FK → firm_members

  -- Integrity
  package_hash              TEXT NOT NULL   -- SHA-256 of all component hashes
  supersedes_package_id     UUID FK → filing_packages    -- null if first version
  superseded_at             TIMESTAMPTZ
  superseded_by_id          UUID FK → filing_packages

  -- Download evidence
  package_downloaded_at     TIMESTAMPTZ
  package_downloaded_by     UUID FK → firm_members

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL
  created_by                UUID FK → firm_members NOT NULL

  CONSTRAINT one_current_per_engagement
    UNIQUE (engagement_id, package_version)
  CONSTRAINT package_hash_unique UNIQUE (package_hash)
}
```

## 4.2 Package Versioning Rules

```
1. Only one filing_packages row per engagement may have is_current = TRUE
2. When a new package is created, the prior current package: is_current → FALSE,
   superseded_at = NOW(), superseded_by_id = new package id
3. A SUPERSEDED package is never deleted; it is the historical record
4. A FILED package (referenced by filing_submissions) cannot be superseded
   without creating a superseding filing record with amendment annotation
5. package_state transitions:
   ASSEMBLING → COMPLETE         (all checklist gates pass)
   COMPLETE → SUPERSEDED         (new package created for same engagement)
   COMPLETE → VOIDED             (engagement regresses; e.g., tax recomputed post-signing)
   SUPERSEDED and VOIDED are terminal: no further transitions
```

## 4.3 XBRL Instance Model (Immutable) + Event Log

```
xbrl_instances {
  id                        UUID PK
  engagement_id             UUID FK → engagements NOT NULL
  statement_snapshot_id     UUID FK → statement_snapshots NOT NULL
  instance_version          INTEGER NOT NULL  -- monotonic per engagement
  current_state             TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK IN ('DRAFT','GENERATED','VALIDATION_FAILED',
                                      'VALIDATED','EXPORTED','SUBMITTED',
                                      'ACKNOWLEDGED','REJECTED')
  taxonomy_version          TEXT NOT NULL
  generated_at              TIMESTAMPTZ
  generated_by_function     TEXT       -- 'generate-xbrl'
  instance_file_id          UUID       -- Supabase Storage reference
  instance_hash             TEXT       -- SHA-256 of instance document
  validation_errors         JSONB
  exported_at               TIMESTAMPTZ
  exported_by               UUID FK → firm_members
  submitted_at              TIMESTAMPTZ
  submitted_by              UUID FK → firm_members
  submission_reference      TEXT
  acknowledged_at           TIMESTAMPTZ
  acknowledgement_ref       TEXT
  rejected_at               TIMESTAMPTZ
  rejected_reason           TEXT
  supersedes_instance_id    UUID FK → xbrl_instances  -- null if first version
  created_at                TIMESTAMPTZ NOT NULL

  CONSTRAINT instance_version_unique UNIQUE (engagement_id, instance_version)
}
```

```
xbrl_state_events {               -- APPEND-ONLY
  id                    UUID PK
  xbrl_instance_id      UUID FK → xbrl_instances NOT NULL
  from_state            TEXT
  to_state              TEXT NOT NULL
  triggered_by          UUID FK → firm_members     -- null if system
  source_function       TEXT                       -- edge function name
  service_principal     TEXT                       -- supabase service role or user
  request_id            TEXT
  engine_version        TEXT
  triggering_record_id  UUID
  event_detail          JSONB
  occurred_at           TIMESTAMPTZ NOT NULL

  -- No UPDATE, No DELETE enforced by trigger
}
```

## 4.4 XBRL State Machine (Corrected)

```
DRAFT
    │  [generate-xbrl called]
    ▼
GENERATED
    ├── [taxonomy errors found]
    │       ▼
    │   VALIDATION_FAILED
    │       │  [CPA fixes source; new xbrl_instances version created]
    │       │  (REJECTED also loops here — see below)
    │       │  A VALIDATION_FAILED instance NEVER returns to DRAFT
    │       │  A new instance version is created
    │       ▼
    │   DRAFT (new instance version; supersedes_instance_id = prior id)
    │
    ▼  [all taxonomy checks pass]
VALIDATED
    │  [CPA downloads validated instance]
    ▼
EXPORTED
    │  [CPA submits to TRA portal; records submission ref]
    ▼
SUBMITTED
    ├── [TRA returns rejection]
    │       ▼
    │   REJECTED  ← TERMINAL for this instance
    │              A new xbrl_instances version must be created
    │              REJECTED instance never returns to DRAFT
    │
    ▼  [TRA issues receipt / acknowledgement]
ACKNOWLEDGED   ← TERMINAL (positive)
```

## 4.5 XBRL Invariants

```
XBRL_GENERATED        ≠ XBRL_VALIDATED
XBRL_VALIDATED        ≠ FILED
FILED                 ≠ ACCEPTED_BY_REGULATOR
ACKNOWLEDGED          ≠ TAX_LIABILITY_SETTLED
SUBMITTED to TRA      ≠ ACK received from TRA
```

These are displayed as permanent notices in the XBRL screen — not tooltips, not footers. Primary content area, always visible.

---

# DELIVERABLE 5 — COMPLIANCE EVIDENCE MODEL

## 5.1 EFDMS is Evidence, Not an Obligation

EFDMS (Electronic Fiscal Devices Management System) and Z-reports are evidence sources — they document sales transactions for VAT/SDL substantiation. They are not themselves an obligation type.

The corrected model:

```
Obligation types:        VAT | PAYE | SDL | WHT | STAMP_DUTY | EXCISE
Evidence source types:   EFDMS_Z_REPORT | TRA_API_PULL | FILED_RETURN_UPLOAD |
                         APPROVED_SCHEDULE | MANUAL_CONFIRMED | TRA_CORRESPONDENCE
```

## 5.2 Compliance Period (Corrected)

```
compliance_periods {
  id                        UUID PK
  company_id                UUID FK → companies NOT NULL
  engagement_id             UUID FK → engagements       -- nullable (monthly period links to annual)
  calendar_year             INTEGER NOT NULL
  calendar_month            INTEGER NOT NULL CHECK (calendar_month BETWEEN 1 AND 12)
  obligation_type           TEXT NOT NULL
                            CHECK IN ('VAT','PAYE','SDL','WHT','STAMP_DUTY','EXCISE')
  period_state              TEXT NOT NULL DEFAULT 'OPEN'
                            CHECK IN ('OPEN','EFD_EVIDENCE_MISSING','VAT_RETURN_EVIDENCE_MISSING',
                                      'READY_TO_RECONCILE','RECONCILIATION_CLEAN',
                                      'RECONCILIATION_GAP','GAP_RESOLVED','READY_TO_FILE','FILED')
  applicable                BOOLEAN NOT NULL DEFAULT TRUE   -- FALSE if obligation not triggered
  inapplicable_reason       TEXT                           -- required if applicable = FALSE
  created_at                TIMESTAMPTZ
  created_by                UUID FK → firm_members
  UNIQUE (company_id, calendar_year, calendar_month, obligation_type)
}
```

## 5.3 Compliance Evidence Sources

```
compliance_evidence_sources {
  id                        UUID PK
  compliance_period_id      UUID FK → compliance_periods NOT NULL
  evidence_type             TEXT NOT NULL
                            CHECK IN ('EFDMS_Z_REPORT','TRA_API_PULL','FILED_RETURN_UPLOAD',
                                      'APPROVED_SCHEDULE','MANUAL_CONFIRMED','TRA_CORRESPONDENCE')
  evidence_state            TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK IN ('PENDING','RECEIVED','REVIEWED','APPROVED','REJECTED')
  file_id                   UUID       -- Supabase Storage reference (for uploaded files)
  file_hash                 TEXT       -- SHA-256 integrity check
  api_pull_reference        TEXT       -- TRA API transaction ID (for TRA_API_PULL type)
  filed_return_period       TEXT       -- e.g. '2025-06' (for FILED_RETURN_UPLOAD)
  gross_sales_evidence      NUMERIC    -- as stated in this evidence source
  output_vat_evidence       NUMERIC
  net_sales_evidence        NUMERIC
  confirmed_by              UUID FK → firm_members
  confirmed_at              TIMESTAMPTZ
  notes                     TEXT
  created_at                TIMESTAMPTZ NOT NULL
  created_by                UUID FK → firm_members NOT NULL
}
```

## 5.4 EFDMS Z-Reports (Corrected Relationship)

`efdms_z_reports` rows belong to a compliance_period and are linked through compliance_evidence_sources:

```
efdms_z_reports
  id
  compliance_evidence_source_id   UUID FK → compliance_evidence_sources NOT NULL
  company_id                      UUID FK → companies NOT NULL
  serial_number                   TEXT NOT NULL
  trader_tin                      TEXT
  report_date                     DATE NOT NULL
  gross_sales                     NUMERIC NOT NULL
  net_sales                       NUMERIC NOT NULL
  vat_collected                   NUMERIC NOT NULL
  exempt_sales                    NUMERIC NOT NULL DEFAULT 0
  zero_rated_sales                NUMERIC NOT NULL DEFAULT 0
  receipt_count                   INTEGER NOT NULL DEFAULT 0
  cancelled_count                 INTEGER NOT NULL DEFAULT 0
  import_source                   TEXT NOT NULL CHECK IN ('manual','api','csv_adapter')
  created_at                      TIMESTAMPTZ NOT NULL
  UNIQUE (company_id, serial_number, report_date)
  APPEND-ONLY
```

## 5.5 VAT Reconciliation (Corrected)

The monthly VAT reconciliation compares:

```
Side A (EFDMS evidence):
  SUM(efdms_z_reports.gross_sales)    WHERE compliance_period_id = X
  SUM(efdms_z_reports.vat_collected)  WHERE compliance_period_id = X

Side B (Filed VAT return evidence):
  compliance_evidence_sources WHERE evidence_type IN ('FILED_RETURN_UPLOAD','TRA_API_PULL',
                                                       'APPROVED_SCHEDULE','MANUAL_CONFIRMED')
  AND evidence_state = 'APPROVED'
  → gross_sales_evidence
  → output_vat_evidence
```

If Side B has no APPROVED record: status = `VAT_RETURN_EVIDENCE_MISSING`. Reconciliation is blocked.

KINGA data is NOT used as Side B. KINGA annual revenue is a risk cross-check signal only.

---

# DELIVERABLE 6 — TRANSITION TRANSACTION CONTRACT

## 6.1 Single Transition Authority

All engagement state transitions — whether triggered by a user action, an engine event, or a system cascade — must run through one function: `transition_engine.advance()` implemented as a SECURITY DEFINER PostgreSQL function.

No frontend may write directly to `engagements.engagement_state`.

## 6.2 Function Signature

```sql
CREATE OR REPLACE FUNCTION advance_engagement_state(
  p_engagement_id          UUID,
  p_requested_to_state     TEXT,
  p_source_function        TEXT,
  p_service_principal      TEXT,
  p_request_id             TEXT,
  p_engine_version         TEXT,
  p_triggering_record_id   UUID,
  p_input_hash             TEXT,
  p_transition_detail      JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
-- Returns: { success, from_state, to_state, event_id, blocked_reason }
$$;
```

## 6.3 Contract — What the Function Does

```
1. LOCK the engagements row FOR UPDATE
2. READ current engagement_state
3. VALIDATE the transition is permitted (from → to is in the allowed transitions table)
4. EVALUATE all gate conditions for the target state (see gate checks below)
5. CHECK separation-of-duties rules if transition involves a human action
6. CHECK that the authenticated user has the required role (from firm_members)
7. If all checks pass:
   a. UPDATE engagements.engagement_state = p_requested_to_state
   b. UPDATE engagements.state_updated_at = NOW()
   c. INSERT into engagement_state_events (provenance record — see below)
   d. Fire any cascade side-effects (snapshot supersession, HESABU staleness, etc.)
   e. RETURN { success: true, from_state, to_state, event_id }
8. If any check fails:
   a. ROLLBACK (no partial write)
   b. RETURN { success: false, blocked_reason: <specific failure>, from_state }
```

This function is the ONLY writer to `engagements.engagement_state`. The column has a trigger preventing direct writes:

```sql
CREATE OR REPLACE FUNCTION block_direct_state_write()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.transition_engine_active', true) <> 'true' THEN
    RAISE EXCEPTION 'Direct writes to engagements.engagement_state are prohibited.
    Use advance_engagement_state().';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

## 6.4 engagement_state (Cached Projection)

`engagements.engagement_state` is a cached projection of the latest event in `engagement_state_events`. It exists for query performance. It is never the source of truth. If it diverges from the event log (which it should not), the event log wins.

A reconciliation function `reconcile_engagement_state(p_engagement_id UUID)` may be called by admins to re-derive the state from the event log.

## 6.5 System Transition Provenance Record

Every call to `advance_engagement_state()` produces one row in `engagement_state_events`:

```
engagement_state_events {
  id                    UUID PK DEFAULT gen_random_uuid()
  engagement_id         UUID FK → engagements NOT NULL
  from_state            TEXT
  to_state              TEXT NOT NULL
  triggered_by          UUID FK → firm_members   -- NULL for system-only transitions
  trigger_type          TEXT NOT NULL
                        CHECK IN ('user_action','engine_event','cascade','admin_override')
  source_function       TEXT NOT NULL   -- edge function name or 'user_action'
  service_principal     TEXT NOT NULL   -- 'service_role' | 'anon' | authenticated user id
  request_id            TEXT NOT NULL   -- UUID generated per request by the calling function
  engine_version        TEXT            -- semver of the engine that fired this transition
  triggering_record_id  UUID            -- the record that caused this transition
  input_hash            TEXT            -- SHA-256 of the key inputs that triggered this
  transition_detail     JSONB           -- arbitrary structured context
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- APPEND-ONLY enforced by trigger
  -- No UPDATE, No DELETE
}
```

## 6.6 Gate Checks Per Target State

The `advance_engagement_state()` function evaluates these gate checks before writing:

| Target State | Gate Checks |
|---|---|
| DATA_INTAKE | process-trial-balance returned success; upload_hash recorded |
| RECONCILED | safisha_gate_passed = TRUE; 0 open exceptions in exception queue |
| DRAFT_STATEMENTS_READY | FS Renderer completed; statement_version assigned; snapshot_candidate created |
| DRAFT_HESABU_PASSED | hesabu_validations row with context='draft', gate_satisfied=TRUE, stale=FALSE |
| TAX_COMPUTED_DRAFT | tax_computations row exists for this engagement |
| TAX_FINALIZED | all gated_resolutions present; workpapers all reviewed; finalization_token present |
| TAX_ADJUSTMENTS_APPLIED | all tax AJEs in APPROVED or REJECTED state; at least one APPROVED |
| STATEMENT_SNAPSHOT_CREATED | statement_snapshots row inserted with valid snapshot_hash |
| FINAL_HESABU_PASSED | hesabu_validations row with context='final', gate_satisfied=TRUE, stale=FALSE, snapshot_id matches current |
| STATEMENTS_SIGNED | Tier 3 sign-off record exists; separation-of-duties passed; snapshot_id matches |
| TAX_SIGNED | Tax sign-off chain complete for this engagement |
| FILING_PACKAGE_READY | filing_packages.package_state = 'COMPLETE'; all applicable checklist gates PASS |
| READY_FOR_MANUAL_SUBMISSION | package_downloaded_at recorded |
| FILED | filing_submissions row exists with all mandatory fields |

---

# DELIVERABLE 7 — SEPARATION-OF-DUTIES MATRIX

## 7.1 Constitutional Rule

UI role gates are navigation convenience. The DB enforces. Every prohibition below has a corresponding DB constraint, trigger, or SECURITY DEFINER check that cannot be overridden by a UI action, admin override, or API call.

## 7.2 Multi-Tier Sign-Off Prohibition

```
Rule: No person may sign more than one tier on the same engagement.

Enforcement:
  CREATE UNIQUE INDEX one_person_one_tier_per_engagement
  ON statement_sign_offs (engagement_id, signed_by)
  WHERE signed_at IS NOT NULL;
```

If a CPA signs Tier 1 (Preparer) and also holds a role that would normally allow Tier 2 (Reviewer), the Tier 2 INSERT is rejected. The firm must assign a different person to Tier 2.

## 7.3 AJE Creator / Sole Approver Prohibition

```
Rule: The person who created an AJE may not be the sole approver of that AJE.
      If only one approver exists for an AJE, they may not be the creator.

Enforcement: adjusting_journal_entries trigger
  IF NEW.approved_by = (SELECT created_by FROM adjusting_journal_entries WHERE id = NEW.id)
  AND (SELECT COUNT(*) FROM aje_approvals WHERE aje_id = NEW.id) = 1
  THEN RAISE EXCEPTION 'AJE creator cannot be the sole approver.';
```

Two-person approval is satisfied when at least one approver is not the creator.

## 7.4 Tax Preparer / Final Approver Prohibition

```
Rule: The person who prepared the tax computation (finalized_by) may not
      be the final tax approver (tax Tier 3 sign-off).

Enforcement: tax sign-off trigger
  IF NEW.tax_tier_3_signed_by = (
    SELECT finalized_by FROM tax_computations
    WHERE engagement_id = NEW.engagement_id
    ORDER BY finalized_at DESC LIMIT 1
  ) THEN RAISE EXCEPTION 'Tax preparer cannot be the final tax approver.';
```

## 7.5 Admin Role Does Not Bypass Financial Approvals

```
Rule: firm_members with role = 'admin' have no elevated access to sign-off
      chains, AJE approvals, tax finalization, or filing submissions.
      Admin role controls user management and statutory rules only.

Enforcement:
  hesabu_block_signoff() checks role IN ('preparer','reviewer','approver') only
  finalize_tax_computation() checks role IN ('cpa','partner') only
  generate_tax_ajes() checks role IN ('cpa','partner') only
  advance_engagement_state() role map (see below) excludes 'admin' for financial transitions
```

## 7.6 Service Role Cannot Become a Human Signatory

```
Rule: When triggered_by IS NULL (system/engine transition), the
      statement_sign_offs.signed_by column must refer to a firm_members row
      with a human role. The service role (Supabase service_role JWT)
      may not appear in signed_by.

Enforcement:
  sign-off INSERT trigger validates that signed_by maps to a firm_members row
  with role NOT IN ('service_role','system','api_client')
```

## 7.7 Full Separation-of-Duties Matrix

| Action | Permitted Roles | Prohibited Combinations |
|---|---|---|
| Tier 1 sign-off (Preparer) | accountant, cpa | Cannot also sign Tier 2 or 3 on same engagement |
| Tier 2 sign-off (Reviewer) | cpa, auditor, partner | Cannot be same person as Tier 1 signatory |
| Tier 3 sign-off (Approver) | partner, director | Cannot be same person as Tier 1 or 2 signatory |
| Tax Tier 1 (Preparer) | accountant, cpa | Cannot also sign Tax Tier 2 or 3 |
| Tax Tier 2 (Reviewer) | cpa, partner | Cannot be same person as Tax Tier 1 |
| Tax Tier 3 (Approver) | partner, director | Cannot be finalized_by; cannot be Tax Tier 1 or 2 |
| AJE create | accountant, cpa | Cannot be sole approver of own AJE |
| AJE approve | cpa, partner | Cannot be creator if sole approver |
| AJE reject | cpa, partner | No restriction |
| Tax finalization | cpa, partner | No restriction within this action |
| Snapshot creation | system (FS Renderer) | No human may trigger directly |
| HESABU run | system (hesabu-validate) | No human may trigger directly (button invokes edge function) |
| Filing package creation | cpa, partner | Must not be same person who performed HESABU finalization |
| FILED recording | cpa, partner | No restriction |
| Admin: statutory rules | admin only | Admin may not sign financial outputs |
| Admin: user management | admin only | Admin may not approve AJEs |

---

# DELIVERABLE 8 — PACKAGE APPLICABILITY MATRIX

## 8.1 Two Package Types

```
A. STATUTORY FILING PACKAGE
   Contents required for annual CIT return to TRA
   - Financial Statements (from snapshot)
   - Tax Computation Summary (from KINGA commit)
   - XBRL instance (VALIDATED)
   - Disclosure Notes (approved)
   - Management Letter (see applicability below)
   - TRA Checklist (all applicable gates passing)

B. AUDIT / ADVISORY DELIVERABLES
   Contents for client, auditor, or internal use
   - Full Financial Statements PDF (from snapshot)
   - Management Letter (always applicable here)
   - Board Pack (MAONO-generated)
   - Engagement Letter (out of scope for this system)
   - Working Papers Set (KINGA workpapers PDF)
```

Package B does not require TAX_SIGNED or FILING_PACKAGE_READY. It can be generated from STATEMENTS_SIGNED onwards.

## 8.2 Checklist Gate Applicability States

Every TRA checklist gate may have one of five states:

| State | Meaning |
|---|---|
| APPLICABLE | This gate applies to this engagement and has not yet been evaluated |
| NOT_APPLICABLE | CPA has certified this gate does not apply; reason recorded |
| PASS | Gate condition is satisfied; evidence present |
| FAIL | Gate condition is not satisfied; blocker identified |
| EVIDENCE_REQUIRED | Gate applies; condition may be satisfied; supporting evidence must be uploaded |

Only PASS or NOT_APPLICABLE gates count toward "all checklist gates satisfied." A FAIL or EVIDENCE_REQUIRED gate blocks FILING_PACKAGE_READY.

## 8.3 Filing Package Checklist Gates

| Gate ID | Description | Applicability Logic | Evidence Required |
|---|---|---|---|
| G1 | Final HESABU validation passed (stale=FALSE) | Always APPLICABLE | hesabu_validations row |
| G2 | All AJEs approved (or rejected with reason) | Always APPLICABLE | adjusting_journal_entries all APPROVED/REJECTED |
| G3 | Financial statements signed (Tier 3) | Always APPLICABLE | statement_sign_offs.approver_signed_at IS NOT NULL |
| G4 | All findings resolved or formally documented | Always APPLICABLE | findings all in RESOLVED/DOCUMENTED state |
| G5 | EFDMS Z-reports present for all periods of year | NOT_APPLICABLE if company is not VAT-registered | efdms_z_reports count by month |
| G6 | Evidence requests closed (or closed with waiver) | APPLICABLE if findings existed | evidence_requests all CLOSED |
| G7 | Transfer pricing documentation complete | NOT_APPLICABLE if no related-party transactions above TP threshold | tp_documentation_id present |
| G8 | Thin cap computation unambiguous | NOT_APPLICABLE if no thin cap trigger; APPLICABLE if triggered | gated_resolutions for thin cap |
| G9 | Capital allowances register reconciles to SFP | Always APPLICABLE | capital_allowances.reconciled_at IS NOT NULL |
| G10 | XBRL instance in VALIDATED state | NOT_APPLICABLE if XBRL waiver granted | xbrl_instances.current_state = 'VALIDATED' |

## 8.4 Management Letter Applicability

```
Management Letter (for Statutory Filing Package):
  APPLICABLE if:
    engagement_policy.management_letter_required = TRUE
    OR findings.total_count > 0
    OR MAONO risk level >= 'HIGH' for any risk category
  NOT_APPLICABLE if:
    engagement_policy.management_letter_required = FALSE
    AND findings.total_count = 0
    AND no MAONO HIGH/CRITICAL risks
    AND CPA certifies NOT_APPLICABLE with reason

Management Letter (for Audit/Advisory Deliverables):
  Always APPLICABLE
```

## 8.5 Reporting Framework Enum (Corrected)

| Value | Description | Status |
|---|---|---|
| FULL_IFRS | International Financial Reporting Standards (full) | Active |
| IFRS_FOR_SMES | IFRS for Small and Medium-sized Entities | Active |
| IPSAS_ACCRUAL | International Public Sector Accounting Standards (accrual basis) | Disabled — pending certification |
| IPSAS_CASH | International Public Sector Accounting Standards (cash basis) | Disabled — pending certification |

Disabled frameworks are visible in the reporting framework selector but non-selectable. They display: "Not yet available — statement template and HESABU suite not certified for this framework."

IPSAS_ACCRUAL and IPSAS_CASH will be enabled when:
- A complete FS Renderer template exists for that framework
- A full HESABU assertion suite (H-01 to H-12 equivalent) is written and validated for that framework
- XBRL taxonomy mapping for that framework is confirmed

---

# DELIVERABLE 9 — REVISED SCHEMA PROPOSAL

## 9.1 New Tables Required

### 1. engagements (from v2.0 — extended)

```
engagements {
  id                          UUID PK
  company_id                  UUID FK → companies NOT NULL
  fiscal_year                 INTEGER NOT NULL
  fiscal_year_end             DATE NOT NULL
  reporting_framework         TEXT NOT NULL
                              CHECK IN ('FULL_IFRS','IFRS_FOR_SMES','IPSAS_ACCRUAL','IPSAS_CASH')
  engagement_state            TEXT NOT NULL DEFAULT 'ONBOARDING'
  current_snapshot_id         UUID FK → statement_snapshots  -- cached; may be null early on
  locked_at                   TIMESTAMPTZ
  locked_by                   UUID FK → firm_members
  engagement_policy           JSONB DEFAULT '{}'             -- management_letter_required, etc.
  state_updated_at            TIMESTAMPTZ
  created_at                  TIMESTAMPTZ NOT NULL
  created_by                  UUID FK → firm_members NOT NULL
  UNIQUE (company_id, fiscal_year)
}
```

### 2. engagement_state_events (APPEND-ONLY)

```
engagement_state_events {
  id                    UUID PK
  engagement_id         UUID FK → engagements NOT NULL
  from_state            TEXT
  to_state              TEXT NOT NULL
  triggered_by          UUID FK → firm_members   -- null for system
  trigger_type          TEXT NOT NULL CHECK IN ('user_action','engine_event','cascade','admin_override')
  source_function       TEXT NOT NULL
  service_principal     TEXT NOT NULL
  request_id            TEXT NOT NULL
  engine_version        TEXT
  triggering_record_id  UUID
  input_hash            TEXT
  transition_detail     JSONB DEFAULT '{}'
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No UPDATE, No DELETE
}
```

### 3. statement_snapshots (APPEND-ONLY; partially mutable — see 2.2)

Full schema in Deliverable 2 Section 2.2.

### 4. compliance_periods (corrected)

Full schema in Deliverable 5 Section 5.2.

### 5. compliance_evidence_sources

Full schema in Deliverable 5 Section 5.3.

### 6. filing_packages (versioned)

Full schema in Deliverable 4 Section 4.1.

### 7. xbrl_instances (immutable)

Full schema in Deliverable 4 Section 4.3.

### 8. xbrl_state_events (APPEND-ONLY)

Full schema in Deliverable 4 Section 4.3.

### 9. filing_submissions (APPEND-ONLY — from v2.0)

```
filing_submissions {
  id                      UUID PK
  engagement_id           UUID FK → engagements NOT NULL
  compliance_period_id    UUID FK → compliance_periods   -- null for annual CIT
  package_id              UUID FK → filing_packages      -- null for monthly
  package_version         INTEGER                        -- must match filing_packages.package_version
  return_type             TEXT NOT NULL CHECK IN ('ANNUAL_CIT','VAT','PAYE','SDL','WHT','STAMP_DUTY')
  submission_channel      TEXT NOT NULL CHECK IN ('TRA_PORTAL','MANUAL_LODGEMENT','TRA_API')
  submission_reference    TEXT NOT NULL
  submitted_at            TIMESTAMPTZ NOT NULL
  submitted_by            UUID FK → firm_members NOT NULL
  acknowledgement_file_id UUID
  acknowledgement_hash    TEXT
  submission_notes        TEXT
  created_at              TIMESTAMPTZ NOT NULL
  -- APPEND-ONLY
}
```

### 10. tax_computation_statutory_refs (APPEND-ONLY)

Full schema in Deliverable 3 Section 3.5.

### 11. gated_resolutions

```
gated_resolutions {
  id                    UUID PK
  tax_computation_id    UUID FK → tax_computations NOT NULL
  gated_item_code       TEXT NOT NULL   -- e.g. 'THIN_CAP_RATIO', 'MANAGEMENT_FEE_RATE'
  resolution_status     TEXT NOT NULL CHECK IN ('RESOLVED','NOT_APPLICABLE','DEFERRED')
  resolution_notes      TEXT NOT NULL
  deferred_reason       TEXT            -- required if DEFERRED
  responsible_party     TEXT            -- required if DEFERRED
  expected_resolution   DATE            -- required if DEFERRED
  resolved_by           UUID FK → firm_members NOT NULL
  resolved_at           TIMESTAMPTZ NOT NULL
  created_at            TIMESTAMPTZ NOT NULL
}
```

### 12. xbrl_checklist_results (part of filing_packages.checklist_results JSONB — may be normalized later)

Stored as JSONB on filing_packages for v2.1. Normalize to a separate table if query patterns require it.

## 9.2 Extended Existing Tables

| Table | Extension | Reason |
|---|---|---|
| hesabu_validations | + statement_snapshot_id (FK → statement_snapshots) | Final validation must reference snapshot |
| hesabu_validations | + validation_context CHECK IN ('draft','final') | Distinguish advisory vs. gate runs |
| hesabu_validations | + tax_computation_version, aje_version, management_input_hash, stale, stale_at, stale_reason | Freshness model |
| statement_sign_offs | + statement_snapshot_id (FK → statement_snapshots) | Signature on snapshot, not on dynamic render |
| statement_sign_offs | + engagement_id (FK → engagements) | Link to engagement for SoD check |
| tax_computations | + finalized_at, finalized_by, computation_version_frozen | Finalization boundary |
| adjusting_journal_entries | + source_tax_computation_id (FK → tax_computations) | Track which computation generated this AJE |
| efdms_z_reports | + compliance_evidence_source_id (FK → compliance_evidence_sources) | Corrected ownership |
| findings | + resolution_type CHECK IN ('RESOLVED','DOCUMENTED','DEFERRED','NOT_APPLICABLE') | Applicability state |
| evidence_requests | + applicability_status CHECK IN ('APPLICABLE','NOT_APPLICABLE','PASS','FAIL','EVIDENCE_REQUIRED') | Package checklist |

## 9.3 Removed Constraints

| Table | Change | Reason |
|---|---|---|
| filing_packages | Remove UNIQUE(engagement_id) | Replaced by (engagement_id, package_version) |
| compliance_periods | Remove obligation_type = 'EFDMS_MONTHLY' | EFDMS is evidence, not an obligation |
| engagements | reporting_framework: remove old IFRS/IFRS_SME/IAS values | Replaced by corrected enum |

## 9.4 Data Ownership Matrix (Revised)

| Domain | Authoritative Table | Written By | Read By |
|---|---|---|---|
| Engagement state | engagement_state_events + engagements (projection) | advance_engagement_state() SECURITY DEFINER | All |
| Statement snapshots | statement_snapshots | FS Renderer (SECURITY DEFINER) | HESABU, Sign-off, Filing |
| Tax finalization | tax_computations.finalized_at | finalize_tax_computation() SECURITY DEFINER | Filing, AJE generation |
| Statutory rate snapshot | tax_computation_statutory_refs | finalize_tax_computation() SECURITY DEFINER | Audit, evidence |
| Gated resolutions | gated_resolutions | CPA via secure endpoint | Tax finalization gate |
| HESABU result | hesabu_validations | hesabu-validate (SECURITY DEFINER) | Sign-off gate, UI |
| Sign-off | statement_sign_offs | hesabu_write_signoff (SECURITY DEFINER) | Period lock trigger |
| Snapshot supersession | statement_snapshots (superseded_by_id) | advance_engagement_state() cascade | Invalidation chain |
| Filing packages | filing_packages | generate-filing-package | TRA Checklist, XBRL, export |
| Submission evidence | filing_submissions | CPA entry (authenticated) | FILED gate |
| XBRL instance | xbrl_instances | generate-xbrl | Filing package |
| XBRL events | xbrl_state_events | advance_xbrl_state() SECURITY DEFINER | XBRL UI |
| Monthly obligations | compliance_periods | CPA / accountant | Monthly mission |
| Monthly evidence | compliance_evidence_sources | CPA / safisha-efdms-ingest | Monthly reconciliation |
| Z-report records | efdms_z_reports | safisha-efdms-ingest | Monthly VAT reconciliation |
| Transaction records | safisha_transactions | safisha-ingest (SECURITY DEFINER) | KINGA, HESABU, MAONO |
| Variance analysis | variance_runs | maono-compute | MAONO UI |
| Alerts | alert_events | SECURITY DEFINER (various) | AlertCenter, My Work |

---

# DELIVERABLE 10 — FINAL IMPLEMENTATION PHASES

## 10.1 Constraints on All Phases

1. Code freeze rules remain in effect until explicitly lifted
2. No phase introduces features not in this architecture
3. Every phase is independently deployable and independently rollback-able
4. No phase may break existing Iron Dome constraints
5. Phase sequencing in Section 10.3 is non-negotiable

## 10.2 Schema First, UI Second

All schema phases (S-phases) must be deployed and verified before the corresponding UI phase (U-phase) begins. A schema phase is complete when:
- Migration runs without error
- RLS policies applied
- All SECURITY DEFINER functions deployed
- At least one integration test passes against the new schema

## 10.3 Phase Sequence

```
S-0  Schema: Core tables
S-1  Schema: Transition engine
S-2  Schema: Snapshot model
S-3  Schema: Tax finalization
S-4  Schema: Filing versioning
S-5  Schema: Compliance evidence
S-6  Schema: SoD enforcement
U-1  UI: Routing shell + Engagement Overview
U-2  UI: Close Books (Mission 1, steps A–D)
U-3  UI: Compute Tax (Mission 2, steps A–C)
U-4  UI: Final Review + Sign Off (Mission 1E)
U-5  UI: Analyse (Mission 3)
U-6  UI: File Returns (Mission 4 — XBRL + Package)
U-7  UI: Monthly Compliance
U-8  UI: Home + My Work
U-9  UI: Firm Dashboard
U-10 UI: Retirement of Dashboard.tsx
```

## 10.4 Schema Phase Detail

### S-0 — Core Tables (prerequisite for all UI phases)

Create: `engagements`, `engagement_state_events`
Extend: `hesabu_validations` (validation_context, snapshot fields, staleness fields)
Extend: `statement_sign_offs` (statement_snapshot_id, engagement_id)
Derived view: `engagement_state_v` (bridge until S-1 is live)

Verification: All existing data migrated; engagement_state_v returns correct state for all existing company/upload combinations.

### S-1 — Transition Engine

Create: `advance_engagement_state()` SECURITY DEFINER function
Create: block_direct_state_write trigger on `engagements.engagement_state`
Create: Allowed transitions table (from → to → gate function name)
Deploy: reconcile_engagement_state() admin utility

Verification: Attempt a direct UPDATE to engagements.engagement_state → must be rejected. Call advance_engagement_state() with a valid transition → must succeed. Call with an invalid transition → must return blocked_reason.

### S-2 — Snapshot Model

Create: `statement_snapshots` table + append-only trigger
Extend: `hesabu_validations.statement_snapshot_id`
Extend: `statement_sign_offs.statement_snapshot_id`
Extend: `engagements.current_snapshot_id`
Update: `hesabu_block_signoff()` trigger to validate snapshot_id

Verification: Attempt sign-off without snapshot → rejected. Attempt sign-off with stale HESABU → rejected. Create snapshot → sign-off succeeds.

### S-3 — Tax Finalization

Create: `gated_resolutions` table
Create: `tax_computation_statutory_refs` table
Extend: `tax_computations` (finalized_at, finalized_by, computation_version_frozen)
Extend: `adjusting_journal_entries` (source_tax_computation_id)
Create: `finalize_tax_computation()` SECURITY DEFINER
Create: `generate_tax_ajes()` SECURITY DEFINER

Verification: Finalize computation with unresolved gated item → rejected. Resolve all items → finalization succeeds. Check that statutory rate snapshot is captured.

### S-4 — Filing Versioning

Create: `filing_packages` (versioned schema — no UNIQUE engagement_id)
Create: `filing_submissions`
Create: `xbrl_instances`
Create: `xbrl_state_events` + append-only trigger
Create: `advance_xbrl_state()` SECURITY DEFINER
Extend: All downstream artifact tables with statement_snapshot_id

Verification: Create two filing_packages for same engagement → both exist; is_current flips correctly. Attempt FILED without filing_submissions → rejected.

### S-5 — Compliance Evidence

Create: `compliance_periods` (corrected schema)
Create: `compliance_evidence_sources`
Extend: `efdms_z_reports` (compliance_evidence_source_id)
Update: safisha-efdms-ingest to link inserts to a compliance_evidence_sources record

Verification: Insert Z-report → compliance_evidence_source_id populated. Attempt VAT reconciliation without APPROVED filed return evidence → status = VAT_RETURN_EVIDENCE_MISSING.

### S-6 — Separation of Duties

Create: UNIQUE INDEX on statement_sign_offs (engagement_id, signed_by)
Create: AJE sole-approver trigger
Create: Tax Tier 3 / finalized_by prohibition trigger
Update: advance_engagement_state() role checks to exclude 'admin' from financial transitions
Update: sign-off INSERT trigger to reject service_role as signatory

Verification: Attempt Tier 1 and Tier 2 sign-off with same user → second rejected. Approve own AJE as sole approver → rejected. Admin attempts to sign off statements → rejected.

## 10.5 UI Phase Detail

### U-1 — Routing Shell + Engagement Overview
New: React Router routes. EngagementLayout (sidebar). EngagementOverview screen.
Backward compat: `/dashboard` continues to work.

### U-2 — Close Books (Steps A–D: Import, Reconcile, Draft Statements, Draft Validation)
Move: TrialBalanceUpload, SafishaGate, ExceptionQueue, AdjustingJournalPanel (non-tax), HesabuAssurancePanel (draft context).
New: Statement version counter display.

### U-3 — Compute Tax (Steps A–C: Computation, Workpapers, Tax AJEs)
Move: KingaTaxPanel (computation section), all workpaper panels, new Tax AJE approval screen.
New: Gated item resolution interface, Tax Finalization confirm step, statutory rate snapshot display.
Gate: U-3 routes only accessible at engagement state ≥ DRAFT_HESABU_PASSED.

### U-4 — Final Review + Sign Off (Steps D–E: Final Validation, Sign Off)
**Critical: this phase must come after U-3 is live and verified.**
Move: HesabuAssurancePanel (final context), sign-off chain.
New: Snapshot viewer (read-only; shows what is being signed), snapshot hash display.
Gate: accessible only at engagement state ≥ TAX_ADJUSTMENTS_APPLIED.
Sign-off screen must display: snapshot_id, snapshot_hash, tax_computation_version, aje_set_hash — so signatories know exactly what they are approving.

### U-5 — Analyse (Mission 3 — MAONO)
Move: MaonoDashboard and all MAONO panels.
No sequencing dependency on U-3/U-4.

### U-6 — File Returns (Mission 4)
New: XBRL screen with full state machine and invariant notices.
Move: Disclosure notes, management letter, TRA checklist (with applicability states).
New: Filing package screen (versioned; shows package_version, package_hash).
New: FILED evidence entry form (with mandatory fields enforced).
Gate: accessible only at engagement state ≥ TAX_SIGNED.
All three XBRL invariants displayed as permanent primary-content notices.

### U-7 — Monthly Compliance
New: compliance_periods list and detail screens.
New: Monthly VAT reconciliation screen (EFDMS vs. VAT return evidence only; no KINGA data shown).
New: Monthly state machine navigator (OPEN → FILED).
New: Monthly filing evidence form.
Gate: Separate from annual engagement routing.

### U-8 — Home + My Work
New: Role-adaptive Home reading from engagement_state_events + alert_events.

### U-9 — Firm Dashboard
Move: FirmDashboardPanel, PeriodCloseManager, AlertCenter.

### U-10 — Dashboard.tsx Retirement
After all panels are routed: redirect `/dashboard` → `/clients`. Dashboard.tsx is deleted. Settings.tsx retains audit log and statutory rules tabs.

## 10.6 Rollback Boundaries

| Phase | Rollback Mechanism | Risk |
|---|---|---|
| S-0 | Drop new tables; remove extended columns | Low — additive only |
| S-1 | Drop advance_engagement_state(); drop block trigger | Medium — direct writes re-enabled |
| S-2 | Drop statement_snapshots; revert sign-off trigger | High — sign-off gate weakened |
| S-3 | Drop finalization function; drop gated_resolutions | Medium — tax finalization removed |
| S-4 | Drop xbrl_instances; revert filing_packages | Low — new tables only |
| S-5 | Drop compliance_periods; revert efdms_z_reports | Low — additive |
| S-6 | Drop SoD constraints | CRITICAL — must not be rolled back without partner approval and audit record |
| U-1 to U-9 | Revert UI files; `/dashboard` continues to work | Low |
| U-10 | Restore Dashboard.tsx from git history | Low |

S-6 rollback is the highest-risk rollback. Removal of SoD constraints requires explicit written approval and produces an audit event. The system must never be in a state where SoD constraints are absent with no record of their removal.

---

# APPENDIX — IRON DOME CONSTITUTIONAL INVARIANTS (FINAL, v2.1)

These may not be removed, weakened, or bypassed by any user action, configuration, admin override, or future feature request:

```
IMMUTABILITY
  1. safisha_transactions — APPEND-ONLY
  2. safisha_audit_log — APPEND-ONLY
  3. variance_runs — APPEND-ONLY
  4. engagement_state_events — APPEND-ONLY
  5. filing_submissions — APPEND-ONLY
  6. hesabu_validations — APPEND-ONLY
  7. xbrl_state_events — APPEND-ONLY
  8. tax_computation_statutory_refs — APPEND-ONLY
  9. statement_snapshots.statements_json — IMMUTABLE AFTER INSERT
  10. statement_snapshots.snapshot_hash — IMMUTABLE AFTER INSERT
  11. budget rows — IMMUTABLE after approved_by is set
  12. signed statement_snapshots — IMMUTABLE (locked = TRUE after Tier 3)

IDENTITY AND AUTHORIZATION
  13. reviewed_by / signed_by — always from supabase.auth.getUser(); never from request body
  14. service_role — may not appear as a human signatory
  15. advance_engagement_state() — sole writer to engagement state; direct writes blocked
  16. finalize_tax_computation() — sole writer to tax finalization status

GATE INTEGRITY
  17. hesabu_block_signoff: gate_satisfied=TRUE AND stale=FALSE AND context='final'
        AND snapshot_id matches AND separation-of-duties passed
  18. FILED state requires filing_submissions record; UI alone cannot set it
  19. TAX_FINALIZED requires all gated items resolved or formally documented
  20. STATEMENT_SNAPSHOT_CREATED — FS Renderer fires this; no human-initiated path

ENGINE BOUNDARIES
  21. HESABU may not write to tax_computations, adjusting_journal_entries, or safisha_transactions
  22. KINGA may not write to hesabu_validations, statement_sign_offs, or safisha_transactions
  23. MAONO may not write to any financial table; advisory output only
  24. FS Renderer may not compute statutory tax rates; reads from tax_computations only
  25. EFDMS reconciliation compares to filed VAT return evidence, not to KINGA output

SEPARATION OF DUTIES
  26. No person signs multiple tiers on the same engagement
  27. AJE creator cannot be sole approver
  28. Tax preparer (finalized_by) cannot be Tax Tier 3 approver
  29. admin role does not bypass financial approvals

STATUTORY RATES
  30. statutory_rules rates require verified_at before KINGA may use them
  31. Rates at finalization time are captured in tax_computation_statutory_refs (immutable)
  32. Disabled reporting frameworks (IPSAS_ACCRUAL, IPSAS_CASH) cannot be selected until
        FS Renderer templates and HESABU suites are certified

AGENTIC CONTROLS
  33. maono-decide outputs never auto-execute
  34. materiality is configurable per company; no hardcoded thresholds anywhere
  35. AI insights (root cause) require tool-use citation and numeric validation before storage

XBRL
  36. XBRL_VALIDATED ≠ FILED ≠ ACCEPTED_BY_REGULATOR — stated as permanent UI notices
  37. REJECTED xbrl_instances never return to DRAFT; new version required

TRANSITION PROVENANCE
  38. Every state transition records: source_function, service_principal, request_id,
        engine_version, triggering_record_id, input_hash, occurred_at
  39. No silent state changes — every transition = one engagement_state_events row
```

---

*End of Version 2.1. No code. No file modifications.*
*This document is the approved architectural basis for implementation.*
*Implementation authority is conditional on this document remaining unchanged.*
*Any deviation from these specifications during implementation requires re-approval.*
