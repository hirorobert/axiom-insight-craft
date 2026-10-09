# Reporting r3: cash perimeter scoped to each period's own accounts (DEFECT D-3)

**Defect.** Hosted acceptance, J6. Demo company `659daa94-116c-4803-99f8-157e0bdd4c62`; version 4 not ready.

- The cash perimeter required every company-wide cash-flagged account (`account_mappings.is_cash_account`) to be in
  the cash account map. That list includes 1000 and 1010, earlier test accounts of another year that are in neither
  the FY2025 nor the FY2024 trial balance.
- A map naming only the correct account, 91000, could therefore never establish the perimeter. A map naming 1000 and
  1010 is refused, because they are not in the statements.
- Because the map was then "unused", it was not stored. Version 4 bound 5 of 6 evidence files and stayed blocked:
  `STATEMENT_EVIDENCE_MISSING:smes.set.scf`, `BLOCKING_FINDINGS:1`, `RECONCILIATION_UNMET:1`.

**Correction (frontend only).** A period's cash accounts are now exactly the accounts of that period's authoritative
reporting input (`fs_reporting_input`: its certification with approved adjustments applied) whose reviewed
classification is cash. Each year is scoped separately, and any account code works. Strictness is unchanged:

| Situation | Result |
|---|---|
| A current-period reviewed cash account not in the map | Refused |
| A comparative-period reviewed cash account not in the map | That period's perimeter is not established (warning) |
| A mapped account in neither period's input | Refused by name |
| An account absent from a period | Contributes nothing to that period |
| An account present at nil | Contributes exactly zero, and must still be categorised |
| An input that does not carry its accounts | Refused, never read as "no cash accounts" |

These are also unchanged:
- approved adjustments, which are part of the input;
- the closing-cash and per-account roll-forward rules;
- the server's stale-dependency checks. A later mapping change invalidates the certification and makes signed
  results stale.

The company-wide reader is removed.

- **No database change:** no migration, no Edge Function, no data repair.
- **Existing records untouched:** accounts 1000 and 1010, the certifications and draft versions 1–4 are not changed.

**Proof.**
- `scripts/db-proof/cashPerimeterScope.mjs` (real PostgreSQL, the acceptance fixture files, plus 1000/1010 reviewed as
  cash in FY2023). It shows:
  - the failure reproduced with the company-wide flags;
  - the next version stores and binds the map;
  - readiness has no blocker; the closing-cash and roll-forward rules PASS;
  - every `EXPECTED_TOTALS.csv` row matches;
  - earlier drafts, certifications and 1000/1010 are unchanged;
  - REVIEWED and FINAL succeed, and the export carries the cash-flow figures;
  - a mapping change makes the result stale.
- Unit tests (`cashPerimeter.test.ts`, `cashScope.test.ts`) cover:
  - historical accounts absent from the upload;
  - different codes across years and arbitrary codes;
  - multiple cash accounts;
  - zero balances;
  - a missing or invalid map;
  - a malformed input;
  - mapping changes.

## Hosted steps (Lovable)

| # | Step | Expected |
|---|---|---|
| 1 | **Publish** the frontend at the release commit named in the release package. | The live deployment reports exactly that commit. |
| 2 | Hard-reload the app, signed in as the demo owner. Open Sign-off for FY2025. | Versions 1–4 are listed as DRAFT. |
| 3 | Add **only** `evidence_FY2025_current_cash_account_map.csv` (it was never stored), then press "Save a new report version". | Version 5 is saved. Readiness is "ready", with no blocker. |
| 4 | Read back (SQL editor, read-only): see the SQL below. | One `CASH_ACCOUNT_MAP` batch, and version 5 binds 6 evidence batches including it. |
| 5 | Resume J6–J10 (`ACCEPTANCE_R1_DEMO_SETUP.md`), then export the PDF and CSV. | As specified. |

```sql
SELECT evidence_batch_id, evidence_type, period_role, version FROM public.financial_evidence_batches
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY evidence_type, period_role;
SELECT report_version, cardinality(evidence_batch_ids) AS bound, evidence_batch_ids FROM public.financial_statement_reports
 WHERE report_id = 'fsr-2025-659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY report_version;
```

**Recovery.** Republish the previous main commit (`e338537`; its frontend is identical to the live `0693d93`) if the publish must be undone. No data step is involved. To
stop reporting, use `docs/release/sql/04_deactivate_company.sql` or `05_kill_switch.sql`. Never delete saved versions.
