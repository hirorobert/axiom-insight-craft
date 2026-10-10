# Refunds, disputes and payment recovery (Polar card payments)

**Scope:** the launch route, which is card payments through Polar (USD; Polar is merchant of record). Mobile money (Snippe) is not launched. Provider facts are in `PAYMENT_PROVIDER_EVIDENCE.md` §3a and §3b. The administrator screen is described in `docs/operations/COMMERCIAL_ADMIN_GUIDE.md` §5a.

**The rule behind every procedure below:** CFOClose access comes only from a CFOClose licence.
- A refund, a dispute or a Polar setting never changes a licence by itself.
- Polar being merchant of record makes Polar the seller and responsible for tax. It does **not** decide CFOClose access.
- Access after a refund or dispute is the **owner's access policy**, applied by a commercial administrator, with a recorded reason.

## 1. What is automated, what is manual, and what is not supported

| Situation | Handling | What is recorded | Effect on access |
|---|---|---|---|
| Polar notification delivered on time | **Automated** | Signed receipt, then provider read, then one payment event and at most one licence (`commit_verified_commercial_payment`, idempotency key `sha256(provider:transaction:intent)`) | The 12-month term starts as placed (§3) |
| Notification redelivered, or sent concurrently | **Automated** | `DUPLICATE` (same event id), or the same commit (`ALREADY_COMMITTED`) | None. No second event, licence or charge. |
| Notification **delayed** past the 5-minute signature window, or redelivered later from Polar's dashboard | **Automated** | `STALE_TIMESTAMP` receipt, then a read of Polar's own order, then the same commit (`reconciled: true`). At most one read a minute per order. | Same as on time. The delivery's body is never trusted. |
| Notification **missing** (endpoint disabled, network) | **Automated** fallback, then **manual** | The customer's status page check, or the administrator's **Check with the provider**: the same provider read | Same as on time |
| Polar did not answer, or the outcome is uncertain | **Manual** | Listed under **Payments needing attention** | None until resolved |
| Paid, but the term cannot be placed automatically (open-ended agreement; upgrade over a queued term; upgrade over **additional named users**, `BLOCKED_SEATS`) | **Manual** | Payment recorded once; intent `MANUAL_REVIEW`; listed for placement | None until an administrator places the paid term |
| Full or partial **refund** (by us in Polar, or by Polar itself) | **Automated recording**, then **manual decision** | A REFUND reversal for the **new** amount only (cumulative refunded amount minus what is already recorded). Redelivery records nothing. | **None automatically.** An administrator decides. |
| **Dispute or chargeback** | **Manual.** Polar documents no dispute webhook. | Nothing automatic. If Polar refunds early to head off a chargeback, that arrives as a refund. | **None automatically.** An administrator decides. |
| Polar "revoke benefits" on refund | **Not applicable.** CFOClose configures no Polar benefits. | — | None |
| Pro-rata refund of an upgraded plan's unused time | **Not supported** automatically | — | Arranged manually, if the owner's policy offers it |
| Automatic renewal or subscription cancellation | **Not applicable.** Every purchase is one 12-month term, with no provider subscription. | — | — |

## 2. Procedures

### 2.1 "I paid but have no access" (payment recovery)

1. Find the order: `/commercial/admin` → **Payments needing attention**, or the customer's reference under **Your orders**.
2. Select **Check with the provider**. This reads Polar's order and never charges.
   - If Polar shows it paid, it settles exactly once.
   - If Polar shows it failed or expired, the order closes so. If it is still open, nothing changes.
3. If the order is now **paid, term not placed**, follow §2.4.
4. If Polar still does not answer, try later. Never ask the customer to pay again while the outcome is uncertain.
5. If a Polar webhook endpoint was **disabled** after repeated failures, re-enable it in Polar's webhook settings. Optionally redeliver the failed deliveries from Polar's dashboard: a redelivery is recovered safely even when its timestamp is old.

### 2.2 Refund

1. Decide under the owner's refund policy, and issue the refund in **Polar's dashboard → the order → Refund order**. Partial refunds are allowed; Polar prorates tax and keeps its fees.
2. Polar's notification is recorded automatically. If it does not arrive, use **Check with the provider** on the order.
3. Under **Payments needing attention → Refunds and disputes**, the reversal appears with its amount.
4. If access should end, end the licence under **Accounts**: **End now** for a current term, or **Cancel (not started)** for a future one.
5. Record the decision: **Record: licence ended** or **Record: licence kept**, with a reason (`admin_record_reversal_review`). Recording the decision does not itself end a licence; step 4 does. Each reversal is decided once.

### 2.3 Dispute or chargeback

1. Watch Polar's dashboard: disputes are **not** reported to CFOClose. Polar charges USD 15 per dispute and monitors a 0.4% chargeback target.
2. Respond as Polar asks. If Polar refunds, §2.2 applies from step 2.
3. If the disputed payment is not refunded but access should end, end the licence under **Accounts** with a reason naming the dispute. The audit trail holds the reason.

### 2.4 Paid term waiting for placement

1. **Open-ended agreement:** end it under **Accounts** first.
2. **Additional named users (`BLOCKED_SEATS`):** agree with the customer how they carry into the new plan. Place the term, then set the additional users under **Accounts**.
3. **Place the paid 12-month term**, with a start date and a reason (`admin_place_paid_licence`). Review can never cancel an order whose payment is recorded.

### 2.5 Duplicate charge

Each order records at most one payment, so a customer can be charged twice only through two separate orders.
1. Refund the extra order in Polar.
2. Record the decision as in §2.2.

## 3. How paid terms are placed

| Purchase | Placement | Additional named users |
|---|---|---|
| New | Starts when the payment is verified | — |
| Renewal (same plan) | Starts exactly when the current term ends | The current term keeps its own until it ends; the new term starts with none |
| Downgrade | Starts when the current term ends | As for renewal |
| Upgrade, no additional users | Starts now; the current term ends now | — |
| Upgrade over additional users | **Not placed automatically** (`BLOCKED_SEATS`), and not sold online | Untouched until an administrator places it |

The same 12 months are guaranteed under retries, concurrency and manual activation:
- One payment gives one event and at most one licence.
- A manual grant never overlaps or shortens a paid term.
- Unrelated accounts and entitlements are untouched.
- The financial-reporting pilot stays restricted to its rollout list.

Evidence: `scripts/db-proof/paidTermPreservation.mjs` (18 assertions, real PostgreSQL) and `scripts/db-proof/paymentProviders.mjs`.

## 4. Evidence and its limits

| Evidence | Kind | What it proves |
|---|---|---|
| `scripts/db-proof/paymentProviders.mjs`, `paidTermPreservation.mjs` | Real PostgreSQL, local and CI | The database authority: idempotency, placement, refunds recorded for review, concurrency |
| `providerAdapters.test.ts` | **Mock** HTTP | Polar signature verification, the stale path, refund change amounts |
| `scripts/e2e/paymentJourney.mjs` (CI `real-app-e2e`) | Local app and functions, **mock** Polar | Delayed notification recovered once; partial then full refund recorded as 200.00 then 290.00; redelivery records nothing |
| Polar sandbox | **Sandbox** | **NOT RUN.** It needs sandbox credentials (owner). |
| Live | **Controlled live** | **NOT RUN.** It needs merchant approval and the owner's authorisation of each charge. |

Mock evidence proves our handling of the documented behaviour. It does not prove Polar's real behaviour, in particular whether retries are re-signed. The sandbox stage (checklist Stage D) is where that is first observed.
