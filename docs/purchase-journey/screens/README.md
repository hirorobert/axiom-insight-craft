# Purchase journey: browser evidence (PR #183)

Captured by `scripts/e2e/paymentJourney.mjs` in CI job *Real application end to end (local Supabase stack)*:

- **Source commit:** `aeca6344dcf7ed1d079c2420e36b1e20d4712796`
- **Run:** [39469468405](https://github.com/hirorobert/axiom-insight-craft/actions/runs/39469468405), artifact `real-app-evidence/payments`
- **Journey result:** 67/67 assertions passed

That run was marked failed only because the inertness guard compared against a stale base. `main` was merged afterwards; the code behind every screen is unchanged by that merge.

**Classification:** a local application, database and Edge Functions, with a **mock** Polar and Snippe on loopback. No provider was contacted and no money moved.

Widths are 1280 px (desktop) and 375 px (mobile).

| File | What it shows |
|---|---|
| `21-checkout-*` | The checkout page: test-mode notice, the route choice, "Continue to payment". The **mobile money / TZS** route appears **only** because this local run points a *sandbox* Snippe adapter at a *loopback mock* (`routing.ts`). It is never offered on the hosted project (`SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false`); production charges USD by card only. |
| `22-mock-provider-page` | The mock Polar page (Pay, and Back, which uses `return_url`). |
| `23-status-received-*` | A paid test order: "Test payment received", no plan activated. |
| `27-landing-plans-online-*` | The landing plans when online payment is open: Solo and Practice approved, Firm proposed. |
| `28-plans-unfinished-*` | **Back** from Polar: `/plans?unfinished=` names the checkout from its recorded state ("No payment has been recorded"), with **Resume** and **Choose another plan**. The header chip reads "No plan · Choose a plan" (hidden below the `sm` width by design). |
| `29-leave-confirm-*` | **Choose another plan**: the consequence is stated before anything changes. The Polar page stays open until it expires; a payment there is never applied twice and is reviewed by the team. *Close this checkout* / *Keep it*. |
| `30-leave-waiting-1280` | The provider was asked moments earlier (by Resume), so the close waits visibly ("about 56 s") instead of acting on a stale answer. |
| `31-plans-left-*` | Closed in CFOClose: "Its payment page may stay open until it expires. Don't pay on it." |
| `32-plans-signed-out-unfinished-*` | **Expired sign-in** on the plans link: sign in, then return to this link. |
| `33-status-sign-in-*` | **Expired sign-in** on the order page: sign in, then return to this order. |
| `34-plans-review-case-*` | A review case (MANUAL_REVIEW): "being confirmed", *Open the order*, and no close action. |
| `35-status-unreachable-*` | **Provider or status outage**: "We cannot reach the order status", with Try again and Back to plans. No spinner. |

**Behaviour verified by the same run, not visible in a still:**

- Resume opens the *same* Polar session.
- Closing the tab and reopening `/plans` still names the checkout.
- After *Close this checkout*, the intent is `CANCELLED` with one audit row, and the mock Polar session is still `open`.
- Another plan then starts at once.
- After signing in, the browser lands back on the original order or link.
- A review case is recovered by the next checkout once the provider has expired it.
