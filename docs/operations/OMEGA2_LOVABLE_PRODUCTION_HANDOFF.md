# SAFF ERP — Ω2 Commercial Engine: Lovable Production Handoff

- **Branch:** `omega2-commercial-engine-20260905` (superseded by the hardening commit named below — see Candidate SHA Note)
- **Wave:** Ω2 — Real Payments + Premium Entitlement + Commercial Operations
- **Date:** 2026-09-05
- **Author:** SALIO CONNECT (mdcmclimited@gmail.com)

> **Candidate SHA Note (Ω1-Ω2 handoff hardening, 2026-09-05):** an earlier
> draft of this document hardcoded `Candidate SHA: b71a4b9c34d678b1c2b4c940e47c69595325fd8e`.
> That commit contains all Ω2 source but predates this document's own
> content. The commit that was supposed to add this document
> (`628c4e4252d62d62e0a7ef026bcbb4d427204aaf`) is empty — the files were
> never staged before it was created — so it must NOT be cited as the
> candidate; it adds nothing over `b71a4b9`. A document cannot correctly
> name its own commit's hash before that commit exists, so this file
> intentionally does not hardcode one. **The single canonical candidate is
> whichever commit this file is committed in** — obtain it with
> `git log -1 --format=%H -- docs/operations/OMEGA2_LOVABLE_PRODUCTION_HANDOFF.md`
> or from the hardening pass's own final report. Do not certify against
> `b71a4b9` or `628c4e4` directly; certify against that commit.

> **STATUS: SOURCE CANDIDATE — NOT YET DEPLOYED.**
>
> No migration has been applied. No Edge Function has been deployed.
> No production secret has been set. No live mutation has occurred.
> The founder must complete every step below in order.

---

## Pre-Flight Checklist (founder must verify each item)

- [ ] Legal review of `/terms` and `/privacy` is complete before taking real paid production customers (LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE)
- [ ] Flutterwave TEST credentials are configured for the Step 7 smoke test
- [ ] Flutterwave account KYB/KYC is approved for Tanzania before accepting LIVE (real-money) payments
- [ ] Plan prices are decided (PRODUCT_PRICING_DECISION_REQUIRED — prices are NULL in migration; do not invent one)
- [ ] Return URL in Flutterwave dashboard is set: `https://<your-domain>/billing/payment/return`
- [ ] Provider secrets (`FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_SECRET`) are set only in Supabase Dashboard → Edge Functions → Secrets — never committed to git, never placed in any repo file

