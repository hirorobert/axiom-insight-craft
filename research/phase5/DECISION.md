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
- The prototype now carries minor units as **exact `BigInt`** (never JS floats), mirroring production `bigint`/exact
  strings; `toMinorUnits` refuses a non-integer money cell rather than silently rounding. Sign and relationship comparisons
  are exact at any magnitude, not merely correct below 2^53.

## Output-specific evidence requirements (the honest "a TB may not be enough")
| Output | Required evidence | Missing ⇒ |
|---|---|---|
| **TB review summary** (the proposed Phase 6 first slice) | reviewed `TRIAL_BALANCE` + complete `MAPPING_REVIEW` (coverage `unmapped=0;ambiguous=0`) | summary not ready — but the **review still proceeds** |
| **Complete financial statements** (excluded from this slice) | + `COMPARATIVE` (prior period) + `CASH_ACCOUNT_MAP` + `TRANSACTION_LEDGER` (+ the existing `fs_publication_blockers` set) | statement blocked with an explicit gap code — **never plugged** (`KNOWN/MISSING/CANNOT_ASSESS`) |

Financial-statement generation and withheld modules remain **excluded**. The first production slice ends at a **traceable TB
review summary + a repeat upload** — not a newly released statement engine.

## AI scope — what actually executes (honest)
**No AI participates. Nothing here calls a model.** The prototype is **deterministic proposals + grouping + reviewer-confirmed
decisions + controlled reuse**. Arithmetic, reconciliation, evidence sufficiency and every enforced gate are deterministic
code (and, in production, the real SQL functions). AI remains an **optional, separately-governed proposal mechanism**: it may
only ever emit `MACHINE_SUGGESTION` proposals that a reviewer confirms, re-validated deterministically — exactly as the
existing `layout-assist` seam does. It is disabled today (`ai_provider_settings` seeded DISABLED, `PROVIDER_DISABLED`), and
enabling meaning-suggestion AI needs its own consent wording + data-handling approval + budget (it would need account names,
which the `ai-sample/1` data-minimisation contract withholds). No paid model execution without existing provider/budget
authority; no private customer data in fixtures, evaluation or training; `cfoclose_tb_fixtures.zip` is not used.

## Accounting boundaries (reaffirmed; each regression-tested in `tests/accounting_boundaries.test.mjs`, 17/17)
These encode disciplines as explicit refusals so the prototype never fabricates authority it lacks. Where production already
owns the discipline, the real authority is named.
- **MUSE observations are candidate rules, scoped.** Each is scoped to an **entity + chart/version + years**, carries
  **evidence**, and holds a **proposed/reviewer-approved** status — never a global prefix rule, never auto-applied.
- **Approval alone does not permit reuse.** Even an approved decision/rule is reusable only when the **context is
  compatible**; **changed meaning or conflicting evidence reopens** review (see reuse-context + `STALE_MEANING`).
- **Prepayments need the three-component bridge.** Opening + additions + release/amortisation, **each evidenced**, give the
  closing balance; **a closing figure agreeing arithmetically does NOT authorise net presentation**.
- **Two TBs establish net movements only** — never gross additions, credit movements, or a movement split; decomposition
  needs transaction-level evidence. (Net movement is not automatically a cash flow.)
- **Required evidence is output-specific; a sufficient reconciled alternative is acceptable.** Uploading a document alone
  **never** establishes readiness — only validated/reconciled evidence does (trust tier `KNOWN`, not "a file exists").
- **Source imbalance survives balanced adjustments.** An adjustment must itself balance (Σdebit = Σcredit, each line one
  side) and is a **layer** over the immutable certification; it cannot cure an underlying source imbalance, and **no
  balancing entry is ever invented** (production authority: `close_review_adjustments`, `20261015100000`).
- **Preserve source precision; distinguish a signed prior figure from a comparative.** A signed value carried in the current
  column is **not** the same as a separate comparative-period column; they are kept distinct, never summed or substituted.
- **Corrected sources are linked immutable versions.** A correction is a **new version** linked to the original; affected
  outputs are **re-evaluated** (requires-revalidation) **without changing historical signed artefacts** (mirrors the
  `close_review_adjustments` revalidation model and `layout_confirmations` binding).

## Interpretation boundaries (reaffirmed, kept separate)
1. **Export layout** (how the file is read) — never implies a treatment. 2. **Account identity & dimensions** —
`account_key = COALESCE(code, normalized name)`; ingestion also carries dimensions, but `account_mappings` has no dimension
axis (a dimension-aware mapping is a separate decision). 3. **Accounting meaning** — proposed, reviewer-confirmed. 4.
**Reporting treatment** — the `account_mappings` enums. 5. **Evidence sufficiency** — per output, never a plug.
Enforced throughout: **gross source rows are preserved**; different codes with similar descriptions are **not** auto-duplicates;
opening/addition/transfer relationships are **presented with evidence, never netted**; **net movement is not automatically cash
flow**; **no automatic netting, balancing plugs or unsupported journals**.

