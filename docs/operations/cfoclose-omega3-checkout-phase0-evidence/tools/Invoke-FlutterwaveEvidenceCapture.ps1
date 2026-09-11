<#
.SYNOPSIS
  Omega3-CHECKOUT Phase 0 evidence collector for GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS.
  TEST MODE ONLY. Implements SANDBOX_TEST_PROTOCOL.md (one directory up).

.DESCRIPTION
  Hardened, this revision, against a Codex re-audit of the prior collector:

  BLOCKER 1 FIX -- no more denylist redaction of a full response. Every
  manifest field comes from Get-AllowlistedEvidenceFields (an ALLOWLIST:
  only timestamp-shaped fields by name, plus 'status'/'amount'/'currency'),
  plus separately-hashed tx_ref/transaction-id, plus collector-generated
  provenance. No code path in this script ever writes a "sanitized copy of
  the full response" anywhere.

  BLOCKER 2 FIX -- every capture belongs to one immutable
  capture_session_id, generated exactly once by CreateCheckout and required
  as an explicit parameter to every later action. Verify extracts the
  provider's own returned tx_ref and REFUSES to write a stage file (exits
  non-zero) if its hash does not match the checkout stage's tx_ref hash.
  FinalizeManifest requires an explicit -CaptureSessionId, loads ONLY the
  stage files whose filename encodes that exact session id and test label,
  and fails if any required stage is missing, duplicated, or reports a
  mismatched session id or test label internally. There is no "select the
  newest file" anywhere in this script.

  HIGH 1 FIX -- payment-completion time is no longer an arbitrary command-
  line string. ObservePaymentSuccess is its own action: it requires the
  operator to type an exact confirmation phrase, and records DateTime.UtcNow
  itself. checkout_opened_utc is captured by CreateCheckout, immediately
  around the attempt to open the hosted checkout URL. Verify and
  FinalizeManifest both re-validate the full six-point timeline (via
  Test-TimelineOrdering) and REFUSE to proceed on any malformed, non-UTC,
  out-of-order, or (for Test B) too-fast timeline.

  HIGH 2 -- see .github/workflows/ci.yml, which now runs
  tools/tests/FlutterwaveEvidenceLib.Tests.ps1 as part of the existing
  "Lint, Build and Type Check" job.

  Safety properties carried over unchanged:
    - Never accepts a secret key as a command-line argument.
    - Obtains the secret via Read-Host -AsSecureString.
    - Requires an explicit, exact TEST-MODE-CONFIRMED typed confirmation
      before making any network call.
    - Refuses to write any evidence file inside this git repository.
    - Persists the full raw response OUTSIDE the repo; never deletes it.
    - Exits immediately (non-zero) on a non-2xx response or malformed JSON.
    - Clears secret-bearing variables in a `finally` block on a best-effort
      basis (see note below -- this is NOT a cryptographic erasure
      guarantee).

  A note on secret clearing (HIGH 4 correction): `ZeroFreeBSTR` zeroes the
  unmanaged BSTR buffer the secure string was decrypted into, which IS a
  real, immediate zeroing of that specific buffer. It does NOT, and cannot,
  guarantee that the managed .NET string `$secretPlain` was copied into is
  also zeroed or has been garbage-collected by the time this script exits --
  .NET strings are immutable and the runtime may have relocated or copied
  the underlying memory during normal operation. Setting `$secretPlain =
  $null` and calling `[System.GC]::Collect()` is best-effort hygiene that
  reduces the window the secret's plaintext might remain resident in memory;
  it is not a cryptographic erasure guarantee, and this script never claims
  otherwise.

.PARAMETER Action
  CreateCheckout, ObservePaymentSuccess, Verify, ReferenceLookup, or FinalizeManifest.

