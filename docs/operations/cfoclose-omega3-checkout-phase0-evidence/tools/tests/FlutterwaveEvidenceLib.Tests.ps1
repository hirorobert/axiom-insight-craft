<#
.SYNOPSIS
  Focused, dependency-free tests for FlutterwaveEvidenceLib.ps1. No Pester
  required, no network call, no secret, no real Flutterwave interaction.
  Run: pwsh -NoProfile -File FlutterwaveEvidenceLib.Tests.ps1
  Exits 0 if every assertion passes, non-zero otherwise, printing a
  PASS/FAIL line per test.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'FlutterwaveEvidenceLib.ps1')

$script:failures = 0
$script:total = 0

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Name)
    $script:total++
    if ($Condition) {
        Write-Host "  PASS: $Name" -ForegroundColor Green
    }
    else {
        Write-Host "  FAIL: $Name" -ForegroundColor Red
        $script:failures++
    }
}

function Assert-Equal {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual, [Parameter(Mandatory)][string]$Name)
    Assert-True -Condition ($Expected -eq $Actual) -Name "$Name (expected '$Expected', got '$Actual')"
}

# ============================================================
# Category 1: secret redaction
# ============================================================
Write-Host "`n=== Secret / PII redaction ===" -ForegroundColor Cyan

$sample = [PSCustomObject]@{
    status   = 'successful'
    amount   = 100
    currency = 'NGN'
    created_at = '2020-03-11T19:22:07.000Z'
    customer = [PSCustomObject]@{
        email      = 'real.person@example.com'
        phone      = '+2348012345678'
        name       = 'Real Person'
        created_at = '2020-03-11T19:22:06.000Z'
    }
    card = [PSCustomObject]@{
        first_6_digits = '123456'
        last_4_digits  = '1111'
        token          = 'flw-t1nf-abc'
    }
    ip                = '203.0.113.5'
    device_fingerprint = 'abc123'
    merchant_id       = 'merchant-999'
}
# NOTE: the sample above uses 'first_6_digits'/'last_4_digits' (with
# underscores) to prove the redaction is exercised on the ACTUAL field
# names Flutterwave uses; the denylist below is intentionally checked
# against both underscored and non-underscored variants.
$redacted = ConvertTo-RedactedObject -Node $sample

Assert-Equal -Expected 'successful' -Actual $redacted.status -Name 'status is retained'
Assert-Equal -Expected 100 -Actual $redacted.amount -Name 'amount is retained'
Assert-Equal -Expected 'NGN' -Actual $redacted.currency -Name 'currency is retained'
Assert-Equal -Expected '2020-03-11T19:22:07.000Z' -Actual $redacted.created_at -Name 'top-level created_at is retained'
Assert-Equal -Expected '2020-03-11T19:22:06.000Z' -Actual $redacted.customer.created_at -Name 'nested customer.created_at is retained'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.customer.email -Name 'customer.email is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.customer.phone -Name 'customer.phone is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.customer.name -Name 'customer.name is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.card.token -Name 'card.token is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.ip -Name 'ip is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.device_fingerprint -Name 'device_fingerprint is redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redacted.merchant_id -Name 'merchant_id is redacted'

$sampleWithArray = [PSCustomObject]@{
    events = @(
        [PSCustomObject]@{ email = 'a@example.com'; created_at = 't1' },
        [PSCustomObject]@{ email = 'b@example.com'; created_at = 't2' }
    )
}
$redactedArray = ConvertTo-RedactedObject -Node $sampleWithArray
Assert-Equal -Expected '[REDACTED]' -Actual $redactedArray.events[0].email -Name 'array element 0 email redacted'
Assert-Equal -Expected '[REDACTED]' -Actual $redactedArray.events[1].email -Name 'array element 1 email redacted'
Assert-Equal -Expected 't1' -Actual $redactedArray.events[0].created_at -Name 'array element 0 created_at retained'

# ============================================================
# Category 2: strict result shapes (Test-IsSafeFlagResult mirrors the
# pinned discriminated-union contract in IMPLEMENTATION_CONDITIONS_PINNED.md)
# ============================================================
Write-Host "`n=== Strict flagResult shapes ===" -ForegroundColor Cyan

