#!/usr/bin/env node
// DEFECT-VERIFIED-CHARGE-DROPPED-001 — real-PostgreSQL proof for 20261102100000_verified_charge_outcomes.sql (batch
// commercial-p5). Embedded PostgreSQL by default (DB_PROOF_MODULES_DIR as for the other proofs); DB_PROOF_MODE=external in CI.
//
//   Before       the real path — a pending Polar checkout passes CFOClose's local expiry, a new attempt sends it to review,
//                an administrator resolves it as uncharged, the still-open Polar session is paid — ends with
//                INTENT_ALREADY_RESOLVED and NOTHING recorded; a second transaction on a paid intent is dropped too
//   Late         a late payment that nothing replaced is placed by the normal rule, audited as late
//   Replacement  a payment on an older session after a replacement started, or a second transaction, is recorded once with
//                an OPEN recovery case — never a second automatic term, never lost
//   Duplicates   concurrent redeliveries under one or many keys: one event, one case
//   Race         a concurrent replacement attempt and old-session payment: always exactly one outcome
//   Resolution   PLACE_ADDITIONAL_TERM (queued after the paid time, never overlapping), REFUNDED (only when refunds cover it),
//                TEST_PAYMENT_CLOSED (sandbox); resolved once; cases permanent and their facts fixed
//   History      every earlier payment event, licence and audit row byte-identical
// Mock and local only: no provider is contacted and no money moves.
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-verified-charge-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE verified_charge_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/verified_charge_proof`;
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

const MIGRATION = "20261102100000_verified_charge_outcomes.sql";

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: 14 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);
  group("Migration chain");
  await check(`every migration before ${MIGRATION} applies`, async () => { if (cut < 0) return "missing"; for (const f of files.slice(0, cut)) await applyMigration(f); return true; });

  // ── Fixtures: the real acquisition, provider-creation, review and commit RPCs as the real roles ────────────────────
  const mkUser = async (label) => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id.slice(0, 8)}@example.test`]); return id; };
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const PLAN = Object.fromEntries((await admin.query("SELECT code, id FROM public.commercial_plans WHERE product_id=$1", [product])).rows.map((r) => [r.code, r.id]));
  await admin.query("UPDATE public.commercial_offers SET is_purchasable = true WHERE offer_code LIKE 'CFOCLOSE_%_GLOBAL_USD_ANNUAL'");
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);
  const asAdmin = (sql, p = []) => one(user(ADMIN), sql, p).then((x) => x?.r);
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  const offer = async (plan) => (await admin.query("SELECT co.* FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id=co.plan_id WHERE cp.code=$1 AND co.market_code='GLOBAL' AND co.billing_interval='ANNUAL' AND co.is_active ORDER BY co.created_at DESC LIMIT 1", [plan])).rows[0];
  const acquire = async (acct, plan, env = "production") => {
    await setState(env === "sandbox" ? "SANDBOX_ONLY" : "CUSTOMER_PAYMENTS_ENABLED");
    try {
      const o = await offer(plan);
      return (await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,'POLAR',$11,$12,$13) r`,
        [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, env, acct.uid, `SAFF-${uuid().slice(0, 12)}`])).r;
    } finally { await setState("PAYMENTS_DISABLED"); }
  };
  /** A Polar checkout session created for a new attempt: the intent is PENDING with the session id. */
  const checkout = async (acct, plan, env = "production") => {
    const a = await acquire(acct, plan, env);
    if (a.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a)}`);
    const session = uuid();
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.intent_id, a.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.intent_id, a.creation_token, session, `https://polar.example.test/checkout/${session}`]);
    const o = await offer(plan);
    return { id: a.intent_id, ref: a.saff_reference, session, amount: Number(o.amount_minor), env };
  };
  /** What settle.ts sends after reading the provider: the canonical key is sha256(provider:transaction:intent). */
  const commit = (i, { tx = `order-${i.session}`, status = "SUCCEEDED", key = null } = {}) =>
    one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,'POLAR',$2,$3,$4,$5,'USD',$6,now(),'PROVIDER_API_VERIFY',$7,$8,$9) r`,
      [i.id, tx, status === "SUCCEEDED" ? "paid" : status.toLowerCase(), status, i.amount, "h".repeat(64), key ?? crypto.createHash("sha256").update(`POLAR:${tx}:${i.id}`).digest("hex"), i.ref, i.env]).then((x) => x.r);
  /** The real path that closes an intent while its Polar session is still open: local expiry, a new attempt, review, "uncharged". */
  const closeByReview = async (acct, i, plan) => {
    await admin.query("UPDATE public.payment_checkout_intents SET expires_at = now() - interval '1 minute' WHERE id=$1", [i.id]);
    const a = await acquire(acct, plan);
    if (a.action !== "MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT") throw new Error(`expected review, got ${JSON.stringify(a)}`);
    await asAdmin("SELECT public.admin_resolve_manual_review_intent($1,'CONFIRMED_UNCHARGED_CANCEL','no payment seen when reviewed') r", [i.id]);
  };
  const lic = async (acct) => (await admin.query("SELECT l.id, cp.code, l.status, l.source, l.provenance, l.effective_start, l.effective_end FROM public.commercial_licences l JOIN public.commercial_plans cp ON cp.id=l.plan_id WHERE l.billing_customer_id=$1 ORDER BY l.effective_start, l.created_at", [acct.bc])).rows;
  const events = async (acct) => (await admin.query("SELECT id, event_type, checkout_intent_id, provider_transaction_id, licence_id, metadata FROM public.payment_events WHERE billing_customer_id=$1 ORDER BY recorded_at, id", [acct.bc])).rows;
  const status = async (i) => (await admin.query("SELECT status FROM public.payment_checkout_intents WHERE id=$1", [i.id])).rows[0].status;

  // ════ BEFORE: the defect ═════════════════════════════════════════════════════════════════════════════════════════
  group("Before the correction · a verified charge is dropped");
  await check("an intent closed by review while its Polar session stayed open is then paid: INTENT_ALREADY_RESOLVED — no payment event, no licence, nothing for anyone to act on", async () => {
    const a = await account("before-late");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const r = await commit(old);
    return r.status === "INTENT_ALREADY_RESOLVED" && r.committed === false && (await events(a)).length === 0 && (await lic(a)).length === 0 ? true : { r };
  });
  await check("a second, different successful transaction on a paid intent is refused as already resolved/paid — the second charge is not recorded", async () => {
    const a = await account("before-second");
    const i = await checkout(a, "SOLO");
    await commit(i);
    const r = await commit(i, { tx: `order-second-${i.session}` });
    return ["INTENT_ALREADY_RESOLVED", "INTENT_ALREADY_PAID"].includes(r.status) && r.committed === false && (await events(a)).length === 1 ? true : { r };
  });
  await check("discovery: a dropped charge leaves the webhook endpoint's record (processing_result DUPLICATE with the provider transaction) and no payment event — the commercial-p5 preflight lists it (read-only; it records nothing)", async () => {
    const a = await account("before-discover");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const r = await commit(old);
    // Exactly what handleProviderWebhook writes for that outcome: a receipt, then the processing event settle.ts reported.
    const rec = (await admin.query("INSERT INTO public.payment_webhook_receipts (provider, signature_present, payload_hash, provider_event_id, saff_reference, correlation_id) VALUES ('POLAR', true, $1, $2, $3, 'proof') RETURNING id", ["p".repeat(64), `wh-${old.session}`, old.ref])).rows[0].id;
    await admin.query("INSERT INTO public.payment_webhook_processing_events (receipt_id, provider, signature_valid, processing_result, provider_transaction_id, saff_reference, correlation_id) VALUES ($1,'POLAR',true,'DUPLICATE',$2,$3,'proof')", [rec, `order-${old.session}`, old.ref]);
    const out = []; const on = (n) => out.push(n.message); admin.on("notice", on);
    let sets;
    try { await admin.query("BEGIN READ ONLY"); const res = await admin.query(fs.readFileSync(path.join(REPO, "docs/release/commercial-p5/preflight.sql"), "utf8")); sets = res; } finally { await admin.query("ROLLBACK"); admin.off("notice", on); }
    const found = sets.some((x) => x.fields?.some((f) => f.name === "deliveries") && x.rows.some((row) => row.provider_transaction_id === `order-${old.session}`));
    return r.status === "INTENT_ALREADY_RESOLVED" && found && out.some((n) => /PREFLIGHT OK/.test(n)) ? true : { r, found, out };
  });
  const cutoff = (await admin.query("SELECT clock_timestamp() t")).rows[0].t;
  const HIST = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text,'|' ORDER BY e.id) FROM public.payment_events e WHERE e.recorded_at <= $1),'')
    || coalesce((SELECT string_agg(to_jsonb(l)::text,'|' ORDER BY l.id) FROM public.commercial_licences l WHERE l.created_at <= $1),'')
    || coalesce((SELECT string_agg(to_jsonb(a)::text,'|' ORDER BY a.id) FROM public.billing_audit_events a WHERE a.created_at <= $1),'')) h`;
  const histBefore = (await admin.query(HIST, [cutoff])).rows[0].h;
  await new Promise((r) => setTimeout(r, 20));

  group("The migration");
  await check("it applies; a second application is refused (PREFLIGHT_REFUSED); every later migration applies", async () => {
    await applyMigration(MIGRATION);
    const e = await errOf(() => applyMigration(MIGRATION));
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return /already in force/.test(e?.message ?? "") ? true : e?.message ?? "applied twice";
  });
  await check("history is preserved: every earlier payment event, licence and audit row is byte-identical", async () =>
    (await admin.query(HIST, [cutoff])).rows[0].h === histBefore ? true : "changed");

  // ════ AFTER ══════════════════════════════════════════════════════════════════════════════════════════════════════
  group("Late payment · nothing replaced the closed intent");
  await check("an intent closed by review is then paid, with no newer attempt: placed by the normal rule (one 12-month term), the intent becomes SUCCEEDED, audited as late", async () => {
    const a = await account("late");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const r = await commit(old);
    const ls = await lic(a);
    const audit = (await admin.query("SELECT new_state FROM public.billing_audit_events WHERE billing_customer_id=$1 AND action='LICENCE_GRANTED'", [a.bc])).rows;
    return r.status === "COMMITTED" && r.late_payment === true && ls.length === 1 && ls[0].status === "ACTIVE" && await status(old) === "SUCCEEDED"
      && audit.length === 1 && audit[0].new_state.late_payment_on_closed_intent === true && audit[0].new_state.intent_status_at_payment === "CANCELLED" ? true : { r, ls, audit };
  });
  await check("a success that contradicts a non-success the PROVIDER reported for the intent is never auto-placed: recorded once as a recovery case (PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS), no licence", async () => {
    const a = await account("contradiction");
    const i = await checkout(a, "SOLO");
    const r1 = await commit(i, { status: "FAILED", tx: `order-failed-${i.session}` });
    const r2 = await commit(i, { tx: `order-late-${i.session}` });
    return r1.status === "NON_SUCCESS_RECORDED" && r2.status === "RECOVERY_REQUIRED" && r2.reason === "PAYMENT_AFTER_PROVIDER_REPORTED_NON_SUCCESS" && (await lic(a)).length === 0 ? true : { r1, r2 };
  });
  await check("a provider-reported non-success after the intent closed records nothing (no money moved)", async () => {
    const a = await account("late-fail");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const r = await commit(old, { status: "FAILED" });
    return r.status === "INTENT_ALREADY_RESOLVED" && (await events(a)).length === 0 ? true : r;
  });

  group("Replacement · the older session paid after a replacement started");
  await check("replacement pending, then the old session is paid: recorded once as RECOVERY_REQUIRED with an OPEN case; no licence; then the replacement is paid: exactly one term", async () => {
    const a = await account("repl-pending");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const repl = await checkout(a, "SOLO");
    const r = await commit(old);
    const caseRow = (await admin.query("SELECT * FROM public.payment_recovery_cases WHERE payment_event_id=$1", [r.event_id])).rows[0];
    const noLicenceYet = (await lic(a)).length === 0;
    const r2 = await commit(repl);
    const ls = await lic(a);
    return r.status === "RECOVERY_REQUIRED" && r.reason === "PAYMENT_AFTER_REPLACEMENT_STARTED" && caseRow?.status === "OPEN" && caseRow.newer_attempt_id === repl.id
      && noLicenceYet && r2.status === "COMMITTED" && ls.length === 1 && (await events(a)).filter((e) => e.event_type === "PAYMENT_CONFIRMED").length === 2 ? true : { r, caseRow, r2, ls };
  });
  await check("replacement paid first, then the old session: one term (the replacement's); the old charge is an OPEN recovery case", async () => {
    const a = await account("repl-paid");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    const repl = await checkout(a, "SOLO");
    await commit(repl);
    const r = await commit(old);
    return r.status === "RECOVERY_REQUIRED" && (await lic(a)).length === 1 ? true : { r, ls: await lic(a) };
  });
  await check("two distinct successful transactions on one intent: the second is an OPEN recovery case (ADDITIONAL_PAYMENT_ON_PAID_INTENT); one term", async () => {
    const a = await account("two-tx");
    const i = await checkout(a, "SOLO");
    await commit(i);
    const r = await commit(i, { tx: `order-second-${i.session}` });
    return r.status === "RECOVERY_REQUIRED" && r.reason === "ADDITIONAL_PAYMENT_ON_PAID_INTENT" && (await lic(a)).length === 1 ? true : r;
  });

  group("Duplicates · one charge, one record");
  await check("8 concurrent deliveries of the old session's payment under one key, plus 4 under other keys: one payment event, one recovery case", async () => {
    const a = await account("dup");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    await checkout(a, "SOLO");
    const rs = await Promise.allSettled([...Array.from({ length: 8 }, () => commit(old)), ...Array.from({ length: 4 }, (_, k) => commit(old, { key: `other-key-${k}-${old.id}` }))]);
    const cases = (await admin.query("SELECT count(*)::int n FROM public.payment_recovery_cases WHERE checkout_intent_id=$1", [old.id])).rows[0].n;
    const evs = (await events(a)).filter((e) => e.provider_transaction_id === `order-${old.session}`).length;
    return rs.every((x) => x.status === "fulfilled") && cases === 1 && evs === 1 ? true : { rejected: rs.filter((x) => x.status === "rejected").map((x) => x.reason.message), cases, evs };
  });
  await check("a redelivery after the late payment was placed: ALREADY_COMMITTED, nothing new", async () => {
    const a = await account("dup-late");
    const old = await checkout(a, "SOLO");
    await closeByReview(a, old, "SOLO");
    await commit(old);
    const again = await commit(old, { key: "a-different-key" });
    return again.status === "ALREADY_COMMITTED" && (await lic(a)).length === 1 && (await events(a)).length === 1 ? true : again;
  });

  group("Race · a late payment and a replacement attempt at the same moment");
  await check("20 rounds of a concurrent replacement attempt and old-session payment: every charge recorded exactly once with one outcome — placed (then the attempt is a new purchase) or a recovery case (the attempt came first); never both, never neither", async () => {
    const out = [];
    for (let k = 0; k < 20; k++) {
      const a = await account(`race-${k}`);
      const old = await checkout(a, "SOLO");
      await closeByReview(a, old, "SOLO");
      await setState("CUSTOMER_PAYMENTS_ENABLED");
      const o = await offer("SOLO");
      const [acq, com] = await Promise.allSettled([
        one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,'POLAR','production',$11,$12) r`,
          [a.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, a.uid, `SAFF-${uuid().slice(0, 12)}`]),
        commit(old)]);
      await setState("PAYMENTS_DISABLED");
      const evs = (await events(a)).filter((e) => e.provider_transaction_id === `order-${old.session}`);
      const cases = (await admin.query("SELECT count(*)::int n FROM public.payment_recovery_cases WHERE checkout_intent_id=$1", [old.id])).rows[0].n;
      const placed = (await lic(a)).length;
      const outcome = com.status === "fulfilled" ? com.value.status : `error:${com.reason.message}`;
      out.push({ outcome, acq: acq.status === "fulfilled" ? acq.value.r.action : "error", evs: evs.length, cases, placed });
    }
    const ok = out.every((o) => o.evs === 1 && ((o.outcome === "COMMITTED" && o.placed === 1 && o.cases === 0) || (o.outcome === "RECOVERY_REQUIRED" && o.placed === 0 && o.cases === 1)));
    return ok ? true : out.filter((o) => !(o.evs === 1));
  });

  group("Resolution · place as an additional term, or refund");
  const openCase = async (label, { env = "production", withTerm = true } = {}) => {
    const a = await account(label);
    const i = await checkout(a, "SOLO", env);
    if (withTerm) await commit(i);
    const r = await commit(i, { tx: `order-extra-${i.session}` });
    return { a, i, caseId: r.recovery_case_id, eventId: r.event_id };
  };
  await check("PLACE_ADDITIONAL_TERM with the customer's recorded agreement: the CURRENT placement rule (same plan → RENEWAL) queues a 12-month term exactly after the paid time, never shortening or overlapping it; agreement and placement audited; resolved once", async () => {
    const { a, caseId } = await openCase("place");
    const before = await lic(a);
    const r = await asAdmin(`SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','customer keeps both purchases','the customer confirmed by email on 2026-10-13 that they want a second term') r`, [caseId]);
    const ls = await lic(a);
    const added = ls.find((l) => l.id === r.licence_id);
    const twice = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'REFUNDED','again') r", [caseId]));
    return sameInstant(added.effective_start, before[0].effective_end) && sameInstant(added.effective_end, addMonths(before[0].effective_end, 12))
      && added.provenance === "PRODUCTION_PAYMENT" && JSON.stringify(ls.find((l) => l.id === before[0].id)) === JSON.stringify(before[0])
      && r.placement === "RENEWAL" && /RECOVERY_CASE_ALREADY_RESOLVED/.test(twice?.message ?? "")
      && (await admin.query("SELECT new_state->>'customer_agreement' ca FROM public.billing_audit_events WHERE action='PAYMENT_RECOVERY_RESOLVED' AND new_state->>'recovery_case_id'=$1", [caseId])).rows[0]?.ca?.includes("confirmed by email")
      ? true : { r, ls, twice: twice?.message };
  });
  await check("a case cannot be closed without a valid outcome: an unknown resolution, a blank reason, or an additional term without the customer's agreement are refused, and the case stays OPEN (an unintended second charge never silently becomes a renewal)", async () => {
    const { caseId } = await openCase("no-outcome");
    const e1 = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'IGNORE','x') r", [caseId]));
    const e2 = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'REFUNDED',' ') r", [caseId]));
    const e3 = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','looks intended') r", [caseId]));
    const e4 = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','looks intended','yes') r", [caseId]));
    const e5 = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'TEST_PAYMENT_CLOSED','x') r", [caseId]));
    const st = (await admin.query("SELECT status FROM public.payment_recovery_cases WHERE id=$1", [caseId])).rows[0].status;
    return /UNKNOWN_RESOLUTION/.test(e1?.message ?? "") && /REASON_REQUIRED/.test(e2?.message ?? "") && /CUSTOMER_AGREEMENT_REQUIRED/.test(e3?.message ?? "")
      && /CUSTOMER_AGREEMENT_REQUIRED/.test(e4?.message ?? "") && /NOT_A_TEST_PAYMENT/.test(e5?.message ?? "") && st === "OPEN" ? true : [e1, e2, e3, e4, e5].map((e) => e?.message);
  });
  await check("paid additional named users are preserved: a second charge for a FIRM upgrade over a PRACTICE term with 3 paid users is refused by the placement rule (BLOCKED_SEATS); the term and its users are untouched", async () => {
    const a = await account("seats");
    const prac = await checkout(a, "PRACTICE");
    const p1 = await commit(prac);
    await admin.query("UPDATE public.commercial_licences SET additional_seats = 3 WHERE id=$1", [p1.licence_id]);
    const firm = await checkout(a, "FIRM");
    const f1 = await commit(firm);
    const f2 = await commit(firm, { tx: `order-extra-${firm.session}` });
    const before = JSON.stringify(await lic(a));
    const e = await errOf(() => asAdmin(`SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','customer wants Firm','the customer confirmed by email on 2026-10-13 that they want a second term') r`, [f2.recovery_case_id]));
    const seats = (await admin.query("SELECT additional_seats FROM public.commercial_licences WHERE id=$1", [p1.licence_id])).rows[0].additional_seats;
    return f1.status === "PLACEMENT_REVIEW_REQUIRED" && f2.status === "RECOVERY_REQUIRED" && /PLACEMENT_RULE_REFUSES: BLOCKED_SEATS/.test(e?.message ?? "")
      && JSON.stringify(await lic(a)) === before && seats === 3 ? true : { f1, f2, e: e?.message, seats };
  });
  await check("PLACE_ADDITIONAL_TERM is refused under an open-ended agreement (placement rule), and for a payment already partly refunded", async () => {
    // An open-ended agreement first: the purchase is recorded and waits for placement review; a second charge is the case.
    const xa = await account("place-blocked");
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end) VALUES ($1,$2,'ACTIVE','MANUAL_ADMIN_GRANT',now() - interval '1 day',NULL)", [xa.bc, PLAN.SOLO]);
    const xi = await checkout(xa, "FIRM");
    const first = await commit(xi);
    const xr = await commit(xi, { tx: `order-extra-${xi.session}` });
    if (first.status !== "PLACEMENT_REVIEW_REQUIRED" || xr.status !== "RECOVERY_REQUIRED") return { first, xr };
    const e1 = await errOf(() => asAdmin(`SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','try','the customer confirmed by email on 2026-10-13 that they want a second term') r`, [xr.recovery_case_id]));
    const y = await openCase("place-refunded");
    await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,100,'USD',$3,$4) r", [y.eventId, `re-${uuid()}`, `rk-${uuid()}`, "r".repeat(64)]);
    const e2 = await errOf(() => asAdmin(`SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','try','the customer confirmed by email on 2026-10-13 that they want a second term') r`, [y.caseId]));
    return /PLACEMENT_RULE_REFUSES: BLOCKED_OPEN_ENDED/.test(e1?.message ?? "") && /PAYMENT_PARTLY_OR_FULLY_REFUNDED/.test(e2?.message ?? "") ? true : { e1: e1?.message, e2: e2?.message };
  });
  await check("REFUNDED only once refunds recorded against that payment cover it in full; the licence of the original purchase is untouched", async () => {
    const { a, caseId, eventId, i } = await openCase("refund");
    const before = JSON.stringify(await lic(a));
    await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [eventId, `re-part-${uuid()}`, 20000, `rk-${uuid()}`, "r".repeat(64)]);
    const partial = await errOf(() => asAdmin("SELECT public.admin_resolve_payment_recovery($1,'REFUNDED','refunded') r", [caseId]));
    await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [eventId, `re-rest-${uuid()}`, i.amount - 20000, `rk-${uuid()}`, "r".repeat(64)]);
    const r = await asAdmin("SELECT public.admin_resolve_payment_recovery($1,'REFUNDED','refunded at Polar in full') r", [caseId]);
    return /REFUND_NOT_RECORDED_IN_FULL/.test(partial?.message ?? "") && r.resolved === true && JSON.stringify(await lic(a)) === before ? true : { partial: partial?.message, r };
  });
  await check("two distinct charges on one intent: a refund of the second binds to the second's payment only — the first's refunded total stays 0, its licence is untouched, and the case closes REFUNDED", async () => {
    const { a, i, caseId, eventId } = await openCase("two-charges-refund");
    const first = (await events(a)).find((e) => e.provider_transaction_id === `order-${i.session}`);
    const before = JSON.stringify(await lic(a));
    await one(SERVICE, "SELECT public.record_payment_reversal($1,'REFUND','POLAR',$2,$3,'USD',$4,$5) r", [eventId, `re-second-${uuid()}`, i.amount, `rk-${uuid()}`, "r".repeat(64)]);
    const sums = async (id) => (await admin.query("SELECT COALESCE(sum(amount_minor),0)::bigint s FROM public.payment_events WHERE event_type IN ('REFUND','CHARGEBACK') AND metadata->>'original_event_id'=$1", [id])).rows[0].s;
    const r = await asAdmin("SELECT public.admin_resolve_payment_recovery($1,'REFUNDED','second charge refunded at Polar') r", [caseId]);
    return Number(await sums(first.id)) === 0 && Number(await sums(eventId)) === i.amount && r.resolved === true && JSON.stringify(await lic(a)) === before ? true : { r };
  });
  await check("a sandbox recovery case closes only as TEST_PAYMENT_CLOSED; it can never be placed as a term", async () => {
    const { caseId } = await openCase("sandbox", { env: "sandbox" });
    const e = await errOf(() => asAdmin(`SELECT public.admin_resolve_payment_recovery($1,'PLACE_ADDITIONAL_TERM','try','the customer confirmed by email on 2026-10-13 that they want a second term') r`, [caseId]));
    const r = await asAdmin("SELECT public.admin_resolve_payment_recovery($1,'TEST_PAYMENT_CLOSED','sandbox test') r", [caseId]);
    return /NOT_A_PRODUCTION_PAYMENT/.test(e?.message ?? "") && r.resolved === true ? true : { e: e?.message, r };
  });
  await check("a recovery case is permanent and its facts are fixed: direct update or delete refused, even by the table owner", async () => {
    const { caseId } = await openCase("immutable");
    const e1 = await errOf(() => admin.query("UPDATE public.payment_recovery_cases SET amount_minor = 1 WHERE id=$1", [caseId]));
    const e2 = await errOf(() => admin.query("DELETE FROM public.payment_recovery_cases WHERE id=$1", [caseId]));
    return /RECOVERY_CASE_FACTS_ARE_FIXED/.test(e1?.message ?? "") && /RECOVERY_CASE_IS_PERMANENT/.test(e2?.message ?? "") ? true : { e1: e1?.message, e2: e2?.message };
  });

  group("Reads and authority");
  await check("the order reads show the intent's own payment, never the recovery payment; placement review picks the intent's own unplaced payment", async () => {
    const { a, i } = await openCase("reads");
    const mine = (await one(user(a.uid), "SELECT public.get_my_payments() r")).r;
    const st = (await one(user(a.uid), "SELECT public.get_checkout_status($1) r", [i.ref])).r;
    const own = (await events(a)).find((e) => e.provider_transaction_id === `order-${i.session}`);
    return mine.length === 1 && st.provider_transaction_id !== `order-extra-${i.session}` && own.licence_id !== null ? true : { mine, st };
  });
  await check("clients cannot read recovery cases; only an active commercial administrator can list or resolve them (42501)", async () => {
    const { a, caseId } = await openCase("authz");
    const e1 = await errOf(() => one(user(a.uid), "SELECT count(*) n FROM public.payment_recovery_cases"));
    const e2 = await errOf(() => one(user(a.uid), "SELECT public.admin_list_payment_recovery_cases() r"));
    const e3 = await errOf(() => one(user(a.uid), "SELECT public.admin_resolve_payment_recovery($1,'REFUNDED','x') r", [caseId]));
    const list = await asAdmin("SELECT public.admin_list_payment_recovery_cases() r");
    return e1 && e2?.code === "42501" && e3?.code === "42501" && list.some((c) => c.id === caseId && c.status === "OPEN") ? true : { e1: e1?.message, e2: e2?.message, e3: e3?.message };
  });
  await check("history after all of the above: every pre-migration event, licence and audit row is still byte-identical", async () =>
    (await admin.query(HIST, [cutoff])).rows[0].h === histBefore ? true : "changed");

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED  [${f.group}] ${f.name}`);
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
