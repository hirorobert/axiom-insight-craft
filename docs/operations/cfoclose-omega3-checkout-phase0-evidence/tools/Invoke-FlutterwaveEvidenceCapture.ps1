<#
.SYNOPSIS
  Ω3-CHECKOUT Phase 0 evidence collector for GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS.
  TEST MODE ONLY. Implements SANDBOX_TEST_PROTOCOL.md (one directory up).

.DESCRIPTION
  Narrowly-scoped, disposable tool. It performs exactly the HTTP calls the
  protocol specifies, against Flutterwave's real v3 API, in TEST mode only.

  Safety properties (see docs/operations/cfoclose-omega3-checkout-phase0-evidence
  for the full requirements this implements):
    - Never accepts a secret key as a command-line argument.
    - Obtains the secret via Read-Host -AsSecureString; never writes it,
      never includes it in any log line, error message, or output object.
    - Requires an explicit, exact TEST-MODE-CONFIRMED typed confirmation
      before making any network call.
    - Refuses to write any evidence file inside this git repository —
      -EvidenceRoot must resolve outside the repo, checked at startup.
    - Generates a fresh, locally-created tx_ref for CreateCheckout.
    - Records UTC timestamps around every request.
    - Persists the full raw response OUTSIDE the repo, and computes its
      SHA-256 — the raw file is never deleted by this script.
    - Produces a REDACTED, sanitized view for the manifest via
      ConvertTo-RedactedObject (FlutterwaveEvidenceLib.ps1) — account/
      merchant/customer identifiers, card token, first-six/last-four
      digits, IP/device fingerprint, authorization material, email, phone,
      and name are stripped; timestamps, status, amount, and currency are
      retained.
    - Exits immediately (non-zero) on a non-2xx response or malformed JSON,
      via the pure Get-CaptureOutcome function, writing no manifest.
    - Zeroes/removes every secret-bearing variable in a `finally` block.

  Actions:
    CreateCheckout   : POST https://api.flutterwave.com/v3/payments
    Verify           : GET  https://api.flutterwave.com/v3/transactions/{TransactionId}/verify
    ReferenceLookup  : GET  https://api.flutterwave.com/v3/transactions?tx_ref={TxRef}  (SUPPLEMENTAL ONLY)
    FinalizeManifest : combines the CreateCheckout + Verify (+ optional
                       ReferenceLookup) stage captures for one TestLabel into
                       the single provenance manifest Correction 4 requires,
                       and hashes that manifest.

.PARAMETER PaymentCompletionObservedUtc
  Required for FinalizeManifest. The UTC timestamp (ISO-8601, e.g. from
  Get-UtcTimestamp run by hand at the moment) you personally observed the
  hosted checkout report success. This is a human observation, not something
  this script can capture on its own — record it the moment it happens.

.EXAMPLE
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action CreateCheckout -TestLabel A `
    -Amount 100 -Currency NGN -RedirectUrl https://example.invalid/return `
    -CustomerEmail phase0-evidence-test@example.invalid

.EXAMPLE
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action Verify -TestLabel A -TransactionId 1234567

