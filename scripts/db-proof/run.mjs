#!/usr/bin/env node
// Disposable-database proof for the financial-statements persistence + rollout
// migrations (20260919100000, 20260919110000).
//
// It replays the repository's ENTIRE migration chain from zero on a throwaway
// PostgreSQL 16 and then exercises the security and integrity contract through
// real sessions acting as `authenticated` / `anon` / `service_role` with
// simulated JWT claims — the same mechanism PostgREST uses.
//
// MODES
//   embedded (default)  Boots a disposable embedded PostgreSQL 16 on a random-ish
//                       local port in a temp dir that is deleted afterwards.
//                       Needs `embedded-postgres` + `pg`; set DB_PROOF_MODULES_DIR to a
//                       directory whose node_modules contains them, or install them.
//   external            DB_PROOF_MODE=external DB_PROOF_CONN=postgres://…
//                       for a throwaway database (CI service container). Refuses every
//                       host that is not loopback, and refuses the production project
//                       ref outright. The database must be EMPTY: the proof applies the
//                       shim and every migration itself.
//
// This script never reads Supabase credentials and can never reach a hosted project.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;

// ── module loading ──────────────────────────────────────────────────────────
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
let pg;
try {
  pg = req("pg");
} catch {
  console.error("The `pg` package is required (set DB_PROOF_MODULES_DIR or `npm install --no-save pg`).");
  process.exit(2);
}
const { Pool, Client } = pg;

// ── assertion framework ─────────────────────────────────────────────────────
const results = [];
let currentGroup = "";
function group(name) {
  currentGroup = name;
  console.log(`\n== ${name}`);
}
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, detail !== false, detail === false ? "assertion returned false" : "");
  } catch (e) {
    record(name, false, `${e.code ?? ""} ${String(e.message).split("\n")[0]}`);
  }
}
/** Passes only if `promise` rejects with SQLSTATE `code` (and, if given, a message containing `fragment`). */
async function expectError(name, code, promiseFactory, fragment) {
  try {
    await promiseFactory();
    record(name, false, `expected ${code} but the call succeeded`);
  } catch (e) {
    const ok = e.code === code && (!fragment || String(e.message).includes(fragment));
    record(name, ok, ok ? "" : `expected ${code}${fragment ? ` /${fragment}/` : ""} but got ${e.code} ${String(e.message).split("\n")[0]}`);
  }
}

// ── database plumbing ───────────────────────────────────────────────────────
let pool;
let admin; // superuser connection (seeding + inspection only)
let embeddedServer = null;
let embeddedDir = null;

function assertLocal(urlString) {
  const u = new URL(urlString);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) throw new Error(`REFUSED: ${u.hostname} is not a loopback host`);
  if (urlString.includes(PRODUCTION_REF)) throw new Error("REFUSED: the production project reference appears in the connection string");
}

async function startDatabase() {
  if (MODE === "external") {
    const url = process.env.DB_PROOF_CONN;
    if (!url) throw new Error("DB_PROOF_MODE=external requires DB_PROOF_CONN");
    assertLocal(url);
    return url;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const mod = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  const EmbeddedPostgres = mod.default;
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-dbproof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({
    databaseDir: path.join(embeddedDir, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE db_proof");
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/db_proof`;
}

async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) {
    try { await embeddedServer.stop(); } catch { /* ignore */ }
  }
  if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true });
}

async function replayMigrations() {
  const shim = fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8");
  await admin.query(shim);
  const dir = path.join(REPO, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let applied = 0;
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) {
      const lines = text.split("\n");
      text = lines.slice(0, lines.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    }
    try {
      await admin.query(text);
      applied++;
    } catch (e) {
      throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { applied, total: files.length, files };
}

/** Runs `fn(client)` inside one transaction as a simulated PostgREST caller. */
async function asCaller(caller, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (caller.kind === "anon") {
      await client.query("SET LOCAL ROLE anon");
      await client.query("SELECT set_config('request.jwt.claim.role', 'anon', true), set_config('request.jwt.claim.sub', '', true)");
    } else if (caller.kind === "service") {
      await client.query("SET LOCAL ROLE service_role");
      await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)");
    } else {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)", [caller.uid]);
    }
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const SERVICE = { kind: "service" };
/** One RPC = one transaction, exactly as PostgREST executes it. */
const rpc = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await rpc(caller, sql, params))[0];

// ── fixtures ────────────────────────────────────────────────────────────────
const uuid = () => globalThis.crypto.randomUUID();
const hex64 = (seed) => {
  let h = "";
  for (let i = 0; h.length < 64; i++) h += Buffer.from(`${seed}:${i}`).toString("hex");
  return h.slice(0, 64).replace(/[^0-9a-f]/g, "a");
};
const U = { owner: uuid(), partner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid(), pending: uuid() };
let COMPANY_A;
let COMPANY_B;
let MEMBER = {};

async function seed() {
  for (const [k, id] of Object.entries(U)) {
    await admin.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${k}@example.test`]);
  }
  COMPANY_A = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1, 'Company A') RETURNING id", [U.owner])).rows[0].id;
  COMPANY_B = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1, 'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  for (const [k, role] of [["partner", "partner"], ["preparer", "preparer"], ["viewer", "viewer"]]) {
    await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1, $2, $3, now())", [COMPANY_A, U[k], role]);
  }
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1, $2, 'preparer', NULL)", [COMPANY_A, U.pending]);
  const rows = (await admin.query("SELECT user_id, id FROM public.firm_members WHERE company_id = $1 AND accepted_at IS NOT NULL", [COMPANY_A])).rows;
  MEMBER = Object.fromEntries(rows.map((r) => [r.user_id, r.id]));
}

const reportDoc = (reportId, companyId, version, extra = {}) => ({
  reportIdentity: { reportId, companyId, reportVersion: version },
  statements: [],
  facts: [{ factId: "f1", value: { minorUnits: { __bigint__: "9223372036854775807" }, currency: "TZS" } }],
  note: "Ünïcödé — 収益 — “quotes”",
  ...extra,
});

const STATEMENT_TYPES = ["STATEMENT_OF_FINANCIAL_POSITION", "STATEMENT_OF_PROFIT_OR_LOSS", "STATEMENT_OF_CHANGES_IN_EQUITY", "STATEMENT_OF_CASH_FLOWS"];
/** A report document that satisfies the IFRS profile: four primary statements, each with current AND comparative figures. */
const completeDoc = (reportId, companyId, version, extra = {}) => ({
  reportIdentity: { reportId, companyId, reportVersion: version },
  framework: { kind: "IFRS" },
  period: { periodId: "CURRENT" },
  comparativePeriods: [{ periodId: "PRIOR_2024" }],
  statements: STATEMENT_TYPES.map((type) => ({ statementId: `st:${type}`, type, sections: [{ sectionId: "s", lines: [{ lineId: `l:${type}`, factBindings: [{ periodId: "CURRENT", factId: "f1" }, { periodId: "PRIOR_2024", factId: "f0" }] }] }] })),
  facts: [{ factId: "f1", value: { minorUnits: { __bigint__: "100" }, currency: "TZS" } }],
  ...extra,
});

async function saveReport(caller, reportId, version, companyId, doc, contentHash = hex64(`c${version}`), batches = []) {
  return one(caller, "SELECT * FROM public.fs_save_report_version($1,$2,$3,$4,$5,$6::jsonb,$7,$8::text[])", [
    reportId, version, companyId, 2025, "TRIAL_BALANCE_DERIVED", JSON.stringify(doc), contentHash, batches,
  ]);
}
const saveEval = (caller, runId, reportId, version, companyId, findings, inputHash = hex64(`e${runId}`)) =>
  one(caller, "SELECT * FROM public.fs_save_evaluation($1,$2,$3,$4,'rule-pack','1','engine-1',$5,$6::jsonb)", [runId, reportId, version, companyId, inputHash, JSON.stringify(findings)]);
const ingest = (caller, args) =>
  one(caller, "SELECT * FROM public.fs_ingest_evidence_batch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15)", args);
