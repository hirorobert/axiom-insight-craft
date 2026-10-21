#!/usr/bin/env node
// Real-PostgreSQL proof of the staged release transport (scripts/release/stagedTransport.mjs) on a DISPOSABLE loopback
// database that reproduces production: every source migration except the five staged sources, the PR #34 release objects,
// and the hosted journal 0000–0063 with drizzle's own hashes (scripts/db-proof/lib/releaseBase.mjs).
//
//   T1  drizzle-orm migrate(): bootstrap, staging, then the five batches in the approved order, one migrate() per entry;
//       each journal hash equals the registered one; every postcondition passes; sign-off baseline unchanged
//   T2  hosted-executor model (BEGIN; submission; journal row; COMMIT), journal row both AFTER and BEFORE the statement
//   T3  staging refuses: a changed comment byte, a changed payload byte, truncation, a final LF added, an unknown batch,
//       a duplicate; update / delete / truncate of evidence refused; no client role can see the schema
//   T4  apply refuses, changing nothing (no journal row, no consumption, schema unchanged): missing stage, a stage
//       modified behind the insert check, wrong predecessor (out of order, a foreign journal row), duplicate apply
//   T5  injected failure in the middle of the wrapper and in the postcondition: everything rolled back, stage included;
//       the same entry then applies cleanly
//   T6  two concurrent submissions of the same entry: exactly one applies
//   T7  an extra sign-off binding injected mid-batch: TRANSPORT_SIGNOFF_BASELINE_CHANGED, batch and journal rolled back
//   T1/T7 run over TWO complete sign-off bindings (REVIEWED + FINAL, same lineage) seeded by a disposable-only hook
//
//   DB_PROOF_CONN=postgres://postgres:postgres@localhost:<port>/postgres node scripts/db-proof/stagedTransport.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { releaseServer, Client, Pool, sha256, hostedJournal, REPO } from "./lib/releaseBase.mjs";
import { BATCHES, KINDS, renderBootstrap, renderApply, renderStage, transportForms, BOOTSTRAP_NAME } from "../release/stagedTransport.mjs";

