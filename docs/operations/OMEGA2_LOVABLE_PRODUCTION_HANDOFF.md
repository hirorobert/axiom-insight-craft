# SAFF ERP — Ω2-G Global Commerce Engine: Lovable Production Handoff

- **Branch:** `omega2-commercial-engine-20260905` (superseded by the global-commerce hardening commit named below — see Candidate SHA Note)
- **Wave:** Ω2-G — Real Payments + Global Commercial Offer Model + Premium Entitlement
- **Date:** 2026-09-05
- **Author:** SALIO CONNECT (mdcmclimited@gmail.com)

> **Candidate SHA Note:** a document cannot correctly name its own commit's
> hash before that commit exists, so this file does not hardcode one. The
> canonical candidate is the commit that contains this document — resolve
> it with `git log -1 --format=%H -- docs/operations/OMEGA2_LOVABLE_PRODUCTION_HANDOFF.md`.
> Earlier commits `b71a4b9` (source only, no docs) and `628c4e4` (empty —
> never actually added the docs it claimed to) must not be cited.

> **STATUS: SOURCE CANDIDATE — NOT YET DEPLOYED.**
>
> No migration has been applied. No Edge Function has been deployed.
> No production secret has been set. No live mutation has occurred.
> The founder must complete every step below in order.

---

## What changed since the original Ω2 draft (read this first)

The original draft gave `commercial_plans` a single price/currency,
defaulting to TZS, with Flutterwave as the only imaginable provider. That
design is gone. Pricing now lives in a separate `commercial_offers` table:
**one plan can have many offers** — one per market/currency combination
(e.g. `PROFESSIONAL_ANNUAL` priced separately for `GLOBAL`/USD, `TZ`/TZS,
and `MU`/USD). Tanzania is one supported market and one supported KINGA
accounting jurisdiction; it is not SAFF's identity. See
`docs/operations/OMEGA2_FINAL_REPORT.md` for the full model and the four
defects this pass fixed (three were SQL bugs that would have broken every
real payment commit; the fourth meant the payment-confirmation page could
never detect success).

---

## Pre-Flight Checklist (founder must verify each item)

- [ ] Legal review of `/terms` and `/privacy` is complete before taking real paid production customers (LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE)
- [ ] Flutterwave TEST credentials are configured for the Step 7 smoke test
- [ ] Flutterwave account KYB/KYC is approved for Tanzania before accepting LIVE (real-money) payments
- [ ] At least one commercial offer is configured and purchasable (PRODUCT_PRICING_DECISION_REQUIRED — no offer exists until the founder creates one; no price is ever invented)
- [ ] Return URL in Flutterwave dashboard is set: `https://<your-domain>/billing/payment/return`
- [ ] Provider secrets (`FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`) are set only in Supabase Dashboard → Edge Functions → Secrets — never committed to git, never placed in any repo file

**Not required for this checklist:** MULTI_COMPANY premium enforcement.
That policy is deferred (see "Known Pending Items" below) and is
explicitly NOT required to deploy or test Ω2-G's payment architecture —
it stays inactive regardless of this deployment.

---

## Step 1 — Merge the Branch

```bash
git checkout main
git pull origin main
git merge omega2-commercial-engine-20260905
git push origin main
```

Lovable auto-deploys from `main`. Wait for the Lovable deploy to complete before proceeding.

---

## Step 2 — Apply the Forward Migration (Lovable-Managed, NOT `supabase db push`)

**Do NOT run `supabase db push` against the SAFF production database.**
This repository has a known Lovable-managed migration-identity divergence
(the Ω1 and RLS1 migrations were each recorded live under a
Lovable-assigned timestamp different from their filenames in this repo).
Running `supabase db push` replays the FULL local migration history from
whatever baseline the CLI believes it is at, which risks re-applying or
conflicting with migrations Lovable has already recorded under its own
identity. That is not safe here.

**Controlled rule:** Lovable applies ONLY the certified Ω2-G forward
migration's semantics — the exact CREATE/ALTER/INSERT statements in
`supabase/migrations/20260905200000_omega2_commercial_payments.sql` —
through its own managed migration path, exactly as it already did for Ω1
and RLS1.

Explicitly prohibited for this handoff:
- **No blanket `supabase db push`** against production.
- **No replay of repository migration history** (Ω1, RLS1, or any prior
  migration file) — those are already live under Lovable's own recorded
  identity.
