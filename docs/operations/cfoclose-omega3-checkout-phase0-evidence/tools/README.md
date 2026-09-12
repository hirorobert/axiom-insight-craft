# Phase 0 Flutterwave evidence collector — tools

Implements `../SANDBOX_TEST_PROTOCOL.md`. TEST MODE ONLY — never point this at a live/production Flutterwave account.

**Hardened again, this revision, against a Codex FINAL PROVENANCE CLOSURE re-audit** (see the file-header comments in each script for the full rationale):

- **BLOCKER 1 FIXED — the exact raw provider response is now RETAINED, not merely hashed.** The prior revision computed `raw_response_sha256` from the HTTP response body but never persisted that body anywhere, so the hash could never be independently re-verified against anything and the claim of "independently verifiable evidence" did not hold. Both `CreateCheckout` and `Verify` now follow a strict byte-authority sequence: the HTTP port returns the response as raw bytes (`BodyBytes`, not a decoded string) → `Test-IsSafeResponseBoundary` checks the response is well-formed → `New-ImmutableBytesFile` atomically persists those EXACT bytes, write-once, to a deterministic session-bound filename (`Get-RawEvidenceFileName`: `raw-<Action>-Test<Label>-<CaptureSessionId>.json`) OUTSIDE the repository → `Get-Sha256HexFromBytes` hashes THOSE SAME bytes → the SAME bytes are UTF-8 decoded for JSON parsing and sanitized-stage construction. No JSON is ever reserialized before hashing. If raw persistence fails for any reason, the action aborts immediately: `CreateCheckout` never opens the browser and never writes a stage; `Verify` never writes a verification stage (so `FinalizeManifest` can never succeed for that session). An orphan raw file is acceptable if a later step fails; a sanitized stage without its corresponding raw file is not possible by construction. `FinalizeManifest` independently reopens both retained raw files via `Get-RetainedRawBytes` and re-hashes their CURRENT on-disk bytes, refusing to write any manifest if either file is missing, duplicated, unreadable, or its hash no longer matches the stage's own recorded `raw_response_sha256`. Raw files, and the local filesystem paths to them, are never printed to the console, never embedded in a sanitized stage, and never embedded in the manifest — the manifest records only the bare raw-evidence filename and its SHA-256.
- **BLOCKER 2 FIXED — `FinalizeManifest` now proves the manifest names the version that ACTUALLY produced the evidence, not just that the stages agree with each other.** The prior revision's own check (`@($contentHashes | Select-Object -Unique).Count -ne 1`) only proved internal consistency across the three stages; it never compared that common value against the CURRENTLY EXECUTING finalizer's own collector identity, so evidence produced by collector version X could be finalized by a differently-versioned collector Y, and the manifest would still record whichever value was common to the stages regardless. `Invoke-FinalizeManifestOrchestration` now requires explicit three-way equality — every stage's `collector_script_content_sha256` AND the current finalizer's own value must all match, or finalization fails closed with `COLLECTOR_CONTENT_VERSION_MISMATCH` — and the identical strict policy for `collector_script_git_sha`, which additionally must be non-empty (`COLLECTOR_GIT_VERSION_MISMATCH` otherwise; an undeterminable Git SHA is a provenance gap, never a pass).
- **HIGH FIXED — `SANDBOX_TEST_PROTOCOL.md`'s manual timestamp-recording instructions now match the collector's actual exact-key-plus-value allowlist**, rather than the earlier broad-substring description that would have let a firm's hand-run capture disagree with what the tooling itself enforces. The code was already correct; only the stale prose was corrected to match it.
- Everything from the prior revision remains in force: `Get-HostedCheckoutLink` opens the ACTUAL hosted-checkout page (`data.link`), never the API endpoint; the timestamp allowlist is exact-key AND value-validated (`expiry`/`created_by`/`date_created` never qualify); stage files and the manifest are write-once (`New-ImmutableJsonFile`, atomic CREATE-NEW); `Verify` requires BOTH `data.id` and `data.tx_ref` to match what was requested; the full orchestration path (`Invoke-CreateCheckoutOrchestration` / `Invoke-ObservePaymentSuccessOrchestration` / `Invoke-VerifyOrchestration` / `Invoke-FinalizeManifestOrchestration`) is driven end-to-end in tests via injected HTTP/browser/clock ports, not inferred from helper-level tests alone; every capture belongs to one immutable `capture_session_id`; TEST-key validation is fail-closed against the documented `FLWSECK_TEST-<32 hex>-X` format.
- **This closure makes the collector safe enough to execute the controlled sandbox experiment. It does NOT close the Flutterwave `created_at` timestamp-semantics gate** — that gate stays OPEN until the sandbox experiment is actually run and its evidence reviewed (see `../PHASE0_FLUTTERWAVE_EVIDENCE.md`).

