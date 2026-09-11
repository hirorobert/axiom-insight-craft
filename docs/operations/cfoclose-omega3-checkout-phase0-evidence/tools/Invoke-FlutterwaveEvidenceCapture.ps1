<#
.SYNOPSIS
  Omega3-CHECKOUT Phase 0 evidence collector for GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS.
  TEST MODE ONLY. Implements SANDBOX_TEST_PROTOCOL.md (one directory up).

.DESCRIPTION
  This script is now a THIN CLI WRAPPER. All real logic -- HTTP-response
  validation, hosted-checkout-link extraction, the timestamp allowlist,
  timeline validation, write-once stage files, and session/transaction
  binding -- lives in FlutterwaveEvidenceLib.ps1's four orchestration
  functions (Invoke-CreateCheckoutOrchestration, Invoke-
  ObservePaymentSuccessOrchestration, Invoke-VerifyOrchestration, Invoke-
  FinalizeManifestOrchestration). This script's only job is to: prompt for
  and hold the secret exactly as long as needed, build the real HTTP/
  browser/clock "ports" those orchestration functions require, and call
  them. The test suite calls the SAME orchestration functions with
  synthetic ports (canned HTTP responses, a fake clock, a browser-open
  recorder) -- so a passing test suite is evidence about this script's real
  behavior, not a parallel reimplementation of it.

  Corrected, this revision, against a Codex live-path re-audit of the prior
  collector:

  BLOCKER 1 FIX -- the collector previously opened, in the browser, the
  same variable holding the API REQUEST endpoint itself
  (https://api.flutterwave.com/v3/payments) -- never Flutterwave's actual
  returned hosted-checkout link (`data.link`). It also recorded
  `checkout_opened_utc` unconditionally, even if the browser-open attempt
  had been suppressed/failed. Corrected: `Get-HostedCheckoutLink`
  (FlutterwaveEvidenceLib.ps1) extracts and validates `data.link` --
  requires `status: "success"`, a non-empty absolute HTTPS URI, and an
  exact match against Flutterwave's documented hosted-checkout host
  (`checkout.flutterwave.com`) -- and ONLY that validated link is ever
  passed to the browser-open port. `checkout_opened_utc` is captured ONLY
  after the browser-open port returns without throwing; a thrown error is
  NEVER suppressed, and no CreateCheckout stage file is written on any
  failure in this chain.

  BLOCKER 2 FIX -- the timestamp allowlist previously matched broad
  SUBSTRINGS ('created', 'completed', 'processed', 'expire', 'expiry', ...)
  against ANY key name, with no check on the VALUE. A card's real `expiry`
  field (e.g. "09/22") would have matched 'expire|expiry' and entered the
  manifest as if it were a timestamp; `created_by`/`processed_by` (actor
  identifiers, not times) would have matched too. Corrected to an EXACT-KEY
  allowlist (`created_at`, `completed_at`, `processed_at`, `settled_at`,
  `timestamp`, or a `*_datetime` suffix -- never a substring) COMBINED with
  a mandatory value-shape check (`Test-IsApprovedTimestampValue`): the value
  must independently validate as a strict ISO-8601 timestamp or an
  explicitly-supported 10/13-digit epoch value. `expiry`/`expiration` are
  not in the allowlist and never will be; "09/22" also fails the value
  check on its own, independent of whatever key it appears under.

  HIGH (write-once stages) FIX -- `Set-Content` (which silently overwrites
  an existing file) is replaced everywhere a stage or manifest is written
  with `New-ImmutableJsonFile`, which uses atomic CREATE-NEW file semantics
  and fails with `STAGE_ALREADY_EXISTS` if the target already exists. No
  successful CreateCheckout/ObservePaymentSuccess/Verify/FinalizeManifest
  output can ever be replaced once written.

  HIGH (real orchestration testing) FIX -- see FlutterwaveEvidenceLib.ps1's
  four `Invoke-*Orchestration` functions and
  `tests/FlutterwaveEvidenceLib.Tests.ps1`'s "End-to-end orchestration"
  section, which drives the full CreateCheckout -> ObservePaymentSuccess ->
  Verify -> FinalizeManifest chain with synthetic HTTP/browser/clock ports
  against a real temporary EvidenceRoot -- no network, no credentials, no
  real browser launch -- plus every failure boundary named in this
  revision's own correction list.

  Complete transaction binding (item 4) -- Verify now requires BOTH
  `data.id` AND `data.tx_ref` from the provider response, and independently
  verifies (a) `SHA-256(data.tx_ref)` equals the checkout stage's tx_ref
  hash, and (b) `data.id` EXACTLY equals the `-TransactionId` this call
  actually requested -- previously only (a) was checked; (b) was silently
  assumed. FinalizeManifest additionally cross-checks tx_ref-hash equality
  and collector-content-hash equality across all three stage files.

  Safety properties carried over unchanged:
    - Never accepts a secret key as a command-line argument.
    - Obtains the secret via Read-Host -AsSecureString.
    - Requires an explicit, exact TEST-MODE-CONFIRMED typed confirmation
      before making any network call, and Flutterwave's documented TEST
      secret-key FORMAT is validated fail-closed (never a bare substring
      check).
    - Refuses to write any evidence file inside this git repository.
    - Persists the full raw response OUTSIDE the repo; never deletes it.
    - Exits immediately (non-zero) on a non-2xx response or malformed JSON.
    - Clears secret-bearing variables in a `finally` block on a best-effort
      basis -- this is NOT a cryptographic erasure guarantee (`ZeroFreeBSTR`
      zeroes the one unmanaged BSTR buffer reliably; it cannot guarantee
      every copy the .NET runtime may have made of the managed string is
      also gone).

.PARAMETER Action
  CreateCheckout, ObservePaymentSuccess, Verify, ReferenceLookup, or FinalizeManifest.

.EXAMPLE
  # 1) Create the checkout (generates and prints a NEW capture_session_id;
  #    opens Flutterwave's real hosted-checkout link in your browser):
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

$collectorGitSha = Get-CollectorScriptGitSha
$collectorContentSha = Get-CollectorScriptContentSha256
$realNowUtc = { Get-UtcTimestamp }

# ===========================================================================
# ObservePaymentSuccess -- machine-captured completion timestamp
# ===========================================================================
if ($Action -eq 'ObservePaymentSuccess') {
    if ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
        Write-Error "ObservePaymentSuccess requires -CaptureSessionId (from CreateCheckout)."
        exit 1
    }

    Write-Host ""
    Write-Host "Only proceed once the hosted checkout page has shown PAYMENT SUCCESS." -ForegroundColor Yellow
    $confirm = Read-Host "Type exactly PAYMENT-SUCCESS-CONFIRMED the moment you see success"
    $confirmed = ($confirm -ceq 'PAYMENT-SUCCESS-CONFIRMED')

    $result = Invoke-ObservePaymentSuccessOrchestration `
        -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId -EvidenceRoot $EvidenceRoot `
        -Confirmed $confirmed -NowUtc $realNowUtc `
        -CollectorScriptGitSha $collectorGitSha -CollectorScriptContentSha256 $collectorContentSha

    if (-not $result.Success) {
        Write-Error "ObservePaymentSuccess failed for Test$TestLabel / session $CaptureSessionId : $($result.Reason)"
        exit 1
    }

    Write-Host ""
    Write-Host "Payment-success observation recorded for Test$TestLabel." -ForegroundColor Green
    Write-Host "  Stage file: $($result.StagePath)"
    Write-Host ""
    Write-Host "Next: -Action Verify -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId -TransactionId <id-from-redirect-or-webhook>" -ForegroundColor Cyan
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

    $result = Invoke-FinalizeManifestOrchestration `
        -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId -EvidenceRoot $EvidenceRoot `
        -CollectorScriptGitSha $collectorGitSha -CollectorScriptContentSha256 $collectorContentSha `
        -PowerShellVersion $PSVersionTable.PSVersion.ToString() `
        -MachineUtcOffsetMinutes ([System.TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalMinutes)

    if (-not $result.Success) {
        Write-Error "FinalizeManifest failed for Test$TestLabel / session $CaptureSessionId : $($result.Reason)"
        exit 1
    }

    $manifestHash = (Get-FileHash -Path $result.ManifestPath -Algorithm SHA256).Hash
    Write-Host ""
    Write-Host "Manifest finalized for Test$TestLabel, session $CaptureSessionId." -ForegroundColor Green
    Write-Host "  Manifest: $($result.ManifestPath)"
    Write-Host "  Manifest SHA-256: $manifestHash"
    Write-Host ""
    Write-Host "This manifest contains ONLY allowlisted evidence fields (approved timestamps/status/amount/currency), hashed identifiers, and collector provenance -- never a copy of the full provider response. Review it, then copy it into PHASE0_FLUTTERWAVE_EVIDENCE.md if you choose to share it." -ForegroundColor Cyan
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
        if (-not [string]::IsNullOrWhiteSpace($CaptureSessionId)) {
            Write-Error "CreateCheckout ALWAYS generates a new capture_session_id -- it does not accept one as input. This is what makes session reuse across unrelated checkouts structurally impossible. Remove -CaptureSessionId and re-run."
            exit 1
        }
        $CaptureSessionId = [guid]::NewGuid().ToString('N')
    }
    elseif ([string]::IsNullOrWhiteSpace($CaptureSessionId)) {
        Write-Error "$Action requires -CaptureSessionId (from CreateCheckout)."
        exit 1
    }

    $txRefToUse = $TxRef
    if ($Action -eq 'CreateCheckout' -and [string]::IsNullOrWhiteSpace($txRefToUse)) {
        $txRefToUse = "omega3-phase0-$TestLabel-$CaptureSessionId"
    }

    $headers = @{
        Authorization  = "Bearer $secretPlain"
        'Content-Type' = 'application/json'
    }

    # Real HTTP ports -- .GetNewClosure() bakes in $headers (which holds the
    # secret) at creation time, since a scriptblock invoked via `&` from
    # inside a DIFFERENT function (the orchestration functions, dot-sourced
    # from the library) does not otherwise see this script's local
    # variables. Both ports convert a thrown HTTP error into the SAME
    # @{StatusCode;Body} shape a success returns -- the orchestration layer
    # never has to deal with exceptions from the transport, only data.
    $realHttpPost = {
        param($Uri, $BodyJson)
        try {
            $webResponse = Invoke-WebRequest -Uri $Uri -Method Post -Headers $headers -Body $BodyJson -ContentType 'application/json' -UseBasicParsing
            return @{ StatusCode = [int]$webResponse.StatusCode; Body = $webResponse.Content }
        }
        catch {
            if ($_.Exception.Response) {
                $sc = [int]$_.Exception.Response.StatusCode
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                }
                catch { $body = '' }
                return @{ StatusCode = $sc; Body = $body }
            }
            return @{ StatusCode = 0; Body = $_.Exception.Message }
        }
    }.GetNewClosure()

    $realHttpGet = {
        param($Uri)
        try {
            $webResponse = Invoke-WebRequest -Uri $Uri -Method Get -Headers $headers -UseBasicParsing
            return @{ StatusCode = [int]$webResponse.StatusCode; Body = $webResponse.Content }
        }
        catch {
            if ($_.Exception.Response) {
                $sc = [int]$_.Exception.Response.StatusCode
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                }
                catch { $body = '' }
                return @{ StatusCode = $sc; Body = $body }
            }
            return @{ StatusCode = 0; Body = $_.Exception.Message }
        }
    }.GetNewClosure()

    # Real browser-open port -- errors are NEVER suppressed (no
    # -ErrorAction SilentlyContinue). A launch failure throws, which
    # Invoke-CreateCheckoutOrchestration catches and treats as
    # BROWSER_LAUNCH_FAILED -- no stage file is written for that outcome.
    $realOpenUrl = {
        param($Url)
        $proc = Start-Process -FilePath $Url -PassThru
        if (-not $proc) {
            throw "Start-Process returned no process handle for '$Url'."
        }
    }

    switch ($Action) {
        'CreateCheckout' {
            if (-not $Amount -or -not $Currency -or -not $RedirectUrl -or -not $CustomerEmail) {
                Write-Error "CreateCheckout requires -Amount, -Currency, -RedirectUrl, -CustomerEmail (use disposable TEST values only -- never a real customer's)."
                exit 1
            }

            $result = Invoke-CreateCheckoutOrchestration `
                -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId `
                -TxRef $txRefToUse -Amount $Amount -Currency $Currency -RedirectUrl $RedirectUrl -CustomerEmail $CustomerEmail `
                -EvidenceRoot $EvidenceRoot -HttpPost $realHttpPost -OpenUrl $realOpenUrl -NowUtc $realNowUtc `
                -CollectorScriptGitSha $collectorGitSha -CollectorScriptContentSha256 $collectorContentSha

            if (-not $result.Success) {
                $detail = if ($result.Detail) { " ($($result.Detail))" } else { '' }
                Write-Error "CreateCheckout failed: $($result.Reason)$detail. No stage file written."
                exit 1
            }

            Write-Host ""
            Write-Host "CreateCheckout complete for Test$TestLabel." -ForegroundColor Green
            Write-Host "  CAPTURE SESSION ID (save this -- every later step needs it exactly): $CaptureSessionId" -ForegroundColor Magenta
            Write-Host "  Opened hosted checkout link: $($result.Link)"
            Write-Host "  Stage file: $($result.StagePath)"
            Write-Host ""
            if ($TestLabel -eq 'B') {
                Write-Host "Test B: wait at least 10 minutes AFTER checkout_opened_utc before completing payment." -ForegroundColor Cyan
            }
            Write-Host "Next: complete the hosted checkout, then run -Action ObservePaymentSuccess -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId" -ForegroundColor Cyan
        }
        'Verify' {
            if (-not $TransactionId) {
                Write-Error "Verify requires -TransactionId."
                exit 1
            }

            $result = Invoke-VerifyOrchestration `
                -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId -TransactionId $TransactionId `
                -EvidenceRoot $EvidenceRoot -HttpGet $realHttpGet -NowUtc $realNowUtc `
                -CollectorScriptGitSha $collectorGitSha -CollectorScriptContentSha256 $collectorContentSha

            if (-not $result.Success) {
                Write-Error "Verify failed: $($result.Reason). No stage file written."
                exit 1
            }

            Write-Host ""
            Write-Host "Verify complete for Test$TestLabel -- transaction id and tx_ref both confirmed to match this capture session." -ForegroundColor Green
            Write-Host "  Stage file: $($result.StagePath)"
            Write-Host ""
            Write-Host "Next: -Action FinalizeManifest -TestLabel $TestLabel -CaptureSessionId $CaptureSessionId" -ForegroundColor Cyan
        }
        'ReferenceLookup' {
            if (-not $TxRef) {
                Write-Error "ReferenceLookup requires -TxRef (supplemental only -- never a substitute for Verify)."
                exit 1
            }
            $uri = "https://api.flutterwave.com/v3/transactions?tx_ref=$TxRef"
            $requestStartUtc = & $realNowUtc
            $httpResult = & $realHttpGet $uri
            $requestEndUtc = & $realNowUtc
            $outcome = Get-CaptureOutcome -StatusCode $httpResult.StatusCode -RawBody $httpResult.Body
            if (-not $outcome.Success) {
                Write-Error "ReferenceLookup failed (reason: $($outcome.Reason)). This is supplemental-only; no stage file was ever written for it."
                exit 1
            }
            $evidenceFields = Get-AllowlistedEvidenceFields -Node $outcome.Parsed
            Write-Host ""
            Write-Host "ReferenceLookup complete (SUPPLEMENTAL ONLY -- not consumed by FinalizeManifest)." -ForegroundColor Green
            Write-Host "  Request window: $requestStartUtc .. $requestEndUtc"
            Write-Host "  Raw response SHA-256: $(Get-Sha256Hex -Text $httpResult.Body)"
            Write-Host "  Allowlisted fields: $($evidenceFields | ConvertTo-Json -Depth 6)"
        }
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
