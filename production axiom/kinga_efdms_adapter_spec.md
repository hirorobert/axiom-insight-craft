# Kinga — EFDMS XLSX Report Adapter Specification
**Ingestion Contract v1.0**
**Status: CONFIRMED — All RD-1 through RD-8 resolved**
**Source files analysed: ETI-RPT-Z-RPRT-PER-TXPR.xlsx, ETI-RPT-PUCH-PER-TXPR.xlsx, ETI-RPT-Z-RPRT-PER-DVCE*.xlsx**
**Author: Kinga Phase 2 architecture review**
**Date: 2026-06-26 (original); confirmed 2026-06-26 from real TRA IDRAS exports**

---

## 0. Purpose

This document specifies the complete contract between TRA IDRAS XLSX report exports and the Kinga canonical ingestion layer. It covers:

- The confirmed TRA IDRAS XLSX column map (verified from real exports)
- How each column maps to `ingestion_batches`, `efdms_records`, and `canonical_financial_records`
- The normalised_hash specification (v1.0) for cross-source deduplication
- Adapter confidence rules and the `tin_absent` distinction
- XLSX multi-page parsing rules (footer detection, repeated header skipping)
- Error handling, partial batches, and batch rollback
- Edge Function pseudocode (TypeScript / Deno with SheetJS)
- Smoke tests

**Critical architecture note — Z-Report vs. receipt-level granularity:**
TRA IDRAS exports **sales data at Z-Report (daily summary) level** only. Individual sales receipts are not available in any of the exported report formats. Purchases ARE available at individual RCTVNUM (receipt) level. This means:
- Module A EFDMS diff for **sales**: daily-total level reconciliation (sum of Z-Report `Daily Total` vs. GL revenue)
- Module A EFDMS diff for **purchases**: receipt-level reconciliation (individual RCTVNUM vs. GL purchase entries)

---

> **Design note — future TRA API ingestion:**
> The ingestion pipeline is intentionally source-agnostic. `ingestion_batches.source_type`
> (`'efdms_csv'`, `'manual_entry'`, `'tra_api'`, `'vfd_api'`) is the ONLY place the source
> identity lives. `efdms_records` and `canonical_financial_records` have no XLSX-specific
> columns. When TRA publishes a direct API, a new adapter module populates the same tables
> with `source_type = 'tra_api'` — zero schema changes downstream. The XLSX-specific parsing
> logic (§10) must be isolated to a single adapter module so swapping it for API-polling later
> is a module replacement, not a surgery. A TRA API adapter will need its own RDs for
> endpoint, auth, payload shape, and pagination — but the schema contract it writes to
> is identical to the XLSX adapter.

---

## 1. Pipeline Architecture

```
TRA IDRAS Portal (tra.go.tz IDRAS)
  ├─ Z-Report Per Taxpayer XLSX  (ETI-RPT-Z-RPRT-PER-TXPR.xlsx)  ← SALES daily totals
  └─ Purchase Report Per Taxpayer XLSX  (ETI-RPT-PUCH-PER-TXPR.xlsx)  ← PURCHASES receipt-level
         │
         ▼
   [Edge Function: kinga-efdms-ingest]
         │
         ├─ 0. Detect report type from file header (row 3-4 contains report title)
         ├─ 1. Validate XLSX structure against contract v1.0
         ├─ 2. Extract taxpayer metadata from header section (rows 7-16)
         ├─ 3. Create ingestion_batches row (status = 'pending')
         │      source_type = 'efdms_csv'   ← constraint value; XLSX is the transport
         │      import_batch_id = caller-supplied idempotency key
         │
         ├─ 4. For each data row (skip footer and repeat-header rows):
         │       a. Parse fields using confirmed column indices (§2)
         │       b. Compute payload_hash  (SHA-256 of raw row as JSON)
         │       c. Compute normalised_hash  (see §5)
         │       d. Compute adapter_confidence  (see §6)
         │       e. INSERT INTO efdms_records  (ON CONFLICT DO NOTHING on efdms_transaction_id)
         │       f. INSERT INTO canonical_financial_records  (ON CONFLICT DO NOTHING on normalised_hash)
         │
         ├─ 5. UPDATE ingestion_batches
         │      status = 'completed' | 'partial' | 'failed'
         │
         └─ 6. Write audit_log row: action = 'canonical_ingestion_completed'
```

**Tables written (in order):**
1. `ingestion_batches` — provenance and progress tracking
2. `efdms_records` — raw EFDMS evidence (append-only)
3. `canonical_financial_records` — normalised, deduplicated (append-only)
4. `audit_logs` — one row per batch event

---

## 2. TRA IDRAS XLSX Report Formats (Confirmed)

