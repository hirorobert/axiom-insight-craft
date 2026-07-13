# SAFF ERP — IRON DOME NUCLEAR UX RE-ARCHITECTURE
## Version 2.2 · Implementation Safety Amendment · 2026-07-13

> **BASIS:** v2.1 was architecturally approved in principle. v2.2 is a narrow implementation-safety layer. It corrects 14 defects that would create data integrity failures, identity confusion, race conditions, or irreversible production damage if v2.1 were implemented as written. Missions, engine boundaries, and the approved lifecycle remain unchanged. No code. No file modifications. This document supersedes v2.1.

---

# DELIVERABLE 1 — VERSION 2.2 AMENDMENTS

## Amendment 1 — Post-Signing Amendments

**Defect in v2.1:** "A new engagement year must be created for any post-sign-off correction." This forces the use of a fake fiscal year to correct a signed engagement — creating phantom engagements, confusing filing history, and breaking the 1:1 relationship between `engagements.fiscal_year` and the actual fiscal year being reported.

**Correction:** Add an engagement revision model. The original engagement becomes a revision of type `ORIGINAL`. A correction to a signed engagement opens a new revision for the same fiscal year.

The signed snapshot remains immutable. The revision creates a new working context for corrections without touching the prior record.

---

## Amendment 2 — Snapshot Event Model

**Defect in v2.1:** `statement_snapshots.status` was described as mutable (transitioning through ACTIVE → SUPERSEDED → SIGNED). A mutable status column on an otherwise-immutable record is inconsistent. Any direct write to status bypasses the event log.

**Correction:** Status lifecycle events move to `statement_snapshot_events` (append-only). `statement_snapshots.status` becomes a cached projection. `advance_snapshot_state()` SECURITY DEFINER is the sole writer, exactly as `advance_engagement_state()` is for engagement state.

---

## Amendment 3 — XBRL State Authority

**Defect in v2.1:** `xbrl_instances.current_state` was declared mutable. `xbrl_state_events` was declared canonical. These two facts were present but the enforcement mechanism (direct write block) was not specified.

**Correction:** Declare explicitly: `xbrl_instances.current_state` is a cached projection. `advance_xbrl_state()` SECURITY DEFINER is the sole writer. A trigger blocks all direct writes. The pattern mirrors advance_engagement_state().

---

## Amendment 4 — Trusted Transition Identity

**Defect in v2.1:** `engagement_state_events` accepted `source_function`, `service_principal`, `triggered_by`, and `occurred_at` as function parameters. These are caller-supplied. A compromised caller can write false provenance.

**Correction:** Separate trusted provenance (derived inside SECURITY DEFINER from database context and JWT) from untrusted caller metadata (stored but marked as unverified). All SECURITY DEFINER functions must also set `search_path` and revoke PUBLIC execute.

---

## Amendment 5 — Idempotency

**Defect in v2.1:** No idempotency mechanism. Network failures, retries, and double-clicks can create duplicate transitions, duplicate snapshots, duplicate filing submissions, or duplicate EFDMS ingestions. Each duplicate is an Iron Dome violation because the event log becomes non-canonical.

**Correction:** Add idempotency keys to all state-changing operations. Repeated requests with the same key return the original result without creating new records.

---

## Amendment 6 — Concurrency-Safe Versioning

**Defect in v2.1:** Version numbers (statement_version, package_version, instance_version, revision_version) were implied to be sequential but no allocation mechanism was specified. Under concurrent requests, `MAX(version)+1` produces duplicates.

**Correction:** All version numbers are allocated through `allocate_version()` SECURITY DEFINER, which uses `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` on a `version_allocations` table. This is atomic under concurrent load.

---

## Amendment 7 — Partial Unique Indexes

**Defect in v2.1:** Uniqueness constraints on "current" records (one current package per engagement, one active snapshot per engagement) were described in prose but not as database constructs.

**Correction:** Define explicit partial unique indexes. PostgreSQL enforces these at the row level — they cannot be bypassed by application code.

---

## Amendment 8 — Tax AJE Terminal Gate

**Defect in v2.1:** The gate condition read "at least one AJE must be approved." This is wrong for engagements in a full tax-loss position, where the current tax provision is zero, DTA exceeds DTL, and no debit AJE is needed.

**Correction:** The gate is: every generated tax AJE is in a terminal reviewed state (APPROVED or REJECTED). Zero approved AJEs is valid only with an explicit `NO_TAX_AJE_REQUIRED` record. The approved AJE set must reconcile numerically to the finalized computation.

---

## Amendment 9 — Obligation-Neutral Monthly States

**Defect in v2.1:** `EFD_EVIDENCE_MISSING` and `VAT_RETURN_EVIDENCE_MISSING` are VAT-specific states embedded in a generic state machine shared by PAYE, SDL, WHT, Stamp Duty, and Excise. A PAYE period would enter `EFD_EVIDENCE_MISSING` — which is meaningless for PAYE.

**Correction:** Generic state machine with obligation-neutral states. Missing evidence is communicated through a typed `missing_evidence_codes` array on the compliance_period record, not through state names.

---

## Amendment 10 — Typed Compliance Evidence

**Defect in v2.1:** `compliance_evidence_sources` carried VAT-specific numeric columns (`gross_sales_evidence`, `output_vat_evidence`) on a universal table used by VAT, PAYE, SDL, and WHT. A PAYE evidence record would have NULL in every VAT column.

**Correction:** Generic metadata in `compliance_evidence_sources`. Obligation-specific numeric facts in typed extension tables: `compliance_evidence_vat`, `compliance_evidence_paye`, `compliance_evidence_sdl`, `compliance_evidence_wht`.

---

## Amendment 11 — Actor Identity Model

**Defect in v2.1:** Foreign keys for audit purposes (signed_by, approved_by, created_by) were described as `UUID FK → firm_members` without specifying whether they hold `auth.users.id` or `firm_members.id`. These are different. A user may belong to multiple firms. `auth.uid()` returns `auth.users.id`. If `firm_members.id` is used for audit FKs but the code writes `auth.uid()` directly, the FK constraint silently breaks or points to the wrong record.

**Correction:** All audit FKs reference `firm_members.id` (never `auth.users.id`). Actor identity is always derived inside SECURITY DEFINER by looking up `firm_members WHERE auth_user_id = auth.uid()` — never from caller parameters.

---

## Amendment 12 — Package Applicability

**Defect in v2.1:** Applicability of XBRL, management letter, EFDMS, and transfer pricing was described as CPA-determined per engagement. This is partially correct but insufficient. Applicability must depend on jurisdiction, return type, taxpayer category, reporting framework, effective date, and verified rule version — not on ad-hoc CPA judgment for items that are legally determined.

**Correction:** Applicability is rule-driven from an `applicability_rules` table. CPA can override only where the rule permits override. MAONO risk signals are advisory only — they never create a statutory requirement where the rule says NOT_APPLICABLE.

---

## Amendment 13 — Forward-Only Production Migrations

**Defect in v2.1:** Rollback boundaries described dropping tables as a rollback mechanism. After production data exists, dropping an audit table (engagement_state_events, statement_snapshots, filing_submissions) destroys immutable evidence. This is never permitted.

**Correction:** Production rollback means: disable feature writes, stop ingest to the new tables, preserve all existing rows, deploy a forward-correcting migration. Audit tables are never dropped.

---

## Amendment 14 — Existing-Data Backfill

**Defect in v2.1:** No protocol for migrating existing production data into the new schema. The engagements, statement_snapshots, and engagement_state_events tables will be empty on first deploy. Existing trial_balance_uploads, tax_computations, statement_sign_offs, and hesabu_validations rows have no corresponding engagement or snapshot record.

**Correction:** Define a genesis protocol that derives initial records from existing data, quarantines ambiguous cases, freezes writes during genesis, and requires explicit authorized sign-off before cutover.

---

# DELIVERABLE 2 — REVISED SCHEMA DELTAS

## 2.1 New: engagements (revised for revision model)

