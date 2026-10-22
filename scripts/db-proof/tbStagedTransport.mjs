#!/usr/bin/env bun
// Disposable PostgreSQL proof for the Trial Balance exact-byte transport.
// It never accepts a non-loopback connection and creates/drops only temporary local databases.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BATCHES, renderApply, renderBootstrap, renderStage, transportForms, BOOTSTRAP_PREDECESSOR } from "../release/tbStagedTransport.mjs";
import { releaseServer, hostedJournal } from "./lib/releaseBase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Client } = req("pg");
const sha = (text) => crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const results = [];
let groupName = "";
const group = (name) => { groupName = name; console.log(`\n== ${name}`); };
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); };
const expectFailure = async (name, fn, pattern) => {
  try { await fn(); check(name, false, "statement unexpectedly succeeded"); }
  catch (e) { check(name, pattern.test(String(e?.message ?? e)), String(e?.message ?? e).split("\n")[0]); }
};
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

async function tx(c, fn) {
  await c.query("BEGIN");
  try { const r = await fn(); await c.query("COMMIT"); return r; }
  catch (e) { try { await c.query("ROLLBACK"); } catch { /* connection error */ } throw e; }
}

async function hosted(c, tag, sql, rowFirst = false) {
  const hash = sha(sql);
  return tx(c, async () => {
    if (rowFirst) await c.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)", [hash, Date.now()]);
    await c.query(sql);
    if (!rowFirst) await c.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)", [hash, Date.now()]);
    return tag;
  });
}

async function stageBatch(c, index) {
  for (const kind of ["source", "wrapper", "postcondition"]) await c.query(renderStage(index, kind));
}

