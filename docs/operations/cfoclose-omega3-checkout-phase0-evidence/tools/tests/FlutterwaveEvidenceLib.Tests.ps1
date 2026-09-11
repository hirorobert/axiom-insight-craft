<#
.SYNOPSIS
  Focused, dependency-free tests for FlutterwaveEvidenceLib.ps1 and the
  collector script's static structure -- including, this revision, the
  full CreateCheckout -> ObservePaymentSuccess -> Verify -> FinalizeManifest
  orchestration path, driven with synthetic HTTP/browser/clock ports. No
  Pester required, no network call, no secret, no real Flutterwave
  interaction, no real browser launch.
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
# Category: ALLOWLIST evidence projection -- exact key + value check (Blocker 2)
# ============================================================
Write-Host "`n=== Allowlist evidence projection: exact key + value check (Blocker 2) ===" -ForegroundColor Cyan

# A response shaped like Flutterwave's REAL documented verification example,
# using the ACTUAL field spellings (first_6digits/last_4digits, no
# underscore before the digit; a REAL card `expiry` field like "09/22"),
# PLUS the specific traps this revision closes: created_by/processed_by
# (actor identifiers, not times), and date_created (contains "created" as a
# SUBSTRING but is not the exact key "created_at").
$realShapedResponse = [PSCustomObject]@{
    status  = 'success'
    message = 'Transaction fetched successfully'
    data    = [PSCustomObject]@{
        id           = 12345
        tx_ref       = 'omega3-phase0-A-abc123'
        flw_ref      = 'FLW-REF-XYZ'
        status       = 'successful'
        amount       = 100
        currency     = 'NGN'
        created_at   = '2020-03-11T19:22:07.000Z'
        date_created = '2020-03-11T19:22:07.000Z'  # substring 'created', NOT the exact key 'created_at'
        created_by   = 'system-actor-42'            # substring 'created', an actor, not a time
        processed_by = 'ops-team'                    # substring 'processed', an actor, not a time
        card         = [PSCustomObject]@{
            first_6digits = '123456'
            last_4digits  = '1111'
            token         = 'flw-t1nf-tokenvalue'
            expiry        = '09/22'                  # Flutterwave's REAL card-expiry field -- must NEVER qualify
        }
        customer     = [PSCustomObject]@{
            id         = 999
            email      = 'real.person@example.com'
            phone      = '+2348012345678'
            fullname   = 'Real Person'
            created_at = '2020-03-11T19:22:06.000Z'
        }
        meta         = [PSCustomObject]@{
            device_fingerprint         = 'fp-abc'
            ip                         = '203.0.113.5'
            unexpected_future_field_v9 = 'something Flutterwave adds next year'
        }
        account_id   = 'acct-777'
        merchant_id  = 'merch-888'
    }
}

$fields = Get-AllowlistedEvidenceFields -Node $realShapedResponse
# NOTE: ConvertTo-Json via -InputObject, never piped -- piping an EMPTY
# array (@()) to ConvertTo-Json produces $null (the pipeline's process
# block never runs for zero input records), and `$null -notmatch '...'`
# then evaluates as an array operation rather than a boolean, breaking
# every downstream Assert-True call. -InputObject always sees the array as
# one argument and always returns a string, even for zero elements.
$fieldsJson = ConvertTo-Json -InputObject $fields -Depth 10 -Compress

Assert-True -Condition ($fieldsJson -notmatch '123456') -Name 'first_6digits VALUE (123456) never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '"1111"') -Name 'last_4digits VALUE (1111) never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'first_6digits') -Name 'first_6digits KEY NAME never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'last_4digits') -Name 'last_4digits KEY NAME never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'flw-t1nf-tokenvalue') -Name 'card token never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '(?i)expiry') -Name 'BLOCKER 2: `expiry` key never appears in allowlisted output, under any case'
Assert-True -Condition ($fieldsJson -notmatch '09/22') -Name 'BLOCKER 2: card expiry VALUE "09/22" never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'system-actor-42') -Name 'BLOCKER 2: created_by VALUE never appears (key is not an exact timestamp key, despite containing "created")'
Assert-True -Condition ($fieldsJson -notmatch 'created_by') -Name 'BLOCKER 2: created_by KEY NAME never appears'
Assert-True -Condition ($fieldsJson -notmatch 'ops-team') -Name 'BLOCKER 2: processed_by VALUE never appears (key is not an exact timestamp key, despite containing "processed")'
Assert-True -Condition ($fieldsJson -notmatch 'processed_by') -Name 'BLOCKER 2: processed_by KEY NAME never appears'
Assert-True -Condition ($fieldsJson -notmatch 'date_created') -Name 'BLOCKER 2: date_created KEY never appears -- it CONTAINS "created" as a substring but is not the exact key "created_at"'
Assert-True -Condition ($fieldsJson -notmatch 'real\.person@example\.com') -Name 'customer email never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '\+2348012345678') -Name 'customer phone never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'Real Person') -Name 'customer fullname never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch '203\.0\.113\.5') -Name 'IP address never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'fp-abc') -Name 'device fingerprint never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'acct-777') -Name 'account_id never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'merch-888') -Name 'merchant_id never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -notmatch 'something Flutterwave adds next year') -Name 'arbitrary UNKNOWN future provider field never appears in allowlisted output'
Assert-True -Condition ($fieldsJson -match '2020-03-11T19:22:07\.000Z') -Name 'data.created_at (the EXACT approved key, with a valid value) VALUE is retained'
Assert-True -Condition ($fieldsJson -match '2020-03-11T19:22:06\.000Z') -Name 'nested customer.created_at VALUE is retained'
Assert-True -Condition ($fieldsJson -match '"successful"') -Name 'status value is retained'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.created_at' })).Count -eq 1) -Name 'data.created_at JSON path is preserved exactly'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.customer.created_at' })).Count -eq 1) -Name 'data.customer.created_at JSON path is preserved exactly'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.status' })).Count -eq 1) -Name 'data.status JSON path is preserved exactly'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.date_created' })).Count -eq 0) -Name 'data.date_created (substring match only) is NOT present as its own field'
Assert-True -Condition ((@($fields | Where-Object { $_.path -eq 'data.card.expiry' })).Count -eq 0) -Name 'data.card.expiry is NOT present as its own field'

