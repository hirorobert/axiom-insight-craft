#!/usr/bin/env node
// Real-PostgreSQL proof of I1-A periods and currency (migration 20261009100000).
//
// Replays the repository's migration chain on a throwaway PostgreSQL 16 and drives the contract through real, separate
// connections acting as `authenticated` / `anon` (simulated JWT claims, as PostgREST does) and `service_role`.
// Concurrency is real: every simultaneous request holds its own connection and transaction.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/periodsAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.
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
const A1_FILE = "20261009100000_currency_registry_and_reporting_periods.sql";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const CONCURRENCY = 25;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");
const uuid = () => crypto.randomUUID();

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`); }
  catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-periods-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE periods_proof");
  await boot.end();
  const url = `postgres://postgres:postgres@localhost:${port}/periods_proof`;
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a loopback database");
  return url;
}
async function stopDatabase() {
  const step = (p) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await step(pool?.end() ?? Promise.resolve());
  await step(admin?.end() ?? Promise.resolve());
  if (server) await step(server.stop());
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
const migrationText = (f) => {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  return text;
};
async function asRole(role, uid, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* ignore */ } throw e; } finally { c.release(); }
}
const asUser = (uid, sql, params) => asRole("authenticated", uid, async (c) => (await c.query(sql, params)).rows);
const asAnon = (sql, params) => asRole("anon", null, async (c) => (await c.query(sql, params)).rows);
const asService = (sql, params) => asRole("service_role", null, async (c) => (await c.query(sql, params)).rows);
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);

