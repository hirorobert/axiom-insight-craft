# Phase 0 Flutterwave evidence collector — tools

Implements `../SANDBOX_TEST_PROTOCOL.md`. TEST MODE ONLY — never point this at a live/production Flutterwave account.

**Hardened, this revision, against a Codex LIVE-PATH re-audit of the prior collector** (see the file-header comments in each script for the full rationale):

- **BLOCKER 1 FIXED — the collector now opens the ACTUAL hosted-checkout page.** The prior revision called `Start-Process` against the API request endpoint itself (`https://api.flutterwave.com/v3/payments`) and recorded `checkout_opened_utc` unconditionally. `Get-HostedCheckoutLink` now extracts and validates `data.link` — requiring `status: "success"`, a non-empty absolute HTTPS URI, and an exact match against Flutterwave's documented hosted-checkout host (`checkout.flutterwave.com`) — before anything is opened, and `checkout_opened_utc` is captured only after the browser actually launches without error. A browser-launch failure is never suppressed and writes no stage file.
- **BLOCKER 2 FIXED — the timestamp allowlist is now exact-key AND value-validated.** The prior revision matched broad substrings (`created`, `completed`, `processed`, `expire`/`expiry`, ...) against any key name with no value check — a card's real `expiry` field (e.g. `"09/22"`) would have passed straight through. `Get-AllowlistedEvidenceFields` now requires BOTH an exact key match (`created_at`/`completed_at`/`processed_at`/`settled_at`/`timestamp`/`*_datetime` — never a substring) AND an independently-validated ISO-8601 or epoch value (`Test-IsApprovedTimestampValue`). `expiry`/`expiration`/`created_by`/`processed_by`/`date_created` never qualify, regardless of case or value.
- **Stage files and the final manifest are now write-once.** `New-ImmutableJsonFile` uses atomic CREATE-NEW semantics — a second write to the same session/action identity fails with `STAGE_ALREADY_EXISTS` rather than silently overwriting.
- **Complete transaction binding at `Verify`.** BOTH `data.id` and `data.tx_ref` are now required from the provider's response; `data.id` must exactly equal the requested `-TransactionId`, and `SHA-256(data.tx_ref)` must equal the checkout stage's own tx_ref hash. Either mismatch aborts with no stage file written. `FinalizeManifest` additionally cross-checks tx_ref-hash and collector-version equality across all three stages.
- **The full orchestration path is now genuinely tested**, not just its helper functions and source text. `FlutterwaveEvidenceLib.ps1`'s four `Invoke-*Orchestration` functions accept injected HTTP/browser/clock ports; the test suite drives the complete CreateCheckout → ObservePaymentSuccess → Verify → FinalizeManifest chain with synthetic ports against a real temporary directory — no network, no credentials, no real browser launch — plus every failure boundary named above.
- Every capture still belongs to one immutable `capture_session_id`; payment-completion time is still machine-captured via `ObservePaymentSuccess`; TEST-key validation is still fail-closed against the documented `FLWSECK_TEST-<32 hex>-X` format.

## Files

- `FlutterwaveEvidenceLib.ps1` — the real logic: `Get-HostedCheckoutLink`, the exact-key+value timestamp allowlist, `New-ImmutableJsonFile`, timeline validation, session-bound stage-file lookup, the pinned flagResult contract mirror, manifest construction, AND the four `Invoke-*Orchestration` functions that drive each action end to end using injected HTTP/browser/clock ports. No network call, no secret, no real browser launch, no file write except within a caller-supplied EvidenceRoot (a temp directory in tests). This is what the test suite exercises directly — including the full orchestration path, not just individual helpers.
- `Invoke-FlutterwaveEvidenceCapture.ps1` — a THIN CLI WRAPPER. Its only job is to prompt for/hold the secret exactly as long as needed, build the REAL HTTP/browser/clock ports (`Invoke-WebRequest`, `Start-Process`, `Get-UtcTimestamp`), and call the same orchestration functions the tests call with fake ports.
- `tests/FlutterwaveEvidenceLib.Tests.ps1` — focused, dependency-free tests (no Pester needed), including the end-to-end orchestration test and every failure-boundary fixture named above. Also run automatically in CI (`.github/workflows/ci.yml`, "Lint, Build and Type Check" job). Run this after any change to `FlutterwaveEvidenceLib.ps1`.

## Running the tests

```powershell
pwsh -NoProfile -File tools/tests/FlutterwaveEvidenceLib.Tests.ps1
```

Exits `0` on all-pass, non-zero otherwise, with a `PASS`/`FAIL` line per assertion.

## Running the collector (protocol order — one capture session per test)

1. `CreateCheckout` — generates and prints a **new `capture_session_id`**. Save it; every later step for this test needs it exactly.
2. Complete the hosted checkout in your browser (immediately for Test A; wait **at least 10 minutes** after `checkout_opened_utc` for Test B).
3. `ObservePaymentSuccess` — run this the moment you see checkout success; it will refuse (Test B) if fewer than 600 seconds have elapsed.
4. `Verify` — by transaction ID (from the redirect/webhook callback). Refuses to write a stage file if the response's own `tx_ref` doesn't match this session's checkout, or if the timeline is invalid.
5. `FinalizeManifest` — by the same `capture_session_id`. Requires exactly one of each prior stage for this session; fails on any missing, duplicate, or cross-session stage.

```powershell
# 1) Create the checkout
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action CreateCheckout -TestLabel A `
  -Amount 100 -Currency NGN -RedirectUrl https://example.invalid/return `
  -CustomerEmail phase0-evidence-test@example.invalid
# -> prints: CAPTURE SESSION ID: <sid>

# 2) ... complete the hosted checkout in your browser ...

# 3) The moment you see success:
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action ObservePaymentSuccess -TestLabel A -CaptureSessionId <sid>

# 4) Verify by transaction ID
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action Verify -TestLabel A -CaptureSessionId <sid> -TransactionId <id-from-checkout>

# 5) Finalize
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action FinalizeManifest -TestLabel A -CaptureSessionId <sid>
```

Repeat all five steps independently for `-TestLabel B` — it gets its own, separate `capture_session_id`; never reuse Test A's session for Test B.

An optional supplemental reference lookup (never a substitute for `Verify`, and not consumed by `FinalizeManifest`):

```powershell
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action ReferenceLookup -TestLabel A -CaptureSessionId <sid> -TxRef <the-tx-ref-you-generated>
```

## Where evidence goes

By default: `%TEMP%\omega3-phase0-flutterwave-evidence\` (override with `-EvidenceRoot`, but it must resolve **outside** this repository — the script refuses to run otherwise, checked before any prompt or network call). Nothing under that directory is committed to git automatically, and the raw (unredacted) capture files are never deleted by this script. Only the final `manifest-Test<Label>-<sessionId>.json` file is meant to ever be copied (by hand, after your own review) into `../PHASE0_FLUTTERWAVE_EVIDENCE.md` — it contains no complete provider response, redacted or otherwise, only allowlisted fields and hashes.

## What never leaves your machine

The TEST secret key, the `Authorization` header, and the unredacted raw provider responses. The script clears the in-memory secret variable and calls `[System.GC]::Collect()` in a `finally` block as **best-effort hygiene** — this reduces the window the plaintext secret might remain resident in memory, but it is **not a cryptographic erasure guarantee**: .NET strings are immutable, and the runtime may have copied the underlying memory during normal operation before the clearing code runs. `ZeroFreeBSTR` does immediately and reliably zero the one unmanaged buffer the secure string was decrypted into, which is a real (if narrow) guarantee — just not one that extends to every copy the .NET runtime may have made.
