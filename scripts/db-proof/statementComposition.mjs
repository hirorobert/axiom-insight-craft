#!/usr/bin/env bun
// Real-PostgreSQL proof of statement composition (20261018100000): the statements are composed BY THE DATABASE from the
// authoritative reporting input (real process-trial-balance certifications, approved Close Review adjustments) and the
// reviewed presentation assignments, with every figure traceable.
//
// The expected statements below were computed BY HAND from the synthetic trial balances (literals in this file; nothing
// is read back from the function under test to build them). They are an independent check of the arithmetic and the
// presentation rules — not an accounting validation by a qualified reviewer.
//
//   vocabulary     the seeded lines equal the TypeScript pack (src/lib/frameworkPacks), version included
//   edition        the SQL decision equals the TypeScript decision table; elections need approve_certification and a
//                  jurisdiction confirmation; history is append-only
//   assignments    prepare_close only; rollout and kill switch; idempotent per request; unknown lines refused; another
//                  workspace refused; append-only; a withdrawal is a new event
//   composition    exact lines and totals for the current year and the comparative; nothing composed for an unassigned,
//                  incompatible or unpresentable account (totals null, never zero; blockers stated); the 5.11 single
//                  basis; lineage to account, certification, certified amount, adjustments and assignment; approved
//                  adjustments flow through as a layer; the identity is deterministic and moves with what it rests on
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/statementComposition.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_LINES_VERSION } from "../../src/lib/frameworkPacks/ifrsForSmes.ts";
import { resolveIfrsForSmesEdition } from "../../src/lib/frameworkPacks/editionPolicy.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const COMPOSITION_FILE = "20261018100000_fs_statement_composition.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 1200)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}
async function refused(name, code, fn, text) {
  try { await fn(); record(name, false, "was not refused"); }
  catch (e) { record(name, e.code === code && (!text || String(e.message).includes(text)), `expected ${code}${text ? ` ${text}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`); }
}

let pool, admin, server = null, dir = null;
async function startDatabase() {
  if ((process.env.DB_PROOF_MODE ?? "embedded") === "external") {
    const conn = process.env.DB_PROOF_CONN ?? "";
    const u = new URL(conn);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || conn.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a loopback database");
    return conn;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-composition-proof-"));
  const port = 57000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE composition_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/composition_proof`;
}
async function stopDatabase() {
  const step = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await step(pool?.end() ?? Promise.resolve()); await step(admin?.end() ?? Promise.resolve());
  if (server) await step(server.stop());
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
}
async function asRole(role, uid, sql, params) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, params); await c.query("COMMIT"); return r.rows;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
const asUser = async (uid, sql, p) => (await asRole("authenticated", uid, sql, p))[0];
const asService = async (sql, p) => (await asRole("service_role", null, sql, p))[0];
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);

