#!/usr/bin/env bun
// Renders the HOSTED ACCEPTANCE fixture set (docs/release/acceptance-r1/): a dedicated synthetic engagement of the demo
// company for FY2025 (current) and FY2024 (comparative). FY2026 is never used: it may hold real or protected data.
//
// The figures are the reviewed proof fixtures (scripts/db-proof/lib/reportingKit.mjs; review package
// docs/reporting/review-package/) with every DATE moved one year earlier and nothing else changed — so the totals
// computed by hand for the review package hold unchanged. Edition: periods start 2025-01-01 and 2024-01-01, before the
// third edition's 2027-01-01 effective date → the 2015 edition by the standard's own rule (no election).
//
//   DB_PROOF_MODULES_DIR=<dir> bun scripts/release/renderAcceptanceFixtures.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSIGN, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2025, FY2026, TB } from "../db-proof/lib/reportingKit.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(REPO, "docs/release/acceptance-r1");
const files = {};
const put = (rel, text) => { files[rel] = text.endsWith("\n") ? text : `${text}\n`; };
// Every date moves one year earlier (2026 → 2025, 2025 → 2024); amounts are unchanged.
const shiftCurrent = (t) => t.replace(/\b2026-(\d\d)-(\d\d)\b/g, "2025-$1-$2");
const shiftPrior = (t) => t.replace(/\b2025-(\d\d)-(\d\d)\b/g, "2024-$1-$2").replace(/1 January 2025/g, "1 January 2024");
// Account authority (account mappings, presentation) is held per COMPANY, not per year: so that the acceptance engagement
// cannot touch the demo company's existing chart, every account gets its own code (9 + the kit code: 91000 … 97000) and a
// name marked "(acceptance r1)". docs/release/sql/07_acceptance_preflight.sql refuses to proceed on any overlap.
const code = (c) => `9${c}`;
const ROWS = TB.map(([c, n, ...rest]) => [code(c), `${n} (acceptance r1)`, ...rest]);
const CASH = code("1000");
const recode = (t) => t.replace(/^([TP]\d+,[^,]*),1000,/gm, `$1,${CASH},`).replace(/^1000,BANK_ACCOUNT,/m, `${CASH},BANK_ACCOUNT,`);

