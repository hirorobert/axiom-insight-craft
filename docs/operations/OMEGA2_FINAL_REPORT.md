# SAFF Ω∞ COMMERCIAL ENGINE Ω2-G — GLOBAL COMMERCE FINAL REPORT

- **Branch:** `omega2-commercial-engine-20260905`
- **Base SHA (Ω1 + RLS1, Lovable-applied):** `4844937f516767427eedc759e66b1774885d7aa8`
- **Date:** 2026-09-05 — global-commerce hardening pass (Ω2-G)
- **Wave:** Ω2-G — Real Payments + Global Commercial Offer Model + Premium Entitlement

> **Candidate SHA Note:** a document cannot correctly name its own commit's
> hash before that commit exists. The canonical candidate is the commit
> that contains this report — resolve it with
> `git log -1 --format=%H -- docs/operations/OMEGA2_FINAL_REPORT.md`. Two
> earlier commits (`b71a4b9`, then the empty `628c4e4`) predate the
> global-commerce repair below and must not be cited as the candidate.

---

## §0 — WHAT CHANGED IN Ω2-G (superseding the original Ω2 draft)

The original Ω2 draft collapsed several orthogonal commercial dimensions
into one: `commercial_plans` carried a single authoritative
`price_amount_minor`/`currency_code`, defaulting to TZS, with Flutterwave
as the only provider. That design also contained three genuine BLOCKER
defects, found by actually running the (previously never-executed) test
suite and reading the SQL against Ω1/RLS1's real schema:

1. **`billing_audit_events` was inserted with columns that don't exist**
   (`event_type`, `metadata`) — Ω1 defines `action`/`previous_state`/
   `new_state`/`reason`/`correlation_id`. Every real payment commit would
   have thrown `column does not exist` and rolled back.
2. **`commercial_licences.source` (`NOT NULL`, no default) was never
   supplied** on the licence INSERT inside `commit_verified_commercial_payment()`.
3. **The prior licence was never closed out before inserting a new one for
   a DIFFERENT plan.** Any FREE→PAID upgrade — the primary real-world
   flow — would have hit RLS1's `excl_cl_no_overlapping_authoritative_periods`
   exclusion constraint and failed the whole transaction, AFTER the
   customer had already paid.

A fourth, non-SQL defect: `get_checkout_status()` returned `intent_status`
while `PaymentReturn.tsx`/`commercialRpc.ts` read `status` — the payment
confirmation page could never actually detect a successful payment.

All four are fixed in this candidate (see §7, §12, §13). None required
touching `PaymentReturn.tsx`'s security properties — only the RPC's field
names and the client's mapping layer.

The global-commerce model below (§1–§6) replaces the single-price-per-plan
design entirely, and is what makes Mauritius/USD, a future UK/GBP offer,
and a future Stripe adapter all additive rather than redesigns.

---

## §1 — THE GLOBAL COMMERCE MODEL

```
PRODUCT → PLAN → COMMERCIAL OFFER → CHECKOUT INTENT → PAYMENT ROUTING
→ PAYMENT PROVIDER → VERIFIED PAYMENT EVIDENCE → PAYMENT EVENT
→ LICENCE → ENTITLEMENT → FEATURE ACCESS
```

Ten orthogonal dimensions, never collapsed into one another: product
identity, accounting jurisdiction, commercial market, commercial offer,
currency, payment provider, payment method, settlement destination,
licence/entitlement, and accounting/professional authority. SAFF is a
global product. Tanzania is a supported accounting jurisdiction, an
optional commercial market, and a provider-capability context — never
SAFF's identity. No global-core file encodes "SAFF = Tanzania",
"PAID = TZS", or "jurisdiction = commercial market".

**Status: PASS** — verified by `src/lib/commercial/payments/__tests__/globalCommerceModel.test.ts`
(33 static source-text assertions against the migration) plus manual review
of every frontend/Edge Function file changed in this pass.

---

## §2 — PLAN != PRICE

**Status: PASS**