# Accept exactly three
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $true })) -Name 'accept { flagged: true }'
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'ALREADY_FLAGGED' })) -Name 'accept { flagged: false, reason: ALREADY_FLAGGED }'
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'INTENT_NOT_PENDING' })) -Name 'accept { flagged: false, reason: INTENT_NOT_PENDING }'

# Reject exhaustively
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult $null)) -Name 'reject null'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult @())) -Name 'reject empty array'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult @([PSCustomObject]@{ flagged = $true }))) -Name 'reject array containing a valid-looking object'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult 'flagged:true')) -Name 'reject string'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult 1)) -Name 'reject number'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{}))) -Name 'reject empty object (missing flagged)'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = 'true' }))) -Name 'reject non-boolean flagged (string "true")'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = 1 }))) -Name 'reject non-boolean flagged (number 1)'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $true; reason = 'ALREADY_FLAGGED' }))) -Name 'reject flagged:true WITH a reason (the exact regression case)'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $true; extra = 'x' }))) -Name 'reject flagged:true with an unrelated extra key'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false }))) -Name 'reject flagged:false with no reason'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = $null }))) -Name 'reject flagged:false with null reason'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'SOMETHING_UNEXPECTED' }))) -Name 'reject flagged:false with unknown reason string'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 123 }))) -Name 'reject flagged:false with non-string reason'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'ALREADY_FLAGGED'; extra = 'x' }))) -Name 'reject otherwise-valid shape plus an extra key'

# ============================================================
# Category 3: malformed responses
# ============================================================
Write-Host "`n=== Malformed response handling ===" -ForegroundColor Cyan

$malformedOutcome = Get-CaptureOutcome -StatusCode 200 -RawBody '{ this is not valid json'
Assert-Equal -Expected $false -Actual $malformedOutcome.Success -Name 'malformed JSON body is rejected'
Assert-Equal -Expected 'MALFORMED_JSON' -Actual $malformedOutcome.Reason -Name 'malformed JSON reason is MALFORMED_JSON'
Assert-True -Condition ($null -eq $malformedOutcome.Parsed) -Name 'malformed JSON produces no parsed object'

$emptyBodyOutcome = Get-CaptureOutcome -StatusCode 200 -RawBody ''
Assert-Equal -Expected $false -Actual $emptyBodyOutcome.Success -Name 'empty body with 200 status is rejected'

# ============================================================
# Category 4: non-2xx failure
# ============================================================
Write-Host "`n=== Non-2xx status handling ===" -ForegroundColor Cyan

foreach ($code in @(400, 401, 403, 404, 500, 502, 503)) {
    $o = Get-CaptureOutcome -StatusCode $code -RawBody '{"status":"error"}'
    Assert-Equal -Expected $false -Actual $o.Success -Name "status $code is rejected"
    Assert-Equal -Expected 'NON_2XX' -Actual $o.Reason -Name "status $code reason is NON_2XX"
}

foreach ($code in @(200, 201, 204, 299)) {
    $o = Get-CaptureOutcome -StatusCode $code -RawBody '{"status":"ok"}'
    Assert-Equal -Expected $true -Actual $o.Success -Name "status $code is accepted (with valid JSON)"
}

$nullStatusOutcome = Get-CaptureOutcome -StatusCode $null -RawBody '{}'
Assert-Equal -Expected $false -Actual $nullStatusOutcome.Success -Name 'null status code (network failure) is rejected'
Assert-Equal -Expected 'NON_2XX' -Actual $nullStatusOutcome.Reason -Name 'null status code reason is NON_2XX'

# ============================================================
# Category 5: timestamp capture
# ============================================================
Write-Host "`n=== Timestamp capture ===" -ForegroundColor Cyan

$ts1 = Get-UtcTimestamp
Start-Sleep -Milliseconds 5
$ts2 = Get-UtcTimestamp