```
engagements {
  id                          UUID PK DEFAULT gen_random_uuid()
  company_id                  UUID NOT NULL REFERENCES companies(id)
  fiscal_year                 INTEGER NOT NULL
  fiscal_year_end             DATE NOT NULL
  reporting_framework         TEXT NOT NULL
                              CHECK (reporting_framework IN (
                                'FULL_IFRS','IFRS_FOR_SMES',
                                'IPSAS_ACCRUAL','IPSAS_CASH'  -- disabled at app layer
                              ))

  -- Revision model
  revision_type               TEXT NOT NULL DEFAULT 'ORIGINAL'
                              CHECK (revision_type IN (
                                'ORIGINAL','AMENDMENT','RESTATEMENT','REGULATOR_CORRECTION'
                              ))
  revision_number             INTEGER NOT NULL DEFAULT 1
  supersedes_revision_id      UUID REFERENCES engagements(id)
  revision_reason             TEXT    -- required when revision_type != 'ORIGINAL'
  authorized_by               UUID    -- firm_members.id; required for AMENDMENT and above
  opened_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  closed_at                   TIMESTAMPTZ  -- set when this revision is signed/filed

  -- State (cached projection — advance_engagement_state() is sole writer)
  engagement_state            TEXT NOT NULL DEFAULT 'ONBOARDING'
  state_updated_at            TIMESTAMPTZ
  current_snapshot_id         UUID REFERENCES statement_snapshots(id)

  -- Lock (set on STATEMENTS_SIGNED)
  locked_at                   TIMESTAMPTZ
  locked_by                   UUID  -- firm_members.id

  -- Policy
  engagement_policy           JSONB NOT NULL DEFAULT '{}'

  -- Audit
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  created_by                  UUID NOT NULL  -- firm_members.id

  CONSTRAINT unique_original_engagement
    UNIQUE (company_id, fiscal_year)
    WHERE revision_type = 'ORIGINAL'

  CONSTRAINT unique_revision_number
    UNIQUE (company_id, fiscal_year, revision_number)

  CONSTRAINT revision_requires_reason
    CHECK (revision_type = 'ORIGINAL' OR revision_reason IS NOT NULL)

  CONSTRAINT revision_requires_authorization
    CHECK (
      revision_type IN ('ORIGINAL','AMENDMENT')
      OR (revision_type IN ('RESTATEMENT','REGULATOR_CORRECTION') AND authorized_by IS NOT NULL)
    )

  CONSTRAINT revision_chain_same_fiscal_year
    -- enforced by trigger: supersedes_revision_id must point to same company+fiscal_year
}
```

## 2.2 New: engagement_state_events (APPEND-ONLY, revised provenance model)

```
engagement_state_events {
  id                      UUID PK DEFAULT gen_random_uuid()
  engagement_id           UUID NOT NULL REFERENCES engagements(id)
  from_state              TEXT
  to_state                TEXT NOT NULL
  idempotency_key         TEXT UNIQUE  -- null for system cascades; present for user/engine-initiated

  -- TRUSTED PROVENANCE (derived inside SECURITY DEFINER — never from caller)
  actor_firm_member_id    UUID    -- firm_members.id; null for system transitions
  actor_auth_user_id      UUID    -- auth.uid() at time of call; null for service_role
  db_role                 TEXT    -- current_user at time of call (e.g., 'authenticator','service_role')
  jwt_role                TEXT    -- role from JWT claims
  db_clock                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
                          -- always server clock; never caller-supplied

  -- UNTRUSTED CALLER METADATA (stored but not authoritative)
  caller_source_function  TEXT    -- what the caller claims called this
  caller_engine_version   TEXT    -- what the caller claims its version is
  caller_request_id       TEXT    -- caller-generated UUID for correlation
  caller_occurred_at      TIMESTAMPTZ  -- what the caller claims the time was

  -- TRIGGERING CONTEXT (derived or validated inside SECURITY DEFINER)
  trigger_type            TEXT NOT NULL
                          CHECK (trigger_type IN (
                            'user_action','engine_event','cascade','admin_override'
                          ))
  triggering_record_type  TEXT    -- table name of the record that caused this
  triggering_record_id    UUID    -- id of that record
  input_hash              TEXT    -- SHA-256 of key inputs
  transition_detail       JSONB NOT NULL DEFAULT '{}'

  -- No UPDATE, No DELETE — enforced by trigger
}
```

## 2.3 New: statement_snapshots (APPEND-ONLY, event-driven status)

```
statement_snapshots {
  id                        UUID PK DEFAULT gen_random_uuid()
  engagement_id             UUID NOT NULL REFERENCES engagements(id)
  statement_version         INTEGER NOT NULL  -- allocated by allocate_version()
  idempotency_key           TEXT UNIQUE NOT NULL

  -- Source provenance
  source_upload_id          UUID NOT NULL REFERENCES trial_balance_uploads(id)
  source_upload_hash        TEXT NOT NULL
  tax_computation_id        UUID NOT NULL REFERENCES tax_computations(id)
  tax_computation_version   INTEGER NOT NULL
  approved_aje_set_hash     TEXT NOT NULL
  management_input_hash     TEXT NOT NULL
  reporting_framework       TEXT NOT NULL
  renderer_version          TEXT NOT NULL

  -- Content (immutable after INSERT — enforced by trigger)
  statements_json           JSONB NOT NULL
  statement_hash            TEXT NOT NULL    -- SHA-256 of statements_json
  snapshot_hash             TEXT NOT NULL    -- SHA-256 of all provenance fields + statement_hash

  -- Cached status (projection of statement_snapshot_events — advance_snapshot_state() is sole writer)
  status                    TEXT NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE','SUPERSEDED','SIGNED','LOCKED','VOIDED'))

  -- Versioning chain
  supersedes_snapshot_id    UUID REFERENCES statement_snapshots(id)
  superseded_at             TIMESTAMPTZ   -- set when status → SUPERSEDED
  superseded_by_id          UUID REFERENCES statement_snapshots(id)

  -- Signing
  signed_at                 TIMESTAMPTZ   -- set when status → SIGNED (Tier 3 sign-off)
  locked_at                 TIMESTAMPTZ   -- set when status → LOCKED (post-sign)

  -- Audit (derived inside FS Renderer SECURITY DEFINER)
  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  created_by_function       TEXT NOT NULL DEFAULT 'fs-renderer'

  CONSTRAINT snapshot_hash_unique UNIQUE (snapshot_hash)
  CONSTRAINT statement_version_unique UNIQUE (engagement_id, statement_version)
  CONSTRAINT no_self_supersede CHECK (supersedes_snapshot_id <> id)
}

-- Partial unique index: only one ACTIVE snapshot per engagement revision
CREATE UNIQUE INDEX one_active_snapshot_per_engagement
  ON statement_snapshots (engagement_id)
  WHERE status = 'ACTIVE';
```

## 2.4 New: statement_snapshot_events (APPEND-ONLY)

```
statement_snapshot_events {
  id                      UUID PK DEFAULT gen_random_uuid()
  snapshot_id             UUID NOT NULL REFERENCES statement_snapshots(id)
  event_type              TEXT NOT NULL
                          CHECK (event_type IN (
                            'CREATED','SUPERSEDED','SIGNED','LOCKED','VOIDED'
                          ))
  actor_firm_member_id    UUID    -- null for system events
  actor_auth_user_id      UUID    -- null for system events
  db_role                 TEXT NOT NULL
  db_clock                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  triggering_record_type  TEXT
  triggering_record_id    UUID
  event_detail            JSONB NOT NULL DEFAULT '{}'
  idempotency_key         TEXT UNIQUE

  -- No UPDATE, No DELETE
}
```

## 2.5 New: xbrl_instances (revised — current_state is cached projection)

```
xbrl_instances {
  id                        UUID PK DEFAULT gen_random_uuid()
  engagement_id             UUID NOT NULL REFERENCES engagements(id)
  statement_snapshot_id     UUID NOT NULL REFERENCES statement_snapshots(id)
  instance_version          INTEGER NOT NULL  -- allocated by allocate_version()
  idempotency_key           TEXT UNIQUE NOT NULL

  -- Cached state (advance_xbrl_state() is sole writer — direct writes blocked)
  current_state             TEXT NOT NULL DEFAULT 'DRAFT'
                            CHECK (current_state IN (
                              'DRAFT','GENERATED','VALIDATION_FAILED','VALIDATED',
                              'EXPORTED','SUBMITTED','ACKNOWLEDGED','REJECTED'
                            ))
  state_updated_at          TIMESTAMPTZ

  taxonomy_version          TEXT NOT NULL
  instance_file_id          UUID       -- Supabase Storage
  instance_hash             TEXT
  validation_errors         JSONB      -- populated on VALIDATION_FAILED
  supersedes_instance_id    UUID REFERENCES xbrl_instances(id)

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  created_by_function       TEXT NOT NULL DEFAULT 'generate-xbrl'

  CONSTRAINT instance_version_unique UNIQUE (engagement_id, instance_version)
}

-- xbrl_state_events: canonical history (defined in v2.1 Section 4.3, trusted provenance added)
-- Partial unique index: one VALIDATED instance per engagement
CREATE UNIQUE INDEX one_validated_xbrl_per_engagement
  ON xbrl_instances (engagement_id)
  WHERE current_state = 'VALIDATED';
```