- **No migration-history normalization** (Lovable's recorded timestamps
  may differ from this repo's filenames — only the resulting schema must
  match).
- **No manual replay of the Ω1 (`20260904180000`) or RLS1
  (`20260905120000`) migrations.**

This is a forward-only migration. It creates `commercial_offers`,
`commercial_catalog_audit_events`, extends `payment_events`, and adds the
offer-aware checkout/commit functions. It adds **zero** price columns to
`commercial_plans`. **Never apply it more than once. Never reverse it
manually.**

Verify after applying:
```sql
-- In Supabase SQL editor:
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('commercial_offers','commercial_catalog_audit_events','payment_checkout_intents');
-- Expected: 3 rows

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name IN (
  'resolve_commercial_offer', 'admin_upsert_commercial_offer', 'admin_list_commercial_offers',
  'commit_verified_commercial_payment', 'record_payment_reversal', 'get_checkout_status',
  'admin_get_billing_detail'
);
-- Expected: 7 rows

SELECT count(*) FROM commercial_offers;
-- Expected: 0 (no offer is seeded — the founder creates the first one in Step 6)
```

---

## Step 3 — Set Supabase Secrets

**In Supabase Dashboard → Edge Functions → Secrets**, add:

| Secret Name | Value | Where to get it |
|---|---|---|
| `FLUTTERWAVE_SECRET_KEY` | `FLWSECK_...` | Flutterwave dashboard → API Keys |
| `FLUTTERWAVE_WEBHOOK_SECRET` | (choose a random string) | Create it; paste same value in Step 4 |

**NEVER commit these values to git. NEVER put them in `.env.local` or any file.**

---

## Step 4 — Configure Flutterwave Webhook

In Flutterwave Dashboard → Settings → Webhooks:

- **Webhook URL:** `https://<supabase-project>.supabase.co/functions/v1/commercial-payment-webhook`
- **Secret Hash:** Same value as `FLUTTERWAVE_WEBHOOK_SECRET` above

Flutterwave sends this as the `verif-hash` header on every webhook call.
Gate A verifies it with constant-time comparison. Never skip this step.

---

## Step 5 — Deploy Edge Functions

```bash
supabase functions deploy commercial-create-checkout
supabase functions deploy commercial-payment-webhook
supabase functions deploy commercial-payment-status
```

Verify:
```bash
supabase functions list
```

---

## Step 6 — Configure Offers

**Go to `/commercial/admin` in the deployed app** (requires admin role).

Create at least one offer per plan/market combination you intend to sell.
Example (illustrative only — the founder decides real amounts):

| Plan | Market | Currency | Amount (minor units) |
|---|---|---|---|
| PAID | GLOBAL | USD | *founder decides* |
| PAID | TZ | TZS | *founder decides* |

For TZS (exponent=0), the minor unit IS the TZS amount. For USD/GBP/EUR
(exponent=2), the minor unit is cents/pence.

Saving an offer with "purchasable" checked unblocks checkout for that
plan/market/currency combination only. **This is the
PRODUCT_PRICING_DECISION_REQUIRED gate.** Until an offer exists and is
purchasable for a requested plan/market:
- `commercial-create-checkout` returns 402 with `PRODUCT_PRICING_DECISION_REQUIRED`
- The upgrade button in Settings shows a "not yet available" state
- No customer can start checkout for that plan/market

---

## Step 7 — Smoke Test (manual)

1. Log in as a test user (not the admin)
2. Go to Settings → Plan & Billing
3. Click "Upgrade Plan" — verify the price shown matches the GLOBAL offer configured in Step 6
4. Verify you are redirected to Flutterwave hosted checkout
5. Complete a test payment using Flutterwave **test** credentials
6. Verify redirect back to `/billing/payment/return?ref=SAFF-...`
7. Verify the page polls and shows "Payment confirmed"
8. Go to Settings → Plan & Billing — licence status should show ACTIVE
9. As admin: go to `/commercial/admin` and verify the billing row is updated

---

## Architecture Safety Summary

### What cannot happen in this implementation

