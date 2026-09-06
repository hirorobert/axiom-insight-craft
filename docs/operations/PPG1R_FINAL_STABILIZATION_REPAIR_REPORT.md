# SAFF Ω∞ PPG-1R — Final Pre-Production Stabilization Repair Report

- **Rejected PPG-1:** `e001d727fd2c6929eea2861cc9bbe43315e37895`
- **Certified Ω2-GR1 base:** `843562068c230b11d3bbfec2aa6224ae22160b6a`
- **Branch:** `ppg1r-final-repair` (parented directly from the rejected PPG-1 candidate)
- **Date:** 2026-09-06
- **Author:** SALIO CONNECT (mdcmclimited@gmail.com)

> **Scope discipline:** surgical repair of exactly the Codex findings below.
> No redesign, no deploy, no push, no merge, no Lovable action, no
> migration applied, no SMTP configuration, no production touched. Zero
> diff against every certified Ω2-GR1 payment/commercial executable
> surface — explicitly verified in §K below.

---

## C. Preflight Repair (HIGH-1)

**Codex finding:** `handleProcessAsAuditedAccounts` starts reprocessing
but `certReadiness.refetch()` isn't triggered until terminal/timeout —
old CERTIFIED may remain visible while reprocessing is already underway.

**Root cause confirmed by re-reading PPG-1's own code:** the guard
(`certReadiness.loading`) only reflected "a fetch is currently in
flight." Between "the backend accepted the reprocess" and "the poll
detects a terminal status" (up to 90s), NO fetch was in flight at all —
the certification panel kept showing whatever it showed before the
mutation, untouched, for the entire window.

**Repair — explicit state machine, not a timing heuristic.** New pure
module `src/lib/workspace/certificationRevalidationGuard.ts`:
`reduceCertificationRevalidationGuard(isRevalidating, event) => boolean`,
with events `MUTATION_ACCEPTED` (→ true, immediately), `TERMINAL_CONFIRMED`
(→ false), `TIMEOUT_NO_TERMINAL_CONFIRMED` (→ stays true — never
auto-clears on an unconfirmed timeout), `MUTATION_INITIATION_FAILED` (→
unchanged), `UPLOAD_IDENTITY_CHANGED` (→ false, new upload's own fresh
lifecycle). `computeCertificationReadiness`'s existing `revalidating`
input is now fed `isRevalidatingCertification || certReadiness.loading`,
and the "certified → pending" downgrade added in PPG-1 is unchanged —
only the TRIGGER for entering that downgraded state changed, from "a
fetch is in flight" to "a reprocess was accepted and hasn't been
terminal-confirmed yet."

Wired into BOTH mutation paths identically:
- `handleProcessAsAuditedAccounts` (`PrepareWorkspace.tsx`): dispatches
  `MUTATION_ACCEPTED` the instant the `process-trial-balance` invoke
  succeeds — BEFORE the immediate `certReadiness.refetch()` call, so even
  though that refetch may race ahead of the backend and return the exact
  pre-mutation CERTIFIED row, the guard (not the fetch result) is what
  `computeCertificationReadiness` trusts.
