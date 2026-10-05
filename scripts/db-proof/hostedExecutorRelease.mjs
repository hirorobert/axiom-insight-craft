#!/usr/bin/env bun
// OBSOLETE (2026-10-05) — handoff r5 is void: hosted journal entry 0027 is the applied account-review digest fix
// (20261003100000), so r5's proposed 0027/0028 numbering conflicts with the hosted journal. Parked, NOT run in CI, and never
// to be applied as it stands. See release/candidates/OBSOLETE.md.
// Release-application proof for 20261004100000 + 20261005100000 under LOVABLE'S STATED HOSTED-EXECUTOR CONTRACT
// (Lovable's executor report, 2026-10-05): the hosted tool takes ONE SQL string per invocation and runs it in its own
// transaction, inserting that entry's drizzle.__drizzle_migrations row in the SAME transaction; two entries are two
// invocations and two transactions, so 0027 can commit while 0028 fails. It does not use drizzle-orm migrate().
//
// MODELLED, NOT OBSERVED: the hosted executor itself cannot be run here. invoke() implements exactly the stated contract
// — BEGIN; the submitted text; the journal INSERT; COMMIT — on a real PostgreSQL. The journal hash is modelled as the
// SHA-256 of the submitted text (the 0026 precedent: hosted hash = entry file SHA-256); the inspection does not trust that
// assumption blindly (a different hash rule reads INCONSISTENT, which stops the release, never a silent retry).
// Isolation is not stated by Lovable, so concurrency is proven under READ COMMITTED, REPEATABLE READ and SERIALIZABLE.
//
// Proven, on the production-equivalent base (scripts/db-proof/lib/releaseBase.mjs):
//   1. each guarded entry and its journal row commit (or roll back) atomically, in separate transactions;
//   2. 0027 commits, then 0028 fails: the REAL safisha-ingest / -match / -resolve handlers of this tree (the versions the
//      release deploys before the migrations) are gated as designed — ingestion answers 503 and writes nothing; matching
//      and decisions run under 0027's server authority and never record an incomplete 'clean'; client forgery is refused;
//      the MAONO gate stays blocked; the inspection reads PARTIAL and publication is not permitted;
//   3. recovery submits only the unapplied entry: committed 0027 is never reapplied (a resubmission is refused, nothing
//      changes); 0028 out of order is refused;
//   4. concurrent or repeated invocations never commit a duplicate ledger or journal row;
//   5. a lost response is resolved by the read-only inspection (exact ledger, journal hashes, schema postconditions) before
//      any retry: committed → no retry; rolled back → retry once; anything else → STOP.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> bun scripts/db-proof/hostedExecutorRelease.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres for an already-running disposable server)
//
// Synthetic users only; loopback only; refuses the production project reference; creates and drops its own databases.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { call, loadHandler } from "./lib/functionHarness.mjs";
import { RELEASE_2026_10, renderRelease } from "../release/guardedEntry.mjs";
import { Client, Pool, REPO, SRC_DIR, hostedJournal, releaseServer, sha256 } from "./lib/releaseBase.mjs";

const [E27, E28] = RELEASE_2026_10.entries;
const entryText = (e) => fs.readFileSync(path.join(REPO, "release/candidates", `${e.tag}.sql`), "utf8");
const entryHash = (e) => sha256(Buffer.from(entryText(e), "utf8"));
const INSPECTION = fs.readFileSync(path.join(REPO, "release/candidates/inspect_release_2026_10.sql"), "utf8");
const HOSTED_0026_HASH = "704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8";

const results = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}
const observe = (name, value) => console.log(`  OBSERVED  ${name}: ${JSON.stringify(value)}`);

const PG = releaseServer("hosted");

// ── The stated executor contract ────────────────────────────────────────────────────────────────────────────────────
/** One hosted invocation: the submitted text and its journal row in ONE transaction of its own. `failJournal` makes the
 *  executor's own journal write fail; `name` tags the backend (application_name) so a test can cancel or terminate it. */
