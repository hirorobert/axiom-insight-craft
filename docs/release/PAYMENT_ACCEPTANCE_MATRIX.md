# Consolidated payment acceptance matrix: Polar card and Snippe mobile money

- **Scope:** both intended launch routes. Public payments stay `PAYMENTS_DISABLED` until every row marked *launch-blocking* passes.
- **Baseline:** main `7d28d12` (PR #126, tree identical to the tested head `b77587e`).
- **Integration owner:** the "POLAR AND SNIPPE" Claude Code session. Hosted configuration goes through Lovable; shared payment screens through the MEGA REDESIGN workstream.

**Every test is PENDING** until its own evidence (environment, date, commit and records) is added to this table. CI coverage and earlier hosted deployments are supporting evidence, not acceptance. The dated history of earlier hosted deployments is in `PAYMENT_LAUNCH_HANDOFF.md`, and it does not prove current launch readiness.

Evidence kinds:
- **CI** means the mock-provider journey and the real-PostgreSQL proofs run on every commit.
- **Staging** means `hplriydtdelehepgttul` with provider test facilities.
- **Live** means production, `LIVE_ACCEPTANCE`, the designated tester only, and a separately authorised real charge.

## Provider test facilities (checked 2026-10-14)

| Provider | Test facility | Consequence |
|---|---|---|
| Polar | A separate sandbox (`sandbox.polar.sh`, `sandbox-api.polar.sh`), test cards, and refunds from the sandbox dashboard | Purchase and refund are tested on staging with no real money |
| Snippe | **None documented.** The [authentication](https://docs.snippe.sh/docs/2026-01-25/authentication) and [payments](https://docs.snippe.sh/docs/2026-01-25/payments) pages give no sandbox host, test key prefix, test phone numbers or test marker on a payment, and **no refund or reversal API**. The networks listed are M-Pesa, Airtel Money, Mixx by Yas and Halotel. | Every Snippe provider row is a **real charge** in production. Refund is **unconfirmed**: it is possible only if Snippe confirms a refund procedure in writing, and it is recorded with `admin_record_provider_refund`. |

## Matrix

| # | Case | Route | Environment | Expected result (verified in the database and on the customer pages) | Existing evidence | Acceptance |
|---|---|---|---|---|---|---|
| P1 | Card purchase | Polar | Staging sandbox | The checkout carries the server's USD offer. Polar's hosted page is paid with a test card. The signed `order.paid` webhook is read back from Polar. One `PAYMENT_CONFIRMED` event. Licence status `SANDBOX`; the account still has **no plan**. The status page says "Test payment received". | CI journey (mock Polar) | **PENDING**: Blocked: staging schema and Polar sandbox secrets |
| P2 | Card refund | Polar | Staging sandbox | The refund is issued in Polar's sandbox dashboard. The `refund.*` or `order.refunded` webhook records one `REFUND` event. The reversal appears in `/commercial/admin` for a single audited decision. The Orders page shows "Refunded". | CI (mock), `paymentReversalAuthority.mjs` | **PENDING**: Blocked: needs P1 |
| P3 | Duplicate and forged notifications | Polar | Staging sandbox | Resending the same webhook, a bad signature and a stale timestamp each change nothing: still one event and one licence. | CI journey (5 concurrent deliveries, replay, bad signature, stale) | **PENDING**: Covered in CI; repeat once on staging |
| P4 | Verified production payment grants access automatically | Polar | Live | `LIVE_ACCEPTANCE` is set and the tester is allow-listed. **One real Solo purchase at USD 490.** One ACTIVE licence, `POLAR_VERIFIED_PAYMENT`, 12-month term. The account gets Solo access. Any other account is refused. | `paymentProviders.mjs` (LIVE_ACCEPTANCE rule) | **PENDING**: **Requires the owner to authorise that specific charge** |
| P5 | Production refund | Polar | Live | P4's order is refunded in Polar production. One `REFUND` event. The administrator ends access or keeps it, recorded once. | `paymentReversalAuthority.mjs` | **PENDING**: Requires the owner to authorise it |
| S1 | Mobile-money purchase | Snippe | Live (no sandbox exists) | A USSD push for **exactly the approved TZS Solo price** (no USD conversion; minimum 500 TZS). Confirmed on the handset. The signed `payment.completed` webhook is read back from Snippe. One ACTIVE licence, `SNIPPE_VERIFIED_PAYMENT`, 12-month term. | `snippeLedger.mjs` 30/30; CI journey (mock Snippe) | **PENDING**: **Blocked**: code gate, TZS prices, merchant activation and credentials; real-charge authorisation |
| S2 | Pending payment | Snippe | Live | The push is not answered. The status page keeps polling and shows pending, with no licence. After Snippe's expiry (1 h or 4 h, unconfirmed) the order shows `expired`, with no licence. | `snippeLedger.mjs` (pending and expired grant nothing) | **PENDING**: Blocked, as for S1. **No charge if it is left unanswered.** |
| S3 | Failed payment | Snippe | Live | The push is declined on the handset (or the balance is too low). The order is `failed`, with no licence, and the customer can start again. | `snippeLedger.mjs` | **PENDING**: Blocked, as for S1. **No charge.** |
| S4 | Reversal or refund | Snippe | Live | **Only if Snippe confirms a refund procedure in writing.** The refund is completed outside CFOClose, then an administrator records it with `admin_record_provider_refund` and makes the licence decision, audited. | `paymentReversalAuthority.mjs` (recording only) | **PENDING**: **Blocked**: Snippe documents no refund (readiness §4 #5) |
| S5 | Duplicate and forged notifications | Snippe | CI; repeated on live S1 | A replay, a forged signature, a stale capture, an unknown reference and 5 concurrent deliveries each change nothing. | CI journey (5 Snippe abuse checks) | **PENDING**: Covered in CI |
| X1 | Sandbox never grants production access | Both | Staging, CI | A sandbox payment produces `SANDBOX`, never ACTIVE, and never places a term. A sandbox adapter never settles a production order. **For Snippe the "sandbox" label is CFOClose configuration only; it is not provider isolation.** | `sandboxLicenceIsolation.mjs` 45/45 | **PENDING**: Polar: verify on P1. Snippe: no provider sandbox. |
| X2 | Correct prices and currencies | Both | Staging, Live | Polar charges the approved USD amount (490, 990 or 2,990) and Polar's order net equals the offer. Snippe charges the approved TZS amount exactly. No USD-to-TZS conversion. A mismatched amount or currency is refused and nothing is written. | `paymentProviders.mjs`, `snippeLedger.mjs` | **PENDING**: TZS prices not approved |
| X3 | Account isolation | Both | CI, Staging | Another account's order is "not found". `create_entity` without a plan, another account's company and the administrator screen are all refused by the server. | CI journey (cross-account denial) | **PENDING**: Covered in CI; repeat on staging |
| X4 | Seat and entity limits | Both | CI, Staging | Each plan's advertised named users and entities are enforced. Upgrading over the extra users goes to review (`BLOCKED_SEATS`). Paid terms and paid extra users are preserved. | `entitlements.mjs`, `paidTermPreservation.mjs`, `planCapabilities.mjs` | **PENDING**: Covered in CI; repeat on staging |
| X5 | One attempt at a time; terms never overlap | Both | CI | One payment attempt at a time per account across Polar and Snippe. A Polar term followed by a Snippe term never overlaps. | `snippeLedger.mjs` | **PENDING**: Covered in CI |
| X6 | Payment and outcome screens | Both | Staging, Live | Checkout, pending, confirmation, failure, refunded and "not found" states, at 1280 and 375 px. | `paymentScreens.test.ts`; CI journey | **PENDING**: Shared with MEGA REDESIGN; re-run after any screen change |

## Launch rule

`CUSTOMER_PAYMENTS_ENABLED` uses the audited platform transition. It is applied only after P1–P5 pass, and either:
- S1–S5 pass, or
- the owner removes Snippe from this launch in writing.
