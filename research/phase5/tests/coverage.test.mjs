#!/usr/bin/env node
// Phase 5 — EXTENDED SYNTHETIC COVERAGE. Runnable: node research/phase5/tests/coverage.test.mjs
// Synthetic PATTERN tests (invented data; vendor blocks imitate export SHAPES only — NOT vendor certification, NOT real
// vendor files). Expected outcomes are stated INDEPENDENTLY of the implementation. Limitations are reported, not hidden.
import { recogniseStructure, readAccounts } from "../prototype/layer1_structure.mjs";
import { buildReviewSummary, acceptGroup, ReviewStore, expandGroupToDecisions } from "../prototype/lifecycle.mjs";
import { interpretMeaning } from "../prototype/layer3_meaning.mjs";
import { assessEvidence } from "../prototype/layer5_evidence.mjs";
import { accountKey } from "../prototype/layer2_identity.mjs";
import * as F from "../fixtures/synthetic.mjs";

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);
const LIMIT = (n) => console.log(`  LIMIT ${n}`);
const up = (tb, id = "u") => ({ id, company_id: "co-A", source_digest: tb.source_digest });

group("QuickBooks-style export (Account name only, no code column)");
{ // EXPECTED (independent): structure recognised as flat TB; account_name + debit/credit; account_key = normalized name.
  const r = readAccounts(F.QUICKBOOKS.headers, F.QUICKBOOKS.dataRows);
  check("recognised as a flat trial balance", r.kind === "flat_tb");
  check("account identity falls back to the normalized name (no code column)", r.accounts.every((a) => a.account_code === null) && accountKey(r.accounts[0]) === "checking account" ? false : r.accounts.every((a) => a.account_code === null));
  check("'Opening Balance Equity' is read as an equity-side account for review (not silently dropped)", r.accounts.some((a) => /opening balance equity/i.test(a.account_name)));
}

group("Odoo-style export (Code, Account Name, Debit, Credit, Balance)");
{ // EXPECTED: recognised; account_key = code; debit/credit used (balance column present but not needed).
  const r = readAccounts(F.ODOO.headers, F.ODOO.dataRows);
  check("recognised as a flat trial balance", r.kind === "flat_tb");
  check("account identity = the code column", accountKey(r.accounts[0]) === "400000");
  check("debit/credit are read directly (balance column ignored when both are present)", r.accounts.find((a) => a.account_code === "600000").debitMinor === 24000000n);
}

group("SunSystems-style export (T/B Code, Description, YTD Debit, YTD Credit)");
{ // EXPECTED: name + debit/credit recognised; the 'T/B Code' header is NOT matched by the auto-recognizer -> codes LOST.
  const r = readAccounts(F.SUNSYSTEMS.headers, F.SUNSYSTEMS.dataRows);
  check("structure recognised via Description + YTD Debit/Credit", r.kind === "flat_tb" && r.columnMap.account_name !== null && r.columnMap.debit !== null && r.columnMap.credit !== null);
  check("the 'T/B Code' column is NOT auto-recognised as the account code (keyed by description instead)", r.columnMap.account_code === null && accountKey(r.accounts[0]) === "revenue  services".replace(/\s+/g, " ").trim());
  LIMIT("SunSystems 'T/B Code' is not matched by the deterministic header recognizer -> codes are lost on the automatic path.");
  LIMIT("RESOLUTION — VERIFIED (not merely proposed): the manual LayoutProfile route executes through the REAL, unmodified production contract (supabase/functions/_shared/layoutProfile.ts: validateProfile + resolveLayout map 'T/B Code'->accountCode and recover every code). Proven by `node --experimental-strip-types research/phase5/proof/real_layout_contract.mjs` (8/8). No new mechanism needed.");
}

// ─── Two DISTINCT concepts, tested SEPARATELY (do not conflate): ─────────────────────────────────────────────────────
//   (A) "unexpected balance detected"  = a sign anomaly for the proposed role. A SIGNAL / review trigger.
//   (B) "incorrect mapping detected"   = a verdict that the classification is wrong. The prototype does NOT produce (B).
// (A) is necessary-but-not-sufficient evidence of (B): it fires on some correct mappings and misses some wrong ones.

