// Shared harness for the reporting proofs (statement composition, notes and schedules, comparatives, sign-off): one
// throwaway PostgreSQL (embedded, or an EMPTY loopback database in CI), the whole migration chain, synthetic workspaces
// and members, and trial balances certified by the REAL process-trial-balance handler. Nothing here asserts anything.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadFunctionTree, mintTestJwt, shim } from "./functionHarness.mjs";
import { currentChain, migrationSql } from "./parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
export const uuid = () => crypto.randomUUID();

// ── Results ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function reporter() {
  const results = [];
  let currentGroup = "";
  const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
  const record = (name, ok, detail = "") => { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); };
  const check = async (name, fn) => {
    try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 1200)}`); }
    catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
  };
  const refused = async (name, code, fn, text) => {
    try { await fn(); record(name, false, "was not refused"); }
    catch (e) { record(name, e.code === code && (!text || String(e.message).includes(text)), `expected ${code}${text ? ` ${text}` : ""}, got ${e.code}: ${String(e.message).split("\n")[0]}`); }
  };
  const finish = (label, crashed) => {
    const failed = results.filter((r) => !r.ok);
    console.log("\n──────────────────────────────────────────");
    console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
    for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
    const ok = !crashed && failed.length === 0 && results.length > 0;
    console.log(ok ? `${label}: ALL PASSED` : `${label}: FAILED`);
    return ok;
  };
  return { group, check, refused, finish };
}

// ── Database ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function openDatabase(name) {
  let server = null, dir = null, url;
  if ((process.env.DB_PROOF_MODE ?? "embedded") === "external") {
    url = process.env.DB_PROOF_CONN ?? "";
    const u = new URL(url);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a loopback database");
  } else {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfoclose-${name}-`));
    const port = 56000 + Math.floor(Math.random() * 3000);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
    await boot.connect(); await boot.query(`CREATE DATABASE ${name}`); await boot.end();
    url = `postgres://postgres:postgres@localhost:${port}/${name}`;
  }
  const admin = new Client({ connectionString: url }); await admin.connect();
  const pool = new Pool({ connectionString: url, max: 30 });
  // readOnly: the transaction PostgREST opens for a STABLE or IMMUTABLE function (BEGIN READ ONLY).
  const asRole = async (role, uid, sql, params, { readOnly = false } = {}) => {
    const c = await pool.connect();
    try {
      await c.query(readOnly ? "BEGIN READ ONLY" : "BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
      const r = await c.query(sql, params); await c.query("COMMIT"); return r.rows;
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
  };
  const db = {
    admin, pool, asRole,
    asUser: async (uid, sql, p) => (await asRole("authenticated", uid, sql, p))[0],
    asService: async (sql, p) => (await asRole("service_role", null, sql, p))[0],
    one: async (sql, p = []) => (await admin.query(sql, p)).rows[0],
    count: async (sql, p = []) => Number((await admin.query(sql, p)).rows[0].n),
    close: async () => {
      const step = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      await step(pool.end()); await step(admin.end());
      if (server) await step(server.stop());
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
    },
  };
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  return db;
}

/** Applies the whole current chain. Returns null on success, or the first failure. */
export async function applyChain(db) {
  for (const f of currentChain(REPO)) {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await db.admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]} @${e.position ?? ""} ${e.where ?? ""}`.slice(0, 600); }
  }
  return null;
}
export const chainFiles = () => currentChain(REPO);
/** Applies the chain BEFORE `file` (main's schema before a release). Returns null on success, or the first failure. */
export async function applyChainBefore(db, file) {
  const chain = currentChain(REPO);
  const stop = chain.indexOf(file);
  if (stop < 0) return `${file} is not in the chain`;
  for (const f of chain.slice(0, stop)) {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await db.admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
  }
  return null;
}
export const migrationText = (f) => migrationSql(REPO, f);

// ── Synthetic world ──────────────────────────────────────────────────────────────────────────────────────────────────
export async function makeWorld(db) {
  const U = { owner: uuid(), preparer: uuid(), partner: uuid(), viewer: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const company = async (owner, name, framework = "ifrs_for_smes") => (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,$2,$3) RETURNING id", [owner, name, framework])).id;
  const A = await company(U.owner, "Synthetic SME");
  const B = await company(U.ownerB, "Other workspace");
  for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  const rollout = (c, on) => db.asService("SELECT public.fs_set_company_rollout($1,$2,'proof rollout change','proof')", [c, on]);
  return { U, A, B, company, rollout };
}

// ── Trial balances (balanced; TZS, two decimals) ─────────────────────────────────────────────────────────────────────
// code, name, classification, statement, normal balance, FY2026 debit, FY2026 credit, FY2025 debit, FY2025 credit
export const TB = [
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
export const csv = (yearCol, rows = TB) => "Account code,Account name,Debit,Credit\n" + rows.map((r) => `${r[0]},${r[1]},${r[yearCol]},${r[yearCol + 1]}`).join("\n") + "\n";
export const FY2026 = 5, FY2025 = 7;
export const ASSIGN = {
  1000: "sfp.cash_and_cash_equivalents", 1100: "sfp.trade_and_other_receivables", 1200: "sfp.inventories",
  1500: "sfp.property_plant_and_equipment", 1510: "sfp.property_plant_and_equipment",
  2000: "sfp.trade_and_other_payables", 2100: "sfp.current_tax", 2500: "sfp.other_financial_liabilities",
  3000: "sfp.equity_attributable_to_owners", 3100: "sfp.equity_attributable_to_owners",
  4000: "sci.revenue", 4100: "sci.other_income", 5000: "sci.cost_of_sales",
  6000: "sci.operating_expenses_by_function", 6100: "sci.operating_expenses_by_function", 6200: "sci.operating_expenses_by_function",
  6300: "sci.finance_costs", 7000: "sci.tax_expense",
};
export const assignmentPairs = (map) => Object.entries(map).map(([k, line]) => ({ accountKey: String(k), lineId: line }));

/** Upload + real-engine certification. */
export async function certifier(db, U) {
  const ptb = (await loadFunctionTree(REPO, "process-trial-balance")).handler;
  const upload = async (company, y, text, { currency = "TZS", start = `${y}-01-01`, end = `${y}-12-31` } = {}) => {
    const pid = (await db.one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,$5,$6,$2) RETURNING id",
      [company, end, `FY${y}`, U.owner, currency, start])).id;
    const filePath = `${U.owner}/${uuid()}.csv`;
    const id = (await db.one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, company, y, pid, U.owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return { id, year: y };
  };
  const decisions = (rows = TB) => rows.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE",
    decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === "1000" }));
  const review = (company, u, rows = TB) => db.asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [company, u.id, uuid(), JSON.stringify(decisions(rows))]);
  const certify = async (company, u) => {
    const r = await call(ptb, db.pool, mintTestJwt(U.owner), { uploadId: u.id, clientRequestId: uuid() });
    const c = await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [company, u.year]);
    if (!c) throw new Error(`not certified: ${JSON.stringify(r.body).slice(0, 300)}`);
    return c.id;
  };
  return { upload, review, certify };
}

// ── The browser client's transport, in process ───────────────────────────────────────────────────────────────────────
/**
 * A ReportingDb (src/lib/reporting/signoff.ts) over the real database as `authenticated` with the given user's auth.uid()
 * — the same mechanism PostgREST uses. Arguments are typed from the function's own signature (jsonb arguments are sent as
 * JSON); results are JSON round-tripped exactly as an HTTP transport would deliver them. Selects run under RLS.
 */
export function clientDb(db, uid) {
  const sigs = new Map();
  const signature = async (fn) => {
    if (!sigs.has(fn)) {
      const r = await db.one(`SELECT p.proargnames AS names, array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types, p.provolatile AS volatility
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid DESC LIMIT 1`, [fn]);
      if (!r) throw Object.assign(new Error(`function ${fn} not found`), { code: "42883" });
      sigs.set(fn, { args: Object.fromEntries(r.names.slice(0, r.types.length).map((n, i) => [n, r.types[i]])), readOnly: r.volatility !== "v" });
    }
    return sigs.get(fn);
  };
  const wrap = async (run) => {
    try { return { data: JSON.parse(JSON.stringify((await run()) ?? null)), error: null }; }
    catch (e) { return { data: null, error: { message: String(e.message), code: e.code ?? null } }; }
  };
  return {
    rpc: (fn, args) => wrap(async () => {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error("bad function name");
      const { args: sig, readOnly } = await signature(fn);
      const keys = Object.keys(args);
      for (const k of keys) if (!(k in sig)) throw Object.assign(new Error(`${fn} has no argument ${k}`), { code: "42883" });
      const sql = `SELECT to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${sig[k]}`).join(", ")})) AS r`;
      const params = keys.map((k) => (sig[k] === "jsonb" && args[k] !== null ? JSON.stringify(args[k]) : args[k]));
      // As PostgREST runs it: a STABLE or IMMUTABLE function inside a READ ONLY transaction (25006 on any write).
      return (await db.asRole("authenticated", uid, sql, params, { readOnly }))[0].r;
    }),
    select: (table, filters) => wrap(async () => {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("bad table name");
      const f = Object.entries(filters);
      const where = f.length ? `WHERE ${f.map(([k], i) => `"${k.replace(/[^a-z_]/g, "")}" = $${i + 1}`).join(" AND ")}` : "";
      return db.asRole("authenticated", uid, `SELECT * FROM public.${table} ${where}`, f.map(([, v]) => v), { readOnly: true });
    }),
  };
}

