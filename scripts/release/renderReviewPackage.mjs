#!/usr/bin/env bun
// Renders the expected-output review package for a QUALIFIED ACCOUNTANT (docs/reporting/review-package/).
//
// The package is BLIND by construction: the inputs (two trial balances, the presentation, the evidence and the decisions
// the proofs use) and a worksheet with no figures go to the reviewer; the AUTHOR's expected figures are a separate file
// to be opened only after the reviewer has prepared their own. The author's figures below are written out by hand from
// the inputs — they are NOT computed by the product — and are labelled as the author's, never as validated.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/release/renderReviewPackage.mjs [--check]
// (the fixtures live in scripts/db-proof/lib/reportingKit.mjs; nothing touches a database.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSIGN, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2025, FY2026, TB } from "../db-proof/lib/reportingKit.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "docs/reporting/review-package");
const files = {};
const put = (rel, text) => { files[rel] = text.endsWith("\n") ? text : `${text}\n`; };

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────────────────────
put("inputs/trial_balance_FY2025.csv", csv(FY2025));
put("inputs/trial_balance_FY2026.csv", csv(FY2026));
put("inputs/account_classification.csv", "Account code,Account name,Classification,Statement,Normal balance\n" + TB.map((r) => r.slice(0, 5).join(",")).join("\n"));
put("inputs/presentation_assignments.csv", "Account code,Presentation line\n" + Object.entries(ASSIGN).map(([k, v]) => `${k},${v}`).join("\n"));
for (const [t, text] of Object.entries(EVIDENCE_FY2026)) put(`inputs/evidence_FY2026_${t.toLowerCase()}.csv`, text);
for (const [t, text] of Object.entries(EVIDENCE_FY2025_COMPARATIVE)) put(`inputs/evidence_FY2025_${t.toLowerCase()}.csv`, text);
put("inputs/decisions_and_schedules.csv", [
  "Item,Value,Basis",
  "Framework,IFRS for SMEs (2015 edition),Periods beginning 2026-01-01 (before the third edition's 2027-01-01 effective date; no early application elected)",
  "Reporting period,2026-01-01 to 2026-12-31; comparative 2025-01-01 to 2025-12-31,TZS; 2 decimals",
  "5.5(e) discontinued operations,Not applicable,None in the periods presented (preparer's decision)",
  "5.5(g) other comprehensive income,Not applicable,No item of 5.4(b) in the periods presented (preparer's decision)",
  "5.5(h) share of associates' OCI,Not applicable,No equity-accounted investee (preparer's decision)",
  "PPE movement schedule (Equipment),Opening 16000.00; depreciation -2000.00; closing 14000.00,Fixed asset register",
  "Cash and cash equivalents,Account 1000 (bank) only,Cash account map",
].join("\n"));

