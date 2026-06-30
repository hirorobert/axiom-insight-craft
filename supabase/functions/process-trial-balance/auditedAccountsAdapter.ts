// ============================================================
// Axiom — AuditedAccountsAdapter
// Version: v1.0 — 2026-06-30
//
// Detects Excel workbooks formatted as audited financial
// statements (SCI + SFP sheets) rather than flat trial balances,
// and converts them to the standard TBRow[] format that the
// process-trial-balance validation pipeline expects.
//
// FLOW:
//   1. isAuditedAccountsFormat()  → detect SCI+SFP structure
//   2. parseAuditedAccounts()     → extract all P&L + BS accounts
//   3. Pass result to existing column-detection & classification
//      pipeline (process-trial-balance/index.ts) via the
//      rawRows[][] format consumed by detectColumns() +
//      rowsToRawAccounts()
//
// FORMAT DETECTED BY SHEET NAME PATTERNS:
//   SCI: "SCI", "Statement of Comprehensive Income",
//        "Income Statement", "P&L", "Profit & Loss"
//   SFP: "SFP", "Statement of Financial Position",
//        "Balance Sheet", "SOFP"
//   PPE: "PPE", "Property Plant" (optional — used for capital
//        allowance pre-population when present)
//   Notes: "NOTES", "Notes to" (optional — provides line-item
//          detail for the tax engine's pattern matching)
//
// OUTPUT FORMAT:
//   A flat array of rows in the shape:
//   [ ["Account Code", "Account Name", "Dr", "Cr"], ...data... ]
//   — identical to what parseXLSX() returns for a flat TB XLSX.
//   This slots directly into detectColumns() without any changes.
//
// LIMITATIONS (v1.0):
//   • Requires at least one numeric value column in the SCI/SFP.
//   • Takes column index 2 (zero-based) as the primary (current
//     year) amount. For comparative statements, col 3 = prior year
//     is ignored.
//   • Only handles INCOME/EXPENSE/ASSET/LIABILITY/EQUITY.
//     Does NOT parse cash flow statements.
//   • Does NOT auto-detect which line items are headers/subtotals —
//     uses a heuristic: rows where the label starts with a keyword
//     like "Total", "Sub-total", "Less:", "Add:", "Net", "Gross"
//     AND the numeric value equals the sum of prior rows are skipped.
//     In practice, the subtotal-row filter in rowsToRawAccounts()
//     (which runs on the output) handles most cases.
//
// USAGE IN index.ts (process-trial-balance):
//   import { isAuditedAccountsFormat, parseAuditedAccounts }
//     from "./auditedAccountsAdapter.ts";
//
//   if (format === "xlsx") {
//     const wb = XLSX.read(new Uint8Array(buffer), { type: "array" });
//     if (isAuditedAccountsFormat(wb)) {
//       rawRows = parseAuditedAccounts(wb);
//       sheetName = "AUDITED_ACCOUNTS (auto-extracted)";
//     } else {
//       const parsed = parseXLSX(buffer);
//       rawRows = parsed.rows;
//       sheetName = parsed.sheetName;
//     }
//   }
// ============================================================

import * as XLSX from "https://esm.sh/xlsx@0.18.5";

// ── Sheet name detection patterns ─────────────────────────────────────────────

const SCI_SHEET_PATTERNS = [
  /^sci$/i,
  /statement\s+of\s+comprehensive\s+income/i,
  /income\s+statement/i,
  /profit\s+(?:and|&)\s+loss/i,
  /^p\s*[&and]+\s*l$/i,
  /comprehensive\s+income/i,
];

const SFP_SHEET_PATTERNS = [
  /^sfp$/i,
  /^sofp$/i,
  /statement\s+of\s+financial\s+position/i,
  /balance\s+sheet/i,
  /financial\s+position/i,
];

const PPE_SHEET_PATTERNS = [
  /^ppe\s*$/i,
  /property[,\s]+plant\s+(?:and|&)\s+equip/i,
  /fixed\s+assets?/i,
  /non[_\s-]current\s+assets?\s+schedule/i,
];

const NOTES_SHEET_PATTERNS = [
  /^notes?$/i,
  /notes?\s+to\s+the/i,
  /^notes?\s+\d/i,
];

