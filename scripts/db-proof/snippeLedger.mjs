#!/usr/bin/env node
// Snippe (Tanzania mobile money, TZS) on the ONE commercial ledger — real-PostgreSQL proof on the full current migration
// chain. Embedded PostgreSQL by default (DB_PROOF_MODULES_DIR as for the other proofs); DB_PROOF_MODE=external in CI.
//
// Snippe has no ledger of its own: a Snippe payment is a payment_checkout_intents row (provider SNIPPE, TZS, market TZ)
// committed by commit_verified_commercial_payment after the Edge Function has read the payment back from Snippe (Gate B,
// supabase/functions/_shared/payments/settle.ts — proven against the adapter in providerAdapters.test.ts and through the
// real Edge Functions with a mock Snippe in scripts/e2e/paymentJourney.mjs). This proof covers what the DATABASE
// guarantees for such a payment:
//
//   Offers       no TZS price exists or is purchasable until a commercial administrator records and approves an explicit
//                amount; the amount is exactly what was entered (no conversion from USD)
//   Commit       a verified production success grants exactly one 12-month licence, source SNIPPE_VERIFIED_PAYMENT,
//                provenance PRODUCTION_PAYMENT, to that account only
//   Non-success  failed, voided and expired grant nothing and close the order; a later success for it grants nothing
//   Mismatch     amount, currency, provider or environment: refused, nothing written
//   Duplicates   concurrent deliveries and different keys converge on one event and one licence
//   Delayed      a success verified after the order's local expiry (Snippe documents up to 4 hours) still grants once
//   Polar+Snippe one open attempt per account across both providers; two separately paid orders never overlap
//   Placement    renewal, upgrade and downgrade from a Snippe payment use the same placement rule as Polar
//   Sandbox      a sandbox Snippe payment records a SANDBOX licence that grants nothing
//   Reversal     a refund recorded against a Snippe payment never changes the licence; the administrator decides once
//   Admin        a placement review is resolved by an administrator; an uncertain attempt is honoured when proven
//   Preserved    a manual grant never shortens a Snippe-paid term; paid additional users block an automatic upgrade;
//                the reporting rollout is untouched
//
// TZS AMOUNTS HERE ARE TEST FIXTURES, NOT PRICES: no TZS price is approved (owner decision, 2026-10-10).
// Mock and local only: no provider is contacted and no money moves.
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-snippe-ledger-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE snippe_ledger_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/snippe_ledger_proof`;
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
  group("Migration chain");
  await check("every current migration applies (including sandbox licence isolation, 20261031110000)", async () => {
    for (const f of migrationFiles()) await applyMigration(f);
    return true;
  });

  // ── Fixtures and calls (the real RPCs, as the real roles) ────────────────────────────────────────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const PLAN = Object.fromEntries((await admin.query("SELECT code, id FROM public.commercial_plans WHERE product_id=$1", [product])).rows.map((r) => [r.code, r.id]));
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);
  const asAdmin = (sql, p = []) => one(user(ADMIN), sql, p).then((x) => x?.r);
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  const offer = async (plan, market) => (await admin.query("SELECT co.* FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id=co.plan_id WHERE cp.code=$1 AND co.market_code=$2 AND co.billing_interval='ANNUAL' AND co.is_active ORDER BY co.created_at DESC LIMIT 1", [plan, market])).rows[0];
  /** The TZ offer as checkout would resolve it, read while customer payments are open (resolution is refused otherwise). */
  const resolveTz = async (plan) => { await setState("CUSTOMER_PAYMENTS_ENABLED"); try { return (await one(SERVICE, "SELECT public.resolve_commercial_offer($1,'ANNUAL','TZ') r", [plan])).r; } finally { await setState("PAYMENTS_DISABLED"); } };
  const publicTzs = async () => ((await one(ANON, "SELECT public.get_public_plan_prices() r")).r.offers ?? []).filter((o) => o.currency_code === "TZS");
  const attempt = async (acct, plan, provider, env) => {
    const o = provider === "SNIPPE" ? await offer(plan, "TZ") : await offer(plan, "GLOBAL");
    const ref = `SAFF-${uuid().slice(0, 12)}`;
    return (await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,$11,$12,$13,$14) r`,
      [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, provider, env, acct.uid, ref])).r;
  };
  /** A Snippe (or Polar) order whose payment request was created: the intent is PENDING with the provider's reference. */
  const order = async (acct, plan, { provider = "SNIPPE", env = "production" } = {}) => {
    await setState(env === "sandbox" ? "SANDBOX_ONLY" : "CUSTOMER_PAYMENTS_ENABLED");
    const a = await attempt(acct, plan, provider, env);
    if (a.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a)}`);
    const pref = provider === "SNIPPE" ? `pi_${uuid().replace(/-/g, "").slice(0, 12)}` : uuid();
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.intent_id, a.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.intent_id, a.creation_token, pref, `https://cfoclose.example.test/billing/payment/return?ref=${a.saff_reference}`]);
    const i = (await admin.query("SELECT * FROM public.payment_checkout_intents WHERE id=$1", [a.intent_id])).rows[0];
    await setState("PAYMENTS_DISABLED");
    return { id: i.id, ref: i.saff_reference, pref, amount: Number(i.expected_amount_minor), currency: i.currency_code, provider, env };
  };
  /** What settle.ts sends after a verified read-back: the canonical key sha256(provider:transaction:intent) is modelled by key. */
  const commit = (i, { status = "SUCCEEDED", providerStatus = "completed", amount = i.amount, currency = i.currency, provider = i.provider, env = i.env, tx = i.pref, key = `k-${i.provider}-${tx}-${i.id}` } = {}) =>
    one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,$2,$3,$4,$5,$6,$7,$8,now(),'PROVIDER_API_VERIFY',$9,$10,$11) r`,
      [i.id, provider, tx, providerStatus, status, amount, currency, "h".repeat(64), key, i.ref, env]).then((x) => x.r);
  const lic = async (acct) => (await admin.query(`SELECT l.id, cp.code, l.status, l.source, l.provenance, l.effective_start, l.effective_end, l.additional_seats
      FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.effective_start, l.created_at`, [acct.bc])).rows;
  const intent = async (i) => (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0].status;
  const events = async (i) => (await admin.query("SELECT event_type, licence_id FROM public.payment_events WHERE checkout_intent_id=$1 ORDER BY recorded_at, id", [i.id])).rows;
  const plan = async (acct) => (await one(SERVICE, "SELECT public._account_current_plan_code($1) r", [acct.uid])).r;
  const FP = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(l)::text,'|' ORDER BY l.id) FROM public.commercial_licences l),'')
      || coalesce((SELECT string_agg(to_jsonb(e)::text,'|' ORDER BY e.id) FROM public.payment_events e),'')
      || coalesce((SELECT string_agg(to_jsonb(i)::text,'|' ORDER BY i.id) FROM public.payment_checkout_intents i),'')) AS h`;
  const fp = async () => (await admin.query(FP)).rows[0].h;

  // ════ Offers ════════════════════════════════════════════════════════════════════════════════════════════════════
  group("Offers · no TZS price unless an administrator records and approves one");
  // The replayed migration chain creates no TZS offer. (The hosted database also carries two legacy, NON-purchasable TZS
  // rows under plan PAID; release gates report historical rows and refuse only purchasable ones — p4HostedBaseline.mjs.)
  await check("the migration chain itself creates no TZS offer: the TZ market resolves to nothing for every plan, and the public price list has no TZS", async () => {
    const n = (await admin.query("SELECT count(*)::int n FROM public.commercial_offers WHERE currency_code='TZS' OR market_code='TZ'")).rows[0].n;
    const r = await Promise.all(["SOLO", "PRACTICE", "FIRM"].map(resolveTz));
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const pub = await publicTzs();
    await setState("PAYMENTS_DISABLED");
    return n === 0 && r.every((x) => x.resolution !== "AVAILABLE") && pub.length === 0 ? true : { n, r, pub };
  });
  await check("an administrator records a TZS price (TEST FIXTURE amounts) as NOT approved: still unavailable and never public", async () => {
    for (const [p, amount] of [["SOLO", 1_000_000], ["PRACTICE", 2_000_000], ["FIRM", 3_000_000]]) {
      await asAdmin("SELECT public.admin_upsert_commercial_offer($1,$2,'TZ','TZS',$3,0::smallint,'ANNUAL',1::smallint,true,false,'test fixture, not a price') r", [`CFOCLOSE_${p}_TZ_TZS_ANNUAL`, p, amount]);
    }
    const r = await resolveTz("SOLO");
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const pub = await publicTzs();
    await setState("PAYMENTS_DISABLED");
    return r.resolution !== "AVAILABLE" && pub.length === 0 ? true : { r, pub };
  });
  await check("a non-administrator cannot record or approve a TZS price (42501)", async () => {
    const someone = await account("someone");
    const e = await errOf(() => one(user(someone.uid), "SELECT public.admin_upsert_commercial_offer('CFOCLOSE_SOLO_TZ_TZS_ANNUAL','SOLO','TZ','TZS',1,0::smallint,'ANNUAL',1::smallint,true,true,'x') r"));
    return e?.code === "42501" ? true : e?.message ?? "accepted";
  });
  await check("approved by the administrator, each TZS amount is exactly what was entered (whole shillings, exponent 0; no conversion), with an audited reason", async () => {
    for (const p of ["SOLO", "PRACTICE", "FIRM"]) {
      const o = await offer(p, "TZ");
      await asAdmin("SELECT public.admin_upsert_commercial_offer($1,$2,'TZ','TZS',$3,0::smallint,'ANNUAL',1::smallint,true,true,'approved for the proof') r", [o.offer_code, p, o.amount_minor]);
    }
    const r = await resolveTz("SOLO");
    const tz = await Promise.all(["SOLO", "PRACTICE", "FIRM"].map((p) => offer(p, "TZ")));
    return r.resolution === "AVAILABLE" && tz.map((o) => [Number(o.amount_minor), o.currency_exponent, o.is_purchasable]).join() === "1000000,0,true,2000000,0,true,3000000,0,true" ? true : { r, tz };
  });

  // ════ Commit ════════════════════════════════════════════════════════════════════════════════════════════════════
  group("Commit · a verified Snippe success grants exactly one licence to the right account");
  const buyer = await account("buyer");
  const bystander = await account("bystander");
  let buyerOrder;
  await check("a verified production success: one ACTIVE 12-month SOLO licence, source SNIPPE_VERIFIED_PAYMENT, provenance PRODUCTION_PAYMENT; the bystander gets nothing", async () => {
    buyerOrder = await order(buyer, "SOLO");
    const r = await commit(buyerOrder);
    const ls = await lic(buyer);
    const ev = await events(buyerOrder);
    return r.status === "COMMITTED" && ls.length === 1 && ls[0].status === "ACTIVE" && ls[0].source === "SNIPPE_VERIFIED_PAYMENT" && ls[0].provenance === "PRODUCTION_PAYMENT"
      && sameInstant(ls[0].effective_end, addMonths(ls[0].effective_start, 12)) && ev.filter((e) => e.event_type === "PAYMENT_CONFIRMED").length === 1
      && await intent(buyerOrder) === "SUCCEEDED" && await plan(buyer) === "SOLO" && (await lic(bystander)).length === 0 && await plan(bystander) === null ? true : { r, ls, ev };
  });

  group("Non-success · failed, voided and expired grant nothing");
  for (const [status, providerStatus, closes] of [["FAILED", "failed", "FAILED"], ["CANCELLED", "voided", "CANCELLED"], ["EXPIRED", "expired", "EXPIRED"]]) {
    await check(`Snippe ${providerStatus}: recorded once, the order closes ${closes}, no licence; a later "success" for the same order grants nothing and is recorded once for recovery`, async () => {
      const a = await account(`ns-${providerStatus}`);
      const i = await order(a, "SOLO");
      const r = await commit(i, { status, providerStatus });
      const late = await commit(i, { tx: `${i.pref}-late` });
      return r.status === "NON_SUCCESS_RECORDED" && await intent(i) === closes && late.status === "RECOVERY_REQUIRED" && late.reason === "PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS"
        && (await lic(a)).length === 0 && await plan(a) === null ? true : { r, late };
    });
  }

  group("Mismatch · amount, currency, provider or environment: refused, nothing written");
  for (const [label, over, rx] of [["one shilling short", { amount: 999_999 }, /amount mismatch/], ["USD instead of TZS", { currency: "USD" }, /currency mismatch/],
    ["reported as a Polar payment", { provider: "POLAR" }, /provider mismatch/], ["verified in the sandbox", { env: "sandbox" }, /environment mismatch/]]) {
    await check(`${label}: refused (Iron Dome), every licence, event and order unchanged`, async () => {
      const a = await account(`mm-${label.split(" ")[0]}`);
      const i = await order(a, "SOLO");
      const before = await fp();
      const e = await errOf(() => commit(i, over));
      return rx.test(e?.message ?? "") && before === await fp() && await intent(i) === "PENDING" ? true : e?.message ?? "accepted";
    });
  }

  group("Duplicates · concurrent deliveries converge");
  await check("8 concurrent commits under one key, plus 4 under different keys (webhook retries, recovery): one event, one licence", async () => {
    const a = await account("dup");
    const i = await order(a, "PRACTICE");
    const rs = await Promise.allSettled([...Array.from({ length: 8 }, () => commit(i)), ...Array.from({ length: 4 }, (_, k) => commit(i, { key: `other-${k}-${i.id}` }))]);
    const ok = rs.filter((x) => x.status === "fulfilled").map((x) => x.value);
    const ev = (await events(i)).filter((e) => e.event_type === "PAYMENT_CONFIRMED");
    return ok.filter((r) => r.committed === true).length === 1 && ev.length === 1 && (await lic(a)).length === 1 ? true : { st: ok.map((r) => r.status), rejected: rs.filter((x) => x.status === "rejected").length, ev: ev.length };
  });

  group("Delayed · a success verified after the order's local expiry");
  await check("the order passed its 1-hour local expiry and a new attempt was blocked without writing (20261105100000: the order stays PENDING); the payment then completes (Snippe allows up to 4 hours): one licence; another transaction for the order is never applied as a licence (it is recorded for recovery)", async () => {
    const a = await account("delayed");
    const i = await order(a, "SOLO");
    await admin.query("UPDATE public.payment_checkout_intents SET expires_at = now() - interval '2 hours' WHERE id=$1", [i.id]);
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const blocked = await attempt(a, "SOLO", "SNIPPE", "production");
    await setState("PAYMENTS_DISABLED");
    const stillOpen = (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0].status;
    const r = await commit(i);
    const other = await commit(i, { tx: `${i.pref}-second` });
    return blocked.action === "OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT" && stillOpen === "PENDING" && r.committed === true && other.status === "RECOVERY_REQUIRED" && other.licence_id === null && (await lic(a)).length === 1 ? true : { blocked, stillOpen, r, other };
  });

  group("Polar and Snippe · one account, both providers");
  await check("12 concurrent attempts alternating Polar (USD) and Snippe (TZS) for one account: exactly one new attempt", async () => {
    const a = await account("both");
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const rs = await Promise.all(Array.from({ length: 12 }, (_, k) => attempt(a, "SOLO", k % 2 ? "POLAR" : "SNIPPE", "production")));
    await setState("PAYMENTS_DISABLED");
    const open = (await admin.query("SELECT count(*)::int n FROM public.payment_checkout_intents WHERE billing_customer_id=$1", [a.bc])).rows[0].n;
    return rs.filter((r) => r.action === "NEW_ATTEMPT").length === 1 && open === 1 ? true : { actions: rs.map((r) => r.action), open };
  });
  await check("a Snippe prompt is outstanding when the customer tries Polar: no second payment starts (20261105100000: the Snippe order stays PENDING, nothing is written); its payment still settles once", async () => {
    const a = await account("switch");
    const i = await order(a, "SOLO");
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const polar = await attempt(a, "SOLO", "POLAR", "production");
    await setState("PAYMENTS_DISABLED");
    const stillOpen = (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0].status;
    const r = await commit(i);
    const polarIntents = (await admin.query("SELECT count(*)::int n FROM public.payment_checkout_intents WHERE billing_customer_id=$1 AND provider='POLAR'", [a.bc])).rows[0].n;
    return polar.action === "OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT" && stillOpen === "PENDING" && polarIntents === 0 && r.committed === true && (await lic(a)).length === 1 ? true : { polar, stillOpen, r, polarIntents };
  });
  await check("a Polar term paid, then a Snippe payment for the same plan: the second term starts exactly when the first ends (two paid terms, never overlapping)", async () => {
    const a = await account("sequence");
    const p = await order(a, "SOLO", { provider: "POLAR" });
    await commit(p);
    const s = await order(a, "SOLO");
    const r = await commit(s);
    const ls = await lic(a);
    return r.placement === "RENEWAL" && ls.length === 2 && ls[0].source === "POLAR_VERIFIED_PAYMENT" && ls[1].source === "SNIPPE_VERIFIED_PAYMENT"
      && sameInstant(ls[1].effective_start, ls[0].effective_end) && sameInstant(ls[1].effective_end, addMonths(ls[0].effective_end, 12)) ? true : { r, ls };
  });

  group("Placement · renewal, upgrade and downgrade from Snippe payments");
  await check("renewal: a second Snippe SOLO payment starts when the first term ends", async () => {
    const a = await account("renew");
    await commit(await order(a, "SOLO"));
    const r = await commit(await order(a, "SOLO"));
    const ls = await lic(a);
    return r.placement === "RENEWAL" && ls.length === 2 && sameInstant(ls[1].effective_start, ls[0].effective_end) ? true : { r, ls };
  });
  await check("upgrade: Solo → Firm by Snippe starts Firm now and ends Solo now", async () => {
    const a = await account("upgrade");
    await commit(await order(a, "SOLO"));
    const r = await commit(await order(a, "FIRM"));
    const ls = await lic(a);
    const solo = ls.find((l) => l.code === "SOLO"), firm = ls.find((l) => l.code === "FIRM");
    return r.placement === "UPGRADE" && sameInstant(solo.effective_end, firm.effective_start) && await plan(a) === "FIRM" ? true : { r, ls };
  });
  await check("downgrade: Firm → Solo by Snippe keeps Firm to its end; Solo starts then", async () => {
    const a = await account("downgrade");
    await commit(await order(a, "FIRM"));
    const r = await commit(await order(a, "SOLO"));
    const ls = await lic(a);
    const firm = ls.find((l) => l.code === "FIRM"), solo = ls.find((l) => l.code === "SOLO");
    return r.placement === "AT_RENEWAL" && sameInstant(solo.effective_start, firm.effective_end) && await plan(a) === "FIRM" ? true : { r, ls };
  });

  group("Sandbox · a test Snippe payment grants nothing");
  await check("a verified sandbox Snippe payment records a SANDBOX licence (provenance SANDBOX_PAYMENT); no plan, and an existing paid term is untouched", async () => {
    const a = await account("sandbox");
    const paid = await order(a, "SOLO");
    await commit(paid);
    const before = JSON.stringify(await lic(a));
    const sb = await order(a, "FIRM", { env: "sandbox" });
    const r = await commit(sb);
    const ls = await lic(a);
    const s = ls.find((l) => l.code === "FIRM");
    return s?.status === "SANDBOX" && s.provenance === "SANDBOX_PAYMENT" && await plan(a) === "SOLO" && JSON.stringify(ls.filter((l) => l.code === "SOLO")) === JSON.stringify(JSON.parse(before)) ? true : { r, ls };
  });

  group("Reversal · recorded for review, never silent");
  await check("a refund recorded against a Snippe payment leaves the licence ACTIVE; a replay records nothing; the administrator decides once, with a reason", async () => {
    const a = await account("refund");
    const i = await order(a, "SOLO");
    const c = await commit(i);
    const rv = await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','SNIPPE',$2,$3,'TZS',$4,$5) r", [c.event_id, `refund-${i.pref}`, i.amount, `refund-key-${i.pref}`, "r".repeat(64)]);
    const replay = await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','SNIPPE',$2,$3,'TZS',$4,$5) r", [c.event_id, `refund-${i.pref}`, i.amount, `refund-key-${i.pref}`, "r".repeat(64)]);
    const still = (await lic(a))[0].status;
    await asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_KEPT','refund agreed; term honoured') r", [rv.r.event_id]);
    const twice = await errOf(() => asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_ENDED','x') r", [rv.r.event_id]));
    // A reversal row names the original payment event (metadata.original_event_id), not the order.
    const refunds = (await admin.query("SELECT count(*)::int n FROM public.payment_events WHERE event_type='REFUND' AND metadata->>'original_event_id'=$1", [c.event_id])).rows[0].n;
    return rv.r.status === "REVERSAL_RECORDED" && replay.r.status !== "REVERSAL_RECORDED" && still === "ACTIVE" && refunds === 1 && twice ? true : { rv: rv.r, replay: replay.r, still, refunds };
  });
  await check("no Snippe refund reaches the ledger by itself (Snippe documents no refund API or event; the adapter reports none): a later read-back of a paid order leaves its term and payment events exactly as they were", async () => {
    const a = await account("refund-none");
    const i = await order(a, "SOLO");
    await commit(i);
    const before = JSON.stringify({ l: await lic(a), e: await events(i) });
    const replay = await commit(i);
    return replay.committed === false && JSON.stringify({ l: await lic(a), e: await events(i) }) === before ? true : replay;
  });

  group("Administrator resolution");
  await check("a Snippe payment over an open-ended agreement is recorded once and waits for review; the administrator places the term", async () => {
    const a = await account("review");
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end) VALUES ($1,$2,'ACTIVE','MANUAL_ADMIN_GRANT',now() - interval '5 days',NULL)", [a.bc, PLAN.SOLO]);
    const i = await order(a, "FIRM");
    const r = await commit(i);
    await admin.query("UPDATE public.commercial_licences SET effective_end = now() + interval '1 hour' WHERE billing_customer_id=$1 AND effective_end IS NULL", [a.bc]);
    const placed = await asAdmin("SELECT public.admin_place_paid_licence($1, now() + interval '2 hours', 'placed after the agreement ends') r", [i.id]);
    const firm = (await lic(a)).find((l) => l.code === "FIRM");
    return r.status === "PLACEMENT_REVIEW_REQUIRED" && placed?.licence_id && firm?.source === "SNIPPE_VERIFIED_PAYMENT" && firm.provenance === "PRODUCTION_PAYMENT"
      && sameInstant(firm.effective_end, addMonths(firm.effective_start, 12)) ? true : { r, placed, firm };
  });
  await check("an uncertain Snippe attempt (no answer when the prompt was requested: MANUAL_REVIEW) is honoured once a later read-back proves the payment", async () => {
    const a = await account("uncertain");
    await setState("CUSTOMER_PAYMENTS_ENABLED");
    const at = await attempt(a, "SOLO", "SNIPPE", "production");
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [at.intent_id, at.creation_token]);
    await one(SERVICE, "SELECT public.mark_checkout_attempt_uncertain($1,$2,$3) r", [at.intent_id, at.creation_token, "SNIPPE_TIMEOUT"]);
    await setState("PAYMENTS_DISABLED");
    const st = (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [at.intent_id])).rows[0].status;
    const i = { id: at.intent_id, ref: at.saff_reference, pref: `pi_${uuid().slice(0, 12)}`, amount: 1_000_000, currency: "TZS", provider: "SNIPPE", env: "production" };
    const r = await commit(i);
    return st === "MANUAL_REVIEW" && r.committed === true && (await lic(a)).length === 1 ? true : { st, r };
  });

  group("Preserved · existing paid terms and restrictions");
  await check("a manual grant overlapping a Snippe-paid term is refused (PAID_TERM_WOULD_BE_SHORTENED) and changes nothing", async () => {
    const a = await account("protect");
    await commit(await order(a, "SOLO"));
    const before = JSON.stringify(await lic(a));
    const e = await errOf(() => asAdmin("SELECT public.admin_grant_commercial_licence($1,'FIRM',now() + interval '30 days',NULL,'overlap the paid term') r", [a.bc]));
    return /PAID_TERM_WOULD_BE_SHORTENED/.test(e?.message ?? "") && JSON.stringify(await lic(a)) === before ? true : e?.message ?? "accepted";
  });
  await check("a Snippe upgrade over a term with paid additional users is not placed automatically (BLOCKED_SEATS review); the users keep their seats", async () => {
    const a = await account("seats");
    const first = (await commit(await order(a, "PRACTICE"))).licence_id;
    await admin.query("UPDATE public.commercial_licences SET additional_seats=3 WHERE id=$1", [first]);
    const i = await order(a, "FIRM");
    const r = await commit(i);
    const ls = await lic(a);
    return r.status === "PLACEMENT_REVIEW_REQUIRED" && r.placement === "BLOCKED_SEATS" && ls.length === 1 && ls[0].additional_seats === 3 && await intent(i) === "MANUAL_REVIEW" ? true : { r, ls };
  });
  await check("Snippe purchases never open the financial-reporting pilot: the rollout tables are byte-identical and a buyer's company stays outside it", async () => {
    const ROLLOUT = "SELECT md5(coalesce((SELECT string_agg(to_jsonb(s)::text, '|') FROM public.financial_statements_rollout_state s), '') || coalesce((SELECT string_agg(to_jsonb(c)::text, '|' ORDER BY c.company_id) FROM public.financial_statements_rollout_companies c), '')) AS h";
    const a = await account("rollout");
    const before = (await admin.query(ROLLOUT)).rows[0].h;
    await commit(await order(a, "FIRM"));
    const co = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Rollout Co') RETURNING id", [a.uid])).rows[0].id;
    const allowed = (await admin.query("SELECT public.fs_rollout_allows($1) AS ok", [co])).rows[0].ok;
    return allowed === false && (await admin.query(ROLLOUT)).rows[0].h === before ? true : { allowed };
  });
  await check("the bystander account was never touched by any of the above", async () => (await lic(bystander)).length === 0 && await plan(bystander) === null ? true : await lic(bystander));

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED  [${f.group}] ${f.name}`);
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