## 2.6 New: filing_packages (partial unique index added)

```
-- From v2.1 with additions:

-- Partial unique index replacing the removed UNIQUE(engagement_id)
CREATE UNIQUE INDEX one_current_package_per_engagement_revision
  ON filing_packages (engagement_id)
  WHERE is_current = TRUE AND package_state NOT IN ('VOIDED','SUPERSEDED');
```

## 2.7 New: version_allocations (concurrency-safe versioning)

```
version_allocations {
  entity_type     TEXT NOT NULL    -- 'statement_snapshot' | 'filing_package' |
                                   -- 'xbrl_instance' | 'engagement_revision' |
                                   -- 'tax_computation'
  entity_id       UUID NOT NULL    -- the engagement_id or parent entity id
  current_version INTEGER NOT NULL DEFAULT 0
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()

  PRIMARY KEY (entity_type, entity_id)
}
```

## 2.8 New: idempotency_keys (cross-operation deduplication)

```
idempotency_keys {
  key             TEXT NOT NULL
  operation_type  TEXT NOT NULL    -- 'engagement_transition' | 'tax_finalization' |
                                   -- 'snapshot_creation' | 'package_assembly' |
                                   -- 'xbrl_generation' | 'filing_submission' |
                                   -- 'efdms_batch_ingest'
  result_json     JSONB NOT NULL   -- the response returned on first successful execution
  engagement_id   UUID             -- FK for scope scoping; nullable for cross-engagement ops
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  expires_at      TIMESTAMPTZ      -- null = permanent; set for short-lived ops

  PRIMARY KEY (key, operation_type)
}
```

## 2.9 New: actor_identity helper (not a table — a function)

```sql
-- Canonical way to resolve actor inside any SECURITY DEFINER function
-- Returns firm_members.id for the current authenticated user in the current firm context
-- Raises exception if user has no firm membership (prevents ghost writes)

CREATE OR REPLACE FUNCTION resolve_actor_firm_member(p_firm_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member_id UUID;
BEGIN
  SELECT id INTO v_member_id
  FROM firm_members
  WHERE auth_user_id = auth.uid()
    AND firm_id = p_firm_id
    AND status = 'active';

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'No active firm membership for current user in firm %', p_firm_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN v_member_id;
END;
$$;

REVOKE ALL ON FUNCTION resolve_actor_firm_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_actor_firm_member(UUID) TO authenticated;
```

## 2.10 New: tax_aje_terminal_gate (replacing prior gate)

```
tax_aje_reconciliation {
  id                          UUID PK
  tax_computation_id          UUID NOT NULL REFERENCES tax_computations(id)
  engagement_id               UUID NOT NULL REFERENCES engagements(id)

  -- For zero-AJE case
  no_tax_aje_required         BOOLEAN NOT NULL DEFAULT FALSE
  no_aje_reason               TEXT    -- required if no_tax_aje_required = TRUE
  no_aje_authorized_by        UUID    -- firm_members.id; required if no_tax_aje_required = TRUE
  no_aje_authorized_at        TIMESTAMPTZ

  -- Reconciliation amounts
  finalized_current_tax       NUMERIC NOT NULL  -- from tax_computations
  finalized_dta               NUMERIC NOT NULL
  finalized_dtl               NUMERIC NOT NULL
  approved_aje_current_tax    NUMERIC NOT NULL DEFAULT 0  -- sum of approved AJEs
  approved_aje_dta            NUMERIC NOT NULL DEFAULT 0
  approved_aje_dtl            NUMERIC NOT NULL DEFAULT 0
  reconciliation_difference   NUMERIC GENERATED ALWAYS AS (
    (finalized_current_tax - approved_aje_current_tax) +
    (finalized_dta - approved_aje_dta) +
    (finalized_dtl - approved_aje_dtl)
  ) STORED
  reconciliation_tolerance    NUMERIC NOT NULL DEFAULT 0  -- set per engagement policy
  gate_passed                 BOOLEAN GENERATED ALWAYS AS (
    (no_tax_aje_required = TRUE AND no_aje_authorized_by IS NOT NULL)
    OR
    (ABS(reconciliation_difference) <= reconciliation_tolerance)
  ) STORED

  created_at                  TIMESTAMPTZ NOT NULL
}
```

## 2.11 New: applicability_rules

```
applicability_rules {
  id                    UUID PK DEFAULT gen_random_uuid()
  rule_code             TEXT NOT NULL UNIQUE   -- e.g. 'XBRL_REQUIRED', 'EFDMS_REQUIRED', 'MGMT_LETTER_REQUIRED'
  gate_id               TEXT NOT NULL          -- references filing checklist gate (e.g. 'G5','G7','G10')
  description           TEXT NOT NULL

  -- Scoping dimensions (NULL = applies to all)
  jurisdiction          TEXT DEFAULT 'TZA'
  return_type           TEXT    -- 'ANNUAL_CIT' | 'VAT' | etc.
  taxpayer_category     TEXT    -- 'RESIDENT' | 'NON_RESIDENT' | 'PERMANENT_ESTABLISHMENT' | 'EXEMPT'
  reporting_framework   TEXT    -- 'FULL_IFRS' | 'IFRS_FOR_SMES' | etc.
  effective_from        DATE NOT NULL
  effective_to          DATE    -- null = currently in force
  verified_rule_version TEXT NOT NULL  -- references a statutory_rules.verified_at or legislation ref

  -- Applicability outcome
  default_applicability TEXT NOT NULL
                        CHECK (default_applicability IN ('APPLICABLE','NOT_APPLICABLE'))
  cpa_override_permitted BOOLEAN NOT NULL DEFAULT FALSE
  override_requires_role TEXT    -- minimum role to override: 'cpa' | 'partner'
  override_requires_reason BOOLEAN NOT NULL DEFAULT TRUE

  -- Source of truth
  legislation_reference TEXT NOT NULL
  verified_at           TIMESTAMPTZ NOT NULL
  verified_by           UUID  -- firm_members.id of person who verified

  created_at            TIMESTAMPTZ NOT NULL
  created_by            UUID NOT NULL
}
```

---

# DELIVERABLE 3 — TRANSACTION AND IDEMPOTENCY CONTRACTS

## 3.1 Master Contract for All State-Changing Operations

Every state-changing operation in the system — regardless of which engine initiates it — must follow this contract:

```
CONTRACT: state_changing_operation

INPUTS
  idempotency_key:   TEXT NOT NULL     -- caller-generated UUID or deterministic hash
  operation_type:    TEXT NOT NULL     -- identifies which operation this is
  [operation-specific parameters]

STEP 1 — IDEMPOTENCY CHECK (before any lock)
  SELECT result_json FROM idempotency_keys
  WHERE key = idempotency_key AND operation_type = operation_type;

  IF FOUND AND result_json IS NOT NULL:
    RETURN result_json  -- return original result; do nothing else
  IF FOUND AND result_json IS NULL:
    RAISE 'Operation in progress — retry after a brief delay'
    -- This handles concurrent duplicate requests

STEP 2 — CLAIM THE KEY (atomic, before proceeding)
  INSERT INTO idempotency_keys (key, operation_type, result_json, engagement_id)
  VALUES (idempotency_key, operation_type, NULL, p_engagement_id)
  ON CONFLICT DO NOTHING;

  IF NOT INSERTED:
    -- Another concurrent request claimed it first
    WAIT briefly; retry STEP 1

STEP 3 — RESOLVE TRUSTED ACTOR
  v_firm_member_id := resolve_actor_firm_member(p_firm_id);
  -- For system transitions: v_firm_member_id = NULL; db_role = current_user

STEP 4 — ACQUIRE LOCK (if concurrency required)
  SELECT ... FOR UPDATE on the relevant parent row (engagement, snapshot, etc.)

STEP 5 — VALIDATE PRECONDITIONS
  Check all gate conditions. If any fail:
    UPDATE idempotency_keys SET result_json = '{"success":false,"blocked_reason":"..."}' WHERE key = ...
    RETURN failure result

STEP 6 — EXECUTE WRITE (within same transaction as step 4)
  Perform the actual INSERT/UPDATE.

STEP 7 — WRITE EVENT (same transaction)
  INSERT into the relevant append-only event table with trusted provenance.

STEP 8 — RELEASE IDEMPOTENCY RESULT
  UPDATE idempotency_keys
  SET result_json = [success result]
  WHERE key = idempotency_key AND operation_type = operation_type;

STEP 9 — COMMIT

ON ANY FAILURE IN STEPS 4–8:
  The transaction rolls back.
  The idempotency_keys row remains with result_json = NULL.
  STEP 1 on retry will see result_json = NULL and treat as "in progress".
  After a configurable TTL (default 60 seconds), an orphaned NULL-result key may be deleted
  by a cleanup job, allowing the caller to retry with the same key.
```

