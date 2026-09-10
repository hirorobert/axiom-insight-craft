# Ω3-CHECKOUT — Phase Brief

**Status: DESIGN / AUDIT ONLY. NO IMPLEMENTATION PERFORMED.**

- Repository: `hirorobert/axiom-insight-craft`
- Main at mission start: `d75f92f7e0ca06b1d7c38de0fb45d41079336166`
- Code baseline actually audited: `6ac832b03371329faa8a6738771b5523e9ef15bf` (identical commercial-relevant source to `d75f92f7`; the only diff between the two is the addition of the non-authoritative `.lovable/plan.md` file — see "Correcting the Lovable plan" below)
- Product: CFOClose (cfoclose.com)
- Target public commercial economics: USD 49/month, USD 499/year (Professional plan)
- Author role for this pass: Engineering Designer / audit preparer — **not** the final auditor. This package exists so an independent Codex reviewer can attack the design before any line of implementation code is written.

## 0. Infrastructure constraints in force for this pass

- Lovable credits are exhausted — this pass does not depend on, or publish through, Lovable.
- No production changes were made. No Supabase access occurred. No migration was written or applied. No commercial offer was created. No payment code was modified.
- Work product is Git/GitHub-only: six documents under `docs/operations/cfoclose-omega3-checkout/`, no source diffs.

## 1. What this package is

Six documents, each scoped to one part of the required audit:

| Document | Covers mission steps |
|---|---|
| `PHASE_BRIEF.md` (this file) | Scope, constraints, plan.md correction |
| `COMMERCIAL_ARCHITECTURE_AUDIT.md` | Steps 1, 3, 4, 5, 7, 9 — system inventory, 16-requirement proof (A–P), resolver contract critique, offer-uniqueness audit, payment-authority-chain trace, RLS/security audit |
| `DATA_CONTRACTS.md` | Exact current and proposed schema/RPC/Edge-Function contracts |
| `THREAT_AND_FAILURE_MODEL.md` | Steps 6, 8 — concurrency scenarios, failure-state classification |
| `ACCEPTANCE_MATRIX.md` | Steps 12, 13 — staging and browser acceptance tests |
| `IMPLEMENTATION_PLAN.md` | Steps 10, 11, 14 — file-level MUST/MAY/MUST NOT CHANGE slices, migration safety, rollback |

## 2. Correcting the Lovable-generated plan

`.lovable/plan.md` (present on `main` at `d75f92f7` via two Lovable-bot commits, `75ebf4f`/`d75f92f`, layered on top of this session's own `6ac832b` brand commit) is **not proof of independent review** — this was true before this pass started and remains true after it. Its 7 numbered findings were independently re-verified against the actual source in this pass; findings 1–4 and 6 are accurate. Two corrections matter enough to drive the implementation plan:

1. **Finding 5 and the "minimum safe correction" both understate how much schema-level safety work is already shipped.** Plan.md proposes, as new work, "a partial unique index preventing two purchasable, currently-effective offers for the same plan+market+interval." This is **already done** — migration `20260906120000_omega3_0_effective_history_and_platform_state.sql` (Ω3.0), which post-dates the commit plan.md was generated against, already dropped and rebuilt `uq_co_current_offer` as a 5-column key `(plan_id, market_code, currency_code, billing_interval, billing_interval_count)`, plus a parallel GiST exclusion constraint (`excl_co_no_overlapping_purchasable_periods`) covering historical non-overlap on the same 5 columns. See `COMMERCIAL_ARCHITECTURE_AUDIT.md` §5 for the full proof. **No new offer-uniqueness migration is needed.**
2. **Finding 7's "cheap, additive constraints" framing undersells the genuine analysis required.** A guard against concurrent CREATED/PENDING checkout intents is real, still-open work, but it is not "cheap and additive" in isolation — it interacts with retry semantics, abandoned-checkout recovery, and the existing `saff_reference` UNIQUE constraint. See `THREAT_AND_FAILURE_MODEL.md` §Concurrency and `IMPLEMENTATION_PLAN.md` §2 for the actual recommendation (reuse-existing-open-intent, not a hard unique index that would 409 a legitimate retry).

Plan.md's proposal to add an *optional* `p_billing_interval` parameter to `resolve_commercial_offer` is explicitly **not accepted as-is** — see `COMMERCIAL_ARCHITECTURE_AUDIT.md` §4 for the independent analysis and the recommended contract (a required parameter plus a separate, explicitly-named read-only listing function).

## 3. Explicit non-goals (Ω4/other scope this pass does not touch)

Per the mission's own guardrail: do not broaden into Ω4-WORKSPACE, do not redesign the workspace, the marketing site, or Pricing.tsx beyond what checkout requires, and do not introduce a new market architecture (the existing `GLOBAL/TZ/MU/GB/EU` vocabulary is not objectively insufficient for USD dual pricing — see audit §3, requirement C). This package proposes zero changes to `stageMetadata.ts`, the 7-stage workspace lifecycle, SAFISHA/HESABU/KINGA/MAONO, or any accounting-authority table.

## 4. Stop condition

This phase produces documents only. It does not:
- create authoritative USD offers,
- modify payment code, migrations, Edge Functions, or the frontend,
- touch production or Supabase,
- publish through Lovable,
- claim Ω3-CHECKOUT is approved for implementation.

Approval to proceed to implementation is a decision for the independent Codex auditor and the user, not for this pass.
