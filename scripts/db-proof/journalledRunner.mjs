#!/usr/bin/env bun
// Real-PostgreSQL proof of the file-based release runner (scripts/release/applyJournalledWrappers.mjs) on a disposable
// database: main's schema before the financial-statements first slice, a drizzle journal whose head is the hosted 0063 row,
// one company enabled for reporting (the demo of the hosted run). Then the runner itself, exactly as the owner runs it:
//
//   R1  identity: the five planned wrappers are the registered bytes; a wrapper with one byte changed is REFUSED before any
//       connection is opened (nothing journalled)
//   R2  an enabled company the run does not allow stops the run before any write
//   R3  dry run: preflights run, nothing applied, no journal row, no mirror file
//   R4  the installation window and the five batches: reporting deactivated for the enabled company (audited), then five
//       journal rows in order whose hashes are the registered wrapper hashes with increasing created_at; every postcondition
//       held; mirrors written (tags 0064-0068, the exact wrapper bytes, journal entries whose when = created_at)
//   R5  the released state is in force (fs-work-bounds/2, the memo, the capacity guard)
//   R6  a second run applies nothing: every batch is reported as already applied by its hash
//   R7  restoration: reporting re-enabled for the company (audited)
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/journalledRunner.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorld, openDatabase, reporter } from "./lib/reportingKit.mjs";
import { currentChain, migrationSql } from "./lib/parkedMigrations.mjs";
import { RELEASE_BATCHES } from "../release/selfCheckingWrapper.mjs";
import { SUBMISSION_FORMS } from "../ci/releaseJournal.mjs";
import { planRelease, runRelease } from "../release/applyJournalledWrappers.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { group, check, finish } = reporter();
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const FIVE = ["fs-controls-r1", "fs-journey-r1", "fs-bounds-r1", "fs-capacity-r1", "fs-memo-r1"];
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
let db;