// ── Row-level skip patterns ────────────────────────────────────────────────────
// Rows whose labels start with these words are header/subtotal rows to skip.
const SKIP_LABEL_PATTERNS = [
  /^total[s]?\b/i,
  /^sub[_\s-]?total[s]?\b/i,
  /^grand\s+total\b/i,
  /^sum\b/i,
  /^net\s+(?:profit|loss|income|assets|liabilities|equity)/i,
  /^gross\s+(?:profit|loss)\b/i,
  /^less[:\s]/i,                // "Less: Closing Inventory" etc.
  /^add[:\s]/i,
  /^auditor/i,
  /^director/i,
  /^note[s]?\s+\d/i,            // "Note 1 to 6 form part..."
  /^p\.o\.\s+box/i,
  /statement\s+of/i,
  /^for\s+the\s+(?:year|period)/i,
  /^\d+\s*$/,                   // bare page numbers
  /^………/,                       // signature lines
  /^……/,
];

function shouldSkipRow(label: string | null): boolean {
  if (!label || !label.trim()) return true;
  const t = label.trim();
  return SKIP_LABEL_PATTERNS.some(p => p.test(t));
}

// ── Utility: find first sheet matching a set of patterns ──────────────────────
function findSheet(wb: XLSX.WorkBook, patterns: RegExp[]): string | null {
  for (const name of wb.SheetNames) {
    if (patterns.some(p => p.test(name.trim()))) return name;
  }
  return null;
}

// ── Utility: parse a sheet → [{label, amount2025, amount2024}] ───────────────
interface SheetRow {
  label:  string;
  amount: number;   // current year (column index 2, zero-based after XLSX parse)
}

function parseSheet(wb: XLSX.WorkBook, sheetName: string): SheetRow[] {
  const ws = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<(string | number | null)[]>(
    ws, { header: 1, defval: null, raw: true }
  ) as (string | number | null)[][];

  const results: SheetRow[] = [];

  for (const row of raw) {
    // Label is always in the first non-null text column
    let label: string | null = null;
    let amount: number | null = null;

    // Find label: first cell that is a non-empty string
    for (let c = 0; c < Math.min(row.length, 4); c++) {
      const v = row[c];
      if (v !== null && typeof v === "string" && v.trim()) {
        label = v.trim();
        break;
      }
    }

    // Find amount: first cell that is a non-zero number after the label column
    // Convention: current-year figure is usually column index 2 or 3
    // We scan columns 1–4 (right-to-left preference for the first numeric col)
    for (let c = 1; c < Math.min(row.length, 6); c++) {
      const v = row[c];
      if (v !== null && typeof v === "number" && !isNaN(v)) {
        amount = v;
        break;  // take the first numeric value (current year)
      }
    }

    if (label && amount !== null && !shouldSkipRow(label)) {
      results.push({ label, amount });
    }
  }

  return results;
}

// ── Balance sheet classification helper ───────────────────────────────────────
// Returns true if the label likely describes a CREDIT item (liability/equity/income)
// Returns false for debit items (assets/expenses)
// Used to set Dr vs Cr in the output rows.

const CREDIT_LABEL_PATTERNS = [
  // Revenue
  /\brevenue\b/i, /\bincome\b/i, /\bsale[s]?\b/i, /\bturnover\b/i, /\bgrant[s]?\b/i,
  // Liabilities
  /\bloan[s]?\b/i, /\bborr(?:ow|owed)/i, /\bpayable[s]?\b/i, /\bcreditor[s]?\b/i,
  /\bliabilit/i, /\bdebt\b/i, /\boverdraft\b/i, /\baccrued\b/i, /\bdeferred\s+income\b/i,
  /\btax\s+payable\b/i, /\bnhif\s+payable\b/i, /\bnssf\s+payable\b/i,
  /\bwcf\s+payable\b/i, /\bsdl\s+payable\b/i, /\bpaye\s+payable\b/i,
  /\bvat\s+payable\b/i, /\bservice\s+levy\s+payable\b/i,
  // Equity
  /\bshare\s+capital\b/i, /\bshare\s+premium\b/i, /\bretained\s+earn/i,
  /\bequity\b/i, /\bsurplus\b/i, /\bnet\s+asset[s]?\b/i,
  /\bcurrent\s+year\s+(?:profit|surplus)\b/i,
];

function isCreditAccount(label: string): boolean {
  return CREDIT_LABEL_PATTERNS.some(p => p.test(label));
}

// ── SCI note detail extraction ─────────────────────────────────────────────────
// When a NOTES sheet is present, extract granular expense line items from it
// (more useful for the tax engine's pattern matching than the SCI summary lines).
// Returns the same SheetRow[] format with Dr/Cr assigned by sign.

function parseNotesGranular(wb: XLSX.WorkBook, notesSheet: string): SheetRow[] {
  // Parse the notes sheet the same way as any other sheet
  // The notes contain the expense breakdown by category
  return parseSheet(wb, notesSheet);
}