$allowedKeyNames = @('status', 'amount', 'currency')
$disallowedLeak = @($fields | Where-Object { $allowedKeyNames -notcontains $_.key -and -not (Test-IsApprovedTimestampKey -KeyName $_.key) })
Assert-True -Condition ($disallowedLeak.Count -eq 0) -Name 'every field returned by the allowlist has a key name that is either an allowed scalar or an EXACT approved timestamp key (no accidental leaks)'

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
$arrayJson = ConvertTo-Json -InputObject $arrayFields -Depth 10 -Compress
Assert-True -Condition ($arrayJson -notmatch 'example\.com') -Name 'array element email fields never appear in allowlisted output'
Assert-True -Condition ($arrayJson -notmatch 'zzz|yyy') -Name 'array element arbitrary unknown fields never appear in allowlisted output'
# 't1'/'t2' are not approved-shape timestamp VALUES (they fail Test-IsApprovedTimestampValue), so despite the
# key 'created_at' being an exact match, the value check must reject them -- proving BOTH checks are enforced.
Assert-True -Condition ($arrayJson -notmatch '"t1"') -Name 'array element 0 created_at with a non-timestamp-shaped VALUE ("t1") is rejected on the value side'
Assert-True -Condition ($arrayJson -notmatch '"t2"') -Name 'array element 1 created_at with a non-timestamp-shaped VALUE ("t2") is rejected on the value side'

$arrayShapedValid = [PSCustomObject]@{
    events = @(
        [PSCustomObject]@{ email = 'a@example.com'; created_at = '2021-05-01T00:00:00Z' }
    )
}
$arrayFieldsValid = Get-AllowlistedEvidenceFields -Node $arrayShapedValid -PathPrefix 'data'
Assert-True -Condition ((@($arrayFieldsValid | Where-Object { $_.path -eq 'data.events[0].created_at' })).Count -eq 1) -Name 'array element JSON path includes index correctly, with a genuinely valid timestamp value'

# ============================================================
# Category: Test-IsApprovedTimestampKey / Test-IsApprovedTimestampValue (Blocker 2)
# ============================================================
Write-Host "`n=== Exact timestamp key + value validation (Blocker 2) ===" -ForegroundColor Cyan

Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'created_at') -Name 'key "created_at" is approved (exact)'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'CREATED_AT') -Name 'key "CREATED_AT" is approved (case-insensitive exact)'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'completed_at') -Name 'key "completed_at" is approved'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'processed_at') -Name 'key "processed_at" is approved'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'settled_at') -Name 'key "settled_at" is approved'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'timestamp') -Name 'key "timestamp" is approved'
Assert-True -Condition (Test-IsApprovedTimestampKey -KeyName 'captured_datetime') -Name 'key ending in "_datetime" is approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'expiry')) -Name 'BLOCKER 2: key "expiry" is NEVER approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'expiration')) -Name 'BLOCKER 2: key "expiration" is NEVER approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'created_by')) -Name 'BLOCKER 2: key "created_by" is NEVER approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'processed_by')) -Name 'BLOCKER 2: key "processed_by" is NEVER approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'date_created')) -Name 'BLOCKER 2: key "date_created" (substring only) is NEVER approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampKey -KeyName 'charged_at')) -Name 'key "charged_at" is not on the exact approved list (deliberately narrow, per the corrections named list)'

Assert-True -Condition (Test-IsApprovedTimestampValue -Value '2020-03-11T19:22:07.000Z') -Name 'a real Flutterwave-shaped ISO-8601 UTC value is approved'
Assert-True -Condition (Test-IsApprovedTimestampValue -Value '2020-03-11T19:22:07Z') -Name 'ISO-8601 UTC without fractional seconds is approved'
Assert-True -Condition (Test-IsApprovedTimestampValue -Value '2020-03-11T19:22:07+03:00') -Name 'ISO-8601 with an explicit numeric offset is approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '1584041 727')) -Name 'a value containing whitespace (not a valid epoch, not valid ISO-8601) is never approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '09/22')) -Name 'BLOCKER 2: card expiry value "09/22" is NEVER an approved timestamp value'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '22/09/2020')) -Name 'a locale-ambiguous date-only string is never approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '2020-03-11')) -Name 'a bare date with no time component is never approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value 'not-a-real-date')) -Name 'a malformed/garbage value is never approved, even under an exact-match key'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value $null)) -Name 'a null value is never approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '')) -Name 'an empty string value is never approved'
Assert-True -Condition (Test-IsApprovedTimestampValue -Value '1584041727') -Name 'a 10-digit epoch-seconds value in a sane range is approved'
Assert-True -Condition (Test-IsApprovedTimestampValue -Value '1584041727000') -Name 'a 13-digit epoch-milliseconds value in a sane range is approved'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '99')) -Name 'a too-short numeric value is never treated as an epoch'
Assert-True -Condition (-not (Test-IsApprovedTimestampValue -Value '0000000000')) -Name 'a 10-digit epoch value outside the sane [2000,2100) range is never approved'