### 2A. Z-Report Per Taxpayer (Sales Daily Summaries)

**File naming pattern:** `ETI-RPT-Z-RPRT-PER-TXPR.xlsx`
**System name:** "Z Report Per Taxpayer with Adjustment" (row 4 of XLSX)
**Record type:** `'sale'`
**Granularity:** One row per EFD device per fiscal day (daily Z-close)

**XLSX structure:**
- Row 1: TRA / IDRAS header
- Rows 3–7: Report metadata (report title, start month, end month, year)
- Rows 9–17: Taxpayer summary block (name, TIN, VRN, address, totals; varies by number of devices)
- Row with `SERIAL: {device_serial}  EFD STATE: ...` — device context line (parse device serial here)
- **Header row** (first row containing `ZNo`): confirmed at approx. row 18, varies by file
- **Data rows:** immediately follow the header row
- **Footer rows:** `Printed from IDRAS (E-Tax Invoice)  Page X of Y  Print Date & Time  DD Month YYYY  HH:MM:SS` — skip these
- No repeated header rows between pages (unlike Purchase report)

**Confirmed column positions (1-indexed):**

| Col | Header text | Kinga field | Notes |
|-----|-------------|-------------|-------|
| 1 | `ZNo` | `efdms_transaction_id` | Combined with device serial: `'{device_serial}/{ZNo}'` |
| 4 | `Date` | `transaction_date` | Format: `DD/MM/YYYY` |
| 6 | `Gross` | _(not ingested)_ | Cumulative total since device activation — NOT the daily amount |
| 9 | `Daily Total` | `amount_tzs` | That day's gross sales (VAT inclusive) |
| 14 | `Exclusive STD` | _(stored in raw_payload)_ | Standard-rated sales excluding VAT |
| 17 | `VAT STD` | `vat_amount_tzs` | VAT on standard-rated sales |
| 20 | `Zero Rated` | _(stored in raw_payload)_ | Zero-rated sales (VAT = 0) |
| 23 | `SR Sales` | _(stored in raw_payload)_ | Special Relief sales |
| 26 | `Exempt Sales` | _(stored in raw_payload)_ | Exempt sales |

**Device serial:** Extracted from the header section line containing `SERIAL:`. Store as `efd_device_id`.

**Amount check:** `Exclusive STD + VAT STD + Zero Rated + SR Sales + Exempt Sales = Daily Total`. Reject the row if this does not hold within TZS 1.00.

**Counterparty:** None — Z-Reports are aggregate sales summaries with no buyer information. `counterparty_tin = NULL`, `counterparty_name = NULL`. `tin_absent = false`.

**Normalised hash disambiguation:** since there is no counterparty, two different days with identical `Daily Total` and `VAT STD` values would produce the same normalised hash (collision). To prevent this, set `counterparty_name = device_serial` in the hash computation for Z-Report records (a synthetic but deterministic value that makes the hash unique per device per day per amount). Document this in the raw_payload.

---

### 2B. Purchase Report Per Taxpayer (Individual Purchase Receipts)

**File naming pattern:** `ETI-RPT-PUCH-PER-TXPR.xlsx`
**System name:** "Purchase Report Per TaxPayer" (row 3 of XLSX)
**Record type:** `'purchase'`
**Granularity:** One row per fiscal receipt (RCTVNUM = unique receipt control number)

**XLSX structure:**
- Row 1: TRA / IDRAS header
- Rows 3–5: Report metadata (report title, start month, end month, year)
- Rows 7–15: Taxpayer summary block (name, TIN, VRN, address, VAT status, totals)
- **Header row:** Row 17 (confirmed) — contains `Rpt No`, `RCTVNUM`, `Date`, etc.
- **Data rows:** Row 18 onwards
- **Footer rows:** `Printed from IDRAS (E-Tax Invoice)  Page X of Y  ...` — skip
- **Repeated header rows:** After each footer, the header row repeats on the next page — skip rows matching the header pattern
- **Blank rows:** Single blank rows appear before repeated headers — skip

**Confirmed column positions (1-indexed):**

