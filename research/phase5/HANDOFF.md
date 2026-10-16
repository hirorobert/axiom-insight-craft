# Phase 5 — Handoff

## Branch & worktree
- Branch: `research/phase5-accounting-interpretation-20261016` (off `origin/main` @ `00a2653`).
- Worktree: `D:/DevStorage/Temp/claude/cfoclose-phase5-20261016` (isolated; all other worktrees/branches preserved).
- Push capability: **available** (verified non-destructively by `git push --dry-run`). Scope written: `research/phase5/**` only.

## Implementation commit (preceding this handoff)
- **`4ec6cf1`** — "research(phase5): accounting-interpretation prototype + synthetic proofs + interface/decision".
  Contains `research/phase5/prototype/*`, `research/phase5/tests/phase5.test.mjs`, `INTERFACE-PROPOSAL.md`, `DECISION.md`,
  `README.md`. (This HANDOFF is a separate, later commit so no commit embeds its own hash.)

## Tests
```
node research/phase5/tests/phase5.test.mjs
```
→ **29/29 checks passed**. Proves: grouped mapping review (no Accept-all); different codes/similar descriptions not
auto-duplicated; opening/addition/transfer/depreciation relationships surfaced, never netted; missing comparative/GL evidence
blocks the OUTPUT not the review; compatible repeat-upload reuse; changed-meaning/identity invalidation & reopen; cross-tenant
and stale-decision refusal (where executable in pure logic — DB/RLS-dependent refusals are labelled and deferred to the
production RPCs). All data invented; no model called; `cfoclose_tb_fixtures.zip` not used.

## Dependencies
- **None beyond the Node standard library** (`node:crypto` only). No new package, no lockfile change, no network, no model,
  no provider call, no budget consumed.

## Provisional assumptions (HANDOFF-core.md not present at research time)
1. `account_mappings` stays company-scoped with `account_key = COALESCE(code, normalized name)`; no new identity axis.
2. `resolve_account_review_batch` remains the sole per-account mapping authority; grouping is a projection/expansion on top.
3. Reuse keys on `account_key` + an identity basis digest; latest `sequence_no` wins (as today).
4. AI stays disabled behind the existing `ai_*` gates; meaning-suggestion AI is out of scope and needs its own consent/
   data-handling/budget decision (because it needs account names, which `ai-sample/1` withholds).
These are isolated in the prototype's adapters; if NORMAL's canonical contract differs, only the adapters change.

## Coordination with NORMAL
- NORMAL owns the customer journey, final integration and the **canonical accepted contract**. This proposal's shapes reuse
  production contracts so Phase 6 **contract tests can demonstrate compatibility** (expanded per-account decisions must be
  byte-compatible with the existing `resolve_account_review_batch` payload).
- Read `docs/HANDOFF-core.md` (or its identified equivalent) when available and reconcile §INTERFACE-PROPOSAL before Phase 6.
- Do not duplicate or interrupt NORMAL's in-flight work.

## Proposed Phase 6 production scope (for explicit approval BEFORE any production change)
Smallest defensible slice — **deterministic grouped TB review + controlled reuse**, no AI, no new DB:
1. Pure functions (new files under a to-be-agreed `src/lib/accounting/...` path): 5-layer interpretation, grouped treatment
   proposal, reuse classification (`REUSABLE/NEW/STALE_IDENTITY/STALE_MEANING`), evidence-sufficiency per output.
2. One read-only review-summary projection (edge or RPC) that renders groups + individual accounts + relationships + reuse +
   coverage + readiness — reusing `resolve_account_review_batch` unchanged for writes (group acceptance expands to its batch).
3. A contract test proving the expansion is compatible with the existing RPC, plus the 7 synthetic scenarios ported to CI.
4. **Ends at a traceable TB review summary + a repeat upload.** NOT a statement engine; financial-statement generation and the
   withheld modules (Tax/Compliance/Filing/Monitor) remain excluded. No migration, entitlement, payment-state, feature-gate,
   registry, lockfile or deployment change.
**Exact production-file ownership and the concrete scope must be agreed with NORMAL and approved before Phase 6 begins.**

## Replayable handoff
Everything is committed on this branch and pushed (draft PR if repository authority allows). To reproduce from scratch:
`git checkout research/phase5-accounting-interpretation-20261016 && node research/phase5/tests/phase5.test.mjs`.