# ============================================================
# Category: Get-HostedCheckoutLink -- the ACTUAL link, never the API endpoint (Blocker 1)
# ============================================================
Write-Host "`n=== Get-HostedCheckoutLink (Blocker 1) ===" -ForegroundColor Cyan

$validCheckoutResponse = [PSCustomObject]@{
    status  = 'success'
    message = 'Hosted Link'
    data    = [PSCustomObject]@{ link = 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-01hynrt7cd1fpm6gtef6khn93g' }
}
$validLinkResult = Get-HostedCheckoutLink -Parsed $validCheckoutResponse
Assert-Equal -Expected $true -Actual $validLinkResult.Success -Name 'a valid, Flutterwave-hosted, https data.link is accepted'
Assert-Equal -Expected 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-01hynrt7cd1fpm6gtef6khn93g' -Actual $validLinkResult.Link -Name 'the extracted link is exactly data.link, never the API request URI'
Assert-True -Condition ($validLinkResult.Link -ne 'https://api.flutterwave.com/v3/payments') -Name 'BLOCKER 1: the extracted link is never the API endpoint itself'

Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $null).Success -Name 'a null response is rejected'
Assert-Equal -Expected 'NULL_RESPONSE' -Actual (Get-HostedCheckoutLink -Parsed $null).Reason -Name 'null response reason is NULL_RESPONSE'

$statusNotSuccess = [PSCustomObject]@{ status = 'error'; data = [PSCustomObject]@{ link = 'https://checkout.flutterwave.com/v3/hosted/pay/x' } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $statusNotSuccess).Success -Name 'a response with status != "success" is rejected even if data.link looks valid'
Assert-Equal -Expected 'STATUS_NOT_SUCCESS' -Actual (Get-HostedCheckoutLink -Parsed $statusNotSuccess).Reason -Name 'wrong-status reason is STATUS_NOT_SUCCESS'

$missingLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ id = 1 } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $missingLink).Success -Name 'missing data.link fails'
Assert-Equal -Expected 'MISSING_LINK' -Actual (Get-HostedCheckoutLink -Parsed $missingLink).Reason -Name 'missing-link reason is MISSING_LINK'

$emptyLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = '' } }
Assert-Equal -Expected 'MISSING_LINK' -Actual (Get-HostedCheckoutLink -Parsed $emptyLink).Reason -Name 'an empty-string data.link fails the same way as a missing one'

$malformedLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'not a valid uri at all' } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $malformedLink).Success -Name 'malformed link fails'
Assert-Equal -Expected 'MALFORMED_LINK' -Actual (Get-HostedCheckoutLink -Parsed $malformedLink).Reason -Name 'malformed-link reason is MALFORMED_LINK'

$httpLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'http://checkout.flutterwave.com/v3/hosted/pay/x' } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $httpLink).Success -Name 'http (not https) link fails'
Assert-Equal -Expected 'NOT_HTTPS' -Actual (Get-HostedCheckoutLink -Parsed $httpLink).Reason -Name 'http-link reason is NOT_HTTPS'

$wrongHostLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'https://evil-lookalike.example.com/v3/hosted/pay/x' } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $wrongHostLink).Success -Name 'non-Flutterwave host fails'
Assert-Equal -Expected 'UNAPPROVED_HOST' -Actual (Get-HostedCheckoutLink -Parsed $wrongHostLink).Reason -Name 'non-Flutterwave-host reason is UNAPPROVED_HOST'

$apiEndpointAsLink = [PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'https://api.flutterwave.com/v3/payments' } }
Assert-Equal -Expected $false -Actual (Get-HostedCheckoutLink -Parsed $apiEndpointAsLink).Success -Name 'the API endpoint itself, if it somehow appeared as data.link, is rejected (wrong host)'

# ============================================================
# Category: write-once evidence files (High)
# ============================================================
Write-Host "`n=== Write-once evidence files (High) ===" -ForegroundColor Cyan
$writeOnceDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omega3-writeonce-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $writeOnceDir | Out-Null
try {
    $targetPath = Join-Path $writeOnceDir 'stage-CreateCheckout-TestA-somesession.json'
    $firstWrite = New-ImmutableJsonFile -Path $targetPath -Content '{"attempt":1}'
    Assert-Equal -Expected $true -Actual $firstWrite.Success -Name 'the FIRST write to a new path succeeds'

    $secondWrite = New-ImmutableJsonFile -Path $targetPath -Content '{"attempt":2}'
    Assert-Equal -Expected $false -Actual $secondWrite.Success -Name 'a SECOND write to the SAME path fails'
    Assert-Equal -Expected 'STAGE_ALREADY_EXISTS' -Actual $secondWrite.Reason -Name 'second-write reason is STAGE_ALREADY_EXISTS'

    $contentAfter = Get-Content -Path $targetPath -Raw
    Assert-True -Condition ($contentAfter -match '"attempt":1') -Name 'the ORIGINAL content is unchanged after a failed overwrite attempt (no silent overwrite, no append)'
    Assert-True -Condition ($contentAfter -notmatch '"attempt":2') -Name 'the second write''s content never appears anywhere in the file'
}
finally {
    Remove-Item -Path $writeOnceDir -Recurse -Force -ErrorAction SilentlyContinue
}

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

