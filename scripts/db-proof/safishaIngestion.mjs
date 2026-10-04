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
const MAPPING_ID = { ...MAPPING, TxnId: "source_txn_id" };
const csv = (rows, header = "Code,Name,Date,Debit,Credit,Ref") => [header, ...rows].join("\n") + "\n";
const R1 = "1000,Cash,2025-01-31,100,,R-1";
const R2 = "2000,Bank charges,2025-01-31,5,,R-2";
const R3 = "3000,Interest,2025-02-28,,7,R-3";
function form(uploadId, sourceType, text, name, mapping = MAPPING, ingestionKey = null) {
  const f = new FormData();
  f.append("upload_id", uploadId);
  f.append("source_type", sourceType);
  f.append("file", new File([text], name, { type: "text/csv" }));
  if (mapping) f.append("mapping_override", JSON.stringify(mapping));
  if (ingestionKey) f.append("ingestion_key", ingestionKey);
  return f;
}
async function state(pool, uploadId) {
  const u = (await pool.query("SELECT safisha_status FROM public.trial_balance_uploads WHERE id=$1", [uploadId])).rows[0];
  const recons = (await pool.query("SELECT id, status, evidence_files FROM public.safisha_reconciliations WHERE tb_upload_id=$1", [uploadId])).rows;
  const ids = recons.map((r) => r.id);
  const rows = ids.length ? (await pool.query("SELECT source_id, account_code, raw_row_number, to_jsonb(t) AS j FROM public.safisha_transactions t WHERE reconciliation_id = ANY($1::uuid[]) ORDER BY source_id, account_code, raw_row_number", [ids])).rows : [];
  let occ = [], ing = [];
  try {
    occ = ids.length ? (await pool.query("SELECT o.disposition, o.overlap_reason, o.raw_row_number, o.transaction_id, i.file_name FROM public.safisha_source_occurrences o JOIN public.safisha_ingestions i ON i.id=o.ingestion_id WHERE o.reconciliation_id = ANY($1::uuid[]) ORDER BY i.created_at, o.raw_row_number", [ids])).rows : [];
    ing = ids.length ? (await pool.query("SELECT id, row_count, file_name FROM public.safisha_ingestions WHERE reconciliation_id = ANY($1::uuid[])", [ids])).rows : [];
  } catch { /* the old schema has no provenance tables */ }
  return { upload: u?.safisha_status ?? null, recons: recons.length, recon: recons[0]?.id ?? null, reconStatus: recons[0]?.status ?? null,
    evidence: recons.reduce((n, r) => n + (r.evidence_files?.length ?? 0), 0), rows: rows.length,
    bySource: rows.reduce((m, r) => ({ ...m, [r.source_id]: (m[r.source_id] ?? 0) + 1 }), {}), detail: rows.map((r) => r.j),
    occurrences: occ, ingestions: ing,
    flagged: occ.filter((o) => o.overlap_reason).map((o) => o.overlap_reason).sort() };
}
const countWhere = (rows, code) => rows.filter((r) => r.account_code === code).length;
/** Every accepted file row of every ingestion has exactly one provenance occurrence. */
const provenanceComplete = (st) => st.ingestions.every((i) => st.occurrences.filter((o) => o.file_name === i.file_name).length === i.row_count);

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

    const ingest = (h, s, who, upload, sourceType, text, name, mapping, key) => call(h, s.pool, who, form(upload, sourceType, text, name, mapping, key));

    /** The shared scenarios against one handler × schema; returns observations (assertions are applied by the caller). */
    const scenarios = async (h, s, { precreate = false } = {}) => {
      const out = {};
      const U = s.ws.U;
      // precreate: the reconciliation already exists (as a seeded fixture), so the old handler's creation defect does not
      // mask its deduplication and concurrency behaviour.
      const newUpload = async (pool, ws) => { const up = await newUploadRow(pool, ws);
        if (precreate) await pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [U.owner, up]);
        return up; };
      { const up = await newUpload(s.pool, s.ws); const file = csv([R1, R2]);
        const first = await ingest(h, s, U.owner, up, "bank", file, "jan.csv"); const afterFirst = await state(s.pool, up);
        const retry = await ingest(h, s, U.owner, up, "bank", file, "jan.csv"); const afterRetry = await state(s.pool, up);
        out.creation = { first: first.http, firstBody: first.body?.error ?? first.body?.inserted, afterFirst: { ...afterFirst, detail: undefined, occurrences: undefined },
          retry: retry.http, retryInserted: retry.body?.inserted ?? retry.body?.error, retryReplay: retry.body?.replay ?? null,
          afterRetry: { ...afterRetry, detail: undefined, occurrences: undefined } }; }
      { const up = await newUploadRow(s.pool, s.ws);
        await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [U.owner, up]);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1]), "feb.csv"); const st = await state(s.pool, up);
        out.partialFailure = { http: r.http, upload: st.upload, recons: st.recons, rows: st.rows }; }
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.preparer, up, "bank", csv([R1]), "pre.csv"); const st = await state(s.pool, up);
        out.preparer = { http: r.http, error: r.body?.error ?? null, upload: st.upload, recons: st.recons, rows: st.rows }; }
      { const up = await newUpload(s.pool, s.ws); const file = csv([R1, R2, R3]);
        const rs = await Promise.all(Array.from({ length: 8 }, () => ingest(h, s, U.owner, up, "bank", file, "same.csv")));
        const st = await state(s.pool, up);
        out.concurrent = { https: [...new Set(rs.map((r) => r.http))], recons: st.recons, rows: st.rows, evidence: st.evidence, upload: st.upload, ingestions: st.ingestions.length }; }
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1, R1, R2]), "twins.csv"); const st = await state(s.pool, up);
        out.identicalRows = { http: r.http, rows: st.rows, r1: countWhere(st.detail, "1000"), flagged: st.flagged }; }
      { const up = await newUpload(s.pool, s.ws);
        const a = await ingest(h, s, U.owner, up, "tb", csv([R1]), "tb.csv"); const b = await ingest(h, s, U.owner, up, "bank", csv([R1]), "bank.csv");
        const st = await state(s.pool, up);
        out.sources = { https: [a.http, b.http], bySource: st.bySource, evidence: st.evidence, flagged: st.flagged }; }
      { const up = await newUpload(s.pool, s.ws);
        await ingest(h, s, U.owner, up, "bank", csv([R1, R2]), "a.csv");
        await ingest(h, s, U.owner, up, "bank", csv([R2, R3]), "b.csv");
        await ingest(h, s, U.owner, up, "bank", csv([R1, R1]), "c.csv");
        const st = await state(s.pool, up);
        out.overlap = { rows: st.rows, r1: countWhere(st.detail, "1000"), r2: countWhere(st.detail, "2000"), r3: countWhere(st.detail, "3000"),
          flagged: st.flagged, evidence: st.evidence, provenanceComplete: provenanceComplete(st), occurrences: st.occurrences.length }; }
      { const up = await newUpload(s.pool, s.ws);
        const r = await ingest(h, s, U.owner, up, "bank", csv([R1]), "unmapped.csv", null); const st = await state(s.pool, up);
        out.needsMapping = { http: r.http, needs: r.body?.needs_mapping ?? null, reconReturned: !!r.body?.reconciliation_id && r.body.reconciliation_id === st.recon, rows: st.rows, upload: st.upload }; }
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
      const tx = (await db.query("SELECT reconciliation_id r, source_id s, raw_row_hash h, raw_row_number n FROM public.safisha_transactions")).rows;
      const tally = (keyOf) => { const m = new Map(); for (const t of tx) { const k = keyOf(t); m.set(k, (m.get(k) ?? 0) + 1); } return [...m.values()]; };
      const groups = tally((t) => `${t.r}|${t.s}|${t.h}`);
      const lineGroups = tally((t) => `${t.r}|${t.s}|${t.h}|${t.n}`);
      const sources = new Map(); for (const t of tx) { const k = `${t.r}|${t.h}`; sources.set(k, new Set([...(sources.get(k) ?? []), t.s])); }
      const recs = (await db.query("SELECT r.tb_upload_id, r.sealed, u.safisha_status FROM public.safisha_reconciliations r JOIN public.trial_balance_uploads u ON u.id=r.tb_upload_id")).rows;
      const perUpload = new Map(); for (const r of recs.filter((x) => !x.sealed)) perUpload.set(r.tb_upload_id, (perUpload.get(r.tb_upload_id) ?? 0) + 1);
      const want = {
        cross_source_hash_pairs: [...sources.values()].filter((v) => v.size > 1).length,
        duplicate_extra_rows: groups.filter((n) => n > 1).reduce((a, n) => a + n - 1, 0),
        duplicate_groups: groups.filter((n) => n > 1).length,
        legacy_rows: tx.length,
        reconciliations_without_status: recs.filter((r) => !r.sealed && r.safisha_status === null).length,
        same_line_duplicate_extra_rows: lineGroups.filter((n) => n > 1).reduce((a, n) => a + n - 1, 0),
        unsealed_per_upload_over_one: [...perUpload.values()].filter((n) => n > 1).length,
      };
      const unchanged = before === (await digest());
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
    await check("retry / lost response: a REPLAY — 200, nothing new (rows, ingestions, evidence unchanged)", () => { const c = n.creation;
      return c.retry === 200 && c.retryReplay === true && c.retryInserted === 0 && c.afterRetry.rows === 2 && c.afterRetry.recons === 1 && c.afterRetry.evidence === 1
        && c.afterRetry.ingestions.length === 1 ? true : c; });
    await check("partial failure: an existing reconciliation with no upload status — the retry completes the status", () => { const c = n.partialFailure;
      return c.http === 200 && c.upload === "processing" && c.recons === 1 && c.rows === 1 ? true : c; });
    await check("a non-owner preparer starts the reconciliation and the upload status is set (not a silent 0-row update)", () => { const c = n.preparer;
      return c.http === 200 && c.upload === "processing" && c.recons === 1 && c.rows === 1 ? true : c; });
    await check("8 simultaneous identical ingests: all 200, one ingestion, one reconciliation, each row once, one evidence entry", () => { const c = n.concurrent;
      return c.https.length === 1 && c.https[0] === 200 && c.recons === 1 && c.rows === 3 && c.evidence === 1 && c.ingestions === 1 && c.upload === "processing" ? true : c; });
    await check("identical rows within one file are all kept, unflagged (multiplicity preserved)", () => { const c = n.identicalRows;
      return c.http === 200 && c.rows === 3 && c.r1 === 2 && c.flagged.length === 0 ? true : c; });
    await check("different sources with identical row text are separate rows, unflagged", () => { const c = n.sources;
      return c.https.every((x) => x === 200) && c.bySource.tb === 1 && c.bySource.bank === 1 && c.evidence === 2 && c.flagged.length === 0 ? true : c; });
    await check("overlapping files: every row of every file preserved; each cross-file identical row flagged; provenance complete", () => { const c = n.overlap;
      return c.rows === 6 && c.r1 === 3 && c.r2 === 2 && c.r3 === 1 && JSON.stringify(c.flagged) === JSON.stringify(["identical_content_other_file", "identical_content_other_file", "identical_content_other_file"])
        && c.evidence === 3 && c.occurrences === 6 && c.provenanceComplete ? true : c; });
    await check("no mapping yet: needs_mapping with the reconciliation id; nothing ingested", () => { const c = n.needsMapping;
      return c.http === 200 && c.needs === true && c.reconReturned && c.rows === 0 ? true : c; });
    await check("unauthorized and cross-tenant: anon 401; outsider and other tenant 404; viewer and Prepare-only 403; nothing written", () => { const c = n.unauthorized;
      return c.codes.anon === 401 && c.codes.outsider === 404 && c.codes.tenantB === 404 && c.codes.viewer === 403 && c.codes.prepareOnly === 403
        && c.recons === 0 && c.rows === 0 && c.upload === null ? true : c; });

    console.log("\n== Accounting identity: content alone never proves the same economic event");
    const s = S.new; const U = s.ws.U;
    { // Two genuinely separate transactions, cell-for-cell identical, in two different statements.
      const up = await newUploadRow(s.pool, s.ws);
      const jan = await ingest(H.new, s, U.owner, up, "bank", csv([R1, R2]), "statement-jan.csv");
      const feb = await ingest(H.new, s, U.owner, up, "bank", csv([R3, R1]), "statement-feb.csv");
      const st = await state(s.pool, up);
      await check("two separate identical transactions in different files BOTH survive; the second is flagged, not dropped", () =>
        jan.http === 200 && feb.http === 200 && countWhere(st.detail, "1000") === 2 && st.rows === 4
          && JSON.stringify(st.flagged) === JSON.stringify(["identical_content_other_file"]) && feb.body?.overlap_flagged === 1 && provenanceComplete(st)
          ? true : { jan: jan.http, feb: feb.body, rows: st.rows, flagged: st.flagged }); }
    { // Byte-identical files from two different upload actions survive when the caller gives each its own ingestion key.
      const up = await newUploadRow(s.pool, s.ws); const file = csv([R1]);
      const a = await ingest(H.new, s, U.owner, up, "bank", file, "one.csv", MAPPING, "action-1");
      const b = await ingest(H.new, s, U.owner, up, "bank", file, "two.csv", MAPPING, "action-2");
      const a2 = await ingest(H.new, s, U.owner, up, "bank", file, "one.csv", MAPPING, "action-1");
      const st = await state(s.pool, up);
      await check("explicit ingestion keys: byte-identical files of two actions both stored (flagged); retrying a key is a replay", () =>
        a.http === 200 && b.http === 200 && a2.http === 200 && a2.body?.replay === true && st.rows === 2 && st.ingestions.length === 2
          && JSON.stringify(st.flagged) === JSON.stringify(["identical_content_other_file"]) ? true : { a: a.body, b: b.body, a2: a2.body, rows: st.rows }); }
    { // Reusing an ingestion identity with different bytes or a different mapping is a conflict; nothing is written.
      const up = await newUploadRow(s.pool, s.ws);
      const first = await ingest(H.new, s, U.owner, up, "bank", csv([R1]), "k.csv", MAPPING, "action-k");
      const before = await state(s.pool, up);
      const otherBytes = await ingest(H.new, s, U.owner, up, "bank", csv([R2]), "k.csv", MAPPING, "action-k");
      const otherMapping = await ingest(H.new, s, U.owner, up, "bank", csv([R1]), "k.csv", { ...MAPPING, Ref: "account_name" }, "action-k");
      const sameFileNewMapping = await ingest(H.new, s, U.owner, up, "bank", csv([R1]), "k2.csv", { ...MAPPING, Ref: "account_name" });
      const sameFileFirst = await ingest(H.new, s, U.owner, up, "bank", csv([R1]), "k2.csv");
      const after = await state(s.pool, up);
      await check("same ingestion identity with different bytes → 409; with a different mapping → 409; same bytes, no key, different mapping → 409; nothing written",
        () => first.http === 200 && otherBytes.http === 409 && otherMapping.http === 409 && sameFileFirst.http === 409 && sameFileNewMapping.http === 200
          && after.rows === before.rows + 1 && after.ingestions.length === 2
          ? true : { first: first.http, otherBytes: otherBytes.http, otherMapping: otherMapping.http, sameFileNewMapping: sameFileNewMapping.http, sameFileFirst: sameFileFirst.http, rows: [before.rows, after.rows] }); }
    { // A reliable source transaction ID proves a duplicate; a disagreeing or repeated ID is flagged, never silently merged.
      const up = await newUploadRow(s.pool, s.ws); const H6 = "Code,Name,Date,Debit,Credit,Ref,TxnId";
      const a = await ingest(H.new, s, U.owner, up, "bank", csv([`${R1},TX-9`], H6), "id-a.csv", MAPPING_ID);
      const b = await ingest(H.new, s, U.owner, up, "bank", csv(["1000,Cash (re-exported),2025-01-31,100,,R-1 copy,TX-9", `${R2},TX-7`], H6), "id-b.csv", MAPPING_ID);
      const c = await ingest(H.new, s, U.owner, up, "bank", csv(["1000,Cash,2025-01-31,999,,R-1,TX-9"], H6), "id-c.csv", MAPPING_ID);
      const d = await ingest(H.new, s, U.owner, up, "bank", csv([`${R3},TX-5`, "3000,Interest again,2025-02-28,,8,R-4,TX-5"], H6), "id-d.csv", MAPPING_ID);
      const st = await state(s.pool, up);
      const dup = st.occurrences.filter((o) => o.disposition === "duplicate_source_txn_id");
      await check("same source_txn_id + same economic fields in another file → not stored, its occurrence points at the stored row",
        () => a.http === 200 && b.http === 200 && b.body?.deduplicated === 1 && dup.length === 1 && st.detail.some((t) => t.id === dup[0].transaction_id && t.source_txn_id === "TX-9")
          ? true : { a: a.body, b: b.body, dup });
      await check("same source_txn_id with different amount → stored and flagged 'source_txn_id_mismatch'; an ID repeated within a file → stored and flagged 'repeated_source_txn_id'",
        () => c.http === 200 && d.http === 200 && JSON.stringify(st.flagged) === JSON.stringify(["repeated_source_txn_id", "source_txn_id_mismatch"])
          // a 1 + b 1 (its TX-9 row is the proven duplicate, not stored) + c 1 + d 2
          && st.rows === 5 && provenanceComplete(st)
          ? true : { c: c.body, d: d.body, flagged: st.flagged, rows: st.rows }); }

    console.log("\n== Concurrency: multiplicity is exact under simultaneous requests");
    { const up = await newUploadRow(s.pool, s.ws);
      const files = Array.from({ length: 6 }, (_, i) => csv([R1, `4${i}00,Unique ${i},2025-03-0${i + 1},${i + 1},,U-${i}`]));
      const rs = await Promise.all(files.map((f, i) => ingest(H.new, s, U.owner, up, "bank", f, `stmt-${i}.csv`)));
      const st = await state(s.pool, up);
      await check("6 simultaneous different files each holding the same row: all 200; 12 rows; the shared row kept 6 times; exactly 5 flagged",
        () => rs.every((r) => r.http === 200) && st.rows === 12 && countWhere(st.detail, "1000") === 6 && st.flagged.length === 5 && st.ingestions.length === 6 && provenanceComplete(st)
          ? true : { https: rs.map((r) => r.http), rows: st.rows, flagged: st.flagged }); }
    { const up = await newUploadRow(s.pool, s.ws);
      const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => ingest(H.new, s, U.owner, up, "bank", csv([`5${i}00,Variant ${i},2025-04-01,${i + 1},,V-${i}`]), "same-key.csv", MAPPING, "shared-key")));
      const st = await state(s.pool, up);
      await check("5 simultaneous requests reusing one ingestion key with different bytes: exactly one stored, four 409, one ingestion",
        () => rs.filter((r) => r.http === 200).length === 1 && rs.filter((r) => r.http === 409).length === 4 && st.rows === 1 && st.ingestions.length === 1
          ? true : { https: rs.map((r) => r.http), rows: st.rows }); }
    { const up = await newUploadRow(s.pool, s.ws); const file = csv([R1, R1, R2]);
      const rs = await Promise.all(Array.from({ length: 8 }, () => ingest(H.new, s, U.owner, up, "bank", file, "twins-8.csv")));
      const st = await state(s.pool, up);
      await check("8 simultaneous retries of a file with a repeated row: one ingestion, the repeated row exactly twice, seven replays",
        () => rs.every((r) => r.http === 200) && rs.filter((r) => r.body?.replay === true).length === 7 && st.rows === 3 && countWhere(st.detail, "1000") === 2 && st.ingestions.length === 1
          ? true : { https: rs.map((r) => r.http), replays: rs.filter((r) => r.body?.replay).length, rows: st.rows }); }

    console.log("\n== Legacy rows (stored before this migration, e.g. the demo's two trial-balance rows): never rewritten, never duplicated");
    { // Reproduce what main's handler stored for a two-row TB file: rows without an ingestion, with their file lines.
      const TB = csv(["1000,Cash at bank,2025-12-31,1500,,TB-1", "3000,Share capital,2025-12-31,,1500,TB-2"]);
      // The row hashes exactly as the handler computes them: ingest the same file into a scratch upload and copy them.
      const scratch = await newUploadRow(s.pool, s.ws); await ingest(H.new, s, U.owner, scratch, "tb", TB, "demo-tb.csv");
      const proto = (await state(s.pool, scratch)).detail;
      const up = await newUploadRow(s.pool, s.ws);
      const recon = (await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [U.owner, up])).rows[0].id;
      await s.pool.query("UPDATE public.trial_balance_uploads SET safisha_status='processing' WHERE id=$1", [up]);
      for (const p of proto) {
        await s.pool.query("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,account_name,txn_date,debit,credit,currency,reference,raw_row_hash,raw_row_number) VALUES ($1,'tb',$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [recon, p.account_code, p.account_name, p.txn_date, p.debit, p.credit, p.currency, p.reference, p.raw_row_hash, p.raw_row_number]);
      }
      const legacyBefore = (await s.pool.query("SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) h FROM public.safisha_transactions t WHERE reconciliation_id=$1", [recon])).rows[0].h;
      const retry = await ingest(H.new, s, U.owner, up, "tb", TB, "demo-tb.csv");
      const st = await state(s.pool, up);
      const legacyAfter = (await s.pool.query("SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) h FROM public.safisha_transactions t WHERE reconciliation_id=$1 AND ingestion_id IS NULL", [recon])).rows[0].h;
      await check("a retry of the legacy TB file stores nothing: both lines claim their legacy rows (legacy_match); the legacy rows are byte-identical",
        () => retry.http === 200 && retry.body?.inserted === 0 && retry.body?.deduplicated === 2 && st.rows === 2 && legacyBefore === legacyAfter
          && st.occurrences.length === 2 && st.occurrences.every((o) => o.disposition === "legacy_match") ? true : { retry: retry.body, rows: st.rows, occ: st.occurrences });
      const again = await ingest(H.new, s, U.owner, up, "tb", TB, "demo-tb.csv");
      await check("retrying it once more is a replay of that ingestion (nothing new)", async () => {
        const st2 = await state(s.pool, up); return again.http === 200 && again.body?.replay === true && st2.rows === 2 && st2.occurrences.length === 2 ? true : { again: again.body, rows: st2.rows }; });
      const shifted = await ingest(H.new, s, U.owner, up, "tb", csv(["2000,Debtors,2025-12-31,10,,TB-0", "1000,Cash at bank,2025-12-31,1500,,TB-1"]), "demo-tb-v2.csv");
      await check("the same content at a different line (another file) is NOT silently merged: stored and flagged 'identical_content_legacy'", async () => {
        const st3 = await state(s.pool, up);
        return shifted.http === 200 && st3.rows === 4 && JSON.stringify(st3.flagged) === JSON.stringify(["identical_content_legacy"]) ? true : { shifted: shifted.body, rows: st3.rows, flagged: st3.flagged }; });
    }
    { // Legacy rows the old race duplicated (same content, same line, twice): a retry claims one; the other stays untouched.
      const up = await newUploadRow(s.pool, s.ws); const file = csv([R1]);
      const scratch = await newUploadRow(s.pool, s.ws); await ingest(H.new, s, U.owner, scratch, "bank", file, "race.csv");
      const p = (await state(s.pool, scratch)).detail[0];
      const recon = (await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing') RETURNING id", [U.owner, up])).rows[0].id;
      for (let i = 0; i < 2; i += 1) await s.pool.query("INSERT INTO public.safisha_transactions (reconciliation_id,source_id,account_code,raw_row_hash,raw_row_number,debit,txn_date) VALUES ($1,'bank',$2,$3,$4,$5,$6)", [recon, p.account_code, p.raw_row_hash, p.raw_row_number, p.debit, p.txn_date]);
      const r = await ingest(H.new, s, U.owner, up, "bank", file, "race.csv"); const st = await state(s.pool, up);
      await check("legacy race duplicates: the retry claims exactly one, stores nothing, rewrites nothing (the extra legacy row remains, visible to the preflight)",
        () => r.http === 200 && r.body?.inserted === 0 && st.rows === 2 && st.occurrences.length === 1 && st.occurrences[0].disposition === "legacy_match" ? true : { r: r.body, rows: st.rows, occ: st.occurrences }); }

    console.log("\n== Deployment order");
    { const s0 = S.old; const up = await newUploadRow(s0.pool, s0.ws);
      const r = await ingest(H.new, s0, s0.ws.U.owner, up, "bank", csv([R1]), "early.csv"); const st = await state(s0.pool, up);
      await check("new handler × old schema: 503 and nothing written (no reconciliation, no rows, no status)", () => r.http === 503 && st.recons === 0 && st.rows === 0 && st.upload === null ? true : { http: r.http, st: { ...st, detail: undefined } }); }
    { const up = await newUploadRow(s.pool, s.ws);
      const r = await ingest(H.old, s, U.owner, up, "bank", csv([R1, R1]), "late.csv"); const st = await state(s.pool, up);
      observe("old handler × new schema", { http: r.http, error: r.body?.error ?? null, recons: st.recons, rows: st.rows, upload: st.upload });
      await check("old handler × new schema: no transaction row is written outside the authoritative path", () => st.rows === 0 ? true : { http: r.http, rows: st.rows }); }
    { const up = await newUploadRow(s.pool, s.ws);
      await s.pool.query("INSERT INTO public.safisha_reconciliations (client_id,tb_upload_id,status) VALUES ($1,$2,'processing')", [U.owner, up]);
      const r = await ingest(H.old, s, U.owner, up, "bank", csv([R1, R1]), "late2.csv"); const st = await state(s.pool, up);
      await check("old handler × new schema with an existing reconciliation: its direct row INSERT is refused (EVIDENCE_SERVER_ONLY), nothing written",
        () => r.http === 500 && /EVIDENCE_SERVER_ONLY/.test(r.body?.error ?? "") && st.rows === 0 ? true : { http: r.http, error: r.body?.error, rows: st.rows }); }

    console.log("\n== Provenance is append-only and server-written");
    await check("clients cannot write ingestions or occurrences; nobody can update or delete them", async () => {
      const asUser = async (sql, params) => { const c = await s.pool.connect(); try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [U.owner]);
        await c.query(sql, params); await c.query("ROLLBACK"); return "ok"; } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } return e.code; } finally { c.release(); } };
      const asOwnerDb = async (sql) => { try { await s.pool.query(sql); return "ok"; } catch (e) { return e.code; } };
      const res = {
        clientInsertIngestion: await asUser("INSERT INTO public.safisha_ingestions (reconciliation_id,source_id,ingestion_key,key_origin,file_sha256,mapping_sha256,file_name,row_count,actor_user_id) SELECT reconciliation_id,source_id,'x','client',file_sha256,mapping_sha256,'x',1,actor_user_id FROM public.safisha_ingestions LIMIT 1"),
        clientInsertOccurrence: await asUser("INSERT INTO public.safisha_source_occurrences (ingestion_id,reconciliation_id,raw_row_number,raw_row_hash,disposition,transaction_id) SELECT ingestion_id,reconciliation_id,9999,raw_row_hash,'stored',transaction_id FROM public.safisha_source_occurrences LIMIT 1"),
        ownerUpdate: await asOwnerDb("UPDATE public.safisha_source_occurrences SET overlap_reason=NULL"),
        ownerDelete: await asOwnerDb("DELETE FROM public.safisha_ingestions"),
      };
      return res.clientInsertIngestion === "42501" && res.clientInsertOccurrence === "42501" && res.ownerUpdate === "42501" && res.ownerDelete === "42501" ? true : res;
    });
    await check("tenant B sees none of tenant A's ingestions or occurrences", async () => {
      const c = await s.pool.connect();
      try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
        await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [U.ownerB]);
        const a = (await c.query("SELECT count(*)::int n FROM public.safisha_ingestions")).rows[0].n; const b = (await c.query("SELECT count(*)::int n FROM public.safisha_source_occurrences")).rows[0].n;
        await c.query("ROLLBACK"); return a === 0 && b === 0 ? true : { a, b }; } finally { c.release(); }
    });

    console.log("\n== Post-apply verification (read-only)");
    await check("safishaIngestionVerify.sql changes nothing and every check is true", async () => {
      const digest = async () => (await s.pool.query("SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) d FROM public.safisha_transactions t")).rows[0].d;
      const before = await digest();
      const c = await s.pool.connect(); let rows;
      try { await c.query("BEGIN READ ONLY"); rows = (await c.query(fs.readFileSync(path.join(REPO, "scripts/db-preflight/safishaIngestionVerify.sql"), "utf8"))).rows; await c.query("ROLLBACK"); }
      finally { c.release(); }
      return before === (await digest()) && rows.length > 0 && rows.every((r) => r.ok === true) ? true : rows;
    });

    console.log("\n== Re-apply");
    await check(`${MIGRATION} applied again changes no row`, async () => {
      const snap = async () => (await s.pool.query(`SELECT (SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) FROM public.safisha_transactions t)
        || (SELECT md5(coalesce(string_agg(o::text, ',' ORDER BY o::text), '')) FROM public.safisha_source_occurrences o)
        || (SELECT md5(coalesce(string_agg(i::text, ',' ORDER BY i::text), '')) FROM public.safisha_ingestions i) AS d`)).rows[0].d;
      const a = await snap(); await s.pool.query(fs.readFileSync(path.join(REPO, "supabase/migrations", MIGRATION), "utf8")); const b = await snap();
      return a === b ? true : { a, b };
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
