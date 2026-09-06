# SAFF Ω∞ Ω2-GR1 — HOSTILE CERTIFICATION REPAIR REPORT

- **Rejected candidate:** `9cf271a8d9b732880ff0d1d0b51e9fa0b448a69f`
- **Codex verdict on rejected candidate:** REJECT — BLOCKER 2, HIGH 1, MEDIUM 0, LOW 0, PRODUCTION UNCHANGED
- **Repair branch:** `omega2-commercial-engine-20260905-hardened` (fast-forwarded onto the repair commit below; parent is the rejected candidate itself — a surgical child, not a new lineage)
- **Repair candidate SHA:** resolve with `git log -1 --format=%H -- docs/operations/OMEGA2_GR1_CERTIFICATION_REPAIR_REPORT.md` — this document is committed in the same commit it describes, so it cannot hardcode its own hash in advance (same convention as `OMEGA2_LOVABLE_PRODUCTION_HANDOFF.md`)
- **Date:** 2026-09-05
- **Author:** SALIO CONNECT (mdcmclimited@gmail.com)

> **Scope discipline:** this is a SURGICAL repair of exactly the three
> Codex-demonstrated findings below. No redesign of the global commerce
> model, no change to Plan != Price, no change to entitlement semantics,
> no Stripe implementation, no invoice/receipt subsystem, no deploy, no
> push, no migration applied, no Lovable action taken.

---

## §A — The Three Findings, and What Was Wrong

### Finding 1 (BLOCKER) — Money Authority Exactness

`supabase/functions/_shared/payments/money.ts`'s `moneyFromProviderDecimal()`
combined `frac.padEnd(exponent, '0')` with `.slice(0, exponent)`. `padEnd`
does nothing to a string already longer than `exponent`; the subsequent
`.slice` then silently discarded any excess digits without checking they
were zero. USD `"1.239"` (exponent 2): `frac = "239"`, `padEnd(2,'0')`
leaves it `"239"` unchanged, `.slice(0,2)` → `"23"` → `123n` — accepted,
when the correct behavior is outright rejection. The same file also
defaulted an unrecognized currency's exponent to `2` via `?? 2` instead of
failing closed, and performed no explicit negative-amount rejection.

### Finding 2 (BLOCKER) — Flutterwave Gate B Reference Requirement

