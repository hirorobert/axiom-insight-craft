# Phase 5 — Handoff

## Branch & commits
- Branch: `research/phase5-accounting-interpretation-20261016` (off `origin/main` @ `00a2653`). Draft **PR #138**.
- Worktree: `D:/DevStorage/Temp/claude/cfoclose-phase5-20261016`. Push: available (verified non-destructively).
- **Implementation commits (preceding this handoff):** `4ec6cf1` (prototype + original proofs + INTERFACE/DECISION),
  `b40097a` (real-contract static check, replayable PG17 proof, extended coverage, income rules),
  `cfa42e2` (exact-money BigInt, role-aware unexpected-balance *signal* vs mapping-verdict separation, `OVERDRAFT` /
  `WRONGLY_MAPPED_NORMAL_SIGN`, executed real-layout contract proof, `run_all.mjs` recorder) and
  `dc07f35` (manual multi-account treatment path, reuse-context > file-hash, atomicity mirrored from the real RPC,
  reason relaxed to the server's actual requirement, `manual.test.mjs`, extended static + replayable proofs) and
  `b56f504` (SEAT_LIMIT fix in the replayable proof via a supported seat grant, runtime DB-version reporting, and the
  `accounting_boundaries.test.mjs` regression harness) and
  `9c135b0` (reconciled the RPC proof to ONE identified version with NORMAL #140's four corrections, preserved the
  same-name/different-code finding, tightened the first-slice reuse rule to three explicit states) and
  **`ab04257`** (UNKNOWN ≠ NOT APPLICABLE reuse rule — absent-on-both context reopens unless an explicit authoritative N/A
  rule exists; reconciled the proof against NORMAL `2632348` / PG 17.11 24/25 and adopted its `extensions.digest`==pgcrypto
  verification; corrected the acceptance wording for uncertain accounts).
  (This HANDOFF is a separate, later commit — no commit embeds its own hash.)

## Reconciliation with NORMAL #140 — one identified proof version (exact versions & differences)
**Versions:** NORMAL #140 commit **`2632348`** (based on #138 @ `5a06e56`) reported **PostgreSQL 17.11: 24/25**, the single
non-pass being the same-name/different-code identity incompatibility (its success path used the revenue group `4000`/`4100
Sales`, so the collision surfaced as a failed check). The identified version is now this branch tip
(`real_contract_proof.mjs` @ the head below).
**Differences (this version vs `2632348`):** (a) seats — here via licence `additional_seats`; NORMAL used an equivalent
`NAMED_USER_SEATS` entitlement override (both supported authority, neither bypasses the seat wall — `included_seats = 1` on
every paid plan); (b) version — `SHOW server_version` vs `current_setting` (both report the **actual** version, neither
hard-codes); (c) success path — a **collision-free** group here vs the revenue group there; (d) the same-name case is an
explicit `fnd()` **FINDING** here (reported separately from pass/fail) vs a counted **FAIL** there; (e) this version adds
#138's manual / atomic / conflict coverage and NORMAL's `extensions.digest`==pgcrypto (SHA-256 vector) verification.
**No completeness claim:** (d) is a **representation** difference, **not a resolution**. The same-name/different-code
incompatibility is **identical and unresolved** in both; "checks pass + 1 finding reproduced" here must **not** be read as
complete compatibility or a passing support claim. The four corrections are justified; fixtures were **not** changed to get
green. NORMAL should re-point the evidence job at the head below.

## GENUINE FINDING (from NORMAL #140), preserved — same-name / different-code accounts
Two accounts with the **same normalized name** and **different codes** (synthetic `4000 Sales`, `4100 Sales`) **cannot both
be mapped** in one company: `account_mappings` carries a partial unique index `uq_acct_map_company_norm_name` on
`(company_id, normalized_account_name)` (`20260703100000`). The real RPC raises a **RAW constraint violation, not a
structured refusal**. This is a real production limitation, **preserved not smoothed**: the proof's success path uses a
collision-free group and a dedicated `fnd()` finding asserts the raw-constraint behaviour; it is also surfaced at the static
tier (`real_contract_static` 18/18). The interpretation layer is still correct to treat the two as **distinct** accounts
(distinct `account_key`); the conflict is at **persistence**.
- **Principle (correction):** a legitimate same-name/different-code account must **not** require **renaming the source
  account as the permanent solution**. **Original source names and codes are preserved**; any disambiguating text is an
  **optional display label kept separate from source identity** (`account_key`/`account_code`/`account_name` are never
  mutated to satisfy the constraint).
- **Proposed handling (for owner decision — not implemented):**
  - (a) **Preparer disambiguation — a TEMPORARY workaround where appropriate**, not the permanent fix: the reviewer supplies
    a distinct *display label* (e.g. "Sales — Product A/B") while the **source name/code stay intact**. It unblocks a real
    engagement today but does not resolve the underlying constraint.
  - (b) **Structured refusal — improved FAILURE HANDLING, not compatibility:** surface `SAME_NORMALIZED_NAME_DIFFERENT_CODE`
    *before* submit instead of a raw DB error. This makes the failure legible; it does **not** make the two accounts
    mappable. The research lane can provide the pure pre-flight validator.
  - (c) **Coordinated constraint-and-lookup repair — the PROPOSED SUPPORT PATH, owned by NORMAL** under the existing bounded
    repair instruction: reconcile the uniqueness/lookup model so genuinely distinct same-name/different-code accounts are
    supported with source identity preserved. **This handoff does NOT prescribe replacing the index with `account_key`
    alone** — NORMAL must verify all uniqueness, lookup and migration dependencies before choosing the mechanism.
- **Production dependency:** the partial unique index `uq_acct_map_company_norm_name` (`20260703100000`, reinforced by the
  full key work in `20260703120000`). Any treatment must reconcile with it; it is not bypassable from research, and the
  repair in (c) is NORMAL's to design and verify.

## Runtime-vs-inspection honesty (reinforced)
SQL inspection (Tier 2 static) tells us the real function's **shape and rules**; it does **not** prove runtime behaviour.
**Atomic batch acceptance, idempotency, concurrency serialization, cross-tenant refusal and stale-decision refusal are
asserted statically here and are only truly PROVEN by Tier 4** — successful execution against the real RPCs on PostgreSQL
(`proof/real_contract_proof.mjs`), which is **still unexecuted on this host** (no Docker/PG). They stay explicitly
unexecuted until NORMAL runs the proof. Nothing in these deliverables claims them as runtime-proven.

## Execution tiers — what is proven at which level (never conflated; unexecuted stays unexecuted)
| Tier | Meaning | Status here |
|---|---|---|
| 1 · Prototype assertions | deterministic behaviour of the research adapters | **EXECUTED** — phase5 29/29, coverage 21/21, manual 24/24 |
| 2 · Static compatibility | payloads/refusals parsed from the **real** RPC SQL match what we emit | **EXECUTED** — real_contract_static 17/17 (necessary, not sufficient) |
| 3 · Actual layout-contract execution | the **real** `layoutProfile.ts` runs against our input | **EXECUTED** — real_layout_contract 8/8 (imports the real module) |
| 4 · Real RPC / RLS / persistence enforcement | the **real** `resolve_account_review_batch` on PostgreSQL (success + refusal + lifecycle + manual + atomic + conflict); the runtime version is reported, not assumed | **REPLAYABLE, NOT executed here** — `proof/real_contract_proof.mjs` (needs a loopback PG; coordinate with NORMAL) |
| 5 · Authenticated application integration | the real UI → edge → RPC under a real logged-in session | **NOT built, NOT executed** — Phase 6, pending scope approval |

## Batch atomicity (authoritative — read from the real SQL, not assumed)
`resolve_account_review_batch` (migration `20261007100000`) validates **every** decision in a first pass and `RAISE`s on the
first invalid one **before any write**; there is no per-decision `try/catch`, and it returns a single aggregate
`result_summary`. **Batch acceptance is therefore ATOMIC / all-or-nothing; partial outcomes do not exist server-side.** The
honest UX consequence (built into the manual path): show each account's **pre-flight** outcome *before* submission; submit
only the confirmed set; a failing submit rejects the **whole** batch naming the offending account — never a silent skip,
never a misleading blanket success. Same-account concurrency is serialized by `pg_advisory_xact_lock(company, account_key)`
(last writer wins; the append-only ledger keeps both).

## Prototype vs real-contract evidence
| Evidence | What it proves | Status |
|---|---|---|
| `tests/phase5.test.mjs` | deterministic 5-layer prototype + lifecycle (the 7 North-Star behaviours); exact BigInt minor units | **EXECUTED 29/29** |
| `tests/coverage.test.mjs` | vendor-style patterns + edge cases; "unexpected balance" vs "incorrect mapping" separated; disclosed LIMITs | **EXECUTED 21/21** |
| `tests/manual.test.mjs` | manual multi-account path: no inferred-equivalence grouping, visual-by-issue, preview, atomic mixed-batch, cross-tenant/stale/idempotency/concurrent-conflict, reuse-context | **EXECUTED 24/24** |
| `tests/accounting_boundaries.test.mjs` | prepayment three-component bridge, two-TB net movement, source-imbalance-survives-balanced-adjustment, signed-prior vs comparative, corrected-version immutability, MUSE candidate-rule scope | **EXECUTED 17/17** |
| `tests/real_contract_static.mjs` | grouped **and manual** expansions compatible with the **real** `resolve_account_review_batch`; surfaces the same-name/different-code finding | **EXECUTED 18/18** (static — necessary, not sufficient) |
| `proof/real_layout_contract.mjs` | the SunSystems "T/B Code" manual-layout fallback **executes through the real, unmodified** `layoutProfile.ts` (`validateProfile`+`resolveLayout` recover every code) | **EXECUTED 8/8** (Node type-stripping; imports the real module) |
| `run_all.mjs` → `TEST-OUTPUT.md` | recorded full output + exit status, categorised prototype / real-contract / deferred | **EXECUTED** (4 executed suites pass, 1 deferred) |
| `proof/real_contract_proof.mjs` | **execution** against the real RPC on disposable PG17: success + refusals + lifecycle | **REPLAYABLE, NOT executed on this host** (no Docker/local PG; scope forbids a CI workflow here) |

**Access limitation (reported once):** this Windows host has no Docker and no local PostgreSQL (embedded-pg is unavailable),
and scope-cleanliness confines my writes to `research/phase5/**` (so I did not add a CI workflow). The real-function execution
proof is therefore delivered as a **one-command replayable package**:
`DB_PROOF_CONN=postgres://…@127.0.0.1:5432/db node research/phase5/proof/real_contract_proof.mjs` (a PG-capable runtime —
CI service or local Docker — runs it; loopback-only; refuses the production ref).

## Test-to-requirement matrix
| North-Star / verification requirement | Test(s) | Result |
|---|---|---|
| Recognise supported structure | coverage (QB/Odoo/SunSystems), phase5 #1 | PASS |
| SunSystems manual-layout fallback executes through the existing contract | `proof/real_layout_contract.mjs` | **EXECUTED 8/8 — VERIFIED route, not proposed** |
| Exact money (BigInt minor units; no float; relationships/signs exact) | phase5 #3, coverage (Odoo), layer1 `toMinorUnits` | PASS |
| Role-aware unexpected-balance signal (contra-asset/drawings normal sides) | coverage (A), layer3 | PASS |
| "Unexpected balance" is a SIGNAL, not an "incorrect mapping" verdict | coverage (A), (A≠B) | PASS (separated tests; no overclaim) |
| Balanced + mis-mapped + normal signs ⇒ **undetectable** (honest limit) | coverage (B, undetectable) | PASS (asserts non-detection) |
| Establish essential accounting context | INTERFACE §2; readiness/evidence tests | design + 4/… evidence checks |
| Propose GROUPED treatments (no Accept-all) | phase5 #1 | PASS |
| Expose consequential uncertainty | phase5 #1 (suspense/contra), coverage (abnormal sign) | PASS |
| Obtain explicit authorised acceptance | phase5 #1, #7; real_contract_static #4/#5 | PASS (expansion compat) |
| Reuse compatible approved decisions | phase5 #5; coverage (compatible repeat) | PASS |
| Reopen on meaning/identity change | phase5 #6; coverage (chart re-code, identity drift) | PASS (identity/code); **STALE_MEANING = GAP** |
| Different codes / similar descriptions ≠ duplicate | phase5 #2 | PASS |
| Opening/addition/transfer/depreciation relationships, never netted | phase5 #3; coverage (MUSE) | PASS |
| Missing comparative/GL blocks OUTPUT not review | phase5 #4; coverage (conflicting) | PASS |
| Balanced-but-wrongly-mapped (abnormal sign) | coverage (A) | PASS (unexpected-balance signal → individual review) |
| Balanced-but-wrongly-mapped (normal sign) | coverage (B, undetectable) | PASS (documented as undetectable — not a false green) |
| Genuine imbalance | coverage | PASS (deferred to production ingestion) |
| Compatible repeat vs incompatible reuse | phase5 #5, coverage | PASS |
| Cross-tenant / stale / concurrent / retry / partial-failure / duplicate | manual.test (prototype), real_contract_static #8 (codes), proof (execution) | prototype PASS; static PASS; execution REPLAYABLE |
| Real-function compatibility (success + refusal) | real_contract_static (static); proof (execution) | static 17/17; execution REPLAYABLE |
| Uncertain accounts NOT auto-grouped by inferred equivalence | manual.test, phase5 #1 | PASS |
| Visual-by-issue organisation implies no treatment/approval | manual.test | PASS (`impliesTreatment:false`) |
| Deliberate multi-select → shown preview → atomic submit | manual.test, proof (manual) | prototype PASS; execution REPLAYABLE |
| Batch atomicity (all-or-nothing; no partial/blanket success) | manual.test (mixed), proof (manual mixed) | prototype PASS; execution REPLAYABLE |
| Conflicting concurrent decisions (serialized; last-writer-wins) | manual.test, proof (conflict) | prototype PASS; execution REPLAYABLE |
| Reuse > file-hash; three-state rule (compatible/unverified-reopen/incompatible); no silent inherit | manual.test (reuse-context) | PASS |
| Same-name/different-code accounts (uq_acct_map_company_norm_name; raw error) | real_contract_static (finding), proof (fnd) | FINDING preserved; treatment proposed in HANDOFF |
| Advisory sign WARNING vs blocking mapping ERROR | manual.test | PASS (distinct) |
| Prepayment three-component bridge (arithmetic ≠ net authority) | accounting_boundaries | PASS |
| Two TBs → net movement only (no additions/splits) | accounting_boundaries | PASS |
| Source imbalance survives balanced adjustment; no invented entry | accounting_boundaries | PASS (refs `close_review_adjustments`) |
| Signed prior figure ≠ comparative; source precision preserved | accounting_boundaries | PASS |
| Corrected source = linked immutable version; outputs re-evaluated | accounting_boundaries | PASS (refs revalidation model) |
| MUSE observations = scoped, evidenced, proposed candidate rules (not global) | accounting_boundaries | PASS |
| Approval ≠ reuse; context compatibility required | manual.test (reuse), accounting_boundaries (MUSE) | PASS |

## Remaining gaps (precise; see INTERFACE §9)
1. **Reuse status for classification decisions** (`REUSABLE/NEW/STALE_IDENTITY`) — new READ logic, **no new table**; generalises the existing `MARK_NON_REPORTING` identity-drift reopen.
2. **`STALE_MEANING` beyond identity/chart-code** — **no production mechanism**; **excluded** from the first slice; a future, separately-scoped signal.
3. **Output version-binding** — bind a completed TB review summary to the exact `reviewInputVersion` + decision `sequence_no`s. **Minimum compatible change: a `close_review_events` row** (new `event_type`), reusing the existing append-only timeline — **no new table**.
4. **Reuse context beyond entity + account_key.** Live `account_mappings` keys only `(company_id, account_key)`, and the write RPC does not compare context — so reuse *through the RPC* is entity + account_key today. **Correction (verified):** currency and period are **not** a schema gap — they are authoritative on `fiscal_periods` (`reporting_currency` FK + explicit dates), reached from an upload via `trial_balance_uploads.period_id`, so a Phase 6 reuse check can **read** them. The genuine remaining gaps are narrower: (a) **binding** the accepting context onto the **decision ledger** (`account_review_decisions` already stores `previous_value`/`new_value` JSON — add context there, or an additive column) so reuse can compare it; (b) a **dimension** axis; (c) a **ruleset-version** axis. The prototype discloses every unverified field (UNKNOWN ≠ EQUAL); no silent assumption. **Not** in the first slice (single-entity, single-currency).

## Proposed Phase 6 production files + owners (for NORMAL to agree; NOT implemented now)
| File / area | What | Proposed owner |
|---|---|---|
| `src/lib/accounting/interpretation/*` (new, pure) | 5 layers + grouping + reuse classification + evidence sufficiency (ports of `research/phase5/prototype/*`) | Phase 6 impl (accounting-interpretation); NORMAL reviews contract |
| `src/lib/accounting/interpretation/manual.ts` (new, pure) | organise-by-issue + preview + atomic common-treatment expansion (port of `manual.mjs`) | Phase 6 impl; **NORMAL owns the selection/approval UX** |
| `supabase/functions/tb-review-summary/*` **or** a SECURITY DEFINER read RPC (new, read-only) | renders groups/individual/relationships/reuse/coverage/readiness; **no write authority** | Phase 6 impl; NORMAL owns placement in the journey |
| `src/components/*ReviewSummary*`, `*ManualAssign*` (new) | grouped-acceptance + deliberate multi-select UI, preview-before-submit, per-account outcomes; **no Accept-all** | **NORMAL** (customer journey) |
| Writes | **unchanged `resolve_account_review_batch`** — group **and** manual acceptance both expand to its atomic batch | existing authority (do not modify) |
| Tests | the static + prototype + manual suites ported to CI; the replayable PG17 proof promoted to a CI job | Phase 6 impl |

## Coordination / DB requirements for the replayable proof (priority 1 — verify with NORMAL; never run on hosted)
**SEAT_LIMIT_REACHED fix:** NORMAL's earlier run stopped during fixture setup at `SEAT_LIMIT_REACHED` (PG16). Cause: the
named-user seat wall (`trg_firm_members_named_user_seats`) with `included_seats = 1` on every paid plan — seeding a partner +
viewer exceeded one seat. **Fixed** by provisioning seats through the **supported authority** — a `NAMED_USER_SEATS`
entitlement override (the `ADMIN_OVERRIDE` path in `_seat_capacity_for_account`) **before** any extra member is inserted. No
trigger is bypassed. The proof now also **queries and prints the actual `server_version`** — no PostgreSQL version is
hard-coded as an executed result (it runs on PG16+/17; NORMAL's isolated run is PG17).

**Corrected invocation (unchanged command; loopback only; refuses the production ref):**
`DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/phase5_proof node research/phase5/proof/real_contract_proof.mjs`
(requires the `pg` devDependency installed and a throwaway PostgreSQL). **Head to run: `b56f504` (branch tip below).**

`proof/real_contract_proof.mjs` replays `scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql` then **every**
`supabase/migrations/*.sql` in filename order on a disposable PostgreSQL, then drives the real RPC. It refuses the
production project ref and any non-loopback host. The authoritative chain it depends on (verify these exist/apply cleanly):
`extensions.digest` (pgcrypto); the `financial_statement` + `account_classification` enums; `trial_balance_uploads`
(`source_file_hash`, `processing_result`); `account_mappings` (GENERATED `account_key` + UNIQUE `(company_id, account_key)`,
`20260703120000`); `account_review_batches` + `account_review_decisions` (`20260816120000`); `account_mapping_content` +
`treatment_request_id` + the latest `resolve_account_review_batch` (`20261006100000`, `20261007100000`); the
membership/capability + **seat** chain (`firm_members` + `trg_firm_members_named_user_seats`, `named_user_access_active`,
`workspace_capability_allowed`, `_seat_capacity_for_account`, `entitlement_overrides`, and the
`commercial_products/plans/licences/billing_customers` seed for `prepare_close` — the proof provisions the
`NAMED_USER_SEATS` override itself before seeding members). **Run it on a throwaway loopback PostgreSQL only**, coordinated
through this branch; it is Tier 4 enforcement, delivered replayable because this host has no PG.

## Dependencies & compatibility
- Prototype/tests: **Node standard library only** (no package, no lockfile change); the real-layout proof needs Node ≥ 22.18 type-stripping. Replayable RPC proof: `pg` (already `pg@8.23.1` devDependency) + a loopback PostgreSQL (16+/17).
- Compatibility: both the grouped and the manual per-account decisions use only fields the real RPC consumes, a non-forbidden `proposal_type`, an accepted `decision_action` (`USER_ACCEPTED_SUGGESTION` / `USER_MANUAL_CLASSIFICATION`), supported statement/class pairings, tri-state flags, and are deterministic (replay-safe). Verified statically (17/17); execution proof replayable.

## Acceptance tests (for Phase 6, to be run in a PG-capable CI)
`proof/real_contract_proof.mjs` (success + refusal + lifecycle + **manual path + atomic mixed-batch + conflicting-decision
serialization** against the real RPC on a disposable PostgreSQL) is the acceptance harness. It must pass on the authoritative
chain before any production wiring. The static + prototype + coverage + manual + accounting-boundary suites run in plain Node
and gate the pure logic.

## Schema / API changes (justified, not assumed)
- **None required for the first slice's writes** — `resolve_account_review_batch` unchanged; group **and** manual acceptance both expand to its existing atomic batch; reuse is native (company-scoped `account_mappings`).
- **One additive, reviewed change if output-binding is wanted now:** a new `close_review_events.event_type = 'tb_review_summarised'` (append-only timeline; **no new table, no new authority**). Justified by requirement #3. If deferred, summaries are recomputed from the ledger at `sequence_no ≤ N`.
- **Reuse-context binding (gap #4), only when multi-currency/dimension reuse is in scope (NOT the first slice):** record the accepting context on `account_review_decisions` (additive JSON/column) and compare on reuse. Additive, no change to the write path's authority.
- A read-only summary RPC/edge (additive; no write authority). Everything else is pure library + UI.

## First proposed Phase 6 slice (single-entity, no statement engine, no withheld modules)
Synthetic **annual single-entity TB** → **grouped review** (proposals with visible exceptions; uncertain accounts individual /
deliberately multi-selectable, never auto-grouped) → **authorised acceptance** (group expansion **and** manual common-treatment,
both atomic through the unchanged RPC) → **versioned per-account decisions** (`account_review_decisions` append-only,
`sequence_no` latest-wins) → **traceable TB review summary** (read-only projection) → **repeat upload** demonstrating
compatible reuse and changed-account reopen (identity drift today; context/meaning reopen per gaps #2/#4). **Ends at the
review summary + repeat upload** — no financial-statement engine, no withheld-module activation.

**First-slice REUSE RULE (three explicit states — never a silent inherit; UNKNOWN ≠ EQUAL ≠ MISMATCH ≠ NOT APPLICABLE):**
- **Verified compatible accepting context** (entity + currency + any dimensions, confirmed equal — currency/period read from
  `fiscal_periods`, or a field explicitly declared NOT APPLICABLE): reuse **may be proposed** (a reviewer-visible proposal,
  not an auto-apply).
- **UNKNOWN context ⇒ reopen for explicit confirmation** (`CONTEXT_UNVERIFIED`): a field present on one side only, **absent
  on both sides with no authoritative N/A rule**, or no recorded context. Missing relevant context requires renewed
  confirmation before reuse.
- **Known change ⇒ reopen** (`CONTEXT_INCOMPATIBLE`): a field present on both sides and differing (e.g. a changed currency).
- **Applicability comes from the GOVERNED, VERSIONED CONTRACT — not arbitrary caller declarations that bypass reuse
  checks.** `notApplicableContextFields` represents that contract (e.g. a non-dimensional single-entity engagement where
  `dimensions` is contractually N/A); it is **not** a free input a caller can set to skip a check. `currency`/`entity` are
  never declarable N/A (`reporting_currency` is required). A **missing *relevant* field still reopens for confirmation**
  regardless of caller input. A treatment is **never silently inherited from `company_id + account_key` alone.** Implemented
  in `reuseContext.contextCompatible` (+ `notApplicableContextFields`) and `classifyAgainstPrior`; proven in `manual.test`
  (incl. a case where, WITHOUT the contract's N/A declaration, absent dimensions/ruleset reopen).

## Future reporting compatibility — DESIGN ONLY (no schema, no rendering, no XBRL change)
Inspected existing mechanisms first: `account_mappings` (`account_key`, `statement`/`classification`/`line_item`/
`normal_balance`, `review_decision_id`), the XBRL layer (`20260711500000_xbrl_layer.sql`, concept seed
`20260711500100`), and `generate-xbrl` (framework-conditional: IFRS variants supported, IPSAS blocked; `TAXONOMY_VERSION =
"2023-01-01"`). These already separate the concerns below — the design keeps them separate and adds nothing.

**Four distinct layers (do not collapse):**
1. **Source identity** — what the account *is* in the client's books: `account_key = COALESCE(account_code, normalized
   name)` + its review-decision lineage. **Stable and internal.**
2. **Confirmed accounting treatment** — the reviewer-approved `statement`/`classification`/`normal_balance` (+ tri-state
   flags). Internal; independent of any external framework or taxonomy.
3. **Framework-specific presentation** — how a treatment is *presented* under a chosen framework (e.g. IFRS-for-SMEs vs full
   IFRS line items). **Many-to-one and one-to-many are both allowed:** several accounts may roll up to one presentation
   line, and **one account may map to different presentation categories under different frameworks** (or be split across
   lines). Do **not** assume one account always has exactly one presentation category.
4. **Optional taxonomy references** — external concept IDs (e.g. an IFRS XBRL concept at a taxonomy *version*). An **optional
   overlay**, keyed by framework + taxonomy version; **swapping the taxonomy version must never change layers 1–3.**

**Invariant:** internal identities (layers 1–2) are **independent of external taxonomy versions** (layer 4). A new taxonomy
release re-points layer-4 references only; the source identity and confirmed treatment, and any completed review summary
bound to them, are unchanged.

**Example A — straightforward (one presentation, one concept):** `account_key "1000" "Cash at bank"` → treatment
`balance_sheet / current_assets` (`is_cash_account=true`) → presentation line "Cash and cash equivalents" under IFRS-for-SMEs
→ taxonomy concept `ifrs-full:CashAndCashEquivalents@2023-01-01`. One account, one presentation, one concept; a 2024 taxonomy
would change only the concept reference.

**Example B — requires additional evidence (presentation not determinable from the treatment alone):** `account_key "2500"
"Bank loan"` → treatment `balance_sheet / … liabilities`. Its **presentation split between current and non-current** depends
on the repayment schedule (the portion due within 12 months) — **evidence that is not in the trial balance**. Until that
evidence is supplied and reconciled, the presentation is a **gap** (`KNOWN/MISSING/CANNOT_ASSESS`), never guessed; the
internal treatment is settled, but the framework presentation stays unresolved. This is the honest "a TB may not be enough"
case at the presentation layer, mirroring the evidence discipline in §4/§5.

## Ownership — response to the proposed production-file ownership (task 5)
**Agreement:** the Phase 6 file/owner split proposed above stands — **NORMAL owns the customer-journey & UI surfaces**
(`*ReviewSummary*`, `*ManualAssign*`, placement in the journey) and the **canonical accepted contract**; the **Phase 5
research lane owns the pure-library ports** (`src/lib/accounting/interpretation/*`, incl. `manual.ts`, `reuseContext`,
`boundaries`) and the **contract/acceptance tests**; **writes stay on the unchanged `resolve_account_review_batch`** (group
and manual acceptance both expand to its atomic batch). No objection; this is a proposal pending owner scope approval, not a
claim of ownership.
**Amendments (minor):** (1) the **read-only review-summary projection** (edge or SECURITY DEFINER read RPC) should be
**co-owned** — NORMAL owns its placement/shape in the journey, the research lane owns the pure projection logic it renders;
(2) the reuse-context + `notApplicableContextFields` authority is a **shared contract decision**: applicability is derived
from the **governed, versioned contract — not arbitrary caller declarations that bypass reuse checks**. Which fields an
engagement may declare NOT APPLICABLE is fixed in that contract with NORMAL before Phase 6 build; a missing *relevant* field
still **reopens for confirmation** regardless of any caller input.
**Dependency to support legitimate same-name/different-code accounts safely (explicit):** the partial unique index
`uq_acct_map_company_norm_name` (`20260703100000`, reinforced by `20260703120000`) is the blocker. **Source names/codes are
preserved — renaming the source is never the permanent fix; disambiguation is an optional display label separate from source
identity.** Handling: (a) **preparer disambiguation** = a **temporary workaround** (display label only, no schema change);
(b) a **structured pre-flight refusal** `SAME_NORMALIZED_NAME_DIFFERENT_CODE` = **improved failure handling, not
compatibility** (the research lane can provide the pure validator); (c) the **coordinated constraint-and-lookup repair** =
the **proposed support path, owned by NORMAL** under the existing bounded repair instruction. **This handoff does not
prescribe replacing the index with `account_key` alone** — NORMAL verifies all uniqueness, lookup and migration dependencies
and chooses the mechanism. (c) is **not** a research-lane change.

## Scope cleanliness
`git diff origin/main` is **entirely under `research/phase5/`** (verified). No production component, migration, registry,
lockfile, entitlement, payment or deployment file is touched.

## Owner-access recap (explained; NOT modified)
`origin/main` @ `00a2653` already contains the merged **platform-owner / entity-allowance** workstream (migration
`20261104100000_platform_owner_access_and_entity_allowance.sql`, the `reauthenticate` edge function) from earlier PRs
(#130 / #131). My Phase 5 branch is **based on that main**, so those commits appear in its baseline/ancestry — but my diff adds
**nothing** to them and I have **not modified** that separate workstream.

## Coordination
NORMAL owns the customer journey, final integration and the canonical accepted contract, and reviews compatibility + agrees
file ownership at its next natural checkpoint; the concrete Phase 6 scope then goes to the owner for approval. **Technical
agreement is not deployment permission.** No merge, deployment, hosted migration, permission/payment-state/feature-gate change
is authorised. Read `docs/HANDOFF-core.md` (or its equivalent) when available and reconcile INTERFACE-PROPOSAL before Phase 6.
