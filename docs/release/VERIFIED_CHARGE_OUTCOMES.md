# DEFECT-VERIFIED-CHARGE-DROPPED-001: a verified charge could be recorded nowhere

- **Severity:** high. Customer money was taken with no record, no entitlement and nothing for anyone to act on.
- **Status:** fixed in source by `20261102100000_verified_charge_outcomes.sql` (batch **commercial-p5**). **Pending hosted application:** see `COMMERCIAL_P5_LOVABLE_DELTA.md`.
- **Proofs:**
  - `scripts/db-proof/verifiedChargeOutcomes.mjs` (local, real PostgreSQL);
  - the CI payment journey group "An older Polar session paid after CFOClose closed its intent", which runs through the real Edge Functions against a mock Polar.

## 1. Provider facts that decide the design

| Provider | Can CFOClose cancel or expire a checkout on request? | Evidence |
|---|---|---|
| Polar | **No.** `PATCH /v1/checkouts/{id}` updates product, price, discounts, customer fields, metadata and URLs. It has no field for `expires_at`, `status`, cancelling or closing. A session ends on Polar's own `expires_at`, after which an `expired` session "is no more accessible". | [update session](https://polar.sh/docs/api-reference/checkouts/update-session), [create session](https://polar.sh/docs/api-reference/checkouts/create-session), read 2026-10-13 |
| Snippe | **No.** No cancel or void endpoint is documented. `voided` exists only as a status. Payments expire on Snippe's side: after 4 hours according to the payments page, 1 hour according to the webhooks page. | `SNIPPE_TZ_READINESS.md` §1 |

So a session cannot be closed from CFOClose. Any session CFOClose stops tracking may still be paid until the provider's own expiry. **The fix therefore has to guarantee an outcome in the ledger**, whatever state the intent is in when the money arrives.

## 2. Reproduction (before the change)

This is the real path, reproduced on real PostgreSQL and through the real functions in CI:
1. A card checkout is created, and its Polar session is open.
2. CFOClose's own one-hour intent expiry passes.
3. The customer starts again. The pending intent cannot be reused, so it goes to **manual review**, and the new attempt is blocked.
4. A commercial administrator resolves the review as **"confirmed uncharged, cancel"**. The intent becomes `CANCELLED`.
5. The customer starts a **replacement**.
6. The customer pays the **old** session, which Polar still accepts.
7. The webhook is authentic and the read-back verifies the payment. `commit_verified_commercial_payment` answers `INTENT_ALREADY_RESOLVED` and **writes nothing**: no payment event, no licence, no audit row. `settle.ts` reports it as `DUPLICATE`.

**A second, different successful transaction on an already-paid intent** was dropped the same way (`INTENT_ALREADY_RESOLVED` or `INTENT_ALREADY_PAID`).

## 3. Every verified charge now has exactly one outcome

| Situation when the verified success arrives | Outcome |
|---|---|
| The intent's own payment (`PENDING` or `MANUAL_REVIEW`, nothing recorded yet) | Unchanged: the term is placed, or the payment waits for placement review. |
| **Late payment.** **CFOClose** closed the intent (no provider-reported outcome exists for it), and **nothing replaced it** (no newer attempt for the same account and product) | **Placed by the normal rule.** The intent becomes `SUCCEEDED`, and the grant is audited with `late_payment_on_closed_intent = true`. |
| **A success that contradicts the provider.** The provider itself reported a failure, cancellation or expiry for the intent | **Never auto-placed.** Recorded once as an OPEN recovery case (`PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS`). |
| **Payment after a replacement started.** A newer attempt exists, whether open, in review or paid | **Recorded once:** a payment event with `placement = RECOVERY_REQUIRED` and no licence, an **OPEN `payment_recovery_cases`** row, and an audit row `VERIFIED_CHARGE_REQUIRES_RECOVERY`. No automatic second term. |
| **A second, different transaction on a paid intent** | The same: recorded once, as an OPEN recovery case. |
| The same provider transaction delivered again, under any key | `ALREADY_COMMITTED`. Nothing new. |
| A non-success reported after the intent closed | Nothing recorded: no money moved. Unchanged. |

**Race.** A commit and a replacement attempt for the same account and product are decided one after the other, under the acquisition lock. The 20-round race proof always lands on exactly one outcome:
- the payment is placed first, and the attempt becomes a new purchase; or
- the attempt is created first, and the payment becomes a recovery case.

It is never both and never neither.

