# Phase 5 — Handoff

## Branch & commits
- Branch: `research/phase5-accounting-interpretation-20261016` (off `origin/main` @ `00a2653`). Draft **PR #138**.
- Worktree: `D:/DevStorage/Temp/claude/cfoclose-phase5-20261016`. Push: available (verified non-destructively).
- **Implementation commits (preceding this handoff):** `4ec6cf1` (prototype + original proofs + INTERFACE/DECISION),
  `b40097a` (real-contract static check, replayable PG17 proof, extended coverage, income rules) and
  **`cfa42e2`** (exact-money BigInt, role-aware unexpected-balance *signal* vs mapping-verdict separation, the `OVERDRAFT`
  and `WRONGLY_MAPPED_NORMAL_SIGN` cases, the executed real-layout contract proof, and the `run_all.mjs` recorder).
  (This HANDOFF is a separate, later commit — no commit embeds its own hash.)

## Prototype vs real-contract evidence
| Evidence | What it proves | Status |
|---|---|---|
| `tests/phase5.test.mjs` | deterministic 5-layer prototype + lifecycle (the 7 North-Star behaviours); exact BigInt minor units | **EXECUTED 29/29** |
| `tests/coverage.test.mjs` | vendor-style patterns + edge cases; "unexpected balance" vs "incorrect mapping" separated; disclosed LIMITs | **EXECUTED 21/21** |
| `tests/real_contract_static.mjs` | the grouped-acceptance expansion is field+semantics compatible with the **real** `resolve_account_review_batch` (parsed from the isolated runtime's migration SQL) | **EXECUTED 14/14** (static — necessary, not sufficient) |
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
| Cross-tenant / stale / concurrent / retry / partial-failure / duplicate | real_contract_static #8 (codes); proof (execution) | static PASS; execution REPLAYABLE |
| Real-function compatibility (success + refusal) | real_contract_static (static); proof (execution) | static 14/14; execution REPLAYABLE |

## Remaining gaps (precise; see INTERFACE §9)
1. **Reuse status for classification decisions** (`REUSABLE/NEW/STALE_IDENTITY`) — new READ logic, **no new table**; generalises the existing `MARK_NON_REPORTING` identity-drift reopen.
2. **`STALE_MEANING` beyond identity/chart-code** — **no production mechanism**; **excluded** from the first slice; a future, separately-scoped signal.
3. **Output version-binding** — bind a completed TB review summary to the exact `reviewInputVersion` + decision `sequence_no`s. **Minimum compatible change: a `close_review_events` row** (new `event_type`), reusing the existing append-only timeline — **no new table**.

## Proposed Phase 6 production files (for NORMAL to agree ownership; NOT implemented now)
- `src/lib/accounting/interpretation/*` (new, pure): the 5 layers + grouping + reuse classification + evidence sufficiency (ports of `research/phase5/prototype/*`).
- A **read-only** review-summary projection: either an edge function `supabase/functions/tb-review-summary/*` or a SECURITY DEFINER read RPC — renders groups/individual/relationships/reuse/coverage/readiness. **Writes stay on the unchanged `resolve_account_review_batch`** (group acceptance expands to its batch).
- `src/components/*ReviewSummary*` (new): grouped-acceptance UI (no Accept-all).
- Tests: contract test proving the expansion is byte-compatible with the real RPC; the 7 scenarios + coverage ported to CI; the replayable PG17 proof promoted to a CI job.

## Dependencies & compatibility
- Prototype/tests: **Node standard library only** (no package, no lockfile change). Replayable proof: `pg` (already `pg@8.23.1` devDependency) + a loopback PG17.
- Compatibility: the expanded per-account decisions use only fields the real RPC consumes, a non-forbidden `proposal_type`, an accepted `decision_action`, supported statement/class pairings, tri-state flags, and are deterministic (replay-safe). Verified statically (14/14); execution proof replayable.

## Acceptance tests (for Phase 6, to be run in a PG-capable CI)
`proof/real_contract_proof.mjs` (success + refusal + lifecycle against the real RPC on disposable PG17) is the acceptance
harness. It must pass on the authoritative chain before any production wiring. The static + prototype + coverage suites run in
plain Node and gate the pure logic.

## Schema / API changes (justified, not assumed)
- **None required for the first slice's writes** — `resolve_account_review_batch` unchanged; reuse is native (company-scoped `account_mappings`).
- **One additive, reviewed change if output-binding is wanted now:** a new `close_review_events.event_type = 'tb_review_summarised'` (append-only timeline; **no new table, no new authority**). Justified by requirement #3 (a completed summary must bind its exact versions). If deferred, summaries are recomputed from the ledger at `sequence_no ≤ N` instead.
- A read-only summary RPC/edge (additive; no write authority). Everything else is pure library + UI.

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
