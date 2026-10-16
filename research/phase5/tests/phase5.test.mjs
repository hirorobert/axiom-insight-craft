#!/usr/bin/env node
// Phase 5 synthetic proof — runnable with: node research/phase5/tests/phase5.test.mjs
//
// All accounts and amounts below are INDEPENDENTLY INVENTED for this research (NOT from cfoclose_tb_fixtures.zip, no
// private workbook, no source figures). No model is called. The prototype is deterministic; where behaviour stands in for
// something a reviewer-confirmed or server-enforced mechanism would do, it is labelled "SIMULATED" in output.
import { buildReviewSummary, acceptGroup, ReviewStore, Refusal, classifyAgainstPrior } from "../prototype/lifecycle.mjs";
import { assessEvidence } from "../prototype/layer5_evidence.mjs";
import { accountKey } from "../prototype/layer2_identity.mjs";
import { sha256Hex } from "../prototype/util.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? `  — ${JSON.stringify(detail)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);
const HEADERS = ["Account Code", "Account Name", "Debit", "Credit"];
const TB = (rows) => { const dataRows = rows.map((r) => [r[0], r[1], r[2] ?? "", r[3] ?? ""]); return { headers: HEADERS, dataRows, source_digest: sha256Hex(dataRows) }; };
const actor = { company_id: "co-A", firm_member_id: "fm-1" };
const upload = (tb, over = {}) => ({ id: "up-1", company_id: "co-A", source_digest: tb.source_digest, ...over });

// ── An invented 20-account trial balance (minor units; integers). ──
const MAIN = TB([
  ["4000", "Sales", "", 180000000],
  ["4100", "Sales", "", 9000000],            // same description, DIFFERENT code
  ["4900", "Other income", "", 1200000],
  ["5000", "Cost of goods sold", 72000000, ""],
  ["6000", "Salaries and wages", 41000000, ""],
  ["6100", "Rent expense", 12000000, ""],
  ["6200", "Utilities", 3400000, ""],
  ["1000", "Cash at bank", 15500000, ""],
  ["1010", "Petty cash", 300000, ""],
  ["1200", "Trade receivables", 28000000, ""],
  ["1300", "Inventory", 19000000, ""],
  ["2000", "Trade payables", "", 22000000],
  ["2100", "Supplier payable - Northwind", "", 6500000],
  ["2500", "Bank loan", "", 40000000],
  ["3000", "Share capital", "", 50000000],
  ["3100", "Retained earnings", "", 70000000],
  ["1500", "Motor vehicles - cost (opening)", 36000000, ""],
  ["1510", "Motor vehicles - additions", 9000000, ""],
  ["1520", "Motor vehicles - transfers", 2000000, ""],
  ["1530", "Accumulated depreciation - motor vehicles", "", 14000000],
  ["9999", "Suspense account", 100000, ""],   // no recognised meaning
]);

// ─────────────────────────────────────────────────────────────────────────────
group("1 · Grouped mapping review (not hundreds of individual approvals; no Accept-all)");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows, store });
  const groupable = s.groups.reduce((n, g) => n + g.member_count, 0);
  check("summary recognised the structure and read 21 accounts", s.ok && s.accountsRead.length === 21, { read: s.accountsRead?.length });
  check("far fewer groups than accounts (grouped treatments)", s.groups.length <= 10 && groupable >= 12, { groups: s.groups.length, groupable });
  check("the Suspense account is NOT grouped — it surfaces for individual classification", s.individual.some((i) => i.account_key === "9999" && i.reason === "NO_RECOGNISED_MEANING"));
  check("the accumulated-depreciation contra-asset surfaces individually (consequential sign), never swept into a group",
    s.individual.some((i) => i.account_key === "1530" && i.reason === "HIGH_UNCERTAINTY"));
  // Accept each group EXPLICITLY with a reason (one call per group) — there is no blanket Accept-all.
  let accepted = 0, logged = 0;
  s.groups.forEach((g, k) => { const r = acceptGroup(store, { upload: upload(MAIN), summary: s, group: g, actor, reason: `confirmed ${g.treatment.classification}`, client_request_id: `req-g${k}` }); accepted++; logged += r.decisions_logged; });
  check("each group accepted individually (explicit reason each); no single Accept-all call", accepted === s.groups.length);
  check("group acceptance expanded to one per-account decision per member in the append-only ledger", logged === groupable && store.decisions.length === groupable, { logged, ledger: store.decisions.length });
  console.log(`        SIMULATED: ${s.accountsRead.length} accounts reviewed as ${s.groups.length} groups + ${s.individual.length} individual, ${accepted} explicit group approvals.`);
}

