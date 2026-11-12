# Ready for Reporting V3 — acceptance contract (rfr-acceptance/1)

Specification: `READY_FOR_REPORTING_V3.md`. Executable fixtures: `scripts/acceptance/rfr-v3/cases.mjs`.
Repository inspected: `f36636771bf9c907084c74adb9516043d77eccbc`.

## 1. Three categories of evidence. None stands in for another.

| Category | Command | What a pass proves | What it does not prove |
|---|---|---|---|
| **RUNNER_SELF_CHECK** | `node scripts/acceptance/rfr-v3/run.mjs --self-check` | The fixtures balance, name their sources, and agree with the reference model (the V3 rules written as code). Sabotaging any defended rule in the model makes a named fixture fail (§6). | Anything about CFOClose, its database or QuickBooks. |
| **IMPLEMENTATION_TEST** | `node scripts/acceptance/rfr-v3/run.mjs --implementation <adapter.mjs>` | The implementation behind the adapter produces the expected findings, scope states, proposals, balances and finalization result for every case and mutation, and passes each database contract it runs. | Live QuickBooks behaviour. Hosted behaviour, unless the adapter targets the hosted system and says so in `meta`. |
| **LIVE_SANDBOX_PROOF** | `node scripts/acceptance/rfr-v3/run.mjs --sandbox <manifest.json>` | The connector's per-account output equals an independent QuickBooks export of the same sandbox company, period and basis. | Production; any company other than the one named; anything about readiness rules. |

Every output line and the JSON report (`report.<category>.json`) carry the category. A release note may cite a
category only for what that category proves. Fixtures with `status: "draft"` have open `freeze_checks` (printed by
the self-check) and may not be cited as frozen.

## 2. Interfaces

### 2.1 Case input (selected fields; see `cases.mjs` for every field)

`period` (start, end, currency, exponent) · `tb` (validated, accounts: closing, signed minor units, debit positive) ·
`ledger` (snapshot, accounts: opening, entries: id, date, account, amount, ref, links) or `null` ·
`gl_dependent_scopes` · `required_scopes` · `population` · `banks[]` (ledger_key, status, statements with pages,
rows and printed balances, outstanding items with the evidence that clears them, match window) · `deposit` ·
`opening_bridge` (basis, lines with approved amount, accounts, level, classification and evidence) ·
`entry_support` · `obe_reconstruction` · `cutoff` (search window, sources, items) · `double_charge` ·
`correction_verification` (effect, anchor, later snapshot postings) · `reporting_adjustments` ·
`apply_proposals` with `approvals` · `evidence` (kind, facts, extraction) · `evidence_uses` · `citations` ·
`freshness`.

### 2.2 Result an implementation must return

```
{ draft_eligible, evidence_upload_allowed,
  findings: [{ rule, outcome: confirmed|suspected|evidence_missing|incomplete|pass, scope, resolved_by? }],
  scopes: { <scope>: READY|HELD|... },
  proposals: [{ id, lines: [{ account, amount }] }],
  corrections: [{ id, state, adjustment_applied, residual }],
  applied_adjustments: [id], balances: { <account>: minor }, refusals: [{ action, code }],
  finalization: { held, reasons: [sorted codes] } }
```

Rule ids and scope ids are the contract's (§4). An implementation that uses other internal names maps them in its
adapter; it may not change what a case expects.

### 2.3 Adapter

```js
export const meta = { kind: "implementation", name: "...", target_commit: "<sha>", target: "local-postgres|staging|hosted" };
export async function evaluate(caseInputs) { /* load inputs into the implementation, run it, read back the result */ }
export async function runContract(id) { /* C1–C4, C7 on PostgreSQL; return { pass, detail } */ }
```

The runner refuses an adapter that is, or imports, the reference model. Contracts without `runContract` report
`NOT_RUN`; they are never counted as passed.

### 2.4 Sandbox manifest

`environment` ("sandbox" only), `realm_sha256`, `period_start`, `period_end`, `accounting_method`, `operator`,
`pulled_at`, `connector_file`, `independent_export_file`. Both files are CSV with `account_id, currency,
opening_minor, debit_minor, credit_minor, closing_minor, entry_count`. The independent export is produced in
QuickBooks itself (report export by a person), not by the connector.

## 3. Fixtures

Amounts TZS. "Held" means finalization is refused for the fixture's required scopes.

