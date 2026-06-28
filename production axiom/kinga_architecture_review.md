# Kinga Phase 2 — Consolidated Architecture Review
**Status:** Architecture review only — no code, no migrations, no database changes  
**Date:** 2026-06-25  
**Scope:** Twelve-section consolidated document per the review mandate  

---

## Architectural Invariants — Compliance Summary

Before any section-by-section analysis, a top-level compliance assessment against the five invariants.

| Invariant | Status | Primary Finding |
|-----------|--------|-----------------|
| 1 — Source Independence | **PARTIALLY VIOLATED** | `efdms_records` is a source-specific table read directly by the proposed findings engine. The canonical boundary does not yet exist. |
| 2 — Determinism | **AT RISK** | The seed migration produces non-deterministic results on repeated execution (see §2). The schema-level tables are deterministic in isolation. |
| 3 — Idempotency | **PARTIALLY MET** | Schema tables: idempotency enforced at DB level for `efdms_records` (UNIQUE constraint). Seed migration: no idempotency protection — **re-execution corrupts legal history**. |
| 4 — Auditability | **MET** | `raw_payload JSONB` on `efdms_records`, `source_detail JSONB` on `findings`, step timestamps on `evidence_requests`. Provenance is preserved. |
| 5 — Separation of Responsibilities | **VIOLATED IN DESIGN** | The proposed findings generation function (Function 2 from prior session) reads directly from `efdms_records` — an adapter-layer table. Business logic must not depend on source-specific stores. |

The two critical violations — Invariants 1 and 5 — are resolved in §3 by introducing the canonical ingestion boundary. They do not require changes to the already-applied schema; they require an additive migration (proposed only, not executed this session) and a constraint on how Edge Functions are written.

---

## §1 — Phase 2A: Current State Verification

### 1.1 Verification SQL

The following queries verify the live state of the four Kinga tables. Run in the Supabase SQL Editor (service role) after applying migration `20260625100000_b3e5c891-*`. **Do not execute this session.**

```sql
-- ── 1. Tables exist and RLS is enabled ─────────────────────────────────────
SELECT
  tablename,
  rowsecurity  -- expected: true for all four
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'statutory_rules', 'efdms_records', 'findings', 'evidence_requests'
  )
ORDER BY tablename;
```

**Expected result:** 4 rows, all `rowsecurity = true`.  
**If fewer than 4 rows:** migration `20260625100000_b3e5c891-*` has not been applied. Apply it before proceeding with any Kinga work.

```sql
-- ── 2. RLS policies — count and structure ──────────────────────────────────
SELECT
  tablename,
  policyname,
  permissive,  -- 'PERMISSIVE' or 'RESTRICTIVE'
  cmd,         -- SELECT, INSERT, UPDATE, DELETE, ALL
  qual,        -- USING clause (pre-update / visibility)
  with_check   -- WITH CHECK clause (post-update / write validation)
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'statutory_rules', 'efdms_records', 'findings', 'evidence_requests'
  )
ORDER BY tablename, permissive DESC, cmd, policyname;
```

**Expected: 14 policy rows.**

| Table | Policy name | Type | Command |
|-------|-------------|------|---------|
| statutory_rules | Authenticated users can read statutory rules | PERMISSIVE | SELECT |
| efdms_records | Users can view EFDMS records for their companies | PERMISSIVE | SELECT |
| efdms_records | Users can ingest EFDMS records for their companies | PERMISSIVE | INSERT |
| efdms_records | efdms_company_ownership_insert | RESTRICTIVE | INSERT |
| findings | Users can view findings for their companies | PERMISSIVE | SELECT |
| findings | Users can create findings for their companies | PERMISSIVE | INSERT |
| findings | Users can update findings for their companies | PERMISSIVE | UPDATE |
| findings | findings_upload_ownership_insert | RESTRICTIVE | INSERT |
| findings | findings_upload_ownership_update | RESTRICTIVE | UPDATE |
| evidence_requests | Users can view evidence requests for their findings | PERMISSIVE | SELECT |
| evidence_requests | Users can create evidence requests for their findings | PERMISSIVE | INSERT |
| evidence_requests | Users can update evidence requests for their findings | PERMISSIVE | UPDATE |
| evidence_requests | evidence_requests_finding_ownership_insert | RESTRICTIVE | INSERT |
| evidence_requests | evidence_requests_finding_ownership_update | RESTRICTIVE | UPDATE |

```sql
-- ── 3. Indexes ──────────────────────────────────────────────────────────────
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'statutory_rules', 'efdms_records', 'findings', 'evidence_requests'
  )
ORDER BY tablename, indexname;
```

**Expected: 14 index rows** (2 PKs + 12 explicit indexes created in the migration).

Key indexes to verify explicitly:

| Index | Table | Note |
|-------|-------|------|
| `uq_statutory_rule_active` | statutory_rules | Partial UNIQUE, WHERE effective_to IS NULL. Must show NULLS NOT DISTINCT if PG ≥ 15. |
| `idx_efdms_records_company_id` | efdms_records | Required for RLS semi-join. If absent, every query table-scans companies. |
| `idx_findings_company_id` | findings | Required for RLS semi-join. |
| `uq_one_request_per_finding` | evidence_requests | UNIQUE on finding_id — also serves as the finding_id lookup index. |

```sql
-- ── 4. Trigger functions — existence and SECURITY DEFINER ──────────────────
SELECT
  proname,
  prosecdef,                            -- true = SECURITY DEFINER
  proconfig,                            -- should contain 'search_path=public' for SECURITY DEFINER fn
  pg_get_functiondef(oid) AS definition -- spot-check the function body
FROM pg_proc
WHERE proname IN (
  'close_prior_statutory_rule',
  'update_finding_response_pack_ready',
  'prevent_finding_id_change',
  'update_updated_at_column'            -- pre-existing; confirm still present
)
ORDER BY proname;
```

**Expected:** 4 rows.

| Function | `prosecdef` | Note |
|----------|-------------|------|
| `close_prior_statutory_rule` | false | Runs as invoker; only touches statutory_rules |
| `update_finding_response_pack_ready` | **true** | SECURITY DEFINER — critical; must be true |
| `prevent_finding_id_change` | false | Raises exception; no cross-table writes |
| `update_updated_at_column` | false (or true) | Pre-existing; present confirms no regressions |

**If `update_finding_response_pack_ready.prosecdef = false`:** the response_pack_ready flag will not be updated when an authenticated user transitions an evidence_request step, because the trigger's UPDATE on `findings` will be blocked by `findings` RLS in the authenticated role context.