// ─────────────────────────────────────────────────────────────────────────────
group("2 · Different codes with similar descriptions are NOT auto-duplicates");
{
  const s = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows });
  check("4000 'Sales' and 4100 'Sales' resolve to DIFFERENT account_keys", accountKey({ account_code: "4000", account_name: "Sales" }) !== accountKey({ account_code: "4100", account_name: "Sales" }));
  const revGroup = s.groups.find((g) => g.treatment.classification === "revenue");
  check("both appear as distinct members of the revenue group (two decisions, not one merged account)", revGroup && revGroup.members.filter((m) => m.account_key === "4000" || m.account_key === "4100").length === 2);
  check("the similar-description uncertainty is surfaced on the group", revGroup && revGroup.uncertainty.reasons.some((r) => /NOT treated as a duplicate/i.test(r)));
}

// ─────────────────────────────────────────────────────────────────────────────
group("3 · Opening / addition / transfer / depreciation relationships (surfaced, never netted)");
{
  const s = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows });
  const fam = s.relationships.find((r) => /motor vehicles/.test(r.stem));
  check("a motor-vehicles lifecycle relationship is detected across its accounts", fam && fam.members.length >= 3, { members: fam?.members?.length });
  const roles = new Set((fam?.members || []).map((m) => m.role));
  check("the relationship spans opening/addition/transfer/depreciation roles", ["opening", "addition", "transfer", "depreciation"].filter((r) => roles.has(r)).length >= 3, { roles: [...roles] });
  // No netting: each member's balance is preserved separately in the accounts read (nothing combined into one figure).
  const costOpen = s.accountsRead.find((a) => a.account_code === "1500");
  const accDep = s.accountsRead.find((a) => a.account_code === "1530");
  check("balances are preserved separately — no automatic netting of cost against depreciation", costOpen.debitMinor === 36000000 && accDep.creditMinor === 14000000);
  check("the relationship note states movements are never netted into one figure or a cash flow", /never netted/i.test(fam.note));
}

