#!/usr/bin/env bun
// H2/E1/E2 — REAL process-trial-balance handlers on REAL PostgreSQL (blueprint Revision 2, gates I-1, I-1a and I-1b).
//
// Handlers run through the shared harness: only std serve, supabase-js and the esm.sh xlsx specifier are replaced (xlsx by
// the identical npm version). Every database call executes on a disposable PostgreSQL migrated through the whole current
// chain (S1, H1 and S2 included), as the caller's real role, so RLS, grants, triggers and RPCs apply as deployed.
//
// Handlers on the same database:
//   CURRENT   supabase/functions/process-trial-balance/index.ts as committed (E2: attempts through the S2 functions).
//   FAULTY    CURRENT with one injected fault in _shared/tbAmounts.ts (the equation's left side off by one minor unit),
//             to prove the invariant path: the attempt fails, nothing certified, the upload never accepted.
//   PREVIOUS  the engine before E1, and the E1 engine, each at the commit recorded in the ledger file: since S2 their first
//             write is refused and they change nothing (X8); the accepted reprocess request they were given is then
//             completed by the current handler.
//
// Every check is a REQUIREMENT that must pass. The known-defect ledger is empty since E2: E1 fixed every registered defect,
// and E1's gate (this file at that commit) proved the previous engine reproduced each one exactly on these same fixtures.
// Any exception, harness or database error, or a required check that did not run fails the gate (exit 1).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/tbHandlerCharacterization.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
// The ledger file's engine commits must be present locally (CI fetches them). It refuses every non-loopback host and the
// production project reference. No production code or schema is changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, functionsAtCommit, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { validateTbAmounts } from "../../supabase/functions/_shared/tbAmounts.ts";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { classifyProbe, canon, gateVerdict, validateLedger } from "./lib/defectLedger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const LEDGER_FILE = path.join(HERE, "fixtures/h2-known-defects.json");
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

// ── Results: requirements and defect probes are separate classes ───────────────────────────────────────────────────
const REQUIRED_REQUIREMENTS = ["REQ-AUTH-1", "REQ-AUTH-2", "REQ-AUTH-3", "REQ-HAPPY", "REQ-EXACT-TOTALS", "REQ-R5C", "REQ-REVIEW",
  "REQ-PROV-UNLINKED", "REQ-PROV-GLOBAL", "REQ-TENANT", "REQ-REPLAY", "REQ-REPROCESS", "REQ-LIFECYCLE",
  // E1 (the current handler on the defect fixtures; each must equal the oracle)
  "REQ-E1-AMOUNTS", "REQ-E1-CASH-ORDER-A", "REQ-E1-CASH-ORDER-B", "REQ-E1-TREATMENT", "REQ-E1-TREATMENT-REFUTED", "REQ-E1-CONTRA",
  "REQ-E1-GENUINE-EQUATION", "REQ-E1-NONREPORTING-NONZERO", "REQ-E1-NONREPORTING-ZERO", "REQ-E1-PRECISION", "REQ-E1-INVARIANT",
  "REQ-E1-GENERATION", "REQ-E1-REPROCESS-REQUIRED", "X-E1-INV",
  // E2 / X8 (the previous engines on S2's schema)
  "X8-PREVIOUS-ENGINE-FENCED", "X8-E1-ENGINE-FENCED", "X8-REPLAY-COMPLETES", "REQ-E2-DEPENDENCY-STALE",
  // R0 release: functions with an open registered defect refuse on the server (_shared/openDefectRestriction.ts)
  "REQ-RESTRICTED-KINGA-FINDINGS", "REQ-RESTRICTED-MAONO-COMPUTE",
  // R0 release: services withheld from this release refuse on the server, with no writes
  "REQ-WITHHELD-TAX", "REQ-WITHHELD-NOTES", "REQ-WITHHELD-LETTER"];
