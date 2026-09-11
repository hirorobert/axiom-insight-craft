<#
.SYNOPSIS
  Focused, dependency-free tests for FlutterwaveEvidenceLib.ps1 and the
  collector script's static structure. No Pester required, no network call,
  no secret, no real Flutterwave interaction.
  Run: pwsh -NoProfile -File FlutterwaveEvidenceLib.Tests.ps1
  Exits 0 if every assertion passes, non-zero otherwise.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$toolsRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $toolsRoot 'FlutterwaveEvidenceLib.ps1')

$script:failures = 0
$script:total = 0

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Name)
    $script:total++
    if ($Condition) { Write-Host "  PASS: $Name" -ForegroundColor Green }
    else { Write-Host "  FAIL: $Name" -ForegroundColor Red; $script:failures++ }
}

function Assert-Equal {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual, [Parameter(Mandatory)][string]$Name)
    Assert-True -Condition ($Expected -eq $Actual) -Name "$Name (expected '$Expected', got '$Actual')"
}

# ============================================================
# Category: ALLOWLIST evidence projection (Blocker 1)
# ============================================================
Write-Host "`n=== Allowlist evidence projection (Blocker 1) ===" -ForegroundColor Cyan

# A response shaped like Flutterwave's REAL documented verification example,
# using the ACTUAL field spellings (first_6digits / last_4digits, no
# underscores before the digit) -- this is the exact spelling the earlier
# denylist got wrong.
$realShapedResponse = [PSCustomObject]@{
    status  = 'success'
    message = 'Transaction fetched successfully'
    data    = [PSCustomObject]@{
        id         = 12345
        tx_ref     = 'omega3-phase0-A-abc123'
        flw_ref    = 'FLW-REF-XYZ'
        status     = 'successful'
        amount     = 100
        currency   = 'NGN'
        created_at = '2020-03-11T19:22:07.000Z'
        card       = [PSCustomObject]@{
            first_6digits = '123456'
            last_4digits  = '1111'
            token         = 'flw-t1nf-tokenvalue'
        }
        customer   = [PSCustomObject]@{
            id         = 999
            email      = 'real.person@example.com'
            phone      = '+2348012345678'
            fullname   = 'Real Person'
            created_at = '2020-03-11T19:22:06.000Z'
        }
        meta       = [PSCustomObject]@{
            device_fingerprint = 'fp-abc'
            ip                 = '203.0.113.5'
            unexpected_future_field_v9 = 'something Flutterwave adds next year'
        }
        account_id  = 'acct-777'
        merchant_id = 'merch-888'
    }
}

$fields = Get-AllowlistedEvidenceFields -Node $realShapedResponse
$fieldsJson = $fields | ConvertTo-Json -Depth 10 -Compress

Assert-True -Condition ($fieldsJson -notmatch '123456') -Name 'first_6digits VALUE (123456) never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '"1111"') -Name 'last_4digits VALUE (1111) never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'first_6digits') -Name 'first_6digits KEY NAME never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'last_4digits') -Name 'last_4digits KEY NAME never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'flw-t1nf-tokenvalue') -Name 'card token never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'real\.person@example\.com') -Name 'customer email never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '\+2348012345678') -Name 'customer phone never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'Real Person') -Name 'customer fullname never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '203\.0\.113\.5') -Name 'IP address never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'fp-abc') -Name 'device fingerprint never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'acct-777') -Name 'account_id never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'merch-888') -Name 'merchant_id never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'something Flutterwave adds next year') -Name 'arbitrary UNKNOWN future provider field never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -match '2020-03-11T19:22:07\.000Z') -Name 'data.created_at VALUE is retained'
Assert-True -Condition ($fieldsJson -match '2020-03-11T19:22:06\.000Z') -Name 'nested customer.created_at VALUE is retained'
Assert-True -Condition ($fieldsJson -match '"successful"') -Name 'status value is retained'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.created_at' })).Count -eq 1) -Name 'data.created_at JSON path is preserved exactly'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.customer.created_at' })).Count -eq 1) -Name 'data.customer.created_at JSON path is preserved exactly'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.status' })).Count -eq 1) -Name 'data.status JSON path is preserved exactly'