# Isolated repro: a timestamp round-tripped through ConvertTo-Json/
# ConvertFrom-Json (exactly what every stage file does) must still validate.
# PowerShell 5.1 (Windows, JavaScriptSerializer-based JSON) and PowerShell 7+
# (Linux CI, System.Text.Json-based) use different JSON engines internally,
# so this round-trip is tested explicitly rather than assumed identical.
$rawTs = Get-UtcTimestamp
$roundTripObj = [PSCustomObject]@{ ts = $rawTs } | ConvertTo-Json | ConvertFrom-Json
$roundTrippedTs = [string]$roundTripObj.ts
Write-Host "  DIAGNOSTIC: raw='$rawTs' (len=$($rawTs.Length)) roundtripped='$roundTrippedTs' (len=$($roundTrippedTs.Length)) equal=$($rawTs -eq $roundTrippedTs)" -ForegroundColor DarkGray
Assert-Equal -Expected $rawTs -Actual $roundTrippedTs -Name 'a UTC timestamp is byte-for-byte identical after a ConvertTo-Json/ConvertFrom-Json round-trip'
Assert-True -Condition (Test-IsValidUtcTimestamp -Value $roundTrippedTs) -Name 'a timestamp round-tripped through JSON still validates as a valid UTC timestamp'

# ============================================================
# Category: timeline ordering / Test B minimum (High 1)
# ============================================================
Write-Host "`n=== Timeline ordering and Test B minimum (High 1) ===" -ForegroundColor Cyan

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

$testAFast = Test-TimelineOrdering -CheckoutRequestStartUtc $t0 -CheckoutRequestEndUtc $t1 -CheckoutOpenedUtc $t2 -PaymentCompletionObservedUtc $t3 -VerifyRequestStartUtc $t4 -VerifyRequestEndUtc $t5 -IsTestB $false
Assert-True -Condition $testAFast.Valid -Name 'Test A has no minimum-elapsed requirement (a fast, correctly-ordered timeline is valid)'

# ============================================================
# Category: session-bound stage capture, no latest-file selection (Blocker 2, prior round)
# ============================================================
Write-Host "`n=== Session-bound stage capture ===" -ForegroundColor Cyan

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omega3-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
    $sessionA = [guid]::NewGuid().ToString('N')
    $sessionB = [guid]::NewGuid().ToString('N')

    $missing = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $false -Actual $missing.Success -Name 'Get-StageCapture reports failure when the stage file does not exist'
    Assert-Equal -Expected 'MISSING' -Actual $missing.Reason -Name 'missing stage reason is MISSING'

    $goodStage = @{ capture_session_id = $sessionA; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = (Get-Sha256Hex -Text 'ref-A') }
    $null = New-ImmutableJsonFile -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$sessionA.json") -Content ($goodStage | ConvertTo-Json)

    $ok = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $true -Actual $ok.Success -Name 'Get-StageCapture succeeds for an exact, internally-consistent match'
    Assert-Equal -Expected $sessionA -Actual $ok.Data.capture_session_id -Name 'loaded stage carries the correct capture_session_id'

    $crossSession = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionB
    Assert-Equal -Expected $false -Actual $crossSession.Success -Name 'a different (unrelated) session id never matches an existing stage file'
    Assert-Equal -Expected 'MISSING' -Actual $crossSession.Reason -Name 'cross-session lookup reason is MISSING, proving there is no fallback to "the only file present"'

    $tamperedSession = [guid]::NewGuid().ToString('N')
    $tamperedStage = @{ capture_session_id = 'SOME-OTHER-SESSION'; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = 'x' }
    $null = New-ImmutableJsonFile -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$tamperedSession.json") -Content ($tamperedStage | ConvertTo-Json)
    $tamperedResult = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $tamperedSession
    Assert-Equal -Expected $false -Actual $tamperedResult.Success -Name 'a stage file whose internal capture_session_id disagrees with its filename is rejected'
    Assert-Equal -Expected 'SESSION_MISMATCH' -Actual $tamperedResult.Reason -Name 'tampered-session reason is SESSION_MISMATCH'

    $labelMismatchSession = [guid]::NewGuid().ToString('N')
    $labelMismatchStage = @{ capture_session_id = $labelMismatchSession; test_label = 'B'; action = 'CreateCheckout'; tx_ref_sha256 = 'x' }
    $null = New-ImmutableJsonFile -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$labelMismatchSession.json") -Content ($labelMismatchStage | ConvertTo-Json)
    $labelMismatchResult = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $labelMismatchSession
    Assert-Equal -Expected $false -Actual $labelMismatchResult.Success -Name 'a stage file whose internal test_label disagrees with its filename is rejected'
    Assert-Equal -Expected 'LABEL_MISMATCH' -Actual $labelMismatchResult.Reason -Name 'label-mismatch reason is LABEL_MISMATCH'

    Start-Sleep -Milliseconds 20
    $sessionC = [guid]::NewGuid().ToString('N')
    $newerStage = @{ capture_session_id = $sessionC; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = (Get-Sha256Hex -Text 'ref-C') }
    $null = New-ImmutableJsonFile -Path (Join-Path $tempDir "stage-CreateCheckout-TestA-$sessionC.json") -Content ($newerStage | ConvertTo-Json)
    $stillSessionA = Get-StageCapture -EvidenceRoot $tempDir -ActionName 'CreateCheckout' -TestLabel 'A' -CaptureSessionId $sessionA
    Assert-Equal -Expected $sessionA -Actual $stillSessionA.Data.capture_session_id -Name 'requesting an OLDER session by exact id still returns that session, not a newer one written afterward (no latest-file fallback)'
}
finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$collectorSource = Get-Content -Path (Join-Path $toolsRoot 'Invoke-FlutterwaveEvidenceCapture.ps1') -Raw
$librarySource = Get-Content -Path (Join-Path $toolsRoot 'FlutterwaveEvidenceLib.ps1') -Raw
Assert-True -Condition ($collectorSource -notmatch 'Sort-Object\s+LastWriteTime') -Name 'collector script source contains no "Sort-Object LastWriteTime" (the old latest-file mechanism)'
Assert-True -Condition ($collectorSource -notmatch '-Descending\s*\|\s*Select-Object\s+-First\s+1') -Name 'collector script source contains no "newest-first, take one" pattern'
Assert-True -Condition ($collectorSource -notmatch 'Set-Content.*stage-') -Name 'collector script never calls Set-Content against a stage-* path (write-once via New-ImmutableJsonFile only)'
Assert-True -Condition ($collectorSource -notmatch 'Start-Process\s+\$uri') -Name 'BLOCKER 1: collector script never calls Start-Process against $uri (the API endpoint) -- it only ever calls the OpenUrl port with the validated hosted-checkout link'
Assert-True -Condition ($collectorSource -match 'Invoke-CreateCheckoutOrchestration') -Name 'collector script delegates CreateCheckout to the real, tested orchestration function'
Assert-True -Condition ($librarySource -match 'providerTxRefSha256\s+-ne\s+\$checkoutResult\.Data\.tx_ref_sha256') -Name 'library source contains the tx_ref-mismatch hard-reject branch (now inside the orchestration function)'
Assert-True -Condition ($librarySource -match "TRANSACTION_ID_MISMATCH") -Name 'library source contains the transaction-id-mismatch hard-reject branch (item 4, complete transaction binding)'

