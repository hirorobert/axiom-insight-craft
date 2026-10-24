#!/usr/bin/env bun
// Disposable PostgreSQL proof for the fs-integrity-r1 exact-byte transport (scripts/release/fsIntegrityStagedTransport.mjs).
// Loopback only (releaseBase refuses anything else); every database it creates is dropped by cleanup().
//
//   base   production-equivalent: every source migration through 20261122100000 except the four, hosted journal 0000–0074
//   P1     staging refuses a changed byte, a final LF, an unknown kind; evidence is append-only; clients cannot see it
//   P2     wrong predecessor, missing bootstrap, missing stage, out of order: refused, nothing changed
//   P3     interrupted application (failure injected inside a wrapper): whole statement rolled back, stage and journal included;
//          the retry then applies cleanly
//   P4     postcondition failure on the last batch: rolled back; retry after the cause is removed applies
//   P5     duplicate and concurrent submissions: exactly one applies
//   P6     success in order: four journal rows with the registered hashes, every artifact consumed, four applied events,
//          an existing sign-off binding and account preserved byte for byte
import crypto from "node:crypto";
import { BATCHES, BOOTSTRAP_PREDECESSOR, kindsOf, renderApply, renderBootstrap, renderStage, transportForms } from "../release/fsIntegrityStagedTransport.mjs";
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
  const has = (await one(c, "SELECT to_regnamespace('cfoclose_fsi_release') IS NOT NULL AS p")).p;
  return JSON.stringify({
    journal: (await c.query("SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id")).rows,
    stage: has ? (await c.query("SELECT batch, kind, consumed_at IS NOT NULL AS c FROM cfoclose_fsi_release.staged_artifacts ORDER BY 1, 2")).rows : null,
    events: has ? (await one(c, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.transport_events")).n : null,
    compilations: (await one(c, "SELECT to_regclass('public.fs_server_compilations') IS NOT NULL AS p")).p,
    authority: (await one(c, "SELECT to_regclass('public.fs_report_authority') IS NOT NULL AS p")).p,
    structure: (await one(c, "SELECT to_regproc('public._fs_document_structure_blockers') IS NOT NULL AS p")).p,
    blockers: (await one(c, "SELECT md5(pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) AS d")).d,
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
  const srv = releaseServer("fsi-transport");
  try {
    await srv.start();
    const base = await srv.buildBase(BATCHES.map((b) => b.source), { sourceThrough: "20261122100000_tb_decision_catalogue_read_predicate.sql", journalThrough: BOOTSTRAP_PREDECESSOR.tag });
    check("base journal is exactly the approved predecessor (id and hash)", base.journalRows === BOOTSTRAP_PREDECESSOR.id && hostedJournal(BOOTSTRAP_PREDECESSOR.tag).at(-1).hash === BOOTSTRAP_PREDECESSOR.hash);
    const forms = transportForms();
    check("five registered deterministic forms, none ends in LF, no transaction control", forms.length === 5 && forms.every((f) => !f.text.endsWith("\n") && !/\b(COMMIT|ROLLBACK)\b/.test(f.text)));

    group("P2 refusals before anything exists");
    const w = new Client({ connectionString: await srv.copyOf(base.name, "wrong"), ssl: false }); await w.connect();
    try {
      await refuses("an apply without the bootstrap refuses", () => hosted(w, renderApply(0)), /FSI_TRANSPORT_WRONG_PREDECESSOR|FSI_TRANSPORT_NOT_INSTALLED/);
      await w.query("INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('foreign', 1)");
      const before = await state(w);
      await refuses("bootstrap after a foreign journal row refuses", () => hosted(w, renderBootstrap()), /FSI_TRANSPORT_WRONG_PREDECESSOR/);
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
      await refuses("a changed byte is refused", () => c.query(renderStage(0, "wrapper").replace("CFOClose self-checking", "CFOClose self-checkinG")), /FSI_TRANSPORT_STAGE_REFUSED/);
      await refuses("an added final LF is refused", () => c.query(renderStage(0, "source").replace(/\$cfoclose_fsi_stage_([0-9a-f]{16})\$\);\n$/, "\n$cfoclose_fsi_stage_$1$);\n")), /FSI_TRANSPORT_STAGE_REFUSED/);
      await refuses("an artifact kind a batch does not carry is refused", () => c.query(renderStage(0, "preflight").replace("'fsi-1-server-compilation', 'preflight'", "'fsi-2-integrity-gate', 'preflight'")), /FSI_TRANSPORT_STAGE_REFUSED/);
      check("refused staging left nothing", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.staged_artifacts")).n === 0);
      for (let i = 0; i < 4; i++) await stage(c, i);
      check("all ten exact artifacts staged", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.staged_artifacts")).n === 10);
      await refuses("a duplicate stage is refused", () => c.query(renderStage(0, "source")), /duplicate key/);
      await refuses("update of staged evidence is refused", () => c.query("UPDATE cfoclose_fsi_release.staged_artifacts SET body = body || ' ' WHERE batch = 'fsi-1-server-compilation' AND kind = 'source'"), /FSI_TRANSPORT_STAGE_IMMUTABLE/);
      await refuses("delete of staged evidence is refused", () => c.query("DELETE FROM cfoclose_fsi_release.staged_artifacts"), /FSI_TRANSPORT_STAGE_IMMUTABLE/);
      await refuses("truncate of evidence is refused", () => c.query("TRUNCATE cfoclose_fsi_release.transport_events"), /FSI_TRANSPORT_EVIDENCE_IMMUTABLE/);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await one(c, "SELECT has_schema_privilege($1, 'cfoclose_fsi_release', 'USAGE') AS u, has_table_privilege($1, 'cfoclose_fsi_release.staged_artifacts', 'SELECT') AS s", [role]);
        check(`${role} has no access to the transport`, !r.u && !r.s);
      }

      group("P2 out of order");
      let before = await state(c);
      await refuses("batch 2 before batch 1 refuses", () => hosted(c, renderApply(1)), /FSI_TRANSPORT_WRONG_PREDECESSOR|FSI_TRANSPORT_PRIOR_NOT_APPLIED/);
      check("out-of-order refusal changed nothing", (await state(c)) === before);

      group("P6/P3 success in order with an interrupted application and retry");
      await hosted(c, renderApply(0));
      await hosted(c, renderApply(1));
      await c.query(`CREATE FUNCTION public._fsi_fail() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity LIKE 'public.fs_report_authority_events%' THEN RAISE EXCEPTION 'FSI_INJECTED_INTERRUPTION'; END IF; END LOOP; END $f$;
        CREATE EVENT TRIGGER fsi_fail ON ddl_command_end EXECUTE FUNCTION public._fsi_fail();`);
      before = await state(c);
      await refuses("an interruption in the middle of 20261125100000 surfaces", () => hosted(c, renderApply(2)), /FSI_INJECTED_INTERRUPTION/);
      check("interruption rolled back schema, stage consumption, events and journal", (await state(c)) === before);
      await c.query("DROP EVENT TRIGGER fsi_fail; DROP FUNCTION public._fsi_fail()");
      await hosted(c, renderApply(2));
      check("retry of the interrupted batch applies", JSON.parse(await state(c)).authority === true);

      group("P4 postcondition failure rolls back");
      const def = (await one(c, "SELECT pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure) AS d")).d;
      await c.query(def.replace("withdrawing a recorded review needs the review_close capability", "withdrawing a recorded review needs the review_close capabilitY"));
      before = await state(c);
      await refuses("the postcondition names the broken guard", () => hosted(c, renderApply(3)), /POSTCONDITION: fs_set_publication_state/);
      check("postcondition failure rolled back the document-structure batch and its journal row", (await state(c)) === before);
      await c.query(def);
      await hosted(c, renderApply(3));

      group("P5 duplicate and concurrent submissions");
      before = await state(c);
      await refuses("a duplicate of the last batch refuses", () => hosted(c, renderApply(3)), /FSI_TRANSPORT_WRONG_PREDECESSOR|FSI_TRANSPORT_ALREADY_APPLIED/);
      await refuses("a re-run of the first batch refuses", () => hosted(c, renderApply(0)), /FSI_TRANSPORT_WRONG_PREDECESSOR|FSI_TRANSPORT_ALREADY_APPLIED/);
      check("duplicates changed nothing", (await state(c)) === before);

      group("P6 final state");
      const j = (await c.query("SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 5")).rows.map((r) => r.hash).reverse();
      check("journal ends with exactly the five registered forms, in order", JSON.stringify(j) === JSON.stringify(forms.map((f) => f.hashes[0])));
      check("journal id of the last entry is 80", (await one(c, "SELECT max(id)::int AS m FROM drizzle.__drizzle_migrations")).m === 80);
      check("all ten artifacts consumed", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.staged_artifacts WHERE consumed_at IS NOT NULL")).n === 10);
      check("exactly four applied events", (await one(c, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.transport_events WHERE event = 'applied'")).n === 4);
      const s = JSON.parse(await state(c));
      check("all four targets installed", s.compilations && s.authority && s.structure);
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
      check("one applied event and one journal row", (await one(a, "SELECT count(*)::int AS n FROM cfoclose_fsi_release.transport_events WHERE event = 'applied'")).n === 1
        && (await one(a, "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash = $1", [forms[1].hashes[0]])).n === 1);
    } finally { await a.end(); await b.end(); }
  } catch (e) { check("proof did not throw unexpectedly", false, String(e?.stack ?? e).split("\n").slice(0, 4).join("\n")); }
  finally { await srv.cleanup(); }
  const failed = results.filter((r) => !r).length;
  console.log(`\nFSI_STAGED_TRANSPORT_PROOF: ${failed ? "FAILED" : "OK"} (${results.length - failed} passed, ${failed} failed)`);
  process.exitCode = failed ? 1 : 0;
}
main();