.EXAMPLE
  # 1) Create the checkout (generates and prints a NEW capture_session_id):
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action CreateCheckout -TestLabel A `
    -Amount 100 -Currency NGN -RedirectUrl https://example.invalid/return `
    -CustomerEmail phase0-evidence-test@example.invalid

  # 2) After completing the hosted checkout (or waiting 10+ min for Test B),
  #    type the exact confirmation phrase when prompted:
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action ObservePaymentSuccess `
    -TestLabel A -CaptureSessionId <the session id from step 1>

  # 3) Verify by transaction ID (from the redirect/webhook callback):
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action Verify -TestLabel A `
    -CaptureSessionId <the session id from step 1> -TransactionId <id>

  # 4) Finalize:
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action FinalizeManifest -TestLabel A `
    -CaptureSessionId <the session id from step 1>
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('CreateCheckout', 'ObservePaymentSuccess', 'Verify', 'ReferenceLookup', 'FinalizeManifest')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [ValidateSet('A', 'B')]
    [string]$TestLabel,

    [string]$CaptureSessionId,
    [string]$TransactionId,
    [string]$TxRef,
    [string]$Amount,
    [string]$Currency,
    [string]$RedirectUrl,
    [string]$CustomerEmail,

    [string]$EvidenceRoot = (Join-Path $env:TEMP 'omega3-phase0-flutterwave-evidence')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'FlutterwaveEvidenceLib.ps1')

function Get-CollectorScriptContentSha256 {
    $libPath = Join-Path $PSScriptRoot 'FlutterwaveEvidenceLib.ps1'
    $mainPath = $PSCommandPath
    $combined = (Get-Content -Path $libPath -Raw) + (Get-Content -Path $mainPath -Raw)
    return Get-Sha256Hex -Text $combined
}

function Get-CollectorScriptGitSha {
    try { return [string](git -C $PSScriptRoot rev-parse HEAD 2>$null) } catch { return '' }
}

function Get-RequiredStage {
    <#
    Thin, exit-on-failure wrapper around the library's pure Get-StageCapture,
    for use at the top level of this script's action handlers.
    #>
    param([string]$ActionName, [string]$TestLabel, [string]$CaptureSessionId)
    $result = Get-StageCapture -EvidenceRoot $EvidenceRoot -ActionName $ActionName -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId
    if (-not $result.Success) {
        $reasonText = switch ($result.Reason) {
            'MISSING' { "not found (expected file: stage-$ActionName-Test$TestLabel-$CaptureSessionId.json). Run that action first." }
            'DUPLICATE' { "matched by more than one file -- structurally unexpected for an exact filename; aborting rather than guessing." }
            'SESSION_MISMATCH' { "found, but its own capture_session_id field disagrees with the requested session '$CaptureSessionId'." }
            'LABEL_MISMATCH' { "found, but its own test_label field disagrees with the requested Test$TestLabel." }
            default { "failed with reason $($result.Reason)." }
        }
        Write-Error "Required stage '$ActionName' for Test$TestLabel / session $CaptureSessionId $reasonText"
        exit 1
    }
    return $result.Data
}

# --- Safety: refuse to write evidence inside the git repository ---
$repoRoot = $null
try { $repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel 2>$null) } catch { }
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
if ($repoRoot) {
    $resolvedRepoRoot = (Resolve-Path $repoRoot).Path
    $resolvedEvidenceRoot = (Resolve-Path $EvidenceRoot).Path
    if ($resolvedEvidenceRoot.StartsWith($resolvedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Error "EvidenceRoot ($EvidenceRoot) resolves INSIDE the git repository ($resolvedRepoRoot). Raw evidence and manifests must never be written inside the repo. Aborting without making any request."
        exit 1
    }
}

# ===========================================================================
# ObservePaymentSuccess -- machine-captured completion timestamp
# ===========================================================================
if ($Action -eq 'ObservePaymentSuccess') {
    if ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
        Write-Error "ObservePaymentSuccess requires -CaptureSessionId (from CreateCheckout)."
        exit 1
    }
    $checkoutStage = Get-RequiredStage -ActionName 'CreateCheckout' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId

    Write-Host ""
    Write-Host "Only proceed once the hosted checkout page has shown PAYMENT SUCCESS." -ForegroundColor Yellow
    $confirm = Read-Host "Type exactly PAYMENT-SUCCESS-CONFIRMED the moment you see success"
    $observedUtc = Get-UtcTimestamp
    if ($confirm -cne 'PAYMENT-SUCCESS-CONFIRMED') {
        Write-Error "Confirmation phrase did not match exactly. No observation recorded. Aborting."
        exit 1
    }

    $elapsedSeconds = ([DateTime]::Parse($observedUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) -
                        [DateTime]::Parse($checkoutStage.checkout_opened_utc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)).TotalSeconds

    $isTestB = ($TestLabel -eq 'B')
    if ($isTestB -and $elapsedSeconds -lt 600) {
        Write-Error "Test B requires at least 600 seconds between checkout_opened_utc and payment_completion_observed_utc; only $([math]::Round($elapsedSeconds, 3)) seconds elapsed. No observation recorded. Wait longer and retry."
        exit 1
    }

    $stage = [ordered]@{
        capture_session_id                 = $CaptureSessionId
        test_label                         = $TestLabel
        action                              = 'ObservePaymentSuccess'
        checkout_opened_utc                = $checkoutStage.checkout_opened_utc
        payment_completion_observed_utc    = $observedUtc
        elapsed_seconds_since_checkout_opened = $elapsedSeconds
        test_b_minimum_met                 = $(if ($isTestB) { $elapsedSeconds -ge 600 } else { $null })
    }
    $stagePath = Join-Path $EvidenceRoot "stage-ObservePaymentSuccess-Test$TestLabel-$CaptureSessionId.json"
    Set-Content -Path $stagePath -Value ($stage | ConvertTo-Json -Depth 8) -Encoding UTF8 -NoNewline

    Write-Host ""
    Write-Host "Payment-success observation recorded for Test$TestLabel." -ForegroundColor Green
    Write-Host "  Elapsed since checkout_opened_utc: $([math]::Round($elapsedSeconds, 3)) seconds"
    Write-Host "  Stage file: $stagePath"
    exit 0
}

# ===========================================================================
# FinalizeManifest -- exact session id, exactly-one-each stage requirement
# ===========================================================================
if ($Action -eq 'FinalizeManifest') {
    if ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
        Write-Error "FinalizeManifest requires -CaptureSessionId. There is no 'latest file' fallback."
        exit 1
    }

    $checkoutStage = Get-RequiredStage -ActionName 'CreateCheckout' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId
    $observeStage = Get-RequiredStage -ActionName 'ObservePaymentSuccess' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId
    $verifyStage = Get-RequiredStage -ActionName 'Verify' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId

    if ($checkoutStage.tx_ref_sha256 -ne $verifyStage.tx_ref_sha256) {
        Write-Error "tx_ref hash mismatch between CreateCheckout and Verify stages for session $CaptureSessionId. This should have already been rejected at Verify time -- refusing to finalize regardless."
        exit 1
    }

    $timeline = Test-TimelineOrdering `
        -CheckoutRequestStartUtc $checkoutStage.request_start_utc `
        -CheckoutRequestEndUtc $checkoutStage.request_end_utc `
        -CheckoutOpenedUtc $checkoutStage.checkout_opened_utc `
        -PaymentCompletionObservedUtc $observeStage.payment_completion_observed_utc `
        -VerifyRequestStartUtc $verifyStage.request_start_utc `
        -VerifyRequestEndUtc $verifyStage.request_end_utc `
        -IsTestB ($TestLabel -eq 'B')

    if (-not $timeline.Valid) {
        Write-Error "Timeline validation failed at finalize time: $($timeline.Reason). Refusing to produce a manifest for an invalid timeline."
        exit 1
    }

    $manifest = New-EvidenceManifest `
        -CaptureSessionId $CaptureSessionId `
        -TestLabel $TestLabel `
        -TxRefSha256 $checkoutStage.tx_ref_sha256 `
        -TransactionIdSha256 $verifyStage.transaction_id_sha256 `
        -TestModeConfirmed $true `
        -ApiVersion 'v3' `
        -CheckoutEndpoint $checkoutStage.endpoint `
        -VerifyEndpoint $verifyStage.endpoint `
        -CheckoutRequestStartUtc $checkoutStage.request_start_utc `
        -CheckoutRequestEndUtc $checkoutStage.request_end_utc `
        -CheckoutOpenedUtc $checkoutStage.checkout_opened_utc `
        -PaymentCompletionObservedUtc $observeStage.payment_completion_observed_utc `
        -VerifyRequestStartUtc $verifyStage.request_start_utc `
        -VerifyRequestEndUtc $verifyStage.request_end_utc `
        -ElapsedSecondsSinceCheckoutOpened $observeStage.elapsed_seconds_since_checkout_opened `
        -TimelineValid $true `
        -ProviderEvidenceFields (@($checkoutStage.provider_evidence_fields) + @($verifyStage.provider_evidence_fields)) `
        -CheckoutRawResponseSha256 $checkoutStage.raw_response_sha256 `
        -VerifyRawResponseSha256 $verifyStage.raw_response_sha256 `
        -CollectorScriptGitSha (Get-CollectorScriptGitSha) `
        -CollectorScriptContentSha256 (Get-CollectorScriptContentSha256) `
        -PowerShellVersion $PSVersionTable.PSVersion.ToString() `
        -MachineUtcOffsetMinutes ([System.TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes)

    $manifestJson = $manifest | ConvertTo-Json -Depth 12
    $manifestPath = Join-Path $EvidenceRoot "manifest-Test$TestLabel-$CaptureSessionId.json"
    Set-Content -Path $manifestPath -Value $manifestJson -Encoding UTF8 -NoNewline
    $manifestHash = (Get-FileHash -Path $manifestPath -Algorithm SHA256).Hash

    Write-Host ""
    Write-Host "Manifest finalized for Test$TestLabel, session $CaptureSessionId." -ForegroundColor Green
    Write-Host "  Manifest: $manifestPath"
    Write-Host "  Manifest SHA-256: $manifestHash"
    Write-Host ""
    Write-Host "This manifest contains ONLY allowlisted evidence fields (timestamps/status/amount/currency), hashed identifiers, and collector provenance -- never a copy of the full provider response. Review it, then copy it into PHASE0_FLUTTERWAVE_EVIDENCE.md if you choose to share it." -ForegroundColor Cyan
    exit 0
}

# ===========================================================================
# CreateCheckout / Verify / ReferenceLookup -- the real network-calling,
# secret-handling actions.
# ===========================================================================

Write-Host ""
Write-Host "=== Omega3-CHECKOUT Phase 0 Flutterwave Evidence Collector ===" -ForegroundColor Yellow
Write-Host "This tool MUST ONLY be used with a Flutterwave TEST-mode secret key." -ForegroundColor Yellow
Write-Host "Never provide a LIVE/production secret key to this tool." -ForegroundColor Yellow
$confirmation = Read-Host "Type exactly TEST-MODE-CONFIRMED to proceed"
if ($confirmation -cne 'TEST-MODE-CONFIRMED') {
    Write-Error "Confirmation phrase did not match exactly. Aborting without making any request."
    exit 1
}

$secureSecret = Read-Host -Prompt 'Enter Flutterwave TEST secret key (input hidden)' -AsSecureString
$bstr = [IntPtr]::Zero
$secretPlain = $null
$headers = $null

try {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $secretPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    if (-not (Test-IsTestModeKey -KeyValue $secretPlain)) {
        Write-Error "The provided key does not match Flutterwave's documented TEST secret-key format (FLWSECK_TEST-<32 hex chars>-X). Aborting -- refusing to guess whether this is a live key or a malformed input."
        exit 1
    }

    if ($Action -eq 'CreateCheckout') {
        if ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
            $CaptureSessionId = [guid]::NewGuid().ToString('N')
        }
        else {
            Write-Error "CreateCheckout ALWAYS generates a new capture_session_id -- it does not accept one as input. This is what makes session reuse across unrelated checkouts structurally impossible. Remove -CaptureSessionId and re-run."
            exit 1
        }
    }
    elseif ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
        Write-Error "$Action requires -CaptureSessionId (from CreateCheckout)."
        exit 1
    }

    $txRefToUse = $TxRef
    if ($Action -eq 'CreateCheckout' -and [string]::IsNullOrWhiteSpace($txRefToUse)) {
        $txRefToUse = "omega3-phase0-$TestLabel-$CaptureSessionId"
    }

    $checkoutStageForVerify = $null
    if ($Action -eq 'Verify') {
        $checkoutStageForVerify = Get-RequiredStage -ActionName 'CreateCheckout' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId
        $observeStageForVerify = Get-RequiredStage -ActionName 'ObservePaymentSuccess' -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId
    }

    $headers = @{
        Authorization  = "Bearer $secretPlain"
        'Content-Type' = 'application/json'
    }

    $requestStartUtc = Get-UtcTimestamp
    $statusCode = $null
    $rawBody = $null
    $uri = $null

    try {
        switch ($Action) {
            'CreateCheckout' {
                if (-not $Amount -or -not $Currency -or -not $RedirectUrl -or -not $CustomerEmail) {
                    Write-Error "CreateCheckout requires -Amount, -Currency, -RedirectUrl, -CustomerEmail (use disposable TEST values only -- never a real customer's)."
                    exit 1
                }
                $uri = 'https://api.flutterwave.com/v3/payments'
                $bodyJson = (@{
                        tx_ref       = $txRefToUse
                        amount       = $Amount
                        currency     = $Currency
                        redirect_url = $RedirectUrl
                        customer     = @{ email = $CustomerEmail }
                    }) | ConvertTo-Json -Depth 5
                $webResponse = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -Body $bodyJson -ContentType 'application/json' -UseBasicParsing
            }
            'Verify' {
                if (-not $TransactionId) {
                    Write-Error "Verify requires -TransactionId."
                    exit 1
                }
                $uri = "https://api.flutterwave.com/v3/transactions/$TransactionId/verify"
                $webResponse = Invoke-WebRequest -Uri $uri -Method Get -Headers $headers -UseBasicParsing
            }
            'ReferenceLookup' {
                if (-not $TxRef) {
                    Write-Error "ReferenceLookup requires -TxRef (supplemental only -- never a substitute for Verify)."
                    exit 1
                }
                $uri = "https://api.flutterwave.com/v3/transactions?tx_ref=$TxRef"
                $webResponse = Invoke-WebRequest -Uri $uri -Method Get -Headers $headers -UseBasicParsing
            }
        }
        $statusCode = [int]$webResponse.StatusCode
        $rawBody = $webResponse.Content
    }
    catch {
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $rawBody = $reader.ReadToEnd()
            }
            catch { $rawBody = '' }
        }
        else {
            $statusCode = 0
            $rawBody = $_.Exception.Message
        }
    }

    $requestEndUtc = Get-UtcTimestamp

    $outcome = Get-CaptureOutcome -StatusCode $statusCode -RawBody $rawBody
    if (-not $outcome.Success) {
        $failPath = Join-Path $EvidenceRoot "FAILED-$Action-Test$TestLabel-$([guid]::NewGuid().ToString('N')).json"
        Set-Content -Path $failPath -Value $rawBody -Encoding UTF8
        Write-Error "Capture failed (reason: $($outcome.Reason), status: $statusCode). No stage file written. Raw failure body saved (outside the repo) at: $failPath. Aborting."
        exit 1
    }

    $rawFileName = "raw-$Action-Test$TestLabel-$CaptureSessionId-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
    $rawFilePath = Join-Path $EvidenceRoot $rawFileName
    Set-Content -Path $rawFilePath -Value $rawBody -Encoding UTF8 -NoNewline
    $rawHash = (Get-FileHash -Path $rawFilePath -Algorithm SHA256).Hash

    $evidenceFields = Get-AllowlistedEvidenceFields -Node $outcome.Parsed

    if ($Action -eq 'CreateCheckout') {
        $checkoutOpenedUtc = Get-UtcTimestamp
        try {
            Start-Process $uri -ErrorAction SilentlyContinue | Out-Null
        }
        catch { }
        # checkout_opened_utc is captured immediately around the attempt to
        # open the hosted checkout URL, whether or not Start-Process actually
        # succeeded (e.g. headless environments) -- it marks the moment this
        # tool handed off to the operator, which is what the timeline needs.

        $stage = [ordered]@{
            capture_session_id      = $CaptureSessionId
            test_label              = $TestLabel
            action                   = 'CreateCheckout'
            endpoint                 = $uri
            tx_ref_sha256            = Get-Sha256Hex -Text $txRefToUse
            request_start_utc       = $requestStartUtc
            request_end_utc         = $requestEndUtc
            checkout_opened_utc     = $checkoutOpenedUtc
            http_status              = $statusCode
            raw_response_sha256     = $rawHash
            provider_evidence_fields = $evidenceFields
        }
        $stagePath = Join-Path $EvidenceRoot "stage-CreateCheckout-Test$TestLabel-$CaptureSessionId.json"
        Set-Content -Path $stagePath -Value ($stage | ConvertTo-Json -Depth 12) -Encoding UTF8 -NoNewline

        Write-Host ""
        Write-Host "CreateCheckout complete for Test$TestLabel." -ForegroundColor Green
        Write-Host "  CAPTURE SESSION ID (save this -- every later step needs it exactly): $CaptureSessionId" -ForegroundColor Magenta
        Write-Host "  Stage file: $stagePath"
        Write-Host ""
        if ($TestLabel -eq 'B') {
            Write-Host "Test B: wait at least 10 minutes AFTER checkout_opened_utc before completing payment." -ForegroundColor Cyan
        }
        Write-Host "Next: complete the hosted checkout, then run -Action ObservePaymentSuccess -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId" -ForegroundColor Cyan
    }
    elseif ($Action -eq 'Verify') {
        $providerTxRef = Get-DataField -Parsed $outcome.Parsed -FieldName 'tx_ref'
        if ([string]::IsNullOrWhiteSpace($providerTxRef)) {
            Write-Error "Verify response did not contain data.tx_ref -- cannot bind this verification to the checkout session. No stage file written."
            exit 1
        }
        $providerTxRefSha256 = Get-Sha256Hex -Text $providerTxRef
        if ($providerTxRefSha256 -ne $checkoutStageForVerify.tx_ref_sha256) {
            Write-Error "tx_ref MISMATCH: the verify response's own tx_ref does not match the tx_ref this session's CreateCheckout generated. This verification does NOT describe the same transaction as this capture session. No stage file written -- this is exactly the cross-transaction contamination this check exists to prevent."
            exit 1
        }

        $providerTransactionId = Get-DataField -Parsed $outcome.Parsed -FieldName 'id'
        $transactionIdSha256 = if ($providerTransactionId) { Get-Sha256Hex -Text $providerTransactionId } else { Get-Sha256Hex -Text $TransactionId }

        $timeline = Test-TimelineOrdering `
            -CheckoutRequestStartUtc $checkoutStageForVerify.request_start_utc `
            -CheckoutRequestEndUtc $checkoutStageForVerify.request_end_utc `
            -CheckoutOpenedUtc $checkoutStageForVerify.checkout_opened_utc `
            -PaymentCompletionObservedUtc $observeStageForVerify.payment_completion_observed_utc `
            -VerifyRequestStartUtc $requestStartUtc `
            -VerifyRequestEndUtc $requestEndUtc `
            -IsTestB ($TestLabel -eq 'B')

        if (-not $timeline.Valid) {
            Write-Error "Timeline validation failed: $($timeline.Reason). No stage file written."
            exit 1
        }

        $stage = [ordered]@{
            capture_session_id           = $CaptureSessionId
            test_label                   = $TestLabel
            action                        = 'Verify'
            endpoint                      = $uri
            tx_ref_sha256                 = $providerTxRefSha256
            transaction_id_sha256         = $transactionIdSha256
            tx_ref_hash_matches_checkout  = $true
            request_start_utc            = $requestStartUtc
            request_end_utc              = $requestEndUtc
            http_status                   = $statusCode
            raw_response_sha256          = $rawHash
            provider_evidence_fields      = $evidenceFields
            timeline_valid                = $true
        }
        $stagePath = Join-Path $EvidenceRoot "stage-Verify-Test$TestLabel-$CaptureSessionId.json"
        Set-Content -Path $stagePath -Value ($stage | ConvertTo-Json -Depth 12) -Encoding UTF8 -NoNewline

        Write-Host ""
        Write-Host "Verify complete for Test$TestLabel -- tx_ref confirmed to match this capture session." -ForegroundColor Green
        Write-Host "  Stage file: $stagePath"
        Write-Host ""
        Write-Host "Next: -Action FinalizeManifest -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId" -ForegroundColor Cyan
    }
    else {
        # ReferenceLookup -- supplemental only, not written as a required stage.
        Write-Host ""
        Write-Host "ReferenceLookup complete (SUPPLEMENTAL ONLY -- not used by FinalizeManifest)." -ForegroundColor Green
        Write-Host "  Raw response SHA-256: $rawHash"
        Write-Host "  Allowlisted fields: $($evidenceFields | ConvertTo-Json -Depth 6)"
    }
}
finally {
    if ($secretPlain) { $secretPlain = $null }
    if ($bstr -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($headers) {
        $headers.Authorization = $null
        Remove-Variable -Name headers -ErrorAction SilentlyContinue
    }
    Remove-Variable -Name secretPlain -ErrorAction SilentlyContinue
    Remove-Variable -Name secureSecret -ErrorAction SilentlyContinue
    [System.GC]::Collect()
}
