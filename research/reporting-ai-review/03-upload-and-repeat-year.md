# 03 — First-Upload & Repeat-Year Experience

## 3.1 What works today (VERIFIED)

### Ingestion is fully deterministic — the governing principle's "familiar layouts need no model" is already satisfied
- **Column detection:** `detectColumns()` scores the first 15 rows against `COLUMN_MATCHERS`
  (`process-trial-balance/index.ts:165-190,409-444`); maps code/name/debit/credit/balance by
  best-match. No positional hardcoding, no model.
- **Excluded-row accounting (mostly explicit):** `rejectedRows[]` records subtotal/total rows,
  malformed numerics (**excluded, never coerced to 0**), and all-zero sentinels, with a reason and
  `source_row_number` (`:503-578`). **Gap:** truly-blank / code-less rows are `continue`d without
  a `rejectedRows` entry (`:515,524`) — "no silent omission" holds for content-bearing rows only.
- **Arithmetic is independent of any model:** debits=credits (tol 1 TZS) is the one hard block
  (`:1680-1726`); the balance-sheet equation is a soft warning (`:1946-1968`).
- **Account-count cap: absent on `b32aa4f` (inspected baseline); PRESENT on `69155ae`.**
  CORRECTED — see `09` §2: on NORMAL's current candidate the cap exists in
  `supabase/functions/_shared/uploadPolicy.ts` (`maxAccounts: 2_000`, plus row/byte limits),
  enforced via `_shared/tbIngestion.ts` with a refusal that names the limit and next step (nothing
  truncated). It is an explicitly **provisional resource bound (owner decision pending), not an
  accounting rule**, covered by unit tests, an e2e probe and a db-proof. Do not conflate this with
  the QA candidate `ebafa68`'s `TOO_MANY_ACCOUNTS` wording.

### Repeat-year reuse — the one mechanism that is actually wired (VERIFIED)
- `account_mappings` is keyed `(company_id, account_key)` where
  `account_key = COALESCE(account_code, normalized_account_name)` — a generated stored column
  (`20260703120000_...sql:24-29`). **No `period_year` column** — mappings are company-scoped and
  **period-agnostic**.
- Every later upload resolves each account against that company's mappings in Tier 1/2 **before**
  any dictionary/regex (`index.ts:751-775,1744-1776`). A professionally approved mapping from last
  year is reused automatically this year. **Changed file identity alone does NOT invalidate
  mappings — and a new reporting period alone does NOT either** (`account_mappings` has no
  `period_year`; reuse is governed by account identity). CORRECTED/clarified — see `09` §6:
  distinguish the reusable **treatment** (mapping/classification, period-agnostic) from
  **period-specific evidence and allocations** (movement splits, cash-perimeter evidence,
  current/non-current and other allocations) which are legitimately re-supplied/re-derived each
  period. A decision reopens on a change in account identity, meaning, governing rule/framework, or
  stale/absent period evidence — not on period rollover per se.

### Changed-context reopening — live at the certification & suppression layers (VERIFIED)
- `get_authoritative_certification` carries the upload's current `source_file_hash` and treats the
  certification as authoritative only if the hash is unchanged (drift ⇒ not authoritative;
  `20260902130000:385-403`). `computeCertificationReadiness.ts` binds authority to the exact
  on-screen upload (`superseded`/`stale` otherwise). `certificationRevalidationGuard.ts` downgrades
  a stale "certified" verdict the instant a reprocess is accepted.
- Identity-drift reopening of a non-reporting suppression:
  `get_effective_non_reporting_status` → `PRIOR_NON_REPORTING_DECISION_STALE_IDENTITY_CHANGED`
  (`20260816120000:500-509`).

### Review authority — grouped batch at the RPC, append-only versioned ledger (VERIFIED)
- `resolve_account_review_batch(p_decisions JSONB)` is the sole writer (`20260904120000`,
  supersedes `20260816120000`): actor from `auth.uid()` → `firm_members` server-side (owner/
  partner/preparer; viewer excluded), upload↔company cross-check, actor-scoped idempotency
  (`client_request_id` + `request_hash`), per-account canonical key with in-batch dedup, advisory-
  lock ordering, append-only `account_review_decisions` with `previous_value`/`new_value` and a
  global monotonic `sequence_no`.

## 3.2 What is MISSING for the "smallest honest extension"

| Capability wanted | Status | Evidence / gap |
|---|---|---|
| Confirmed compatible **profile** reuse without model calls | **PARTIAL** | Account-level mapping reuse exists & is deterministic; but there is **no layout/file "profile" or fingerprint** concept in ingestion. |
| **Bounded AI proposals for unfamiliar layouts** (cell/page refs, explicit excluded rows) | **MISSING** | Zero AI in ingestion; unfamiliar layouts are best-effort parsed or `blocked` on missing columns — no proposal path. |
| **Grouped proposals / bulk assignment** for common treatment | **MISSING in UI** | `resolve_account_review_batch` accepts a batch, but `AccountReviewPanel.tsx` is **per-account only** (one `Select` per row, `:496-511`); no "apply to all matching" control. |
| Per-account validation, **no inferred equivalence** | **PRESENT** | Identity is the exact `rowKey` (code or `name:<name>`), mirroring the server key. |
| Material uncertainty → **focused questions** | **MISSING** | `needs_review` accounts are listed; there is no question-reduction step. |
| **Versioned decisions** | **PRESENT (as append-only ledger)** | `sequence_no` + prev/new; **no `expected_version` CAS** on review (that pattern is World-B only). |
| **Prior-decision-as-suggestion** resolver (period/framework-gated) | **DORMANT** | `resolveMappingMemorySuggestion()` (`mappingMemory.ts:379-487`) is pure, fail-closed, compatibility-gated — but **unwired**; its store `account_mapping_memory` has **no writer and zero rows** (`:28-33`). |

## 3.3 Status corrections vs CLAUDE.md (flag, do not fix here)
- **`DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001`** is listed OPEN in §9.1, but on this branch it
  appears **repaired in source**: migration `20260904120000_account_review_flag_preservation.sql`
  drops NOT NULL/DEFAULT on the three flags (`:77-83`) and rewrites the UPSERT to insert NULL on a
  new row and **preserve** the existing value when a flag key is absent (`:296-328`);
  `buildReviewDecisions.ts:45-124` omits un-reviewed flags (true tri-state). The UI now exposes all
  three flag checkboxes (`AccountReviewPanel.tsx:528-546`). **Live DB application is UNKNOWN** —
  the panel itself notes the RPC may be unapplied in reachable environments. Recommend reconciling
  the status doc.
- Minor: `parser_version` is stamped `"v2.0"` on the success path (`index.ts:1992`) but `"v2.2"`
  on the blocked/needs-review paths — a provenance inconsistency.
