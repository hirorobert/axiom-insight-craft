#!/usr/bin/env bun
// Real-PostgreSQL proof of Close Review (roadmap increments 8-10), starting with the append-only timeline.
//
//   rollout      nothing is written or readable while the financial-statements rollout is off for the company
//                (allow-list) or the kill switch is engaged;
//   authority    comments need prepare_close or review_close exercised now; a member without either is read-only;
//                only the author revises a comment; another workspace reads nothing and writes nothing;
//   history      an edit is a new event naming the original, which never changes; append-only for every role;
//                idempotent per request; one ordered timeline per subject.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/closeReviewAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadFunctionTree, mintTestJwt, shim } from "./lib/functionHarness.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const TIMELINE_FILE = "20261013100000_close_review_timeline.sql";
const FINDINGS_FILE = "20261014100000_close_review_findings.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 700)}`); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-close-review-proof-"));
  const port = 58000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE close_review_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/close_review_proof`;
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


async function setup() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 40 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  group("Replay — the whole chain");
  await check(`${TIMELINE_FILE} is in the chain and the whole chain applies`, async () => {
    if (!files.includes(TIMELINE_FILE)) return `${TIMELINE_FILE} missing`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]} @${e.position ?? ""} ${e.where ?? ""}`.slice(0, 600); }
    }
    return true;
  });
  await refused("applying the timeline migration again is refused by its preflight", "P0001", () => admin.query(migrationSql(REPO, TIMELINE_FILE)), "PREFLIGHT_REFUSED");

  const U = { owner: uuid(), preparer: uuid(), partner: uuid(), viewer: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic B') RETURNING id", [U.ownerB])).id;
  for (const k of ["preparer", "partner", "viewer"]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], k]);
  const rollout = (company, on) => asService("SELECT public.fs_set_company_rollout($1,$2,'proof rollout change','proof')", [company, on]);
  return { U, A, B, rollout };
}

async function timelineProof({ U, A, B, rollout }) {
  const comment = (uid, body, { company = A, kind = "finding", subject = "F-1", request = uuid(), revises = null } = {}) =>
    asUser(uid, "SELECT public.close_review_comment($1,$2,$3,$4,$5,$6) r", [company, kind, subject, body, request, revises]).then((r) => r.r);
  const timeline = (uid, subject = "F-1") => asRole("authenticated", uid, "SELECT event_type, body, revises_event_id, actor_user_id FROM public.close_review_events WHERE subject_kind='finding' AND subject_id=$1 ORDER BY seq", [subject]);

  group("Timeline — rollout");
  await check("rollout off for the company: nothing is written (feature_disabled)", async () => {
    const r = await comment(U.preparer, "Looks wrong");
    return r.outcome === "feature_disabled" && (await count("SELECT count(*) n FROM public.close_review_events")) === 0 ? true : r;
  });
  await rollout(A, true); await rollout(B, true);

  group("Timeline — authority");
  let first;
  await check("a preparer comments (prepare_close); the actor is the user and the firm member", async () => {
    first = await comment(U.preparer, "Rent looks doubled");
    const row = await one("SELECT * FROM public.close_review_events WHERE id=$1", [first.eventId]);
    const member = (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.preparer])).id;
    return first.outcome === "recorded" && row.event_type === "comment" && row.actor_user_id === U.preparer && row.firm_member_id === member ? true : { first, row };
  });
  await check("a partner (review_close) comments", async () => (await comment(U.partner, "Agreed — see lease")).outcome === "recorded" ? true : "refused");
  await check("a member with neither capability is read-only (forbidden), and can read the timeline", async () => {
    const r = await comment(U.viewer, "x");
    const rows = await timeline(U.viewer);
    return r.outcome === "forbidden" && rows.length === 2 ? true : { r, n: rows.length };
  });
  await check("another workspace's owner can neither comment on this workspace nor read its timeline", async () => {
    const r = await comment(U.ownerB, "x");
    const rows = await timeline(U.ownerB);
    return r.outcome === "forbidden" && rows.length === 0 ? true : { r, n: rows.length };
  });

  group("Timeline — history");
  await check("the author revises: a new 'comment_revised' event names the original; the original is unchanged", async () => {
    const before = await one("SELECT body FROM public.close_review_events WHERE id=$1", [first.eventId]);
    const r = await comment(U.preparer, "Rent is doubled in March", { revises: first.eventId });
    const rows = await timeline(U.owner);
    const after = await one("SELECT body FROM public.close_review_events WHERE id=$1", [first.eventId]);
    return r.outcome === "recorded" && before.body === after.body && rows.length === 3 && rows[2].event_type === "comment_revised" && rows[2].revises_event_id === first.eventId ? true : { r, rows };
  });
  await check("someone else cannot revise it (not_author)", async () => (await comment(U.partner, "edit", { revises: first.eventId })).outcome === "not_author" ? true : "allowed");
  await check("a revision must name a comment of the same subject (not_found)", async () => (await comment(U.preparer, "edit", { subject: "F-2", revises: first.eventId })).outcome === "not_found" ? true : "allowed");
  await check("a retried request records once; the same request id with other content is refused", async () => {
    const request = uuid();
    const a = await comment(U.preparer, "Once", { request });
    const b = await comment(U.preparer, "Once", { request });
    const c = await comment(U.preparer, "Different", { request });
    return a.eventId === b.eventId && b.replay === true && c.outcome === "request_reused" ? true : { a, b, c };
  });
  await check("an empty or oversized comment is refused", async () => {
    const a = await comment(U.preparer, "   ");
    const b = await comment(U.preparer, "x".repeat(4001));
    return a.outcome === "invalid_request" && b.outcome === "invalid_request" ? true : { a, b };
  });
  for (const [label, sql] of [["updated", "UPDATE public.close_review_events SET body='x'"], ["deleted", "DELETE FROM public.close_review_events"], ["truncated", "TRUNCATE public.close_review_events"]]) {
    await refused(`events cannot be ${label} — not even by the database owner`, "42501", () => admin.query(sql));
  }
  await refused("clients cannot insert events directly", "42501", () => asRole("authenticated", U.owner, "INSERT INTO public.close_review_events (company_id, subject_kind, subject_id, event_type, body) VALUES ($1,'finding','F-1','comment','x')", [A]));
  await refused("clients cannot call the internal writer", "42501", () => asRole("authenticated", U.owner, "SELECT public._close_review_append($1,'finding','F-1','comment','x',NULL,'{}',$2,NULL,NULL)", [A, U.owner]));
  await refused("the service role cannot call the internal writer either", "42501", () => asRole("service_role", null, "SELECT public._close_review_append($1,'finding','F-1','comment','x',NULL,'{}',NULL,NULL,NULL)", [A]));

  group("Timeline — kill switch");
  await check("kill switch engaged: nothing is written and the timeline is not readable", async () => {
    await asService("SELECT public.fs_set_kill_switch(true,'proof kill switch','proof')");
    const r = await comment(U.preparer, "x");
    const rows = await timeline(U.owner);
    await asService("SELECT public.fs_set_kill_switch(false,'proof kill switch off','proof')");
    return r.outcome === "feature_disabled" && rows.length === 0 ? true : { r, n: rows.length };
  });
}


// ── Findings (I2) ────────────────────────────────────────────────────────────────────────────────────────────────────
const TB = [
  // code, name, classification, statement, normal, debit, credit, cash
  ["1000", "Bank", "current_assets", "balance_sheet", "debit", "5000.00", "", true],
  ["1010", "Petty cash", "current_assets", "balance_sheet", "debit", "", "200.00", true],
  ["1500", "Equipment", "non_current_assets", "balance_sheet", "debit", "10000.00", "", false],
  ["1510", "Accumulated depreciation", "non_current_assets", "balance_sheet", "credit", "", "2000.00", false],
  ["2000", "Trade payables", "current_liabilities", "balance_sheet", "credit", "", "3000.00", false],
  ["2100", "Income tax payable", "current_liabilities", "balance_sheet", "credit", "", "800.00", false],
  ["3000", "Share capital", "equity", "balance_sheet", "credit", "", "8000.00", false],
  ["4000", "Sales", "revenue", "income_statement", "credit", "", "9000.00", false],
  ["4001", "Service revenue", "revenue", "income_statement", "credit", "", "1000.00", false],
  ["6000", "Rent", "operating_expenses", "income_statement", "debit", "7000.00", "", false],
  ["6100", "Wages", "operating_expenses", "income_statement", "debit", "1200.00", "", false],
  ["7000", "Income tax expense", "taxes", "income_statement", "debit", "800.00", "", false],
];
const CSV_TB = "Account code,Account name,Debit,Credit\n" + TB.map((r) => `${r[0]},${r[1]},${r[5]},${r[6]}`).join("\n") + "\n";