const req = createRequire(import.meta.url);
const { drizzle } = req("drizzle-orm/node-postgres");
const { migrate } = req("drizzle-orm/node-postgres/migrator");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { if (ok) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${detail}`); } };
const group = (g) => console.log(`\n== ${g}`);
const srv = releaseServer("transport");
const EXCLUDE = BATCHES.map((b) => b.source);
const FORMS = transportForms();
const ENTRY = [renderBootstrap(), ...BATCHES.map((_, i) => renderApply(i))];

async function connect(url) { const c = new Client({ connectionString: url, ssl: false }); await c.connect(); return c; }
async function attempt(c, sql) { try { await c.query(sql); return { ok: true }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } }
async function state(c) {
  const j = (await c.query("SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
  const has = (await c.query("SELECT to_regnamespace('cfoclose_release') IS NOT NULL AS s")).rows[0].s;
  const st = has ? (await c.query("SELECT batch, kind, consumed_at IS NOT NULL AS consumed FROM cfoclose_release.staged_artifacts ORDER BY 1,2")).rows : [];
  const ev = has ? (await c.query("SELECT count(*)::int AS n FROM cfoclose_release.transport_events")).rows[0].n : 0;
  const fn = (await c.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`)).rows[0].n;
  const cls = (await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`)).rows[0].n;
  return JSON.stringify({ j, has, st, ev, fn, cls });
}
/** Hosted-executor model: one transaction with the submission and its journal row (after, or before the statement). */
async function hosted(c, text, { rowFirst = false } = {}) {
  await c.query("BEGIN");
  try {
    const ins = () => c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [sha256(Buffer.from(text, "utf8")), Date.now()]);
    if (rowFirst) await ins();
    await c.query(text);
    if (!rowFirst) await ins();
    await c.query("COMMIT");
    return { ok: true };
  } catch (e) { await c.query("ROLLBACK"); return { ok: false, code: e.code, message: e.message }; }
}
/** Complete-row sign-off fingerprint, exactly the transport's (and the primary live baseline's) expression. */
const DIGEST_SQL = "SELECT count(*)::int AS n, encode(sha256(convert_to(coalesce(string_agg(to_jsonb(f)::text, chr(10) ORDER BY f.seq), ''), 'UTF8')), 'hex') AS digest FROM public.fs_publication_bindings f";
async function digest(c) { return (await c.query(DIGEST_SQL)).rows[0]; }
async function existingFunctionPrivileges(c) {
  return JSON.stringify((await c.query("SELECT p.oid, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname <> 'cfoclose_release' ORDER BY p.oid")).rows);
}
/** DISPOSABLE-ONLY fixture hook (test-only, as in s2Authority/billingSuspension): rows written with
 *  session_replication_role = replica, so append-only triggers and parent-row FKs are bypassed. Every column populated. */
async function insertBinding(c, { state: st, report = "fsr-2025-proof", version = 6, doc = "c".repeat(64) }) {
  const cols = (await c.query("SELECT column_name, data_type, is_identity, is_generated FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fs_publication_bindings' ORDER BY ordinal_position")).rows
    .filter((r) => r.is_identity !== "YES" && r.is_generated !== "ALWAYS");
  const fixed = { state: st, report_id: report, report_version: version, document_sha256: doc, declared_content_hash: "d".repeat(64),
    dependencies_sha256: "e".repeat(64), dependencies: { proof: true, state: st }, approver_role: "owner", approver_display_name: `Proof ${st}`,
    signoff_policy: "solo_owner", same_approver: true, approved_at: st === "FINAL" ? "2026-10-09T14:11:46Z" : "2026-10-09T14:11:09Z" };
  const val = (r) => r.column_name in fixed ? fixed[r.column_name]
    : r.data_type === "uuid" ? crypto.randomUUID() : r.data_type === "boolean" ? true : /int|numeric/.test(r.data_type) ? 1
    : /timestamp/.test(r.data_type) ? "2026-10-09T14:00:00Z" : /json/.test(r.data_type) ? { proof: r.column_name } : `proof-${r.column_name}`;
  await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
  try {
    await c.query(`INSERT INTO public.fs_publication_bindings (${cols.map((r) => r.column_name).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map(val));
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
}
async function seedTwoBindings(c) {
  const shared = { report: "fsr-2025-proof", version: 6, doc: "c".repeat(64) };
  await insertBinding(c, { ...shared, state: "REVIEWED" }); await insertBinding(c, { ...shared, state: "FINAL" });
}
async function stageAll(c, batches = BATCHES.map((_, i) => i)) { for (const i of batches) for (const k of KINDS) await c.query(renderStage(i, k)); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "transport-dz-"));
/** A drizzle migrations folder holding the first n transport entries, with `when` after hosted 0063. */
function folder(n) {
  const dir = path.join(tmp, `f${n}`); fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const last = hostedJournal().at(-1).when;
  const entries = FORMS.slice(0, n).map((f, i) => ({ idx: 64 + i, version: "7", when: last + 1000 * (i + 1), tag: `${String(64 + i).padStart(4, "0")}_${f.name}`, breakpoints: true }));
  for (const [i, e] of entries.entries()) fs.writeFileSync(path.join(dir, `${e.tag}.sql`), ENTRY[i]);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  return dir;
}

