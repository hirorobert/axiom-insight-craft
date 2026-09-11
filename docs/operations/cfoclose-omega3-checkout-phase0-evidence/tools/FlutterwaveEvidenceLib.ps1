<#
.SYNOPSIS
  Pure, network-free, secret-free helper functions for the Ω3-CHECKOUT Phase 0
  Flutterwave evidence collector. Dot-sourced by both
  Invoke-FlutterwaveEvidenceCapture.ps1 (the real, network-calling tool) and
  tests/FlutterwaveEvidenceLib.Tests.ps1 (the focused test suite).

  Nothing in this file makes a network call, reads a secret, or writes a file.
  That separation is deliberate: it is what makes every function here directly
  unit-testable with synthetic inputs, with no mocking of HTTP or credentials
  required.
#>

Set-StrictMode -Version Latest

function Get-UtcTimestamp {
    [OutputType([string])]
    param()
    return [DateTime]::UtcNow.ToString('o')
}

function Get-Sha256Hex {
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hashBytes = $sha256.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Test-IsTestModeKey {
    <#
    Heuristic-only safety check: refuses to proceed with a key that does not
    look like a Flutterwave TEST-mode key. This is a defensive backstop, not a
    substitute for the explicit TEST-MODE-CONFIRMED prompt the real collector
    also requires — a heuristic can be wrong, the explicit human confirmation
    cannot be silently bypassed.
    #>
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$KeyValue
    )
    if ([string]::IsNullOrWhiteSpace($KeyValue)) { return $false }
    return ($KeyValue -match '(?i)test')
}

function Get-CaptureOutcome {
    <#
    Pure decision function: given an HTTP status code and a raw response body,
    decides whether this capture is usable evidence.
      - Reason 'NON_2XX'       : status code outside [200,299] — abort, no manifest.
      - Reason 'MALFORMED_JSON': status was 2xx but the body does not parse — abort, no manifest.
      - Reason 'OK'            : status was 2xx and the body parsed — proceed.
    Never throws for a malformed body; malformed input is a normal, expected
    outcome this function reports, not an exceptional one.
    #>
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [Nullable[int]]$StatusCode,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$RawBody
    )

    if ($null -eq $StatusCode -or $StatusCode -lt 200 -or $StatusCode -ge 300) {
        return @{ Success = $false; Reason = 'NON_2XX'; Parsed = $null }
    }

    if ([string]::IsNullOrWhiteSpace($RawBody)) {
        # An empty/whitespace-only body is not usable evidence even with a
        # 2xx status — ConvertFrom-Json silently returns $null for '' rather
        # than throwing, so this must be checked explicitly or a blank body
        # would otherwise be misreported as a successful, evidence-bearing capture.
        return @{ Success = $false; Reason = 'MALFORMED_JSON'; Parsed = $null }
    }

    try {
        $parsed = $RawBody | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        return @{ Success = $false; Reason = 'MALFORMED_JSON'; Parsed = $null }
    }

    return @{ Success = $true; Reason = 'OK'; Parsed = $parsed }
}

# Fixed denylist — case-insensitive key names stripped anywhere in the response
# tree, regardless of nesting depth. Anything NOT on this list is retained,
# so a timestamp/status/amount/currency field the redaction step has never
# seen before is kept by default rather than silently dropped.
$script:FlutterwaveEvidenceDenyKeys = @(
    'account_id', 'merchant_id', 'customer_id', 'id_merchant', 'merchant_reference',
    'card_token', 'token', 'card_number', 'cardno', 'last4digits', 'last4', 'first6digits', 'first6',
    'ip', 'ip_address', 'device_fingerprint', 'device_id',
    'authorization', 'auth', 'secret', 'api_key', 'apikey', 'key',
    'email', 'phone', 'phone_number', 'phonenumber', 'name', 'fullname', 'full_name', 'customer_name'
)

function ConvertTo-RedactedObject {
    <#
    Recursively walks a parsed JSON object/array/scalar tree and replaces the
    VALUE of any key whose name (case-insensitive) appears in the fixed
    denylist with the literal string '[REDACTED]'. Every other key/value,
    at every depth, is retained unchanged. Arrays are walked element-by-
    element; scalars are returned as-is.
    #>
    [OutputType([object])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        $Node
    )

    if ($null -eq $Node) { return $Node }

    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $result = [ordered]@{}
        foreach ($prop in $Node.PSObject.Properties) {
            $lname = $prop.Name.ToLowerInvariant()
            if ($script:FlutterwaveEvidenceDenyKeys -contains $lname) {
                $result[$prop.Name] = '[REDACTED]'
            }
            else {
                $result[$prop.Name] = ConvertTo-RedactedObject -Node $prop.Value
            }
        }
        return [PSCustomObject]$result
    }
    elseif ($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string])) {
        return @($Node | ForEach-Object { ConvertTo-RedactedObject -Node $_ })
    }
    else {
        return $Node
    }
}

