#!/usr/bin/env node
// Real-PostgreSQL proof of the online-payment authority (20261029100000_payment_provider_routes.sql) on the existing
// checkout chain (acquire → begin → persist → commit). Expected results are written here independently of the
// implementation: each check states the outcome a correct payment system must produce.
//
//   Gate        the migration refuses unless payments are disabled (schema and rows byte-identical); re-runnable;
//   Providers   SNIPPE and POLAR are accepted identifiers; anything else is refused;
//   Matrix      no checkout attempt while payments are disabled; sandbox-only refuses production;
//   Commit      a verified success yields exactly one 12-month licence; replay and 8 concurrent deliveries converge on
//               one licence and one payment event; a second transaction for a paid intent is never applied;
//   Mismatch    amount, currency, provider and environment mismatches write nothing; a non-final status writes nothing;
//   Outcomes    FAILED / CANCELLED / EXPIRED close the intent exactly; a late success after a final outcome grants nothing;
//               an uncertain (manual review) attempt is honoured by a later verified success;
//   Placement   renewal after the current term; downgrade at renewal; upgrade now (current term ends); an open-ended
//               licence or an upgrade over a queued term records the payment once, grants nothing, and is placed by an
//               administrator — whose review can never discard a recorded payment;
//   Manual      manual activation never shortens a paid term; it can start where the paid term ends;
//   Reversal    a refund is recorded for review without touching the licence; the customer sees it; one review decision;
//   Isolation   another account cannot read, list or claim an order; company ownership is not administration; client
//               roles cannot commit, place or ensure; service_role cannot use administrator actions;
//   Billing     a signed-in user without a workspace gets exactly one billing record, even under concurrency;
//   Withheld    a paid licence carries only its plan's capabilities (Consolidation stays withheld); no override appears.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/paymentProviders.mjs
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
const MIGRATION = "20261029100000_payment_provider_routes.sql";
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-payments-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE payments_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/payments_proof`;
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
  await check("with payments in SANDBOX_ONLY the migration refuses (PT422 PAYMENTS_MUST_BE_DISABLED) and nothing changes", async () => {
    await setState("SANDBOX_ONLY");
    const before = await fingerprint();
    const e = await errOf(() => admin.query(migrationText));
    const after = await fingerprint();
    await setState("PAYMENTS_DISABLED");
    return e?.code === "PT422" && e.message === "PAYMENTS_MUST_BE_DISABLED" && before === after ? true : { code: e?.code, msg: e?.message, same: before === after };
  });
  await check("with payments disabled it applies, a second application changes nothing, and every later migration applies", async () => {
    await applyMigration(MIGRATION);
    const fp = await fingerprint();
    await applyMigration(MIGRATION);
    if (fp !== await fingerprint()) return "changed on re-application";
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
    "SELECT l.id, cp.code, l.status, l.source, l.effective_start, l.effective_end FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.effective_start", [acct.bc])).rows;
  const events = async (intent) => (await admin.query("SELECT event_type, licence_id, normalized_status FROM public.payment_events WHERE checkout_intent_id=$1", [intent.id])).rows;

  group("Providers · identifiers");
  await check("SNIPPE and POLAR are accepted on intents and offer restrictions; PAYPAL is refused (23514)", async () => {
    const okR = await errOf(() => admin.query("UPDATE public.commercial_offers SET provider_restriction='SNIPPE' WHERE id=$1", [OFFER.SOLO.id]));
    await admin.query("UPDATE public.commercial_offers SET provider_restriction=NULL WHERE id=$1", [OFFER.SOLO.id]);
    const bad = await errOf(() => admin.query("UPDATE public.commercial_offers SET provider_restriction='PAYPAL' WHERE id=$1", [OFFER.SOLO.id]));
    const def = (await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_pci_provider'")).rows[0].d;
    return okR === null && bad?.code === "23514" && def.includes("'SNIPPE'") && def.includes("'POLAR'") ? true : { okR: okR?.message, bad: bad?.code, def };
  });

  group("Matrix · platform state decides whether any checkout may start");
  await check("PAYMENTS_DISABLED: acquisition is refused and no intent is written", async () => {
    const a = await account("disabled");
    const e = await errOf(() => acquire(a, "SOLO"));
    const n = (await admin.query("SELECT count(*)::int n FROM public.payment_checkout_intents WHERE billing_customer_id=$1", [a.bc])).rows[0].n;
    return /PLATFORM_STATE_MATRIX_VIOLATION/.test(e?.message ?? "") && n === 0 ? true : { e: e?.message, n };
  });
  await setState("SANDBOX_ONLY");
  await check("SANDBOX_ONLY: a production-environment attempt is refused; a sandbox attempt proceeds", async () => {
    const a = await account("sandbox-only");
    const e = await errOf(() => acquire(a, "SOLO", "POLAR", "production"));
    const ok = await acquire(a, "SOLO", "POLAR", "sandbox");
    return /PLATFORM_STATE_MATRIX_VIOLATION/.test(e?.message ?? "") && !!ok.id ? true : e?.message;
  });

  group("Commit · one verified payment, one licence");
  await check("a verified success yields exactly one ACTIVE licence of exactly 12 months, source POLAR_VERIFIED_PAYMENT", async () => {
    const a = await account("happy");
    const i = await acquire(a, "SOLO");
    const r = await commit(i);
    const ls = await licences(a);
    return r.committed === true && r.placement === "NEW" && ls.length === 1 && ls[0].source === "POLAR_VERIFIED_PAYMENT"
      && sameInstant(ls[0].effective_end, addMonths(ls[0].effective_start, 12)) && (await intentStatus(i.id)).status === "SUCCEEDED" ? true : { r, ls };
  });
  await check("replaying the same verified delivery returns ALREADY_COMMITTED and writes nothing", async () => {
    const a = await account("replay");
    const i = await acquire(a, "SOLO");
    await commit(i);
    const before = await fingerprint();
    const r = await commit(i);
    return r.status === "ALREADY_COMMITTED" && before === await fingerprint() ? true : r;
  });
  await check("8 concurrent deliveries of the same payment (webhook retries + status recovery) converge on one licence and one event", async () => {
    const a = await account("concurrent");
    const i = await acquire(a, "PRACTICE");
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => commit(i)));
    const committed = rs.filter((x) => x.status === "fulfilled" && x.value.committed === true).length;
    const ls = await licences(a);
    const ev = await events(i);
    return committed === 1 && ls.length === 1 && ev.length === 1 ? true : { committed, ls: ls.length, ev: ev.length, rs: rs.map((x) => x.value?.status ?? x.reason?.message) };
  });
  await check("concurrent deliveries under different keys (webhook vs. recovery) still yield one licence; the other is refused as resolved", async () => {
    const a = await account("concurrent-keys");
    const i = await acquire(a, "SOLO");
    const rs = await Promise.allSettled([commit(i, { key: `k1-${i.ref}` }), commit(i, { key: `k2-${i.ref}` })]);
    const ls = await licences(a);
    const statuses = rs.map((x) => x.value?.status).sort();
    return ls.length === 1 && JSON.stringify(statuses) === JSON.stringify(["COMMITTED", "INTENT_ALREADY_RESOLVED"]) ? true : { statuses, ls: ls.length };
  });

  group("Mismatch · nothing is written");
  for (const [label, over] of [["amount", { amount: 1 }], ["currency", { currency: "TZS" }], ["provider", { provider: "SNIPPE" }], ["environment", { env: "production" }]]) {
    await check(`a ${label} mismatch raises and leaves licences, events and the intent unchanged`, async () => {
      const a = await account(`mismatch-${label}`);
      const i = await acquire(a, "SOLO");
      const before = await fingerprint();
      const e = await errOf(() => commit(i, over));
      return e !== null && before === await fingerprint() && (await intentStatus(i.id)).status === "PENDING" ? true : { e: e?.message };
    });
  }
  for (const s of ["PENDING", "UNKNOWN", "CHECKOUT_CREATED", "REFUNDED", "PARTIALLY_REFUNDED"]) {
    await check(`a non-final provider status (${s}) raises NON_FINAL_PAYMENT_STATUS and writes nothing`, async () => {
      const a = await account(`nonfinal-${s}`);
      const i = await acquire(a, "SOLO");
      const before = await fingerprint();
      const e = await errOf(() => commit(i, { status: s }));
      return e?.message === "NON_FINAL_PAYMENT_STATUS" && before === await fingerprint() ? true : e?.message;
    });
  }

  group("Outcomes · final non-success, late success, uncertain");
  for (const [s, expected] of [["FAILED", "FAILED"], ["CANCELLED", "CANCELLED"], ["EXPIRED", "EXPIRED"]]) {
    await check(`${s}: the intent closes as ${expected}, no licence; a later success for it grants nothing`, async () => {
      const a = await account(`final-${s}`);
      const i = await acquire(a, "SOLO");
      const r = await commit(i, { status: s, key: `n-${i.ref}`, tx: `n-${i.ref}` });
      const late = await commit(i, { key: `late-${i.ref}`, tx: `late-${i.ref}` });
      return r.status === "NON_SUCCESS_RECORDED" && (await intentStatus(i.id)).status === expected && late.status === "INTENT_ALREADY_RESOLVED"
        && (await licences(a)).length === 0 ? true : { r, late };
    });
  }
  await check("an uncertain attempt (MANUAL_REVIEW) is honoured when a later verification proves the payment", async () => {
    const a = await account("uncertain");
    const i = await acquire(a, "SOLO");
    await admin.query("UPDATE public.payment_checkout_intents SET status='MANUAL_REVIEW' WHERE id=$1", [i.id]);
    const r = await commit(i);
    return r.committed === true && (await licences(a)).length === 1 ? true : r;
  });
  await check("after a payment is recorded, a different provider transaction for the same intent is never applied", async () => {
    const a = await account("second-tx");
    await licence(a, "SOLO", new Date(Date.now() - DAY), null);   // open-ended → placement review keeps the intent open
    const i = await acquire(a, "SOLO");
    const r1 = await commit(i);
    const r2 = await commit(i, { tx: `other-${i.ref}`, key: `other-${i.ref}` });
    return r1.status === "PLACEMENT_REVIEW_REQUIRED" && r2.status === "INTENT_ALREADY_PAID" && (await events(i)).length === 1 ? true : { r1, r2 };
  });

  group("Placement · renewal, downgrade at renewal, upgrade now");
  await check("same plan: the new 12-month term starts exactly when the current one ends (no lost time, no overlap)", async () => {
    const a = await account("renew");
    const end = new Date(Date.now() + 40 * DAY);
    await licence(a, "PRACTICE", new Date(Date.now() - 325 * DAY), end);
    const i = await acquire(a, "PRACTICE");
    const r = await commit(i);
    const ls = await licences(a);
    return r.placement === "RENEWAL" && ls.length === 2 && sameInstant(ls[1].effective_start, end) && sameInstant(ls[1].effective_end, addMonths(end, 12))
      && sameInstant(ls[0].effective_end, end) ? true : { r, ls };
  });
  await check("downgrade (Firm → Solo): Firm keeps its full term; Solo starts when Firm ends", async () => {
    const a = await account("downgrade");
    const end = new Date(Date.now() + 100 * DAY);
    const firm = await licence(a, "FIRM", new Date(Date.now() - 265 * DAY), end);
    const i = await acquire(a, "SOLO");
    const r = await commit(i);
    const ls = await licences(a);
    const firmNow = ls.find((l) => l.id === firm);
    return r.placement === "AT_RENEWAL" && sameInstant(firmNow.effective_end, end) && ls.length === 2 && sameInstant(ls[1].effective_start, end) ? true : { r, ls };
  });
  await check("upgrade (Solo → Firm): Firm starts now and Solo ends now", async () => {
    const a = await account("upgrade");
    const solo = await licence(a, "SOLO", new Date(Date.now() - 10 * DAY), new Date(Date.now() + 355 * DAY));
    const i = await acquire(a, "FIRM");
    const r = await commit(i);
    const ls = await licences(a);
    const s = ls.find((l) => l.id === solo);
    const f = ls.find((l) => l.code === "FIRM");
    return r.placement === "UPGRADE" && sameInstant(s.effective_end, f.effective_start) && Math.abs(new Date(f.effective_start) - Date.now()) < 60_000 ? true : { r, ls };
  });
  await check("open-ended licence: the payment is recorded once, no licence is granted, the intent waits in review", async () => {
    const a = await account("open-ended");
    await licence(a, "SOLO", new Date(Date.now() - DAY), null);
    const i = await acquire(a, "PRACTICE");
    const r = await commit(i);
    const st = await intentStatus(i.id);
    const ev = await events(i);
    return r.status === "PLACEMENT_REVIEW_REQUIRED" && st.status === "MANUAL_REVIEW" && st.metadata.manual_review_reason === "PAID_LICENCE_PLACEMENT_REQUIRED"
      && ev.length === 1 && ev[0].licence_id === null && (await licences(a)).length === 1 ? true : { r, st, ev };
  });
  await check("upgrade over a queued term is not placed automatically (review), and no new checkout can start meanwhile", async () => {
    const a = await account("queued");
    const end = new Date(Date.now() + 30 * DAY);
    await licence(a, "SOLO", new Date(Date.now() - 335 * DAY), end);
    await licence(a, "SOLO", end, addMonths(end, 12));
    const i = await acquire(a, "FIRM");
    const r = await commit(i);
    const o = OFFER.SOLO;
    const again = await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,'POLAR','sandbox',$11,$12) r`,
      [a.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, a.uid, `SAFF-${uuid().slice(0, 10)}`]);
    return r.status === "PLACEMENT_REVIEW_REQUIRED" && again.r.action === "MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT" ? true : { r, again: again.r };
  });
  await check("an administrator places the recorded term; review can never cancel or fail an intent whose payment is recorded", async () => {
    const a = await account("place");
    const lic = await licence(a, "SOLO", new Date(Date.now() - DAY), null);
    const i = await acquire(a, "PRACTICE");
    await commit(i);
    const cancel = await errOf(() => one(user(ADMIN), "SELECT public.admin_resolve_manual_review_intent($1,'CONFIRMED_UNCHARGED_CANCEL','test') r", [i.id]));
    const overlap = await errOf(() => one(user(ADMIN), "SELECT public.admin_place_paid_licence($1, now(), 'test') r", [i.id]));
    await one(user(ADMIN), "SELECT public.admin_transition_licence_status($1,'EXPIRED','replaced by paid plan') r", [lic]);
    const placed = await one(user(ADMIN), "SELECT public.admin_place_paid_licence($1, now() + interval '1 minute', 'customer paid online') r", [i.id]);
    const st = await one(user(a.uid), "SELECT public.get_checkout_status($1) r", [i.ref]);
    const audit = (await admin.query("SELECT count(*)::int n FROM public.billing_audit_events WHERE action='PAID_LICENCE_PLACED' AND billing_customer_id=$1", [a.bc])).rows[0].n;
    return cancel?.message === "PAYMENT_RECORDED_FOR_INTENT" && overlap?.message === "TERM_OVERLAPS_EXISTING_LICENCE" && placed.r.placed === true
      && st.r.status === "SUCCEEDED" && st.r.purchased_plan_code === "PRACTICE" && !!st.r.purchased_licence_id && audit === 1 ? true
      : { cancel: cancel?.message, overlap: overlap?.message, placed: placed?.r, st: st?.r, audit };
  });

  group("Manual activation · never shortens a paid term");
  await check("a manual grant overlapping a paid term is refused (PAID_TERM_WOULD_BE_SHORTENED) and changes nothing", async () => {
    const a = await account("manual-vs-paid");
    const i = await acquire(a, "SOLO");
    await commit(i);
    const before = await fingerprint();
    const e = await errOf(() => one(user(ADMIN), "SELECT public.admin_grant_commercial_licence($1,'FIRM',now() + interval '1 day',NULL,'test') r", [a.bc]));
    return e?.message === "PAID_TERM_WOULD_BE_SHORTENED" && before === await fingerprint() ? true : e?.message;
  });
  await check("a manual grant starting where the paid term ends is accepted; the paid term is intact", async () => {
    const a = await account("manual-after-paid");
    const i = await acquire(a, "SOLO");
    await commit(i);
    const paid = (await licences(a))[0];
    await one(user(ADMIN), "SELECT public.admin_grant_commercial_licence($1,'FIRM',(SELECT effective_end FROM public.commercial_licences WHERE id=$2),NULL,'enterprise agreement from renewal') r", [a.bc, paid.id]);
    const after = (await licences(a)).find((l) => l.id === paid.id);
    return sameInstant(after.effective_end, paid.effective_end) && (await licences(a)).length === 2 ? true : after;
  });
  await check("a manually activated account (fixed end) paying for the same plan renews after the manual term", async () => {
    const a = await account("manual-then-paid");
    const end = new Date(Date.now() + 20 * DAY);
    await one(user(ADMIN), "SELECT public.admin_grant_commercial_licence($1,'SOLO',now() - interval '1 day',$2,'activation by agreement') r", [a.bc, end]);
    const i = await acquire(a, "SOLO");
    const r = await commit(i);
    return r.placement === "RENEWAL" && sameInstant(r.period_start, end) ? true : r;
  });

  group("Reversal · recorded for review, never silent");
  await check("a refund is recorded without touching the licence; the customer sees it; one review decision is accepted", async () => {
    const a = await account("refund");
    const i = await acquire(a, "SOLO");
    const c = await commit(i);
    const lBefore = JSON.stringify(await licences(a));
    const rv = await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [c.event_id, `refund-${i.ref}`, i.amount, `refund-key-${i.ref}`, "r".repeat(64)]);
    const replay = await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [c.event_id, `refund-${i.ref}`, i.amount, `refund-key-${i.ref}`, "r".repeat(64)]);
    const st = await one(user(a.uid), "SELECT public.get_checkout_status($1) r", [i.ref]);
    const mine = await one(user(a.uid), "SELECT public.get_my_payments() r");
    const att = await one(user(ADMIN), "SELECT public.admin_list_payment_attention() r");
    const listed = att.r.reversals.some((x) => x.event_id === rv.r.event_id);
    await one(user(ADMIN), "SELECT public.admin_record_reversal_review($1,'LICENCE_ENDED','refunded at customer request') r", [rv.r.event_id]);
    const twice = await errOf(() => one(user(ADMIN), "SELECT public.admin_record_reversal_review($1,'LICENCE_KEPT','x') r", [rv.r.event_id]));
    const att2 = await one(user(ADMIN), "SELECT public.admin_list_payment_attention() r");
    return rv.r.licence_action === "REVIEW_REQUIRED" && replay.r.status === "ALREADY_RECORDED" && lBefore === JSON.stringify(await licences(a))
      && st.r.reversal_type === "REFUND" && mine.r[0].reversal_type === "REFUND" && listed && twice?.message === "REVERSAL_ALREADY_REVIEWED"
      && !att2.r.reversals.some((x) => x.event_id === rv.r.event_id) ? true : { rv: rv.r, st: st.r.reversal_type, listed, twice: twice?.message };
  });

  group("Isolation · accounts, administration, roles");
  const A = await account("iso-a");
  const B = await account("iso-b");
  const iA = await acquire(A, "SOLO");
  await check("another account reads found:false for the order, lists none of it, and cannot claim its verification", async () => {
    const s = await one(user(B.uid), "SELECT public.get_checkout_status($1) r", [iA.ref]);
    const list = await one(user(B.uid), "SELECT public.get_my_payments() r");
    const claim = await one(SERVICE, "SELECT public.claim_verification_attempt($1,$2) r", [iA.id, B.uid]);
    return s.r.found === false && list.r.length === 0 && claim.r.claimed === false && claim.r.reason === "NOT_FOUND_OR_NOT_OWNER" ? true : { s: s.r, n: list.r.length, claim: claim.r };
  });
  await check("the owner and an active commercial administrator may claim one verification; a second claim is throttled", async () => {
    const own = await one(SERVICE, "SELECT public.claim_verification_attempt($1,$2) r", [iA.id, A.uid]);
    const adm = await one(SERVICE, "SELECT public.claim_verification_attempt($1,$2) r", [iA.id, ADMIN]);
    return own.r.claimed === true && adm.r.claimed === false && adm.r.reason === "THROTTLED" && own.r.provider_checkout_ref?.startsWith("prov-") ? true : { own: own.r, adm: adm.r };
  });
  await check("owning companies does not make an account an administrator: every admin action is refused (42501)", async () => {
    const owner = await account("company-owner");
    await licence(owner, "FIRM", new Date(Date.now() - DAY), new Date(Date.now() + 300 * DAY));
    await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Owner Co')", [owner.uid]);
    const calls = [
      ["admin_list_payment_attention", "SELECT public.admin_list_payment_attention()"],
      ["admin_find_billing_account", "SELECT public.admin_find_billing_account('x@example.test')"],
      ["admin_place_paid_licence", `SELECT public.admin_place_paid_licence('${iA.id}', now(), 'x')`],
      ["admin_record_reversal_review", `SELECT public.admin_record_reversal_review('${uuid()}', 'LICENCE_KEPT', 'x')`],
      ["admin_grant_commercial_licence", `SELECT public.admin_grant_commercial_licence('${owner.bc}','SOLO',now(),NULL,'x')`],
    ];
    const codes = [];
    for (const [n, sql] of calls) codes.push([n, (await errOf(() => q(user(owner.uid), sql)))?.code]);
    return codes.every(([, c]) => c === "42501") ? true : codes;
  });
  await check("client roles cannot execute commit, placement or billing-record creation; service_role cannot execute admin actions", async () => {
    const denied = async (caller, sql) => (await errOf(() => q(caller, sql)))?.code === "42501";
    const checks = [
      await denied(user(A.uid), `SELECT public.commit_verified_commercial_payment('${iA.id}','POLAR','t','paid','SUCCEEDED',1,'USD','h',now(),'PROVIDER_API_VERIFY','k','r','sandbox')`),
      await denied(ANON, `SELECT public._commercial_licence_placement('${A.bc}','${PLAN.SOLO}',now())`),
      await denied(user(A.uid), `SELECT public.ensure_checkout_billing_customer('${A.uid}')`),
      await denied(user(A.uid), `SELECT public.claim_verification_attempt('${iA.id}','${A.uid}')`),
      await denied(SERVICE, "SELECT public.admin_list_payment_attention()"),
      await denied(SERVICE, `SELECT public.admin_place_paid_licence('${iA.id}', now(), 'x')`),
      await denied(SERVICE, "SELECT public.admin_find_billing_account('x@example.test')"),
      await denied(ANON, "SELECT public.get_my_payments()"),
    ];
    return checks.every(Boolean) ? true : checks;
  });
  await check("an administrator finds an account by email (case-insensitive) with its licences", async () => {
    const email = (await admin.query("SELECT email FROM auth.users WHERE id=$1", [A.uid])).rows[0].email;
    const r = await one(user(ADMIN), "SELECT public.admin_find_billing_account($1) r", [email.toUpperCase()]);
    const none = await one(user(ADMIN), "SELECT public.admin_find_billing_account('nobody@example.test') r");
    return r.r.found === true && r.r.billing_customer_id === A.bc && none.r.found === false ? true : r.r;
  });

  group("Billing record · a signed-in user without a workspace");
  await check("5 concurrent checkout starts create exactly one billing record and one audit event", async () => {
    const uid = await mkUser("no-workspace");
    const rs = await Promise.all(Array.from({ length: 5 }, () => one(SERVICE, "SELECT public.ensure_checkout_billing_customer($1) r", [uid])));
    const ids = new Set(rs.map((x) => x.r));
    const n = (await admin.query("SELECT count(*)::int n FROM public.billing_customers WHERE owner_user_id=$1", [uid])).rows[0].n;
    const audit = (await admin.query("SELECT count(*)::int n FROM public.billing_audit_events a JOIN public.billing_customers b ON b.id=a.billing_customer_id WHERE b.owner_user_id=$1 AND a.action='BILLING_CUSTOMER_CREATED'", [uid])).rows[0].n;
    return ids.size === 1 && n === 1 && audit === 1 ? true : { ids: ids.size, n, audit };
  });

  group("Withheld · a paid licence carries only its plan");
  await check("after a paid Solo licence: the resolver entitles Close Assurance, not Multi-entity reporting or Consolidation; no override appears", async () => {
    const a = await account("withheld");
    const i = await acquire(a, "SOLO");
    await commit(i);
    const ent = async (cap) => (await admin.query("SELECT public._resolve_entitlement_for_owner($1,$2)->>'status' s", [a.uid, cap])).rows[0].s;
    const overrides = (await admin.query("SELECT count(*)::int n FROM public.entitlement_overrides WHERE billing_customer_id=$1", [a.bc])).rows[0].n;
    const r = { assurance: await ent("CLOSE_ASSURANCE"), multi: await ent("MULTI_ENTITY_REPORTING"), consolidation: await ent("CONSOLIDATION"), overrides };
    return r.assurance === "ENTITLED" && r.multi === "NOT_ENTITLED" && r.consolidation === "NOT_ENTITLED" && overrides === 0 ? true : r;
  });

  group("Webhook evidence · every outcome is representable, receipts are immutable");
  await check("the new processing outcomes are accepted; an unknown one is refused; receipts cannot be updated", async () => {
    const rid = (await admin.query("INSERT INTO public.payment_webhook_receipts (provider, signature_present, payload_hash) VALUES ('POLAR', true, $1) RETURNING id", ["p".repeat(64)])).rows[0].id;
    for (const r of ["DUPLICATE", "STALE_TIMESTAMP", "MERCHANT_MISMATCH", "ACCOUNT_MISMATCH", "NOT_FINAL", "IGNORED_EVENT_TYPE", "REVERSAL_RECORDED", "PLACEMENT_REVIEW"]) {
      await admin.query("INSERT INTO public.payment_webhook_processing_events (receipt_id, provider, signature_valid, processing_result) VALUES ($1,'POLAR',true,$2)", [rid, r]);
    }
    const bad = await errOf(() => admin.query("INSERT INTO public.payment_webhook_processing_events (receipt_id, provider, signature_valid, processing_result) VALUES ($1,'POLAR',true,'GRANTED')", [rid]));
    const upd = await errOf(() => admin.query("UPDATE public.payment_webhook_receipts SET provider='X' WHERE id=$1", [rid]));
    return bad?.code === "23514" && /append-only/.test(upd?.message ?? "") ? true : { bad: bad?.code, upd: upd?.message };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.message ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