// ── Evidence a preparer would upload for FY2026, derived from the trial balances so every balance ties (corrected
// 2026-10-08 after building the reviewer package: tax paid 700 = 700 + 900 − 900; interest paid 600 = the expense, no
// accrual; customers 28,700 = 30,000 − (4,300 − 3,000); suppliers and employees 21,700 = 14,000 + 5,500 + 2,400
// + (2,200 − 1,800) − (3,100 − 2,500)). Bank 8,000.00 → 12,500.00; dividends 700.00 ────────────────────────────────
export const EVIDENCE_FY2026 = {
  TRANSACTION_LEDGER: [
    "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
    "T1,2026-03-31,1000,Receipts from customers,28700.00,,OPERATING,Receipts from customers",
    "T2,2026-06-30,1000,Payments to suppliers and employees,,21700.00,OPERATING,Payments to suppliers and employees",
    "T3,2026-07-15,1000,Interest received,500.00,,OPERATING,Interest received",
    "T4,2026-09-30,1000,Loan repayment,,1000.00,FINANCING,Repayment of borrowings",
    "T5,2026-11-30,1000,Dividend paid,,700.00,FINANCING,Dividends paid",
    "T6,2026-12-15,1000,Income tax paid,,700.00,OPERATING,Income tax paid",
    "T7,2026-12-20,1000,Interest paid,,600.00,OPERATING,Interest paid",
  ].join("\n") + "\n",
  EQUITY_MOVEMENTS: [
    "component,movement_type,amount,description",
    "Share capital,OPENING_BALANCE,10000.00,",
    "Share capital,CLOSING_BALANCE,10000.00,",
    "Retained earnings,OPENING_BALANCE,6600.00,",
    "Retained earnings,PROFIT_OR_LOSS,5100.00,",
    "Retained earnings,DIVIDENDS_OR_DISTRIBUTIONS,-700.00,Final dividend",
    "Retained earnings,CLOSING_BALANCE,11000.00,",
  ].join("\n") + "\n",
  CASH_ACCOUNT_MAP: "account_key,category,effect,include_in_cash_flow,note\n1000,BANK_ACCOUNT,ADD,Y,Main operating account\n",
};