**Reads.** `get_checkout_status`, `get_my_payments` and `admin_place_paid_licence` read only the intent's **own** payment. A recovery payment is never shown or placed as if it were that payment. A refund webhook now binds to the payment its own transaction recorded, so an intent holding two payments can never refund the wrong one.

## 4. Administrator resolution

**Where:** `/commercial/admin` → Payments needing attention → **Charges needing a decision** (`admin_list_payment_recovery_cases`, `admin_resolve_payment_recovery`).

| Resolution | When it is allowed | Effect |
|---|---|---|
| **Place as an additional term** | A production payment with no refund recorded, **the customer's recorded agreement to receive another term** (how and when they agreed), and a placement the **current rule** allows | Placed exactly as a verified payment would be: renewal queued at the end, downgrade at renewal, upgrade from now. Every `BLOCKED_*` result refuses it: an open-ended agreement, a queued term, or paid additional named users. Provenance `PRODUCTION_PAYMENT`. The agreement and the placement are audited. |
| **Mark refunded** | Refunds recorded against **that** payment cover it in full. For Polar, the refund is made in Polar and arrives by webhook. For Snippe, it is recorded with `admin_record_provider_refund`. | The case closes. The original purchase's licence is untouched. |
| **Close test payment** | A sandbox payment, which moved no money | The case closes. A sandbox payment can never be placed as a term. |

**An unintended second charge never silently becomes a renewal.** Without the customer's recorded agreement, the only way to close the case is a refund. An unknown resolution, a blank reason, or a test-payment closure of a production payment are all refused, and the case stays OPEN.

Each case is **resolved once and audited** (`PAYMENT_RECOVERY_RESOLVED`). Cases are permanent and their facts are fixed: a direct update or delete is refused, even by the table owner. Clients cannot read the table.

## 5. Historical dropped charges: discoverable, not recovered automatically

**This forward fix does not recover charges dropped before it was applied.** They need an explicit, separately approved decision.

**Discoverable in CFOClose's own records:**
- When the old commit dropped a charge that arrived by webhook, the endpoint logged a processing event `DUPLICATE`, with the provider transaction id and the order reference.
- No payment event exists for that transaction.
- The commercial-p5 preflight, section 1b, lists exactly these. The proof finds one in the endpoint's own record shape.

**Discoverable only at the provider:**
- A charge whose webhook never reached CFOClose leaves no trace here. It appears only in Polar's orders or Snippe's payments.
- Finding it means comparing those with `payment_events`. That is a manual reconciliation, and nothing here automates it.

**Not re-verifiable in the app:** the in-app payment verification (`claim_verification_attempt`) accepts only open orders, so a closed order is never re-checked by it.

## 6. Refunds bind to the exact provider transaction

- **Webhooks:** a refund webhook finds the payment its **own** transaction recorded (`settle.ts` looks the payment up by provider transaction id, then checks the intent and provider match). It is never "the intent's payment".
- **Two charges on one intent:** with the original and a recovery payment present, a refund of the second records against the second only. The first's refunded total stays 0, the licence is untouched, and the case closes `REFUNDED`. This is proven on real PostgreSQL and in the unit tests.
- **Cumulative bounds:** the commercial-p4 rules apply per payment.

## 7. Preventing unmanaged sessions

- **A replacement never silently abandons a payable session.** A pending intent that can't be reused still goes to review and blocks a new attempt, as before.
- **Closing a review is now safe.** Once an administrator has closed it, any later payment on the old session reaches an outcome through §3.
- **Exposure is reported.** The hosted preflight lists every intent CFOClose closed with no provider-reported outcome while a provider session existed. Those sessions may still be payable until the provider's expiry.

## 8. Proof

| Proof | Kind | Result |
|---|---|---|
| `verifiedChargeOutcomes.mjs` | Local, real PostgreSQL | **26/26** |
| The CI payment journey: the old Polar session paid after review and a replacement; the replacement paid; redeliveries; the administrator's resolution | Real Edge Functions, mock Polar, local Supabase | CI (`real-app-e2e`) |
| `selfCheckingWrappers` with `RELEASE_BATCH=commercial-p5` (32); on the new chain `paymentProviders` 43, `snippeLedger` 30, `paidTermPreservation` 18, `sandboxLicenceIsolation` 45, `paymentReversalAuthority` 38, `p4HostedBaseline` 19, `annualTerm` 91. Three older checks that said a later success "grants nothing" now also prove it is recorded once for recovery. | Local, real PostgreSQL | PASS |
| A real Polar or Snippe late payment | Provider | **NOT RUN.** No charge was made. |
