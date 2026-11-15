// The four approved Ready-for-Reporting migrations (20261223100000, 20261224100000, 20261225100000, 20261226100000 — D7–D10) through
// their exact-byte transport, on the ACTUAL hosted order in a disposable loopback database: every source migration before 20261223
// except 20261215100000 (parked: it failed atomically on the hosted migrator, owner decision 2026-11-14), then 20261228100000 (D12,
// hosted id 106, applied before them to admit the third compiler identity), then bootstrap → stage → apply ×4, then 20261227100000
// (D11) directly. No hosted credentials, provider calls or application activation. The migrations and the earlier transports are unchanged.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChainBefore, makeWorld, migrationText, openDatabase, REPO } from "./lib/reportingKit.mjs";
import { BATCHES, BOOTSTRAP_PREDECESSOR, PRESERVED_TABLES, SCHEMA, artifactBytes, renderApply, renderBootstrap, renderStage, transportForms } from "../release/rfrStagedTransport.mjs";
import { CASES, PROOF } from "./rfrTransport.manifest.mjs";

const results = []; const forms = transportForms(); const manifest = fs.readFileSync(new URL("./rfrTransport.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/rfrTransport.present.json");
const PARKED = "20261215100000_api_cache_control_headers.sql";
const D11 = "20261227100000_rfr_prior_pack_basis.sql";
const DIGESTS = ["49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789", "12314dadd6e24dff7a13fa2e0b1dfde5d22905a8d4b97bf91894a8508d1488df", "85a0f3627a9effde61036a422cd0fba5247cf0003af2506882d187982dcd872a"];
const HOSTED_ROWS = [[103, "e943b3f036c94700345ce8843bde9e64f29fdfaf9b702851ff0cc941c3ecb208"], [104, "57687934c3093db66bf2bd4d45e5155ef8c5fb05d22a382a9664e9efe952eb16"], [105, "779ba3908142e037a5cc73e95348af33987bbe11e5c08a3ea2f3fdfdbf2c557c"]];
let db, crashed = false, completed = false, crashMessage = null;
async function kase(id, fn) { assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id)); try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); } catch (e) { results.push({ id, outcome: "fail", error: String(e.message ?? e).slice(0, 800) }); console.log("FAIL", id, "—", String(e.message ?? e).split("\n")[0]); process.exitCode = 1; } }
async function refusal(sql, needle, params = [], client = null) { let error; try { await (client ?? db.admin).query(sql, params); } catch (e) { error = e; } assert(error, "expected refusal"); if (needle) assert(String(error.message).includes(needle), `expected ${needle}, got ${error.code}: ${String(error.message).split("\n")[0]}`); return error; }
const row = async (sql, params = []) => (await db.admin.query(sql, params)).rows[0];
const rowJson = (t) => (t === "account_mappings" ? "(to_jsonb(t) - 'is_contra_account')" : "to_jsonb(t)");
const snapshot = async () => { const out = {}; for (const t of PRESERVED_TABLES) out[t] = (await row(`SELECT coalesce(jsonb_agg(${rowJson(t)} ORDER BY ${rowJson(t)}::text),'[]'::jsonb) v FROM public.${t} t`)).v; return out; };
async function entry(client, index) { await client.query("BEGIN"); try { await client.query(index === 0 ? renderBootstrap() : renderApply(index - 1)); await client.query("INSERT INTO drizzle.__drizzle_migrations(id,hash) VALUES($1,$2)", [BOOTSTRAP_PREDECESSOR.id + index + 1, forms[index].hashes[0]]); await client.query("COMMIT"); } catch (e) { await client.query("ROLLBACK"); throw e; } }
async function interrupted(index) { await db.admin.query("BEGIN"); try { await db.admin.query(renderApply(index)); await db.admin.query("SELECT 1/0"); assert.fail("late fault did not throw"); } catch (e) { assert.equal(e.code, "22012"); } finally { await db.admin.query("ROLLBACK"); } }
const present = async (index) => (await row(`SELECT (${BATCHES[index].anyPresent}) v`)).v === true;
const installed = async (index) => (await row(`SELECT (${BATCHES[index].installed}) v`)).v === true;
const notInstalled = async (index) => assert.equal(await present(index), false, `${BATCHES[index].batch} must not be present`);
const consumed = async () => (await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts WHERE consumed_at IS NOT NULL`)).n;
const compilerPin = async () => (await row(`SELECT (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.fs_server_compilations'::regclass AND c.conname = 'fs_server_compilations_compiler_sha256_check') || ':' || md5(pg_get_functiondef('public.fs_record_server_compilation(uuid,uuid,text,integer,text,text,jsonb,jsonb,jsonb,text)'::regprocedure)) v`)).v;
const q = (xs) => `ARRAY[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")}]::text[]`;
/** One digest over everything a batch creates or re-creates: relations, columns, constraints, indexes, triggers, policies, RLS, ACLs, functions. */
const catalogSql = (b) => { const tables = b.batch === "rfr-2" ? ["account_mappings"] : b.tables; const fns = b.batch === "rfr-2"
  ? ["resolve_account_review_batch", "close_review_refresh_findings", "account_mapping_content", "account_review_decision_content", "account_mappings_provenance_guard"]
  : [...new Set([...b.functions.map((f) => f.slice(0, f.indexOf("("))), "fs_publication_blockers"])];
  return `SELECT x FROM (
  SELECT 'rel:'||c.relname||':'||c.relkind::text||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity||':'||c.relforcerowsecurity||':'||coalesce(obj_description(c.oid,'pg_class'),'') AS x FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY(${q(tables)})
  UNION ALL SELECT 'col:'||c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||coalesce(a.attacl::text,'')||':'||coalesce(col_description(a.attrelid,a.attnum),'')
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY(${q(tables)}) AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'con:'||c.relname||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY(${q(tables)})
  UNION ALL SELECT 'idx:'||indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = ANY(${q(tables)})
  UNION ALL SELECT 'trg:'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal AND c.relname = ANY(${q(tables)})
  UNION ALL SELECT 'pol:'||tablename||':'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename = ANY(${q(tables)})
  UNION ALL SELECT 'fn:'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||p.prosecdef||':'||p.provolatile::text||':'||coalesce(p.proacl::text,'')||':'||coalesce(p.proconfig::text,'')||':'||md5(pg_get_functiondef(p.oid))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY(${q(fns)})
) q ORDER BY x`; };
// Deparsing depends on the search_path of the READING session; every read runs under the same explicit path in a fresh pooled session.
const catalog = async (client, b, { inTx = false } = {}) => { if (!inTx) await client.query("BEGIN"); let facts; try { await client.query("SET LOCAL search_path TO public"); facts = (await client.query(catalogSql(b))).rows.map((r) => r.x); } finally { if (!inTx) await client.query("ROLLBACK"); }
  return { d: crypto.createHash("md5").update(facts.join(String.fromCharCode(10))).digest("hex"), n: facts.length, facts }; };
/** The reference for a batch: the exact source executed directly in a transaction that is rolled back (DDL is transactional). */
async function reference(b) { const c = await db.pool.connect(); try { await c.query("BEGIN"); try { await c.query("SET LOCAL search_path TO public"); await c.query(migrationText(b.source)); return await catalog(c, b, { inTx: true }); } finally { await c.query("ROLLBACK"); } } finally { c.release(); } }
async function installedEqualsDirect(index, ref) {
  const b = BATCHES[index]; const readClient = await db.pool.connect(); let got; try { got = await catalog(readClient, b); } finally { readClient.release(); }
  assert(ref.n >= 8, `${b.batch}: the catalogue digest must cover the whole migration (${ref.n} facts)`);
  const only = (x, y) => x.facts.filter((f) => !y.facts.includes(f));
  assert.deepEqual({ onlyTransport: only(got, ref), onlyDirect: only(ref, got) }, { onlyTransport: [], onlyDirect: [] }, `${b.batch}: the transport installed exactly what the migration creates when executed directly`);
  assert.equal(got.d, ref.d);
}
let before, pinBefore;
try {
  db = await openDatabase("rfr_transport_proof");
  await kase("setup.actual-hosted-order", async () => {
    assert.equal(await applyChainBefore(db, BATCHES[0].source, { skip: [PARKED] }), null);
    assert((await row("SELECT to_regprocedure('public.api_cache_control_pre_request()') IS NULL v")).v, "the parked 20261215100000 is not part of the hosted order");
    const con = (await row("SELECT pg_get_constraintdef(c.oid) v FROM pg_constraint c WHERE c.conrelid='public.fs_server_compilations'::regclass AND c.conname='fs_server_compilations_compiler_sha256_check'")).v;
    for (const d of DIGESTS) assert(con.includes(d), `D12 (20261228100000) is applied before the four: the CHECK admits ${d.slice(0, 8)}`);
    assert((await row("SELECT position('_fs_first_period_pending' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0 AND position('_rfr_blockers' IN pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure)) = 0 v")).v, "no splice of the four is present yet");
    for (let i = 0; i < BATCHES.length; i++) await notInstalled(i);
    for (const t of PRESERVED_TABLES) assert((await row(`SELECT to_regclass('public.${t}') IS NOT NULL v`)).v, `preserved table ${t} exists at this point of the chain`);
    await db.admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations(id integer PRIMARY KEY,hash text NOT NULL)");
    for (const [id, hash] of HOSTED_ROWS) await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES($1,$2)", [id, hash]); // the hosted rows 103–105 (D4–D6), as recorded
  });
  await kase("bootstrap.wrong-predecessor-refused", () => refusal(renderBootstrap(), "WRONG_PREDECESSOR"));
  await kase("bootstrap.exact-id-and-both-recorded-forms-of-106", async () => {
    const forms106 = BOOTSTRAP_PREDECESSOR.hashes; assert.equal(forms106.length, 2); assert.equal(new Set(forms106).size, 2);
    assert.equal(forms106[0], "f319b4600a013871c0c734ef4e5a7451becfada0787f88f4a5ca40a80d420294", "the hash hosted id 106 actually recorded (Lovable's mirror 0105 of D12)");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(106,'unreviewed')");
    await refusal(renderBootstrap(), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=106");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(107,$1)", [forms106[0]]); // right hash at the wrong id
    await refusal(renderBootstrap(), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=107");
    for (const h of forms106) {        // each recorded form is accepted at id 106 (rolled back, so the next form starts from the same state)
      await db.admin.query("BEGIN"); try { await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(106,$1)", [h]); await db.admin.query(renderBootstrap()); } finally { await db.admin.query("ROLLBACK"); }
      assert((await row(`SELECT to_regnamespace('${SCHEMA}') IS NULL v`)).v);
    }
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(106,$1)", [forms106[0]]); // the form actually installed on the hosted database
  });
  const W = await makeWorld(db);
  await db.asService("SELECT public.fs_set_company_rollout($1,true,'proof rollout change','proof')", [W.A]); // before the baseline: setup, not a transport effect
  before = await snapshot(); pinBefore = await compilerPin();
  assert.equal(before.financial_statements_rollout_companies.length, 1); assert(before.firm_members.length >= 3);
  await kase("bootstrap.private-install", async () => { await entry(db.admin, 0); assert((await row(`SELECT to_regnamespace('${SCHEMA}') IS NOT NULL v`)).v); assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, 107); });
  await kase("bootstrap.existing-schema-refused", () => refusal(renderBootstrap(), "WRONG_PREDECESSOR"));
  await kase("stage.client-roles-denied", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal((await row("SELECT has_schema_privilege($1,'" + SCHEMA + "','USAGE') v", [role])).v, false);
      let error; try { await db.asRole(role, null, `SELECT * FROM ${SCHEMA}.staged_artifacts`); } catch (e) { error = e; } assert.equal(error?.code, "42501");
      error = undefined; try { await db.asRole(role, null, `INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES('rfr-1','source','SELECT 1')`); } catch (e) { error = e; } assert.equal(error?.code, "42501");
      assert.equal((await row("SELECT has_sequence_privilege($1,'" + SCHEMA + ".transport_events_seq_seq','USAGE') v", [role])).v, false);
    }
  });
  await kase("apply.missing-stage-refused", () => refusal(renderApply(0), "UNCERTAIN_STAGE"));
  await kase("stage.truncated-body-refused", async () => {
    const full = artifactBytes(0, "source").toString("utf8");
    await refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES($1,'source',$2)`, "STAGE_REFUSED", [BATCHES[0].batch, full.slice(0, full.length - 100)]);
    await refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES($1,'source',$2)`, "STAGE_REFUSED", [BATCHES[0].batch, full.slice(0, 22000)]); // what the migrator could carry
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts`)).n, 0);
  });
  await kase("stage.one-byte-tamper-refused", async () => {
    for (let i = 0; i < BATCHES.length; i++) await refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES($1,'source',$2)`, "STAGE_REFUSED", [BATCHES[i].batch, artifactBytes(i, "source").toString("utf8") + " "]);
    await refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES($1,'source',$2)`, "STAGE_REFUSED", [BATCHES[1].batch, artifactBytes(0, "source").toString("utf8")]); // the right body under the wrong batch
  });
  await kase("stage.unknown-artifact-refused", () => refusal(`INSERT INTO ${SCHEMA}.staged_artifacts(batch,kind,body) VALUES('unreviewed','source','SELECT 1')`, "STAGE_REFUSED"));
  await kase("stage.exact-sources-inert", async () => {
    for (let i = 0; i < BATCHES.length; i++) await db.admin.query(renderStage(i, "source"));
    for (let i = 0; i < BATCHES.length; i++) await notInstalled(i);
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.staged_artifacts WHERE consumed_at IS NULL`)).n, 4);
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.transport_events WHERE event='staged'`)).n, 4);
    assert.deepEqual(await snapshot(), before); assert.equal(await compilerPin(), pinBefore);
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
      await db.admin.query(`UPDATE ${SCHEMA}.staged_artifacts SET body=replace(body,'RAISE','raise') WHERE batch=$1`, [BATCHES[0].batch]); // same length, different bytes
      await refusal(renderApply(0), "STAGE_MISSING_OR_MODIFIED");
    } finally { await db.admin.query("ROLLBACK"); }
  });
  await kase("apply.wrong-length-rejected-at-rehash", async () => {
    await db.admin.query("BEGIN"); try {
      await db.admin.query(`ALTER TABLE ${SCHEMA}.staged_artifacts DISABLE TRIGGER trg_staged_artifacts_guard`);
      await db.admin.query(`UPDATE ${SCHEMA}.staged_artifacts SET body=left(body, length(body)-1), body_bytes=body_bytes-1 WHERE batch=$1`, [BATCHES[0].batch]);
      await refusal(renderApply(0), "STAGE_MISSING_OR_MODIFIED");
    } finally { await db.admin.query("ROLLBACK"); }
    await notInstalled(0);
  });
  await kase("apply.out-of-order-refused", async () => {
    // rfr-2 before rfr-1: its predecessor row is absent → refused; a journal row alone (no consumed rfr-1) is refused as well.
    await refusal(renderApply(1), "WRONG_PREDECESSOR");
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(108,$1)", [forms[1].hashes[0]]);
    try { await refusal(renderApply(1), "PRIOR_NOT_APPLIED"); } finally { await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=108"); }
    await notInstalled(1); assert.equal(await consumed(), 0);
  });
  await kase("apply.prerequisite-missing-refused", async () => {
    for (const fn of ["_fs_scope_lock(uuid, integer)", "fs_first_period_declared(uuid, integer)", "close_review_readable(uuid)"]) {
      await db.admin.query("BEGIN"); try {
        await db.admin.query(`ALTER FUNCTION public.${fn} RENAME TO prerequisite_gone`);
        await refusal(renderApply(0), "PREREQUISITE_MISSING");
      } finally { await db.admin.query("ROLLBACK"); }
    }
    await notInstalled(0);
  });
  await kase("apply.unexpected-journal-head-refused", async () => {
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(999,'unreviewed')");
    await refusal(renderApply(0), "WRONG_PREDECESSOR"); await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=999");
  });
  await kase("apply.any-new-object-present-refused", async () => {
    const decoys = [
      "CREATE TABLE public.fs_first_period_claims(id int)",
      "CREATE FUNCTION public._fs_first_period_assess(p_company_id uuid, p_period_year integer) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$",
    ];
    for (const sql of decoys) {
      await db.admin.query("BEGIN"); try { await db.admin.query(sql); await refusal(renderApply(0), "UNCERTAIN_STATE"); } finally { await db.admin.query("ROLLBACK"); }
    }
    await notInstalled(0);
  });
  await kase("apply.client-roles-cannot-execute", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      let error; try { await db.asRole(role, null, renderApply(0)); } catch (e) { error = e; } assert(error, `${role} must not be able to run the apply`);
      assert.equal(error.code, "42501", `${role}: ${error.message.split("\n")[0]}`);
    }
    await notInstalled(0); assert.equal(await consumed(), 0);
  });
  await kase("apply.late-failure-rolls-back", async () => {
    await interrupted(0); await notInstalled(0);
    assert.equal(await consumed(), 0); assert.deepEqual(await snapshot(), before); assert.equal(await compilerPin(), pinBefore);
    assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, 107);
  });
  await kase("apply.baseline-change-rolls-back", async () => {
    // A deliberately hostile DDL hook in this disposable DB proves preservation is enforced, not just logged.
    await db.admin.query(`CREATE FUNCTION public.rfr_transport_fault() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF coalesce(current_setting('${SCHEMA}.applying', true), '') = 'rfr-1' THEN UPDATE public.financial_statements_rollout_state SET kill_switch=NOT kill_switch WHERE singleton; END IF;
    END$$; CREATE EVENT TRIGGER rfr_transport_fault ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.rfr_transport_fault()`);
    try { await refusal(renderApply(0), "BASELINE_CHANGED"); } finally { await db.admin.query("DROP EVENT TRIGGER rfr_transport_fault; DROP FUNCTION public.rfr_transport_fault()"); }
    await notInstalled(0); assert.deepEqual(await snapshot(), before);
  });
  await kase("apply.compiler-identity-change-rolls-back", async () => {
    // A hostile hook that narrows the compiler identity while the source installs: the apply must refuse and roll back.
    await db.admin.query(`CREATE FUNCTION public.rfr_transport_narrow() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN
      IF coalesce(current_setting('${SCHEMA}.applying', true), '') = 'rfr-1' THEN
        ALTER TABLE public.fs_server_compilations DROP CONSTRAINT fs_server_compilations_compiler_sha256_check;
        ALTER TABLE public.fs_server_compilations ADD CONSTRAINT fs_server_compilations_compiler_sha256_check CHECK (compiler_sha256 = '${DIGESTS[0]}');
      END IF;
    END$$; CREATE EVENT TRIGGER rfr_transport_narrow ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.rfr_transport_narrow()`);
    try { await refusal(renderApply(0), "COMPILER_IDENTITY_CHANGED"); } finally { await db.admin.query("DROP EVENT TRIGGER rfr_transport_narrow; DROP FUNCTION public.rfr_transport_narrow()"); }
    await notInstalled(0); assert.equal(await compilerPin(), pinBefore); assert.equal(await consumed(), 0);
  });
  await kase("apply.search-path-does-not-outlive-the-transaction", async () => {
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
      for (let i = 0; i < BATCHES.length; i++) { const text = renderApply(i); assert(text.includes("PERFORM set_config('search_path', v_search_path, false);")); assert(!text.includes("PERFORM set_config('search_path', v_search_path, true);")); }
    } finally { try { await c.query("RESET search_path"); } finally { c.release(); } }
  });
  const ref1 = await reference(BATCHES[0]); await notInstalled(0);
  await kase("apply.rfr-1.concurrent-installed-exactly-once", async () => {
    const clients = await Promise.all([db.pool.connect(), db.pool.connect()]);
    try {
      await Promise.all(clients.map((c) => c.query("SET search_path TO extensions, public")));
      const attempts = await Promise.allSettled(clients.map((c) => entry(c, 1)));
      assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1, JSON.stringify(attempts.map((a) => a.reason?.message?.split("\n")[0] ?? "ok")));
      assert.equal(attempts.filter((x) => x.status === "rejected").length, 1);
      for (const c of clients) assert.equal((await c.query("SHOW search_path")).rows[0].search_path, "extensions, public", "the real apply left the migrator connection's search_path as it was");
    } finally { for (const c of clients) { try { await c.query("RESET search_path"); } finally { c.release(); } } }
    assert(await installed(0));
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.transport_events WHERE event='applied'`)).n, 1);
    assert.equal(await consumed(), 1);
    assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, 108);
  });
  await kase("apply.rfr-1.replay-refused", async () => {
    await refusal(renderApply(0), "WRONG_PREDECESSOR");                       // the journal moved on
    await db.admin.query("DELETE FROM drizzle.__drizzle_migrations WHERE id=108");
    try { await refusal(renderApply(0), "ALREADY_APPLIED"); }                  // even with the journal rewound, the consumed stage refuses
    finally { await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(108,$1)", [forms[1].hashes[0]]); }
    assert.equal((await row(`SELECT count(*)::int n FROM ${SCHEMA}.transport_events WHERE event='applied'`)).n, 1);
  });
  await kase("apply.rfr-1.equals-direct-application", () => installedEqualsDirect(0, ref1));
  for (const i of [1, 2, 3]) {
    await kase(`apply.rfr-${i + 1}.installed-and-equals-direct-application`, async () => {
      await notInstalled(i);
      const ref = await reference(BATCHES[i]); await notInstalled(i);
      await interrupted(i); await notInstalled(i); assert.equal(await consumed(), i); // a late fault leaves nothing behind
      await entry(db.admin, i + 1);
      assert(await installed(i)); assert.equal(await consumed(), i + 1);
      assert.equal((await row("SELECT max(id) n FROM drizzle.__drizzle_migrations")).n, 108 + i);
      await installedEqualsDirect(i, ref);
      await refusal(renderApply(i), "WRONG_PREDECESSOR");
    });
  }
  await kase("after.d11-applies-directly", async () => {
    await db.admin.query(migrationText(D11));
    await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES(112,$1)", [crypto.createHash("sha256").update(migrationText(D11), "utf8").digest("hex")]);
    assert((await row("SELECT to_regprocedure('public.rfr_import_prior_pack(uuid, integer, uuid)') IS NOT NULL v")).v, "D11 installed its function after the transport");
  });
  await kase("after.compiler-identity-unchanged", async () => {
    assert.equal(await compilerPin(), pinBefore);
    const con = (await row("SELECT pg_get_constraintdef(c.oid) v FROM pg_constraint c WHERE c.conrelid='public.fs_server_compilations'::regclass AND c.conname='fs_server_compilations_compiler_sha256_check'")).v;
    for (const d of DIGESTS) assert(con.includes(d));
    assert.equal((await row("SELECT count(*)::int n FROM public.fs_server_compilations")).n, before.fs_server_compilations.length);
  });
  await kase("after.preserved-records-unchanged", async () => {
    assert.deepEqual(await snapshot(), before);
    assert.equal((await row("SELECT count(*)::int n FROM public.account_mappings WHERE is_contra_account IS NOT NULL")).n, 0, "no contra designation was back-filled");
    assert.equal((await row("SELECT count(*)::int n FROM public.financial_statements_rollout_companies")).n, 1, "the pilot allow-list is unchanged");
  });
  await kase("after.journal-and-provenance-consistent", async () => {
    const ev = (await db.admin.query(`SELECT batch, detail FROM ${SCHEMA}.transport_events WHERE event='applied' ORDER BY seq`)).rows;
    assert.deepEqual(ev.map((e) => e.batch), BATCHES.map((b) => b.batch));
    ev.forEach((e, i) => { assert.equal(e.detail.source, BATCHES[i].source); assert.equal(e.detail.source_sha256, BATCHES[i].artifacts.source.sha256); assert.equal(Number(e.detail.predecessor_journal_id), 107 + i); });
    assert.equal(await consumed(), 4);
    const j = (await db.admin.query("SELECT id, hash FROM drizzle.__drizzle_migrations WHERE id >= 106 ORDER BY id")).rows;
    assert.deepEqual(j.map((r) => Number(r.id)), [106, 107, 108, 109, 110, 111, 112]);
    assert.deepEqual(j.slice(1, 6).map((r) => r.hash), forms.map((f) => f.hashes[0]), "hosted ids 107–111 are exactly the five registered transport forms");
  });
  await kase("after.installed-authority-matrix", async () => {
    for (const b of BATCHES) {
      for (const t of b.tables) { assert.equal((await row(`SELECT has_table_privilege('anon','public.${t}','SELECT') v`)).v, false, `anon ${t}`); for (const r of ["authenticated", "service_role"]) for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal((await row(`SELECT has_table_privilege($1,'public.${t}','${p}') v`, [r])).v, false, `${r} ${p} ${t}`); assert((await row(`SELECT relrowsecurity v FROM pg_class WHERE oid='public.${t}'::regclass`)).v); }
      for (const f of b.functions) assert.equal((await row(`SELECT has_function_privilege('anon','public.${f}','EXECUTE') v`)).v, false, `anon ${f}`);
    }
    assert.equal((await row("SELECT has_function_privilege('authenticated','public.fs_publication_blockers(uuid, text, integer)','EXECUTE') v")).v, false);
    assert.equal((await row("SELECT has_column_privilege('authenticated','public.account_mappings','is_contra_account','UPDATE') v")).v, false);
  });
  completed = true;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`RFR_TRANSPORT: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed`);
  await db?.close(); process.exit(process.exitCode ?? 0);
}
