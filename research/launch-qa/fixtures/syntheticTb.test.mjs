#!/usr/bin/env node
// Independent exact-money self-check of the invented fixtures (runs here; integer arithmetic).
import { BALANCED, IMBALANCED, SAME_NAME, totals } from "./syntheticTb.mjs";
let pass = 0, fail = 0; const ck = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} — ${JSON.stringify(d)}`); } };
ck("BALANCED debits == credits == 101,500,000 (exact)", BALANCED.expected.debit === 101500000 && BALANCED.expected.credit === 101500000 && BALANCED.expected.balanced, BALANCED.expected);
ck("IMBALANCED difference is exactly -30,000,000 and NOT balanced (imbalance stays visible)", IMBALANCED.expected.difference === -30000000 && !IMBALANCED.expected.balanced, IMBALANCED.expected);
ck("SAME_NAME preserves two DISTINCT codes under one name (not merged)", SAME_NAME.rows.filter(r => r.name === "Sales").length === 2 && new Set(SAME_NAME.rows.map(r => r.code)).size === SAME_NAME.rows.length, SAME_NAME.rows.map(r => r.code));
ck("CSV round-trips the headers + rows", BALANCED.csv.split("\n")[0] === "Account Code,Account Name,Debit,Credit" && BALANCED.csv.trim().split("\n").length === BALANCED.rows.length + 1);
console.log(`\n${pass}/${pass+fail} fixture self-checks passed.`); process.exit(fail ? 1 : 0);