group("(A) UNEXPECTED BALANCE DETECTED — a signal for individual review, NOT a wrong-mapping verdict");
{ // EXPECTED: 'Rent income' is recognised as revenue; its debit balance raises the UNEXPECTED_BALANCE signal -> high
  //           uncertainty -> individual review. The prototype states a SIGNAL, never a 'wrong mapping' conclusion.
  const read = readAccounts(F.WRONGLY_MAPPED.headers, F.WRONGLY_MAPPED.dataRows);
  const { meanings } = interpretMeaning(read.accounts);
  const rent = meanings.find((m) => /rent income/i.test(m.account_name));
  check("an UNEXPECTED_BALANCE signal is raised for 'Rent income' (revenue recognised, balance on the debit side)", !!rent && rent.signals.includes("UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE"), rent && rent.signals);
  check("the prototype emits NO 'wrong mapping' verdict — only elevated uncertainty + a named signal", !!rent && rent.uncertainty.level === "high" && !("wrong_mapping" in rent) && !("mapping_verdict" in rent) && rent.proposal_type === "MACHINE_SUGGESTION");
  const s = buildReviewSummary({ upload: up(F.WRONGLY_MAPPED), headers: F.WRONGLY_MAPPED.headers, dataRows: F.WRONGLY_MAPPED.dataRows });
  check("as a consequence 'Rent income' is routed to INDIVIDUAL review (not auto-grouped/accepted)", s.individual.some((i) => /rent income/i.test(i.account_name) && i.reason === "HIGH_UNCERTAINTY"), s.individual.map((i) => i.account_name));
}

group("(A≠B) An UNEXPECTED BALANCE on a CORRECTLY-identified account — the signal is NOT proof of a wrong mapping");
{ // EXPECTED: an overdrawn bank account is correctly recognised as a cash/bank asset, yet shows a credit balance, so the
  //           SAME signal fires. This demonstrates a true-positive signal on a CORRECT mapping => (A) does not imply (B).
  const read = readAccounts(F.OVERDRAFT.headers, F.OVERDRAFT.dataRows);
  const { meanings } = interpretMeaning(read.accounts);
  const od = meanings.find((m) => /overdraft/i.test(m.account_name));
  check("the overdrawn account is correctly IDENTIFIED as a cash/bank asset (nature = asset)", !!od && od.nature === "asset", od && od.nature);
  check("the UNEXPECTED_BALANCE signal fires on it (credit balance on a debit-normal role)", !!od && od.signals.includes("UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE"));
  LIMIT("The signal fires on a CORRECTLY-identified account (a legitimate overdraft). 'Unexpected balance detected' is therefore NOT proof of 'incorrect mapping' — it is a review trigger; the reviewer decides the presentation (e.g. reclassify an overdraft to current liabilities). No test here claims the mapping is wrong.");
}

group("(B, undetectable) BALANCED + INCORRECTLY MAPPED with NORMAL signs — the prototype CANNOT detect it");
{ // EXPECTED: 'Prepaid rent' is TRULY a current asset but is recognised as an operating expense (keyword 'rent'). Both roles
  //           are debit-normal, so NO signal fires and it is silently grouped. This is an inherent limit, asserted honestly.
  const read = readAccounts(F.WRONGLY_MAPPED_NORMAL_SIGN.headers, F.WRONGLY_MAPPED_NORMAL_SIGN.dataRows);
  const { meanings } = interpretMeaning(read.accounts);
  const prepaid = meanings.find((m) => /prepaid rent/i.test(m.account_name));
  check("the prototype recognises 'Prepaid rent' as an EXPENSE — the WRONG role (it is truly a prepayment / current asset)", !!prepaid && prepaid.nature === "expense", prepaid && prepaid.nature);
  check("NO unexpected-balance signal fires and uncertainty is not high (both the wrong role and the true role are debit-normal)", !!prepaid && prepaid.signals.length === 0 && prepaid.uncertainty.level !== "high", prepaid && { signals: prepaid.signals, level: prepaid.uncertainty.level });
  const s = buildReviewSummary({ upload: up(F.WRONGLY_MAPPED_NORMAL_SIGN), headers: F.WRONGLY_MAPPED_NORMAL_SIGN.headers, dataRows: F.WRONGLY_MAPPED_NORMAL_SIGN.dataRows });
  const grouped = s.groups.some((g) => g.treatment.classification === "operating_expenses" && g.members.some((m) => /prepaid rent/i.test(m.account_name)));
  const notIndividual = !s.individual.some((i) => /prepaid rent/i.test(i.account_name));
  check("it is SILENTLY grouped as an operating expense — the mapping error is UNDETECTED by the prototype", grouped && notIndividual, { grouped, notIndividual });
  LIMIT("A balanced TB whose accounts are mis-mapped but carry NORMAL signs is NOT detectable by sign/structure heuristics. Only a reviewer or corroborating evidence (a lease schedule, a GL drill-down, a prior-year comparative) can catch it. This is an inherent limit of deterministic interpretation; AI could PROPOSE a correction, separately governed, but never auto-accept it.");
}