| Col | Header text | Kinga field | Notes |
|-----|-------------|-------------|-------|
| 1 | `Rpt No` | `source_batch_id` | Sequential reference; not a unique business key |
| 2 | `RCTVNUM` | `efdms_transaction_id` | Fiscal Receipt Control Number — idempotency key |
| 4 | `Date` | `transaction_date` | Format: `DD/MM/YYYY` |
| 7 | `EFD Machine` | `efd_device_id` | Issuing device serial (e.g., `03TZ773005306`) |
| 8 | `Daily Total` | _(validation only)_ | Gross including VAT; use for amount check only |
| 10 | `Excl STD` | `amount_tzs` | Standard-rated net amount (before VAT) |
| 14 | `Vatable` | _(stored in raw_payload)_ | Vatable amount — equals `Excl STD` for standard-rated |
| 16 | `VAT` | `vat_amount_tzs` | VAT amount |
| 18 | `Zero Rated` | _(stored in raw_payload)_ | Zero-rated purchase amount |
| 20 | `Special Relief` | _(stored in raw_payload)_ | Special relief purchase amount |
| 22 | `Exempt Sales` | _(stored in raw_payload)_ | Exempt purchase amount |
| 25 | `Seller Name` | `counterparty_name` | Supplier who issued the receipt |
| 27 | `Seller TIN` | `counterparty_tin` | Supplier TIN (always present in confirmed data) |
| 28 | `Buyer Name` | _(not ingested)_ | The company itself — cross-check against company TIN only |

**Amount check:** `Excl STD + VAT + Zero Rated + Special Relief + Exempt Sales = Daily Total` (within TZS 1.00). Verified from real data: `1258050.85 + 226449.15 = 1484500.00` ✓

**VAT rate implied:** `VAT / Excl STD ≈ 0.18` (18% TZ standard VAT rate). Confirmed from sample.

**`RCTVNUM` format:** Alphanumeric, variable length (e.g., `2B9F4A685`, `93FEBA13282`). NOT a simple integer. Always use as string.

---

### 2C. Z-Report Per Device (Sales Daily Summaries — Single Device)

**File naming pattern:** `ETI-RPT-Z-RPRT-PER-DVCE.xlsx`
**System name:** "Z-Report Per Serial with Adjustment"
**Same schema as Z-Report Per Taxpayer** (§2A) but filtered to one device. Column names confirmed identical:
`Znum`, `Date`, `Gross`, `Daily Total`, `Exclusive STD`, `VAT STD`, `Zero Rated`, `SR Supplies`, `Exempt Supplies`
Note: `ZNo` (per taxpayer) vs `Znum` (per device) — same concept, different header text.
Note: `SR Sales` (per taxpayer) vs `SR Supplies` (per device) — same data, different header text.

**Adapter handles either file type identically** — detect from row 4 (`Z Report Per Taxpayer` vs `Z-Report Per Serial`).

---

## 3. Resolved Decisions (formerly Required Decisions RD-1 through RD-7)

| RD | Question | Resolution |
|----|----------|-----------|
| RD-1 | TRA EFDMS column names | ✅ Confirmed — see §2A and §2B above |
| RD-2 | Date format | ✅ `DD/MM/YYYY` confirmed from all files (e.g., `23/04/2022`, `31/12/2018`) |
| RD-3 | Number format | ✅ Excel numeric cells — no string parsing needed. `Excl STD`, `VAT`, `Daily Total` are already `float` values from SheetJS/openpyxl. No thousands separator stripping required. |
| RD-4 | Record type strings | ✅ No `record_type` column exists. Type is determined by report file (Z-Report → `'sale'`, Purchase → `'purchase'`). Caller must specify when uploading. |
| RD-5 | B2C / `tin_absent` flag | ✅ No explicit B2C flag. Purchase report: Seller TIN always present in confirmed data → `tin_absent = false` always for EFDMS adapter. Z-Report: no counterparty at all → `tin_absent = false`, `counterparty_tin = NULL`. |
| RD-6 | File encoding | ✅ XLSX format — encoding is not applicable. SheetJS/openpyxl handles binary format internally. |
| RD-7 | File delimiter | ✅ XLSX format — no delimiter. Row and cell parsing is handled by the XLSX library. |

**RD-8 — RESOLVED: Individual sales receipt report availability**

**Finding:** TRA IDRAS provides individual receipt-level sales data **only for devices running EFD Protocol 2.1 or later**. For pre-Protocol 2.1 devices (all data in the uploaded files: 2018–2023), only the Z-Report daily summary was transmitted to TRA. Individual sales receipts were not captured by TRA's system for those periods.

**Protocol 2.1 change (confirmed from TRA public notice):** The upgrade to Protocol 2.1 introduced an embedded QR code that "captures every single receipt on the EFDMS of TRA, unlike previously whereby only the summary of the trader's daily sales could be captured via the daily Z-report." This means individual receipt data IS now transmitted for Protocol 2.1 devices.

**Whether IDRAS exposes this as a downloadable XLSX report (`ETI-RPT-SALE-PER-TXPR` or similar) is not confirmed from public sources.** This requires a logged-in check on the IDRAS portal for a post-Protocol 2.1 period.

**Architectural consequence — two sub-cases:**