async function main() {
  db = await openDatabase("journalled_runner_proof");
  const journal = JSON.parse(fs.readFileSync(path.join(REPO, "drizzle/migrations/meta/_journal.json"), "utf8"));
  const last = journal.entries.find((e) => e.tag === "0063_period_currency_correction");
  if (!last) throw new Error("Historical journal boundary 0063 missing");
  const historicalJournal = { ...journal, entries: journal.entries.filter((e) => e.idx <= last.idx) };
  const chain = currentChain(REPO);
  const sourceEnd = chain.indexOf("20261113100000_period_currency_correction.sql");
  if (sourceEnd < 0) throw new Error("Historical source boundary missing");
  const fsSources = new Set(RELEASE_BATCHES.filter((b) => FIVE.includes(b.id)).flatMap((b) => b.sources));
  group("Base — main's schema before the slice; the journal head is the hosted 0063 row");
  await check("the chain without the five FS migrations applies; the journal holds exactly the 0063 row", async () => {
    for (const f of chain.slice(0, sourceEnd + 1)) {
      if (fsSources.has(f)) continue;
      let t = migrationSql(REPO, f);
      if (f === PG_CRON_FILE) t = t.split("\n").slice(0, t.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
      await db.admin.query(t);
    }
    await db.admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [sha256(fs.readFileSync(path.join(REPO, "drizzle/migrations", `${last.tag}.sql`))), last.when]);
    const n = await db.count("SELECT count(*) n FROM drizzle.__drizzle_migrations");
    return n === 1 && last.tag === "0063_period_currency_correction" ? true : { n, last: last.tag };
  });
  const p = db.admin.connectionParameters;
  const url = `postgres://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}`;
  const W = await makeWorld(db);
  const { A } = W;
  await W.rollout(A, true);
  // The repository mirror the runner extends: a copy with the journal and the 0063 mirror.
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-mirror-"));
  fs.mkdirSync(path.join(mirror, "meta"));
  fs.writeFileSync(path.join(mirror, "meta/_journal.json"), JSON.stringify(historicalJournal));
  for (const f of ["0063_period_currency_correction.sql", "meta/0063_snapshot.json"]) fs.copyFileSync(path.join(REPO, "drizzle/migrations", f), path.join(mirror, f));
  const journalRows = () => db.admin.query("SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id").then((r) => r.rows);
  const audits = () => db.count("SELECT count(*) n FROM public.financial_statements_rollout_audit WHERE company_id = $1", [A]);
  const enabled = () => db.one("SELECT enabled FROM public.financial_statements_rollout_companies WHERE company_id = $1", [A]).then((r) => r?.enabled ?? null);
  const lines = [];
  const log = (l) => lines.push(l);
  const RP = "disposable database (this proof)", OP = "proof";

  group("R1  identity before any connection");
  let plan;
  await check("the five batches plan to the registered wrapper bytes (hash and byte count of SUBMISSION_FORMS)", async () => {
    plan = planRelease({ batches: FIVE });
    const ok = plan.length === 5 && plan.every((x) => x.hash === SUBMISSION_FORMS[x.source].wrapper.sha256 && x.bytes.length === SUBMISSION_FORMS[x.source].wrapper.bytes);
    return ok ? true : plan.map((x) => [x.source, x.hash.slice(0, 12)]);
  });
  await check("a wrapper with one byte changed is REFUSED by the plan; nothing is journalled", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-tamper-"));
    for (const x of plan) fs.copyFileSync(x.wrapperPath, path.join(tmp, path.basename(x.wrapperPath)));
    const victim = path.join(tmp, path.basename(plan[2].wrapperPath));
    const b = fs.readFileSync(victim); b[Math.floor(b.length / 2)] ^= 0x01; fs.writeFileSync(victim, b);
    let err = null;
    try { planRelease({ batches: FIVE, wrappersDir: tmp }); } catch (e) { err = String(e.message); }
    return /^REFUSED: .*is not the registered wrapper/.test(err ?? "") && (await journalRows()).length === 1 ? true : { err, rows: (await journalRows()).length };
  });

  group("R2  an enabled company the run does not allow stops the run before any write");
  await check("the enabled company is named and nothing is applied", async () => {
    let err = null;
    try { await runRelease({ url, plan, recoveryPoint: RP, operator: OP, mirrorDir: mirror, allowEnabled: [], log }); } catch (e) { err = String(e.message); }
    return /^STOP: companies enabled for reporting that the run does not allow: /.test(err ?? "") && err.includes(A) && (await journalRows()).length === 1 ? true : { err, rows: (await journalRows()).length };
  });
  await check("a run without a recovery point or an operator is refused before connecting", async () => {
    let e1 = null, e2 = null;
    try { await runRelease({ url, plan, recoveryPoint: "", operator: OP, mirrorDir: mirror, log }); } catch (e) { e1 = String(e.message); }
    try { await runRelease({ url, plan, recoveryPoint: RP, operator: "", mirrorDir: mirror, log }); } catch (e) { e2 = String(e.message); }
    return /recovery-point/.test(e1 ?? "") && /operator/.test(e2 ?? "") ? true : { e1, e2 };
  });

  group("R3  dry run");
  await check("preflights run, nothing is applied, no journal row, no mirror file", async () => {
    const s = await runRelease({ url, plan, recoveryPoint: RP, operator: OP, dryRun: true, mirrorDir: mirror, allowEnabled: [A], log });
    const files = fs.readdirSync(mirror).filter((f) => f.endsWith(".sql"));
    return s.applied.length === 0 && s.dryRunStoppedAfter === "fs-controls-r1" && (await journalRows()).length === 1 && files.length === 1 && lines.filter((l) => /preflight OK/.test(l)).length >= 1 && lines.some((l) => /planned; their preflights require the previous batch/.test(l)) ? true : { s, rows: (await journalRows()).length, files };
  });

  group("R4  the installation window and the five batches");
  let summary, auditsBefore;
  await check("reporting is deactivated for the enabled company (audited) and the five wrappers apply in order with their journal rows", async () => {
    auditsBefore = await audits();
    summary = await runRelease({ url, plan, recoveryPoint: RP, operator: OP, mirrorDir: mirror, allowEnabled: [A], demoWindow: "deactivate", demoCompany: A, log });
    const rows = await journalRows();
    const hashes = rows.slice(1).map((r) => r.hash);
    const expected = plan.map((x) => x.hash);
    const increasing = rows.every((r, i) => i === 0 || Number(r.created_at) > Number(rows[i - 1].created_at));
    return summary.applied.length === 5 && rows.length === 6 && JSON.stringify(hashes) === JSON.stringify(expected) && increasing && (await enabled()) === false && (await audits()) === auditsBefore + 1
      ? true : { applied: summary.applied.length, rows: rows.length, hashes: hashes.map((h) => h.slice(0, 8)), increasing, enabled: await enabled(), audits: await audits() };
  });
  await check("the mirrors: tags 0064-0068, the exact wrapper bytes, journal entries whose when equals the hosted created_at, snapshots chained by index", async () => {
    const j = JSON.parse(fs.readFileSync(path.join(mirror, "meta/_journal.json"), "utf8"));
    const added = j.entries.slice(-5);
    const rows = (await journalRows()).slice(1);
    const ok = added.map((e) => e.tag).join(",") === "0064_fs_publication_controls,0065_fs_review_workflow_and_rollforward,0066_fs_work_bounds,0067_fs_account_capacity,0068_fs_transaction_memo"
      && added.every((e, i) => e.idx === 64 + i && String(e.when) === String(rows[i].created_at) && fs.readFileSync(path.join(mirror, `${e.tag}.sql`)).equals(plan[i].bytes) && sha256(fs.readFileSync(path.join(mirror, `${e.tag}.sql`))) === rows[i].hash)
      && added.every((e) => { const snap = (n) => JSON.parse(fs.readFileSync(path.join(mirror, "meta", `${String(n).padStart(4, "0")}_snapshot.json`), "utf8")); return snap(e.idx).prevId === snap(e.idx - 1).id; });
    return ok ? true : { tags: added.map((e) => e.tag), whens: added.map((e) => e.when), rows: rows.map((r) => r.created_at) };
  });
  await check("the run log carries no connection string and records the recovery point, the operator and every postcondition", async () => {
    const text = lines.join("\n");
    return !text.includes(url) && !text.includes(`:${p.password}@`) && text.includes(RP) && text.includes(OP) && lines.filter((l) => /postcondition OK; sign-offs unchanged/.test(l)).length === 5 ? true : lines.slice(-8);
  });

  group("R5  the released state is in force");
  await check("fs-work-bounds/2 with the account envelope, the memo helpers and the capacity guard exist", async () => {
    const b = (await db.one("SELECT public.fs_work_bounds() b")).b;
    const memo = await db.count("SELECT count(*) n FROM pg_proc WHERE proname IN ('_fs_memo_get', '_fs_memo_put', '_fs_statement_composition_compute', 'fs_account_capacity')");
    return b.contract === "fs-work-bounds/2" && b.accountsReadPerComposition === 1000 && b.evidenceRowsPerVersion === 3000 && memo === 4 ? true : { b, memo };
  });

  group("R6  a second run applies nothing");
  await check("every batch is reported as already applied by its hash; the journal is unchanged", async () => {
    const before = (await journalRows()).length;
    const s = await runRelease({ url, plan, recoveryPoint: RP, operator: OP, mirrorDir: mirror, allowEnabled: [], log });
    return s.applied.length === 0 && s.alreadyApplied.length === 5 && s.alreadyApplied.every((x) => x.form === "wrapper") && s.alreadyApplied.filter((x) => x.head).length === 1 && s.alreadyApplied[4].head === true && (await journalRows()).length === before ? true : { s, rows: (await journalRows()).length };
  });

  group("R7  restoration after the window");
  await check("reporting is re-enabled for the company with its own audit row; nothing else changes", async () => {
    const rows = (await journalRows()).length;
    const s = await runRelease({ url, plan: [], recoveryPoint: RP, operator: OP, mirrorDir: mirror, allowEnabled: [], restoreDemo: A, log });
    return s.restored === A && (await enabled()) === true && (await audits()) === auditsBefore + 2 && (await journalRows()).length === rows ? true : { s, enabled: await enabled(), audits: await audits() };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`
INFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("JOURNALLED_RUNNER", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