// The comparative year (FY2025) as the same report needs it: the prior year's ledger and equity movements, and the signed
// prior-year statement of cash flows' opening cash (5,000.00 at 1 January 2025). Ties to the FY2025 TB: bank 8,000.00;
// retained earnings 3,500.00 before closing = 4,200.00 opening less the 700.00 dividend; equity 16,600.00 (10,000 + 3,500
// + profit 3,100).
export const EVIDENCE_FY2025_COMPARATIVE = {
  TRANSACTION_LEDGER: [
    "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line",
    "P1,2025-03-31,1000,Receipts from customers,24600.00,,OPERATING,Receipts from customers",
    "P2,2025-06-30,1000,Payments to suppliers and employees,,19100.00,OPERATING,Payments to suppliers and employees",
    "P3,2025-07-15,1000,Interest received,400.00,,OPERATING,Interest received",
    "P4,2025-09-30,1000,Loan repayment,,1000.00,FINANCING,Repayment of borrowings",
    "P5,2025-12-15,1000,Income tax paid,,500.00,OPERATING,Income tax paid",
    "P6,2025-12-20,1000,Interest paid,,700.00,OPERATING,Interest paid",
    "P7,2025-11-30,1000,Dividend paid,,700.00,FINANCING,Dividends paid",
  ].join("\n") + "\n",
  EQUITY_MOVEMENTS: [
    "component,movement_type,amount,description",
    "Share capital,OPENING_BALANCE,10000.00,",
    "Share capital,CLOSING_BALANCE,10000.00,",
    "Retained earnings,OPENING_BALANCE,4200.00,",
    "Retained earnings,PROFIT_OR_LOSS,3100.00,",
    "Retained earnings,DIVIDENDS_OR_DISTRIBUTIONS,-700.00,Final dividend",
    "Retained earnings,CLOSING_BALANCE,6600.00,",
  ].join("\n") + "\n",
  PRIOR_PERIOD_STATEMENTS: "statement_type,line_key,line_label,amount\nCASH_FLOWS,cash_and_cash_equivalents_opening_cf,Cash and cash equivalents at 1 January 2025,5000.00\n",
};