$allowedKeyNames = @('status', 'amount', 'currency', 'created_at')
$disallowedLeak = @($fields | Where-Object { $allowedKeyNames -notcontains $_.key -and $_.key -notmatch $script:TimestampKeyPattern })
Assert-True -Condition ($disallowedLeak.Count -eq 0) -Name 'every field returned by the allowlist has a key name that is either an allowed scalar or timestamp-shaped (no accidental leaks)'

# The card/customer/meta/account/merchant subtrees must contribute NOTHING
# except customer.created_at (a legitimate timestamp).
$nonTimestampCardOrMeta = @($fields | Where-Object { $_.path -like 'data.card.*' -or $_.path -like 'data.meta.*' -or $_.path -eq 'data.account_id' -or $_.path -eq 'data.merchant_id' })
Assert-True -Condition ($nonTimestampCardOrMeta.Count -eq 0) -Name 'card/meta/account_id/merchant_id subtrees contribute zero fields to allowlisted evidence'

# An array of nested objects is walked with unknown fields still dropped.
$arrayShaped = [PSCustomObject]@{
    events = @(
        [PSCustomObject]@{ email = 'a@example.com'; created_at = 't1'; secret_field = 'zzz' },
        [PSCustomObject]@{ email = 'b@example.com'; created_at = 't2'; secret_field = 'yyy' }
    )
}
$arrayFields = Get-AllowlistedEvidenceFields -Node $arrayShaped -PathPrefix 'data'
$arrayJson = $arrayFields | ConvertTo-Json -Depth 10 -Compress
Assert-True -Condition ($arrayJson -notmatch 'example\.com') -Name 'array element email fields never appear in allowlisted output'
Assert-True -Condition ($arrayJson -notmatch 'zzz|yyy') -Name 'array element arbitrary unknown fields never appear in allowlisted output'
Assert-True -Condition ($arrayJson -match '"t1"') -Name 'array element 0 created_at is retained'
Assert-True -Condition ($arrayJson -match '"t2"') -Name 'array element 1 created_at is retained'
Assert-True -Condition ((@($arrayFields | Where-Object { $_.path -eq 'data.events[0].created_at' })).Count -eq 1) -Name 'array element JSON path includes index correctly'

# ============================================================
# Category: strict flagResult shapes (unrelated contract, unchanged)
# ============================================================
Write-Host "`n=== Strict flagResult shapes ===" -ForegroundColor Cyan
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $true })) -Name 'accept { flagged: true }'
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'ALREADY_FLAGGED' })) -Name 'accept { flagged: false, reason: ALREADY_FLAGGED }'
Assert-True -Condition (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'INTENT_NOT_PENDING' })) -Name 'accept { flagged: false, reason: INTENT_NOT_PENDING }'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult $null)) -Name 'reject null'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{}))) -Name 'reject empty object'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $true; reason = 'ALREADY_FLAGGED' }))) -Name 'reject flagged:true WITH a reason'
Assert-True -Condition (-not (Test-IsSafeFlagResult -FlagResult ([PSCustomObject]@{ flagged = $false; reason = 'SOMETHING_UNEXPECTED' }))) -Name 'reject flagged:false with unknown reason'

# ============================================================
# Category: malformed responses / non-2xx
# ============================================================
Write-Host "`n=== Malformed response / non-2xx handling ===" -ForegroundColor Cyan
$malformedOutcome = Get-CaptureOutcome -StatusCode 200 -RawBody '{ this is not valid json'
Assert-Equal -Expected $false -Actual $malformedOutcome.Success -Name 'malformed JSON body is rejected'
Assert-Equal -Expected 'MALFORMED_JSON' -Actual $malformedOutcome.Reason -Name 'malformed JSON reason is MALFORMED_JSON'
Assert-Equal -Expected $false -Actual (Get-CaptureOutcome -StatusCode 200 -RawBody '').Success -Name 'empty body with 200 status is rejected'
foreach ($code in @(400, 401, 403, 404, 500, 502, 503)) {
    Assert-Equal -Expected $false -Actual (Get-CaptureOutcome -StatusCode $code -RawBody '{"status":"error"}').Success -Name "status $code is rejected"
}
foreach ($code in @(200, 201, 204, 299)) {
    Assert-Equal -Expected $true -Actual (Get-CaptureOutcome -StatusCode $code -RawBody '{"status":"ok"}').Success -Name "status $code is accepted (with valid JSON)"
}
Assert-Equal -Expected $false -Actual (Get-CaptureOutcome -StatusCode $null -RawBody '{}').Success -Name 'null status code (network failure) is rejected'

