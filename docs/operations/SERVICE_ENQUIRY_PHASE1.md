# CFOClose Phase 1 — Service Enquiry and Expert Intake

Status: **implemented on branch `feat/service-enquiry-intake`; NOT applied or deployed anywhere.** Nothing in this document
describes live behaviour until the migration is applied and the two Edge Functions are deployed (see *Activation*).

Phase 1 is one canonical enquiry backend, one reusable enquiry form, a donor/funder expert intake, a jurisdiction-gated tax
expert intake, contextual entry points, a secured staff triage queue and a transactional notification outbox. It deliberately
contains **no** donor-reporting workbench, tax calculation, file upload, CRM, automatic acceptance, proposal or assignment.

## Dark-launch gate (`service_enquiry_phase1`)

The whole user-facing experience sits behind one independent rollout gate, `src/lib/serviceEnquiry/serviceEnquiryGate.ts`,
**committed OFF** — so it is OFF in every environment, including production. It follows the repository's gate convention
(a source-controlled constant; no `VITE_*` variable, storage value, query parameter or runtime setting can change it), and it
fails closed: only the exact configuration `{ gate: "service_enquiry_phase1", enabled: true }` is ON; a missing, malformed or
unreadable configuration is OFF. It does not reuse or alter any other rollout gate.

While OFF the product is identical to current `main`: no donor tile (the original tax card is unchanged), no Contact link in
the header, footer or the two Help & support menus, `/contact` and `/admin/enquiries` are not registered (the existing
not-found page answers), and no request can reach `submit-service-enquiry`. The migration and both Edge Functions are
independent of the gate and can be applied and deployed while it is OFF. The gate is rollout control only — authorization is
still enforced by the database (`staff_*` functions refuse anyone who is not active platform staff) and never consults it.

**Enabling it is a reviewed code change** (`enabled: true` in `COMMITTED_CONFIG`), made only after the activation checklist
below is complete: migration applied, both functions deployed, first platform staff enrolled, and the email path verified.

## Architecture

| Layer | Artefact |
|---|---|
| Database authority | `supabase/migrations/20260921100000_service_enquiry_intake.sql` |
| Public entry point | Edge Function `submit-service-enquiry` (optional JWT, honeypot, 16 KiB cap, hashed rate limits, UUID idempotency) |
| Notification retry | Edge Function `dispatch-enquiry-notifications` (active platform staff only) |
| Shared rules | `supabase/functions/_shared/serviceEnquiryContract.ts` (used by the browser, the function and the tests) |
| Handler logic | `supabase/functions/_shared/serviceEnquiryHandler.ts` (dependency-injected, unit-tested without Deno) |
| Browser | `src/components/enquiry/*`, `src/lib/serviceEnquiry/*`, `src/pages/Contact.tsx`, `src/pages/admin/EnquiryQueue.tsx` |
| Proofs | `scripts/db-proof/serviceEnquiries.mjs` (real PostgreSQL), `src/lib/serviceEnquiry/*.test.ts` |

### Security boundary

* No client role — `anon`, `authenticated`, **and not even `service_role`** — has any write privilege on any of the seven
  canonical tables. RLS is enabled with no policies. Every write is a `SECURITY DEFINER` function with a pinned `search_path`.
* Submission (`submit_service_enquiry`) is executable by `service_role` only; the browser can only reach it through the Edge
  Function, which derives the requester's user id **only** from a verified JWT (there is no user-id field in the request).
* A trigger refuses any direct `UPDATE` of `status` / assignee and any change to submitted content, and any `DELETE`, for every
  role including a superuser. Status changes go through one function that locks the row, validates the transition matrix and
  appends the event in the same transaction.
* `service_enquiry_events`, `platform_staff_audit` and the transition table refuse `UPDATE`, `DELETE` and `TRUNCATE`.
* **Platform staff is a separate authority** (`platform_staff_members`). A company owner, company administrator or workspace
  member is not platform staff. No staff row is seeded by the migration, and no email address is ever trusted as a credential.
* Public references are `CFQ-XXXX-XXXX-XXXX` (48 random bits) — never a database id or a counter.
* Rate limiting keys are HMACs of the client address / email (secret derived server-side); a raw address is never stored or
  logged. Nothing in a log line contains a message, email, token, payload or IP.