| Scenario | Sales data granularity | Adapter design |
|----------|----------------------|----------------|
| Pre-Protocol 2.1 periods (all uploaded files) | Z-Report daily summaries only | Current Z-Report adapter (§2A) handles this permanently |
| Post-Protocol 2.1, IDRAS exposes receipt report | Individual receipt level | Add a third adapter mode matching Purchase adapter structure |
| Post-Protocol 2.1, IDRAS only exposes Z-Reports | Still daily summaries | Current Z-Report adapter handles this; no change needed |

**Action required:** Log into TRA IDRAS portal. Navigate to ETI Reporting. Check if any "Sales" or "Receipt" report type appears for a period after the company's EFD device was upgraded to Protocol 2.1. If found, note the file name (e.g., `ETI-RPT-SALE-PER-TXPR.xlsx`) and upload a sample — the column structure can be confirmed from one file.

**For Module A v1.0:** Proceed with Z-Report daily-total level reconciliation. This is correct for all pre-Protocol 2.1 periods. Post-Protocol 2.1 receipt-level reconciliation is a Module A v1.1 enhancement, pending RD-8 portal confirmation.

---

## 4. ingestion_batches Row Construction

```typescript
// Caller supplies in the request body:
const batch = {
  company_id:                 caller_company_id,
  source_type:                'efdms_csv',           // CHECK constraint value; XLSX is the transport
  provider_name:              'TRA IDRAS',
  import_batch_id:            caller_idempotency_key, // e.g. 'zreport-2022-01-acme'
  ingestion_contract_version: '1.0',
  source_file_reference:      original_filename,      // e.g. 'ETI-RPT-PUCH-PER-TXPR.xlsx'
  record_count:               data_rows_count,        // exclude header, footer, blank rows
  status:                     'pending',
  imported_by:                caller_user_id,
};
```

---

## 5. efdms_records Row Construction

### For Z-Report (Sales Daily Summary):

```typescript
const efdmsRecord = {
  company_id:           batch.company_id,
  efdms_transaction_id: `${deviceSerial}/${row['ZNo']}`,  // composite key for uniqueness
  record_type:          'sale',
  transaction_date:     parseDate(row['Date']),           // DD/MM/YYYY → Date
  period_year:          date.getFullYear(),
  period_month:         date.getMonth() + 1,
  amount_tzs:           row['Daily Total'],               // Excel numeric — no parsing needed
  vat_amount_tzs:       row['VAT STD'],
  counterparty_tin:     null,                             // no buyer info in Z-reports
  counterparty_name:    null,
  efd_device_id:        deviceSerial,                     // extracted from SERIAL: header line
  source_batch_id:      null,
  raw_payload: {
    row_number:        rowIndex,
    ZNo:               row['ZNo'],
    Date:              row['Date'],
    Gross:             row['Gross'],
    Daily_Total:       row['Daily Total'],
    Exclusive_STD:     row['Exclusive STD'],
    VAT_STD:           row['VAT STD'],
    Zero_Rated:        row['Zero Rated'],
    SR_Sales:          row['SR Sales'] ?? row['SR Supplies'],
    Exempt_Sales:      row['Exempt Sales'] ?? row['Exempt Supplies'],
    device_serial:     deviceSerial,
  },
};
```

### For Purchase Report (Individual Receipts):

```typescript
const efdmsRecord = {
  company_id:           batch.company_id,
  efdms_transaction_id: row['RCTVNUM'],                   // e.g. '2B9F4A685'
  record_type:          'purchase',
  transaction_date:     parseDate(row['Date']),
  period_year:          date.getFullYear(),
  period_month:         date.getMonth() + 1,
  amount_tzs:           row['Excl STD'],                  // net amount before VAT
  vat_amount_tzs:       row['VAT'],
  counterparty_tin:     String(row['Seller TIN']).trim() || null,
  counterparty_name:    String(row['Seller Name']).trim() || null,
  efd_device_id:        String(row['EFD Machine']).trim(),
  source_batch_id:      String(row['Rpt No']),
  raw_payload: {
    row_number:      rowIndex,
    Rpt_No:          row['Rpt No'],
    RCTVNUM:         row['RCTVNUM'],
    Date:            row['Date'],
    EFD_Machine:     row['EFD Machine'],
    Daily_Total:     row['Daily Total'],
    Excl_STD:        row['Excl STD'],
    Vatable:         row['Vatable'],
    VAT:             row['VAT'],
    Zero_Rated:      row['Zero Rated'],
    Special_Relief:  row['Special Relief'],
    Exempt_Sales:    row['Exempt Sales'],
    Seller_Name:     row['Seller Name'],
    Seller_TIN:      row['Seller TIN'],
    Buyer_Name:      row['Buyer Name'],
  },
};
```

**INSERT strategy:** `INSERT INTO efdms_records ... ON CONFLICT (company_id, efdms_transaction_id) DO NOTHING`