## 3.2 Operation-Specific Contracts

| Operation | Idempotency key derivation | Lock target | Event table |
|---|---|---|---|
| Engagement transition | `SHA256(engagement_id + to_state + caller_request_id)` | `engagements FOR UPDATE` | engagement_state_events |
| Tax finalization | `SHA256(tax_computation_id + 'finalize')` | `tax_computations FOR UPDATE` | engagement_state_events |
| Snapshot creation | `SHA256(engagement_id + source_upload_hash + approved_aje_set_hash + management_input_hash)` | `engagements FOR UPDATE` | statement_snapshot_events |
| Filing package assembly | `SHA256(engagement_id + statement_snapshot_id + 'assemble')` | `engagements FOR UPDATE` | engagement_state_events |
| XBRL generation | `SHA256(engagement_id + statement_snapshot_id + taxonomy_version)` | `engagements FOR UPDATE` | xbrl_state_events |
| Filing submission (annual) | `SHA256(engagement_id + return_type + submission_reference)` | `filing_packages FOR UPDATE` | — (filing_submissions is canonical) |
| Filing submission (monthly) | `SHA256(compliance_period_id + return_type + submission_reference)` | `compliance_periods FOR UPDATE` | — |
| EFDMS batch ingest | `SHA256(company_id + fiscal_year + period_month + file_hash)` | None (append-only write) | — |

## 3.3 SECURITY DEFINER Function Standard

Every SECURITY DEFINER function in the system must satisfy:

```sql
CREATE OR REPLACE FUNCTION <function_name>(...)
RETURNS <type>
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp   -- MANDATORY: prevents search path injection
AS $$
...
$$;

-- MANDATORY: revoke default PUBLIC execute
REVOKE ALL ON FUNCTION <function_name>(...) FROM PUBLIC;

-- MANDATORY: grant only to required role(s)
GRANT EXECUTE ON FUNCTION <function_name>(...) TO authenticated;
-- or:
GRANT EXECUTE ON FUNCTION <function_name>(...) TO service_role;
```

`SET search_path = public, pg_temp` is not optional. Without it, a malicious extension or schema object can intercept calls by shadowing public functions in a schema earlier in the search path.

The complete list of SECURITY DEFINER functions in this architecture:

| Function | Granted To |
|---|---|
| advance_engagement_state() | authenticated, service_role |
| advance_snapshot_state() | service_role (FS Renderer only) |
| advance_xbrl_state() | authenticated, service_role |
| finalize_tax_computation() | authenticated (cpa, partner roles only) |
| generate_tax_ajes() | service_role (kinga-tax-engine only) |
| resolve_actor_firm_member() | authenticated |
| allocate_version() | authenticated, service_role |
| hesabu_write_validation() | service_role (hesabu-validate only) |
| hesabu_block_signoff() | postgres (trigger function) |
| block_direct_state_write() | postgres (trigger function) |
| block_direct_xbrl_state_write() | postgres (trigger function) |
| block_direct_snapshot_status_write() | postgres (trigger function) |
| reconcile_engagement_state() | service_role (admin utility only) |
| safisha_resolve_exception() | authenticated (cpa, partner) |

---

# DELIVERABLE 4 — CONCURRENCY RULES

## 4.1 Version Allocation (Concurrency-Safe)

```sql
CREATE OR REPLACE FUNCTION allocate_version(
  p_entity_type TEXT,
  p_entity_id   UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_version INTEGER;
BEGIN
  INSERT INTO version_allocations (entity_type, entity_id, current_version, updated_at)
  VALUES (p_entity_type, p_entity_id, 1, clock_timestamp())
  ON CONFLICT (entity_type, entity_id) DO UPDATE
    SET current_version = version_allocations.current_version + 1,
        updated_at = clock_timestamp()
  RETURNING current_version INTO v_version;

  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION allocate_version(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION allocate_version(TEXT, UUID) TO authenticated, service_role;
```

This INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING pattern is atomic. No two concurrent callers can receive the same version number. No MAX(version)+1 is used anywhere.

## 4.2 Version Allocation Scope

| Version type | entity_type | entity_id |
|---|---|---|
| statement_version | 'statement_snapshot' | engagement_id |
| filing package version | 'filing_package' | engagement_id |
| xbrl instance version | 'xbrl_instance' | engagement_id |
| engagement revision number | 'engagement_revision' | SHA256(company_id + fiscal_year) cast to UUID |
| tax computation version | 'tax_computation' | engagement_id |

## 4.3 Row-Level Locking Protocol

Operations that must not run concurrently on the same engagement:

```
Transition A: engagement state advance
Transition B: snapshot creation
Transition C: snapshot supersession
Transition D: tax finalization
Transition E: filing package assembly

All of A–E must SELECT ... FOR UPDATE on the engagements row before proceeding.
This serializes all state-changing operations on an engagement.

Timeout: lock acquisition times out after 5 seconds.
On timeout: return error { success: false, blocked_reason: 'LOCK_TIMEOUT', retry: true }
The caller should retry with the same idempotency_key (which will find the original result
if the competing operation succeeded, or retry the operation if it failed).
```

## 4.4 Snapshot Supersession Race Condition

A supersession cascade (triggered when tax changes) must atomically:
1. Lock the engagements row
2. Lock the current active snapshot row (SELECT ... FOR UPDATE)
3. Set the old snapshot status → SUPERSEDED
4. Insert the new snapshot
5. Update engagements.current_snapshot_id
6. Void all unsigned sign-off tiers

Steps 1–6 are in a single transaction. If any step fails, the transaction rolls back and the old snapshot remains ACTIVE.

## 4.5 No Unprotected MAX(version)+1

Any code that uses `MAX(version) + 1` or `COUNT(*) + 1` for version generation is a bug. All version allocations go through `allocate_version()`. This is enforced at code review.

---

# DELIVERABLE 5 — ENGAGEMENT REVISION MODEL

## 5.1 What a Revision Is

A revision is a new working context for a signed engagement. It allows corrections, restatements, and regulator-mandated changes without creating a fake fiscal year and without touching the original signed records.

```
Engagement (company: Acme, fiscal_year: 2025, revision_type: ORIGINAL, revision_number: 1)
  └── All missions run here. Snapshot v1 signed. State: FILED.

Engagement (company: Acme, fiscal_year: 2025, revision_type: AMENDMENT, revision_number: 2)
  supersedes_revision_id → original engagement id
  revision_reason: "Restated depreciation charge per auditor instruction"
  authorized_by: partner_member_id
  └── Missions run again on this revision. New snapshot created. New tax computation.
      Original snapshot (revision 1) remains SIGNED and LOCKED — immutable.
```

## 5.2 Revision Types

| Type | When Used | Authorization Required |
|---|---|---|
| ORIGINAL | First issuance for this company + fiscal year | None (standard creation) |
| AMENDMENT | Correction after sign-off; figures change | partner or director role |
| RESTATEMENT | Material error correction; comparative figures change | partner or director; audit committee notification |
| REGULATOR_CORRECTION | TRA or other regulator has required a change | partner or director; regulatory reference required |

## 5.3 Revision Lifecycle

A revision follows the same state machine as the original engagement (ONBOARDING → … → FILED). However:

- An AMENDMENT starts at a reduced starting state. If only a management input changed, it can start at STATEMENT_SNAPSHOT_CREATED and skip back through the chain. If tax changed, it starts at TAX_COMPUTED_DRAFT.
- A RESTATEMENT always starts at DRAFT_STATEMENTS_READY (comparative figures must be re-derived).
- A REGULATOR_CORRECTION starts at whatever state the regulator's required change affects.

The starting state for a revision is determined by the `revision_change_type`:

```
revision_change_type (on the engagements row):
  MANAGEMENT_INPUT_ONLY     → start at TAX_ADJUSTMENTS_APPLIED
  TAX_CHANGE_ONLY           → start at DRAFT_HESABU_PASSED
  STATEMENT_CHANGE_ONLY     → start at RECONCILED
  FULL_RESTATEMENT          → start at DRAFT_STATEMENTS_READY
  REGULATOR_DIRECTED        → start state specified by authorized_by
```