# ============================================================
# Category: tx_ref hash comparison cannot combine two different transactions
# ============================================================
Write-Host "`n=== tx_ref hash binding ===" -ForegroundColor Cyan
$hashRefX = Get-Sha256Hex -Text 'omega3-phase0-A-transaction-X'
$hashRefY = Get-Sha256Hex -Text 'omega3-phase0-A-transaction-Y'
Assert-True -Condition ($hashRefX -ne $hashRefY) -Name 'two different tx_ref values hash to two different values (the mismatch check has something to detect)'
Assert-True -Condition ($hashRefX -eq (Get-Sha256Hex -Text 'omega3-phase0-A-transaction-X')) -Name 'the same tx_ref value always hashes identically (the match check is deterministic)'

# ============================================================
# Category: hardened TEST-key validation
# ============================================================
Write-Host "`n=== TEST-key format validation ===" -ForegroundColor Cyan
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
# Category: END-TO-END ORCHESTRATION -- synthetic ports, real logic (item 5)
# ============================================================
Write-Host "`n=== End-to-end orchestration (synthetic HTTP/browser/clock ports) ===" -ForegroundColor Cyan

function New-FakeClock {
    # Returns a scriptblock that hands out strictly-increasing UTC
    # timestamps, one second apart, each call -- so a full orchestration
    # run naturally produces a validly-ordered timeline without any real
    # wall-clock waiting.
    $counter = [ref]0
    return {
        $counter.Value++
        return [DateTime]::UtcNow.AddSeconds($counter.Value).ToString('o')
    }.GetNewClosure()
}

