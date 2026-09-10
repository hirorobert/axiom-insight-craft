# Ω3-CHECKOUT — Implementation Plan

Design document only. Nothing below has been applied. Every file is marked MUST CHANGE / MAY CHANGE / MUST NOT CHANGE for a future, separate implementation pass — subject to the independent Codex audit this package exists to enable.

## 1. File-level slices

### MUST CHANGE

| File | Change |
|---|---|
| `supabase/migrations/<new timestamp>_omega3_checkout_resolver_interval.sql` (new file) | `CREATE OR REPLACE FUNCTION resolve_commercial_offer(p_plan_code, p_market_code DEFAULT 'GLOBAL', p_billing_interval TEXT)` — interval required, filters by it; `CREATE FUNCTION list_purchasable_commercial_offers(...)` (new, read-only, no discriminant) — see `DATA_CONTRACTS.md` §1 |
| `supabase/functions/commercial-create-checkout/index.ts` | Accept `billingInterval` (required) in the request body; validate before calling the resolver; thread it into the `resolve_commercial_offer` RPC call; add the checkout-intent reuse-check (`DATA_CONTRACTS.md` §6) before inserting a new intent |
| `supabase/functions/_shared/payments/providers/flutterwave.ts:147-155` | Replace stale branding in `createCheckout`'s `customizations`/`meta` block: `title: 'SAFF ERP'` → the CFOClose brand name (reuse `BRAND.name`-equivalent server-side constant, not a re-typed literal), `logo: 'https://cfoclose.com/favicon.ico'` → a real, live, raster-format CFOClose logo URL (the current `favicon.svg` is not usable here — Flutterwave's `customizations.logo` conventionally expects a raster image; a PNG export of the CFOClose mark is a prerequisite, tracked as a **BLOCKER dependency**, not solved by this design pass), `meta.source: 'SAFF_ERP_OMEGA2'` → a CFOClose-namespaced value (e.g. `'CFOCLOSE_OMEGA3'`). This is presentation-only — no pricing/verification/security logic changes. |
| `src/lib/commercial/commercialRpc.ts` | `createCheckoutIntent(planCode, billingInterval, marketCode?)` — new required second parameter; request body gains `billingInterval` |
| `src/components/commercial/CheckoutUpgradeButton.tsx` | New required `billingInterval` prop; thread it into both the display `resolve_commercial_offer` call and the `createCheckoutIntent` call, exactly mirroring the existing `marketCode` propagation pattern |
| `src/pages/Pricing.tsx` | Remove the "checkout disabled" lock panel; wire the existing `interval` state (`"monthly"|"annual"`, already present) into a real `CheckoutUpgradeButton` (mapped to the uppercase `MONTHLY`/`ANNUAL` server vocabulary) instead of the static locked panel. **Scope discipline:** this is a wiring change only — no redesign of the page's layout, copy, or feature lists (Step 10's explicit "do not redesign Pricing beyond what checkout requires") |
| Test files: new/updated unit tests for the resolver-interval change, the reuse-check, the Flutterwave branding fix, and a `DISPLAY_INTERVAL == CHECKOUT_INTERVAL` static guard mirroring `marketPropagation.test.ts` | Follow the established static-source-text regression-guard convention (`fs.readFileSync` against the real migration/Edge Function/component files) — never a parallel hand-rolled type/mock module (see the shadow-test finding, `COMMERCIAL_ARCHITECTURE_AUDIT.md` §1.5) |

### CONTROLLED DATA-SEED OPERATION (not a schema migration — see §3)

| Action | Detail |
|---|---|
| Create two authoritative USD offers | Via `admin_upsert_commercial_offer('CFOCLOSE-PAID-GLOBAL-USD-MONTHLY', 'PAID', 'GLOBAL', 'USD', 4900, 2, 'MONTHLY', 1, true, true, '<reason>')` and the ANNUAL equivalent (49900) — an admin RPC call against staging/production, not a `CREATE TABLE`/`ALTER TABLE` statement |

### MAY CHANGE