// ─────────────────────────────────────────────────────────────────────────────
group("4 · Missing comparative / GL evidence blocks the OUTPUT, not the review");
{
  // Review-summary readiness only needs the reviewed TB + a complete mapping review.
  const coverageComplete = { total: 21, unmapped: 0, ambiguous: 0 };
  const rvw = assessEvidence("tb_review_summary", { evidence: [{ type: "TRIAL_BALANCE", validationStatus: "VALID", evidenceBatchId: "eb-tb" }], mappingCoverage: coverageComplete });
  check("TB review summary is READY once the TB is read and mapping review is complete", rvw.ready, rvw.gaps);
  // Complete statements need comparative + cash map + transaction ledger — none supplied here.
  const full = assessEvidence("complete_financial_statements", { evidence: [{ type: "TRIAL_BALANCE", validationStatus: "VALID", evidenceBatchId: "eb-tb" }], mappingCoverage: coverageComplete });
  check("complete statements are NOT ready — comparative period missing", !full.ready && full.gaps.includes("COMPARATIVE_PERIOD_MISSING"));
  check("complete statements are NOT ready — cash-flow ledger authority unresolved", full.gaps.includes("CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED"));
  check("complete statements are NOT ready — transaction ledger evidence missing", full.gaps.includes("REQUIRED_EVIDENCE_MISSING:TRANSACTION_LEDGER"));
  // Supplying valid comparative + cash map + ledger clears those gaps (never plugged — only when truly present & valid).
  const withEvidence = assessEvidence("complete_financial_statements", { mappingCoverage: coverageComplete, evidence: [
    { type: "TRIAL_BALANCE", validationStatus: "VALID", evidenceBatchId: "eb-tb" },
    { type: "COMPARATIVE", validationStatus: "VALID", evidenceBatchId: "eb-cmp" },
    { type: "CASH_ACCOUNT_MAP", validationStatus: "VALID", evidenceBatchId: "eb-cam" },
    { type: "TRANSACTION_LEDGER", validationStatus: "VALID", evidenceBatchId: "eb-led" }] });
  check("with valid comparative + cash map + ledger, the gaps clear (evidence present, not plugged)", withEvidence.ready, withEvidence.gaps);
  const invalidLedger = assessEvidence("complete_financial_statements", { mappingCoverage: coverageComplete, evidence: [
    { type: "TRIAL_BALANCE", validationStatus: "VALID", evidenceBatchId: "eb-tb" },
    { type: "COMPARATIVE", validationStatus: "VALID", evidenceBatchId: "eb-cmp" },
    { type: "CASH_ACCOUNT_MAP", validationStatus: "VALID", evidenceBatchId: "eb-cam" },
    { type: "TRANSACTION_LEDGER", validationStatus: "REQUIRES_REVIEW", evidenceBatchId: "eb-led" }] });
  check("an invalid/REQUIRES_REVIEW ledger is CANNOT_ASSESS → still a gap (never treated as present)", !invalidLedger.ready && invalidLedger.gaps.includes("REQUIRED_EVIDENCE_MISSING:TRANSACTION_LEDGER"));
}

// ─────────────────────────────────────────────────────────────────────────────
group("5 · Compatible repeat-upload reuse (no re-approval of unchanged accounts)");
{
  const store = new ReviewStore();
  const s1 = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows, store });
  s1.groups.forEach((g, k) => acceptGroup(store, { upload: upload(MAIN), summary: s1, group: g, actor, reason: "first review", client_request_id: `r1-${k}` }));
  // A second upload of the SAME accounts (new amounts, same identities) — only new/changed accounts should need review.
  const REPEAT = TB(MAIN.dataRows.map((r) => [r[0], r[1], r[2] === "" ? "" : Math.round(Number(r[2]) * 1.07), r[3] === "" ? "" : Math.round(Number(r[3]) * 1.07)]));
  const s2 = buildReviewSummary({ upload: upload(REPEAT, { id: "up-2" }), headers: REPEAT.headers, dataRows: REPEAT.dataRows, store });
  const grouped = MAIN.dataRows.length - s1.individual.length; // accounts that got an accepted decision in round 1
  check("every previously-accepted account is REUSABLE on the repeat upload", s2.reuse.reusable.length === grouped, { reusable: s2.reuse.reusable.length, expected: grouped });
  const needReview2 = new Set([...s2.groups.flatMap((g) => g.members.map((m) => m.account_key)), ...s2.individual.map((i) => i.account_key)]);
  const s1Individuals = new Set(s1.individual.map((i) => i.account_key));
  check("only the previously-UN-reviewed accounts need review again — no accepted account re-surfaces",
    needReview2.size === s1Individuals.size && [...needReview2].every((k) => s1Individuals.has(k)), { needReview2: [...needReview2], s1Individuals: [...s1Individuals] });
  console.log(`        SIMULATED: round 2 reused ${s2.reuse.reusable.length} approved decisions; only ${s2.individual.length} still-unreviewed accounts remain.`);
}

