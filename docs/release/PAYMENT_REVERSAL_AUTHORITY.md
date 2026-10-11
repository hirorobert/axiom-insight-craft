# DEFECT-PAYMENT-REVERSAL-UNBOUND-001: payment reversals were unbounded

- **Severity:** medium. It affected the integrity of financial records, not access: a reversal never changed a licence.
- **Status:** fixed in source by `20261101100000_payment_reversal_authority.sql` (batch **commercial-p4**). **Pending hosted application:** see `COMMERCIAL_P4_LOVABLE_DELTA.md`.
- **Proof:** `scripts/db-proof/paymentReversalAuthority.mjs`, on local real PostgreSQL. Its results are in §6.

## 1. Reproduction (real PostgreSQL, before the change)

`record_payment_reversal` (live since `20260906083524`; service role) recorded all of these:
- a refund of a **failed** payment;
- a refund in **another currency**;
- a refund of a **zero or negative** amount;
- a refund reported by **another provider**;
- refunds totalling **more than was paid** (80,000 against 49,000).

Separately, `admin_record_reversal_review` with the decision `LICENCE_ENDED` **only recorded the words**: the licence kept granting access.

## 2. The rules now (`_record_payment_reversal_core`, the one writer of REFUND and CHARGEBACK events)

| Rule | Refusal |
|---|---|
| The original is a `PAYMENT_CONFIRMED` event with `normalized_status = SUCCEEDED` and a positive amount | `REVERSAL_ORIGINAL_NOT_FOUND`, `REVERSAL_ORIGINAL_NOT_A_CONFIRMED_PAYMENT` |
| Same provider as the original | `REVERSAL_PROVIDER_MISMATCH` |
| Same currency as the original | `REVERSAL_CURRENCY_MISMATCH` |
| A positive whole amount in minor units | `REVERSAL_AMOUNT_INVALID` |
| All reversals of the payment together never exceed what was paid | `REVERSAL_EXCEEDS_PAYMENT` |
| Idempotency: a replay with the same facts answers `ALREADY_RECORDED`; the same key with different facts is refused | `REVERSAL_IDEMPOTENCY_KEY_REUSED` |
| One provider refund reference is recorded once | `REVERSAL_PROVIDER_REFERENCE_ALREADY_RECORDED` |
| Concurrency: every reversal of one payment is decided under one advisory lock | Proven: 10 simultaneous 30% refunds record exactly 3 |

Each recorded reversal carries:
- `reversed_before_minor`, `reversed_after_minor` and `paid_minor`;
- its `source`: `PROVIDER_REPORTED` or `ADMIN_RECORDED_PROVIDER_REFUND`.

**Webhooks:** a reversal the ledger refuses is a definite answer. The webhook records it as `CURRENCY_MISMATCH`, `AMOUNT_MISMATCH`, `MERCHANT_MISMATCH` or `REFERENCE_MISMATCH`. It is never an `ERROR` that makes the provider redeliver forever (`settle.ts`).

## 3. History: preserved, reported, never rewritten

- **Nothing changes in place.** The migration changes no table, column or row, and `payment_events` stays append-only.
- **Discrepancies are reported.** `admin_list_reversal_discrepancies()` lists every existing reversal the new rules would refuse, for commercial administrators only. Each row names its issues:
  - `ORIGINAL_MISSING`;
  - `ORIGINAL_NOT_A_CONFIRMED_PAYMENT`;
  - `PROVIDER_MISMATCH`;
  - `CURRENCY_MISMATCH`;
  - `AMOUNT_NOT_POSITIVE`;
  - `CUMULATIVE_EXCEEDS_PAYMENT`.
- **Hosted check:** the hosted preflight and postcondition print the same list, so it can be compared before and after.
- **Correction:** a historical discrepancy is corrected, if at all, by an owner decision recorded as a new event. Nothing is edited.

## 4. A licence decision now takes effect

`LICENCE_ENDED`, from `admin_record_reversal_review` or from the refund workflow below:
- **A current term** ends now: status `CANCELLED`, `effective_end` = now. A paid term may always end earlier.
- **A term that has not started** is cancelled with its dates kept.
- **Audit:** each is recorded as `LICENCE_ENDED_AFTER_REVERSAL`, with the previous and new state.

