#!/usr/bin/env bun
// Real-PostgreSQL proof of the engagements portfolio read (20261117100000; Trial Balance workflow, Track A).
//
//   authorization  the creator, an accepted active member and a capability-grant holder see a company; a pending
//                  member, a suspended named user, a revoked member, another tenant and anon see nothing;
//   paging         keyset over 130+ engagements in every sort: no duplicate, no gap, deterministic, page size 1–100;
//   filters        search (LIKE metacharacters literal), purpose separate from status, period year; exact counts;
//   status         every status from the real attempt/certification path and the authoritative function;
//   consistency    the view token changes for a visible change and for a visibility change, never for another tenant;
//   cost           measured (reported, and bounded by the stated budget as a release check — not assumed).
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> node scripts/db-proof/engagementPortfolio.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const FILE = "20261117100000_engagement_portfolio.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
/** The portfolio read's cost budget for this proof's data set (a release check, measured here; not a latency guarantee). */
const BUDGET_MS = Number(process.env.PORTFOLIO_BUDGET_MS ?? 1500);

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") { results.push({ group: currentGroup, name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 700)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-portfolio-proof-"));
  const port = 56900 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE portfolio_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/portfolio_proof`;
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
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const asService = (sql, params) => asRole("service_role", null, sql, params);
const SRC = crypto.createHash("sha256").update("engagement-portfolio-proof").digest("hex");
const result = (blocking, review) => ({ outcome: "certified",
  upload: { status: blocking ? "blocked" : review ? "needs_review" : "complete", is_valid: !blocking && !review, processing_result: { status: "x" }, validation_report: { ok: !blocking }, accounting_errors: [] },
  certification: { normalized_input_hash: "n", output_hash: "o", is_blocking: blocking, requires_review: review, rows_snapshot: [],
    exceptions: blocking ? [{ code: "TRIAL_BALANCE_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits do not equal credits." }] : [] } });

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url }); await admin.connect();
  pool = new Pool({ connectionString: url, max: 20 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions; GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
    CREATE OR REPLACE FUNCTION extensions.digest(text, text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT AS 'SELECT public.digest($1, $2)';`);
  const files = currentChain(REPO);
  const applyFile = async (f) => {
    let t = migrationSql(REPO, f);
    if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    await admin.query(t);
  };

  group("Chain — every migration applies, the portfolio included; a second application is refused");
  await check(`the full chain applies, ${FILE} included`, async () => {
    if (!files.includes(FILE)) return `${FILE} missing from the chain`;
    for (const f of files) { try { await applyFile(f); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });
  await check("re-applying the migration is refused by its preflight, nothing changed", async () =>
    applyFile(FILE).then(() => "ran", (e) => (/PREFLIGHT_REFUSED/.test(e.message) ? true : e.message)));
  await check("privileges: the read for authenticated only; the helpers and the revision table for no client", async () => {
    const r = await one(`SELECT has_function_privilege('authenticated','public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)','EXECUTE') a,
        has_function_privilege('anon','public.list_portfolio_engagements(text,text[],text[],integer,text,integer,jsonb)','EXECUTE') b,
        has_function_privilege('authenticated','public._portfolio_visible_companies(uuid)','EXECUTE') c,
        has_function_privilege('authenticated','public._portfolio_bump(uuid)','EXECUTE') d,
        has_table_privilege('authenticated','public.portfolio_revisions','SELECT') e,
        has_function_privilege('authenticated','public.list_portfolio_entities(integer)','EXECUTE') f,
        has_function_privilege('authenticated','public.get_account_home(text[],integer)','EXECUTE') g,
        has_function_privilege('anon','public.get_account_home(text[],integer)','EXECUTE') h`);
    return r.a && !r.b && !r.c && !r.d && !r.e && r.f && r.g && !r.h ? true : r;
  });

  // ── Fixture: two tenants; tenant A has 130 engagements across 26 companies; invented names only ───────────────────
  const U = { owner: uuid(), ownerB: uuid(), member: uuid(), pending: uuid(), suspended: uuid(), revoked: uuid(), grantee: uuid(), stranger: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.ownerB]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 0 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
    // The fixture account needs 26 entities: an explicit, recorded entity allowance (the supported override), not a bypass.
    if (uid === U.owner) await admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, granted_by, reason) VALUES ($1,'ENTITY_CAPACITY',50,$2,'portfolio proof fixture')", [bc, uid]);
  }
  const companiesA = [], namesA = [];
  for (let i = 0; i < 26; i++) {
    const name = i === 3 ? "Invented 50% Traders_Ltd" : `Invented Entity ${String.fromCharCode(65 + i)} ${i % 2 ? "Holdings" : "Ltd"}`;
    namesA.push(name);
    companiesA.push((await one("INSERT INTO public.companies (user_id,name,code,tin) VALUES ($1,$2,$3,$4) RETURNING id", [U.owner, name, `C${100 + i}`, `9000000${String(i).padStart(2, "0")}`])).id);
  }
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Invented Other Tenant Ltd') RETURNING id", [U.ownerB])).id;
  const memberOf = async (company, uid, accepted = true) => admin.query(
    `INSERT INTO public.firm_members (company_id, user_id, role, invited_email, accepted_at) VALUES ($1,$2,'preparer',$3,$4)`,
    [company, uid, `${uid.slice(0, 6)}@example.test`, accepted ? new Date().toISOString() : null]);
  const C0 = companiesA[0], C1 = companiesA[1];
  await memberOf(C0, U.member); await memberOf(C0, U.pending, false); await memberOf(C0, U.suspended); await memberOf(C0, U.revoked);
  await admin.query("INSERT INTO public.named_user_billing_suspensions (account_user_id, user_id, reason) VALUES ($1,$2,'OWNER_SELECTION')", [U.owner, U.suspended]);
  await admin.query("DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [C0, U.revoked]);
  const ownerMember = async (company) => (await one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=(SELECT user_id FROM public.companies WHERE id=$1)", [company]))?.id ?? null;
  const grantCol = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='workspace_capability_grants'")).rows.map((r) => r.column_name);

  const engagements = [];
  async function openPeriod(company, year, currency = "TZS") {
    const period = (await one(`INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start, reporting_end)
      VALUES ($1,$2,$3,(SELECT user_id FROM public.companies WHERE id=$1),$4,$5,$6) RETURNING id`, [company, `${year}-12-31`, `FY${year}`, currency, `${year}-01-01`, `${year}-12-31`])).id;
    const e = (await one(`INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id) VALUES ($1,$2,'composite',$3) RETURNING id`, [period, company, await ownerMember(company)])).id;
    engagements.push({ id: e, company, period, year });
    return { engagement: e, period, year, company };
  }
  for (const c of companiesA) for (const y of [2021, 2022, 2023, 2024, 2025]) await openPeriod(c, y);
  await openPeriod(B, 2025);

  // Status fixtures on C1 (each a different period), through the real attempt path.
  const owner1 = await one("SELECT user_id u FROM public.companies WHERE id=$1", [C1]);
  async function upload(company, year, period) {
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id, source_file_hash)
      VALUES ('invented-tb.csv',$1,10,'processing',$2,$3,$4,$5,$6) RETURNING id`, [`${owner1.u}/${uuid()}.csv`, company, year, period, owner1.u, SRC])).id;
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v6',6,'workspace_user',NULL,$4,600) r", [up, uuid(), SRC, owner1.u]))[0].r;
    if (b.outcome !== "claimed") throw new Error(`begin: ${JSON.stringify(b)}`);
    return { up, run: b.engine_run_id };
  }
  const snapshot = (run, company) => asService("SELECT public.tb_snapshot_dependencies($1,$2::jsonb) r",
    [run, JSON.stringify([{ scope: company, key: "#framework" }, { scope: company, key: "#currency" }, { scope: "global", key: "#dictionary" }])]);
  const finalize = async (run, r) => (await asService("SELECT public.tb_finalize_attempt($1,$2::jsonb) r", [run, JSON.stringify(r)]))[0].r;
  const e1 = engagements.filter((e) => e.company === C1);
  const statusFixture = {};
  { const t = await upload(C1, 2021, e1[0].period); statusFixture.processing = e1[0].id; void t; }
  { const t = await upload(C1, 2022, e1[1].period); await snapshot(t.run, C1); await finalize(t.run, result(true, false)); statusFixture.blocked = e1[1].id; }
  { const t = await upload(C1, 2023, e1[2].period); await snapshot(t.run, C1); await finalize(t.run, result(false, true)); statusFixture.needs_decision = e1[2].id; }
  { const t = await upload(C1, 2024, e1[3].period); await snapshot(t.run, C1); await finalize(t.run, result(false, false)); statusFixture.ready = e1[3].id; }
  statusFixture.no_trial_balance = e1[4].id;

  const list = (uid, o = {}) => asRole("authenticated", uid, "SELECT public.list_portfolio_engagements($1,$2,$3,$4,$5,$6,$7::jsonb) r",
    [o.search ?? null, o.statuses ?? null, o.purposes ?? null, o.year ?? null, o.sort ?? null, o.limit ?? null, o.cursor ? JSON.stringify(o.cursor) : null]).then((r) => r[0].r);
  async function all(uid, o = {}) {
    const seen = []; let cursor = null; let pages = 0; let token = null; let total = null;
    do {
      const r = await list(uid, { ...o, cursor });
      if (r.outcome !== "ok") return { error: r };
      token ??= r.view_token; total ??= r.total;
      if (r.view_token !== token) return { error: "token changed" };
      seen.push(...r.rows.map((x) => x.engagement_id));
      cursor = r.next_cursor; pages++;
    } while (cursor && pages < 100);
    return { seen, pages, total };
  }

  group("Authorization — the platform's workspace-access rule, through one definer function");
  await check("the owner sees all 130 of their engagements and none of the other tenant's", async () => {
    const r = await all(U.owner, { limit: 25 });
    const ids = new Set(engagements.filter((e) => e.company !== B).map((e) => e.id));
    return r.seen?.length === 130 && r.seen.every((x) => ids.has(x)) && r.total === 130 ? true : { n: r.seen?.length, total: r.total, error: r.error };
  });
  await check("an accepted active member sees exactly that company's engagements", async () => {
    const r = await all(U.member, { limit: 100 });
    return r.seen?.length === 5 && r.seen.every((x) => engagements.find((e) => e.id === x)?.company === C0) ? true : r;
  });
  await check("a pending member, a suspended named user, a revoked member, a stranger and another tenant's owner see nothing of tenant A", async () => {
    const out = {};
    for (const k of ["pending", "suspended", "revoked", "stranger"]) out[k] = (await list(U[k], { limit: 100 })).rows?.length;
    const b = await list(U.ownerB, { limit: 100 });
    out.ownerB = b.rows.filter((x) => x.company_id !== B).length;
    return Object.values(out).every((n) => n === 0) && b.rows.length === 1 ? true : out;
  });
  await check("anon cannot execute the read (42501); an unauthenticated authenticated-role call answers unauthenticated", async () => {
    const a = await asRole("anon", null, "SELECT public.list_portfolio_engagements(NULL,NULL,NULL,NULL,NULL,NULL,NULL) r", []).then(() => "ran", (e) => e.code);
    const u = await list(null, {});
    return a === "42501" && u.outcome === "unauthenticated" ? true : { a, u };
  });
  if (grantCol.includes("grantee_user_id")) {
    await check("an unrevoked capability-grant holder sees the granted company; after revocation, nothing", async () => {
      const cols = grantCol.includes("capability") ? "company_id, grantee_user_id, capability" : "company_id, grantee_user_id";
      const vals = grantCol.includes("capability") ? "$1,$2,'prepare_trial_balance'" : "$1,$2";
      const by = grantCol.find((c) => c === "granted_by_user_id" || c === "granted_by");
      const extra = by ? { cols: `, ${by}`, vals: ",$3" } : { cols: "", vals: "" };
      try {
        await admin.query(`INSERT INTO public.workspace_capability_grants (${cols}${extra.cols}) VALUES (${vals}${extra.vals})`, extra.cols ? [C1, U.grantee, U.owner] : [C1, U.grantee]);
      } catch (e) { return `grant fixture: ${e.message.split("\n")[0]}`; }
      const before = (await list(U.grantee, { limit: 100 })).rows.length;
      const revokedBy = grantCol.find((c) => c === "revoked_by_user_id" || c === "revoked_by");
      await admin.query(`UPDATE public.workspace_capability_grants SET revoked_at=now()${revokedBy ? `, ${revokedBy}=$2` : ""} WHERE grantee_user_id=$1`, revokedBy ? [U.grantee, U.owner] : [U.grantee]);
      const after = (await list(U.grantee, { limit: 100 })).rows.length;
      return before === 5 && after === 0 ? true : { before, after };
    });
  }

  group("Paging — keyset, deterministic, every sort; page size 1–100");
  for (const sort of ["entity", "period", "opened"]) {
    await check(`sort ${sort}: pages of 7 cover all 130 exactly once, in the stated order, twice identically`, async () => {
      const a = await all(U.owner, { sort, limit: 7 }), b = await all(U.owner, { sort, limit: 7 });
      const unique = new Set(a.seen);
      return a.seen?.length === 130 && unique.size === 130 && JSON.stringify(a.seen) === JSON.stringify(b.seen) && a.pages === Math.ceil(130 / 7) ? true : { n: a.seen?.length, unique: unique.size, pages: a.pages, same: JSON.stringify(a.seen) === JSON.stringify(b.seen) };
    });
  }
  await check("entity order: name ascending, then period year descending, then engagement id", async () => {
    const r = await list(U.owner, { sort: "entity", limit: 12 });
    const keys = r.rows.map((x) => [x.company_name.toLowerCase(), x.period_year]);
    const ok = keys.every((k, i) => i === 0 || keys[i - 1][0] < k[0] || (keys[i - 1][0] === k[0] && keys[i - 1][1] >= k[1]));
    return ok ? true : keys;
  });
  await check("page size: 0, 101 and a negative size are refused (INVALID_LIMIT); 100 and 1 are accepted; the default is 25", async () => {
    const z = await list(U.owner, { limit: 0 }), big = await list(U.owner, { limit: 101 }), neg = await list(U.owner, { limit: -1 });
    const h = await list(U.owner, { limit: 100 }), o = await list(U.owner, { limit: 1 }), d = await list(U.owner, {});
    return [z, big, neg].every((x) => x.code === "INVALID_LIMIT") && h.rows.length === 100 && o.rows.length === 1 && d.rows.length === 25 ? true : { z, big, neg };
  });
  await check("an unknown sort, filter value or malformed cursor is refused, never guessed", async () => {
    const s = await list(U.owner, { sort: "attention" }), f = await list(U.owner, { statuses: ["nope"] }), p = await list(U.owner, { purposes: ["vip"] });
    const c = await list(U.owner, { cursor: { id: "not-a-uuid" } });
    return s.code === "INVALID_SORT" && f.code === "INVALID_FILTER" && p.code === "INVALID_FILTER" && c.code === "INVALID_CURSOR" ? true : { s, f, p, c };
  });

  group("Filters — search, purpose and status separate; exact counts");
  await check("search matches name, code or TIN case-insensitively; % and _ are literal", async () => {
    const byName = await list(U.owner, { search: "holdings", limit: 100 });
    const byCode = await list(U.owner, { search: "c105", limit: 100 });
    const byTin = await list(U.owner, { search: "900000025", limit: 100 });
    const pct = await list(U.owner, { search: "50%", limit: 100 });
    const underscore = await list(U.owner, { search: "traders_ltd", limit: 100 });
    const wildcard = await list(U.owner, { search: "%", limit: 100 });
    const holdings = namesA.filter((n) => n.toLowerCase().includes("holdings")).length * 5;
    return byName.total === holdings && byCode.total === 5 && byTin.total === 5 && pct.total === 5 && underscore.total === 5 && wildcard.total === 5
      ? true : { byName: byName.total, byCode: byCode.total, byTin: byTin.total, pct: pct.total, underscore: underscore.total, wildcard: wildcard.total };
  });
  await check("purpose is a separate filter: test workspaces filter out of client work; not_stated is explicit", async () => {
    await admin.query("INSERT INTO public.workspace_purpose_events (company_id, purpose, reason, actor_user_id) VALUES ($1,'test','Invented test workspace',$2)", [companiesA[25], U.owner]);
    const test = await list(U.owner, { purposes: ["test"], limit: 100 }), notStated = await list(U.owner, { purposes: ["not_stated"], limit: 100 });
    return test.total === 5 && test.rows.every((x) => x.purpose === "test") && notStated.total === 125 ? true : { test: test.total, notStated: notStated.total };
  });
  await check("period-year filter and the total are exact", async () => {
    const y = await list(U.owner, { year: 2023, limit: 100 });
    return y.total === 26 && y.rows.every((x) => x.period_year === 2023) ? true : { total: y.total };
  });

  group("Status — from the real attempt path and the authoritative function");
  await check("each fixture shows its status: processing, blocked, needs_decision, ready, no_trial_balance", async () => {
    const r = await list(U.owner, { search: "c101", limit: 100 });
    const by = Object.fromEntries(r.rows.map((x) => [x.engagement_id, x.status]));
    const want = Object.fromEntries(Object.entries(statusFixture).map(([s, id]) => [id, s]));
    const bad = Object.entries(want).filter(([id, s]) => by[id] !== s);
    return bad.length === 0 ? true : { bad, by };
  });
  await check("the status filter applies after the counts: status_counts describe the filtered set, total the status-filtered set", async () => {
    const r = await list(U.owner, { search: "c101", statuses: ["blocked"], limit: 100 });
    return r.total === 1 && r.rows[0]?.engagement_id === statusFixture.blocked && r.status_counts.blocked === 1 && r.status_counts.no_trial_balance === 1 ? true : r;
  });
  await check("upload metadata: file, time and uploader are the latest active upload's; a missing uploader name is null, never invented", async () => {
    const r = await list(U.owner, { search: "c101", statuses: ["ready"], limit: 100 });
    const u = r.rows[0]?.upload;
    return u && u.file_name === "invented-tb.csv" && u.uploaded_at && u.uploaded_by === null ? true : r.rows[0];
  });

  group("Consistency — a tenant-scoped view token (a live view: refresh required on change)");
  await check("the token is stable without changes; a visible upload change changes it; another tenant's change does not", async () => {
    const t0 = (await list(U.owner, { limit: 5 })).view_token, t1 = (await list(U.owner, { limit: 5 })).view_token;
    await admin.query("UPDATE public.trial_balance_uploads SET file_name='invented-tb-renamed.csv' WHERE company_id=$1", [C1]);
    const t2 = (await list(U.owner, { limit: 5 })).view_token;
    const b0 = (await list(U.ownerB, { limit: 5 })).view_token;
    await admin.query("UPDATE public.companies SET name='Invented Other Tenant Renamed' WHERE id=$1", [B]);
    const t3 = (await list(U.owner, { limit: 5 })).view_token, b1 = (await list(U.ownerB, { limit: 5 })).view_token;
    return t0 === t1 && t2 !== t1 && t3 === t2 && b1 !== b0 ? true : { t0, t1, t2, t3, b0, b1 };
  });
  await check("a membership change (visibility) changes the member's token; a page sequence that crosses a change reports it", async () => {
    const before = (await list(U.member, { limit: 2 }));
    await memberOf(C1, U.member);
    const after = (await list(U.member, { limit: 2, cursor: before.next_cursor }));
    return before.view_token !== after.view_token && after.rows.length > 0 ? true : { before: before.view_token, after: after.view_token };
  });

  group("Account home — routing from EXACT server counts with bounded samples, never a truncated client list");
  const home = (uid, withheld = ["TAX_COMPUTATION", "COMPLIANCE_REVIEW", "FILING_PREPARATION", "MONITORING"], limit = null) =>
    asRole("authenticated", uid, "SELECT public.get_account_home($1,$2) r", [withheld, limit]).then((r) => r[0].r);
  await check("the owner: exact total of open engagements (130) with a bounded sample (50); nothing of the other tenant", async () => {
    const h = await home(U.owner);
    const ids = new Set(engagements.filter((e) => e.company !== B).map((e) => e.id));
    return h.outcome === "ok" && h.engagements.total === 130 && h.engagements.rows.length === 50 && h.engagements.rows.every((r) => ids.has(r.engagement_id))
      && h.companies_without_engagement.total === 0 && h.shared.total === 0 ? true : { total: h.engagements?.total, n: h.engagements?.rows?.length };
  });
  await check("an engagement whose every granted service is withheld is counted apart (never resumed); one with Trial balance review is not", async () => {
    const [wid, fid] = [engagements.find((e) => e.company === companiesA[5]).id, engagements.find((e) => e.company === companiesA[6]).id];
    const om = await ownerMember(companiesA[5]), om2 = await ownerMember(companiesA[6]);
    // Historical engagements (granted before withheld services were refused by 20261002100000): inserted as they exist.
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query("INSERT INTO public.engagement_mandate_events (engagement_id, capability, action, sequence_no, actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',1,$2)", [wid, om]);
      await admin.query("INSERT INTO public.engagement_mandate_events (engagement_id, capability, action, sequence_no, actor_member_id) VALUES ($1,'TAX_COMPUTATION','GRANT',1,$2),($1,'FINANCIAL_STATEMENTS','GRANT',2,$2)", [fid, om2]);
    } finally { await admin.query("SET session_replication_role = origin"); }
    const h = await home(U.owner);
    const row = (await list(U.owner, { search: "Invented Entity G", limit: 100 })).rows.find((r) => r.engagement_id === fid);
    return h.engagements.total === 129 && h.withheld.total === 1 && h.withheld.rows[0].engagement_id === wid
      && JSON.stringify(row?.services) === JSON.stringify(["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]) ? true : { e: h.engagements.total, w: h.withheld, row };
  });
  await check("a company with no open engagement, an accepted member's view, a grant holder's shared workspace, a stranger, and limits", async () => {
    const idle = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Invented Idle Ltd') RETURNING id", [U.owner])).id;
    // A fresh, unrevoked grant on another company (the earlier one was revoked above): it is a shared workspace, never own.
    const by = grantCol.find((c) => c === "granted_by_user_id" || c === "granted_by");
    await admin.query(`INSERT INTO public.workspace_capability_grants (company_id, grantee_user_id, capability${by ? `, ${by}` : ""}) VALUES ($1,$2,'prepare_trial_balance'${by ? ",$3" : ""})`,
      by ? [companiesA[2], U.grantee, U.owner] : [companiesA[2], U.grantee]);
    const o = await home(U.owner), mm = await home(U.member), g = await home(U.grantee), st = await home(U.stranger), bad = await home(U.owner, null, 101);
    await admin.query("UPDATE public.companies SET is_active=false WHERE id=$1", [idle]);
    return o.companies_without_engagement.total === 1 && o.companies_without_engagement.rows[0].id === idle
      && mm.engagements.rows.every((r) => [C0, C1].includes(r.company_id)) && mm.shared.total === 0
      && g.shared.total === 1 && g.shared.rows[0].id === companiesA[2] && g.engagements.total === 0 && st.engagements.total === 0 && st.shared.total === 0 && bad.code === "INVALID_LIMIT"
      ? true : { o: o.companies_without_engagement, mm: mm.engagements?.total, g: g.shared, st, bad };
  });

  group("Entities — the bounded list the upload page offers, under the same visibility");
  await check("the owner lists all 26 entities by name with the true total; a member only theirs; a stranger none; limits enforced", async () => {
    const ents = (uid, limit = null) => asRole("authenticated", uid, "SELECT public.list_portfolio_entities($1) r", [limit]).then((r) => r[0].r);
    const o = await ents(U.owner), mm = await ents(U.member), st = await ents(U.stranger), small = await ents(U.owner, 5), bad = await ents(U.owner, 501);
    const names = o.entities.map((e) => e.name);
    const sorted = [...names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    return o.outcome === "ok" && o.total === 26 && o.entities.length === 26 && JSON.stringify(names) === JSON.stringify(sorted)
      && !o.entities.some((e) => e.id === B) && mm.entities.every((e) => [C0, C1].includes(e.id)) && st.total === 0
      && small.entities.length === 5 && small.total === 26 && bad.code === "INVALID_LIMIT" ? true : { o: o.total, mm: mm.entities?.length, st, small: small.entities?.length, bad };
  });
  await check("anon cannot call the entity list", async () =>
    asRole("anon", null, "SELECT public.list_portfolio_entities(10)").then(() => "allowed", (e) => (/permission denied/.test(e.message) ? true : e.message)));

  group("Cost — measured on this data set (reported; a release check, not a latency guarantee)");
  await check(`a filtered first page and a full-status count over 130 engagements finish within ${BUDGET_MS} ms (median of 5)`, async () => {
    const times = [];
    for (let i = 0; i < 5; i++) { const t = Date.now(); await list(U.owner, { search: "invented", limit: 25 }); times.push(Date.now() - t); }
    times.sort((a, b) => a - b);
    console.log(`        median ${times[2]} ms; all ${times.join(", ")} ms`);
    return times[2] <= BUDGET_MS ? true : times;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => `${f.group} / ${f.name}`).join("; ")}` : ""}`);
  return failed.length === 0;
}

main().then(async (ok) => { await stopDatabase(); process.exit(ok ? 0 : 1); }, async (e) => { console.error(e); await stopDatabase(); process.exit(2); });
