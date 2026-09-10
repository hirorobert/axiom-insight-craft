# Ω3-CHECKOUT — Phase 0 Evidence: `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS`

**Status: GATE REMAINS OPEN.** This document records desk-research evidence only. It does NOT close the gate — the gate's own closure criteria (`DATA_CONTRACTS.md` §7.4) require a captured, real Flutterwave sandbox transaction fixture with an independently-recorded submission time, which this pass could not produce (see §3, "Blocked work").

Mission base: this branch (`ci/omega3-phase0-flutterwave-evidence`) forks from `origin/main` at `3768fe8d473ca9a167e18b933cc1ac70776e9dc1`, the exact commit produced by merging PR #13 (the Ω3-CHECKOUT design/audit package, rounds 1–8).

No production Flutterwave credentials, real customer payment, production Supabase access, commercial-offer activation, checkout implementation, licence/entitlement mutation, or deployment occurred in this pass. No secret, authorization header, customer PII, card data, or full sensitive provider payload is committed anywhere in this document or branch.

---

## 1. Objective

Determine whether Flutterwave's `data.created_at` field (returned by `GET /transactions/:id/verify` and by reference lookup) represents:
- checkout/transaction-record creation,
- payment submission,
- successful authorization/capture,
- settlement, or
- an ambiguous instant not cleanly matching any single one of the above,

so that `GATE-FLUTTERWAVE-CREATED-AT-SEMANTICS` (`DATA_CONTRACTS.md` §7.4) can be either closed with evidence, or kept open with a proposed alternative.

## 2. Authorized work performed this pass: Flutterwave documentation research