## 5.4 What Is Carried Forward vs. Re-Run

| Item | AMENDMENT | RESTATEMENT | REGULATOR_CORRECTION |
|---|---|---|---|
| Trial balance upload | Carry forward (same upload) | Re-upload if figures change | As directed |
| SAFISHA reconciliation | Carry forward | Re-run | As directed |
| Draft statements | Re-generate from change | Re-generate fully | As directed |
| HESABU (draft) | Re-run | Re-run | Re-run |
| Tax computation | May carry forward or re-run | Re-run | As directed |
| Tax AJEs | May carry forward or re-generate | Re-generate | As directed |
| Final statements | Always re-generate | Always re-generate | Always re-generate |
| HESABU (final) | Always re-run | Always re-run | Always re-run |
| Sign-off chain | Always fresh | Always fresh | Always fresh |
| Filing package | Always new version | Always new version | Always new version |

## 5.5 Original Snapshot Remains Immutable

The original signed snapshot (from revision 1) is permanently LOCKED. It does not become SUPERSEDED when a revision opens — it is superseded only within the same revision's snapshot chain. The revision distinction means:

```
Revision 1, Snapshot v1 → status: SIGNED, locked: TRUE  (immutable forever)
Revision 2, Snapshot v1 → status: ACTIVE                (new revision, new snapshot chain)
```

If the amendment is later itself corrected (Revision 3), Revision 2's final snapshot becomes SUPERSEDED within Revision 2's chain and Revision 2's engagement is closed. Revision 1 remains SIGNED and LOCKED.

## 5.6 Filing Package Link to Revision

All filing artifacts are scoped to an `engagement_id`. Since each revision is its own engagement record with its own ID, there is no risk of a Revision 2 filing package overwriting a Revision 1 filing package. They are separate rows with separate engagement_ids.

```
Statutory filing history for Acme FY2025:
  filing_submissions (engagement_id: revision_1_id, return_type: ANNUAL_CIT, reference: TRA-001)
  filing_submissions (engagement_id: revision_2_id, return_type: ANNUAL_CIT, reference: TRA-002-AMENDED)
```

---

# DELIVERABLE 6 — GENERIC MONTHLY COMPLIANCE MODEL

## 6.1 Obligation-Neutral State Machine

All compliance periods — regardless of obligation type — use the same state machine. Missing evidence is communicated through a typed `missing_evidence_codes` array, not through state names.

```
OPEN
    │  Period created; no evidence yet
    │  missing_evidence_codes = []
    ▼
EVIDENCE_GATHERING
    │  At least one evidence source record created; not yet approved
    │  missing_evidence_codes populated by advance_compliance_period_state()
    │  based on obligation_type requirements (see 6.2)
    ▼
EVIDENCE_INCOMPLETE  ← non-terminal; returns to EVIDENCE_GATHERING when evidence added
    │  missing_evidence_codes is non-empty
    │  UI displays obligation-specific messages from the code list
    ▼
READY_TO_RECONCILE
    │  All required evidence sources in APPROVED state
    │  missing_evidence_codes = []
    ▼
RECONCILIATION_IN_PROGRESS
    │  CPA has started the reconciliation
    ▼
RECONCILED_CLEAN       ← gap is within materiality
RECONCILED_GAP         ← gap exceeds materiality; documented
    │  Either state requires an explicit CPA acknowledgement
    ▼
GAP_UNDER_REVIEW       ← from RECONCILED_GAP when gap is disputed or needs escalation
GAP_RESOLVED           ← CPA has documented resolution; may still have a gap but it is closed
    ▼
READY_TO_FILE
    │  Reconciliation is in a terminal state (CLEAN, RESOLVED, or CPA-acknowledged GAP)
    │  Payment evidence recorded if payment is due
    ▼
FILED
       Evidence: filing_submissions row (compliance_period_id populated)
```

## 6.2 Missing Evidence Codes by Obligation

| Code | Obligation | Meaning |
|---|---|---|
| VAT_EFDMS_Z_REPORTS_MISSING | VAT | No Z-report evidence for this period |
| VAT_RETURN_MISSING | VAT | No approved filed VAT return evidence |
| VAT_PAYMENT_RECEIPT_MISSING | VAT | Tax due but no payment evidence |
| PAYE_PAYROLL_REGISTER_MISSING | PAYE | No approved payroll register for period |
| PAYE_P9_FORM_MISSING | PAYE | P9 forms for employees not submitted |
| PAYE_PAYMENT_RECEIPT_MISSING | PAYE | PAYE withheld but no payment evidence |
| SDL_PAYROLL_MISSING | SDL | No payroll evidence (SDL base = gross emoluments) |
| SDL_PAYMENT_RECEIPT_MISSING | SDL | SDL levy not evidenced as paid |
| WHT_PAYMENT_SCHEDULE_MISSING | WHT | No schedule of WHT payments made |
| WHT_CERTIFICATES_MISSING | WHT | WHT certificates to recipients not issued/recorded |
| WHT_PAYMENT_RECEIPT_MISSING | WHT | WHT amount not evidenced as remitted to TRA |
| EXCISE_DECLARATION_MISSING | EXCISE | Excise declaration not filed |
| STAMP_DUTY_INSTRUMENT_MISSING | STAMP_DUTY | No stamped instrument on file |

## 6.3 Required Evidence by Obligation

The `advance_compliance_period_state()` function evaluates required evidence based on `obligation_type`:

| Obligation | Required evidence types | Optional |
|---|---|---|
| VAT | EFDMS_Z_REPORT (if is_efd_registered) + FILED_RETURN | PAYMENT_RECEIPT (if tax due) |
| PAYE | PAYROLL_REGISTER + P9_FORMS (if employee count > 0) | PAYMENT_RECEIPT |
| SDL | PAYROLL_REGISTER | PAYMENT_RECEIPT |
| WHT | WHT_SCHEDULE + WHT_CERTIFICATES | PAYMENT_RECEIPT |
| EXCISE | EXCISE_DECLARATION | PAYMENT_RECEIPT |
| STAMP_DUTY | INSTRUMENT_COPY | — |

The `is_efd_registered` flag on the company record gates Z-report requirements for VAT. If a VAT-registered company is not EFD-registered (early-stage or exemption), VAT_EFDMS_Z_REPORTS_MISSING is not raised.

---

# DELIVERABLE 7 — TYPED EVIDENCE MODEL

## 7.1 Generic Evidence Metadata

```
compliance_evidence_sources {
  id                        UUID PK DEFAULT gen_random_uuid()
  compliance_period_id      UUID NOT NULL REFERENCES compliance_periods(id)
  idempotency_key           TEXT UNIQUE NOT NULL

  evidence_type             TEXT NOT NULL
                            CHECK (evidence_type IN (
                              'EFDMS_Z_REPORT',
                              'TRA_API_PULL',
                              'FILED_RETURN_UPLOAD',
                              'APPROVED_SCHEDULE',
                              'MANUAL_CONFIRMED',
                              'TRA_CORRESPONDENCE',
                              'PAYROLL_REGISTER',
                              'P9_FORMS',
                              'WHT_SCHEDULE',
                              'WHT_CERTIFICATES',
                              'EXCISE_DECLARATION',
                              'STAMPED_INSTRUMENT',
                              'PAYMENT_RECEIPT'
                            ))

  evidence_state            TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (evidence_state IN (
                              'PENDING','RECEIVED','UNDER_REVIEW','APPROVED','REJECTED'
                            ))

  -- Generic provenance (no obligation-specific numerics here)
  file_id                   UUID          -- Supabase Storage
  file_hash                 TEXT          -- SHA-256
  api_pull_reference        TEXT          -- TRA API transaction ID (for TRA_API_PULL)
  period_covered            TEXT          -- e.g. '2025-06'
  source_description        TEXT          -- human-readable description of what this is

  -- Review
  reviewed_by               UUID          -- firm_members.id
  reviewed_at               TIMESTAMPTZ
  review_notes              TEXT
  confirmed_by              UUID          -- firm_members.id (final approval)
  confirmed_at              TIMESTAMPTZ

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  created_by                UUID NOT NULL -- firm_members.id
}
```

## 7.2 VAT Evidence Extension