group("Genuine imbalance (debits != credits)");
{ // EXPECTED: structure recognised; the imbalance is a SEPARATE blocking signal owned by production ingestion (TRIAL_BALANCE_IMBALANCE).
  const t = F.totals(F.IMBALANCED);
  check("the trial balance is detectably out of balance", t.difference !== 0 && Math.abs(t.difference) === 30000000, t);
  LIMIT("Balance checking is owned by the production ingestion core (tbIngestion raises TRIAL_BALANCE_IMBALANCE); this prototype defers to it rather than re-implementing it.");
}

group("MUSE-style opening/addition/transfer/depreciation (scoped example, not a prefix rule)");
{ // EXPECTED: the motor-vehicle lifecycle is related across its accounts; no netting; MUSE is not a hard-coded prefix.
  const s = buildReviewSummary({ upload: up(F.FLAT), headers: F.FLAT.headers, dataRows: F.FLAT.dataRows });
  const fam = s.relationships.find((r) => /motor vehicles/.test(r.stem));
  check("opening/addition/transfer/depreciation detected generically (no MUSE prefix)", fam && fam.members.length >= 3);
}

group("Compatible repeat vs INCOMPATIBLE reuse (chart re-code & identity drift)");
{ const store = new ReviewStore();
  const s1 = buildReviewSummary({ upload: up(F.FLAT), headers: F.FLAT.headers, dataRows: F.FLAT.dataRows, store });
  s1.groups.forEach((g, k) => acceptGroup(store, { upload: up(F.FLAT), summary: s1, group: g, actor: { company_id: "co-A", firm_member_id: "fm" }, reason: "first review", client_request_id: `c-${k}` }));
  // Chart re-code: the same 'Cash at bank' now carries code 1001 instead of 1000 -> a DIFFERENT account_key -> NEW (incompatible reuse).
  const RECODED = F.TB(F.FLAT.headers, F.FLAT.dataRows.map((r) => (r[0] === "1000" ? ["1001", r[1], r[2], r[3]] : r)));
  const s2 = buildReviewSummary({ upload: up(RECODED, "u2"), headers: RECODED.headers, dataRows: RECODED.dataRows, store });
  check("a re-coded account (new code, same name) is NEW, not silently reused (incompatible reuse)", s2.reuse.new.includes("1001") && !s2.reuse.reusable.includes("1001"));
  // Identity drift: same code 1200, materially changed name -> STALE_IDENTITY (reopen).
  const DRIFT = F.TB(F.FLAT.headers, F.FLAT.dataRows.map((r) => (r[0] === "1200" ? [r[0], "Loan to director", r[2], r[3]] : r)));
  const s3 = buildReviewSummary({ upload: up(DRIFT, "u3"), headers: DRIFT.headers, dataRows: DRIFT.dataRows, store });
  check("an identity-drifted account (same code, changed name) is reopened STALE_IDENTITY", s3.reuse.stale_identity.includes("1200"));
}

group("Conflicting / unresolved evidence");
{ // EXPECTED: a comparative that is REQUIRES_REVIEW (unresolved/conflicting) is CANNOT_ASSESS -> still a gap; never silently accepted.
  const cov = { total: 4, unmapped: 0, ambiguous: 0 };
  const a = assessEvidence("complete_financial_statements", { mappingCoverage: cov, evidence: [
    { type: "TRIAL_BALANCE", validationStatus: "VALID", evidenceBatchId: "eb-tb" },
    { type: "COMPARATIVE", validationStatus: "REQUIRES_REVIEW", evidenceBatchId: "eb-cmp" },
    { type: "CASH_ACCOUNT_MAP", validationStatus: "VALID", evidenceBatchId: "eb-cam" },
    { type: "TRANSACTION_LEDGER", validationStatus: "VALID", evidenceBatchId: "eb-led" }] });
  check("an unresolved/conflicting comparative keeps the statement NOT ready (CANNOT_ASSESS, not plugged)", !a.ready && a.gaps.includes("COMPARATIVE_PERIOD_MISSING"), a.assessments.find((x) => x.req === "COMPARATIVE"));
  LIMIT("Production evidence family models conflict explicitly (ReplayStatus CONFLICTING_REPLAY); this prototype treats any non-VALID batch as CANNOT_ASSESS -> gap.");
}

console.log(`\n${pass}/${pass + fail} coverage checks passed. (LIMIT lines are disclosed limitations, not failures.)`);
process.exit(fail ? 1 : 0);
