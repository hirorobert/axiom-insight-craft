# Sandbox Test Protocol — `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` closure evidence

For whoever runs this: a Flutterwave **TEST mode** (sandbox) account is required. Never use LIVE/production keys for this. Nothing here should touch this project's real Supabase, real customers, or real money.

**Corrected, this revision — one mandatory, deterministic path.** An earlier draft of this protocol left room for either dashboard-driven or API-driven checkout creation, and for either transaction-ID verification or reference lookup, without requiring both tests to use the same mechanism. That ambiguity is closed here: **both Test A and Test B must be created and verified through the exact same mechanism, below — never dashboard-created and API-created transactions compared against each other, and never reference-lookup used as a substitute for transaction-ID verification.** Mixing origins would let a difference between dashboard-side and API-side transaction handling masquerade as a difference in `created_at` semantics, corrupting the comparison this evidence exists to produce.

**Recommended: use the corrected PowerShell collector** at `tools/Invoke-FlutterwaveEvidenceCapture.ps1` (this same directory) to run this protocol — it performs every step below consistently, opens the ACTUAL Flutterwave hosted-checkout link (`data.link`, validated against Flutterwave's documented host — never the API request endpoint itself), projects only ALLOWLISTED evidence fields (an exact-key-plus-value-validated timestamp allowlist, never a redacted copy of the full response and never a card `expiry` field masquerading as a timestamp — see the collector's own header comments), binds every capture to one immutable session id AND verifies the provider's returned transaction id/tx_ref both match what was requested, machine-captures the completion timestamp instead of accepting one as free-form input, writes every stage and the final manifest write-once (never overwritable), and produces the provenance manifest `PHASE0_FLUTTERWAVE_EVIDENCE.md` requires. See `tools/README.md` for exact usage (`CreateCheckout` → `ObservePaymentSuccess` → `Verify` → `FinalizeManifest`). The manual steps below remain the authoritative specification of what the collector does and why, and are what to follow if running by hand instead.

## The one mandatory path (applies identically to Test A and Test B)