// ─────────────────────────────────────────────────────────────────────────────
group("6 · Changed account meaning / identity reopens the affected decision");
{
  const store = new ReviewStore();
  const s1 = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows, store });
  s1.groups.forEach((g, k) => acceptGroup(store, { upload: upload(MAIN), summary: s1, group: g, actor, reason: "first review", client_request_id: `rr-${k}` }));
  // (a) identity drift: same code 1200, materially changed name.
  const DRIFT = TB(MAIN.dataRows.map((r) => (r[0] === "1200" ? [r[0], "Loan to related party", r[2], r[3]] : r)));
  const sa = buildReviewSummary({ upload: upload(DRIFT, { id: "up-3" }), headers: DRIFT.headers, dataRows: DRIFT.dataRows, store });
  check("a coded account whose name materially changed is reopened as STALE_IDENTITY", sa.reuse.stale_identity.includes("1200"), sa.reuse);
  check("the reopened account re-appears for review; unchanged accounts stay reused", sa.reuse.reusable.length > 0 && !sa.reuse.reusable.includes("1200"));
  // (b) relevant meaning/context changed (e.g. a comparative/GL reconciliation revealed a different meaning for 2100).
  const sb = buildReviewSummary({ upload: upload(MAIN, { id: "up-4" }), headers: MAIN.headers, dataRows: MAIN.dataRows, store, meaningChangedKeys: ["2100"] });
  check("an account flagged as meaning/context-changed is reopened as STALE_MEANING", sb.reuse.stale_meaning.includes("2100"), sb.reuse);
  const c = classifyAgainstPrior(store, "co-A", { account_code: "2100", account_name: "Supplier payable - Northwind" }, { meaningChanged: true });
  check("the reopen reason is explicit and traceable", c.reason === "RELEVANT_MEANING_OR_CONTEXT_CHANGED");
}

// ─────────────────────────────────────────────────────────────────────────────
group("7 · Cross-tenant and stale-decision refusal (executable where pure)");
{
  const store = new ReviewStore();
  const s = buildReviewSummary({ upload: upload(MAIN), headers: MAIN.headers, dataRows: MAIN.dataRows, store });
  const g = s.groups[0];
  const refused = (fn) => { try { fn(); return null; } catch (e) { return e instanceof Refusal ? e.code : `UNEXPECTED:${e.message}`; } };
  check("cross-tenant: an actor from another company cannot accept this upload's group",
    refused(() => acceptGroup(store, { upload: upload(MAIN), summary: s, group: g, actor: { company_id: "co-B", firm_member_id: "fm-x" }, reason: "x", client_request_id: "rb-1" })) === "UPLOAD_COMPANY_MISMATCH");
  check("stale source: accepting against a summary whose source has since changed is refused (SOURCE_CHANGED)",
    refused(() => acceptGroup(store, { upload: upload(MAIN, { source_digest: "changed-hash" }), summary: s, group: g, actor, reason: "x", client_request_id: "rc-1" })) === "SOURCE_CHANGED");
  // Idempotency: same key, different payload → refused; same key, same payload → safe replay.
  const ok1 = acceptGroup(store, { upload: upload(MAIN), summary: s, group: g, actor, reason: "accepted", client_request_id: "rd-1" });
  const replay = acceptGroup(store, { upload: upload(MAIN), summary: s, group: g, actor, reason: "accepted", client_request_id: "rd-1" });
  check("replay with the same key + same payload is a safe no-op (no duplicate decisions)", replay.reused === true && replay.batch_id === ok1.batch_id);
  const diff = refused(() => acceptGroup(store, { upload: upload(MAIN), summary: s, group: s.groups[1], actor, reason: "different", client_request_id: "rd-1" }));
  check("reusing the same key with a DIFFERENT payload is refused", diff === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
  console.log("        NOT executable here (needs real Postgres/RLS): true auth.uid() identity binding, server-computed account_key, and DB-level append-only immutability — these are asserted against the production RPCs, not this pure prototype.");
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
