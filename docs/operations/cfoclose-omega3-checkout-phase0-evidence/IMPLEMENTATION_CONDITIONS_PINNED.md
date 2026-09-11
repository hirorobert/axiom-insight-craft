# Pinned pre-implementation acceptance conditions — webhook mismatch handling

**These are binding acceptance criteria for whenever checkout/payment-authority implementation is eventually authorized. No code is written against them now.** Checkout implementation remains prohibited by this Phase 0 mission's own scope, and separately by `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` (`docs/operations/cfoclose-omega3-checkout/DATA_CONTRACTS.md` §7.4) still being OPEN — see `PHASE0_FLUTTERWAVE_EVIDENCE.md` in this same branch. This document exists so these conditions cannot be diluted, forgotten, or re-litigated when implementation eventually begins; it supersedes the corresponding pseudocode in `DATA_CONTRACTS.md` §6a/§12.4 as the precise, binding version of the same requirement.

## Why this exists

`DATA_CONTRACTS.md`'s round-8 pseudocode for the `provider_environment`-mismatch branch checks `flagError` (the RPC call's own error channel) before returning HTTP 200, but never validates the actual JSON *shape* of `flagResult` — the successful return value — before treating it as safe to return 200 for. A `flagResult` that is `null`, malformed, carries an unrecognized `reason` value, or carries an unexpected EXTRA property alongside an otherwise-valid shape would currently fall through to 200 under that pseudocode, which is exactly the class of gap this package's own discipline exists to catch before real implementation, not after.

**Corrected, this revision — a single, internally consistent, strict discriminated union.** An earlier draft of this document contained its own internal contradiction: Condition 2 said "no other combination... is accepted as safe," while a note under the executable-tests section explicitly walked through `{flagged: true, reason: 'ALREADY_FLAGGED'}` — a shape with an extra, unexpected `reason` property — and called it safe anyway, on the reasoning that `flagged` is "checked first." That reasoning is exactly the loophole a strict contract must close: checking `flagged` first and returning early is precisely how an extra, unvalidated property on an otherwise-plausible object slips through undetected. This document is now unambiguous: the three EXACT shapes below, and only those three, by EXACT key set — never a superset, never a subset with an assumed default.

## Condition 1 — `recordProcessingEvent` must return an explicit discriminated result

```ts
type ProcessingEventResult =
  | { success: true }
  | { success: false; error: unknown };
```

Never `void`, never a bare boolean, never a value that silently conflates "wrote successfully" with "an error was logged and swallowed." The caller must be able to branch on `.success` with no ambiguity.

## Condition 2 — the mismatch handler may return HTTP 200 for exactly three JSON object shapes, and no others

The handler may return HTTP 200 (after `flagError` has already been checked and confirmed absent) **only** when `flagResult` is a plain object whose EXACT key set and value types match one of these three, byte-for-byte in structure — no additional property present, no missing property, no substitute type:

```json
{ "flagged": true }
```
```json
{ "flagged": false, "reason": "ALREADY_FLAGGED" }
```
```json
{ "flagged": false, "reason": "INTENT_NOT_PENDING" }
```

This is a **strict discriminated union**, checked by exact key set, not by checking `flagged` alone and assuming the rest of the shape follows:
- The `{flagged: true}` case has EXACTLY one key. An object with `flagged: true` PLUS any other key (`reason`, or anything else) is REJECTED, not accepted — `flagged: true` never legitimately carries a `reason` in this RPC's real contract, so a `reason` appearing alongside it is evidence of either a bug or a shape this contract has not reviewed, either way unsafe to treat as 200.
- Each `{flagged: false, reason: ...}` case has EXACTLY two keys, and `reason` must be EXACTLY the string `'ALREADY_FLAGGED'` or EXACTLY `'INTENT_NOT_PENDING'` — no other string, no `null`, no non-string value, and no third key alongside them.

## Condition 3 — every other shape returns HTTP 500

The following is the exhaustive list of REJECT cases (HTTP 500, and the flag RPC must never be treated as having "worked"). This list exists so no future implementation can claim a rejected case was "probably fine":

- `flagResult` is `null` or `undefined`.
- `flagResult` is an array (even `[]`, even an array literally containing a valid-looking object).
- `flagResult` is any other non-object (`string`, `number`, `boolean`, or a value that fails to parse as JSON at all).
- `flagResult` is an object with `flagged` key missing entirely.
- `flagResult.flagged` is present but not strictly `true` or `false` (e.g. `1`, `0`, `"true"`, `null`).
- `flagResult.flagged === true` accompanied by a `reason` key (any value, including `null`) or by ANY other additional key beyond `flagged` alone.
- `flagResult.flagged === false` with no `reason` key at all.
- `flagResult.flagged === false` and `reason` is `null`, a non-string, or any string other than exactly `'ALREADY_FLAGGED'` or `'INTENT_NOT_PENDING'` — including a future reason value the RPC might one day be extended to return, until this document and the RPC's own contract are updated together.
- `flagResult.flagged === false` with a valid `reason` PLUS any additional key beyond `flagged`/`reason`.
- Any other shape not exactly one of the three enumerated in Condition 2.