$e2eEvidenceRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omega3-e2e-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $e2eEvidenceRoot | Out-Null
try {
    $sessionId = [guid]::NewGuid().ToString('N')
    $realTxRef = "omega3-phase0-A-$sessionId"
    $realTransactionId = '778899'

    $checkoutSuccessResponse = [PSCustomObject]@{
        status  = 'success'
        message = 'Hosted Link'
        data    = [PSCustomObject]@{ link = 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-e2etest' }
    } | ConvertTo-Json -Depth 5

    $verifySuccessResponse = [PSCustomObject]@{
        status  = 'success'
        message = 'Transaction fetched successfully'
        data    = [PSCustomObject]@{
            id         = $realTransactionId
            tx_ref     = $realTxRef
            status     = 'successful'
            amount     = 100
            currency   = 'NGN'
            created_at = '2020-03-11T19:22:07.000Z'
        }
    } | ConvertTo-Json -Depth 5

    $openedUrls = New-Object System.Collections.Generic.List[string]
    $fakeOpenUrl = {
        param($Url)
        $openedUrls.Add($Url)
    }.GetNewClosure()

    $fakeHttpPost = { param($Uri, $BodyJson) return @{ StatusCode = 200; Body = $checkoutSuccessResponse } }.GetNewClosure()
    $fakeHttpGet = { param($Uri) return @{ StatusCode = 200; Body = $verifySuccessResponse } }.GetNewClosure()
    $fakeClock = New-FakeClock

    # --- Step 1: CreateCheckout ---
    $createResult = Invoke-CreateCheckoutOrchestration `
        -TestLabel 'A' -CaptureSessionId $sessionId -TxRef $realTxRef `
        -Amount '100' -Currency 'NGN' -RedirectUrl 'https://example.invalid/return' -CustomerEmail 'phase0-evidence-test@example.invalid' `
        -EvidenceRoot $e2eEvidenceRoot -HttpPost $fakeHttpPost -OpenUrl $fakeOpenUrl -NowUtc $fakeClock `
        -CollectorScriptGitSha 'test-sha' -CollectorScriptContentSha256 'test-content-hash'

    Assert-Equal -Expected $true -Actual $createResult.Success -Name 'E2E: CreateCheckout orchestration succeeds against a synthetic successful response'
    Assert-Equal -Expected 1 -Actual $openedUrls.Count -Name 'E2E: the OpenUrl port was called exactly once'
    Assert-Equal -Expected 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-e2etest' -Actual $openedUrls[0] -Name 'BLOCKER 1: the hosted checkout LINK was opened'
    Assert-True -Condition ($openedUrls[0] -ne 'https://api.flutterwave.com/v3/payments') -Name 'BLOCKER 1: the API endpoint was NEVER opened'
    Assert-True -Condition (Test-Path $createResult.StagePath) -Name 'E2E: a CreateCheckout stage file was written'

    # --- Step 2: ObservePaymentSuccess ---
    $observeResult = Invoke-ObservePaymentSuccessOrchestration `
        -TestLabel 'A' -CaptureSessionId $sessionId -EvidenceRoot $e2eEvidenceRoot `
        -Confirmed $true -NowUtc $fakeClock `
        -CollectorScriptGitSha 'test-sha' -CollectorScriptContentSha256 'test-content-hash'
    Assert-Equal -Expected $true -Actual $observeResult.Success -Name 'E2E: ObservePaymentSuccess orchestration succeeds when confirmed'

    # --- Step 3: Verify ---
    $verifyResult = Invoke-VerifyOrchestration `
        -TestLabel 'A' -CaptureSessionId $sessionId -TransactionId $realTransactionId `
        -EvidenceRoot $e2eEvidenceRoot -HttpGet $fakeHttpGet -NowUtc $fakeClock `
        -CollectorScriptGitSha 'test-sha' -CollectorScriptContentSha256 'test-content-hash'
    if (-not $verifyResult.Success) { Write-Host "  DIAGNOSTIC: Verify failed with Reason='$($verifyResult.Reason)'" -ForegroundColor Magenta }
    Assert-Equal -Expected $true -Actual $verifyResult.Success -Name 'E2E: Verify orchestration succeeds when tx_ref and transaction id both match'

    # --- Step 4: FinalizeManifest ---
    $finalizeResult = Invoke-FinalizeManifestOrchestration `
        -TestLabel 'A' -CaptureSessionId $sessionId -EvidenceRoot $e2eEvidenceRoot `
        -CollectorScriptGitSha 'test-sha' -CollectorScriptContentSha256 'test-content-hash' `
        -PowerShellVersion '7.4.0' -MachineUtcOffsetMinutes 0
    Assert-Equal -Expected $true -Actual $finalizeResult.Success -Name 'E2E: FinalizeManifest orchestration succeeds for a fully-correlated session'
    Assert-True -Condition (Test-Path $finalizeResult.ManifestPath) -Name 'E2E: the final manifest file was written'

    $finalManifestContent = Get-Content -Path $finalizeResult.ManifestPath -Raw | ConvertFrom-Json
    Assert-Equal -Expected $true -Actual $finalManifestContent.timeline_valid -Name 'E2E: the finalized manifest reports timeline_valid = true'
    Assert-True -Condition ((@($finalManifestContent.provider_evidence_fields | Where-Object { $_.path -eq 'data.created_at' })).Count -ge 1) -Name 'E2E: the finalized manifest carries at least one allowlisted timestamp field'
    $finalManifestJson = $finalManifestContent | ConvertTo-Json -Depth 10 -Compress
    Assert-True -Condition ($finalManifestJson -notmatch $realTxRef) -Name 'E2E: the RAW tx_ref never appears in the final manifest, only its hash'
    # NOTE: the transaction id legitimately appears once, inside
    # `verify_endpoint` -- the URL this session's Verify action actually
    # called, which is genuine, non-sensitive provenance (an opaque
    # provider-assigned identifier, not PII/card data), and knowing which
    # URL was called is exactly the kind of information a provenance
    # manifest should keep. What must NEVER happen is the transaction id
    # appearing as its own bare evidence VALUE outside of that one
    # routing/provenance field -- `transaction_id_sha256` is the hash-only
    # form used everywhere else.
    $manifestFieldsWithoutEndpoints = $finalManifestContent | Select-Object * -ExcludeProperty checkout_endpoint, verify_endpoint
    $manifestFieldsJson = $manifestFieldsWithoutEndpoints | ConvertTo-Json -Depth 10 -Compress
    Assert-True -Condition ($manifestFieldsJson -notmatch $realTransactionId) -Name 'E2E: the RAW transaction id never appears anywhere in the manifest EXCEPT the verify_endpoint URL itself (routing provenance, not evidence)'
}
finally {
    Remove-Item -Path $e2eEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# ============================================================
# Category: orchestration FAILURE BOUNDARIES (item 5)
# ============================================================
Write-Host "`n=== Orchestration failure boundaries ===" -ForegroundColor Cyan

function New-OrchestrationTestContext {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("omega3-fail-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    return $dir
}

# --- CreateCheckout failure boundaries ---
$failScenarios = @(
    @{ Name = 'missing data.link fails, writes no stage, never opens a browser'
        Response = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ id = 1 } } | ConvertTo-Json)
        ExpectedReason = 'MISSING_LINK' }
    @{ Name = 'malformed data.link fails, writes no stage, never opens a browser'
        Response = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'not a uri' } } | ConvertTo-Json)
        ExpectedReason = 'MALFORMED_LINK' }
    @{ Name = 'http (non-https) data.link fails, writes no stage, never opens a browser'
        Response = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'http://checkout.flutterwave.com/v3/hosted/pay/x' } } | ConvertTo-Json)
        ExpectedReason = 'NOT_HTTPS' }
    @{ Name = 'non-Flutterwave host data.link fails, writes no stage, never opens a browser'
        Response = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'https://not-flutterwave.example.com/pay/x' } } | ConvertTo-Json)
        ExpectedReason = 'UNAPPROVED_HOST' }
)

