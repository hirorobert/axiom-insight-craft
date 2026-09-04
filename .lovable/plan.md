# SAFF Release Stage 1 — Apply Phase-6 Tri-State Migration Only

## Pre-execution check (already verified, read-only)

Live `public.account_mappings`:

```text
is_cash_account       NOT NULL  DEFAULT false
is_retained_earnings  NOT NULL  DEFAULT false
is_payroll_account    NOT NULL  DEFAULT false
```

Live `resolve_account_review_batch` is the pre-tri-state version: it still
does `coalesce((v_decision->>'is_cash_account')::boolean, false)` on insert
and `is_cash_account = EXCLUDED.is_cash_account` on conflict — i.e. an
omitted flag is manufactured as FALSE and overwrites existing professional
state. Canonical-main text ("Phase 6", `COALESCE(am.is_cash_account`) is
absent from the live definition.

Pre-conditions match the gate. Proceed.

## Authorized change

Apply exactly one migration, byte-for-byte from the synced canonical mirror:

`supabase/migrations/20260904120000_account_review_flag_preservation.sql`

It does two things and nothing else:
1. Drops NOT NULL and DEFAULT on exactly the three flag columns.
2. `CREATE OR REPLACE` on `resolve_account_review_batch` so that an omitted
   flag inserts NULL on a new row and preserves the current value on an
   existing row, while an explicit true/false is written verbatim.

No other migration, no history repair, no reset, no manual unrelated SQL.

## Post-migration verification

1. Re-read `information_schema.columns` — all three columns NULLABLE = YES,
   DEFAULT = null.
2. Re-read `pg_get_functiondef` — confirm the preservation clauses and that
   actor resolution, role gating, locking, decision logging and
   MARK_NON_REPORTING_ACCOUNT are otherwise unchanged.
3. Tri-state behavioural verification, isolated and non-destructive: run
   inside a single explicit transaction that is ROLLBACK-ed, using a
   synthetic company/upload/member fixture, never a real accounting record.
   Sequence against one account key:
   - seed existing mapping with `is_cash_account = true`
   - submit a decision omitting the key → expect it stays `true`
   - submit `is_cash_account = false` → expect `false`
   - submit `is_cash_account = true` → expect `true`
   - new key with the flag omitted → expect NULL, not false
   Invariant asserted: ABSENT/UNDECIDED != FALSE.
   If the environment cannot run the RPC as an authenticated member inside a
   rollback-safe transaction, report the behavioural check as NOT TESTABLE
   with the exact blocker rather than mutating real records.
4. Confirm no other schema object changed.

## Provenance

The historical identity mismatch is not repaired. The report will state the
identity Lovable records for this application and note that the ~53
historical generated identities remain registered provenance debt.

## MAONO read-only classification (evidence already gathered)

`public.account_classifications` does not exist live.

- `maono-compute/index.ts:319-324` — `.from("account_classifications")`
  then `if (actualErr) throw new Error("Failed to load actuals: " + ...)`.
  A missing relation is a hard function failure, not degradation.
- `maono-cashflow/index.ts:130-138` — same table, error ignored via
  `(accts ?? [])`, so cash/AR/AP silently become 0 rather than
  CANNOT_ASSESS.

Verdict to report: **MAONO_CLASSIFICATION_DEPENDENCY_RELEASE_BLOCKER**
(compute fails outright; cashflow fabricates zeros). Not repaired in this
stage.

## Explicitly out of scope

No Edge Function deploys, no publish, no secret changes, no
`account_classifications` creation, no MAONO defect fixes, no KINGA-TZ
activation, no GitHub modification, no new generated migrations.

## Final report format

Exactly the requested fields, closing with the five-line verdict block.