1. **Flutterwave TEST mode only.** Confirm the secret key in use is a TEST key (Flutterwave's own TEST/LIVE key prefixes distinguish this — verify before proceeding, never assume).
2. **Create the checkout through the same documented v3 endpoint for both tests** — the standard hosted-payment-link creation call (`POST https://api.flutterwave.com/v3/payments`, the v3 REST endpoint this design's own webhook/verification flow is built against). Do not create one test via the dashboard's own "create payment link" UI and the other via this API call — pick this API path for both, with no exception.
3. **Generate a unique `tx_ref` locally**, before making the creation call, and pass it in the creation request. Never let the provider assign the reference. Record the generated `tx_ref` (or, if withheld from the shared evidence for extra caution, its SHA-256 hash).
4. **Record UTC timestamps immediately before and after the checkout-creation call** — `checkout_request_start_utc` (captured right before the HTTP call is sent) and `checkout_request_end_utc` (captured right after the HTTP response is received). This brackets the creation call itself, not a human's perception of it.
5. **Open the returned hosted-checkout URL** from the creation response's `data.link` field (in a browser, using TEST-mode test-card details from Flutterwave's own published test-card list) — never the request endpoint you called in step 2. **The collector's `CreateCheckout` action does this automatically**: it extracts and validates `data.link` (must be a non-empty, absolute, `https://checkout.flutterwave.com/...` URI) before opening it, and aborts with no stage file written if the link is missing, malformed, non-HTTPS, or on an unexpected host.
6. **Test A: complete the payment immediately** — proceed through the hosted checkout with no deliberate delay, as fast as normally possible.
7. **Test B: wait at least 10 minutes between opening the checkout URL and completing the payment** — leave the checkout page open (or note the reference and return to it) for a real, meaningful, observable gap. Ten minutes is a floor, not a target — longer is fine, shorter invalidates the test.
8. **Record a UTC completion-observation timestamp** — `payment_completion_observed_utc`, the wall-clock moment the hosted checkout UI shows success (this is an observation, not a provider-verified fact — it exists only to compare against the provider's own returned timestamps). **When using the collector, this is captured by the `ObservePaymentSuccess` action itself (`DateTime.UtcNow` at the moment you type the exact confirmation phrase) — never typed in as a free-form timestamp string.** If running by hand, record it the same way: the instant you observe success, not a value reconstructed afterward from memory.
9. **Verify by transaction ID**, not by reference, as the PRIMARY verification call:
   ```
   GET https://api.flutterwave.com/v3/transactions/{id}/verify
   ```
   where `{id}` is the transaction ID Flutterwave itself returned (from the webhook, the redirect callback, or the checkout-creation response's own follow-up — however this design's real flow obtains it; never re-derive it from the `tx_ref` for this step, since that is what step 11 is for, kept separate).
10. **Record UTC timestamps immediately before and after this verification call** — `verify_request_start_utc` and `verify_request_end_utc`, bracketing the call the same way step 4 brackets checkout creation.
11. **A reference-lookup call (`GET /transactions?tx_ref=...` or equivalent) may be made as a SUPPLEMENTAL, ADDITIONAL data point — it must never replace the transaction-ID verification in step 9.** If made, record its own timestamps and response the same way, clearly labeled as supplemental, never substituted into the primary comparison.
12. **Record every provider-returned timestamp field verbatim, without interpreting any of them.** Whatever field names appear in the raw response (`created_at`, `created_datetime`, anything nested under `customer` or `payment_method` or elsewhere, anything containing `_at`/`_date`/`time`/`settled`/`charged`/`processed`) — copy the exact field name and exact value. Do not decide at capture time what a field "really means"; that analysis happens afterward, against the recorded raw values, not instead of recording them.

## Do not mix test origins

**Test A and Test B must both be produced by this exact sequence, start to finish, with no shortcuts on either one.** A comparison between a dashboard-created Test A and an API-created Test B (or a transaction-ID-verified Test A against a reference-lookup-only Test B) is invalid evidence for this gate and must not be submitted as such — the whole point of the comparison is isolating whether `created_at` shifts with a delayed COMPLETION, which requires everything else about how the two transactions were created and verified to be identical.

## What to record (one block per test, both Test A and Test B)

- `tx_ref` (or its SHA-256 hash)
- `checkout_request_start_utc`, `checkout_request_end_utc` (step 4)
- `payment_completion_observed_utc` (step 8)
- `verify_request_start_utc`, `verify_request_end_utc` (step 10)
- `data.created_at` from the transaction-ID verify response (step 9) — the PRIMARY value this gate needs
- Every other timestamp-shaped field found anywhere in that same response body (step 12), verbatim
- If a supplemental reference lookup was made (step 11): its own timestamps and its own `created_at`/timestamp fields, clearly labeled SUPPLEMENTAL
- The transaction `status` value
- `amount` and `currency` (needed to confirm the two test transactions are otherwise comparable, not to prove anything about timestamps)

## Sanitizing before sharing back

**Corrected, this revision: this is an ALLOWLIST, not a denylist.** An earlier draft of this protocol described this step as "strip these known-sensitive fields, keep everything else" — the same structural weakness Blocker 1 identified in the collector itself (a denylist cannot anticipate every field a provider might return, and this project's own denylist attempt missed Flutterwave's real `first_6digits`/`last_4digits` spelling). If you are running this BY HAND rather than using the collector, apply the same allowlist discipline the collector enforces automatically: **the shared evidence may contain ONLY** —
- timestamp-shaped fields (by name — anything like `created_at`, `*_date`, `*datetime*`, `completed`, `settled`, `charged`, `processed`, `expire*`, `timestamp`), keeping their exact field name/path and value
- `status`, `amount`, `currency`
- the SHA-256 hash of `tx_ref` — **never the raw value**
- the SHA-256 hash of the transaction `id` — **never the raw value**
- your own request-timing metadata (the UTC timestamps this protocol asks you to record)

**Everything else is discarded, not merely reviewed for sensitivity** — including anything you don't recognize as sensitive, since an unrecognized field is exactly the case a denylist fails on. If you use the collector (`tools/Invoke-FlutterwaveEvidenceCapture.ps1`), this projection happens automatically via `Get-AllowlistedEvidenceFields` and you do not need to do this step by hand — its output manifest is already safe to share as-is, after your own final review.

**Before discarding the original, unredacted capture:**
- Compute its SHA-256 hash (`Get-FileHash` in PowerShell, or `sha256sum` elsewhere) and record the hash string.
- Note where the original (unredacted) capture is retained — e.g. a password-protected local file, a private note — so it can be re-checked later if a question arises about whether the sanitized version was transcribed correctly. **Do not commit the original.** The PowerShell collector in `tools/` writes raw captures OUTSIDE this repository by design, specifically so this step is automatic rather than a manual discipline to remember.

## What to send back

A short message or file containing:
1. Both tests' recorded timestamps (every field named in "What to record" above), for Test A and Test B separately.
2. The SHA-256 hash of each test's original unredacted raw-response capture, and where those originals are kept.
3. The sanitized JSON bodies (or just the relevant fields, if you'd rather not share the full body even sanitized).
4. If the PowerShell collector was used: its generated evidence manifest (already sanitized and hashed per `tools/README.md`).

This will be added to `PHASE0_FLUTTERWAVE_EVIDENCE.md` as the closure evidence `DATA_CONTRACTS.md` §7.4 requires, and the gate's CLOSED/OPEN decision will be made from it.
