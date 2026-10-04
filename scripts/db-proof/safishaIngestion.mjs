#!/usr/bin/env bun
// Evidence ingestion proof: the REAL safisha-ingest handler — main's version (byte-identical fixture, pinned by git blob
// hash) and this tree's — against disposable PostgreSQL WITHOUT and WITH the ingestion migration
// (20261005100000_safisha_ingestion_authority.sql), through the shared harness (real role, row-level security, triggers;
// only the network edge replaced).
//
// Scenarios, each on its own synthetic upload: creation and retry; a lost response; a partial failure (reconciliation
// created, upload status never set); a non-owner preparer; simultaneous identical ingests; legitimate identical source
// rows; different evidence sources with identical text; overlapping and repeated files; the column-mapping round trip;
// unauthorized and cross-tenant requests.
//
//   old handler × old schema   the baseline, RECORDED (not asserted): what production does today;
//   new handler × new schema   every scenario ASSERTED;
//   new handler × old schema   deployment order: every call refused (503) and nothing written;
//   old handler × new schema   deployment order: nothing duplicated or forged.
//
//   DB_PROOF_MODULES_DIR=<dir with node_modules/pg + embedded-postgres> bun ./scripts/db-proof/safishaIngestion.mjs
//   (or DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres for an already-running disposable server)
//
// Synthetic users only; loopback only; refuses the production project reference; creates and drops its own databases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { call, loadHandler } from "./lib/functionHarness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261005100000_safisha_ingestion_authority.sql";
const OLD_DIR = path.join(HERE, "fixtures/functions-main-e8962f2");
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
const observations = [];
function record(name, ok, detail = "") { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); }
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : JSON.stringify(r)); } catch (e) { record(name, false, String(e?.message ?? e).split("\n")[0]); }
}
const observe = (name, value) => { observations.push({ name, value }); console.log(`  OBSERVED  ${name}: ${JSON.stringify(value)}`); };