## Detection epistemics — "unexpected balance" ≠ "incorrect mapping" (tested separately, not conflated)
The prototype detects an **unexpected balance** (a sign anomaly for the proposed role) — it raises
`signals: ["UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE"]` and high uncertainty, routing the account to individual review. It
**never emits a "wrong mapping" verdict.** The two concepts are proven distinct by separate coverage tests:
- **(A) is not sufficient for (B):** the signal fires on a **correctly-identified** account — a legitimately overdrawn
  bank/cash account shows a credit balance (fixture `OVERDRAFT`). Detecting the anomaly does not establish a mis-mapping; it
  is a review trigger, and the reviewer decides the presentation.
- **(A) is not necessary for (B):** a **balanced, mis-mapped** account with **normal signs** is **undetectable** by the
  prototype (fixture `WRONGLY_MAPPED_NORMAL_SIGN`: "Prepaid rent" — truly a current asset, recognised as an operating
  expense; both roles are debit-normal, so no signal fires and it is silently grouped). Only a reviewer or corroborating
  evidence (a lease schedule, a GL drill-down, a comparative) can catch this class — an inherent limit of deterministic
  interpretation; AI could *propose*, separately governed, but never auto-accept.

## Batch atomicity, reason requirement, and manual selection (decided from the REAL contract, not assumed)
- **Atomicity: ALL-OR-NOTHING.** `resolve_account_review_batch` (`20261007100000`) validates every decision in a first pass
  and `RAISE`s on the first failure **before any write**; no per-decision `try/catch`; a single aggregate `result_summary`.
  There are **no partial outcomes** server-side. The manual path mirrors this: show each account's **pre-flight outcome
  before submission**, submit the confirmed set, and reject the **whole** batch (naming the offending account) on any
  failure — never a silent skip, never a misleading blanket success. Same-account concurrency is serialized by
  `pg_advisory_xact_lock` (last-writer-wins; the append-only ledger keeps both decisions).
- **Reason: use the existing requirement, invent no essay.** The RPC requires a reason **only** for
  `CONFIRM_ACCOUNT_TREATMENT` (3..500); `account_review_decisions.reason` is `TEXT NULL`. Routine
  `USER_ACCEPTED_SUGGESTION` / `USER_MANUAL_CLASSIFICATION` need **none**. An earlier prototype over-required a 3-char
  reason; **corrected** — a reason is recorded when supplied, never forced for a routine decision.
- **Uncertain accounts.** `HIGH_UNCERTAINTY` / `NO_RECOGNISED_MEANING` accounts are never auto-grouped by inferred
  equivalence (layer 4 keeps them individual). They may be organised **visually by issue** (`impliesTreatment:false`), and a
  reviewer may **deliberately** select several and assign one common treatment — each validated through the same server
  authority, preserving identity, previous + proposed treatment, actor, operation identity (`client_request_id`) and any
  reason.
- **Reuse is more than a file hash — three explicit states, never a silent inherit.** (i) **Verified compatible** accepting
  context (entity + currency + any dimensions; currency/period from `fiscal_periods`) ⇒ reuse **may be proposed**;
  (ii) **missing/unverifiable** context ⇒ **reopen for explicit confirmation** (`CONTEXT_UNVERIFIED`); (iii) a **known
  change** ⇒ reopen (`CONTEXT_INCOMPATIBLE`). A treatment is **never inherited solely from `company_id + account_key`**; a
  field absent on both sides is "not applicable", not a false reopen. Honest schema reality: currency + period are
  authoritative on `fiscal_periods`; the remaining work is **binding the accepting context onto the decision ledger** plus
  **dimension** and **ruleset-version** axes (gap #4). Additive, not in the first slice.
- **Same-name / different-code accounts (finding from NORMAL #140, preserved).** `uq_acct_map_company_norm_name` forbids two
  accounts with the same normalized name per company, so the real RPC raises a **raw constraint error** when both are mapped
  (e.g. `4000`/`4100 Sales`). The interpretation layer is right to treat them as distinct; the conflict is at persistence.
  Proposed Phase 6 treatment and the production dependency are in HANDOFF — the fixture is unchanged, the case preserved.

## Limitations surfaced by the extended coverage (reported, not optimised away)
- **Header recognition is partial.** QuickBooks- and Odoo-style headers are recognised; **SunSystems' "T/B Code" is not**, so
  the automatic path loses codes and keys by description. **Resolution — now VERIFIED through an EXISTING contract (not merely
  proposed):** the manual `LayoutProfile` route executes through the **real, unmodified** `supabase/functions/_shared/layoutProfile.ts`
  (`validateProfile` + `resolveLayout` map "T/B Code" → accountCode and recover every code). Proven by
  `research/phase5/proof/real_layout_contract.mjs` (8/8, Node type-stripping). Phase 6 routes unrecognised headers through the
  confirmed-layout path; no new mechanism.
- **Keyword heuristics collide** (e.g. "rent income"). Mitigated by an income-precedence rule and a **role-aware,
  exact-money unexpected-balance signal** (mirrors finding A01; role-aware = contra-assets are credit-normal and drawings are
  debit-normal, so neither is mis-flagged). It surfaces side mismatches for individual review but, per the epistemics above,
  **cannot catch every wrong mapping** — the reviewer is the authority (AI could assist, separately governed).
- **Balance/imbalance checking** is owned by the production ingestion core (`TRIAL_BALANCE_IMBALANCE`); the prototype defers.
- **`STALE_MEANING`** beyond identity/chart-code change has **no production mechanism** and is **not** in the first slice.