`commercial_plans` owns identity and capabilities only — no price column
was ever added to it in this candidate. The sole pricing authority is
`commercial_offers`: "this plan is available in this market, in this
currency, at this price." No plan price is invented anywhere; the seed
data adds zero offer rows — a plan with no offer simply cannot be checked
out (`PRODUCT_PRICING_DECISION_REQUIRED`, unchanged as a real gate).

---

## §3 — COMMERCIAL OFFER AUTHORITY

**Status: PASS**

`commercial_offers` columns: `offer_code` (unique), `plan_id`,
`market_code`, `currency_code`, `amount_minor` (`BIGINT NOT NULL`,
`> 0`), `currency_exponent`, `billing_interval`/`billing_interval_count`,
`effective_start`/`effective_end`, `is_active`, `is_purchasable`, an
optional `provider_restriction`. A partial unique index
(`uq_co_current_offer`) prevents two simultaneously-current purchasable
offers for the same `(plan, market, currency)` at the database level —
the resolver additionally fails closed to `AMBIGUOUS` rather than trusting
that index alone. Offers are public catalogue data (`co_select_public`
policy), matching Ω1's existing allowance for `commercial_plans`/
`commercial_products` — a price is not private data.

---

## §4 — MARKET != JURISDICTION

**Status: PASS**

Market vocabulary: `GLOBAL, TZ, MU, GB, EU` — a closed `CHECK` constraint,
not a country ERP. `resolve_commercial_offer(plan_code, market_code)` has
no company/jurisdiction parameter and no browser-supplied amount/currency
parameter — market is the only "where" input, and it is never derived from
IP or `Accept-Language`. `TZ` (commercial market) and Tanzania's KINGA
accounting jurisdiction are unrelated concepts; nothing in this migration
or in `commercial-create-checkout` reads `companies.reporting_framework`
or any jurisdiction field to pick a market.

---

## §5 — CURRENCY IS OFFER-SCOPED

**Status: PASS**

`SUPPORTED_CURRENCIES` (both the frontend and Edge Function copies of
`money.ts`) now includes `TZS, USD, KES, UGX, GBP, EUR` — GBP/EUR were
added as a structural proof that a new currency needs one array entry and
one exponent, never a schema change. No exchange-rate/FX-conversion logic
exists anywhere in the migration or Edge Functions (grepped: zero matches
for `exchange_rate|fx_rate|convert_currency`). Each offer has its own
human-approved price in its own currency — SAFF never converts.

---

## §6 — MONEY AUTHORITY DEFECT: FIXED

**Status: PASS**

