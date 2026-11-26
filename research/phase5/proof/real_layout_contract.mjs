#!/usr/bin/env node
// Phase 5 — REAL-CONTRACT EXECUTION PROOF for the SunSystems-style manual-layout fallback.
//
// RUN (executes here; needs Node 22.18+/23+/24 TypeScript type-stripping):
//   node --experimental-strip-types research/phase5/proof/real_layout_contract.mjs
//
// WHAT THIS PROVES (not a shape match — a genuine execution through the production contract):
//   1. The deterministic auto-recognizer (this prototype's layer 1, mirroring tbIngestion COLUMN_MATCHERS) does NOT match
//      SunSystems' "T/B Code" header — so on the automatic path the account code is LOST. (negative control)
//   2. The REAL, UNMODIFIED production layout contract — supabase/functions/_shared/layoutProfile.ts, imported and executed
//      here, not reimplemented — accepts a manual LayoutProfile that names "T/B Code" as the account-code column
//      (validateProfile) and RESOLVES it against the file (resolveLayout), mapping "T/B Code" -> accountCode and capturing
//      every code. This upgrades the earlier "proposed route" to a VERIFIED route: the fallback executes through the
//      existing contract with no new mechanism.
//
// Scope: read-only import of the production module; nothing is modified. Synthetic fixture only.
import { SUNSYSTEMS } from "../fixtures/synthetic.mjs";
import { recogniseStructure } from "../prototype/layer1_structure.mjs";

const TS = new URL("../../../supabase/functions/_shared/layoutProfile.ts", import.meta.url);
let L;
try {
  L = await import(TS.href);
} catch (e) {
  console.error("REAL_MODULE_IMPORT_FAILED (needs `node --experimental-strip-types`):", String(e && e.message || e).split("\n")[0]);
  process.exit(2);
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d, (k, v) => typeof v === "bigint" ? String(v) : v)}` : ""}`); } };

console.log("== Production module surface (read-only import)");
check("validateProfile, resolveLayout, profileSha256 and LAYOUT_TEMPLATE_FORMAT are exported by the REAL module",
  typeof L.validateProfile === "function" && typeof L.resolveLayout === "function" && typeof L.profileSha256 === "function" && typeof L.LAYOUT_TEMPLATE_FORMAT === "string",
  { has: Object.keys(L).sort() });

console.log("\n== Negative control: the automatic recognizer loses the SunSystems code");
{
  const r = recogniseStructure(SUNSYSTEMS.headers);
  check("auto-recognizer does NOT match 'T/B Code' as the account code (code would be lost on the automatic path)", r.columnMap.account_code === null, r.columnMap);
}

console.log("\n== REAL contract: a manual LayoutProfile naming 'T/B Code' validates and resolves");
{
  // Build the SAME untrusted-request shape the production UI would submit, and validate it through the REAL validateProfile.
  const raw = {
    format: L.LAYOUT_TEMPLATE_FORMAT,
    sheet: { kind: "csv" },
    headerRow: 1,
    columns: { accountCode: "T/B Code", accountName: "Description", debit: "YTD Debit", credit: "YTD Credit" },
    numberFormat: L.NUMBER_FORMAT_IDS[0],
    balanceSign: null,
  };
  const v = L.validateProfile(raw);
  check("the REAL validateProfile ACCEPTS the manual layout that names 'T/B Code' as the account code", v.ok === true, v.ok ? undefined : v.errors);
  if (!v.ok) { console.log(`\n${pass}/${pass + fail} real-layout-contract checks passed.`); process.exit(1); }

  // Build SourceRow[] exactly as the contract expects: header on row 1, data on rows 2..n.
  const rows = [
    { rowNumber: 1, cells: SUNSYSTEMS.headers },
    ...SUNSYSTEMS.dataRows.map((cells, i) => ({ rowNumber: i + 2, cells })),
  ];
  const profileHash = await L.profileSha256(v.profile);
  const res = L.resolveLayout(rows, null, v.profile, profileHash);
  check("the REAL resolveLayout RESOLVES the layout against the file (ok=true, no blocking issues)", res.ok === true, res.ok ? undefined : res.issues);
  if (!res.ok) { console.log(`\n${pass}/${pass + fail} real-layout-contract checks passed.`); process.exit(1); }

  const cols = res.resolved.columns;
  check("'T/B Code' resolves to the account-code column at index 0 (code column RECOVERED by the real contract)", cols.accountCode === 0, cols);
  check("'Description' resolves to the account-name column", cols.accountName === 1, cols);
  check("'YTD Debit' / 'YTD Credit' resolve to the debit/credit columns", cols.debit === 2 && cols.credit === 3, cols);

  // Read the codes back out of the resolved code column — they are captured, not lost.
  const recoveredCodes = SUNSYSTEMS.dataRows.map((r) => String(r[cols.accountCode]).trim());
  const expectedCodes = ["SAL001", "EXP010", "AST100", "LIA200"];
  check("every SunSystems code is captured through the manual layout (no code lost)", JSON.stringify(recoveredCodes) === JSON.stringify(expectedCodes), { recoveredCodes });
}

console.log(`\n${pass}/${pass + fail} real-layout-contract checks passed.`);
process.exit(fail ? 1 : 0);
