# R0 implementation-contract corrections (recorded with H2)

Owner-required corrections to the consolidated E1 + S2/E2 design (Amendment 2). They bind the later implementation
contracts. This file records them; it does not authorize H1, E1, S2 or E2. Baseline: `main` `af8a96b`, S1 deployed and fixed.

## 1. Run history: controlled transitions, never edited history
Runs and attempts change state (`running` → `completed` / `failed` / `abandoned`). The contract must not claim that runs
are never edited. Use one of:
- a controlled transition on the run row (only the legal transitions above, each enforced by a trigger, with no other
  column changes after a terminal state), **plus** an append-only event row for every transition; or
- immutable outcome records: the run row is insert-only, and each outcome is a separate insert-only row.

Certifications, invalidations, review decisions and transition events remain append-only.

## 2. Version floors: numeric engine generation
Engine-version floors (the proposed `min_engine_version`) compare a **numeric engine generation** (an integer written by
the handler and recorded on each run), never version strings lexically. `engine_version` stays a display label.

## 3. `tb-amounts/1` validation recomputes relationships
Validation checks the grammar **and** recomputes every relationship from the values themselves:
- `source.difference = debit_total − credit_total`;
- `equation.lhs = assets`;
- `equation.rhs = liabilities + equity + income − expenses`;
- `equation.difference = lhs − rhs`;
- `status = balanced` if and only if `difference = 0`;
- cash relationships, from the C2 definitions (b = debit − credit per cash account; every cash account is classified as an
  asset or a liability, otherwise it is in review and no `tb-amounts/1` is certified):
  - `reported` = Σ b over asset-classified cash accounts;
  - `overdraft` = Σ (−b) over liability-classified cash accounts;
  - `net_position` = Σ b over all cash accounts, so **`net_position = reported − overdraft`** must hold;
  - `credit_balances` = Σ (−b) over cash accounts with b < 0, so it is **≥ 0**;
  - `accounts` equals the number of distinct cash accounts.

Any mismatch is malformed. A grammatically valid document with inconsistent figures is never accepted.

## 4. Lock tests: interacting pairs and known inversions only
Deadlock tests cover only operation pairs that can actually interact (sharing a row, key or advisory lock) and the
specific inversions found in the current code. Not every pair can deadlock, and controls must be realistic:
- `commit_tb_certification`: run → upload, through its trigger;
- `complete_trial_balance_discard`, `restore_trial_balance_upload`, `tbu_sweeper_complete`: operation → upload;
- the review / reprocess advisory key space.

The revised order includes **registration's reservation lock**: `register_trial_balance_upload` locks the reservation
(`FOR UPDATE`) before inserting the upload, and `retire_trial_balance_upload` locks the old upload then the reservation.
The canonical order must place reservations consistently with both, proven on real PostgreSQL.

## Scope notes
- The database processing hold (H1a) is a proposal requiring separate approval; H2 does not depend on it.
- `CONFIRM_ACCOUNT_TREATMENT` (H1b) remains required before E1.
