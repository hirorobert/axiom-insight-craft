#!/usr/bin/env node
// Real-PostgreSQL proof of paid-term preservation (20261030100000_paid_term_seat_preservation.sql, batch commercial-p2)
// on top of the payment authority (20261029100000). Expected results are written from the requirement — an existing
// paid term is never shortened unintentionally and unrelated entitlements stay intact — not from the implementation:
//
//   Gate        refused unless payments are disabled; a second application is refused; nothing changes when refused;
//   Seats       an upgrade over a term with additional named users is recorded once for review, grants nothing, and
//               leaves that term, its seats, its end and the account's overrides untouched; an upgrade without seats
//               still applies at once;
//   Renewal     renewal and downgrade start exactly when the current term ends and report its additional named users;
//               the current term keeps its seats and end;
//   Retries     every placement converges under 6 concurrent deliveries and a replay: one payment event, at most one
//               licence, the earlier term changed only by an upgrade, its seats never;
//   Manual      manual activation racing a verified payment (either order, or simultaneously) never overlaps or shortens
//               the paid term;
//   Withheld    a paid term never opens the financial-reporting pilot (rollout allow-list and kill switch unchanged);
//   Unrelated   a bystander account's licence and seats are byte-identical after every placement.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/paidTermPreservation.mjs
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
const MIGRATION = "20261030100000_paid_term_seat_preservation.sql";
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

  const FP = `SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
    SELECT 'f:'||p.oid::regprocedure::text||md5(pg_get_functiondef(p.oid)) AS x FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
    UNION ALL SELECT 'k:'||conname||':'||conrelid::regclass::text||':'||pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT 'l:'||to_jsonb(l)::text FROM public.commercial_licences l
    UNION ALL SELECT 'i:'||to_jsonb(i)::text FROM public.payment_checkout_intents i
    UNION ALL SELECT 'e:'||to_jsonb(e)::text FROM public.payment_events e
    UNION ALL SELECT 'a:'||to_jsonb(a)::text FROM public.billing_audit_events a) z`;
  const fingerprint = async () => (await admin.query(FP)).rows[0].fp;
  const migrationText = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);

  group("Gate · payments must be disabled");
  await check("with payments in SANDBOX_ONLY the migration refuses (P0001 PREFLIGHT_REFUSED) and nothing changes", async () => {
    await setState("SANDBOX_ONLY");
    const before = await fingerprint();
    const e = await errOf(() => admin.query(migrationText));
    const after = await fingerprint();
    await setState("PAYMENTS_DISABLED");
    return e?.code === "P0001" && /^PREFLIGHT_REFUSED: payments must be disabled/.test(e.message) && before === after ? true : { code: e?.code, msg: e?.message, same: before === after };
  });
  await check("with payments disabled it applies; a second application is refused by its preflight and changes nothing; every later migration applies", async () => {
    await applyMigration(MIGRATION);
    const fp = await fingerprint();
    const again = await errOf(() => admin.query(migrationText));
    if (!/^PREFLIGHT_REFUSED: paid-term seat preservation is already in force/.test(again?.message ?? "") || fp !== await fingerprint()) return again?.message ?? "re-application was not refused";
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return true;
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planRow = async (code) => (await admin.query("SELECT id, entity_capacity FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0];
  const PLAN = { SOLO: (await planRow("SOLO")).id, PRACTICE: (await planRow("PRACTICE")).id, FIRM: (await planRow("FIRM")).id };
  const offerOf = async (code) => (await admin.query("SELECT * FROM public.commercial_offers WHERE offer_code=$1", [code])).rows[0];
  const OFFER = { SOLO: await offerOf("CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL"), PRACTICE: await offerOf("CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL"), FIRM: await offerOf("CFOCLOSE_FIRM_GLOBAL_USD_ANNUAL") };
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);
  const account = async (label) => {
    const uid = await mkUser(label);
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
    return { uid, bc };
  };
  const licence = (acct, plan, start, end, source = "MANUAL_ADMIN_GRANT") => admin.query(
    "INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end) VALUES ($1,$2,'ACTIVE',$3,$4,$5) RETURNING id",
    [acct.bc, PLAN[plan], source, start, end]).then((r) => r.rows[0].id);
  // A PENDING intent whose provider checkout was durably persisted, built through the real acquisition RPCs.
  const acquire = async (acct, plan, provider = "POLAR", env = "sandbox") => {
    const o = OFFER[plan];
    const ref = `SAFF-${uuid().slice(0, 12)}`;
    const a = await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,$11,$12,$13,$14) r`,
      [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, provider, env, acct.uid, ref]);
    if (a.r.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a.r)}`);
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.r.intent_id, a.r.creation_token]);
    const p = await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.r.intent_id, a.r.creation_token, `prov-${uuid()}`, `https://checkout.example.test/${ref}`]);
    if (!p.r.persisted) throw new Error("persist failed");
    return { id: a.r.intent_id, ref, amount: Number(o.amount_minor), plan };
  };
  const commit = (intent, over = {}) => one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,$2,$3,$4,$5,$6,$7,$8,now(),'PROVIDER_API_VERIFY',$9,$10,$11) r`, [
    intent.id, over.provider ?? "POLAR", over.tx ?? `tx-${intent.ref}`, over.providerStatus ?? "paid", over.status ?? "SUCCEEDED",
    over.amount ?? intent.amount, over.currency ?? "USD", "h".repeat(64), over.key ?? `key-${intent.ref}`, intent.ref, over.env ?? "sandbox"]).then((x) => x.r);
  const intentStatus = async (id) => (await admin.query("SELECT status, metadata FROM public.payment_checkout_intents WHERE id=$1", [id])).rows[0];
  const licences = async (acct) => (await admin.query(
    "SELECT l.id, cp.code, l.status, l.source, l.effective_start, l.effective_end, l.additional_seats FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.effective_start", [acct.bc])).rows;
  const events = async (intent) => (await admin.query("SELECT event_type, licence_id, normalized_status FROM public.payment_events WHERE checkout_intent_id=$1", [intent.id])).rows;


  const withSeats = async (lic, n) => admin.query("UPDATE public.commercial_licences SET additional_seats=$2 WHERE id=$1", [lic, n]);
  const snap = async (acct) => JSON.stringify(await licences(acct));
  const OVERRIDES = "SELECT md5(coalesce(string_agg(to_jsonb(o)::text, '|' ORDER BY o.id), '')) AS o FROM public.entitlement_overrides o WHERE o.billing_customer_id = $1";
  // Unrelated entitlements: a bystander account with its own seats.
  const bystander = await account("bystander");
  const byLic = await licence(bystander, "PRACTICE", new Date(Date.now() - 10 * DAY), new Date(Date.now() + 355 * DAY));
  await withSeats(byLic, 3);
  const bystanderBefore = await snap(bystander);
  await setState("SANDBOX_ONLY");

  group("Seats · an upgrade never ends paid additional named users automatically");
  await check("Practice with 2 additional users → buying Firm: payment recorded once, no licence granted, intent in review; term, seats, end and overrides untouched", async () => {
    const a = await account("seats-upgrade");
    const end = new Date(Date.now() + 200 * DAY);
    const prac = await licence(a, "PRACTICE", new Date(Date.now() - 165 * DAY), end);
    await withSeats(prac, 2);
    await admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, granted_by, reason) VALUES ($1,'CLOSE_INSIGHTS',$2,'proof')", [a.bc, ADMIN]);
    const before = await snap(a);
    const over = (await admin.query(OVERRIDES, [a.bc])).rows[0].o;
    const i = await acquire(a, "FIRM");
    const r = await commit(i);
    const st = await intentStatus(i.id);
    const ev = await events(i);
    return r.status === "PLACEMENT_REVIEW_REQUIRED" && r.placement === "BLOCKED_SEATS" && st.status === "MANUAL_REVIEW" && ev.length === 1 && ev[0].licence_id === null
      && (await snap(a)) === before && (await admin.query(OVERRIDES, [a.bc])).rows[0].o === over ? true : { r, st, ev };
  });
  await check("the placement rule reports BLOCKED_SEATS with the seat count (checkout reads the same rule before charging)", async () => {
    const a = await account("seats-preview");
    const prac = await licence(a, "PRACTICE", new Date(Date.now() - 5 * DAY), new Date(Date.now() + 360 * DAY));
    await withSeats(prac, 4);
    const p = await one(SERVICE, "SELECT public._commercial_licence_placement($1,$2,now()) r", [a.bc, PLAN.FIRM]);
    return p.r.kind === "BLOCKED_SEATS" && Number(p.r.additional_seats) === 4 ? true : p.r;
  });
  await check("an upgrade without additional users still applies at once: Firm starts now, Solo ends then", async () => {
    const a = await account("plain-upgrade");
    const solo = await licence(a, "SOLO", new Date(Date.now() - 10 * DAY), new Date(Date.now() + 355 * DAY));
    const i = await acquire(a, "FIRM");
    const r = await commit(i);
    const ls = await licences(a);
    const s = ls.find((l) => l.id === solo); const f = ls.find((l) => l.code === "FIRM");
    return r.placement === "UPGRADE" && sameInstant(s.effective_end, f.effective_start) ? true : { r, ls };
  });

  group("Renewal and downgrade · start at the end of the current term, which keeps its seats");
  for (const [label, current, buy, kind] of [["renewal (Practice → Practice)", "PRACTICE", "PRACTICE", "RENEWAL"], ["downgrade (Firm → Practice)", "FIRM", "PRACTICE", "AT_RENEWAL"]]) {
    await check(`${label}: the new term starts exactly at the current end; the current term keeps its 3 additional users and end; the rule reports them`, async () => {
      const a = await account(`seats-${kind}`);
      const end = new Date(Date.now() + 90 * DAY);
      const cur = await licence(a, current, new Date(Date.now() - 275 * DAY), end);
      await withSeats(cur, 3);
      const preview = await one(SERVICE, "SELECT public._commercial_licence_placement($1,$2,now()) r", [a.bc, PLAN[buy]]);
      const i = await acquire(a, buy);
      const r = await commit(i);
      const ls = await licences(a);
      const c = ls.find((l) => l.id === cur); const n = ls.find((l) => l.id !== cur);
      return r.placement === kind && preview.r.kind === kind && Number(preview.r.additional_seats) === 3 && sameInstant(c.effective_end, end) && c.additional_seats === 3
        && sameInstant(n.effective_start, end) && sameInstant(n.effective_end, addMonths(end, 12)) && n.additional_seats === 0 ? true : { r, preview: preview.r, ls };
    });
  }

  group("Retries and concurrency · every placement converges");
  for (const [label, setup, buy] of [
    ["renewal", async (a) => licence(a, "SOLO", new Date(Date.now() - 300 * DAY), new Date(Date.now() + 65 * DAY)), "SOLO"],
    ["downgrade", async (a) => licence(a, "FIRM", new Date(Date.now() - 300 * DAY), new Date(Date.now() + 65 * DAY)), "SOLO"],
    ["upgrade", async (a) => licence(a, "SOLO", new Date(Date.now() - 300 * DAY), new Date(Date.now() + 65 * DAY)), "FIRM"],
    ["upgrade over seats (review)", async (a) => { const l = await licence(a, "PRACTICE", new Date(Date.now() - 300 * DAY), new Date(Date.now() + 65 * DAY)); await withSeats(l, 1); return l; }, "FIRM"],
  ]) {
    await check(`${label}: 6 concurrent deliveries plus a replay — one payment event, at most one new licence, the earlier term changed only by an upgrade, its seats never`, async () => {
      const a = await account(`race-${label.slice(0, 8)}`);
      const cur = await setup(a);
      const before = (await licences(a)).find((l) => l.id === cur);
      const i = await acquire(a, buy);
      await Promise.allSettled(Array.from({ length: 6 }, () => commit(i)));
      const replay = await commit(i);
      const ls = await licences(a);
      const ev = await events(i);
      const after = ls.find((l) => l.id === cur);
      const added = ls.filter((l) => l.id !== cur);
      const endRule = label === "upgrade" ? new Date(after.effective_end) < new Date(before.effective_end) : sameInstant(after.effective_end, before.effective_end);
      const expectAdded = label.includes("review") ? 0 : 1;
      return ev.length === 1 && added.length === expectAdded && endRule && after.additional_seats === before.additional_seats && replay.status === "ALREADY_COMMITTED"
        ? true : { ev: ev.length, added: added.length, before, after, replay };
    });
  }

  group("Manual activation racing a verified payment");
  for (const order of ["grant-first", "payment-first", "simultaneous"]) {
    await check(`${order}: no overlapping active terms, and the paid term is never shortened (a grant over it is refused)`, async () => {
      const a = await account(`manual-${order}`);
      const end = new Date(Date.now() + 30 * DAY);
      await licence(a, "SOLO", new Date(Date.now() - 335 * DAY), end);
      const i = await acquire(a, "SOLO");   // renewal: starts at `end`
      const grant = () => one(user(ADMIN), "SELECT public.admin_grant_commercial_licence($1,'FIRM',$2,NULL,'manual grant racing a payment') r", [a.bc, new Date(end.getTime() + 10 * DAY)]);
      let outcomes;
      if (order === "grant-first") outcomes = [await errOf(grant), await errOf(() => commit(i))];
      else if (order === "payment-first") outcomes = [await errOf(() => commit(i)), await errOf(grant)];
      else outcomes = await Promise.all([errOf(grant), errOf(() => commit(i))]);
      const ls = await licences(a);
      const active = ls.filter((l) => l.status === "ACTIVE");
      const far = 8.64e15;
      const overlaps = active.some((x, k) => active.some((y, m) => m > k && new Date(x.effective_start).getTime() < (y.effective_end ? new Date(y.effective_end).getTime() : far)
        && new Date(y.effective_start).getTime() < (x.effective_end ? new Date(x.effective_end).getTime() : far)));
      const paid = ls.find((l) => l.source === "POLAR_VERIFIED_PAYMENT");
      const paidIntact = !paid || sameInstant(paid.effective_end, addMonths(paid.effective_start, 12));
      const st = await intentStatus(i.id);
      return !overlaps && paidIntact && ["SUCCEEDED", "MANUAL_REVIEW"].includes(st.status) && (await events(i)).length === 1
        ? true : { outcomes: outcomes.map((e) => e?.message ?? null), ls, st: st.status };
    });
  }

  await check("deterministic: while the commit's per-account lock is held, a manual grant for that account waits; it completes once the lock is released", async () => {
    const a = await account("manual-lock");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [a.bc]);
      let done = false;
      const grant = one(user(ADMIN), "SELECT public.admin_grant_commercial_licence($1,'SOLO',now(),now() + interval '12 months','lock proof') r", [a.bc]).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 1500));
      const waited = !done;
      await holder.query("COMMIT");
      const r = await grant;
      return waited && r.r.licence_id ? true : { waited, r };
    } finally { holder.release(); }
  });

  group("Withheld services · a purchase never opens the financial-reporting pilot");
  await check("a company not on the reporting rollout stays outside it after a paid Firm term; the rollout tables are byte-identical", async () => {
    const a = await account("rollout");
    await licence(a, "SOLO", new Date(Date.now() - 10 * DAY), new Date(Date.now() + 355 * DAY));
    const co = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Rollout Co') RETURNING id", [a.uid])).rows[0].id;
    const ROLLOUT = "SELECT md5(coalesce((SELECT string_agg(to_jsonb(s)::text, '|') FROM public.financial_statements_rollout_state s), '') || coalesce((SELECT string_agg(to_jsonb(c)::text, '|' ORDER BY c.company_id) FROM public.financial_statements_rollout_companies c), '')) AS h";
    const before = (await admin.query(ROLLOUT)).rows[0].h;
    const allowedBefore = (await admin.query("SELECT public.fs_rollout_allows($1) AS ok", [co])).rows[0].ok;
    const i = await acquire(a, "FIRM");
    const r = await commit(i);
    const allowedAfter = (await admin.query("SELECT public.fs_rollout_allows($1) AS ok", [co])).rows[0].ok;
    return r.committed === true && allowedBefore === false && allowedAfter === false && (await admin.query(ROLLOUT)).rows[0].h === before ? true : { r, allowedBefore, allowedAfter };
  });

  group("Unrelated entitlements");
  await check("the bystander account's licence and 3 additional users are byte-identical after every placement above", async () => (await snap(bystander)) === bystanderBefore ? true : "bystander changed");

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.message ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