| Attack vector | Prevention |
|---|---|
| Browser sets `paid=true` | RLS: `commercial_licences` has `REVOKE UPDATE, DELETE FROM authenticated`. Only `commit_verified_commercial_payment()` SECURITY DEFINER can write. |
| Browser supplies price/currency | `commercial-create-checkout` accepts only `planCode`/`marketCode`; the offer (and its price) is resolved server-side via `resolve_commercial_offer()`. |
| Fake webhook grants licence | Gate A (constant-time verif-hash) + Gate B (independent Flutterwave API verify). Both must pass. |
| Tampered amount in webhook | Gate B compares `amountMinor` as `bigint` against the checkout intent's own snapshot — no float rounding, no re-read of a possibly-changed offer. |
| Replayed webhook double-commits | `uq_pe_provider_tx_id` unique index. Second commit returns `ALREADY_COMMITTED`. |
| Return page URL grants entitlement | `PaymentReturn.tsx` only polls `commercial-payment-status`. URL params are never trusted. |
| Payment grants accounting authority | `ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL` — no accounting table is referenced anywhere in this migration. |
| Reversal auto-mutates licence | `record_payment_reversal()` returns `REVIEW_REQUIRED`. No auto-mutation. Human review required. |
| Editing an offer rewrites history | Every checkout intent snapshots its own economic facts at creation time — an offer price change never touches an existing checkout or licence. |
| No eligible payment provider | `PAYMENT_PROVIDER_UNAVAILABLE` (HTTP 503) — never a fake checkout. |
| Second/third provider requires schema changes | Provider-neutral `ProviderAdapter` + `PaymentProviderCapabilities` routing. Adding Stripe = new adapter file + one capabilities declaration. No core table change. |

### OMEGA2_NORTH_STAR
Payment evidence (`payment_events.provider_transaction_id`,
`payment_webhook_receipts.idempotency_key`) is designed to feed a future
Standards Evidence Graph without collision. `NORTH_STAR_READY`.

---

## Rollback Procedure

Ω2-G uses only additive forward migrations. There is no automated rollback.

If a critical defect is found post-deploy:
1. Disable checkout: set an offer's `is_purchasable = false` via `/commercial/admin`
2. Disable Edge Functions: `supabase functions delete commercial-create-checkout`
3. Investigate and repair; re-deploy
4. **Never revert the migration** — the tables contain live customer records

---

## Known Pending Items (registered deferred debt — not Ω2-G blockers)

| Item | Gate | Required before this deploy? |
|---|---|---|
| Legal review of /terms and /privacy | LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE | Before accepting real paid customers — not before deploying/testing the payment architecture itself |
| Multi-company premium enforcement | MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION | **No.** Remains inactive/deferred. Not required to deploy or test Ω2-G's payment architecture. No trigger, RLS policy, or entitlement check in this migration enforces it. |
| Observability provider (Sentry etc.) | OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE | No |
| Settlement destination configuration | Explicitly out of scope this wave — see OMEGA2_FINAL_REPORT.md §12 | No — architecture is additive-ready for it, nothing to configure yet |
| A second provider (Stripe, for GB/EU markets) | Structurally proven ready; not built | No — Flutterwave alone is sufficient for the markets configured today |
| DEFECT-KINGA-MAPPING-TENANCY-001 | Separate task — not Ω2-G related | No |
| DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001 | V5 Phase 5 — not Ω2-G related | No |

The only items that gate this deploy are `PRODUCT_PRICING_DECISION_REQUIRED`
(Step 6) and the Flutterwave/legal/secret-handling checklist items above.
Everything in this table is registered debt to track, not a precondition
for shipping Ω2-G.

---

## Lovable's Minimum Work

After Codex certification, Lovable should only need to:

1. Sync certified GitHub main
2. Apply the certified Ω2-G migration semantics (Step 2 — managed path, never `supabase db push`)
3. Set provider secrets (Step 3)
4. Configure the Flutterwave webhook (Step 4)
5. Deploy the three Edge Functions (Step 5)
6. Configure founder-approved offers/prices (Step 6)
7. Run the sandbox payment acceptance smoke test (Step 7)
8. Bootstrap an explicitly-authorized real commercial admin, only if requested

Lovable must NOT invent prices, markets, providers, schema, payment logic,
or entitlement logic. Every one of those is either already decided in code
(schema, logic) or requires a human founder decision (prices, which
markets to sell into, whether/when to add a second provider).

---

*This document is the authoritative production handoff for Ω2-G. Corrections
happen through an explicit, auditable hardening pass like this one — not
casual inline edits. If a deployment step fails, raise a new defect rather
than editing this document ad hoc.*