```sql
-- ── 5. Triggers — wired to correct tables ──────────────────────────────────
SELECT
  event_object_table AS table_name,
  trigger_name,
  event_manipulation AS event,
  action_timing AS timing,
  action_orientation AS orientation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND event_object_table IN (
    'statutory_rules', 'efdms_records', 'findings', 'evidence_requests'
  )
ORDER BY event_object_table, trigger_name;
```

**Expected: 5 trigger rows.**

| Table | Trigger name | Event | Timing |
|-------|-------------|-------|--------|
| statutory_rules | trg_close_prior_statutory_rule | INSERT | BEFORE |
| findings | update_findings_updated_at | UPDATE | BEFORE |
| evidence_requests | trg_prevent_finding_id_change | UPDATE | BEFORE |
| evidence_requests | trg_update_response_pack_ready | INSERT, UPDATE | AFTER |
| evidence_requests | update_evidence_requests_updated_at | UPDATE | BEFORE |

```sql
-- ── 6. Foreign keys — ON DELETE behaviors ──────────────────────────────────
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS referenced_table,
  ccu.column_name AS referenced_column,
  rc.delete_rule       -- expected values: RESTRICT or SET NULL
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name IN ('efdms_records', 'findings', 'evidence_requests')
ORDER BY tc.table_name, kcu.column_name;
```

**Expected FK behaviors:**

| Table | Column | Referenced | ON DELETE |
|-------|--------|------------|-----------|
| efdms_records | company_id | companies.id | RESTRICT |
| findings | company_id | companies.id | RESTRICT |
| findings | statutory_rule_id | statutory_rules.id | RESTRICT |
| findings | upload_id | trial_balance_uploads.id | SET NULL |
| evidence_requests | finding_id | findings.id | RESTRICT |

### 1.2 Seed data verification

```sql
-- ── 7. Seed data state — run after applying seed migration ─────────────────
SELECT
  trigger_category,
  rate_pct,
  threshold_amount,
  effective_from,
  effective_to,          -- NULL = currently active; date = closed
  verified_at,           -- expected: NULL for all FA2025 rows
  LEFT(notes, 80) AS notes_preview
FROM public.statutory_rules
ORDER BY effective_from, trigger_category;
```

**Interpretation:**
- If 0 rows returned: seed migration `20260625110000_d7b2e491-*` has not been applied.
- If 9 rows returned, all `verified_at = NULL`: seed migration applied correctly (first execution).
- If `sdl` appears twice with different `effective_from`: seed migration was run twice. This is data corruption (see §2 for full analysis and remediation).
- If `sdl` row with `effective_from < '2025-07-01'` shows `effective_to = '2025-06-30'`: effective-dating trigger worked correctly.
- If `sdl` row with `effective_from < '2025-07-01'` shows `effective_to = NULL`: the trigger did not fire, or no pre-FA2025 SDL row existed to close.

### 1.3 Interpretation guide for not-yet-applied state

**If migration `20260625100000_b3e5c891-*` has not been applied:**

The four Kinga tables do not exist. The pg_policies, pg_indexes, and pg_tables queries will return 0 rows for Kinga tables. Execution instructions: paste the full contents of `supabase/migrations/20260625100000_b3e5c891-7f4a-4d2e-9c18-a6f0d2e8b347.sql` into the Supabase SQL Editor and run as service role. Confirm no error output before proceeding.

**If seed migration `20260625110000_d7b2e491-*` has not been applied:**

The `statutory_rules` table exists but is empty. The statutory rules engine has no data to evaluate against. This is a safe pre-insertion state — no data corruption, just missing reference data. Apply the seed migration after reviewing §2 below and confirming idempotency improvements (if desired).

---

## §2 — Phase 2B: Seed Migration Review

### 2.1 Idempotency analysis

**Finding: the seed migration is not idempotent. Re-execution corrupts legal history.**

The migration uses plain `INSERT` statements with no duplicate protection. The effective-dating trigger (`close_prior_statutory_rule`) creates the corruption path:

**First execution (correct):**
1. INSERT `sdl` with `effective_from = '2025-07-01'`
2. Trigger fires: finds existing SDL row where `effective_to IS NULL`, sets `effective_to = '2025-06-30'`
3. New SDL row inserted: `effective_to = NULL` (currently active)

**Second execution (corrupt):**
1. INSERT `sdl` with `effective_from = '2025-07-01'` again
2. Trigger fires: finds the *first-execution* SDL row (effective_to IS NULL), sets `effective_to = '2025-06-30'`
3. Second SDL row inserted: `effective_to = NULL` — now two Finance Act 2025 SDL rows exist, one with `effective_to = '2025-06-30'` and one with `effective_to = NULL`, both for the same period
4. The `uq_statutory_rule_active` partial unique index does not prevent this because the first-execution row now has `effective_to IS NOT NULL` (it was just set to '2025-06-30')

This creates a silently corrupt legal history: the rules engine's effective-dating query (`WHERE effective_to IS NULL OR effective_to >= :period`) would return the second-execution row as the active rule, and the first-execution row would appear as a phantom "historical" version for the period 2025-07-01 to 2025-06-30 — which is an impossible date range (`effective_from > effective_to`) that violates `chk_effective_dates`... wait, no: the first-execution row's `effective_from = '2025-07-01'` and `effective_to = '2025-06-30'` means `effective_to < effective_from`, which **does** violate `chk_effective_dates`.

**Revised analysis:** the `chk_effective_dates` constraint (`effective_to IS NULL OR effective_to > effective_from`) would catch this. The trigger sets `effective_to = NEW.effective_from - 1 = '2025-06-30'`. The first-execution row has `effective_from = '2025-07-01'`. So `effective_to ('2025-06-30') > effective_from ('2025-07-01')` is FALSE, and `effective_to IS NULL` is also FALSE. The UPDATE that the trigger performs does not go through this CHECK constraint directly — CHECK constraints only fire on INSERT or UPDATE of the row being changed. Since the trigger is running `UPDATE statutory_rules SET effective_to = ...`, the constraint on that row is re-evaluated. `effective_to ('2025-06-30') > effective_from ('2025-07-01')` = FALSE → **constraint violation**. The second execution of the SDL INSERT would fail with a CHECK constraint error on the row being closed.

**However, for entirely new trigger categories (8 of the 9 rows are new categories):**

