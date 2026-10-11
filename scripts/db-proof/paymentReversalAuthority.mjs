#!/usr/bin/env node
// DEFECT-PAYMENT-REVERSAL-UNBOUND-001 — real-PostgreSQL proof for 20261101100000_payment_reversal_authority.sql (batch
// commercial-p4). Embedded PostgreSQL by default (DB_PROOF_MODULES_DIR as for the other proofs); DB_PROOF_MODE=external in CI.
//
//   Before       the defect reproduces: reversals of a failed payment, in another currency, of a non-positive amount, from
//                another provider, and above what was paid are all recorded; a LICENCE_ENDED review leaves access granted
//   Migration    applies with those historical rows present; refuses a second application
//   History      every earlier payment event and audit row stays byte-identical; each historical discrepancy is reported
//                (admin_list_reversal_discrepancies), never rewritten
//   Bounds       confirmed original, same provider and currency, positive amount, cumulative within the amount paid,
//                idempotency (replay vs. reuse) and concurrency (10 racing refunds; 8 deliveries of one)
//   Snippe       admin_record_provider_refund: administrators only; reference, evidence and decision required; refused for
//                Polar (it reports its own refunds) and sandbox payments; reconciled; LICENCE_ENDED ends access now (a
//                future term is cancelled with its dates kept); replays, duplicate references and over-refunds refused
//   Review       admin_record_reversal_review: LICENCE_ENDED now takes effect; LICENCE_KEPT changes nothing
// TZS amounts are TEST FIXTURES, not prices. Local only: no provider is contacted and no money moves.
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-payment-reversal-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE payment_reversal_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/payment_reversal_proof`;
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
  const ADMIN = await mkUser("admin");
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [ADMIN]);
  const asAdmin = (sql, p = []) => one(user(ADMIN), sql, p).then((x) => x?.r);
  const account = async (label) => { const uid = await mkUser(label); const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id; return { uid, bc }; };
  const setState = (s) => admin.query("UPDATE public.commercial_platform_state SET state=$1 WHERE id = true", [s]);
  // TZS offers are TEST FIXTURES, not prices (no TZS price is approved).
  for (const [p, amount] of [["SOLO", 1_000_000], ["FIRM", 3_000_000]]) {
    await asAdmin("SELECT public.admin_upsert_commercial_offer($1,$2,'TZ','TZS',$3,0::smallint,'ANNUAL',1::smallint,true,true,'test fixture, not a price') r", [`CFOCLOSE_${p}_TZ_TZS_ANNUAL`, p, amount]);
  }
  await admin.query("UPDATE public.commercial_offers SET is_purchasable = true WHERE offer_code LIKE 'CFOCLOSE_%_GLOBAL_USD_ANNUAL'");
  const offer = async (plan, market) => (await admin.query("SELECT co.* FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id=co.plan_id WHERE cp.code=$1 AND co.market_code=$2 AND co.billing_interval='ANNUAL' AND co.is_active ORDER BY co.created_at DESC LIMIT 1", [plan, market])).rows[0];
  /** A paid order: intent created, provider reference bound, then committed as the verified-payment path does. */
  const paid = async (acct, plan, { provider = "SNIPPE", env = "production", status = "SUCCEEDED" } = {}) => {
    await setState(env === "sandbox" ? "SANDBOX_ONLY" : "CUSTOMER_PAYMENTS_ENABLED");
    const o = provider === "SNIPPE" ? await offer(plan, "TZ") : await offer(plan, "GLOBAL");
    const ref = `SAFF-${uuid().slice(0, 12)}`;
    const a = (await one(SERVICE, `SELECT public.acquire_checkout_attempt($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10::smallint,$11,$12,$13,$14) r`,
      [acct.bc, product, o.plan_id, o.id, o.market_code, o.currency_code, o.currency_exponent, o.amount_minor, o.billing_interval, o.billing_interval_count, provider, env, acct.uid, ref])).r;
    if (a.action !== "NEW_ATTEMPT") throw new Error(`acquire: ${JSON.stringify(a)}`);
    const pref = `pi_${uuid().replace(/-/g, "").slice(0, 12)}`;
    await one(SERVICE, "SELECT public.begin_provider_checkout_request($1,$2) r", [a.intent_id, a.creation_token]);
    await one(SERVICE, "SELECT public.persist_checkout_provider_result($1,$2,$3,$4) r", [a.intent_id, a.creation_token, pref, `https://cfoclose.example.test/r?ref=${ref}`]);
    const c = (await one(SERVICE, `SELECT public.commit_verified_commercial_payment($1,$2,$3,$4,$5,$6,$7,$8,now(),'PROVIDER_API_VERIFY',$9,$10,$11) r`,
      [a.intent_id, provider, pref, status === "SUCCEEDED" ? "completed" : "failed", status, o.amount_minor, o.currency_code, "h".repeat(64), `k-${pref}`, ref, env])).r;
    await setState("PAYMENTS_DISABLED");
    return { intent: a.intent_id, event: c.event_id, licence: c.licence_id, amount: Number(o.amount_minor), currency: o.currency_code, provider, pref };
  };
  const reverse = (p, { amount, currency = p.currency, provider = p.provider, type = "REFUND", key = `rk-${uuid()}`, ref = `re_${uuid().slice(0, 8)}`, original = p.event } = {}) =>
    one(SERVICE, "SELECT public.record_payment_reversal($1,$2,$3,$4,$5,$6,$7,$8) r", [original, type, provider, ref, amount, currency, key, "r".repeat(64)]).then((x) => x.r);
  const plan = async (acct) => (await one(SERVICE, "SELECT public._account_current_plan_code($1) r", [acct.uid])).r;
  const licence = async (id) => (await admin.query("SELECT id, status, effective_start, effective_end FROM public.commercial_licences WHERE id=$1", [id])).rows[0];
  const reversalsOf = async (p) => (await admin.query("SELECT id, event_type, amount_minor, currency, provider, metadata FROM public.payment_events WHERE event_type IN ('REFUND','CHARGEBACK') AND metadata->>'original_event_id'=$1 ORDER BY recorded_at, id", [p.event])).rows;
  const audit = async (action, key, value) => (await admin.query("SELECT * FROM public.billing_audit_events WHERE action=$1 AND new_state->>$2 = $3", [action, key, value])).rows;
  const refundByAdmin = (p, { amount, currency = p.currency, reference = `SNP-RF-${uuid().slice(0, 8)}`, kind = "PROVIDER_DASHBOARD", note = "Completed refund seen in the provider account view", sha = null, decision = "LICENCE_KEPT", reason = "customer refund", key = uuid(), caller = user(ADMIN) } = {}) =>
    one(caller, "SELECT public.admin_record_provider_refund($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r", [p.event, amount, currency, reference, kind, note, sha, decision, reason, key]).then((x) => x?.r);
  const HISTORY = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text,'|' ORDER BY e.id) FROM public.payment_events e),'')
      || coalesce((SELECT string_agg(to_jsonb(a)::text,'|' ORDER BY a.id) FROM public.billing_audit_events a),'')) AS h`;

  // ════ BEFORE: the defect, reproduced; its rows become the historical discrepancies ══════════════════════════════
  group("Before the correction · DEFECT-PAYMENT-REVERSAL-UNBOUND-001 reproduces");
  const hist = await account("history");
  const histPaid = await paid(hist, "SOLO");
  const histFailed = await paid(hist, "SOLO", { status: "FAILED" });
  const histUsd = await paid(await account("history-usd"), "SOLO", { provider: "POLAR" });
  const before = {};
  await check("record_payment_reversal accepts a refund of a FAILED payment, in another currency, of a non-positive amount, from another provider, and refunds totalling more than was paid", async () => {
    before.failed = await reverse({ ...histFailed }, { amount: 1000 });
    before.currency = await reverse(histPaid, { amount: 100, currency: "USD" });
    before.negative = await reverse(histPaid, { amount: -5 });
    before.provider = await reverse(histPaid, { amount: 10, provider: "POLAR" });
    before.over1 = await reverse(histUsd, { amount: 40_000 });
    before.over2 = await reverse(histUsd, { amount: 40_000 });   // 80,000 against 49,000 paid
    return Object.values(before).every((r) => r.status === "REVERSAL_RECORDED") ? true : before;
  });
  await check("a review decision LICENCE_ENDED is recorded but the licence keeps granting access", async () => {
    const a = await account("before-review");
    const p = await paid(a, "SOLO");
    const r = await reverse(p, { amount: p.amount });
    await asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_ENDED','refunded in full') r", [r.event_id]);
    return (await licence(p.licence)).status === "ACTIVE" && await plan(a) === "SOLO" ? true : await licence(p.licence);
  });
  // Every row written so far is history: the digest of rows up to this instant must never change.
  const historyCutoff = (await admin.query("SELECT clock_timestamp() AS t")).rows[0].t;
  const HISTORY_AT = `SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text,'|' ORDER BY e.id) FROM public.payment_events e WHERE e.recorded_at <= $1),'')
      || coalesce((SELECT string_agg(to_jsonb(a)::text,'|' ORDER BY a.id) FROM public.billing_audit_events a WHERE a.created_at <= $1),'')) AS h`;
  const historyBefore = (await admin.query(HISTORY_AT, [historyCutoff])).rows[0].h;
  await new Promise((r) => setTimeout(r, 20));

  group("The migration");
  await check("it refuses before sandbox licence isolation is in force (PREFLIGHT_REFUSED) — proven by its own preflight text", async () => {
    const text = fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8");
    return /PREFLIGHT_REFUSED: sandbox licence isolation \(20261031110000, commercial-p3\) must be applied first/.test(text) ? true : "preflight missing";
  });
  await check("it applies on the chain with the historical rows present; a second application is refused (PREFLIGHT_REFUSED) and changes nothing", async () => {
    await applyMigration(MIGRATION);
    const h = (await admin.query(HISTORY)).rows[0].h;
    const e = await errOf(() => applyMigration(MIGRATION));
    return /already in force/.test(e?.message ?? "") && (await admin.query(HISTORY)).rows[0].h === h ? true : e?.message ?? "applied twice";
  });
  await check("every later migration applies", async () => { for (const f of files.slice(cut + 1)) await applyMigration(f); return true; });

  group("History · preserved and reported, never rewritten");
  await check("every payment event and audit row from before the migration is byte-identical after it", async () =>
    (await admin.query(HISTORY_AT, [historyCutoff])).rows[0].h === historyBefore ? true : "changed");
  await check("the discrepancy report lists each historical bad reversal with its issues; nothing else", async () => {
    const list = await asAdmin("SELECT public.admin_list_reversal_discrepancies() r");
    const by = Object.fromEntries(list.map((x) => [x.reversal_event_id, x.issues]));
    const want = {
      [before.failed.event_id]: ["ORIGINAL_NOT_A_CONFIRMED_PAYMENT"],
      [before.currency.event_id]: ["CURRENCY_MISMATCH"],
      [before.negative.event_id]: ["AMOUNT_NOT_POSITIVE"],
      [before.provider.event_id]: ["PROVIDER_MISMATCH"],
      [before.over2.event_id]: ["CUMULATIVE_EXCEEDS_PAYMENT"],
    };
    const ok = Object.entries(want).every(([id, issues]) => JSON.stringify(by[id]) === JSON.stringify(issues)) && !(before.over1.event_id in by) && list.length === 5;
    return ok ? true : { list };
  });
  await check("the report is for commercial administrators only (42501 for anyone else)", async () => {
    const nosy = await account("nosy");
    const e = await errOf(() => one(user(nosy.uid), "SELECT public.admin_list_reversal_discrepancies() r"));
    return e?.code === "42501" ? true : e?.message ?? "readable";
  });
  await check("the historical rows are still there, unchanged, after the report (it writes nothing)", async () => {
    const rows = (await admin.query("SELECT count(*)::int n FROM public.payment_events WHERE id = ANY($1)", [Object.values(before).map((r) => r.event_id)])).rows[0].n;
    return rows === 6 ? true : rows;
  });

  // ════ The bounds ═════════════════════════════════════════════════════════════════════════════════════════════════
  group("Provider-reported reversals · bounded");
  const bound = await account("bound");
  const bp = await paid(bound, "SOLO");   // 1,000,000 TZS
  for (const [label, over, rx] of [
    ["a FAILED payment as the original", { original: histFailed.event }, /REVERSAL_ORIGINAL_NOT_A_CONFIRMED_PAYMENT/],
    ["a reversal as the original", { original: before.over1.event_id }, /REVERSAL_ORIGINAL_NOT_A_CONFIRMED_PAYMENT/],
    ["an unknown original", { original: uuid() }, /REVERSAL_ORIGINAL_NOT_FOUND/],
    ["another currency", { amount: 100, currency: "USD" }, /REVERSAL_CURRENCY_MISMATCH/],
    ["another provider", { amount: 100, provider: "POLAR" }, /REVERSAL_PROVIDER_MISMATCH/],
    ["zero", { amount: 0 }, /REVERSAL_AMOUNT_INVALID/],
    ["a negative amount", { amount: -1 }, /REVERSAL_AMOUNT_INVALID/],
    ["more than was paid", { amount: 1_000_001 }, /REVERSAL_EXCEEDS_PAYMENT/],
    ["an unknown type", { amount: 100, type: "VOID" }, /REVERSAL_TYPE_INVALID/],
    ["a blank idempotency key", { amount: 100, key: " " }, /REVERSAL_IDEMPOTENCY_KEY_REQUIRED/],
  ]) {
    await check(`refused: ${label}; nothing written`, async () => {
      const h = (await admin.query(HISTORY)).rows[0].h;
      const e = await errOf(() => reverse(bp, { amount: 100, ...over }));
      return rx.test(e?.message ?? "") && (await admin.query(HISTORY)).rows[0].h === h ? true : e?.message ?? "accepted";
    });
  }
  await check("partial then the rest: 400,000 then 600,000 recorded (fully reversed); one more shilling refused; the licence is untouched", async () => {
    const r1 = await reverse(bp, { amount: 400_000 });
    const r2 = await reverse(bp, { amount: 600_000 });
    const e = await errOf(() => reverse(bp, { amount: 1 }));
    return r1.reversed_minor === 400_000 && r2.reversed_minor === 1_000_000 && r2.fully_reversed === true && /REVERSAL_EXCEEDS_PAYMENT/.test(e?.message ?? "")
      && (await licence(bp.licence)).status === "ACTIVE" ? true : { r1, r2, e: e?.message };
  });
  await check("idempotency: the same key with the same facts answers ALREADY_RECORDED; with different facts it is refused", async () => {
    const p = await paid(await account("idem"), "SOLO");
    const r = await reverse(p, { amount: 100, key: "idem-key-1", ref: "re_idem_1" });
    const again = await reverse(p, { amount: 100, key: "idem-key-1", ref: "re_idem_1" });
    const other = await errOf(() => reverse(p, { amount: 200, key: "idem-key-1", ref: "re_idem_2" }));
    return r.status === "REVERSAL_RECORDED" && again.status === "ALREADY_RECORDED" && again.event_id === r.event_id && /REVERSAL_IDEMPOTENCY_KEY_REUSED/.test(other?.message ?? "")
      && (await reversalsOf(p)).length === 1 ? true : { r, again, other: other?.message };
  });
  await check("concurrency: 10 simultaneous refunds of 30% each against one payment — exactly 3 recorded, the total never exceeds what was paid", async () => {
    const p = await paid(await account("race"), "SOLO");
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => reverse(p, { amount: 300_000 })));
    const ok = rs.filter((x) => x.status === "fulfilled" && x.value.status === "REVERSAL_RECORDED");
    const refused = rs.filter((x) => x.status === "rejected" && /REVERSAL_EXCEEDS_PAYMENT/.test(x.reason?.message ?? ""));
    const total = (await reversalsOf(p)).reduce((s, r) => s + Number(r.amount_minor), 0);
    return ok.length === 3 && refused.length === 7 && total === 900_000 ? true : { ok: ok.length, refused: refused.length, total };
  });
  await check("concurrency: 8 simultaneous deliveries of one refund under one key record it once", async () => {
    const p = await paid(await account("race-key"), "SOLO");
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => reverse(p, { amount: 500, key: "same-refund", ref: "re_same" })));
    const recorded = rs.filter((x) => x.status === "fulfilled" && x.value.status === "REVERSAL_RECORDED").length;
    return recorded === 1 && (await reversalsOf(p)).length === 1 && rs.every((x) => x.status === "fulfilled") ? true : rs.map((x) => x.status === "fulfilled" ? x.value.status : x.reason.message);
  });
  await check("a Polar refund reported cumulatively (20,000 then 49,000 total) records 20,000 then 29,000 within the 49,000 paid", async () => {
    const p = await paid(await account("polar-refund"), "SOLO", { provider: "POLAR" });
    const r1 = await reverse(p, { amount: 20_000 });
    const r2 = await reverse(p, { amount: 29_000 });
    return r1.status === "REVERSAL_RECORDED" && r2.reversed_minor === 49_000 && r2.fully_reversed ? true : { r1, r2 };
  });
  await check("the service role may record provider reversals; clients may not call record_payment_reversal or the core", async () => {
    const someone = await account("client");
    const e1 = await errOf(() => one(user(someone.uid), "SELECT public.record_payment_reversal($1,'REFUND','SNIPPE','x',1,'TZS','k','h') r", [bp.event]));
    const e2 = await errOf(() => one(SERVICE, "SELECT public._record_payment_reversal_core($1,'REFUND','SNIPPE','x',1,'TZS','k','h','X',NULL,NULL) r", [bp.event]));
    return e1?.code === "42501" && e2?.code === "42501" ? true : { e1: e1?.message, e2: e2?.message };
  });

  // ════ The administrator workflow for refunds the provider cannot report (Snippe) ═════════════════════════════════
  group("Snippe refunds · recorded by an administrator from the provider's evidence");
  await check("only a commercial administrator may record one (42501)", async () => {
    const p = await paid(await account("adm-only"), "SOLO");
    const notAdmin = await account("not-admin");
    const e = await errOf(() => refundByAdmin(p, { amount: 100, caller: user(notAdmin.uid) }));
    return e?.code === "42501" ? true : e?.message ?? "accepted";
  });
  await check("refused without the provider's refund reference, a known evidence kind, an evidence note, a valid document hash or a licence decision", async () => {
    const p = await paid(await account("adm-fields"), "SOLO");
    const tries = [[{ reference: "" }, /PROVIDER_REFUND_REFERENCE_REQUIRED/], [{ kind: "EMAIL" }, /EVIDENCE_KIND_INVALID/], [{ note: "ok" }, /EVIDENCE_NOTE_REQUIRED/],
      [{ sha: "abc" }, /EVIDENCE_SHA256_INVALID/], [{ decision: null }, /LICENCE_DECISION_REQUIRED/], [{ reason: " " }, /REASON_REQUIRED/]];
    const out = [];
    for (const [over, rx] of tries) { const e = await errOf(() => refundByAdmin(p, { amount: 100, ...over })); out.push(rx.test(e?.message ?? "")); }
    return out.every(Boolean) && (await reversalsOf(p)).length === 0 ? true : out;
  });
  await check("refused for a Polar payment (Polar reports its own refunds — recording one by hand would count it twice)", async () => {
    const p = await paid(await account("adm-polar"), "SOLO", { provider: "POLAR" });
    const e = await errOf(() => refundByAdmin(p, { amount: 100, currency: "USD" }));
    return /PROVIDER_REPORTS_REFUNDS/.test(e?.message ?? "") ? true : e?.message ?? "accepted";
  });
  await check("refused for a sandbox Snippe payment (no money moved)", async () => {
    const p = await paid(await account("adm-sandbox"), "SOLO", { env: "sandbox" });
    const e = await errOf(() => refundByAdmin(p, { amount: 100 }));
    return /NOT_A_PRODUCTION_PAYMENT/.test(e?.message ?? "") ? true : e?.message ?? "accepted";
  });
  await check("a full refund with LICENCE_ENDED: recorded with the reference and evidence, reconciled (fully refunded), and access ends now — plan gone, audited", async () => {
    const a = await account("adm-full");
    const p = await paid(a, "SOLO");
    const sha = "a".repeat(64);
    const r = await refundByAdmin(p, { amount: p.amount, reference: "SNP-RF-FULL-0001", kind: "PROVIDER_SUPPORT_CONFIRMATION", note: "Snippe support confirmed refund SNP-RF-FULL-0001 by email", sha, decision: "LICENCE_ENDED", reason: "refunded in full at the customer's request" });
    const l = await licence(p.licence);
    const ev = (await reversalsOf(p))[0];
    const recorded = await audit("PROVIDER_REFUND_RECORDED_BY_ADMIN", "reversal_event_id", r.event_id);
    const ended = await audit("LICENCE_ENDED_AFTER_REVERSAL", "reversal_event_id", r.event_id);
    return r.status === "REVERSAL_RECORDED" && r.fully_reversed === true && r.licence_decision.licence_effect === "ENDED_NOW"
      && l.status === "CANCELLED" && new Date(l.effective_end) <= new Date() && await plan(a) === null
      && ev.metadata.source === "ADMIN_RECORDED_PROVIDER_REFUND" && ev.metadata.evidence.provider_refund_reference === "SNP-RF-FULL-0001" && ev.metadata.evidence.document_sha256 === sha
      && recorded.length === 1 && recorded[0].actor_user_id === ADMIN && ended.length === 1 ? true : { r, l, ev: ev?.metadata, recorded: recorded.length, ended: ended.length };
  });
  await check("a partial refund with LICENCE_KEPT: recorded and reconciled (not fully refunded); the licence and plan are unchanged", async () => {
    const a = await account("adm-partial");
    const p = await paid(a, "SOLO");
    const before = JSON.stringify(await licence(p.licence));
    const r = await refundByAdmin(p, { amount: 250_000, decision: "LICENCE_KEPT" });
    return r.status === "REVERSAL_RECORDED" && r.reversed_minor === 250_000 && r.fully_reversed === false && r.licence_decision.licence_effect === "NO_CHANGE"
      && JSON.stringify(await licence(p.licence)) === before && await plan(a) === "SOLO" ? true : r;
  });
  await check("a replay with the same idempotency key answers ALREADY_RECORDED with the original decision; nothing is recorded or decided twice", async () => {
    const a = await account("adm-replay");
    const p = await paid(a, "SOLO");
    const key = uuid();
    const r = await refundByAdmin(p, { amount: 100_000, key, reference: "SNP-RF-REPLAY" });
    const again = await refundByAdmin(p, { amount: 100_000, key, reference: "SNP-RF-REPLAY" });
    const decisions = await audit("REVERSAL_REVIEWED", "reversal_event_id", r.event_id);
    return again.status === "ALREADY_RECORDED" && again.event_id === r.event_id && again.licence_decision?.decision === "LICENCE_KEPT" && decisions.length === 1 && (await reversalsOf(p)).length === 1 ? true : { again, decisions: decisions.length };
  });
  await check("the same provider refund reference cannot be recorded twice (under a new key), and a refund above what remains is refused", async () => {
    const a = await account("adm-dup");
    const p = await paid(a, "SOLO");
    await refundByAdmin(p, { amount: 600_000, reference: "SNP-RF-DUP" });
    const dup = await errOf(() => refundByAdmin(p, { amount: 100_000, reference: "SNP-RF-DUP" }));
    const over = await errOf(() => refundByAdmin(p, { amount: 400_001, reference: "SNP-RF-OVER" }));
    return /REVERSAL_PROVIDER_REFERENCE_ALREADY_RECORDED/.test(dup?.message ?? "") && /REVERSAL_EXCEEDS_PAYMENT/.test(over?.message ?? "") && (await reversalsOf(p)).length === 1 ? true : { dup: dup?.message, over: over?.message };
  });
  await check("a refund of a renewal that has not started yet, with LICENCE_ENDED: that future term is cancelled with its dates kept; the current term keeps granting", async () => {
    const a = await account("adm-future");
    const first = await paid(a, "SOLO");
    const renewal = await paid(a, "SOLO");
    const before = await licence(renewal.licence);
    const r = await refundByAdmin(renewal, { amount: renewal.amount, decision: "LICENCE_ENDED", reference: "SNP-RF-FUT" });
    const after = await licence(renewal.licence);
    return r.licence_decision.licence_effect === "FUTURE_TERM_CANCELLED" && after.status === "CANCELLED" && sameInstant(after.effective_end, before.effective_end)
      && (await licence(first.licence)).status === "ACTIVE" && await plan(a) === "SOLO" ? true : { r, after };
  });

  group("Review decisions · now take effect");
  await check("admin_record_reversal_review LICENCE_ENDED on a provider-reported refund ends access now; a second decision is refused", async () => {
    const a = await account("review");
    const p = await paid(a, "SOLO", { provider: "POLAR" });
    const r = await reverse(p, { amount: p.amount });
    const d = await asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_ENDED','refunded in full') r", [r.event_id]);
    const twice = await errOf(() => asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_KEPT','again') r", [r.event_id]));
    return d.licence_effect === "ENDED_NOW" && (await licence(p.licence)).status === "CANCELLED" && await plan(a) === null && /REVERSAL_ALREADY_REVIEWED/.test(twice?.message ?? "") ? true : { d, twice: twice?.message };
  });
  await check("LICENCE_KEPT changes nothing; a non-administrator cannot decide (42501)", async () => {
    const a = await account("review-kept");
    const p = await paid(a, "SOLO", { provider: "POLAR" });
    const r = await reverse(p, { amount: 1000 });
    const e = await errOf(() => one(user(a.uid), "SELECT public.admin_record_reversal_review($1,'LICENCE_ENDED','self') r", [r.event_id]));
    const d = await asAdmin("SELECT public.admin_record_reversal_review($1,'LICENCE_KEPT','partial goodwill refund') r", [r.event_id]);
    return e?.code === "42501" && d.licence_effect === "NO_CHANGE" && (await licence(p.licence)).status === "ACTIVE" && await plan(a) === "SOLO" ? true : { e: e?.message, d };
  });

  group("History, again");
  await check("every pre-migration payment event and audit row is still byte-identical (rows added since are new rows only)", async () => {
    return (await admin.query(HISTORY_AT, [historyCutoff])).rows[0].h === historyBefore ? true : "changed";
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED  [${f.group}] ${f.name}`);
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try { exitCode = await main(); } catch (e) { console.error(`FATAL: ${e?.stack ?? e}`); exitCode = 1; } finally { await stopDatabase(); }
process.exit(exitCode);