foreach ($scenario in $failScenarios) {
    $dir = New-OrchestrationTestContext
    try {
        $openCount = [ref]0
        $noopOpenUrl = { param($Url) $openCount.Value++ }.GetNewClosure()
        $canned = $scenario.Response
        $postFn = { param($Uri, $BodyJson) return @{ StatusCode = 200; Body = $canned } }.GetNewClosure()
        $sid = [guid]::NewGuid().ToString('N')

        $result = Invoke-CreateCheckoutOrchestration `
            -TestLabel 'A' -CaptureSessionId $sid -TxRef "ref-$sid" `
            -Amount '100' -Currency 'NGN' -RedirectUrl 'https://example.invalid/return' -CustomerEmail 'test@example.invalid' `
            -EvidenceRoot $dir -HttpPost $postFn -OpenUrl $noopOpenUrl -NowUtc { Get-UtcTimestamp } `
            -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'

        Assert-Equal -Expected $false -Actual $result.Success -Name "FAILURE BOUNDARY: $($scenario.Name) -- Success is false"
        Assert-Equal -Expected $scenario.ExpectedReason -Actual $result.Reason -Name "FAILURE BOUNDARY: $($scenario.Name) -- correct reason code"
        Assert-Equal -Expected 0 -Actual $openCount.Value -Name "FAILURE BOUNDARY: $($scenario.Name) -- OpenUrl was NEVER called"
        Assert-Equal -Expected 0 -Actual (@(Get-ChildItem -Path $dir -Filter 'stage-*.json' -ErrorAction SilentlyContinue)).Count -Name "FAILURE BOUNDARY: $($scenario.Name) -- no stage file was written"
    }
    finally {
        Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Browser-launch failure: a VALID link, but OpenUrl throws ---
$dir = New-OrchestrationTestContext
try {
    $validResp = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'https://checkout.flutterwave.com/v3/hosted/pay/x' } } | ConvertTo-Json)
    $postFn = { param($Uri, $BodyJson) return @{ StatusCode = 200; Body = $validResp } }.GetNewClosure()
    $throwingOpenUrl = { param($Url) throw "Simulated: no application is associated with this URL." }
    $sid = [guid]::NewGuid().ToString('N')

    $result = Invoke-CreateCheckoutOrchestration `
        -TestLabel 'A' -CaptureSessionId $sid -TxRef "ref-$sid" `
        -Amount '100' -Currency 'NGN' -RedirectUrl 'https://example.invalid/return' -CustomerEmail 'test@example.invalid' `
        -EvidenceRoot $dir -HttpPost $postFn -OpenUrl $throwingOpenUrl -NowUtc { Get-UtcTimestamp } `
        -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'

    Assert-Equal -Expected $false -Actual $result.Success -Name 'FAILURE BOUNDARY: browser-launch failure -- Success is false'
    Assert-Equal -Expected 'BROWSER_LAUNCH_FAILED' -Actual $result.Reason -Name 'FAILURE BOUNDARY: browser-launch failure -- correct reason code'
    Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($result.Detail)) -Name 'FAILURE BOUNDARY: browser-launch failure -- the real error is surfaced, not suppressed'
    Assert-Equal -Expected 0 -Actual (@(Get-ChildItem -Path $dir -Filter 'stage-*.json' -ErrorAction SilentlyContinue)).Count -Name 'FAILURE BOUNDARY: browser-launch failure -- no successful stage file was written'
}
finally {
    Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Verify failure boundaries: tx_ref mismatch, transaction id mismatch ---
$dir = New-OrchestrationTestContext
try {
    $sid = [guid]::NewGuid().ToString('N')
    $checkoutResp = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ link = 'https://checkout.flutterwave.com/v3/hosted/pay/x' } } | ConvertTo-Json)
    $postFn = { param($Uri, $BodyJson) return @{ StatusCode = 200; Body = $checkoutResp } }.GetNewClosure()
    $openUrl = { param($Url) }
    $clock = New-FakeClock

    $null = Invoke-CreateCheckoutOrchestration -TestLabel 'A' -CaptureSessionId $sid -TxRef 'the-real-ref' `
        -Amount '100' -Currency 'NGN' -RedirectUrl 'https://example.invalid/return' -CustomerEmail 'test@example.invalid' `
        -EvidenceRoot $dir -HttpPost $postFn -OpenUrl $openUrl -NowUtc $clock -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'
    $null = Invoke-ObservePaymentSuccessOrchestration -TestLabel 'A' -CaptureSessionId $sid -EvidenceRoot $dir -Confirmed $true -NowUtc $clock -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'

    # Verify response returns a DIFFERENT tx_ref than the checkout stage recorded.
    $wrongTxRefResp = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ id = '999'; tx_ref = 'a-completely-different-ref' } } | ConvertTo-Json)
    $getFn = { param($Uri) return @{ StatusCode = 200; Body = $wrongTxRefResp } }.GetNewClosure()
    $verifyResult = Invoke-VerifyOrchestration -TestLabel 'A' -CaptureSessionId $sid -TransactionId '999' `
        -EvidenceRoot $dir -HttpGet $getFn -NowUtc $clock -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'
    Assert-Equal -Expected $false -Actual $verifyResult.Success -Name 'FAILURE BOUNDARY: Verify with a mismatched tx_ref -- Success is false'
    Assert-Equal -Expected 'TX_REF_MISMATCH' -Actual $verifyResult.Reason -Name 'FAILURE BOUNDARY: Verify with a mismatched tx_ref -- correct reason code'
    Assert-Equal -Expected 0 -Actual (@(Get-ChildItem -Path $dir -Filter 'stage-Verify-*.json' -ErrorAction SilentlyContinue)).Count -Name 'FAILURE BOUNDARY: tx_ref mismatch -- no Verify stage file was written'

    # Verify response returns the CORRECT tx_ref but a DIFFERENT transaction id than requested.
    $wrongIdResp = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ id = 'DIFFERENT-ID'; tx_ref = 'the-real-ref' } } | ConvertTo-Json)
    $getFn2 = { param($Uri) return @{ StatusCode = 200; Body = $wrongIdResp } }.GetNewClosure()
    $verifyResult2 = Invoke-VerifyOrchestration -TestLabel 'A' -CaptureSessionId $sid -TransactionId '999' `
        -EvidenceRoot $dir -HttpGet $getFn2 -NowUtc $clock -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'
    Assert-Equal -Expected $false -Actual $verifyResult2.Success -Name 'FAILURE BOUNDARY: Verify with a mismatched transaction id -- Success is false'
    Assert-Equal -Expected 'TRANSACTION_ID_MISMATCH' -Actual $verifyResult2.Reason -Name 'FAILURE BOUNDARY: Verify with a mismatched transaction id -- correct reason code'
    Assert-Equal -Expected 0 -Actual (@(Get-ChildItem -Path $dir -Filter 'stage-Verify-*.json' -ErrorAction SilentlyContinue)).Count -Name 'FAILURE BOUNDARY: transaction-id mismatch -- no Verify stage file was written'

    # Missing tx_ref / missing id in the verify response.
    $missingTxRefResp = ([PSCustomObject]@{ status = 'success'; data = [PSCustomObject]@{ id = '999' } } | ConvertTo-Json)
    $getFn3 = { param($Uri) return @{ StatusCode = 200; Body = $missingTxRefResp } }.GetNewClosure()
    $verifyResult3 = Invoke-VerifyOrchestration -TestLabel 'A' -CaptureSessionId $sid -TransactionId '999' `
        -EvidenceRoot $dir -HttpGet $getFn3 -NowUtc $clock -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x'
    Assert-Equal -Expected 'MISSING_TX_REF' -Actual $verifyResult3.Reason -Name 'FAILURE BOUNDARY: Verify response missing data.tx_ref entirely -- correct reason code'
}
finally {
    Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- FinalizeManifest failure boundary: collector-version mismatch across stages ---
$dir = New-OrchestrationTestContext
try {
    $sid = [guid]::NewGuid().ToString('N')
    $checkoutStage = @{ capture_session_id = $sid; test_label = 'A'; action = 'CreateCheckout'; tx_ref_sha256 = 'abc'; endpoint = 'x'; request_start_utc = $t0; request_end_utc = $t1; checkout_opened_utc = $t2; provider_evidence_fields = @(); raw_response_sha256 = 'x'; collector_script_content_sha256 = 'VERSION-1' }
    $observeStage = @{ capture_session_id = $sid; test_label = 'A'; action = 'ObservePaymentSuccess'; checkout_opened_utc = $t2; payment_completion_observed_utc = $t3; elapsed_seconds_since_checkout_opened = 1.0; collector_script_content_sha256 = 'VERSION-1' }
    $verifyStage = @{ capture_session_id = $sid; test_label = 'A'; action = 'Verify'; tx_ref_sha256 = 'abc'; transaction_id_sha256 = 'def'; endpoint = 'y'; request_start_utc = $t4; request_end_utc = $t5; provider_evidence_fields = @(); raw_response_sha256 = 'y'; collector_script_content_sha256 = 'VERSION-2-DIFFERENT' }

    $null = New-ImmutableJsonFile -Path (Join-Path $dir "stage-CreateCheckout-TestA-$sid.json") -Content ($checkoutStage | ConvertTo-Json)
    $null = New-ImmutableJsonFile -Path (Join-Path $dir "stage-ObservePaymentSuccess-TestA-$sid.json") -Content ($observeStage | ConvertTo-Json)
    $null = New-ImmutableJsonFile -Path (Join-Path $dir "stage-Verify-TestA-$sid.json") -Content ($verifyStage | ConvertTo-Json)

    $finalizeResult = Invoke-FinalizeManifestOrchestration -TestLabel 'A' -CaptureSessionId $sid -EvidenceRoot $dir `
        -CollectorScriptGitSha '' -CollectorScriptContentSha256 'x' -PowerShellVersion '7.4.0' -MachineUtcOffsetMinutes 0
    Assert-Equal -Expected $false -Actual $finalizeResult.Success -Name 'FAILURE BOUNDARY: FinalizeManifest with mismatched collector-version across stages -- Success is false'
    Assert-Equal -Expected 'COLLECTOR_VERSION_MISMATCH' -Actual $finalizeResult.Reason -Name 'FAILURE BOUNDARY: mismatched collector version -- correct reason code'
    Assert-Equal -Expected 0 -Actual (@(Get-ChildItem -Path $dir -Filter 'manifest-*.json' -ErrorAction SilentlyContinue)).Count -Name 'FAILURE BOUNDARY: mismatched collector version -- no manifest was written'
}
finally {
    Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# ============================================================
# Category: CI actually invokes this suite (structural self-check)
# ============================================================
Write-Host "`n=== CI wiring ===" -ForegroundColor Cyan
$repoRoot = $null
try { $repoRoot = (git -C $toolsRoot rev-parse --show-toplevel 2>$null) } catch { }
if ($repoRoot) {
    $ciPath = Join-Path $repoRoot '.github/workflows/ci.yml'
    if (Test-Path $ciPath) {
        $ciContent = Get-Content -Path $ciPath -Raw
        Assert-True -Condition ($ciContent -match 'FlutterwaveEvidenceLib\.Tests\.ps1') -Name 'ci.yml references FlutterwaveEvidenceLib.Tests.ps1'
        Assert-True -Condition ($ciContent -match '(?i)pwsh') -Name 'ci.yml uses a pwsh shell step for the Phase-0 PowerShell validation'

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