For `vat_withholding_goods` on second execution:
1. Trigger fires: finds `vat_withholding_goods` where `effective_to IS NULL` (the first-execution row)
2. Sets `effective_to = '2025-06-30'` on that row
3. First-execution row: `effective_from = '2025-07-01'`, `effective_to = '2025-06-30'` → `chk_effective_dates` violation

So the second execution fails at the UPDATE inside the trigger with a CHECK constraint error — but this is inside a trigger running as part of the INSERT, so the whole INSERT fails with an exception. The `BEGIN/COMMIT` wrapping means the entire batch of 9 INSERTs rolls back.

**Net result of re-execution:**
- If the database has integrity: the second execution raises a `check_violation` exception on the trigger's UPDATE and rolls back cleanly. No data corruption.
- The migration is therefore **not idempotent but is safe to fail** — it fails loudly rather than silently corrupting data.
- The problem is operational, not correctness: re-execution produces an error that looks ambiguous without this analysis, and debugging it requires understanding the trigger behavior.

### 2.2 Duplicate protection recommendation

The migration should be hardened with explicit idempotency guards. The correct pattern is a `WHERE NOT EXISTS` filter that skips the INSERT if a row for the same trigger_category + jurisdiction + effective_from already exists:

```sql
-- Pattern (do not execute — shown for review):
INSERT INTO public.statutory_rules ( ... )
SELECT ...
WHERE NOT EXISTS (
  SELECT 1 FROM public.statutory_rules
  WHERE trigger_category = 'sdl'
    AND jurisdiction = 'TZ'
    AND industry_pack IS NULL
    AND effective_from = '2025-07-01'
);
```

This makes each INSERT truly idempotent: if the row already exists for that exact `(trigger_category, jurisdiction, industry_pack, effective_from)` combination, the INSERT is skipped entirely — the trigger does not fire, and no effective_to is incorrectly set on the existing row.

**Recommendation:** Before the seed migration is applied for the first time in production, replace all 9 plain INSERTs with `INSERT ... SELECT ... WHERE NOT EXISTS` variants. This migration would be the revised `20260625110000` file. Since this has not yet been applied to production, the revision window is still open.

### 2.3 SDL effective-dating — legal history preservation

The SDL conflict design is correct in intent: the `notes` column preserves the conflict, `verified_at = NULL` signals it is unverified, and the effective-dating trigger ensures the pre-FA2025 SDL row is closed correctly. However, two gaps remain:

**Gap 1 — Pre-FA2025 SDL row may not exist.** The seed migration comments that the trigger will close "any pre-existing SDL row." But the `statutory_rules` table was created empty by migration `20260625100000_b3e5c891-*`. No pre-FA2025 SDL data exists in the database unless it was inserted separately. If there is no prior SDL row, the trigger's UPDATE affects 0 rows (harmless), but the historical legal rate for the period before 2025-07-01 is simply absent. This is a documentation gap, not a correctness issue, but it means historical reconciliation runs against pre-2025 periods will find no active SDL rule.

**Gap 2 — Resolution protocol after SDL rate verification.** Once the primary Finance Act 2025 text is reviewed and the correct rate confirmed, the resolution is not an UPDATE to the existing row. It is a new INSERT with the verified rate and the same `effective_from = '2025-07-01'`. The trigger will close the unverified-4% row. The `verified_at` and `verified_by` columns on the new row provide the governance trail. This protocol should be documented in the operational runbook, not just in code comments.

### 2.4 No silent overwrite of legal rates

The `statutory_rules` schema correctly enforces this via the append-only, effective-dating pattern: there are no UPDATE or DELETE policies for any role. A rate "correction" is always a new row closing the prior one. This is correct and should be maintained in all future seed and amendment migrations.

---

## §3 — Phase 2C: Canonical Ingestion Architecture

### 3.1 The canonical boundary — why it is missing and what it costs

The current architecture has no canonical boundary. The data flow is:

```
EFDMS CSV/API  →  [normalise in Edge Function]  →  efdms_records  →  findings engine
```

The findings engine reads from `efdms_records` directly. This means:
- Invariant 1 is violated: the engine knows records came from EFDMS
- Invariant 5 is violated: business logic depends on an adapter-layer table
- Adding a second source (bank statement CSV, manual GL entry) requires either (a) adding a second source-specific table that the findings engine must also read from, or (b) adding branching logic to the engine per source — both of which compound the violation

The correct architecture is:

```
EFDMS CSV/API   →  EFDMS Adapter      →  [canonical boundary]
Bank CSV        →  CSV Adapter        →  [canonical boundary]  →  findings engine
Manual Entry    →  Manual Adapter     →  [canonical boundary]
TRA API (future)→  TRA API Adapter    →  [canonical boundary]
```

The canonical boundary is a single table. Beyond it, the findings engine, statutory rules engine, evidence workflow, and all reporting see only canonical records — never source-specific structures.

### 3.2 Two-table canonical layer design

Two new tables are proposed. Neither is executed this session.

#### `ingestion_batches` — batch-level provenance

Tracks each import attempt at the batch level. One row per batch, regardless of source.

```
ingestion_batches
─────────────────────────────────────────────────────────────────
id                    UUID         PK, gen_random_uuid()
company_id            UUID         NOT NULL → companies(id) RESTRICT
source_type           TEXT         NOT NULL
                                   CHECK IN ('efdms_csv', 'manual_entry',
                                             'tra_api', 'vfd_api')
provider_name         TEXT         NOT NULL
                                   -- human-readable: 'TRA EFDMS CSV Export',
                                   -- 'Manual Entry', etc.
import_batch_id       TEXT         NOT NULL
                                   -- caller-supplied idempotency key
                                   UNIQUE(company_id, import_batch_id)
ingestion_contract_version TEXT    NOT NULL DEFAULT '1.0'
source_file_reference TEXT         NULL
                                   -- original filename for CSV uploads;
                                   -- NULL for API and manual sources
record_count          INTEGER      NOT NULL
                                   -- total records in the source payload
status                TEXT         NOT NULL DEFAULT 'pending'
                                   CHECK IN ('pending', 'processing',
                                             'completed', 'failed', 'partial')
inserted_count        INTEGER      NULL  -- populated after processing
skipped_count         INTEGER      NULL  -- duplicates skipped
error_count           INTEGER      NULL  -- parse/validation failures
error_summary         JSONB        NULL  -- per-row error details
imported_by           UUID         NOT NULL  -- calling user UUID (explicit)
imported_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
completed_at          TIMESTAMPTZ  NULL
```