`supabase/functions/_shared/payments/providers/flutterwave.ts`'s
`verifyTransaction()` contained:
```ts
if (rawTxRef && rawTxRef !== saffRef) { /* reject */ }
...
saffReference: rawTxRef || saffRef,
```
The mismatch check only ran when `rawTxRef` was truthy — a missing/empty
`tx_ref` in Flutterwave's own verify response skipped it entirely — and
the fallback then substituted SAFF's own locally-expected reference for
whatever Flutterwave had (or hadn't) actually reported. A provider
response that said nothing about the reference would still "verify."

### Finding 3 (HIGH) — Immutable Webhook Receipt Model Contradiction

`payment_webhook_receipts` (in
`supabase/migrations/20260905200000_omega2_commercial_payments.sql`)
carried a `BEFORE UPDATE OR DELETE` trigger that unconditionally raised an
exception, while `commercial-payment-webhook/index.ts` inserted a
`PENDING` row and then called `.update({ processing_result, signature_valid })`
against that same row multiple times through the handler. Every one of
those updates would fail with the Iron Dome exception the moment a real
webhook arrived — the table and the function that wrote to it disagreed
about whether the table was mutable. A secondary defect in the same code
path: receipt-insert failure was caught and treated as non-fatal
("Receipt record failure is non-fatal — continue processing"), allowing
processing (and potentially a licence grant) to continue with no durable
provider evidence at all.

---

## §B — Repair 1: Money Authority Exactness

Both `moneyFromProviderDecimal()` copies —
[`supabase/functions/_shared/payments/money.ts`](../../supabase/functions/_shared/payments/money.ts)
and [`src/lib/commercial/payments/money.ts`](../../src/lib/commercial/payments/money.ts)
— were rewritten with the same logic:

1. A strict shape regex (`/^\d+(\.\d+)?$/`) run against the trimmed,
   comma-stripped input rejects negative signs, scientific notation,
   `NaN`/`Infinity` string forms, and any non-numeric garbage outright.
2. `parseCurrencyExponent()` (edge copy) now returns `null` — never a
   silent default of `2` — for any currency not in `SUPPORTED_CURRENCIES`.
   `moneyFromProviderDecimal` fails closed immediately when the lookup
   returns `null`.
3. If the fractional part is longer than the currency's exponent, the
   EXCESS digits (`frac.slice(exponent)`) must match `/^0*$/` — all zero —
   or the amount is rejected outright. Only when the excess is entirely
   zero is the fractional part truncated to the exponent's width. No
   floating-point arithmetic, `parseFloat`, or rounding is used anywhere
   in this path — only string slicing feeding an exact `BigInt()` call.

Traced by hand against every example in the Ω2-GR1 mission's truth table
before writing tests, then proven by 47 executed hostile tests (27 against
the exact edge-function file, 20 new additions to the existing frontend
`money.test.ts`) — see §H.

| Input | Currency | Before this repair | After this repair |
|---|---|---|---|
| `"1"` | USD | 100 | 100 (unchanged) |
| `"1.2"` | USD | 120 | 120 (unchanged) |
| `"1.23"` | USD | 123 | 123 (unchanged) |
| `"1.230"` | USD | 123 | 123 (unchanged — extra digit is zero) |
| `"1.239"` | USD | **123 (WRONG — silently truncated)** | **null / INVALID** |
| `"1.231"` | USD | **123 (WRONG)** | **null / INVALID** |
| `"0.001"` | USD | **0 (WRONG)** | **null / INVALID** |
| `"-1.23"` | USD | **-123 (WRONG — no sign rejection)** | **null / INVALID** |
| `"1000"` | TZS | 1000 | 1000 (unchanged) |
| `"1000.0"` | TZS | 1000 | 1000 (unchanged) |
| `"1000.00"` | TZS | 1000 | 1000 (unchanged) |
| `"1000.1"` | TZS | null (already correct) | null (unchanged) |
| `"1.23"` | `"XYZ"` (unsupported) | **123 via silent exponent=2 default (WRONG)** | **null / INVALID** |

---

## §C — Repair 2: Flutterwave Gate B Reference Requirement

`verifyTransaction()` in
[`supabase/functions/_shared/payments/providers/flutterwave.ts`](../../supabase/functions/_shared/payments/providers/flutterwave.ts)
now:

1. Reads `data.tx_ref` with a strict `typeof === 'string'` guard (so
   `String(undefined)`/`String(null)` can never masquerade as a real
   reference), then trims it.
2. Checks the reference FIRST, before currency or amount: an empty
   `rawTxRef` returns `VERIFICATION_FAILED` with reason `REFERENCE_MISSING`
   — unconditionally, with no truthy-guard bypass.
3. A non-empty but non-matching `rawTxRef` returns `REFERENCE_MISMATCH`.
4. Only once `rawTxRef === saffRef` is proven does the function continue
   to currency, then amount, verification.
5. The returned `NormalizedTransaction.saffReference` is set to `rawTxRef`
   directly — never `rawTxRef || saffRef`. There is no code path left in
   which the local `saffRef` parameter is substituted for what the
   provider actually reported.

Nine executed hostile tests cover every combination in the mission's
outcome table — see §H.

---

## §D — Repair 3: Immutable Webhook Evidence Model

`supabase/migrations/20260905200000_omega2_commercial_payments.sql` §8
was rewritten from one table to two, both immutable by construction:

**`payment_webhook_receipts`** — pure OBSERVATION. Columns: `id, provider,
received_at, signature_present, payload_hash, provider_event_id,
saff_reference, correlation_id`. `signature_valid` and `processing_result`
were REMOVED from this table entirely — there is no longer any column on
it that a processing step could plausibly need to update. Its
`BEFORE UPDATE OR DELETE` trigger is unchanged and still unconditionally
rejects both operations; it no longer contradicts anything, because
nothing in the codebase attempts an UPDATE against it (verified in §D.1).

**`payment_webhook_processing_events`** (new) — append-only OUTCOME log.
Columns: `id, receipt_id (FK → payment_webhook_receipts, CASCADE),
provider, signature_valid, processing_result (same CHECK enum, minus
`PENDING`, plus `REFERENCE_MISSING`), provider_transaction_id,
saff_reference, payment_event_id (FK → payment_events, SET NULL),
correlation_id, created_at`. Guarded by its own independent
`BEFORE UPDATE OR DELETE` trigger. One row is inserted per processing
ATTEMPT — Gate A rejection, Gate B rejection, successful commit, or error
— never mutated afterward. A retry of the same receipt inserts an
ADDITIONAL row; history is never rewritten.

**Deliberate idempotency-boundary decision — neither table has a unique
constraint on an attacker-influenceable column** (`saff_reference`,
`provider_event_id`). Both are visible to an end user before Gate A ever
authenticates anything (an attacker can read `saff_reference` off the
`/billing/payment/return?ref=...` URL). A unique constraint on either
value would let a forged, unsigned, first delivery permanently claim that
slot and block or corrupt the genuine later delivery. The actual
commercial idempotency guarantee — never granting a licence twice for the
same real payment — is untouched by this repair and continues to live
where it always correctly lived: `commit_verified_commercial_payment()`'s
`idempotency_key` uniqueness on `payment_events`, derived from
Flutterwave's OWN Gate-B-verified `provider_transaction_id`, which an
attacker cannot forge without also forging a valid Flutterwave API
response.

**§D.1 — Fail-closed receipt persistence.**
`commercial-payment-webhook/index.ts` was rewritten so that a failed
receipt insert (`receiptErr || !receiptRow`) returns HTTP 500 immediately
— before Gate A, before Gate B, before any commit attempt. This replaces
the rejected candidate's "Receipt record failure is non-fatal — continue
processing" behavior. Returning 500 (rather than silently swallowing the
error) both honors "NO DURABLE PROVIDER EVIDENCE => NO LICENCE GRANT" and
invites Flutterwave's own retry — which is safe, because a retried
delivery simply records a second, equally valid, uniquely-keyed-by-`id`
receipt row.

