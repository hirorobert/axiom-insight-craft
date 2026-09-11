# Phase 0 Flutterwave evidence collector — tools

Implements `../SANDBOX_TEST_PROTOCOL.md`. TEST MODE ONLY — never point this at a live/production Flutterwave account.

**Hardened, this revision, against a Codex re-audit of the prior collector** (see the file-header comments in each script for the full rationale):

- **No more denylist redaction.** `Get-AllowlistedEvidenceFields` (an ALLOWLIST — only timestamp-shaped fields by name, plus `status`/`amount`/`currency`) replaces the earlier denylist entirely. No manifest ever contains a "sanitized copy of the full response" — only the allowlisted fields, hashed identifiers, and collector-generated provenance.
- **Every capture belongs to one immutable `capture_session_id`**, generated once by `CreateCheckout` and required by every later action. `Verify` extracts the provider's own returned `tx_ref` and refuses to write a stage file if its hash doesn't match the checkout's — a checkout and a verification can no longer be silently combined across unrelated transactions. `FinalizeManifest` requires an explicit `-CaptureSessionId`; there is no "latest file" fallback anywhere.
- **Payment-completion time is machine-captured**, not an arbitrary command-line string. `ObservePaymentSuccess` is its own action — it requires an exact typed confirmation and records `DateTime.UtcNow` itself. The full six-point timeline (`checkout_request_start ≤ checkout_request_end ≤ checkout_opened ≤ payment_completion_observed ≤ verify_request_start ≤ verify_request_end`) is validated at both `Verify` and `FinalizeManifest` time, and Test B additionally requires ≥600 seconds between `checkout_opened_utc` and `payment_completion_observed_utc`.
- **TEST-key validation is fail-closed against the documented format** (`FLWSECK_TEST-<32 hex>-X`, case-sensitive) — a key is no longer accepted merely for containing the substring "test".

## Files

- `FlutterwaveEvidenceLib.ps1` — pure functions only: the allowlist projector, timestamp/timeline validation, the hardened key-format check, session-bound stage-file lookup, the pinned flagResult contract mirror, manifest construction. No network call, no secret, no file write except within the test suite's own temp directories. This is what the test suite exercises directly.
- `Invoke-FlutterwaveEvidenceCapture.ps1` — the real tool. Makes network calls to `https://api.flutterwave.com/v3/...`, prompts for the TEST secret key via `Read-Host -AsSecureString`, writes raw/staged/final evidence **outside this git repository**.
- `tests/FlutterwaveEvidenceLib.Tests.ps1` — focused, dependency-free tests (no Pester needed). Also run automatically in CI (`.github/workflows/ci.yml`, "Lint, Build and Type Check" job). Run this after any change to `FlutterwaveEvidenceLib.ps1`.

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
