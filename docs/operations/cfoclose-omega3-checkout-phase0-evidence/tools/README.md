# Phase 0 Flutterwave evidence collector — tools

Implements `../SANDBOX_TEST_PROTOCOL.md`. TEST MODE ONLY — never point this at a live/production Flutterwave account.

## Files

- `FlutterwaveEvidenceLib.ps1` — pure functions only (redaction, timestamp helpers, response-outcome decision, the pinned flagResult contract mirror, manifest construction). No network call, no secret, no file write. This is what the test suite exercises.
- `Invoke-FlutterwaveEvidenceCapture.ps1` — the real tool. Makes network calls to `https://api.flutterwave.com/v3/...`, prompts for the TEST secret key via `Read-Host -AsSecureString`, writes raw/staged/final evidence **outside this git repository**.
- `tests/FlutterwaveEvidenceLib.Tests.ps1` — focused, dependency-free tests (no Pester needed) for the library. Run this after any change to `FlutterwaveEvidenceLib.ps1`.

## Running the tests

```powershell
pwsh -NoProfile -File tools/tests/FlutterwaveEvidenceLib.Tests.ps1
```

Exits `0` on all-pass, non-zero otherwise, with a `PASS`/`FAIL` line per assertion.

## Running the collector (protocol order)

1. `CreateCheckout` for Test A, then complete the hosted checkout **immediately**.
2. `Verify` for Test A once you have the transaction ID.
3. `FinalizeManifest` for Test A, supplying the UTC time you personally observed checkout success.
4. Repeat 1–3 for Test B, but wait **at least 10 minutes** between opening the hosted checkout and completing it.

```powershell
# Test A — immediate completion
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action CreateCheckout -TestLabel A `
  -Amount 100 -Currency NGN -RedirectUrl https://example.invalid/return `
  -CustomerEmail phase0-evidence-test@example.invalid

# ... complete the hosted checkout in your browser, immediately ...

./Invoke-FlutterwaveEvidenceCapture.ps1 -Action Verify -TestLabel A -TransactionId <id-from-checkout>

./Invoke-FlutterwaveEvidenceCapture.ps1 -Action FinalizeManifest -TestLabel A `
  -PaymentCompletionObservedUtc '2026-09-11T10:15:00.0000000Z'
```

Repeat with `-TestLabel B`, waiting 10+ minutes before completing the checkout.

An optional supplemental reference lookup:

```powershell
./Invoke-FlutterwaveEvidenceCapture.ps1 -Action ReferenceLookup -TestLabel A -TxRef <the-tx-ref-you-generated>
```

## Where evidence goes

By default: `%TEMP%\omega3-phase0-flutterwave-evidence\` (override with `-EvidenceRoot`, but it must resolve **outside** this repository — the script refuses to run otherwise). Nothing under that directory is committed to git automatically, and the raw (unredacted) capture files are never deleted by this script. Only the final, sanitized `manifest-Test*.json` file is meant to ever be copied (by hand, after your own review) into `../PHASE0_FLUTTERWAVE_EVIDENCE.md`.

## What never leaves your machine

The TEST secret key, the `Authorization` header, and the unredacted raw provider responses. The script zeroes the in-memory secret in a `finally` block and never writes it to disk, a log, or an error message.