Processing-outcome insert failures (into
`payment_webhook_processing_events`) are logged but are NOT treated as
fatal — the durable-evidence invariant is specifically about the RECEIPT
(what arrived), not about the forensic log of what SAFF subsequently did
with it; `commit_verified_commercial_payment()` remains the sole,
independently idempotent authority for licence grants regardless of
whether this secondary logging insert succeeds.

Twelve executed tests — nine static source-text checks against the actual
migration and Edge Function files, three behavioral — prove this model;
see §H.

---

## §E — Schema Contract Recheck

Every Ω2 SQL mutation site was re-read against the CURRENT candidate
schema (not memory) for NOT NULL/defaults/column names/types/FKs/CHECK/
unique constraints/append-only triggers/RLS/grants:

| Table | Checked against | Result |
|---|---|---|
| `payment_webhook_receipts` | Its own `CREATE TABLE`, immediately above the webhook function's insert call | Insert supplies exactly `provider, signature_present, payload_hash, provider_event_id, saff_reference, correlation_id` — matches every non-defaulted column. No UPDATE anywhere in the codebase targets this table (§D.1, proven in `webhookEvidenceModel.test.ts`). |
| `payment_webhook_processing_events` (new) | Its own `CREATE TABLE` | Every `recordProcessingEvent()` call site supplies `receipt_id, provider, signature_valid, processing_result, provider_transaction_id, saff_reference, payment_event_id, correlation_id` — matches. `processing_result` values used by the function (`INVALID_SIGNATURE`, `ERROR`, `REFERENCE_MISSING`, `REFERENCE_MISMATCH`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `VERIFICATION_FAILED`, `REPLAY`, `PROCESSED`) are all present in the CHECK enum — verified by regex in `webhookEvidenceModel.test.ts`. |
| `payment_events` | `commit_verified_commercial_payment()`'s own `INSERT` (unchanged by this repair) | No column referenced by this repair's changes. Unaffected. |
| `payment_checkout_intents` | Webhook function's `.select(...)` column list (unchanged) | Unaffected by this repair. |
| `commercial_licences` | Unaffected by this repair (Ω2-G already fixed `source` + prior-licence closeout). | No change. |
| `billing_audit_events` | Unaffected by this repair (Ω2-G already fixed the column-name mismatch). | No change. |
| `commercial_catalog_audit_events` | Unaffected by this repair. | No change. |
| `commercial_offers` | Unaffected by this repair. | No change. |