---

## 6. canonical_financial_records Row Construction

```typescript
const normalised = computeNormalisedHash({
  company_id:        batch.company_id,
  record_type:       efdmsRecord.record_type,
  canonical_date:    efdmsRecord.transaction_date,
  amount_tzs:        efdmsRecord.amount_tzs,
  vat_amount_tzs:    efdmsRecord.vat_amount_tzs,
  counterparty_tin:  efdmsRecord.counterparty_tin,
  // For Z-Report: use device_serial in counterparty_name to prevent hash collisions
  // between different days with identical amounts on the same company.
  counterparty_name: efdmsRecord.record_type === 'sale'
    ? efdmsRecord.efd_device_id   // device serial as synthetic "name"
    : efdmsRecord.counterparty_name,
});

const canonicalRecord = {
  batch_id:                   batch.id,
  company_id:                 batch.company_id,
  record_type:                efdmsRecord.record_type,
  canonical_date:             efdmsRecord.transaction_date,
  period_year:                efdmsRecord.period_year,
  period_month:               efdmsRecord.period_month,
  amount_tzs:                 efdmsRecord.amount_tzs,
  vat_amount_tzs:             efdmsRecord.vat_amount_tzs,
  counterparty_tin:           efdmsRecord.counterparty_tin,
  counterparty_name:          efdmsRecord.counterparty_name,
  tin_absent:                 false,    // confirmed: EFDMS adapter never sets true
  source_type:                'efdms_csv',
  provider_name:              'TRA IDRAS',
  import_batch_id:            batch.import_batch_id,
  ingestion_contract_version: '1.0',
  source_file_reference:      batch.source_file_reference,
  source_identifier:          efdmsRecord.efdms_transaction_id,
  payload_hash:               sha256(JSON.stringify(efdmsRecord.raw_payload)),
  normalised_hash:            normalised,
  imported_by:                batch.imported_by,
  adapter_confidence:         computeConfidence(efdmsRecord),
  raw_payload:                efdmsRecord.raw_payload,
};
```

---

## 7. Normalised Hash Specification (v1.0)

SHA-256 hex (64 chars) of the following fields joined with `|`:

```
{company_id}|{record_type}|{canonical_date_YYYY-MM-DD}|{amount_tzs_2dp}|{vat_amount_tzs_2dp}|{counterparty_tin_or_NULL}|{counterparty_name_or_NULL}
```

**Z-Report special case:** `counterparty_name` field in the hash uses `efd_device_id` (device serial), not the real counterparty name (which is NULL). This makes daily Z-Report records unique even if two days have identical amounts. The real `counterparty_name` stored in the table remains NULL.

```typescript
function computeNormalisedHash(fields: {
  company_id: string;
  record_type: string;
  canonical_date: Date;
  amount_tzs: number;
  vat_amount_tzs: number;
  counterparty_tin: string | null;
  counterparty_name: string | null;  // for Z-reports: pass device_serial here
}): string {
  const parts = [
    fields.company_id.toLowerCase(),
    fields.record_type.toLowerCase(),
    fields.canonical_date.toISOString().substring(0, 10),
    fields.amount_tzs.toFixed(2),
    fields.vat_amount_tzs.toFixed(2),
    fields.counterparty_tin ?? 'NULL',
    fields.counterparty_name?.trim() ?? 'NULL',
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}
```

---

## 8. Adapter Confidence Rules

| Condition | adapter_confidence | Description |
|-----------|-------------------|-------------|
| Purchase: Seller TIN present, name present | 1.00 | Full counterparty identification |
| Purchase: Seller TIN present, name absent | 0.95 | TIN alone is sufficient for TRA matching |
| Purchase: Seller TIN absent, name present | 0.85 | Name only — cannot cross-reference with TRA |
| Purchase: both absent | 0.75 | Anonymous transaction |
| Z-Report (sale): no counterparty info | 0.70 | Aggregate daily total — no receipt-level attribution |

`tin_absent = false` for all EFDMS adapter records (confirmed: no explicit B2C flag in TRA IDRAS exports).

---

## 9. XLSX Parsing Rules

### 9A. Row Classification

A row is a **data row** if:
- Its first non-null cell (`col[0]` for Z-Report, `col[0]` or `col[1]` for Purchase) is numeric or a non-header string
- It does NOT match the header pattern (first cell = `ZNo` / `Rpt No`)
- It does NOT match the footer pattern (contains `'Printed from IDRAS'`)
- It is NOT blank (all cells None)

