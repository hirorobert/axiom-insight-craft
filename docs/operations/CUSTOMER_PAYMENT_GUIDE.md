# Buying a CFOClose plan: what the customer sees, and what support should say

This guide covers the customer side of online payment (milestone *Commercial launch: plans and online payment*). For the administrator's side, see `COMMERCIAL_ADMIN_GUIDE.md` §5 and §5a.

## When online payment is open

Online payment is open only when the owner has done both of these:
- approved a plan's annual price, in `/commercial/admin` → **Prices**;
- set `CUSTOMER_PAYMENTS_ENABLED`.

Until then, every plan shows a figure marked **Proposed** and the action **Request activation**. A team member agrees terms and activates the plan; nothing is charged online.

## Buying a plan

1. **Choose the plan.** On the home page or at `/plans`, select **Choose <plan>**.
2. **Sign in, or create an account.** The plan belongs to the account the customer signs in with. After sign-up and email confirmation they return to the checkout for the plan they chose.
3. **Choose how to pay.** The page shows:
   - what is bought: the plan, its entities and included named users, and a 12-month term that does not renew automatically;
   - where the term starts:
     - **New:** starts when the payment is verified.
     - **Same plan:** starts when the current term ends.
     - **Smaller plan:** starts when the current term ends; the current plan continues until then.
     - **Larger plan:** starts when the payment is verified, and the current plan ends then. Unused time is not refunded automatically; the customer can contact us about a credit.
   - the total payable for each payment method:
     - **Card:** paid on Polar's secure page. Polar is our merchant of record for card payments and may add sales tax for the customer's location; the final total is shown before they pay. CFOClose never receives card details.
     - **Mobile money** (M-Pesa, Airtel Money, Mixx by Yas or Halotel): the customer enters their mobile number and approves the prompt on their phone with their PIN. CFOClose does not store the number.
4. **Watch the status page.** It updates by itself (`/billing/payment/return`). It shows:
   - **Waiting for payment confirmation**, or for mobile money **Approve the payment on your phone**;
   - **Payment received**: the plan is active until its end date, or scheduled from a later start date;
   - **The payment did not go through / was cancelled / expired**: no payment was taken, and **Start a new payment** is offered;
   - **Payment received — setting up your plan**: the payment is recorded and will not be taken again, and our team places the term;
   - **Confirming this payment**: the outcome is not yet known. **Do not pay again.** Use **Check again**, or contact us.
5. **Receipts.**
   - **Card:** Polar emails the receipt and invoice.
   - **Mobile money:** the provider's confirmation message is the receipt.
   - **Both:** the order reference and the provider reference are on the status page and in **Your orders** (`/billing/orders`).

Access never follows from returning from a payment page. It appears only once the server has verified the payment with the provider.

## What support says

| The customer says | Check | Answer |
|---|---|---|
| "I paid but have no access." | Their order in **Your orders**, then in `/commercial/admin` → **Payments needing attention** | Use **Check with the provider**. It never charges again. If the order is paid but the term is waiting for placement, place it. |
| "I was charged twice." | The provider dashboard | One order has at most one recorded payment. Refund any duplicate charge in the provider dashboard, then record the decision in the administrator screen. |
| "The prompt never arrived on my phone." | The status page says *Approve the payment on your phone* | The request expires on its own. When the status page shows it expired, use **Start a new payment**. |
| "I want a refund." | Owner policy | Refund in the provider's dashboard. The refund is recorded and listed for the administrator, who decides whether the licence ends. |
| "Can I pay for consulting here?" | — | No. Specialist services are quoted separately: use **Ask for a quote**. They are never part of a plan. |
| "Can I add named users?" | — | Additional named users are arranged with our team (Practice and Firm). |