// ── Synthetic trial balances (balanced; amounts in TZS, two decimals) ───────────────────────────────────────────────
// code, name, classification, statement, normal balance, FY2026 debit, FY2026 credit, FY2025 debit, FY2025 credit
const TB = [
  ["1000", "Bank", "current_assets", "balance_sheet", "debit", "12500.00", "", "8000.00", ""],
  ["1100", "Trade receivables", "current_assets", "balance_sheet", "debit", "4300.00", "", "3000.00", ""],
  ["1200", "Inventory", "current_assets", "balance_sheet", "debit", "2200.00", "", "1800.00", ""],
  ["1500", "Equipment at cost", "non_current_assets", "balance_sheet", "debit", "20000.00", "", "20000.00", ""],
  ["1510", "Accumulated depreciation", "non_current_assets", "balance_sheet", "credit", "", "6000.00", "", "4000.00"],
  ["2000", "Trade payables", "current_liabilities", "balance_sheet", "credit", "", "3100.00", "", "2500.00"],
  ["2100", "Income tax payable", "current_liabilities", "balance_sheet", "credit", "", "900.00", "", "700.00"],
  ["2500", "Bank loan", "non_current_liabilities", "balance_sheet", "credit", "", "8000.00", "", "9000.00"],
  ["3000", "Share capital", "equity", "balance_sheet", "credit", "", "10000.00", "", "10000.00"],
  ["3100", "Retained earnings", "equity", "balance_sheet", "credit", "", "5900.00", "", "3500.00"],
  ["4000", "Sales", "revenue", "income_statement", "credit", "", "30000.00", "", "25000.00"],
  ["4100", "Interest income", "other_income", "income_statement", "credit", "", "500.00", "", "400.00"],
  ["5000", "Cost of sales", "cost_of_goods_sold", "income_statement", "debit", "14000.00", "", "11500.00", ""],
  ["6000", "Salaries", "operating_expenses", "income_statement", "debit", "5500.00", "", "5000.00", ""],
  ["6100", "Rent", "operating_expenses", "income_statement", "debit", "2400.00", "", "2400.00", ""],
  ["6200", "Depreciation", "operating_expenses", "income_statement", "debit", "2000.00", "", "2000.00", ""],
  ["6300", "Interest expense", "operating_expenses", "income_statement", "debit", "600.00", "", "700.00", ""],
  ["7000", "Income tax expense", "taxes", "income_statement", "debit", "900.00", "", "700.00", ""],
];
const csv = (yearCol) => "Account code,Account name,Debit,Credit\n" + TB.map((r) => `${r[0]},${r[1]},${r[yearCol]},${r[yearCol + 1]}`).join("\n") + "\n";
const ASSIGN = {
  1000: "sfp.cash_and_cash_equivalents", 1100: "sfp.trade_and_other_receivables", 1200: "sfp.inventories",
  1500: "sfp.property_plant_and_equipment", 1510: "sfp.property_plant_and_equipment",
  2000: "sfp.trade_and_other_payables", 2100: "sfp.current_tax", 2500: "sfp.other_financial_liabilities",
  3000: "sfp.equity_attributable_to_owners", 3100: "sfp.equity_attributable_to_owners",
  4000: "sci.revenue", 4100: "sci.other_income", 5000: "sci.cost_of_sales",
  6000: "sci.operating_expenses_by_function", 6100: "sci.operating_expenses_by_function", 6200: "sci.operating_expenses_by_function",
  6300: "sci.finance_costs", 7000: "sci.tax_expense",
};

