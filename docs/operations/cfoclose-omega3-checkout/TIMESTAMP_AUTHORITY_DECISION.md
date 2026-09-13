# TIMESTAMP_AUTHORITY_DECISION — Flutterwave `data.created_at`

**Decision:** Flutterwave's `data.created_at` field is **telemetry only**. It
is never used to authorize, reject, or delay a payment commit, and it never
gates any part of the checkout implementation this decision accompanies.

## Background

`docs/operations/cfoclose-omega3-checkout/PHASE_BRIEF.md` and
`DATA_CONTRACTS.md` (the Ω3-CHECKOUT design/audit package, 8 rounds of
Codex review, PR #13) named an open question — `GATE-FLUTTERWAVE-CREATED-
AT-SEMANTICS` — asking whether `data.created_at` represents checkout
creation, payment submission, authorization, or settlement. A prior,
narrowly-scoped mission (`ci/omega3-phase0-flutterwave-evidence`, PR #14)
built and hardened a PowerShell evidence collector intended to capture a
real sandbox transaction pair and answer that question empirically. No
sandbox evidence was ever produced — that branch never had Flutterwave
sandbox credentials — and the gate was never closed.

## Decision, per the CFOClose Ω3-CHECKOUT Marshall Plan

The Marshall Plan (final execution charter, canonical main
`3768fe8d473ca9a167e18b933cc1ac70776e9dc1`) resolves this without waiting
for that evidence:

> The Flutterwave `data.created_at` field is classified as **telemetry,
> never payment authority**. No further sandbox timestamp-research work
> blocks Ω3 implementation.

This is possible because the actual live payment-authority chain
(`supabase/functions/commercial-payment-webhook/index.ts`,
`_shared/payments/authority.ts`'s `authoriseCommit()`, and
`commit_verified_commercial_payment()`) never reads `data.created_at` at
all. A payment commits only when all of the following independently hold:

1. Webhook signature verified (`verif-hash`, Gate A).
2. Independent server-side `GET /transactions/{id}/verify` call succeeds
   (Gate B) — never the browser's own `?status=` callback parameter.
3. Provider status normalizes to `SUCCEEDED`.
4. Provider transaction ID is present and, via `payment_events.idempotency_
   key`, effectively unique per commit.
5. `tx_ref` returned by the independent verify call exactly matches the
   checkout intent's own reference.
6. Amount and currency exactly match the checkout intent's snapshotted,
   server-resolved offer economics (`expected_amount_minor`,
   `currency_code`) — bigint comparison, never float.
7. The checkout intent has not already resolved to a terminal state
   (`commit_verified_commercial_payment`'s own `FOR UPDATE` row lock and
   status check).

None of these seven checks reference `data.created_at`, `checkout_opened_
utc`, or any other provider-side or locally-observed timestamp as an
authorization input. `payment_checkout_intents.expires_at` (the local
hosted-link expiry) controls only whether a **new** provider checkout page
may still be opened for a given intent — per this same implementation, an
already-completed, independently-verified provider charge is never
invalidated by that local expiry.

## What this decision does and does not authorize

- It resolves the OPEN QUESTION the gate asked (what `created_at` means)
  by making the answer irrelevant to correctness, not by asserting a
  specific semantic interpretation of the field.
- It does not close `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` as originally
  scoped in `DATA_CONTRACTS.md` §7.4 — that gate asked a research
  question about provider behavior, and this document does not answer it.
  It records instead that the gate is **non-blocking**: nothing in the
  live or newly-implemented checkout system depends on its answer.
- It does not authorize using `data.created_at` for anything in the
  future without a fresh, explicit decision — if a future feature (e.g. a
  settlement-lag report) wants to use it, that is a new design decision,
  not an extension of this one.
- PR #14 (`ci/omega3-phase0-flutterwave-evidence`) remains open as an
  audit archive of the evidence-collector hardening work performed there.
  It is not merged and is superseded as a delivery path by this Ω3-CHECKOUT
  implementation, per the Marshall Plan §1.

## Status

**RESOLVED — non-blocking.** No further sandbox timestamp-research work is
required before, during, or after this implementation.