No source operation in this repair references a column that does not
exist in the migration it targets.

---

## §F — Preserved PASS Areas (none regressed)

GLOBAL PRODUCT NEUTRALITY, PLAN != PRICE, COMMERCIAL OFFER AUTHORITY,
MARKET != JURISDICTION, CHECKOUT AUTHORITY, PROVIDER ROUTING, ATOMIC
PAYMENT COMMIT, FREE_TO_PAID, RPC/UI CONTRACTS, IDEMPOTENCY, RLS, UNKNOWN
SEMANTICS, PAYMENT RETURN, SETTLEMENT ORTHOGONALITY, ACCOUNTING
ORTHOGONALITY — none of these areas were touched by this repair.
`globalCommerceModel.test.ts` (33 tests, all against the same migration
file this repair also edited) was re-executed in full and still passes,
proving the offer model, market vocabulary, checkout-intent snapshot
behavior, and settlement-orthogonality guarantees are unchanged by the
webhook-evidence rewrite. `routing.test.ts` (9 tests) and
`atomicCommit.test.ts` (9 tests) likewise pass unchanged.

---

## §G — Stripe Readiness and Receipt Readiness (reported truthfully)

**Stripe readiness: `PLAUSIBLE_BUT_UNPROVEN`.** Unchanged from Ω2-G. This
repair did not touch `routing.ts`, `PaymentProviderCapabilities`, or the
provider enum. No executable, provider-independent contract test proving
Stripe integration without core schema change was added or attempted —
doing so would require actually building a Stripe adapter, which is
explicitly out of scope. This is NOT a blocker for GR1 and is not falsely
upgraded to `PROVEN`.

**Receipt readiness: `LIMITED` (improved from the rejected candidate, but
still not `READY` in the invoice-subsystem sense).** The immutable
`payment_webhook_receipts`/`payment_webhook_processing_events` pair now
durably preserves, per delivery: provider, payload hash, whether a
signature was present, the claimed SAFF reference and provider event id,
and — per processing outcome — the verified provider transaction id, the
resolved SAFF reference, and a link to the resulting `payment_events` row
when one exists. Combined with `payment_events` (unchanged by this
repair), the facts needed for a FUTURE receipt already exist: SAFF
reference, billing customer (via the checkout intent → payment event
chain), plan, offer, `amount_minor`, currency, verified payment
timestamp, provider, provider transaction id, and licence period/status.
What does NOT exist, and is explicitly not built here: any
customer-facing receipt/invoice document, any tax-invoice numbering
scheme, or any statutory-compliance formatting. A provider payment
receipt is not a statutory tax invoice. `LIMITED` is the honest label —
the evidence is now durable and forensically coherent, but no receipt
document exists yet.

---

## §H — Test Execution (all executed for real, not asserted)

Ran with `npx vitest run` on Windows, this session, this repair candidate:

| Suite | Tests | What it proves |
|---|---|---|
| `edgeMoney.test.ts` (new) | 27 | The ACTUAL edge-function `money.ts` file's exactness truth table (USD/TZS), hostile inputs (NaN/Infinity/scientific-notation/malformed/unsupported-currency), imported directly — no Deno-only code in this file, so it is safe to exercise from Vitest exactly like `certifiedTbSource.test.ts` already does for another `_shared` module. |
| `money.test.ts` (+20 new tests, 51 total) | 51 | The frontend `money.ts` mirror's identical exactness truth table and hostile inputs. |
| `edgeFlutterwaveGateB.test.ts` (new) | 9 | The ACTUAL `flutterwave.ts` `verifyTransaction()`, with `fetch` and a minimal `Deno` global stubbed: missing/null/empty/whitespace/wrong/correct tx_ref, correct-tx_ref-with-wrong-amount, correct-tx_ref-with-wrong-currency, correct-tx_ref-with-non-success-status (verified true at Gate B, then independently refused by `authoriseCommit` for `NON_SUCCESS`). |
| `webhookEvidenceModel.test.ts` (new) | 12 | Static source-text proof against the actual migration and Edge Function files: `payment_webhook_receipts` has no mutable-looking columns; both tables carry independent append-only triggers; neither has a unique constraint on attacker-influenceable columns; the Edge Function never calls `.update()` against either table; the receipt insert happens before Gate A; a failed receipt insert returns before Gate A/commit; the commit RPC is never reached before the receipt is durably recorded. |
| `globalCommerceModel.test.ts` (unchanged) | 33 | Ω2-G's offer model, market vocabulary, and snapshot guarantees are unaffected. |
| `routing.test.ts` (unchanged) | 9 | Provider routing unaffected. |
| `atomicCommit.test.ts` (unchanged) | 9 | Atomic commit / idempotency unaffected. |
| `webhookSecurity.test.ts`, `paymentSecurity.test.ts`, `checkoutFlow.test.ts` (unchanged) | 27 | Conceptual Iron Dome invariants unaffected. |