put("trial_balance_FY2025_current.csv", csv(FY2026, ROWS));
put("trial_balance_FY2024_prior.csv", csv(FY2025, ROWS));
put("account_classification.csv", "Account code,Account name,Classification,Statement,Normal balance,Cash account\n" + ROWS.map((r) => [...r.slice(0, 5), r[0] === CASH ? "yes" : "no"].join(",")).join("\n"));
put("presentation_assignments.csv", "Account code,Presentation line\n" + Object.entries(ASSIGN).map(([k, v]) => `${code(k)},${v}`).join("\n"));
put("evidence_FY2025_current_transaction_ledger.csv", recode(shiftCurrent(EVIDENCE_FY2026.TRANSACTION_LEDGER)));
put("evidence_FY2025_current_equity_movements.csv", EVIDENCE_FY2026.EQUITY_MOVEMENTS);
put("evidence_FY2025_current_cash_account_map.csv", recode(EVIDENCE_FY2026.CASH_ACCOUNT_MAP));
put("evidence_FY2024_comparative_transaction_ledger.csv", recode(shiftPrior(EVIDENCE_FY2025_COMPARATIVE.TRANSACTION_LEDGER)));
put("evidence_FY2024_comparative_equity_movements.csv", EVIDENCE_FY2025_COMPARATIVE.EQUITY_MOVEMENTS);
put("evidence_FY2024_comparative_prior_period_statements.csv", shiftPrior(EVIDENCE_FY2025_COMPARATIVE.PRIOR_PERIOD_STATEMENTS));
put("ppe_schedule_FY2025.csv", "Class,Opening carrying amount,Movement,Amount,Closing carrying amount,Source\nEquipment,16000.00,Depreciation,-2000.00,14000.00,Fixed asset register 2025 (synthetic)");
put("notes_wording_FY2025.csv", [
  "Requirement,Wording (acceptance placeholder — NOT a reviewed disclosure),Source",
  "smes.note.compliance,These are synthetic acceptance statements prepared to test the product; they are not represented as compliant with any standard.,Acceptance fixture r1",
  "smes.note.identification,Synthetic acceptance engagement of the demo company; year ended 31 December 2025; TZS.,Acceptance fixture r1",
  "smes.note.policies,Historical cost (acceptance placeholder).,Acceptance fixture r1",
  "smes.note.judgements,None beyond estimates (acceptance placeholder).,Acceptance fixture r1",
  "smes.note.estimates,Useful lives of equipment (acceptance placeholder).,Acceptance fixture r1",
  "smes.note.subclassifications,All receivables from third parties (acceptance placeholder).,Acceptance fixture r1",
  "smes.note.share_capital,10000 ordinary shares fully paid (acceptance placeholder).,Acceptance fixture r1",
].join("\n"));
put("decisions_FY2025.csv", [
  "Requirement,Decision,Reason",
  "smes.note.share_capital,Applicable,The synthetic entity has share capital",
  "smes.sci.5_5_e,Not applicable,No discontinued operation in the synthetic periods",
  "smes.sci.5_5_g,Not applicable,No item of 5.4(b) other comprehensive income in the synthetic periods",
  "smes.sci.5_5_h,Not applicable,No equity-accounted investee in the synthetic periods",
].join("\n"));
// Totals computed BY HAND for the review package (docs/reporting/review-package/SEALED_AUTHOR_EXPECTED.csv), restated for
// the shifted years. AUTHOR-PREPARED, NOT INDEPENDENTLY VALIDATED.
put("EXPECTED_TOTALS.csv", [
  "Statement,Line,FY2025 (current),FY2024 (comparative),Derivation",
  "Financial position,Total assets,33000.00,28800.00,PPE 14000/16000 + cash 12500/8000 + receivables 4300/3000 + inventories 2200/1800",
  "Financial position,Total equity,21000.00,16600.00,share capital 10000 + retained earnings (pre-closing) + profit",
  "Financial position,Total liabilities,12000.00,12200.00,borrowings 8000/9000 + payables 3100/2500 + current tax 900/700",
  "Comprehensive income,Profit before tax,6000.00,3800.00,30000-14000-9900-600+500 / 25000-11500-9400-700+400",
  "Comprehensive income,Profit for the period,5100.00,3100.00,PBT less tax 900/700",
  "Comprehensive income,Total comprehensive income,5100.00,3100.00,no OCI: 5.5(g) and (h) decided not applicable",
  "Cash flows,Net cash from operating activities,6200.00,4700.00,28700-21700+500-700-600 / 24600-19100+400-500-700",
  "Cash flows,Net cash from financing activities,-1700.00,-1700.00,loan repayment 1000 + dividends 700",
  "Cash flows,Cash at the end of the period,12500.00,8000.00,opening 8000/5000 + net increase 4500/3000",
  "Changes in equity,Total equity at the end of the period,21000.00,16600.00,10000 + retained earnings 11000/6600",
  "PPE schedule,Closing carrying amount,14000.00,,16000 less depreciation 2000",
].join("\n"));

const check = process.argv[2] === "--check";
let drift = 0;
for (const [rel, text] of Object.entries(files)) {
  const f = path.join(OUT, rel);
  if (check) { if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) { drift++; console.log(`DRIFT ${rel}`); } continue; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
console.log(check ? (drift ? "ACCEPTANCE_FIXTURES: DRIFT" : "ACCEPTANCE_FIXTURES: OK") : `wrote ${Object.keys(files).length} files to docs/release/acceptance-r1/`);
process.exit(drift ? 1 : 0);