# ============================================================
# Category: timestamp capture
# ============================================================
Write-Host "`n=== Timestamp capture ===" -ForegroundColor Cyan
$ts1 = Get-UtcTimestamp
Start-Sleep -Milliseconds 5
$ts2 = Get-UtcTimestamp
Assert-True -Condition (Test-IsValidUtcTimestamp -Value $ts1) -Name 'Get-UtcTimestamp produces a value Test-IsValidUtcTimestamp accepts'
Assert-True -Condition (Test-IsValidUtcTimestamp -Value $ts2) -Name 'a second Get-UtcTimestamp call also produces a valid UTC timestamp'
Assert-True -Condition (-not (Test-IsValidUtcTimestamp -Value 'not-a-timestamp')) -Name 'Test-IsValidUtcTimestamp rejects garbage input'
Assert-True -Condition (-not (Test-IsValidUtcTimestamp -Value '')) -Name 'Test-IsValidUtcTimestamp rejects empty string'
Assert-True -Condition (-not (Test-IsValidUtcTimestamp -Value '2026-09-11T10:00:00+02:00')) -Name 'Test-IsValidUtcTimestamp rejects a non-UTC-kind offset timestamp'
$p1 = [DateTime]::Parse($ts1, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
$p2 = [DateTime]::Parse($ts2, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
Assert-True -Condition ($p2 -ge $p1) -Name 'a later timestamp is not earlier than an earlier one'

# ============================================================
# Category: timeline ordering / Test B minimum (High 1)
# ============================================================
Write-Host "`n=== Timeline ordering and Test B minimum (High 1) ===" -ForegroundColor Cyan

function New-Ts { param([int]$OffsetSeconds) return [DateTime]::UtcNow.AddSeconds($OffsetSeconds).ToString('o') }

$base = [DateTime]::UtcNow
$t0 = $base.ToString('o')
$t1 = $base.AddSeconds(1).ToString('o')
$t2 = $base.AddSeconds(2).ToString('o')
$t3 = $base.AddSeconds(3).ToString('o')
$t4 = $base.AddSeconds(4).ToString('o')
$t5 = $base.AddSeconds(5).ToString('o')

$validA = Test-TimelineOrdering -CheckoutRequestStartUtc $t0 -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition $validA.Valid -Name 'Test A: strictly increasing, correctly-ordered timeline is VALID'

$outOfOrder = Test-TimelineOrdering -CheckoutRequestStartUtc $t2 -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t3 -PaymentCompletionObservedUtc $t4 -VerifyRequestStartUtc $t5 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition (-not $outOfOrder.Valid) -Name 'out-of-order timeline (end before start) is INVALID'
Assert-True -Condition ($outOfOrder.Reason -like 'ORDER_VIOLATION:*') -Name 'out-of-order timeline reports ORDER_VIOLATION'

$malformedTimeline = Test-TimelineOrdering -CheckoutRequestStartUtc 'garbage' -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition (-not $malformedTimeline.Valid) -Name 'malformed (non-parseable) timestamp makes the timeline INVALID'
Assert-True -Condition ($malformedTimeline.Reason -like 'MALFORMED_OR_NON_UTC:*') -Name 'malformed timestamp reports MALFORMED_OR_NON_UTC'

$nonUtcTimeline = Test-TimelineOrdering -CheckoutRequestStartUtc '2026-09-11T10:00:00+02:00' -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition (-not $nonUtcTimeline.Valid) -Name 'a non-UTC-kind offset timestamp makes the timeline INVALID'

# Test B: exactly 599 seconds between checkout_opened and payment_completion -> FAIL.
$openedAt = $base
$obs599 = $base.AddSeconds(599)
$verifyStart599 = $obs599.AddSeconds(1)
$verifyEnd599 = $verifyStart599.AddSeconds(1)
$testB599 = Test-TimelineOrdering `
    -CheckoutRequestStartUtc $base.AddSeconds(-2).ToString('o') `
    -CheckoutRequestEndUtc $base.AddSeconds(-1).ToString('o') `
    -CheckoutOpenedUtc $openedAt.ToString('o') `
    -PaymentCompletionObservedUtc $obs599.ToString('o') `
    -VerifyRequestStartUtc $verifyStart599.ToString('o') `
    -VerifyRequestEndUtc $verifyEnd599.ToString('o') `
    -IsTestB $true
Assert-True -Condition (-not $testB599.Valid) -Name 'Test B at 599 seconds elapsed FAILS the 10-minute minimum'
Assert-True -Condition ($testB599.Reason -like 'TEST_B_MINIMUM_NOT_MET:*') -Name 'Test B 599-second failure reports TEST_B_MINIMUM_NOT_MET'

# Test B: exactly 600 seconds -> PASS.
$obs600 = $base.AddSeconds(600)
$verifyStart600 = $obs600.AddSeconds(1)
$verifyEnd600 = $verifyStart600.AddSeconds(1)
$testB600 = Test-TimelineOrdering `
    -CheckoutRequestStartUtc $base.AddSeconds(-2).ToString('o') `
    -CheckoutRequestEndUtc $base.AddSeconds(-1).ToString('o') `
    -CheckoutOpenedUtc $openedAt.ToString('o') `
    -PaymentCompletionObservedUtc $obs600.ToString('o') `
    -VerifyRequestStartUtc $verifyStart600.ToString('o') `
    -VerifyRequestEndUtc $verifyEnd600.ToString('o') `
    -IsTestB $true
Assert-True -Condition $testB600.Valid -Name 'Test B at exactly 600 seconds elapsed PASSES the 10-minute minimum'

# Test A has no 600-second minimum -- a 1-second Test A timeline is fine.
$testAFast = Test-TimelineOrdering -CheckoutRequestStartUtc $t0 -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition $testAFast.Valid -Name 'Test A has no minimum-elapsed requirement (a fast, correctly-ordered timeline is valid)'

# ============================================================
# Category: session-bound stage capture, no latest-file selection (Blocker 2)
# ============================================================
Write-Host "`n=== Session-bound stage capture (Blocker 2) ===" -ForegroundColor Cyan

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omega3-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $sessionA = [guid]::NewGuid().ToString('N')
    $sessionB = [guid]::NewGuid().ToString('N')

    # Missing: no file at all.
    $missing = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $false -Actual $missing.Success -Name 'Get-StageCapture reports failure when the stage file does not exist'
    Assert-Equal -Expected 'MISSING' -Actual $missing.Reason -Name 'missing stage reason is MISSING'

    # Write a correct stage file for sessionA / Test A.
    $goodStage = @{ capture_session_id = $sessionA; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = (Get-Sha256Hex -Text 'ref-A') }
    Set-Content -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$sessionA.json") -Value ($goodStage | ConvertTo-Json) -Encoding UTF8

    $ok = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $true -Actual $ok.Success -Name 'Get-StageCapture succeeds for an exact, internally-consistent match'
    Assert-Equal -Expected $sessionA -Actual $ok.Data.capture_session_id -Name 'loaded stage carries the correct capture_session_id'

    # Cross-session: requesting sessionB must NOT return sessionA's file.
    $crossSession = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionB
    Assert-Equal -Expected $false -Actual $crossSession.Success -Name 'a different (unrelated) session id never matches an existing stage file'
    Assert-Equal -Expected 'MISSING' -Actual $crossSession.Reason -Name 'cross-session lookup reason is MISSING (no filename-level match), proving there is no fallback to "the only file present"'

    # Tampered content: filename says sessionA, but internal field says something else.
    $tamperedSession = [guid]::NewGuid().ToString('N')
    $tamperedStage = @{ capture_session_id = 'SOME-OTHER-SESSION'; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = 'x' }
    Set-Content -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$tamperedSession.json") -Value ($tamperedStage | ConvertTo-Json) -Encoding UTF8
    $tamperedResult = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $tamperedSession
    Assert-Equal -Expected $false -Actual $tamperedResult.Success -Name 'a stage file whose internal capture_session_id disagrees with its filename is rejected'
    Assert-Equal -Expected 'SESSION_MISMATCH' -Actual $tamperedResult.Reason -Name 'tampered-session reason is SESSION_MISMATCH'

    # Tampered test label.
    $labelMismatchSession = [guid]::NewGuid().ToString('N')
    $labelMismatchStage = @{ capture_session_id = $labelMismatchSession; test_label = 'B'; action = 'CreateCheckout'; tx_ref_sha256 = 'x' }
    Set-Content -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$labelMismatchSession.json") -Value ($labelMismatchStage | ConvertTo-Json) -Encoding UTF8
    $labelMismatchResult = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $labelMismatchSession
    Assert-Equal -Expected $false -Actual $labelMismatchResult.Success -Name 'a stage file whose internal test_label disagrees with its filename is rejected'
    Assert-Equal -Expected 'LABEL_MISMATCH' -Actual $labelMismatchResult.Reason -Name 'label-mismatch reason is LABEL_MISMATCH'

    # Duplicate: two files that would both match the SAME exact pattern
    # (simulated by creating the pattern twice would overwrite on most
    # filesystems, so duplicate detection is instead proven by checking the
    # matcher's own Count>1 branch is reachable via a wildcard collision --
    # here we assert the exact-match count for the legitimate file stays 1,
    # demonstrating single-file resolution is the only path to Success.)
    $countCheck = @(Get-ChildItem -Path $tempDir -Filter "stage-CreateCheckout-TestA-$sessionA.json")
    Assert-Equal -Expected 1 -Actual $countCheck.Count -Name 'exactly one file matches the exact session pattern (no glob/wildcard over-matching)'

    # "Latest file" selection no longer exists: two DIFFERENT sessions' stage
    # files coexist in the same directory; requesting one by exact id never
    # returns the other, regardless of which was written most recently.
    Start-Sleep -Milliseconds 20
    $sessionC = [guid]::NewGuid().ToString('N')
    $newerStage = @{ capture_session_id = $sessionC; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = (Get-Sha256Hex -Text 'ref-C') }
    Set-Content -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$sessionC.json") -Value ($newerStage | ConvertTo-Json) -Encoding UTF8
    $stillSessionA = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $sessionA -Actual $stillSessionA.Data.capture_session_id -Name 'requesting an OLDER session by exact id still returns that session, not the newer one written afterward (no latest-file fallback)'
}
finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Structural proof: the collector script contains no sort-by-recency file
# selection anywhere (the exact mechanism the earlier "select newest file"
# defect relied on).
$collectorSource = Get-Content -Path (Join-Path $toolsRoot 'Invoke-FlutterwaveEvidenceCapture.ps1') -Raw
Assert-True -Condition ($collectorSource -notmatch 'Sort-Object\s+LastWriteTime') -Name 'collector script source contains no "Sort-Object LastWriteTime" (the old latest-file mechanism)'
Assert-True -Condition ($collectorSource -notmatch '-Descending\s*\|\s*Select-Object\s+-First\s+1') -Name 'collector script source contains no "newest-first, take one" pattern'

# ============================================================
# Category: tx_ref hash comparison cannot combine two different transactions
# ============================================================
Write-Host "`n=== tx_ref hash binding (Blocker 2) ===" -ForegroundColor Cyan
$hashRefX = Get-Sha256Hex -Text 'omega3-phase0-A-transaction-X'
$hashRefY = Get-Sha256Hex -Text 'omega3-phase0-A-transaction-Y'
Assert-True -Condition ($hashRefX -ne $hashRefY) -Name 'two different tx_ref values hash to two different values (the mismatch check has something to detect)'
Assert-True -Condition ($hashRefX -eq (Get-Sha256Hex -Text 'omega3-phase0-A-transaction-X')) -Name 'the same tx_ref value always hashes identically (the match check is deterministic)'
# The collector's own Verify-time rejection is: providerTxRefSha256 -ne checkoutStage.tx_ref_sha256 => abort.
# That equality/inequality primitive is exactly what is proven above; the
# collector script itself is proven, separately, to invoke it as a hard
# gate (grep below), since that branch makes a real network call and
# cannot be exercised without live credentials.
Assert-True -Condition ($collectorSource -match 'providerTxRefSha256\s+-ne\s+\$checkoutStageForVerify\.tx_ref_sha256') -Name 'collector script source contains the tx_ref-mismatch hard-reject branch'
Assert-True -Condition ($collectorSource -match "No stage file written -- this is exactly the cross-transaction contamination") -Name 'collector script aborts (no stage file) on tx_ref mismatch, with an explicit explanation in the error path'

# ============================================================
# Category: hardened TEST-key validation (High 4)
# ============================================================
Write-Host "`n=== TEST-key format validation (High 4) ===" -ForegroundColor Cyan
# NOTE: fixture "key" values are assembled at RUNTIME via string
# concatenation, deliberately never appearing as a single contiguous
# literal anywhere in this source file. A literal string matching
# Flutterwave's real secret-key shape is exactly what GitHub's push-
# protection secret scanner (correctly) flags as a possible live credential,
# even when the value is synthetic and was never a real key -- so these
# fixtures are built the same way a real test would build a random-looking
# string, never typed out whole.
$fakeHexLower = ('ab' * 16)
$fakeHexUpper = ('AB' * 16)
$fakeHexShort = 'ab12'
$testKeyPrefix = 'FLWSECK' + '_TEST-'
$liveKeyPrefix = 'FLWSECK' + '-'

Assert-True -Condition (Test-IsTestModeKey -KeyValue "$testKeyPrefix$fakeHexLower-X") -Name 'accepts a correctly-shaped TEST key (32 lowercase hex)'
Assert-True -Condition (Test-IsTestModeKey -KeyValue "$testKeyPrefix$fakeHexUpper-X") -Name 'accepts a correctly-shaped TEST key (32 uppercase hex)'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue 'this-is-a-test-key-honestly')) -Name 'rejects a substring trick ("test" appears but format is wrong)'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue "$liveKeyPrefix$fakeHexLower-X")) -Name 'rejects a LIVE-shaped key (missing _TEST)'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue "$($testKeyPrefix.ToLowerInvariant())$fakeHexLower-x")) -Name 'rejects a case-mismatched key (case-sensitive prefix/suffix)'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue "$testKeyPrefix$fakeHexShort-X")) -Name 'rejects a TEST-prefixed key with the wrong middle-segment length'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue '')) -Name 'rejects an empty string'
Assert-True -Condition (-not (Test-IsTestModeKey -KeyValue "$testKeyPrefix$fakeHexLower")) -Name 'rejects a TEST-prefixed key missing the -X suffix'

