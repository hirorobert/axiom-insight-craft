# Pinned pre-implementation acceptance conditions — webhook mismatch handling

**These are binding acceptance criteria for whenever checkout/payment-authority implementation is eventually authorized. No code is written against them now.** Checkout implementation remains prohibited by this Phase 0 mission's own scope, and separately by `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` (`docs/operations/cfoclose-omega3-checkout/DATA_CONTRACTS.md` §7.4) still being OPEN — see `PHASE0_FLUTTERWAVE_EVIDENCE.md` in this same branch. This document exists so these three conditions cannot be diluted, forgotten, or re-litigated when implementation eventually begins; it supersedes the corresponding pseudocode in `DATA_CONTRACTS.md` §6a/§12.4 as the precise, binding version of the same requirement.

## Why this exists

`DATA_CONTRACTS.md`'s round-8 pseudocode for the `provider_environment`-mismatch branch checks `flagError` (the RPC call's own error channel) before returning HTTP 200, but never validates the actual JSON *shape* of `flagResult` — the successful return value — before treating it as safe to return 200 for. A `flagResult` that is `null`, malformed, or carries an unrecognized `reason` value would currently fall through to 200 under that pseudocode, which is exactly the class of gap this package's own discipline exists to catch before real implementation, not after.

## Condition 1 — `recordProcessingEvent` must return an explicit discriminated result

```ts
type ProcessingEventResult =
  | { success: true }
  | { success: false; error: unknown };
```

Never `void`, never a bare boolean, never a value that silently conflates "wrote successfully" with "an error was logged and swallowed." The caller must be able to branch on `.success` with no ambiguity.

## Condition 2 — the mismatch handler may return HTTP 200 only for an exact, enumerated `flagResult` shape

The handler must accept **only** these three verified shapes of `flagResult` (the successful return value of `flag_webhook_payment_requires_manual_review`, after `flagError` has already been checked and confirmed absent) as grounds for returning HTTP 200:

```
flagResult.flagged === true
  OR
flagResult.flagged === false AND flagResult.reason === 'ALREADY_FLAGGED'
  OR
flagResult.flagged === false AND flagResult.reason === 'INTENT_NOT_PENDING'
```

No other combination of `flagged`/`reason` values is accepted as safe, even if `flagged === false` — for example, `flagged === false` with any reason string other than the two named above must NOT be treated as safe.

## Condition 3 — anything else returns HTTP 500

Every one of the following must produce HTTP 500 (never 200, and the flag RPC must not be treated as having "worked"):

- `flagResult` is `null` or `undefined`.
- `flagResult` fails to parse as JSON, or is not an object.
- `flagResult.flagged` is `true` boolean but arrives alongside anything (defensive — the shape must be exactly what's expected, not "close enough").
- `flagResult.flagged === false` and `flagResult.reason` is missing, `null`, or any string other than exactly `'ALREADY_FLAGGED'` or `'INTENT_NOT_PENDING'` (including a future reason value the RPC might one day be extended to return, until this document and the RPC's own contract are updated together).
- Any other shape not explicitly enumerated in Condition 2.

## Required implementation-time validation code shape (illustrative, not final syntax — to be adapted to the real handler's actual style at implementation time)

```ts
function isSafeFlagResult(flagResult: unknown): boolean {
  if (flagResult === null || typeof flagResult !== 'object') return false;
  const r = flagResult as { flagged?: unknown; reason?: unknown };
  if (r.flagged === true) return true;
  if (r.flagged === false && (r.reason === 'ALREADY_FLAGGED' || r.reason === 'INTENT_NOT_PENDING')) return true;
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

## Required executable tests at implementation time (in addition to every test already specified in `ACCEPTANCE_MATRIX.md` §12 tests 6b/6c/8/8b/11a–11f)

- `flagResult = null` → 500.
- `flagResult = "not json"` / a non-object → 500.
- `flagResult = { flagged: false }` (no `reason` at all) → 500.
- `flagResult = { flagged: false, reason: 'SOMETHING_UNEXPECTED' }` → 500.
- `flagResult = { flagged: false, reason: 'ALREADY_FLAGGED' }` → 200.
- `flagResult = { flagged: false, reason: 'INTENT_NOT_PENDING' }` → 200.
- `flagResult = { flagged: true }` → 200.
- `flagResult = { flagged: true, reason: 'ALREADY_FLAGGED' }` (an internally-inconsistent shape — `flagged: true` should never carry a `reason` at all per the RPC's own contract) → treated as the safe `flagged === true` case per Condition 2's exact rule (checked on `flagged` first), but this exact shape should never actually be produced by a correctly-implemented RPC — flagged here as a documented edge case, not an expected real response.

## Status

**PINNED, not implemented.** No source file in this repository currently contains this logic — the shared webhook handler and `recordProcessingEvent` this describes do not yet exist as real code (`commercial-payment-webhook-sandbox`/`-production`, `_shared/commercialPaymentWebhookHandler.ts`, and the `recordProcessingEvent` helper remain design-only per `IMPLEMENTATION_PLAN.md`'s MUST CHANGE table). This document is the binding specification for when they are written, gated on `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` closing and on explicit authorization to begin checkout implementation.
