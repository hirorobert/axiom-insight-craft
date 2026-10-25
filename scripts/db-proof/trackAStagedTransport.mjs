#!/usr/bin/env bun
// Disposable PostgreSQL proof for the track-a-r1 exact-byte transport (scripts/release/trackAStagedTransport.mjs).
// Loopback only (releaseBase refuses anything else); every database it creates is dropped by cleanup().
//
//   base   production-equivalent: every source migration through 20261126100000, hosted journal 0000–0079 (id 80)
//   P1     staging refuses a changed byte, a final LF, an artifact kind a batch does not carry; evidence is append-only;
//          clients cannot see it
//   P2     wrong predecessor, missing bootstrap, out of order (the guard before the hardening): refused, nothing changed
//   P3     interrupted application (failure injected inside 20261127100000): whole statement rolled back, stage and journal
//          included; the retry then applies cleanly
//   P4     postcondition failure on batch 2 (batch 1 weakened after it applied): rolled back; retry after repair applies
//   P5     duplicate and concurrent submissions: exactly one applies
//   P6     success in order: three journal rows with the registered hashes (ids 81–83), every artifact consumed, two applied
//          events, an existing sign-off binding and account preserved byte for byte
import crypto from "node:crypto";
import { BATCHES, BOOTSTRAP_PREDECESSOR, kindsOf, renderApply, renderBootstrap, renderStage, transportForms } from "../release/trackAStagedTransport.mjs";
import { releaseServer, Client, hostedJournal } from "./lib/releaseBase.mjs";