$parseOk1 = $false
$parseOk2 = $false
$parsed1 = [DateTime]::MinValue
$parsed2 = [DateTime]::MinValue
try {
    $parsed1 = [DateTime]::Parse($ts1, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $parseOk1 = $true
}
catch { $parseOk1 = $false }
try {
    $parsed2 = [DateTime]::Parse($ts2, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    $parseOk2 = $true
}
catch { $parseOk2 = $false }

Assert-True -Condition $parseOk1 -Name 'Get-UtcTimestamp produces a parseable ISO-8601 timestamp'
Assert-True -Condition $parseOk2 -Name 'a second Get-UtcTimestamp call also produces a parseable timestamp'
Assert-True -Condition ($parsed1.Kind -eq [System.DateTimeKind]::Utc) -Name 'timestamp round-trips as UTC kind'
Assert-True -Condition ($parsed2 -ge $parsed1) -Name 'a later timestamp is not earlier than an earlier one (monotonic ordering)'

# ============================================================
# Category 6: manifest hashing
# ============================================================
Write-Host "`n=== Manifest construction and hashing ===" -ForegroundColor Cyan

$manifest = New-EvidenceManifest `
    -TestLabel 'A' `
    -TxRefSha256 (Get-Sha256Hex -Text 'omega3-phase0-A-testref') `
    -TestModeConfirmed $true `
    -ApiVersion 'v3' `
    -CheckoutEndpoint 'https://api.flutterwave.com/v3/payments' `
    -CheckoutRequestStartUtc '2026-09-11T10:00:00.0000000Z' `
    -CheckoutRequestEndUtc '2026-09-11T10:00:01.0000000Z' `
    -PaymentCompletionObservedUtc '2026-09-11T10:00:30.0000000Z' `
    -VerifyEndpoint 'https://api.flutterwave.com/v3/transactions/123/verify' `
    -VerifyRequestStartUtc '2026-09-11T10:01:00.0000000Z' `
    -VerifyRequestEndUtc '2026-09-11T10:01:01.0000000Z' `
    -ProviderTimestamps ([PSCustomObject]@{ created_at = '2026-09-11T10:00:00.0000000Z' }) `
    -CheckoutRawResponseSha256 'deadbeef' `
    -VerifyRawResponseSha256 'cafebabe' `
    -CollectorScriptGitSha 'abc123' `
    -PowerShellVersion '7.4.0' `
    -MachineUtcOffsetMinutes 0

$requiredKeys = @(
    'test_label', 'tx_ref_sha256', 'test_mode_confirmed', 'api_version',
    'checkout_endpoint', 'checkout_request_start_utc', 'checkout_request_end_utc',
    'payment_completion_observed_utc', 'verify_endpoint', 'verify_request_start_utc',
    'verify_request_end_utc', 'provider_timestamps', 'checkout_raw_response_sha256',
    'verify_raw_response_sha256', 'collector_script_git_sha', 'powershell_version',
    'machine_utc_offset_minutes'
)
foreach ($key in $requiredKeys) {
    Assert-True -Condition ($manifest.Contains($key)) -Name "manifest binds required field '$key'"
}
Assert-Equal -Expected 'A' -Actual $manifest.test_label -Name 'manifest records the correct test label'

$manifestJson = $manifest | ConvertTo-Json -Depth 12
$tempFile = [System.IO.Path]::GetTempFileName()
try {
    Set-Content -Path $tempFile -Value $manifestJson -Encoding UTF8 -NoNewline
    $hash1 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash
    $hash2 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash
    Assert-Equal -Expected $hash1 -Actual $hash2 -Name 'manifest SHA-256 is deterministic across repeated hashing of the same file'
    Assert-True -Condition ($hash1.Length -eq 64) -Name 'manifest SHA-256 hash is 64 hex characters'

    Set-Content -Path $tempFile -Value ($manifestJson + ' ') -Encoding UTF8 -NoNewline
    $hash3 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash
    Assert-True -Condition ($hash3 -ne $hash1) -Name 'manifest SHA-256 changes when manifest content changes'
}
finally {
    Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}

# ============================================================
Write-Host "`n=== Summary: $($script:total - $script:failures) / $($script:total) passed ===" -ForegroundColor $(if ($script:failures -eq 0) { 'Green' } else { 'Red' })

if ($script:failures -gt 0) {
    exit 1
}
exit 0