/** The three comprehensive-income line items a preparer decides (5.5(e), (g), (h)). */
export const COMPREHENSIVE_INCOME_DECISIONS = ["smes.sci.5_5_e", "smes.sci.5_5_g", "smes.sci.5_5_h"];

/** Everything up to (not including) evidence and a report: certified years, presentation, Close Review, notes, comparatives. */
export async function prepareReporting(db, W, k, { year = 2026, comparativesApproved = true } = {}) {
  const { U, A } = W;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const p = await k.upload(A, year - 1, csv(FY2025)); await k.review(A, p); await k.certify(A, p);
  const c = await k.upload(A, year, csv(FY2026)); await k.certify(A, c);
  await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3)", [A, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]);
  const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, year])).r;
  const open = (await db.admin.query("SELECT f.id FROM public.close_review_findings f WHERE f.run_id=$1", [run.runId])).rows;
  for (const f of open) await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2026',$2) r", [f.id, uuid()]);
  const WORDS = { "smes.note.compliance": "Prepared in accordance with the IFRS for SMEs (2015 edition).", "smes.note.identification": "Synthetic SME Limited; year ended 31 December 2026; TZS.",
    "smes.note.policies": "Historical cost.", "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "All receivables from third parties.",
    "smes.note.share_capital": "10,000 ordinary shares, fully paid." };
  await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','The entity has share capital',$3)", [A, year, uuid()]);
  // Section 5: no discontinued operation and no other comprehensive income in either period presented (20261022100000).
  for (const id of COMPREHENSIVE_INCOME_DECISIONS) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented',$4)", [A, year, id, uuid()]);
  for (const [id, text] of Object.entries(WORDS)) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, year, id, text, uuid()]);
  await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,'Fixed asset register 2026',$4)", [A, year,
    JSON.stringify([{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]), uuid()]);
  if (comparativesApproved) await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the signed 2025 statements',$3) r", [A, year, uuid()]);
}
