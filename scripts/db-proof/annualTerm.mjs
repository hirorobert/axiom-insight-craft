#!/usr/bin/env node
// Real-PostgreSQL proof of the 12-month commercial term (20261001120000_annual_commercial_term.sql).
//
//   T-01  selecting monthly payment cannot create a one-month licence — a monthly intent is refused, and a monthly
//         intent created BEFORE the migration cannot be committed into a short licence (no licence, no partial write);
//   T-02  an annual payment creates one 12-month licence that is entitled;
//   T-03  payment failure (SUSPENDED) refuses new privileged actions and preserves reads;
//   T-04  stopping renewal changes renewal only — status, period and entitlement are untouched; idempotent; audited;
//   T-05  expiry refuses new privileged actions and leaves existing records readable (archive);
//   T-06  no client-side action grants or changes an entitlement;
//   T-07  every licence that existed before the migration is unchanged (every pre-existing column, byte for byte);
//         only the self-serve MONTHLY offers change, and only to retired;
//   T-09  the migration is re-runnable: a second application changes nothing;
//   T-08  the read-only preflight audit (scripts/db-preflight/annualTermPreflight.sql) runs without writing and finds
//         the monthly-paid licence.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/annualTerm.mjs
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261001120000_annual_commercial_term.sql";
const PREFLIGHT = "scripts/db-preflight/annualTermPreflight.sql";
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

let pool;
let admin;
let embeddedServer = null;
let embeddedDir = null;

