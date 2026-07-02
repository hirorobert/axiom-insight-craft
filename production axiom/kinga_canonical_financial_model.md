# Kinga Canonical Financial Model
Version: 1.1
Date: 2026-07-02
Status: Active (corrected from v1.0)

---

## SECTION 1: CANONICAL FINANCIAL RECORDS (live table schema)

`canonical_financial_records` is the transaction ingestion store. It records individual financial events (sales, purchases) ingested from EFDMS or other sources. It is NOT an account-balance table. Account balances live in `trial_balance_uploads.processing_result` and `account_mappings`.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | uuid | NOT NULL | PK |
| batch_id | uuid | NOT NULL | FK → ingestion_batches.id |
| company_id | uuid | NOT NULL | FK → companies.id (denormalized for RLS) |
| record_type | text | NOT NULL | CHECK: 'sale' \| 'purchase' |
| canonical_date | date | NOT NULL | Date of financial event |
| period_year | integer | NOT NULL | Must match EXTRACT(YEAR FROM canonical_date) |
| period_month | integer | NOT NULL | Must match EXTRACT(MONTH FROM canonical_date) |
| amount_tzs | numeric | NOT NULL | Total transaction amount — always positive |
| vat_amount_tzs | numeric | NOT NULL | VAT component — zero or positive |
| counterparty_tin | text | nullable | TIN of buyer/seller |
| counterparty_name | text | nullable | Name of buyer/seller |
| tin_absent | boolean | NOT NULL | true = adapter confirmed TIN does not exist |
| source_type | text | NOT NULL | CHECK: 'efdms_csv' \| 'manual_entry' \| 'tra_api' \| 'vfd_api' |
| provider_name | text | NOT NULL | Adapter that ingested the record |
| import_batch_id | text | NOT NULL | Batch identifier from the source system |
| ingestion_contract_version | text | NOT NULL | Contract version the adapter used |
| source_file_reference | text | nullable | Source filename or path |
| source_identifier | text | nullable | Business-level ID from source (e.g. EFDMS receipt number) |
| payload_hash | text | NOT NULL | SHA-256 hex of raw_payload — 64 chars |
| normalized_hash | text | NOT NULL | SHA-256 hex of canonical fields — 64 chars; UNIQUE per company |
| imported_by | uuid | NOT NULL | UUID of calling user — never auth.uid() (returns NULL under service role) |
| imported_at | timestamptz | NOT NULL | DEFAULT now() |
| adapter_confidence | numeric | NOT NULL | 0.00–1.00 |
| requires_secondary_review | boolean | NOT NULL | DEFAULT false |
| raw_payload | jsonb | NOT NULL | Original source record verbatim |

---

## SECTION 2: CANONICAL STATEMENTS (computed views, never stored)

These are derived aggregations over account balances. They are not stored. They are computed on demand by each engine from `trial_balance_uploads.processing_result` (current) or `account_mappings` (planned).

### Statement of Financial Position

| Line | Formula |
|---|---|
| current_assets | SUM(net_balance) WHERE classification = 'current_assets' |
| non_current_assets | SUM(net_balance) WHERE classification = 'non_current_assets' |
| total_assets | current_assets + non_current_assets |
| current_liabilities | SUM(net_balance) WHERE classification = 'current_liabilities' |
| non_current_liabilities | SUM(net_balance) WHERE classification = 'non_current_liabilities' |
| total_liabilities | current_liabilities + non_current_liabilities |
| equity | SUM(net_balance) WHERE classification = 'equity' |
| balance_check | total_assets = total_liabilities + equity — flag violation as finding; do not block export |

### Statement of Financial Performance

| Line | Formula |
|---|---|
| revenue | SUM(net_balance) WHERE classification = 'revenue' |
| cost_of_goods_sold | SUM(net_balance) WHERE classification = 'cost_of_goods_sold' |
| gross_profit | revenue - cost_of_goods_sold |
| operating_expenses | SUM(net_balance) WHERE classification = 'operating_expenses' |
| other_income | SUM(net_balance) WHERE classification = 'other_income' |
| taxes_expense | SUM(net_balance) WHERE classification = 'taxes' |
| profit_before_tax | gross_profit - operating_expenses + other_income |
| profit_after_tax | profit_before_tax - taxes_expense |

---

## SECTION 3: CANONICAL TRANSACTION (EFDMS source)

The canonical transaction is the conceptual view of a single financial event. It maps to `canonical_financial_records` (Section 1). The table column names differ from the conceptual field names in places — the mapping is documented here.

| Conceptual field | Table column | Notes |
|---|---|---|
| id | id | PK |
| company_id | company_id | FK → companies.id |
| source_type | source_type | 'efdms_csv' \| 'manual_entry' \| 'tra_api' \| 'vfd_api' |
| source_batch_id | batch_id | FK → ingestion_batches.id |
| source_record_id | source_identifier | nullable — EFDMS receipt number or business ID |
| amount | amount_tzs | Total transaction amount |
| vat_amount | vat_amount_tzs | VAT component |
| net_amount | (computed) | amount_tzs - vat_amount_tzs — not stored |
| transaction_date | canonical_date | Date of financial event |
| period | (computed) | Derived from period_year + period_month — not stored as single date |
| receipt_number | source_identifier | EFDMS receipt number |
| classification | record_type | 'sale' or 'purchase' — not a GL classification |