| File | Reason |
|---|---|
| `src/lib/commercial/payments/{paymentTypes.ts,paymentAuthority.ts}` and their 4 test files | Either delete (their real intent — documenting Iron Dome invariants — survives fine as a comment) or repoint at the real `_shared/payments/*` modules. Not required to ship Ω3-CHECKOUT; flagged so it is not mistaken for coverage in the meantime. |
| `src/constants/copy.ts` (`PRICING` block) | Only if the parity mechanism in §5 below is chosen to live here (e.g. a comment-adjacent constant that a build check reads) — no change to the *displayed* 49/499 values themselves |

### MUST NOT CHANGE

- `supabase/functions/commercial-payment-webhook/index.ts` — the two-gate verification flow, replay handling, and receipt/processing-event model are correct and out of scope; Ω3-CHECKOUT does not touch webhook logic at all.
- `supabase/functions/_shared/payments/authority.ts` (`authoriseCommit`) — unchanged; it already validates against whatever the intent snapshot says, interval included implicitly via the snapshot.
- `supabase/functions/_shared/payments/money.ts`, `contracts.ts`, `routing.ts` — no change; USD (exponent 2) is already a supported currency and Flutterwave already supports it.
- `commit_verified_commercial_payment`, `record_payment_reversal`, `get_checkout_status`, `admin_get_billing_detail` — no change; these operate on the intent's own snapshot, which already carries `billing_interval` correctly once set at creation.
- `commercial_licences`, `entitlement_overrides`, `_resolve_entitlement_for_owner`, `get_effective_entitlement` — no change; entitlement is plan-scoped, not interval-scoped, and plan membership is unaffected by this design.
- Any RLS policy — no change; the new `list_purchasable_commercial_offers` function reuses the existing `anon, authenticated` grant pattern already established for `resolve_commercial_offer`.
- `commercial_offers` table schema, `uq_co_current_offer`, `excl_co_no_overlapping_purchasable_periods` — no change (audit §5: already sufficient).
- `src/lib/workspace/*`, `stageMetadata.ts`, any SAFISHA/HESABU/KINGA/MAONO code — untouched, out of scope entirely.
- `src/pages/billing/PaymentReturn.tsx` — no change; it already displays whatever `get_checkout_status` returns, which will correctly include interval-aware licence dates with zero changes on its side.

## 2. Concurrency implementation note (ties to `THREAT_AND_FAILURE_MODEL.md`)

The checkout-intent reuse-check is **application-level logic inside the Edge Function**, not a database migration — deliberately, because the correct behavior (hand back the existing open intent) is a business decision about retry UX, not a data-integrity invariant a constraint should enforce. A hard partial unique index was considered and rejected (`DATA_CONTRACTS.md` §6) because it would reject a legitimate double-click/retry with a 409 instead of resolving it gracefully.

## 3. Migration safety