```typescript
function classifyRow(row: any[]): 'data' | 'header' | 'footer' | 'blank' | 'metadata' {
  const nonNull = row.filter(v => v !== null && v !== undefined);
  if (nonNull.length === 0) return 'blank';

  const firstNonNull = String(nonNull[0]);
  if (firstNonNull.includes('Printed from IDRAS')) return 'footer';
  if (firstNonNull === 'ZNo' || firstNonNull === 'Znum' || firstNonNull === 'Rpt No') return 'header';
  if (firstNonNull.startsWith('TANZANIA REVENUE') || firstNonNull.startsWith('\nTANZANIA')) return 'metadata';

  return 'data';
}
```

### 9B. Date Parsing

```typescript
function parseDate(raw: string | number | Date): Date {
  if (raw instanceof Date) return raw;  // SheetJS may already return Date objects
  if (typeof raw === 'number') {
    // Excel serial date number
    return new Date((raw - 25569) * 86400 * 1000);
  }
  // String: DD/MM/YYYY
  const match = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return new Date(`${match[3]}-${match[2]}-${match[1]}`);
  throw new Error(`Cannot parse date: "${raw}"`);
}
```

**Note:** SheetJS (`xlsx` npm package) may auto-parse date cells as JavaScript `Date` objects depending on the cell type. Always handle both string and Date inputs.

### 9C. Device Serial Extraction (Z-Report only)

The device serial appears in a metadata row formatted as:
`SERIAL: 08TZ106210  EFD STATE:  ACTIVATED`

```typescript
function extractDeviceSerial(sheet: any): string | null {
  for (const row of sheet) {
    const nonNull = row.filter((v: any) => v !== null);
    for (const cell of nonNull) {
      const match = String(cell).match(/SERIAL:\s*(\S+)/);
      if (match) return match[1];
    }
  }
  return null;
}
```

### 9D. Amount Validation

```typescript
function validateAmounts(row: ParsedRow, reportType: 'sale' | 'purchase'): void {
  const dailyTotal = row.daily_total;
  const sum = row.amount_net + row.vat + (row.zero_rated ?? 0)
            + (row.special_relief ?? 0) + (row.exempt ?? 0);
  if (Math.abs(sum - dailyTotal) > 1.00) {
    throw new Error(
      `Amount mismatch: net(${row.amount_net}) + vat(${row.vat}) + other = ${sum} ≠ daily_total(${dailyTotal})`
    );
  }
}
```

---

## 10. Edge Function Pseudocode (TypeScript / Deno + SheetJS)