`LICENCE_KEPT` changes nothing. Each reversal is decided **once**. The admin screen's buttons now say what they do: "End the licence now" and "Keep the licence".

## 5. Snippe refunds: the administrator workflow

**Recording a refund is not issuing one.** CFOClose never issues, initiates or requests a refund, and `admin_record_provider_refund` moves no money. It only **records**, after the fact, a refund that has **already been completed outside CFOClose**, from the provider's own evidence.

**What Snippe supports is not known.** Snippe documents no refund API, no refund event and no refund procedure, so it is **not confirmed** that Snippe can refund a mobile-money collection at all, or how: by dashboard, by support or by any other route. That is a provider prerequisite (`SNIPPE_TZ_READINESS.md` §4 #5). Until Snippe confirms it in writing, there is no supported way to issue a Snippe refund. A customer refund would have to be made by whatever means the owner and Snippe agree, and then recorded here.

**Nothing reaches CFOClose by itself.** However a refund is completed, it exists here only once a commercial administrator records it with `admin_record_provider_refund`, in one audited transaction:
1. **Who:** an active commercial administrator, with a recorded reason.
2. **What:** a **production** Snippe payment. It refuses Polar, which reports its own refunds, so recording one by hand would count it twice. It also refuses sandbox payments, which moved no money.
3. **Evidence:**
   - Snippe's own **refund reference**, which can be recorded only once;
   - the evidence kind, meaning where the completed refund was **seen**. It is not a claim about how the refund was made:
     - `PROVIDER_DASHBOARD`: the provider's account view shows it;
     - `PROVIDER_SUPPORT_CONFIRMATION`: written confirmation from the provider;
     - `SETTLEMENT_REPORT`: it appears in a settlement report;
   - a note of at least 10 characters;
   - optionally, the SHA-256 of a saved document.
4. **Reconciliation:** the amount is bounded by §2. The answer gives `reversed_minor`, `paid_minor` and `fully_reversed`.
5. **Licence access:** decided explicitly, `LICENCE_ENDED` or `LICENCE_KEPT`, in the same transaction (§4).
6. **Audit:**
   - `REVERSAL_REQUIRES_REVIEW`;
   - `REVERSAL_REVIEWED`, with the licence effect;
   - `PROVIDER_REFUND_RECORDED_BY_ADMIN`, with the reference and evidence;
   - `LICENCE_ENDED_AFTER_REVERSAL` when access ends.

**How to call it.** There is no screen yet; that is listed as remaining work. Use the SQL editor, as the administrator:

```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<commercial admin auth.users.id>","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.admin_record_provider_refund(
  '<payment_events.id of the PAYMENT_CONFIRMED event>', <amount in TZS>, 'TZS',
  '<Snippe refund reference>', 'PROVIDER_DASHBOARD', '<what was seen, where and when>', NULL,
  'LICENCE_ENDED',            -- or 'LICENCE_KEPT'
  '<reason>', gen_random_uuid());
COMMIT;
```

Keep the idempotency key if you may retry: a retry with the same key and the same facts records nothing twice.

**Before calling it:**
- the refund must already be **complete** at the provider, with a reference the provider issued;
- the amount must be exactly what was returned;
- the licence decision must be the owner's.

Calling it does **not** contact Snippe and does not return money to anyone.

## 6. Proof

| Proof | Kind | Result |
|---|---|---|
| `paymentReversalAuthority.mjs`: the reproduction; the migration with history present; history byte-identical; discrepancies reported; every bound; idempotency; concurrency; the Snippe workflow; review decisions taking effect | Local, real PostgreSQL | **38/38** |
| `selfCheckingWrappers.mjs` with `RELEASE_BATCH=commercial-p4`: refusals before any statement, injected failures rolled back, the hosted-executor model, re-application refused, the read-only postcondition | Local, real PostgreSQL | **32/32** |
| On the new chain: `paymentProviders` 43/43 (its refund check now also proves `LICENCE_ENDED` ends access), `paidTermPreservation` 18/18, `sandboxLicenceIsolation` 45/45, `snippeLedger` 30/30, `annualTerm` 91/91 | Local, real PostgreSQL | PASS |
| A real Snippe refund recorded end to end | Provider and hosted | **NOT RUN** |