// Hand-computed expectations (minor units). FY2026 / FY2025.
const EXPECT_LINES = [
  // statement, section, lineId, current, comparative
  ["SFP", "non_current_assets", "sfp.property_plant_and_equipment", "1400000", "1600000"],
  ["SFP", "current_assets", "sfp.cash_and_cash_equivalents", "1250000", "800000"],
  ["SFP", "current_assets", "sfp.trade_and_other_receivables", "430000", "300000"],
  ["SFP", "current_assets", "sfp.inventories", "220000", "180000"],
  ["SFP", "equity", "sfp.equity_attributable_to_owners", "1590000", "1350000"],
  ["SFP", "non_current_liabilities", "sfp.other_financial_liabilities", "800000", "900000"],
  ["SFP", "current_liabilities", "sfp.trade_and_other_payables", "310000", "250000"],
  ["SFP", "current_liabilities", "sfp.current_tax", "90000", "70000"],
  ["SCI", "sci", "sci.revenue", "3000000", "2500000"],
  ["SCI", "sci", "sci.other_income", "50000", "40000"],
  ["SCI", "sci", "sci.cost_of_sales", "1400000", "1150000"],
  ["SCI", "sci", "sci.operating_expenses_by_function", "990000", "940000"],
  ["SCI", "sci", "sci.finance_costs", "60000", "70000"],
  ["SCI", "sci", "sci.tax_expense", "90000", "70000"],
];
const EXPECT_TOTALS = {
  current: { nonCurrentAssetsMinor: "1400000", currentAssetsMinor: "1900000", totalAssetsMinor: "3300000", currentLiabilitiesMinor: "400000",
    nonCurrentLiabilitiesMinor: "800000", totalLiabilitiesMinor: "1200000", equityAccountsMinor: "1590000", incomeMinor: "3050000",
    expensesExcludingTaxMinor: "2450000", profitBeforeTaxMinor: "600000", taxExpenseMinor: "90000", profitOrLossMinor: "510000",
    totalEquityMinor: "2100000", totalEquityAndLiabilitiesMinor: "3300000", balanceDifferenceMinor: "0" },
  comparative: { nonCurrentAssetsMinor: "1600000", currentAssetsMinor: "1280000", totalAssetsMinor: "2880000", currentLiabilitiesMinor: "320000",
    nonCurrentLiabilitiesMinor: "900000", totalLiabilitiesMinor: "1220000", equityAccountsMinor: "1350000", incomeMinor: "2540000",
    expensesExcludingTaxMinor: "2160000", profitBeforeTaxMinor: "380000", taxExpenseMinor: "70000", profitOrLossMinor: "310000",
    totalEquityMinor: "1660000", totalEquityAndLiabilitiesMinor: "2880000", balanceDifferenceMinor: "0" },
};

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 30 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  group("Replay");
  await check(`${COMPOSITION_FILE} is in the chain and the whole chain applies`, async () => {
    if (!files.includes(COMPOSITION_FILE)) return `${COMPOSITION_FILE} missing`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]} @${e.position ?? ""} ${e.where ?? ""}`.slice(0, 600); }
    }
    return true;
  });
  await refused("re-applying is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, COMPOSITION_FILE)), "PREFLIGHT_REFUSED");

  group("Vocabulary — the seeded lines are the TypeScript pack's");
  await check("every line (id, statement, label, requirement, natures, position, order) and the lines version are identical", async () => {
    const rows = (await admin.query("SELECT lines_version, line_id, statement, label, requirement_id, natures, position, sort_order FROM public.fs_presentation_lines ORDER BY sort_order")).rows;
    const want = IFRS_FOR_SMES_2015.lines.map((l, i) => ({ lines_version: IFRS_FOR_SMES_LINES_VERSION, line_id: l.id, statement: l.statement, label: l.label,
      requirement_id: l.requirementId, natures: [...l.natures], position: l.position ?? null, sort_order: i + 1 }));
    return JSON.stringify(rows) === JSON.stringify(want) ? true : { got: rows.slice(0, 2), want: want.slice(0, 2), n: [rows.length, want.length] };
  });
  await refused("the vocabulary is immutable", "42501", () => admin.query("UPDATE public.fs_presentation_lines SET label='x'"));

  group("Edition — the SQL decision equals the TypeScript table");
  await check("for every row of the decision table, _fs_smes_edition_decide == resolveIfrsForSmesEdition (elected = confirmed election)", async () => {
    const C = { edition: "2025", jurisdictionConfirmation: "Regulator circular ref. X/2026" };
    const rows = [[null, null], ["2016-12-31", null], ["2017-01-01", null], ["2025-07-01", null], ["2026-12-31", null], ["2026-01-01", C], ["2027-01-01", null], ["2027-01-01", C], ["2031-04-01", null]];
    const bad = [];
    for (const [start, el] of rows) {
      const ts = resolveIfrsForSmesEdition(start, el);
      const tsKey = ts.state === "refused" ? `refused:${ts.reason}` : `${ts.pack.id}${ts.earlyApplication ? "+early" : ""}`;
      const sq = (await one("SELECT public._fs_smes_edition_decide('ifrs_for_smes', $1::date, $2) d", [start, el !== null])).d;
      const sqKey = sq.state === "refused" ? `refused:${sq.reason}` : `${sq.packId}${sq.earlyApplication ? "+early" : ""}`;
      if (tsKey !== sqKey) bad.push({ start, el: !!el, tsKey, sqKey });
    }
    const other = (await one("SELECT public._fs_smes_edition_decide('full_ifrs', '2026-01-01', false) d")).d;
    return bad.length === 0 && other.reason === "FRAMEWORK_NOT_IFRS_FOR_SMES" ? true : { bad, other };
  });

  // Users, workspaces, members.
  const U = { owner: uuid(), preparer: uuid(), partner: uuid(), viewer: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Synthetic SME','ifrs_for_smes') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Other workspace','ifrs_for_smes') RETURNING id", [U.ownerB])).id;
  const F = (await one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Full IFRS entity','full_ifrs') RETURNING id", [U.owner])).id;
  for (const k of ["preparer", "partner", "viewer"]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  const rollout = (company, on) => asService("SELECT public.fs_set_company_rollout($1,$2,'proof rollout change','proof')", [company, on]);

  // Certified trial balances through the real engine.
  const ptb = (await loadFunctionTree(REPO, "process-trial-balance")).handler;
  const upload = async (company, y, text) => {
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [company, `${y}-12-31`, `FY${y}`, U.owner, `${y}-01-01`])).id;
    const filePath = `${U.owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, company, y, pid, U.owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return { id, year: y };
  };
  const decisions = TB.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE",
    decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === "1000" }));
  const certify = async (company, u) => {
    const r = await call(ptb, pool, mintTestJwt(U.owner), { uploadId: u.id, clientRequestId: uuid() });
    const c = await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [company, u.year]);
    if (!c) throw new Error(`not certified: ${JSON.stringify(r.body).slice(0, 300)}`);
    return c.id;
  };
  const prior = await upload(A, 2025, csv(7));
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, prior.id, uuid(), JSON.stringify(decisions)]);
  const cur = await upload(A, 2026, csv(5));
  let priorCert, curCert;
  group("Setup — two years certified by the real engine");
  await check("FY2025 and FY2026 certify (authoritative, exact)", async () => {
    priorCert = await certify(A, prior); curCert = await certify(A, cur);
    return priorCert && curCert ? true : "no";
  });

  const compose = (uid, company = A, y = 2026) => asUser(uid, "SELECT public.fs_statement_composition($1,$2) r", [company, y]).then((r) => r.r);
  const assign = (uid, pairs, { company = A, request = uuid(), reason = "Presentation per the chart of accounts" } = {}) =>
    asUser(uid, "SELECT public.fs_assign_presentation($1,$2::jsonb,$3,$4) r", [company, JSON.stringify(pairs), reason, request]).then((r) => r.r);
  const pairs = (map) => Object.entries(map).map(([k, line]) => ({ accountKey: String(k), lineId: line }));

  group("Assignments — authority, rollout, idempotency, history");
  await check("rollout off: nothing recorded (feature_disabled); composition unavailable", async () => {
    const r = await assign(U.preparer, pairs({ 1000: ASSIGN[1000] }));
    const c = await compose(U.owner);
    return r.outcome === "feature_disabled" && c.state === "unavailable" && (await count("SELECT count(*) n FROM public.fs_presentation_assignments")) === 0 ? true : { r, c };
  });
  await rollout(A, true); await rollout(B, true); await rollout(F, true);
  await check("a member without prepare_close is refused (forbidden); another workspace's owner too", async () => {
    const a = await assign(U.viewer, pairs({ 1000: ASSIGN[1000] }));
    const b = await assign(U.ownerB, pairs({ 1000: ASSIGN[1000] }));
    return a.outcome === "forbidden" && b.outcome === "forbidden" ? true : { a, b };
  });
  await check("an unknown line is refused, naming it; nothing recorded", async () => {
    const r = await assign(U.preparer, [{ accountKey: "1000", lineId: "sfp.made_up" }]);
    return r.outcome === "unknown_line" && r.lineId === "sfp.made_up" && (await count("SELECT count(*) n FROM public.fs_presentation_assignments")) === 0 ? true : r;
  });
  await check("malformed batches are refused (duplicate account, missing lineId key, empty)", async () => {
    const a = await assign(U.preparer, [{ accountKey: "1000", lineId: null }, { accountKey: "1000", lineId: null }]);
    const b = await assign(U.preparer, [{ accountKey: "1000" }]);
    const c = await assign(U.preparer, []);
    return [a, b, c].every((x) => x.outcome === "invalid_request") ? true : { a, b, c };
  });
  await check("a framework other than IFRS for SMEs is refused", async () => (await assign(U.owner, pairs({ 1000: ASSIGN[1000] }), { company: F })).outcome === "framework_not_ifrs_for_smes" ? true : "allowed");

  group("Composition — nothing presented before assignment");
  await check("every account unassigned: no lines, totals incomplete (null, never zero), PRESENTATION_UNASSIGNED:18", async () => {
    const c = await compose(U.viewer);
    return c.state === "composed" && c.lines.length === 0 && c.totals.current.state === "incomplete" && c.totals.current.notPresented === 18
      && c.totals.current.totalAssetsMinor === undefined && JSON.stringify(c.blockers) === JSON.stringify(["PRESENTATION_UNASSIGNED:18"]) ? true : { lines: c.lines.length, totals: c.totals, blockers: c.blockers };
  });

  let request, firstAssign, composed;
  await check("the preparer assigns all eighteen accounts in one request; the actor is the user and the firm member", async () => {
    request = uuid();
    firstAssign = await assign(U.preparer, pairs(ASSIGN), { request });
    const member = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.preparer])).id;
    const rows = (await admin.query("SELECT DISTINCT actor_user_id, firm_member_id FROM public.fs_presentation_assignments")).rows;
    return firstAssign.outcome === "recorded" && firstAssign.count === 18 && rows.length === 1 && rows[0].actor_user_id === U.preparer && rows[0].firm_member_id === member ? true : { firstAssign, rows };
  });
  await check("a retried request answers its outcome without recording again; other content under the same id is refused", async () => {
    const a = await assign(U.preparer, pairs(ASSIGN), { request });
    const b = await assign(U.preparer, pairs({ 1000: ASSIGN[1100] }), { request });
    return a.outcome === "recorded" && a.replay === true && b.outcome === "request_reused" && (await count("SELECT count(*) n FROM public.fs_presentation_assignments")) === 18 ? true : { a, b };
  });
  await check("assigning the same lines again records nothing (unchanged)", async () => (await assign(U.preparer, pairs(ASSIGN))).outcome === "unchanged" ? true : "recorded");

  group("Composition — exact figures (hand-computed) for both years");
  await check("FY2026 and FY2025 lines equal the hand-computed amounts; nothing else is presented", async () => {
    composed = await compose(U.viewer);
    const got = composed.lines.map((l) => [l.statement, l.section, l.lineId, l.current.amountMinor, l.comparative?.amountMinor ?? null]);
    return composed.state === "composed" && JSON.stringify(got) === JSON.stringify(EXPECT_LINES) ? true : { got };
  });
  await check("totals equal the hand-computed totals; the statement of financial position balances in both years; no blocker", async () => {
    const strip = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "state").sort(([a], [b]) => (a < b ? -1 : 1)));
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    return composed.totals.current.state === "complete" && composed.totals.comparative.state === "complete"
      && JSON.stringify(strip(composed.totals.current)) === JSON.stringify(sorted(EXPECT_TOTALS.current))
      && JSON.stringify(strip(composed.totals.comparative)) === JSON.stringify(sorted(EXPECT_TOTALS.comparative))
      && composed.blockers.length === 0 && composed.accountsNotPresented.length === 0 ? true : { totals: composed.totals, blockers: composed.blockers };
  });
  await check("pinned: the 2015 edition (period starting 2026-01-01), lines 1.0.0, the reporting input's identity, both certifications", async () => {
    const input = (await asUser(U.owner, "SELECT public.fs_reporting_input($1,2026) r", [A])).r;
    return composed.contract === "fs-statement-composition/2" && composed.pack.packId === "ifrs-for-smes/2015" && composed.pack.earlyApplication === false
      && composed.pack.linesVersion === IFRS_FOR_SMES_LINES_VERSION && composed.inputSha256 === input.inputSha256
      && composed.current.certificationId === curCert && composed.comparative.certificationId === priorCert && composed.comparative.state === "available" ? true : { pack: composed.pack, current: composed.current, comparative: composed.comparative };
  });
  await check("lineage: PPE traces to its two accounts in each year — certification, certified amount, assignment event — and sums exactly", async () => {
    const ppe = composed.lines.find((l) => l.lineId === "sfp.property_plant_and_equipment");
    const asg = (await admin.query("SELECT account_key, id FROM public.fs_presentation_assignments WHERE account_key IN ('1500','1510')")).rows;
    const byKey = Object.fromEntries(asg.map((r) => [r.account_key, r.id]));
    const want = [
      { period: "current", accountKey: "1500", certificationId: curCert, amountMinor: "2000000", certifiedAmountMinor: "2000000" },
      { period: "current", accountKey: "1510", certificationId: curCert, amountMinor: "-600000", certifiedAmountMinor: "-600000" },
      { period: "comparative", accountKey: "1500", certificationId: priorCert, amountMinor: "2000000", certifiedAmountMinor: "2000000" },
      { period: "comparative", accountKey: "1510", certificationId: priorCert, amountMinor: "-400000", certifiedAmountMinor: "-400000" },
    ];
    const got = ppe.lineage.map((x) => ({ period: x.period, accountKey: x.accountKey, certificationId: x.certificationId, amountMinor: x.amountMinor, certifiedAmountMinor: x.certifiedAmountMinor }));
    return JSON.stringify(got) === JSON.stringify(want) && ppe.lineage.every((x) => x.assignmentId === byKey[x.accountKey] && x.adjustmentIds.length === 0) ? true : { got };
  });
  await check("the identity is deterministic: composing again gives the same compositionSha256", async () => {
    const again = await compose(U.owner);
    return /^[0-9a-f]{64}$/.test(composed.compositionSha256) && again.compositionSha256 === composed.compositionSha256 ? true : [composed.compositionSha256, again.compositionSha256];
  });

  group("Composition — presentation rules (nothing composed that should not be)");
  await check("a payable on an asset line is incompatible: not presented, totals incomplete, PRESENTATION_INCOMPATIBLE:1", async () => {
    await assign(U.preparer, pairs({ 2000: "sfp.trade_and_other_receivables" }));
    const c = await compose(U.owner);
    const bad = c.accountsNotPresented.filter((a) => a.period === "current");
    const ok = c.blockers.includes("PRESENTATION_INCOMPATIBLE:1") && c.totals.current.state === "incomplete" && bad.length === 1 && bad[0].accountKey === "2000" && bad[0].status === "incompatible";
    await assign(U.preparer, pairs({ 2000: ASSIGN[2000] }));
    return ok ? true : { blockers: c.blockers, bad };
  });
  await check("bank on property, plant and equipment (a non-current line) is incompatible with a current classification", async () => {
    await assign(U.preparer, pairs({ 1000: "sfp.property_plant_and_equipment" }));
    const c = await compose(U.owner);
    await assign(U.preparer, pairs({ 1000: ASSIGN[1000] }));
    return c.blockers.includes("PRESENTATION_INCOMPATIBLE:1") ? true : c.blockers;
  });
  await check("5.11: one expense in a nature line while the others are by function → EXPENSE_ANALYSIS_MIXED", async () => {
    await assign(U.preparer, pairs({ 6000: "sci.employee_benefits_expense" }));
    const c = await compose(U.owner);
    await assign(U.preparer, pairs({ 6000: ASSIGN[6000] }));
    return c.blockers.includes("EXPENSE_ANALYSIS_MIXED") && c.totals.current.state === "complete" ? true : c.blockers;
  });
  await check("a withdrawal is a new event (history kept); the account becomes unassigned again", async () => {
    const before = await count("SELECT count(*) n FROM public.fs_presentation_assignments WHERE account_key='4100'");
    await assign(U.preparer, [{ accountKey: "4100", lineId: null }], { reason: "Re-presenting interest income" });
    const c = await compose(U.owner);
    const after = await count("SELECT count(*) n FROM public.fs_presentation_assignments WHERE account_key='4100'");
    await assign(U.preparer, pairs({ 4100: ASSIGN[4100] }));
    return after === before + 1 && c.blockers.includes("PRESENTATION_UNASSIGNED:1") ? true : { before, after, blockers: c.blockers };
  });
  await check("the identity moves with the assignments it rests on, and every changed composition is a distinct identity", async () => {
    const now = await compose(U.owner);
    return now.compositionSha256 !== composed.compositionSha256 && JSON.stringify(now.lines.map((l) => [l.lineId, l.current.amountMinor])) === JSON.stringify(composed.lines.map((l) => [l.lineId, l.current.amountMinor])) ? true : "unchanged identity";
  });

  group("Composition — approved adjustments flow through as a layer");
  await check("an approved rent accrual (300.00) changes rent, payables, profit and equity exactly; certified amounts and lineage show it", async () => {
    const L = (k, d, c) => ({ accountKey: k, debitMinor: String(d), creditMinor: String(c) });
    const p = (await asUser(U.preparer, "SELECT public.close_review_propose_adjustment($1,2026,'Rent accrual for December',NULL,$2::jsonb,'{}'::uuid[],$3,NULL) r", [A, JSON.stringify([L("6100", 30000, 0), L("2000", 0, 30000)]), uuid()])).r;
    const pending = await compose(U.owner);
    const d = (await asUser(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed to the lease',NULL,$2) r", [p.adjustmentId, uuid()])).r;
    const c = await compose(U.owner);
    const line = (x, id) => x.lines.find((l) => l.lineId === id).current.amountMinor;
    const rent = c.lines.find((l) => l.lineId === "sci.operating_expenses_by_function").lineage.find((x) => x.period === "current" && x.accountKey === "6100");
    return d.outcome === "recorded" && line(pending, "sci.operating_expenses_by_function") === "990000"
      && line(c, "sci.operating_expenses_by_function") === "1020000" && line(c, "sfp.trade_and_other_payables") === "340000"
      && c.totals.current.profitOrLossMinor === "480000" && c.totals.current.totalEquityMinor === "2070000" && c.totals.current.balanceDifferenceMinor === "0"
      && rent.amountMinor === "270000" && rent.certifiedAmountMinor === "240000" && JSON.stringify(rent.adjustmentIds) === JSON.stringify([p.adjustmentId])
      && c.inputSha256 !== pending.inputSha256 && c.compositionSha256 !== pending.compositionSha256 ? true : { d, totals: c.totals.current, rent };
  });

  group("Edition elections");
  const elect = (uid, on, conf = "Regulator circular ref. X/2026", company = A) =>
    asUser(uid, "SELECT public.fs_elect_early_application($1,2026,$2,$3,'Elected by the board') r", [company, on, conf]).then((r) => r.r);
  await check("only approve_certification elects; a confirmation is required; recorded → the third edition, early", async () => {
    const a = await elect(U.preparer, true);
    const b = await elect(U.owner, true, " ");
    const c = await elect(U.owner, true);
    const d = await elect(U.owner, true);
    const comp = await compose(U.owner);
    return a.outcome === "forbidden" && b.outcome === "invalid_request" && c.outcome === "recorded" && d.outcome === "unchanged"
      && comp.pack.packId === "ifrs-for-smes/2025" && comp.pack.earlyApplication === true ? true : { a, b, c, d, pack: comp.pack };
  });
  await check("withdrawn → back to the 2015 edition; both events kept", async () => {
    const w = await elect(U.owner, false);
    const comp = await compose(U.owner);
    return w.outcome === "recorded" && comp.pack.packId === "ifrs-for-smes/2015" && (await count("SELECT count(*) n FROM public.fs_framework_elections")) === 2 ? true : { w, pack: comp.pack };
  });
  await check("a framework other than IFRS for SMEs: the election is refused and nothing is composed (edition_unresolved)", async () => {
    const e = await elect(U.owner, true, "ref", F);
    const fp = await upload(F, 2026, csv(5));
    await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [F, fp.id, uuid(), JSON.stringify(decisions)]);
    await certify(F, fp);
    const c = await compose(U.owner, F);
    return e.outcome === "framework_not_ifrs_for_smes" && c.state === "edition_unresolved" && c.reason === "FRAMEWORK_NOT_IFRS_FOR_SMES" ? true : { e, c };
  });

  group("Tenancy, kill switch, append-only");
  await check("another workspace's owner reads nothing (unavailable)", async () => (await compose(U.ownerB)).state === "unavailable" ? true : "readable");
  await check("kill switch engaged: composition unavailable and assignments refused", async () => {
    await asService("SELECT public.fs_set_kill_switch(true,'proof kill switch','proof')");
    const c = await compose(U.owner);
    const a = await assign(U.preparer, pairs({ 4100: "sci.revenue" }));
    await asService("SELECT public.fs_set_kill_switch(false,'proof kill switch off','proof')");
    return c.state === "unavailable" && a.outcome === "feature_disabled" ? true : { c: c.state, a };
  });
  for (const [label, sql] of [["updated", "UPDATE public.fs_presentation_assignments SET reason='x'"], ["deleted", "DELETE FROM public.fs_presentation_assignments"],
    ["truncated", "TRUNCATE public.fs_presentation_assignments"], ["election updated", "UPDATE public.fs_framework_elections SET reason='x'"]]) {
    await refused(`assignments/elections cannot be ${label} — not even by the database owner`, "42501", () => admin.query(sql));
  }
  await refused("clients cannot insert assignments directly", "42501", () => asRole("authenticated", U.preparer, "INSERT INTO public.fs_presentation_assignments (company_id, pack_family, account_key, line_id, reason, actor_user_id, request_id, batch_ordinal) VALUES ($1,'ifrs-for-smes','1000','sfp.inventories','x y z',$2,$3,0)", [A, U.preparer, uuid()]));
  await refused("anon cannot compose", "42501", () => asRole("anon", null, "SELECT public.fs_statement_composition($1,2026)", [A]));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "STATEMENT_COMPOSITION: ALL PASSED" : "STATEMENT_COMPOSITION: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