- **Schema migration** (the resolver signature change, `list_purchasable_commercial_offers`): forward-only, no `DROP TABLE`, no destructive alteration of `commercial_offers` or any historical row. `CREATE OR REPLACE FUNCTION` on `resolve_commercial_offer` changes its signature — confirmed safe because there is exactly one caller in the entire repository (`commercial-create-checkout`), updated in the same deployment. Rollback: `CREATE OR REPLACE FUNCTION` back to the two-parameter signature (the old function body is preserved verbatim in git history / this document's quotation in `DATA_CONTRACTS.md` §1) — reversible without any data loss, since no column or row is altered by this migration, only function bodies.
- **Controlled commercial data-seed operation** (the two USD offers): explicitly **not** a schema migration — it is an authenticated admin RPC call (`admin_upsert_commercial_offer`) against a running database, auditable via `commercial_catalog_audit_events`, reversible via `admin_supersede_commercial_offer` (mark `is_purchasable = false`, never a `DELETE`). This distinction matters because Step 11 explicitly requires telling these two kinds of change apart — a migration file changes what the *schema allows*; this operation changes what *data exists* within a schema that already allows it.
- Pre-deployment verification: run the new/updated static-source-text tests (per §1's MUST CHANGE test row) plus the full existing commercial suite (`migrationCollisionGuard.test.ts`, `omega3_0FoundationMigration.test.ts`, `globalCommerceModel.test.ts`, etc.) — none of which should need modification themselves, since none of them assert the *old* two-parameter resolver signature as a requirement (confirmed by re-reading each: they assert resolver *behavior* — AVAILABLE/AMBIGUOUS/fallback semantics — never a fixed arity).
- Post-deployment verification: `ACCEPTANCE_MATRIX.md` in full, against a real staging project (this repository's own isolated staging worktree convention, project-ref-scoped, applies here exactly as it did for Mission A).
- No accidental recreation of existing objects: the new migration file's timestamp sorts after `20260906120000` (Ω3.0); no `CREATE TABLE` statement appears in it at all, only `CREATE OR REPLACE FUNCTION` / `CREATE FUNCTION`.
- No modification of existing production data: the migration touches no rows; the data-seed operation only ever inserts two new rows via the existing controlled RPC, touching no existing offer.
- Frontend economics: `Pricing.tsx`'s `PRICING.MONTHLY_USD`/`ANNUAL_USD` constants remain the **display** source (Step 11 explicitly forbids silently hardcoding commercial economics into frontend code as the *authority* — these constants are not the authority, `commercial_offers` is; the constants exist so the page can render a price without an RPC round-trip before the user has even chosen an interval). §5 below addresses keeping them from drifting apart from the DB-authoritative values.

## 4. Rollback

| Layer | Rollback action |
|---|---|
| Frontend (`Pricing.tsx`, `CheckoutUpgradeButton.tsx`, `commercialRpc.ts`) | Revert the commit(s); `Pricing.tsx`'s lock panel can be restored immediately with zero data implications — checkout was already disabled before this design, so reverting the frontend alone re-disables it cleanly |
| Edge Function (`commercial-create-checkout`) | Revert to the pre-Ω3-CHECKOUT deployed version; the reuse-check and interval requirement are additive request-shape changes, so an old frontend talking to a new function would simply get a 400 (missing `billingInterval`) rather than silently misbehaving — and a reverted function talking to an unreverted frontend would similarly 400 on the extra field only if it validated strictly, which it does not need to (extra JSON fields are ignored), so partial rollback is safe in either direction |
| Flutterwave adapter branding fix | Purely cosmetic; revert is a plain text revert, no data implications |
| RPC (`resolve_commercial_offer`) | `CREATE OR REPLACE FUNCTION` back to the two-parameter version quoted in `DATA_CONTRACTS.md` §1 — reversible, no data loss |
| `list_purchasable_commercial_offers` | `DROP FUNCTION` — safe, nothing else calls it (it is new) |
| Commercial offers (the two new USD rows) | **Never delete.** Mark `is_purchasable = false` via `admin_supersede_commercial_offer` if the launch needs to be paused — this preserves the historical evidence trail (the row remains, `effective_end` is set, `effective_history_protected` stays true forever per the Ω3.0 ratchet) rather than erasing that USD pricing was ever offered, exactly matching Step 14's explicit prohibition on deleting historical payment/licence evidence as a rollback strategy. |
| `commercial_platform_state` | Roll back to `PAYMENTS_DISABLED` via `admin_transition_platform_state` if a full pause is needed — this is the designed purpose of that singleton gate. |

## 5. Public pricing / authoritative offer drift (Requirement O)

Recommendation, not implemented in this pass: a lightweight parity check — either (a) a staging smoke test that calls `resolve_commercial_offer(PAID, GLOBAL, MONTHLY)` and asserts `amount_minor === PRICING.MONTHLY_USD * 100`, run as part of the acceptance matrix (§`ACCEPTANCE_MATRIX.md` §1, step 2's own note), or (b) an admin-surfaced warning in a future catalogue view if the two ever diverge. Neither requires new architecture, and neither makes the frontend authoritative — the frontend still only ever *displays* `PRICING.*`; the DB remains the sole authority for what checkout actually charges.

## 6. Status

No implementation was performed in this pass. This document, together with the other five in `docs/operations/cfoclose-omega3-checkout/`, is the complete design/audit package requested by the Ω3-CHECKOUT DESIGN MISSION.
