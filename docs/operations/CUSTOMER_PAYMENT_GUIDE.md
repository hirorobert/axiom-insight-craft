# Buying a CFOClose plan: what the customer sees, and what support should say

This guide covers the customer side of online payment. For the administrator's side, see `COMMERCIAL_ADMIN_GUIDE.md` §5 and §5a.

**Launch scope (owner decision, 10 October 2026):**
- **Card payments through Polar** (USD) only.
- Mobile money (TZS) is **not offered**. No TZS price is approved, and the server never offers that route.
- Enterprise and specialist consulting are quoted separately.
- Financial reporting stays a restricted pilot; buying a plan never opens it.

## When online payment is open

Online payment is open only when all of these hold:
1. Polar has approved the merchant account.
2. The sandbox and controlled live acceptance stages have passed.
3. The owner has set `CUSTOMER_PAYMENTS_ENABLED`.

Until then:

| Price state | What a plan shows |
|---|---|
| Approved | The approved price, for example "USD 490 per year", with **Request activation**: a team member agrees terms and activates the plan, and nothing is charged online. |
| Not yet approved | The catalogue figure marked **Proposed**, with **Request activation**. |

The approved annual prices are Solo USD 490, Practice USD 990 and Firm USD 2,990. Additional named users (Practice and Firm) are arranged with the team: their price stays **proposed**, and they are never sold online.

## Buying a plan

1. **Choose the plan.** On the home page or at `/plans`, select **Choose <plan>**.
2. **Sign in, or create an account.** The plan belongs to the account the customer signs in with. After sign-up and email confirmation they return to the checkout for that plan.
3. **Check what is bought.** The page shows the plan, its entities and included named users, and a 12-month term that does not renew automatically. It also shows where the term starts:
   - **New:** when the payment is verified.
   - **Same plan:** when the current term ends.
   - **Smaller plan:** when the current term ends; the current plan continues until then.
   - **Larger plan:** when the payment is verified, and the current plan ends then. Unused time is not refunded automatically.
     - If the current plan has **additional named users**, an upgrade is not sold online: it would end them. The page says so, and the team arranges it.
   - On a renewal or downgrade, the current term's additional named users continue until that term ends. They are **not** part of the new purchase, and the page says so.
4. **Pay by card on Polar's secure page.** Polar is the merchant of record for card payments and may add sales tax for the customer's location. The final total is shown before payment. CFOClose never receives card details.
5. **Watch the status page.** It updates by itself (`/billing/payment/return`). It shows one of these:
   - **Waiting for payment confirmation.**
   - **Payment received:** the plan is active until its end date, or scheduled from a later start date.
   - **The payment did not go through / was cancelled / expired:** no payment was taken. **Start a new payment** is offered.
   - **Payment received — setting up your plan:** the payment is recorded and will not be taken again. The team places the term.
   - **Confirming this payment:** the outcome is not yet known. **Do not pay again.** Use **Check again**, or contact us.
   - **Payment refunded / disputed:** our team reviews the plan's access and contacts the customer.
6. **Receipts.** Polar emails the receipt and invoice. The order reference and Polar's order reference are on the status page and in **Your orders** (`/billing/orders`).

Access never follows from returning from Polar's page. It appears only once the server has verified the order with Polar.

## What support says

| The customer says | Check | Answer |
|---|---|---|
| "I paid but have no access." | Their order in **Your orders**, then `/commercial/admin` → **Payments needing attention** | Use **Check with the provider**: it reads Polar's own record and never charges again. If the order is paid but the term is waiting for placement, place it. A delayed notification from Polar is reconciled the same way. |
| "I was charged twice." | Polar's dashboard | One order has at most one recorded payment. Refund any duplicate in Polar, then record the decision in the administrator screen. |
| "I want a refund." | Owner refund policy | Refund in Polar's dashboard. The refund is recorded and listed for the administrator, who decides whether access ends (§5a). Polar being merchant of record does not decide access. |
| "Can I pay by mobile money?" | — | Not at launch. Card only, or ask us to activate the plan by agreement. |
| "Can I pay for consulting here?" | — | No. Specialist services are quoted separately: use **Ask for a quote**. They are never part of a plan. |
| "Can I add named users?" | — | Additional named users are arranged with the team (Practice and Firm). They are not sold online. |
| "Does my plan include financial reporting?" | — | Financial reporting is a pilot by invitation. Buying a plan does not include or enable it. |