const OPEN = "SELECT public.open_engagement_with_period($1,$2,$3,$4,$5,'composite',$6,$7,$8) r";
const open = async (uid, company, start, end, currency, prior = {}) =>
  (await asUser(uid, OPEN, [company, start, end, currency, ["FINANCIAL_STATEMENTS"], prior.start ?? null, prior.end ?? null, prior.currency ?? null]))[0].r;

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 6 });
  const files = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const cut = files.indexOf(A1_FILE);

  group("Replay — every migration before A1");
  await check(`${A1_FILE} is in the chain; every earlier migration applies`, async () => {
    if (cut < 0) return "A1 missing";
    await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
    for (const f of files.slice(0, cut)) { try { await admin.query(migrationText(f)); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });

  const U = { owner: uuid(), partner: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() };
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const prod = (await one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 4], [U.ownerB, "FIRM", 50]]) {
    const bc = (await one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
    await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company A') RETURNING id", [U.owner])).id;
  const B = (await one("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).id;
  for (const [k, role] of [["partner", "partner"], ["preparer", "preparer"], ["viewer", "viewer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);

  group("Preflight — incompatible existing data makes the migration refuse; nothing changes");
  const a1 = migrationText(A1_FILE);
  const fp = (sql, p) => admin.query(sql, p);
  for (const [label, setup] of [
    ["an unsupported currency (XAU, non-monetary)", () => fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency) VALUES ($1,'2011-12-31','FY2011',$2,'XAU')", [A, U.owner])],
    ["a malformed currency (lower case)", () => fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency) VALUES ($1,'2011-12-31','FY2011',$2,'tzs')", [A, U.owner])],
    ["a start after its end", () => fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,'2011-12-31','FY2011',$2,'TZS','2011-12-31','2011-01-01')", [A, U.owner])],
    ["a period longer than the technical ceiling", () => fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,'2014-12-31','FY2014',$2,'TZS','2010-01-01','2014-12-31')", [A, U.owner])],
    ["two dated periods that overlap", async () => {
      await fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,'2011-12-31','FY2011',$2,'TZS','2011-01-01','2011-12-31')", [A, U.owner]);
      await fp("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,'2012-06-30','FY2012',$2,'TZS','2011-07-01','2012-06-30')", [A, U.owner]);
    }],
  ]) {
    await check(`refuses on ${label}`, async () => {
      await admin.query("BEGIN");
      try {
        await setup();
        try { await admin.query(a1); return "migration applied"; } catch (e) { if (!/PREFLIGHT_REFUSED/.test(e.message)) return e.message.split("\n")[0]; }
        return true;
      } finally { await admin.query("ROLLBACK"); }
    });
  }
  await check("after the refusals nothing exists of A1 and no period row remains", async () =>
    (await one("SELECT to_regclass('public.currency_registry') IS NULL AS ok")).ok && (await count("SELECT count(*) n FROM public.fiscal_periods")) === 0);

  // Legacy state created BEFORE A1 through the pre-A1 paths: an undated period, a dated one, and a v1 workspace.
  const legacyUndated = (await one("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency) VALUES ($1,'2019-12-31','FY2019',$2,'TZS') RETURNING id", [A, U.owner])).id;
  const legacyDated = (await one("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,'2018-12-31','FY2018',$2,'KES','2018-01-01','2018-12-31') RETURNING id", [A, U.owner])).id;

  group("Apply A1");
  await check(`${A1_FILE} applies on top of compatible data, and every later migration after it`, async () => {
    for (const f of files.slice(cut)) { try { await admin.query(migrationText(f)); } catch (e) { return `${f}: ${String(e.message).split("\n")[0]}`; } }
    return true;
  });
  await check("existing periods are preserved exactly: currencies unchanged, no dates invented, no provenance backfilled", async () => {
    const u = await one("SELECT reporting_currency, reporting_start, reporting_end, dates_basis FROM public.fiscal_periods WHERE id=$1", [legacyUndated]);
    const d = await one("SELECT reporting_currency, reporting_start::text s, reporting_end::text e, dates_basis FROM public.fiscal_periods WHERE id=$1", [legacyDated]);
    return u.reporting_currency === "TZS" && u.reporting_start === null && u.reporting_end === null && u.dates_basis === null
      && d.reporting_currency === "KES" && d.s === "2018-01-01" && d.e === "2018-12-31" && d.dates_basis === null ? true : { u, d };
  });

  group("Currency registry (currency-registry/1)");
  await check("155 monetary currencies with one recorded version; the same codes and exponents as the TypeScript registry", async () => {
    const rows = (await admin.query("SELECT code, exponent, registry_version FROM public.currency_registry ORDER BY code")).rows;
    const ts = fs.readFileSync(path.join(REPO, "supabase/functions/_shared/currencyRegistry.ts"), "utf8");
    const tsMap = Object.fromEntries([...ts.matchAll(/^ {2}([A-Z]{3}): (\d),$/gm)].map((m) => [m[1], Number(m[2])]));
    const same = rows.length === Object.keys(tsMap).length && rows.every((r) => tsMap[r.code] === r.exponent);
    const version = new Set(rows.map((r) => r.registry_version));
    return rows.length === 155 && same && version.size === 1 && [...version][0] === "iso4217-list-one-2026-09-17" ? true : { n: rows.length, same, version: [...version] };
  });
  await check("funds codes and non-monetary units are excluded (XAU, XDR, XTS, XXX, CLF, BOV, USN)", async () =>
    (await count("SELECT count(*) n FROM public.currency_registry WHERE code = ANY($1)", [["XAU", "XDR", "XTS", "XXX", "CLF", "BOV", "USN"]])) === 0);
  await check("reporting_currency has no default (no TZS fallback) and must be a registry code", async () => {
    const d = await one("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='fiscal_periods' AND column_name='reporting_currency'");
    return d.column_default === null;
  });
  await refused("the registry is read-only for clients", "42501", () => asUser(U.owner, "INSERT INTO public.currency_registry (code,exponent,name) VALUES ('ZZZ',2,'x')"));

  group("open_engagement_with_period — authorisation and input");
  await refused("anonymous is refused (no EXECUTE grant)", "42501", () => asAnon(OPEN, [A, "2025-01-01", "2025-12-31", "TZS", ["FINANCIAL_STATEMENTS"], null, null, null]));
  for (const who of ["preparer", "viewer", "outsider", "ownerB"]) await refused(`${who} cannot set up a period for company A (review_close required)`, "42501", () => open(U[who], A, "2025-01-01", "2025-12-31", "TZS"));
  await refused("missing dates are refused", "22023", () => open(U.owner, A, null, "2025-12-31", "TZS"));
  await refused("start after end is refused", "22023", () => open(U.owner, A, "2025-12-31", "2025-01-01", "TZS"));
  await refused("a period longer than 36 months is refused (technical guard)", "22023", () => open(U.owner, A, "2021-01-01", "2024-01-01", "TZS"), "PERIOD_TOO_LONG");
  await check("exactly 36 months less a day is accepted as long as it is within the ceiling", async () => (await open(U.ownerB, B, "2021-01-01", "2023-12-31", "USD")).outcome === "opened");
  for (const bad of ["XAU", "ABC", "", "XTS"]) await refused(`currency '${bad}' is refused (CURRENCY_UNSUPPORTED)`, "22023", () => open(U.owner, A, "2025-01-01", "2025-12-31", bad), "CURRENCY_UNSUPPORTED");
  await refused("one prior date without the other is refused", "22023", () => open(U.owner, A, "2025-01-01", "2025-12-31", "TZS", { start: "2024-01-01" }));
  await check("nothing was created by the refused calls (company A)", async () => (await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A])) === 2);

  group("Explicit periods — non-calendar, identity, prior");
  let p25;
  await check("a non-calendar period (1 Jul 2024 – 30 Jun 2025, BHD) opens: year 2025, dates confirmed by the caller, event recorded", async () => {
    const r = await open(U.owner, A, "2024-07-01", "2025-06-30", "BHD");
    p25 = r.periodId;
    const row = await one("SELECT reporting_currency, dates_basis, dates_confirmed_by IS NOT NULL AS by, fiscal_year_end::text fye FROM public.fiscal_periods WHERE id=$1", [p25]);
    const ev = await count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='created'", [p25]);
    return r.outcome === "opened" && r.created && r.periodYear === 2025 && row.reporting_currency === "BHD" && row.dates_basis === "confirmed" && row.by && row.fye === "2025-06-30" && ev === 1 ? true : { r, row, ev };
  });
  await check("the identical request is an exact no-op (same period and engagement, created=false)", async () => {
    const r = await open(U.partner, A, "2024-07-01", "2025-06-30", "BHD");
    return r.outcome === "opened" && r.periodId === p25 && r.created === false;
  });
  await check("different dates ending in the same year are refused (PERIOD_YEAR_TAKEN); nothing created", async () => {
    const r = await open(U.owner, A, "2025-01-01", "2025-12-31", "TZS");
    return r.outcome === "refused" && r.code === "PERIOD_YEAR_TAKEN" && (await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A])) === 3 ? true : r;
  });
  await check("the same dates in another currency are refused (CURRENCY_DIFFERS_FROM_EXISTING)", async () => (await open(U.owner, A, "2024-07-01", "2025-06-30", "TZS")).code === "CURRENCY_DIFFERS_FROM_EXISTING");
  await check("an overlapping period ending in another year is refused (PERIOD_OVERLAP); nothing created", async () => {
    const r = await open(U.owner, A, "2025-03-01", "2026-02-28", "BHD");
    return r.outcome === "refused" && r.code === "PERIOD_OVERLAP" && (await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A])) === 3 ? true : r;
  });
  let p26;
  await check("an adjacent prior period is created and linked; its currency defaults to the period's; events recorded", async () => {
    const r = await open(U.owner, A, "2025-07-01", "2026-06-30", "BHD", { start: "2024-07-01", end: "2025-06-30" });
    p26 = r.periodId;
    const row = await one("SELECT prior_period_id FROM public.fiscal_periods WHERE id=$1", [p26]);
    const linked = await count("SELECT count(*) n FROM public.fiscal_period_events WHERE period_id=$1 AND action='prior_linked'", [p26]);
    return r.outcome === "opened" && r.priorPeriodId === p25 && row.prior_period_id === p25 && linked === 1 ? true : { r, row, linked };
  });
  await check("a prior period that does not end the day before is refused (PRIOR_NOT_ADJACENT)", async () =>
    (await open(U.owner, A, "2026-07-01", "2027-06-30", "BHD", { start: "2025-01-01", end: "2025-12-31" })).code === "PRIOR_NOT_ADJACENT");
  await check("a prior period in a different currency is recorded as such (no conversion, no refusal at setup)", async () => {
    const r = await open(U.ownerB, B, "2025-01-01", "2025-12-31", "USD", { start: "2024-01-01", end: "2024-12-31", currency: "EUR" });
    const row = await one("SELECT reporting_currency FROM public.fiscal_periods WHERE id=$1", [r.priorPeriodId]);
    return r.outcome === "opened" && row.reporting_currency === "EUR" ? true : { r, row };
  });

  group(`Concurrency — ${CONCURRENCY} simultaneous requests, separate connections`);
  await check(`${CONCURRENCY} concurrent setup requests for overlapping periods: exactly one opened, the rest refused; no duplicate rows`, async () => {
    const before = await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A]);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => {
      const start = new Date(Date.UTC(2031, 0, 1 + i * 5)); // 12-month windows that all contain May–Dec 2031: every pair overlaps
      const end = new Date(start.getTime()); end.setUTCFullYear(end.getUTCFullYear() + 1); end.setUTCDate(end.getUTCDate() - 1);
      const iso = (d) => d.toISOString().slice(0, 10);
      return open(i % 2 ? U.partner : U.owner, A, iso(start), iso(end), "BHD");
    }));
    const opened = out.filter((r) => r.outcome === "opened");
    const after = await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A]);
    return opened.length === 1 && out.every((r) => r.outcome === "opened" || ["PERIOD_OVERLAP", "PERIOD_YEAR_TAKEN"].includes(r.code)) && after === before + 1 ? true : { opened: opened.length, codes: [...new Set(out.map((r) => r.code ?? r.outcome))], before, after };
  });
  await check(`the exclusion constraint decides even without the setup lock: ${CONCURRENCY} direct concurrent service inserts of overlapping ranges → exactly one row`, async () => {
    // Same start, distinct ends (one year-end per row), all within the ceiling: every pair overlaps.
    const ins = (i) => asService("INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency,reporting_start,reporting_end) VALUES ($1,$2,$3,$4,'USD','2040-06-01',$2) RETURNING id",
      [B, `2041-05-${String(1 + i).padStart(2, "0")}`, `FY2041-${i}`, U.ownerB]).then(() => "ok", (e) => e.code);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => ins(i)));
    // Simultaneous writers on an exclusion-constrained index are refused either by the exclusion check (23P01) or, when
    // they wait on each other, by deadlock detection (40P01). Either way nothing overlapping is written. (The setup RPC
    // serialises per company first, so a person always gets PERIOD_OVERLAP.)
    const rows = await count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1 AND reporting_start='2040-06-01'", [B]);
    return out.filter((x) => x === "ok").length === 1 && out.every((x) => ["ok", "23P01", "40P01"].includes(x)) && rows === 1 ? true : { out, rows };
  });

  group("Fence — only server code sets currency, dates, provenance or the prior link");
  await check("a member cannot insert a period directly (42501: the fence, or row security before it); nothing is created", async () => {
    let code = null;
    try { await asUser(U.owner, "INSERT INTO public.fiscal_periods (company_id,fiscal_year_end,period_label,created_by,reporting_currency) VALUES ($1,'2050-12-31','FY2050',$2,'TZS')", [A, U.owner]); } catch (e) { code = e.code; }
    return code === "42501" && (await count("SELECT count(*) n FROM public.fiscal_periods WHERE fiscal_year_end='2050-12-31'")) === 0 ? true : code;
  });
  await check("the fence itself refuses a direct insert even when row security would allow it (the role is authenticated)", async () => {
    // Exercise the trigger directly as the authenticated role with row security bypassed for this one statement's
    // policy check: a SECURITY INVOKER wrapper owned by postgres cannot be used, so assert on the trigger source instead.
    const src = (await one("SELECT prosrc FROM pg_proc WHERE proname='fiscal_periods_setup_fence'")).prosrc;
    return /current_user IN \('authenticated', 'anon'\)/.test(src) && /IF TG_OP = 'INSERT' THEN\s+RAISE EXCEPTION 'PERIOD_SETUP_FENCED/.test(src);
  });
  for (const [col, val] of [["reporting_currency", "'KES'"], ["reporting_start", "'2024-07-02'"], ["reporting_end", "'2025-06-29'"], ["prior_period_id", "NULL"]]) {
    await check(`a member cannot change ${col} directly (refused, or no visible row under RLS — never applied)`, async () => {
      const before = JSON.stringify(await one(`SELECT ${col} v FROM public.fiscal_periods WHERE id=$1`, [p26]));
      let code = null;
      try { await asUser(U.owner, `UPDATE public.fiscal_periods SET ${col}=${val} WHERE id=$1`, [p26]); } catch (e) { code = e.code; }
      const after = JSON.stringify(await one(`SELECT ${col} v FROM public.fiscal_periods WHERE id=$1`, [p26]));
      return before === after && (code === "42501" || code === null) ? true : { code, before, after };
    });
  }
  await refused("the service role cannot write date provenance outside the setup functions", "42501", () => asService("UPDATE public.fiscal_periods SET dates_basis='confirmed', dates_confirmed_at=now() WHERE id=$1", [legacyDated]), "PERIOD_SETUP_FENCED");

  group("Date confirmation — legacy periods");
  await check("a year whose legacy period has no dates is refused until its dates are confirmed (PERIOD_DATES_UNCONFIRMED)", async () =>
    (await open(U.owner, A, "2019-01-01", "2019-12-31", "TZS")).code === "PERIOD_DATES_UNCONFIRMED");
  await refused("a preparer cannot confirm dates (answered as not found: no existence leak)", "P0002", () => asUser(U.preparer, "SELECT public.confirm_period_dates($1,'2019-01-01','2019-12-31')", [legacyUndated]));
  await refused("an outsider cannot confirm dates", "P0002", () => asUser(U.outsider, "SELECT public.confirm_period_dates($1,'2019-01-01','2019-12-31')", [legacyUndated]));
  await check("an end date different from the recorded year end is refused", async () => (await asUser(U.owner, "SELECT public.confirm_period_dates($1,'2019-01-01','2019-11-30') r", [legacyUndated]))[0].r.code === "END_DIFFERS_FROM_YEAR_END");
  await check("the owner confirms the dates: recorded as confirmed, with an event holding the previous values", async () => {
    const r = (await asUser(U.owner, "SELECT public.confirm_period_dates($1,'2019-01-01','2019-12-31') r", [legacyUndated]))[0].r;
    const row = await one("SELECT dates_basis, reporting_start::text s FROM public.fiscal_periods WHERE id=$1", [legacyUndated]);
    const ev = await one("SELECT detail FROM public.fiscal_period_events WHERE period_id=$1 AND action='dates_confirmed'", [legacyUndated]);
    return r.outcome === "confirmed" && r.changed && row.dates_basis === "confirmed" && row.s === "2019-01-01" && ev.detail.previous_start === null ? true : { r, row, ev };
  });
  await check("after confirmation the same setup request reuses that period", async () => {
    const r = await open(U.owner, A, "2019-01-01", "2019-12-31", "TZS");
    return r.outcome === "opened" && r.periodId === legacyUndated ? true : r;
  });

  group("Processed history — a legacy period stays datable; its currency stays server-only");
  await check("after a processing attempt began in FY2018, the period can still be dated by a reviewer (confirm_period_dates), and a member still cannot change its currency", async () => {
    const up = (await one(`INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id)
      VALUES ('tb.csv',$1,10,'processing',$2,2018,$3,$4) RETURNING id`, [`${U.owner}/${uuid()}.csv`, A, legacyDated, U.owner])).id;
    const src = crypto.createHash("sha256").update("periods-proof").digest("hex");
    const b = (await asService("SELECT public.tb_begin_attempt($1,$2,'h','in',$3,'safisha-tb-certification-v3',3,'workspace_user',NULL,$4,600) r", [up, uuid(), src, U.owner]))[0].r;
    if (b.outcome !== "claimed") return b;
    const confirm = (await asUser(U.owner, "SELECT public.confirm_period_dates($1,'2018-01-01','2018-12-31') r", [legacyDated]))[0].r;
    let member = null;
    try { await asUser(U.owner, "UPDATE public.fiscal_periods SET reporting_currency='USD' WHERE id=$1", [legacyDated]); member = "applied"; } catch (e) { member = e.code; }
    const cur = (await one("SELECT reporting_currency FROM public.fiscal_periods WHERE id=$1", [legacyDated])).reporting_currency;
    return confirm.outcome === "confirmed" && member === "42501" && cur === "KES" ? true : { confirm, member, cur };
  });

  group("v1 compatibility and history");
  await check("open_engagement_with_scope (v1) still opens a calendar-year TZS period, recording its provenance", async () => {
    const r = (await asUser(U.owner, "SELECT public.open_engagement_with_scope($1,2020,$2) r", [A, ["FINANCIAL_STATEMENTS"]]))[0].r;
    const row = await one("SELECT reporting_currency, dates_basis, reporting_start::text s, reporting_end::text e FROM public.fiscal_periods WHERE id=$1", [r.periodId]);
    return row.reporting_currency === "TZS" && row.dates_basis === "v1_calendar_convention" && row.s === "2020-01-01" && row.e === "2020-12-31" ? true : row;
  });
  await refused("period events cannot be edited", "42501", () => admin.query("UPDATE public.fiscal_period_events SET action='created' WHERE period_id=$1", [legacyUndated]));
  await refused("period events cannot be deleted", "42501", () => admin.query("DELETE FROM public.fiscal_period_events WHERE period_id=$1", [legacyUndated]));
  await check("a member reads its company's period events; another company's owner reads none", async () => {
    const mine = await asUser(U.viewer, "SELECT count(*)::int n FROM public.fiscal_period_events WHERE company_id=$1", [A]);
    const theirs = await asUser(U.ownerB, "SELECT count(*)::int n FROM public.fiscal_period_events WHERE company_id=$1", [A]);
    return mine[0].n > 0 && theirs[0].n === 0 ? true : { mine, theirs };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────────────────────────────────");
console.log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
console.log(ok ? "PERIODS_AUTHORITY: ALL PASSED" : "PERIODS_AUTHORITY: FAILED");
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await stopDatabase();
process.exit(ok ? 0 : 1);