const ledger = validateLedger(JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")));
const REQUIRED_PROBES = ledger.defects.map((d) => d.probe);
const results = { requirement: new Map(), probe: new Map() };
let infraFailure = null;

function requirement(id, ok, detail = "") {
  results.requirement.set(id, ok);
  console.log(`  ${ok ? "PASS     " : "FAIL     "} ${id}${ok || !detail ? "" : `\n             ${detail}`}`);
}
async function req1(id, fn) {
  try { const r = await fn(); requirement(id, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`); }
  catch (e) { requirement(id, false, `exception: ${String(e?.message ?? e).split("\n")[0]}`); }
}
/** A defect probe: observed must equal the ledger's exact signature and differ from the oracle. */
async function probe(id, fn) {
  const entry = ledger.defects.find((d) => d.probe === id);
  try {
    if (!entry) throw new Error("probe not registered in the ledger");
    const { observed, oracle } = await fn();
    const o = canon(observed), want = canon(entry.signature), right = canon(oracle);
    const verdict = classifyProbe({ observed, signature: entry.signature, oracle });
    if (verdict === "fixed") {
      results.probe.set(id, "fixed");
      console.log(`  FAIL      ${id} [${entry.defect}] observed equals the ORACLE — the defect is fixed; remove it from the ledger in the fixing PR\n             ${o}`);
    } else if (verdict === "reproduced") {
      results.probe.set(id, "reproduced");
      console.log(`  DEFECT    ${id} [${entry.defect}] reproduced exactly (never a pass)\n             observed ${o}\n             oracle   ${right}`);
    } else {
      results.probe.set(id, "mismatch");
      console.log(`  FAIL      ${id} [${entry.defect}] observed matches neither the ledger signature nor the oracle\n             observed  ${o}\n             signature ${want}\n             oracle    ${right}`);
    }
  } catch (e) {
    results.probe.set(id, "error");
    console.log(`  FAIL      ${id} exception: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

// ── Disposable database ────────────────────────────────────────────────────────────────────────────────────────────
let pool; let admin; let server = null; let dir = null;
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-h2-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE h2_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/h2_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* */ } try { await admin?.end(); } catch { /* */ }
  if (server) { try { await server.stop(); } catch { /* */ } }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
const uuid = () => globalThis.crypto.randomUUID();
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
async function asUser(uid, sql, p = []) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const r = await c.query(sql, p); await c.query("COMMIT"); return r.rows;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}
async function asService(sql, p = []) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role"); const r = await c.query(sql, p); await c.query("COMMIT"); return r.rows; }
  catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
}

// ── Independent oracle: bigint minor units and a class-side table (never read back from the engine) ─────────────────
const CLASS_SIDE = {
  current_assets: "asset", non_current_assets: "asset", current_liabilities: "liability", non_current_liabilities: "liability",
  equity: "equity", revenue: "income", other_income: "income", cost_of_goods_sold: "expense", operating_expenses: "expense", taxes: "expense",
};
function toMinor(text, exponent) {
  if (text === "") return 0n;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.replace(/,/g, ""));
  if (!m || (m[2] ?? "").length > exponent) throw new Error(`oracle: bad amount ${text}`);
  return BigInt(m[1] + (m[2] ?? "").padEnd(exponent, "0"));
}
const fmt = (minor, exponent) => { const neg = minor < 0n; const s = (neg ? -minor : minor).toString().padStart(exponent + 1, "0"); return `${neg ? "-" : ""}${exponent ? `${s.slice(0, -exponent)}.${s.slice(-exponent)}` : s}`; };
/** rows: [code, name, debit, credit]; classes: code → classification (absent = excluded). */
function oracle(rows, classes, exponent, { cash = [] } = {}) {
  const sum = { asset: 0n, liability: 0n, equity: 0n, income: 0n, expense: 0n }; let debit = 0n; let credit = 0n; let cashTotal = 0n;
  for (const [code, , d, c] of rows) {
    const dm = toMinor(d, exponent), cm = toMinor(c, exponent); debit += dm; credit += cm;
    if (cash.includes(code)) cashTotal += dm - cm;
    const side = CLASS_SIDE[classes[code]]; if (!side) continue;
    sum[side] += side === "asset" || side === "expense" ? dm - cm : cm - dm;
  }
  const rhs = sum.liability + sum.equity + sum.income - sum.expense;
  return { debit, credit, ...sum, difference: sum.asset - rhs, cashTotal, fmt: (x) => fmt(x, exponent) };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const csv = (rows, title = "Trial balance for the year") => `${title}\nCode,Name,Debit,Credit\n${rows.map((r) => r.map((x) => (x.includes(",") ? `"${x}"` : x)).join(",")).join("\n")}\n`;

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 12 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  // The hosted project has pgcrypto in schema "extensions" (S1's RPCs call extensions.digest); same function here.
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  for (const f of files) {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await admin.query(t); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
  const { handler, sourceSha256 } = await loadFunctionTree(REPO, "process-trial-balance");
  const priorTree = await loadFunctionTree(REPO, "process-trial-balance", { functionsDir: functionsAtCommit(REPO, ledger.engine_commit, "process-trial-balance") });
  if (priorTree.sourceSha256 !== ledger.handler_sha256) throw new Error(`previous handler at ${ledger.engine_commit} has sha256 ${priorTree.sourceSha256}, ledger records ${ledger.handler_sha256}`);
  const prior = priorTree.handler;
  const e1 = (await loadFunctionTree(REPO, "process-trial-balance", { functionsDir: functionsAtCommit(REPO, ledger.e1_engine_commit, "process-trial-balance") })).handler;
  // Fault injection: the equation's left side is off by exactly one minor unit; everything else is the current handler.
  let faultApplied = 0;
  const faulty = (await loadFunctionTree(REPO, "process-trial-balance", { patch: (rel, t) => {
    if (rel !== "_shared/tbAmounts.ts") return t;
    const at = "const lhs = sums.assets;";
    if (t.split(at).length !== 2) throw new Error("fault injection: anchor not found exactly once");
    faultApplied++;
    return t.replace(at, "const lhs = sums.assets + 1n;");
  } })).handler;
  if (faultApplied !== 1) throw new Error("fault injection did not apply");
  console.log(`\n== Setup: ${files.length} migrations (S1, H1 and S2 included)`);
  console.log(`   current handler  process-trial-balance/index.ts sha256 ${sourceSha256}`);
  console.log(`   previous handler at ${ledger.engine_commit.slice(0, 12)} sha256 ${priorTree.sourceSha256} (ledger match); E1 engine at ${ledger.e1_engine_commit.slice(0, 12)}`);

  const U = { owner: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "SOLO", 0]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'viewer',now())", [A, U.viewer]);

  // One period (and upload) per scenario; the currency comes from the period, as the handler reads it.
  const periods = {};
  async function period(company, year, currency = "TZS") {
    const id = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [company, `${year}-12-31`, `FY${year}`, company === A ? U.owner : U.ownerB, currency])).id;
    periods[`${company}:${year}`] = id; return id;
  }
  async function upload(company, year, text, { currency = "TZS" } = {}) {
    const owner = company === A ? U.owner : U.ownerB;
    const pid = periods[`${company}:${year}`] ?? (await period(company, year, currency));
    const filePath = `${owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, text.length, company, year, pid, owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return id;
  }
  // Mappings through the REAL review RPC (so they carry S1 review provenance).
  const reviewUpload = await upload(A, 1999, csv([["9000", "Seed", "1", ""], ["9001", "Seed", "", "1"]]));
  const reviewB = await upload(B, 1999, csv([["9000", "Seed", "1", ""], ["9001", "Seed", "", "1"]]));
  const NORMAL = { current_assets: "debit", non_current_assets: "debit", current_liabilities: "credit", non_current_liabilities: "credit", equity: "credit", revenue: "credit", other_income: "credit", cost_of_goods_sold: "debit", operating_expenses: "debit", taxes: "debit" };
  const STATEMENT = (cls) => (["revenue", "other_income", "cost_of_goods_sold", "operating_expenses", "taxes"].includes(cls) ? "income_statement" : "balance_sheet");
  async function review(owner, company, up, entries) {
    const decisions = entries.map(([code, name, cls, extra = {}]) => (cls === "NON_REPORTING"
      ? { account_code: code, account_name: name, decision_action: "MARK_NON_REPORTING_ACCOUNT" }
      : { account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: STATEMENT(cls), classification: cls, normal_balance: NORMAL[cls], ...extra }));
    await asUser(owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [company, up, uuid(), JSON.stringify(decisions)]);
  }
  const runHandler = (uid, uploadId, clientRequestId = uuid(), h = handler) => call(h, pool, uid ? mintTestJwt(uid) : null, { uploadId, clientRequestId });
  const runPrior = (uid, uploadId) => runHandler(uid, uploadId, uuid(), prior);
  const uploadRow = (id) => one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id]);
  const certs = async (id) => (await admin.query("SELECT * FROM public.tb_certifications WHERE upload_id=$1 ORDER BY sequence_no", [id])).rows;
  const authoritative = async (company, year) => (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [company, year]))?.id ?? null;
  
  // ── HAPPY (2001): a plain balanced trial balance, every account reviewed ──────────────────────────────────────────
  console.log("\n== Requirements (must pass)");
  const HAPPY = [["1000", "Bank", "1,500.25", ""], ["3000", "Share capital", "", "1,000.00"], ["4000", "Sales", "", "900.25"], ["6000", "Rent", "400.00", ""]];
  await review(U.owner, A, reviewUpload, [["1000", "Bank", "current_assets"], ["3000", "Share capital", "equity"], ["4000", "Sales", "revenue"], ["6000", "Rent", "operating_expenses"]]);
  const happy = await upload(A, 2001, csv(HAPPY));

  await req1("REQ-AUTH-1", async () => {
    const r = await call(handler, pool, null, { uploadId: happy, clientRequestId: uuid() });
    return r.http === 401 && (await uploadRow(happy)).status === "processing" ? true : r;
  });
  await req1("REQ-AUTH-2", async () => {
    // A malformed (two-part) token is refused before any read.
    const res = await handler(new Request("http://functions.invalid/fn", { method: "POST", headers: { Authorization: "Bearer a.b", "content-type": "application/json" }, body: JSON.stringify({ uploadId: happy, clientRequestId: uuid() }) }));
    return res.status === 401 ? true : res.status;
  });
  await req1("REQ-AUTH-3", async () => {
    // A signed-in user with no authority over the workspace: 403, nothing written.
    const before = canon(await uploadRow(happy));
    const r = await runHandler(U.outsider, happy);
    return r.http === 403 && canon(await uploadRow(happy)) === before && (await certs(happy)).length === 0 ? true : r;
  });
  const happyReq = uuid();
  await req1("REQ-HAPPY", async () => {
    const r = await runHandler(U.owner, happy, happyReq);
    const row = await uploadRow(happy); const cs = await certs(happy);
    return r.http === 200 && row.status === "complete" && cs.length === 1 && !cs[0].is_blocking && !cs[0].requires_review
      && (await authoritative(A, 2001)) === cs[0].id ? true : { http: r.http, status: row.status, certs: cs.length };
  });
  await req1("REQ-EXACT-TOTALS", async () => {
    const o = oracle(HAPPY, {}, 2);
    const exact = (await uploadRow(happy)).processing_result.validation_report.tb_balance_check.exact;
    return exact.total_debits === o.fmt(o.debit) && exact.total_credits === o.fmt(o.credit) && exact.difference === "0.00" && exact.currency === "TZS" && exact.currency_exponent === 2
      ? true : exact;
  });
  await req1("REQ-REPLAY", async () => {
    const r = await runHandler(U.owner, happy, happyReq);
    return r.http === 200 && r.body?.replay === true && (await certs(happy)).length === 1 && (await uploadRow(happy)).status === "complete" ? true : r;
  });
  await req1("REQ-REPROCESS", async () => {
    const before = (await certs(happy))[0];
    const op = uuid();
    const acc = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [happy, op, (await uploadRow(happy)).source_file_hash]))[0].r;
    const mid = await authoritative(A, 2001);
    const r = await runHandler(U.owner, happy, op);
    const cs = await certs(happy);
    const inv = await one("SELECT count(*)::int n FROM public.tb_certification_invalidations WHERE certification_id=$1", [before.id]);
    return acc.outcome === "accepted" && mid === null && r.http === 200 && cs.length === 2 && (await authoritative(A, 2001)) === cs[1].id && inv.n === 1
      ? true : { acc, mid, http: r.http, certs: cs.length, inv };
  });

  // R5c: three decimals in a two-decimal currency are refused at ingestion (no rounding).
  await req1("REQ-R5C", async () => {
    const id = await upload(A, 2002, csv([["1000", "Bank", "10.005", ""], ["3000", "Share capital", "", "10.005"]]));
    const r = await runHandler(U.owner, id); const row = await uploadRow(id);
    return r.http === 200 && row.status === "blocked" && (await certs(id)).every((c) => c.is_blocking) && (await authoritative(A, 2002)) === null ? true : { http: r.http, status: row.status };
  });
  // An account with no mapping goes to review; nothing is authoritative.
  await req1("REQ-REVIEW", async () => {
    const id = await upload(A, 2003, csv([["1000", "Bank", "100.00", ""], ["9999", "Unknown thing", "", "100.00"]]));
    await runHandler(U.owner, id); const row = await uploadRow(id); const cs = await certs(id);
    const review = row.processing_result?.needs_review_accounts?.map((a) => a.account_code) ?? [];
    return row.status === "needs_review" && review.includes("9999") && cs.at(-1)?.requires_review === true && (await authoritative(A, 2003)) === null ? true : { status: row.status, review };
  });
  // S1 provenance consumption: an unlinked company mapping is a suggestion with an accurate reason.
  await req1("REQ-PROV-UNLINKED", async () => {
    await asService(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance)
      VALUES ($1,$2,'1600','Unlinked bank','balance_sheet','current_assets','Bank','debit')`, [U.owner, A]);
    const id = await upload(A, 2004, csv([["1600", "Unlinked bank", "50.00", ""], ["3000", "Share capital", "", "50.00"]]));
    await runHandler(U.owner, id); const row = await uploadRow(id);
    const a = row.processing_result?.needs_review_accounts?.find((x) => x.account_code === "1600");
    return row.status === "needs_review" && /no recorded review decision confirms it/.test(a?.reason ?? "") && (await authoritative(A, 2004)) === null ? true : { status: row.status, a };
  });
  await req1("REQ-PROV-GLOBAL", async () => {
    await asService(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance)
      VALUES ($1,NULL,'1610','Shared bank','balance_sheet','current_assets','Bank','debit')`, [U.owner]);
    const id = await upload(A, 2005, csv([["1610", "Shared bank", "50.00", ""], ["3000", "Share capital", "", "50.00"]]));
    await runHandler(U.owner, id); const row = await uploadRow(id);
    const a = row.processing_result?.needs_review_accounts?.find((x) => x.account_code === "1610");
    return row.status === "needs_review" && /shared chart of accounts/.test(a?.reason ?? "") ? true : { status: row.status, a };
  });
  await req1("REQ-TENANT", async () => {
    await review(U.ownerB, B, reviewB, [["1700", "B bank", "current_assets"]]);
    const id = await upload(A, 2006, csv([["1700", "B bank", "50.00", ""], ["3000", "Share capital", "", "50.00"]]));
    await runHandler(U.owner, id); const row = await uploadRow(id);
    return row.status === "needs_review" && (row.processing_result?.needs_review_accounts ?? []).some((x) => x.account_code === "1700") && (await authoritative(A, 2006)) === null ? true : row.status;
  });
  await req1("REQ-LIFECYCLE", async () => {
    const id = await upload(A, 2007, csv(HAPPY));
    await runHandler(U.owner, id);
    await asUser(U.owner, "SELECT * FROM public.remove_trial_balance_upload($1,$2,'h2 proof')", [id, (await uploadRow(id)).version]);
    const runs0 = (await one("SELECT count(*)::int n FROM public.engine_runs WHERE company_id=$1", [A])).n;
    const r = await runHandler(U.owner, id);
    const runs1 = (await one("SELECT count(*)::int n FROM public.engine_runs WHERE company_id=$1", [A])).n;
    return r.http === 409 && runs0 === runs1 && (await uploadRow(id)).lifecycle_state === "retired" ? true : { http: r.http, runs0, runs1 };
  });

  // ── The defect fixtures (D1, D1b, D5–D8, D10), reviewed through the real RPC; checked against the oracle below ──────
  // CASH3 (D6, D7): three reviewed cash accounts.
  const CASH3 = [["1100", "Cash A", "10,000.00", ""], ["1110", "Cash B", "20,000.00", ""], ["1120", "Cash C", "30,500.00", ""], ["3100", "Capital cash", "", "60,500.00"]];
  await review(U.owner, A, reviewUpload, [["1100", "Cash A", "current_assets", { is_cash_account: true }], ["1110", "Cash B", "current_assets", { is_cash_account: true }],
    ["1120", "Cash C", "current_assets", { is_cash_account: true }], ["3100", "Capital cash", "equity"]]);
  const cashOracle = oracle(CASH3, {}, 2, { cash: ["1100", "1110", "1120"] });

  // Closing-stock rescue (D5): a current-asset credit named "Closing stock".
  const RESCUE = [["1200", "Closing stock", "", "5,000.00"], ["1210", "Bank rescue", "15,000.00", ""], ["3200", "Capital rescue", "", "10,000.00"]];
  await review(U.owner, A, reviewUpload, [["1200", "Closing stock", "current_assets"], ["1210", "Bank rescue", "current_assets"], ["3200", "Capital rescue", "equity"]]);

  // Contra-signed liability (D8) and the equation failure it causes being certified (D1).
  const CONTRA = [["2300", "Accrued liabilities", "", "2,000.00"], ["2310", "Trade payables", "", "3,000.00"], ["1300", "Bank contra", "5,000.00", ""]];
  await review(U.owner, A, reviewUpload, [["2300", "Accrued liabilities", "current_liabilities", { normal_balance: "debit" }], ["2310", "Trade payables", "current_liabilities"], ["1300", "Bank contra", "current_assets"]]);
  const contraOracle = oracle(CONTRA, { 2300: "current_liabilities", 2310: "current_liabilities", 1300: "current_assets" }, 2);
  // Invariant (independent of the fixture): an authoritative certification never carries an equation failure. For this
  // fixture the correct engine has no failure at all (difference 0, R3c), so the oracle is: authoritative, no failure.

  // Non-zero non-reporting account (D1b).
  const NONREP = [["1400", "Bank nonrep", "3,000.00", ""], ["1410", "Suspense nonrep", "250.00", ""], ["3400", "Capital nonrep", "", "3,250.00"]];
  await review(U.owner, A, reviewUpload, [["1400", "Bank nonrep", "current_assets"], ["3400", "Capital nonrep", "equity"], ["1410", "Suspense nonrep", "NON_REPORTING"]]);

  // Equation message precision in a three-decimal currency (D10).
  const BHD = [["1500", "Bank bhd", "10.000", ""], ["1510", "Suspense bhd", "1.235", ""], ["3500", "Capital bhd", "", "11.235"]];
  await review(U.owner, A, reviewUpload, [["1500", "Bank bhd", "current_assets"], ["3500", "Capital bhd", "equity"], ["1510", "Suspense bhd", "NON_REPORTING"]]);

  // Genuine equation failure (D1, independent of the contra case): a LEGACY reviewed mapping to a cash-flow class. S1
  // refuses new ones, so the decision is seeded directly (decisions are insert-only) and the mapping linked by the service
  // role through S1's provenance guard. The previous engine leaves its 500.00 out of the statements and certifies.
  const GEN = [["1800", "Legacy investing", "500.00", ""], ["1810", "Bank gen", "1,500.00", ""], ["3800", "Capital gen", "", "2,000.00"]];
  await review(U.owner, A, reviewUpload, [["1810", "Bank gen", "current_assets"], ["3800", "Capital gen", "equity"]]);
  const genDecision = (await one(`INSERT INTO public.account_review_decisions (batch_id, company_id, upload_id, firm_member_id, account_code,
      normalized_account_name, review_account_key, proposal_type, decision_action, new_value, reason)
    SELECT batch_id, company_id, upload_id, firm_member_id, '1800', 'legacy investing', '1800', 'NONE', 'USER_MANUAL_CLASSIFICATION',
      jsonb_build_object('mapping', public.account_mapping_content('cash_flow', 'operating_activities', 'Legacy investing', 'debit', false, false, false)),
      'legacy classification (seeded)'
    FROM public.account_review_decisions WHERE company_id=$1 AND review_account_key='1810' ORDER BY sequence_no DESC LIMIT 1 RETURNING id`, [A])).id;
  await asService(`INSERT INTO public.account_mappings (user_id, company_id, account_code, account_name, statement, classification, line_item, normal_balance,
      is_cash_account, is_retained_earnings, is_payroll_account, review_decision_id)
    VALUES ($1,$2,'1800','Legacy investing','cash_flow','operating_activities','Legacy investing','debit',false,false,false,$3)`, [U.owner, A, genDecision]);
  const genOracle = oracle(GEN, { 1810: "current_assets", 3800: "equity" }, 2);
  if (genOracle.difference === 0n) throw new Error("genuine fixture: the oracle shows no equation failure");

  // ── E1 requirements: the CURRENT handler on the same fixtures must equal the oracle ───────────────────────────────
  console.log("\n== E1 requirements: the CURRENT handler (must equal the independent oracle)");
  const amountsOk = (pr) => validateTbAmounts(pr?.amounts).ok === true;
  const latestCert = async (id) => (await certs(id)).at(-1) ?? null;
  const isAuthoritative = async (company, year, id) => { const c = await latestCert(id); return c !== null && (await authoritative(company, year)) === c.id; };

  await req1("REQ-E1-AMOUNTS", async () => {
    const pr = (await uploadRow(happy)).processing_result; const o = oracle(HAPPY, { 1000: "current_assets", 3000: "equity", 4000: "revenue", 6000: "operating_expenses" }, 2);
    const cl = pr?.amounts?.classes; const src = pr?.amounts?.source;
    return amountsOk(pr) && cl.assets_minor === o.asset.toString() && cl.equity_minor === o.equity.toString() && cl.income_minor === o.income.toString()
      && cl.expenses_minor === o.expense.toString() && cl.liabilities_minor === o.liability.toString() && src.debit_total_minor === o.debit.toString()
      && src.credit_total_minor === o.credit.toString() && pr.amounts.equation.difference_minor === o.difference.toString() && pr.amounts.equation.status === "balanced"
      && pr.amounts.currency === "TZS" && pr.amounts.exponent === 2 ? true : pr?.amounts ?? "no amounts";
  });
  for (const [rid, year, rows] of [["REQ-E1-CASH-ORDER-A", 2015, CASH3], ["REQ-E1-CASH-ORDER-B", 2016, [CASH3[2], CASH3[1], CASH3[0], CASH3[3]]]]) {
    await req1(rid, async () => {
      const id = await upload(A, year, csv(rows)); await runHandler(U.owner, id);
      const row = await uploadRow(id); const pr = row.processing_result; const c = pr?.amounts?.cash; const want = cashOracle.cashTotal.toString();
      return row.status === "complete" && amountsOk(pr) && c.reported_minor === want && c.net_position_minor === want && c.overdraft_minor === "0"
        && c.credit_balances_minor === "0" && c.accounts === 3 && pr.validation_report.cash_reconciliation === null && pr.amounts.reconciliation.status === "not_checked"
        && (await isAuthoritative(A, year, id)) ? true : { status: row.status, cash: c ?? null, cash_reconciliation: pr?.validation_report?.cash_reconciliation };
    });
  }
  await req1("REQ-E1-TREATMENT", async () => {
    const id = await upload(A, 2017, csv(RESCUE)); await runHandler(U.owner, id);
    let row = await uploadRow(id); let pr = row.processing_result;
    const reqs = pr?.treatment_requests ?? [];
    const flagged = (pr?.needs_review_accounts ?? []).find((x) => x.account_code === "1200");
    const step1 = row.status === "needs_review" && reqs.length === 1 && flagged?.treatment_request_id === reqs[0].request_id && pr.statements === null
      && pr.amounts === undefined && reqs[0].source_file_hash === row.source_file_hash && reqs[0].debit_minor === "0" && reqs[0].credit_minor === "500000"
      && (await authoritative(A, 2017)) === null;
    if (!step1) return { step: "flagged", status: row.status, reqs, flagged };
    // The person keeps it as mapped, with a reason, through the REAL review RPC; then a reprocess request and the handler.
    await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, id, uuid(), JSON.stringify([{ account_code: "1200", account_name: "Closing stock",
      decision_action: "CONFIRM_ACCOUNT_TREATMENT", treatment_request_id: reqs[0].request_id, treatment: "keep_as_mapped", reason: "Stock count confirms the credit" }])]);
    const op = uuid();
    const acc = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [id, op, row.source_file_hash]))[0].r;
    await runHandler(U.owner, id, op);
    row = await uploadRow(id); pr = row.processing_result;
    const o = oracle(RESCUE, { 1200: "current_assets", 1210: "current_assets", 3200: "equity" }, 2);
    const stock = (await latestCert(id))?.rows_snapshot?.find((r) => r.accountCode === "1200");
    return acc.outcome === "accepted" && row.status === "complete" && amountsOk(pr) && pr.amounts.classes.assets_minor === o.asset.toString()
      && pr.amounts.classes.expenses_minor === o.expense.toString() && o.expense === 0n && pr.amounts.equation.status === "balanced"
      && pr.statements.income_statement.cost_of_goods_sold.accounts.length === 0 && stock?.classSideMinor === "-500000" && stock?.rowContract === "tb-row/1"
      && (await isAuthoritative(A, 2017, id)) ? true : { step: "confirmed", acc, status: row.status, classes: pr?.amounts?.classes, stock };
  });
  await req1("REQ-E1-TREATMENT-REFUTED", async () => {
    // The same name with a DEBIT balance is ordinary inventory: no question (R3b).
    const rows = [["1200", "Closing stock", "5,000.00", ""], ["1210", "Bank rescue", "15,000.00", ""], ["3200", "Capital rescue", "", "20,000.00"]];
    const id = await upload(A, 2024, csv(rows)); await runHandler(U.owner, id);
    const row = await uploadRow(id);
    return row.status === "complete" && row.processing_result.treatment_requests === undefined && (await isAuthoritative(A, 2024, id)) ? true : row.status;
  });
  await req1("REQ-E1-CONTRA", async () => {
    const id = await upload(A, 2018, csv(CONTRA)); await runHandler(U.owner, id);
    const row = await uploadRow(id); const pr = row.processing_result; const c = await latestCert(id);
    return contraOracle.difference === 0n && row.status === "complete" && amountsOk(pr) && pr.amounts.classes.liabilities_minor === contraOracle.liability.toString()
      && pr.amounts.equation.difference_minor === "0" && !(c?.exceptions ?? []).some((e) => e.code === "BALANCE_SHEET_EQUATION_FAILED")
      && (await isAuthoritative(A, 2018, id)) ? true : { status: row.status, classes: pr?.amounts?.classes, exceptions: c?.exceptions };
  });
  await req1("REQ-E1-GENUINE-EQUATION", async () => {
    const id = await upload(A, 2019, csv(GEN)); await runHandler(U.owner, id);
    const row = await uploadRow(id); const cs = await certs(id);
    const review = (row.processing_result?.needs_review_accounts ?? []).map((x) => x.account_code);
    return row.status === "needs_review" && row.is_valid === false && canon(review) === canon(["1800"]) && cs.length > 0 && cs.every((c) => c.requires_review && (c.rows_snapshot ?? []).length === 0)
      && (await authoritative(A, 2019)) === null ? true : { status: row.status, review, certs: cs.length };
  });
  await req1("REQ-E1-NONREPORTING-NONZERO", async () => {
    const id = await upload(A, 2020, csv(NONREP)); await runHandler(U.owner, id);
    const row = await uploadRow(id); const pr = row.processing_result;
    const review = (pr?.needs_review_accounts ?? []).map((x) => x.account_code);
    return row.status === "needs_review" && canon(review) === canon(["1410"]) && canon(pr.non_reporting_accounts ?? []) === "[]" && (await authoritative(A, 2020)) === null
      ? true : { status: row.status, review, non_reporting: pr?.non_reporting_accounts };
  });
  await req1("REQ-E1-NONREPORTING-ZERO", async () => {
    const rows = [["1400", "Bank nonrep", "3,000.00", ""], ["1410", "Suspense nonrep", "10.00", "10.00"], ["3400", "Capital nonrep", "", "3,000.00"]];
    const id = await upload(A, 2021, csv(rows)); await runHandler(U.owner, id);
    const row = await uploadRow(id);
    return row.status === "complete" && canon((row.processing_result.non_reporting_accounts ?? []).map((x) => x.account_code)) === canon(["1410"])
      && (await isAuthoritative(A, 2021, id)) ? true : row.status;
  });
  await req1("REQ-E1-PRECISION", async () => {
    // BHD (exponent 3): the suspended 1.235 is a non-zero account (review), and its amount is stated at the currency's exponent.
    const id = await upload(A, 2022, csv(BHD), { currency: "BHD" }); await runHandler(U.owner, id);
    const row = await uploadRow(id);
    const a = (row.processing_result?.needs_review_accounts ?? []).find((x) => x.account_code === "1510");
    return row.status === "needs_review" && /\b1\.235\b/.test(a?.reason ?? "") ? true : { status: row.status, a };
  });
  await req1("REQ-E1-INVARIANT", async () => {
    const id = await upload(A, 2023, csv(HAPPY)); const r = await runHandler(U.owner, id, uuid(), faulty);
    const row = await uploadRow(id);
    const run = await one("SELECT * FROM public.engine_runs WHERE source_record_id::text=$1 ORDER BY started_at DESC LIMIT 1", [id]);
    const key = run ? await one("SELECT status FROM public.idempotency_keys WHERE engine_run_id=$1", [run.id]) : null;
    const err = (row.accounting_errors ?? []).find((e) => e.code === "INVARIANT_VIOLATION");
    return r.http === 200 && row.status === "error" && row.is_valid === false && (await certs(id)).length === 0 && run?.status === "failed"
      && run?.error_code === "INVARIANT_VIOLATION" && key?.status === "failed" && /Difference: 0\.01\./.test(err?.message ?? "")
      // The recorded amounts are inconsistent (lhs ≠ assets), and the independent validator refuses them: never shown as a result.
      && row.processing_result?.amounts?.equation?.status === "failed" && validateTbAmounts(row.processing_result.amounts).ok === false
      && (await authoritative(A, 2023)) === null ? true : { http: r.http, status: row.status, run: run && { status: run.status, error_code: run.error_code }, key, err };
  });
  await req1("REQ-E1-REPROCESS-REQUIRED", async () => {
    // A direct new request on a certified upload is refused (409) by tb_begin_attempt: no run, no write, status kept.
    const id = await upload(A, 2025, csv(HAPPY)); await runHandler(U.owner, id);
    const before = await certs(id);
    const reqId = uuid();
    const r = await runHandler(U.owner, id, reqId);
    const row = await uploadRow(id);
    const runs = (await one("SELECT count(*)::int n FROM public.engine_runs WHERE source_record_id::text=$1", [id])).n;
    return before.length === 1 && r.http === 409 && r.body?.code === "REPROCESS_REQUIRED" && row.status === "complete" && (await certs(id)).length === 1
      && runs === 1 && (await isAuthoritative(A, 2025, id)) ? true : { http: r.http, body: r.body, status: row.status, runs };
  });
  await req1("X-E1-INV", async () => {
    // An invariant failure after a reprocess request leaves NO current authority: the earlier certification was
    // invalidated by the request and is never current again; the failed run certifies nothing.
    const id = await upload(A, 2026, csv(HAPPY)); await runHandler(U.owner, id);
    const first = await latestCert(id);
    const wasAuthoritative = (await authoritative(A, 2026)) === first?.id;
    const op = uuid();
    const acc = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [id, op, (await uploadRow(id)).source_file_hash]))[0].r;
    const r = await runHandler(U.owner, id, op, faulty);
    const row = await uploadRow(id);
    return wasAuthoritative && acc.outcome === "accepted" && r.http === 200 && row.status === "error" && (await certs(id)).length === 1
      && (await authoritative(A, 2026)) === null ? true : { wasAuthoritative, acc, http: r.http, status: row.status, authoritative: await authoritative(A, 2026) };
  });
  await req1("REQ-E1-GENERATION", async () => {
    // Every run is a current-engine attempt: version v3, integer generation 3, an attempt number and a lease.
    const rows = (await admin.query("SELECT engine_version, engine_generation, bool_and(attempt_no IS NOT NULL AND lease_expires_at IS NOT NULL) a, count(*)::int n FROM public.engine_runs WHERE function_name='process-trial-balance' GROUP BY 1,2 ORDER BY 1,2")).rows;
    return rows.length === 1 && rows[0].engine_version === "safisha-tb-certification-v3" && rows[0].engine_generation === 3 && rows[0].a === true ? true : rows;
  });

  await req1("REQ-E2-DEPENDENCY-STALE", async () => {
    // The real handler records what it consulted; a later review decision on one of those accounts makes the result a
    // re-check at read time (no fallback), while the certification itself is unchanged.
    const rows = [["1900", "Bank stale", "700.00", ""], ["3900", "Capital stale", "", "700.00"]];
    await review(U.owner, A, reviewUpload, [["1900", "Bank stale", "current_assets"], ["3900", "Capital stale", "equity"]]);
    const id = await upload(A, 2028, csv(rows)); await runHandler(U.owner, id);
    const was = await isAuthoritative(A, 2028, id);
    const cert = JSON.stringify(await latestCert(id));
    await review(U.owner, A, reviewUpload, [["1900", "Bank stale", "non_current_assets"]]);
    const now = await authoritative(A, 2028);
    return was && now === null && JSON.stringify(await latestCert(id)) === cert ? true : { was, now };
  });

  // ── Open-defect restrictions: the real handlers refuse before authenticating, reading or writing ──
  // Row counts of every table a restricted or withheld function can write (those that exist on this chain).
  const WRITE_TABLES = ["engine_runs", "idempotency_keys", "audit_logs", "tax_computations", "findings", "period_closing_balances",
    "adjusting_journal_entries", "aje_lines", "maono_insights", "variance_runs", "variance_analyses", "variance_alerts"];
  const writeCounts = async () => {
    const out = {};
    for (const t of WRITE_TABLES) {
      if ((await one("SELECT to_regclass($1) r", [`public.${t}`])).r) out[t] = (await one(`SELECT count(*)::int n FROM public.${t}`)).n;
    }
    return out;
  };
  for (const [rid, fn] of [["REQ-RESTRICTED-KINGA-FINDINGS", "kinga-findings-engine"], ["REQ-RESTRICTED-MAONO-COMPUTE", "maono-compute"],
    ["REQ-WITHHELD-TAX", "kinga-tax-engine"], ["REQ-WITHHELD-NOTES", "generate-disclosure-notes"], ["REQ-WITHHELD-LETTER", "generate-management-letter"]]) {
    await req1(rid, async () => {
      const restricted = (await loadFunctionTree(REPO, fn)).handler;
      const before = await writeCounts();
      const asOwner = await call(restricted, pool, mintTestJwt(U.owner), { company_id: A, upload_id: happy, uploadId: happy, companyId: A });
      const anonymous = await call(restricted, pool, null, {});
      const after = await writeCounts();
      return asOwner.http === 503 && asOwner.body?.code === "SERVICE_RESTRICTED" && anonymous.http === 503
        && canon(before) === canon(after) && !/kinga|maono|defect/i.test(JSON.stringify(asOwner.body)) ? true : { asOwner, anonymous };
    });
  }

  // ── X8: the previous engines on S2's schema ──────────────────────────────────────────────────────────────────────
  console.log("\n== X8: the previous engines are refused at their first write; the accepted request is completed by the current one");
  const x8Up = await upload(A, 2027, csv(HAPPY)); await runHandler(U.owner, x8Up);
  const x8Op = uuid();
  const x8Accepted = (await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [x8Up, x8Op, (await uploadRow(x8Up)).source_file_hash]))[0].r;
  const x8Snapshot = async () => canon({
    upload: await uploadRow(x8Up),
    runs: (await admin.query("SELECT * FROM public.engine_runs WHERE source_record_id=$1 ORDER BY started_at, id", [x8Up])).rows,
    certs: await certs(x8Up),
    keys: (await admin.query("SELECT k.* FROM public.idempotency_keys k JOIN public.engine_runs r ON r.id=k.engine_run_id WHERE r.source_record_id=$1 ORDER BY k.created_at, k.id", [x8Up])).rows,
    events: (await admin.query("SELECT e.* FROM public.engine_run_events e JOIN public.engine_runs r ON r.id=e.engine_run_id WHERE r.source_record_id=$1 ORDER BY e.id", [x8Up])).rows,
  });
  for (const [rid, engine] of [["X8-PREVIOUS-ENGINE-FENCED", prior], ["X8-E1-ENGINE-FENCED", e1]]) {
    await req1(rid, async () => {
      const before = await x8Snapshot();
      const r = await runHandler(U.owner, x8Up, x8Op, engine);
      const after = await x8Snapshot();
      return x8Accepted.outcome === "accepted" && r.http >= 400 && before === after && (await uploadRow(x8Up)).status === "processing" ? true : { http: r.http, body: r.body, unchanged: before === after };
    });
  }
  await req1("X8-REPLAY-COMPLETES", async () => {
    const r = await runHandler(U.owner, x8Up, x8Op);
    const row = await uploadRow(x8Up); const c = await latestCert(x8Up);
    return r.http === 200 && row.status === "complete" && c !== null && (await isAuthoritative(A, 2027, x8Up)) && (await certs(x8Up)).length === 2 ? true : { http: r.http, body: r.body, status: row.status };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; infraFailure = e; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
finally { await stopDatabase(); }

// ── Gate: requirements pass; every registered probe reproduced exactly; nothing missing; no infrastructure failure ────
const v = gateVerdict({ requiredRequirements: REQUIRED_REQUIREMENTS, requirementResults: results.requirement, registeredProbes: REQUIRED_PROBES,
  probeResults: results.probe, infrastructureFailure: crashed || infraFailure !== null });
console.log("\n──────────────────────────────────────────");
console.log(`requirements: ${results.requirement.size - v.failedRequirements.length}/${REQUIRED_REQUIREMENTS.length} passed${v.failedRequirements.length ? ` — FAILED: ${v.failedRequirements.join(", ")}` : ""}${v.missingRequirements.length ? ` — NOT RUN: ${v.missingRequirements.join(", ")}` : ""}`);
console.log(`known defects reproduced (not passes): ${v.reproduced.length}/${REQUIRED_PROBES.length} — ${v.reproduced.join(", ") || "none"}`);
const probeProblems = [...v.badProbes, ...v.missingProbes.map((x) => `${x}:not-run`), ...v.unregisteredProbes.map((x) => `${x}:unregistered`)];
if (probeProblems.length) console.log(`probe failures: ${probeProblems.join(", ")}`);
console.log(v.ok ? "H2_CHARACTERIZATION: GATE PASSED (requirements pass; every registered defect reproduced exactly)" : "H2_CHARACTERIZATION: GATE FAILED");
process.exit(v.ok ? 0 : 1);