**There is no "checked on `flagged` first, so the rest doesn't matter" shortcut anywhere in this contract.** Every candidate object is checked against its FULL exact key set before being accepted.

## Required implementation-time validation code shape (illustrative, not final syntax — to be adapted to the real handler's actual style at implementation time)

```ts
function isSafeFlagResult(flagResult: unknown): boolean {
  if (flagResult === null || typeof flagResult !== 'object' || Array.isArray(flagResult)) {
    return false;
  }
  const keys = Object.keys(flagResult as Record<string, unknown>).sort();
  const r = flagResult as { flagged?: unknown; reason?: unknown };

  // Exact shape 1: { flagged: true } — exactly one key, no reason, nothing else.
  if (keys.length === 1 && keys[0] === 'flagged' && r.flagged === true) {
    return true;
  }

  // Exact shape 2/3: { flagged: false, reason: 'ALREADY_FLAGGED' | 'INTENT_NOT_PENDING' }
  // — exactly two keys, nothing else.
  if (
    keys.length === 2 &&
    keys[0] === 'flagged' &&
    keys[1] === 'reason' &&
    r.flagged === false &&
    (r.reason === 'ALREADY_FLAGGED' || r.reason === 'INTENT_NOT_PENDING')
  ) {
    return true;
  }

  return false;
}

// ... after recordProcessingEvent succeeds and the flag RPC call returns { data: flagResult, error: flagError } ...
if (flagError) {
  return new Response(JSON.stringify({ error: 'FLAG_RPC_FAILED' }), { status: 500 });
}
if (!isSafeFlagResult(flagResult)) {
  return new Response(JSON.stringify({ error: 'FLAG_RPC_UNEXPECTED_RESULT' }), { status: 500 });
}
return new Response(JSON.stringify({ received: true }), { status: 200 });
```

`Object.keys(...).sort()` plus an exact length+content check is deliberate — it is what makes this an EXACT-key-set check rather than a "does it have at least these keys" check, which is what let the earlier draft's contradiction (an accepted `{flagged: true, reason: 'ALREADY_FLAGGED'}`) go unnoticed.

## Required executable tests at implementation time (in addition to every test already specified in `ACCEPTANCE_MATRIX.md` §12 tests 6b/6c/8/8b/11a–11f)

**Accept (→ 200), exactly these three:**
- `flagResult = { flagged: true }` → 200.
- `flagResult = { flagged: false, reason: 'ALREADY_FLAGGED' }` → 200.
- `flagResult = { flagged: false, reason: 'INTENT_NOT_PENDING' }` → 200.

**Reject (→ 500), exhaustively:**
- `flagResult = null` → 500.
- `flagResult = undefined` → 500.
- `flagResult = []` → 500.
- `flagResult = [{ flagged: true }]` → 500 (an array is never accepted, regardless of contents).
- `flagResult = "flagged:true"` (a string, not an object) → 500.
- `flagResult = 1` → 500.
- `flagResult = {}` (missing `flagged` entirely) → 500.
- `flagResult = { flagged: "true" }` (non-boolean `flagged`) → 500.
- `flagResult = { flagged: 1 }` → 500.
- `flagResult = { flagged: true, reason: 'ALREADY_FLAGGED' }` → 500 (`flagged: true` may never carry a `reason` — this is the exact case the earlier draft incorrectly accepted; this test exists specifically to guard against that regression).
- `flagResult = { flagged: true, extra: 'x' }` → 500 (any additional key alongside `flagged: true` is rejected).
- `flagResult = { flagged: false }` (no `reason` at all) → 500.
- `flagResult = { flagged: false, reason: null }` → 500.
- `flagResult = { flagged: false, reason: 'SOMETHING_UNEXPECTED' }` → 500.
- `flagResult = { flagged: false, reason: 123 }` (non-string `reason`) → 500.
- `flagResult = { flagged: false, reason: 'ALREADY_FLAGGED', extra: 'x' }` → 500 (an otherwise-valid shape plus one additional key is still rejected).

## Executable proof this contract is internally consistent

This exact strict discriminated-union logic (Condition 2/3 above) is mirrored, verbatim in behavior, as a disposable PowerShell function `Test-IsSafeFlagResult` in `tools/FlutterwaveEvidenceLib.ps1`, and every accept/reject case in "Required executable tests" above is run against it in `tools/tests/FlutterwaveEvidenceLib.Tests.ps1` (17 of the 82 total tests in that suite). This mirror makes NO network call and touches NO checkout logic — it exists solely to prove, executably, that this document's own specification is self-consistent (no shape is simultaneously accepted and rejected), which is exactly the property the earlier, corrected draft of this document lacked. It is not itself the real implementation and does not substitute for the real Edge Function code once that is authorized.

## Status

**PINNED, not implemented.** No source file in this repository currently contains this logic — the shared webhook handler and `recordProcessingEvent` this describes do not yet exist as real code (`commercial-payment-webhook-sandbox`/`-production`, `_shared/commercialPaymentWebhookHandler.ts`, and the `recordProcessingEvent` helper remain design-only per `IMPLEMENTATION_PLAN.md`'s MUST CHANGE table). This document is the binding specification for when they are written, gated on `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` closing and on explicit authorization to begin checkout implementation.