// ── The worksheet (no figures) and the author's expectations (separate) ─────────────────────────────────────────────
// [id, statement, line, FY2026, FY2025, author's derivation]
const AUTHOR = [
  ["SFP-01", "Financial position", "Property, plant and equipment", "14000.00", "16000.00", "1500 cost 20,000 less 1510 accumulated depreciation 6,000 (4,000)"],
  ["SFP-02", "Financial position", "Cash and cash equivalents", "12500.00", "8000.00", "1000 Bank"],
  ["SFP-03", "Financial position", "Trade and other receivables", "4300.00", "3000.00", "1100"],
  ["SFP-04", "Financial position", "Inventories", "2200.00", "1800.00", "1200"],
  ["SFP-05", "Financial position", "Total assets", "33000.00", "28800.00", "sum of the above"],
  ["SFP-06", "Financial position", "Share capital and retained earnings (as in the trial balance)", "15900.00", "13500.00", "3000 + 3100 (pre-closing)"],
  ["SFP-07", "Financial position", "Profit for the period (not yet closed to retained earnings)", "5100.00", "3100.00", "from the statement of comprehensive income"],
  ["SFP-08", "Financial position", "Total equity", "21000.00", "16600.00", "SFP-06 + SFP-07"],
  ["SFP-09", "Financial position", "Borrowings (non-current)", "8000.00", "9000.00", "2500"],
  ["SFP-10", "Financial position", "Trade and other payables", "3100.00", "2500.00", "2000"],
  ["SFP-11", "Financial position", "Current tax liability", "900.00", "700.00", "2100"],
  ["SFP-12", "Financial position", "Total equity and liabilities", "33000.00", "28800.00", "equals total assets"],
  ["SCI-01", "Comprehensive income", "Revenue", "30000.00", "25000.00", "4000"],
  ["SCI-02", "Comprehensive income", "Other income", "500.00", "400.00", "4100 interest income"],
  ["SCI-03", "Comprehensive income", "Cost of sales", "-14000.00", "-11500.00", "5000"],
  ["SCI-04", "Comprehensive income", "Distribution, administrative and other expenses (by function)", "-9900.00", "-9400.00", "6000 + 6100 + 6200"],
  ["SCI-05", "Comprehensive income", "Finance costs", "-600.00", "-700.00", "6300 interest expense"],
  ["SCI-06", "Comprehensive income", "Profit before tax", "6000.00", "3800.00", "SCI-01..05"],
  ["SCI-07", "Comprehensive income", "Tax expense", "-900.00", "-700.00", "7000"],
  ["SCI-08", "Comprehensive income", "Profit for the period", "5100.00", "3100.00", "SCI-06 + SCI-07"],
  ["SCI-09", "Comprehensive income", "Total comprehensive income", "5100.00", "3100.00", "no other comprehensive income (5.5(g), (h) not applicable)"],
  ["SCF-01", "Cash flows (direct)", "Receipts from customers", "28700.00", "24600.00", "FY2026: 30,000 - (4,300 - 3,000); FY2025: as supplied (FY2024 balances unknown)"],
  ["SCF-02", "Cash flows (direct)", "Payments to suppliers and employees", "-21700.00", "-19100.00", "FY2026: 14,000 + 5,500 + 2,400 + 400 inventory increase - 600 payables increase; FY2025: as supplied"],
  ["SCF-03", "Cash flows (direct)", "Interest received (operating)", "500.00", "400.00", "accounting policy choice (7.14)"],
  ["SCF-04", "Cash flows (direct)", "Income tax paid (operating)", "-700.00", "-500.00", "FY2026: 700 + 900 - 900; FY2025: as supplied"],
  ["SCF-05", "Cash flows (direct)", "Interest paid (operating)", "-600.00", "-700.00", "accounting policy choice (7.14); no accrual account"],
  ["SCF-06", "Cash flows (direct)", "Net cash from operating activities", "6200.00", "4700.00", "SCF-01..05"],
  ["SCF-07", "Cash flows (direct)", "Repayment of borrowings", "-1000.00", "-1000.00", "2500: 9,000 to 8,000"],
  ["SCF-08", "Cash flows (direct)", "Dividends paid", "-700.00", "-700.00", "retained earnings movement"],
  ["SCF-09", "Cash flows (direct)", "Net cash from financing activities", "-1700.00", "-1700.00", "SCF-07 + SCF-08"],
  ["SCF-10", "Cash flows (direct)", "Net increase in cash", "4500.00", "3000.00", "SCF-06 + SCF-09"],
  ["SCF-11", "Cash flows (direct)", "Cash at the beginning of the period", "8000.00", "5000.00", "FY2026: SFP FY2025; FY2025: signed prior-year statement of cash flows"],
  ["SCF-12", "Cash flows (direct)", "Cash at the end of the period", "12500.00", "8000.00", "equals SFP-02"],
  ["SCE-01", "Changes in equity", "Share capital: opening and closing", "10000.00", "10000.00", "3000"],
  ["SCE-02", "Changes in equity", "Retained earnings: opening", "6600.00", "4200.00", "FY2026: FY2025 closing; FY2025: 3,500 + 700 dividend (pre-closing)"],
  ["SCE-03", "Changes in equity", "Retained earnings: profit for the period", "5100.00", "3100.00", "SCI-08"],
  ["SCE-04", "Changes in equity", "Retained earnings: dividends", "-700.00", "-700.00", "per the equity movements"],
  ["SCE-05", "Changes in equity", "Retained earnings: closing", "11000.00", "6600.00", "SCE-02..04"],
  ["SCE-06", "Changes in equity", "Total equity: closing", "21000.00", "16600.00", "equals SFP-08"],
  ["PPE-01", "PPE schedule", "Carrying amount: opening", "16000.00", "", "FY2025 closing"],
  ["PPE-02", "PPE schedule", "Depreciation", "-2000.00", "", "6200"],
  ["PPE-03", "PPE schedule", "Carrying amount: closing", "14000.00", "", "equals SFP-01"],
];
const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
put("REVIEWER_WORKSHEET.csv", ["id,statement,line,reviewer_FY2026,reviewer_FY2025,reviewer_basis,agrees_with_product_output (Y/N/—),comment",
  ...AUTHOR.map(([id, st, line]) => [id, st, line, "", "", "", "", ""].map(q).join(","))].join("\n"));
put("SEALED_AUTHOR_EXPECTED.csv", ["id,statement,line,author_FY2026,author_FY2025,author_derivation,status",
  ...AUTHOR.map((r) => [...r, "AUTHOR_PREPARED_NOT_VALIDATED"].map(q).join(","))].join("\n"));

const check = process.argv[2] === "--check";
let drift = 0;
for (const [rel, text] of Object.entries(files)) {
  const f = path.join(OUT, rel);
  if (check) { if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) { drift++; console.log(`DRIFT ${rel}`); } continue; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
console.log(check ? (drift ? "REVIEW_PACKAGE: DRIFT" : "REVIEW_PACKAGE: OK") : `wrote ${Object.keys(files).length} files to docs/reporting/review-package/`);
process.exit(drift ? 1 : 0);