- `AccountReviewPanel`'s Save/Reprocess flow: new `onReprocessingStarted`
  prop, called at the identical point (`reprocessStarted = true`, before
  polling begins) — dispatches the same `MUTATION_ACCEPTED` event via the
  parent's callback. `onReprocessed` now carries a `reason: "terminal" |
  "timeout" | "initiation_failed"` argument so the parent can apply
  `TERMINAL_CONFIRMED` only on a genuine terminal read, never on a
  timeout.

Rapid second invocation: `canInitiateCertificationAffectingMutation(
isRevalidating)` refuses a new `handleProcessAsAuditedAccounts` call while
already revalidating (AccountReviewPanel already had its own
`saving||reprocessing` guard, unchanged). Unmount safety: both
`PrepareWorkspace.tsx` and `AccountReviewPanel.tsx` now track poll
timers in a ref and clear them on unmount; `AccountReviewPanel` also
guards its own local `setReprocessing`/`setSaving` calls with an
`isMountedRef`, while still always calling the parent's callbacks (which
may legitimately outlive this specific child).

## D. Stale-Certification Race Proof

`src/lib/workspace/certificationRevalidationGuard.test.ts` (20 new
tests) proves the exact race end-to-end using
`computeCertificationReadiness` directly:

- **"immediate refetch returns old certified"** — guard flips true via
  `MUTATION_ACCEPTED`, then `computeCertificationReadiness` is called
  with the EXACT SAME pre-mutation `CERTIFIED_ROW` still as
  `authoritative` — verdict is `pending`, never `certified`.
- **slow backend** — 5 simulated polling ticks with no terminal event;
  verdict stays `pending` throughout.
- **terminal success** — `TERMINAL_CONFIRMED` clears the guard; a fresh
  certified read is trusted again.
- **terminal failure (blocked)** — guard clears, the truthful `blocked`
  verdict is shown, never a fake `certified`.
- **timeout** — `TIMEOUT_NO_TERMINAL_CONFIRMED` leaves the guard true;
  verdict stays `pending` even though a read was taken.
- **initiation failure** — guard never enters; the prior genuinely-
  certified state is preserved exactly.
- **rapid second invocation** — `canInitiateCertificationAffectingMutation`
  refuses while already revalidating.
- **replacement upload mid-revalidation** — `UPLOAD_IDENTITY_CHANGED`
  clears the guard immediately for the new upload's own lifecycle.
- **Save/Reprocess account review** — proven to follow the identical
  reducer-event contract as `handleProcessAsAuditedAccounts`, not an
  independently-invented parallel state machine.

**Zero stale-certified window after an accepted mutation** — proven, not
asserted.

---

## E. MAONO Semantic Repair (HIGH-2)

**Codex finding:** MAONO still maps broad `current_assets` to
`expected_ar_inflows` and `current_liabilities` to AP outflows;
`CLASS_LEVEL_APPROXIMATION` disclosure does not make that arithmetic
safe; inventory/prepayment/tax-receivable ambiguity does not fail closed.

**Confirmed, and root-caused precisely.** PPG-1 fixed the one confirmed
defect fixable with existing data (the PAYE/VAT/SDL/WHT double-count) but
otherwise still swept every non-cash `current_assets`/`current_liabilities`
balance into AR/AP, merely disclosing the approximation in prose. Codex
correctly rejected that a disclosure string doesn't make the underlying
arithmetic safe.

**Repair — explicit CashBehavior seam, fail-closed by construction.**
`supabase/functions/_shared/maonoCashflowMath.ts` now defines:
```
CashBehavior = TRADE_RECEIVABLE | TRADE_PAYABLE | STATUTORY_RECEIVABLE
             | STATUTORY_PAYABLE | NON_CASH_CURRENT_ASSET
             | NON_TRADE_CURRENT_LIABILITY | CASH | UNKNOWN
