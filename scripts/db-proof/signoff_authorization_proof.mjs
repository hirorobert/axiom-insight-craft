#!/usr/bin/env node
// ============================================================================
// REGRESSION PROOF — legacy statement_sign_offs authorization (Workstream A)
//
// STATUS: WRITTEN, UNEXECUTED on the authoring host (no bootable PostgreSQL:
//   no Docker, no system PG, and @embedded-postgres/windows fails initdb with
//   `$libdir/utf8_and_win` missing). No runtime proof is claimed. Run where a
//   loopback PG16 is available — see the two commands at the bottom.
//
// It replays the ENTIRE repository migration chain on a throwaway loopback DB
// and asserts the five sign-off defects (A–E, docs/fin-integrity/
// FINANCIAL-INTEGRITY-RESULT.md) are REFUSED.
//   - With the candidate repair applied (default): every scenario must be REFUSED.
//   - With SIGNOFF_PROOF_WITHOUT_REPAIR=1: the repair migration is skipped, and
//     the scenarios are expected to SUCCEED (i.e. the defect is demonstrated;
//     the harness reports them as KNOWN-FAILING / vulnerable).
//
// Mirrors the session + replay mechanism of scripts/db-proof/run.mjs: simulated
// PostgREST callers via SET LOCAL ROLE + request.jwt.claim.*. Refuses any
// non-loopback host and the production project ref; never reads Supabase creds.
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const REPAIR_FILE = "20261103100000_signoff_authorization_hardening.sql";
const WITHOUT_REPAIR = process.env.SIGNOFF_PROOF_WITHOUT_REPAIR === "1";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Client, Pool } = req("pg");

let embeddedServer, embeddedDir, pool, admin;
const results = [];
const rec = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); };
const uuid = () => globalThis.crypto.randomUUID();
const hex64 = (s) => { let h = ""; for (let i = 0; h.length < 64; i++) h += Buffer.from(`${s}:${i}`).toString("hex"); return h.slice(0, 64); };