async function invoke(url, sql, { isolation = "READ COMMITTED", failJournal = false, name = "release-invocation" } = {}) {
  const c = new Client({ connectionString: url, ssl: false, application_name: name }); await c.connect();
  c.on("error", () => { /* a terminated backend */ });
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await c.query(sql);
    await c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [failJournal ? null : sha256(Buffer.from(sql, "utf8")), Date.now()]);
    await c.query("COMMIT");
    return { ok: true };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* */ }
    return { ok: false, code: e.code ?? null, message: String(e.message ?? e).split("\n")[0] };
  } finally { try { await c.end(); } catch { /* */ } }
}
async function q(url, sql, params) { const c = new Client({ connectionString: url, ssl: false }); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } }
/** The inspection exactly as handed off, inside BEGIN READ ONLY … ROLLBACK. */
async function inspect(url) {
  const c = new Client({ connectionString: url, ssl: false }); await c.connect();
  try { await c.query("BEGIN READ ONLY"); const rows = (await c.query(INSPECTION)).rows; await c.query("ROLLBACK"); return rows; } finally { await c.end(); }
}
const verdict = (rows) => ({ e27: rows[0].state, e28: rows[1].state, release: rows[2].state, next27: rows[0].next_step, next28: rows[1].next_step,
  publication: rows[2].publication_permitted, after: Number(rows[2].journal_rows_after_pre_release) });
/** Everything the release could change: release functions and triggers, release tables and columns, journal, ledger. */
async function digest(url) {
  return (await q(url, `SELECT md5(concat_ws('|',
    (SELECT string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(array_to_string(p.proacl, ','), ''), ',' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE ANY (ARRAY['safisha%', '_safisha%', 'maono_check%'])),
    (SELECT string_agg(t.tgname || t.tgrelid::regclass::text, ',' ORDER BY t.tgname, t.tgrelid::regclass::text) FROM pg_trigger t WHERE NOT t.tgisinternal),
    (SELECT string_agg(c.table_name || '.' || c.column_name, ',' ORDER BY c.table_name, c.column_name) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name LIKE ANY (ARRAY['safisha%', '_release%'])),
    (SELECT string_agg(m.id || ':' || m.hash, ',' ORDER BY m.id) FROM drizzle.__drizzle_migrations m),
    CASE WHEN to_regclass('public._release_migration_ledger') IS NOT NULL THEN (xpath('/row/d/text()', query_to_xml('SELECT string_agg(source || source_sha256, '','' ORDER BY source) AS d FROM public._release_migration_ledger', false, true, '')))[1]::text END)) AS d`))[0].d;
}
const journalCount = async (url, hash) => Number((await q(url, "SELECT count(*) n FROM drizzle.__drizzle_migrations WHERE hash = $1", [hash]))[0].n);
const ledgerRows = async (url) => (await q(url, "SELECT source, source_sha256 FROM public._release_migration_ledger ORDER BY source").catch(() => []));
const objects = async (url) => (await q(url, `SELECT ${E27.probe} AS e27, ${E28.probe} AS e28, to_regclass('public.safisha_ingestions') IS NOT NULL AS ingestions`))[0];
async function verifyFile(url, file) {
  const c = new Client({ connectionString: url, ssl: false }); await c.connect();
  try { await c.query("BEGIN READ ONLY"); const rows = (await c.query(fs.readFileSync(path.join(REPO, "scripts/db-preflight", file), "utf8"))).rows; await c.query("ROLLBACK"); return rows.filter((r) => r.ok !== true).map((r) => r.item); }
  finally { await c.end(); }
}
/** The handed-off procedure after an uncertain outcome: inspect read-only; submit `entry` only when its next_step says so. */
async function resolveThenRetry(url, entry) {
  const rows = await inspect(url); const row = rows.find((r) => r.item === entry.tag);
  if (!row.next_step.startsWith("submit")) return { retried: false, next: row.next_step };
  return { retried: true, result: await invoke(url, entryText(entry)) };
}

