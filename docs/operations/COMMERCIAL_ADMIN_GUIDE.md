# CFOClose: founder sign-in, administration and operator enrolment

This guide covers the commercial candidate (PR #101). Nothing in it has been performed. Each step is an explicit action
for the person named. **No step gives anyone blanket access to customer workspaces, and no step deletes an account.**

## 1. Four separate authorities

| Authority | What it allows | Where it is recorded | Who grants it |
|---|---|---|---|
| **Company ownership** | Owning and working in a company's workspace; inviting members; recording its workspace purpose | `companies.user_id`, `firm_members` | The person who creates the company (first run). Members are invited by the owner. |
| **Enquiry administration** | Reading and handling enquiries at `/admin/enquiries`: assign, note, change status, reply | `platform_staff_members` (`triage_agent` or `manager`), with an append-only `platform_staff_audit` | A database operator, using the `service_role` (§4) |
| **Commercial administration** | Recording a customer's plan after terms are agreed (manual activation), and managing offers | `commercial_admins` allowlist; every `admin_*` function checks it | A database operator, using the `service_role` (§5) |
| **Deployment** | Applying migrations, deploying Edge Functions, publishing the frontend, setting secrets | Lovable project / Supabase project roles | The project owner in Lovable. This is outside the application. |

These authorities are independent:
- Being enquiry staff gives no access to any customer workspace or financial record. The staff functions read only enquiries.
- Being a commercial administrator allows recording plans, and reading the billing state those functions return. It gives no workspace, trial balance or report access.
- Owning your own company gives no administrative authority.
- Database-owner access while applying a migration (Lovable / SQL editor) is an **operator** action. It is not application administrator access. Never use it to read or change customer data outside a reviewed release step.

## 2. Founder sign-in

1. Open the published site and go to `/auth?mode=signup`. Create the account with the founder's own email address and a strong, unique password.
2. Confirm the address from the confirmation email (see `PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED`: custom SMTP must be configured before real volumes).
3. Sign in at `/auth`. The first sign-in shows the first-run form. **Do not** create a company unless the founder really works on one. A founder account needs no company to administer enquiries or plans.
4. Note the account's user id for §4 and §5. The operator reads it in the SQL editor without changing anything:
   ```sql
   SELECT id, email, email_confirmed_at FROM auth.users WHERE email = '<founder email>';
   ```

## 3. Operator procedure, applicable to every grant

- Verify the person independently (in person or by a known channel). The account must already exist and its email must be confirmed.
- Use the reason text to say why and by whose decision. It is stored permanently in the audit trail.
- Record the action in the operations log: date, operator, grant, reason.
- Revoke with the matching revoke function when the role ends. Never delete rows.

## 4. Enrol an enquiry operator

Run in the Supabase SQL editor (an operator session) as one transaction:

```sql
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.platform_staff_grant(
  '<auth.users.id>',                     -- an existing, verified account
  'manager',                             -- 'manager' or 'triage_agent'
  'Enquiry manager for CFOClose, decided by <founder> on <date>',
  'ops:<operator name>'
);
COMMIT;
```

- `manager` and `triage_agent` are recorded roles. **Today the database gives both the same queue powers**: list, open, assign to any active staff member, note, change status and reply. The distinction is recorded for the audit trail only. Limiting `triage_agent` would be a reviewed change.
- The queue at `/admin/enquiries` is not linked from public navigation. Access is decided by the database, not by the route.
- Revoke: `SELECT public.platform_staff_revoke('<auth.users.id>', '<reason>', 'ops:<operator name>');`, in the same transaction form.

**Tracked replies.** A reply sent from the queue (`staff_reply_service_enquiry`) is stored append-only and queued to the requester's own address only. Its delivery status is shown beside it:
- *Queued* or *Sending*: not yet handed over.
- *Accepted*: the provider took it. This is not proof of delivery.
- *Delivered* or *Bounced*: only when the provider reports it.
- *Failed*: shown with its error code.

Email is sent only when `ENQUIRY_EMAIL_ENABLED=true` and `LOVABLE_API_KEY` are set for the functions (see the Lovable checklist).

## 5. Enrol a commercial administrator, and activate a plan manually

**Bootstrap (once).** There is no bootstrap function by design. An operator inserts the first row:

```sql
INSERT INTO public.commercial_admins (user_id, granted_by, active)
VALUES ('<founder auth.users.id>', NULL, true);
```

**Activating a plan after terms are agreed.** The flow:
1. The customer sends *Request activation* from Plans, naming a plan (`plan_activation`, with `plan_code` SOLO, PRACTICE, FIRM or ENTERPRISE).
2. A manager replies from the queue to agree terms.
3. When terms are agreed, the commercial administrator records the plan **on the account registered to the requester's email**.

The `admin_*` functions act as the signed-in administrator (`auth.uid()`), so the actor recorded is the administrator. The application has no screen for this yet (`/commercial/admin` manages offers and shows billing state only), so this is an **owner decision** (§7). Until a screen exists, an operator runs the call **with the administrator's identity**:

```sql
BEGIN;
SELECT set_config('request.jwt.claim.sub', '<commercial admin auth.users.id>', true);
SELECT set_config('request.jwt.claims', json_build_object('sub', '<commercial admin auth.users.id>', 'role', 'authenticated')::text, true);
SELECT public.admin_ensure_billing_customer('<customer auth.users.id>', 'Activation agreed by email on <date>, enquiry <reference>');
-- Use the billing_customer_id that the call above returns:
SELECT public.admin_grant_commercial_licence('<billing_customer_id>', 'PRACTICE', now(), now() + interval '12 months',
  'Activation agreed by email on <date>, enquiry <reference>');
COMMIT;
```

- Plan codes and capacities come from the reviewed catalogue (`src/content/landing/proposedPlans.ts`, `commercial_plans`). Do not invent a plan or a price. A hosted edit that differs from the reviewed catalogue is drift; correct it through a reviewed change.
- No checkout is activated and no payment is taken in the application.
- Suspension, cancellation and seats use `admin_transition_licence_status`, `admin_cancel_future_licence` and `admin_set_licence_additional_seats`, each with a reason.

## 6. Not provided, on purpose

- **No blanket tenant access.** No role here can open a customer's workspace. Support work inside a workspace requires the customer to invite the person as a member, which is recorded and can be removed by the customer.
- **No account deletion.** Deletion requests are handled outside this guide, under the published privacy terms after legal review. Nothing here deletes `auth.users`, companies, uploads, certifications, report versions or sealed packs.
- **No hosted action by Claude.** Every step above is performed by the people named.

## 7. Owner decisions

1. Whether to add an in-app activation screen for commercial administrators. It would replace the identity-claim SQL in §5 and record the same actor.
2. Who holds `manager` and who holds `triage_agent`, and whether the two roles should differ in power (today they do not).
3. The internal notification address (`ENQUIRY_INTERNAL_NOTIFY_TO`). It is never guessed.
