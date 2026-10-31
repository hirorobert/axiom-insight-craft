// The exact approved IPSAS migration through its transport, on the real predecessor chain in a disposable loopback database.
// No hosted credentials, provider calls or application activation. The migration and the equipment transport are unchanged.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChainBefore, makeWorld, migrationText, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { BATCHES, BOOTSTRAP_PREDECESSOR, artifactBytes, renderBootstrap, renderApply, renderStage, transportForms, PRESERVED_TABLES } from "../release/ipsasStagedTransport.mjs";
import { CASES, PROOF } from "./ipsasTransport.manifest.mjs";
const results = []; const forms = transportForms(); const manifest = fs.readFileSync(new URL("./ipsasTransport.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/ipsasTransport.present.json");
const SCHEMA = "cfoclose_ipsas_release";
let db, crashed = false, completed = false, crashMessage = null;
async function kase(id, fn) { assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id)); try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); } catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${e.message}` }); throw e; } }
async function refusal(sql, needle, params = []) { let error; try { await db.admin.query(sql, params); } catch (e) { error = e; } assert(error, "expected refusal"); if (needle) assert(String(error.message).includes(needle), String(error.message)); }
const row = async (sql, params = []) => (await db.admin.query(sql, params)).rows[0];
const snapshot = async () => { const out = {}; for (const t of PRESERVED_TABLES) out[t] = (await row(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) v FROM public.${t} t`)).v; return out; };
async function entry(client, index) { await client.query("BEGIN"); try { await client.query(index === 0 ? renderBootstrap() : renderApply(index - 1)); await client.query("INSERT INTO drizzle.__drizzle_migrations(id,hash) VALUES($1,$2)", [BOOTSTRAP_PREDECESSOR.id + 1 + index, forms[index].hashes[0]]); await client.query("COMMIT"); } catch (e) { await client.query("ROLLBACK"); throw e; } }
async function interrupted() { await db.admin.query("BEGIN"); try { await db.admin.query(renderApply(0)); await db.admin.query("SELECT 1/0"); assert.fail("late fault did not throw"); } catch (e) { assert.equal(e.code, "22012"); } finally { await db.admin.query("ROLLBACK"); } }
const notInstalled = async () => assert((await row("SELECT to_regclass('public.ipsas_prep_revisions') IS NULL AND to_regprocedure('public.ipsas_confirm(uuid,integer,text,text,uuid,uuid)') IS NULL v")).v);
const consumed = async () => (await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts WHERE consumed_at IS NOT NULL`)).n;
/** One digest over everything the preparation migration creates: columns, defaults + what each default is bound to, constraints, indexes, triggers, RLS, ACLs, functions. */
const REL = "(c.relname LIKE 'ipsas\\_prep\\_%' OR c.relname LIKE 'ipsas\\_confirmations%')";
const CATALOG = `SELECT x FROM (
  SELECT 'rel:'||c.relname||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity||':'||c.relforcerowsecurity AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND ${REL}
  UNION ALL SELECT 'col:'||c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||a.attidentity::text||':'||a.attgenerated::text
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND ${REL} AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'con:'||c.relname||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND ${REL}
  UNION ALL SELECT 'idx:'||i.indexdef FROM pg_indexes i JOIN pg_class c ON c.relname=i.tablename AND c.relnamespace='public'::regnamespace WHERE i.schemaname='public' AND ${REL}
  UNION ALL SELECT 'trg:'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND ${REL} AND NOT t.tgisinternal
  UNION ALL SELECT 'fn:'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||p.prosecdef||':'||p.provolatile::text||':'||coalesce(p.proacl::text,'')||':'||coalesce(p.proconfig::text,'')||':'||md5(pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE '\\_ipsas\\_%' OR p.proname LIKE 'ipsas\\_%')
  UNION ALL SELECT 'bind:'||c.relname||':'||coalesce((SELECT n.nspname||'.'||p.proname FROM pg_depend dp JOIN pg_proc p ON p.oid=dp.refobjid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE dp.classid='pg_attrdef'::regclass AND dp.objid=d.oid AND dp.refclassid='pg_proc'::regclass LIMIT 1),'pg_catalog-pinned')
    FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid WHERE c.relnamespace='public'::regnamespace AND ${REL}
) q ORDER BY x`;
// Deparsing depends on the READING session's search_path and an unqualified name binds through the EXECUTING session's: both the reference
// and every installation use a fresh pooled session, and every read runs under one explicit path, so only the stored catalogue can differ.
const catalog = async (client, { inTx = false } = {}) => { if (!inTx) await client.query("BEGIN"); let facts; try { await client.query("SET LOCAL search_path TO public"); facts = (await client.query(CATALOG)).rows.map((r) => r.x); } finally { if (!inTx) await client.query("ROLLBACK"); }
  return { d: crypto.createHash("md5").update(facts.join(String.fromCharCode(10))).digest("hex"), n: facts.length, facts }; };
try {
  db = await openDatabase("ipsas_transport_proof");
  await kase("setup.real-predecessor-chain", async () => {
    assert.equal(await applyChainBefore(db, BATCHES[0].source), null);
    assert((await row("SELECT to_regclass('public.fs_equipment_answers') IS NOT NULL v")).v, "the equipment multi-class migration is part of the predecessor chain");
    await db.admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations(id integer PRIMARY KEY,hash text NOT NULL)");
  });
  await kase("bootstrap.wrong-predecessor-refused", () => refusal(renderBootstrap(), "WRONG_PREDECESSOR"));
  await kase("bootstrap.exact-id-required", async () => {
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(90,$1)", [BOOTSTRAP_PREDECESSOR.hashes[0]]);
    await refusal(renderBootstrap(), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=90");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(91,$1)", [BOOTSTRAP_PREDECESSOR.hashes[1]]); // the migrator's final-LF form is accepted too
  });
  const W = await makeWorld(db);
  await db.asService("SELECT public.fs_set_company_rollout($1,true,'proof rollout change','proof')", [W.A]); // before the baseline: setup, not a transport effect
  await db.admin.query(`INSERT INTO public.fs_schedule_submissions(company_id,period_year,schedule_id,rows,opening_total,closing_total,content_sha256,source_ref,actor_user_id,request_id)
    VALUES($1,2026,'ppe','[]',0,0,repeat('a',64),'Synthetic existing schedule',$2,$3)`, [W.A, W.U.owner, uuid()]);
  await db.admin.query(`INSERT INTO public.fs_disclosure_texts(company_id,period_year,requirement_id,body,source_ref,actor_user_id,request_id)
    VALUES($1,2026,'smes.note.policies','Synthetic existing policy','Synthetic source',$2,$3)`, [W.A, W.U.owner, uuid()]);
  const before = await snapshot();
  await kase("bootstrap.private-install", async () => { await entry(db.admin, 0); assert((await row(`SELECT to_regnamespace('${SCHEMA}') IS NOT NULL v`)).v); });
  await kase("bootstrap.existing-schema-refused", () => refusal(renderBootstrap(), "WRONG_PREDECESSOR"));
  await kase("stage.client-roles-denied", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await row("SELECT has_schema_privilege($1,'" + SCHEMA + "','USAGE') v", [role])).v, false);
      let error; try { await db.asRole(role, null, `SELECT * FROM ${SCHEMA}.staged_artifacts`); } catch (e) { error = e; } assert.equal(error?.code, "42501");
      assert.equal((await row("SELECT has_sequence_privilege($1,'" + SCHEMA + ".transport_events_seq_seq','USAGE') v", [role])).v, false);
    }
  });
  await kase("apply.missing-stage-refused", () => refusal(renderApply(0), "UNCERTAIN_STAGE"));
  await kase("stage.one-byte-tamper-refused", () => refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES($1,'source',$2)`, "STAGE_REFUSED", [BATCHES[0].batch, artifactBytes(0, "source").toString("utf8") + " "]));
  await kase("stage.unknown-artifact-refused", () => refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES('unreviewed','source','SELECT 1')`, "STAGE_REFUSED"));
  await kase("stage.exact-source-inert", async () => {
    await db.admin.query(renderStage(0, "source"));
    await notInstalled();
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts WHERE consumed_at IS NULL`)).n, 1);
    assert.deepEqual(await snapshot(), before);
  });
  await kase("stage.immutable-evidence", async () => {
    await refusal(`UPDATE ${SCHEMA}.staged_artifacts SET body=body||' '`, "STAGE_IMMUTABLE");
    await refusal(`DELETE FROM ${SCHEMA}.staged_artifacts`, "STAGE_IMMUTABLE");
    await refusal(`TRUNCATE ${SCHEMA}.staged_artifacts`, "EVIDENCE_IMMUTABLE");
    await refusal(`DELETE FROM ${SCHEMA}.transport_events`, "EVIDENCE_IMMUTABLE");
    await refusal(`TRUNCATE ${SCHEMA}.transport_events`, "EVIDENCE_IMMUTABLE");
  });
  await kase("apply.rehash-does-not-trust-metadata", async () => {
    await db.admin.query("BEGIN"); try {
      await db.admin.query(`ALTER TABLE ${SCHEMA}.staged_artifacts DISABLE TRIGGER trg_staged_artifacts_guard`);
      await db.admin.query(`UPDATE ${SCHEMA}.staged_artifacts SET body=body||' ' WHERE batch=$1`, [BATCHES[0].batch]);
      await refusal(renderApply(0), "STAGE_MISSING_OR_MODIFIED");
    } finally { await db.admin.query("ROLLBACK"); }
  });
  await kase("apply.prerequisite-missing-refused", async () => {
    await db.admin.query("BEGIN"); try {
      await db.admin.query("ALTER FUNCTION public._cr_certified_accounts(uuid) RENAME TO _cr_certified_accounts_gone");
      await refusal(renderApply(0), "PREREQUISITE_MISSING");
    } finally { await db.admin.query("ROLLBACK"); }
    await notInstalled();
  });
  await kase("apply.unexpected-journal-head-refused", async () => {
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(999,'unreviewed')");
    await refusal(renderApply(0), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=999");
  });
  await kase("apply.late-failure-rolls-back", async () => {
    await interrupted(); await notInstalled();
    assert.equal(await consumed(), 0); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.baseline-change-rolls-back", async () => {
    // A deliberately hostile DDL hook in this disposable DB proves preservation is enforced, not just logged.
    await db.admin.query(`CREATE FUNCTION public.ipsas_transport_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF to_regclass('public.ipsas_prep_revisions') IS NOT NULL AND to_regclass('public.ipsas_confirmations') IS NULL THEN UPDATE public.financial_statements_rollout_state SET kill_switch=NOT kill_switch WHERE singleton; END IF;
    END$$; CREATE EVENT TRIGGER ipsas_transport_fault ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.ipsas_transport_fault()`);
    try { await refusal(renderApply(0), "BASELINE_CHANGED"); } finally { await db.admin.query("DROP EVENT TRIGGER ipsas_transport_fault; DROP FUNCTION public.ipsas_transport_fault()"); }
    await notInstalled(); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.privilege-postcondition-rolls-back", async () => {
    // A hostile hook that widens a privilege after the migration's own grants: the apply must refuse and roll back.
    await db.admin.query(`CREATE FUNCTION public.ipsas_transport_widen() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF to_regprocedure('public.ipsas_confirm(uuid,integer,text,text,uuid,uuid)') IS NOT NULL AND NOT has_function_privilege('anon','public.ipsas_prep_context(uuid,integer)','EXECUTE') THEN GRANT EXECUTE ON FUNCTION public.ipsas_prep_context(uuid,integer) TO anon; END IF;
    END$$; CREATE EVENT TRIGGER ipsas_transport_widen ON ddl_command_end WHEN TAG IN ('GRANT') EXECUTE FUNCTION public.ipsas_transport_widen()`);
    try { await refusal(renderApply(0), "PRIVILEGE_POSTCONDITION"); } finally { await db.admin.query("DROP EVENT TRIGGER ipsas_transport_widen; DROP FUNCTION public.ipsas_transport_widen()"); }
    await notInstalled(); assert.equal(await consumed(), 0); assert.deepEqual(await snapshot(), before);
  });
  // The reference: the exact source executed directly in a fresh session inside a transaction that is rolled back (DDL is transactional).
  const GRANT_SOURCE = BATCHES[0].source;
  let reference;
  { const c = await db.pool.connect();
    try { await c.query("BEGIN"); try { await c.query(migrationText(GRANT_SOURCE)); reference = await catalog(c, { inTx: true }); } finally { await c.query("ROLLBACK"); } } finally { c.release(); } }
  await notInstalled();
  await kase("apply.binding-independent-of-session-search-path", async () => {
    // The source has unqualified names (DEFAULT gen_random_uuid()). Control first: in this chain pgcrypto is installed in public, so the
    // ambiguity is real - the SOURCE run directly under a path that lists public before pg_catalog binds the public function.
    assert((await row("SELECT to_regprocedure('public.gen_random_uuid()') IS NOT NULL v")).v, "the chain provides a public.gen_random_uuid()");
    const run = async (searchPath, sql) => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); await c.query(`SET LOCAL search_path TO ${searchPath}`); await c.query(sql); return await catalog(c, { inTx: true }); }
      finally { try { await c.query("ROLLBACK"); } catch { /* */ } c.release(); }
    };
    const unpinned = await run("public, pg_catalog", migrationText(GRANT_SOURCE));
    assert(unpinned.facts.some((f) => f.startsWith("bind:") && f.endsWith("public.gen_random_uuid")), "control: the unpinned direct run bound the public function");
    assert.notEqual(unpinned.d, reference.d);
    assert(reference.facts.filter((f) => f.startsWith("bind:")).length >= 2 && reference.facts.filter((f) => f.startsWith("bind:")).every((f) => f.endsWith("pg_catalog-pinned")), "the default-session reference binds the core function");
    // The transport's apply pins the path for the source: whatever the migrator's session path, the result is the core binding.
    for (const searchPath of ['"$user", public', "public, pg_catalog", "pg_catalog, public", "public", "extensions, public"]) {
      const installed = await run(searchPath, renderApply(0));
      assert.deepEqual(installed.facts.filter((f) => f.startsWith("bind:")), reference.facts.filter((f) => f.startsWith("bind:")), `binding under ${searchPath}`);
      assert.equal(installed.d, reference.d, `catalogue under ${searchPath}`);
    }
    await notInstalled();
  });
  await kase("apply.concurrent-installed-exactly-once", async () => {
    const clients = await Promise.all([db.pool.connect(), db.pool.connect()]);
    try {
      const attempts = await Promise.allSettled(clients.map((c) => entry(c, 1)));
      assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1); assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
    } finally { clients.forEach((c) => c.release()); }
    assert((await row("SELECT to_regclass('public.ipsas_prep_revisions') IS NOT NULL AND to_regclass('public.ipsas_confirmations') IS NOT NULL v")).v);
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.transport_events WHERE event='applied'`)).n, 1);
    assert.equal(await consumed(), 1);
  });
  await kase("apply.duplicate-refused", () => refusal(renderApply(0), "WRONG_PREDECESSOR"));
  await kase("installed.equals-direct-application", async () => {
    const readClient = await db.pool.connect(); let installed; try { installed = await catalog(readClient); } finally { readClient.release(); }
    assert(reference.n >= 60, `the catalogue digest must cover the whole migration (${reference.n} facts)`);
    const only = (a, b) => a.facts.filter((x) => !b.facts.includes(x));
    assert.deepEqual({ onlyTransport: only(installed, reference), onlyDirect: only(reference, installed) }, { onlyTransport: [], onlyDirect: [] }, "the transport installed exactly what the migration creates when executed directly");
    assert.equal(installed.d, reference.d);
  });
  await kase("installed.authority-matrix-and-framework-gate", async () => {
    for (const role of ["anon", "service_role"]) assert.equal((await row("SELECT has_function_privilege($1,'public.ipsas_prep_context(uuid,integer)','EXECUTE') v", [role])).v, false);
    assert.equal((await row("SELECT has_function_privilege('authenticated','public.ipsas_prep_context(uuid,integer)','EXECUTE') v")).v, true);
    assert.equal((await row("SELECT has_function_privilege('authenticated','public._ipsas_live(uuid,integer)','EXECUTE') v")).v, false);
    const r = (await db.asUser(W.U.owner, "SELECT public.ipsas_prep_context($1,2026) r", [W.A])).r;
    assert.equal(r.outcome, "framework_not_ipsas_accrual", "an IFRS for SMEs company is not served");
  });
  await kase("preservation.actual-records-and-settings", async () => {
    assert.deepEqual(await snapshot(), before);
    for (const t of ["ipsas_prep_revisions", "ipsas_confirmations"]) assert.equal((await row(`SELECT count(*)::int n FROM public.${t}`)).n, 0);
    assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, BOOTSTRAP_PREDECESSOR.id + 2);
  });
  completed = true;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`IPSAS_TRANSPORT: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed`);
  await db?.close(); process.exit(process.exitCode ?? 0);
}