**Targeted GR1 tests: 68/68 passing** (27 + 9 + 12 + 20 new; all against
the exact defects Codex demonstrated).
**Full repository suite: 1026/1026 passing** (55 files) — up from 958/958
on the rejected candidate.

---

## §I — Static Verification (typecheck / build / lint / diff-check)

All run for real on this repair candidate, this session:

- `tsc --noEmit -p tsconfig.app.json` — exit 0, zero output. PASS.
- `npm run build` (`vite build`) — succeeded, 2675 modules transformed.
  Only the pre-existing "chunk larger than 500kB" advisory, unrelated to
  this repair. PASS.
- `eslint` on every file touched by this repair — zero errors, zero
  warnings, after removing two invalid `eslint-disable-next-line
  import/first` comments that referenced a rule plugin not configured in
  this project (an authoring mistake caught by running lint for real
  rather than assuming the comment was harmless). A full-repository
  `eslint . --ext .ts,.tsx` run shows 476 pre-existing warnings and 2
  pre-existing errors, all inside OTHER git worktrees
  (`.claude/worktrees/adoring-hamilton-a45fb7`,
  `.claude/worktrees/inspiring-hamilton-e426fd`) unrelated to this repair
  and not part of this candidate's tree. PASS on every tracked file this
  repair changed.
- `git diff --check` — clean (only pre-existing LF/CRLF line-ending
  advisories on files this repair did not touch; zero literal
  whitespace-error or conflict-marker findings). PASS.

---

## §J — Files Changed in This Repair Pass

```
supabase/migrations/20260905200000_omega2_commercial_payments.sql          — §8 rewritten: two-table immutable webhook evidence model (amended in place, CREATED_NOT_APPLIED, never chained)
supabase/functions/_shared/payments/money.ts                               — moneyFromProviderDecimal exactness fix; parseCurrencyExponent fails closed
src/lib/commercial/payments/money.ts                                       — same exactness fix in the frontend mirror
supabase/functions/_shared/payments/providers/flutterwave.ts               — Gate B tx_ref required, no fallback, reference-checked before currency/amount
supabase/functions/commercial-payment-webhook/index.ts                     — rewritten for the two-table model; receipt-insert failure is now fatal
src/lib/commercial/payments/__tests__/edgeMoney.test.ts                    — new: 27 tests against the actual edge-function money.ts
src/lib/commercial/payments/__tests__/money.test.ts                        — +20 exactness/hostile-input tests
src/lib/commercial/payments/__tests__/edgeFlutterwaveGateB.test.ts         — new: 9 tests against the actual flutterwave.ts
src/lib/commercial/payments/__tests__/webhookEvidenceModel.test.ts         — new: 12 static source-text tests against the migration + Edge Function
docs/operations/OMEGA2_FINAL_REPORT.md                                     — §22 correction notice appended (does not rewrite the historical verdict block)
docs/operations/OMEGA2_LOVABLE_PRODUCTION_HANDOFF.md                       — Ω2-GR1 summary added; attack-vector table extended; stale idempotency_key claim corrected; verify-query updated for the new table
docs/operations/OMEGA2_GR1_CERTIFICATION_REPAIR_REPORT.md                  — this report (new)
```

No Ω1 or RLS1 migration file was touched. No file outside the three
defect areas (money, Flutterwave verification, webhook evidence) was
modified for logic reasons — only the two documentation files, for
accuracy.

---

## §K — What Was Deliberately NOT Done

