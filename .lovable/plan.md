# Ω2 Auth-Contract Repair — Controlled Redeploy

## Preflight (already confirmed, read-only)

- Local source HEAD is exactly `00b2c4fce7eb1dc475d305ed6ad8fb4d43219f7d`, working tree clean.
- `commercial-create-checkout/index.ts` and `commercial-payment-status/index.ts` both already call
  `validateAuth(authHeader, CORS_HEADERS)` against the real `_shared/auth.ts` contract and return the
  401 with CORS headers attached. No source edit is required or will be made.
- `commercial-payment-status` builds its Supabase client with the anon key plus the caller's bearer
  token, so `get_checkout_status()` runs under the caller's own `auth.uid()`.

## Actions (deployment only)

1. Deploy exactly two Edge Functions, unchanged from the synced tree:
   - `commercial-create-checkout`
   - `commercial-payment-status`
2. Nothing else: no migrations, no offer/licence/entitlement changes, no credential changes, no
   `commercial-payment-webhook` redeploy, no unrelated remediation, no CORS-completeness work
   beyond what the synced source already contains, no LIVE payment enablement.

## Verification (after deploy, no payment initiated)

| Check | How |
| --- | --- |
| SOURCE [SHA] | report `00b2c4fc…` |
| COMMERCIAL_CREATE_CHECKOUT | deploy result + function listed active |
| COMMERCIAL_PAYMENT_STATUS | deploy result + function listed active |
| VALID AUTHENTICATED CALL | restore the injected preview session, call `commercial-payment-status?ref=<nonexistent>` with the real JWT; expect HTTP 200 with `found:false / UNKNOWN` (safe, non-mutating). For checkout, confirm it passes auth (no 401) — stop before any provider call is completed. |
| INVALID AUTH FAIL_CLOSED | call both with a missing and a malformed bearer token; expect 401 |
| CORS ON 401 | inspect response headers of the 401 for `Access-Control-Allow-Origin` / `-Headers` |
| PAYMENT STATUS CALLER JWT SCOPING | confirm the anon-key + caller-JWT client path, and that another owner's reference resolves as not-found for this caller |
| PAYMENT AUTHORITY | re-read offers/licences/entitlement rows to confirm unchanged |
| REAL CUSTOMER PAYMENTS | remain DISABLED (sandbox credentials only) |

Then STOP and return the requested report. No payment will be initiated in this pass.

## Note on the valid-call check

If the managed browser session reports `signed_out` at run time, the authenticated check will be
reported honestly as `NOT_TESTABLE_LIVE` rather than assumed to pass; the deploy and negative-auth
checks are unaffected.