```
compliance_evidence_vat {
  evidence_source_id        UUID PK REFERENCES compliance_evidence_sources(id)

  -- Filed VAT return figures (from FILED_RETURN_UPLOAD, TRA_API_PULL, or APPROVED_SCHEDULE)
  gross_sales_filed         NUMERIC(18,2)
  zero_rated_sales_filed    NUMERIC(18,2)
  exempt_sales_filed        NUMERIC(18,2)
  taxable_sales_filed       NUMERIC(18,2)    -- gross - zero_rated - exempt
  output_vat_filed          NUMERIC(18,2)    -- 18% of taxable_sales
  input_vat_claimed_filed   NUMERIC(18,2)
  net_vat_payable_filed     NUMERIC(18,2)    -- output - input
  late_payment_penalty      NUMERIC(18,2)    -- if any
  interest_charged          NUMERIC(18,2)    -- if any
  total_vat_due_filed       NUMERIC(18,2)

  -- EFDMS summary (from EFDMS_Z_REPORT batch) — aggregated from efdms_z_reports
  efdms_gross_sales_sum     NUMERIC(18,2)
  efdms_vat_collected_sum   NUMERIC(18,2)
  efdms_z_report_count      INTEGER
  efdms_period_covered_from DATE
  efdms_period_covered_to   DATE

  -- Reconciliation gap (computed, not stored — generated at query time)
  -- gross_sales_gap = gross_sales_filed - efdms_gross_sales_sum
  -- vat_gap = output_vat_filed - efdms_vat_collected_sum

  currency                  TEXT NOT NULL DEFAULT 'TZS'
}
```

## 7.3 PAYE Evidence Extension

```
compliance_evidence_paye {
  evidence_source_id        UUID PK REFERENCES compliance_evidence_sources(id)

  payroll_period_from       DATE NOT NULL
  payroll_period_to         DATE NOT NULL
  employee_count            INTEGER NOT NULL
  total_gross_emoluments    NUMERIC(18,2) NOT NULL
  total_exempt_income       NUMERIC(18,2) NOT NULL DEFAULT 0
  total_taxable_income      NUMERIC(18,2) NOT NULL
  paye_withheld             NUMERIC(18,2) NOT NULL
  paye_remitted             NUMERIC(18,2) NOT NULL DEFAULT 0
  paye_outstanding          NUMERIC(18,2) GENERATED ALWAYS AS
                            (paye_withheld - paye_remitted) STORED
  p9_forms_issued           INTEGER
  currency                  TEXT NOT NULL DEFAULT 'TZS'
}
```

## 7.4 SDL Evidence Extension

```
compliance_evidence_sdl {
  evidence_source_id        UUID PK REFERENCES compliance_evidence_sources(id)

  payroll_period_from       DATE NOT NULL
  payroll_period_to         DATE NOT NULL
  employee_count            INTEGER NOT NULL
  total_gross_emoluments    NUMERIC(18,2) NOT NULL
  sdl_rate_applied          NUMERIC(5,4) NOT NULL   -- e.g. 0.045 for 4.5%
  sdl_levy_computed         NUMERIC(18,2) NOT NULL
  sdl_remitted              NUMERIC(18,2) NOT NULL DEFAULT 0
  sdl_outstanding           NUMERIC(18,2) GENERATED ALWAYS AS
                            (sdl_levy_computed - sdl_remitted) STORED
  currency                  TEXT NOT NULL DEFAULT 'TZS'
}
```

## 7.5 WHT Evidence Extension

```
compliance_evidence_wht {
  evidence_source_id        UUID PK REFERENCES compliance_evidence_sources(id)

  payment_category          TEXT NOT NULL
                            CHECK (payment_category IN (
                              'DIVIDEND','INTEREST','ROYALTY',
                              'TECHNICAL_SERVICE_FEE','MANAGEMENT_FEE',
                              'RENT','OTHER'
                            ))
  recipient_tin             TEXT
  recipient_name            TEXT
  gross_payment             NUMERIC(18,2) NOT NULL
  wht_rate_applied          NUMERIC(5,4) NOT NULL
  wht_withheld              NUMERIC(18,2) NOT NULL
  wht_remitted              NUMERIC(18,2) NOT NULL DEFAULT 0
  wht_outstanding           NUMERIC(18,2) GENERATED ALWAYS AS
                            (wht_withheld - wht_remitted) STORED
  legislation_reference     TEXT    -- e.g. 'ITA s.83(1)(a)'
  certificate_issued        BOOLEAN NOT NULL DEFAULT FALSE
  currency                  TEXT NOT NULL DEFAULT 'TZS'
}
```

## 7.6 EFDMS Z-Report Link (unchanged from v2.1 correction)

`efdms_z_reports` rows link to `compliance_evidence_sources` where `evidence_type = 'EFDMS_Z_REPORT'`. The numeric totals from Z-reports aggregate into `compliance_evidence_vat.efdms_gross_sales_sum` and `efdms_vat_collected_sum` at query time — they are not duplicated on the evidence record.

---

# DELIVERABLE 8 — APPLICABILITY RULE MODEL

## 8.1 Rule Evaluation Contract

Applicability for every checklist gate is determined by:

```
STEP 1: Query applicability_rules WHERE
  gate_id = gate
  AND jurisdiction = 'TZA' (or company.jurisdiction)
  AND (return_type IS NULL OR return_type = engagement.return_type)
  AND (taxpayer_category IS NULL OR taxpayer_category = company.taxpayer_category)
  AND (reporting_framework IS NULL OR reporting_framework = engagement.reporting_framework)
  AND effective_from <= engagement.fiscal_year_end
  AND (effective_to IS NULL OR effective_to >= engagement.fiscal_year_start)
  ORDER BY effective_from DESC LIMIT 1;

STEP 2: If no rule found → gate state = 'APPLICABLE' (default assumption)
         If rule.default_applicability = 'APPLICABLE' → gate state = 'APPLICABLE'
         If rule.default_applicability = 'NOT_APPLICABLE' → gate state = 'NOT_APPLICABLE'

STEP 3: CPA override (only if rule.cpa_override_permitted = TRUE)
  A CPA with minimum role rule.override_requires_role may change state to
  NOT_APPLICABLE (if default is APPLICABLE) or vice versa.
  If rule.override_requires_reason = TRUE, a reason text is mandatory.
  Override is recorded in filing_packages.checklist_results with:
    { status: 'NOT_APPLICABLE', override_by: firm_member_id, override_reason: '...', override_at: '...' }

STEP 4: MAONO risk signals
  If MAONO risk level >= 'HIGH' for a risk category linked to this gate:
    A risk_recommendation is added to the gate entry in checklist_results.
    risk_recommendation does NOT change the gate's applicability state.
    risk_recommendation is advisory text only.
    A gate that is NOT_APPLICABLE by rule remains NOT_APPLICABLE regardless of MAONO risk.
```

## 8.2 Seeded Applicability Rules for Tanzania (Initial Set)

| Rule Code | Gate | Default | Override | Condition |
|---|---|---|---|---|
| XBRL_REQUIRED_TZA | G10 | APPLICABLE | cpa (with reason) | All annual ANNUAL_CIT returns |
| EFDMS_REQUIRED_VAT | G5 | APPLICABLE | cpa (with reason) | company.is_efd_registered = TRUE |
| EFDMS_NOT_REQUIRED_NON_VAT | G5 | NOT_APPLICABLE | No override | company.is_vat_registered = FALSE |
| TP_DOC_REQUIRED | G7 | NOT_APPLICABLE | cpa (with reason) | Default; CPA sets APPLICABLE if TP threshold met |
| TP_DOC_REQUIRED_LARGE | G7 | APPLICABLE | partner only | company.taxpayer_category = 'LARGE' |
| THIN_CAP_GATE | G8 | NOT_APPLICABLE | cpa (with reason) | Default; APPLICABLE if related-party debt present |
| MGMT_LETTER_POLICY | filing package | Per engagement_policy | partner (with reason) | Driven by engagement_policy.management_letter_required |

## 8.3 Applicability Independence from MAONO

MAONO may detect that transfer pricing risk is HIGH based on related-party transaction patterns. This generates a risk_recommendation on G7 (TP Documentation). But:

- If applicability_rules says G7 is NOT_APPLICABLE (no related-party debt above threshold): it remains NOT_APPLICABLE
- The MAONO finding is displayed as: "ADVISORY: Transfer pricing risk detected. CPA should review whether TP documentation requirements apply."
- The CPA may then apply a CPA override to change G7 to APPLICABLE — but this is a CPA decision, not an automatic MAONO escalation

MAONO cannot write to `applicability_rules`, cannot change gate states, and cannot create statutory requirements. This is constitutionally prohibited.

