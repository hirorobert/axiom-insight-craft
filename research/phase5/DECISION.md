# Phase 5 — Decision: deterministic vs AI-assisted vs hybrid

Research recommendation for NORMAL's review. It proposes the **smallest defensible** architecture and states its limits.

## The three approaches

### A. Deterministic (what the prototype implements)
Rule/keyword heuristics propose meaning; reviewer confirms; grouping + reuse + invalidation are pure, reproducible functions.
- **For:** no provider, no cost, no data leaves the server, fully auditable and replayable, every refusal is a stable code.
  Reuses every existing authority (`account_key`, `sequence_no` latest-wins, `source_file_hash`, certification invalidation,
  identity-drift reopen). Proven: 29/29 synthetic checks.
- **Against:** brittle on genuinely unfamiliar descriptions — an account it cannot recognise falls to **individual** review
  (`NO_RECOGNISED_MEANING`), and keyword collisions are real (e.g. "accumulated depreciation" matches "depreciation"); the
  prototype handles that one by surfacing it as high-uncertainty, but the general case needs either broader rules or (B).

### B. AI-assisted
A model proposes meanings/groupings for accounts the deterministic layer cannot recognise.
- **For:** fewer "unknown" individual reviews; adapts to novel/multilingual descriptions.
- **Against — decisive here:** AI is **architecturally disabled** and gated four ways (`ai_consent_versions`,
  `ai_provider_settings` seeded DISABLED with an enable-gate CHECK, `ai_workspace_budgets`, `ai_layout_assist_runs`); no
  provider is wired (`PROVIDER_DISABLED` 503); the Phase 5 rule forbids paid calls without existing budget/provider authority.
  Critically, the existing data-minimisation contract (`ai-sample/1`) sends only **SHAPE tokens** — "no account name, amount,
  company or sheet name leaves the server." But **meaning lives in the account name**, so a meaning-suggestion model would need
  a *different, more revealing* sample than `ai-sample/1` — a **new consent wording + data-handling approval + budget**
  decision that is explicitly an owner/product choice, not something to enable here. AI output must also never auto-approve.

### C. Hybrid (RECOMMENDED)
Deterministic authority + reuse/invalidation backbone (the must-be-correct part, no model), with AI as an **optional,
consent+budget-gated SUGGESTION layer** that only ever emits `proposal_type: "MACHINE_SUGGESTION"` which a reviewer confirms —
never auto-accepted, re-validated deterministically — exactly as the existing `layout-assist` seam does for layouts.

## Recommendation — smallest defensible architecture
**Ship the deterministic hybrid WITHOUT AI first.** Concretely:
1. Keep `resolve_account_review_batch` as the sole per-account authority (no new authority, no migration).
2. Add, as **pure functions + one read-only summary** (edge or RPC): the 5-layer interpretation, the **grouped treatment
   proposal**, the **reuse classification** (`REUSABLE/NEW/STALE_IDENTITY/STALE_MEANING`), and the **evidence sufficiency**
   assessment per output. Group acceptance **expands** to the existing per-account batch; no "Accept all".
3. Defer AI behind the already-disabled `ai_*` gates; adding it later is additive and requires its own consent/data-handling/
   budget decision (because it needs account names, which `ai-sample/1` withholds).

This is smallest-defensible because it adds **no database structure, no entitlement/payment/registry/deployment change**, reuses
every versioning/invalidation primitive that already exists, and keeps the reviewer in authority over every consequential call.

## Limitations (stated, not hidden)
- The deterministic keyword rules in the prototype are **illustrative**; production keyword/vocabulary coverage is a product
  decision. The architecture (layers, grouping, reuse, invalidation) is the deliverable, not the specific keywords.
- **Dimensions** (cost centre / branch / fund) are captured at ingestion (`IngestedAccount.identity`) but `account_mappings`
  has **no dimension axis**. A dimension-aware mapping is a larger, separate decision (a new identity axis) — out of scope here.
- `account_classifications` (MAONO) has **no migration**; nothing here builds on it.
- **Chart re-coding:** reuse keys on `account_key` (code when present). A company that re-codes its chart would see accounts as
  `NEW` even if descriptions are unchanged — correct per the identity rule, but a known UX edge the product should consider.
- **Refusals needing real Postgres/RLS** (true `auth.uid()` binding, server-computed `account_key`, DB-level append-only
  immutability) are asserted against the production RPCs, not re-proven in this pure prototype — the proof labels them so.
- The prototype uses JS integers for minor units; production uses `bigint`/exact strings (no float ever reaches the DB).

## Output-specific evidence requirements (the honest "a TB may not be enough")
| Output | Required evidence | Missing ⇒ |
|---|---|---|
| **TB review summary** (the proposed Phase 6 first slice) | reviewed `TRIAL_BALANCE` + complete `MAPPING_REVIEW` (coverage `unmapped=0;ambiguous=0`) | summary not ready — but the **review still proceeds** |
| **Complete financial statements** (excluded from this slice) | + `COMPARATIVE` (prior period) + `CASH_ACCOUNT_MAP` + `TRANSACTION_LEDGER` (+ the existing `fs_publication_blockers` set) | statement blocked with an explicit gap code — **never plugged** (`KNOWN/MISSING/CANNOT_ASSESS`) |

Financial-statement generation and withheld modules remain **excluded**. The first production slice ends at a **traceable TB
review summary + a repeat upload** — not a newly released statement engine.