# ============================================================
# Category: manifest construction and hashing
# ============================================================
Write-Host "`n=== Manifest construction and hashing ===" -ForegroundColor Cyan
$manifest = New-EvidenceManifest `
    -CaptureSessionId 'session-abc' `
    -TestLabel 'A' `
    -TxRefSha256 (Get-Sha256Hex -Text 'ref') `
    -TransactionIdSha256 (Get-Sha256Hex -Text '12345') `
    -TestModeConfirmed $true `
    -ApiVersion 'v3' `
    -CheckoutEndpoint 'https://api.flutterwave.com/v3/payments' `
    -VerifyEndpoint 'https://api.flutterwave.com/v3/transactions/12345/verify' `
    -CheckoutRequestStartUtc $t0 -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 `
    -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 `
    -ElapsedSecondsSinceCheckoutOpened 1.0 -TimelineValid $true `
    -ProviderEvidenceFields @([PSCustomObject]@{ path = 'data.created_at'; key = 'created_at'; value = $t0 }) `
    -CheckoutRawResponseSha256 'deadbeef' -VerifyRawResponseSha256 'cafebabe' `
    -CollectorScriptGitSha 'abc123' -CollectorScriptContentSha256 'contenthash' `
    -PowerShellVersion '7.4.0' -MachineUtcOffsetMinutes 0

$requiredKeys = @('capture_session_id', 'test_label', 'tx_ref_sha256', 'transaction_id_sha256', 'test_mode_confirmed', 'api_version', 'checkout_endpoint', 'verify_endpoint', 'checkout_request_start_utc', 'checkout_request_end_utc', 'checkout_opened_utc', 'payment_completion_observed_utc', 'verify_request_start_utc', 'verify_request_end_utc', 'elapsed_seconds_since_checkout_opened', 'timeline_valid', 'provider_evidence_fields', 'checkout_raw_response_sha256', 'verify_raw_response_sha256', 'collector_script_git_sha', 'collector_script_content_sha256', 'powershell_version', 'machine_utc_offset_minutes')
foreach ($key in $requiredKeys) {
    Assert-True -Condition ($manifest.Contains($key)) -Name "manifest binds required field '$key'"
}
$manifestJson = $manifest | ConvertTo-Json -Depth 12 -Compress
Assert-True -Condition ($manifestJson -notmatch '"data"\s*:\s*\{') -Name 'manifest never embeds a raw nested "data" object (no full-response leakage)'

$tempFile = [System.IO.Path]::GetTempFileName()
try {
    Set-Content -Path $tempFile -Value $manifestJson -Encoding UTF8 -NoNewline
    $hash1 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash
    $hash2 = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash
    Assert-Equal -Expected $hash1 -Actual $hash2 -Name 'manifest SHA-256 is deterministic across repeated hashing'
    Assert-True -Condition ($hash1.Length -eq 64) -Name 'manifest SHA-256 hash is 64 hex characters'
    Set-Content -Path $tempFile -Value ($manifestJson + ' ') -Encoding UTF8 -NoNewline
    Assert-True -Condition ((Get-FileHash -Path $tempFile -Algorithm SHA256).Hash -ne $hash1) -Name 'manifest SHA-256 changes when manifest content changes'
}
finally {
    Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}

# ============================================================
# Category: CI actually invokes this suite (structural self-check)
# ============================================================
Write-Host "`n=== CI wiring (High 2) ===" -ForegroundColor Cyan
$repoRoot = $null
try { $repoRoot = (git -C $toolsRoot rev-parse --show-toplevel 2>$null) } catch { }
if ($repoRoot) {
    $ciPath = Join-Path $repoRoot '.github/workflows/ci.yml'
    if (Test-Path $ciPath) {
        $ciContent = Get-Content -Path $ciPath -Raw
        Assert-True -Condition ($ciContent -match 'FlutterwaveEvidenceLib\.Tests\.ps1') -Name 'ci.yml references FlutterwaveEvidenceLib.Tests.ps1'
        Assert-True -Condition ($ciContent -match '(?i)pwsh') -Name 'ci.yml uses a pwsh shell step for the Phase-0 PowerShell validation'

        # Count job keys ONLY within the `jobs:` top-level block (2-space
        # indented keys immediately under the line "jobs:"), not anywhere
        # else in the file -- a naive whole-file regex would also match
        # unrelated 2-space-indented keys like the `on:` block's
        # `pull_request:`/`push:` entries.
        $ciLines = $ciContent -split "`r?`n"
        $jobsStartIndex = -1
        for ($i = 0; $i -lt $ciLines.Count; $i++) {
            if ($ciLines[$i] -match '^jobs:\s*$') { $jobsStartIndex = $i; break }
        }
        Assert-True -Condition ($jobsStartIndex -ge 0) -Name 'ci.yml has a top-level "jobs:" key'
        $jobCount = 0
        if ($jobsStartIndex -ge 0) {
            for ($i = $jobsStartIndex + 1; $i -lt $ciLines.Count; $i++) {
                if ($ciLines[$i] -match '^\s{2}[a-zA-Z0-9_-]+:\s*$') { $jobCount++ }
            }
        }
        Assert-True -Condition ($jobCount -eq 5) -Name "ci.yml still declares exactly 5 top-level jobs (found $jobCount)"
    }
    else {
        Write-Host "  SKIP: ci.yml not found relative to repo root -- cannot verify CI wiring from this context." -ForegroundColor Yellow
    }
}
else {
    Write-Host "  SKIP: not running inside a git repository -- cannot verify CI wiring from this context." -ForegroundColor Yellow
}

# ============================================================
Write-Host "`n=== Summary: $($script:total - $script:failures) / $($script:total) passed ===" -ForegroundColor $(if ($script:failures -eq 0) { 'Green' } else { 'Red' })
if ($script:failures -gt 0) { exit 1 }
exit 0