---

# DELIVERABLE 9 — BACKFILL AND CUTOVER PROTOCOL

## 9.1 The Backfill Problem

At the time of deployment, the following existing data exists in production:
- `trial_balance_uploads` rows (existing upload history)
- `tax_computations` rows (existing computations, some signed)
- `statement_sign_offs` rows (existing sign-offs)
- `hesabu_validations` rows (existing validation results)
- `efdms_z_reports` rows (existing EFDMS records)
- `findings` rows (existing findings)
- `adjusting_journal_entries` rows (existing AJEs)

The new schema requires:
- One `engagements` row per (company, fiscal_year)
- One `statement_snapshots` row for each signed period
- `engagement_state_events` bootstrapped from existing data
- `compliance_evidence_sources` linking to existing efdms_z_reports

None of these exist yet.

## 9.2 Genesis Protocol — Six Stages

### Stage 0: Pre-Flight Inventory (no writes)

Run a read-only analysis query across all production tables. Produce:

```
GENESIS DRY-RUN REPORT
Generated: [timestamp]

Companies: [count]
Uploads per company: [distribution]
Signed engagements: [count]
Unsigned (in-progress) engagements: [count]
Tax computations: [count] (of which finalized: [count])
Sign-off chains: [count] (Tier 1 only: [count], Tier 2: [count], Tier 3 complete: [count])
EFDMS records: [count]
Findings (open): [count]
Findings (closed): [count]

AMBIGUITY QUEUE:
  Companies with multiple fiscal year uploads: [list]
  Uploads with no matching company: [count]
  Sign-offs with no corresponding HESABU pass: [count]
  Tax computations with no linked upload: [count]
  AJEs with no matching computation: [count]
```

### Stage 1: Ambiguity Resolution

The ambiguity queue from Stage 0 must be manually reviewed and resolved before genesis proceeds. Each ambiguous case is assigned:

- `DERIVABLE`: the correct mapping can be determined from existing data
- `REQUIRES_CPA_INPUT`: a CPA must specify which upload/computation the record belongs to
- `SKIP`: the record is historical noise and will not be migrated

No genesis proceeds until the ambiguity queue is empty (all items assigned a status).

### Stage 2: Write Freeze

Before genesis writes begin:

```
1. Set application-level flag: WRITE_FREEZE_ACTIVE = TRUE
   (new uploads, new computations, new sign-offs are blocked with a maintenance notice)
2. Confirm all pending edge function calls have completed (or timed out)
3. Record freeze_started_at and freeze_started_by
4. Take a database snapshot / backup
```

The write freeze must be acknowledged by a partner or director via a signed confirmation record in the database.

### Stage 3: Genesis Writes

Run the genesis migration as a series of atomic, individually-reversible steps:

```
STEP G1: Create engagements rows
  For each distinct (company_id, fiscal_year) derived from trial_balance_uploads:
    INSERT INTO engagements (...)
    with revision_type = 'ORIGINAL', revision_number = 1
    and engagement_state derived from the most advanced sign-off state found

STEP G2: Create statement_snapshots rows
  For each signed period (statement_sign_offs with tier 3 complete):
    INSERT INTO statement_snapshots (...)
    statements_json = NULL (historical — statements not stored as JSON historically)
    snapshot_hash = SHA256 of available provenance fields
    status = 'SIGNED'
    Note: statements_json being NULL is acceptable for historical records; the
    constraint must allow NULL for genesis records. A genesis_flag column marks these.

STEP G3: Create engagement_state_events rows (genesis bootstrap)
  For each engagement, create a minimal event log:
    - ONBOARDING event (at engagement created_at or earliest upload date)
    - DATA_INTAKE event (at first upload)
    - RECONCILED event (if SAFISHA gate evidence exists)
    - (later states as derivable)
  All genesis events have trigger_type = 'genesis_backfill'
  All genesis events have actor_firm_member_id = NULL (unknown at backfill time)

STEP G4: Create compliance_evidence_sources rows
  For each existing efdms_z_reports row:
    Create a compliance_evidence_sources record with evidence_type = 'EFDMS_Z_REPORT'
    Update efdms_z_reports.compliance_evidence_source_id

STEP G5: Create compliance_periods rows
  For each distinct (company_id, calendar_year, calendar_month) in efdms_z_reports:
    INSERT INTO compliance_periods (obligation_type = 'VAT', period_state = 'EVIDENCE_GATHERING')

STEP G6: Allocate versions
  For each engagement:
    INSERT INTO version_allocations for statement_snapshot, filing_package, xbrl_instance, tax_computation
    with current_version = MAX of existing versions for that engagement
```

### Stage 4: Count and Hash Reconciliation

After genesis writes, run a reconciliation report:

```
GENESIS RECONCILIATION REPORT

Engagements created: [count] (expected: [count from dry run])
Statement snapshots created: [count]
Engagement state events created: [count]
Compliance evidence sources created: [count]
Compliance periods created: [count]
Version allocations created: [count]

HASH CHECK:
  Companies in engagements = Companies in trial_balance_uploads: [PASS/FAIL]
  Signed sign-offs with matching snapshot: [count matched / count total]
  EFDMS rows with compliance_evidence_source_id: [count / count total]

MISMATCHES (must be zero before proceeding):
  Engagements without any state event: [count]
  Sign-offs without snapshot_id: [count]
  efdms_z_reports without compliance_evidence_source_id: [count]
```

The reconciliation report must show zero mismatches before proceeding.

### Stage 5: Authorized Sign-Off

A partner or director must review the reconciliation report and insert an explicit authorization record:

```
genesis_authorizations {
  id
  report_hash           TEXT NOT NULL  -- SHA-256 of the reconciliation report
  authorized_by         UUID NOT NULL  -- firm_members.id
  authorization_note    TEXT NOT NULL
  authorized_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
}
```

Without a row in `genesis_authorizations`, the cutover function refuses to release the write freeze.

### Stage 6: Cutover

```
1. genesis_authorization record exists with authorized_by and authorized_at → CONFIRMED
2. WRITE_FREEZE_ACTIVE → FALSE (new writes resume, now going to new tables)
3. Record cutover_completed_at
4. Monitor for 30 minutes: new uploads should create engagements rows
5. Confirm first post-genesis engagement transition succeeds end-to-end
```

## 9.3 Historical Records — Relaxed Constraints

Genesis records that cannot satisfy all new constraints (e.g., statements_json is NULL because historical statements were not stored as JSON) use a `is_genesis_record = TRUE` flag. Constraints that cannot apply to genesis records are modified to:

```sql
CONSTRAINT snapshot_json_required
  CHECK (statements_json IS NOT NULL OR is_genesis_record = TRUE);
```

These relaxed constraints are explicitly documented. New records created after cutover must satisfy all constraints without the genesis relaxation.

---

# DELIVERABLE 10 — FINAL GO / NO-GO IMPLEMENTATION CHECKLIST

This checklist is the implementation authority gate. Every item must be CONFIRMED before any schema migration runs in production.

## SECTION A — Architecture Integrity

```
[ ] A-01  v2.2 architecture document reviewed and approved by a partner or director
[ ] A-02  All 14 amendments confirmed as incorporated in schema deltas
[ ] A-03  Engine boundaries (SAFISHA / KINGA / FS Renderer / HESABU / MAONO) confirmed
          as unchanged from v2.1
[ ] A-04  No new missions, no new engines, no new engine boundaries introduced
[ ] A-05  All 39 Iron Dome constitutional invariants from v2.1 remain in force
[ ] A-06  MAONO is confirmed as read-only with respect to all financial tables
[ ] A-07  All applicability_rules confirmed as legislation-referenced with verified_at
```

## SECTION B — Schema Correctness