### Status matrix (server-enforced, 18 permitted pairs)

`submitted → triage | spam | withdrawn` · `triage → awaiting_client | scoping | declined | spam` ·
`awaiting_client → triage | scoping | withdrawn` · `scoping → awaiting_client | proposal_sent | declined` ·
`proposal_sent → accepted | declined | withdrawn` · `accepted → closed` · `declined → closed` ·
`spam`, `withdrawn`, `closed` are terminal.

## Activation checklist (not yet performed)

1. **Apply the migration** through the project's managed path (Lovable / `supabase db push`, in filename order). It is additive
   and forward-only. Run `node scripts/db-proof/serviceEnquiries.mjs` against a throwaway database first (CI does this).
2. **Deploy both Edge Functions**: `supabase functions deploy submit-service-enquiry` and
   `supabase functions deploy dispatch-enquiry-notifications` (default `verify_jwt`; no `config.toml` change is needed).
3. **Refresh generated types** after the migration is applied. This branch already contains the new objects, produced by the
   same generator the Supabase CLI runs (`@supabase/postgres-meta` 0.96.4) against a disposable replay of the migration chain and
   merged as pure insertions; the managed regeneration remains authoritative.
4. **Configure application email (optional; fails safe when absent):** function secrets `ENQUIRY_EMAIL_ENABLED=true`
   (requires the existing `LOVABLE_API_KEY`) and `ENQUIRY_INTERNAL_NOTIFY_TO=<the internal triage mailbox>`. Without them the
   enquiry is still recorded and the receipt says the email acknowledgement is *unavailable*; nothing is ever reported as sent
   that was not. The recipient is never guessed.
5. **Enrol the first platform staff member** (see below). Until then the queue correctly refuses everyone.

### Bootstrapping platform staff (`PLATFORM_STAFF_BOOTSTRAP_REQUIRED`)

Enrolment is an operator action for a person **you have independently verified**, and their account must already exist. From a
`service_role` session (for example the SQL editor with the role claim set, or PostgREST with the service key — never paste a
key into a ticket):

```sql
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.platform_staff_grant(
  '<auth.users.id of the verified person>',   -- an existing account
  'manager',                                   -- or 'triage_agent'
  'Verified triage owner for CFOClose enquiries',   -- reason, at least 8 characters, kept in the audit trail
  'ops:<your name>'                            -- operator label
);
COMMIT;
```

Revoke with `public.platform_staff_revoke(user_id, reason, operator_label)`. Every grant and revocation is recorded in the
append-only `platform_staff_audit` table. The queue is at `/admin/enquiries` and is intentionally not linked from any public
navigation; access is enforced by the database, not by the route.

## Email

Application acknowledgements are separate from authentication emails and use the platform's existing sender domain:
`CFOClose <noreply@notify.cfoclose.com>`. The authentication email hook is untouched. The send goes through
`sendLovableEmail` from `@lovable.dev/email-js@0.1.0` (the package the auth hook already pins) with `purpose: "transactional"`
and the outbox row id as the idempotency key. **This path could not be exercised from the authoring environment** (no platform
key); it is therefore gated behind explicit configuration and must be verified with one synthetic message before staff rely on it.
A failed or unconfigured send leaves a `pending` outbox row (retryable from the queue) and never loses or rolls back the enquiry.

## Known limitations and follow-ups

* **No CAPTCHA provider is configured**; the controls are honeypot, body cap, per-IP/per-email/global rate limits and
  idempotency. A provider can be added later without changing the contract.
* **No platform rate-limit facility existed**; a small database-backed fixed-window limiter is part of the migration.
* The public **Privacy Policy** does not yet mention enquiry handling. It is a legally reviewed surface and was not edited here.
* A financial-statements expert-help entry was not added: the statements page is diff-pinned by `workspaceGate.test.ts`.
* Enquiries are not deletable (their history is retained by design); a retention/erasure procedure is a separate decision.
* Tanzania is presented only as *private preview / request access*. The runtime label is composed from the ISO code, so no
  jurisdiction is named in global source (`jurisdictionCopyAudit.test.ts` still passes unmodified).