```
`classifyCashBehavior(row, cashState)` is the SOLE place classification
happens. Given the repository-evidence finding (re-confirmed, unchanged
since PPG-1: the live `account_classification` enum has never had a
sub-split below `current_assets`/`current_liabilities`; `account_mappings`
has exactly three tri-state flags, none distinguishing inventory/
prepayment/tax accounts from trade receivables/payables; `line_item` is
free text, not a controlled vocabulary, and using it would reintroduce
the exact heuristic this file's own header already documents removing),
every non-cash current-asset and every current-liability row classifies
as `UNKNOWN` today — no heuristic, no keyword matching, no name/sign
inference was added anywhere.

`assessArAp(bucketed)` is the fail-closed decision point:
- `arState`/`apState` = `"KNOWN"` only when the respective row count is
  literally zero (an empty set is a definite fact, not an evidentiary
  gap) — otherwise `"CANNOT_ASSESS"`.
- `arKnownAmount`/`apKnownAmount` are meaningful only when `KNOWN` —
  always `0` today, honestly (never approximated).

`maono-cashflow/index.ts` calls `assessArAp()` immediately after
bucketing and BEFORE building the 13-week forecast. If either side is
`CANNOT_ASSESS`, the function returns a 409 with `analytical_state:
"CANNOT_ASSESS"` and writes **zero rows** to `cashflow_forecasts` — the
table's `expected_ar_inflows`/`expected_ap_outflows` columns are `NUMERIC
NOT NULL DEFAULT 0` (verified against
`20260711300100_maono_phase_b.sql`; no migration was created or applied
in this pass), so a partial row with a fabricated 0 for an unknown
component is schema-incompatible with honesty — not writing the row at
all is the only schema-compliant way to never fabricate a number, exactly
mirroring the two PRE-EXISTING `CANNOT_ASSESS` early returns already in
this same file (uncertified TB, incomplete cash perimeter).

## F. CANNOT_ASSESS Propagation

Per the mission's "KNOWN + UNKNOWN = UNKNOWN only for the aggregate that
NEEDS the unknown component": the CANNOT_ASSESS response does not
withhold everything — it preserves `known.opening_cash` (fully
determined by the already-complete professional cash tri-state
perimeter) and `known.statutory_this_month` (independently sourced from
`tax_computations`, unrelated to the current-asset/liability
classification gap), while explicitly marking `unassessable.ar`/
`unassessable.ap` with the failing side's unclassified-account count and
the relevant limitation text — never a fabricated AR/AP number for the
failing side.

Frontend: `MaonoDashboard.tsx` only ever reads the `cashflow_forecasts`
TABLE (traced — it never calls the edge function or reads its JSON
response directly), so zero rows written means `cashWeeks = []`.
`CashFlowForecast.tsx`'s empty-state message was corrected from "not
available. Run maono-cashflow to generate." (implies "just click a
button") to an honest statement covering BOTH real causes: not yet
generated, OR account classification does not yet support the forecast.
Static regression tests
(`src/components/maono/CashFlowForecast.test.ts`, 5 tests) prove the
empty-state branch structurally precedes all numeric aggregation/
formatting (`maxAbsValue`, `fmt`/`fmtFull`) — a CANNOT_ASSESS/empty
result can never fall through into a rendered "Tsh 0" or a NaN chart.
`CashWeek`'s numeric fields remain `number` (never `number | null`) by
design — the type contract itself is the guard against a null silently
reaching a formatter.

## G. Tax Double-Count Regression

`excludeScheduledTaxFromCurrentLiabilities()` is unchanged and still
applied on the success path (now against `arAp.apKnownAmount`, always 0
today, but load-bearing again the instant a future classification
authority makes it non-zero). 30 tests in `maonoCashflowMath.test.ts`
re-verify the exact exclusion arithmetic (including the null-is-not-zero
and zero-floor cases) plus 7 new structural tests in
`maonoCashflowFailClosedGate.test.ts` proving the edge function's call
order: bucketing → `assessArAp` → (CANNOT_ASSESS return, before any
insert) or (tax exclusion still applied → forecast built → insert).
**Not regressed.**

---

## H. Auth Finding (§7)

Codex reported `AUTH ERROR UX FAIL` with no defect named. Independent
hostile-shape reconstruction (not an assumption) found and fixed **two
genuine defects**:

1. **Reproduced and fixed — a real crash.**
   `translateAuthError({ message: 12345 })` (or any object whose
   `message` field is a truthy non-string) threw `TypeError:
   ((intermediate value) ?? "").toLowerCase is not a function`. The prior
   `(error?.message ?? "").toLowerCase()` only guards `null`/`undefined`,
   not a wrong-typed truthy value. Fixed with explicit `typeof` checks on
   both `error` itself and `error.message`/`error.status` before use.
   Caught by a new hostile-shape test suite covering: a genuine `Error`
   instance, an `Error` with a `.status` (AuthApiError shape), a raw
   string passed where an object was expected, a number/boolean/array, a
   malformed object with a non-string `message`, an explicit `message:
   null`, and a sweep proving every hostile input still returns a valid
   `{category, message}` shape, never throwing, never an empty message.
2. **Reproduced and fixed — a real gap.** Neither the signup/login submit
   handler nor the resend-confirmation handler had a SYNCHRONOUS
   duplicate-request guard — both relied solely on the submit button's
   `disabled={loading}` attribute, which does not guarantee no second
   invocation reaches the handler before React commits the disabled
   render (a fast double-click, or Enter-key submission racing a click).
   Fixed with an explicit `if (loading) return;` at the top of
   `handleSubmit` and the resend `onClick` handler.

Verified via 20 tests in `translateAuthError.test.ts` (13 pre-existing +
7 new hostile-shape) and 4 new static structural tests in
`Auth.guard.test.ts` proving both synchronous guards exist and precede
their respective `setLoading(true)` calls, and that both the signup and
resend error branches route through `translateAuthError` (login/
password-reset error handling remains out of scope, unchanged from
PPG-1's own stated boundary).

**No raw Supabase/provider text is exposed** (unchanged, re-verified);
**no false success** (verified — every hostile input yields a failure-
shaped `{category, message}`, never a success-looking result); **no
duplicate signup request while submitting** (fixed); **resend failure
never appears successful** (verified — the resend `catch` and error
branches both show failure toasts, never `toast.success`).

`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED` is unchanged and preserved
as infrastructure debt — no SMTP configuration was touched.

## I. CRLF Normalization

`git diff --check 8435620..e001d72` failed on `src/pages/Auth.tsx` with
"trailing whitespace" on every line PPG-1 added. Forensically proven a
TRUE_FALSE_POSITIVE in the PPG-1 report (byte-level: `git cat-file -p
8435620:src/pages/Auth.tsx` shows the STORED blob already contains 573
CRLF sequences — this file was committed with CRLF baked directly into
the git object, violating this repository's `core.autocrlf=true`
convention that every other file follows; `PrepareWorkspace.tsx`'s stored
blob, by contrast, has zero CRLF). Codex's own classification agreed
(`TRUE_FALSE_POSITIVE`) but still required the exact gate to read clean
rather than be waived by exception.

**Repair:** normalized `src/pages/Auth.tsx`'s line endings to LF
(matching the rest of the repository) and trimmed genuine pre-existing
trailing whitespace revealed once every line became part of the diff (a
whitespace-only change — zero semantic content altered, verified via
`git diff --ignore-all-space --ignore-blank-lines` showing ONLY the
intended §C/§H content changes). No `.gitattributes` added, no
`core.whitespace` config changed, no other file mass-normalized.
`git diff --check 8435620..HEAD -- src/pages/Auth.tsx` now returns
**zero output** — a genuine PASS, not a documented exception.

## J. Migration Authority Regression

Unchanged since PPG-1 — re-verified: `git diff --stat` against the
certified base shows only the two already-quarantined `.sql.historical`
renames (35 insertions, the PPG-1 quarantine notices), zero new migration
changes. Ω1 live identity (`20260905093408`), RLS1 live identity
(`20260905141022`), and the sole not-yet-live Ω2 migration
(`20260905200000_omega2_commercial_payments.sql`) are all byte-identical
to the certified base. No blanket `db push`, no historical migration
replay.

## K. Ω2-GR1 Executable Payment Diff

Explicitly re-checked against `843562068c230b11d3bbfec2aa6224ae22160b6a`
for every named path: `supabase/functions/_shared/payments/**`,
`commercial-create-checkout/**`, `commercial-payment-webhook/**`,
`commercial-payment-status/**`, `20260905200000_omega2_commercial_
payments.sql`, and every commercial/checkout/payment frontend authority
file (`src/lib/commercial/payments/**`, `commercialRpc.ts`,
`entitlementContract.ts`, `src/pages/billing/**`,
`src/pages/commercial/**`, `src/components/commercial/**`).

**`git diff --stat` output: empty. Zero bytes changed anywhere in the
certified surface.** `Ω2-GR1 EXECUTABLE PAYMENT DIFF = NO` —
`Ω2_CERTIFICATION_COLLISION` was never triggered; nothing in this repair
required touching certified payment code.

## L. Tests / Gates (all executed for real)

| Gate | Result |
|---|---|
| `certificationRevalidationGuard.test.ts` (new) | 20/20 |
| `maonoCashflowMath.test.ts` (rewritten for HIGH-2) | 30/30 |
| `maonoCashflowFailClosedGate.test.ts` (new) | 7/7 |
| `CashFlowForecast.test.ts` (new) | 5/5 |
| `translateAuthError.test.ts` (13 pre-existing + 7 new hostile-shape) | 20/20 |
| `Auth.guard.test.ts` (new) | 4/4 |
| Commercial suite (unchanged) | 226/226 |
| SAFISHA/pre-flight suite | 51/51 |
| **Full Vitest suite** | **1138/1138** (62 files), up from 1079/1079 on the rejected PPG-1 |
| `tsc --noEmit -p tsconfig.app.json` | Clean, exit 0 |
| `npm run build` | Succeeds (pre-existing chunk-size advisory only) |
| `eslint` (tracked tree, `.claude/**` scratch dirs excluded) | 0 errors, 127 warnings — identical to the PPG-1 baseline, zero new lint issues (one `prefer-const` error introduced mid-repair was caught and fixed before this final count) |
| `node scripts/audit_migrations.mjs` | CLEAN, 111 files, 0 errors, 0 warnings |
| `git diff --check 8435620..HEAD` | **Clean — zero output, no exceptions** |

## M. Production Status

Unchanged — no migration applied, no deploy, no Edge Function deployed,
no Lovable action, no Flutterwave configuration, no admin bootstrap, no
payment performed. Only `git` operations and source edits occurred.

## N. Remaining Infrastructure Debt

Unchanged from PPG-1: `PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED` (no
custom SMTP exists anywhere in this repository; the underlying low-rate-
cap cause remains infrastructure, not source-fixable). No new
infrastructure debt introduced by this pass. The MAONO receivable/
payable classification gap remains registered as
`DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001` (CLAUDE.md §9.1) —
now updated to reflect the fail-closed repair rather than the rejected
approximation; full closure still requires either a new professional
tri-state classification flag (mirroring `is_payroll_account`'s
precedent) or a genuine `account_classification` enum extension — an
explicitly product-owned decision, not built here.

---

## Files Changed in This Pass

```
src/lib/workspace/certificationRevalidationGuard.ts          — new: pure HIGH-1 state machine
src/lib/workspace/certificationRevalidationGuard.test.ts      — new, 20 tests
src/pages/workspace/PrepareWorkspace.tsx                      — wires the reducer; immediate MUTATION_ACCEPTED on accept, not terminal/timeout
src/components/AccountReviewPanel.tsx                         — onReprocessingStarted prop; onReprocessed(reason); unmount-safe timers
supabase/functions/_shared/maonoCashflowMath.ts               — CashBehavior seam; classifyCashBehavior; assessArAp fail-closed gate
supabase/functions/maono-cashflow/index.ts                    — calls assessArAp before forecasting; CANNOT_ASSESS response preserves known facts; zero rows written when unassessable
src/lib/accounting/maonoCashflowMath.test.ts                  — rewritten for the new contract, 30 tests
src/lib/accounting/maonoCashflowFailClosedGate.test.ts        — new, 7 tests
src/components/maono/CashFlowForecast.tsx                     — honest empty-state message
src/components/maono/CashFlowForecast.test.ts                 — new, 5 tests
src/lib/auth/translateAuthError.ts                            — fixed a real TypeError on non-string message; explicit typeof guards
src/lib/auth/translateAuthError.test.ts                       — +7 hostile-shape tests
src/pages/Auth.tsx                                            — synchronous duplicate-request guards (signup + resend); LF line-ending normalization + trailing-whitespace cleanup
src/pages/Auth.guard.test.ts                                  — new, 4 tests
docs/operations/PPG1R_FINAL_STABILIZATION_REPAIR_REPORT.md    — this report (new)
```

No Ω1/RLS1/Ω2 migration touched. No certified Ω2-GR1 payment/commercial
executable file touched (§K).
