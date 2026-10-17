#!/usr/bin/env bun
// Real-PostgreSQL proof of trial balance drafts (migration 20261106100000; Phase 2 §5.4, §5.10).
//
//   replay        the whole chain applies with the drafts migration; applying it again is refused by its preflight;
//   reserve       owner-scoped path drafts/<owner>/<draft>/<name>; 7-day retention from one definition; the same key and
//                 payload return the same draft (also 12 concurrent requests); the same key with another payload is
//                 refused; invalid input and anonymous callers get nothing;
//   isolation     another user's draft answers exactly like a missing one; no client reads the table or calls a service
//                 function; the bucket's client policies never admit a drafts/ path;
//   commit        begin → reserve (as the user) → record → register (as the user) → finish, each step idempotent and
//                 resumable; the company's authority is decided by the existing workspace functions, never by the draft;
//                 another user, another company and an expired draft are refused; a reservation that expired during a
//                 paused commit is replaced;
//   retention     the REAL sweeper orchestration removes an expired, a deleted and a committed draft's own drafts/ object
//                 exactly once; an unexpired draft and a commit in flight are untouched; an abandoned commit is settled;
//                 committed financial evidence (the workspace copy and its upload) is never touched.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/trialBalanceDrafts.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { runSourceSweep } from "../../supabase/functions/_shared/sourceSweeper.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const DRAFTS_FILE = "20261106100000_trial_balance_drafts.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();
const key = () => crypto.randomBytes(18).toString("base64url");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-drafts-proof-"));
  const port = 56000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise(); await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE drafts_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/drafts_proof`;
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
const asUserRows = (uid, sql, p) => asRole("authenticated", uid, sql, p);
const asService = async (sql, p) => (await asRole("service_role", null, sql, p))[0];
const one = async (sql, p = []) => (await admin.query(sql, p)).rows[0];
const count = async (sql, p = []) => Number((await one(sql, p)).n);

async function main() {
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

  group("Replay — the whole chain, drafts included");
  await check(`${DRAFTS_FILE} is in the chain and the whole chain applies`, async () => {
    if (!files.includes(DRAFTS_FILE)) return `${DRAFTS_FILE} missing`;
    for (const f of files) {
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await admin.query(t); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; }
    }
    return true;
  });
  await refused("applying the drafts migration again is refused by its preflight (nothing is replaced)", "P0001", () => admin.query(migrationSql(REPO, DRAFTS_FILE)), "PREFLIGHT_REFUSED");

  const U = { owner: uuid(), other: uuid(), ownerB: uuid(), control: uuid(), leaver: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const uid of [U.owner, U.ownerB, U.control]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  }
  const company = async (owner, name) => (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [owner, name])).id;
  const A = await company(U.owner, "Invented Trading A");
  const B = await company(U.ownerB, "Invented Trading B");

  const putObject = (p) => admin.query("INSERT INTO storage.objects (bucket_id, name) VALUES ('trial-balance-files', $1)", [p]);
  const objectExists = async (p) => (await count("SELECT count(*) n FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p])) === 1;
  const draftRow = (id) => one("SELECT * FROM public.trial_balance_drafts WHERE id=$1", [id]);
  const commitRows = async (draftId) => (await admin.query("SELECT * FROM public.trial_balance_draft_commits WHERE draft_id=$1 ORDER BY created_at", [draftId])).rows;
  const SHA = hash("invented trial balance bytes");
  const reserveDraft = (who, k, { name = "invented-tb.xlsx", size = 2048, sha = SHA } = {}) =>
    asUser(who, "SELECT * FROM public.reserve_trial_balance_draft($1,$2,$3,$4)", [name, size, sha, k]);
  const newDraft = async (who = U.owner, { put = true, sha = hash(uuid()) } = {}) => {
    const d = await reserveDraft(who, key(), { sha });
    if (d.outcome !== "reserved") throw new Error(`draft ${d.outcome}`);
    if (put) await putObject(d.object_path);
    return { ...d, sha };
  };
  const expireDraft = (id) => admin.query("UPDATE public.trial_balance_drafts SET expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
  const CONF = { entity: "Invented Trading A", period: "FY", currency: "TZS" };
  let year = 1960;
  const target = (companyId = A, over = {}) => ({ company: companyId, year: ++year, periodId: null, engagementId: null, confirmation: CONF, ...over });
  const begin = (draftId, who, k, t) => asService("SELECT * FROM public.tbd_begin_commit($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [draftId, who, k, t.company, t.year, t.periodId, t.engagementId, JSON.stringify(t.confirmation), t.replaces?.uploadId ?? null]);

  // The Edge Function's commit, step by step in the same order (supabase/functions/_shared/draftUpload.ts): service-role
  // bookkeeping; the workspace reservation and the registration AS THE USER. Storage is the bootstrap's storage.objects
  // table (presence only); real bytes, copy and hash are exercised on the local stack (scripts/e2e/draftJourney.mjs).
  const commit = async (d, who, t, { k = key(), stopAfter = null } = {}) => {
    const b = await begin(d.draft_id, who, k, t);
    if (!["started", "resume"].includes(b.outcome)) return { step: "begin", ...b, k };
    if (stopAfter === "begin") return { step: "begin", ...b, k };
    let reservationId = b.reservation_id;
    let res = reservationId ? await one("SELECT * FROM public.trial_balance_source_reservations WHERE id=$1", [reservationId]) : null;
    if (b.reservation_state !== "consumed") {
      if (!res || b.reservation_state !== "live") {
        const r = await asUser(who, "SELECT * FROM public.reserve_trial_balance_source($1,$2)", [t.company, b.file_name]);
        if (r.outcome !== "reserved") return { step: "reserve", ...r, k };
        const rec = await asService("SELECT public.tbd_record_commit_reservation($1,$2,$3) r", [b.commit_id, who, r.reservation_id]);
        if (!["recorded", "already_recorded"].includes(rec.r)) return { step: "record", outcome: rec.r, k };
        reservationId = r.reservation_id;
        res = await one("SELECT * FROM public.trial_balance_source_reservations WHERE id=$1", [reservationId]);
      }
      if (stopAfter === "record") return { step: "record", reservationId, commitId: b.commit_id, k };
      if (!(await objectExists(res.object_path))) await putObject(res.object_path); // the service-role Storage copy
      if (stopAfter === "copy") return { step: "copy", reservationId, commitId: b.commit_id, k };
      const v = await asService("SELECT public.tbd_record_copy_verified($1,$2,$3,$4) r", [b.commit_id, who, b.content_sha256, Number(b.file_size)]);
      if (!["verified", "already_verified"].includes(v.r)) return { step: "verify", outcome: v.r, k };
    }
    // A replacement registers through retire_trial_balance_upload (one transaction, or nothing); anything else registers.
    const g = t.replaces
      ? await asUser(who, "SELECT outcome::text AS outcome, new_upload_id AS upload_id, detail FROM public.retire_trial_balance_upload($1,$2,$3,$4,'Replaced from a draft')", [t.replaces.uploadId, t.replaces.expectedVersion, reservationId, Number(b.file_size)])
      : await asUser(who, "SELECT * FROM public.register_trial_balance_upload($1,$2,$3,$4,$5)", [reservationId, Number(b.file_size), t.year, t.periodId, t.engagementId]);
    if (!["registered", "already_registered", "replaced"].includes(g.outcome)) return { step: "register", ...g, commitId: b.commit_id, k };
    if (stopAfter === "register") return { step: "register", upload_id: g.upload_id, commitId: b.commit_id, k };
    const f = await asService("SELECT public.tbd_finish_commit($1,$2,$3) r", [b.commit_id, who, g.upload_id]);
    return { step: "finish", outcome: f.r, upload_id: g.upload_id, workspacePath: res.object_path, commitId: b.commit_id, k };
  };

  // ── Reserve ──────────────────────────────────────────────────────────────────────────────────────────────────────
  group("Reserve — bound to the owner and the file's identity; 7-day retention");
  let D1;
  const k1 = key();
  await check("reserved: path drafts/<owner>/<draft>/<safe name>; expires exactly trial_balance_draft_retention() = 7 days after creation", async () => {
    D1 = await reserveDraft(U.owner, k1, { name: "Invented TB 2025 (final).xlsx" });
    const r = await draftRow(D1.draft_id);
    const ret = await one("SELECT public.trial_balance_draft_retention()::text t");
    return D1.outcome === "reserved" && D1.object_path === `drafts/${U.owner}/${D1.draft_id}/Invented_TB_2025__final_.xlsx`
      && ret.t === "7 days" && new Date(r.expires_at) - new Date(r.created_at) === 7 * 86400000 && r.state === "reserved"
      && r.request_hash === (await one("SELECT public.tbd_reserve_hash($1,$2,$3,$4) h", [U.owner, "Invented TB 2025 (final).xlsx", 2048, SHA])).h ? true : { D1, r, ret };
  });
  await check("the same key and the same file: 'replayed', the same draft, nothing new", async () => {
    const r = await reserveDraft(U.owner, k1, { name: "Invented TB 2025 (final).xlsx" });
    return r.outcome === "replayed" && r.draft_id === D1.draft_id && (await count("SELECT count(*) n FROM public.trial_balance_drafts WHERE owner_ref=$1", [U.owner])) === 1 ? true : r;
  });
  await check("the same key with another file (content, size or name changed): 'conflict' each time, nothing written", async () => {
    const outs = [
      await reserveDraft(U.owner, k1, { name: "Invented TB 2025 (final).xlsx", sha: hash("other bytes") }),
      await reserveDraft(U.owner, k1, { name: "Invented TB 2025 (final).xlsx", size: 2049 }),
      await reserveDraft(U.owner, k1, { name: "renamed.xlsx" }),
    ];
    return outs.every((o) => o.outcome === "conflict" && o.draft_id === null) && (await count("SELECT count(*) n FROM public.trial_balance_drafts WHERE owner_ref=$1", [U.owner])) === 1 ? true : outs;
  });
  await check("a new key with the same file is a new, legitimate draft (keys are per submission), and another user's same key is theirs", async () => {
    const again = await reserveDraft(U.owner, key(), { name: "Invented TB 2025 (final).xlsx" });
    const other = await reserveDraft(U.other, k1, { name: "Invented TB 2025 (final).xlsx" });
    return again.outcome === "reserved" && again.draft_id !== D1.draft_id && other.outcome === "reserved" && other.object_path.startsWith(`drafts/${U.other}/`) ? true : { again, other };
  });
  await check("no entity is needed to reserve", async () => (await count("SELECT count(*) n FROM public.trial_balance_drafts d WHERE d.id=$1", [D1.draft_id])) === 1);
  await check("12 concurrent identical requests converge on one draft", async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 12 }, () => reserveDraft(U.owner, k)));
    return new Set(rs.map((r) => r.draft_id)).size === 1 && rs.filter((r) => r.outcome === "reserved").length === 1 ? true : rs.map((r) => r.outcome);
  });
  await check("invalid input (short key, bad hash, empty name, zero or over-limit size) is refused with nothing written", async () => {
    const before = await count("SELECT count(*) n FROM public.trial_balance_drafts");
    const outs = [
      await reserveDraft(U.owner, "short"), await reserveDraft(U.owner, key(), { sha: "not-a-hash" }),
      await reserveDraft(U.owner, key(), { name: "" }), await reserveDraft(U.owner, key(), { size: 0 }),
      await reserveDraft(U.owner, key(), { size: 52428801 }),
    ].map((r) => r.outcome);
    return outs.every((o) => o === "invalid_request") && (await count("SELECT count(*) n FROM public.trial_balance_drafts")) === before ? true : outs;
  });
  await check("a signed-in role with no (or an unknown) user identity is refused", async () => {
    const a = await asUser(null, "SELECT * FROM public.reserve_trial_balance_draft('a.csv',10,$1,$2)", [SHA, key()]);
    const b = await asUser(uuid(), "SELECT * FROM public.reserve_trial_balance_draft('a.csv',10,$1,$2)", [SHA, key()]);
    return a.outcome === "forbidden" && b.outcome === "forbidden" ? true : { a, b };
  });
  await refused("anonymous callers cannot reserve", "42501", () => asRole("anon", null, "SELECT * FROM public.reserve_trial_balance_draft('a.csv',10,$1,$2)", [SHA, key()]));
  await refused("what a draft is bound to never changes (even for the service role)", "42501",
    () => asRole("service_role", null, "UPDATE public.trial_balance_drafts SET content_sha256=$2 WHERE id=$1", [D1.draft_id, hash("x")]), "DRAFT_BINDING_IMMUTABLE");

  // ── Isolation ────────────────────────────────────────────────────────────────────────────────────────────────────
  group("Isolation — owner only");
  await check("the owner reads their draft (stored = whether the object is there, as the server sees it) and lists it", async () => {
    const before = await asUser(U.owner, "SELECT * FROM public.get_trial_balance_draft($1)", [D1.draft_id]);
    await putObject(D1.object_path);
    const after = await asUser(U.owner, "SELECT * FROM public.get_trial_balance_draft($1)", [D1.draft_id]);
    const list = await asUserRows(U.owner, "SELECT * FROM public.list_trial_balance_drafts()");
    return before.stored === false && after.stored === true && after.file_name === "Invented TB 2025 (final).xlsx" && list.some((l) => l.draft_id === D1.draft_id) ? true : { before, after };
  });
  await check("another user: reading answers no row, listing shows none of it, deleting answers 'not_found'", async () => {
    const g = await asUserRows(U.other, "SELECT * FROM public.get_trial_balance_draft($1)", [D1.draft_id]);
    const l = await asUserRows(U.other, "SELECT * FROM public.list_trial_balance_drafts()");
    const d = await asUser(U.other, "SELECT public.delete_trial_balance_draft($1) r", [D1.draft_id]);
    return g.length === 0 && !l.some((x) => x.draft_id === D1.draft_id) && d.r === "not_found" && (await draftRow(D1.draft_id)).state === "reserved" ? true : { g, d };
  });
  for (const role of ["authenticated", "anon"]) {
    for (const t of ["trial_balance_drafts", "trial_balance_draft_commits"]) {
      await refused(`${role} cannot read ${t} directly`, "42501", () => asRole(role, U.owner, `SELECT * FROM public.${t}`));
    }
  }
  for (const [fn, args] of [["tbd_sign_target($1,$2)", 2], ["tbd_begin_commit($1,$2,'k',$1,2000,NULL,NULL,'{}',NULL)", 2], ["tbd_record_commit_reservation($1,$2,$1)", 2],
    ["tbd_record_copy_verified($1,$2,'x',1)", 2], ["tbd_finish_commit($1,$2,$1)", 2], ["tbd_cancel_commit($1,$2)", 2], ["tbd_reject_draft($1,$2)", 2], ["tbd_commit_abandoned($1)", 1]]) {
    await refused(`a signed-in user cannot call ${fn.split("(")[0]} (service role only)`, "42501",
      () => asRole("authenticated", U.owner, `SELECT public.${fn}`, args === 2 ? [D1.draft_id, U.owner] : [D1.draft_id]));
  }
  await check("the bucket's client policies never admit a drafts/ path (their first folder must be the caller's own id)", async () => {
    const pols = (await admin.query("SELECT polname, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) w FROM pg_policy WHERE polrelid='storage.objects'::regclass")).rows
      .filter((p) => `${p.q ?? ""}${p.w ?? ""}`.includes("trial-balance-files"));
    const evaluated = (await one("SELECT (storage.foldername($1))[1] = $2 AS admitted", [D1.object_path, U.owner])).admitted;
    return pols.length >= 4 && pols.every((p) => /foldername\(name\)\)\[1\] = \(?auth\.uid\(\)/.test(`${p.q ?? ""}${p.w ?? ""}`)) && evaluated === false ? true : { pols, evaluated };
  });
  await check("signing: only the owner's own reserved, unexpired draft is signable; another user gets no row", async () => {
    const own = await asService("SELECT * FROM public.tbd_sign_target($1,$2)", [D1.draft_id, U.owner]);
    const other = await asRole("service_role", null, "SELECT * FROM public.tbd_sign_target($1,$2)", [D1.draft_id, U.other]);
    return own.signable === true && own.stored === true && own.object_path === D1.object_path && other.length === 0 ? true : { own, other };
  });

  // ── Commit idempotency ───────────────────────────────────────────────────────────────────────────────────────────
  group("Commit — bound to draft, content, entity, period and confirmed context");
  let C1, T1;
  await check("commit: the upload is registered from a workspace reservation; the commit and the draft are bound to exactly that upload", async () => {
    T1 = target(A);
    C1 = await commit({ ...D1 }, U.owner, T1);
    const d = await draftRow(D1.draft_id);
    const [c] = await commitRows(D1.draft_id);
    const u = await one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [C1.upload_id]);
    const bound = (await one("SELECT public.tbu_upload_source_bound($1) b", [C1.upload_id])).b;
    return C1.outcome === "committed" && d.state === "committed" && d.committed_upload_id === C1.upload_id && c.state === "committed" && c.upload_id === C1.upload_id
      && c.copy_verified_at && u.company_id === A && u.period_year === T1.year && u.file_path === C1.workspacePath && u.file_path.startsWith(`workspaces/${A}/`) && u.user_id === U.owner && bound ? true : { C1, d, c, u, bound };
  });
  await check("the same key and inputs after it finished: 'already_committed' with the same upload; nothing new", async () => {
    const n = await count("SELECT count(*) n FROM public.trial_balance_uploads");
    const again = await begin(D1.draft_id, U.owner, C1.k, T1);
    return again.outcome === "already_committed" && again.upload_id === C1.upload_id && (await count("SELECT count(*) n FROM public.trial_balance_uploads")) === n ? true : again;
  });
  await check("the same key with changed inputs (period, entity, engagement or any confirmed field) is a conflict", async () => {
    const outs = [];
    for (const t of [{ ...T1, year: T1.year + 1 }, { ...T1, company: B }, { ...T1, engagementId: uuid() }, { ...T1, confirmation: { ...CONF, currency: "USD" } }, { ...T1, confirmation: { ...CONF, entity: "Someone Else Ltd" } }]) {
      outs.push((await begin(D1.draft_id, U.owner, C1.k, t)).outcome);
    }
    return outs.every((o) => o === "conflict") ? true : outs;
  });
  await check("a different key with the same inputs replays the same commit; with other inputs it is a conflict (a draft is committed once)", async () => {
    const same = await begin(D1.draft_id, U.owner, key(), T1);
    const other = await begin(D1.draft_id, U.owner, key(), { ...T1, year: T1.year + 5 });
    return same.outcome === "already_committed" && same.commit_id === C1.commitId && other.outcome === "conflict" && (await commitRows(D1.draft_id)).length === 1 ? true : { same, other };
  });
  await check("a key used for one draft is a conflict on another draft", async () => {
    const d2 = await newDraft();
    const r = await begin(d2.draft_id, U.owner, C1.k, T1);
    return r.outcome === "conflict" && (await commitRows(d2.draft_id)).length === 0 ? true : r;
  });
  await check("12 concurrent begins with one key converge on one commit", async () => {
    const d = await newDraft(); const t = target(A); const k = key();
    const rs = await Promise.all(Array.from({ length: 12 }, () => begin(d.draft_id, U.owner, k, t)));
    return new Set(rs.map((r) => r.commit_id)).size === 1 && rs.filter((r) => r.outcome === "started").length === 1 && (await commitRows(d.draft_id)).length === 1 ? true : rs.map((r) => r.outcome);
  });
  await check("invalid commit inputs are refused: a confirmation missing a field or with an extra one, an out-of-range year, a short key", async () => {
    const d = await newDraft();
    const outs = [
      await begin(d.draft_id, U.owner, key(), target(A, { confirmation: { entity: "X", period: "P" } })),
      await begin(d.draft_id, U.owner, key(), target(A, { confirmation: { ...CONF, framework: "IFRS" } })),
      await begin(d.draft_id, U.owner, key(), target(A, { year: 99 })),
      await begin(d.draft_id, U.owner, "short", target(A)),
    ].map((r) => r.outcome);
    return outs.every((o) => o === "invalid_request") && (await commitRows(d.draft_id)).length === 0 ? true : outs;
  });
  await refused("what a commit is bound to never changes (even for the service role)", "42501",
    () => asRole("service_role", null, "UPDATE public.trial_balance_draft_commits SET period_year = period_year + 1 WHERE draft_id=$1", [D1.draft_id]), "DRAFT_COMMIT_BINDING_IMMUTABLE");
  await refused("the upload a commit replaces is part of its binding and never changes", "42501",
    () => asRole("service_role", null, "UPDATE public.trial_balance_draft_commits SET replaces_upload_id = $2 WHERE draft_id=$1", [D1.draft_id, uuid()]), "DRAFT_COMMIT_BINDING_IMMUTABLE");

  // ── Commit recovery ──────────────────────────────────────────────────────────────────────────────────────────────
  group("Commit — every interruption resumes; nothing is consumed or registered twice");
  await check("stopped after begin, after the reservation, after the copy, and after registration: each retry finishes with one upload", async () => {
    const out = [];
    for (const stop of ["begin", "record", "copy", "register"]) {
      const d = await newDraft(); const t = target(A);
      const first = await commit(d, U.owner, t, { stopAfter: stop });
      const n = await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [A]);
      const done = await commit(d, U.owner, t, { k: first.k });
      const after = await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [A]);
      const res = await count("SELECT count(*) n FROM public.trial_balance_source_reservations r JOIN public.trial_balance_draft_commits c ON c.reservation_id = r.id WHERE c.draft_id=$1", [d.draft_id]);
      out.push({ stop, done: done.outcome, added: after - n, res });
    }
    return out.every((o) => o.done === "committed" && o.res === 1) && out[3].added === 0 && out.slice(0, 3).every((o) => o.added === 1) ? true : out;
  });
  await check("registration succeeded but the answer was lost: begin reports the reservation consumed; the retry registers nothing new", async () => {
    const d = await newDraft(); const t = target(A);
    const first = await commit(d, U.owner, t, { stopAfter: "register" });
    const b = await begin(d.draft_id, U.owner, first.k, t);
    const n = await count("SELECT count(*) n FROM public.trial_balance_uploads");
    const done = await commit(d, U.owner, t, { k: first.k });
    return b.reservation_state === "consumed" && done.outcome === "committed" && done.upload_id === first.upload_id && (await count("SELECT count(*) n FROM public.trial_balance_uploads")) === n ? true : { b, done };
  });
  await check("a reservation that expired while the commit was paused is replaced (and the copy re-verified); the expired one is never consumed", async () => {
    const d = await newDraft(); const t = target(A);
    const r1 = await commit(d, U.owner, t, { stopAfter: "copy" });
    await admin.query("UPDATE public.trial_balance_source_reservations SET expires_at = now() - interval '1 minute' WHERE id=$1", [r1.reservationId]);
    const b = await begin(d.draft_id, U.owner, r1.k, t);
    const done = await commit(d, U.owner, t, { k: r1.k });
    const [c] = await commitRows(d.draft_id);
    const old = await one("SELECT consumed_at FROM public.trial_balance_source_reservations WHERE id=$1", [r1.reservationId]);
    return b.reservation_state === "expired" && done.outcome === "committed" && c.reservation_id !== r1.reservationId && old.consumed_at === null ? true : { b, done, c, old };
  });
  await check("a live recorded reservation cannot be swapped for another (conflict)", async () => {
    const d = await newDraft(); const t = target(A);
    const r1 = await commit(d, U.owner, t, { stopAfter: "record" });
    const r2 = await asUser(U.owner, "SELECT * FROM public.reserve_trial_balance_source($1,$2)", [A, "invented-tb.xlsx"]);
    const rec = await asService("SELECT public.tbd_record_commit_reservation($1,$2,$3) r", [r1.commitId, U.owner, r2.reservation_id]);
    return rec.r === "conflict" ? true : rec;
  });
  await check("the copy must be recorded as verified, with the draft's exact hash and size, before a commit can finish", async () => {
    const d = await newDraft(); const t = target(A);
    const r1 = await commit(d, U.owner, t, { stopAfter: "copy" });
    const wrongSha = await asService("SELECT public.tbd_record_copy_verified($1,$2,$3,$4) r", [r1.commitId, U.owner, hash("tampered"), 2048]);
    const wrongSize = await asService("SELECT public.tbd_record_copy_verified($1,$2,$3,$4) r", [r1.commitId, U.owner, d.sha, 2047]);
    // Registered by the user directly (they hold the reservation), but never verified: finish refuses.
    const g = await asUser(U.owner, "SELECT * FROM public.register_trial_balance_upload($1,2048,$2,NULL,NULL)", [r1.reservationId, t.year]);
    const f = await asService("SELECT public.tbd_finish_commit($1,$2,$3) r", [r1.commitId, U.owner, g.upload_id]);
    return wrongSha.r === "mismatch" && wrongSize.r === "mismatch" && f.r === "not_verified" && (await draftRow(d.draft_id)).state === "committing" ? true : { wrongSha, wrongSize, f };
  });
  await check("finish refuses an upload that did not come from this commit's reservation (mismatch)", async () => {
    const d = await newDraft(); const t = target(A);
    const r1 = await commit(d, U.owner, t, { stopAfter: "copy" });
    await asService("SELECT public.tbd_record_copy_verified($1,$2,$3,2048) r", [r1.commitId, U.owner, d.sha]);
    const f = await asService("SELECT public.tbd_finish_commit($1,$2,$3) r", [r1.commitId, U.owner, C1.upload_id]);
    return f.r === "mismatch" && (await draftRow(d.draft_id)).state === "committing" ? true : f;
  });

  group("Commit — cancel, reject and refusals");
  await check("the period already has an active trial balance: registration refuses; the commit is cancelled; a new key commits the draft to another period", async () => {
    const d = await newDraft(); const t = { ...target(A), year: T1.year };
    const r = await commit(d, U.owner, t);
    const cancel = await asService("SELECT public.tbd_cancel_commit($1,$2) r", [r.commitId, U.owner]);
    const respent = await begin(d.draft_id, U.owner, r.k, t);
    const ok = await commit(d, U.owner, target(A));
    const rows = await commitRows(d.draft_id);
    return r.step === "register" && r.outcome === "active_upload_exists" && cancel.r === "cancelled" && respent.outcome === "not_eligible"
      && ok.outcome === "committed" && rows.map((x) => x.state).join() === "cancelled,committed" ? true : { r, cancel, respent, ok, rows };
  });
  await check("replace the period's active trial balance with a draft: through retire, the old one superseded (kept as history), the new one active and bound; the commit binds the replaced upload", async () => {
    const d = await newDraft(); const t = { ...target(A), year: T1.year };
    const old = await one("SELECT id, version FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=$2 AND lifecycle_state IN ('active_unprocessed','active_processing','active_processed','blocked')", [A, t.year]);
    const r = await commit(d, U.owner, { ...t, replaces: { uploadId: old.id, expectedVersion: Number(old.version) } });
    const o = await one("SELECT lifecycle_state, superseded_by_upload_id FROM public.trial_balance_uploads WHERE id=$1", [old.id]);
    const n = await one("SELECT lifecycle_state, replaces_upload_id FROM public.trial_balance_uploads WHERE id=$1", [r.upload_id]);
    const [c] = await commitRows(d.draft_id);
    const bound = (await one("SELECT public.tbu_upload_source_bound($1) b", [r.upload_id])).b;
    return r.outcome === "committed" && o.lifecycle_state === "superseded" && o.superseded_by_upload_id === r.upload_id
      && n.replaces_upload_id === old.id && n.lifecycle_state === "active_unprocessed" && c.replaces_upload_id === old.id && bound ? true : { r, o, n, c, bound };
  });
  await check("a replacement at a stale version is refused by retire; the current trial balance stays active and nothing is registered", async () => {
    const d = await newDraft(); const t = { ...target(A), year: T1.year };
    const cur = await one("SELECT id, version FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=$2 AND lifecycle_state IN ('active_unprocessed','active_processing','active_processed','blocked')", [A, t.year]);
    const n = await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [A]);
    const r = await commit(d, U.owner, { ...t, replaces: { uploadId: cur.id, expectedVersion: Number(cur.version) - 1 } });
    const after = await one("SELECT lifecycle_state FROM public.trial_balance_uploads WHERE id=$1", [cur.id]);
    return r.step === "register" && r.outcome === "stale_version" && after.lifecycle_state === "active_unprocessed"
      && (await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [A])) === n ? true : { r, after };
  });
  await check("the replaced upload is part of the commit's binding: the same key replacing another upload is a conflict; finish refuses an upload that is not that replacement", async () => {
    const d = await newDraft(); const t = { ...target(A), year: T1.year };
    const k = key();
    const b1 = await begin(d.draft_id, U.owner, k, { ...t, replaces: { uploadId: uuid() } });
    const b2 = await begin(d.draft_id, U.owner, k, { ...t, replaces: { uploadId: uuid() } });
    const plain = await begin(d.draft_id, U.owner, k, t);
    const f = await asService("SELECT public.tbd_finish_commit($1,$2,$3) r", [b1.commit_id, U.owner, C1.upload_id]);
    return b1.outcome === "started" && b2.outcome === "conflict" && plain.outcome === "conflict" && ["mismatch", "not_found"].includes(f.r) ? true : { b1: b1.outcome, b2: b2.outcome, plain: plain.outcome, f };
  });
  await check("a registered commit can never be cancelled", async () => {
    const c = await asService("SELECT public.tbd_cancel_commit($1,$2) r", [C1.commitId, U.owner]);
    return c.r === "not_eligible" ? true : c;
  });
  await check("a draft whose stored bytes do not match: rejected, never committable, never deletable by its owner as a reservation", async () => {
    const d = await newDraft();
    const r = await asService("SELECT public.tbd_reject_draft($1,$2) r", [d.draft_id, U.owner]);
    const b = await begin(d.draft_id, U.owner, key(), target(A));
    const row = await draftRow(d.draft_id);
    return r.r === "rejected" && b.outcome === "not_eligible" && row.state === "rejected" && row.rejected_reason === "content_mismatch" ? true : { r, b, row };
  });
  await check("another user cannot begin, cancel, record, verify, finish or reject anything of the owner's (not_found)", async () => {
    const d = await newDraft(); const t = target(A);
    const r1 = await commit(d, U.owner, t, { stopAfter: "record" });
    const outs = [
      (await begin(d.draft_id, U.ownerB, key(), target(B))).outcome,
      (await asService("SELECT public.tbd_cancel_commit($1,$2) r", [r1.commitId, U.ownerB])).r,
      (await asService("SELECT public.tbd_record_copy_verified($1,$2,$3,2048) r", [r1.commitId, U.ownerB, d.sha])).r,
      (await asService("SELECT public.tbd_finish_commit($1,$2,$3) r", [r1.commitId, U.ownerB, C1.upload_id])).r,
      (await asService("SELECT public.tbd_reject_draft($1,$2) r", [d.draft_id, U.ownerB])).r,
    ];
    return outs.every((o) => o === "not_found") && (await draftRow(d.draft_id)).state === "committing" ? true : outs;
  });
  await check("committing into an entity the user has no authority over: the workspace reservation refuses; nothing in that entity", async () => {
    const d = await newDraft();
    const before = await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [B]);
    const r = await commit(d, U.owner, target(B));
    return r.step === "reserve" && r.outcome === "forbidden" && (await count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [B])) === before ? true : r;
  });
  await check("a reservation of another user or another entity cannot be recorded on a commit", async () => {
    const d = await newDraft();
    const b = await begin(d.draft_id, U.owner, key(), target(A));
    const bRes = await asUser(U.ownerB, "SELECT * FROM public.reserve_trial_balance_source($1,'invented-tb.xlsx')", [B]);
    const rec = await asService("SELECT public.tbd_record_commit_reservation($1,$2,$3) r", [b.commit_id, U.owner, bRes.reservation_id]);
    return rec.r === "conflict" ? true : rec;
  });
  await check("an expired draft: read as 'expired', not signable, and cannot be committed", async () => {
    const d = await newDraft(); await expireDraft(d.draft_id);
    const g = await asUser(U.owner, "SELECT * FROM public.get_trial_balance_draft($1)", [d.draft_id]);
    const s = await asService("SELECT * FROM public.tbd_sign_target($1,$2)", [d.draft_id, U.owner]);
    const b = await begin(d.draft_id, U.owner, key(), target(A));
    return g.state === "expired" && s.signable === false && b.outcome === "expired" ? true : { g, s, b };
  });
  await check("a draft whose file never arrived cannot be committed (object_missing)", async () => {
    const d = await newDraft(U.owner, { put: false });
    const b = await begin(d.draft_id, U.owner, key(), target(A));
    return b.outcome === "object_missing" && (await draftRow(d.draft_id)).state === "reserved" && (await commitRows(d.draft_id)).length === 0 ? true : b;
  });
  await check("the owner deletes a draft: 'deleted', then 'already_deleted'; it can no longer be committed; a committed one is not deletable", async () => {
    const d = await newDraft();
    const a = await asUser(U.owner, "SELECT public.delete_trial_balance_draft($1) r", [d.draft_id]);
    const b = await asUser(U.owner, "SELECT public.delete_trial_balance_draft($1) r", [d.draft_id]);
    const c = await begin(d.draft_id, U.owner, key(), target(A));
    const committed = await asUser(U.owner, "SELECT public.delete_trial_balance_draft($1) r", [D1.draft_id]);
    return a.r === "deleted" && b.r === "already_deleted" && c.outcome === "not_eligible" && committed.r === "not_eligible" ? true : { a, b, c, committed };
  });

  // ── Existing lifecycle paths, unchanged by drafts ────────────────────────────────────────────────────────────────
  group("Existing lifecycle — discard, restore, replace and deletion behave exactly as for an upload without a draft");
  // A control entity whose uploads never came from a draft: every path is run on both and the outcomes compared.
  const CTRL = await company(U.control, "Invented Control Ltd");
  const directUpload = async (who, co, y) => {
    const r = await asUser(who, "SELECT * FROM public.reserve_trial_balance_source($1,'invented-tb.xlsx')", [co]);
    await putObject(r.object_path);
    const g = await asUser(who, "SELECT * FROM public.register_trial_balance_upload($1,2048,$2,NULL,NULL)", [r.reservation_id, y]);
    return g.upload_id;
  };
  const uploadRow = (id) => one("SELECT * FROM public.trial_balance_uploads WHERE id=$1", [id]);
  const discard = async (who, id) => { const u = await uploadRow(id); return asUser(who, "SELECT * FROM public.discard_trial_balance_upload($1,$2)", [id, Number(u.version)]); };
  const shape = (r) => JSON.stringify(Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => ["outcome"].includes(k))));
  let fromDraft, ctrlUpload, lifecycle;
  await check("discard → complete → restore: identical outcomes for an upload from a draft and one without; the draft and commit rows are unchanged", async () => {
    const d = await newDraft(); const t = target(A);
    fromDraft = (await commit(d, U.owner, t)).upload_id;
    ctrlUpload = await directUpload(U.control, CTRL, t.year);
    const before = JSON.stringify([await draftRow(d.draft_id), await commitRows(d.draft_id)]);
    const out = {};
    for (const [label, who, id] of [["draft", U.owner, fromDraft], ["control", U.control, ctrlUpload]]) {
      const b = await discard(who, id);
      const c = await asUser(who, "SELECT * FROM public.complete_trial_balance_discard($1)", [b.operation_id]);
      const r = await asUser(who, "SELECT * FROM public.restore_trial_balance_upload($1)", [b.operation_id]);
      out[label] = [shape(b), shape(c), shape(r), (await uploadRow(id)).status, await one("SELECT public.tbu_upload_source_bound($1) b", [id]).then((x) => x.b)];
    }
    lifecycle = d;
    return JSON.stringify(out.draft) === JSON.stringify(out.control) && JSON.stringify([await draftRow(d.draft_id), await commitRows(d.draft_id)]) === before ? true : { out };
  });
  await check("replace (retire with a new reservation): identical outcomes; the draft keeps pointing at the superseded upload as history; the new upload is the active, bound one", async () => {
    const out = {};
    for (const [label, who, co, id] of [["draft", U.owner, A, fromDraft], ["control", U.control, CTRL, ctrlUpload]]) {
      const rep = await asUser(who, "SELECT * FROM public.reserve_trial_balance_source($1,'replacement.xlsx')", [co]);
      await putObject(rep.object_path);
      const u = await uploadRow(id);
      const r = await asUser(who, "SELECT * FROM public.retire_trial_balance_upload($1,$2,$3,2048,'proof')", [id, Number(u.version), rep.reservation_id]);
      const n = await uploadRow(r.new_upload_id);
      out[label] = [shape(r), (await uploadRow(id)).status, n.status, (await one("SELECT public.tbu_upload_source_bound($1) b", [n.id])).b];
    }
    const d = await draftRow(lifecycle.draft_id);
    return JSON.stringify(out.draft) === JSON.stringify(out.control) && d.committed_upload_id === fromDraft && d.state === "committed" ? true : { out, d };
  });
  await check("lifecycle history (append-only events) is never removed by any draft operation or sweep", async () => {
    const ids = (await admin.query("SELECT id FROM public.trial_balance_upload_lifecycle_events ORDER BY id")).rows.map((r) => r.id);
    lifecycle.events = ids;
    return ids.length > 0;
  });
  await check("deleting an entity: the same outcome with and without draft history; draft history is kept with the entity reference cleared", async () => {
    // Fresh, minimal entities so the comparison is only about the draft history.
    const withDraft = await company(U.owner, "Invented Deletable With Draft");
    const without = await company(U.owner, "Invented Deletable Without");
    const d = await newDraft();
    await begin(d.draft_id, U.owner, key(), target(withDraft));
    const del = async (id) => { try { await admin.query("DELETE FROM public.companies WHERE id=$1", [id]); return "deleted"; } catch (e) { return e.code; } };
    const a = await del(withDraft), b = await del(without);
    const [c] = await commitRows(d.draft_id);
    return a === b && (a !== "deleted" || (c && c.company_id === null && c.target_company_ref === withDraft)) ? true : { a, b, c };
  });
  await check("removing a user account: never blocked by drafts; the draft becomes unreachable (owner link cleared) and is swept", async () => {
    const d = await reserveDraft(U.leaver, key());
    await putObject(d.object_path);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [U.leaver]);
    const r = await draftRow(d.draft_id);
    const cand = await asRole("service_role", null, "SELECT * FROM public.tbu_sweeper_candidates(500) WHERE target_id=$1", [d.draft_id]);
    lifecycle.leaver = d;
    return r.owner_user_id === null && r.owner_ref === U.leaver && cand.length === 1 && cand[0].delete_object === true ? true : { r, cand };
  });

  // ── Retention ────────────────────────────────────────────────────────────────────────────────────────────────────
  group("Retention — the scheduled sweeper (real orchestration); committed evidence untouched");
  const deletions = [];
  const sweepDeps = {
    redeemTicket: async () => true,
    listCandidates: async (n) => asRole("service_role", null, "SELECT * FROM public.tbu_sweeper_candidates($1)", [n]),
    claim: async (k, id) => (await asService("SELECT public.tbu_sweeper_claim($1,$2) r", [k, id])).r === "claimed",
    removeObject: async (p) => { const r = await admin.query("DELETE FROM storage.objects WHERE bucket_id='trial-balance-files' AND name=$1", [p]); if (r.rowCount) deletions.push(p); return true; },
    objectExists: async (p) => objectExists(p),
    complete: async (k, id) => (await asService("SELECT public.tbu_sweeper_complete($1,$2) r", [k, id])).r,
  };
  const sweep = () => runSourceSweep(sweepDeps, "a".repeat(64));
  const boundUploads = async () => JSON.stringify((await admin.query("SELECT id, file_path, status FROM public.trial_balance_uploads WHERE status <> 'discarded' AND public.tbu_upload_source_bound(id) ORDER BY id")).rows);
  const boundObjects = async () => (await admin.query("SELECT o.name FROM storage.objects o WHERE EXISTS (SELECT 1 FROM public.trial_balance_uploads t WHERE t.file_path = o.name AND public.tbu_upload_source_bound(t.id)) ORDER BY 1")).rows.map((r) => r.name).join("|");

  const evidenceBefore = await boundObjects();
  const uploadsBefore = await boundUploads();
  await check("the committed draft's own drafts/ copy is removed once; its upload's workspace file is untouched", async () => {
    deletions.length = 0; await sweep(); await sweep();
    const d = await draftRow(D1.draft_id);
    return deletions.filter((p) => p === D1.object_path).length === 1 && !(await objectExists(D1.object_path))
      && (await objectExists(C1.workspacePath)) && d.state === "committed" && d.swept_at !== null ? true : { deletions, d };
  });
  await check("every object a bound upload references is still there, every bound upload is unchanged, and only drafts/ objects were deleted", async () =>
    deletions.every((p) => p.startsWith("drafts/")) && (await boundObjects()) === evidenceBefore && (await boundUploads()) === uploadsBefore ? true : deletions);
  await check("lifecycle history is intact after the sweeps", async () => {
    const ids = (await admin.query("SELECT id FROM public.trial_balance_upload_lifecycle_events WHERE id = ANY($1)", [lifecycle.events])).rows;
    return ids.length === lifecycle.events.length;
  });
  await check("the removed account's draft object was removed", async () => !(await objectExists(lifecycle.leaver.object_path)) && (await draftRow(lifecycle.leaver.draft_id)).swept_at !== null);
  await check("a rejected draft's object is removed on the next sweep", async () => {
    const d = await newDraft();
    await asService("SELECT public.tbd_reject_draft($1,$2) r", [d.draft_id, U.owner]);
    deletions.length = 0; await sweep();
    return deletions.includes(d.object_path) && (await draftRow(d.draft_id)).swept_at !== null ? true : deletions;
  });
  await check("an unconfirmed draft inside its 7 days is untouched", async () => {
    const d = await newDraft();
    deletions.length = 0; await sweep();
    return deletions.length === 0 && (await objectExists(d.object_path)) && (await draftRow(d.draft_id)).state === "reserved" ? true : deletions;
  });
  await check("past 7 days: removed exactly once (two concurrent sweeps); the draft is 'expired' and swept; its row is kept", async () => {
    const d = await newDraft(); await expireDraft(d.draft_id);
    deletions.length = 0; await Promise.all([sweep(), sweep()]); await sweep();
    const r = await draftRow(d.draft_id);
    return deletions.filter((p) => p === d.object_path).length === 1 && r.state === "expired" && r.swept_at !== null && !(await objectExists(d.object_path)) ? true : { deletions, r };
  });
  await check("cleanup racing a commit at the moment of expiry: either the commit began first (then the draft is untouched) or the sweep expired it first (then begin answers 'expired'); never both", async () => {
    const out = [];
    for (let i = 0; i < 10; i++) {
      const d = await newDraft(); const t = target(A);
      await admin.query("UPDATE public.trial_balance_drafts SET expires_at = now() + interval '150 milliseconds' WHERE id=$1", [d.draft_id]);
      await new Promise((r) => setTimeout(r, 150));
      deletions.length = 0;
      const [b] = await Promise.all([begin(d.draft_id, U.owner, key(), t), sweep()]);
      await sweep();
      const row = await draftRow(d.draft_id);
      const gone = !(await objectExists(d.object_path));
      out.push({ b: b.outcome, state: row.state, gone });
    }
    // started → committing, object kept (the commit is in flight); expired → swept, object gone. Nothing in between.
    return out.every((o) => (o.b === "started" && o.state === "committing" && !o.gone) || (o.b === "expired" && o.state === "expired" && o.gone)) ? true : out;
  });
  await check("a deleted draft's object is removed on the next sweep, inside its 7 days", async () => {
    const d = await newDraft();
    await asUser(U.owner, "SELECT public.delete_trial_balance_draft($1) r", [d.draft_id]);
    deletions.length = 0; await sweep();
    const r = await draftRow(d.draft_id);
    return deletions.includes(d.object_path) && r.state === "deleted" && r.swept_at !== null ? true : { deletions, r };
  });
  await check("an expired draft whose file never arrived is settled with nothing deleted", async () => {
    const d = await newDraft(U.owner, { put: false }); await expireDraft(d.draft_id);
    deletions.length = 0; await sweep();
    const r = await draftRow(d.draft_id);
    return deletions.length === 0 && r.state === "expired" && r.swept_at !== null ? true : { deletions, r };
  });
  await check("a commit in flight (live workspace reservation) is never touched, even past 7 days", async () => {
    const d = await newDraft();
    await commit(d, U.owner, target(A), { stopAfter: "record" }); await expireDraft(d.draft_id);
    deletions.length = 0; await sweep();
    const r = await draftRow(d.draft_id);
    const claim = await asService("SELECT public.tbu_sweeper_claim('draft',$1) r", [d.draft_id]);
    return deletions.length === 0 && r.state === "committing" && r.swept_at === null && claim.r === "not_eligible" && (await objectExists(d.object_path)) ? true : { deletions, r, claim };
  });
  await check("an abandoned commit past 7 days: registered → settled as committed to that upload; never registered → cancelled and expired; both drafts/ copies removed", async () => {
    const reg = await newDraft(); const regStop = await commit(reg, U.owner, target(A), { stopAfter: "register" });
    const nev = await newDraft(); await begin(nev.draft_id, U.owner, key(), target(A));
    await expireDraft(reg.draft_id); await expireDraft(nev.draft_id);
    deletions.length = 0; await sweep();
    const a = await draftRow(reg.draft_id), b = await draftRow(nev.draft_id);
    const [ca] = await commitRows(reg.draft_id), [cb] = await commitRows(nev.draft_id);
    return a.state === "committed" && a.committed_upload_id === regStop.upload_id && ca.state === "committed" && ca.upload_id === regStop.upload_id
      && b.state === "expired" && cb.state === "cancelled" && deletions.includes(reg.object_path) && deletions.includes(nev.object_path) ? true : { a, b, ca, cb, deletions };
  });
  await check("repeated cleanup is a no-op: further sweeps delete nothing and change no row", async () => {
    await sweep();
    const snap = JSON.stringify((await admin.query("SELECT id, state, swept_at FROM public.trial_balance_drafts ORDER BY id")).rows);
    deletions.length = 0; await sweep(); await sweep();
    return deletions.length === 0 && JSON.stringify((await admin.query("SELECT id, state, swept_at FROM public.trial_balance_drafts ORDER BY id")).rows) === snap ? true : deletions;
  });
  await check("committed evidence never lives at a draft path: a drafts/ path can never be a bound upload source, while the committed upload is bound to its workspace copy", async () => {
    const d = await newDraft();
    await admin.query("SET session_replication_role = replica");
    let forged;
    try {
      forged = (await one("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,user_id,company_id,period_year) VALUES ('x',$1,1,'processing',$2,$3,1900) RETURNING id", [d.object_path, U.owner, A])).id;
    } finally { await admin.query("SET session_replication_role = origin"); }
    const forgedBound = (await one("SELECT public.tbu_upload_source_bound($1) b", [forged])).b;
    const committedBound = (await one("SELECT public.tbu_upload_source_bound($1) b", [C1.upload_id])).b;
    await admin.query("SET session_replication_role = replica");
    try { await admin.query("DELETE FROM public.trial_balance_uploads WHERE id=$1", [forged]); } finally { await admin.query("SET session_replication_role = origin"); }
    return forgedBound === false && committedBound === true && !C1.workspacePath.startsWith("drafts/") ? true : { forgedBound, committedBound };
  });
  await check("the constraint changes: only the two new tables carry new constraints; every reference is SET NULL except the commit→draft cascade; none points at an upload", async () => {
    const fks = (await admin.query(`SELECT conrelid::regclass::text t, confrelid::regclass::text r, confdeltype d FROM pg_constraint
      WHERE contype='f' AND conrelid IN ('public.trial_balance_drafts'::regclass, 'public.trial_balance_draft_commits'::regclass) ORDER BY 1, 2`)).rows
      .map((f) => `${f.t.replace("public.", "")}->${f.r.replace("public.", "")}:${f.d}`).join(" ");
    // No foreign key to trial_balance_uploads at all: tbu_upload_evidence() would read one as processing evidence.
    const want = "trial_balance_draft_commits->companies:n trial_balance_draft_commits->trial_balance_drafts:c trial_balance_draft_commits->trial_balance_source_reservations:n trial_balance_drafts->auth.users:n";
    const migration = migrationSql(REPO, DRAFTS_FILE);
    const altersExisting = /ALTER TABLE (?!public\.trial_balance_draft)/i.test(migration) || /DROP (TABLE|CONSTRAINT|POLICY|TRIGGER)/i.test(migration);
    return fks === want && !altersExisting ? true : { fks, altersExisting };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "TRIAL_BALANCE_DRAFTS: ALL PASSED" : "TRIAL_BALANCE_DRAFTS: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