.EXAMPLE
  ./Invoke-FlutterwaveEvidenceCapture.ps1 -Action FinalizeManifest -TestLabel A `
    -PaymentCompletionObservedUtc '2026-09-11T10:15:00.0000000Z'
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('CreateCheckout', 'Verify', 'ReferenceLookup', 'FinalizeManifest')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [ValidateSet('A', 'B')]
    [string]$TestLabel,

    [string]$TransactionId,
    [string]$TxRef,
    [string]$Amount,
    [string]$Currency,
    [string]$RedirectUrl,
    [string]$CustomerEmail,
    [string]$PaymentCompletionObservedUtc,

    [string]$EvidenceRoot = (Join-Path $env:TEMP 'omega3-phase0-flutterwave-evidence')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'FlutterwaveEvidenceLib.ps1')

# --- Safety: refuse to write evidence inside the git repository ---
$repoRoot = $null
try { $repoRoot = (git -C $PSScriptRoot rev-parse --show-toplevel 2>$null) } catch { }
if ($repoRoot) {
    $resolvedRepoRoot = (Resolve-Path $repoRoot).Path
    New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
    $resolvedEvidenceRoot = (Resolve-Path $EvidenceRoot).Path
    if ($resolvedEvidenceRoot.StartsWith($resolvedRepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Error "EvidenceRoot ($EvidenceRoot) resolves INSIDE the git repository ($resolvedRepoRoot). Raw evidence and manifests must never be written inside the repo. Aborting without making any request."
        exit 1
    }
}
else {
    New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
}

if ($Action -eq 'FinalizeManifest') {
    if ([string]::IsNullOrWhiteSpace($PaymentCompletionObservedUtc)) {
        Write-Error "FinalizeManifest requires -PaymentCompletionObservedUtc (the UTC time you personally observed checkout success)."
        exit 1
    }

    $checkoutStage = Get-ChildItem -Path $EvidenceRoot -Filter "stage-CreateCheckout-Test$TestLabel-*.json" | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $verifyStage = Get-ChildItem -Path $EvidenceRoot -Filter "stage-Verify-Test$TestLabel-*.json" | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $refStage = Get-ChildItem -Path $EvidenceRoot -Filter "stage-ReferenceLookup-Test$TestLabel-*.json" | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1

    if (-not $checkoutStage -or -not $verifyStage) {
        Write-Error "Could not find both a CreateCheckout and a Verify stage capture for Test$TestLabel under $EvidenceRoot. Run those actions first."
        exit 1
    }

    $checkoutData = Get-Content -Path $checkoutStage.FullName -Raw | ConvertFrom-Json
    $verifyData = Get-Content -Path $verifyStage.FullName -Raw | ConvertFrom-Json
    $refData = if ($refStage) { Get-Content -Path $refStage.FullName -Raw | ConvertFrom-Json } else { $null }

    $manifest = New-EvidenceManifest `
        -TestLabel $TestLabel `
        -TxRefSha256 $checkoutData.tx_ref_sha256 `
        -TestModeConfirmed $true `
        -ApiVersion 'v3' `
        -CheckoutEndpoint $checkoutData.endpoint `
        -CheckoutRequestStartUtc $checkoutData.request_start_utc `
        -CheckoutRequestEndUtc $checkoutData.request_end_utc `
        -PaymentCompletionObservedUtc $PaymentCompletionObservedUtc `
        -VerifyEndpoint $verifyData.endpoint `
        -VerifyRequestStartUtc $verifyData.request_start_utc `
        -VerifyRequestEndUtc $verifyData.request_end_utc `
        -ProviderTimestamps $verifyData.sanitized_response `
        -CheckoutRawResponseSha256 $checkoutData.raw_response_sha256 `
        -VerifyRawResponseSha256 $verifyData.raw_response_sha256 `
        -CollectorScriptGitSha (if ($repoRoot) { (git -C $PSScriptRoot rev-parse HEAD 2>$null) } else { '' }) `
        -PowerShellVersion $PSVersionTable.PSVersion.ToString() `
        -MachineUtcOffsetMinutes ([System.TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes) `
        -SupplementalReferenceLookup $(if ($refData) { $refData.sanitized_response } else { $null })

    $manifestJson = $manifest | ConvertTo-Json -Depth 12
    $manifestFileName = "manifest-Test$TestLabel-$([guid]::NewGuid().ToString('N')).json"
    $manifestPath = Join-Path $EvidenceRoot $manifestFileName
    Set-Content -Path $manifestPath -Value $manifestJson -Encoding UTF8 -NoNewline
    $manifestHash = (Get-FileHash -Path $manifestPath -Algorithm SHA256).Hash

    Write-Host ""
    Write-Host "Manifest finalized for Test$TestLabel." -ForegroundColor Green
    Write-Host "  Manifest: $manifestPath"
    Write-Host "  Manifest SHA-256: $manifestHash"
    Write-Host ""
    Write-Host "This manifest is already sanitized. Review it, then copy it into PHASE0_FLUTTERWAVE_EVIDENCE.md if you choose to share it. The manifest file itself is OUTSIDE the git repo and is never committed automatically." -ForegroundColor Cyan
    exit 0
}

# --- Explicit TEST-MODE confirmation (required before any network call) ---
Write-Host ""
Write-Host "=== Omega3-CHECKOUT Phase 0 Flutterwave Evidence Collector ===" -ForegroundColor Yellow
Write-Host "This tool MUST ONLY be used with a Flutterwave TEST-mode secret key." -ForegroundColor Yellow
Write-Host "Never provide a LIVE/production secret key to this tool." -ForegroundColor Yellow
$confirmation = Read-Host "Type exactly TEST-MODE-CONFIRMED to proceed"
if ($confirmation -cne 'TEST-MODE-CONFIRMED') {
    Write-Error "Confirmation phrase did not match exactly. Aborting without making any request."
    exit 1
}

# --- Obtain the secret key securely; never accepted as a parameter/argument ---
$secureSecret = Read-Host -Prompt 'Enter Flutterwave TEST secret key (input hidden)' -AsSecureString
$bstr = [IntPtr]::Zero
$secretPlain = $null
$headers = $null

try {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $secretPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    if (-not (Test-IsTestModeKey -KeyValue $secretPlain)) {
        Write-Error "The provided key does not look like a Flutterwave TEST secret key (expected something containing 'TEST'). Aborting -- refusing to guess whether this is a live key."
        exit 1
    }

    $txRefToUse = $TxRef
    if ($Action -eq 'CreateCheckout' -and [string]::IsNullOrWhiteSpace($txRefToUse)) {
        $txRefToUse = "omega3-phase0-$TestLabel-$([guid]::NewGuid().ToString('N').Substring(0, 12))"
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
                $bodyObject = @{
                    tx_ref       = $txRefToUse
                    amount       = $Amount
                    currency     = $Currency
                    redirect_url = $RedirectUrl
                    customer     = @{ email = $CustomerEmail }
                }
                $bodyJson = $bodyObject | ConvertTo-Json -Depth 5
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
            catch {
                $rawBody = ''
            }
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
        Write-Error "Capture failed (reason: $($outcome.Reason), status: $statusCode). No manifest written. Raw failure body saved (outside the repo) for debugging at: $failPath. Aborting."
        exit 1
    }

    $sanitized = ConvertTo-RedactedObject -Node $outcome.Parsed

    $captureId = [guid]::NewGuid().ToString('N')
    $rawFileName = "raw-$Action-Test$TestLabel-$captureId.json"
    $rawFilePath = Join-Path $EvidenceRoot $rawFileName
    Set-Content -Path $rawFilePath -Value $rawBody -Encoding UTF8 -NoNewline
    $rawHash = (Get-FileHash -Path $rawFilePath -Algorithm SHA256).Hash

    $stage = [ordered]@{
        test_label          = $TestLabel
        action              = $Action
        endpoint            = $uri
        tx_ref_sha256       = if ($txRefToUse) { Get-Sha256Hex -Text $txRefToUse } elseif ($TxRef) { Get-Sha256Hex -Text $TxRef } else { $null }
        request_start_utc   = $requestStartUtc
        request_end_utc     = $requestEndUtc
        http_status         = $statusCode
        raw_response_sha256 = $rawHash
        sanitized_response  = $sanitized
    }
    $stageJson = $stage | ConvertTo-Json -Depth 12
    $stagePath = Join-Path $EvidenceRoot "stage-$Action-Test$TestLabel-$captureId.json"
    Set-Content -Path $stagePath -Value $stageJson -Encoding UTF8 -NoNewline

    Write-Host ""
    Write-Host "$Action capture complete for Test$TestLabel." -ForegroundColor Green
    Write-Host "  Raw (unredacted) response: $rawFilePath  (retained -- never deleted by this script)"
    Write-Host "  Raw response SHA-256:      $rawHash"
    Write-Host "  Stage file:                $stagePath"
    Write-Host ""
    if ($Action -eq 'Verify') {
        Write-Host "Next: run -Action FinalizeManifest -TestLabel $TestLabel -PaymentCompletionObservedUtc <the UTC time you observed checkout success>" -ForegroundColor Cyan
    }
}
finally {
    # --- Zero/remove every secret-bearing variable, always, even on failure ---
    if ($secretPlain) {
        $secretPlain = $null
    }
    if ($bstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ($headers) {
        $headers.Authorization = $null
        Remove-Variable -Name headers -ErrorAction SilentlyContinue
    }
    Remove-Variable -Name secretPlain -ErrorAction SilentlyContinue
    Remove-Variable -Name secureSecret -ErrorAction SilentlyContinue
    [System.GC]::Collect()
}