async function findingsProof({ U, A }) {
  const ptb = (await loadFunctionTree(REPO, "process-trial-balance")).handler;
  let year = 2010;
  const upload = async (y = ++year) => {
    const pid = (await one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2) RETURNING id",
      [A, `${y}-12-31`, `FY${y}`, U.owner, `${y}-01-01`])).id;
    const filePath = `${U.owner}/${uuid()}.csv`;
    const id = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,$2,'processing',$3,$4,$5,$6) RETURNING id`, [filePath, CSV_TB.length, A, y, pid, U.owner])).id;
    shim.storage.set(`trial-balance-files/${filePath}`, new TextEncoder().encode(CSV_TB));
    return { id, year: y };
  };
  const decisions = TB.map(([code, name, cls, st, nb, , , cash]) => ({ account_code: code, account_name: name, proposal_type: "NONE",
    decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: cash }));
  const seed = await upload();
  await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, seed.id, uuid(), JSON.stringify(decisions)]);
  const certify = async (u) => {
    const r = await call(ptb, pool, mintTestJwt(U.owner), { uploadId: u.id, clientRequestId: uuid() });
    const c = await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, u.year]);
    if (!c) throw new Error(`not certified: ${JSON.stringify(r.body).slice(0, 300)}`);
    return c.id;
  };
  const refresh = (uid, y) => asUser(uid, "SELECT public.close_review_refresh_findings($1,$2) r", [A, y]).then((r) => r.r);
  const summary = (uid, y) => asUser(uid, "SELECT public.close_review_findings_summary($1,$2) r", [A, y]).then((r) => r.r);
  const act = (uid, id, action, text = "Reviewed against the ledger", evidence = null, request = uuid()) =>
    asUser(uid, "SELECT public.close_review_finding_action($1,$2,$3,$4,$5) r", [id, action, text, evidence, request]).then((r) => r.r);

  group("Findings — generation on the authoritative trial balance");
  const cur = await upload();
  await check("the trial balance certifies through the real engine (authoritative)", async () => (await certify(cur)) ? true : "no");
  let run;
  await check("a member without prepare_close cannot generate (forbidden); nothing recorded", async () => {
    const r = await refresh(U.viewer, cur.year);
    return r.outcome === "forbidden" && (await count("SELECT count(*) n FROM public.close_review_finding_runs")) === 0 ? true : r;
  });
  const requirement = (uid, on, ref = "Reviewed requirement: income-tax computation workpaper (framework pack / statute reference)") =>
    asUser(uid, "SELECT public.close_review_set_requirement($1,'T01',$2,$3,'Scoped for this workspace') r", [A, on, on ? ref : null]).then((r) => r.r);
  let unscoped;
  await check("without a reviewed requirement the tax workpaper is NOT REQUIRED (no T01 finding), never universally assumed", async () => {
    unscoped = await refresh(U.preparer, cur.year);
    const st = (await one("SELECT rule_status, scope_key FROM public.close_review_finding_runs WHERE id=$1", [unscoped.runId]));
    const t01 = await count("SELECT count(*) n FROM public.close_review_findings WHERE run_id=$1 AND rule_id='T01'", [unscoped.runId]);
    return unscoped.outcome === "generated" && st.scope_key === "T01=off" && st.rule_status.T01.status === "not_required" && t01 === 0 ? true : { unscoped, st, t01 };
  });
  await check("only approve_certification scopes a requirement, with its reference; scoping it makes a NEW run", async () => {
    const a = await requirement(U.preparer, true);
    const b = await requirement(U.owner, true, null);
    const c = await requirement(U.owner, true);
    const again = await requirement(U.owner, true);
    return a.outcome === "forbidden" && b.outcome === "invalid_request" && c.outcome === "recorded" && again.outcome === "unchanged" ? true : { a, b, c, again };
  });
  await check("generated: A01 (assets in credit), A03 (cash in credit), T01 (tax workpaper) — exact minor units; nothing for correctly-signed accounts", async () => {
    run = await refresh(U.preparer, cur.year);
    if (run.runId === unscoped.runId) return "the scope change did not make a new run";
    const fs_ = (await admin.query("SELECT rule_id, finding_key, severity, mandatory, required_resolution, credit_minor::text c, detail FROM public.close_review_findings WHERE run_id=$1 ORDER BY finding_key", [run.runId])).rows;
    const keys = fs_.map((f) => f.finding_key);
    const a03 = fs_.find((f) => f.rule_id === "A03");
    const t01 = fs_.find((f) => f.rule_id === "T01");
    return run.outcome === "generated" && keys.includes("A01:1510") && keys.includes("A03:1010") && keys.includes("T01") && !keys.some((k) => k.startsWith("A07"))
      && keys.includes("A01:1010") /* petty cash in credit is also an asset on the wrong side */ && a03.severity === "blocking" && a03.mandatory && a03.required_resolution === "review"
      && a03.c === "20000" && t01.required_resolution === "evidence" && t01.detail.accounts.length === 1
      && !keys.some((k) => k.startsWith("A01:2") || k.startsWith("A01:3") || k.startsWith("A01:4")) ? true : fs_;
  });
  await check("every rule has a kind and a status; only evaluated rules can raise findings; every other status says why", async () => {
    const s = (await one("SELECT rule_status FROM public.close_review_finding_runs WHERE id=$1", [run.runId])).rule_status;
    // Independent expectation (the catalogue as reviewed), not read back from the implementation.
    const expected = { A01: ["risk_indicator", "evaluated"], A02: ["risk_indicator", "not_evaluated"], A03: ["deterministic_error", "evaluated"],
      A04: ["deterministic_error", "not_evaluated"], A05: ["risk_indicator", "not_evaluated"], A06: ["risk_indicator", "not_evaluated"],
      A07: ["deterministic_error", "excluded"], A08: ["risk_indicator", "not_evaluated"], A09: ["risk_indicator", "not_evaluated"],
      A10: ["risk_indicator", "evaluated"], T01: ["evidence_requirement", "evaluated"] };
    const bad = Object.entries(expected).filter(([k, [kind, status]]) => !s[k] || s[k].kind !== kind || s[k].status !== status
      || (status !== "evaluated" && !(s[k].reason?.length > 10)) || s[k].evaluated !== (status === "evaluated"));
    const raised = (await admin.query("SELECT DISTINCT rule_id FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows.map((r) => r.rule_id);
    const kinds = (await admin.query("SELECT DISTINCT rule_id, kind FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows;
    return bad.length === 0 && Object.keys(s).length === 11 && raised.every((r) => expected[r][1] === "evaluated")
      && kinds.every((k) => k.kind === expected[k.rule_id][0]) && s.A04.reason === "No authoritative prior-year trial balance." ? true : { bad, raised, kinds };
  });
  await check("generating again for the same authority is a replay (one run)", async () => {
    const again = await refresh(U.partner, cur.year);
    return again.outcome === "unchanged" && again.runId === run.runId && (await count("SELECT count(*) n FROM public.close_review_finding_runs")) === 2 ? true : again;
  });
  await check("the summary reports the current run and its unresolved blocking findings (A03, T01)", async () => {
    const s = await summary(U.viewer, cur.year);
    return s.state === "current" && s.runId === run.runId && Number(s.unresolvedBlocking) === 2 && s.currency === "TZS" ? true : s;
  });

  group("Findings — lifecycle");
  const fid = async (key) => (await one("SELECT id FROM public.close_review_findings WHERE run_id=$1 AND finding_key=$2", [run.runId, key])).id;
  await check("a member without capabilities cannot explain (forbidden); a preparer cannot accept (review_close needed)", async () => {
    const a = await act(U.viewer, await fid("A01:1510"), "explain");
    const b = await act(U.preparer, await fid("A01:1010"), "accept");
    return a.outcome === "forbidden" && b.outcome === "forbidden" ? true : { a, b };
  });
  await check("a mandatory finding has no accept or not-applicable path", async () => {
    const a = await act(U.partner, await fid("T01"), "accept");
    const b = await act(U.partner, await fid("A03:1010"), "not_applicable");
    return a.outcome === "mandatory_finding" && b.outcome === "mandatory_finding" ? true : { a, b };
  });
  await check("the tax finding needs the preparer's workpaper reference; with it, it is resolved", async () => {
    const a = await act(U.preparer, await fid("T01"), "explain", "Computed in the attached workpaper");
    const b = await act(U.preparer, await fid("T01"), "explain", "Computed in the attached workpaper", "Tax computation FY workpaper v2 (sha256 9f2c…)");
    const s = await summary(U.owner, cur.year);
    return a.outcome === "evidence_required" && b.outcome === "recorded" && b.status === "explained" && Number(s.unresolvedBlocking) === 1 ? true : { a, b, s };
  });
  await check("an explanation does not resolve a blocking finding that needs a review or an adjustment (A03 stays unresolved)", async () => {
    const a = await act(U.preparer, await fid("A03:1010"), "explain", "Petty cash float overdrawn");
    const s = await summary(U.owner, cur.year);
    return a.outcome === "recorded" && Number(s.unresolvedBlocking) === 1 ? true : { a, s };
  });
  await check("explain a warning; accept another (reviewer); reopen returns it to open; an action twice is an invalid transition", async () => {
    const e = await act(U.preparer, await fid("A01:1510"), "explain", "Contra asset: accumulated depreciation");
    const twice = await act(U.preparer, await fid("A01:1510"), "explain", "again");
    const acc = await act(U.partner, await fid("A01:1010"), "accept", "Petty cash float shown net; see A03");
    const re = await act(U.partner, await fid("A01:1510"), "reopen", "Please cite the asset register");
    return e.status === "explained" && twice.outcome === "invalid_transition" && acc.status === "accepted" && re.status === "open" ? true : { e, twice, acc, re };
  });
  await check("a retried action records once; the history keeps every step", async () => {
    const request = uuid();
    const id = await fid("A01:1510");
    const a = await act(U.preparer, id, "explain", "Per the asset register", null, request);
    const b = await act(U.preparer, id, "explain", "Per the asset register", null, request);
    const steps = (await admin.query("SELECT event_type FROM public.close_review_events WHERE subject_kind='finding' AND subject_id=$1 ORDER BY seq", [id])).rows.map((r) => r.event_type);
    return a.eventId === b.eventId && b.replay === true && steps.join(",") === "finding_explained,finding_reopened,finding_explained" ? true : { a, b, steps };
  });
  await refused("findings cannot be changed — not even by the database owner", "42501", () => admin.query("UPDATE public.close_review_findings SET severity='warning'"));
  await refused("clients cannot call the internal status helpers", "42501", () => asRole("authenticated", U.owner, "SELECT public.close_review_finding_status($1)", [uuid()]));

  group("Findings — authority changes");
  await check("an authoritative prior year makes a NEW run (the key includes the prior authority); A04 then names the missing pack basis", async () => {
    await certify(seed);                                   // the seed upload is the year before
    const r = await refresh(U.preparer, cur.year);
    const s = (await one("SELECT rule_status, prior_certification_id FROM public.close_review_finding_runs WHERE id=$1", [r.runId]));
    return r.outcome === "generated" && r.runId !== run.runId && s.prior_certification_id !== null
      && s.rule_status.A04.reason.includes("trial-balance basis") && s.rule_status.A07.evaluated === false ? true : { r, s };
  });
  await check("actions on a finding of the earlier run are refused (stale_authority)", async () => {
    const a = await act(U.partner, (await one("SELECT id FROM public.close_review_findings WHERE run_id=$1 AND finding_key='A01:1010'", [run.runId])).id, "reopen", "late");
    return a.outcome === "stale_authority" ? true : a;
  });
  await check("the authority invalidated: the summary says so (no_authority) and nothing can be generated", async () => {
    const certId = (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, cur.year])).id;
    await admin.query("INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id) VALUES ($1,$2,$3,'reprocess_requested',$4,$5)", [certId, A, cur.id, uuid(), U.owner]);
    const s = await summary(U.owner, cur.year);
    const r = await refresh(U.preparer, cur.year);
    return s.state === "no_authority" && r.outcome === "no_authority" ? true : { s, r };
  });
  return { upload, certify, refresh, summary, act };
}

// ── Adjustments (I3) ─────────────────────────────────────────────────────────────────────────────────────────────────
async function adjustmentsProof({ U, A }, kit) {
  const cur = await kit.upload();
  await kit.certify(cur);
  const Y = cur.year;
  const L = (key, d, c, memo) => ({ accountKey: key, debitMinor: String(d), creditMinor: String(c), ...(memo ? { memo } : {}) });
  const propose = (uid, lines, { reason = "Accrue December rent", evidence = null, findings = [], request = uuid(), reverses = null } = {}) =>
    asUser(uid, "SELECT public.close_review_propose_adjustment($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7,$8) r", [A, Y, reason, evidence, JSON.stringify(lines), findings, request, reverses]).then((r) => r.r);
  const decide = (uid, id, decision, { reason = "Agreed to the lease", ack = null, request = uuid() } = {}) =>
    asUser(uid, "SELECT public.close_review_decide_adjustment($1,$2,$3,$4,$5) r", [id, decision, reason, ack, request]).then((r) => r.r);
  const tb = async (uid = U.owner) => Object.fromEntries((await asRole("authenticated", uid, "SELECT * FROM public.close_review_adjusted_trial_balance($1,$2)", [A, Y]))
    .map((r) => [r.account_key, { d: r.adjusted_debit_minor, c: r.adjusted_credit_minor, ad: r.adjustment_debit_minor, ac: r.adjustment_credit_minor }]));
  const summary = (uid = U.owner) => asUser(uid, "SELECT public.close_review_adjustments_summary($1,$2) r", [A, Y]).then((r) => r.r);
  const policy = (uid, p, override, reason = "Sole practitioner") => asUser(uid, "SELECT public.close_review_set_approval_policy($1,$2,$3,$4) r", [A, p, override, reason]).then((r) => r.r);
  const certHash = async () => (await one("SELECT md5(c.rows_snapshot::text) h FROM public.get_authoritative_certification($1,$2) c", [A, Y])).h;

  group("Adjustments — proposal");
  let first;
  await check("a preparer proposes a balanced journal; it is numbered, bound to the authority and recorded on the timeline", async () => {
    first = await propose(U.preparer, [L("6000", 10000, 0, "December rent"), L("2000", 0, 10000)]);
    const a = await one("SELECT * FROM public.close_review_adjustments WHERE id=$1", [first.adjustmentId]);
    const cert = (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, Y])).id;
    const ev = await count("SELECT count(*) n FROM public.close_review_events WHERE subject_kind='adjustment' AND subject_id=$1 AND event_type='adjustment_proposed'", [first.adjustmentId]);
    return first.outcome === "proposed" && first.number === 1 && a.certification_id === cert && a.total_minor === "10000" && ev === 1 ? true : { first, a };
  });
  await check("a retried proposal is the same adjustment", async () => {
    const request = uuid();
    const a = await propose(U.preparer, [L("6000", 5, 0), L("2000", 0, 5)], { request });
    const b = await propose(U.preparer, [L("6000", 5, 0), L("2000", 0, 5)], { request });
    return a.adjustmentId === b.adjustmentId && b.replay === true ? true : { a, b };
  });
  for (const [label, lines, outcome] of [
    ["unbalanced", [L("6000", 10000, 0), L("2000", 0, 9999)], "unbalanced"],
    ["a line with both sides", [L("6000", 100, 100), L("2000", 0, 0)], "invalid_request"],
    ["a single line", [L("6000", 100, 0)], "invalid_request"],
    ["a fractional amount", [{ accountKey: "6000", debitMinor: "10.5", creditMinor: "0" }, L("2000", 0, 10)], "invalid_request"],
    ["a negative amount", [L("6000", -100, 0), L("2000", 0, -100)], "invalid_request"],
    ["an account the workspace has not classified", [L("9999", 100, 0), L("2000", 0, 100)], "unknown_account"],
  ]) {
    await check(`refused: ${label} (${outcome}); nothing recorded`, async () => {
      const n = await count("SELECT count(*) n FROM public.close_review_adjustments");
      const r = await propose(U.preparer, lines);
      return r.outcome === outcome && (await count("SELECT count(*) n FROM public.close_review_adjustments")) === n ? true : r;
    });
  }
  await check("a member without prepare_close cannot propose; a finding that is not current is refused", async () => {
    const a = await propose(U.viewer, [L("6000", 1, 0), L("2000", 0, 1)]);
    const b = await propose(U.preparer, [L("6000", 1, 0), L("2000", 0, 1)], { findings: [uuid()] });
    return a.outcome === "forbidden" && b.outcome === "finding_not_current" ? true : { a, b };
  });

  group("Adjustments — approval");
  await check("the proposer cannot approve their own adjustment under two-person approval", async () => {
    const r = await decide(U.preparer, first.adjustmentId, "approve");
    return r.outcome === "self_approval_not_allowed" || r.outcome === "forbidden" ? true : r;
  });
  const before = await certHash();
  await check("a reviewer approves (two_person); the adjusted trial balance moves; the certification is unchanged", async () => {
    const r = await decide(U.partner, first.adjustmentId, "approve");
    const t = await tb();
    const ev = await one("SELECT detail FROM public.close_review_events WHERE subject_id=$1 AND event_type='adjustment_approved'", [first.adjustmentId]);
    return r.outcome === "recorded" && r.status === "approved" && ev.detail.policy === "two_person" && ev.detail.selfApproved === false
      && t["6000"].ad === "10000" && t["6000"].d === "710000" && t["2000"].c === "310000" && (await certHash()) === before ? true : { r, t: t["6000"] };
  });
  await check("a decision is final: approving again is refused (already_decided); a retried decision replays", async () => {
    const request = uuid();
    const p2 = await propose(U.preparer, [L("6100", 300, 0), L("2000", 0, 300)], { reason: "Wages accrual" });
    const a = await decide(U.owner, p2.adjustmentId, "reject", { request, reason: "No support" });
    const b = await decide(U.owner, p2.adjustmentId, "reject", { request, reason: "No support" });
    const c = await decide(U.partner, p2.adjustmentId, "approve");
    const t = await tb();
    return a.status === "rejected" && b.replay === true && c.outcome === "already_decided" && t["6100"].ad === "0" ? true : { a, b, c };
  });
  await check("only the proposer withdraws; the proposer cannot reject their own", async () => {
    const p3 = await propose(U.preparer, [L("6100", 1, 0), L("2000", 0, 1)]);
    const a = await decide(U.partner, p3.adjustmentId, "withdraw");
    const b = await decide(U.preparer, p3.adjustmentId, "reject");
    const c = await decide(U.preparer, p3.adjustmentId, "withdraw", { reason: "Duplicate of #2" });
    return a.outcome === "forbidden" && b.outcome === "forbidden" && c.status === "withdrawn" ? true : { a, b, c };
  });

  group("Adjustments — self-approval policy");
  await check("only manage_members sets the policy (recorded as an event)", async () => {
    const a = await policy(U.preparer, "owner_self_approval", false);
    const b = await policy(U.owner, "owner_self_approval", false);
    return a.outcome === "forbidden" && b.outcome === "recorded"
      && (await count("SELECT count(*) n FROM public.close_review_approval_policy_events WHERE company_id=$1", [A])) === 1 ? true : { a, b };
  });
  let mine;
  await check("with two members holding approve_certification, self-approval is still unavailable (R3)", async () => {
    mine = await propose(U.partner, [L("6000", 2500, 0), L("2000", 0, 2500)], { reason: "Partner's accrual" });
    const r = await decide(U.partner, mine.adjustmentId, "approve");
    const s = await summary();
    return r.outcome === "self_approval_not_allowed" && s.selfApprovalAvailable === false && s.approvers === 2 ? true : { r, s };
  });
  await check("with the recorded override: the acknowledgement is required, then it is approved, stamped self_approved and disclosed", async () => {
    await policy(U.owner, "owner_self_approval", true, "Override: the second approver is on leave");
    const a = await decide(U.partner, mine.adjustmentId, "approve");
    const b = await decide(U.partner, mine.adjustmentId, "approve", { ack: true, reason: "I approve my own entry; disclosed" });
    const s = await summary();
    const row = s.adjustments.find((x) => x.id === mine.adjustmentId);
    return a.outcome === "acknowledgement_required" && b.outcome === "recorded" && b.selfApproved === true && row.selfApproved === true ? true : { a, b, row };
  });
  await check("a preparer without approve_certification can never self-approve, whatever the policy", async () => {
    const p = await propose(U.preparer, [L("6100", 7, 0), L("2000", 0, 7)]);
    const r = await decide(U.preparer, p.adjustmentId, "approve", { ack: true });
    return r.outcome === "self_approval_not_allowed" ? true : r;
  });

  group("Adjustments — reversal");
  await check("a reversal is a new adjustment with the server-negated lines; once approved the layer nets to the certified amounts", async () => {
    const r = await propose(U.preparer, [], { reason: "Reverse #1: rent was already accrued", reverses: first.adjustmentId });
    const lines = (await admin.query("SELECT account_key, debit_minor::text d, credit_minor::text c FROM public.close_review_adjustment_lines WHERE adjustment_id=$1 ORDER BY line_no", [r.adjustmentId])).rows;
    const ap = await decide(U.partner, r.adjustmentId, "approve");
    const t = await tb();
    return r.outcome === "proposed" && lines[0].account_key === "6000" && lines[0].c === "10000" && lines[1].d === "10000"
      && ap.status === "approved" && BigInt(t["6000"].d) - BigInt(t["6000"].c) === 702500n /* net 7,000.00 + partner's 25.00 */ ? true : { r, lines, t: t["6000"] };
  });
  await check("an adjustment cannot be reversed twice, and an unapproved one cannot be reversed", async () => {
    const a = await propose(U.preparer, [], { reason: "again", reverses: first.adjustmentId });
    const p = await propose(U.preparer, [L("6100", 9, 0), L("2000", 0, 9)]);
    const b = await propose(U.preparer, [], { reason: "reverse a pending one", reverses: p.adjustmentId });
    return a.outcome === "not_reversible" && b.outcome === "not_reversible" ? true : { a, b };
  });

  group("Adjustments — policy changes and revocation between proposal and approval");
  // The capability model in force (20260925140000): member capabilities, revocations recorded with a reason.
  const grant = (cap, who) => asUser(U.owner, "SELECT public.grant_member_capability($1,$2,$3,'Restored after the proof step') r", [A, who, cap]);
  const revoke = (cap, who) => asUser(U.owner, "SELECT public.revoke_member_capability($1,$2,$3,'Removed for the proof step') r", [A, who, cap]);
  await check("the policy in force AT APPROVAL decides: proposed under self-approval, then two-person → self-approval refused; another reviewer approves", async () => {
    const p = await propose(U.partner, [L("6000", 300, 0), L("2000", 0, 300)], { reason: "Partner's second accrual" });
    await policy(U.owner, "two_person", false, "Back to two-person approval");
    const self = await decide(U.partner, p.adjustmentId, "approve", { ack: true });
    const other = await decide(U.owner, p.adjustmentId, "approve");
    return self.outcome === "self_approval_not_allowed" && other.status === "approved" ? true : { self, other };
  });
  await check("a capability revoked between proposal and approval: the approval is refused; restored, it is accepted", async () => {
    const p = await propose(U.preparer, [L("6000", 400, 0), L("2000", 0, 400)], { reason: "Accrual awaiting review" });
    await revoke("review_close", U.partner);
    const refusedNow = await decide(U.partner, p.adjustmentId, "approve");
    await grant("review_close", U.partner);
    const ok = await decide(U.partner, p.adjustmentId, "approve");
    return refusedNow.outcome === "forbidden" && ok.status === "approved" ? true : { refusedNow, ok };
  });

  group("Adjustments — the resolution contract of a finding");
  const states = (y = Y) => asRole("authenticated", U.owner, "SELECT * FROM public.close_review_finding_states($1,$2)", [A, y]);
  await kit.refresh(U.preparer, Y);
  const fid = async (key) => (await one("SELECT f.id FROM public.close_review_findings f JOIN public.close_review_finding_runs r ON r.id=f.run_id WHERE r.company_id=$1 AND r.period_year=$2 AND f.finding_key=$3 ORDER BY r.created_at DESC LIMIT 1", [A, Y, key])).id;
  await check("a finding whose rule does not accept an adjustment cannot be named (T01 needs evidence)", async () => {
    const r = await propose(U.preparer, [L("7000", 1, 0), L("2100", 0, 1)], { findings: [await fid("T01")] });
    return r.outcome === "finding_not_resolvable_by_adjustment" ? true : r;
  });
  let a03Small, a03Rest;
  await check("naming A03 on an adjustment whose effect does NOT clear the credit balance leaves it open and blocking", async () => {
    const before = Number((await kit.summary(U.owner, Y)).unresolvedBlocking);
    a03Small = await propose(U.preparer, [L("1010", 5000, 0, "Part of the float"), L("2000", 0, 5000)], { findings: [await fid("A03:1010")], reason: "Partial reclassification" });
    await decide(U.partner, a03Small.adjustmentId, "approve");
    const s = await kit.summary(U.owner, Y);
    const id = await fid("A03:1010");
    const mine = (await states()).find((x) => x.finding_id === id);
    return mine.status !== "adjusted" && mine.resolved === false && Number(s.unresolvedBlocking) === before ? true : { mine, s: s.unresolvedBlocking, before };
  });
  await check("the effect decides, not the link: a further adjustment (not naming it) that clears the credit balance resolves A03", async () => {
    const before = Number((await kit.summary(U.owner, Y)).unresolvedBlocking);
    a03Rest = await propose(U.preparer, [L("1010", 15000, 0), L("2000", 0, 15000)], { reason: "Rest of the float" });
    await decide(U.partner, a03Rest.adjustmentId, "approve");
    const id = await fid("A03:1010");
    const mine = (await states()).find((x) => x.finding_id === id);
    const after = Number((await kit.summary(U.owner, Y)).unresolvedBlocking);
    return mine.status === "adjusted" && mine.resolved === true && after === before - 1 ? true : { mine, before, after };
  });
  await refused("adjustment lines cannot be changed — not even by the database owner", "42501", () => admin.query("UPDATE public.close_review_adjustment_lines SET debit_minor = debit_minor + 1"));
  await refused("adjustments cannot be deleted", "42501", () => admin.query("DELETE FROM public.close_review_adjustments"));
  await refused("clients cannot write adjustments directly", "42501", () => asRole("authenticated", U.owner, "INSERT INTO public.close_review_adjustments (company_id, period_year, number, certification_id, kind, reason, lines_sha256, total_minor, proposer_user_id, request_id) VALUES ($1,2000,99,$2,'adjustment','x','" + "a".repeat(64) + "',1,$3,$4)", [A, uuid(), U.owner, uuid()]));
  await check("another workspace reads none of these adjustments and cannot decide them", async () => {
    const rows = await asRole("authenticated", U.ownerB, "SELECT count(*)::int n FROM public.close_review_adjustments");
    const r = await decide(U.ownerB, first.adjustmentId, "reject");
    return rows[0].n === 0 && r.outcome === "not_found" ? true : { rows, r };
  });

  group("Adjustments — revalidation after the authority changes");
  const revalidate = (uid, id, decision = "revalidate", { reason = "Checked against the re-checked trial balance", ack = null, request = uuid() } = {}) =>
    asUser(uid, "SELECT public.close_review_revalidate_adjustment($1,$2,$3,$4,$5) r", [id, decision, reason, ack, request]).then((r) => r.r);
  const reprocess = async () => {
    const row = await one("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [cur.id]);
    await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [cur.id, uuid(), row.source_file_hash]);
    return kit.certify(cur);
  };
  const wages = await propose(U.preparer, [L("6100", 300, 0), L("2000", 0, 300)], { reason: "Wages accrual" });
  await decide(U.partner, wages.adjustmentId, "approve");
  const pending = await propose(U.preparer, [L("6100", 11, 0), L("2000", 0, 11)]);
  const cert1 = (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, Y])).id;
  const historyBefore = await count("SELECT count(*) n FROM public.close_review_events WHERE subject_kind='adjustment'");
  const cert2 = await reprocess();
  await check("a re-check: approved adjustments REQUIRE REVALIDATION — none applied, none discarded, their history intact; pending ones cannot be approved", async () => {
    const s = await summary();
    const t = await tb();
    const approved = s.adjustments.filter((x) => x.status === "approved");
    const stale = await decide(U.partner, pending.adjustmentId, "approve");
    const applied = Object.values(t).filter((x) => x.ad !== "0" || x.ac !== "0").length;
    return cert2 !== cert1 && approved.length > 0 && approved.every((x) => x.binding === "requires_revalidation" && x.current === false)
      && s.requiresRevalidation === approved.length && applied === 0 && stale.outcome === "stale_authority"
      && (await count("SELECT count(*) n FROM public.close_review_events WHERE subject_kind='adjustment'")) === historyBefore ? true : { s: s.adjustments.map((x) => [x.number, x.status, x.binding]), applied };
  });
  await check("only review_close revalidates; the proposer follows the self-approval rules (two-person now: refused)", async () => {
    const a = await revalidate(U.preparer, wages.adjustmentId);
    const b = await revalidate(U.partner, mine.adjustmentId, "revalidate", { ack: true });
    return a.outcome === "forbidden" && b.outcome === "self_approval_not_allowed" ? true : { a, b };
  });
  await check("revalidated: applied to the current certification, old and new bindings recorded with the affected accounts; the approval is not rewritten", async () => {
    const approvalBefore = JSON.stringify((await admin.query("SELECT * FROM public.close_review_events WHERE subject_id=$1 AND event_type='adjustment_approved'", [wages.adjustmentId])).rows);
    const r = await revalidate(U.owner, wages.adjustmentId);
    const b = await one("SELECT * FROM public.close_review_adjustment_bindings WHERE id=$1", [r.bindingId]);
    const t = await tb();
    const approvalAfter = JSON.stringify((await admin.query("SELECT * FROM public.close_review_events WHERE subject_id=$1 AND event_type='adjustment_approved'", [wages.adjustmentId])).rows);
    const acc = b.detail.accounts.find((x) => x.accountKey === "6100");
    return r.outcome === "recorded" && r.state === "applied" && b.from_certification_id === cert1 && b.to_certification_id === cert2 && b.decision === "revalidated"
      && acc.certifiedBefore.debitMinor === "120000" && acc.certifiedNow.debitMinor === "120000" && t["6100"].ad === "300" && approvalBefore === approvalAfter ? true : { r, b, t: t["6100"] };
  });
  await check("a replay returns the same decision; deciding again is already_current", async () => {
    const request = uuid();
    const a = await revalidate(U.owner, a03Rest.adjustmentId, "revalidate", { request });
    const b = await revalidate(U.owner, a03Rest.adjustmentId, "revalidate", { request });
    const c = await revalidate(U.owner, a03Rest.adjustmentId);
    return a.outcome === "recorded" && b.replay === true && b.bindingId === a.bindingId && c.outcome === "already_current" ? true : { a, b, c };
  });
  await check("8 concurrent revalidations of one adjustment: exactly one binding; it is applied once", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => revalidate(U.owner, a03Small.adjustmentId)));
    const n = await count("SELECT count(*) n FROM public.close_review_adjustment_bindings WHERE adjustment_id=$1", [a03Small.adjustmentId]);
    const t = await tb();
    return rs.filter((r) => r.outcome === "recorded").length === 1 && rs.every((r) => ["recorded", "already_current"].includes(r.outcome)) && n === 1
      && t["1010"].ad === "20000" /* 50.00 + 150.00, each once */ ? true : { outcomes: rs.map((r) => r.outcome), n, t: t["1010"] };
  });
  await check("a reversed pair is never carried (neither half); it can be declined, and stays in history as not carried", async () => {
    const reversal = (await one("SELECT id FROM public.close_review_adjustments WHERE reverses_id=$1", [first.adjustmentId])).id;
    const a = await revalidate(U.owner, first.adjustmentId);
    const b = await revalidate(U.owner, reversal);
    const c = await revalidate(U.owner, first.adjustmentId, "decline", { reason: "Reversed; nothing to carry" });
    const s = await summary();
    return a.outcome === "reversed_pair_not_carried" && b.outcome === "reversed_pair_not_carried" && c.outcome === "recorded"
      && s.adjustments.find((x) => x.id === first.adjustmentId).binding === "not_carried" ? true : { a, b, c };
  });
  await check("never applied twice: an equivalent adjustment already applied to the current certification blocks revalidating the old one", async () => {
    const dup = await propose(U.preparer, [L("6000", 300, 0), L("2000", 0, 300)], { reason: "Partner's second accrual, re-proposed" });
    await decide(U.partner, dup.adjustmentId, "approve");
    const old = (await one("SELECT a.id FROM public.close_review_adjustments a WHERE a.company_id=$1 AND a.period_year=$2 AND a.reason = 'Partner''s second accrual'", [A, Y])).id;
    const r = await revalidate(U.owner, old);
    return r.outcome === "duplicate_of_current" ? true : r;
  });
  await check("an invalid journal is refused: after an account is reclassified (and re-checked), an adjustment on it cannot be revalidated", async () => {
    // Reclassify Wages (6100) — a new review decision, a new authority.
    await asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, cur.id, uuid(), JSON.stringify([{ account_code: "6100", account_name: "Wages", proposal_type: "NONE",
      decision_action: "USER_MANUAL_CLASSIFICATION", statement: "income_statement", classification: "cost_of_goods_sold", normal_balance: "debit", is_cash_account: false }])]);
    const cert3 = await reprocess();
    const r = await revalidate(U.owner, wages.adjustmentId);
    const s = await summary();
    return cert3 !== cert2 && r.outcome === "journal_invalid" && r.accounts[0].accountKey === "6100" && r.accounts[0].classificationNow === "cost_of_goods_sold"
      && s.adjustments.find((x) => x.id === wages.adjustmentId).binding === "requires_revalidation" ? true : { r, cert3 };
  });
  await check("the authority invalidated: no layer, nothing can be approved or revalidated (no_authority / stale_authority)", async () => {
    const certId = (await one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, Y])).id;
    await admin.query("INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id) VALUES ($1,$2,$3,'reprocess_requested',$4,$5)", [certId, A, cur.id, uuid(), U.owner]);
    const t = await tb();
    const s = await summary();
    const r = await revalidate(U.owner, a03Small.adjustmentId);
    return Object.keys(t).length === 0 && s.state === "no_authority" && s.adjustments.every((x) => x.current === false) && r.outcome === "no_authority" ? true : { s: s.state, r };
  });
  await refused("bindings are append-only", "42501", () => admin.query("UPDATE public.close_review_adjustment_bindings SET reason='x'"));
}

// ── Financial Statements: the authoritative reporting input ──────────────────────────────────────────────────────────
async function reportingInputProof({ U, A, B }, kit) {
  const input = (uid, y) => asUser(uid, "SELECT public.fs_reporting_input($1,$2) r", [A, y]).then((r) => r.r);
  const L = (key, d, c) => ({ accountKey: key, debitMinor: String(d), creditMinor: String(c) });
  const propose = (uid, y, lines) => asUser(uid, "SELECT public.close_review_propose_adjustment($1,$2,'Proof accrual',NULL,$3::jsonb,'{}'::uuid[],$4,NULL) r", [A, y, JSON.stringify(lines), uuid()]).then((r) => r.r);
  const approve = (uid, id) => asUser(uid, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [id, uuid()]).then((r) => r.r);
  const acct = (inp, side, key) => inp[side].accounts.find((a) => a.accountKey === key);

  group("Reporting input — authority, layer, comparative, identity");
  const y1 = await kit.upload();
  await check("no authoritative trial balance: no_authority (never a non-authoritative upload)", async () => {
    const r = await input(U.owner, y1.year);
    return r.state === "no_authority" ? true : r;
  });
  await kit.certify(y1);
  let first;
  await check("current year: the authoritative certification with reviewed placement; the prior year is not authoritative (named, not substituted)", async () => {
    first = await input(U.viewer, y1.year);
    const rent = acct(first, "current", "6000");
    return first.state === "current" && first.contract === "fs-reporting-input/1" && first.current.currency === "TZS" && first.current.exponent === 2
      && rent.statement === "income_statement" && rent.normalBalance === "debit" && rent.debitMinor === "700000" && rent.adjustmentIds.length === 0
      && ["missing", "not_authoritative"].includes(first.comparative.state) && /^[0-9a-f]{64}$/.test(first.inputSha256) ? true : { s: first.state, c: first.comparative, rent };
  });
  await check("approved adjustments are applied as a layer with account lineage; the identity changes; the certified amounts do not", async () => {
    const p = await propose(U.preparer, y1.year, [L("6000", 15000, 0), L("2000", 0, 15000)]);
    const pending = await input(U.owner, y1.year);
    await approve(U.partner, p.adjustmentId);
    const after = await input(U.owner, y1.year);
    const rent = acct(after, "current", "6000");
    return pending.inputSha256 === first.inputSha256 /* a pending proposal is not applied */
      && after.inputSha256 !== first.inputSha256 && rent.certifiedDebitMinor === "700000" && rent.adjustmentDebitMinor === "15000"
      && rent.debitMinor === "715000" && rent.adjustmentIds.includes(p.adjustmentId) && after.adjustments.length === 1 && after.adjustments[0].selfApproved === false ? true : { rent, adj: after.adjustments };
  });
  await check("the same state reads the same identity (deterministic)", async () => {
    const a = await input(U.owner, y1.year), b = await input(U.partner, y1.year);
    return a.inputSha256 === b.inputSha256 ? true : [a.inputSha256, b.inputSha256];
  });
  const y2 = await kit.upload();
  await kit.certify(y2);
  await check("the next year: the comparative is the prior year AS REPORTED (its approved adjustments included), with its own lineage", async () => {
    const r = await input(U.owner, y2.year);
    const rent = r.comparative.accounts.find((a) => a.accountKey === "6000");
    return r.comparative.state === "available" && r.comparative.periodYear === y1.year && rent.debitMinor === "715000"
      && r.comparative.adjustments.length === 1 && acct(r, "current", "6000").debitMinor === "700000" ? true : { c: r.comparative.state, rent };
  });
  await check("a new approved adjustment in the PRIOR year changes the next year's identity (its comparative changed)", async () => {
    const before = (await input(U.owner, y2.year)).inputSha256;
    const p = await propose(U.preparer, y1.year, [L("6100", 100, 0), L("2000", 0, 100)]);
    await approve(U.partner, p.adjustmentId);
    const after = await input(U.owner, y2.year);
    return after.inputSha256 !== before && after.comparative.accounts.find((a) => a.accountKey === "6100").adjustmentDebitMinor === "100" ? true : { before, after: after.inputSha256 };
  });
  await check("another workspace and a rollout that is off read nothing", async () => {
    const other = await asUser(U.ownerB, "SELECT public.fs_reporting_input($1,$2) r", [A, y1.year]).then((r) => r.r);
    await asService("SELECT public.fs_set_company_rollout($1,false,'proof rollout off','proof')", [A]);
    const off = await input(U.owner, y1.year);
    await asService("SELECT public.fs_set_company_rollout($1,true,'proof rollout on','proof')", [A]);
    return other.state === "unavailable" && off.state === "unavailable" ? true : { other, off };
  });
  await refused("clients cannot call the internal period builders", "42501", () => asRole("authenticated", U.owner, "SELECT public._fs_adjusted_accounts($1,$2,$3)", [A, y1.year, uuid()]));
  await check("a re-check makes the input stale (approved adjustments no longer applied, counted as requiring revalidation); revalidating applies them and changes the identity again", async () => {
    const before = await input(U.owner, y1.year);
    const row = await one("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [y1.id]);
    await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [y1.id, uuid(), row.source_file_hash]);
    await kit.certify(y1);
    const rechecked = await input(U.owner, y1.year);
    const pend = rechecked.adjustmentsRequiringRevalidation;
    const ids = before.adjustments.map((a) => a.id);
    for (const id of ids) await asUser(U.owner, "SELECT public.close_review_revalidate_adjustment($1,'revalidate','Checked against the re-check',NULL,$2) r", [id, uuid()]);
    const after = await input(U.owner, y1.year);
    return rechecked.inputSha256 !== before.inputSha256 && rechecked.adjustments.length === 0 && pend === ids.length && pend > 0
      && after.inputSha256 !== rechecked.inputSha256 && after.adjustments.length === ids.length && after.adjustmentsRequiringRevalidation === 0
      && acct(after, "current", "6000").debitMinor === acct(before, "current", "6000").debitMinor ? true : { pend, ids: ids.length, a: after.adjustments.length };
  });
  await check("a self-revalidation (own proposer, self-approval policy, acknowledged) is disclosed in the input like a self-approval", async () => {
    const p = await asUser(U.owner, "SELECT public.close_review_propose_adjustment($1,$2,'Owner accrual',NULL,$3::jsonb,'{}'::uuid[],$4,NULL) r", [A, y1.year, JSON.stringify([L("6100", 700, 0), L("2000", 0, 700)]), uuid()]).then((r) => r.r);
    await approve(U.partner, p.adjustmentId);
    const row = await one("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [y1.id]);
    await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [y1.id, uuid(), row.source_file_hash]);
    await kit.certify(y1);
    await asUser(U.owner, "SELECT public.close_review_set_approval_policy($1,'owner_self_approval',true,'Override for the proof')", [A]);
    const noAck = await asUser(U.owner, "SELECT public.close_review_revalidate_adjustment($1,'revalidate','Mine, checked',NULL,$2) r", [p.adjustmentId, uuid()]).then((r) => r.r);
    const ok = await asUser(U.owner, "SELECT public.close_review_revalidate_adjustment($1,'revalidate','Mine, checked',true,$2) r", [p.adjustmentId, uuid()]).then((r) => r.r);
    await asUser(U.owner, "SELECT public.close_review_set_approval_policy($1,'two_person',false,'Back to two-person')", [A]);
    const inp2 = await input(U.owner, y1.year);
    const mineAdj = inp2.adjustments.find((a) => a.id === p.adjustmentId);
    return noAck.outcome === "acknowledgement_required" && ok.outcome === "recorded" && mineAdj?.selfRevalidated === true && mineAdj.selfApproved === false ? true : { noAck, ok, mineAdj };
  });
  void B;
}

// ── Sign-off completion requirements (I8) ────────────────────────────────────────────────────────────────────────────
async function signoffProof({ U, A, B }, kit) {
  const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const input = (y) => asUser(U.owner, "SELECT public.fs_reporting_input($1,$2) r", [A, y]).then((r) => r.r);
  const STATEMENT_TYPES = ["STATEMENT_OF_FINANCIAL_POSITION", "STATEMENT_OF_PROFIT_OR_LOSS", "STATEMENT_OF_CHANGES_IN_EQUITY", "STATEMENT_OF_CASH_FLOWS"];
  const AREAS = ["accounting-policies", "basis-of-preparation", "supporting-notes"];
  const both = (lineId) => ({ lineId, factBindings: [{ periodId: "CURRENT", factId: "f1" }, { periodId: "PRIOR", factId: "f0" }] });
  // A document complete for the IFRS profile; its trial-balance facts carry the source identity given.
  const doc = (rid, sourceHash, uploadId, { comparative = true } = {}) => ({
    reportIdentity: { reportId: rid, companyId: A, reportVersion: 1 },
    framework: { kind: "IFRS" }, period: { periodId: "CURRENT" },
    comparativePeriods: comparative ? [{ periodId: "PRIOR" }] : [],
    statements: STATEMENT_TYPES.map((type) => ({ statementId: `st:${type}`, type, sections: [{ sectionId: "s",
      lines: (type === "STATEMENT_OF_CASH_FLOWS" ? ["line:cf:opening", "line:cf:closing"] : [`l:${type}`]).map((l) => (comparative ? both(l) : { lineId: l, factBindings: [{ periodId: "CURRENT", factId: "f1" }] })) }] })),
    notes: [{ noteId: "note:cash-ledger-authority", monetaryFactIds: ["fact:cashroll:ledger:abc", "fact:cashroll:tb:abc"] }],
    textualDisclosures: [...AREAS.map((a) => ({ disclosureId: `checklist:${a}`, text: `PROVIDED: ${a}` })), { disclosureId: "mapping:coverage", text: "total=12;unmapped=0;ambiguous=0" }],
    facts: [{ factId: "f1", value: { minorUnits: { __bigint__: "100" }, currency: "TZS" },
      provenance: { source: { sourceDocumentId: uploadId, sourceHash, artifactKind: "TRIAL_BALANCE" } } }],
  });
  const evidence = async (y, type) => {
    const rid = `rpt-ev-${uuid()}`;
    const batchId = `eb-${uuid()}`;
    await asUser(U.partner, "SELECT * FROM public.fs_commit_revision($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::text[],$11::jsonb)", [
      A, rid, 0, `key-${uuid()}`, y, "TRIAL_BALANCE_DERIVED", JSON.stringify({ reportIdentity: { reportId: rid, companyId: A, reportVersion: 1 }, statements: [], facts: [] }), hex(rid),
      JSON.stringify([{ evidenceBatchId: batchId, reportingPeriodId: `FY${y}`, evidenceType: type, periodRole: "CURRENT", seriesKey: `s-${uuid()}`, schemaVersion: "1",
        sourceFileName: "ledger.csv", contentHash: hex(batchId), currency: "TZS", scale: 2, batchDocument: { rows: [{ amount: "1.00", memo: "ok" }] }, validationStatus: "VALID", diagnostics: [], expectedPreviousBatchId: null }]),
      [batchId], JSON.stringify({ evaluationRunId: `ev-${uuid()}`, rulePackId: "rp", rulePackVersion: "2", engineVersion: "e2", inputHash: hex(`ie${rid}`), findings: [] })]);
    return batchId;
  };
  const save = async (y, rid, d, batches) => {
    await asUser(U.preparer, "SELECT * FROM public.fs_save_report_version($1,1,$2,$3,'TRIAL_BALANCE_DERIVED',$4::jsonb,$5,$6::text[])", [rid, A, y, JSON.stringify(d), hex(`c${rid}`), batches]);
    await asUser(U.partner, "SELECT * FROM public.fs_save_evaluation($1,$2,1,$3,'rule-pack','1','engine-1',$4,'[]'::jsonb)", [`ev-${rid}`, rid, A, hex(`e${rid}`)]);
    return rid;
  };
  const readiness = (rid) => asUser(U.partner, "SELECT public.fs_report_readiness($1,$2,1) r", [A, rid]).then((r) => r.r);
  const setState = (uid, rid, state, reason = "sign-off proof step") => asUser(uid, "SELECT * FROM public.fs_set_publication_state($1,1,$2,$3,$4)", [rid, A, state, reason]);
  const mine = (r) => r.blockers.filter((b) => /^(REPORTING_INPUT|CLOSE_REVIEW|COMPARATIVE_PERIOD_MISSING)/.test(b));

  group("Sign-off — the report must be on the current authoritative input and a finished Close Review");
  const yr = await kit.upload();
  await kit.certify(yr);
  const ledger = await evidence(yr.year, "TRANSACTION_LEDGER");
  const equity = await evidence(yr.year, "EQUITY_MOVEMENTS");
  const batches = [ledger, equity];
  let inp = await input(yr.year);
  await check("a synthetic report (facts not from the authoritative input) is refused: REPORTING_INPUT_STALE", async () => {
    const rid = `rpt-syn-${uuid()}`;
    await save(yr.year, rid, doc(rid, hex("processing-result"), yr.id), batches);
    const r = await readiness(rid);
    return mine(r).includes("REPORTING_INPUT_STALE") ? true : r.blockers;
  });
  let rid1;
  await check("on the current input but before the findings check: CLOSE_REVIEW_FINDINGS_NOT_CHECKED (and nothing else of ours)", async () => {
    rid1 = `rpt-a-${uuid()}`;
    await save(yr.year, rid1, doc(rid1, inp.inputSha256, yr.id), batches);
    const r = await readiness(rid1);
    return JSON.stringify(mine(r)) === JSON.stringify(["CLOSE_REVIEW_FINDINGS_NOT_CHECKED"]) ? true : r.blockers;
  });
  await check("after the check: the unresolved blocking findings are named (A03 and T01) and REVIEWED is refused", async () => {
    await kit.refresh(U.preparer, yr.year);
    inp = await input(yr.year);
    const rid = `rpt-b-${uuid()}`;
    await save(yr.year, rid, doc(rid, inp.inputSha256, yr.id), batches);
    const r = await readiness(rid);
    let refusal = null;
    try { await setState(U.partner, rid, "REVIEWED"); } catch (e) { refusal = String(e.message); }
    return mine(r).includes("CLOSE_REVIEW_BLOCKING_FINDINGS:2") && /CLOSE_REVIEW_BLOCKING_FINDINGS/.test(refusal ?? "") ? true : { b: r.blockers, refusal };
  });
  let ridFinal;
  await check("resolve T01 with the workpaper and A03 with an approved adjustment; an undecided adjustment blocks; the input moved, so the earlier report is stale", async () => {
    const f = async (key) => (await one("SELECT f.id FROM public.close_review_findings f JOIN public.close_review_finding_runs r ON r.id=f.run_id WHERE r.company_id=$1 AND r.period_year=$2 AND f.finding_key=$3 ORDER BY r.created_at DESC LIMIT 1", [A, yr.year, key])).id;
    await kit.act(U.preparer, await f("T01"), "explain", "Computed in the workpaper", "Tax WP v1");
    const p = await asUser(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,'Present the overdrawn float as a payable',NULL,$3::jsonb,$4::uuid[],$5,NULL) r",
      [A, yr.year, JSON.stringify([{ accountKey: "1010", debitMinor: "20000", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "20000" }]), [await f("A03:1010")], uuid()]).then((r) => r.r);
    await asUser(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [p.adjustmentId, uuid()]);
    const pend = await asUser(U.preparer, "SELECT public.close_review_propose_adjustment($1,$2,'Pending one',NULL,$3::jsonb,'{}'::uuid[],$4,NULL) r",
      [A, yr.year, JSON.stringify([{ accountKey: "6100", debitMinor: "5", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "5" }]), uuid()]).then((r) => r.r);
    inp = await input(yr.year);
    ridFinal = `rpt-c-${uuid()}`;
    await save(yr.year, ridFinal, doc(ridFinal, inp.inputSha256, yr.id), batches);
    const r = await readiness(ridFinal);
    const old = await readiness(rid1);
    await asUser(U.preparer, "SELECT public.close_review_decide_adjustment($1,'withdraw','Not needed',NULL,$2) r", [pend.adjustmentId, uuid()]);
    return JSON.stringify(mine(r)) === JSON.stringify(["CLOSE_REVIEW_ADJUSTMENTS_UNDECIDED:1"]) && mine(old).includes("REPORTING_INPUT_STALE") ? true : { r: r.blockers, old: old.blockers };
  });
  await check("the complete, authoritative report is ready: REVIEWED (review_close), then FINAL (approve_certification); FINAL is immutable", async () => {
    const r = await readiness(ridFinal);
    const reviewed = await setState(U.partner, ridFinal, "REVIEWED");
    const fin = await setState(U.owner, ridFinal, "FINAL", "final sign-off on the authoritative input");
    let again = null;
    try { await setState(U.partner, ridFinal, "REVIEWED", "trying to reopen"); } catch (e) { again = e.code; }
    return r.ready === true && reviewed.state === "REVIEWED" && fin.state === "FINAL" && again === "PT409" ? true : { r: r.blockers, again };
  });
  await check("a preparer cannot mark REVIEWED (capabilities unchanged: one sign-off path)", async () => {
    let a = null;
    try { await setState(U.preparer, rid1, "REVIEWED"); } catch (e) { a = e.code; }
    return a === "42501" ? true : a;
  });

  group("Sign-off — approved adjustments awaiting revalidation block sign-off");
  await check("after a re-check, a report on the new input is blocked until each approved adjustment is revalidated or declined", async () => {
    const row = await one("SELECT source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [yr.id]);
    await asUser(U.owner, "SELECT public.tbu_request_reprocess($1,$2,$3) r", [yr.id, uuid(), row.source_file_hash]);
    await kit.certify(yr);
    let i2 = await input(yr.year);
    const ridA = `rpt-rv-${uuid()}`;
    await save(yr.year, ridA, doc(ridA, i2.inputSha256, yr.id), batches);
    const blocked = mine(await readiness(ridA));
    const approved = (await admin.query("SELECT a.id FROM public.close_review_adjustments a WHERE a.company_id=$1 AND a.period_year=$2", [A, yr.year])).rows;
    for (const a of approved) await asUser(U.partner, "SELECT public.close_review_revalidate_adjustment($1,'revalidate','Checked on the re-check',NULL,$2) r", [a.id, uuid()]);
    i2 = await input(yr.year);
    const ridB = `rpt-rv2-${uuid()}`;
    await save(yr.year, ridB, doc(ridB, i2.inputSha256, yr.id), batches);
    const after = mine(await readiness(ridB));
    return blocked.includes("CLOSE_REVIEW_ADJUSTMENTS_REQUIRE_REVALIDATION:1") && !after.some((b) => b.startsWith("CLOSE_REVIEW_ADJUSTMENTS_REQUIRE_REVALIDATION"))
      && mine(await readiness(ridA)).includes("REPORTING_INPUT_STALE") ? true : { blocked, after };
  });

  group("Sign-off — the first-period exception (a genuinely first period only)");
  const declare = (uid, company, y, on, { kind = "certificate_of_incorporation", ref = "Certificate of incorporation no. 123", date = "2026-01-15" } = {}) =>
    asUser(uid, "SELECT public.fs_declare_first_period($1,$2,$3,'First reporting period since incorporation',$4,$5,$6::date) r",
      [company, y, on, on ? kind : null, on ? ref : null, on ? date : null]).then((r) => r.r);
  await check("without comparative figures: COMPARATIVE_PERIOD_MISSING (never zero, never an automatic exception)", async () => {
    const rid = `rpt-fp-${uuid()}`;
    await save(yr.year, rid, doc(rid, inp.inputSha256, yr.id, { comparative: false }), batches);
    const r = await readiness(rid);
    return mine(r).includes("COMPARATIVE_PERIOD_MISSING") ? true : r.blockers;
  });
  await check("a workspace with earlier trial balances is missing comparative information, not a first period: refused, whatever the evidence; a preparer is refused first", async () => {
    const a = await declare(U.preparer, A, yr.year, true);
    const b = await declare(U.owner, A, yr.year, true);
    return a.outcome === "forbidden" && b.outcome === "earlier_reviewed_period_exists" ? true : { a, b };
  });
  // Workspace B: a genuinely first period (no earlier trial balance of any kind).
  const FY = 2024;
  await admin.query("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end) VALUES ($1,$2,$3,$4,'TZS',$5,$2)", [B, `${FY}-12-31`, `FY${FY}`, U.ownerB, `${FY}-03-01`]);
  const ridB = `rpt-b-${uuid()}`;
  await asUser(U.ownerB, "SELECT * FROM public.fs_save_report_version($1,1,$2,$3,'DOCUMENT_REVIEWED',$4::jsonb,$5,'{}'::text[])", [ridB, B, FY, JSON.stringify({ ...doc(ridB, hex("doc"), uuid(), { comparative: false }), reportIdentity: { reportId: ridB, companyId: B, reportVersion: 1 } }), hex(`c${ridB}`)]);
  await asUser(U.ownerB, "SELECT * FROM public.fs_save_evaluation($1,$2,1,$3,'rule-pack','1','engine-1',$4,'[]'::jsonb)", [`ev-${ridB}`, ridB, B, hex(`e${ridB}`)]);
  const readyB = () => asUser(U.ownerB, "SELECT public.fs_report_readiness($1,$2,1) r", [B, ridB]).then((r) => mine(r.r));
  await check("relevant evidence issued AFTER the period (a later certified copy) is accepted; the declaration satisfies the requirement", async () => {
    const before = await readyB();
    const r = await declare(U.ownerB, B, FY, true, { date: "2025-06-30" });
    const after = await readyB();
    return before.includes("COMPARATIVE_PERIOD_MISSING") && r.outcome === "recorded" && !after.includes("COMPARATIVE_PERIOD_MISSING") ? true : { before, r, after };
  });
  await check("irrelevant evidence is refused; a member of another workspace cannot declare here", async () => {
    await declare(U.ownerB, B, FY, false);
    const a = await declare(U.ownerB, B, FY, true, { kind: "bank_statement", ref: "Bank statement March" });
    const b = await declare(U.owner, B, FY, true);
    const c = await declare(U.ownerB, B, FY, true);
    return a.outcome === "evidence_not_relevant" && b.outcome === "forbidden" && c.outcome === "recorded" ? true : { a, b, c };
  });
  await check("conflicting history appearing later (an earlier-period trial balance) voids the declaration: COMPARATIVE_PERIOD_MISSING again; a new one is refused", async () => {
    await admin.query("INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, user_id) VALUES ('old.csv',$1,1,'processing',$2,$3,$4)", [`${U.ownerB}/${uuid()}.csv`, B, FY - 1, U.ownerB]);
    const after = await readyB();
    const voided = await asUser(U.ownerB, "SELECT public.fs_first_period_declared($1,$2) r", [B, FY]).then((r) => r.r);
    await declare(U.ownerB, B, FY, false);
    const again = await declare(U.ownerB, B, FY, true);
    return after.includes("COMPARATIVE_PERIOD_MISSING") && voided === false && again.outcome === "earlier_period_data_exists" ? true : { after, voided, again };
  });
  await refused("declarations are append-only", "42501", () => admin.query("UPDATE public.fs_first_period_declarations SET reason = 'x'"));
}

async function main() {
  const ctx = await setup();
  await timelineProof(ctx);
  const kit = await findingsProof(ctx);
  await adjustmentsProof(ctx, kit);
  await reportingInputProof(ctx, kit);
  await signoffProof(ctx, kit);
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "CLOSE_REVIEW_AUTHORITY: ALL PASSED" : "CLOSE_REVIEW_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
