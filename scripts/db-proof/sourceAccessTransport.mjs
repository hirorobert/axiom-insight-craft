// The exact approved source-access migration (20261211100000) through its transport, on the real predecessor chain (every source migration
// before it) in a disposable loopback database. No hosted credentials, provider calls or application activation. The migration and the
// preceding transports are unchanged.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChainBefore, makeWorld, migrationText, openDatabase, REPO } from "./lib/reportingKit.mjs";
import { BATCHES, BOOTSTRAP_PREDECESSOR, NEW_FUNCTIONS, artifactBytes, renderBootstrap, renderApply, renderStage, transportForms, PRESERVED_TABLES } from "../release/sourceAccessStagedTransport.mjs";
import { CASES, PROOF } from "./sourceAccessTransport.manifest.mjs";
const results = []; const forms = transportForms(); const manifest = fs.readFileSync(new URL("./sourceAccessTransport.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/sourceAccessTransport.present.json");
const SCHEMA = "cfoclose_source_access_release";
const CAP = "manage_source_files";
const TABLE = "trial_balance_source_download_events";
let db, crashed = false, completed = false, crashMessage = null;
async function kase(id, fn) { assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id)); try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); } catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${e.message}` }); throw e; } }
async function refusal(sql, needle, params = []) { let error; try { await db.admin.query(sql, params); } catch (e) { error = e; } assert(error, "expected refusal"); if (needle) assert(String(error.message).includes(needle), String(error.message)); }
const row = async (sql, params = []) => (await db.admin.query(sql, params)).rows[0];
const snapshot = async () => { const out = {}; for (const t of PRESERVED_TABLES) out[t] = (await row(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) v FROM public.${t} t`)).v; return out; };
async function entry(client, index) { await client.query("BEGIN"); try { await client.query(index === 0 ? renderBootstrap() : renderApply(index - 1)); await client.query("INSERT INTO drizzle.__drizzle_migrations(id,hash) VALUES($1,$2)", [BOOTSTRAP_PREDECESSOR.id + 1 + index, forms[index].hashes[0]]); await client.query("COMMIT"); } catch (e) { await client.query("ROLLBACK"); throw e; } }
async function interrupted() { await db.admin.query("BEGIN"); try { await db.admin.query(renderApply(0)); await db.admin.query("SELECT 1/0"); assert.fail("late fault did not throw"); } catch (e) { assert.equal(e.code, "22012"); } finally { await db.admin.query("ROLLBACK"); } }
const notInstalled = async () => assert((await row(`SELECT to_regclass('public.${TABLE}') IS NULL AND ${NEW_FUNCTIONS.map((f) => `to_regprocedure('public.${f}') IS NULL`).join(" AND ")} AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_firm_members_revoke_workspace_grants') v`)).v);
const consumed = async () => (await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts WHERE consumed_at IS NOT NULL`)).n;
const fnNames = NEW_FUNCTIONS.map((f) => `'${f.slice(0, f.indexOf("("))}'`).join(",");
/** One digest over everything the migration creates: columns, defaults, constraints, indexes, triggers (incl. the one on firm_members), policies, RLS, ACLs, functions, comments. */
const CATALOG = `SELECT x FROM (
  SELECT 'rel:'||c.relname||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity||':'||c.relforcerowsecurity||':'||coalesce(obj_description(c.oid,'pg_class'),'') AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname='${TABLE}'
  UNION ALL SELECT 'col:'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||a.attidentity::text||':'||a.attgenerated::text||':'||coalesce(col_description(c.oid,a.attnum),'')
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relname='${TABLE}' AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'con:'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='${TABLE}'
  UNION ALL SELECT 'idx:'||indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='${TABLE}'
  UNION ALL SELECT 'trg:'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND (c.relname='${TABLE}' OR t.tgname='trg_firm_members_revoke_workspace_grants')
  UNION ALL SELECT 'pol:'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename='${TABLE}'
  UNION ALL SELECT 'fn:'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||p.prosecdef||':'||p.provolatile::text||':'||coalesce(p.proacl::text,'')||':'||coalesce(p.proconfig::text,'')||':'||md5(pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (${fnNames})
  UNION ALL SELECT 'bind:'||c.relname||':'||coalesce((SELECT n.nspname||'.'||p.proname FROM pg_depend dp JOIN pg_proc p ON p.oid=dp.refobjid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE dp.classid='pg_attrdef'::regclass AND dp.objid=d.oid AND dp.refclassid='pg_proc'::regclass LIMIT 1),'pg_catalog-pinned')
    FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid WHERE c.relnamespace='public'::regnamespace AND c.relname='${TABLE}'
) q ORDER BY x`;
// Deparsing depends on the search_path of the READING session, and an unqualified name in the migration binds through the search_path of the
// EXECUTING session. Both the reference run and every installation therefore use a fresh pooled session, and both reads run under the same explicit path.
const catalog = async (client, { inTx = false } = {}) => { if (!inTx) await client.query("BEGIN"); let facts; try { await client.query("SET LOCAL search_path TO public"); facts = (await client.query(CATALOG)).rows.map((r) => r.x); } finally { if (!inTx) await client.query("ROLLBACK"); }
  return { d: crypto.createHash("md5").update(facts.join(String.fromCharCode(10))).digest("hex"), n: facts.length, facts }; };
try {
  db = await openDatabase("source_access_transport_proof");
  const FILE = BATCHES[0].source;
  await kase("setup.real-predecessor-chain", async () => {
    assert.equal(await applyChainBefore(db, FILE), null);
    assert((await row("SELECT to_regclass('public.ipsas_presentation_revisions') IS NOT NULL AND to_regprocedure('public.ipsas_statement_review(uuid,integer)') IS NOT NULL v")).v, "the IPSAS statement review migration is part of the predecessor chain");
    assert((await row("SELECT to_regprocedure('public.workspace_authority_basis(uuid,uuid,text)') IS NOT NULL AND to_regprocedure('public._plan_write_lock(uuid)') IS NOT NULL AND to_regprocedure('public.tbu_append_only_guard()') IS NOT NULL v")).v, "the source's prerequisites are part of the predecessor chain");
    assert((await row(`SELECT to_regclass('public.${TABLE}') IS NULL v`)).v, "the source-access objects do not exist yet");
    await db.admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations(id integer PRIMARY KEY,hash text NOT NULL)");
  });
  await kase("bootstrap.wrong-predecessor-refused", () => refusal(renderBootstrap(), "WRONG_PREDECESSOR"));
  await kase("bootstrap.exact-id-and-every-recorded-form-of-97", async () => {
    const forms97 = BOOTSTRAP_PREDECESSOR.hashes; assert.equal(forms97.length, 4);
    assert.equal(new Set(forms97).size, 4, "the four recorded forms of hosted id 97 are distinct");
    assert(forms97.includes("023484a1f9ad9ce298b03ec3f15d76c8df2dec2a9b8675749ef334ab3f8e7c17"), "the hash hosted id 97 actually recorded is accepted");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(96,$1)", [forms97[0]]);
    await refusal(renderBootstrap(), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=96");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(97,'unreviewed')");
    await refusal(renderBootstrap(), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=97");
    for (const h of forms97) {        // each recorded form is accepted at id 97 (rolled back, so the next form starts from the same state)
      await db.admin.query("BEGIN"); try { await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(97,$1)", [h]); await db.admin.query(renderBootstrap()); } finally { await db.admin.query("ROLLBACK"); }
      assert((await row(`SELECT to_regnamespace('${SCHEMA}') IS NULL v`)).v);
    }
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(97,$1)", [forms97[3]]); // the form actually installed on the hosted database
  });
  const W = await makeWorld(db);
  await db.asService("SELECT public.fs_set_company_rollout($1,true,'proof rollout change','proof')", [W.A]); // before the baseline: setup, not a transport effect
  // Existing grants and memberships: an explicit open grant for a member, which the installation must leave exactly as it is.
  const g = (await db.asRole("authenticated", W.U.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [W.A, W.U.viewer, CAP]))[0];
  assert.equal(g.outcome, "granted", JSON.stringify(g));
  const before = await snapshot();
  assert.equal(before.workspace_capability_grants.length, 1); assert(before.firm_members.length >= 3);
  assert.equal(before.workspace_capability_grants[0].revoked_at, null);
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
    for (const fn of ["_plan_write_lock(uuid)", "workspace_authority_basis(uuid,uuid,text)", "tbu_append_only_guard()"]) {
      await db.admin.query("BEGIN"); try {
        await db.admin.query(`ALTER FUNCTION public.${fn} RENAME TO prerequisite_gone`);
        await refusal(renderApply(0), "PREREQUISITE_MISSING");
      } finally { await db.admin.query("ROLLBACK"); }
    }
    await notInstalled();
  });
  await kase("apply.unexpected-journal-head-refused", async () => {
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(999,'unreviewed')");
    await refusal(renderApply(0), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=999");
  });
  await kase("apply.any-new-object-present-refused", async () => {
    // Two of the objects are CREATE OR REPLACE'd by the source, so ANY one already existing is an uncertain state, not only all of them.
    const decoys = [
      "CREATE FUNCTION public.firm_members_revoke_workspace_grants() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$",
      "CREATE FUNCTION public.record_trial_balance_source_download_denial(p_user_id uuid, p_company_id uuid, p_upload_id uuid, p_object_sha256 text) RETURNS void LANGUAGE sql AS $$SELECT 1$$",
      `CREATE TABLE public.${TABLE}(id int)`,
    ];
    for (const sql of decoys) {
      await db.admin.query("BEGIN"); try { await db.admin.query(sql); await refusal(renderApply(0), "UNCERTAIN_STATE"); } finally { await db.admin.query("ROLLBACK"); }
    }
    await notInstalled();
  });
  await kase("apply.late-failure-rolls-back", async () => {
    await interrupted(); await notInstalled();
    assert.equal(await consumed(), 0); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.baseline-change-rolls-back", async () => {
    // A deliberately hostile DDL hook in this disposable DB proves preservation is enforced, not just logged.
    await db.admin.query(`CREATE FUNCTION public.source_access_transport_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF to_regclass('public.${TABLE}') IS NOT NULL AND to_regprocedure('public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)') IS NULL THEN UPDATE public.financial_statements_rollout_state SET kill_switch=NOT kill_switch WHERE singleton; END IF;
    END$$; CREATE EVENT TRIGGER source_access_transport_fault ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.source_access_transport_fault()`);
    try { await refusal(renderApply(0), "BASELINE_CHANGED"); } finally { await db.admin.query("DROP EVENT TRIGGER source_access_transport_fault; DROP FUNCTION public.source_access_transport_fault()"); }
    await notInstalled(); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.privilege-postcondition-rolls-back", async () => {
    // A hostile hook that widens a privilege after the migration's own grants: the apply must refuse and roll back.
    await db.admin.query(`CREATE FUNCTION public.source_access_transport_widen() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF to_regprocedure('public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)') IS NOT NULL AND NOT has_function_privilege('anon','public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text)','EXECUTE') THEN GRANT EXECUTE ON FUNCTION public.record_trial_balance_source_download_denial(uuid,uuid,uuid,text) TO anon; END IF;
    END$$; CREATE EVENT TRIGGER source_access_transport_widen ON ddl_command_end WHEN TAG IN ('GRANT') EXECUTE FUNCTION public.source_access_transport_widen()`);
    try { await refusal(renderApply(0), "PRIVILEGE_POSTCONDITION"); } finally { await db.admin.query("DROP EVENT TRIGGER source_access_transport_widen; DROP FUNCTION public.source_access_transport_widen()"); }
    await notInstalled(); assert.equal(await consumed(), 0); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.search-path-does-not-outlive-the-transaction", async () => {
    // The source contains a SESSION-level SET search_path. Control: with the earlier transport shape (a transaction-local restore) that SET
    // survives the commit on the migrator's connection; the shape used here restores the original path at session level.
    const c = await db.pool.connect();
    try {
      const show = async () => (await c.query("SHOW search_path")).rows[0].search_path;
      const wrapper = (local) => `DO $w$ DECLARE v text := current_setting('search_path'); BEGIN
        PERFORM set_config('search_path','pg_catalog, public', true); EXECUTE 'SET search_path TO public, pg_catalog'; PERFORM set_config('search_path', v, ${local}); END $w$`;
      await c.query("SET search_path TO extensions, public"); const original = await show();
      await c.query("BEGIN"); await c.query(wrapper(true)); await c.query("COMMIT");
      assert.notEqual(await show(), original, "control: a transaction-local restore lets the source's SET outlive the commit");
      await c.query("SET search_path TO extensions, public"); assert.equal(await show(), original);
      await c.query("BEGIN"); await c.query(wrapper(false)); await c.query("COMMIT");
      assert.equal(await show(), original, "a session-level restore leaves the connection's path as it was");
      const text = renderApply(0);
      assert(text.includes("PERFORM set_config('search_path', v_search_path, false);"), "the generated apply restores the path at session level");
      assert(!text.includes("PERFORM set_config('search_path', v_search_path, true);"), "and has no transaction-local restore after the source");
    } finally { try { await c.query("RESET search_path"); } finally { c.release(); } }
  });
  // The reference: the exact source executed directly in a transaction that is rolled back (DDL is transactional), so it is compared
  // with what the transport installs without ever leaving the reference behind.
  let reference;
  const refClient = await db.pool.connect();
  try { await refClient.query("BEGIN"); try { await refClient.query(migrationText(FILE)); reference = await catalog(refClient, { inTx: true }); } finally { await refClient.query("ROLLBACK"); } } finally { refClient.release(); }
  await notInstalled();
  await kase("apply.installs-what-a-direct-run-installs-under-any-session-path", async () => {
    // Unlike the IPSAS sources, this migration has its OWN `SET search_path TO public, pg_catalog` as its first statement, so the transport's
    // pin cannot change how its unqualified DEFAULT gen_random_uuid() binds: the source decides. What the transport must guarantee is that
    // the installation equals a direct application, whatever the migrator's session path. (In this chain pgcrypto is in public, so the
    // source binds that function; recorded here as a fact about the source, not asserted as a property of the transport.)
    assert((await row("SELECT to_regprocedure('public.gen_random_uuid()') IS NOT NULL v")).v, "the chain provides a public.gen_random_uuid()");
    const referenceBind = reference.facts.filter((f) => f.startsWith("bind:"));
    assert(referenceBind.length >= 1, "the digest covers the default binding");
    assert(migrationText(FILE).includes("SET search_path TO public, pg_catalog;"), "the source sets its own search_path");
    const run = async (searchPath, sql) => {
      const c = await db.pool.connect();
      try { await c.query("BEGIN"); await c.query(`SET LOCAL search_path TO ${searchPath}`); await c.query(sql); return await catalog(c, { inTx: true }); }
      finally { try { await c.query("ROLLBACK"); } catch { /* */ } c.release(); }
    };
    for (const searchPath of ['"$user", public', "public, pg_catalog", "pg_catalog, public", "public", "extensions, public"]) {
      const direct = await run(searchPath, migrationText(FILE));
      const installed = await run(searchPath, renderApply(0));
      assert.deepEqual(installed.facts.filter((f) => f.startsWith("bind:")), referenceBind, `binding under ${searchPath}`);
      assert.equal(direct.d, reference.d, `direct application under ${searchPath}`);
      assert.equal(installed.d, reference.d, `catalogue under ${searchPath}`);
    }
    await notInstalled();
  });
  await kase("apply.concurrent-installed-exactly-once", async () => {
    const clients = await Promise.all([db.pool.connect(), db.pool.connect()]);
    try {
      await Promise.all(clients.map((c) => c.query("SET search_path TO extensions, public")));
      const attempts = await Promise.allSettled(clients.map((c) => entry(c, 1)));
      assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1); assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
      for (const c of clients) assert.equal((await c.query("SHOW search_path")).rows[0].search_path, "extensions, public", "the real apply left the migrator connection's search_path as it was");
    } finally { for (const c of clients) { try { await c.query("RESET search_path"); } finally { c.release(); } } }
    assert((await row(`SELECT to_regclass('public.${TABLE}') IS NOT NULL v`)).v);
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.transport_events WHERE event='applied'`)).n, 1);
    assert.equal(await consumed(), 1);
  });
  await kase("apply.duplicate-refused", () => refusal(renderApply(0), "WRONG_PREDECESSOR"));
  await kase("installed.equals-direct-application", async () => {
    const readClient = await db.pool.connect(); let installed; try { installed = await catalog(readClient); } finally { readClient.release(); }
    assert(reference.n >= 25, `the catalogue digest must cover the whole migration (${reference.n} facts)`);
    assert(reference.facts.some((f) => f.startsWith("trg:") && f.includes("firm_members")), "the digest covers the trigger on firm_members");
    assert(reference.facts.some((f) => f.startsWith("pol:")), "the digest covers the owner-read policy");
    const only = (a, b) => a.facts.filter((x) => !b.facts.includes(x));
    assert.deepEqual({ onlyTransport: only(installed, reference), onlyDirect: only(reference, installed) }, { onlyTransport: [], onlyDirect: [] }, "the transport installed exactly what the migration creates when executed directly");
    assert.equal(installed.d, reference.d);
  });
  await kase("installed.authority-matrix", async () => {
    const decide = "decide_trial_balance_source_download_issuance(uuid,uuid,uuid,timestamptz,timestamptz,integer,timestamptz,integer,text)", record = "record_trial_balance_source_download_denial(uuid,uuid,uuid,text)";
    for (const role of ["anon", "authenticated"]) for (const f of [decide, record]) assert.equal((await row(`SELECT has_function_privilege($1,'public.${f}','EXECUTE') v`, [role])).v, false, `${role} ${f}`);
    for (const f of [decide, record]) assert.equal((await row(`SELECT has_function_privilege('service_role','public.${f}','EXECUTE') v`)).v, true, f);
    for (const role of ["anon", "authenticated", "service_role"]) for (const f of ["firm_members_revoke_workspace_grants()", "trial_balance_source_download_events_no_truncate()"]) assert.equal((await row(`SELECT has_function_privilege($1,'public.${f}','EXECUTE') v`, [role])).v, false, `${role} ${f}`);
    for (const role of ["authenticated", "service_role"]) {
      assert.equal((await row(`SELECT has_table_privilege($1,'public.${TABLE}','SELECT') v`, [role])).v, true, `${role} reads`);
      for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal((await row(`SELECT has_table_privilege($1,'public.${TABLE}','${p}') v`, [role])).v, false, `${role} ${p}`);
    }
    assert.equal((await row(`SELECT has_table_privilege('anon','public.${TABLE}','SELECT') v`)).v, false);
    assert((await row(`SELECT relrowsecurity v FROM pg_class WHERE oid='public.${TABLE}'::regclass`)).v);
  });
  await kase("preservation.actual-records-grants-and-memberships", async () => {
    assert.deepEqual(await snapshot(), before);
    assert.equal((await row("SELECT revoked_at FROM public.workspace_capability_grants")).revoked_at, null, "the existing grant stayed open");
    assert.equal((await row(`SELECT count(*)::int n FROM public.${TABLE}`)).n, 0);
    assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, BOOTSTRAP_PREDECESSOR.id + 2);
  });
  await kase("installed.removal-trigger-works-after-transport", async () => {
    // Last, because it changes the preserved state on purpose: removing the member now ends that member's explicit grant in the same transaction.
    await db.admin.query("DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [W.A, W.U.viewer]);
    const r = await row("SELECT revoked_at FROM public.workspace_capability_grants WHERE grantee_user_id=$1 AND company_id=$2", [W.U.viewer, W.A]);
    assert(r.revoked_at, "the grant was revoked by the removal");
    assert.equal(Number((await row("SELECT count(*) n FROM public.workspace_capability_grant_events WHERE grantee_user_id=$1 AND action='revoke' AND outcome='applied'", [W.U.viewer])).n), 1);
  });
  completed = true;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`SOURCE_ACCESS_TRANSPORT: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed`);
  await db?.close(); process.exit(process.exitCode ?? 0);
}