// ── Synthetic workspace and the real handlers ──────────────────────────────────────────────────────────────────────
async function seed(pool) {
  const run = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);
  const U = { owner: crypto.randomUUID(), partner: crypto.randomUUID(), preparer: crypto.randomUUID() };
  for (const [k, id] of Object.entries(U)) await run("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}-${PG.RUN}@example.test`]);
  const prod = (await run("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'"))[0].id;
  const bc = (await run("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod]))[0].id;
  await run("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  const company = (await run("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Release Co') RETURNING id", [U.owner]))[0].id;
  await run("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now()), ($1,$3,'preparer',now())", [company, U.partner, U.preparer]);
  return { U, company, year: 2000 };
}
async function newUpload(pool, ws) {
  ws.year += 1;
  return (await pool.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',$3,$4,$5) RETURNING id",
    [`tb-${ws.year}.csv`, `workspaces/${ws.company}/${crypto.randomUUID()}/tb.csv`, ws.company, ws.year, ws.U.owner])).rows[0].id;
}
/** A reconciliation as ingestion leaves it (fixture rows written by the database owner). */
async function reconciliation(pool, ws, { matched, unmatched }) {
  const up = await newUpload(pool, ws);
  await pool.query("UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [up]);
  const r = (await pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [ws.U.owner, up])).rows[0].id;
  for (let i = 0; i < matched; i += 1) for (const src of ["tb", "bank"])
    await pool.query("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,raw_row_hash) VALUES ($1,$2,$3,'Cash','2025-01-31',100,$4)", [r, src, String(1000 + i), crypto.randomUUID()]);
  for (let i = 0; i < unmatched; i += 1)
    await pool.query("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,raw_row_hash) VALUES ($1,'tb',$2,'Suspense','2025-01-31',250,$3)", [r, String(9000 + i), crypto.randomUUID()]);
  return { up, r };
}
const stored = async (pool, f) => (await pool.query("SELECT u.safisha_status s, r.status r FROM public.trial_balance_uploads u JOIN public.safisha_reconciliations r ON r.tb_upload_id=u.id WHERE u.id=$1", [f.up])).rows[0];
const gateBlocked = async (pool, up) => (await pool.query("SELECT is_blocked FROM public.maono_check_safisha_gate($1::uuid[])", [[up]])).rows[0].is_blocked;
function ingestForm(up, key) {
  const f = new FormData();
  f.append("upload_id", up); f.append("source_type", "bank");
  f.append("file", new File(["Code,Name,Date,Debit,Credit\n1000,Cash,2025-01-31,100,\n"], "bank.csv", { type: "text/csv" }));
  f.append("mapping_override", JSON.stringify({ Code: "account_code", Name: "account_name", Date: "txn_date", Debit: "debit", Credit: "credit" }));
  f.append("ingestion_key", key);
  return f;
}
async function asClient(pool, uid, sql, params) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const r = await c.query(sql, params); await c.query("COMMIT"); return `ok:${r.rowCount}`; }
  catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } return e.code; } finally { c.release(); }
}