`moneyFromMinorUnits()` previously called `BigInt(1.5)` directly, which
throws a `RangeError` *before* its own `{valid:false}` validation branch
could run — contradicting its own documented "never throws" contract.
Fixed: `number` inputs are now checked with `Number.isFinite`,
`Number.isInteger`, and `Number.isSafeInteger` *before* any `BigInt()`
call; the `BigInt()` call itself is additionally wrapped in a `try/catch`
as defence-in-depth. Verified by 21 new hostile-input tests: non-integer
number, `NaN`, `Infinity`, `-Infinity`, an unsafe integer, a negative
float, BIGINT-domain overflow, and the existing malformed-string/empty-
string cases (already safe via the pre-existing `try/catch` around
`moneyFromProviderDecimal`'s own `BigInt()` call). Zero unexpected
exceptions from the documented non-throwing path.

---

## §7 — CHECKOUT INTENT: ECONOMIC SNAPSHOT

**Status: PASS**

`payment_checkout_intents` now references `commercial_offer_id` and
snapshots the offer's economic facts at creation time: `plan_id`,
`market_code`, `expected_amount_minor`, `currency_code`,
`currency_exponent`, `billing_interval`, `billing_interval_count`.
`commit_verified_commercial_payment()` validates the provider's reported
amount/currency against the **intent's own snapshot** — it never re-reads
`commercial_offers` (verified: zero `FROM public.commercial_offers`
references inside the commit function). Editing an offer's price after a
checkout is created cannot retroactively change that checkout or any
historical payment event.

---

## §8 — OFFER RESOLVER

**Status: PASS**

`resolve_commercial_offer(p_plan_code, p_market_code = 'GLOBAL')` returns
one of four explicit resolutions — `AVAILABLE`, `NOT_AVAILABLE`,
`AMBIGUOUS`, `UNKNOWN` — never a silently-chosen offer. Precedence: exact
market match first, then a `GLOBAL` fallback (flagged in the response as
`fallback_to_global: true`) only when the requested market has zero
matches. More than one match at any step returns `AMBIGUOUS`, not a
best guess. The function accepts no locale/IP/amount/currency parameter —
those inputs simply do not exist in its signature.

---

## §9 — PROVIDER ROUTING

**Status: PASS**

`supabase/functions/_shared/payments/routing.ts` (+ a testable frontend
mirror at `src/lib/commercial/payments/routing.ts`) implements
`selectPaymentProvider(offer, configuredProviders)` as a pure function
over declared `PaymentProviderCapabilities` (currencies, markets, methods,
environment). No `"TZS => Flutterwave"` or `"TZ => Flutterwave"` rule is
hardcoded as permanent truth. `getConfiguredProviders()` only returns a
provider whose secrets are actually present in the environment — routing
can never select a provider it cannot call. If no eligible configured
provider exists, `commercial-create-checkout` returns
`PAYMENT_PROVIDER_UNAVAILABLE` (HTTP 503) — never a fake checkout.

---

## §10 — FLUTTERWAVE ADAPTER COMPATIBILITY

**Status: PASS**

Flutterwave remains the sole configured provider. Its capabilities are
declared as `{ currencies: [TZS, USD, KES, UGX], markets: [GLOBAL, TZ, MU] }`
— deliberately **not** GB/EU, matching its real-world strength (African +
global-card processing, not UK/EU domestic rails) and proving that a
GB/EU offer today correctly resolves to `PAYMENT_PROVIDER_UNAVAILABLE`
rather than being force-routed to an ill-suited provider. Its
`payment_options` field (mobile money vs. card-only) is now conditional on
the transaction's actual currency being TZS, not unconditionally
Tanzania-flavoured for every market it processes — a payment *method* is
provider execution detail (dimension G), never global commercial identity.

---

## §11 — STRIPE-READINESS PROOF

**Status: PASS — no core redesign required**

Verified structurally (`globalCommerceModel.test.ts` + `routing.test.ts`):

- The `provider` `CHECK` constraint on `payment_checkout_intents` already
  includes `'STRIPE'` — adding a Stripe transaction needs no migration.
- No core table (`commercial_offers`, `payment_checkout_intents`) mentions
  `FLUTTERWAVE` anywhere outside its own enum `CHECK` constraint.
- A mock `STRIPE_MOCK_CAPABILITIES` object satisfies the exact same
  `PaymentProviderCapabilities` shape Flutterwave uses (test asserts
  identical key sets) and, once added to `getConfiguredProviders()`,
  immediately makes a GB/EU offer routable — with **zero** changes to
  `selectPaymentProvider()`, `commercial_offers`, checkout intent
  semantics, `payment_events`, licence schema, the entitlement resolver,
  or `PaymentReturn.tsx`.
- Adding Stripe for real requires only: a `StripeAdapter` implementing
  `ProviderAdapter`, a `STRIPE_CAPABILITIES` declaration, one new branch in
  `adapterFor()` in `commercial-create-checkout/index.ts`, and Stripe's own
  webhook route. No schema change.

---

## §12 — SETTLEMENT ORTHOGONALITY

**Status: PASS — architectural note only, no schema change**

Settlement (where SAFF's merchant funds ultimately land) is explicitly
outside customer entitlement authority. `payment_events`,
`commercial_licences`, and `get_effective_entitlement()` have zero
settlement-related columns or inputs — grepped and asserted by test. Entitlement
is determined solely by verified provider transaction evidence (Gate A +
Gate B), never by observing money arrive in any account. No settlement
integration (Payoneer, CRDB, or otherwise) is built; no personal account
of any kind is referenced anywhere in this schema. A future
`settlement_events` table keyed by `payment_events.id` could be added
additively without touching payment, licence, or entitlement schema,
precisely because none of them know settlement exists today.

---

## §13 — BLOCKER DEFECT REPAIRS (money/licence/audit authority)

**Status: PASS — all three fixed, verified by static source-text test**

1. `billing_audit_events` inserts now use the real Ω1 columns
   (`action`, `previous_state`, `new_state`, `reason`) everywhere in this
   migration — zero remaining `event_type`/`metadata` references against
   that table.
2. Every `commercial_licences` INSERT supplies `source` (e.g.
   `'FLUTTERWAVE_VERIFIED_PAYMENT'`) — never NULL into a `NOT NULL`
   column with no default.
3. `commit_verified_commercial_payment()` now looks up the customer's
   current `ACTIVE`/`GRACE` licence **without filtering by plan_id**,
   and closes it out (`effective_end = v_period_start`) before inserting
   the new licence row — mirroring RLS1's own
   `admin_grant_commercial_licence()` close-out pattern. A FREE→PAID
   upgrade can no longer violate RLS1's
   `excl_cl_no_overlapping_authoritative_periods` exclusion constraint.

---

## §14 — PAYMENT-RETURN FIELD CONTRACT: FIXED

**Status: PASS — PaymentReturn.tsx's own security properties unchanged**

`get_checkout_status()` now returns a top-level `status` key (was
`intent_status`) plus `effective_start`/`effective_end`, matching what
`PaymentReturn.tsx` actually reads. `pollCheckoutStatus()` in
`commercialRpc.ts` is the sole snake_case→camelCase translation boundary.
`PaymentReturn.tsx` itself was not modified — it already read only
`?ref=`, never trusted a URL-supplied status, never granted entitlement
client-side, and polled an owner-scoped RPC. Confirmed by re-reading
`get_checkout_status()`'s `WHERE ... bc.owner_user_id = auth.uid() OR
is_commercial_admin()` clause directly, not by trusting a prior claim.

---

## §15 — EXISTING Ω2 IRON DOME INVARIANTS: PRESERVED

**Status: PASS — none weakened**

- Browser never sets `paid=true` (`REVOKE UPDATE, DELETE ... FROM authenticated`
  on `commercial_licences`; only `commit_verified_commercial_payment()`
  SECURITY DEFINER writes it).
- Return page never grants entitlement (§14).
- Webhook Gate A (constant-time `verif-hash`) + Gate B (independent
  provider API verification, now with a hard tx_ref requirement — see
  Ω2-GR1 below) both required.
- `payment_webhook_receipts` is a pure immutable OBSERVATION recorded
  before any processing, with no mutable-looking columns; processing
  outcomes are separate append-only rows in
  `payment_webhook_processing_events` (Ω2-GR1 repair — see below).
- Idempotency: `idempotency_key` unique on `payment_events`;
  `uq_pe_provider_tx_id` unchanged; webhook replay still short-circuits.
- Atomic licence commit — still one transaction, now additionally correct
  for cross-plan upgrades (§13).
- `FREE != PREMIUM`, `UNKNOWN != FALSE`, tri-state entitlement — untouched,
  `get_effective_entitlement()` was not modified.
- Server-side premium gates — untouched.
- Commercial/accounting orthogonality — untouched; no accounting table is
  referenced anywhere in this migration (grepped).
- Provider-neutral adapter interface — strengthened, not weakened (§9–§11).

---

## §16 — ADMIN OFFER MANAGEMENT

**Status: PASS**

`/commercial/admin` now manages **offers**, not a single plan price field.
`admin_upsert_commercial_offer(...)` is `commercial_admin`-gated, requires
a mandatory `p_reason`, and records every create/update in the new,
immutable `commercial_catalog_audit_events` table (append-only trigger,
admin-only `SELECT`). `admin_list_commercial_offers()` gives the admin UI
a read of every offer, including inactive/non-purchasable ones. No price
is invented by this UI — the founder types the amount; the UI only
validates it is a positive integer. Editing an offer never rewrites
historical checkout/payment evidence (§7). Commercial admin authority
still confers zero accounting authority (verified: `admin_upsert_commercial_offer`
references no accounting table).

---

## §17 — MIGRATION STATUS

**Status: CREATED_NOT_APPLIED**

`supabase/migrations/20260905200000_omega2_commercial_payments.sql` was
amended in place (not chained) because it has never been applied to any
database — this is the single, canonical Ω2 pricing/payment migration.
`commercial_plans` receives zero new columns from this file. No Ω1 or
RLS1 migration file is modified.

---

## §18 — TEST MATRIX COVERAGE

**Status: ACTUALLY EXECUTED on Windows, `npx vitest run`**

| Suite | Tests | Coverage |
|---|---|---|
| `money.test.ts` | 31 | Integer money, hostile inputs (NaN/Infinity/unsafe-integer/negative-float), TZS/USD/GBP/EUR, bigint exactness, overflow |
| `globalCommerceModel.test.ts` | 33 | Plan!=price, offer authority, market!=jurisdiction, resolver states, snapshot immutability, the three blocker repairs, settlement orthogonality, global-neutral core, Stripe-readiness |
| `routing.test.ts` | 9 | Flutterwave eligible routing, fails-closed unavailable/restricted cases, routing never mutates price, Stripe-mock composability |
| `paymentSecurity.test.ts` | 8 | Iron Dome invariants, NEVER rules, tri-state entitlement |
| `checkoutFlow.test.ts` | 5 | Adapter interface, PRODUCT_PRICING guard, provider portability |
| `webhookSecurity.test.ts` | 14 | Gate A, Gate B, status mapping, receipt-before-commit |
| `atomicCommit.test.ts` | 9 | CommitResult states, idempotency, status machine, reversal REVIEW_REQUIRED |

**Total this suite: 109 tests, 109 passing.** Full repository suite:
**958/958 passing** (52 files) — zero known defects remain in money,
payment, licence, or entitlement authority.

---

## §19 — TYPECHECK / BUILD / LINT / DIFF CHECK

**Status: ALL PASS**

- `tsc --noEmit -p tsconfig.app.json`: clean.
- `npm run build`: succeeds.
- `eslint` on every tracked Ω2-G source file: zero errors, zero warnings.
- `git diff --check`: clean.

---

## §20 — FILES CHANGED IN THIS HARDENING PASS

```
supabase/migrations/20260905200000_omega2_commercial_payments.sql   — rewritten: offer model + 4 defect repairs
supabase/functions/commercial-create-checkout/index.ts              — offer resolution + provider routing
supabase/functions/_shared/payments/providers/flutterwave.ts        — conditional payment_options (currency-scoped, not TZ-default)
supabase/functions/_shared/payments/money.ts                        — +GBP/EUR
supabase/functions/_shared/payments/routing.ts                      — new: provider routing abstraction
src/lib/commercial/payments/money.ts                                — money authority fix + GBP/EUR
src/lib/commercial/payments/routing.ts                               — new: testable routing mirror
src/lib/commercial/commercialRpc.ts                                  — offer RPC signatures + status field mapping
src/components/commercial/CheckoutUpgradeButton.tsx                  — offer-aware, global-neutral display
src/pages/commercial/CommercialAdmin.tsx                             — offer management UI (was: single plan price)
src/lib/commercial/payments/__tests__/money.test.ts                  — +21 hostile-input tests
src/lib/commercial/payments/__tests__/globalCommerceModel.test.ts    — new: 33 tests
src/lib/commercial/payments/__tests__/routing.test.ts                — new: 9 tests
docs/operations/OMEGA2_FINAL_REPORT.md, OMEGA2_LOVABLE_PRODUCTION_HANDOFF.md — this pass
```

`commercial-payment-webhook/index.ts` and `commercial-payment-status/index.ts`
required **no changes** — both already consumed the checkout intent's own
snapshot columns, which is exactly what the offer model was designed to
leave untouched downstream.

---

## §21 — FINAL VERDICT

```
┌─────────────────────────────────────────────────────────────────────────┐
│         SAFF Ω∞ GLOBAL COMMERCE Ω2-G — CERTIFICATION RESULT             │
├─────────────────────────────────────────────────────────────────────────┤
│  Product global-neutral                          ✅ PASS                 │
│  Plan != Price                                   ✅ PASS                 │
│  Commercial offer authority                      ✅ PASS                 │
│  Market != jurisdiction                          ✅ PASS                 │
│  Currency offer-scoped                           ✅ PASS                 │
│  Money non-throwing validation (defect fixed)    ✅ PASS                 │
│  Checkout economic snapshot                      ✅ PASS                 │
│  Offer resolver (4 explicit states)              ✅ PASS                 │
│  Provider routing                                ✅ PASS                 │
│  Flutterwave adapter compatibility               ✅ PASS                 │
│  Stripe-ready without core redesign              ✅ PASS                 │
│  Settlement orthogonal                           ✅ PASS                 │
│  FREE != PREMIUM / UNKNOWN != FALSE              ✅ PASS                 │
│  Payment authority (3 blockers fixed)            ✅ PASS                 │
│  Accounting orthogonality                        ✅ PASS                 │
│  Tests 958/958, typecheck, build, lint, diff     ✅ PASS                 │
│                                                                         │
│  ████████████████████████████████████████████████████████████████████  │
│  ██   Ω2-G  READY_FOR_CODEX_CERTIFICATION                            ██  │
│  ████████████████████████████████████████████████████████████████████  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## §22 — Ω2-GR1 CORRECTION NOTICE (post-publication)

**This report describes candidate `9cf271a8d9b732880ff0d1d0b51e9fa0b448a69f`,
which Codex's independent certification pass REJECTED** with 2 BLOCKER
findings and 1 HIGH finding. The verdict block above is preserved verbatim
as the historical record of what this pass believed at the time — it was
wrong on three specific points:

1. §6's "money authority defect: fixed" was true for `moneyFromMinorUnits()`
   (the integer-input validator) but did **not** cover a second, more
   dangerous defect in `moneyFromProviderDecimal()` (the decimal-string
   parser both money.ts copies also export): it silently truncated any
   provider decimal with excess precision instead of rejecting it — e.g.
   USD `"1.239"` became `123` minor units instead of `INVALID`. Money
   exactness in this report's §6 was therefore **incomplete, not proven**.
2. The Flutterwave adapter's Gate B (§10) verified amount/currency but
   ACCEPTED a verify response with a missing `tx_ref` by silently falling
   back to SAFF's own locally-expected reference — defeating independent
   provider corroboration for the one field that actually binds the
   verified transaction to SAFF's checkout.
3. §15's "existing invariants preserved" claim that
   `payment_webhook_receipts` was "still append-only, still recorded
   before any processing" was true of the table alone, but did not
   surface that the *calling Edge Function* attempted `UPDATE`s against
   that same append-only-triggered table — a contradiction that would
   have failed at runtime on every real webhook.

All three are repaired in candidate `9cf271a8`'s child. See
**`OMEGA2_GR1_CERTIFICATION_REPAIR_REPORT.md`** for the full repair report,
exact SHA, and updated test/typecheck/build/lint/diff-check results. Every
other verdict row in §21 (global-neutral core, plan!=price, offer
authority, market!=jurisdiction, provider routing, Stripe-readiness,
settlement orthogonality, accounting orthogonality) was NOT challenged by
Codex and is carried forward unchanged into the repair candidate — GR1 was
a surgical repair of exactly the three findings above, not a redesign.