RLS: SELECT scoped to `company_id IN (SELECT id FROM companies WHERE user_id = auth.uid())`. No UPDATE or DELETE policies (append-only).

#### `canonical_financial_records` — the single normalized form

One row per financial event, regardless of origin source.

```
canonical_financial_records
─────────────────────────────────────────────────────────────────
id                    UUID         PK, gen_random_uuid()
batch_id              UUID         NOT NULL → ingestion_batches(id) RESTRICT
company_id            UUID         NOT NULL → companies(id) RESTRICT

-- Financial event (source-agnostic)
record_type           TEXT         NOT NULL
                                   CHECK IN ('sale', 'purchase')
                                   -- canonical business types, not source types
canonical_date        DATE         NOT NULL
period_year           INTEGER      NOT NULL
period_month          INTEGER      NOT NULL
amount_tzs            NUMERIC(20,2) NOT NULL
vat_amount_tzs        NUMERIC(20,2) NOT NULL DEFAULT 0
counterparty_tin      TEXT         NULL
counterparty_name     TEXT         NULL

-- Provenance metadata (required for Invariant 4)
source_type           TEXT         NOT NULL  -- copied from ingestion_batches
provider_name         TEXT         NOT NULL  -- copied from ingestion_batches
import_batch_id       TEXT         NOT NULL  -- copied from ingestion_batches
ingestion_contract_version TEXT    NOT NULL  -- from batch

-- Idempotency keys
source_identifier     TEXT         NULL
                                   -- authoritative business ID when available
                                   -- (efdms_transaction_id, etc.)
                                   -- NULL for sources with no business ID
payload_hash          TEXT         NOT NULL
                                   -- SHA-256 of raw_payload (exact bytes)
normalized_hash       TEXT         NOT NULL
                                   -- SHA-256 of canonical fields (see §6)
                                   UNIQUE(company_id, normalized_hash)
                                   -- enforces Invariant 3 across all sources

-- Adapter quality metadata
imported_by           UUID         NOT NULL  -- calling user UUID (explicit)
imported_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
adapter_confidence    NUMERIC(3,2) NOT NULL DEFAULT 1.00
                                   CHECK (BETWEEN 0.00 AND 1.00)
requires_secondary_review BOOLEAN  NOT NULL DEFAULT false

-- Full audit trail (Invariant 4)
raw_payload           JSONB        NOT NULL
                                   -- original record exactly as received
                                   -- before any normalization
source_file_reference TEXT         NULL  -- from batch

CONSTRAINT chk_period_consistency
  CHECK (period_year  = EXTRACT(YEAR  FROM canonical_date)::INTEGER
     AND period_month = EXTRACT(MONTH FROM canonical_date)::INTEGER)
```

RLS: same pattern as `efdms_records` — SELECT, PERMISSIVE INSERT, RESTRICTIVE INSERT (defense-in-depth). No UPDATE or DELETE.

### 3.3 Relationship between `efdms_records` and the canonical layer

`efdms_records` is already live and append-only. It should be retained as the **raw evidence archive** for the EFDMS adapter — not replaced. The EFDMS adapter writes to both:

1. `efdms_records` (raw EFDMS-specific store, existing) — preserves the exact EFDMS record structure for potential TRA query responses that require source-native format
2. `canonical_financial_records` (canonical store, proposed) — normalized form that all business engines read from

The findings engine is updated to read from `canonical_financial_records` only, never from `efdms_records`. This restores Invariant 1 and Invariant 5 without altering the existing schema.

