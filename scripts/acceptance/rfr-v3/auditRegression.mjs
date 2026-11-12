#!/usr/bin/env node
/**
 * Regression tests for the five defects found by the independent review of 8bb3b1fb9eecf4cb5d564e43299107cea070f398.
 *
 *   node scripts/acceptance/rfr-v3/auditRegression.mjs            current reference model + current runner
 *   node scripts/acceptance/rfr-v3/auditRegression.mjs --audited  the model and runner exactly as audited (read from git)
 *   node scripts/acceptance/rfr-v3/auditRegression.mjs --adapter <adapter.mjs>   an implementation adapter (evaluate())
 *
 * Every case is written in the AUDITED contract's own vocabulary, so the same inputs run against the audited code. Each
 * asserts the CORRECT behaviour, so against the audited code the cases FAIL (that is the reproduction) and against the
 * fixed model, the implementation and the fixed runner they PASS. Exit 0 only when every case passes.
 *
 * D1 missing evidence can pass · D2 an adjustment counts twice · D3 the sandbox runner can manufacture a pass ·
 * D4 evidence passes without the facts a rule requires · D5 reviewed content mixed with refresh timing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDITED_COMMIT = "8bb3b1fb9eecf4cb5d564e43299107cea070f398";
const argv = process.argv.slice(2);
const audited = argv.includes("--audited");
const adapterPath = argv.includes("--adapter") ? argv[argv.indexOf("--adapter") + 1] : null;

// ── locate the code under test ──────────────────────────────────────────────────────────────────────────────────
let dir = HERE;
if (audited) {
  dir = mkdtempSync(join(tmpdir(), "rfr-audited-"));
  for (const f of ["referenceModel.mjs", "cases.mjs", "run.mjs"]) {
    const r = spawnSync("git", ["show", `${AUDITED_COMMIT}:scripts/acceptance/rfr-v3/${f}`], { cwd: resolve(HERE, "../../.."), encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) { console.error(`cannot read ${f} at ${AUDITED_COMMIT}: ${r.stderr}`); process.exit(2); }
    writeFileSync(join(dir, f), r.stdout);
  }
}
const modelUrl = pathToFileURL(adapterPath ? resolve(adapterPath) : join(dir, "referenceModel.mjs")).href;
const mod = await import(modelUrl);
const evaluate = mod.evaluateSync ?? mod.evaluate;
const runner = join(dir, "run.mjs");

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const t = (txt) => { const neg = txt.startsWith("-"); const [w, f = ""] = txt.replace(/^-/, "").replace(/,/g, "").split("."); const v = BigInt(w + f.padEnd(2, "0").slice(0, 2)).toString(); return neg && v !== "0" ? "-" + v : v; };
const P = { start: "2025-07-01", end: "2026-06-30", currency: "TZS", exponent: 2 };
const ev = (kind, facts = {}, extraction = "human_confirmed") => ({ kind, facts, extraction });
const tb = (accounts) => { const total = Object.values(accounts).reduce((a, x) => a + BigInt(x), 0n); const out = Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, { closing: v }])); out.REST = { closing: (-total).toString() }; return { validated: true, accounts: out }; };
const FOOD = t("33,518,793.00");

const results = [];
const check = (id, defect, title, fn) => {
  let errs = [];
  try { errs = fn() ?? []; } catch (e) { errs = [`threw: ${e.message}`]; }
  results.push({ id, defect, title, errs });
};
const notReady = (r, s) => (r.scopes?.[s] ?? "absent") !== "READY";

// ── D1: missing evidence can pass ───────────────────────────────────────────────────────────────────────────────
check("D1-a", "D1", "a balanced TB alone must not clear cash, payables, opening or completeness", () => {
  const r = evaluate({ period: P, tb: tb({ "1010": t("8,500,000.00") }), required_scopes: ["cash:BANK-A", "payables", "opening:cash", "completeness:liabilities"] });
  const e = [];
  if (r.draft_eligible !== true) e.push("drafting must stay available");
  if (r.finalization?.held !== true) e.push(`finalization must be held, got held=${r.finalization?.held}`);
  for (const s of ["cash:BANK-A", "payables", "opening:cash", "completeness:liabilities"]) if (!notReady(r, s)) e.push(`scope ${s} is READY with no evidence`);
  return e;
});
check("D1-b", "D1", "a bank account whose statements cover the period but whose matching and tie were never evaluated is not READY", () => {
  const r = evaluate({ period: P, tb: tb({ "1010": t("8,500,000.00") }), required_scopes: ["cash:BANK-A"],
    banks: [{ id: "BANK-A", ledger_key: "1010", status: "active", statements: [{ file: "a", sha: "a", from: P.start, to: P.end, pages_missing: [], opening: t("4,000,000.00"), rows: [] }] }] });
  return !notReady(r, "cash:BANK-A") || r.finalization?.held !== true ? ["cash:BANK-A cleared although the cash tie was never evaluated"] : [];
});

// ── D2: an adjustment can count twice ───────────────────────────────────────────────────────────────────────────
const E2_TB = tb({ "5607": t("138,798,548.00"), "2000": "0", OBE: t("-305,357,378.30"), "1020": t("65,772,218.34") });
const E2_LEDGER = { snapshot: "g1", accounts: { "5607": "0", "2000": "0", OBE: t("-305,357,378.30"), "1020": t("88,050,597.63"), REST: E2_TB.accounts.REST.closing }, entries: [
  { id: "E-1#1", date: "2025-07-02", account: "5607", amount: FOOD, ref: "001593", links: ["003/2024.2025"] },
  { id: "E-1#2", date: "2025-07-02", account: "1020", amount: "-" + FOOD, ref: "001593", links: ["003/2024.2025"] },
  { id: "AGG-5607", date: "2026-06-30", account: "5607", amount: t("105,279,755.00") }, { id: "AGG-1020", date: "2026-06-30", account: "1020", amount: t("11,240,413.71") }] };
const E2_EV = {
  "EV-NMB": ev("bank_statement", { amount: FOOD, ref: "001593", date: "2025-07-02", counterparty: "ENDUIMET RANGERS ASSOCIATION" }, "reproduced"),
  "EV-V02": ev("approved_fs_note", { amount: FOOD, ref: "003/2024.2025" }), "EV-PV": ev("payment_voucher", { amount: FOOD, ref: "003/2024.2025" }),
  "EV-ERA": ev("supplier_confirmation", { counterparty: "ENDUIMET RANGERS ASSOCIATION", ref: "003/2024.2025", amount: FOOD }), "EV-OBE": ev("opening_journal", { account: "2000", amount: FOOD, date: "2025-06-30", ref: "003/2024.2025" }),
};
const e2 = (extra = {}) => ({
  period: P, tb: E2_TB, ledger: E2_LEDGER, gl_dependent_scopes: ["payables"], required_scopes: ["payables", "opening:payables-food", "ledger"], evidence: E2_EV,
  opening_bridge: { basis: "external_signed_fs", lines: [{ line: "payables-food", approved: "-" + FOOD, accounts: ["2000"], level: "subledger", classification: { kind: "mapping", evidence: ["EV-OBE"] } }],
    proposals: [{ id: "corr:opening:payables-food", line: "payables-food", lines: [{ account: "OBE", amount: FOOD }, { account: "2000", amount: "-" + FOOD }] }] },
  double_charge: { amount: FOOD, cheque: "001593", bill: "003/2024.2025", payee: "ENDUIMET RANGERS ASSOCIATION", payment_evidence: "EV-NMB", gl_entry_id: "E-1#1", expense_account: "5607", payable_account: "2000",
    voucher: "EV-PV", supplier_confirmation: "EV-ERA", approved_fs: "EV-V02", bridge_line: "payables-food", correction_id: "corr:food:003/2024.2025" },
  apply_proposals: ["corr:opening:payables-food", "corr:food:003/2024.2025"],
  approvals: ["corr:opening:payables-food", "corr:food:003/2024.2025"].map((id) => ({ id, proposer: "preparer-1", approver: "reviewer-1", approver_caps: ["review_close"] })),
  ...extra });
check("D2-control", "D2", "control: the single, correct application leaves the payable at zero and is not held", () => {
  const r = evaluate(e2());
  const e = [];
  if (r.balances?.["2000"] !== "0") e.push(`payable ${r.balances?.["2000"]}, expected 0`);
  if (r.balances?.["5607"] !== t("105,279,755.00")) e.push(`5607 ${r.balances?.["5607"]}`);
  if (r.finalization?.held !== false) e.push(`control must not be held: ${r.finalization?.reasons}`);
  return e;
});
check("D2-a", "D2", "the opening correction applied through the proposal path AND a persisted adjustment must not clear readiness", () => {
  const r = evaluate(e2({ reporting_adjustments: [{ id: "adj-persisted-opening", approved: true, lines: [{ account: "OBE", amount: FOOD }, { account: "2000", amount: "-" + FOOD }] }] }));
  const e = [];
  if (r.finalization?.held !== true) e.push(`finalization not held although the payable is ${r.balances?.["2000"]} (credit ${t("33,518,793.00")} left)`);
  if (!notReady(r, "payables")) e.push("payables READY");
  return e;
});
check("D2-b", "D2", "the same persisted adjustment submitted twice is counted once", () => {
  const adj = { id: "corr:dup", approved: true, lines: [{ account: "5300", amount: t("1,000.00") }, { account: "2200", amount: t("-1,000.00") }] };
  const r = evaluate({ period: P, tb: tb({ "5300": t("5,000.00"), "2200": t("-2,000.00") }), reporting_adjustments: [adj, structuredClone(adj)] });
  return r.balances?.["5300"] === t("6,000.00") ? [] : [`5300 is ${r.balances?.["5300"]}, expected 6000.00 (one application)`];
});

// ── D4: evidence passes without the facts a rule requires ───────────────────────────────────────────────────────
const S1_TB = tb({ "5300": t("12,000,000.00"), "2200": "0" });
const s1 = (invoiceFacts, grnFacts) => ({
  period: P, tb: S1_TB, required_scopes: ["completeness:liabilities"],
  ledger: { snapshot: "s1", accounts: { "5300": t("12,000,000.00"), "2200": "0", REST: S1_TB.accounts.REST.closing }, entries: [] },
  cutoff: { search: { from: "2026-07-01", to: "2026-08-14", required_to: "2026-08-14", sources: ["EV-PAYLIST", "EV-INVREG"] },
    items: [{ ref: "INV-7781", grn_ref: "552", amount: t("4,250,000.00"), goods_received: "2026-06-24", evidence: "EV-INV", receipt_evidence: "EV-GRN", expense_account: "5300", accrual_account: "2200" }], ledger_liabilities: [], bank_reconciliation_clean: true },
  evidence: { "EV-PAYLIST": ev("subsequent_payments_listing", { date: "2026-08-14" }), "EV-INVREG": ev("supplier_invoice_register", { date: "2026-08-14" }), "EV-INV": ev("supplier_invoice", invoiceFacts), "EV-GRN": ev("goods_received_note", grnFacts) },
  apply_proposals: ["corr:cutoff:INV-7781"], approvals: [{ id: "corr:cutoff:INV-7781", proposer: "preparer-1", approver: "reviewer-1", approver_caps: ["review_close"] }] });
check("D4-control", "D4", "control: a dated invoice after year end and a dated goods-received note before it are accepted and accrued", () => {
  const r = evaluate(s1({ amount: t("4,250,000.00"), date: "2026-07-14", ref: "INV-7781" }, { date: "2026-06-24", ref: "552" }));
  const e = [];
  if (notReady(r, "completeness:liabilities")) e.push(`control held: ${r.finalization?.reasons}`);
  if (!r.applied_adjustments?.includes("corr:cutoff:INV-7781")) e.push("control correction not applied");
  return e;
});
check("D4-a", "D4", "an invoice with no date must not satisfy the subsequent-period date window", () => {
  const r = evaluate(s1({ amount: t("4,250,000.00") }, { date: "2026-06-24" }));
  const e = [];
  if (!notReady(r, "completeness:liabilities")) e.push("completeness:liabilities READY on an undated invoice");
  if (r.applied_adjustments?.includes("corr:cutoff:INV-7781")) e.push("a correction was applied from an undated invoice");
  return e;
});
check("D4-b", "D4", "the goods-received date must come from the evidence, not from a field the caller typed", () => {
  const r = evaluate(s1({ amount: t("4,250,000.00"), date: "2026-07-14" }, {}));
  return notReady(r, "completeness:liabilities") ? [] : ["cut-off cleared with a goods-received note that states no date"];
});
const openingDiff = (docFacts, kind = "opening_journal", cls = "mapping") => ({
  period: P, tb: tb({ "1010": t("9,000,000.00") }), required_scopes: ["opening:cash"],
  ledger: { snapshot: "g", accounts: { "1010": t("9,000,000.00"), REST: t("-9,000,000.00") }, entries: [] },
  opening_bridge: { basis: "external_signed_fs", lines: [{ line: "cash", approved: t("8,000,000.00"), accounts: ["1010"], level: "account", classification: { kind: cls, evidence: ["EV-X"] } }] },
  evidence: { "EV-X": ev(kind, docFacts) } });
check("D4-c", "D4", "a document of the right type with no account, period or amount does not explain an opening difference", () => {
  const r = evaluate(openingDiff({}));
  return notReady(r, "opening:cash") ? [] : ["opening difference accepted on a document that states nothing about the difference"];
});
check("D4-d", "D4", "a document naming a different amount does not explain an opening difference", () => {
  const r = evaluate(openingDiff({ amount: t("500,000.00"), account: "1010", date: "2025-06-30" }));
  return notReady(r, "opening:cash") ? [] : ["opening difference accepted on a document with the wrong amount"];
});
check("D4-e", "D4", "AI extraction or human confirmation does not establish relevance on its own", () => {
  const r = evaluate({ ...openingDiff({}), evidence: { "EV-X": ev("opening_journal", { note: "looks right" }, "reproduced") } });
  return notReady(r, "opening:cash") ? [] : ["a 'reproduced' document with no relevant facts cleared the difference"];
});

// ── D5: reviewed content mixed with refresh timing ──────────────────────────────────────────────────────────────
check("D5-a", "D5", "a source-freshness record of unknown age cannot clear a QuickBooks-bound finalization", () => {
  const r = evaluate({ period: P, tb: tb({}), freshness: { source: "qbo", reconfirmed: true, tb_hash_bound: "h1", tb_hash_now: "h1", pulled_at: "2020-01-01T00:00:00Z" } });
  return r.finalization?.held === true ? [] : ["a freshness boolean with no expiry and no binding to the reviewed content cleared finalization"];
});

// ── D3: the sandbox runner can manufacture a pass ───────────────────────────────────────────────────────────────
function runSandbox(name, files, manifest) {
  const d = mkdtempSync(join(tmpdir(), `rfr-sbx-${name}-`));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  writeFileSync(join(d, "manifest.json"), JSON.stringify(manifest));
  const r = spawnSync(process.execPath, [runner, "--sandbox", join(d, "manifest.json")], { encoding: "utf8" });
  return r.status;
}
const HEAD = "account_id,currency,opening_minor,debit_minor,credit_minor,closing_minor,entry_count\n";
const META = { environment: "sandbox", realm_sha256: "a".repeat(64), period_start: "2025-07-01", period_end: "2026-06-30", accounting_method: "Accrual", operator: "tester", pulled_at: "2026-11-01T10:00:00Z" };
const notPass = (code) => (code === 0 ? ["the sandbox proof reported PASS (exit 0)"] : []);
check("D3-a", "D3", "the same header-only CSV twice with dummy metadata must not pass", () =>
  notPass(runSandbox("a", { "x.csv": HEAD }, { environment: "sandbox", realm_sha256: "x", period_start: "x", period_end: "x", accounting_method: "x", operator: "x", pulled_at: "x", connector_file: "x.csv", independent_export_file: "x.csv" })));
check("D3-b", "D3", "two distinct header-only CSVs with valid metadata must not pass (empty inputs)", () =>
  notPass(runSandbox("b", { "a.csv": HEAD, "b.csv": HEAD + "\n" }, { ...META, connector_file: "a.csv", independent_export_file: "b.csv" })));
const ROW = "1020,TZS,0,100,0,100,1\n";
check("D3-c", "D3", "the same file supplied as connector output and as the 'independent' export must not pass", () =>
  notPass(runSandbox("c", { "a.csv": HEAD + ROW }, { ...META, connector_file: "a.csv", independent_export_file: "a.csv" })));
check("D3-d", "D3", "duplicate account keys inside a file must not pass", () =>
  notPass(runSandbox("d", { "a.csv": HEAD + ROW + ROW, "b.csv": HEAD + ROW + ROW }, { ...META, connector_file: "a.csv", independent_export_file: "b.csv" })));
check("D3-e", "D3", "matching files with no independent provenance and no recorded run must not pass", () =>
  notPass(runSandbox("e", { "a.csv": HEAD + ROW, "b.csv": HEAD + ROW }, { ...META, connector_file: "a.csv", independent_export_file: "b.csv" })));

// ── report ──────────────────────────────────────────────────────────────────────────────────────────────────────
const label = adapterPath ? `adapter ${adapterPath}` : audited ? `AUDITED ${AUDITED_COMMIT.slice(0, 7)}` : "current reference model + runner";
console.log(`AUDIT REGRESSION (${label}): each case asserts the corrected behaviour.\n`);
for (const r of results) console.log(`${r.errs.length ? "FAIL" : "ok  "} ${r.id} [${r.defect}] ${r.title}${r.errs.length ? "\n       " + r.errs.join("\n       ") : ""}`);
const failed = results.filter((r) => r.errs.length);
const byDefect = {};
for (const r of results) (byDefect[r.defect] ??= { pass: 0, fail: 0 })[r.errs.length ? "fail" : "pass"]++;
console.log("\n" + Object.entries(byDefect).map(([d, c]) => `${d}: ${c.pass} pass / ${c.fail} fail`).join("   "));
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
