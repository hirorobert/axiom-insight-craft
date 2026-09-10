# Sandbox Test Protocol — `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` closure evidence

For whoever runs this: a Flutterwave **sandbox** (test-mode) account is required. Never use production/live keys for this. Nothing here should touch this project's real Supabase, real customers, or real money.

## What you need
- A Flutterwave sandbox account and its **test** secret key.
- Flutterwave's published test card numbers (in their sandbox docs) for a "successful" test charge.
- A way to make two HTTP calls (curl, Postman, or the Flutterwave dashboard's own "Transactions" log export) and note down wall-clock times as you go.
- A plain text editor to record your own independently-observed timestamps — do this in real time, not from memory afterward.

## Test A — immediate completion

1. Note the wall-clock time (UTC, to the second) **right before** you initiate a new sandbox checkout. Call this `A_checkout_initiated_at`.
2. Create a sandbox checkout/payment (via the dashboard's test-payment flow, or a test `POST` to the standard checkout-initiation endpoint).
3. Immediately complete the test payment with a "successful" test card, with no deliberate delay — go through the flow as fast as normally possible.
4. Note the wall-clock time right after the payment shows as successful in the UI/response. Call this `A_payment_completed_at`.
5. Wait a few seconds, then call `GET /transactions/:id/verify` (or the reference-lookup equivalent) for this transaction. Note the wall-clock time of this call: `A_verify_called_at`.
6. Save the FULL raw JSON response from step 5 to a local file NOT committed to git yet (see "Sanitizing before sharing" below).

## Test B — deliberately delayed completion

1. Note `B_checkout_initiated_at` the same way as step 1 above.
2. Create a second sandbox checkout the same way.
3. **Deliberately wait at least 5–10 minutes** before completing the test payment (leave the checkout page open, or note the reference and come back to it). The goal is a real, meaningful, independently-observable gap between checkout creation and payment completion.
4. Complete the test payment. Note `B_payment_completed_at`.
5. Call `GET /transactions/:id/verify` shortly after. Note `B_verify_called_at`.
6. Save the full raw JSON response, same as Test A.

## What to record (in a plain text file, one block per test)

For each of Test A and Test B, record:
- `checkout_initiated_at` (your own clock, step 1)
- `payment_completed_at` (your own clock, the moment the UI/API confirmed success)
- `verify_called_at` (your own clock, when you made the verify call)
- `data.created_at` from the verify response
- `data.created_at` from a SEPARATE call using reference/`tx_ref` lookup, if that endpoint is also being exercised (it should return the same or a related value — record it either way)
- Every OTHER timestamp-shaped field anywhere in the raw response body, whatever it's called (e.g. anything containing `_at`, `_date`, `time`, `settled`, `charged`, `processed`) — copy the field name and value verbatim, don't paraphrase
- The transaction `status` value

## Sanitizing before sharing back

**Before this data is added to `PHASE0_FLUTTERWAVE_EVIDENCE.md` or committed to git, strip:**
- Any API key, secret key, or `Authorization` header value
- Card number, CVV, expiry, cardholder name — even sandbox/test values, as a matter of discipline
- Customer email/phone/name if the test used anything resembling a real person's details (use an obviously fake test identity, e.g. `phase0-evidence-test@example.invalid`)
- Your Flutterwave account ID or merchant identifier, if present in the payload

**Keep, because the gate needs it:**
- The `created_at` (and any other timestamp) field names and values
- The transaction `status`
- The `id` and `tx_ref`/reference (sandbox-only test references carry no real risk, but redact them too if you'd rather — they aren't needed for the timestamp comparison itself)

**Before discarding the original, unredacted capture:**
- Compute its SHA-256 hash (`sha256sum <file>` or equivalent) and record the hash string.
- Note where the original (unredacted) capture is retained — e.g. a password-protected local file, a private note — so it can be re-checked later if a question arises about whether the sanitized version was transcribed correctly. **Do not commit the original.**

## What to send back

A short message or file containing:
1. Both tests' recorded timestamps (your own clock + every provider-returned timestamp field).
2. The two SHA-256 hashes (one per test) of the original unredacted captures, and where those originals are kept.
3. The sanitized JSON bodies (or just the relevant timestamp fields, if you'd rather not share the full body even sanitized).

This will be added to `PHASE0_FLUTTERWAVE_EVIDENCE.md` as the closure evidence `DATA_CONTRACTS.md` §7.4 requires, and the gate's CLOSED/OPEN decision will be made from it.