// ── Disposable server and databases ─────────────────────────────────────────────────────────────────────────────────
const RUN = `${process.pid}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
let server, dir, maintenanceUrl;
const createdDbs = [];
async function startServer() {
  let url = process.env.DB_PROOF_CONN;
  if (!url) {
    const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
    const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-ingest-proof-"));
    const port = 57000 + Math.floor(Math.random() * 900);
    server = new EmbeddedPostgres({ databaseDir: path.join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, createPostgresUser: typeof process.getuid === "function" && process.getuid() === 0, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await server.initialise(); await server.start();
    url = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || url.includes(PRODUCTION_REF)) throw new Error("REFUSED: not a disposable local database");
  maintenanceUrl = url;
}
async function newDatabase(label) {
  const name = `ingest_proof_${label}_${RUN}`;
  const boot = new Client({ connectionString: maintenanceUrl, ssl: false }); await boot.connect();
  try { await boot.query(`CREATE DATABASE "${name}"`); createdDbs.push(name); } finally { await boot.end(); }
  const u = new URL(maintenanceUrl); u.pathname = `/${name}`; return u.toString();
}
async function stop(pools) {
  for (const p of pools) { try { await p.end(); } catch { /* */ } }
  if (createdDbs.length) {
    const boot = new Client({ connectionString: maintenanceUrl, ssl: false }); await boot.connect();
    for (const n of createdDbs) { try { await boot.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); console.log(`  dropped ${n}`); } catch (e) { console.error(`  could not drop ${n}: ${e?.message ?? e}`); } }
    await boot.end();
  }
  try { await server?.stop(); } catch { /* */ } try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}
async function migrate(url, withCandidate) {
  const db = new Client({ connectionString: url, ssl: false }); await db.connect();
  try {
    await db.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
    await db.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
    const all = fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    const files = all.filter((f) => withCandidate || f !== MIGRATION);
    for (const f of files) {
      let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
      if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      try { await db.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
    }
    return { applied: files.length, candidatePresent: all.includes(MIGRATION) };
  } finally { await db.end(); }
}
const gitBlobSha1 = (buf) => crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

// ── Synthetic workspaces ────────────────────────────────────────────────────────────────────────────────────────────
async function seed(pool) {
  const q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);
  const U = Object.fromEntries(["owner", "partner", "preparer", "viewer", "prepareOnly", "outsider", "ownerB"].map((k) => [k, crypto.randomUUID()]));
  for (const [k, id] of Object.entries(U)) await q("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}-${RUN}@example.test`]);
  const prod = (await q("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'"))[0].id;
  for (const [uid, plan, seats] of [[U.owner, "PRACTICE", 6], [U.outsider, "SOLO", 0], [U.ownerB, "SOLO", 0]]) {
    const bc = (await q("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod]))[0].id;
    await q("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', $3 FROM public.commercial_plans WHERE product_id=$2 AND code=$4", [bc, prod, seats, plan]);
  }
  const A = (await q("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Ingest Co') RETURNING id", [U.owner]))[0].id;
  const B = (await q("INSERT INTO public.companies (user_id,name) VALUES ($1,'Synthetic Other Tenant') RETURNING id", [U.ownerB]))[0].id;
  await q("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now()), ($1,$3,'preparer',now()), ($1,$4,'viewer',now())", [A, U.partner, U.preparer, U.viewer]);
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [U.owner]);
    await c.query("SELECT * FROM public.grant_workspace_capability($1,$2,'prepare_trial_balance')", [A, U.prepareOnly]);
    await c.query("COMMIT");
  } finally { c.release(); }
  return { U, A, B, year: 2000 };
}
async function newUploadRow(pool, ws, company = ws.A, owner = ws.U.owner) {
  ws.year += 1;
  return (await pool.query("INSERT INTO public.trial_balance_uploads (file_name,file_path,file_size,status,company_id,period_year,user_id) VALUES ($1,$2,10,'complete',$3,$4,$5) RETURNING id",
    [`tb-${ws.year}.csv`, `workspaces/${company}/${crypto.randomUUID()}/tb.csv`, company, ws.year, owner])).rows[0].id;
}

const MAPPING = { Code: "account_code", Name: "account_name", Date: "txn_date", Debit: "debit", Credit: "credit", Ref: "reference" };
const csv = (rows) => ["Code,Name,Date,Debit,Credit,Ref", ...rows].join("\n") + "\n";
const R1 = "1000,Cash,2025-01-31,100,,R-1";
const R2 = "2000,Bank charges,2025-01-31,5,,R-2";
const R3 = "3000,Interest,2025-02-28,,7,R-3";
function form(uploadId, sourceType, text, name, mapping = MAPPING) {
  const f = new FormData();
  f.append("upload_id", uploadId);
  f.append("source_type", sourceType);
  f.append("file", new File([text], name, { type: "text/csv" }));
  if (mapping) f.append("mapping_override", JSON.stringify(mapping));
  return f;
}
async function state(pool, uploadId) {
  const u = (await pool.query("SELECT safisha_status FROM public.trial_balance_uploads WHERE id=$1", [uploadId])).rows[0];
  const recons = (await pool.query("SELECT id, status, evidence_files FROM public.safisha_reconciliations WHERE tb_upload_id=$1", [uploadId])).rows;
  const rows = recons.length ? (await pool.query("SELECT source_id, account_code, raw_row_number, to_jsonb(t) AS j FROM public.safisha_transactions t WHERE reconciliation_id = ANY($1::uuid[]) ORDER BY source_id, account_code, raw_row_number", [recons.map((r) => r.id)])).rows : [];
  return { upload: u?.safisha_status ?? null, recons: recons.length, recon: recons[0]?.id ?? null, reconStatus: recons[0]?.status ?? null,
    evidence: recons.reduce((n, r) => n + (r.evidence_files?.length ?? 0), 0), rows: rows.length,
    bySource: rows.reduce((m, r) => ({ ...m, [r.source_id]: (m[r.source_id] ?? 0) + 1 }), {}), detail: rows.map((r) => r.j) };
}
const countWhere = (rows, code) => rows.filter((r) => r.account_code === code).length;