Public API documentation and SDK source were consulted (no account, no credentials, no network calls against any Flutterwave account — all URLs below are Flutterwave's own public docs/GitHub repos).

### 2.1 — `GET /transactions/:id/verify` (v3 REST API — the endpoint this design's `verifyTransaction`/`verifyTransactionByReference` target)

Source: [Flutterwave API Documentation — Transaction Verification](https://developer.flutterwave.com/v3.0/docs/transaction-verification)

The published example response includes `data.created_at` (e.g. `"2020-03-11T19:22:07.000Z"`), alongside `id`, `status`, `amount`, `currency`, and payment-method details. **The documentation does not define what `created_at` represents** — it appears only as an example value with no accompanying description distinguishing record-creation time from payment-completion time. No other timestamp field appears in the documented response shape for this endpoint.

### 2.2 — Node SDK transaction schema (same v3 API surface, independently-maintained reference)

Source: [Flutterwave/Node-v3 — transactions.md](https://github.com/Flutterwave/Node-v3/blob/master/documentation/transactions.md)

The sample response shows two `created_at` fields at different nesting levels:
- `data.created_at`: `"2020-07-15T14:31:16.000Z"` (the transaction object itself)
- `data.customer.created_at`: `"2020-07-15T14:31:15.000Z"` (the nested customer object)

**Observation (this pass's own analysis, not a Flutterwave-documented claim):** the customer record's `created_at` precedes the transaction's `created_at` by one second in this sample — consistent with an ordinary "customer row created, then transaction row created moments later" sequence, the pattern a **record-creation** timestamp would produce. It is equally consistent with "customer created at checkout initiation, transaction created at payment completion, one second apart" — a single sample cannot distinguish these. **This observation is suggestive, not proof**, and is recorded here as raw reasoning, not as a claim this pass treats as settled.

No field in this documented schema is named or described as "completed_at," "captured_at," "authorized_at," or equivalent. The only status-adjacent field is `status` itself (e.g. `"successful"`), with no separate timestamp for when that status was reached.

### 2.3 — Newer webhook documentation (`charge.completed`, apparently a v4-era payload shape)

Source: [Flutterwave — Webhooks](https://developer.flutterwave.com/docs/webhooks)

This page's example `charge.completed` payload uses a different shape than the v3 `verif-hash` model this design is built on (a root-level `webhook_id`/`timestamp` envelope, and `created_datetime` — not `created_at` — inside the `data` object and again nested under a `payment_method` object). **This is very likely a different, newer API version than the one this design targets** (the design's Gate A is built around `verif-hash` header verification, a v3-era mechanism), so this is background context, not directly-applicable evidence for the v3 field this gate is about. It is recorded here because it independently confirms the same pattern across Flutterwave's API surface: the field is consistently named/associated with **creation**, never with completion/capture/authorization, and no such completion-specific timestamp field could be found anywhere in Flutterwave's public documentation, across either API generation, in this pass's research.

### 2.4 — Summary of documentation research

**What is confirmed:** Flutterwave's own public documentation, across the v3 REST API, its official Node SDK reference, and even the newer (likely v4) webhook documentation, never defines `created_at`/`created_datetime` as a payment-completion, capture, authorization, or settlement timestamp. The field's name, its consistent presence at both record-creation-shaped objects (customer, transaction) in the same sample payloads, and the complete absence of any alternative "completion time" field anywhere in the documentation, are all consistent with — but do not, on documentation alone, *prove* — record-creation semantics.

**What remains unconfirmed:** documentation naming a field is not the same as proving its real-world behavior (this is the exact distinction `DATA_CONTRACTS.md` §7.4 already draws). It remains possible that Flutterwave's real implementation sets this field at payment completion despite the generic name, or that its behavior differs between "immediate" and "delayed" checkout completions in a way documentation doesn't surface. **Closing the gate requires the sandbox transaction comparison below, which this pass could not produce.**

## 3. Blocked work: sandbox transaction evidence (mission items 2, "at least two sandbox transactions")

**This pass has no Flutterwave sandbox account, no sandbox API keys, and no browser session authenticated to any Flutterwave dashboard for this project.** The mission's own authorized-work list permits "disposable Flutterwave SANDBOX probing," but performing it requires credentials this environment does not have and cannot obtain on its own — this is a capability gap, not a policy decision. Fabricating or guessing at transaction data would violate this entire package's own first principle (never assert unverified provider behavior as fact), so none is fabricated here.

**What is needed to unblock this:** either (a) a project maintainer with Flutterwave sandbox dashboard access runs the two required test transactions per the exact protocol in `SANDBOX_TEST_PROTOCOL.md` (this branch) and shares back the resulting **sanitized** JSON (protocol below specifies exactly what to redact), or (b) sandbox API keys are made available through a secure channel outside chat (never pasted directly into this conversation) for a session with the appropriate tool access to run the two calls itself.

See `SANDBOX_TEST_PROTOCOL.md` in this same branch for the exact, step-by-step protocol — what to click, what to record independently, and how to sanitize before sharing.

## 4. Decision (per mission instructions)

Per the mission's own decision rule: **evidence remains insufficient, so the gate stays OPEN.** No closure is asserted. No reinterpretation of `data.created_at` is proposed as a substitute for real evidence.

**Working hypothesis for if/when sandbox evidence becomes available (not a proposed alternative rule — a prediction to be tested, discarded if wrong):** the balance of documentation evidence in §2 leans toward `created_at` being a record-creation timestamp, not a payment-completion timestamp. If the sandbox comparison in §3 confirms this (i.e., `created_at` matches checkout-creation time, not the later payment-submission/completion time, especially in test case B's deliberately-delayed scenario), this design's expiry comparison (`DATA_CONTRACTS.md` §7.0/§7.4) would need to be redesigned around a different field — Flutterwave's transaction `status`-transition evidence, a webhook-delivery timestamp (itself provider-side, so it would need its own semantics check), or a settlement-specific field if one exists in the real sandbox response body (not found in documentation, but sandbox responses sometimes carry fields absent from published docs). **No such redesign is proposed as final here** — per the mission's own instruction, this pass stops before proposing an alternative until the actual evidence is in hand, since proposing a specific alternative field without evidence would itself be exactly the kind of un-evidenced assumption this gate exists to prevent.

## 5. Next steps

1. A maintainer with Flutterwave sandbox access runs `SANDBOX_TEST_PROTOCOL.md`'s two test transactions and returns the sanitized output (or shares sandbox credentials through a secure, non-chat channel for a future session to run them).
2. On receipt, this evidence is added to this same document (or a follow-up commit on this branch), the SHA-256 hashes of the original unredacted captures are recorded, and the comparison in `DATA_CONTRACTS.md` §7.4's exact closure criteria is performed.
3. Only then is the gate's CLOSED/OPEN decision finalized, with a named sign-off, per §7.4's criterion 3.
4. Item 4 of the mission's authorized-work list (a disposable Postgres/migration-replay harness) is deferred to a follow-up pass — it is orthogonal to closing this specific gate and was not started here, so as to keep this evidence-only commit narrowly scoped to the gate this mission names as its objective.