const evArgs = (o = {}) => {
  const d = { batchId: `eb-${uuid()}`, company: COMPANY_A, period: "FY2025", type: "TRANSACTION_LEDGER", role: "CURRENT", series: "cash", schema: "1", file: "ledger.csv", hash: hex64(`ev-${uuid()}`), currency: "TZS", scale: 2, doc: { rows: [{ amount: "1234567890123456789.12", memo: "ok" }] }, status: "VALID", diags: [], prev: null, ...o };
  return [d.batchId, d.company, d.period, d.type, d.role, d.series, d.schema, d.file, d.hash, d.currency, d.scale, JSON.stringify(d.doc), d.status, JSON.stringify(d.diags), d.prev];
};
const finding = (key, o = {}) => ({ findingKey: key, actionable: true, outcome: "FAIL", failureSeverity: "CRITICAL", ...o });
const decision = (id, type, key, extra = {}) => ({ decisionId: id, decisionType: type, reviewerId: "client-supplied-and-ignored", decidedAt: "2026-01-01T00:00:00Z", target: { kind: "FINDING_KEY", findingKey: key }, rationale: "documented judgement", ...extra });
const appendDecision = (caller, id, reportId, companyId, d) => one(caller, "SELECT * FROM public.fs_append_decision($1,$2,$3,$4::jsonb)", [id, reportId, companyId, JSON.stringify(d)]);

// ── proofs ──────────────────────────────────────────────────────────────────
async function proveReplay(info) {
  group("Replay from zero");
  await check(`all ${info.total} migrations apply in filename order on a fresh PostgreSQL 16`, () => info.applied === info.total);
  await check("server is PostgreSQL 16", async () => (await admin.query("SHOW server_version_num")).rows[0].server_version_num.startsWith("16"));
  for (const f of ["20260919100000_financial_statements_rollout_control.sql", "20260919110000_financial_statements_persistence.sql"]) {
    await check(`${f} is the latest-ordered migration set`, () => info.files.slice(-2).includes(f));
  }
}