**Migration required (design only, not this session):** One additive migration creating `ingestion_batches` and `canonical_financial_records`. One backfill script normalizing existing `efdms_records` rows into `canonical_financial_records` (to avoid a split-brain state where some canonical records exist and some don't). The backfill must be idempotent (using `normalized_hash` as the duplicate check).

---

## §4 — CSV Adapter Design

### 4.1 Accepted schema — column definitions

The CSV adapter accepts a flat, header-row CSV. Column headers are case-insensitive and may contain surrounding whitespace (trimmed on parse). Two column sets are defined: required and optional.

**Required columns:**

| Canonical header | Accepted aliases | Type | Notes |
|-----------------|-----------------|------|-------|
| `transaction_id` | `Transaction ID`, `TxnID`, `efdms_transaction_id` | TEXT | Business identifier; used as `source_identifier` |
| `date` | `Transaction Date`, `Date`, `Txn Date` | DATE | Parsed from YYYY-MM-DD, DD/MM/YYYY, or DD-MMM-YYYY |
| `type` | `Record Type`, `Type`, `Direction` | TEXT | Normalized to `sale` / `purchase` (see mapping below) |
| `amount` | `Amount`, `Amount (TZS)`, `Gross Amount` | NUMERIC | TZS, positive only |

**Optional columns (use NULL if absent):**

| Header | Canonical field |
|--------|----------------|
| `vat` / `VAT Amount` | `vat_amount_tzs` |
| `tin` / `Counterparty TIN` | `counterparty_tin` |
| `name` / `Counterparty Name` | `counterparty_name` |
| `device_id` / `EFD Device ID` | `efd_device_id` |

### 4.2 Type mapping rules

The CSV may use non-canonical strings for record type. Mapping is case-insensitive:

| Source value | Canonical |
|-------------|-----------|
| `sale`, `s`, `sales`, `output`, `revenue`, `Receipt` | `sale` |
| `purchase`, `p`, `purchases`, `input`, `expense`, `Payment` | `purchase` |
| anything else | PARSE ERROR — reject row with diagnostic |

### 4.3 Row-level diagnostics

Each row that fails validation produces a structured diagnostic object:

```json
{
  "row_number": 14,
  "raw_content": "2024-01-15,mystery,50000,",
  "error_code": "INVALID_RECORD_TYPE",
  "error_message": "Unrecognised record type 'mystery'. Expected: sale, purchase.",
  "field": "type",
  "raw_value": "mystery",
  "canonical_value": null,
  "fatal": false
}
```

`fatal: true` indicates the row cannot be recovered even with manual correction of other fields. `fatal: false` indicates the row can be re-submitted after fixing the flagged field.

### 4.4 Batch-level diagnostics

Returned in the ingestion response alongside per-row diagnostics:

```json
{
  "import_batch_id": "csv-export-2024-q1-001",
  "source_file_reference": "efdms_q1_2024.csv",
  "total_rows": 142,
  "header_rows_skipped": 1,
  "blank_rows_skipped": 0,
  "parsed": 140,
  "inserted": 138,
  "skipped_duplicates": 2,
  "parse_errors": 2,
  "adapter_confidence": 0.80,
  "requires_secondary_review": false,
  "error_details": [ ... ]
}
```

### 4.5 Source traceability

The original filename is stored in `ingestion_batches.source_file_reference` and copied to `canonical_financial_records.source_file_reference`. The `raw_payload` column on each canonical record stores the original CSV row as parsed key-value pairs:

```json
{
  "row_number": 14,
  "raw_headers": ["transaction_id","date","type","amount","vat","tin"],
  "raw_values": ["EFD-2024-001","2024-01-15","sale","50000","9000","100-123456-Z"]
}
```

### 4.6 Duplicate detection

Two layers:

1. **Within the batch:** detect duplicate `transaction_id` values within the same CSV file before any database write. Report duplicates as batch-level warnings; insert only the first occurrence.

2. **Across batches:** `UNIQUE(company_id, normalized_hash)` on `canonical_financial_records` enforces cross-batch deduplication. ON CONFLICT DO NOTHING with RETURNING id gives exact counts.

### 4.7 Adapter confidence

CSV adapter: `adapter_confidence = 0.80` (default).

Rationale: CSV does not carry a cryptographic signature or API-verified identity. Field values depend on correct export configuration from the source system. The 0.80 confidence signals to downstream systems that secondary review is warranted for high-stakes determinations, though most operational records are reliable.

`requires_secondary_review = false` for standard CSV imports. Set to `true` if the parse error rate exceeds 5% of the batch.

---

## §5 — Manual Entry Adapter Design

### 5.1 Manual entry is a distinct evidence class

Manual entry is not "CSV without a file." The distinguishing property: there is no underlying source document from which a manually-entered value can be re-derived. If the entered value is wrong, there is no original evidence to re-check. This irreversibility requires stronger safeguards than file-based sources.

### 5.2 Additional safeguards

| Safeguard | Rationale |
|-----------|-----------|
| `adapter_confidence = 0.60` | No source document; lower reliability than file sources |
| `requires_secondary_review = true` | Always — a second person must verify manually-entered amounts before they are used in findings |
| `entered_by` (= `imported_by`) | Explicitly who typed the value |
| `entered_at` (= `imported_at`) | When the value was entered |
| `justification TEXT NOT NULL` | Required free-text field: why this record is being entered manually instead of from a source file |
| `supporting_evidence TEXT NULL` | Optional reference to a physical document, email, or other evidence (file upload ID, document reference) |
| Immutable audit history | The `raw_payload` stores the entered values at time of entry; the row is append-only (no UPDATE policy) |
| Pre-save duplicate detection | Before inserting, compute `normalized_hash` and check for existing match; surface conflict to the user with a preview of the existing record |
| UI indication | The canonical record's `source_type = 'manual_entry'` must be surfaced in every UI view — no findings based on manual records may appear identical to findings based on EFDMS-sourced records from the user's perspective |

### 5.3 Canonical form — identical to every other source

Despite these additional safeguards, the canonical record produced by manual entry is structurally identical to a record from the CSV adapter or EFDMS adapter. The same columns, the same types, the same constraints. The `source_type` and `adapter_confidence` columns carry the provenance information; no schema change distinguishes manual records from others. The findings engine does not branch on `source_type`.

The extra safeguard fields (`justification`, `supporting_evidence`) are stored in `raw_payload` JSONB on the canonical record — not as separate columns. This preserves the invariant that the canonical table is source-agnostic at the column level.

### 5.4 Manual entry `normalized_hash` composition

Manual records have no `source_identifier`. The `normalized_hash` is the sole idempotency key. The hash composition is identical to the standard specification (§6), which means that a manually-entered record with the same company, date, type, amount, VAT, and counterparty as an EFDMS record will produce the same normalized_hash and be detected as a duplicate. This is correct behavior — the same transaction should not exist twice regardless of source.

---

## §6 — Reserved Adapter Strategy

### TRA API — `NOT_YET_AVAILABLE`

**Prerequisites before implementation can begin:**

- **Authenticated access:** TRA must provide official API credentials (API key or OAuth client credentials) to licensed third-party developers. No such program has been confirmed publicly as of this document.
- **Authorization model:** Confirmed mechanism for a third party to act on behalf of a taxpayer (company) without holding the taxpayer's own TRA portal credentials.
- **Provider agreement:** Written agreement with TRA defining data access scope, permitted use, rate limits, and liability terms.
- **Data contract:** Documented JSON/XML payload specification with field definitions, data types, enumeration values, and changelog.
- **Payload specification:** Field mapping from TRA's native format to the canonical schema defined in §3.2 — cannot be designed until the TRA payload spec is obtained.
- **Synchronization model:** Pull (polling), push (webhook), or event stream. Unknown until TRA confirms.
- **Rate limiting:** TRA's documented request limits, retry policies, and backoff requirements.
- **Webhook/event behavior:** If TRA provides real-time events (new transaction confirmed, status change), the event handling contract must be specified before the adapter is designed.
- **Legal and operational constraints:** Tanzania data protection requirements; whether financial transaction data may be stored by a third party; NBAA professional confidentiality considerations.

No implementation design is produced for this adapter. The adapter interface is reserved in the `source_type` CHECK constraint (`'tra_api'` is included in the allowed values) to avoid a future migration to the constraint.

### Licensed VFD Provider API — `NOT_YET_AVAILABLE`

**Prerequisites before implementation can begin:**

- **Authenticated access:** Confirmed API access via an accredited VFD provider (GePG, Zan Malipo, or similar). Provider selection affects the integration contract entirely.
- **Authorization model:** VFD provider's mechanism for granting per-company data access to a third-party platform.
- **Provider agreement:** Commercial agreement with the VFD provider, distinct from any TRA agreement.
- **Data contract:** Provider-specific payload specification (VFD providers are not standardized with each other — this adapter is provider-specific, not VFD-generic).
- **Payload specification:** Cannot be designed until provider is selected and API documentation obtained.
- **Synchronization model, rate limiting, webhook behavior:** All provider-specific; unknown until agreement is in place.
- **Legal constraints:** VFD provider terms regarding secondary use of transaction data; alignment with TRA's VFD operational guidelines (EFD regulations, as updated by Finance Act 2025).

Reserved in `source_type` CHECK constraint as `'vfd_api'`. No implementation design produced.

---

## §7 — Idempotency Specification

### 7.1 Authoritative business identifier (use when available)

When the source provides a verifiable, unique business identifier assigned by an authoritative external system, use it as the `source_identifier`. It is stored alongside the `normalized_hash` but is not the sole idempotency key (because the same business ID from a different source type could theoretically appear — though in practice this is unlikely, the `normalized_hash` remains the enforced UNIQUE constraint).

| Source | Business identifier field | `source_identifier` value |
|--------|--------------------------|--------------------------|
| EFDMS CSV | `efdms_transaction_id` | Value from the field |
| TRA API (future) | TRA-assigned transaction UUID | TRA's reference |
| VFD API (future) | Provider transaction ID | Provider's reference |
| Manual entry | None | `NULL` |
| Generic CSV without ID field | None | Row number + file hash |

### 7.2 Normalized hash specification

The `normalized_hash` is computed from the canonical fields using a deterministic, order-defined algorithm. It is the sole cross-source idempotency key.

**Algorithm:** SHA-256, hex-encoded lowercase string.

**Input construction:** Concatenate the following fields in this exact order, separated by `|`:

```
{company_id}|{record_type}|{canonical_date}|{amount_tzs}|{vat_amount_tzs}|{counterparty_tin}|{counterparty_name}
```

**Field normalization rules (applied before hashing):**

| Field | Normalization |
|-------|--------------|
| `company_id` | UUID in canonical lowercase format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `record_type` | Lowercase: `sale` or `purchase` |
| `canonical_date` | ISO 8601: `YYYY-MM-DD` |
| `amount_tzs` | Fixed 2 decimal places, no currency symbol, no thousands separator: `1234567.89` |
| `vat_amount_tzs` | Same as `amount_tzs`; `0.00` if not present (never NULL) |
| `counterparty_tin` | Trimmed, uppercase, all whitespace removed; `""` (empty string) if NULL |
| `counterparty_name` | Trimmed, lowercase, collapsed internal whitespace (multiple spaces → single space); `""` if NULL |

**Null handling:** All nullable fields are normalized to `""` before hashing. NULL is never passed to the hash function.

**Whitespace handling:** Leading and trailing whitespace stripped from all string fields. Internal whitespace in `counterparty_name` collapsed to single space. Whitespace in `counterparty_tin` stripped entirely (TINs have no meaningful whitespace).

**Numeric normalization:** Always 2 decimal places. No scientific notation. No leading zeros beyond the units digit. No trailing zeros beyond the second decimal: `1000.00`, not `1,000.00` or `1000` or `1000.0` or `1.0E3`.

**Currency normalization:** All amounts are in TZS. No currency code is included in the hash input — the database constraint enforces TZS-only storage.

**Date normalization:** `YYYY-MM-DD` only. Any source date in another format (DD/MM/YYYY, Unix timestamp, etc.) must be converted to ISO 8601 by the adapter before hashing.

**Example hash input:**

```
a1b2c3d4-e5f6-7890-abcd-ef1234567890|sale|2024-01-15|50000.00|9000.00|100-123456-Z|acme limited
```

**Example hash output:** `sha256("a1b2c3d4...acme limited")` → 64-character hex string stored in `normalized_hash`.

### 7.3 What creates a new record vs. what does not

**Never creates a new record (cosmetic differences):**
- Different capitalization of counterparty name (`ACME LIMITED` vs `acme limited`)
- Trailing whitespace in any field
- `counterparty_tin` with spaces vs. without (`100 123456 Z` vs `100-123456-Z` after stripping)
- `vat_amount_tzs = 0` vs. `vat_amount_tzs = NULL` (both normalize to `0.00`)

**Always creates a new record (meaningful differences):**
- Different `canonical_date` (even by one day)
- Different `amount_tzs` (even by 1 TZS)
- Different `record_type` (`sale` vs `purchase`)
- Different `company_id`
- Different `counterparty_tin` after normalization
- Different `counterparty_name` after normalization (if TIN is also absent — see note)

**Note on counterparty identity:** `counterparty_tin` is the authoritative counterparty identifier. If TIN is present and matches, a different name spelling does not create a separate record (the TIN is part of the hash, and the name variation is cosmetic). If TIN is absent on both records, name normalization is the only counterparty signal in the hash — this creates some risk of false duplicates (two different suppliers with similar names). This is an acceptable tradeoff for MVP; future improvement: add a separate TIN-only normalization step.

---

## §8 — Contract Versioning Strategy

### 8.1 `ingestion_contract_version` field

Stored on `ingestion_batches` and propagated to `canonical_financial_records`. Current version: `"1.0"`.

This version number represents the **normalization contract** — the agreement between adapters and the canonical schema about what fields are required, what normalizations are applied, and what the `normalized_hash` includes.

### 8.2 Evolution rules

The contract may evolve when:
- New required fields are added to the canonical schema (e.g., `jurisdiction` if multi-country support is added)
- Normalization rules change (e.g., a different hash composition for better collision resistance)
- Adapter confidence scoring methodology changes

**What must change when the contract version increments:**
- Only adapters: the normalization logic inside each adapter
- The hash composition algorithm (if changed)
- The version string stored on new batches

**What must NOT change when the contract version increments:**
- The `canonical_financial_records` table structure (add columns only, never remove)
- The `findings` engine — it reads canonical records but does not know the contract version
- The `evidence_requests` workflow — entirely unaffected
- Any reporting queries — they read canonical records at the business field level

### 8.3 Mixed-version batch handling

When a new contract version is deployed, existing records remain at their original version. The `ingestion_contract_version` column allows:
- Querying historical records by the normalization contract under which they were created
- Re-hashing old records if a normalization error is discovered (run as a data repair migration, not as part of normal ingestion)
- Auditing which contract version produced which canonical records

Mixed-version canonical records coexist safely: the findings engine reads financial fields only, not the contract version.

### 8.4 Version `1.0` specification

Included fields in `normalized_hash`: `company_id`, `record_type`, `canonical_date`, `amount_tzs`, `vat_amount_tzs`, `counterparty_tin`, `counterparty_name` — exactly as specified in §7.2.

---

## §9 — Firm Members Architecture

### 9.1 Gap from prior session

The Partner sign-off at step 5 of the evidence workflow (`advance-evidence-step` action `sign_off`) currently has no role enforcement because there is no roles table. This section designs that table.

### 9.2 `firm_members` table design

```
firm_members
─────────────────────────────────────────────────────────────────
id            UUID          PK, gen_random_uuid()
company_id    UUID          NOT NULL → companies(id) ON DELETE CASCADE
                            -- CASCADE: removing a company removes its members
user_id       UUID          NOT NULL
                            -- the user being added as a member
role          TEXT          NOT NULL
                            CHECK IN ('owner', 'partner', 'preparer', 'viewer')
invited_by    UUID          NULL
                            -- UUID of the user who created this membership row
                            -- NULL for the company owner's own row (auto-created)
accepted_at   TIMESTAMPTZ   NULL
                            -- NULL = invitation pending; NOT NULL = active member
created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()

CONSTRAINT uq_firm_member UNIQUE (company_id, user_id)
-- One row per user per company; role changes are UPDATEs, not new rows
```

### 9.3 RLS design

```sql
-- Enable RLS
ALTER TABLE public.firm_members ENABLE ROW LEVEL SECURITY;

-- SELECT: own rows OR company owner can see all their company's members
CREATE POLICY "Members can view their own membership"
ON public.firm_members FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- INSERT: only the company owner can add members
CREATE POLICY "Company owners can add members"
ON public.firm_members FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- RESTRICTIVE INSERT: defense-in-depth
CREATE POLICY "firm_members_company_ownership_insert"
ON public.firm_members AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- UPDATE: company owner can change roles;
--         members can set their own accepted_at (accept invitation)
CREATE POLICY "Company owners can update member roles"
ON public.firm_members FOR UPDATE TO authenticated
USING (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
  OR user_id = auth.uid()  -- member accepting their own invitation
)
WITH CHECK (
  -- Owners can change any field
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
  -- Members can only set accepted_at (enforced at application layer;
  -- DB layer permits the row if they own it)
  OR user_id = auth.uid()
);

-- DELETE: only company owner can remove members
CREATE POLICY "Company owners can remove members"
ON public.firm_members FOR DELETE TO authenticated
USING (
  company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);
```

### 9.4 Partner sign-off enforcement

The step-transition handler checks partner eligibility before executing the `sign_off` action:

```
-- Pseudocode for partner verification (not deployable code)
partner_check = SELECT fm.role
  FROM firm_members fm
  WHERE fm.company_id = er.company_id
    AND fm.user_id = calling_user_id
    AND fm.accepted_at IS NOT NULL  -- must have accepted the invitation
    AND fm.role IN ('owner', 'partner')

IF partner_check is empty:
  RETURN 403 Forbidden "sign_off requires owner or partner role for this company"
```

The `owner` role always has sign-off privileges (a sole practitioner who is both preparer and partner should not be locked out of their own workflow). The `partner` role has sign-off privileges. `preparer` and `viewer` do not.

### 9.5 `owner` row creation

When a company is created (INSERT into `companies`), a trigger should automatically create the owner's `firm_members` row:

```
trigger: AFTER INSERT ON companies
→ INSERT INTO firm_members (company_id, user_id, role, accepted_at)
   VALUES (NEW.id, NEW.user_id, 'owner', now())
   ON CONFLICT DO NOTHING
```

This ensures every company always has at least one owner row in `firm_members`, and the step-transition handler can always resolve roles without special-casing the `companies.user_id` lookup.

### 9.6 Role descriptions

| Role | Can view findings | Can create evidence request | Can advance steps 1–4 | Can sign off (step 5) | Can see all members |
|------|----------------|--------------------------|--------------------|---------------------|-------------------|
| owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| partner | ✓ | ✓ | ✓ | ✓ | ✓ |
| preparer | ✓ | ✓ | ✓ | ✗ | own row only |
| viewer | ✓ | ✗ | ✗ | ✗ | own row only |

---

## §10 — VAT Refund Extension Points

Phase 3 only. No tables designed this session.

The current architecture provides three clean attachment points for a `vat_refund_claims` tracker:

**Attachment point 1 — `canonical_financial_records`**  
VAT amounts (`vat_amount_tzs`) are stored on every canonical record. A refund claim would aggregate these by company/period to compute the refund basis. The canonical layer is the natural query source — no source-specific logic required.

**Attachment point 2 — `companies`**  
Each company's VAT registration status (currently not stored) and its refund claim history would be scoped to `company_id` — the same FK pattern used by all four existing Kinga tables.

**Attachment point 3 — `findings`**  
A finding of type `'manual'` with `trigger_category = 'vat_refund_pending'` can represent an in-progress refund claim without a dedicated table, as a Phase 3 interim. The full `vat_refund_claims` table (with TRA submission reference, backlog tracking, follow-up history) would be a Phase 3 schema migration following the same append-only, RLS-protected, audit-trailed pattern as `evidence_requests`.

The 12–24 month real-world wait time for TZS 1.4–1.5 trillion in pending refunds makes this a high-value workflow target — firms with large VAT credit positions need a defensible paper trail specifically because TRA processing is unpredictable. When Phase 3 begins, the table design brief and attachment point specifications are ready to execute without architectural rework.

---

## §11 — Risk Assessment

### Architectural risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Source Independence violation (current) | **HIGH** | The proposed findings engine reads from `efdms_records` directly. Adding a second source requires branching logic that compounds indefinitely. | Add canonical layer (§3) before implementing the findings engine. The findings engine must not be deployed until this is in place. |
| No canonical boundary before findings engine | **HIGH** | Without the canonical layer, every new adapter requires findings engine changes. | Block findings engine Edge Function deployment until `canonical_financial_records` is live. |
| `firm_members` gap in Partner sign-off | **MEDIUM** | Step 5 currently has no role enforcement. Any authenticated user who can see the finding can sign off. | Design and apply the `firm_members` migration before deploying the step-transition handler. |
| SDL rate conflict unresolved | **MEDIUM** | The 4% vs. 3.5% SDL conflict will propagate to all client findings generated using the rule. `verified_at = NULL` is the guard, but the application layer must enforce it. | Resolve against primary Finance Act 2025 text before going live with findings generation. |
| `firm_members` trigger on company creation | **LOW** | If the auto-create trigger for the owner's `firm_members` row is not added, companies will have no owner row, and the partner check in step 5 will incorrectly block the company owner. | Include in the `firm_members` migration as an atomic unit. |

### Operational risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Seed migration re-execution | **MEDIUM** | Re-running the seed migration fails with a CHECK violation (safe but confusing). Operators without context will not understand the error. | Apply idempotency guards (§2.2) before running in production, or add a clear comment block explaining re-execution behavior. |
| EFDMS export format unconfirmed | **HIGH** | The CSV adapter's field mapping is designed against assumed column headers. A real TRA export may use different names or encoding. | Obtain a real export sample before implementing the CSV adapter. Do not release the ingestion function until field mapping is verified. |
| `validation_report` per-account gap | **HIGH** | Rule-trigger findings require account-level GL amounts not currently available in `validation_report`. The findings engine cannot produce rule_trigger type without this data. | Audit the `process-trial-balance` function output before implementing Module B of the findings engine. |
| Service role key exposure | **MEDIUM** | Edge Functions using the service role key bypass all RLS. A compromised function or key can read/write any company's data. | Minimize service role key usage; validate user ownership explicitly in every Edge Function before any service-role write. Rotate the service role key on any suspected exposure. |

### Migration risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Canonical layer backfill | **MEDIUM** | Once `canonical_financial_records` is added, existing `efdms_records` rows must be backfilled. A failed backfill leaves the database in a split-brain state. | Write and test the backfill script in a staging environment first. Make it idempotent (normalized_hash deduplication). |
| `effective_to` constraint on re-run | **LOW** | The seed migration's second execution fails with `chk_effective_dates` violation inside the trigger. The error message is cryptic without context. | Already mitigated by the `BEGIN/COMMIT` rollback — no partial state. Long-term: apply §2.2 idempotency guards. |
| Phase 1 security migrations not yet applied | **HIGH** | If the four Phase 1 security migrations (Fixes 1–4) have not been applied to production, the existing Axiom tables (`trial_balance_uploads`, `account_corrections`) still carry the vulnerabilities documented in the Phase 1 review. Kinga's RLS references `trial_balance_uploads` in the findings RESTRICTIVE policy — the upload must be correctly scoped before that policy has meaningful security value. | Confirm Phase 1 migrations are applied and smoke-tested before deploying any Kinga functionality in production. |

### Audit risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| SDL rate used for live filings before verification | **HIGH** | If any client filing uses the unverified 4% SDL rate and the correct rate is 3.5%, the filing is incorrect. | The `verified_at IS NULL` check must be enforced at the application layer: no finding may be generated from a rule where `verified_at IS NULL`. This is a required guard in the findings engine. |
| `response_pack_ready` not updated if SECURITY DEFINER is lost | **MEDIUM** | If `update_finding_response_pack_ready.prosecdef = false`, the flag is never set to true, and response pack generation is permanently blocked. | Run the trigger function verification query from §1 after every migration deployment. |
| Manual entry records without secondary review | **MEDIUM** | `requires_secondary_review = true` on manual records is enforced by convention (the adapter sets it) but not by a DB constraint. An adapter bug could produce manual records without the flag. | Add a DB CHECK or trigger: `CHECK (source_type != 'manual_entry' OR requires_secondary_review = true)`. |

### Scalability risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Two-hop RLS on evidence_requests | **LOW** | At the scale described in the architecture doc (hundreds of companies, thousands of findings), the nested IN semi-join is efficient with current indexes. At multi-thousand company scale it may require a SECURITY DEFINER helper function as discussed in the RLS stress test. | Monitor query plan for evidence_requests at 5,000+ findings per user. Add SECURITY DEFINER function if planner regresses. |
| `canonical_financial_records` growth | **LOW** | This table will be the largest table in the database at scale. All adapters write here. | Add `idx_canonical_records_company_period ON canonical_financial_records (company_id, period_year, period_month)` and `idx_canonical_records_batch ON canonical_financial_records (batch_id)` in the canonical layer migration. |

### Integration risks

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| TRA API access unconfirmed | **HIGH** | The entire EFDMS real-time integration depends on API access that has not been confirmed with TRA. | Do not architect the TRA API adapter until access is confirmed. The reserved `source_type = 'tra_api'` requires no schema changes when the time comes. |
| VFD provider selection | **MEDIUM** | Each VFD provider has a different API contract. The adapter cannot be designed generically. | Select one VFD provider, obtain API documentation, and design a provider-specific adapter — not a generic "VFD" adapter. |

---

## §12 — Recommendations

Listed in priority order.

**1. Apply the canonical ingestion layer before deploying the findings engine.**  
The findings engine must never be deployed reading from `efdms_records`. The `canonical_financial_records` table and its backfill are the prerequisite. This is the highest-priority architectural action.

**2. Apply idempotency guards to the seed migration before production execution.**  
The current seed migration is safe to fail on re-execution but produces a confusing error. Replace plain INSERTs with `INSERT ... WHERE NOT EXISTS` variants. The revision window is still open since the migration has not yet been applied.

**3. Resolve the SDL rate conflict before enabling findings generation.**  
Obtain the primary Finance Act 2025 text. If rate is 3.5%: insert a new `sdl` row with `rate_pct = 3.5000`, `effective_from = '2025-07-01'` (the trigger closes the 4% row). If rate is 4%: set `verified_at = now()`, `verified_by = <reviewer_uuid>` on the existing row via service-role UPDATE. The findings engine must gate on `verified_at IS NOT NULL` for all rules used in computations.

**4. Apply the `firm_members` migration before deploying the step-transition handler.**  
Without role enforcement, any authenticated user can sign off any finding. The `firm_members` design in §9 is complete and ready for implementation approval.

**5. Obtain a real TRA EFDMS export sample before implementing the CSV adapter.**  
Field mapping is the only variable that cannot be resolved from first principles. Everything else in the adapter design can be built independently.

**6. Audit `process-trial-balance` output before implementing rule-trigger findings.**  
The rule-trigger module (Module B of the findings engine) requires per-account GL amounts that may not be in the current `validation_report` structure. Confirm the data contract first.

**7. Add the `firm_members` owner auto-creation trigger atomically with the `firm_members` table migration.**  
Missing this trigger means the company owner row never exists, and partner sign-off blocks the company owner.

**8. Add a CHECK or trigger on `canonical_financial_records` enforcing `requires_secondary_review = true` for `source_type = 'manual_entry'`.**  
Prevents an adapter bug from silently disabling the manual entry safeguard.

**9. Confirm Phase 1 security migrations are live before any Kinga production usage.**  
Kinga's findings RESTRICTIVE policy references `trial_balance_uploads`. If Fix 4 (upload ownership check) is not applied, the RESTRICTIVE policy has a different security baseline than designed.

**10. Reserve the VAT refund tracker as a Phase 3 first-class feature.**  
The attachment points are clean (§10). The commercial case (TZS 1.4–1.5T backlog, 12–24 month waits) is strong. When Phase 3 begins, no architectural rework is needed.

---

*End of document. Stop and wait for review.*
