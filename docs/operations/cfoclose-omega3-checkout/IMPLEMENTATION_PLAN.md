# Ω3-CHECKOUT — Implementation Plan

Design document only. Nothing below has been applied. Every file is marked MUST CHANGE / MAY CHANGE / MUST NOT CHANGE for a future, separate implementation pass — subject to the independent Codex audit this package exists to enable.

**Design-correction round (this revision):** the resolver deployment is now explicitly three-phase (schema → application → cleanup), `commit_verified_commercial_payment` moves from MUST NOT CHANGE to MUST CHANGE (a customer-level lock is required — item 6), `admin_upsert_commercial_offer` gains the same product-scoping fix as the resolver, the two USD offers are seeded non-purchasable with a separate activation step (item 12), `list_purchasable_commercial_offers` is withdrawn entirely (item 9 — no proven caller), and every "renewal" reference means manual, customer-initiated renewal (item 8).

## 1. File-level slices

### MUST CHANGE

| File | Change |
|---|---|
| `supabase/migrations/<new timestamp A>_omega3_checkout_resolver_and_intent_acquisition.sql` (new file, **Phase A**) | Creates the 3-arg `resolve_commercial_offer(p_plan_code, p_billing_interval, p_market_code DEFAULT 'GLOBAL')` (required params first, no `NOT NULL` in the signature, explicit body validation, product-scoped via `billing_customers.product_id` / `commercial_default_product_id()`) **alongside** the still-live 2-arg overload; creates `commercial_default_product_id()`; creates `acquire_or_reuse_checkout_intent(...)`; adds the customer-level lock to `commit_verified_commercial_payment` (via `CREATE OR REPLACE` — same signature, so this one IS a true replace, not an overload); fixes `admin_upsert_commercial_offer`'s identical unscoped plan lookup (`:215`) to resolve via the offer's own intended product rather than a bare `code` match — see `DATA_CONTRACTS.md` §1 for the exact SQL. See `DATA_CONTRACTS.md` §1 for why this is Phase A only (both resolver overloads coexist after this migration). |
| `supabase/functions/commercial-create-checkout/index.ts` (**Phase B**, deployed only after Phase A migration is live) | Remove `marketCode` from the accepted request body entirely (not defaulted — the field is not read); add the platform-state gate (`DATA_CONTRACTS.md` §2, §10 matrix) as the first check after auth; call the new 3-arg `resolve_commercial_offer` with a literal `'GLOBAL'` market; replace the direct `INSERT` into `payment_checkout_intents` with a call to `acquire_or_reuse_checkout_intent`; implement the two-step protocol (commit the intent row, call the provider, write the URL back via a narrow guarded `UPDATE`) |
| `supabase/functions/_shared/payments/providers/flutterwave.ts:147-155` | Replace stale branding per `DATA_CONTRACTS.md` §9: `title: 'CFOClose'`, `description` uses "Professional Licence" not "Firm Licence", `logo` points at a new raster CFOClose asset (see BLOCKER dependency below), `meta.source: 'CFOCLOSE_OMEGA3'`. New reference values (wherever the `SAFF-...` prefix is generated) switch to `CFOCLOSE-` going forward only — the `saff_reference` **column name** and every historical row's value are left untouched (item 11). |
| `src/lib/commercial/commercialRpc.ts` | `createCheckoutIntent(planCode, billingInterval)` — `marketCode` parameter **removed**, not made optional; request body drops the field entirely |
| `src/components/commercial/CheckoutUpgradeButton.tsx` | `marketCode` prop **removed**; new required `billingInterval` prop threaded into both the display `resolve_commercial_offer` call (now 3-arg, no market argument passed from the client at all — the RPC's own default/literal handles it) and `createCheckoutIntent` |
| `src/pages/Pricing.tsx` | Remove the "checkout disabled" lock panel; wire the existing `interval` state into a real `CheckoutUpgradeButton`; add the unauthenticated-selection routing to sign-in/signup with the interval preserved (item 10); add the parity check described in §5 below so a static/DB pricing mismatch disables checkout rather than displaying an untrustworthy number. **Scope discipline unchanged:** wiring only, no redesign of layout/copy/feature lists. |
| Test files: new/updated tests for the corrected resolver signature, the atomic acquire/reuse RPC, the customer-level commit lock, the platform-state gate, the removed `marketCode` contract, the product-binding fix, and the Flutterwave branding fix | Follow the established static-source-text regression-guard convention. `marketPropagation.test.ts`'s assertions are retired (they test a contract this design removes) and replaced by a `DISPLAY_INTERVAL == CHECKOUT_INTERVAL` guard plus an explicit "no `marketCode` key anywhere in the request body" guard. `CheckoutUpgradeButton.test.ts`'s market-propagation-specific assertions are updated to match. |
| `supabase/migrations/<new timestamp C>_omega3_checkout_resolver_cleanup.sql` (new file, **Phase C**, deployed only after Phase B is confirmed live and stable) | `REVOKE ALL ON FUNCTION public.resolve_commercial_offer(TEXT, TEXT) FROM PUBLIC, anon, authenticated; DROP FUNCTION public.resolve_commercial_offer(TEXT, TEXT);` — removes the old, ambiguous 2-arg overload only once nothing calls it |

### CONTROLLED DATA-SEED OPERATION (not a schema migration — see §3) — corrected for non-purchasable seeding (item 12)

| Action | Detail |
|---|---|
| Step 1 — create two authoritative USD offers, **non-purchasable** | `admin_upsert_commercial_offer('CFOCLOSE-PAID-GLOBAL-USD-MONTHLY', 'PAID', 'GLOBAL', 'USD', 4900, 2, 'MONTHLY', 1, true, **false**, '<reason>')` and the ANNUAL equivalent (49900, **false**) — `is_active=true` (a real catalogue row from creation) but `is_purchasable=false` (cannot be charged against) |
| Step 2 — activation, a SEPARATE, later, explicitly audited operation | Only after every gate in `ACCEPTANCE_MATRIX.md` passes on staging: `admin_supersede_commercial_offer(...)` (or a narrower future `admin_set_offer_purchasable`) flips `is_purchasable = true` for each offer, one at a time, each independently reversible and independently audited via `commercial_catalog_audit_events`. Step 2 must never be bundled into the same deployment or the same admin call as Step 1. |

### MAY CHANGE

| File | Reason |
|---|---|
| `src/lib/commercial/payments/{paymentTypes.ts,paymentAuthority.ts}` and their 4 test files | Unchanged from the prior round — shadow coverage, not required to ship |
| `src/constants/copy.ts` (`PRICING` block) | Only if the parity mechanism in §5 lives here |

### MUST NOT CHANGE

- `supabase/functions/commercial-payment-webhook/index.ts`'s Gate A/replay/receipt model — **unchanged except** the Gate B transient/definitive split (item 7), which is a narrow, additive change to how one failure category is classified and responded to, not a redesign of the webhook flow.
- `supabase/functions/_shared/payments/authority.ts` (`authoriseCommit`) — unchanged.
- `supabase/functions/_shared/payments/money.ts`, `contracts.ts`, `routing.ts` — unchanged.
- `record_payment_reversal`, `get_checkout_status`, `admin_get_billing_detail` — unchanged.
- `commercial_licences`, `entitlement_overrides`, `_resolve_entitlement_for_owner`, `get_effective_entitlement` — unchanged; entitlement is plan-scoped, not interval- or lock-granularity-scoped.
- Any RLS policy — unchanged.
- `commercial_offers` table schema, `uq_co_current_offer`, `excl_co_no_overlapping_purchasable_periods` — unchanged (still sufficient, §5 of the architecture audit).
- `src/lib/workspace/*`, `stageMetadata.ts`, SAFISHA/HESABU/KINGA/MAONO — untouched.
- `src/pages/billing/PaymentReturn.tsx` — unchanged; already displays whatever `get_checkout_status` returns.

### Corrected from the prior round

| Item | Prior classification | Corrected classification | Why |
|---|---|---|---|
| `commit_verified_commercial_payment` | MUST NOT CHANGE | **MUST CHANGE** | Item 6 requires a customer-level (not merely intent-level) lock — see `DATA_CONTRACTS.md` §7. The change is narrowly scoped (one lock acquisition + one re-read, inserted at a specific point) and touches no existing validation logic. |
| `list_purchasable_commercial_offers` (new function) | Proposed as MUST CHANGE (new addition) | **Withdrawn entirely** | Item 9 — no proven caller exists anywhere in this design's own implementation slice or the current codebase. |
| Checkout-intent reuse logic | Proposed as an Edge-Function-level `SELECT`-then-reuse | **Replaced with the atomic `acquire_or_reuse_checkout_intent` RPC** | Item 5 — the prior design was a non-atomic check-then-act race. |
| USD offer seeding | Proposed as a single-step creation with `is_purchasable=true` | **Split into two steps: create non-purchasable, activate separately** | Item 12. |

## 2. Concurrency implementation note

The atomic `acquire_or_reuse_checkout_intent` RPC and the customer-level lock inside `commit_verified_commercial_payment` are both **database-enforced**, not application-level check-then-act logic — this corrects the prior round's rejected `SELECT`-then-`INSERT` proposal, which could not actually guarantee atomicity across two concurrent Edge Function invocations. See `DATA_CONTRACTS.md` §6–7 for the full SQL and `THREAT_AND_FAILURE_MODEL.md` Part 1 for the scenario-by-scenario re-audit.

## 3. Migration safety

- **Phase A migration** (new 3-arg resolver + `commercial_default_product_id` + `acquire_or_reuse_checkout_intent` + the `commit_verified_commercial_payment` lock addition + the `admin_upsert_commercial_offer` product-scoping fix): forward-only, no `DROP TABLE`, no destructive alteration. The 2-arg `resolve_commercial_offer` overload is left in place and functioning exactly as before for the duration of this phase — this migration changes zero existing behavior for any in-flight caller.
- **Phase B** (application deploy): the Edge Function and frontend changes. Rollback of this phase alone (reverting to the pre-Ω3-CHECKOUT Edge Function/frontend while Phase A's schema remains deployed) is safe — the old 2-arg resolver overload is still present and still callable, so a reverted Edge Function continues to work exactly as it did before any of this shipped.
- **Phase C migration** (drop the 2-arg overload): deployed only after Phase B is confirmed stable — see the three-phase deployment order in `DATA_CONTRACTS.md` §1. This ordering is the direct answer to item 1's "define safe migration/Edge-Function deployment order" requirement; it did not exist as an explicit multi-phase plan in the prior round, which treated the resolver change as a single atomic swap (itself part of what made the prior signature proposal invalid — a same-signature `CREATE OR REPLACE` really would be atomic and safe, but a changed-arity one is not, which is exactly the "overload, not replace" hazard item 1 flags).
- **Controlled commercial data-seed operation:** unchanged in kind from the prior round (an admin RPC call, not a migration, reversible via supersession, never a `DELETE`) — corrected only in that Step 1 (create) and Step 2 (activate) are now explicitly two separate, independently-audited operations (item 12).
- Pre-deployment verification: the full existing commercial test suite plus every new/updated test in §1's MUST CHANGE row. None of the existing tests assert a fixed resolver arity as a requirement (re-confirmed this round) except `marketPropagation.test.ts`, which is explicitly retired.
- Post-deployment verification: `ACCEPTANCE_MATRIX.md` in full, including the new platform-state, concurrency, product-binding, and manual-renewal-disclosure sections.
- Frontend economics: `Pricing.tsx`'s `PRICING.MONTHLY_USD`/`ANNUAL_USD` constants remain a **display fallback only until the resolver call succeeds** — once checkout is enabled, the page must render the server-resolved amount for the actually-selected interval (item 9), and a detected mismatch between the two must **disable the checkout CTA and raise an acceptance failure**, not merely log a warning. See §5.

## 4. Rollback

| Layer | Rollback action |
|---|---|
| Frontend (`Pricing.tsx`, `CheckoutUpgradeButton.tsx`, `commercialRpc.ts`) | Revert the commit(s); the lock panel can be restored immediately |
| Edge Function (`commercial-create-checkout`) | Revert to the pre-Ω3-CHECKOUT deployed version; safe independent of migration phase (see §3) |
| Flutterwave adapter branding fix | Purely cosmetic; plain text revert |
| Phase A migration | `DROP FUNCTION` the new 3-arg resolver, `commercial_default_product_id`, `acquire_or_reuse_checkout_intent`; `CREATE OR REPLACE FUNCTION` `commit_verified_commercial_payment` back to its pre-lock body (preserved verbatim in git history); `CREATE OR REPLACE FUNCTION` `admin_upsert_commercial_offer` back to its unscoped lookup if the product-scoping fix itself needs reverting (unlikely in isolation, since it only tightens an existing single-product-safe behavior) |
| Phase C migration | Re-`CREATE FUNCTION` the 2-arg overload if ever needed (its body is quoted verbatim in the prior round's `DATA_CONTRACTS.md` history) — expected never to be necessary once Phase C has shipped, since nothing calls it by then |
| Commercial offers (the two new USD rows) | **Never delete.** If activated (Step 2) and a rollback to non-purchasable is needed, `admin_supersede_commercial_offer` flips `is_purchasable` back to `false` — preserving the historical evidence trail. If not yet activated, simply do not perform Step 2. |
| `commercial_platform_state` | Roll back to `PAYMENTS_DISABLED` via `admin_transition_platform_state` for a full pause — this is the gate's designed purpose, and with this design's new enforcement (item 4), doing so now actually stops checkout traffic, unlike before this implementation ships. |

## 5. Public pricing / authoritative offer drift, and the withdrawn listing function (items 9)

**Parity mechanism, corrected to be enforcing, not advisory:** `Pricing.tsx`, once wired to real checkout, must call `resolve_commercial_offer` for both intervals (or lazily for the selected one) and compare the returned `amount_minor`/`currency_code` against `PRICING.MONTHLY_USD`/`ANNUAL_USD`. On a match, render normally. **On a mismatch, disable the checkout CTA and surface a visible "pricing temporarily unavailable" state** — this is the acceptance-failure behavior item 9 requires, replacing the prior round's softer "staging smoke test / admin warning" framing, which did not actually prevent a live mismatch from reaching a customer. This still makes the DB the sole authority (the frontend never invents a number; it only refuses to proceed on disagreement) and still requires no new architecture.

**`list_purchasable_commercial_offers` is fully withdrawn** — not deferred, not "may change." If a genuine future need for an interval-independent listing surface arises (e.g. an admin catalogue UI), it gets its own design pass with a real, named caller identified first.

## 6. Status

No implementation was performed in this pass. This document, together with the other five in `docs/operations/cfoclose-omega3-checkout/`, is the complete, corrected design/audit package.