```typescript
// supabase/functions/kinga-efdms-ingest/index.ts
// Ingestion contract v1.0 — TRA IDRAS XLSX format

import { serve } from 'https://deno.land/std/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';
import { createHash } from 'node:crypto';

type ReportType = 'z_report' | 'purchase';

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // 1. Auth
  const { data: { user }, error: authError } = await supabase.auth.getUser(
    req.headers.get('Authorization')!.replace('Bearer ', '')
  );
  if (authError || !user) return respond(401, { error: 'Unauthorized' });

  // 2. Parse multipart form
  const form = await req.formData();
  const file = form.get('file') as File;
  const companyId = form.get('company_id') as string;
  const importBatchId = form.get('import_batch_id') as string;

  // 3. Validate company ownership
  const { data: company } = await supabase
    .from('companies').select('id').eq('id', companyId).eq('user_id', user.id).single();
  if (!company) return respond(403, { error: 'Company not found or not owned by caller' });

  // 4. Parse XLSX
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'dd/mm/yyyy' });

  // 5. Detect report type from header
  const reportType: ReportType = detectReportType(allRows);
  const deviceSerial = reportType === 'z_report' ? extractDeviceSerial(allRows) : null;

  // 6. Find header row and extract data rows
  const { headerRowIndex, columnMap } = findHeaderRow(allRows, reportType);
  const dataRows = allRows
    .slice(headerRowIndex + 1)
    .filter(row => classifyRow(row, reportType) === 'data');

  // 7. Create ingestion batch
  const { data: batch, error: batchErr } = await supabase
    .from('ingestion_batches')
    .upsert({
      company_id: companyId,
      source_type: 'efdms_csv',        // constraint value; XLSX is the transport
      provider_name: 'TRA IDRAS',
      import_batch_id: importBatchId,
      ingestion_contract_version: '1.0',
      source_file_reference: file.name,
      record_count: dataRows.length,
      status: 'processing',
      imported_by: user.id,
    }, { onConflict: 'company_id,import_batch_id' })
    .select().single();

  if (batchErr) return respond(500, { error: batchErr.message });
  if (batch.status === 'completed') return respond(200, { message: 'Already processed', batch });

  // 8. Process rows
  let insertedCount = 0, skippedCount = 0, errorCount = 0;
  const errorSummary: RowError[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const raw = dataRows[i];
    try {
      const parsed = parseRow(raw, columnMap, reportType, deviceSerial);
      validateAmounts(parsed);

      const rawPayload = buildRawPayload(raw, columnMap, i, reportType, deviceSerial);
      const payloadHash = sha256(JSON.stringify(rawPayload));
      const normHash = computeNormalisedHash({
        company_id:        companyId,
        record_type:       parsed.record_type,
        canonical_date:    parsed.transaction_date,
        amount_tzs:        parsed.amount_tzs,
        vat_amount_tzs:    parsed.vat_amount_tzs,
        counterparty_tin:  parsed.counterparty_tin,
        // Z-Report: use device serial in hash to prevent collisions between days with identical amounts
        counterparty_name: parsed.record_type === 'sale'
          ? (deviceSerial ?? null)
          : parsed.counterparty_name,
      });

      const { error: efdmsErr } = await supabase.from('efdms_records').insert({
        company_id:           companyId,
        efdms_transaction_id: parsed.efdms_transaction_id,
        record_type:          parsed.record_type,
        transaction_date:     parsed.transaction_date.toISOString().substring(0, 10),
        period_year:          parsed.transaction_date.getFullYear(),
        period_month:         parsed.transaction_date.getMonth() + 1,
        amount_tzs:           parsed.amount_tzs,
        vat_amount_tzs:       parsed.vat_amount_tzs,
        counterparty_tin:     parsed.counterparty_tin,
        counterparty_name:    parsed.counterparty_name,
        efd_device_id:        parsed.efd_device_id,
        source_batch_id:      parsed.source_batch_id,
        raw_payload:          rawPayload,
        ingested_by:          null,
      });
      if (efdmsErr?.code === '23505') { skippedCount++; continue; }
      if (efdmsErr) throw new Error(efdmsErr.message);

      const { error: canonErr } = await supabase.from('canonical_financial_records').insert({
        batch_id:                   batch.id,
        company_id:                 companyId,
        record_type:                parsed.record_type,
        canonical_date:             parsed.transaction_date.toISOString().substring(0, 10),
        period_year:                parsed.transaction_date.getFullYear(),
        period_month:               parsed.transaction_date.getMonth() + 1,
        amount_tzs:                 parsed.amount_tzs,
        vat_amount_tzs:             parsed.vat_amount_tzs,
        counterparty_tin:           parsed.counterparty_tin,
        counterparty_name:          parsed.counterparty_name,
        tin_absent:                 false,
        source_type:                'efdms_csv',
        provider_name:              'TRA IDRAS',
        import_batch_id:            importBatchId,
        ingestion_contract_version: '1.0',
        source_file_reference:      file.name,
        source_identifier:          parsed.efdms_transaction_id,
        payload_hash:               payloadHash,
        normalised_hash:            normHash,
        imported_by:                user.id,
        adapter_confidence:         computeConfidence(parsed),
        raw_payload:                rawPayload,
      });
      if (canonErr?.code === '23505') { skippedCount++; }
      else if (canonErr) throw new Error(canonErr.message);
      else insertedCount++;

    } catch (err) {
      errorCount++;
      errorSummary.push({
        row_number: headerRowIndex + 1 + i + 2,
        efdms_transaction_id: null,
        error_type: 'validation_error',
        error_message: err.message,
        raw_values: raw,
      });
    }
  }

  // 9. Close batch
  const finalStatus = errorCount === 0 ? 'completed'
    : insertedCount > 0 ? 'partial' : 'failed';

  await supabase.from('ingestion_batches').update({
    status: finalStatus,
    inserted_count: insertedCount,
    skipped_count: skippedCount,
    error_count: errorCount,
    error_summary: errorSummary.length > 0 ? errorSummary : null,
    completed_at: new Date().toISOString(),
  }).eq('id', batch.id);

  await supabase.from('audit_logs').insert({
    user_id: user.id,
    action: finalStatus === 'failed' ? 'canonical_ingestion_failed' : 'canonical_ingestion_completed',
    entity_type: 'ingestion_batch',
    entity_id: batch.id,
    metadata: { inserted_count: insertedCount, skipped_count: skippedCount, error_count: errorCount,
                report_type: reportType, device_serial: deviceSerial },
  });

  return respond(200, { batch_id: batch.id, status: finalStatus,
    report_type: reportType, inserted_count: insertedCount,
    skipped_count: skippedCount, error_count: errorCount });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function detectReportType(rows: any[][]): ReportType {
  for (const row of rows.slice(0, 10)) {
    for (const cell of row) {
      if (String(cell ?? '').includes('Purchase Report')) return 'purchase';
      if (String(cell ?? '').includes('Z Report') || String(cell ?? '').includes('Z-Report')) return 'z_report';
    }
  }
  throw new Error('Cannot detect report type from XLSX header. Expected "Z Report" or "Purchase Report" in first 10 rows.');
}

function findHeaderRow(rows: any[][], reportType: ReportType): { headerRowIndex: number; columnMap: Record<string, number> } {
  const headerFirstCell = reportType === 'z_report' ? ['ZNo', 'Znum'] : ['Rpt No'];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonNull = row.filter(v => v !== null && v !== undefined);
    if (headerFirstCell.some(h => String(nonNull[0] ?? '') === h)) {
      // Build column map from this row
      const colMap: Record<string, number> = {};
      row.forEach((v, idx) => { if (v !== null && v !== undefined) colMap[String(v)] = idx; });
      return { headerRowIndex: i, columnMap: colMap };
    }
  }
  throw new Error('Cannot find header row in XLSX. Expected row starting with "ZNo", "Znum", or "Rpt No".');
}

function classifyRow(row: any[], reportType: ReportType): 'data' | 'header' | 'footer' | 'blank' {
  const nonNull = row.filter(v => v !== null && v !== undefined);
  if (nonNull.length === 0) return 'blank';
  const first = String(nonNull[0]);
  if (first.includes('Printed from IDRAS')) return 'footer';
  if (['ZNo', 'Znum', 'Rpt No'].includes(first)) return 'header';
  return 'data';
}

function parseDate(raw: any): Date {
  if (raw instanceof Date) return raw;
  const match = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) return new Date(Date.UTC(+match[3], +match[2] - 1, +match[1]));
  throw new Error(`Cannot parse date: "${raw}"`);
}

function computeConfidence(parsed: ParsedRow): number {
  if (parsed.record_type === 'sale') return 0.70;       // aggregate Z-report, no counterparty
  if (parsed.counterparty_tin && parsed.counterparty_name) return 1.00;
  if (parsed.counterparty_tin) return 0.95;
  if (parsed.counterparty_name) return 0.85;
  return 0.75;
}

function respond(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
```

