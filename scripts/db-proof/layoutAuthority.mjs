#!/usr/bin/env bun
// Real-PostgreSQL proof of I1-A layouts (migration 20261010100000) with the REAL handlers: trial-balance-layout and
// process-trial-balance (generation 4), plus process-trial-balance as it is on origin/main (generation 3) for the mixed
// versions. Only the network edges are replaced (lib/functionHarness.mjs); every request runs as the caller's real role.
//
//   templates      versioned, insert-only, no source hash; expected version; retry replays; tenant-scoped keys;
//   confirmations  bound to the source hash and the resolved layout hash; server-side full-file validation with every
//                  row's disposition; expected confirmation number; retry replays; concurrent confirms → exactly one;
//                  append-only for every role; prepare_close required; another tenant refused;
//   reuse          a template re-validated on another file: header drift, missing column, number-format mismatch refused;
//   processing     a confirmed European layout is certified; the '#layout_confirmation' dependency is recorded and a new
//                  confirmation makes the result "Needs re-check"; a confirmation racing an attempt is refused;
//   compatibility  a generation-3 handler is refused at begin (nothing written) for an upload with a confirmation and
//                  still works for one without; a certification from before layouts needs a re-check before a
//                  confirmation; a generation-4 handler on a database without the layout tables refuses before any write.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/layoutAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, functionsAtCommit, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const A2_FILE = "20261010100000_layout_templates_and_confirmations.sql";
// The generation-3 engine: process-trial-balance as merged on main before this work (E2 / S2).
const GENERATION_3_COMMIT = "553d54cac9921cfc7b2698842bd4fff2a6be8f1b";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 600)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}
async function refused(name, code, fn, text) {
  try { await fn(); record(name, false, "no error was raised"); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-layout-proof-"));
  const port = 55000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE layout_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/layout_proof`;
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
const asUser = (uid, sql, p) => asRole("authenticated", uid, sql, p);
const asService = (sql, p) => asRole("service_role", null, sql, p);
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);

const EURO = 'Code;Name;Soll;Haben\n1000;Bank;"1.500,25";\n3000;Share capital;;"1.000,00"\n4000;Sales;;"900,25"\n6000;Rent;"400,00";\n';
const EURO_LAYOUT = {
  format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
  columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] },
};
const PLAIN = "Code,Name,Debit,Credit\n1000,Bank,1500.25,\n3000,Share capital,,1000.00\n4000,Sales,,900.25\n6000,Rent,400.00,\n";

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 30 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);

  group("Replay — the whole chain, A2 included");
  await check(`${A2_FILE} is in the chain and the whole chain (with every later migration) applies`, async () => {
    if (!files.includes(A2_FILE)) return `${A2_FILE} missing`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });
  await refused("applying A2 again is refused by its preflight (nothing is replaced)", "P0001", () => admin.query(migrationSql(REPO, A2_FILE)), "PREFLIGHT_REFUSED");

  const layoutFn = (await loadFunctionTree(REPO, "trial-balance-layout")).handler;
  const ptb = (await loadFunctionTree(REPO, "process-trial-balance")).handler;
  const ptbGen3 = (await loadFunctionTree(REPO, "process-trial-balance", { functionsDir: functionsAtCommit(REPO, GENERATION_3_COMMIT, "process-trial-balance") })).handler;

  const U = { owner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  for (const [k, role] of [["preparer", "preparer"], ["viewer", "viewer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);
  const cap = async (uid, c) => (await one("SELECT public.has_workspace_capability($1,$2,'prepare_close') v", [A, uid])).v === c;

  group("Setup — capabilities as the workspace grants them");
  await check("owner and preparer hold prepare_close; viewer does not", async () =>
    (await cap(U.owner, true)) && (await cap(U.preparer, true)) && (await cap(U.viewer, false)) ? true : "unexpected capability matrix");

  let year = 2000;
  async function upload(company, text, { fileName = "tb.csv", currency = "TZS" } = {}) {
    const owner = company === A ? U.owner : U.ownerB;
    const y = ++year;
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,$5,$6,$2) RETURNING id",
      [company, `${y}-12-31`, `FY${y}`, owner, currency, `${y}-01-01`])).id;
    const filePath = `${owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ($1,$2,$3,'processing',$4,$5,$6,$7) RETURNING id`, [fileName, filePath, text.length, company, y, pid, owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(text));
    return { id, year: y, bytes: new TextEncoder().encode(text) };
  }
  const L = (uid, body) => call(layoutFn, pool, uid ? mintTestJwt(uid) : null, body);
  const process = (uid, uploadId, h = ptb) => call(h, pool, mintTestJwt(uid), { uploadId, clientRequestId: uuid() });
  const confirmations = (uploadId) => admin.query("SELECT * FROM public.layout_confirmations WHERE upload_id=$1 ORDER BY confirmation_no", [uploadId]).then((r) => r.rows);
  const authoritative = async (company, y) => (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [company, y]))?.id ?? null;
  // Every account reviewed, so the trial balances below certify (the review RPC, as the product records it).
  const seed = await upload(A, PLAIN);
  const NORMAL = { current_assets: "debit", equity: "credit", revenue: "credit", operating_expenses: "debit" };
  const decisions = [["1000", "Bank", "current_assets", "balance_sheet"], ["3000", "Share capital", "equity", "balance_sheet"], ["4000", "Sales", "revenue", "income_statement"], ["6000", "Rent", "operating_expenses", "income_statement"]]
    .map(([code, name, cls, st]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: NORMAL[cls] }));
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, seed.id, uuid(), JSON.stringify(decisions)]);

  group("Inspect and validate — reads only, the whole file");
  const euro = await upload(A, EURO);
  await check("inspect: the sheet preview, the automatic suggestion, the number-format evidence and confirmation 0", async () => {
    const r = await L(U.owner, { action: "inspect", uploadId: euro.id });
    const s = r.body?.sheets?.[0];
    return r.http === 200 && r.body.kind === "csv" && r.body.currentConfirmationNo === 0 && r.body.sourceFileHash === sha(euro.bytes)
      && s.rowCount === 5 && s.preview[1].cells[2] === "1.500,25" ? true : r;
  });
  await check("anonymous → 401; another tenant → 403; nothing recorded", async () => {
    const a = await L(null, { action: "inspect", uploadId: euro.id });
    const b = await L(U.ownerB, { action: "inspect", uploadId: euro.id });
    const c = await L(U.outsider, { action: "validate", uploadId: euro.id, layout: EURO_LAYOUT });
    return a.http === 401 && b.http === 403 && c.http === 403 && (await confirmations(euro.id)).length === 0 ? true : [a.http, b.http, c.http];
  });
  await check("another workspace's owner: inspect, validate and confirm are each refused 403 with the same body; the stored file is never read; nothing is recorded or changed", async () => {
    const reads = [];
    const realGet = shim.storage.get.bind(shim.storage);
    shim.storage.get = (k) => { reads.push(k); return realGet(k); };
    const before = JSON.stringify(await one("SELECT status, processing_attempt, source_file_hash, current_engine_run_id FROM public.trial_balance_uploads WHERE id=$1", [euro.id]));
    const counts = async () => JSON.stringify(await one("SELECT (SELECT count(*) FROM public.layout_confirmations)::int c, (SELECT count(*) FROM public.layout_templates)::int t, (SELECT count(*) FROM public.engine_runs)::int r"));
    const n0 = await counts();
    let rs;
    try {
      rs = [
        await L(U.ownerB, { action: "inspect", uploadId: euro.id }),
        await L(U.ownerB, { action: "validate", uploadId: euro.id, layout: EURO_LAYOUT }),
        await L(U.ownerB, { action: "confirm", uploadId: euro.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0, numberFormatConfirmed: true }),
      ];
    } finally { shim.storage.get = realGet; }
    const after = JSON.stringify(await one("SELECT status, processing_attempt, source_file_hash, current_engine_run_id FROM public.trial_balance_uploads WHERE id=$1", [euro.id]));
    const bodies = new Set(rs.map((r) => JSON.stringify(r.body)));
    return rs.every((r) => r.http === 403) && bodies.size === 1 && reads.length === 0 && before === after && (await counts()) === n0
      ? true : { http: rs.map((r) => r.http), bodies: [...bodies], reads, before, after };
  });
  await check("validate: the layout fits, every row has a disposition, exact totals; nothing is written", async () => {
    const r = await L(U.viewer, { action: "validate", uploadId: euro.id, layout: EURO_LAYOUT });
    const rep = r.body?.report;
    return r.http === 200 && rep.layoutFits === true && rep.rows.length === 5 && rep.rows[0][1] === "header"
      && rep.totals.debit === "1900.25" && rep.totals.credit === "1900.25" && rep.issues.length === 0
      && (await confirmations(euro.id)).length === 0 ? true : r.body;
  });
  await check("an incomplete layout is refused with reasons (400)", async () => {
    const r = await L(U.owner, { action: "validate", uploadId: euro.id, layout: { ...EURO_LAYOUT, numberFormat: "auto" } });
    return r.http === 400 && r.body.errors.some((e) => /number format/.test(e)) ? true : r;
  });

  group("Confirmations — bound, server-validated, append-only, versioned");
  let first;
  await check("a viewer cannot confirm (prepare_close): 403, nothing recorded", async () => {
    const r = await L(U.viewer, { action: "confirm", uploadId: euro.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    return r.http === 403 && r.body.code === "FORBIDDEN" && (await confirmations(euro.id)).length === 0 ? true : r;
  });
  await check("the preparer confirms: bound to the source hash and the resolved hash; every row's disposition kept; actor = firm member", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: euro.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    const rows = await confirmations(euro.id);
    first = rows[0];
    const member = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.preparer])).id;
    return r.http === 200 && r.body.confirmationNo === 1 && rows.length === 1 && first.source_file_hash === sha(euro.bytes)
      && first.resolved_profile_sha256 === r.body.report.resolvedProfileSha256 && first.rows_read === 5
      && first.row_dispositions.length === 5 && first.validation.layoutFits === true
      && first.actor_type === "user" && first.firm_member_id === member && first.actor_user_id === null ? true : { r: r.body, first };
  });
  await check("the same confirmation retried: replayed, still one row", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: euro.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    return r.http === 200 && r.body.replay === true && (await confirmations(euro.id)).length === 1 ? true : r.body;
  });
  await check("a different layout with a stale expected number: VERSION_CONFLICT (409), nothing recorded", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: euro.id, layout: { ...EURO_LAYOUT, columns: { ...EURO_LAYOUT.columns, accountCode: null } }, expectedConfirmationNo: 0 });
    return r.http === 409 && r.body.code === "VERSION_CONFLICT" && r.body.currentConfirmationNo === 1 && (await confirmations(euro.id)).length === 1 ? true : r.body;
  });
  await check("a layout that does not fit the file is refused (422) with the full report; nothing recorded", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: euro.id, layout: { ...EURO_LAYOUT, numberFormat: "comma_dot" }, expectedConfirmationNo: 1 });
    return r.http === 422 && r.body.code === "LAYOUT_DOES_NOT_FIT" && r.body.report.issues.some((i) => i.code === "LAYOUT_NUMBER_FORMAT_MISMATCH")
      && (await confirmations(euro.id)).length === 1 ? true : r.body;
  });
  for (const [label, sql] of [["updated", "UPDATE public.layout_confirmations SET rows_read=0 WHERE upload_id=$1"], ["deleted", "DELETE FROM public.layout_confirmations WHERE upload_id=$1"]]) {
    await refused(`a confirmation cannot be ${label} — not even by the database owner`, "42501", () => admin.query(sql, [euro.id]));
  }
  await refused("confirmations cannot be truncated", "42501", () => admin.query("TRUNCATE public.layout_confirmations"));
  await refused("the service role cannot insert a confirmation directly", "42501", () => asService(
    "INSERT INTO public.layout_confirmations (upload_id,company_id,confirmation_no,source_file_hash,profile,profile_sha256,resolved_profile,resolved_profile_sha256,validation,row_dispositions,rows_read,actor_type,actor_user_id) VALUES ($1,$2,9,$3,$4,$3,$5,$3,'{}','[]',0,'workspace_user',$6)",
    [euro.id, A, "a".repeat(64), JSON.stringify(EURO_LAYOUT), JSON.stringify({ format: "layout-resolved/1", profileSha256: "a".repeat(64) }), U.owner]), "LAYOUT_RECORD_FENCED");
  await refused("an authenticated user cannot call the recording function", "42501", () => asUser(U.owner,
    "SELECT public.layout_record_confirmation($1,$2,1,$3,'{}',$3,'{}',$3,NULL,'{\"layoutFits\":true}','[]')", [U.owner, euro.id, "a".repeat(64)]));
  await check("members read their company's confirmations; another tenant reads none", async () => {
    const mine = await asUser(U.viewer, "SELECT count(*)::int n FROM public.layout_confirmations WHERE upload_id=$1", [euro.id]);
    const theirs = await asUser(U.ownerB, "SELECT count(*)::int n FROM public.layout_confirmations WHERE upload_id=$1", [euro.id]);
    return mine[0].n === 1 && theirs[0].n === 0 ? true : { mine, theirs };
  });
  await check("10 concurrent confirmations of different layouts with the same expected number → exactly one recorded", async () => {
    const up = await upload(A, EURO);
    // Two distinct layouts (with and without the name column) compete; the loser's requests conflict, the winner's replay.
    const variants = Array.from({ length: 10 }, (_, i) => ({ ...EURO_LAYOUT, columns: { ...EURO_LAYOUT.columns, accountName: i % 2 ? "Name" : null } }));
    const rs = await Promise.all(variants.map((v) => L(U.preparer, { action: "confirm", uploadId: up.id, layout: v, expectedConfirmationNo: 0 })));
    const rows = await confirmations(up.id);
    const ok = rs.filter((r) => r.http === 200 && r.body.confirmationNo === 1).length;
    const conflicts = rs.filter((r) => r.http === 409 && r.body.code === "VERSION_CONFLICT").length;
    return rows.length === 1 && ok + conflicts === 10 && ok >= 1 ? true : { rows: rows.length, codes: rs.map((r) => r.body?.code ?? r.body?.status) };
  });

  group("Templates — versioned, no file identity, expected version");
  const key = uuid();
  await check("save version 1; a retry replays; the template row carries no source hash", async () => {
    const a = await L(U.preparer, { action: "save_template", companyId: A, templateKey: key, expectedVersion: 0, name: "German export", layout: EURO_LAYOUT });
    const b = await L(U.preparer, { action: "save_template", companyId: A, templateKey: key, expectedVersion: 0, name: "German export", layout: EURO_LAYOUT });
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='layout_templates'")).rows.map((r) => r.column_name);
    const t = await one("SELECT * FROM public.layout_templates WHERE template_key=$1", [key]);
    return a.http === 200 && a.body.version === 1 && b.body.replay === true && !cols.some((c) => /^(source_|upload_|file_)/.test(c))
      && !JSON.stringify(t.profile).match(/hash|source/i) && t.firm_member_id !== null ? true : { a: a.body, b: b.body, cols };
  });
  await check("an edit is version 2 (expected 1); the same edit with a stale expected version conflicts", async () => {
    const edited = { ...EURO_LAYOUT, columns: { ...EURO_LAYOUT.columns, accountName: "Bezeichnung" } };
    const a = await L(U.preparer, { action: "save_template", companyId: A, templateKey: key, expectedVersion: 1, name: "German export", layout: edited });
    const b = await L(U.preparer, { action: "save_template", companyId: A, templateKey: key, expectedVersion: 1, name: "German export v2b", layout: EURO_LAYOUT });
    return a.body.version === 2 && b.http === 409 && b.body.code === "VERSION_CONFLICT" && b.body.currentVersion === 2
      && (await count("SELECT count(*) n FROM public.layout_templates WHERE template_key=$1", [key])) === 2 ? true : { a: a.body, b: b.body };
  });
  await check("another tenant cannot add to this template key; a viewer cannot save", async () => {
    const a = await L(U.ownerB, { action: "save_template", companyId: B, templateKey: key, expectedVersion: 2, name: "x", layout: EURO_LAYOUT });
    const b = await L(U.viewer, { action: "save_template", companyId: A, templateKey: uuid(), expectedVersion: 0, name: "x", layout: EURO_LAYOUT });
    return a.body.code === "TEMPLATE_NOT_FOUND" && b.http === 403 ? true : { a: a.body, b: b.body };
  });
  await refused("a template cannot be edited in place", "42501", () => admin.query("UPDATE public.layout_templates SET name='x' WHERE template_key=$1", [key]));

  group("Reuse — a template re-validated on another file");
  for (const [label, text, code] of [
    ["header drift (the header moved down a row)", "Export\n" + EURO, "LAYOUT_COLUMN_NOT_FOUND"],
    ["a missing column", EURO.replace("Haben", "Kredit"), "LAYOUT_COLUMN_NOT_FOUND"],
    ["amounts in another number format", 'Code;Name;Soll;Haben\n1000;Bank;"1,500.25";\n3000;Capital;;"1,500.25"\n', "LAYOUT_NUMBER_FORMAT_MISMATCH"],
  ]) {
    await check(`${label}: refused (${code}); nothing recorded`, async () => {
      const up = await upload(A, text);
      const t = await one("SELECT id, profile FROM public.layout_templates WHERE template_key=$1 AND version=1", [key]);
      const r = await L(U.preparer, { action: "confirm", uploadId: up.id, layout: t.profile, templateId: t.id, expectedConfirmationNo: 0 });
      return r.http === 422 && r.body.report.issues.some((i) => i.code === code) && (await confirmations(up.id)).length === 0 ? true : r.body;
    });
  }
  await check("the same template on a matching file confirms, recording the template it came from", async () => {
    const up = await upload(A, EURO);
    const t = await one("SELECT id, profile FROM public.layout_templates WHERE template_key=$1 AND version=1", [key]);
    const r = await L(U.preparer, { action: "confirm", uploadId: up.id, layout: t.profile, templateId: t.id, expectedConfirmationNo: 0 });
    const rows = await confirmations(up.id);
    return r.http === 200 && rows[0].template_id === t.id ? true : r.body;
  });

  group("Processing — generation 4 reads the confirmed layout");
  await check("the automatic path cannot read the European file (not certified as balanced)", async () => {
    const up = await upload(A, EURO);
    const r = await process(U.owner, up.id);
    return r.http === 200 && (await one("SELECT status FROM public.trial_balance_uploads WHERE id=$1", [up.id])).status !== "complete" ? true : r.body;
  });
  let euroCert;
  await check("confirmed European layout → complete and authoritative; the layout dependency recorded at its revision", async () => {
    const r = await process(U.owner, euro.id);
    const row = await one("SELECT status, current_engine_run_id FROM public.trial_balance_uploads WHERE id=$1", [euro.id]);
    const dep = await one("SELECT revision FROM public.engine_run_dependencies WHERE engine_run_id=$1 AND dep_key=$2", [row.current_engine_run_id, `#layout_confirmation:${euro.id}`]);
    const run = await one("SELECT engine_generation, engine_version FROM public.engine_runs WHERE id=$1", [row.current_engine_run_id]);
    euroCert = await authoritative(A, euro.year);
    return r.http === 200 && row.status === "complete" && Number(dep?.revision) === 1 && run.engine_generation === 4 && euroCert !== null ? true : { r: r.body, row, dep, run };
  });
  await check("a new confirmation after certification → the result is no longer authoritative (Needs re-check)", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: euro.id, layout: { ...EURO_LAYOUT, columns: { ...EURO_LAYOUT.columns, accountName: null } }, expectedConfirmationNo: 1 });
    return r.http === 200 && r.body.confirmationNo === 2 && (await authoritative(A, euro.year)) === null ? true : { r: r.body };
  });
  await check("a confirmation while an attempt is running is refused (IN_PROGRESS)", async () => {
    const up = await upload(A, EURO);
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v4',4,'workspace_user',NULL,$4,600) r", [up.id, uuid(), sha(up.bytes), U.owner]))[0].r;
    const r = await L(U.preparer, { action: "confirm", uploadId: up.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    return b.outcome === "claimed" && r.http === 409 && r.body.code === "IN_PROGRESS" ? true : { b, r: r.body };
  });
  await check("the layout dependency key is accepted only for the run's own upload", async () => {
    const up = await upload(A, PLAIN);
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v4',4,'workspace_user',NULL,$4,600) r", [up.id, uuid(), sha(up.bytes), U.owner]))[0].r;
    let other = null;
    try { await asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb)", [b.engine_run_id, JSON.stringify([{ scope: A, key: `#layout_confirmation:${euro.id}` }])]); other = "accepted"; } catch (e) { other = e.code; }
    const own = (await asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r", [b.engine_run_id, JSON.stringify([{ scope: A, key: `#layout_confirmation:${up.id}` }])]))[0].r;
    return other === "22023" && own.recorded === 1 ? true : { other, own };
  });

  group("Compatibility — mixed handler and schema versions");
  await check("generation 3 (origin/main) on an upload WITH a confirmation: refused at begin, no run, upload unchanged", async () => {
    const up = await upload(A, EURO);
    await L(U.preparer, { action: "confirm", uploadId: up.id, layout: EURO_LAYOUT, expectedConfirmationNo: 0 });
    const before = JSON.stringify(await one("SELECT status, processing_attempt, current_engine_run_id, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [up.id]));
    const r = await process(U.owner, up.id, ptbGen3);
    const after = JSON.stringify(await one("SELECT status, processing_attempt, current_engine_run_id, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [up.id]));
    return r.http === 409 && before === after && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up.id])) === 0 ? true : { r: r.body, before, after };
  });
  let gen3Upload;
  await check("generation 3 on an upload WITHOUT a confirmation still certifies (existing behaviour)", async () => {
    gen3Upload = await upload(A, PLAIN);
    const r = await process(U.owner, gen3Upload.id, ptbGen3);
    return r.http === 200 && (await authoritative(A, gen3Upload.year)) !== null ? true : r.body;
  });
  await check("a certification from before layouts: a confirmation is refused until a re-check is requested (REPROCESS_REQUIRED)", async () => {
    const r = await L(U.preparer, { action: "confirm", uploadId: gen3Upload.id, layout: { ...EURO_LAYOUT, numberFormat: "comma_dot", columns: { ...EURO_LAYOUT.columns, debit: "Debit", credit: "Credit" }, sheet: { kind: "csv" } }, expectedConfirmationNo: 0 });
    return r.http === 409 && r.body.code === "REPROCESS_REQUIRED" && (await confirmations(gen3Upload.id)).length === 0 ? true : r.body;
  });
  await check("generation 4 on a database without the layout tables: 503 before any write (no download, no run)", async () => {
    const up = await upload(A, PLAIN);
    await admin.query("ALTER TABLE public.layout_confirmations RENAME TO layout_confirmations_hidden");
    let r;
    try { r = await process(U.owner, up.id); } finally { await admin.query("ALTER TABLE public.layout_confirmations_hidden RENAME TO layout_confirmations"); }
    const row = await one("SELECT status, processing_attempt, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [up.id]);
    return r.http === 503 && r.body.code === "LAYOUT_AUTHORITY_UNAVAILABLE" && row.status === "processing" && row.processing_attempt === 0 && row.source_file_hash === null
      && (await count("SELECT count(*) n FROM public.engine_runs WHERE source_record_id=$1", [up.id])) === 0 ? true : { r: r.body, row };
  });
  await check("the layout function on a database without its writer reports 'unavailable', never a raw error", async () => {
    await admin.query("ALTER FUNCTION public.layout_save_template(uuid,uuid,uuid,integer,text,jsonb,text) RENAME TO layout_save_template_hidden");
    let r;
    try { r = await L(U.preparer, { action: "save_template", companyId: A, templateKey: uuid(), expectedVersion: 0, name: "x", layout: EURO_LAYOUT }); }
    finally { await admin.query("ALTER FUNCTION public.layout_save_template_hidden(uuid,uuid,uuid,integer,text,jsonb,text) RENAME TO layout_save_template"); }
    return r.http === 503 && r.body.code === "LAYOUT_AUTHORITY_UNAVAILABLE" ? true : r;
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "LAYOUT_AUTHORITY: ALL PASSED" : "LAYOUT_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