const sha = (t) => crypto.createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`); };
const group = (n) => console.log(`\n== ${n}`);
const one = async (c, sql, p = []) => (await c.query(sql, p)).rows[0];
async function refuses(name, fn, re) { try { await fn(); check(name, false, "unexpectedly succeeded"); } catch (e) { check(name, re.test(String(e?.message)), String(e?.message).split("\n")[0]); } }
/** Hosted-executor model: the submission and its journal row in one transaction. */
async function hosted(c, sql) {
  await c.query("BEGIN");
  try { await c.query(sql); await c.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ($1, $2)", [sha(sql), Date.now()]); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
}
const stage = async (c, i) => { for (const k of kindsOf(i)) await c.query(renderStage(i, k)); };
async function state(c) {
  const has = (await one(c, "SELECT to_regnamespace('cfoclose_tra_release') IS NOT NULL AS p")).p;
  return JSON.stringify({
    journal: (await c.query("SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id")).rows,
    stage: has ? (await c.query("SELECT batch, kind, consumed_at IS NOT NULL AS c FROM cfoclose_tra_release.staged_artifacts ORDER BY 1, 2")).rows : null,
    events: has ? (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tra_release.transport_events")).n : null,
    intents: (await one(c, "SELECT to_regclass('public.fs_authority_replacement_intents') IS NOT NULL AS p")).p,
    events_table: (await one(c, "SELECT to_regclass('public.company_framework_events') IS NOT NULL AS p")).p,
    guard: (await one(c, "SELECT to_regprocedure('public.guard_company_reporting_framework()') IS NOT NULL AS p")).p,
    state_fn: (await one(c, "SELECT md5(pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) AS d")).d,
    svc_truncate: (await one(c, "SELECT has_table_privilege('service_role', 'public.tb_certifications', 'TRUNCATE') AS p")).p,
  });
}
const BINDINGS = "SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq), '')) AS d FROM public.fs_publication_bindings f";
async function seedBinding(c) {
  const cols = (await c.query("SELECT column_name, data_type, is_identity, is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='fs_publication_bindings' ORDER BY ordinal_position")).rows
    .filter((r) => r.is_identity !== "YES" && r.is_generated !== "ALWAYS");
  const fixed = { state: "FINAL", report_id: "fsr-2025-proof", report_version: 6, document_sha256: "c".repeat(64), declared_content_hash: "d".repeat(64),
    dependencies_sha256: "e".repeat(64), approver_role: "owner", signoff_policy: "solo_owner" };
  const val = (r) => r.column_name in fixed ? fixed[r.column_name] : r.data_type === "uuid" ? crypto.randomUUID() : r.data_type === "boolean" ? true
    : /int|numeric/.test(r.data_type) ? 1 : /timestamp/.test(r.data_type) ? "2026-10-09T14:00:00Z" : /json/.test(r.data_type) ? { proof: r.column_name } : `proof-${r.column_name}`;
  await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
  await c.query(`INSERT INTO public.fs_publication_bindings(${cols.map((r) => `"${r.column_name}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map(val));
  await c.query("COMMIT");
}

async function main() {
  const srv = releaseServer("tra-transport");
  try {
    await srv.start();
    const base = await srv.buildBase(BATCHES.map((b) => b.source), { sourceThrough: "20261126100000_fs_document_structure.sql", journalThrough: BOOTSTRAP_PREDECESSOR.tag });
    check("base journal is exactly the approved predecessor (id 80 and hash)", base.journalRows === BOOTSTRAP_PREDECESSOR.id && hostedJournal(BOOTSTRAP_PREDECESSOR.tag).at(-1).hash === BOOTSTRAP_PREDECESSOR.hash);
    const forms = transportForms();
    check("three registered deterministic forms, none ends in LF, no transaction control", forms.length === 3 && forms.every((f) => !f.text.endsWith("\n") && !/\b(COMMIT|ROLLBACK)\b/.test(f.text)));

    group("P2 refusals before anything exists");
    const w = new Client({ connectionString: await srv.copyOf(base.name, "wrong"), ssl: false }); await w.connect();
    try {
      await refuses("an apply without the bootstrap refuses", () => hosted(w, renderApply(0)), /TRA_TRANSPORT_WRONG_PREDECESSOR|TRA_TRANSPORT_NOT_INSTALLED/);
      await w.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('foreign', 1)");
      const before = await state(w);
      await refuses("bootstrap after a foreign journal row refuses", () => hosted(w, renderBootstrap()), /TRA_TRANSPORT_WRONG_PREDECESSOR/);
      check("wrong predecessor changed nothing", (await state(w)) === before);
    } finally { await w.end(); }

    const url = await srv.copyOf(base.name, "primary");
    const c = new Client({ connectionString: url, ssl: false }); await c.connect();
    try {
      await seedBinding(c);
      const acct = await one(c, "INSERT INTO auth.users(id, email) VALUES ($1, 'existing@example.test') RETURNING id", [crypto.randomUUID()]);
      const bindings0 = await one(c, BINDINGS);
      check("an existing sign-off binding is present before the release", bindings0.n === 1);

      group("P1 staging is exact and append-only");
      await hosted(c, renderBootstrap());
      await refuses("a changed byte is refused", () => c.query(renderStage(0, "wrapper").replace("CFOClose self-checking", "CFOClose self-checkinG")), /TRA_TRANSPORT_STAGE_REFUSED/);
      await refuses("an added final LF is refused", () => c.query(renderStage(0, "source").replace(/\$cfoclose_tra_stage_([0-9a-f]{16})\$\);\n$/, "\n$cfoclose_tra_stage_$1$);\n")), /TRA_TRANSPORT_STAGE_REFUSED/);
      await refuses("an artifact kind a batch does not carry is refused", () => c.query(renderStage(0, "preflight").replace("'tra-1-authority-hardening', 'preflight'", "'tra-2-framework-guard', 'preflight'")), /TRA_TRANSPORT_STAGE_REFUSED/);
      check("refused staging left nothing", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tra_release.staged_artifacts")).n === 0);
      for (let i = 0; i < BATCHES.length; i++) await stage(c, i);
      check("all seven exact artifacts staged", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tra_release.staged_artifacts")).n === 7);
      await refuses("a duplicate stage is refused", () => c.query(renderStage(0, "source")), /duplicate key/);
      await refuses("update of staged evidence is refused", () => c.query("UPDATE cfoclose_tra_release.staged_artifacts SET body = body || ' ' WHERE batch = 'tra-1-authority-hardening' AND kind = 'source'"), /TRA_TRANSPORT_STAGE_IMMUTABLE/);
      await refuses("delete of staged evidence is refused", () => c.query("DELETE FROM cfoclose_tra_release.staged_artifacts"), /TRA_TRANSPORT_STAGE_IMMUTABLE/);
      await refuses("truncate of evidence is refused", () => c.query("TRUNCATE cfoclose_tra_release.transport_events"), /TRA_TRANSPORT_EVIDENCE_IMMUTABLE/);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await one(c, "SELECT has_schema_privilege($1, 'cfoclose_tra_release', 'USAGE') AS u, has_table_privilege($1, 'cfoclose_tra_release.staged_artifacts', 'SELECT') AS s", [role]);
        check(`${role} has no access to the transport`, !r.u && !r.s);
      }

      group("P2 out of order: the enforcement guard before the hardening");
      let before = await state(c);
      await refuses("batch 2 before batch 1 refuses", () => hosted(c, renderApply(1)), /TRA_TRANSPORT_WRONG_PREDECESSOR|TRA_TRANSPORT_PRIOR_NOT_APPLIED/);
      check("out-of-order refusal changed nothing", (await state(c)) === before);

      group("P3 interrupted application of batch 1 and retry");
      await c.query(`CREATE FUNCTION public._tra_fail() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity LIKE 'public.company_framework_events%' THEN RAISE EXCEPTION 'TRA_INJECTED_INTERRUPTION'; END IF; END LOOP; END $f$;
        CREATE EVENT TRIGGER tra_fail ON ddl_command_end EXECUTE FUNCTION public._tra_fail();`);
      before = await state(c);
      await refuses("an interruption in the middle of 20261127100000 surfaces", () => hosted(c, renderApply(0)), /TRA_INJECTED_INTERRUPTION/);
      check("interruption rolled back schema, privileges, stage consumption, events and journal", (await state(c)) === before);
      await c.query("DROP EVENT TRIGGER tra_fail; DROP FUNCTION public._tra_fail()");
      await hosted(c, renderApply(0));
      const s1 = JSON.parse(await state(c));
      check("retry of the interrupted batch applies (preflight, wrapper, postcondition 1)", s1.intents && s1.events_table && !s1.guard && s1.svc_truncate === false);

      group("P4 postcondition failure on batch 2 rolls back");
      await c.query("GRANT UPDATE ON public.fs_report_authority TO service_role");
      before = await state(c);
      await refuses("postcondition 2 names the weakened batch 1", () => hosted(c, renderApply(1)), /TRA_POSTCONDITION: batch 1/);
      check("postcondition failure rolled back the guard and its journal row", (await state(c)) === before);
      await c.query("REVOKE UPDATE ON public.fs_report_authority FROM service_role");
      await hosted(c, renderApply(1));

      group("P5 duplicate submissions");
      before = await state(c);
      await refuses("a duplicate of the last batch refuses", () => hosted(c, renderApply(1)), /TRA_TRANSPORT_WRONG_PREDECESSOR|TRA_TRANSPORT_ALREADY_APPLIED/);
      await refuses("a re-run of the first batch refuses", () => hosted(c, renderApply(0)), /TRA_TRANSPORT_WRONG_PREDECESSOR|TRA_TRANSPORT_ALREADY_APPLIED/);
      check("duplicates changed nothing", (await state(c)) === before);

      group("P6 final state");
      const j = (await c.query("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3")).rows.map((r) => r.hash).reverse();
      check("journal ends with exactly the three registered forms, in order", JSON.stringify(j) === JSON.stringify(forms.map((f) => f.hashes[0])));
      check("journal id of the last entry is 83", (await one(c, "SELECT max(id)::int AS m FROM drizzle.__drizzle_migrations")).m === 83);
      check("all seven artifacts consumed", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tra_release.staged_artifacts WHERE consumed_at IS NOT NULL")).n === 7);
      check("exactly two applied events", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_tra_release.transport_events WHERE event = 'applied'")).n === 2);
      const s = JSON.parse(await state(c));
      check("both targets installed", s.intents && s.events_table && s.guard);
      const b1 = await one(c, BINDINGS);
      check("existing sign-off binding byte-identical", b1.n === bindings0.n && b1.d === bindings0.d);
      check("existing account preserved", !!(await one(c, "SELECT 1 AS x FROM auth.users WHERE id = $1", [acct.id])));
    } finally { await c.end(); }

    group("P5 concurrent submissions of the same entry");
    const rurl = await srv.copyOf(base.name, "race");
    const a = new Client({ connectionString: rurl, ssl: false }), b = new Client({ connectionString: rurl, ssl: false });
    await a.connect(); await b.connect();
    try {
      await hosted(a, renderBootstrap()); await stage(a, 0);
      const [ra, rb] = await Promise.allSettled([hosted(a, renderApply(0)), hosted(b, renderApply(0))]);
      check("exactly one of two concurrent submissions applies", [ra, rb].filter((r) => r.status === "fulfilled").length === 1,
        [ra, rb].map((r) => r.status === "rejected" ? String(r.reason?.message).split("\n")[0] : "ok").join(" | "));
      check("one applied event and one journal row", (await one(a, "SELECT count(*)::int AS n FROM cfoclose_tra_release.transport_events WHERE event = 'applied'")).n === 1
        && (await one(a, "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash = $1", [forms[1].hashes[0]])).n === 1);
    } finally { await a.end(); await b.end(); }
  } catch (e) { check("proof did not throw unexpectedly", false, String(e?.stack ?? e).split("\n").slice(0, 4).join("\n")); }
  finally { await srv.cleanup(); }
  const failed = results.filter((r) => !r).length;
  console.log(`\nTRA_STAGED_TRANSPORT_PROOF: ${failed ? "FAILED" : "OK"} (${results.length - failed} passed, ${failed} failed)`);
  process.exitCode = failed ? 1 : 0;
}
main();