---

## 11. Smoke Tests

```sql
-- Smoke A: Confirm Z-Report idempotency
-- Ingest ETI-RPT-Z-RPRT-PER-TXPR.xlsx twice with same import_batch_id.
-- Second call: inserted_count = 0, skipped_count = N, status = 'completed'.

-- Smoke B: Confirm purchase receipt deduplication
-- Ingest ETI-RPT-PUCH-PER-TXPR.xlsx. Then ingest same file again.
-- Second call: all rows skipped on RCTVNUM unique constraint.

-- Smoke C: Confirm amount validation rejects bad rows
-- Modify a row in XLSX so Excl STD + VAT ≠ Daily Total by > TZS 1.00.
-- Expected: row in error_summary, not in efdms_records.

-- Smoke D: Confirm enforce_verified_statutory_rule still fires
-- After ingestion, attempt to create a finding referencing an unverified FA2026 rule.
-- Expected: ERROR 23000 (V2 violation). Ingestion does not auto-verify rules.

-- Smoke E: Confirm batch counts
SELECT id, status, record_count, inserted_count, skipped_count, error_count, source_file_reference
FROM ingestion_batches
WHERE company_id = '<test_company_id>'
ORDER BY imported_at DESC
LIMIT 5;

-- Smoke F: Confirm canonical records were created
SELECT record_type, COUNT(*) AS records,
       SUM(amount_tzs) AS total_amount,
       SUM(vat_amount_tzs) AS total_vat,
       MIN(canonical_date) AS earliest,
       MAX(canonical_date) AS latest
FROM canonical_financial_records
WHERE company_id = '<test_company_id>'
GROUP BY record_type;
-- Z-Report file: record_type='sale', count = number of Z-close days in period
-- Purchase file: record_type='purchase', count = number of unique RCTVNUMs

-- Smoke G: Confirm normalised hash uniqueness (no collisions)
SELECT normalised_hash, COUNT(*) AS c
FROM canonical_financial_records
WHERE company_id = '<test_company_id>'
GROUP BY normalised_hash
HAVING COUNT(*) > 1;
-- Expected: 0 rows
```

---

## 12. Open Items After RD-8 Confirmation

1. Confirm whether TRA IDRAS provides a sales receipt-level report (RD-8). If yes, add a third adapter mode using the confirmed column names.
2. Write Supabase integration test using the actual uploaded XLSX files as fixtures.
3. Confirm `source_type = 'efdms_csv'` is acceptable for XLSX transport (or request schema change to add `'efdms_xlsx'` to the `chk_batch_source_type` CHECK constraint).
4. Wire findings engine Module A to read `canonical_financial_records` after ingestion completes.
5. Determine per-period GL amount source for Module A comparison (which `trial_balance_uploads` period overlaps the EFDMS period).
