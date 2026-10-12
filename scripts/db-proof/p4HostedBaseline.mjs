#!/usr/bin/env node
// commercial-p4 on the EXACT hosted baseline — real-PostgreSQL proof of the release assertions (purchasing_gate.sql,
// preflight.sql, postcondition.sql) and the exact wrapper against the state Lovable reported at P4-1 (2026-10-12):
// journal 54, payments disabled, and two legacy offers under plan PAID that are active but NOT purchasable —
// 95dc943c-9d5e-433f-906c-5528bd0302cd SANDBOX-TEST-PAID-TZ and 68d35bb6-1663-4045-910e-97c983cee690
// SANDBOX-TEST-PAID-GLOBAL (TZS). Historical rows are reported and never changed; any purchasable TZS/TZ offer is refused
// even while payments are disabled; payments must independently be disabled. Embedded PostgreSQL by default.
// The legacy rows' amounts here are fixtures; on the hosted database they are left exactly as they are.
import crypto from "node:crypto";
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
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`);
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}

let pool, admin, embeddedServer = null, embeddedDir = null;
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-p4-baseline-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE p4_baseline_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/p4_baseline_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) { try { fs.rmSync(embeddedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } }
}
const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
}
async function asCaller(caller, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const role = caller.kind === "anon" ? "anon" : caller.kind === "service" ? "service_role" : "authenticated";
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, caller.uid ?? ""]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const SERVICE = { kind: "service" };
const ANON = { kind: "anon" };
const one = async (caller, sql, params) => (await asCaller(caller, async (c) => (await c.query(sql, params)).rows))[0];
const uuid = () => globalThis.crypto.randomUUID();
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const DAY = 86_400_000;
const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };

const MIGRATION = "20261101100000_payment_reversal_authority.sql";
const WRAPPER = "release/wrappers/20261101100000_payment_reversal_authority.wrapper.sql";
const DOC = (f) => fs.readFileSync(path.join(REPO, "docs/release/commercial-p4", f), "utf8");
// The two legacy offers recorded on the hosted database (Lovable, 2026-10-12): active, NOT purchasable, plan PAID.
const LEGACY = [
  { id: "95dc943c-9d5e-433f-906c-5528bd0302cd", code: "SANDBOX-TEST-PAID-TZ", market: "TZ" },
  { id: "68d35bb6-1663-4045-910e-97c983cee690", code: "SANDBOX-TEST-PAID-GLOBAL", market: "GLOBAL" },
];

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 6 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);

  group("Hosted baseline · the state P4-1 meets");
  await check("every migration before commercial-p4 applies; the hosted journal holds 54 rows; payments are disabled", async () => {
    for (const f of files.slice(0, cut)) await applyMigration(f);
    await admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)");
    for (let k = 0; k < 54; k++) await admin.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)", [`hosted-${k + 1}`, Date.now()]);
    await admin.query("UPDATE public.commercial_platform_state SET state='PAYMENTS_DISABLED' WHERE id = true");
    return true;
  });
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  let paidPlan = (await admin.query("SELECT id FROM public.commercial_plans WHERE code='PAID' AND product_id=$1", [product])).rows[0]?.id;
  await check("the legacy plan PAID and its two TZS offers exist exactly as recorded on the hosted database: active, NOT purchasable", async () => {
    if (!paidPlan) {
      // The hosted database still carries the legacy plan; the replayed chain may not. Recreate it as a copy of a plan row.
      paidPlan = (await admin.query(`INSERT INTO public.commercial_plans SELECT (jsonb_populate_record(NULL::public.commercial_plans,
          to_jsonb(p) || jsonb_build_object('id', gen_random_uuid(), 'code', 'PAID', 'name', 'Paid (legacy)', 'is_active', false))).*
        FROM public.commercial_plans p WHERE p.code = 'SOLO' AND p.product_id = $1 RETURNING id`, [product])).rows[0].id;
    }
    for (const o of LEGACY) {
      await admin.query(`INSERT INTO public.commercial_offers (id, offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent,
          billing_interval, billing_interval_count, is_active, is_purchasable) VALUES ($1,$2,$3,$4,'TZS',1000,0,'ANNUAL',1,true,false)`, [o.id, o.code, paidPlan, o.market]);
    }
    const rows = (await admin.query("SELECT id, offer_code, is_active, is_purchasable FROM public.commercial_offers WHERE currency_code='TZS' OR market_code='TZ' ORDER BY offer_code")).rows;
    return rows.length === 2 && rows.every((r) => r.is_active && !r.is_purchasable) ? true : rows;
  });
  const legacyMd5 = async () => (await admin.query("SELECT string_agg(md5(to_jsonb(co)::text), ',' ORDER BY co.id) h FROM public.commercial_offers co WHERE co.id = ANY($1)", [LEGACY.map((o) => o.id)])).rows[0].h;
  const legacyBefore = await legacyMd5();

  /** One documented SQL file in one transaction; `setup` runs first; always rolled back. */
  const runDoc = async (text, { setup = null, readOnly = !setup } = {}) => {
    const notices = []; const on = (n) => notices.push(n.message);
    admin.on("notice", on);
    try {
      await admin.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      if (setup) await admin.query(setup);
      const res = await admin.query(text);
      return { sets: (Array.isArray(res) ? res : [res]).filter((r) => r.fields?.length), notices };
    } catch (e) { return { error: e, notices }; } finally { await admin.query("ROLLBACK"); admin.off("notice", on); }
  };
  const GATE = DOC("purchasing_gate.sql");
  const gateListsLegacy = (out) => {
    const rows = out.sets.find((s) => s.fields.some((f) => f.name === "row_md5"))?.rows ?? [];
    return rows.length === 2 && LEGACY.every((o) => rows.some((r) => r.id === o.id && r.offer_code === o.code && r.is_purchasable === false && r.is_active === true));
  };

  group("P4-1 · the purchasing gate on the legacy baseline");
  await check("the gate passes READ ONLY: payments disabled, no purchasable TZS/TZ offer, no TZS public price; it lists both legacy rows unchanged", async () => {
    const out = await runDoc(GATE);
    return !out.error && out.notices.some((n) => /^PURCHASING GATE OK/.test(n)) && gateListsLegacy(out) ? true : { e: out.error?.message, notices: out.notices };
  });
  await check("the commercial-p4 preflight passes READ ONLY on the same baseline", async () => {
    const out = await runDoc(DOC("preflight.sql"));
    return !out.error && out.notices.some((n) => /PREFLIGHT OK: apply 20261101100000_payment_reversal_authority\.wrapper\.sql/.test(n)) ? true : { e: out.error?.message, notices: out.notices };
  });
  await check("no self-serve plan resolves a TZ offer, even with customer payments enabled (the legacy rows are not purchasable)", async () => {
    const out = [];
    try {
      await admin.query("BEGIN");
      await admin.query("UPDATE public.commercial_platform_state SET state='CUSTOMER_PAYMENTS_ENABLED' WHERE id = true");
      for (const p of ["SOLO", "PRACTICE", "FIRM"]) out.push((await admin.query("SELECT public.resolve_commercial_offer($1,'ANNUAL','TZ') r", [p])).rows[0].r);
      out.push({ public: (await admin.query("SELECT public.get_public_plan_prices() r")).rows[0].r.offers.filter((o) => o.currency_code === "TZS") });
    } finally { await admin.query("ROLLBACK"); }
    return out.slice(0, 3).every((r) => r.resolution !== "AVAILABLE") && out[3].public.length === 0 ? true : out;
  });

  group("Negative · an unexpectedly purchasable TZS/TZ offer is refused even while payments are disabled");
  const negatives = [
    ["SANDBOX-TEST-PAID-TZ made purchasable", `UPDATE public.commercial_offers SET is_purchasable = true WHERE id = '${LEGACY[0].id}'`, [/purchasable TZS\/TZ offer\(s\): SANDBOX-TEST-PAID-TZ/], [/commercial_platform_state/]],
    ["SANDBOX-TEST-PAID-GLOBAL (TZS) made purchasable", `UPDATE public.commercial_offers SET is_purchasable = true WHERE id = '${LEGACY[1].id}'`, [/purchasable TZS\/TZ offer\(s\): SANDBOX-TEST-PAID-GLOBAL/], [/commercial_platform_state/]],
    ["a new purchasable Solo TZ offer (also on the public price list)", `INSERT INTO public.commercial_offers (offer_code, plan_id, market_code, currency_code, amount_minor, currency_exponent, billing_interval, billing_interval_count, is_active, is_purchasable)
       SELECT 'CFOCLOSE_SOLO_TZ_TZS_ANNUAL', id, 'TZ', 'TZS', 1000000, 0, 'ANNUAL', 1, true, true FROM public.commercial_plans WHERE code = 'SOLO' AND product_id = '${product}'`,
      [/purchasable TZS\/TZ offer\(s\): CFOCLOSE_SOLO_TZ_TZS_ANNUAL/, /public price list carries 1 TZS\/TZ price/], [/commercial_platform_state/]],
    ["payments opened to the sandbox (no TZS offer purchasable)", `UPDATE public.commercial_platform_state SET state = 'SANDBOX_ONLY' WHERE id = true`, [/commercial_platform_state is SANDBOX_ONLY/], [/purchasable TZS/]],
    ["payments opened to customers AND a purchasable TZ offer: both named", `UPDATE public.commercial_platform_state SET state = 'CUSTOMER_PAYMENTS_ENABLED' WHERE id = true; UPDATE public.commercial_offers SET is_purchasable = true WHERE id = '${LEGACY[0].id}'`,
      [/commercial_platform_state is CUSTOMER_PAYMENTS_ENABLED/, /SANDBOX-TEST-PAID-TZ/], []],
  ];
  const runNegatives = async (when) => {
    for (const [label, setup, must, mustNot] of negatives) {
      await check(`${when}: ${label} → PURCHASING_GATE_REFUSED; rolled back, the legacy rows unchanged`, async () => {
        const out = await runDoc(GATE, { setup });
        const m = out.error?.message ?? "";
        return /PURCHASING_GATE_REFUSED/.test(m) && must.every((rx) => rx.test(m)) && mustNot.every((rx) => !rx.test(m)) && await legacyMd5() === legacyBefore ? true : m || "not refused";
      });
    }
  };
  await runNegatives("before");

  group("P4-3 · the exact wrapper on the legacy baseline (hosted executor model)");
  const journal = async () => (await admin.query("SELECT count(*)::int n FROM drizzle.__drizzle_migrations")).rows[0].n;
  await check("the registered wrapper applies with exactly one journal row (54 → 55); the legacy rows are byte-identical", async () => {
    const text = fs.readFileSync(path.join(REPO, WRAPPER), "utf8");
    try {
      await admin.query("BEGIN");
      await admin.query(text);
      await admin.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)", [crypto.createHash("sha256").update(text).digest("hex"), Date.now()]);
      await admin.query("COMMIT");
    } catch (e) { await admin.query("ROLLBACK"); return e.message; }
    return await journal() === 55 && await legacyMd5() === legacyBefore ? true : { journal: await journal() };
  });
  await check("every later migration applies", async () => { for (const f of files.slice(cut + 1)) await applyMigration(f); return true; });

  group("P4-4 / P4-7 · after the release");
  await check("the commercial-p4 postcondition passes READ ONLY", async () => {
    const out = await runDoc(DOC("postcondition.sql"));
    return !out.error && out.notices.includes("POSTCONDITION OK.") ? true : { e: out.error?.message, notices: out.notices };
  });
  await check("the purchasing gate passes again and lists both legacy rows, byte-identical to P4-1", async () => {
    const out = await runDoc(GATE);
    return !out.error && out.notices.some((n) => /^PURCHASING GATE OK/.test(n)) && gateListsLegacy(out) && await legacyMd5() === legacyBefore ? true : { e: out.error?.message };
  });
  await runNegatives("after");

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED  [${f.group}] ${f.name}`);
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