- Stripe was not implemented. `PLAUSIBLE_BUT_UNPROVEN` stands.
- No customer-facing invoice/receipt document or numbering scheme was
  built. `LIMITED` stands, honestly.
- No Payoneer/CRDB settlement integration was added.
- The global-commerce architecture (offers, market vocabulary, provider
  routing) was not redesigned — verified unchanged by re-running
  `globalCommerceModel.test.ts` and `routing.test.ts`.
- "Plan != Price" was not reopened.
- Entitlement semantics were not changed — no defect required it.
- No deploy, no push, no merge, no migration applied, no Lovable action.

---

## §L — Migration Status

`supabase/migrations/20260905200000_omega2_commercial_payments.sql`
remains `CREATED_NOT_APPLIED` and was amended in place (not chained) —
consistent with every prior pass, since it has never been applied to any
database anywhere. This repair changes only its §8 (webhook evidence)
block; every other section is byte-identical to the rejected candidate.

---

## §M — Candidate Ancestry

The repair commit's parent is `9cf271a8d9b732880ff0d1d0b51e9fa0b448a69f`
itself — this is a direct surgical child, not a rebase, not a squash, and
not a new lineage. `git log --oneline` from the repair commit reaches the
rejected candidate as its immediate parent, which in turn reaches
`4fe90d6` (the Ω2-handoff-hardening commit), `bb6432e` (the Ω1/RLS1 merge
into `main`), and the full certified history behind it.

---

## §N — RLS / Security Posture

Unchanged by this repair except for the two new tables, which follow the
exact pattern already established for every other Ω2 forensic table:
`ENABLE ROW LEVEL SECURITY`, a single `SELECT`-only policy gated by
`is_commercial_admin()` (the RLS1-certified SECURITY DEFINER helper,
reused — not reimplemented), `REVOKE ALL ... FROM anon, authenticated`,
`GRANT SELECT ... TO authenticated`, `GRANT ALL ... TO service_role`. No
browser role can read, write, or delete either table directly; only
`service_role` (the Edge Function) writes, and only an authenticated
commercial admin can read.

---

## §O — Accounting Orthogonality

Unaffected. This repair touches only commercial payment-evidence tables
and Edge Functions; no accounting table (`account_mappings`,
`tax_computations`, `period_closing_balances`, or any other) is
referenced anywhere in the changed files.

---

## §P — Idempotency (unchanged, explicitly re-verified)

`commit_verified_commercial_payment()`'s `idempotency_key` uniqueness on
`payment_events` was not modified by this repair. The new webhook-evidence
tables deliberately carry NO uniqueness of their own (§D) — idempotency
protection continues to derive entirely from the Gate-B-verified
`provider_transaction_id`, exactly as it did before this repair.

---

## §Q — UNKNOWN Semantics

Unaffected. `get_effective_entitlement()` was not modified by this
repair; `UNKNOWN != FALSE`, `FREE != PREMIUM` tri-state semantics are
untouched.

---

## §R — Final Status

```
SAFF Ω∞ Ω2-GR1 CERTIFICATION REPAIR —
REJECTED CANDIDATE 9cf271a8d9b732880ff0d1d0b51e9fa0b448a69f —
REPAIR CANDIDATE [resolve via: git log -1 --format=%H -- docs/operations/OMEGA2_GR1_CERTIFICATION_REPAIR_REPORT.md] —
MONEY EXACTNESS PASS —
OVER_PRECISION REJECTION PASS —
FLUTTERWAVE TX_REF REQUIRED PASS —
WEBHOOK RECEIPT IMMUTABILITY PASS —
DURABLE PROVIDER EVIDENCE PASS —
SCHEMA CONTRACTS PASS —
ATOMIC PAYMENT COMMIT PASS —
FREE_TO_PAID PASS —
RLS PASS —
UNKNOWN SEMANTICS PASS —
STRIPE READINESS PLAUSIBLE_BUT_UNPROVEN —
RECEIPT READINESS LIMITED —
BLOCKER 0 —
HIGH 0 —
TARGETED TESTS 68/68 —
FULL TESTS 1026/1026 —
TYPECHECK PASS —
BUILD PASS —
LINT PASS —
DIFF CHECK PASS —
PRODUCTION UNCHANGED —
READY_FOR_CODEX_RECERTIFICATION YES
```