try {
  await srv.start();
  console.log("building the production-equivalent base (this replays the migration chain)…");
  const base = await srv.buildBase(EXCLUDE);
  console.log(`base: ${base.applied} source migrations, ${base.journalRows} journal rows`);
  const tail = hostedJournal().at(-1);
  check("base journal tail is hosted id 64 / 8122917c…", base.journalRows === 64 && tail.hash === "8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc");

  // ── T1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("T1 drizzle-orm migrate(): bootstrap, stage, five batches in order");
  {
    const url = await srv.copyOf(base.name, "t1");
    const pool = new Pool({ connectionString: url, ssl: false });
    const c = await connect(url);
    try {
      await seedTwoBindings(c);
      const base0 = await digest(c);
      const full = (await c.query("SELECT bool_and(NOT EXISTS (SELECT 1 FROM jsonb_each(to_jsonb(f)) e WHERE e.value = 'null'::jsonb)) AS ok, string_agg(state, ',' ORDER BY seq) AS st, count(DISTINCT report_id || ':' || report_version || ':' || document_sha256)::int AS lin FROM public.fs_publication_bindings f")).rows[0];
      check("fixture: two complete sign-off bindings (REVIEWED, FINAL; same lineage; no NULL field)", base0.n === 2 && full.ok === true && full.st === "REVIEWED,FINAL" && full.lin === 1, JSON.stringify(full));
      const privilegesBefore = await existingFunctionPrivileges(c);
      await migrate(drizzle(pool), { migrationsFolder: folder(1) });
      check("bootstrap leaves every pre-existing function privilege unchanged", (await existingFunctionPrivileges(c)) === privilegesBefore);
      const helpers = ["cfoclose_release.approved_artifact(text,text)", "cfoclose_release.staged_artifacts_guard()", "cfoclose_release.append_only_guard()"];
      for (const role of ["anon", "authenticated", "service_role"]) {
        const denied = await Promise.all(helpers.map(async (fn) => (await c.query("SELECT NOT has_function_privilege($1, $2, 'EXECUTE') AS denied", [role, fn])).rows[0].denied));
        check(`${role}: EXECUTE denied on all three exact new helper signatures`, denied.every(Boolean));
      }
      check("PUBLIC has no EXECUTE on any new helper", (await c.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE n.nspname = 'cfoclose_release' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'")).rows[0].n === 0);
      await stageAll(c);
      for (let i = 0; i < BATCHES.length; i++) {
        await migrate(drizzle(pool), { migrationsFolder: folder(i + 2) });
        const consumed = (await c.query("SELECT count(*)::int AS n FROM cfoclose_release.staged_artifacts WHERE batch = $1 AND consumed_at IS NOT NULL", [BATCHES[i].batch])).rows[0].n;
        check(`${BATCHES[i].batch} applied (preflight, wrapper, postcondition) and consumed`, consumed === 3);
        const d = await digest(c);
        check(`${BATCHES[i].batch}: both complete sign-off rows byte-identical (full-row digest)`, d.n === 2 && d.digest === base0.digest, JSON.stringify(d));
      }
      const j = (await c.query("SELECT id, hash FROM drizzle.__drizzle_migrations WHERE id > 64 ORDER BY id")).rows;
      check("six journal rows 65–70 with exactly the registered hashes", j.length === 6 && j.every((r, i) => r.id === 65 + i && r.hash === FORMS[i].hashes[0]), JSON.stringify(j));
      const ev = (await c.query("SELECT batch, detail FROM cfoclose_release.transport_events WHERE event = 'applied' ORDER BY seq")).rows;
      check("five applied events in the approved order", ev.map((e) => e.batch).join() === BATCHES.map((b) => b.batch).join());
      check("every applied event records the unchanged full-row baseline (2 rows)", ev.every((e) => e.detail.signoffs === 2 && e.detail.signoff_digest === base0.digest));
      // Each batch's postcondition ran inside its own apply, at that batch's state (later batches legitimately supersede
      // earlier contracts); after the release, the LAST batch's postcondition holds read-only.
      const last = BATCHES.at(-1);
      const r = await attempt(c, fs.readFileSync(path.join(REPO, last.postcondition.path), "utf8"));
      check(`${last.batch} postcondition re-run read-only after the whole release: OK`, r.ok, r.message);
    } finally { await c.end(); await pool.end(); }
  }

  // ── T2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const rowFirst of [false, true]) {
    group(`T2 hosted-executor model (journal row ${rowFirst ? "BEFORE" : "AFTER"} the statement)`);
    const url = await srv.copyOf(base.name, `t2${rowFirst ? "b" : "a"}`);
    const c = await connect(url);
    try {
      let r = await hosted(c, ENTRY[0], { rowFirst }); check("bootstrap", r.ok, r.message);
      await stageAll(c);
      for (let i = 0; i < BATCHES.length; i++) { r = await hosted(c, ENTRY[i + 1], { rowFirst }); check(BATCHES[i].batch, r.ok, r.message); }
    } finally { await c.end(); }
  }

  // ── T3–T6 share a bootstrapped copy ─────────────────────────────────────────────────────────────────────────────────
  const boot = await srv.copyOf(base.name, "boot");
  { const c = await connect(boot); await hosted(c, ENTRY[0]); await c.end(); }

  group("T3 staging refuses anything but the exact approved bytes");
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t3");
    const c = await connect(url);
    try {
      const good = renderStage(0, "wrapper");
      const commentAt = good.indexOf("-- CFOClose"), payloadAt = good.indexOf("pack_family");
      const variants = {
        "one comment byte changed": good.slice(0, commentAt + 3) + "c" + good.slice(commentAt + 4),
        "one payload byte changed": good.slice(0, payloadAt) + "P" + good.slice(payloadAt + 1),
        "truncated": good.replace(/\$cfoclose_stage_[0-9a-f]{16}\$\);\n$/, "").slice(0, -200) + good.match(/\$cfoclose_stage_[0-9a-f]{16}\$\);\n$/)[0],
        "a final LF added": good.replace(/(\$cfoclose_stage_[0-9a-f]{16}\$\);\n)$/, "\n$1"),
        "staged under another batch": good.replace("'fs-controls-r1', 'wrapper'", "'fs-journey-r1', 'wrapper'"),
        "an unknown batch": good.replace("'fs-controls-r1', 'wrapper'", "'fs-other-r1', 'wrapper'"),
        "pre-consumed": good.replace("(batch, kind, body) VALUES ('fs-controls-r1', 'wrapper', ", "(batch, kind, consumed_at, body) VALUES ('fs-controls-r1', 'wrapper', now(), "),
      };
      for (const [label, sql] of Object.entries(variants)) { const r = await attempt(c, sql); check(`refused: ${label}`, !r.ok && /TRANSPORT_STAGE_REFUSED|null value|violates/.test(r.message), r.message); }
      check("nothing was staged by the refused attempts", (await c.query("SELECT count(*)::int AS n FROM cfoclose_release.staged_artifacts")).rows[0].n === 0);
      let r = await attempt(c, good); check("the exact committed bytes stage", r.ok, r.message);
      r = await attempt(c, good); check("a duplicate stage is refused", !r.ok && r.code === "23505", r.message);
      r = await attempt(c, "UPDATE cfoclose_release.staged_artifacts SET body = body || ' '"); check("update of a staged body refused", !r.ok && /IMMUTABLE/.test(r.message));
      r = await attempt(c, "UPDATE cfoclose_release.staged_artifacts SET consumed_at = now()"); check("consumption outside an apply refused", !r.ok && /IMMUTABLE/.test(r.message));
      r = await attempt(c, "DELETE FROM cfoclose_release.staged_artifacts"); check("delete refused", !r.ok && /IMMUTABLE/.test(r.message));
      r = await attempt(c, "TRUNCATE cfoclose_release.staged_artifacts"); check("truncate refused", !r.ok && /IMMUTABLE/.test(r.message));
      r = await attempt(c, "UPDATE cfoclose_release.transport_events SET event = 'applied'"); check("event update refused", !r.ok && /IMMUTABLE/.test(r.message));
      r = await attempt(c, "DELETE FROM cfoclose_release.transport_events"); check("event delete refused", !r.ok && /IMMUTABLE/.test(r.message));
      for (const role of ["anon", "authenticated", "service_role"]) {
        await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
        const s = await attempt(c, "SELECT 1 FROM cfoclose_release.staged_artifacts"); await c.query("ROLLBACK");
        await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
        const f = await attempt(c, "SELECT cfoclose_release.approved_artifact('fs-controls-r1', 'wrapper')"); await c.query("ROLLBACK");
        check(`${role} can neither read the stage nor call a transport function`, !s.ok && s.code === "42501" && !f.ok && f.code === "42501", `${s.message} / ${f.message}`);
      }
      const rls = (await c.query("SELECT bool_and(relrowsecurity) AS r FROM pg_class WHERE relnamespace = 'cfoclose_release'::regnamespace AND relkind = 'r'")).rows[0].r;
      check("RLS is on for both release tables", rls === true);
    } finally { await c.end(); }
  }

  group("T4 apply refusals change nothing");
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t4");
    const c = await connect(url);
    try {
      const refusedUnchanged = async (label, text, re) => { const before = await state(c); const r = await hosted(c, text); check(`${label}: refused`, !r.ok && re.test(r.message), r.message); check(`${label}: nothing changed`, (await state(c)) === before); };
      await refusedUnchanged("missing stage", ENTRY[1], /TRANSPORT_STAGE_MISSING_OR_MODIFIED/);
      await c.query(renderStage(0, "preflight")); await c.query(renderStage(0, "postcondition"));
      await refusedUnchanged("wrapper still missing", ENTRY[1], /TRANSPORT_STAGE_MISSING_OR_MODIFIED/);
      // A modified wrapper smuggled past the insert check (trigger disabled by a superuser): the apply's own literals refuse it.
      const good = renderStage(0, "wrapper"); const at = good.indexOf("-- CFOClose");
      await c.query("ALTER TABLE cfoclose_release.staged_artifacts DISABLE TRIGGER trg_staged_artifacts_guard");
      await c.query((good.slice(0, at + 3) + "c" + good.slice(at + 4)).replace("(batch, kind, body) VALUES", "(batch, kind, body_bytes, body_sha256, body) VALUES").replace("'fs-controls-r1', 'wrapper', $", "'fs-controls-r1', 'wrapper', 94858, '7c3c0b0d9cd456f07a88da1c0930fb5e4a9c4bdeead6ea068008eca939470d56', $"));
      await c.query("ALTER TABLE cfoclose_release.staged_artifacts ENABLE TRIGGER trg_staged_artifacts_guard");
      await refusedUnchanged("a wrapper whose comment was modified behind the insert check (recorded identity forged)", ENTRY[1], /TRANSPORT_STAGE_MISSING_OR_MODIFIED/);
      await refusedUnchanged("out of order (journey before controls)", ENTRY[2], /TRANSPORT_WRONG_PREDECESSOR/);
      await refusedUnchanged("bootstrap twice", ENTRY[0], /TRANSPORT_WRONG_PREDECESSOR|TRANSPORT_ALREADY_INSTALLED/);
    } finally { await c.end(); }
  }
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t4b");
    const c = await connect(url);
    try {
      await stageAll(c);
      await c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('foreign', 1)");
      const before = await state(c); const r = await hosted(c, ENTRY[1]);
      check("a foreign journal row after the predecessor: refused", !r.ok && /TRANSPORT_WRONG_PREDECESSOR/.test(r.message), r.message);
      check("a foreign journal row after the predecessor: nothing changed", (await state(c)) === before);
    } finally { await c.end(); }
  }
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t4c");
    const c = await connect(url);
    try {
      await stageAll(c);
      let r = await hosted(c, ENTRY[1]); check("controls applies", r.ok, r.message);
      const before = await state(c); r = await hosted(c, ENTRY[1]);
      check("duplicate apply refused", !r.ok && /TRANSPORT_WRONG_PREDECESSOR|TRANSPORT_ALREADY_APPLIED/.test(r.message), r.message);
      check("duplicate apply changed nothing", (await state(c)) === before);
    } finally { await c.end(); }
  }

  group("T5 injected failures roll everything back, stage state included");
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t5");
    const c = await connect(url);
    try {
      await stageAll(c);
      // Mid-wrapper: refuse the creation of a function the controls migration creates.
      await c.query(`CREATE FUNCTION public._proof_inject() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        DECLARE r record; BEGIN FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.object_identity LIKE 'public.fs_evidence_statements(%' THEN RAISE EXCEPTION 'PROOF_INJECTED_MID_WRAPPER'; END IF; END LOOP; END $f$;
        CREATE EVENT TRIGGER proof_inject ON ddl_command_end EXECUTE FUNCTION public._proof_inject();`);
      let before = await state(c); let r = await hosted(c, ENTRY[1]);
      check("mid-wrapper failure surfaces", !r.ok && /PROOF_INJECTED_MID_WRAPPER/.test(r.message), r.message);
      check("mid-wrapper failure: journal, stage, events and schema unchanged", (await state(c)) === before);
      check("mid-wrapper failure: the migration's objects are absent", (await c.query("SELECT to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL AS a")).rows[0].a === true);
      await c.query("DROP EVENT TRIGGER proof_inject; DROP FUNCTION public._proof_inject()");
      // Postcondition: the bounds postcondition checks a contract the wrapper sets; break it right after the wrapper's last DDL.
      r = await hosted(c, ENTRY[1]); check("controls applies after the injection is removed", r.ok, r.message);
      r = await hosted(c, ENTRY[2]); check("journey applies", r.ok, r.message);
      // SEPARATELY STAGED postcondition: grant authenticated EXECUTE on fs_bound_review_comment(). The wrapper's own
      // internal postcondition does not check that function (so the wrapper completes); only the staged
      // docs/release/fs-bounds-r1/postcondition.sql does, with 'POSTCONDITION: the function grants …'.
      await c.query(`CREATE FUNCTION public._proof_post() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF current_setting('cfoclose_release.applying', true) = 'fs-bounds-r1' AND to_regprocedure('public.fs_bound_review_comment()') IS NOT NULL
             AND NOT has_function_privilege('authenticated', 'public.fs_bound_review_comment()', 'EXECUTE') THEN
            GRANT EXECUTE ON FUNCTION public.fs_bound_review_comment() TO authenticated;
          END IF; END $f$;
        CREATE EVENT TRIGGER proof_post ON ddl_command_end EXECUTE FUNCTION public._proof_post();`);
      before = await state(c); r = await hosted(c, ENTRY[3]);
      check("staged-postcondition failure surfaces from the STAGED file (not the wrapper's POSTCONDITION_FAILED)",
        !r.ok && /^POSTCONDITION: the function grants/.test(r.message ?? "") && !/POSTCONDITION_FAILED/.test(r.message ?? ""), r.message);
      check("staged-postcondition failure: journal, stage consumption, events and schema unchanged", (await state(c)) === before);
      check("staged-postcondition failure: the wrapper's DDL rolled back (fs_work_bounds and its triggers absent)",
        (await c.query("SELECT to_regprocedure('public.fs_work_bounds()') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_feb_work_bounds') AS a")).rows[0].a === true);
      await c.query("DROP EVENT TRIGGER proof_post; DROP FUNCTION public._proof_post()");
      r = await hosted(c, ENTRY[3]); check("bounds applies after the injection is removed", r.ok, r.message);
    } finally { await c.end(); }
  }

  group("T6 concurrent submissions of the same entry");
  {
    const url = await srv.copyOf(boot.split("/").pop(), "t6");
    const a = await connect(url), b = await connect(url);
    try {
      await stageAll(a);
      const [ra, rb] = await Promise.all([hosted(a, ENTRY[1]), hosted(b, ENTRY[1])]);
      check("exactly one concurrent submission applies", [ra.ok, rb.ok].filter(Boolean).length === 1, `${ra.message} / ${rb.message}`);
      const loser = ra.ok ? rb : ra;
      check("the other is refused by the transport", /TRANSPORT_WRONG_PREDECESSOR|TRANSPORT_ALREADY_APPLIED/.test(loser.message ?? ""), loser.message);
      check("exactly one applied event and one journal row", (await a.query("SELECT count(*)::int AS n FROM cfoclose_release.transport_events WHERE event = 'applied'")).rows[0].n === 1
        && (await a.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE id > 65")).rows[0].n === 1);
    } finally { await a.end(); await b.end(); }
  }
  group("T7 an injected sign-off change is detected and rolls the batch back");
  {
    const url = await srv.copyOf(base.name, "t7");
    const c = await connect(url);
    try {
      await seedTwoBindings(c);
      const base0 = await digest(c);
      await hosted(c, ENTRY[0]); await stageAll(c);
      // UPDATE/DELETE are refused by the table's append-only trigger, so the injection is an extra INSERT through the
      // disposable-only replica hook, fired by the controls wrapper's own DDL while the batch applies.
      await c.query(`CREATE FUNCTION public._proof_signoff() RETURNS event_trigger LANGUAGE plpgsql AS $f$
        DECLARE v public.fs_publication_bindings;
        BEGIN
          IF current_setting('cfoclose_release.applying', true) = 'fs-controls-r1'
             AND NOT EXISTS (SELECT 1 FROM public.fs_publication_bindings WHERE report_id = 'fsr-injected') THEN
            SELECT * INTO v FROM public.fs_publication_bindings ORDER BY seq LIMIT 1;
            v.id := gen_random_uuid(); v.publication_id := gen_random_uuid(); v.report_id := 'fsr-injected';
            PERFORM set_config('session_replication_role', 'replica', true);
            INSERT INTO public.fs_publication_bindings OVERRIDING SYSTEM VALUE SELECT (v).*;
            PERFORM set_config('session_replication_role', 'origin', true);
          END IF; END $f$;
        CREATE EVENT TRIGGER proof_signoff ON ddl_command_end EXECUTE FUNCTION public._proof_signoff();`);
      const before = await state(c);
      const r = await hosted(c, ENTRY[1]);
      check("the extra binding is detected: TRANSPORT_SIGNOFF_BASELINE_CHANGED", !r.ok && /TRANSPORT_SIGNOFF_BASELINE_CHANGED/.test(r.message ?? ""), r.message);
      check("detection rolled back journal, stage consumption, events and schema", (await state(c)) === before);
      const d = await digest(c);
      check("the injected binding is gone; the two original rows are byte-identical", d.n === 2 && d.digest === base0.digest, JSON.stringify(d));
      check("the controls wrapper's objects are absent", (await c.query("SELECT to_regprocedure('public.fs_evidence_statements(uuid, integer)') IS NULL AS a")).rows[0].a === true);
      await c.query("DROP EVENT TRIGGER proof_signoff; DROP FUNCTION public._proof_signoff()");
      const ok = await hosted(c, ENTRY[1]); check("controls then applies cleanly with the baseline intact", ok.ok, ok.message);
    } finally { await c.end(); }
  }
} catch (e) { fail++; console.error(e); }
finally { await srv.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\nSTAGED_TRANSPORT_PROOF: ${fail ? "FAILED" : "OK"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail ? 1 : 0;