async function main() {
  console.log("\n== Entries, inspection and lineage");
  await check("both approved sources are unchanged (exact bytes and SHA-256)", () => {
    const bad = RELEASE_2026_10.entries.filter((e) => { const b = fs.readFileSync(path.join(SRC_DIR, e.source)); return b.length !== e.bytes || sha256(b) !== e.digest; });
    return bad.length === 0 ? true : bad.map((e) => e.source);
  });
  await check("the committed entries and inspection are exactly their rendering (scripts/release/guardedEntry.mjs)", () => {
    const bad = Object.entries(renderRelease(REPO)).filter(([rel, text]) => fs.readFileSync(path.join(REPO, rel), "utf8") !== text).map(([rel]) => rel);
    return bad.length === 0 ? true : bad;
  });
  await check("the latest hosted journal entry is 0026 with hash 704beb2d… (the hosted row Lovable reported); the inspection anchors on it", () => {
    const last = hostedJournal().at(-1);
    return last.tag === RELEASE_2026_10.after && last.hash === HOSTED_0026_HASH && INSPECTION.includes(HOSTED_0026_HASH) ? true : last;
  });
  await check("source hashes and guarded-entry journal hashes are distinct, and the inspection checks both", () =>
    RELEASE_2026_10.entries.every((e) => entryHash(e) !== e.digest && INSPECTION.includes(entryHash(e)) && INSPECTION.includes(e.digest)) ? true : RELEASE_2026_10.entries.map((e) => [e.digest, entryHash(e)]));

  await PG.start();
  const pools = [];
  try {
    const base = await PG.buildBase(RELEASE_2026_10.entries.map((e) => e.source));
    console.log(`  base: ${base.applied} source migrations; hosted journal reproduced (${base.journalRows} rows); PR #34 staging table present`);
    const H = {
      ingest: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-ingest/index.ts"), "utf8"), "release-ingest"),
      match: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-match/index.ts"), "utf8"), "release-match"),
      resolve: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-resolve/index.ts"), "utf8"), "release-resolve"),
    };

    console.log("\n== Before the release: the inspection is read-only and reads NOT_STARTED");
    { const url = await PG.copyOf(base.name, "before");
      const d0 = await digest(url); const v = verdict(await inspect(url)); const d1 = await digest(url);
      await check("NOT_STARTED: 0027 'submit', 0028 'wait'; publication not permitted; nothing changed", () =>
        v.release === "NOT_STARTED" && v.e27 === "NOT_APPLIED" && v.next27.startsWith("submit") && v.next28.startsWith("wait") && v.publication === false && d0 === d1 ? true : v); }

    // ── 1. Each entry and its journal row, atomically, in separate transactions ─────────────────────────────────────
    console.log("\n== 1. One invocation per entry: entry and journal row atomic, separate transactions");
    { const url = await PG.copyOf(base.name, "single");
      const r27 = await invoke(url, entryText(E27));
      const v1 = verdict(await inspect(url));
      await check("0027 commits with exactly one journal row (its entry hash), one ledger row (its source digest); release PARTIAL, publication blocked", async () => {
        const l = await ledgerRows(url);
        return r27.ok && (await journalCount(url, entryHash(E27))) === 1 && (await journalCount(url, E27.digest)) === 0 && l.length === 1 && l[0].source_sha256 === E27.digest
          && v1.release === "PARTIAL" && v1.e27 === "APPLIED" && v1.publication === false && v1.next28.startsWith("submit") ? true : { r27, v1, l }; });
      const r28 = await invoke(url, entryText(E28));
      const v2 = verdict(await inspect(url));
      await check("0028 commits in its own transaction; release COMPLETE; publication permitted; both verification files all true", async () => {
        const xmins = (await q(url, "SELECT xmin::text x FROM drizzle.__drizzle_migrations WHERE hash = ANY($1)", [[entryHash(E27), entryHash(E28)]])).map((r) => r.x);
        const bad = [...await verifyFile(url, E27.verify), ...await verifyFile(url, E28.verify)];
        return r28.ok && xmins.length === 2 && new Set(xmins).size === 2 && v2.release === "COMPLETE" && v2.publication === true && v2.after === 2 && bad.length === 0 ? true : { r28, xmins, v2, bad }; });
      const d = await digest(url);
      const again = [await invoke(url, entryText(E27)), await invoke(url, entryText(E28)), await invoke(url, entryText(E27))];
      await check("repeated invocations of either entry are REFUSED (55000 RELEASE_ALREADY_APPLIED); no ledger or journal row added; nothing changed", async () =>
        again.every((r) => !r.ok && r.code === "55000" && /RELEASE_ALREADY_APPLIED/.test(r.message)) && (await digest(url)) === d ? true : again); }
    { const url = await PG.copyOf(base.name, "journal_fail");
      const r = await invoke(url, entryText(E27), { failJournal: true }); const o = await objects(url); const v = verdict(await inspect(url));
      await check("the executor's journal write failing rolls back the whole entry: no ledger, no objects, no journal row (NOT_STARTED)", () =>
        !r.ok && r.code === "23502" && !o.e27 && v.release === "NOT_STARTED" && v.after === 0 ? true : { r, o, v }); }
    { const url = await PG.copyOf(base.name, "postcondition");
      await q(url, "CREATE TRIGGER ac_reconciliation_freshness BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()");
      const r = await invoke(url, entryText(E27)); const o = await objects(url);
      await check("a failed postcondition refuses the entry (55000 RELEASE_POSTCONDITION_FAILED): no journal row, nothing applied", async () =>
        !r.ok && r.code === "55000" && /POSTCONDITION/.test(r.message) && !o.e27 && (await journalCount(url, entryHash(E27))) === 0 ? true : { r, o }); }

    // ── 2. 0027 commits, 0028 fails ────────────────────────────────────────────────────────────────────────────────
    console.log("\n== 2. 0027 commits, then 0028 fails (a live session holds a lock it needs; the invocation is cancelled)");
    const url = await PG.copyOf(base.name, "partial");
    const pool = new Pool({ connectionString: url, ssl: false, max: 10 }); pools.push(pool);
    const ws = await seed(pool);
    const r27 = await invoke(url, entryText(E27));
    const holder = new Client({ connectionString: url, ssl: false }); await holder.connect();
    await holder.query("BEGIN"); await holder.query("LOCK TABLE public.safisha_transactions IN ACCESS SHARE MODE");
    const pending = invoke(url, entryText(E28), { name: "release-0028" });
    for (let i = 0; i < 100; i += 1) { if ((await q(url, "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = 'release-0028' AND wait_event_type = 'Lock'"))[0].n === 1) break; await new Promise((r) => setTimeout(r, 50)); }
    await q(url, "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = 'release-0028'");
    const r28 = await pending;
    await holder.query("ROLLBACK"); await holder.end();
    await check("0027 committed; 0028 failed (57014) and left nothing: no 0028 journal row, ledger holds 0027 only, 0028 objects absent", async () => {
      const l = await ledgerRows(url); const o = await objects(url);
      return r27.ok && !r28.ok && r28.code === "57014" && (await journalCount(url, entryHash(E28))) === 0 && (await journalCount(url, entryHash(E27))) === 1
        && l.length === 1 && l[0].source === E27.source && o.e27 && !o.e28 && !o.ingestions ? true : { r27, r28, l, o }; });
    await check("0027's postconditions hold on their own (reconciliationAuthorityVerify.sql all true)", async () => { const bad = await verifyFile(url, E27.verify); return bad.length === 0 ? true : bad; });
    { const v = verdict(await inspect(url));
      await check("inspection: PARTIAL — 0027 APPLIED ('never resubmit'), 0028 NOT_APPLIED ('submit once'); publication NOT permitted", () =>
        v.release === "PARTIAL" && v.e27 === "APPLIED" && v.next27.startsWith("none") && v.e28 === "NOT_APPLIED" && v.next28.startsWith("submit") && v.publication === false && v.after === 1 ? true : v); }
    { const up = await newUpload(pool, ws);
      const r = await call(H.ingest, pool, ws.U.owner, ingestForm(up, `${up}:partial`));
      const st = (await pool.query("SELECT (SELECT count(*)::int FROM public.safisha_reconciliations WHERE tb_upload_id=$1) recons, (SELECT safisha_status FROM public.trial_balance_uploads WHERE id=$1) s", [up])).rows[0];
      await check("ingestion is gated: the release's safisha-ingest answers 503 and writes nothing (no reconciliation, no upload status)", () =>
        r.http === 503 && st.recons === 0 && st.s === null ? true : { http: r.http, body: r.body, st }); }
    { const F1 = await reconciliation(pool, ws, { matched: 2, unmatched: 0 });
      const m1 = await call(H.match, pool, ws.U.owner, { reconciliation_id: F1.r });
      const F2 = await reconciliation(pool, ws, { matched: 1, unmatched: 1 });
      const m2 = await call(H.match, pool, ws.U.owner, { reconciliation_id: F2.r });
      const forged = await asClient(pool, ws.U.owner, "UPDATE public.trial_balance_uploads SET safisha_status='clean' WHERE id=$1", [F2.up]);
      const forgedRecon = await asClient(pool, ws.U.owner, "UPDATE public.safisha_reconciliations SET status='clean' WHERE id=$1", [F2.r]);
      const before = { s: await stored(pool, F2), gate: await gateBlocked(pool, F2.up) };
      await check("matching runs under 0027's authority: complete → clean; one unmatched line → needs_review; client forgery of 'clean' refused; MAONO gate blocked", async () =>
        m1.http === 200 && (await stored(pool, F1)).s === "clean" && m2.http === 200 && before.s.r === "needs_review" && before.s.s !== "clean"
          && !String(forged).startsWith("ok") && !String(forgedRecon).startsWith("ok") && before.gate === true ? true : { m1: m1.http, m2: m2.http, forged, forgedRecon, before });
      const [x] = (await pool.query("SELECT id FROM public.safisha_exceptions WHERE reconciliation_id=$1", [F2.r])).rows;
      const esc = await call(H.resolve, pool, ws.U.preparer, { exception_id: x.id, action: "escalated" });
      const afterEsc = { s: await stored(pool, F2), gate: await gateBlocked(pool, F2.up) };
      const self = await call(H.resolve, pool, ws.U.preparer, { exception_id: x.id, action: "approved" });
      const app = await call(H.resolve, pool, ws.U.partner, { exception_id: x.id, action: "approved" });
      const afterApp = { s: await stored(pool, F2), gate: await gateBlocked(pool, F2.up) };
      await check("decisions run under 0027's authority: escalated stays open and blocked; the escalating preparer cannot approve it; a different senior reviewer's approval → clean, gate open", () =>
        esc.http === 200 && afterEsc.s.s !== "clean" && afterEsc.gate === true && self.http !== 200 && app.http === 200 && afterApp.s.s === "clean" && afterApp.gate === false
          ? true : { esc: esc.http, afterEsc, self: self.http, app: app.http, afterApp }); }

    // ── 3. Recovery: only the unapplied entry ──────────────────────────────────────────────────────────────────────
    console.log("\n== 3. Recovery submits only the unapplied entry");
    { const d = await digest(url);
      const re27 = await invoke(url, entryText(E27));
      await check("resubmitting committed 0027 is REFUSED (55000 RELEASE_ALREADY_APPLIED) and changes nothing", async () =>
        !re27.ok && re27.code === "55000" && /RELEASE_ALREADY_APPLIED/.test(re27.message) && (await digest(url)) === d ? true : re27);
      const p27 = await resolveThenRetry(url, E27); const p28 = await resolveThenRetry(url, E28);
      const v = verdict(await inspect(url));
      await check("the procedure (inspect, then submit only what next_step says) skips 0027 and applies 0028; COMPLETE; exactly one journal row per entry", async () =>
        !p27.retried && p28.retried && p28.result.ok && v.release === "COMPLETE" && v.publication === true && v.after === 2
          && (await journalCount(url, entryHash(E27))) === 1 && (await journalCount(url, entryHash(E28))) === 1 ? true : { p27, p28, v });
      const up = await newUpload(pool, ws);
      const r = await call(H.ingest, pool, ws.U.owner, ingestForm(up, `${up}:recovered`));
      await check("after recovery, ingestion works through the authoritative path (200, one row stored)", () => r.http === 200 && r.body?.inserted === 1 ? true : { http: r.http, body: r.body }); }
    { const u2 = await PG.copyOf(base.name, "order");
      const raw = await (async () => { const c = new Client({ connectionString: u2, ssl: false }); await c.connect();
        try { await c.query("BEGIN"); await c.query(fs.readFileSync(path.join(SRC_DIR, E28.source), "utf8")); await c.query("ROLLBACK"); return "applies"; } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } return e.code; } finally { await c.end(); } })();
      observe("the bare 20261005100000 source on a schema WITHOUT 20261004100000 (rolled back)", raw);
      const r = await invoke(u2, entryText(E28)); const v = verdict(await inspect(u2)); const o = await objects(u2);
      await check("why 0028 needs its prerequisite (measured): the bare source would apply without 0027; the guarded 0028 is REFUSED (55000 RELEASE_PREREQUISITE_MISSING), writes nothing; NOT_STARTED", () =>
        raw === "applies" && !r.ok && r.code === "55000" && /RELEASE_PREREQUISITE_MISSING/.test(r.message) && !o.e28 && v.release === "NOT_STARTED" ? true : { raw, r, v, o }); }

    // ── 4. Concurrent and repeated invocations ─────────────────────────────────────────────────────────────────────
    console.log("\n== 4. Concurrent and repeated invocations never duplicate ledger or journal rows");
    for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]) {
      const u = await PG.copyOf(base.name, `conc_${isolation.split(" ")[0].toLowerCase()}`);
      const a = await Promise.all(Array.from({ length: 8 }, () => invoke(u, entryText(E27), { isolation })));
      const b = await Promise.all(Array.from({ length: 8 }, () => invoke(u, entryText(E28), { isolation })));
      const v = verdict(await inspect(u)); const l = await ledgerRows(u);
      const codes = (rs) => [...new Set(rs.filter((r) => !r.ok).map((r) => r.code))].sort();
      observe(`${isolation}: refusal codes 0027 / 0028`, [codes(a), codes(b)]);
      await check(`${isolation}: 8 simultaneous 0027 then 8 simultaneous 0028 — exactly one of each commits; one ledger and one journal row each; COMPLETE`, async () =>
        a.filter((r) => r.ok).length === 1 && b.filter((r) => r.ok).length === 1 && l.length === 2 && (await journalCount(u, entryHash(E27))) === 1
          && (await journalCount(u, entryHash(E28))) === 1 && v.release === "COMPLETE" && v.after === 2 ? true : { a: a.map((r) => r.ok || r.code), b: b.map((r) => r.ok || r.code), l, v });
    }
    { const u = await PG.copyOf(base.name, "conc_mixed");
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => invoke(u, entryText(i % 2 ? E28 : E27))));
      const v = verdict(await inspect(u));
      observe("10 simultaneous mixed 0027/0028 invocations", { outcomes: rs.map((r) => (r.ok ? "ok" : r.code)), release: v.release });
      await check("10 simultaneous mixed 0027/0028 invocations: at most one commit per entry, 0028 never before 0027; the state is COMPLETE or PARTIAL, never INCONSISTENT", async () =>
        (await journalCount(u, entryHash(E27))) === 1 && (await journalCount(u, entryHash(E28))) <= 1 && ["COMPLETE", "PARTIAL"].includes(v.release) ? true : v); }

    // ── 5. Lost responses ───────────────────────────────────────────────────────────────────────────────────────────
    console.log("\n== 5. A lost response is resolved by the read-only inspection before any retry");
    { const u = await PG.copyOf(base.name, "lost_committed");
      await invoke(u, entryText(E27)); // the response is lost: the caller never sees this result
      const d = await digest(u); const p = await resolveThenRetry(u, E27);
      await check("committed, response lost: the inspection reads 0027 APPLIED; the procedure does NOT retry; nothing changes", async () =>
        !p.retried && p.next.startsWith("none") && (await digest(u)) === d && (await journalCount(u, entryHash(E27))) === 1 ? true : p); }
    { const u = await PG.copyOf(base.name, "lost_rolled_back");
      const holder = new Client({ connectionString: u, ssl: false }); await holder.connect();
      await holder.query("SELECT pg_advisory_lock(hashtextextended('cfoclose_release_ledger', 0))");
      const pending = invoke(u, entryText(E27), { name: "release-lost" });
      for (let i = 0; i < 100; i += 1) { if ((await q(u, "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name = 'release-lost' AND wait_event_type = 'Lock'"))[0].n === 1) break; await new Promise((r) => setTimeout(r, 50)); }
      await q(u, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'release-lost'");
      const lost = await pending; await holder.end();
      const v = verdict(await inspect(u)); const p = await resolveThenRetry(u, E27); const v2 = verdict(await inspect(u));
      await check("connection lost mid-invocation: NOT_STARTED (rolled back) → the procedure retries ONCE → PARTIAL, one journal row", async () =>
        !lost.ok && v.release === "NOT_STARTED" && p.retried && p.result.ok && v2.release === "PARTIAL" && (await journalCount(u, entryHash(E27))) === 1 ? true : { lost, v, p, v2 }); }
    const inconsistent = async (label, mutate) => {
      const u = await PG.copyOf(base.name, label); await mutate(u);
      const d = await digest(u); const v = verdict(await inspect(u)); const p27 = await resolveThenRetry(u, E27); const p28 = await resolveThenRetry(u, E28);
      return { v, unchanged: (await digest(u)) === d, retried: p27.retried || p28.retried };
    };
    const stopped = (r) => r.v.release === "INCONSISTENT" && r.v.publication === false && r.v.next27.startsWith("STOP") && r.v.next28.startsWith("STOP") && r.unchanged && !r.retried;
    { const r = await inconsistent("inc_outside", async (u) => { await q(u, entryText(E27)); });
      await check("applied OUTSIDE the executor (ledger and objects, no journal row): INCONSISTENT → STOP; no retry; publication blocked", () => (stopped(r) ? true : r)); }
    { const r = await inconsistent("inc_bare", async (u) => { await invoke(u, fs.readFileSync(path.join(SRC_DIR, E27.source), "utf8")); });
      await check("the bare source applied through the executor (journal hash = source hash, no ledger): INCONSISTENT → STOP", () => (stopped(r) ? true : r)); }
    { const r = await inconsistent("inc_extra", async (u) => { await invoke(u, entryText(E27)); await q(u, "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unexpected', $1)", [Date.now() + 1000]); });
      await check("an unexpected journal row after 0026: INCONSISTENT → STOP", () => (stopped(r) ? true : r)); }
    { const r = await inconsistent("inc_hash", async (u) => { await invoke(u, entryText(E27)); await q(u, "UPDATE drizzle.__drizzle_migrations SET hash = 'another-hash-rule' WHERE hash = $1", [entryHash(E27)]); });
      await check("a journal hash computed by a different rule than the entry's SHA-256: INCONSISTENT → STOP (never a silent retry)", () => (stopped(r) ? true : r)); }
  } finally {
    for (const p of pools) { try { await p.end(); } catch { /* */ } }
    await PG.cleanup();
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); }
process.exit(code);