| Id | Origin | Inputs and sources | Expected finding | Scopes | User sees | Permitted correction | Resulting balances | Final. |
|---|---|---|---|---|---|---|---|---|
| **E1** | EWMA | CRDB TZS row 08/06/2026, credit 100,000,000.00, ref AA25247CKBBX, balance 119,209,092.89; V02 fixed deposit 200,000,000.00; TB v2 1030 "CRDB USD 0252241325200" 119,601,778.84, 1032 nil | DEPOSIT_MOVEMENT pass (payout evidenced, into CRDB TZS); DEPOSIT_HISTORY_INCOMPLETE (100,000,000.00 unexplained); BANK_ACCOUNT_NOT_IN_LEDGER (CRDB TZS) | deposits HELD; cash:CRDB-TZS HELD | payout found; upload deposit certificates/confirmation; choose the ledger account for CRDB TZS | none; refusals: restate prior year, recognise a second deposit asset; E1-M1: presenting the same balance as deposit and cash is refused (EVIDENCE_USED_TWICE) | unchanged: 1030 119,601,778.84; 1032 0 | held |
| **E2** (pilot) | EWMA amounts, constructed GL and documents | NMB 40102300487 row 02/07/2025 cheque 001593, 33,518,793.00, payee Enduimet Rangers Association; V02 Note 13 payable bill 003/2024.2025 33,518,793.00; ML Q5; TB v2 5607 Food ration 138,798,548.00, A/P nil | LEDGER_TIEOUT pass; OPENING_DIFFERENCE_EXPLAINED (mapping, opening journal); OPENING_PAYABLE_CHARGED_TO_EXPENSE confirmed, resolved by the approved correction | payables, opening:payables-food, ledger READY | expense lowered by 33,518,793.00; opening payable settled; cash unchanged | (1) Dr OBE / Cr Payable 33,518,793.00; (2) Dr Payable / Cr Food ration 33,518,793.00; two-person approval | 5607 105,279,755.00; payable 0; OBE −271,838,585.30 (from −305,357,378.30); 1020 unchanged; cheque 001593 posted once; no adjustment touches cash | not held |
| E2-M1/M2/M3 | | no voucher / approver = proposer / no opening journal | suspected, no proposal / APPROVAL_AUTHORITY refusal / OPENING_DIFFERENCE_UNCLASSIFIED | payables HELD | | none | unchanged | held |
| **E2-REAL** | EWMA (held evidence today) | bank row, V02 note; no GL, voucher, confirmation, opening journal | LEDGER_REQUIRED; OPENING_NOT_COMPARED; suspected double charge | payables, opening HELD; draft eligible | "may have been charged twice … upload GL, voucher, payee confirmation" | none | unchanged | held |
| **E2-L1** | constructed QBO journal | QBO-JE-881 Dr OBE / Cr 5607 33,518,793.00 linked to bill 003 | CORRECTION_VERIFIED_IN_SOURCE | payables READY | | adjustment retired | 5607 105,279,755.00 once | not held |
| **E2-L2** | | linked journal for 20,000,000.00 | partial; residual OBE +13,518,793.00 / 5607 −13,518,793.00 | HELD | "QuickBooks corrects 20,000,000.00 of 33,518,793.00" | propose the residual or complete in source | 5607 118,798,548.00 (adjustment suspended, no double count) | held |
| **E2-L3** | | journal then reversal | corrected_then_reversed; nothing reinstated silently | HELD | | reviewer decision | 5607 138,798,548.00 | held |
| **E2-L4** | | same snapshot imported twice | one correction, verified | READY | | | 5607 105,279,755.00 | not held |
| **E2-L5** | | unrelated refund Dr 1020 / Cr 5607 33,518,793.00, no link | not_corrected_in_source; adjustment still applies | READY | | | 5607 71,760,962.00; OBE −271,838,585.30 | not held |
| **E3** | EWMA | TB v2 OBE Cr 305,357,378.30; AJ1 Cr 119,601,778.84, AJ2 Cr 122,000,000.00, AJ3 Dr 94,817,865.98, AJ4 Dr 663,394,698.75 | OBE_ARITHMETIC pass (Cr 821,968,164.19 reproduced); OBE_CONTENT_UNVERIFIED | opening:equity HELD | "reproduced the figure; have not seen the entries; upload opening journal and ledger detail" | none | unchanged | held |
| **E4** | EWMA | NMB 40102300487 pages 8, 38–40 of 40 missing, last row 26/06/2026 122,311,359.72; ledger 1020 65,772,218.34; Jambo statement ends 29/01/2025, ledger 1025 11,560,070.41; CRDB TZS without ledger account | RUNNING_BALANCE_BREAK; STATEMENT_PAGES_MISSING; SUPPLIED_PAGES_MATCHED pass but account held; STATEMENT_COVERAGE_GAP (Jambo); BANK_ACCOUNT_NOT_IN_LEDGER | three cash scopes HELD | named pages and statements to upload | none | unchanged | held |
| **S1** | synthetic | INV-7781 dated 14/07/2026, GRN 552 24/06/2026, 4,250,000.00; payments listing and invoice register to 14/08/2026 | CUTOFF_OMITTED_LIABILITY confirmed, resolved; clean bank reconciliation noted as not a completeness test | completeness READY | accrue at 30 June | Dr 5300 / Cr 2200 4,250,000.00 | 5300 16,250,000.00; 2200 −4,250,000.00 | not held |
| S1-M1/M2 | | evidence removed / GRN missing | CUTOFF_SEARCH_INCOMPLETE (incomplete) / receipt date unevidenced | HELD | | | | held |
| **S2** | synthetic | cheque 000777 1,500,000.00 issued 28/06, presented 03/07/2026; bank 10,000,000.00; TB 8,500,000.00 | TIMING_ITEM_CLEARED; CASH_TIES_TO_TB | READY | bank − cheque = TB | none | unchanged | not held |
| S2-M1 | | no subsequent statement | TIMING_ITEM_UNSUPPORTED with targeted request | HELD | | | | held |
| **S3** | synthetic | accumulated surplus Cr 12,000,000.00 = prior FINAL at account level | OPENING_AGREES | READY | | | | not held |
| **S4** | synthetic | suspense 1999: +2,000,000.00 and −2,000,000.00, no support, balance 0 | ENTRY_UNSUPPORTED ×2 | HELD | "ends at zero, entries unsupported" | none | | held |
| S4-M1 | | both entries supported | ENTRIES_SUPPORTED | READY | | | | not held |
| S7 / S8 | synthetic | no GL / GL ≠ TB | LEDGER_REQUIRED / LEDGER_TIEOUT_FAILED, LEDGER_NOT_RELIED; draft still eligible | dependent scopes HELD | | | | held |
| S9 | synthetic | same file twice; overlapping file disagrees | duplicate ignored; STATEMENT_OVERLAP_CONFLICT | HELD | | | | held |
| S10 | synthetic | reviewer classifies a difference as timing with no evidence | OPENING_CLASSIFICATION_UNEVIDENCED; refusal APPROVAL_IS_NOT_EVIDENCE | HELD | | | | held |
| S11 | synthetic | rule cites an unverified IFRS for SMEs paragraph | CITATION_UNVERIFIED | rule_pack HELD | | | | held |
| S12 | synthetic | QuickBooks cannot be re-read at finalization | — | | | | | held: SOURCE_FRESHNESS_UNDETERMINED; M1 re-read equal → not held |
| FM1–FM5 | synthetic / constructed | spec §14 | | | | | | held |