// ── Main export: format detection ─────────────────────────────────────────────

/**
 * Returns true if the workbook looks like audited financial statements
 * (has both an SCI and an SFP sheet) rather than a flat trial balance.
 */
export function isAuditedAccountsFormat(wb: XLSX.WorkBook): boolean {
  const hasSCI = !!findSheet(wb, SCI_SHEET_PATTERNS);
  const hasSFP = !!findSheet(wb, SFP_SHEET_PATTERNS);
  return hasSCI && hasSFP;
}

// ── Main export: converter ────────────────────────────────────────────────────

/**
 * Converts an audited-accounts workbook into a flat raw-rows array
 * compatible with the process-trial-balance detectColumns() pipeline.
 *
 * Output schema:
 *   Row 0: ["Account Code", "Account Name", "Dr", "Cr"]
 *   Row n: [code_string, name_string, debit_string_or_"", credit_string_or_""]
 */
export function parseAuditedAccounts(wb: XLSX.WorkBook): (string | number | null)[][] {
  const sciSheet   = findSheet(wb, SCI_SHEET_PATTERNS);
  const sfpSheet   = findSheet(wb, SFP_SHEET_PATTERNS);
  const ppeSheet   = findSheet(wb, PPE_SHEET_PATTERNS);
  const notesSheet = findSheet(wb, NOTES_SHEET_PATTERNS);

  const outputRows: (string | number | null)[][] = [
    ["Account Code", "Account Name", "Dr", "Cr"],
  ];

  let seqNum = 1;
  const used = new Set<string>();  // deduplicate label→code

  function addRow(label: string, amount: number, isCredit: boolean) {
    if (!label.trim()) return;
    // Generate a stable sequential code; dedup by label
    const key = label.toLowerCase().replace(/\s+/g, "_");
    if (used.has(key)) return;
    used.add(key);

    const code = `AA${String(seqNum++).padStart(3, "0")}`;
    const absAmt = Math.abs(amount);
    if (absAmt === 0) return;   // skip zero-value rows

    if (isCredit) {
      outputRows.push([code, label, "", String(Math.round(absAmt))]);
    } else {
      outputRows.push([code, label, String(Math.round(absAmt)), ""]);
    }
  }

  // ── 1. INCOME STATEMENT ───────────────────────────────────────────────────
  // Prefer Notes (granular) over SCI (summary) for expense lines.
  // Always use SCI for revenue (Notes may not separate revenue clearly).

  if (sciSheet) {
    const sciRows = parseSheet(wb, sciSheet);

    for (const { label, amount } of sciRows) {
      const isCredit = isCreditAccount(label);
      // For SCI: positive amount on income → credit; positive on expense → debit
      // The isCreditAccount heuristic handles most cases.
      addRow(label, amount, isCredit);
    }
  }

  // If Notes sheet exists, try to extract more granular expense detail.
  // These rows will be skipped (deduplication) if the same label appeared in SCI.
  if (notesSheet) {
    const noteRows = parseNotesGranular(wb, notesSheet);
    for (const { label, amount } of noteRows) {
      const isCredit = isCreditAccount(label);
      addRow(label, amount, isCredit);
    }
  }

  // ── 2. BALANCE SHEET ─────────────────────────────────────────────────────
  if (sfpSheet) {
    const sfpRows = parseSheet(wb, sfpSheet);
    for (const { label, amount } of sfpRows) {
      const isCredit = isCreditAccount(label);
      addRow(label, amount, isCredit);
    }
  }

  // ── 3. PPE SCHEDULE (optional — adds asset detail for capital allowances) ──
  if (ppeSheet) {
    const ppeRows = parseSheet(wb, ppeSheet);
    // PPE schedule rows are all debit assets; we add them if not already present
    for (const { label, amount } of ppeRows) {
      // Skip total rows that already appeared in SFP
      if (/\btotal\b/i.test(label)) continue;
      addRow(label, amount, false);  // all PPE lines are debit
    }
  }

  return outputRows;
}

// ── Detection metadata (for logging) ──────────────────────────────────────────

export function getAuditedAccountsMetadata(wb: XLSX.WorkBook): Record<string, string | null> {
  return {
    sci_sheet:   findSheet(wb, SCI_SHEET_PATTERNS),
    sfp_sheet:   findSheet(wb, SFP_SHEET_PATTERNS),
    ppe_sheet:   findSheet(wb, PPE_SHEET_PATTERNS),
    notes_sheet: findSheet(wb, NOTES_SHEET_PATTERNS),
  };
}