**Hardened once more, this revision, against a Codex FINAL LIVE HTTP BYTE-BOUNDARY audit** — the one remaining gap in the byte-authority chain above: the real HTTP ports in `Invoke-FlutterwaveEvidenceCapture.ps1` claimed to return raw `BodyBytes`, but obtained them by re-encoding the response object's own decoded-text property (`.Content`) or a decoded-text stream reader — both are a STRING reconstruction, not the genuine wire bytes, and a response using a non-UTF8 encoding, a BOM, or any byte sequence not perfectly round-trippable through decode+re-encode would have been silently corrupted before it was ever hashed or persisted. Corrected: both ports now call `Get-WebResponseBytes` (success path, reads `RawContentStream` — the same raw bytes Invoke-WebRequest read off the wire, before any string decoding, on both Windows PowerShell 5.1 and PowerShell 7+) and `Get-ErrorResponseBytes` (non-2xx path, tries both the Windows PowerShell 5.1 shape — `GetResponseStream()` — and the PowerShell 7+ shape — `.Content.ReadAsByteArrayAsync()` — since the two engines throw structurally different exception/response types for the same HTTP error). Both functions live in `FlutterwaveEvidenceLib.ps1` and are exercised directly by the test suite, so the production adapter and the tests run the identical byte-extraction code, never two parallel implementations. If genuine bytes cannot be obtained even though a real HTTP response was received, the port returns `BodyBytes = $null` (never a fabricated substitute) and the orchestration layer fails closed with `RAW_RESPONSE_BYTES_UNAVAILABLE` — no raw file, no stage. A total transport failure (no HTTP response object at all) now returns `StatusCode = $null` / `BodyBytes = $null` — the earlier revision's invented `StatusCode = 0` sentinel is gone, and `Test-IsValidHttpStatusCode` now rejects `0` and any value outside the real HTTP range `[100, 599]` explicitly, so an invented status can never again be mistaken for a genuine response. The exception's diagnostic message is preserved only as a local `TransportError` field — never hashed, never persisted as evidence, never treated as provider-response bytes.

## Files

- `FlutterwaveEvidenceLib.ps1` — the real logic: `Get-HostedCheckoutLink`, the exact-key+value timestamp allowlist, `New-ImmutableJsonFile`/`New-ImmutableBytesFile` (write-once JSON and raw-byte persistence), `Get-Sha256HexFromBytes`/`Get-RetainedRawBytes`/`Get-RawEvidenceFileName` (the byte-authority raw-retention primitives), `Test-IsValidHttpStatusCode`/`Get-WebResponseBytes`/`Get-ErrorResponseBytes` (the genuine, cross-platform, byte-native HTTP transport-boundary primitives — never a decoded-string reconstruction), timeline validation, session-bound stage-file lookup, the pinned flagResult contract mirror, manifest construction, AND the four `Invoke-*Orchestration` functions that drive each action end to end using injected HTTP/browser/clock ports. No network call, no secret, no real browser launch, no file write except within a caller-supplied EvidenceRoot (a temp directory in tests). This is what the test suite exercises directly — including the full orchestration path and the byte-extraction functions themselves, not just individual helpers.
- `Invoke-FlutterwaveEvidenceCapture.ps1` — a THIN CLI WRAPPER. Its only job is to prompt for/hold the secret exactly as long as needed, build the REAL HTTP/browser/clock ports (`Invoke-WebRequest` plus `Get-WebResponseBytes`/`Get-ErrorResponseBytes` for genuine byte extraction, `Start-Process`, `Get-UtcTimestamp`), and call the same orchestration functions the tests call with fake ports.
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
5. `FinalizeManifest` — by the same `capture_session_id`. Requires exactly one of each prior stage for this session; fails on any missing, duplicate, or cross-session stage. Also reopens and re-hashes the retained raw evidence files for `CreateCheckout` and `Verify`, failing closed (no manifest written) if either is missing, unreadable, or its bytes no longer match what the stage recorded; and requires every stage's collector identity (content hash and Git SHA) to match the CURRENTLY EXECUTING collector, failing closed with `COLLECTOR_CONTENT_VERSION_MISMATCH`/`COLLECTOR_GIT_VERSION_MISMATCH` otherwise.

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

By default: `%TEMP%\omega3-phase0-flutterwave-evidence\` (override with `-EvidenceRoot`, but it must resolve **outside** this repository — the script refuses to run otherwise, checked before any prompt or network call). Nothing under that directory is committed to git automatically. `CreateCheckout` and `Verify` each write their own raw evidence file there (`raw-CreateCheckout-Test<Label>-<sessionId>.json`, `raw-Verify-Test<Label>-<sessionId>.json`) holding the EXACT bytes of the provider's response — write-once, never overwritten, never automatically deleted by this script, never printed to the console, and never copied into any stage or manifest JSON. Only the final `manifest-Test<Label>-<sessionId>.json` file is meant to ever be copied (by hand, after your own review) into `../PHASE0_FLUTTERWAVE_EVIDENCE.md` — it contains no complete provider response, redacted or otherwise, only allowlisted fields, raw-evidence filenames, and hashes.

## What never leaves your machine

The TEST secret key, the `Authorization` header, and the unredacted raw provider responses. The script clears the in-memory secret variable and calls `[System.GC]::Collect()` in a `finally` block as **best-effort hygiene** — this reduces the window the plaintext secret might remain resident in memory, but it is **not a cryptographic erasure guarantee**: .NET strings are immutable, and the runtime may have copied the underlying memory during normal operation before the clearing code runs. `ZeroFreeBSTR` does immediately and reliably zero the one unmanaged buffer the secure string was decrypted into, which is a real (if narrow) guarantee — just not one that extends to every copy the .NET runtime may have made.