Source register and constructed items are listed per case in `cases.mjs` (`sources`, `constructed`,
`freeze_checks`). Open freeze checks at this commit: E1 (CRDB TZS account number and statement period end; V02
note line), E2 (replace the constructed GL; confirm the bill's supplier is the cheque payee), E4 (page-8 amount:
the bank workpaper note says net debits 7,059,664.92 while adjacent transcribed rows imply 12,786,950.80).

## 4. Database and live contracts (IMPLEMENTATION_TEST / LIVE_SANDBOX_PROOF only)

| Id | Category | Requirement |
|---|---|---|
| C1 | database | A manifest input change commits before FINAL: FINAL refused `RFR_MANIFEST_STALE`; no FINAL row, no issuance. |
| C2 | database | FINAL commits before the change: FINAL and its stored manifest byte-identical afterwards; the next version shows the change. |
| C3 | database | FINAL at REPEATABLE READ or SERIALIZABLE is refused PT412 before any write. |
| C4 | database | Catalogue check: every function that writes a manifest input takes `_fs_scope_lock` first. |
| C5 | live sandbox | QuickBooks GeneralLedger response reproduces an independent QuickBooks export per account (`--sandbox`). |
| C6 | live sandbox | Transaction and line identifiers are stable across an edit and re-pull; a deleted transaction disappears. |
| C7 | database | Retiring or replacing evidence bound by a FINAL keeps the bound bytes retrievable. |

C1 and C2 use two held sessions, as `scripts/db-proof/publicationAuthority.mjs` does for replacement versus seal.

## 5. Reporting rules

- Report the category, the commit or environment, and the count: "IMPLEMENTATION_TEST at <sha>: 37/37 cases, C1–C4
  and C7 run and passed". Never "acceptance passed".
- A draft fixture's pass is reported as draft.
- LIVE_SANDBOX_PROOF names the sandbox company (by realm hash) and period; it is never extended to production.

## 6. Self-check of the runner itself

At this commit `--self-check` passes 37 of 37 rows (25 cases, 11 mutations, META). Each of these deliberate
sabotages of the reference model was run and made the named fixture fail:

| Sabotage | Fails |
|---|---|
| net-zero suspense passes | S4 |
| AI-extracted evidence accepted | FM4 |
| first candidate taken when matching | FM2 |
| GL fingerprint change ignored at finalization | FM3 |
| unlinked same-effect journal retires the adjustment | FM5 |
| per-bank population confirmation ignored | FM1 |
| no cut-off search treated as complete | S1-M1 |
| missing statement pages ignored | E4 |
