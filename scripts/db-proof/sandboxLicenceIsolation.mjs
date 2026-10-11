#!/usr/bin/env node
// DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001 — real-PostgreSQL proof for 20261031100000_sandbox_licence_isolation.sql
// (batch commercial-p3). Embedded PostgreSQL by default (DB_PROOF_MODULES_DIR as for the other proofs).
//
//   Before        on the chain without the correction the defect reproduces: a sandbox payment grants production access
//                 through every consumer; PAYMENTS_DISABLED does not revoke it; a sandbox upgrade ends a genuine term
//   Gate          refused unless payments are disabled; refused a second time; every later migration applies
//   Backfill      provenance only from authoritative records (the PAYMENT_CONFIRMED event or placement record naming the
//                 licence, then its checkout intent's environment); ambiguous rows are REVIEW_REQUIRED, never assumed
//                 production; no licence deleted, no payment or earlier audit row changed
//   Containment   each sandbox licence becomes SANDBOX with one audited row; the buyer loses access; a term a sandbox
//                 upgrade ended is listed and restored to its recorded end, once, audited
//   Invariant     a new sandbox payment records SANDBOX and grants nothing (summary, entity capacity, plan, seats,
//                 capability, create_entity); never touches a genuine term; no platform state or direct write revives it
//   Intact        production purchases, manual grants and placements still grant; the paid-term guard still holds
//   Lineage       concurrent deliveries and replays, refunds and renewals keep the environment
//   Review        administrators resolve ambiguous rows explicitly, once, audited
//   Withheld      financial reporting stays behind the real rollout (fs_rollout_allows / financial_statements_workspace_access)
//
//   node scripts/db-proof/sandboxLicenceIsolation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261031100000_sandbox_licence_isolation.sql";
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-paid-term-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE paid_term_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/paid_term_proof`;
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
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const DAY = 86_400_000;
const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };


async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 12 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);

  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group("Migration chain");
  await check(`every migration before ${MIGRATION} applies`, async () => {
    if (cut < 0) return "migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });

  // ── Fixtures and calls (the real RPCs, as the real roles) ────────────────────────────────────────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const PLAN = Object.fromEntries((await admin.query("SELECT code, id FROM public.commercial_plans WHERE product_id=$1", [product])).rows.map((r) => [r.code, r.id]));
  const offerOf = async (code) => (await admin.query("SELECT * FROM public.commercial_offers WHERE offer_code=$1", [code])).rows[0];
  const OFFER = { SOLO: await offerOf("CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL"), PRACTICE: await offerOf("CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL"), FIRM: await offerOf("CFOCLOSE_FIRM_GLOBAL_USD_ANNUAL") };
  await admin.query("UPDATE public.commercial_offers SET is_purchasable = true WHERE offer_code LIKE 'CFOCLOSE_%_GLOBAL_USD_ANNUAL'");
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  const grant = (acct, plan, start, end) => admin.query(
    "INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end) VALUES ($1,$2,'ACTIVE','MANUAL_ADMIN_GRANT',$3,$4) RETURNING id",
    [acct.bc, PLAN[plan], start, end]).then((r) => r.rows[0].id);
  const acquire = async (acct, plan, env) => {
    const o = OFFER[plan]; const ref = `SAFF-${uuid().slice(0, 12)}`;
    const a = await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,$11,$12,$13,$14) r`,
      [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, "POLAR", env, acct.uid, ref]);
    if (a.r.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a.r)}`);
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.r.intent_id, a.r.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.r.intent_id, a.r.creation_token, `prov-${uuid()}`, `https://checkout.example.test/${ref}`]);
    return { id: a.r.intent_id, ref, amount: Number(o.amount_minor), env };
  };
  // Buy in the platform state that permits the environment: sandbox in SANDBOX_ONLY, production in CUSTOMER_PAYMENTS_ENABLED.
  const buy = async (acct, plan, env) => { await setState(env === "sandbox" ? "SANDBOX_ONLY" : "CUSTOMER_PAYMENTS_ENABLED"); return acquire(acct, plan, env); };
  const commit = (i) => one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,'POLAR',$2,'paid','SUCCEEDED',$3,'USD',$4,now(),'PROVIDER_API_VERIFY',$5,$6,$7) r`,
    [i.id, `tx-${i.ref}`, i.amount, "h".repeat(64), `key-${i.ref}`, i.ref, i.env]).then((x) => x.r);
  const lic = async (acct) => (await admin.query(`SELECT l.id, cp.code, l.status, l.source, l.effective_start, l.effective_end, l.additional_seats
    ${"FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.effective_start, l.created_at"}`, [acct.bc])).rows;
  const prov = async (id) => (await admin.query("SELECT status, provenance, provenance_evidence FROM public.commercial_licences WHERE id=$1", [id])).rows[0];
  const as = (acct, sql, p = []) => one(user(acct.uid), sql, p).then((x) => x?.r);
  const asAdmin = (sql, p = []) => one(user(ADMIN), sql, p).then((x) => x?.r);
  /** Every consumer that decides access, read as the account owner (and the plan resolver as the service). */
  const access = async (acct) => ({
    summary: (await as(acct, "SELECT public.get_my_billing_summary() r"))?.licence_status ?? null,
    entities: (await as(acct, "SELECT public.get_my_entity_capacity() r"))?.capacity ?? null,
    plan: (await one(SERVICE, "SELECT public._account_current_plan_code($1) r", [acct.uid]))?.r ?? null,
    seats: (await one(SERVICE, "SELECT public._seat_capacity_for_account($1) r", [acct.uid]))?.r?.source ?? null,
    capability: (await one(SERVICE, "SELECT public._resolve_entitlement_for_owner($1,'CLOSE_ASSURANCE') r", [acct.uid]))?.r?.reason ?? null,
  });
  const NO_ACCESS = (a) => a.summary === null && !a.entities && a.plan === null && a.seats === "NO_CURRENT_PLAN" && a.capability === "NO_CURRENT_PLAN";
  const tryCreate = (acct) => as(acct, "SELECT public.create_entity($1,'Probe Co','2025-12-31','USD',NULL) r", [uuid()]).then((r) => r?.outcome).catch((e) => `error:${e.code}`);
  const audit = async (action) => (await admin.query("SELECT * FROM public.billing_audit_events WHERE action=$1 ORDER BY created_at", [action])).rows;
  const ADMIN_TABLES = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text,'|' ORDER BY e.id) FROM public.payment_events e),'')
      || coalesce((SELECT string_agg(to_jsonb(i)::text,'|' ORDER BY i.id) FROM public.payment_checkout_intents i),'')) AS h`;

  // ════ BEFORE: the defect, reproduced on the chain without the correction ══════════════════════════════════════════
  group("Before the correction · the defect reproduces on real PostgreSQL");
  const leak = await account("leak");          // the ba803893 shape: a sandbox purchase, no other licence
  let leakLicence;
  await check("a verified sandbox payment grants production access (billing summary, capacity, plan, seats, capability, create_entity)", async () => {
    const i = await buy(leak, "SOLO", "sandbox");
    const c = await commit(i);
    leakLicence = c.licence_id;
    const a = await access(leak);
    return c.status === "COMMITTED" && a.summary === "ACTIVE" && a.entities === 1 && a.plan === "SOLO" && a.capability !== "NO_CURRENT_PLAN" ? true : { c, a };
  });
  await check("returning the platform to PAYMENTS_DISABLED does not revoke it", async () => {
    await setState("PAYMENTS_DISABLED");
    const a = await access(leak);
    return a.summary === "ACTIVE" ? true : a;
  });
  const victim = await account("victim");      // a genuine term ended by a sandbox upgrade
  let victimTerm, victimOriginalEnd, victimSandbox;
  await check("a sandbox upgrade ends a genuine (manually granted) term", async () => {
    // Granted through the audited RPC, so its original end is on record.
    const g = await asAdmin("SELECT public.admin_grant_commercial_licence($1,'PRACTICE',now() - interval '10 days', now() + interval '355 days','victim term') r", [victim.bc]);
    victimTerm = g.licence_id;
    victimOriginalEnd = (await lic(victim))[0].effective_end;
    const i = await buy(victim, "FIRM", "sandbox");
    const c = await commit(i);
    victimSandbox = c.licence_id;
    const t = (await lic(victim)).find((l) => l.id === victimTerm);
    return c.placement === "UPGRADE" && new Date(t.effective_end) < new Date(victimOriginalEnd) ? true : { c, t };
  });
  // Further pre-existing records the backfill must classify.
  const paid = await account("paid");          // a genuine production purchase
  const paidI = await buy(paid, "PRACTICE", "production");
  const paidLicence = (await commit(paidI)).licence_id;
  const manual = await account("manual");
  const manualLicence = (await asAdmin("SELECT public.admin_grant_commercial_licence($1,'SOLO',now(),now() + interval '12 months','manual activation') r", [manual.bc])).licence_id;
  const placed = await account("placed");       // a production payment placed by an administrator (link only in intent metadata)
  await grant(placed, "SOLO", new Date(Date.now() - 5 * DAY), null);  // open-ended -> BLOCKED_OPEN_ENDED -> review
  const placedI = await buy(placed, "FIRM", "production");
  const placedC = await commit(placedI);
  await admin.query("UPDATE public.commercial_licences SET effective_end = now() + interval '1 hour' WHERE billing_customer_id=$1 AND effective_end IS NULL", [placed.bc]);
  const placedLicence = (await asAdmin("SELECT public.admin_place_paid_licence($1, now() + interval '2 hours', 'placed after the agreement ended') r", [placedI.id])).licence_id;
  const reviewSb = await account("review-sandbox");   // a sandbox payment awaiting placement when the correction lands
  await grant(reviewSb, "SOLO", new Date(Date.now() - 5 * DAY), null);
  const reviewSbI = await buy(reviewSb, "PRACTICE", "sandbox");
  const reviewSbC = await commit(reviewSbI);
  const orphan = await account("orphan");       // a payment-sourced licence no record links to an intent
  const orphanLicence = (await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end) VALUES ($1,$2,'ACTIVE','POLAR_VERIFIED_PAYMENT',now(),now() + interval '12 months') RETURNING id", [orphan.bc, PLAN.SOLO])).rows[0].id;
  const nullEnv = await account("null-env");     // a payment licence whose intent has no recorded environment (pre-Ω3 shape)
  const nullEnvI = await buy(nullEnv, "SOLO", "production");
  const nullEnvLicence = (await commit(nullEnvI)).licence_id;
  await admin.query("UPDATE public.payment_checkout_intents SET provider_environment = NULL WHERE id=$1", [nullEnvI.id]);
  await setState("PAYMENTS_DISABLED");
  const placedOk = placedC.status === "PLACEMENT_REVIEW_REQUIRED" && reviewSbC.status === "PLACEMENT_REVIEW_REQUIRED";
  record("fixtures: a production purchase, a manual grant, an administrator placement, a sandbox payment awaiting placement, an orphan and an environment-less payment licence", placedOk, JSON.stringify({ placedC, reviewSbC }));

  // ════ THE MIGRATION ═══════════════════════════════════════════════════════════════════════════════════════════════
  const migrationText = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
  const paymentsBefore = (await admin.query(ADMIN_TABLES)).rows[0].h;
  const licencesBefore = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences")).rows[0].n;
  const auditBefore = (await admin.query("SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY a.id)) h, count(*)::int n FROM public.billing_audit_events a")).rows[0];
  group("Gate");
  await check("with payments in SANDBOX_ONLY the migration refuses (P0001 PREFLIGHT_REFUSED) and nothing changes", async () => {
    await setState("SANDBOX_ONLY");
    const e = await errOf(() => admin.query(migrationText));
    await setState("PAYMENTS_DISABLED");
    const col = (await admin.query("SELECT 1 FROM information_schema.columns WHERE table_name='commercial_licences' AND column_name='provenance'")).rowCount;
    return e?.code === "P0001" && /^PREFLIGHT_REFUSED: payments must be disabled/.test(e.message) && col === 0 ? true : { e: e?.message, col };
  });
  await check("with payments disabled it applies; a second application is refused; every later migration applies", async () => {
    await applyMigration(MIGRATION);
    const again = await errOf(() => admin.query(migrationText));
    if (!/^PREFLIGHT_REFUSED: sandbox licence isolation is already in force/.test(again?.message ?? "")) return again?.message ?? "not refused";
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return true;
  });

  group("Backfill · provenance only from authoritative records; nothing deleted, no payment touched");
  await check("each licence is classified from its own records", async () => {
    const got = {
      leak: (await prov(leakLicence)).provenance, victimSandbox: (await prov(victimSandbox)).provenance, victimTerm: (await prov(victimTerm)).provenance,
      paid: (await prov(paidLicence)).provenance, manual: (await prov(manualLicence)).provenance, placed: (await prov(placedLicence)).provenance,
      orphan: (await prov(orphanLicence)).provenance, nullEnv: (await prov(nullEnvLicence)).provenance,
    };
    const want = { leak: "SANDBOX_PAYMENT", victimSandbox: "SANDBOX_PAYMENT", victimTerm: "MANUAL_GRANT", paid: "PRODUCTION_PAYMENT", manual: "MANUAL_GRANT",
      placed: "PRODUCTION_PAYMENT", orphan: "REVIEW_REQUIRED", nullEnv: "REVIEW_REQUIRED" };
    return JSON.stringify(got) === JSON.stringify(want) ? true : got;
  });
  await check("ambiguous records are not assumed production: each REVIEW_REQUIRED row says why", async () => {
    const o = (await prov(orphanLicence)).provenance_evidence.basis, n = (await prov(nullEnvLicence)).provenance_evidence.basis;
    return /no PAYMENT_CONFIRMED event or placement record/.test(o) && /no recorded provider_environment/.test(n) ? true : { o, n };
  });
  await check("no licence deleted; every payment event and checkout intent byte-identical; earlier audit rows untouched", async () => {
    const n = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences")).rows[0].n;
    const p = (await admin.query(ADMIN_TABLES)).rows[0].h;
    const a = (await admin.query("SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY a.id)) h FROM public.billing_audit_events a WHERE a.action <> 'SANDBOX_LICENCE_CONTAINED'")).rows[0].h;
    return n === licencesBefore && p === paymentsBefore && a === auditBefore.h ? true : { n, licencesBefore, payments: p === paymentsBefore, audit: a === auditBefore.h };
  });

  group("Containment · audited; the sandbox licences stop granting (the ba803893 procedure)");
  await check("each sandbox licence is SANDBOX, with dates unchanged, and one SANDBOX_LICENCE_CONTAINED row (system actor, previous and new state)", async () => {
    const rows = await audit("SANDBOX_LICENCE_CONTAINED");
    const forLeak = rows.find((r) => r.new_state.licence_id === leakLicence);
    const l = (await lic(leak))[0];
    return (await prov(leakLicence)).status === "SANDBOX" && rows.length === 2 && forLeak && forLeak.actor_user_id === null
      && forLeak.previous_state.status === "ACTIVE" && forLeak.new_state.status === "SANDBOX" && l.id === leakLicence ? true : { rows: rows.length, forLeak };
  });
  await check("the sandbox buyer now has no access through any consumer, and create_entity refuses", async () => {
    const a = await access(leak); const c = await tryCreate(leak);
    return NO_ACCESS(a) && c !== "created" ? true : { a, c };
  });
  await check("the containment names the genuine term the sandbox upgrade ended", async () => {
    const r = (await audit("SANDBOX_LICENCE_CONTAINED")).find((x) => x.new_state.licence_id === victimSandbox);
    return r?.new_state.ended_production_licence_id === victimTerm ? true : r?.new_state;
  });
  await check("the review lists it; restoring returns the term to the end its own grant recorded, once, audited", async () => {
    const list = await asAdmin("SELECT public.admin_list_licence_provenance_review() r");
    const listed = list.terms_ended_by_sandbox.some((t) => t.ended_licence_id === victimTerm && !t.restored);
    const r = await asAdmin("SELECT public.admin_restore_term_ended_by_sandbox($1,'restore the term the sandbox upgrade ended') r", [victimTerm]);
    const again = await errOf(() => asAdmin("SELECT public.admin_restore_term_ended_by_sandbox($1,'second attempt at restoring') r", [victimTerm]));
    const t = (await lic(victim)).find((l) => l.id === victimTerm);
    const a = await access(victim);
    return listed && r.restored && sameInstant(t.effective_end, victimOriginalEnd) && /TERM_ALREADY_RESTORED/.test(again?.message ?? "")
      && (await audit("TERM_RESTORED_AFTER_SANDBOX")).length === 1 && a.summary === "ACTIVE" && a.plan === "PRACTICE" ? true : { listed, r, t, again: again?.message, a };
  });

  // ════ THE INVARIANT ═══════════════════════════════════════════════════════════════════════════════════════════════
  group("Invariant · a sandbox settlement cannot unlock production access");
  const fresh = await account("fresh-sandbox");
  let freshI, freshLicence;
  await check("a new sandbox payment records a SANDBOX licence (provenance SANDBOX_PAYMENT) and grants nothing anywhere", async () => {
    freshI = await buy(fresh, "FIRM", "sandbox");
    const c = await commit(freshI);
    freshLicence = c.licence_id;
    const a = await access(fresh); const created = await tryCreate(fresh); const p = await prov(c.licence_id);
    return c.status === "COMMITTED" && c.grants_access === false && c.placement === "SANDBOX_RECORD" && p.status === "SANDBOX" && p.provenance === "SANDBOX_PAYMENT"
      && NO_ACCESS(a) && created !== "created" ? true : { c, a, created, p };
  });
  await check("the order status says so: provider_environment sandbox, grants_access false", async () => {
    const s = await as(fresh, "SELECT public.get_checkout_status($1) r", [freshI.ref]);
    return s.provider_environment === "sandbox" && s.grants_access === false && s.purchased_licence_status === "SANDBOX" ? true : s;
  });
  const holder = await account("production-holder");
  await check("a sandbox upgrade, renewal or downgrade never changes a genuine term", async () => {
    const term = await asAdmin("SELECT public.admin_grant_commercial_licence($1,'PRACTICE',now() - interval '30 days', now() + interval '335 days','holder term') r", [holder.bc]);
    const before = JSON.stringify((await lic(holder)).filter((l) => l.id === term.licence_id));
    for (const plan of ["FIRM", "PRACTICE", "SOLO"]) { const i = await buy(holder, plan, "sandbox"); const c = await commit(i); if (c.placement !== "SANDBOX_RECORD") return c; }
    const after = JSON.stringify((await lic(holder)).filter((l) => l.id === term.licence_id));
    const a = await access(holder);
    return before === after && a.plan === "PRACTICE" ? true : { before, after, a };
  });

  group("Invariant · no platform state and no direct write revives sandbox access");
  await check("every platform state leaves the sandbox buyer without access", async () => {
    for (const s of ["SANDBOX_ONLY", "LIVE_ACCEPTANCE", "CUSTOMER_PAYMENTS_ENABLED", "PAYMENTS_DISABLED"]) {
      await setState(s);
      const a = await access(fresh);
      if (!NO_ACCESS(a)) return { s, a };
    }
    return true;
  });
  await check("a sandbox licence cannot be made ACTIVE, GRACE or PENDING — not by the service role, not by the table owner, not by the status RPC", async () => {
    const svc = await errOf(() => q(SERVICE, "UPDATE public.commercial_licences SET status='ACTIVE' WHERE id=$1", [freshLicence]));
    const own = await errOf(() => admin.query("UPDATE public.commercial_licences SET status='GRACE' WHERE id=$1", [freshLicence]));
    const pend = await errOf(() => admin.query("UPDATE public.commercial_licences SET status='PENDING' WHERE id=$1", [freshLicence]));
    const rpc = await errOf(() => asAdmin("SELECT public.admin_transition_licence_status($1,'ACTIVE','revive') r", [freshLicence]));
    const reclass = await errOf(() => admin.query("UPDATE public.commercial_licences SET provenance='PRODUCTION_PAYMENT', status='ACTIVE' WHERE id=$1", [freshLicence]));
    const fake = await errOf(() => admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end, provenance) VALUES ($1,$2,'ACTIVE','POLAR_VERIFIED_PAYMENT',now(),now()+interval '1 year','SANDBOX_PAYMENT')", [fresh.bc, PLAN.FIRM]));
    const all = [svc, own, pend, rpc, reclass, fake];
    return all.every((e) => e) && NO_ACCESS(await access(fresh)) && (await prov(freshLicence)).status === "SANDBOX" ? true : all.map((e) => e?.message ?? null);
  });

  group("Production and manual terms remain intact");
  await check("a genuine production purchase still grants exactly as before (PRODUCTION_PAYMENT, ACTIVE)", async () => {
    const p = await account("prod-new");
    const i = await buy(p, "SOLO", "production"); const c = await commit(i);
    const a = await access(p); const pv = await prov(c.licence_id);
    await setState("PAYMENTS_DISABLED");
    return c.grants_access === true && pv.provenance === "PRODUCTION_PAYMENT" && pv.status === "ACTIVE" && a.summary === "ACTIVE" && a.plan === "SOLO" ? true : { c, a, pv };
  });
  await check("the earlier production purchase, manual grant and administrator placement are unchanged and still grant", async () => {
    const r = [await access(paid), await access(manual)];
    const pl = (await lic(placed)).find((l) => l.id === placedLicence);
    return r[0].plan === "PRACTICE" && r[1].plan === "SOLO" && pl.status === "ACTIVE" ? true : { r, pl };
  });
  await check("a manual grant still never shortens a paid production term (PAID_TERM_WOULD_BE_SHORTENED)", async () => {
    const e = await errOf(() => asAdmin("SELECT public.admin_grant_commercial_licence($1,'FIRM',now(),NULL,'overlap the paid term') r", [paid.bc]));
    return /PAID_TERM_WOULD_BE_SHORTENED/.test(e?.message ?? "") ? true : e?.message;
  });
  await check("placing a sandbox payment that was awaiting placement records SANDBOX, never a granting term", async () => {
    const r = await asAdmin("SELECT public.admin_place_paid_licence($1, now(), 'place the test payment') r", [reviewSbI.id]);
    const p = await prov(r.licence_id);
    return p.status === "SANDBOX" && p.provenance === "SANDBOX_PAYMENT" ? true : p;
  });

  group("Lineage · duplicates, refunds and renewals keep their environment");
  await check("6 concurrent deliveries plus a replay of one sandbox payment: one event, one SANDBOX licence", async () => {
    const a = await account("dup-sandbox"); const i = await buy(a, "SOLO", "sandbox");
    await Promise.allSettled(Array.from({ length: 6 }, () => commit(i)));
    const replay = await commit(i);
    const ev = (await admin.query("SELECT licence_id FROM public.payment_events WHERE checkout_intent_id=$1", [i.id])).rows;
    const ls = await lic(a);
    return ev.length === 1 && ls.length === 1 && ls[0].status === "SANDBOX" && replay.status === "ALREADY_COMMITTED" ? true : { ev, ls, replay };
  });
  await check("a refund of a sandbox payment is recorded against it and leaves the licence SANDBOX; a production refund leaves its licence PRODUCTION and ACTIVE", async () => {
    const ev = async (i) => (await admin.query("SELECT id FROM public.payment_events WHERE checkout_intent_id=$1 AND event_type='PAYMENT_CONFIRMED'", [i.id])).rows[0].id;
    const refund = (eventId, label) => one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [eventId, `refund-${label}`, 1000, `key-refund-${label}`, "h".repeat(64)]).then((x) => x.r);
    const s = await refund(await ev(freshI), "sandbox"); const p = await refund(await ev(paidI), "production");
    const sp = await prov(freshLicence), pp = await prov(paidLicence);
    return s.status === "REVERSAL_RECORDED" && p.status === "REVERSAL_RECORDED" && sp.status === "SANDBOX" && pp.status === "ACTIVE" && pp.provenance === "PRODUCTION_PAYMENT" ? true : { s, p, sp, pp };
  });
  await check("a production renewal after sandbox purchases is placed from the genuine term's end, never from a sandbox record", async () => {
    const term = (await lic(holder)).find((l) => l.status === "ACTIVE");
    const i = await buy(holder, "PRACTICE", "production"); const c = await commit(i);
    await setState("PAYMENTS_DISABLED");
    return c.placement === "RENEWAL" && sameInstant(c.period_start, term.effective_end) && (await prov(c.licence_id)).provenance === "PRODUCTION_PAYMENT" ? true : { c, term };
  });

  group("Review · ambiguous records are resolved explicitly, by an administrator, audited");
  await check("the review lists both ambiguous licences with their evidence; it refuses anyone who is not a commercial administrator", async () => {
    const list = await asAdmin("SELECT public.admin_list_licence_provenance_review() r");
    const ids = list.review_required.map((r) => r.licence_id);
    const refused = await errOf(() => as(paid, "SELECT public.admin_list_licence_provenance_review() r"));
    return ids.includes(orphanLicence) && ids.includes(nullEnvLicence) && refused?.code === "42501" ? true : { ids, refused: refused?.message };
  });
  await check("confirmed production keeps the term; confirmed sandbox contains it at once; each resolved once, audited", async () => {
    await asAdmin("SELECT public.admin_resolve_licence_provenance($1,'PRODUCTION_PAYMENT','provider dashboard shows a live order') r", [nullEnvLicence]);
    await asAdmin("SELECT public.admin_resolve_licence_provenance($1,'SANDBOX_PAYMENT','provider dashboard shows a test order') r", [orphanLicence]);
    const again = await errOf(() => asAdmin("SELECT public.admin_resolve_licence_provenance($1,'PRODUCTION_PAYMENT','second resolution attempt') r", [orphanLicence]));
    const n = await prov(nullEnvLicence), o = await prov(orphanLicence);
    const a = (await audit("LICENCE_PROVENANCE_CONFIRMED")).length + (await audit("SANDBOX_PROVENANCE_CONFIRMED")).length;
    return n.provenance === "PRODUCTION_PAYMENT" && n.status === "ACTIVE" && o.provenance === "SANDBOX_PAYMENT" && o.status === "SANDBOX"
      && NO_ACCESS(await access(orphan)) && (await access(nullEnv)).plan === "SOLO" && /PROVENANCE_ALREADY_PROVEN/.test(again?.message ?? "") && a === 2 ? true : { n, o, again: again?.message, a };
  });

  group("Withheld services · the real reporting rollout, not a tax gate");
  await check("financial reporting stays withheld for a production buyer and for a genuine term holder who also made sandbox Firm purchases: fs_rollout_allows false; financial_statements_workspace_access disabled (a sandbox-only buyer cannot even create a company: the capacity wall refuses)", async () => {
    const out = {};
    out.sandboxOnlyCreate = await tryCreate(fresh);
    for (const [label, acct] of [["production", paid], ["holder-with-sandbox-purchases", holder]]) {
      const co = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,$2) RETURNING id", [acct.uid, `${label} reporting probe`])).rows[0].id;
      await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1,$2,'partner',now()) ON CONFLICT DO NOTHING", [co, acct.uid]).catch(() => undefined);
      const allows = (await admin.query("SELECT public.fs_rollout_allows($1) ok", [co])).rows[0].ok;
      const ws = await as(acct, "SELECT public.financial_statements_workspace_access($1) r", [co]);
      out[label] = { allows, enabled: ws?.enabled, reason: ws?.reason };
    }
    const rows = Object.entries(out).filter(([k]) => k !== "sandboxOnlyCreate").map(([, v]) => v);
    return out.sandboxOnlyCreate !== "created" && rows.length === 2 && rows.every((o) => o.allows === false && o.enabled === false) ? true : out;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
