# Notes, disclosure requirements and movement schedules

Migration `20261019100000_fs_notes_and_schedules.sql`; client `src/lib/notes/notesStatus.ts`; proof
`scripts/db-proof/notesSchedules.mjs` (real PostgreSQL, on database-composed statements).

## Requirements decided by the database
`fs_notes_status(company, year)` reports each STATEMENT, DISCLOSURE, PERIOD and SCHEDULE requirement of the applied pack
edition, with a status and the reason for it. It also states its blockers and a `statusSha256` identity.

| Requirement kind | How it is decided |
|---|---|
| Always-required disclosure | `provided` when the preparer's wording is recorded (`fs_record_disclosure`, verbatim, with source), otherwise `missing` (blocks) |
| Conditional disclosure the data cannot decide (e.g. share capital, 4.12) | `undecided` (blocks) until the preparer records `applicable`/`not_applicable` with a reason (`fs_decide_requirement`); then as above |
| Early-application disclosure | applicable exactly when the edition is applied early (edition policy) — never decided by hand |
| Period (3.10) | a twelve-month period is `satisfied`; a longer or shorter one needs the preparer's disclosure; unknown dates block |
| Statements of financial position / comprehensive income | `composed` when the composition is complete and has no blocker, otherwise `incomplete` (blocks) |
| Statement of changes in equity | `evidence_present` only with valid EQUITY_MOVEMENTS evidence for the year; never from a trial balance |
| Statement of cash flows | `evidence_present` only with a valid TRANSACTION_LEDGER **and** CASH_ACCOUNT_MAP; never from a closing trial balance (reconciled account by account where the statement is generated) |
| Movement schedule (17.31(e), 16.10(e), 18.27(e), 21.14(a)) | applicable when the composed line has a carrying amount at either date; then see below |

## Schedules: validated, then reconciled
**At intake** (`fs_record_schedule`), the server checks every class: exact integer amounts, known movement kinds each at
most once, the sign rule (additions ≥ 0; depreciation, disposals, amortisation, used and reversed ≤ 0) and
opening + movements = closing. Any failure is named and nothing is stored.

**At status time**, the schedule is reconciled to the composed statement:

| Status | Meaning |
|---|---|
| `closing_mismatch` | closing total ≠ the current composed line (blocks, exact difference) |
| `opening_mismatch` | opening total ≠ the composed prior-year line (blocks, exact difference) |
| `reconciled` | both agree |
| `reconciled_opening_unverified` | there is no authoritative comparative: stated, never passed, not blocking |

## Authority and history
- Writes need `prepare_close`, under the rollout and kill switch, in an IFRS for SMEs workspace.
- Every write is idempotent per request (a different payload under the same request is refused).
- Records are append-only; a withdrawal is a new event.
- Reads need workspace access; another workspace reads nothing.
- No wording is ever generated. The words are the preparer's.

## Limits (carried)
- Evidence presence for the statement of changes in equity and the cash-flow statement is read from the existing
  evidence store. The cash-flow reconciliation itself is the existing generator's, not re-derived here.
- Comparative approval, account bridges and restatements are the comparatives increment.
- Sign-off binding to `statusSha256` is the sign-off increment.