function assertLocal(urlString) {
  if (urlString.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project ref");
  const u = new URL(urlString);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) throw new Error(`REFUSED: ${u.hostname} is not loopback`);
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-signoff-proof-"));
  const port = 54900 + Math.floor(Math.random() * 90);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise(); await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE db_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/db_proof`;
}
async function stopDatabase() { try { await pool?.end(); } catch {} try { await admin?.end(); } catch {} if (embeddedServer) { try { await embeddedServer.stop(); } catch {} } if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true }); }

async function replayMigrations() {
  const shim = fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8");
  await admin.query(shim);
  const dir = path.join(REPO, "supabase/migrations");
  let files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (WITHOUT_REPAIR) files = files.filter((f) => f !== REPAIR_FILE);
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) { const lines = text.split("\n"); text = lines.slice(0, lines.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n"); }
    try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
}

async function asCaller(uid, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(client); await client.query("COMMIT"); return out;
  } catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; } finally { client.release(); }
}
// A scenario "passes" (secure) when the write is REFUSED. With WITHOUT_REPAIR it is expected to SUCCEED (vulnerable).
async function expectRefused(name, uid, run) {
  let refused = false, detail = "";
  try { await asCaller(uid, run); } catch (e) { refused = true; detail = String(e.message).split("\n")[0]; }
  if (WITHOUT_REPAIR) rec(`${name} [no-repair: expect SUCCESS=vulnerable]`, !refused, refused ? `unexpectedly refused: ${detail}` : "write SUCCEEDED → defect demonstrated");
  else rec(`${name} [repaired: expect REFUSED]`, refused, refused ? "" : "write SUCCEEDED → repair did NOT close the hole");
}

// ── fixtures — companies + members are seeded here directly. ─────────────────
// PREREQUISITE TO COMPLETE AGAINST THE LIVE CAPABILITY SCHEMA: grant COMPANY_A
// the `prepare_close` + `approve_certification` capabilities and the
// `STATEMENT_CERTIFICATION` entitlement exactly as scripts/db-proof/run.mjs::seed
// does (workspace_capability_* / entitlement tables, migration 20260925140000 /
// 20260925100000). Without that wiring the cert wall / capability checks fire
// before the scenarios under test and the proof cannot isolate A–E.
const U = { preparer: uuid(), outsiderY: uuid(), outsiderZ: uuid() };
let COMPANY_A, UPLOAD, MEMBER_PREP;

async function seed() {
  COMPANY_A = uuid(); UPLOAD = uuid(); MEMBER_PREP = uuid();
  await admin.query(`INSERT INTO auth.users (id) VALUES ($1),($2),($3)`, [U.preparer, U.outsiderY, U.outsiderZ]);
  await admin.query(`INSERT INTO public.companies (id, name) VALUES ($1,'Synthetic Co A')`, [COMPANY_A]);
  await admin.query(`INSERT INTO public.firm_members (id, company_id, user_id, role) VALUES ($1,$2,$3,'preparer')`, [MEMBER_PREP, COMPANY_A, U.preparer]);
  await admin.query(`INSERT INTO public.trial_balance_uploads (id, company_id, period_year, file_name, file_path, status) VALUES ($1,$2,2025,'tb.csv','p/tb.csv','complete')`, [UPLOAD, COMPANY_A]);
  // DELIBERATELY: no passing hesabu_validations row (Defect A/D), or a pass-then-fail pair (Defect D).
  // TODO(reviewer): grant prepare_close + approve_certification + STATEMENT_CERTIFICATION entitlement to COMPANY_A (see note above).
}

const ins = (c, cols, vals) => c.query(`INSERT INTO public.statement_sign_offs (company_id, period_year, upload_id, ${cols}) VALUES ($1,2025,$2,${vals})`, [COMPANY_A, UPLOAD]);

async function main() {
  const conn = await startDatabase();
  admin = new Client({ connectionString: conn }); await admin.connect();
  pool = new Pool({ connectionString: conn, max: 4 });
  console.log(`\n== replay migrations (${WITHOUT_REPAIR ? "WITHOUT repair — demonstrate defects" : "WITH candidate repair"})`);
  await replayMigrations(); await seed();

  console.log("\n== sign-off authorization scenarios");
  // Defect A — prepare_close user INSERTs a locked+approved row, no validation, no tier, no preparer signature.
  await expectRefused("A: INSERT locked+approved row bypasses HESABU gate & approver tier", U.preparer, (c) =>
    ins(c, "preparer_signed_at, approver_id, approver_signed_at, status, locked_at",
           `NULL, '${U.outsiderZ}', now(), 'locked', now()`));
  // Defect B — one actor attributes reviewer/approver to arbitrary distinct users.
  await expectRefused("B: signer identity not bound to auth.uid() (impersonation)", U.preparer, (c) =>
    ins(c, "preparer_id, preparer_signed_at, reviewer_id, reviewer_signed_at, approver_id, approver_signed_at",
           `'${U.preparer}', now(), '${U.outsiderY}', now(), '${U.outsiderZ}', now()`));
  // Defect D — sign after a newer FAILING validation (seed a pass then a fail before running this one).
  await expectRefused("D: preparer-sign accepted against a stale pass / newer failing validation", U.preparer, async (c) => {
    await admin.query(`INSERT INTO public.hesabu_validations (upload_id, gate_satisfied, status, validated_at) VALUES ($1,true,'passed',now()-interval '2h'),($1,false,'failed',now()-interval '1h')`, [UPLOAD]);
    return ins(c, "preparer_id, preparer_signed_at", `'${U.preparer}', now()`);
  });
  // Defect E — jump straight to 'locked' without the preparer→reviewer→approver sequence.
  await expectRefused("E: status jumps to 'locked' without tier sequence", U.preparer, (c) =>
    ins(c, "status, locked_at", `'locked', now()`));
  // Defect C — mutate an already-locked row (requires a locked row to exist; service-seed one, then attempt UPDATE as approver).
  await expectRefused("C: locked sign-off row is mutated post-lock", U.preparer, async (c) => {
    const r = await admin.query(`INSERT INTO public.statement_sign_offs (company_id, period_year, upload_id, locked_at, statements_hash) VALUES ($1,2025,$2,now(),$3) RETURNING id`, [COMPANY_A, UPLOAD, hex64("locked")]);
    return c.query(`UPDATE public.statement_sign_offs SET approver_note='tampered' WHERE id=$1`, [r.rows[0].id]);
  });

  await stopDatabase();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions as expected.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error("PROOF ERROR:", e.message); try { await stopDatabase(); } catch {} process.exit(2); });

// RUN (where a loopback PG16 is available):
//   DB_PROOF_MODULES_DIR=/path/with/embedded-postgres+pg node scripts/db-proof/signoff_authorization_proof.mjs
//   SIGNOFF_PROOF_WITHOUT_REPAIR=1 DB_PROOF_MODULES_DIR=... node scripts/db-proof/signoff_authorization_proof.mjs   # demonstrate defects
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/throwaway node scripts/db-proof/signoff_authorization_proof.mjs