function Test-IsSafeFlagResult {
    <#
    A disposable, executable PowerShell mirror of the STRICT discriminated-
    union contract pinned in IMPLEMENTATION_CONDITIONS_PINNED.md (Condition 2
    of that document). This function calls no network, touches no checkout
    logic, and is not itself the real implementation — it exists solely to
    prove, executably, that the PINNED specification is internally
    consistent (no shape is simultaneously described as both accepted and
    rejected), by running the exact enumerated accept/reject list from that
    document's "Required executable tests" section against this mirror.

    Accepts EXACTLY:
      { flagged: true }                                   -- exactly one key
      { flagged: false, reason: 'ALREADY_FLAGGED' }        -- exactly two keys
      { flagged: false, reason: 'INTENT_NOT_PENDING' }     -- exactly two keys
    Rejects everything else, including an otherwise-valid shape carrying any
    additional property.
    #>
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        $FlagResult
    )

    if ($null -eq $FlagResult) { return $false }
    if ($FlagResult -is [System.Array]) { return $false }
    if ($FlagResult -is [string] -or $FlagResult -is [int] -or $FlagResult -is [double] -or $FlagResult -is [bool]) {
        return $false
    }
    if (-not ($FlagResult -is [System.Management.Automation.PSCustomObject] -or $FlagResult -is [hashtable])) {
        return $false
    }

    if ($FlagResult -is [hashtable]) {
        $keys = @($FlagResult.Keys | Sort-Object)
        $get = { param($k) $FlagResult[$k] }
    }
    else {
        # NOTE: enumerate explicitly via ForEach-Object rather than chained
        # `.PSObject.Properties.Name` — under Set-StrictMode -Version Latest,
        # that chained form throws PropertyNotFoundStrict when the property
        # collection is EMPTY (e.g. FlagResult = {}), which is exactly one of
        # the shapes this function must be able to reject cleanly rather than
        # crash on.
        $keys = @($FlagResult.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        $get = { param($k) $FlagResult.$k }
    }

    if ($keys.Count -eq 1 -and $keys[0] -eq 'flagged') {
        $flaggedValue = & $get 'flagged'
        if ($flaggedValue -is [bool] -and $flaggedValue -eq $true) { return $true }
        return $false
    }

    if ($keys.Count -eq 2 -and $keys[0] -eq 'flagged' -and $keys[1] -eq 'reason') {
        $flaggedValue = & $get 'flagged'
        $reasonValue = & $get 'reason'
        if ($flaggedValue -is [bool] -and $flaggedValue -eq $false -and $reasonValue -is [string]) {
            if ($reasonValue -eq 'ALREADY_FLAGGED' -or $reasonValue -eq 'INTENT_NOT_PENDING') {
                return $true
            }
        }
        return $false
    }

    return $false
}

function New-EvidenceManifest {
    <#
    Builds the final provenance manifest object binding together every field
    Correction 4 requires. Pure — takes already-computed inputs, writes
    nothing, makes no network call.
    #>
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('A', 'B')][string]$TestLabel,
        [Parameter(Mandatory = $true)][string]$TxRefSha256,
        [Parameter(Mandatory = $true)][bool]$TestModeConfirmed,
        [Parameter(Mandatory = $true)][string]$ApiVersion,
        [Parameter(Mandatory = $true)][string]$CheckoutEndpoint,
        [Parameter(Mandatory = $true)][string]$CheckoutRequestStartUtc,
        [Parameter(Mandatory = $true)][string]$CheckoutRequestEndUtc,
        [Parameter(Mandatory = $true)][string]$PaymentCompletionObservedUtc,
        [Parameter(Mandatory = $true)][string]$VerifyEndpoint,
        [Parameter(Mandatory = $true)][string]$VerifyRequestStartUtc,
        [Parameter(Mandatory = $true)][string]$VerifyRequestEndUtc,
        [Parameter(Mandatory = $true)][object]$ProviderTimestamps,
        [Parameter(Mandatory = $true)][string]$CheckoutRawResponseSha256,
        [Parameter(Mandatory = $true)][string]$VerifyRawResponseSha256,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$CollectorScriptGitSha,
        [Parameter(Mandatory = $true)][string]$PowerShellVersion,
        [Parameter(Mandatory = $true)][double]$MachineUtcOffsetMinutes,
        [Parameter(Mandatory = $false)][object]$SupplementalReferenceLookup = $null
    )

    $manifest = [ordered]@{
        test_label                     = $TestLabel
        tx_ref_sha256                  = $TxRefSha256
        test_mode_confirmed            = $TestModeConfirmed
        api_version                    = $ApiVersion
        checkout_endpoint               = $CheckoutEndpoint
        checkout_request_start_utc     = $CheckoutRequestStartUtc
        checkout_request_end_utc       = $CheckoutRequestEndUtc
        payment_completion_observed_utc = $PaymentCompletionObservedUtc
        verify_endpoint                 = $VerifyEndpoint
        verify_request_start_utc       = $VerifyRequestStartUtc
        verify_request_end_utc         = $VerifyRequestEndUtc
        provider_timestamps            = $ProviderTimestamps
        checkout_raw_response_sha256   = $CheckoutRawResponseSha256
        verify_raw_response_sha256     = $VerifyRawResponseSha256
        collector_script_git_sha       = $CollectorScriptGitSha
        powershell_version             = $PowerShellVersion
        machine_utc_offset_minutes     = $MachineUtcOffsetMinutes
        supplemental_reference_lookup  = $SupplementalReferenceLookup
    }

    return $manifest
}
