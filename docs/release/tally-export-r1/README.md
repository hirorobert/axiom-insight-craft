# Tally (TallyPrime) trial-balance export support, release record r1

**Status: authored and unit-tested against SYNTHETIC fixtures only. No real Tally export exists in this repository.
Acceptance against a real Tanzanian TallyPrime Trial Balance export (Excel and XML) is still required before this
adapter is relied on.** Nothing here is deployed; no migration, no schema change, no function deploy.

The owner chose the cheap route: read Tally's own export files in the shared trial-balance reader
(`supabase/functions/_shared/tbIngestion.ts`, `tbSource.ts`), as a detected, strict adapter in the style of the
QuickBooks Desktop adapter. There is no local sync agent against Tally's `localhost:9000` gateway.

## 1. What Tally's own documentation establishes (read 2026-11-03)

Only pages on `help.tallysolutions.com` were used. Third-party repositories, blogs and tools were not used as
evidence.

| # | Source (help.tallysolutions.com) | What it establishes |
|---|---|---|
| S1 | [Trial Balance (TallyPrime)](https://help.tallysolutions.com/tally-prime/accounting-financial-reports-tally/trial-balance-tally/) | The report shows Debit and Credit; group-wise by default; **F5** switches to ledger-wise; **Alt+F5** detailed; F12 "Expand all levels in Detailed format" expands every group, including those with "Group behaves like a Sub-ledger" = Yes. By default Sundry Debtors / Sundry Creditors behave as sub-ledgers (they are NOT expanded unless configured). F12 "Show Opening Balance" puts opening and closing side by side. A "Difference in opening balances" line appears when openings do not balance. Closing stock is not shown. |
| S2 | [Trial Balance (Tally.ERP 9)](https://help.tallysolutions.com/article/Tally.ERP9/Reports/Display_Financial_Statements/Display_Trial_Balance.htm) | Same report structure in the earlier product: F5 Ledger-wise / Grouped, F1 Detailed, "Expand all levels in Detailed Format?", Shift+Enter to open a group, sub-ledger behaviour of Sundry Creditors. |
| S3 | [Groups in TallyPrime](https://help.tallysolutions.com/groups-in-tallyprime/) | Groups nest ("Under: Primary or any other predefined group"). "Group behaves like a sub-ledger" hides the group's ledgers. **"Nett Debit/Credit Balances for Reporting"** is a per-group option: "display the net balance, either debit or credit, whichever is higher, in the report" — the worked example is exactly the Trial Balance. So a group line may show gross debit and credit totals OR a single net figure, and this differs per group. Predefined groups cannot be deleted; renaming them is discouraged. |
| S4 | [Pre-Defined Groups (Tally.ERP 9 6.6)](https://help.tallysolutions.com/docs/te9rel66/Creating_Masters/Accounts_Info/p.htm) | The 28 predefined groups (15 primary, 13 sub-groups) and each sub-group's parent. The adapter's reserved-group list is this table verbatim. |
| S5 | [Ledgers in TallyPrime](https://help.tallysolutions.com/ledgers-in-tallyprime/) | Every ledger is created **Under** a group (mandatory). Predefined ledgers: **Cash** and **Profit & Loss A/c**. |
| S6 | [Case Study I — XML Request and Response Formats](https://help.tallysolutions.com/article/DeveloperReference/integration-capabilities/case_study_1.htm) | The Trial Balance report exported as XML (`SVEXPORTFORMAT = $$SysName:XML`, `EXPLODEFLAG = Yes`) is an `ENVELOPE` whose body is a flat sequence of `DSPACCNAME`/`DSPDISPNAME` (the name) and `DSPACCINFO` with `DSPCLDRAMT`/`DSPCLDRAMTA` (closing debit) and `DSPCLCRAMT`/`DSPCLCRAMTA` (closing credit). In the documented sample the credit closing amount is written `100000.00` and the debit closing amount `-100000.00`: **debit negative, credit positive, the unused side empty.** No element distinguishes a group line from a ledger line. Dates in import samples are `20080402` (`YYYYMMDD`) and `02-Apr-2008`. |
| S7 | [Understanding Tally XML tags](https://help.tallysolutions.com/understanding-tally-xml-tags/) | `ENVELOPE` → `HEADER` + `BODY`; `STATICVARIABLES` elements start with `SV`; date examples `<SVFROMDATE TYPE="Date">1-Apr-2008</SVFROMDATE>` and `31-Mar-2009` (`d-Mon-yyyy`). |
| S8 | [XML message format](https://help.tallysolutions.com/article/DeveloperReference/integration-capabilities/xml_message_format.htm) | Generic request/response envelope templates; a response `HEADER` carries `STATUS`. Nothing report-specific. |
| S9 | [Export data (TallyPrime)](https://help.tallysolutions.com/data-management/export-data-in-tally/) | Export formats: ASCII (.txt), Excel (.xlsx), HTML, JPEG, PDF, **XML (.xml)**, JSON. A single report is exported with Ctrl+E / Alt+E, with per-report "Report Details" and "Export Settings" that "might vary depending on the document selected" (not enumerated). Option "Export base currency symbol along with the amount". |
| S10 | [Export FAQ (TallyPrime)](https://help.tallysolutions.com/export-data-faq/) | Excel files open after export; for XML only the folder opens. "Export closing balance as opening balance" is XML-only. A "Restricted (ASCII)" vs "Default (All Languages)" encoding choice exists; in XML "the rupee symbol appears as question mark". |
| S11 | [General configuration (Tally.ERP 9 6.6)](https://help.tallysolutions.com/docs/te9rel66/Maintaining_Company_Data/F12_Config/f12_general.htm) | Configurable "Character to use for decimals", "Separator to use for thousands", "Show amount in millions" (Yes = millions grouping, No = **lakhs** grouping), negative sign placement **`(-)`** before or after the currency symbol, short date format default `dd-mm-yy`. |
| S12 | [Exporting Reports (Tally.ERP 9 6.0)](https://help.tallysolutions.com/article/te9rel60/Data_Management/DM_Export_Data.htm) | Export Report screen: Language (Default (All Languages)), Format, Export Location, Output File Name, "Open Exported Folder"; the report's own configuration applies before export. |
| S13 | [Financial Statements export (TallyPrime 7.1+)](https://help.tallysolutions.com/prepare-financial-statements/) | Alt+E > Financial Statements writes a multi-sheet smart template (CY/PY Trial Balance sheets with C1/C2/C3 classification columns) for the Indian Schedule III add-on; it is a different product path and is **not** what this adapter reads. |

## 2. Where the documentation is silent, and the reading chosen

Tally's help describes the report and the export menu, but shows the exported **Excel grid only as screenshots**. The
cell-by-cell layout (title rows, header labels, indentation of ledgers under groups, the "Grand Total" label, how
numbers are written) is therefore NOT documented in text. The adapter takes the strictest reading at every silent
point, and each is listed here so that acceptance against a real export can confirm or refute it:

| Silent point | Reading taken (strict) | Consequence if a real export differs |
|---|---|---|
| Title block text | A Tally export is recognised only when, above the header, one cell is exactly "Trial Balance" and one cell is a Tally period line `d-Mon-yyyy to d-Mon-yyyy` (S7's date style, joined by "to"). | The file is not detected and is read by the generic path as before (groups refused as codeless amount rows / imbalance). Nothing is guessed. |
| Header labels | The name column is headed exactly "Particulars"; amounts are either "Debit" and "Credit" columns, or one "Closing Balance" column whose cells carry a `Dr`/`Cr` suffix. A two-row header ("Particulars" + "Closing Balance" over "Debit" / "Credit") is also accepted. There is no account-code column (Tally ledgers have none; S5). | Not detected → generic path. |
| How a ledger is shown under its group | By **indentation**: leading spaces in the Particulars cell. A row is a group when the next substantive row is indented deeper than it; otherwise it is a leaf. | If a real export carries indentation only as a cell style (not as characters), every row is at depth 0, so every group line is a depth-0 leaf and the file is **refused** with the reason named (never summed twice). |
| Which leaf rows are ledgers | Every ledger is Under a group (S5), so a **depth-0 leaf is a group whose ledgers are not in the file** (condensed view, or a sub-ledger group, S1/S3) and is refused — with one exception: the predefined ledger "Profit & Loss A/c", which sits directly under Primary (S5). A leaf at any depth whose name is one of the 28 predefined groups (S4) is refused ("Group behaves like a sub-ledger", S1/S3). | Refusal, never a guess. User-defined groups that behave as sub-ledgers at depth ≥ 1 cannot be told from ledgers; this residual risk is caught only when it breaks a parent subtotal or the Grand Total. |
| What a group line's amount means | Either the gross debit and credit totals of all ledgers beneath it, or the net of them on one side ("Nett Debit/Credit Balances for Reporting", S3) — decided per group, exactly, with no tolerance. Anything else is refused as a total-row mismatch. | A mismatch refuses the file; the message names the group row and both readings. |
| Grand Total | Tally prints a Grand Total; the adapter **requires** exactly one "Grand Total" row, as the last substantive row, equal to the exact sum of the ledger rows (or, when groups are reported net, to the exact sum of the top-level lines, which is the same figure when the structure checks pass). A Tally-detected file without a Grand Total is refused. | Refusal. |
| Number format | Indian lakh grouping (`1,00,000.00`), international grouping (`100,000.00`) and plain digits are read; decimal point is `.`; a leading `-` or Tally's `(-)` (S11) is negative; a `Dr`/`Cr` suffix is read only in the single "Closing Balance" column. These extensions apply **only inside the detected Tally adapter**, never to the generic path. A configured decimal comma (S11) is not supported here (a confirmed layout profile remains the way to declare European formats). | Unreadable amounts are refused with the row named. |
| Difference in opening balances | A row named "Difference in opening balances" (S1) is refused as an imbalance; Tally's own guidance is to fix the ledgers' opening balances first. | Refusal. |
| Opening + closing side by side | Two Debit and two Credit columns are ambiguous and refused by the existing rule (export closing balances only). | Refusal. |
| XML group vs ledger | S6 documents no marker; the XML adapter reads the file only as a **ledger-wise** export (every line a ledger). A line whose name is a predefined group (S4) proves the file is group-wise or exploded and the file is refused. User-defined group lines in an exploded XML cannot be detected. | Refusal where detectable; the residual risk is stated in §4. |
| XML encoding | Strict UTF-8 (with or without BOM), the same rule as CSV. UTF-16 and other encodings are refused with the existing message. | Refusal. |
| XML amount signs | As S6: a closing debit is written negative or empty, a closing credit positive or empty. A positive debit or negative credit is refused (it contradicts the only documented sample). | Refusal. |

## 3. What is supported, what is refused

Supported, when positively detected (the detection is recorded in the read's `columns` / `detected` record, like the
QuickBooks Desktop adapter records its unlabelled name column):

- **Excel / CSV grid** (`.xlsx`, `.xls`, `.csv`): title block (company, "Trial Balance", period line), "Particulars" with
  "Debit"/"Credit" or with "Closing Balance" + `Dr`/`Cr`, group lines with indented ledger lines (any depth), a Grand
  Total. Group lines are recognised and excluded exactly once; each is checked against its own ledgers; the Grand Total
  is checked against the ledgers. Ledger-wise exports (F5: a flat list and a Grand Total) are read as plain ledgers.
- **XML** (`.xml`): the `ENVELOPE` of the Trial Balance report with `DSPACCNAME`/`DSPACCINFO` pairs (S6), read as a
  ledger-wise export. Sign convention as S6. The browser's file picker now also accepts `.xml`; the server reads an
  `.xml` only when it is this exact Tally shape and refuses any other XML.
- Codeless ledgers get the reader's existing name-based identity, so a repeated ledger name is refused exactly as
  today (`DUPLICATE_ACCOUNT_NAME`).

Refused (blocking finding, nothing repaired, nothing inferred):

| Situation | Finding |
|---|---|
| A group line whose amount is neither the gross nor the net of its ledgers | `TOTAL_ROW_MISMATCH` (message names the group row and both readings) |
| Grand Total absent, or not equal to the ledgers | `UNSUPPORTED_LAYOUT` / `TOTAL_ROW_MISMATCH` |
| A group line without its ledgers (condensed view, sub-ledger group, flattened indentation), inconsistent indentation | `UNSUPPORTED_LAYOUT` (message says to export Detailed with all levels expanded, or Ledger-wise) |
| "Difference in opening balances" present | `TRIAL_BALANCE_IMBALANCE` |
| Closing Balance without `Dr`/`Cr`; XML debit positive / credit negative | `MALFORMED_NUMERIC_VALUE` (Tally-specific message) |
| XML that is not the Trial Balance envelope shape, or contains predefined group lines | `UNSUPPORTED_FORMAT` / `UNSUPPORTED_LAYOUT` |
| Repeated ledger names; debits ≠ credits; amounts with more decimals than the currency | the existing findings, unchanged |

No new finding code was introduced, so `public.tb_finding_rule` (migration `20261118100000`) and its mirror
`_shared/tbFindingDecisions.ts` are untouched and no migration is needed.

## 4. What is unverified

- **Everything in §2** is a reading of silent documentation. The fixtures under
  `src/lib/ingestion/__fixtures__/tally/` were written by hand from S1–S12; they are labelled synthetic and are not
  evidence of what TallyPrime writes.
- Whether TallyPrime's Excel export writes indentation as leading spaces (the adapter's structural signal) or as a cell
  style. If the latter, real detailed exports will be refused (safely) and the structural signal must be revisited.
- Whether the real header is one row or two, whether the Grand Total label is exactly "Grand Total", and whether
  numbers are written as text with separators or as numeric cells.
- Whether the UI's "Export as XML" of the Trial Balance screen produces exactly S6's shape (S6 documents the HTTP
  response; the export file is expected to be the same rendering).
- A user-defined group that behaves as a sub-ledger (S3) at depth ≥ 1 in an Excel export, and any user-defined group
  line in an exploded XML export, cannot be distinguished from a ledger by the adapter. In Excel the parent subtotal
  and Grand Total checks catch most such cases; in XML there is no such check.
- Tanzanian specifics: whether firms export in TZS with lakh or million grouping, and whether the period line uses
  the `d-Mon-yyyy` style in a Tanzanian locale.

**Acceptance against a real Tanzanian Tally export is required** before this adapter is presented as supported: one
group-wise detailed export (Excel), one ledger-wise export (Excel), one XML export, each with its Tally screen
totals, read through `readTrialBalanceSource` with the outcome recorded here.

## 5. What was built, and the evidence (local, Windows, Bun 1.3.14, 2026-11-03)

| Piece | Where |
|---|---|
| Grid adapter: detection, Tally amount grammar, structural pass (groups, ledgers, Grand Total), hooks in the main pass | `supabase/functions/_shared/tbIngestion.ts` (`detectTallyGrid`, `parseTallyAmount`, `analyseTallyRows`; version `tb-ingest-3.3.0`) |
| XML reader: strict tokenizer for the documented envelope, rows for the same core | `supabase/functions/_shared/tallyXmlExport.ts`; entry in `tbSource.ts` (`detectSourceFormat` → `"xml"`, same byte and table gates; a layout never applies to XML) |
| `.xml` accepted by the upload policy and the browser picker (server stays the authority: any non-Tally XML is refused) | `_shared/uploadPolicy.ts` and its browser mirror (`tb-upload-policy-4`), `src/lib/ingestion/uploadFlow.ts`, `trialBalanceManagement.ts`, the two file inputs, their pinned copy tests |
| Synthetic fixtures | `src/lib/ingestion/__fixtures__/tally/` (README states they are hand-written) and `scripts/dev/make-tally-fixture.mjs` |
| Tests | `src/lib/ingestion/tallyExport.test.ts` (40 tests: happy paths for the detailed grid, the two-row-header workbook, the ledger-wise and Dr/Cr exports and the XML; group-subtotal mismatch; nested parents; net-reported groups; duplicate ledgers; a ledger named like a total; Grand Total missing/wrong; sub-ledger and condensed groups; indentation faults; flattened indentation; period line; precision; amount grammar; XML sign, group, shape, entity, encoding and layout refusals; the corpus never detected; a title-less "Particulars" file reads generically) |

Rule: no new finding code. The adapter's refusals reuse `TOTAL_ROW_MISMATCH`, `UNSUPPORTED_LAYOUT`, `MALFORMED_NUMERIC_VALUE`,
`TRIAL_BALANCE_IMBALANCE`, `PERIOD_MISMATCH`, `UNSUPPORTED_FORMAT` and `ENCODING_NOT_UTF8` with Tally-specific
messages, so `public.tb_finding_rule` and `_shared/tbFindingDecisions.ts` are untouched. The generic unknown-format
message was kept byte-identical because the characterization corpus pins it.

Local gate:

| Step | Result |
|---|---|
| `bun install --frozen-lockfile` | OK (554 packages) |
| `bunx tsc --noEmit -p tsconfig.app.json` | exit 0 |
| `tsc` over `_shared/tbIngestion.ts`, `tbSource.ts`, `tallyXmlExport.ts`, `layoutProfile.ts` (strict, scratch tsconfig; CI runs `deno check` on these and Deno is not installed here) | exit 0 |
| `bun run lint` | exit 0 (181 pre-existing warnings, 0 errors; `supabase/functions` is outside the lint config) |
| Ingestion and upload-policy suites (29 files incl. `ingestCharacterization.test.ts`, `quickbooksDesktopExport.test.ts`, `layout*.test.ts`, `uploadPolicy.test.ts`, `FirstUpload.test.ts`, `tbJourneySix.test.ts`) + `databaseInert.test.ts` | 29 files / 503 tests passed; 2 files / 52 tests passed |
| **Characterization corpus** (`ingestCharacterization.test.ts`, every pinned digest) | unchanged — passes |
| `bun run build` | built in 35.8 s, exit 0 |
| Full `bun run test` | not run here (known Windows-environment failures: git-base lookups, 5 s timeouts); Linux CI is the authority |

## 6. Charter references

- P1/R1 provenance: the detection and every excluded group line are recorded in the read's `columns` and lineage.
- R2 / §11.1: integer minor units, exact equality, no tolerance, no rounding; `(-)` and `Dr`/`Cr` are sign
  conventions read only inside the detected adapter.
- G1 import integrity: debits = credits and no duplicate identities are still enforced by the unchanged core.
- R14 (connectors): not applicable — this is a file reader; no connection to Tally is made.