---

## SECTION 4: THE CONTRACT

1. Every module that reads EFDMS transaction data reads from `canonical_financial_records`. No module reads from `efdms_records` for computation. `efdms_records` is a raw staging table only.

2. Every module that reads account balances reads from `trial_balance_uploads.processing_result` (current) or `account_mappings` (planned). These are the account-balance stores, not `canonical_financial_records`.

3. No module computes a revenue total, obligation base, or tax figure by reading raw trial balance file bytes or raw EFDMS CSV bytes. All computation starts from a normalized data shape.

4. **Tax engine exception (current violation):** kinga-tax-engine/index.ts reads from `trial_balance_uploads.processing_result.statements` (`is.profit_before_tax`, `is.revenue.total`, and account arrays under `is.*` and `bs.*`). This is the correct current source for account balances. It must be formally migrated to a dedicated account-balance store before country expansion (Priority 9). TODO: replace `pr.statements.*` reads with a query keyed on (company_id, period).

5. **Findings engine exception (current violation):** kinga-findings-engine/index.ts reads from `trial_balance_uploads.processing_result` via the `TrialBalanceAccount` shape. Same exception as Rule 4. TODO: replace processing_result JSONB access with a canonical accounts query before Priority 9.

6. The three computational views (`v_loss_history`, `v_period_pairs`, `v_wdv_carry_forward`) are read-only derived views. The CIT engine reads from them directly. No module writes to them.

7. The AMT three-consecutive-loss-years trigger is computed by `v_loss_history.amt_3yr_trigger`. The engine must read this flag rather than computing consecutive loss years independently.

8. Any new module that reads financial data directly from `trial_balance_uploads.processing_result` or `efdms_records` must document why, with an explicit TODO to fix it before Priority 9.

---

## SECTION 5: DIVERGENCE RESOLUTION

Divergences identified in Step 1 audit (2026-07-02):

| ID | Concept | Engine A name/path | Engine B name/path | Resolution |
|---|---|---|---|---|
| D1 | Account balance | `sumMatching(accounts, patterns)` result in kinga-tax-engine | `account.balance` in kinga-findings-engine | Both refer to the same value. Canonical name: **`net_balance`** — debit minus credit, signed. |
| D2 | Revenue total | `is.revenue.total` — pre-aggregated scalar (kinga-tax-engine) | SUM of accounts with `trigger_account_classification = 'revenue'` (kinga-findings-engine) | Same concept, two computation paths. Canonical computation: SUM(net_balance) WHERE classification = 'revenue' (Section 2). The pre-aggregated scalar path in the tax engine is non-canonical. |
| D3 | Data source | `trial_balance_uploads.processing_result` (both engines) | `canonical_financial_records` (defined in DB, used by neither engine for account balances) | Both engines correctly read from `processing_result` for account balances. `canonical_financial_records` is a transaction store, not an account-balance store (Section 1 corrected). No violation of Contract Rule 1. |
| D4 | Period fields | `periodYear` + `periodMonth` as integer function parameters | `period_year` + `period_month` as integer DB columns | Identical values. Consistent naming. No action needed. |
| D5 | Account row shape | `{ account_code, account_name, debit, credit, balance }` in tax engine | `{ account_code, account_name, debit, credit, balance }` in findings engine | Identical shape. No divergence. |
| D6 | Canonical store usage | Not read or written | Not read or written | `canonical_financial_records` is for EFDMS transactions (Section 1). No engine writes to it yet because the EFDMS adapter is not yet built. This is a build gap, not a contract violation. |

---

## SECTION 6: COMPUTATIONAL VIEWS

These three views are the real computational backbone of the CIT engine. They are not raw tables. Do not write to them directly.

### v_loss_history

Tracks loss carry-forward per company per year.

| Field | Type | Notes |
|---|---|---|
| company_id | uuid | |
| company_name | text | |
| period_year | integer | |
| current_year_result_tzs | numeric | Profit or loss for the year |
| loss_utilised_tzs | numeric | Amount of prior loss relieved against current profit |
| unrelieved_loss_bf_tzs | numeric | Unrelieved loss brought forward into this year |
| unrelieved_loss_cf_tzs | numeric | Unrelieved loss carried forward to next year |
| consecutive_loss_years | integer | Count of consecutive loss years up to and including this year |
| amt_3yr_trigger | boolean | true when company has 3 or more consecutive loss years |
| risk_label | text | Human-readable risk classification |

### v_period_pairs

Links current and prior period uploads per company.

| Field | Type | Notes |
|---|---|---|
| company_id | uuid | |
| current_period_id | uuid | |
| current_upload_id | uuid | |
| current_year_end | date | |
| current_label | text | |
| prior_period_id | uuid | |
| prior_upload_id | uuid | |
| prior_year_end | date | |
| prior_label | text | |
| accounting_basis | text | |
| reporting_currency | text | |

### v_wdv_carry_forward

Written-down values per ITA wear and tear class between periods.

| Field | Type | Notes |
|---|---|---|
| company_id | uuid | |
| company_name | text | |
| current_year | integer | |
| prior_year | integer | |
| ita_class | integer | ITA Third Schedule class (1–5) |
| asset_description | text | |
| wdv_closing_prior | numeric | WDV at end of prior year |
| wdv_opening_current | numeric | WDV at start of current year (equals wdv_closing_prior) |
| status | text | |