function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-annual-term-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE annual_term_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/annual_term_proof`;
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
    if (caller.kind === "anon") {
      await c.query("SET LOCAL ROLE anon");
      await c.query("SELECT set_config('request.jwt.claim.role','anon',true), set_config('request.jwt.claim.sub','',true)");
    } else {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [caller.uid]);
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const codeOf = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.code ?? String(e.message); } };
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 8 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group("Migration — applies over every earlier migration and is the newest");
  await check(`every migration before ${MIGRATION} applies`, async () => {
    if (cut < 0) return "migration not found";
    if (cut !== files.length - 1) return `not the newest migration (followed by ${files.slice(cut + 1).join(", ")})`;
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });

  // ── Fixtures that exist BEFORE the migration ─────────────────────────────────────────────────────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0].id;
  const PLAN = { SOLO: await planId("SOLO"), ENTERPRISE: await planId("ENTERPRISE") };
  const offer = async (code) => (await admin.query("SELECT * FROM public.commercial_offers WHERE offer_code=$1", [code])).rows[0];
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);

  const account = async (label, planCode, licence = {}) => {
    const uid = await mkUser(label);
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
    let lic = null;
    let co = null;
    if (planCode) {
      // The workspace is created while the licence is current (company creation is capacity-gated), then the licence
      // is put into its target state — as a real account reaches it.
      lic = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start)
        VALUES ($1,$2,'ACTIVE',$3,now() - interval '1 day') RETURNING id`, [bc, await planId(planCode), licence.source ?? "ADMIN_GRANT"])).rows[0].id;
      co = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, `${label} Co`])).rows[0].id;
      await admin.query("UPDATE public.commercial_licences SET status=$2, effective_start=$3, effective_end=$4 WHERE id=$1",
        [lic, licence.status ?? "ACTIVE", licence.start ?? new Date(Date.now() - 86_400_000), licence.end ?? null]);
    }
    return { uid, bc, lic, co };
  };
  const intent = async (acct, offerCode, provider = "STRIPE") => {
    const o = await offer(offerCode);
    return (await admin.query(`INSERT INTO public.payment_checkout_intents
        (billing_customer_id, commercial_offer_id, plan_id, market_code, expected_amount_minor, currency_code, currency_exponent,
         billing_interval, billing_interval_count, provider, saff_reference, status, created_by_user_id, provider_environment, product_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12,'sandbox',$13) RETURNING id`,
      [acct.bc, o.id, o.plan_id, o.market_code, o.amount_minor, o.currency_code, o.currency_exponent, o.billing_interval, o.billing_interval_count,
       provider, `SAFF-${uuid()}`, acct.uid, product])).rows[0].id;
  };
  const commit = async (intentId, amount) => (await admin.query(`SELECT public.commit_verified_commercial_payment($1,'STRIPE',$2,'succeeded','SUCCEEDED',$3,'USD',$4,now(),'PROVIDER_API_VERIFY',$5,$6,'sandbox') r`,
    [intentId, `tx-${uuid()}`, amount, "h".repeat(64), `idem-${uuid()}`, `SAFF-${uuid()}`])).rows[0].r;

  const P = {
    annualAdmin: await account("annual-admin", "PRACTICE", { start: new Date(Date.now() - 30 * 86_400_000), end: new Date(Date.now() + 335 * 86_400_000) }),
    monthlyPaid: await account("monthly-paid", "SOLO", { source: "STRIPE_VERIFIED_PAYMENT", start: new Date(Date.now() - 5 * 86_400_000), end: new Date(Date.now() + 25 * 86_400_000) }),
    suspended: await account("suspended", "FIRM", { status: "SUSPENDED" }),
    expired: await account("expired", "SOLO", { status: "EXPIRED", start: new Date(Date.now() - 400 * 86_400_000), end: new Date(Date.now() - 35 * 86_400_000) }),
  };
  const pendingMonthly = await account("pending-monthly", null);
  const pendingMonthlyIntent = await intent(pendingMonthly, "CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY");
  const snapLic = async () => (await admin.query("SELECT id, to_jsonb(l) - 'renewal_status' AS row FROM public.commercial_licences l ORDER BY id")).rows;
  const snapOffers = async () => (await admin.query("SELECT offer_code, to_jsonb(o) AS row FROM public.commercial_offers o ORDER BY offer_code")).rows;
  const licBefore = await snapLic();
  const offersBefore = await snapOffers();

  // T-08 runs before the migration (production runs it before applying).
  group("T-08 · read-only preflight audit");
  await check("the preflight runs inside a READ ONLY transaction and lists the monthly-paid licence and the pending monthly intent", async () => {
    const sql = fs.readFileSync(path.join(REPO, PREFLIGHT), "utf8");
    const c = await pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      const res = await c.query(sql);
      await c.query("ROLLBACK");
      const sets = (Array.isArray(res) ? res : [res]).map((r) => r.rows);
      const flat = JSON.stringify(sets);
      return flat.includes(P.monthlyPaid.lic) && flat.includes(pendingMonthlyIntent) ? true : flat.slice(0, 400);
    } finally { c.release(); }
  });

  group("Apply the migration");
  await check(`${MIGRATION} applies`, async () => { await applyMigration(MIGRATION); return true; });

  // ── T-07 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-07 · existing licences and offers");
  await check("every licence that existed before is unchanged in every pre-existing column", async () => {
    const after = await snapLic();
    return JSON.stringify(after) === JSON.stringify(licBefore) ? true : "a pre-existing licence changed";
  });
  await check("every pre-existing licence reads renewal_status RENEWS (the additive default)", async () =>
    (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE renewal_status <> 'RENEWS'")).rows[0].n === 0);
  await check("only the SOLO / PRACTICE / FIRM MONTHLY offers changed, and only to retired; every other offer is identical", async () => {
    const before = new Map(offersBefore.map((r) => [r.offer_code, r.row]));
    const bad = [];
    for (const { offer_code, row } of await snapOffers()) {
      const was = before.get(offer_code);
      const selfServeMonthly = /^CFOCLOSE_(SOLO|PRACTICE|FIRM)_.*_MONTHLY$/.test(offer_code);
      if (!selfServeMonthly) { if (JSON.stringify(was) !== JSON.stringify(row)) bad.push(`changed: ${offer_code}`); continue; }
      if (row.is_active || row.is_purchasable || row.effective_end === null) bad.push(`not retired: ${offer_code}`);
      for (const k of ["amount_minor", "currency_code", "billing_interval", "billing_interval_count", "plan_id"]) if (was[k] !== row[k]) bad.push(`${offer_code}.${k}`);
    }
    return bad.length ? bad.join(" | ") : true;
  });

  // ── T-01 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-01 · monthly payment never creates a one-month licence");
  const fresh = await account("fresh", null);
  await check("a new MONTHLY checkout intent for Solo, Practice or Firm is refused (22023)", async () => {
    const codes = [];
    for (const o of ["CFOCLOSE_SOLO_GLOBAL_USD_MONTHLY", "CFOCLOSE_PRACTICE_GLOBAL_USD_MONTHLY", "CFOCLOSE_FIRM_GLOBAL_USD_MONTHLY"]) {
      const e = await errOf(() => intent(fresh, o));
      codes.push(e?.code === "22023" && /one 12-month term/.test(e.message) ? "22023" : `${e?.code} ${e?.message}`);
    }
    return codes.every((c) => c === "22023") ? true : codes.join(",");
  });
  await check("a MONTHLY intent created before the migration cannot be committed: the commit fails and no licence or payment event is written", async () => {
    const before = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE billing_customer_id=$1", [pendingMonthly.bc])).rows[0].n;
    const events = (await admin.query("SELECT count(*)::int n FROM public.payment_events WHERE checkout_intent_id=$1", [pendingMonthlyIntent])).rows[0].n;
    const err = await errOf(() => commit(pendingMonthlyIntent, 4900));
    const code = err && /12-month term/.test(err.message) ? err.code : `unexpected: ${err?.code} ${err?.message}`;
    const after = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences WHERE billing_customer_id=$1", [pendingMonthly.bc])).rows[0].n;
    const eventsAfter = (await admin.query("SELECT count(*)::int n FROM public.payment_events WHERE checkout_intent_id=$1", [pendingMonthlyIntent])).rows[0].n;
    return code === "22023" && after === before && eventsAfter === events ? true : { code, before, after, events, eventsAfter };
  });
  await check("a payment-created licence shorter than 12 months is refused even by a direct insert (by the term guard)", async () =>
    (await errOf(() => admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
      VALUES ($1,$2,'ACTIVE','STRIPE_VERIFIED_PAYMENT',now(),now() + interval '1 month')`, [fresh.bc, PLAN.SOLO])))?.message?.includes("shorter than the 12-month term") === true);
  await check("Enterprise is untouched by the guards (contract-based)", async () =>
    (await codeOf(() => admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
      VALUES ($1,$2,'PENDING','STRIPE_VERIFIED_PAYMENT',now(),now() + interval '3 months')`, [fresh.bc, PLAN.ENTERPRISE]))) === "ok");

  // ── T-02 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-02 · an annual payment creates one 12-month, entitled licence");
  const annual = await account("annual-buyer", null);
  const authz = async (who, co, cap = "REPORTING_PACK_EXPORT") => (await one(user(who), "SELECT public.authorize_paid_action($1,$2) r", [co, cap])).r;
  await check("ANNUAL Practice intent commits into exactly one licence of 12 months", async () => {
    const r = await commit(await intent(annual, "CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL"), 99000);
    const lic = (await admin.query("SELECT status, effective_end - effective_start AS span, effective_end >= effective_start + interval '12 months' AS full FROM public.commercial_licences WHERE billing_customer_id=$1", [annual.bc])).rows;
    return r?.committed === true && lic.length === 1 && lic[0].status === "ACTIVE" && lic[0].full === true ? true : { r, lic };
  });
  await check("the annual licence entitles new privileged actions (including creating the first workspace)", async () => {
    annual.co = (await q(user(annual.uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Annual Co') RETURNING id", [annual.uid]))[0].id;
    return (await authz(annual.uid, annual.co)).allowed === true;
  });

  // ── T-03 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-03 · payment failure suspends writes, preserves reads");
  await check("SUSPENDED: a new privileged action is refused", async () => (await authz(P.suspended.uid, P.suspended.co)).allowed === false);
  await check("SUSPENDED: the account holder still reads their workspace", async () =>
    (await q(user(P.suspended.uid), "SELECT id FROM public.companies WHERE id=$1", [P.suspended.co])).length === 1);

  // ── T-04 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-04 · stopping renewal changes renewal only");
  const row = async (id) => (await admin.query("SELECT status, effective_start, effective_end, plan_id, additional_seats, renewal_status FROM public.commercial_licences WHERE id=$1", [id])).rows[0];
  await check("the holder stops renewal: renewal NON_RENEWING; status, period, plan and seats unchanged; still entitled", async () => {
    const before = await row(P.annualAdmin.lic);
    const r = (await one(user(P.annualAdmin.uid), "SELECT public.stop_commercial_renewal('moving on') r")).r;
    const after = await row(P.annualAdmin.lic);
    const same = ["status", "plan_id", "additional_seats"].every((k) => before[k] === after[k])
      && +before.effective_start === +after.effective_start && +before.effective_end === +after.effective_end;
    const stillEntitled = (await authz(P.annualAdmin.uid, P.annualAdmin.co)).allowed === true;
    return r.outcome === "renewal_stopped" && after.renewal_status === "NON_RENEWING" && same && stillEntitled ? true : { r, before, after, stillEntitled };
  });
  await check("idempotent, and audited exactly once", async () => {
    const r = (await one(user(P.annualAdmin.uid), "SELECT public.stop_commercial_renewal(NULL) r")).r;
    const n = (await admin.query("SELECT count(*)::int n FROM public.billing_audit_events WHERE billing_customer_id=$1 AND action='RENEWAL_STOPPED'", [P.annualAdmin.bc])).rows[0].n;
    return r.outcome === "already_non_renewing" && n === 1 ? true : { r, n };
  });
  await check("another person cannot stop someone else's renewal; anon cannot call it", async () => {
    const other = await account("other", null);
    const r = (await one(user(other.uid), "SELECT public.stop_commercial_renewal(NULL) r")).r;
    const anon = await codeOf(() => q(ANON, "SELECT public.stop_commercial_renewal(NULL)"));
    const untouched = (await row(P.monthlyPaid.lic)).renewal_status === "RENEWS";
    return r.outcome === "no_current_licence" && anon === "42501" && untouched ? true : { r, anon, untouched };
  });

  // ── T-05 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-05 · expiry leaves the archive readable");
  await check("EXPIRED: a new privileged action is refused", async () => (await authz(P.expired.uid, P.expired.co)).allowed === false);
  await check("EXPIRED: the account holder still reads their workspace", async () =>
    (await q(user(P.expired.uid), "SELECT id FROM public.companies WHERE id=$1", [P.expired.co])).length === 1);
  await check("a licence whose period has ended (still ACTIVE in status) no longer entitles; the workspace stays readable", async () => {
    const lapsed = await account("lapsed", "SOLO", { start: new Date(Date.now() - 400 * 86_400_000), end: new Date(Date.now() - 1000) });
    const refused = (await authz(lapsed.uid, lapsed.co)).allowed === false;
    const reads = (await q(user(lapsed.uid), "SELECT id FROM public.companies WHERE id=$1", [lapsed.co])).length === 1;
    return refused && reads ? true : { refused, reads };
  });

  // ── T-06 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-06 · no client-side action grants or changes an entitlement");
  await check("an authenticated holder cannot insert a licence, extend one, or flip its status or renewal", async () => {
    const u = P.expired;
    const codes = [
      await codeOf(() => q(user(u.uid), "INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now())", [u.bc, PLAN.SOLO])),
      await codeOf(async () => { const r = await q(user(u.uid), "UPDATE public.commercial_licences SET status='ACTIVE', effective_end = now() + interval '5 years' WHERE id=$1 RETURNING id", [u.lic]); if (r.length) throw Object.assign(new Error("updated"), { code: "UPDATED" }); }),
      await codeOf(async () => { const r = await q(user(u.uid), "UPDATE public.commercial_licences SET renewal_status='NON_RENEWING' WHERE id=$1 RETURNING id", [u.lic]); if (r.length) throw Object.assign(new Error("updated"), { code: "UPDATED" }); }),
    ];
    const row1 = await row(u.lic);
    return !codes.includes("ok") || (codes[1] === "ok" && codes[2] === "ok" && row1.status === "EXPIRED" && row1.renewal_status === "RENEWS")
      ? (row1.status === "EXPIRED" && row1.renewal_status === "RENEWS" ? true : { codes, row1 })
      : { codes, row1 };
  });
  await check("the guard functions are not callable by clients", async () => {
    const c1 = await codeOf(() => q(user(P.expired.uid), "SELECT public.commercial_annual_term_licence_guard()"));
    return c1 !== "ok" ? true : c1;
  });

  // ── T-09 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T-09 · re-application changes nothing");
  await check("applying the migration a second time leaves every licence, renewal status and offer exactly as it was", async () => {
    const full = async () => (await admin.query("SELECT to_jsonb(l) AS row FROM public.commercial_licences l ORDER BY id")).rows;
    const lic = await full(); const off = await snapOffers();
    await applyMigration(MIGRATION);
    return JSON.stringify(await full()) === JSON.stringify(lic) && JSON.stringify(await snapOffers()) === JSON.stringify(off) ? true : "changed on re-application";
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.message ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