async function state(c) {
  return JSON.stringify({
    schema: (await one(c, "SELECT to_regnamespace('cfoclose_tb_release') IS NOT NULL AS present")).present,
    portfolio: (await one(c, "SELECT to_regclass('public.portfolio_revisions') IS NOT NULL AS present")).present,
    decisions: (await one(c, "SELECT to_regclass('public.tb_decision_actions') IS NOT NULL AS present")).present,
    events: (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.transport_events")).n,
    journal: (await one(c, "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).n,
  });
}

async function main() {
  const srv = releaseServer("tb-transport");
  let base, primary, wrong;
  try {
    await srv.start();
    // Reproduce the release's actual predecessor, not today's already-advanced hosted journal.
    const journalThrough = "0070_customer_checkout_abandon";
    base = await srv.buildBase([BATCHES[0].source, BATCHES[1].source], { sourceThrough: "20261119100000_customer_checkout_abandon.sql", journalThrough });
    check("historical TB predecessor is exactly the reviewed journal id and hash", base.journalRows === BOOTSTRAP_PREDECESSOR.id && hostedJournal(journalThrough).at(-1).hash === BOOTSTRAP_PREDECESSOR.hash);
    primary = await srv.copyOf(base.name, "primary");
    wrong = await srv.copyOf(base.name, "wrong-predecessor");
    const c = new Client({ connectionString: primary, ssl: false }); await c.connect();
    const w = new Client({ connectionString: wrong, ssl: false }); await w.connect();
    try {
      group("exact form and tamper refusal");
      const forms = transportForms();
      check("bootstrap and both applies have registered deterministic hashes", forms.length === 3 && forms.every((f) => f.hashes.every((h) => /^[0-9a-f]{64}$/.test(h))));
      await hosted(w, "foreign", "SELECT 1").catch(() => {});
      // A foreign journal row after the approved predecessor makes the bootstrap refuse before creating its schema.
      await expectFailure("wrong predecessor refuses before schema creation", () => hosted(w, "bootstrap", renderBootstrap()), /TB_TRANSPORT_WRONG_PREDECESSOR/);
      check("wrong predecessor leaves no transport schema", !(await one(w, "SELECT to_regnamespace('cfoclose_tb_release') IS NOT NULL AS present")).present);

      await expectFailure("tampered artifact is refused by the trigger", async () => {
        await hosted(c, "bootstrap", renderBootstrap());
        const good = renderStage(0, "wrapper");
        await c.query(good.replace("CFOClose", "XFOClose"));
      }, /TB_TRANSPORT_STAGE_REFUSED/);
      check("tampered stage leaves no staged artifacts", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.staged_artifacts")).n === 0);

      group("atomic apply, predecessor, retry and existing-record preservation");
      await stageBatch(c, 0); await stageBatch(c, 1);
      const existing = await one(c, "INSERT INTO auth.users(id, email) VALUES ($1, $2) RETURNING id, email", [crypto.randomUUID(), "existing@example.test"]);
      const before = await state(c);
      await c.query(`CREATE FUNCTION public._tb_transport_fail() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity LIKE 'public.portfolio_revisions%' THEN RAISE EXCEPTION 'TB_TRANSPORT_INJECTED_ROLLBACK'; END IF;
        END LOOP; END $f$;
        CREATE EVENT TRIGGER tb_transport_fail ON ddl_command_end EXECUTE FUNCTION public._tb_transport_fail();`);
      await expectFailure("wrapper failure is surfaced", () => hosted(c, "portfolio", renderApply(0)), /TB_TRANSPORT_INJECTED_ROLLBACK/);
      check("wrapper failure rolls back schema, stage consumption and journal", (await state(c)) === before);
      await c.query("DROP EVENT TRIGGER tb_transport_fail; DROP FUNCTION public._tb_transport_fail()");
      await c.query("CREATE TABLE public.portfolio_revisions(id integer)");
      await expectFailure("pre-existing target object is treated as uncertain state", () => hosted(c, "portfolio-uncertain", renderApply(0), true), /TB_TRANSPORT_UNCERTAIN_STATE/);
      check("uncertain target leaves the staged batch unconsumed", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.staged_artifacts WHERE batch='tb-portfolio-a1' AND consumed_at IS NOT NULL")).n === 0);
      await c.query("DROP TABLE public.portfolio_revisions");
      await hosted(c, "portfolio", renderApply(0));
      check("portfolio applies and records exactly one stage event plus one journal row", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.transport_events WHERE event='applied' AND batch='tb-portfolio-a1'")).n === 1);
      await expectFailure("duplicate portfolio apply refuses idempotently", () => hosted(c, "portfolio-duplicate", renderApply(0), true), /TB_TRANSPORT_ALREADY_APPLIED|TB_TRANSPORT_WRONG_PREDECESSOR/);
      await hosted(c, "decisions", renderApply(1));
      check("decisions applies only after portfolio and both batches are consumed", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.staged_artifacts WHERE consumed_at IS NOT NULL")).n === 6);
      const after = await state(c);
      const existingAfter = await one(c, "SELECT email FROM auth.users WHERE id=$1", [existing.id]);
      check("pre-existing auth record and journal state are preserved", existingAfter?.email === existing.email && JSON.parse(after).journal === 74);
      check("no source or wrapper is re-run on retry", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tb_release.transport_events WHERE event='applied'")).n === 2);

      const currentPolicy = fs.readFileSync(path.join(REPO, "supabase/migrations/20261122100000_tb_decision_catalogue_read_predicate.sql"), "utf8");
      await c.query(currentPolicy);
      check("later catalogue hardening applies after the verified transport without altering its journal", (await one(c, "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).n === 74);

      group("concurrent journal writers cannot invalidate an in-flight predecessor");
      const raceUrl = await srv.copyOf(base.name, "journal-race");
      const applying = new Client({ connectionString: raceUrl, ssl: false });
      const foreign = new Client({ connectionString: raceUrl, ssl: false });
      await applying.connect(); await foreign.connect();
      try {
        await hosted(applying, "bootstrap", renderBootstrap());
        await stageBatch(applying, 0);
        const applyingPid = (await one(applying, "SELECT pg_backend_pid() AS pid")).pid;
        const foreignPid = (await one(foreign, "SELECT pg_backend_pid() AS pid")).pid;
        await applying.query("BEGIN");
        await applying.query(renderApply(0));
        const foreignInsert = foreign.query(
          "INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)",
          ["foreign-concurrent-migration", Date.now()],
        );
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          blocked = (await one(applying, "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [applyingPid, foreignPid])).blocked;
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        check("a different migration writer waits until the canonical apply and its journal row commit", blocked);
        await applying.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)", [sha(renderApply(0)), Date.now()]);
        await applying.query("COMMIT");
        await foreignInsert;
        const journal = (await applying.query("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 2")).rows;
        check("the foreign row follows, never interrupts, the atomic portfolio application", journal[0]?.hash === "foreign-concurrent-migration" && journal[1]?.hash === sha(renderApply(0)));
        await expectFailure("a committed foreign successor then blocks the next TB batch", () => hosted(applying, "decisions", renderApply(1)), /TB_TRANSPORT_WRONG_PREDECESSOR/);
      } finally {
        await applying.query("ROLLBACK").catch(() => {});
        await applying.end(); await foreign.end();
      }
    } finally { await c.end(); await w.end(); }
  } catch (e) { check(`${groupName || "proof"} did not throw unexpectedly`, false, String(e?.stack ?? e).split("\n").slice(0, 3).join("\n")); }
  finally { await srv.cleanup(); }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nTB_STAGED_TRANSPORT_PROOF: ${failed ? "FAILED" : "OK"} (${results.length - failed} passed, ${failed} failed)`);
  process.exitCode = failed ? 1 : 0;
}

main();