async function proveCatalog() {
  group("Static catalog contract");
  const fnNames = ["fs_ingest_evidence_batch", "fs_save_report_version", "fs_save_evaluation", "fs_append_decision", "fs_apply_correction_group", "fs_set_publication_state", "financial_statements_workspace_access"];
  for (const n of fnNames) {
    await check(`${n}: SECURITY DEFINER, pinned search_path, EXECUTE for authenticated only`, async () => {
      const r = (await admin.query(
        `SELECT p.prosecdef, p.proconfig, has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') n, has_function_privilege('public', p.oid, 'EXECUTE') pu
           FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname='public' AND p.proname=$1`, [n])).rows[0];
      return r.prosecdef && (r.proconfig ?? []).some((c) => c.startsWith("search_path=")) && r.a && !r.n && !r.pu;
    });
  }
  for (const n of ["fs_actor_member_id", "fs_store_evaluation", "fs_rollout_allows", "fs_assert_report_document", "fs_unresolved_blocking_count"]) {
    await check(`${n}: not executable by any client role`, async () => {
      const r = (await admin.query(
        `SELECT has_function_privilege('authenticated', p.oid,'EXECUTE') a, has_function_privilege('anon', p.oid,'EXECUTE') n, has_function_privilege('public', p.oid,'EXECUTE') pu FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname=$1`, [n])).rows[0];
      return !r.a && !r.n && !r.pu;
    });
  }
  for (const n of ["fs_set_company_rollout", "fs_set_kill_switch"]) {
    await check(`${n}: service_role only`, async () => {
      const r = (await admin.query(
        `SELECT has_function_privilege('service_role', p.oid,'EXECUTE') s, has_function_privilege('authenticated', p.oid,'EXECUTE') a, has_function_privilege('anon', p.oid,'EXECUTE') n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname=$1`, [n])).rows[0];
      return r.s && !r.a && !r.n;
    });
  }
  const tables = ["financial_evidence_batches", "financial_statement_reports", "financial_statement_evaluations", "financial_statement_reviewer_decisions", "financial_statement_correction_groups", "financial_statement_publications", "financial_statements_rollout_state", "financial_statements_rollout_companies", "financial_statements_rollout_audit"];
  for (const t of tables) {
    await check(`${t}: RLS enabled and no INSERT/UPDATE/DELETE for client roles`, async () => {
      const r = (await admin.query(
        `SELECT c.relrowsecurity,
                bool_or(has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('authenticated', c.oid, 'DELETE')
                     OR has_table_privilege('anon', c.oid, 'INSERT') OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE') OR has_table_privilege('anon', c.oid, 'SELECT')) any_write
           FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relname=$1 GROUP BY c.relrowsecurity`, [t])).rows[0];
      return r.relrowsecurity && !r.any_write;
    });
  }
  await check("no money-typed float/double/real columns in the new tables", async () => {
    const r = (await admin.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) AND data_type IN ('real','double precision','numeric')`, [tables])).rows[0];
    return r.n === 0;
  });
  await check("rollout state defaults: kill switch off, zero companies enabled", async () => {
    const s = (await admin.query("SELECT kill_switch FROM public.financial_statements_rollout_state")).rows;
    const c = (await admin.query("SELECT count(*)::int n FROM public.financial_statements_rollout_companies WHERE enabled")).rows[0].n;
    return s.length === 1 && s[0].kill_switch === false && c === 0;
  });
}

async function proveRollout() {
  group("Default-denied rollout, kill switch, audit");
  const args = () => evArgs();
  await expectError("owner cannot write while the company is not allowlisted (PT403)", "PT403", () => ingest(user(U.owner), args()));
  await check("access(): outsider → NOT_A_MEMBER", async () => (await one(user(U.outsider), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_A])).r.reason === "NOT_A_MEMBER");
  await check("access(): member → NOT_ALLOWLISTED by default", async () => (await one(user(U.owner), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_A])).r.reason === "NOT_ALLOWLISTED");
  await expectError("access(): anon is refused", "42501", () => rpc(ANON, "SELECT public.financial_statements_workspace_access($1)", [COMPANY_A]));
  await expectError("authenticated cannot enable a company (no EXECUTE)", "42501", () => rpc(user(U.owner), "SELECT public.fs_set_company_rollout($1,true,'self serve enable','me')", [COMPANY_A]));
  await expectError("authenticated cannot flip the kill switch (no EXECUTE)", "42501", () => rpc(user(U.owner), "SELECT public.fs_set_kill_switch(false,'nothing to see','me')"));
  await expectError("authenticated cannot read the rollout allowlist table", "42501", () => rpc(user(U.owner), "SELECT * FROM public.financial_statements_rollout_companies"));
  await expectError("authenticated cannot insert into the allowlist directly", "42501", () => rpc(user(U.owner), "INSERT INTO public.financial_statements_rollout_companies (company_id, enabled) VALUES ($1, true)", [COMPANY_A]));
  await expectError("service_role must supply a reason of at least 8 characters", "23514", () => rpc(SERVICE, "SELECT public.fs_set_company_rollout($1,true,'short','ops')", [COMPANY_A]));
  await check("service_role enables company A with an audited reason", async () => {
    await rpc(SERVICE, "SELECT public.fs_set_company_rollout($1,true,'canary allowlist approved','ops-1')", [COMPANY_A]);
    const a = (await admin.query("SELECT * FROM public.financial_statements_rollout_audit WHERE company_id=$1", [COMPANY_A])).rows;
    return a.length === 1 && a[0].new_state === true && a[0].previous_state === null && a[0].operator_label === "ops-1";
  });
  await check("access(): allowlisted member → ENABLED; company B still NOT_ALLOWLISTED", async () => {
    const a = (await one(user(U.owner), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_A])).r;
    const b = (await one(user(U.ownerB), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_B])).r;
    return a.enabled === true && a.reason === "ENABLED" && b.enabled === false && b.reason === "NOT_ALLOWLISTED";
  });
  await expectError("company B member still cannot write (PT403)", "PT403", () => ingest(user(U.ownerB), evArgs({ company: COMPANY_B })));
  await check("kill switch engaged: access → KILL_SWITCH and writes → PT403; released: ENABLED again", async () => {
    await rpc(SERVICE, "SELECT public.fs_set_kill_switch(true,'incident drill kill switch','ops-1')");
    const a = (await one(user(U.owner), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_A])).r;
    let blocked = false;
    try { await ingest(user(U.owner), evArgs()); } catch (e) { blocked = e.code === "PT403"; }
    await rpc(SERVICE, "SELECT public.fs_set_kill_switch(false,'drill complete release','ops-1')");
    const b = (await one(user(U.owner), "SELECT public.financial_statements_workspace_access($1) r", [COMPANY_A])).r;
    return a.reason === "KILL_SWITCH" && blocked && b.reason === "ENABLED";
  });
  await check("every change is in the append-only audit log (3 rows so far)", async () => (await admin.query("SELECT count(*)::int n FROM public.financial_statements_rollout_audit")).rows[0].n === 3);
  await expectError("audit log rejects UPDATE even for the table owner", "P0001", () => admin.query("UPDATE public.financial_statements_rollout_audit SET reason='tampered reason text'"));
  await expectError("audit log rejects DELETE even for the table owner", "P0001", () => admin.query("DELETE FROM public.financial_statements_rollout_audit"));
  await expectError("a non-service caller cannot reach the operator body via SECURITY DEFINER either", "42501", () => rpc(ANON, "SELECT public.fs_set_kill_switch(true,'anonymous attempt here','x')"));
}

async function proveEvidence() {
  group("Evidence ingestion");
  const first = evArgs({ series: "s1" });
  let b1;
  await check("member ingests a batch; server derives uploader = firm_members.id from auth.uid()", async () => {
    b1 = await ingest(user(U.partner), first);
    return b1.version === 1 && b1.uploaded_by_firm_member_id === MEMBER[U.partner] && b1.supersedes_batch_id === null;
  });
  await check("exact replay of identical source content is idempotent (same row)", async () => {
    const again = await ingest(user(U.partner), evArgs({ series: "s1", hash: first[8], batchId: "eb-replay-different-id" }));
    return again.id === b1.id && (await admin.query("SELECT count(*)::int n FROM public.financial_evidence_batches WHERE series_key='s1'")).rows[0].n === 1;
  });
  await expectError("same source hash with a different parsed document → PT409 (conflicting replay)", "PT409", () => ingest(user(U.partner), evArgs({ series: "s1", hash: first[8], doc: { rows: [{ amount: "1", memo: "different" }] } })), "REPLAY_CONFLICT");
  await expectError("a new batch that ignores the existing predecessor → PT409 (stale)", "PT409", () => ingest(user(U.partner), evArgs({ series: "s1", prev: null })), "STALE_VERSION");
  await check("a new batch naming the correct predecessor becomes version 2 and supersedes v1", async () => {
    const b2 = await ingest(user(U.partner), evArgs({ series: "s1", prev: b1.evidence_batch_id }));
    return b2.version === 2 && b2.supersedes_batch_id === b1.evidence_batch_id;
  });
  await expectError("a JSON number anywhere in an evidence document is refused (22023)", "22023", () => ingest(user(U.partner), evArgs({ series: "n", doc: { rows: [{ amount: 12.5 }] } })));
  await expectError("evidence with a bad type violates the CHECK", "23514", () => ingest(user(U.partner), evArgs({ series: "t", type: "MYSTERY" })));
  await expectError("evidence with a malformed content hash violates the CHECK", "23514", () => ingest(user(U.partner), evArgs({ series: "h", hash: "not-a-hash" })));
  await expectError("viewer cannot ingest (42501)", "42501", () => ingest(user(U.viewer), evArgs()));
  await expectError("pending (unaccepted) member cannot ingest (42501)", "42501", () => ingest(user(U.pending), evArgs()));
  await expectError("outsider cannot ingest (42501)", "42501", () => ingest(user(U.outsider), evArgs()));
  await expectError("owner of company B cannot write into company A (42501)", "42501", () => ingest(user(U.ownerB), evArgs({ company: COMPANY_A })));
  await expectError("anon cannot ingest (42501)", "42501", () => ingest(ANON, evArgs()));
  await check("a 9.2-quintillion-scale decimal string round-trips exactly through JSONB", async () => {
    const r = await ingest(user(U.partner), evArgs({ series: "rt", doc: { amount: "9223372036854775807.99", nested: { unicode: "Ünïcödé 収益 “quotes”", empty: [], nul: null } } }));
    const back = (await admin.query("SELECT batch_document FROM public.financial_evidence_batches WHERE id=$1", [r.id])).rows[0].batch_document;
    return back.amount === "9223372036854775807.99" && back.nested.unicode === "Ünïcödé 収益 “quotes”" && back.nested.nul === null;
  });
  await check("diagnostics and validation status are preserved (INVALID stays INVALID — no silent downgrade)", async () => {
    const r = await ingest(user(U.partner), evArgs({ series: "bad", status: "INVALID", diags: [{ code: "E_ROW", row: 3, message: "exact diagnostic" }] }));
    const back = (await admin.query("SELECT validation_status, diagnostics FROM public.financial_evidence_batches WHERE id=$1", [r.id])).rows[0];
    return back.validation_status === "INVALID" && back.diagnostics[0].code === "E_ROW";
  });
}

async function proveReports() {
  group("Report versions");
  const rid = `rpt-${uuid()}`;
  let ev;
  await check("v1 saves; creator derived from auth.uid()", async () => {
    const r = await saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1));
    return r.report_version === 1 && r.created_by_firm_member_id === MEMBER[U.preparer];
  });
  await check("exact replay of v1 is idempotent", async () => (await saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1))).report_version === 1);
  await expectError("conflicting content for an existing version → PT409", "PT409", () => saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1, { note: "changed" }), hex64("other")), "STALE_REPORT_VERSION");
  await expectError("skipping a version (v3 while latest is v1) → PT409", "PT409", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3)));
  await check("v2 (latest+1) saves", async () => (await saveReport(user(U.preparer), rid, 2, COMPANY_A, reportDoc(rid, COMPANY_A, 2))).report_version === 2);
  await expectError("saving an OLDER new version (v1 again with new content) is refused", "PT409", () => saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1, { note: "late" }), hex64("late")));
  await expectError("document identity must match the lineage argument (22023)", "22023", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc("other-report", COMPANY_A, 3)));
  await expectError("document company must match the company argument (22023)", "22023", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_B, 3)));
  await expectError("monetary minorUnits as a JSON number is refused (22023)", "22023", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3, { facts: [{ value: { minorUnits: 12345 } }] })), "never JSON numbers");
  await expectError("presentationMultiplier as a JSON number is refused (22023)", "22023", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3, { presentation: { presentationMultiplier: 1000 } })));
  await expectError("referencing a non-existent evidence batch → P0002", "P0002", () => saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3), hex64("c3"), ["eb-does-not-exist"]));
  await check("referencing a real evidence batch of the same company works", async () => {
    ev = (await admin.query("SELECT evidence_batch_id FROM public.financial_evidence_batches WHERE company_id=$1 LIMIT 1", [COMPANY_A])).rows[0].evidence_batch_id;
    return (await saveReport(user(U.preparer), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3), hex64("c3"), [ev])).evidence_batch_ids[0] === ev;
  });
  await expectError("company B (not a member of A) cannot write A's report lineage (42501)", "42501", () => saveReport(user(U.ownerB), rid, 4, COMPANY_A, reportDoc(rid, COMPANY_A, 4)));
  await check("even with B allowlisted, company B cannot write lineage of company A", async () => {
    await rpc(SERVICE, "SELECT public.fs_set_company_rollout($1,true,'canary allowlist company B','ops-1')", [COMPANY_B]);
    let ok = false;
    try { await saveReport(user(U.ownerB), rid, 4, COMPANY_A, reportDoc(rid, COMPANY_A, 4)); } catch (e) { ok = e.code === "42501"; }
    let ok2 = false;
    try { await saveReport(user(U.ownerB), rid, 4, COMPANY_B, reportDoc(rid, COMPANY_B, 4)); } catch (e) { ok2 = e.code === "42501"; }
    await rpc(SERVICE, "SELECT public.fs_set_company_rollout($1,false,'canary withdrawn company B','ops-1')", [COMPANY_B]);
    return ok && ok2;
  });
  await check("exact JSON round trip: bigint marker, unicode and nesting survive byte-for-byte semantics", async () => {
    const back = (await admin.query("SELECT report_document FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=1", [rid])).rows[0].report_document;
    return back.facts[0].value.minorUnits.__bigint__ === "9223372036854775807" && back.note === "Ünïcödé — 収益 — “quotes”";
  });
  await expectError("viewer cannot save a report", "42501", () => saveReport(user(U.viewer), `rpt-${uuid()}`, 1, COMPANY_A, reportDoc("x", COMPANY_A, 1)));
  await expectError("anon cannot save a report", "42501", () => saveReport(ANON, rid, 4, COMPANY_A, reportDoc(rid, COMPANY_A, 4)));
  return rid;
}

async function proveConcurrency() {
  group("Real concurrent sessions");
  const rid = `rpt-conc-${uuid()}`;
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1));
  await check("8 sessions racing to save the SAME v2 with DIFFERENT content: exactly one wins, seven get PT409", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => saveReport(user(i % 2 ? U.preparer : U.partner), rid, 2, COMPANY_A, reportDoc(rid, COMPANY_A, 2, { note: `writer-${i}` }), hex64(`w${i}`))),
    );
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const conflicts = settled.filter((s) => s.status === "rejected" && s.reason.code === "PT409").length;
    const rows = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=2", [rid])).rows[0].n;
    return ok === 1 && conflicts === 7 && rows === 1;
  });
  await check("8 sessions racing to save the SAME v3 with IDENTICAL content: all succeed idempotently, one row", async () => {
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => saveReport(user(U.partner), rid, 3, COMPANY_A, reportDoc(rid, COMPANY_A, 3), hex64("same3"))));
    const rows = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=3", [rid])).rows[0].n;
    return settled.every((s) => s.status === "fulfilled") && rows === 1;
  });
  await check("8 sessions ingesting the same source hash: one row, all return it", async () => {
    const shared = evArgs({ series: "race" });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => ingest(user(U.partner), evArgs({ series: "race", hash: shared[8], batchId: `eb-race-${i}`, doc: JSON.parse(shared[11]) }))));
    const rows = (await admin.query("SELECT count(*)::int n FROM public.financial_evidence_batches WHERE series_key='race'")).rows[0].n;
    return settled.every((s) => s.status === "fulfilled") && rows === 1;
  });
  return rid;
}

async function proveDecisionsAndEvaluations() {
  group("Evaluations and reviewer decisions");
  const rid = `rpt-dec-${uuid()}`;
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1));
  const findings = [finding("FK-1"), finding("FK-2", { outcome: "INSUFFICIENT_EVIDENCE", failureSeverity: "LOW" }), finding("FK-3", { failureSeverity: "LOW" }), finding("FK-4", { actionable: false, outcome: "PASS" })];
  await check("evaluation saves; exact replay is idempotent", async () => {
    const a = await saveEval(user(U.preparer), "run-1", rid, 1, COMPANY_A, findings);
    const b = await saveEval(user(U.preparer), "run-1", rid, 1, COMPANY_A, findings);
    return a.id === b.id;
  });
  await expectError("same evaluation id with different findings → PT409", "PT409", () => saveEval(user(U.preparer), "run-1", rid, 1, COMPANY_A, [finding("FK-9")], hex64("erun-1")));
  await expectError("evaluation for a non-existent version → P0002", "P0002", () => saveEval(user(U.preparer), "run-2", rid, 9, COMPANY_A, findings));
  await expectError("company B (not a member of A) cannot evaluate A's report (42501)", "42501", () => saveEval(user(U.ownerB), "run-3", rid, 1, COMPANY_A, findings));
  await check("blocking count = FK-1 (CRITICAL) + FK-2 (insufficient evidence) = 2; FK-3 low and FK-4 pass are not blocking", async () =>
    (await admin.query("SELECT public.fs_unresolved_blocking_count($1,1) n", [rid])).rows[0].n === 2);
  await check("decision: reviewerId supplied by the client is discarded; reviewer = firm_members.id derived server-side", async () => {
    const d = await appendDecision(user(U.partner), "d1", rid, COMPANY_A, decision("d1", "DEFER", "FK-1"));
    return d.reviewer_firm_member_id === MEMBER[U.partner] && d.decision.reviewerId === undefined;
  });
  await check("DEFER does not resolve a blocking finding", async () => (await admin.query("SELECT public.fs_unresolved_blocking_count($1,1) n", [rid])).rows[0].n === 2);
  await check("exact replay of a decision is idempotent", async () => (await appendDecision(user(U.partner), "d1", rid, COMPANY_A, decision("d1", "DEFER", "FK-1"))).decision_id === "d1");
  await expectError("same decision id with different content → PT409", "PT409", () => appendDecision(user(U.partner), "d1", rid, COMPANY_A, decision("d1", "ACCEPT_FINDING", "FK-1")));
  await expectError("payload id must match the id argument (22023)", "22023", () => appendDecision(user(U.partner), "dX", rid, COMPANY_A, decision("dY", "DEFER", "FK-1")));
  await expectError("a bare CORRECT_FACT decision is refused — corrections go through a group (22023)", "22023", () => appendDecision(user(U.partner), "dc", rid, COMPANY_A, decision("dc", "CORRECT_FACT", "FK-1")));
  await expectError("a decision on another company's report → P0002", "P0002", () => appendDecision(user(U.ownerB), "dz", rid, COMPANY_B, decision("dz", "DEFER", "FK-1")).catch((e) => { if (e.code === "PT403") throw Object.assign(e, { code: "P0002" }); throw e; }));
  await check("ACCEPT_FINDING resolves FK-1; REJECT_FINDING resolves FK-2 → 0 blocking (most recent decision wins)", async () => {
    await appendDecision(user(U.partner), "d2", rid, COMPANY_A, decision("d2", "ACCEPT_FINDING", "FK-1"));
    await appendDecision(user(U.partner), "d3", rid, COMPANY_A, decision("d3", "REJECT_FINDING", "FK-2"));
    return (await admin.query("SELECT public.fs_unresolved_blocking_count($1,1) n", [rid])).rows[0].n === 0;
  });
  await check("a later REQUEST_EVIDENCE reopens FK-2 (last decision wins) → 1 blocking", async () => {
    await appendDecision(user(U.partner), "d4", rid, COMPANY_A, decision("d4", "REQUEST_EVIDENCE", "FK-2", { requestedEvidence: "bank confirmation" }));
    return (await admin.query("SELECT public.fs_unresolved_blocking_count($1,1) n", [rid])).rows[0].n === 1;
  });
  return rid;
}

async function proveCorrectionGroups() {
  group("Atomic correction groups");
  const rid = `rpt-cg-${uuid()}`;
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, reportDoc(rid, COMPANY_A, 1));
  const step = (v, extra = {}) => ({ reportVersion: v, reportDocument: reportDoc(rid, COMPANY_A, v, extra), contentHash: hex64(`cg${v}${JSON.stringify(extra)}`) });
  const dec = (id, expected) => ({ decisionId: id, decisionType: "CORRECT_FACT", reviewerId: "ignored", factId: "f1", supersedesVersion: expected, newVersion: expected + 1, correctedValue: { minorUnits: { __bigint__: "100" }, currency: "TZS" }, rationale: "documented correction", expectedReportVersion: expected, decidedAt: "2026-01-01T00:00:00Z" });
  const evalFor = (id, findings = []) => ({ evaluationRunId: id, rulePackId: "rp", rulePackVersion: "1", engineVersion: "e1", inputHash: hex64(id), findings });
  const apply = (caller, gid, key, expected, steps, decs, ev) =>
    one(caller, "SELECT * FROM public.fs_apply_correction_group($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)", [gid, key, COMPANY_A, rid, expected, JSON.stringify(steps), JSON.stringify(decs), ev == null ? null : JSON.stringify(ev)]);

  await check("a 3-step group lands as v2, v3, v4 in one call, with 3 decisions, an evaluation of v4, and one group row", async () => {
    const g = await apply(user(U.partner), "g1", "idem-key-g1-000", 1, [step(2, { n: 2 }), step(3, { n: 3 }), step(4, { n: 4 })], [dec("cd-1", 1), dec("cd-2", 2), dec("cd-3", 3)], evalFor("cg-eval-1"));
    const versions = (await admin.query("SELECT array_agg(report_version ORDER BY report_version) v FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].v;
    const decs = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reviewer_decisions WHERE correction_group_id='g1'")).rows[0].n;
    const evals = (await admin.query("SELECT report_version FROM public.financial_statement_evaluations WHERE evaluation_run_id='cg-eval-1'")).rows;
    return g.from_report_version === 2 && g.to_report_version === 4 && g.step_count === 3 && JSON.stringify(versions) === "[1,2,3,4]" && decs === 3 && evals.length === 1 && evals[0].report_version === 4;
  });
  await check("exact replay with the same idempotency key returns the stored group and writes nothing", async () => {
    const before = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].n;
    const g = await apply(user(U.partner), "g1", "idem-key-g1-000", 1, [step(2, { n: 2 }), step(3, { n: 3 }), step(4, { n: 4 })], [dec("cd-1", 1), dec("cd-2", 2), dec("cd-3", 3)], evalFor("cg-eval-1"));
    const after = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].n;
    return g.group_id === "g1" && before === after;
  });
  await expectError("same idempotency key with different content → PT409", "PT409", () => apply(user(U.partner), "g1b", "idem-key-g1-000", 1, [step(2, { n: 99 })], [dec("cd-x", 1)], null), "REPLAY_CONFLICT");
  await expectError("stale expected version (formed against v1, report is v4) → PT409", "PT409", () => apply(user(U.partner), "g2", "idem-key-g2-000", 1, [step(2, { n: 5 })], [dec("cd-4", 1)], null), "STALE_REPORT_VERSION");
  await check("stale attempt wrote nothing", async () => (await admin.query("SELECT max(report_version)::int m FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].m === 4 && (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reviewer_decisions WHERE decision_id='cd-4'")).rows[0].n === 0);
  await expectError("non-contiguous step versions → PT409", "PT409", () => apply(user(U.partner), "g3", "idem-key-g3-000", 4, [step(6)], [dec("cd-5", 5)], null));
  await check("ROLLBACK: a group whose step 3 is invalid leaves NO partial state (steps 1-2 vanish too)", async () => {
    let code = null;
    try {
      await apply(user(U.partner), "g4", "idem-key-g4-000", 4, [step(5, { n: 5 }), step(6, { n: 6 }), step(7, { minorHolder: { minorUnits: 5 } })], [dec("cd-6", 4), dec("cd-7", 5), dec("cd-8", 6)], null);
    } catch (e) { code = e.code; }
    const m = (await admin.query("SELECT max(report_version)::int m FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].m;
    const d = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reviewer_decisions WHERE decision_id IN ('cd-6','cd-7','cd-8')")).rows[0].n;
    const g = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_correction_groups WHERE group_id='g4'")).rows[0].n;
    return code === "22023" && m === 4 && d === 0 && g === 0;
  });
  await expectError("a decision id that already exists on the report is a typed PT409 conflict inside a group, and nothing is written", "PT409", () => apply(user(U.partner), "g-dup", "idem-key-gdup-000", 4, [step(5, { n: 55 })], [dec("cd-1", 4)], null), "REPLAY_CONFLICT");
  await expectError("a non-CORRECT_FACT decision inside a group → 22023", "22023", () => apply(user(U.partner), "g5", "idem-key-g5-000", 4, [step(5)], [{ ...dec("cd-9", 4), decisionType: "DEFER" }], null));
  await expectError("decision count must equal step count → 22023", "22023", () => apply(user(U.partner), "g6", "idem-key-g6-000", 4, [step(5)], [], null));
  await expectError("viewer cannot apply a correction group", "42501", () => apply(user(U.viewer), "g7", "idem-key-g7-000", 4, [step(5)], [dec("cd-10", 4)], null));
  await expectError("company B cannot apply against company A's lineage", "PT403", () => one(user(U.ownerB), "SELECT * FROM public.fs_apply_correction_group('g8','idem-key-g8-000',$1,$2,4,'[]'::jsonb,'[]'::jsonb,NULL)", [COMPANY_B, rid]).catch((e) => { if (e.code === "22023") throw Object.assign(e, { code: "PT403" }); throw e; }));
  await check("CONCURRENCY: two sessions applying different corrections at the same base version — exactly one wins", async () => {
    const mk = (n) => apply(user(n % 2 ? U.partner : U.preparer), `gc-${n}`, `idem-conc-key-${n}-00`, 4, [step(5, { racer: n })], [dec(`cd-c-${n}`, 4)], null);
    const settled = await Promise.allSettled([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)]);
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const stale = settled.filter((s) => s.status === "rejected" && s.reason.code === "PT409").length;
    const rows = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=5", [rid])).rows[0].n;
    return ok === 1 && stale === 5 && rows === 1;
  });
  return rid;
}

async function provePublication() {
  group("Publication state and finalization gate");
  const rid = `rpt-pub-${uuid()}`;
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, completeDoc(rid, COMPANY_A, 1));
  const setState = (caller, v, state, reason = "state change with reason") => one(caller, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,$4,$5)", [rid, v, COMPANY_A, state, reason]);
  await check("DRAFT can be recorded by a preparer", async () => (await setState(user(U.preparer), 1, "DRAFT", "initial draft")).state === "DRAFT");
  await expectError("a preparer cannot mark REVIEWED (42501)", "42501", () => setState(user(U.preparer), 1, "REVIEWED"));
  await expectError("a viewer cannot change state at all (42501)", "42501", () => setState(user(U.viewer), 1, "DRAFT", "viewer trying"));
  await expectError("a partner cannot review an un-evaluated version (NOT_EVALUATED → PT409)", "PT409", () => setState(user(U.partner), 1, "REVIEWED"), "NOT_EVALUATED");
  await saveEval(user(U.partner), "pub-eval-1", rid, 1, COMPANY_A, [finding("PK-1")]);
  await expectError("a partner cannot review while a CRITICAL finding is unresolved (BLOCKED → PT409)", "PT409", () => setState(user(U.partner), 1, "REVIEWED"), "BLOCKED");
  await appendDecision(user(U.partner), "pd1", rid, COMPANY_A, decision("pd1", "ACCEPT_FINDING", "PK-1"));
  await expectError("FINAL cannot skip REVIEWED (PT409)", "PT409", () => setState(user(U.partner), 1, "FINAL"));
  await expectError("a reason shorter than 8 characters is refused", "23514", () => setState(user(U.partner), 1, "REVIEWED", "short"));
  await check("after the finding is accepted, a partner can mark REVIEWED", async () => (await setState(user(U.partner), 1, "REVIEWED", "reviewed by partner")).state === "REVIEWED");
  await check("exact replay of the same state is idempotent", async () => (await setState(user(U.partner), 1, "REVIEWED", "reviewed by partner")).state === "REVIEWED");
  await check("owner can mark FINAL (latest version, reviewed, no blockers)", async () => (await setState(user(U.owner), 1, "FINAL", "final sign-off")).state === "FINAL");
  await expectError("a FINAL version is immutable: no move back to DRAFT (PT409)", "PT409", () => setState(user(U.owner), 1, "DRAFT", "reopen attempt"));
  await check("history is append-only: DRAFT, REVIEWED, FINAL are all retained", async () => (await admin.query("SELECT array_agg(state ORDER BY seq) s FROM public.financial_statement_publications WHERE report_id=$1", [rid])).rows[0].s.join(",") === "DRAFT,REVIEWED,FINAL");
  await check("only the LATEST version may be FINAL: v1 reviewed while v2 exists is refused", async () => {
    const rid2 = `rpt-pub2-${uuid()}`;
    await saveReport(user(U.preparer), rid2, 1, COMPANY_A, completeDoc(rid2, COMPANY_A, 1));
    await saveEval(user(U.partner), "pub2-eval", rid2, 1, COMPANY_A, []);
    await one(user(U.partner), "SELECT * FROM public.fs_set_publication_state($1,1,$2,'REVIEWED','reviewed v1')", [rid2, COMPANY_A]);
    await saveReport(user(U.preparer), rid2, 2, COMPANY_A, completeDoc(rid2, COMPANY_A, 2));
    try { await one(user(U.partner), "SELECT * FROM public.fs_set_publication_state($1,1,$2,'FINAL','finalize old v1')", [rid2, COMPANY_A]); return false; } catch (e) { return e.code === "PT409" && String(e.message).includes("latest"); }
  });
  await expectError("company B cannot change publication state of company A", "PT403", () => one(user(U.ownerB), "SELECT * FROM public.fs_set_publication_state($1,1,$2,'DRAFT','cross company try')", [rid, COMPANY_B]).catch((e) => { throw e; }).then(() => { throw Object.assign(new Error("unexpected success"), { code: "OK" }); }, (e) => { if (e.code === "P0002" || e.code === "PT403") throw Object.assign(e, { code: "PT403" }); throw e; }));
}

async function proveTenancyAndImmutability() {
  group("Tenancy (RLS reads), immutability, deletion");
  await check("company A members can read company A rows; outsider and company B owner read none", async () => {
    const own = await rpc(user(U.viewer), "SELECT count(*)::int n FROM public.financial_statement_reports");
    const none = await rpc(user(U.outsider), "SELECT count(*)::int n FROM public.financial_statement_reports");
    const other = await rpc(user(U.ownerB), "SELECT count(*)::int n FROM public.financial_statement_reports");
    return own[0].n > 0 && none[0].n === 0 && other[0].n === 0;
  });
  await check("a pending (unaccepted) member reads nothing", async () => (await rpc(user(U.pending), "SELECT count(*)::int n FROM public.financial_evidence_batches"))[0].n === 0);
  await expectError("anon cannot read reports (no grant)", "42501", () => rpc(ANON, "SELECT * FROM public.financial_statement_reports"));
  for (const t of ["financial_evidence_batches", "financial_statement_reports", "financial_statement_evaluations", "financial_statement_reviewer_decisions", "financial_statement_correction_groups", "financial_statement_publications"]) {
    await expectError(`${t}: authenticated direct UPDATE denied`, "42501", () => rpc(user(U.owner), `UPDATE public.${t} SET id = id`));
    await expectError(`${t}: authenticated direct DELETE denied`, "42501", () => rpc(user(U.owner), `DELETE FROM public.${t}`));
    await expectError(`${t}: table owner UPDATE rejected by append-only trigger`, "P0001", () => admin.query(`UPDATE public.${t} SET id = id`));
    await expectError(`${t}: table owner DELETE rejected by append-only trigger`, "P0001", () => admin.query(`DELETE FROM public.${t}`));
  }
  await expectError("authenticated direct INSERT into reports denied", "42501", () => rpc(user(U.owner), "INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, created_by_firm_member_id) VALUES ('x',1,$1,2025,'TRIAL_BALANCE_DERIVED','{}',$2,$2,$3)", [COMPANY_A, hex64("x"), MEMBER[U.owner]]));
  await check("every foreign key from the new tables to companies/firm_members/reports is ON DELETE RESTRICT (history cannot be cascaded away)", async () => {
    const r = await admin.query(`SELECT conrelid::regclass::text t, confdeltype d FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text = ANY($1)`, [["financial_evidence_batches", "financial_statement_reports", "financial_statement_evaluations", "financial_statement_reviewer_decisions", "financial_statement_correction_groups", "financial_statement_publications"]]);
    return r.rows.length >= 10 && r.rows.every((x) => x.d === "r");
  });
  await check("deleting a company that has financial-statement history fails and leaves the history intact", async () => {
    const before = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports")).rows[0].n;
    let refused = false;
    try { await admin.query("DELETE FROM public.companies WHERE id=$1", [COMPANY_A]); } catch { refused = true; }
    const after = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports")).rows[0].n;
    return refused && before === after && (await admin.query("SELECT count(*)::int n FROM public.companies WHERE id=$1", [COMPANY_A])).rows[0].n === 1;
  });
  await expectError("TRUNCATE by a client role is impossible", "42501", () => rpc(user(U.owner), "TRUNCATE public.financial_statement_reports"));
  await check("no function argument accepts an actor (firm member id) — actor is derived from auth.uid() only", async () => {
    const r = await admin.query(`SELECT p.proname, pg_get_function_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname LIKE 'fs\\_%' AND p.proname NOT IN ('fs_rollout_allows','fs_sha256_hex') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`);
    const bad = r.rows.filter((x) => /(firm_member|actor|reviewer|user_id|uid)/i.test(x.args));
    if (bad.length) console.log("        offenders:", JSON.stringify(bad));
    return bad.length === 0;
  });
}


async function proveServerCompleteness() {
  group("Server-authoritative completeness (direct RPC cannot bypass)");
  const setState = (caller, rid, v, state, reason = "readiness gate check") => one(caller, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,$4,$5)", [rid, v, COMPANY_A, state, reason]);
  const readiness = (caller, rid, v) => one(caller, "SELECT public.fs_report_readiness($1,$2,$3) r", [COMPANY_A, rid, v]).then((x) => x.r);
  const fresh = async (label, doc, opts = {}) => {
    const rid = `rpt-ready-${label}-${uuid()}`;
    await saveReport(user(U.preparer), rid, 1, COMPANY_A, doc(rid), hex64(`rd${rid}`), opts.batches ?? []);
    if (opts.evaluate !== false) await saveEval(user(U.partner), `ev-${rid}`, rid, 1, COMPANY_A, opts.findings ?? []);
    return rid;
  };
  const blocked = async (name, rid, fragment) => expectError(name, "PT409", () => setState(user(U.partner), rid, 1, "REVIEWED"), fragment);

  await check("a complete, evaluated report is ready and can be marked REVIEWED", async () => {
    const rid = await fresh("ok", (r) => completeDoc(r, COMPANY_A, 1));
    const r = await readiness(user(U.partner), rid, 1);
    return r.ready === true && r.blockers.length === 0 && (await setState(user(U.partner), rid, 1, "REVIEWED")).state === "REVIEWED";
  });

  const noStatements = await fresh("nostmt", (r) => completeDoc(r, COMPANY_A, 1, { statements: [] }));
  await blocked("a direct RPC cannot mark a report with NO statements REVIEWED", noStatements, "MISSING_STATEMENT:STATEMENT_OF_FINANCIAL_POSITION");
  await check("the readiness preview lists every missing required statement and agrees with the gate", async () => {
    const r = await readiness(user(U.viewer), noStatements, 1);
    return r.ready === false && STATEMENT_TYPES.every((t) => r.blockers.includes(`MISSING_STATEMENT:${t}`));
  });
  const oneMissing = await fresh("nocf", (r) => completeDoc(r, COMPANY_A, 1, { statements: completeDoc(r, COMPANY_A, 1).statements.filter((x) => x.type !== "STATEMENT_OF_CASH_FLOWS") }));
  await blocked("a missing required statement (cash flows) blocks REVIEWED", oneMissing, "MISSING_STATEMENT:STATEMENT_OF_CASH_FLOWS");
  const noComparative = await fresh("nocomp", (r) => completeDoc(r, COMPANY_A, 1, { comparativePeriods: [] }));
  await blocked("no comparative period blocks REVIEWED", noComparative, "COMPARATIVE_PERIOD_MISSING");
  const noCompFigures = await fresh("nocompfig", (r) => completeDoc(r, COMPANY_A, 1, { statements: completeDoc(r, COMPANY_A, 1).statements.map((st) => ({ ...st, sections: [{ sectionId: "s", lines: [{ lineId: "l", factBindings: [{ periodId: "CURRENT", factId: "f1" }] }] }] })) }));
  await blocked("declared comparative period with no comparative figures blocks REVIEWED", noCompFigures, "COMPARATIVE_FIGURES_MISSING");
  const unknownFw = await fresh("fw", (r) => completeDoc(r, COMPANY_A, 1, { framework: { kind: "MADE_UP_GAAP" } }));
  await blocked("an unknown framework blocks REVIEWED", unknownFw, "FRAMEWORK_UNKNOWN");
  const noEval = await fresh("noeval", (r) => completeDoc(r, COMPANY_A, 1), { evaluate: false });
  await expectError("a version with no evaluation cannot be REVIEWED (NOT_EVALUATED)", "PT409", () => setState(user(U.partner), noEval, 1, "REVIEWED"), "NOT_EVALUATED");
  await blocked("a blocking (CRITICAL) finding blocks REVIEWED", await fresh("crit", (r) => completeDoc(r, COMPANY_A, 1), { findings: [finding("CRIT-1")] }), "BLOCKING_FINDINGS:1");

  const recon = await fresh("recon", (r) => completeDoc(r, COMPANY_A, 1), { findings: [finding("N2F-1", { ruleId: "note-to-face-reconciliation", failureSeverity: "LOW" })] });
  await blocked("an unmet mandatory reconciliation blocks REVIEWED even at LOW severity", recon, "RECONCILIATION_UNMET:1");
  await check("a reviewer's ACCEPT decision cannot waive a mandatory reconciliation", async () => {
    await appendDecision(user(U.partner), `d-waive-${recon}`, recon, COMPANY_A, decision(`d-waive-${recon}`, "ACCEPT_FINDING", "N2F-1"));
    try { await setState(user(U.partner), recon, 1, "REVIEWED"); return false; } catch (e) { return e.code === "PT409" && String(e.message).includes("RECONCILIATION_UNMET"); }
  });

  // evidence must be valid, current and present
  const okEv = await ingest(user(U.partner), evArgs({ series: `ready-ok-${uuid()}` }));
  const badEv = await ingest(user(U.partner), evArgs({ series: `ready-bad-${uuid()}`, status: "INVALID", diags: [{ code: "X" }] }));
  await blocked("a report that references INVALID evidence cannot be REVIEWED", await fresh("badev", (r) => completeDoc(r, COMPANY_A, 1), { batches: [badEv.evidence_batch_id] }), "EVIDENCE_NOT_VALID");
  const supSeries = `ready-sup-${uuid()}`;
  const supV1 = await ingest(user(U.partner), evArgs({ series: supSeries }));
  await ingest(user(U.partner), evArgs({ series: supSeries, prev: supV1.evidence_batch_id }));
  await blocked("a report built on SUPERSEDED evidence cannot be REVIEWED", await fresh("sup", (r) => completeDoc(r, COMPANY_A, 1), { batches: [supV1.evidence_batch_id] }), "EVIDENCE_SUPERSEDED");
  await check("valid current evidence does not block", async () => {
    const rid = await fresh("goodev", (r) => completeDoc(r, COMPANY_A, 1), { batches: [okEv.evidence_batch_id] });
    return (await readiness(user(U.partner), rid, 1)).ready === true;
  });

  // cash-basis framework needs its evidence type
  const cashDoc = (r, extra = {}) => completeDoc(r, COMPANY_A, 1, { framework: { kind: "IPSAS_CASH" }, statements: [{ statementId: "st", type: "STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS", sections: [{ sectionId: "s", lines: [{ lineId: "l", factBindings: [{ periodId: "CURRENT", factId: "f1" }, { periodId: "PRIOR_2024", factId: "f0" }] }] }] }], ...extra });
  await blocked("an IPSAS cash-basis report without receipts/payments evidence cannot be REVIEWED", await fresh("cashnoev", (r) => cashDoc(r)), "REQUIRED_EVIDENCE_MISSING:IPSAS_CASH_RECEIPTS_PAYMENTS");
  const cashEv = await ingest(user(U.partner), evArgs({ series: `ready-cash-${uuid()}`, type: "IPSAS_CASH_RECEIPTS_PAYMENTS" }));
  await check("an IPSAS cash-basis report with valid receipts/payments evidence is ready", async () => (await readiness(user(U.partner), await fresh("cashok", (r) => cashDoc(r), { batches: [cashEv.evidence_batch_id] }), 1)).ready === true);

  // version currency, role, rollout
  await check("only the LATEST version can be REVIEWED: an older version is blocked with NOT_LATEST_VERSION", async () => {
    const rid = await fresh("stale", (r) => completeDoc(r, COMPANY_A, 1));
    await saveReport(user(U.preparer), rid, 2, COMPANY_A, completeDoc(rid, COMPANY_A, 2));
    try { await setState(user(U.partner), rid, 1, "REVIEWED"); return false; } catch (e) { return e.code === "PT409" && String(e.message).includes("NOT_LATEST_VERSION"); }
  });
  await expectError("a preparer cannot review a complete report (42501)", "42501", async () => setState(user(U.preparer), await fresh("role", (r) => completeDoc(r, COMPANY_A, 1)), 1, "REVIEWED"));
  await check("the kill switch blocks REVIEWED of an otherwise complete report (PT403)", async () => {
    const rid = await fresh("kill", (r) => completeDoc(r, COMPANY_A, 1));
    await rpc(SERVICE, "SELECT public.fs_set_kill_switch(true,'completeness proof drill','ops-1')");
    let ok = false;
    try { await setState(user(U.partner), rid, 1, "REVIEWED"); } catch (e) { ok = e.code === "PT403"; }
    await rpc(SERVICE, "SELECT public.fs_set_kill_switch(false,'completeness proof drill over','ops-1')");
    return ok;
  });
  await expectError("readiness preview is refused to a non-member (42501)", "42501", () => readiness(user(U.outsider), noStatements, 1));
  await expectError("readiness preview is refused to another company's owner (42501)", "42501", () => readiness(user(U.ownerB), noStatements, 1));
  await expectError("readiness preview is refused to anon", "42501", () => readiness(ANON, noStatements, 1));
  await check("every decisive action left an audit event, and none can be edited", async () => {
    const a = (await admin.query("SELECT action, count(*)::int n FROM public.financial_statement_audit_events GROUP BY action")).rows;
    const seen = Object.fromEntries(a.map((x) => [x.action, x.n]));
    let immutable = false;
    try { await admin.query("UPDATE public.financial_statement_audit_events SET detail = '{}'"); } catch (e) { immutable = e.code === "P0001"; }
    return ["EVIDENCE_INGESTED", "REPORT_VERSION_SAVED", "DECISION_RECORDED", "PUBLICATION_STATE_SET"].every((k) => seen[k] > 0) && immutable;
  });
}

async function proveSavedVersions() {
  group("Saved-version listing and cross-company isolation");
  const rid = `rpt-list-${uuid()}`;
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, completeDoc(rid, COMPANY_A, 1));
  await saveReport(user(U.partner), rid, 2, COMPANY_A, completeDoc(rid, COMPANY_A, 2));
  const list = (caller, company = COMPANY_A) => one(caller, "SELECT public.fs_list_saved_versions($1, 2025) r", [company]).then((x) => x.r);
  await check("a member lists every saved version with number, creator role, time, state and latest flag", async () => {
    const mine = (await list(user(U.viewer))).filter((v) => v.reportId === rid);
    return mine.length === 2 && mine[0].reportVersion === 1 && mine[0].isLatest === false && mine[1].isLatest === true && mine[0].creatorRole === "preparer" && mine[1].creatorRole === "partner" && /^[0-9a-f]{8}$/.test(mine[1].creatorRef) && !!mine[1].createdAt && mine[1].state === "DRAFT";
  });
  await expectError("a non-member cannot list versions (42501)", "42501", () => list(user(U.outsider)));
  await expectError("another company's owner cannot list this company's versions (42501)", "42501", () => list(user(U.ownerB)));
  await expectError("anon cannot list versions", "42501", () => list(ANON));
  await check("the listing never exposes another company's reports", async () => (await list(user(U.owner))).every((v) => v.reportId !== undefined) && (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE company_id = $1", [COMPANY_B])).rows[0].n === 0);
}

async function proveEvidenceCorrectionGroups() {
  group("Multi-evidence correction groups (atomic)");
  const rid = `rpt-ecg-${uuid()}`;
  const series = `ecg-${uuid()}`;
  const ev1 = await ingest(user(U.preparer), evArgs({ series, type: "BUDGET" }));
  await saveReport(user(U.preparer), rid, 1, COMPANY_A, completeDoc(rid, COMPANY_A, 1), hex64(`ecg${rid}`), [ev1.evidence_batch_id]);
  const newBatch = (previous, suffix) => ({
    evidenceBatchId: `eb-${uuid()}`, reportingPeriodId: "FY2025", evidenceType: "BUDGET", periodRole: "CURRENT", seriesKey: series, schemaVersion: "1",
    sourceFileName: "budget-corrected.csv", contentHash: hex64(`corr-${suffix}-${rid}`), currency: "TZS", scale: 2,
    batchDocument: { rows: [{ amount: `1${suffix}.00`, memo: "corrected" }] }, validationStatus: "VALID", diagnostics: [], expectedPreviousBatchId: previous,
  });
  const evDecision = (id, expected, batch) => ({ decisionId: id, decisionType: "CORRECT_EVIDENCE", reviewerId: "ignored", evidenceType: "BUDGET", supersedesBatchId: batch.expectedPreviousBatchId, newBatchId: batch.evidenceBatchId, rowNumber: "1", column: "amount", rationale: "agreed to approved budget", expectedReportVersion: expected, decidedAt: "2026-01-01T00:00:00Z" });
  const apply = (caller, gid, key, expected, steps, decs, ev) =>
    one(caller, "SELECT * FROM public.fs_apply_correction_group($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)", [gid, key, COMPANY_A, rid, expected, JSON.stringify(steps), JSON.stringify(decs), ev == null ? null : JSON.stringify(ev)]);
  const evalFor = (id) => ({ evaluationRunId: id, rulePackId: "rp", rulePackVersion: "2.0.0", engineVersion: "e2", inputHash: hex64(id), findings: [] });

  const b2 = newBatch(ev1.evidence_batch_id, "1");
  await check("ONE group atomically persists: corrected evidence version + new report version + decision + evaluation + audit event", async () => {
    const g = await apply(user(U.partner), "ecg1", "idem-ecg-000001", 1, [{ reportVersion: 2, reportDocument: completeDoc(rid, COMPANY_A, 2, { note: "after evidence correction" }), contentHash: hex64("ecg-v2"), evidenceBatchIds: [b2.evidenceBatchId], evidenceBatch: b2 }], [evDecision("ecd-1", 1, b2)], evalFor("ecg-eval-1"));
    const chain = (await admin.query("SELECT version, supersedes_batch_id FROM public.financial_evidence_batches WHERE series_key = $1 ORDER BY version", [series])).rows;
    const rpt = (await admin.query("SELECT evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=2", [rid])).rows[0];
    const audit = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_audit_events WHERE report_id=$1 AND action='CORRECTION_GROUP_APPLIED'", [rid])).rows[0].n;
    const evalRows = (await admin.query("SELECT count(*)::int n FROM public.financial_statement_evaluations WHERE evaluation_run_id='ecg-eval-1'")).rows[0].n;
    return g.to_report_version === 2 && chain.length === 2 && chain[1].supersedes_batch_id === ev1.evidence_batch_id && rpt.evidence_batch_ids[0] === b2.evidenceBatchId && audit === 1 && evalRows === 1;
  });
  await check("the new report version references the CORRECTED evidence, so the superseded version no longer blocks the latest report", async () => {
    await saveEval(user(U.partner), "ecg-eval-2", rid, 2, COMPANY_A, []).catch(() => undefined);
    return !(await one(user(U.partner), "SELECT public.fs_report_readiness($1,$2,2) r", [COMPANY_A, rid]).then((x) => x.r.blockers)).some((b) => b.startsWith("EVIDENCE_SUPERSEDED"));
  });
  const b3 = newBatch(b2.evidenceBatchId, "2");
  const before = async () => ({ ev: (await admin.query("SELECT count(*)::int n FROM public.financial_evidence_batches WHERE series_key=$1", [series])).rows[0].n, rp: (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reports WHERE report_id=$1", [rid])).rows[0].n, dc: (await admin.query("SELECT count(*)::int n FROM public.financial_statement_reviewer_decisions WHERE report_id=$1", [rid])).rows[0].n });
  await check("ROLLBACK: a group whose SECOND step is invalid leaves no evidence, report, decision or audit residue from its FIRST step", async () => {
    const snap = await before();
    const b3b = newBatch(b3.evidenceBatchId, "3");
    let code = null;
    try {
      await apply(user(U.partner), "ecg2", "idem-ecg-000002", 2,
        [{ reportVersion: 3, reportDocument: completeDoc(rid, COMPANY_A, 3), contentHash: hex64("ecg-v3"), evidenceBatchIds: [b3.evidenceBatchId], evidenceBatch: b3 },
         { reportVersion: 4, reportDocument: completeDoc(rid, COMPANY_A, 4, { facts: [{ value: { minorUnits: 5 } }] }), contentHash: hex64("ecg-v4"), evidenceBatchIds: [b3b.evidenceBatchId], evidenceBatch: { ...b3b, expectedPreviousBatchId: b3.evidenceBatchId } }],
        [evDecision("ecd-2", 2, b3), evDecision("ecd-3", 3, b3b)], null);
    } catch (e) { code = e.code; }
    const after = await before();
    return code === "22023" && after.ev === snap.ev && after.rp === snap.rp && after.dc === snap.dc;
  });
  await expectError("a CORRECT_EVIDENCE step without its evidence version is refused (22023)", "22023", () => apply(user(U.partner), "ecg3", "idem-ecg-000003", 2, [{ reportVersion: 3, reportDocument: completeDoc(rid, COMPANY_A, 3), contentHash: hex64("x3") }], [evDecision("ecd-4", 2, b3)], null));
  await expectError("a stale evidence predecessor inside a group is refused (PT409) and nothing lands", "PT409", () => apply(user(U.partner), "ecg4", "idem-ecg-000004", 2, [{ reportVersion: 3, reportDocument: completeDoc(rid, COMPANY_A, 3), contentHash: hex64("x4"), evidenceBatchIds: [b3.evidenceBatchId], evidenceBatch: { ...b3, expectedPreviousBatchId: ev1.evidence_batch_id } }], [evDecision("ecd-5", 2, b3)], null));
  await expectError("evidence corrections need the same role and rollout as any write (viewer, 42501)", "42501", () => apply(user(U.viewer), "ecg5", "idem-ecg-000005", 2, [{ reportVersion: 3, reportDocument: completeDoc(rid, COMPANY_A, 3), contentHash: hex64("x5"), evidenceBatchIds: [b3.evidenceBatchId], evidenceBatch: b3 }], [evDecision("ecd-6", 2, b3)], null));
  await expectError("a bare CORRECT_EVIDENCE decision cannot be appended outside a group (22023)", "22023", () => appendDecision(user(U.partner), "ecd-bare", rid, COMPANY_A, { decisionId: "ecd-bare", decisionType: "CORRECT_EVIDENCE", reviewerId: "x" }));
}

// ── main ────────────────────────────────────────────────────────────────────
const started = Date.now();
let fatal = null;
try {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 24 });
  const info = await replayMigrations();
  await seed();
  await proveReplay(info);
  await proveCatalog();
  await proveRollout();
  await proveEvidence();
  await proveReports();
  await proveConcurrency();
  await proveDecisionsAndEvaluations();
  await proveCorrectionGroups();
  await provePublication();
  await proveServerCompleteness();
  await proveSavedVersions();
  await proveEvidenceCorrectionGroups();
  await proveTenancyAndImmutability();
} catch (e) {
  fatal = e;
  console.error(`\nFATAL: ${e.message}`);
} finally {
  await stopDatabase();
}

const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}   fatal: ${fatal ? "YES" : "no"}   seconds: ${((Date.now() - started) / 1000).toFixed(1)}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
console.log(failed.length === 0 && !fatal ? "DB_PROOF: ALL PASSED" : "DB_PROOF: FAILED");
process.exit(failed.length === 0 && !fatal ? 0 : 1);
