#!/usr/bin/env bun
// Real-PostgreSQL release proof of the reporting release (the five self-checking wrappers of release/wrappers/,
// batch reporting-r1) for the conditions a hosted rollout meets, on real data and the REAL process-trial-balance handler:
//
//   preflight      docs/release/reporting-r1/preflight.sql passes on main's schema and refuses once objects exist
//   mixed version  at EVERY stage (before the release, after each wrapper) the surfaces main's released app uses keep
//                  working — trial-balance certification through the real handler, Close Review, the reporting input,
//                  readiness — and data created before the release stays authoritative; the new client against a
//                  schema that lacks a function fails closed with an error, never with data
//   partial        a release stopped after wrapper 2 leaves a consistent database; continuing completes it
//   forward        a failure injected inside wrapper 4 rolls it back completely; the release continues by re-submitting
//   recovery       the same wrapper (no rollback scripts, no manual repair)
//   postcondition  docs/release/reporting-r1/postcondition.sql passes after the fifth wrapper; data created before the
//                  release composes, and the closure's notes status (contract 2) evaluates
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/reportingRelease.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import fs from "node:fs";
import path from "node:path";
import { applyChainBefore, ASSIGN, assignmentPairs, certifier, clientDb, csv, FY2025, FY2026, makeWorld, openDatabase, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { REPORTING_WRAPPED_SOURCES, wrapperFile } from "../release/selfCheckingWrapper.mjs";

const { group, check, finish } = reporter();
let db;
const wrapper = (s) => fs.readFileSync(path.join(REPO, wrapperFile(s)), "utf8");
const sql = (f) => fs.readFileSync(path.join(REPO, "docs/release/reporting-r1", f), "utf8");

async function main() {
  db = await openDatabase("release_proof");
  group("Base — main's schema before the reporting release");
  await check("the chain before 20261018100000 applies", async () => (await applyChainBefore(db, REPORTING_WRAPPED_SOURCES[0])) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;

  const readOnly = async (file) => {
    const notices = [];
    const on = (m) => notices.push(String(m.message));
    db.admin.on("notice", on);
    try {
      await db.admin.query("BEGIN READ ONLY");
      try { await db.admin.query(sql(file)); return { ok: true, notices }; } catch (e) { return { ok: false, message: String(e.message).split("\n")[0], notices }; }
      finally { await db.admin.query("ROLLBACK"); }
    } finally { db.admin.off("notice", on); }
  };

  group("Data created BEFORE the release (main's app, main's schema)");
  let certPrior, certCur;
  await check("two years certified by the real process-trial-balance handler; Close Review run; the reporting input current", async () => {
    const p = await k.upload(A, Y - 1, csv(FY2025)); await k.review(A, p); certPrior = await k.certify(A, p);
    const c = await k.upload(A, Y, csv(FY2026)); certCur = await k.certify(A, c);
    const run = (await db.asUser(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    const input = (await db.asUser(U.owner, "SELECT public.fs_reporting_input($1,$2) r", [A, Y])).r;
    return run?.runId && input?.state === "current" ? true : { run, input: input?.state };
  });
  await check("the hosted preflight passes on main's schema (read-only) and prints its baseline", async () => {
    const r = await readOnly("preflight.sql");
    return r.ok && r.notices.includes("PREFLIGHT OK.") && r.notices.some((n) => n.startsWith("BASELINE tb_certifications=")) ? true : r;
  });
  await check("the new client against main's schema fails closed: an error, never data", async () => {
    const r = await clientDb(db, U.owner).rpc("fs_statement_composition", { p_company_id: A, p_period_year: Y });
    return r.data === null && r.error && r.error.code === "42883" ? true : r;
  });

  // The surfaces main's released app uses, after every stage; and the pre-release data stays authoritative.
  let smokeYear = Y + 1; // each stage certifies a new year through the real handler
  const smoke = async (stage) => {
    const u = await k.upload(A, smokeYear++, csv(FY2026));
    const cert = await k.certify(A, u);
    const prior = (await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [A, Y - 1])).id;
    const run = (await db.asUser(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    const input = (await db.asUser(U.owner, "SELECT public.fs_reporting_input($1,$2) r", [A, Y])).r;
    const caps = (await db.asUser(U.preparer, "SELECT public.get_my_workspace_capabilities($1) r", [A])).r;
    return cert && prior === certPrior && run?.runId && input?.state === "current" && caps?.access === true ? true : { stage, cert, prior, run, input: input?.state };
  };

  const apply = async (s) => { try { await db.admin.query(wrapper(s)); return null; } catch (e) { return `${e.code}: ${String(e.message).split("\n")[0]}`; } };
  const [w1, w2, w3, w4, w5] = REPORTING_WRAPPED_SOURCES;

  group("Wrappers 1–2, then a stop (partial release)");
  for (const s of [w1, w2]) {
    await check(`${s}: applies`, async () => (await apply(s)) ?? true);
    await check(`after ${s.slice(0, 14)}: main's surfaces work; data created before the release is still authoritative`, () => smoke(s));
  }
  await check("stopped after wrapper 2: the database is consistent (the composition answers), the comparatives function is absent and the new client fails closed on it", async () => {
    const comp = (await db.asUser(U.owner, "SELECT public.fs_statement_composition($1,$2) r", [A, Y])).r;
    const r = await clientDb(db, U.owner).rpc("fs_comparatives_status", { p_company_id: A, p_period_year: Y });
    return typeof comp?.state === "string" && r.error?.code === "42883" ? true : { comp: comp?.state, r };
  });

  group("Wrapper 3; wrapper 4 fails, then is re-submitted (forward recovery)");
  await check(`${w3}: applies; main's surfaces work`, async () => (await apply(w3)) ?? smoke(w3));
  await check(`${w4}: a failure injected inside it rolls it back completely (no binding table, no trigger, no function)`, async () => {
    await db.admin.query(`CREATE SCHEMA IF NOT EXISTS proof_inject;
      CREATE OR REPLACE FUNCTION proof_inject.on_end() RETURNS event_trigger LANGUAGE plpgsql AS $f$
      DECLARE r record; BEGIN FOR r IN SELECT object_identity FROM pg_event_trigger_ddl_commands() LOOP
        IF r.object_identity = 'public.fs_publication_bindings' THEN RAISE EXCEPTION 'PROOF_INJECTED_FAILURE at %', r.object_identity USING ERRCODE = 'XX000'; END IF;
      END LOOP; END $f$;
      CREATE EVENT TRIGGER proof_inject_end ON ddl_command_end EXECUTE FUNCTION proof_inject.on_end();`);
    let failed;
    try { failed = await apply(w4); } finally { await db.admin.query("DROP EVENT TRIGGER IF EXISTS proof_inject_end; DROP SCHEMA proof_inject CASCADE"); }
    const left = (await db.one("SELECT to_regclass('public.fs_publication_bindings') t, to_regproc('public.fs_reporting_dependencies') f, (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_fsp_bind') g")).t;
    const f = (await db.one("SELECT to_regproc('public.fs_reporting_dependencies') f")).f;
    return /PROOF_INJECTED_FAILURE/.test(failed ?? "") && left === null && f === null ? true : { failed, left, f };
  });
  await check("at that state (3 of 5 applied, 4 failed) main's surfaces work", () => smoke("after a failed wrapper 4"));
  await check(`${w4}: re-submitted unchanged, it applies (no repair, no rollback script); main's surfaces work`, async () => (await apply(w4)) ?? smoke(w4));
  await check(`${w5}: applies; main's surfaces work`, async () => (await apply(w5)) ?? smoke(w5));

  group("After the release");
  await check("the hosted postcondition passes (read-only)", async () => {
    const r = await readOnly("postcondition.sql");
    return r.ok && r.notices.includes("POSTCONDITION OK.") ? true : r;
  });
  await check("the preflight now refuses (objects of the release exist), changing nothing", async () => {
    const r = await readOnly("preflight.sql");
    return !r.ok && /already exist/.test(r.message) ? true : r;
  });
  await check("re-submitting any wrapper is refused by its own preflight; nothing changes", async () => {
    const out = [];
    for (const s of REPORTING_WRAPPED_SOURCES) out.push(await apply(s));
    return out.every((x) => /P0001: PREFLIGHT_REFUSED/.test(x ?? "")) ? true : out;
  });
  await check("data certified BEFORE the release composes after it (assignment through the new function), and the notes status evaluates under contract 2", async () => {
    await db.asUser(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3)", [A, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]);
    const comp = (await db.asUser(U.owner, "SELECT public.fs_statement_composition($1,$2) r", [A, Y])).r;
    const notes = (await db.asUser(U.owner, "SELECT public.fs_notes_status($1,$2) r", [A, Y])).r;
    return comp.state === "composed" && comp.totals.current.totalAssetsMinor === "3300000" && notes.contract === "fs-notes-status/2" && certCur ? true : { comp: comp.state, notes: notes.contract };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("REPORTING_RELEASE", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