```
[ ] B-01  Every SECURITY DEFINER function has SET search_path = public, pg_temp
[ ] B-02  Every SECURITY DEFINER function has REVOKE ALL FROM PUBLIC + explicit GRANT
[ ] B-03  Every state-cached column (engagement_state, snapshot status, xbrl current_state)
          has a trigger blocking direct writes
[ ] B-04  All append-only tables have triggers blocking UPDATE and DELETE
[ ] B-05  advance_engagement_state() is the sole writer to engagements.engagement_state
[ ] B-06  advance_snapshot_state() is the sole writer to statement_snapshots.status
[ ] B-07  advance_xbrl_state() is the sole writer to xbrl_instances.current_state
[ ] B-08  allocate_version() is used for all version number allocations
          (zero uses of MAX(version)+1 anywhere in the codebase)
[ ] B-09  All audit FK columns reference firm_members.id, not auth.users.id
[ ] B-10  resolve_actor_firm_member() is called in every SECURITY DEFINER function
          that requires actor identity
[ ] B-11  Partial unique indexes exist for:
          - one ACTIVE snapshot per engagement
          - one current filing package per engagement
          - one VALIDATED XBRL per engagement
          - one ORIGINAL engagement per (company, fiscal_year)
[ ] B-12  idempotency_keys table exists with (key, operation_type) primary key
[ ] B-13  version_allocations table exists with INSERT ... ON CONFLICT ... DO UPDATE
[ ] B-14  All 6 typed evidence extension tables exist (vat, paye, sdl, wht, plus
          generic metadata on compliance_evidence_sources)
[ ] B-15  tax_aje_reconciliation.gate_passed is a GENERATED ALWAYS AS column
          (not computed in application code)
[ ] B-16  gated_resolutions table exists and finalization gate checks it
[ ] B-17  Separation-of-duties constraints exist as DB-enforced triggers and indexes
[ ] B-18  genesis_authorizations table exists; cutover function checks for a row
[ ] B-19  All HESABU functions revoke PUBLIC execute
[ ] B-20  hesabu_block_signoff checks: gate_satisfied AND stale = FALSE
          AND context = 'final' AND snapshot_id present AND SoD passed
```

## SECTION C — Backfill Readiness

```
[ ] C-01  Stage 0 dry-run report generated and reviewed
[ ] C-02  All ambiguities resolved (ambiguity queue is empty)
[ ] C-03  Genesis migration scripts are written and have been run against
          a full production data copy in a staging environment
[ ] C-04  Count/hash reconciliation shows zero mismatches on staging
[ ] C-05  A partner or director has reviewed the staging reconciliation report
[ ] C-06  genesis_authorization record inserted in staging as proof-of-concept
[ ] C-07  Rollback from genesis (disable writes, preserve records) tested on staging
[ ] C-08  First post-genesis engagement transition succeeds end-to-end on staging
[ ] C-09  is_genesis_record relaxed constraints are documented and do not apply
          to any record created after cutover
[ ] C-10  Write freeze mechanism has been tested (new uploads blocked during freeze)
```

## SECTION D — Phase Sequencing

```
[ ] D-01  S-0 (core tables) is deployed and verified before any UI phase begins
[ ] D-02  S-1 (transition engine) is deployed and direct-write block is verified
          before S-2 begins
[ ] D-03  S-2 (snapshot model) is deployed and sign-off trigger updated
          before U-4 (Final Review + Sign Off) begins
[ ] D-04  S-3 (tax finalization) is deployed before U-3 (Compute Tax) begins
[ ] D-05  U-3 is deployed, tested, and confirmed working before U-4 begins
          (Tax must be live before Final Sign-Off goes live)
[ ] D-06  S-6 (separation of duties) is deployed before any sign-off UI is live
[ ] D-07  U-6 (File Returns) deploys only after TAX_SIGNED state is reachable
          end-to-end in production
[ ] D-08  U-10 (Dashboard.tsx retirement) happens only after all panels are
          confirmed working in their routed locations for a minimum of 2 weeks
[ ] D-09  No UI phase introduces a state transition that bypasses
          advance_engagement_state()
[ ] D-10  No UI phase introduces a direct write to any append-only table
```

## SECTION E — Rollback and Forward Correction

```
[ ] E-01  Each schema phase has a documented DISABLE path (not a DROP path)
[ ] E-02  No audit table (engagement_state_events, statement_snapshot_events,
          filing_submissions, xbrl_state_events, hesabu_validations,
          tax_computation_statutory_refs) is listed as droppable in any rollback plan
[ ] E-03  Feature flags exist for each UI phase; any UI phase can be disabled
          without schema rollback
[ ] E-04  S-6 (separation-of-duties) rollback requires partner sign-off and
          produces an audit event — this is documented and enforced
[ ] E-05  Forward-only correction scripts exist for each schema phase in case of
          partial deployment failure
[ ] E-06  A restore procedure from the pre-genesis database backup has been tested
```

## SECTION F — Identity and Authorization

```
[ ] F-01  auth.uid() is never written directly to any FK column that references
          firm_members.id
[ ] F-02  All sign-off, approval, and finalization FKs have been audited to confirm
          they hold firm_members.id values
[ ] F-03  source_function, service_principal, triggered_by, occurred_at are separated
          into trusted (DB-derived) and untrusted (caller-supplied) fields in all
          event tables
[ ] F-04  client-supplied source_function and occurred_at are stored in
          caller_source_function and caller_occurred_at fields (untrusted)
[ ] F-05  db_clock = clock_timestamp() is always used; no event table accepts a
          caller-supplied timestamp as authoritative
[ ] F-06  service_role is confirmed as excluded from all signatory FK columns
[ ] F-07  The admin role is confirmed as excluded from hesabu_block_signoff(),
          finalize_tax_computation(), and advance_engagement_state() for financial transitions
```

## SECTION G — Idempotency

```
[ ] G-01  idempotency_keys table schema confirmed (key, operation_type PK; result_json nullable)
[ ] G-02  All 7 operation types have idempotency_key parameters and check the table first
[ ] G-03  Duplicate-call behaviour tested: second call with same key returns first result,
          no new DB rows created
[ ] G-04  Orphaned NULL-result key cleanup job exists with configurable TTL (default 60s)
[ ] G-05  EFDMS batch ingest idempotency key derivation is confirmed:
          SHA256(company_id + fiscal_year + period_month + file_hash)
[ ] G-06  Filing submission idempotency tested: double-submitting same reference
          does not create two filing_submissions rows
```

## SECTION H — Applicability Rules

```
[ ] H-01  applicability_rules table exists and is seeded with the initial Tanzania rule set
[ ] H-02  All seeded rules have legislation_reference and verified_at populated
[ ] H-03  MAONO is confirmed as unable to write to applicability_rules
[ ] H-04  CPA override records include override_by, override_reason, override_at
[ ] H-05  Disabled reporting frameworks (IPSAS_ACCRUAL, IPSAS_CASH) are non-selectable
          in the UI; selection attempt returns a clear message
[ ] H-06  G5 (EFDMS) gate confirmed as NOT_APPLICABLE for non-EFD-registered VAT companies
[ ] H-07  G10 (XBRL) gate has a confirmed CPA override path with partner approval
```

## AUTHORIZATION SIGNATURE

```
This checklist must be completed and signed before implementation begins.

Architecture approved by:    ________________________________  Date: ___________
Schema reviewed by:          ________________________________  Date: ___________
Staging backfill confirmed:  ________________________________  Date: ___________
Implementation authorized:   ________________________________  Date: ___________

IMPLEMENTATION IS BLOCKED until all items in Sections A–H are CONFIRMED.
Any unchecked item is a go/no-go blocker.
```

---

# CONSTITUTIONAL INVARIANTS CARRIED FORWARD (v2.2 ADDITIONS)

The 39 invariants from v2.1 remain in force. The following are added in v2.2:

```
40. advance_snapshot_state() is the sole writer to statement_snapshots.status
    Direct writes are blocked by trigger.

41. advance_xbrl_state() is the sole writer to xbrl_instances.current_state
    Direct writes are blocked by trigger.

42. actor identity is always derived from auth.uid() → firm_members lookup
    inside SECURITY DEFINER; never from caller parameters.

43. db_clock = clock_timestamp() is authoritative for all event timestamps.
    Caller-supplied timestamps are stored in untrusted fields only.

44. All SECURITY DEFINER functions: SET search_path = public, pg_temp;
    REVOKE ALL FROM PUBLIC; GRANT only to required roles.

45. allocate_version() is the sole source of all version numbers.
    MAX(version)+1 is prohibited.

46. idempotency_keys must be checked before any state-changing operation.
    Duplicate operations with the same key return the original result silently.

47. A signed engagement revision (ORIGINAL or AMENDMENT) requires a new revision record.
    The original signed snapshot is never touched.

48. Audit tables are never dropped for rollback. Forward-only corrections only.

49. genesis_authorization record is required before cutover.
    No partner/director sign-off = no cutover.

50. MAONO cannot write to applicability_rules, cannot change gate states,
    cannot create statutory requirements. Advisory only.
```

---

*End of Version 2.2. No code. No file modifications.*
*This document constitutes the final architecture before implementation authority is granted.*
*Implementation is blocked until the Go/No-Go checklist (Deliverable 10) is fully confirmed.*