async function main() {
  console.log("\n== Handlers");
  const manifest = JSON.parse(fs.readFileSync(path.join(OLD_DIR, "manifest.json"), "utf8"));
  await check("the OLD safisha-ingest is byte-identical to main's (git blob hash matches the manifest)", async () => {
    const got = gitBlobSha1(fs.readFileSync(path.join(OLD_DIR, "ingest.index.ts")));
    return got === manifest.files["ingest.index.ts"].git_blob_sha1 ? true : got;
  });
  const H = {
    old: await loadHandler(fs.readFileSync(path.join(OLD_DIR, "ingest.index.ts"), "utf8"), "old-ingest"),
    new: await loadHandler(fs.readFileSync(path.join(REPO, "supabase/functions/safisha-ingest/index.ts"), "utf8"), "new-ingest"),
  };

  await startServer();
  const pools = [];
  try {
    const S = {};
    let candidatePresent = false;
    for (const [label, withCandidate] of [["old", false], ["new", true]]) {
      const url = await newDatabase(label);
      const m = await migrate(url, withCandidate);
      candidatePresent = m.candidatePresent;
      console.log(`  ${label} schema: ${m.applied} migrations${withCandidate ? "" : ` (without ${MIGRATION})`}`);
      const pool = new Pool({ connectionString: url, ssl: false, max: 30 }); pools.push(pool);
      S[label] = { pool, ws: await seed(pool) };
    }

    const ingest = (h, s, who, upload, sourceType, text, name, mapping) => call(h, s.pool, who, form(upload, sourceType, text, name, mapping));

    /** Every scenario against one handler × schema; returns the observed outcome of each (assertions are applied by the caller). */
    const scenarios = async (h, s, { precreate = false } = {}) => {
      const out = {};
      const U = s.ws.U;
      // precreate: the reconciliation already exists (as a seeded fixture), so the old handler's creation defect does not
      // mask its deduplication and concurrency behaviour.
      const newUpload = async (pool, ws) => { const up = await newUploadRow(pool, ws);
        if (precreate) await pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [U.owner, up]);
        return up; };
      // 1. creation, retry, lost response (a retry of the identical request)
      { const up = await newUpload(s.pool, s.ws); const file = csv([R1, R2]);
        const first = await ingest(h, s, U.owner, up, "bank", file, "jan.csv"); const afterFirst = await state(s.pool, up);
        const retry = await ingest(h, s, U.owner, up, "bank", file, "jan.csv"); const afterRetry = await state(s.pool, up);
        out.creation = { first: first.http, firstBody: first.body?.error ?? first.body?.inserted, afterFirst: { ...afterFirst, detail: undefined },
          retry: retry.http, retryInserted: retry.body?.inserted ?? retry.body?.error, afterRetry: { ...afterRetry, detail: undefined } }; }
      // 2. partial failure: the reconciliation exists (a previous attempt created it) but the upload status was never set
      { const up = await newUploadRow(s.pool, s.ws);
        await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [U.owner, up]);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1]), "feb.csv"); const st = await state(s.pool, up);
        out.partialFailure = { http: r.http, upload: st.upload, recons: st.recons, rows: st.rows }; }
      // 3. a non-owner preparer (prepare_close, no upload UPDATE policy) starts the reconciliation
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.preparer, up, "bank", csv([R1]), "pre.csv"); const st = await state(s.pool, up);
        out.preparer = { http: r.http, error: r.body?.error ?? null, upload: st.upload, recons: st.recons, rows: st.rows }; }
      // 4. simultaneous identical ingests
      { const up = await newUpload(s.pool, s.ws); const file = csv([R1, R2, R3]);
        const rs = await Promise.all(Array.from({ length: 8 }, () => ingest(h, s, U.owner, up, "bank", file, "same.csv")));
        const st = await state(s.pool, up);
        out.concurrent = { https: [...new Set(rs.map((r) => r.http))], recons: st.recons, rows: st.rows, evidence: st.evidence, upload: st.upload }; }
      // 5. legitimate identical source rows (the same line twice in one statement)
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1, R1, R2]), "twins.csv"); const st = await state(s.pool, up);
        out.identicalRows = { http: r.http, rows: st.rows, r1: countWhere(st.detail, "1000") }; }
      // 6. different evidence sources whose row text is identical
      { const up = await newUpload(s.pool, s.ws);
        const a = await ingest(h, s, U.owner, up, "tb", csv([R1]), "tb.csv"); const b = await ingest(h, s, U.owner, up, "bank", csv([R1]), "bank.csv");
        const st = await state(s.pool, up);
        out.sources = { https: [a.http, b.http], bySource: st.bySource, evidence: st.evidence }; }
      // 7. overlapping files and a repeated file with more copies of a row
      { const up = await newUpload(s.pool, s.ws);
        await ingest(h, s, U.owner, up, "bank", csv([R1, R2]), "a.csv");
        await ingest(h, s, U.owner, up, "bank", csv([R2, R3]), "b.csv");
        await ingest(h, s, U.owner, up, "bank", csv([R1, R1]), "c.csv");
        const st = await state(s.pool, up);
        out.overlap = { rows: st.rows, r1: countWhere(st.detail, "1000"), r2: countWhere(st.detail, "2000"), r3: countWhere(st.detail, "3000"),
          provenance: st.detail.filter((d) => d.account_code === "3000").map((d) => d.source_file_sha256 ?? null), evidence: st.evidence }; }
      // 8. the column-mapping round trip: no mapping yet → reconciliation id returned, nothing ingested
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1]), "unmapped.csv", null); const st = await state(s.pool, up);
        out.needsMapping = { http: r.http, needs: r.body?.needs_mapping ?? null, reconReturned: !!r.body?.reconciliation_id && r.body.reconciliation_id === st.recon, rows: st.rows, upload: st.upload }; }
      // 9. unauthorized and cross-tenant
      { const up = await newUpload(s.pool, s.ws); const file = csv([R1]);
        const who = { anon: null, outsider: U.outsider, tenantB: U.ownerB, viewer: U.viewer, prepareOnly: U.prepareOnly };
        const codes = {};
        for (const [k, uid] of Object.entries(who)) codes[k] = (await ingest(h, s, uid, up, "bank", file, "x.csv")).http;
        const st = await state(s.pool, up);
        out.unauthorized = { codes, recons: st.recons, rows: st.rows, upload: st.upload }; }
      return out;
    };

    console.log("\n== old handler × old schema (main today) — recorded baseline");
    const base = await scenarios(H.old, S.old);
    for (const [k, v] of Object.entries(base)) observe(k, v);
    console.log("\n== old handler × old schema, reconciliation already existing — recorded baseline");
    const base2 = await scenarios(H.old, S.old, { precreate: true });
    for (const k of ["creation", "preparer", "concurrent", "identicalRows", "sources", "overlap"]) observe(`${k} (existing reconciliation)`, base2[k]);

    console.log("\n== Preflight on the old schema (after the baseline left real duplicates): read-only, counts exact");
    await check("safishaIngestionPreflight.sql changes nothing and its counts equal an independent recount", async () => {
      const db = S.old.pool;
      const digest = async () => (await db.query(`SELECT (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) FROM public.safisha_transactions t)
        || (SELECT md5(coalesce(string_agg(r::text, ',' ORDER BY r::text), '')) FROM public.safisha_reconciliations r)
        || (SELECT md5(coalesce(string_agg(u::text, ',' ORDER BY u::text), '')) FROM public.trial_balance_uploads u) AS d`)).rows[0].d;
      const before = await digest();
      const c = await db.connect(); let rows;
      try { await c.query("BEGIN READ ONLY"); rows = (await c.query(fs.readFileSync(path.join(REPO, "scripts/db-preflight/safishaIngestionPreflight.sql"), "utf8"))).rows; await c.query("ROLLBACK"); }
      finally { c.release(); }
      const got = Object.fromEntries(rows.map((r) => [r.item, Number(r.n)]));
      // Independent recount from the raw rows.
      const tx = (await db.query("SELECT reconciliation_id r, source_id s, raw_row_hash h FROM public.safisha_transactions")).rows;
      const groups = new Map(); for (const t of tx) { const k = `${t.r}|${t.s}|${t.h}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
      const sources = new Map(); for (const t of tx) { const k = `${t.r}|${t.h}`; sources.set(k, new Set([...(sources.get(k) ?? []), t.s])); }
      const recs = (await db.query("SELECT r.tb_upload_id, r.sealed, u.safisha_status FROM public.safisha_reconciliations r JOIN public.trial_balance_uploads u ON u.id=r.tb_upload_id")).rows;
      const perUpload = new Map(); for (const r of recs.filter((x) => !x.sealed)) perUpload.set(r.tb_upload_id, (perUpload.get(r.tb_upload_id) ?? 0) + 1);
      const want = {
        cross_source_hash_pairs: [...sources.values()].filter((v) => v.size > 1).length,
        duplicate_extra_rows: [...groups.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0),
        duplicate_groups: [...groups.values()].filter((n) => n > 1).length,
        reconciliations_without_status: recs.filter((r) => !r.sealed && r.safisha_status === null).length,
        unsealed_per_upload_over_one: [...perUpload.values()].filter((n) => n > 1).length,
      };
      const unchanged = before === (await digest());
      // The baseline's simultaneous ingests must show up as duplicates here (the proof would otherwise be vacuous).
      return unchanged && JSON.stringify(got) === JSON.stringify(want) && want.duplicate_groups > 0 ? true : { unchanged, got, want };
    });

    if (!candidatePresent) {
      console.log(`\n${MIGRATION} is not in this tree yet: baseline only.`);
      return results.filter((x) => !x).length;
    }

    console.log("\n== new handler × new schema — asserted");
    const n = await scenarios(H.new, S.new);
    await check("creation: 200, one reconciliation, upload 'processing', both rows, one evidence entry", () => { const c = n.creation;
      return c.first === 200 && c.afterFirst.recons === 1 && c.afterFirst.upload === "processing" && c.afterFirst.rows === 2 && c.afterFirst.evidence === 1 ? true : c; });
    await check("retry / lost response: 200, nothing new (rows, reconciliations and evidence unchanged)", () => { const c = n.creation;
      return c.retry === 200 && c.retryInserted === 0 && c.afterRetry.rows === 2 && c.afterRetry.recons === 1 && c.afterRetry.evidence === 1 ? true : c; });
    await check("partial failure: an existing reconciliation with no upload status — the retry completes the status", () => { const c = n.partialFailure;
      return c.http === 200 && c.upload === "processing" && c.recons === 1 && c.rows === 1 ? true : c; });
    await check("a non-owner preparer starts the reconciliation and the upload status is set (not a silent 0-row update)", () => { const c = n.preparer;
      return c.http === 200 && c.upload === "processing" && c.recons === 1 && c.rows === 1 ? true : c; });
    await check("8 simultaneous identical ingests: all 200, one reconciliation, each row exactly once, one evidence entry", () => { const c = n.concurrent;
      return c.https.length === 1 && c.https[0] === 200 && c.recons === 1 && c.rows === 3 && c.evidence === 1 && c.upload === "processing" ? true : c; });
    await check("legitimate identical rows in one file are all kept (multiplicity preserved)", () => { const c = n.identicalRows;
      return c.http === 200 && c.rows === 3 && c.r1 === 2 ? true : c; });
    await check("different sources with identical row text are separate rows", () => { const c = n.sources;
      return c.https.every((x) => x === 200) && c.bySource.tb === 1 && c.bySource.bank === 1 && c.evidence === 2 ? true : c; });
    await check("overlapping files: the shared row once; a file with more copies of a row adds only the extra copy; provenance kept", () => { const c = n.overlap;
      return c.rows === 4 && c.r1 === 2 && c.r2 === 1 && c.r3 === 1 && c.provenance.length === 1 && /^[0-9a-f]{64}$/.test(c.provenance[0] ?? "") && c.evidence === 3 ? true : c; });
    await check("no mapping yet: needs_mapping with the reconciliation id; nothing ingested", () => { const c = n.needsMapping;
      return c.http === 200 && c.needs === true && c.reconReturned && c.rows === 0 ? true : c; });
    await check("unauthorized and cross-tenant: anon 401; outsider and other tenant 404; viewer and Prepare-only 403; nothing written", () => { const c = n.unauthorized;
      return c.codes.anon === 401 && c.codes.outsider === 404 && c.codes.tenantB === 404 && c.codes.viewer === 403 && c.codes.prepareOnly === 403
        && c.recons === 0 && c.rows === 0 && c.upload === null ? true : c; });

    console.log("\n== Deployment order");
    { const s = S.old; const up = await newUploadRow(s.pool, s.ws);
      const r = await ingest(H.new, s, s.ws.U.owner, up, "bank", csv([R1]), "early.csv"); const st = await state(s.pool, up);
      await check("new handler × old schema: 503 and nothing written (no reconciliation, no rows, no status)", () => r.http === 503 && st.recons === 0 && st.rows === 0 && st.upload === null ? true : { http: r.http, st: { ...st, detail: undefined } }); }
    { const s = S.new; const up = await newUploadRow(s.pool, s.ws);
      const r = await ingest(H.old, s, s.ws.U.owner, up, "bank", csv([R1, R1]), "late.csv"); const st = await state(s.pool, up);
      observe("old handler × new schema", { http: r.http, error: r.body?.error ?? null, recons: st.recons, rows: st.rows, upload: st.upload });
      await check("old handler × new schema: no transaction row is written outside the authoritative path", () => st.rows === 0 ? true : { http: r.http, rows: st.rows }); }
    { // The same, with the reconciliation already present: the old handler reaches its direct client INSERT, which the
      // database refuses (it must not create duplicates or rows without provenance).
      const s = S.new; const up = await newUploadRow(s.pool, s.ws);
      await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [s.ws.U.owner, up]);
      const r = await ingest(H.old, s, s.ws.U.owner, up, "bank", csv([R1, R1]), "late2.csv"); const st = await state(s.pool, up);
      await check("old handler × new schema with an existing reconciliation: its direct row INSERT is refused (EVIDENCE_SERVER_ONLY), nothing written",
        () => r.http === 500 && /EVIDENCE_SERVER_ONLY/.test(r.body?.error ?? "") && st.rows === 0 ? true : { http: r.http, error: r.body?.error, rows: st.rows }); }

    console.log("\n== Re-apply");
    await check(`${MIGRATION} applied again changes no row`, async () => {
      const snap = async () => (await S.new.pool.query("SELECT count(*)::int n, md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) h FROM public.safisha_transactions t")).rows[0];
      const a = await snap(); await S.new.pool.query(fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8")); const b = await snap();
      return JSON.stringify(a) === JSON.stringify(b) ? true : { a, b };
    });
  } finally {
    await stop(pools);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed;
}

let code = 1;
try { code = (await main()) === 0 ? 0 : 1; } catch (e) { console.error("FATAL", e); }
process.exit(code);