**Not required for this checklist:** MULTI_COMPANY premium enforcement.
That policy is deferred (see "Known Pending Items" below) and is
explicitly NOT required to deploy or test Ω2's single-company payment
architecture — it stays inactive regardless of this deployment.

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
(the RLS1 migration was recorded live under a different, Lovable-assigned
timestamp than its filename in this repo — see `4844937f`'s history).
Running `supabase db push` replays the FULL local migration history
against the live database from whatever baseline the CLI believes it is
at, which risks re-applying or reconciling migrations Lovable has already
recorded under its own identity. That is not safe here.

**Controlled rule:** Lovable applies ONLY the certified Ω2 forward
migration's semantics — the exact CREATE/ALTER/INSERT statements in
`supabase/migrations/20260905200000_omega2_commercial_payments.sql` —
through its own managed migration path (its dashboard's migration
runner, or an equivalent controlled single-file apply), the same way it
already applied the Ω1 and RLS1 migrations.

Explicitly prohibited for this handoff:
- **No blanket `supabase db push`** against production.
- **No replay of repository migration history** (Ω1, RLS1, or any prior
  migration file) — those are already live under Lovable's own recorded
  identity; re-running them from the repo's filenames risks a duplicate
  or conflicting application.
- **No migration-history normalization** (do not attempt to make
  Lovable's recorded migration timestamps match this repo's filenames —
  they are allowed to differ; only the resulting schema must match).
- **No manual replay of the Ω1 (`20260904180000`) or RLS1
  (`20260905120000`) migrations** — they are already live.

The canonical Ω2 migration file remains
`supabase/migrations/20260905200000_omega2_commercial_payments.sql`.
Lovable may record it live under a different managed timestamp/identity —
that is expected and acceptable, exactly as happened for Ω1 and RLS1.
What must match is the resulting schema (tables, columns, functions,
constraints, RLS policies), not the migration's recorded filename.

This is a forward-only migration. It extends Ω1 tables and creates new ones.
**Never apply it more than once. Never reverse it manually.**

Verify after applying:
```sql
-- In Supabase SQL editor:
SELECT plan_code, price_amount_minor, is_purchasable FROM commercial_plans;
-- Expected: price_amount_minor IS NULL, is_purchasable = false (founder must set these)

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name IN (
  'commit_verified_commercial_payment',
  'record_payment_reversal',
  'get_checkout_status',
  'admin_get_billing_detail'
);
-- Expected: 4 rows
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

## Step 6 — Set Plan Prices

**Go to `/commercial/admin` in the deployed app** (requires admin role).

Set `price_amount_minor` for each plan. For TZS with exponent=0, the minor unit IS the TZS amount:
- 450,000 TZS annual → enter `450000`
- 50,000 TZS monthly → enter `50000`

Saving a price also sets `is_purchasable = true`, which unblocks the checkout flow.

**This is the PRODUCT_PRICING_DECISION_REQUIRED gate.** Until prices are set:
- `commercial-create-checkout` returns 402 with `PRODUCT_PRICING_DECISION_REQUIRED`
- The upgrade button in Settings shows a toast error
- No customer can start checkout

---

## Step 7 — Smoke Test (manual)

1. Log in as a test user (not the admin)
2. Go to Settings → Plan & Billing
3. Click "Upgrade Plan"
4. Verify you are redirected to Flutterwave hosted checkout (card + mobilemoneytzania)
5. Complete a test payment using Flutterwave test credentials
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
| Fake webhook grants licence | Gate A (constant-time verif-hash) + Gate B (independent Flutterwave API verify). Both must pass. |
| Tampered amount in webhook | Gate B compares `amountMinor` as `bigint` — no float rounding. |
| Replayed webhook double-commits | `uq_pe_provider_tx_id` unique index. Second commit returns `ALREADY_COMMITTED`. |
| Return page URL grants entitlement | `PaymentReturn.tsx` only polls `commercial-payment-status`. URL params are never trusted. |
| Payment grants accounting authority | `ACCOUNTING_TABLES_NEVER_TOUCHED_BY_COMMERCIAL` — `tax_computations`, `engine_runs`, `statement_sign_offs` are never touched by any commercial operation. |
| Reversal auto-mutates licence | `record_payment_reversal()` returns `REVIEW_REQUIRED`. No auto-mutation. Human review required. |
| Second provider requires schema changes | Provider-neutral `ProviderAdapter` interface. Adding Pesapal = new adapter file only. |

### OMEGA2_NORTH_STAR
Payment evidence (`payment_events.provider_transaction_id`, `payment_webhook_receipts.idempotency_key`) is designed to feed a future Standards Evidence Graph without collision. `NORTH_STAR_READY`.

---

## Rollback Procedure

Ω2 uses only additive forward migrations. There is no automated rollback.

If a critical defect is found post-deploy:
1. Disable checkout: set `is_purchasable = false` on all plans via `/commercial/admin`
2. Disable Edge Functions: `supabase functions delete commercial-create-checkout`
3. Investigate and repair; re-deploy
4. **Never revert the migration** — the tables contain live customer records

---

## Known Pending Items (registered deferred debt — not Ω2 blockers)

| Item | Gate | Required before this deploy? |
|---|---|---|
| Legal review of /terms and /privacy | LEGAL_PROFESSIONAL_REVIEW_REQUIRED_BEFORE_PAID_GO_LIVE | Before accepting real paid customers — not before deploying/testing the payment architecture itself |
| Multi-company premium enforcement | MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION | **No.** Remains inactive/deferred. Not required to deploy or test Ω2's single-company payment architecture. No trigger, RLS policy, or entitlement check in this migration enforces it — do not activate it as part of this handoff. |
| Observability provider (Sentry etc.) | OBSERVABILITY_PROVIDER_WIRING_DEFERRED_TO_Ω2/PRE-GO-LIVE | No |
| DEFECT-KINGA-MAPPING-TENANCY-001 | Separate task — not Ω2 related | No |
| DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001 | V5 Phase 5 — not Ω2 related | No |

The only items that gate this deploy are `PRODUCT_PRICING_DECISION_REQUIRED`
(Step 6) and the Flutterwave/legal/secret-handling checklist items above.
Everything in this table is registered debt to track, not a precondition
for shipping Ω2.

---

*This document is the authoritative production handoff for Ω2. Do not modify it retroactively. If a step fails, raise a new defect rather than editing this document.*
