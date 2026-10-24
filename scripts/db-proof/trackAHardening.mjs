#!/usr/bin/env bun
// Real-PostgreSQL proof of release batch track-a-r1 (20261127100000 + 20261128100000), installed the way it will be
// installed: on a database that ALREADY holds a FINAL authority, a sign-off and a sealed official pack made by the
// previous definitions. It proves:
//   - the batch's order guard, that an interrupted installation leaves nothing behind, that a retry applies cleanly and
//     that a repeated application is refused by its preflight; the existing sign-off and pack bytes are untouched;
//   - D-05: no service credential or member can write the FINAL authority pointer or its history directly; even the
//     table owner cannot delete the pointer, skip a sequence or move it without a matching authority event;
//   - the replacement intent: a caller-settable setting no longer authorises a cross-lineage replacement; the intent
//     cannot be forged; it is confined to the transaction that declared it;
//   - D-06: TRUNCATE is refused for every API role and, through triggers, for the table owner;
//   - D-01: a direct change of companies.reporting_framework is refused for every API role; the audited owner-only RPC
//     changes it, records the event, invalidates the certification it affects, replays idempotently, refuses stale,
//     locked, processing, unauthorised and cross-tenant attempts;
//   - concurrency: a FINAL and a framework change of one company serialise in both orders; two framework changes
//     serialise; other periods are not blocked by the company lock.
// Every case has a stable id in trackAHardening.manifest.mjs; the run writes a structured result
// (PROOF_RESULT_FILE, default proof-results/trackAHardening.present.json).
//
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) bun scripts/db-proof/trackAHardening.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyChainBefore, certifier, chainFiles, clientDb, csv, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, FY2026, makeWorld, migrationText, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./trackAHardening.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { changeReportingFramework } from "../../src/lib/workspace/companyFramework.ts";

const M1 = "20261127100000_fs_track_a_authority_hardening.sql";
const M2 = "20261128100000_companies_framework_change_guard.sql";
const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` }));
const stillPending = async (p, ms) => Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
const errOf = (e) => `${e.code ?? ""}:${String(e.message).split("\n")[0]}`;
let db;

// The fifteen tables 20261127100000 closes against TRUNCATE, and the history tables that already refused it.
const TRUNCATE_CLOSED = ["financial_evidence_batches", "financial_statement_audit_events", "financial_statement_correction_groups", "financial_statement_documents",
  "financial_statement_evaluations", "financial_statement_framework_requirements", "financial_statement_publications", "financial_statement_reports",
  "financial_statement_reviewer_decisions", "financial_statements_rollout_audit", "fs_signoff_policy_events", "tb_certification_findings",
  "tb_certification_invalidations", "tb_certifications", "tb_reprocess_requests"];
const TRUNCATE_ALSO = ["fs_report_authority", "fs_report_authority_events", "fs_authority_replacement_intents", "company_framework_events"];
// The fixtures an installation must not touch: rows of these tables, compared byte for byte (canonical jsonb text).
const FIXTURE_TABLES = ["financial_statement_publications", "fs_publication_bindings", "fs_report_authority", "fs_report_authority_events", "reporting_pack_issuances",
  "financial_statement_reviewer_decisions", "fs_signoff_policy_events", "financial_statement_reports", "tb_certifications", "companies"];

const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./trackAHardening.manifest.mjs", import.meta.url), "utf8"));
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1500) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

async function main() {
  db = await openDatabase("track_a_proof");
  const admin = db.admin;

  group("Installation on a database that already holds authority, sign-off and a sealed pack");
  await kase("setup.chain-before", `the chain before ${M1} applies; both batch migrations are in the chain, ${M1} before ${M2}, and nothing after them`, async () => {
    const chain = chainFiles(); const i1 = chain.indexOf(M1), i2 = chain.indexOf(M2);
    if (i1 < 0 || i2 !== i1 + 1 || i2 !== chain.length - 1) return { i1, i2, last: chain[chain.length - 1] };
    const err = await applyChainBefore(db, M1); return err ?? true;
  });

  const W = await makeWorld(db);
  const { U, A, B } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const asRole = (role, uid, sql, p) => db.asRole(role, uid, sql, p);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const pointer = () => db.one("SELECT report_id, report_version, publication_id, authority_seq FROM public.fs_report_authority WHERE company_id=$1 AND period_year=$2", [A, Y]);
  const events = () => admin.query("SELECT kind, report_id, report_version, publication_id, previous_report_id, previous_report_version, actor_user_id FROM public.fs_report_authority_events WHERE company_id=$1 AND period_year=$2 ORDER BY seq", [A, Y]).then((r) => r.rows);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return errOf(e); } };
  const replaceSql = "SELECT to_jsonb(public.fs_replace_final_authority($1,$2,$3,$4,$5,$6)) r";
  const replace = (uid, rid, v, prid, pv, reason) => asU(uid, replaceSql, [A, rid, v, prid, pv, reason]).then((r) => r.r);
  const finalSql = "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL',$4)) r";
  /** Runs `sql` as `role`/`uid` inside a transaction held open: its locks are held until commit(). */
  const inFlight = async (uid, sql, params, role = "authenticated") => {
    const c = await db.pool.connect();
    await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, uid ?? ""]);
    const r = await c.query(sql, params);
    return { row: r.rows[0]?.r, commit: async () => { await c.query("COMMIT"); c.release(); }, rollback: async () => { await c.query("ROLLBACK"); c.release(); } };
  };
  /** A statement the table owner (the migration role) runs and always rolls back; returns the refusal or "applied". */
  const ownerAttempt = async (sql, params = [], { immediate = false } = {}) => {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN"); await c.query(sql, params);
      if (immediate) await c.query("SET CONSTRAINTS ALL IMMEDIATE");
      return "applied";
    } catch (e) { return errOf(e); } finally { await c.query("ROLLBACK").catch(() => null); c.release(); }
  };
  const newLineage = async (label) => {
    const rid = `rpt-ta-${label}-${uuid()}`;
    const r = await attempt(pre, rid);
    if (r.outcome !== "saved") throw new Error(`${label}: ${JSON.stringify(r).slice(0, 200)}`);
    const rd = await partner.c.readiness(A, rid, r.reportVersion);
    if (!rd.ready) throw new Error(`${label} not ready: ${rd.blockers.join(";")}`);
    const rv = await partner.c.setState(A, rid, r.reportVersion, "REVIEWED", `Reviewed ${label}`);
    if (rv.state !== "REVIEWED") throw new Error(`${label} not reviewed`);
    return { rid, v: r.reportVersion };
  };
  const l1State = async () => hex(JSON.stringify([
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.financial_statement_publications t WHERE report_id=$1 ORDER BY 1", [L1.rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.fs_publication_bindings t WHERE report_id=$1 ORDER BY 1", [L1.rid])).rows,
    (await admin.query("SELECT to_jsonb(t)::text j FROM public.reporting_pack_issuances t WHERE id=$1", [L1Pack])).rows]));
  const snapshot = async () => {
    const out = {};
    for (const t of FIXTURE_TABLES) out[t] = hex(JSON.stringify((await admin.query(`SELECT to_jsonb(t)::text j FROM public.${t} t ORDER BY 1`)).rows.map((r) => r.j)));
    out["storage.objects"] = hex(JSON.stringify((await admin.query("SELECT bucket_id || '/' || name || ':' || coalesce(metadata::text,'') j FROM storage.objects ORDER BY 1")).rows.map((r) => r.j)));
    return out;
  };
  const schemaState = async () => (await admin.query(`SELECT to_regclass('public.fs_authority_replacement_intents') IS NOT NULL intents, to_regclass('public.company_framework_events') IS NOT NULL events,
      to_regprocedure('public.set_company_reporting_framework(uuid,text,text,text,uuid)') IS NOT NULL rpc,
      position('cfoclose.fs_replace_authority' IN pg_get_functiondef('public.fs_set_publication_state(text,integer,uuid,text,text)'::regprocedure)) > 0 setting_read,
      (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg\\_%\\_no\\_truncate' AND NOT tgisinternal)::int truncate_triggers,
      (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_fsra_guard','trg_fsra_event_consistency','trg_guard_company_reporting_framework'))::int guards,
      has_table_privilege('service_role','public.fs_report_authority','UPDATE') svc_update`)).rows[0];

  // The official pack through the Edge Function's own module (service role; in-memory bucket).
  const { issueOfficialPack, verifyOfficialPack } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/reportingPackSeal.mjs")).href);
  const bucket = new Map();
  const serviceRpc = async (fn, args) => {
    const keys = Object.keys(args);
    try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((kk, i) => `${kk} => $${i + 1}`).join(", ")}) r`, keys.map((kk) => args[kk])); return { data: rows[0].r, error: null }; }
    catch (e) { return { data: null, error: e }; }
  };
  const storeObject = async (p, b) => {
    if (bucket.has(p)) return { error: { message: "exists" } };
    await admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [p, JSON.stringify({ size: b.byteLength, mimetype: "application/json" })]);
    bucket.set(p, b); return { error: null };
  };
  const deps = { rpc: serviceRpc, put: storeObject, get: async (p) => bucket.get(p) ?? null, sha256Hex: async (b) => hex(b) };
  const issueRpc = async (uid, rid, v, req = uuid()) => (await asU(uid, "SELECT public.issue_official_reporting_pack($1,$2,$3,$4) r", [A, Y, `fs-report:${rid}:v${v}`, req])).r;

  let L1, L2, L1Pack, before, packBytesSha, l1Snap;
  await kase("setup.world-and-fixtures", "with the PREVIOUS definitions: two certified years, notes and schedules; lineage 1 REVIEWED by the partner and FINAL by the owner (the authority, ESTABLISHED); its official pack issued and sealed; lineage 2 REVIEWED", async () => {
    await prepareReporting(db, W, k, { year: Y });
    const seed = await attempt(pre, `rpt-ta-seed-${uuid()}`, allEvidence());
    if (seed.outcome !== "saved") return seed;
    L1 = await newLineage("l1");
    const f = await owner.c.setState(A, L1.rid, L1.v, "FINAL", "Approved for issue before the hardening");
    const i = await issueRpc(U.owner, L1.rid, L1.v); L1Pack = i.issuance_id;
    const s = await issueOfficialPack(deps, { userId: U.owner, issuanceId: L1Pack });
    L2 = await newLineage("l2");
    const p = await pointer();
    before = await snapshot();
    packBytesSha = hex(JSON.stringify([...bucket.entries()].map(([kk, v]) => [kk, hex(v)])));
    l1Snap = await l1State();
    const st = await schemaState();
    return f.state === "FINAL" && s.body.outcome === "sealed" && p?.report_id === L1.rid && p.authority_seq === 1 && st.setting_read === true && st.intents === false && st.svc_update === true
      ? true : { f: f.state, s: s.body?.outcome, p, st };
  });

  await kase("m1.order-refused", `${M2} applied before ${M1} is refused by its order guard (TRACK_A_ORDER) and changes nothing`, async () => {
    const s0 = await schemaState();
    let e = null; try { await admin.query(migrationText(M2)); } catch (x) { e = errOf(x); }
    const s1 = await schemaState();
    return /^55000:TRACK_A_ORDER/.test(e ?? "") && JSON.stringify(s0) === JSON.stringify(s1) ? true : { e, s0, s1 };
  });
  await kase("m2.interruption-rolls-back", `${M1} interrupted after its last statement (an injected failure in the same transaction) leaves no table, trigger, grant or function change behind; every fixture is unchanged`, async () => {
    const s0 = await schemaState();
    let e = null;
    try { await admin.query(`${migrationText(M1)}\nDO $inj$ BEGIN RAISE EXCEPTION 'INJECTED_INTERRUPTION' USING ERRCODE = '57014'; END $inj$;`); } catch (x) { e = errOf(x); }
    const s1 = await schemaState();
    const after = await snapshot();
    return /^57014:INJECTED_INTERRUPTION/.test(e ?? "") && JSON.stringify(s0) === JSON.stringify(s1) && JSON.stringify(after) === JSON.stringify(before) ? true : { e, s0, s1, same: JSON.stringify(after) === JSON.stringify(before) };
  });
  await kase("m3.apply-then-retry-refused", `the retry of ${M1} applies; ${M2} then applies; a second ${M1} is refused by its preflight (TRACK_A_BASELINE_CHANGED); a second ${M2} is a no-op; the schema is the hardened one`, async () => {
    await admin.query(migrationText(M1));
    await admin.query(migrationText(M2));
    const s1 = await schemaState();
    let e = null; try { await admin.query(migrationText(M1)); } catch (x) { e = errOf(x); }
    await admin.query(migrationText(M2));
    const s2 = await schemaState();
    return /^55000:TRACK_A_BASELINE_CHANGED/.test(e ?? "") && s1.intents && s1.events && s1.rpc && s1.setting_read === false && s1.guards === 3 && s1.svc_update === false
      && JSON.stringify(s1) === JSON.stringify(s2) ? true : { e, s1, s2 };
  });
  await kase("m4.fixtures-preserved", "after installation every fixture row (publications, bindings, authority and its events, issuances, sign-offs, policy events, reports, certifications, companies) and every stored pack object is byte-identical; the sealed pack still verifies intact, official, not superseded; the existing pointer satisfies the event invariant", async () => {
    const after = await snapshot();
    const v = await verifyOfficialPack(deps, U.owner, L1Pack);
    const packNow = hex(JSON.stringify([...bucket.entries()].map(([kk, b]) => [kk, hex(b)])));
    const bad = (await admin.query(`SELECT a.company_id FROM public.fs_report_authority a
      WHERE NOT EXISTS (SELECT 1 FROM (SELECT e.kind, e.publication_id FROM public.fs_report_authority_events e WHERE e.company_id=a.company_id AND e.period_year=a.period_year AND e.kind <> 'CONFLICT_DETECTED' ORDER BY e.seq DESC LIMIT 1) l
                        WHERE l.publication_id = a.publication_id)`)).rows;
    const diff = Object.keys(before).filter((t) => before[t] !== after[t]);
    return diff.length === 0 && packNow === packBytesSha && v.outcome === "intact" && v.official === true && v.superseded === false && bad.length === 0 ? true : { diff, v, bad };
  });

  // ── B. The FINAL authority ─────────────────────────────────────────────────────────────────────────────────────────
  group("B. The FINAL authority cannot be written around its functions");
  await kase("b1.direct-authority-writes-refused", "service_role and every member (owner, partner) are refused INSERT, UPDATE and DELETE on the authority pointer, its history and the replacement intents (42501); the pointer and history are unchanged", async () => {
    const p0 = await pointer(); const e0 = (await events()).length;
    const out = [];
    const stmts = [
      ["UPDATE public.fs_report_authority SET report_id=$1, report_version=$2, authority_seq=authority_seq+1 WHERE company_id=$3", [L2.rid, L2.v, A]],
      ["DELETE FROM public.fs_report_authority WHERE company_id=$1", [A]],
      ["INSERT INTO public.fs_report_authority (company_id, period_year, report_id, report_version, publication_id, authority_seq) SELECT company_id, 2025, report_id, report_version, publication_id, 1 FROM public.fs_report_authority WHERE company_id=$1", [A]],
      ["INSERT INTO public.fs_report_authority_events (company_id, period_year, kind, report_id, report_version) VALUES ($1, 2026, 'REPLACED', $2, $3)", [A, L2.rid, L2.v]],
      ["UPDATE public.fs_report_authority_events SET report_id=$2 WHERE company_id=$1", [A, L2.rid]],
      ["DELETE FROM public.fs_report_authority_events WHERE company_id=$1", [A]],
      ["INSERT INTO public.fs_authority_replacement_intents (txid, company_id, report_id, report_version, replaces_report_id, replaces_report_version) VALUES (pg_current_xact_id(), $1, $2, $3, 'x', 1)", [A, L2.rid, L2.v]],
    ];
    for (const [role, uid] of [["service_role", null], ["authenticated", U.owner], ["authenticated", U.partner]]) {
      for (const [sql, params] of stmts) { const r = await refusal(() => asRole(role, uid, sql, params)); out.push({ role, uid: uid === U.owner ? "owner" : uid ? "partner" : null, sql: sql.slice(0, 40), r }); }
    }
    const allRefused = out.every((o) => /^42501:/.test(o.r ?? ""));
    const p1 = await pointer();
    return allRefused && JSON.stringify(p0) === JSON.stringify(p1) && (await events()).length === e0 ? true : out.filter((o) => !/^42501:/.test(o.r ?? ""));
  });
  await kase("b2.authority-guard-binds-table-owner", "even the table owner (the migration role, inside a rolled-back transaction) cannot delete the pointer, change its scope, skip a sequence, or move it without a matching authority event (AUTHORITY_POINTER_WITHOUT_EVENT at commit)", async () => {
    const p = await pointer();
    const l2pub = (await db.one("SELECT id FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2 ORDER BY seq DESC LIMIT 1", [L2.rid, L2.v])).id;
    const del = await ownerAttempt("DELETE FROM public.fs_report_authority WHERE company_id=$1 AND period_year=$2", [A, Y]);
    const scopeChange = await ownerAttempt("UPDATE public.fs_report_authority SET period_year=2024, authority_seq=authority_seq+1 WHERE company_id=$1 AND period_year=$2", [A, Y]);
    const skip = await ownerAttempt("UPDATE public.fs_report_authority SET authority_seq=authority_seq+5 WHERE company_id=$1 AND period_year=$2", [A, Y]);
    const noEvent = await ownerAttempt("UPDATE public.fs_report_authority SET report_id=$3, report_version=$4, publication_id=$5, authority_seq=authority_seq+1 WHERE company_id=$1 AND period_year=$2", [A, Y, L2.rid, L2.v, l2pub], { immediate: true });
    return /^42501:AUTHORITY_POINTER_IMMUTABLE/.test(del) && /^42501:AUTHORITY_POINTER_IMMUTABLE/.test(scopeChange) && /^42501:AUTHORITY_POINTER_SEQUENCE/.test(skip) && /AUTHORITY_POINTER_WITHOUT_EVENT/.test(noEvent)
      && JSON.stringify(await pointer()) === JSON.stringify(p) ? true : { del, scopeChange, skip, noEvent };
  });
  await kase("b3.flag-spoofing-ignored", "the owner sets the former internal setting (cfoclose.fs_replace_authority, session- and transaction-level, naming the current authority exactly) and asks a plain FINAL of the competing lineage: refused AUTHORITY_CONFLICT; nothing recorded; the authority is unchanged", async () => {
    const p0 = await pointer(); const e0 = (await events()).length;
    const spoof = JSON.stringify({ reportId: L1.rid, reportVersion: L1.v });
    const results = [];
    for (const scope of ["false", "true"]) {
      results.push(await refusal(() => asU(U.owner, `SELECT set_config('cfoclose.fs_replace_authority', $5, ${scope}), to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL',$4)) r`, [L2.rid, L2.v, A, "Spoofed replacement attempt", spoof])));
    }
    const pubs = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [L2.rid]);
    return results.every((r) => /^PT409:AUTHORITY_CONFLICT/.test(r ?? "")) && pubs === 0 && JSON.stringify(await pointer()) === JSON.stringify(p0) && (await events()).length === e0 ? true : { results, pubs };
  });
  await kase("b4.intent-not-forgeable", "no API role can read or execute the intent helper or the scope lock, and the replacement function is not executable by service_role or anon (42501)", async () => {
    const r = [];
    for (const [role, uid] of [["authenticated", U.owner], ["service_role", null]]) {
      r.push(await refusal(() => asRole(role, uid, "SELECT public._fs_replacement_intent($1,$2,$3) r", [A, L2.rid, L2.v])));
      r.push(await refusal(() => asRole(role, uid, "SELECT public._fs_scope_lock($1,$2)", [A, Y])));
      r.push(await refusal(() => asRole(role, uid, "SELECT * FROM public.fs_authority_replacement_intents")));
    }
    r.push(await refusal(() => asRole("service_role", null, replaceSql, [A, L2.rid, L2.v, L1.rid, L1.v, "Service replacing"])));
    r.push(await refusal(() => asRole("anon", null, replaceSql, [A, L2.rid, L2.v, L1.rid, L1.v, "Anonymous replacing"])));
    return r.every((x) => /^42501:/.test(x ?? "")) ? true : r;
  });
  let L3;
  await kase("b5.legitimate-replacement", "the owner replaces lineage 1 by lineage 2 through fs_replace_final_authority: FINAL recorded, the pointer moves (seq 2), a REPLACED event names both versions, the actor and the new publication; the intent row of that transaction records the actor; lineage 1's sealed pack is disclosed as superseded and its bytes are untouched", async () => {
    const r = await replace(U.owner, L2.rid, L2.v, L1.rid, L1.v, "Replaces lineage 1: the board adopted the second set");
    const p = await pointer(); const ev = await events(); const last = ev[ev.length - 1];
    const intents = (await admin.query("SELECT actor_user_id, replaces_report_id, replaces_report_version FROM public.fs_authority_replacement_intents WHERE company_id=$1 AND report_id=$2", [A, L2.rid])).rows;
    const v = await verifyOfficialPack(deps, U.owner, L1Pack);
    return r.state === "FINAL" && p.report_id === L2.rid && p.authority_seq === 2 && last.kind === "REPLACED" && last.publication_id === p.publication_id && last.previous_report_id === L1.rid && last.previous_report_version === L1.v && last.actor_user_id === U.owner
      && intents.length === 1 && intents[0].actor_user_id === U.owner && intents[0].replaces_report_id === L1.rid && v.outcome === "intact" && v.superseded === true ? true : { r: r?.state, p, last, intents, v };
  });
  await kase("b6.intent-confined-to-transaction", "the committed intent does not authorise anything later: a plain FINAL of a third lineage is refused AUTHORITY_CONFLICT; in one transaction a second, different replacement for the same version is refused AUTHORITY_MISMATCH and the whole transaction rolls back", async () => {
    L3 = await newLineage("l3");
    const plain = await refusal(() => asU(U.owner, finalSql, [L3.rid, L3.v, A, "Plain FINAL after a replacement elsewhere"]));
    const both = await refusal(() => asU(U.owner, `SELECT public.fs_replace_final_authority($1,$2,$3,$4,$5,'First declaration') a, public.fs_replace_final_authority($1,$2,$3,$4,$6,'Different declaration') r`, [A, L3.rid, L3.v, L2.rid, L2.v, L2.v + 1]));
    const intents = await db.count("SELECT count(*) n FROM public.fs_authority_replacement_intents WHERE report_id=$1", [L3.rid]);
    return /^PT409:AUTHORITY_CONFLICT/.test(plain ?? "") && /^PT409:AUTHORITY_MISMATCH/.test(both ?? "") && intents === 0 && (await pointer()).report_id === L2.rid ? true : { plain, both, intents };
  });

  // ── C. Append-only history ────────────────────────────────────────────────────────────────────────────────────────
  group("C. TRUNCATE, UPDATE and DELETE of history");
  await kase("c1.truncate-refused-every-role", `TRUNCATE of each of the ${TRUNCATE_CLOSED.length} newly closed tables and the ${TRUNCATE_ALSO.length} authority/framework history tables is refused for service_role, authenticated and anon (privilege), and for the table owner (trigger, inside a rolled-back transaction, also with CASCADE); every row count is unchanged`, async () => {
    const bad = [];
    for (const t of [...TRUNCATE_CLOSED, ...TRUNCATE_ALSO]) {
      const n0 = await db.count(`SELECT count(*) n FROM public.${t}`);
      for (const [role, uid] of [["service_role", null], ["authenticated", U.owner], ["anon", null]]) {
        const r = await refusal(() => asRole(role, uid, `TRUNCATE public.${t}`));
        if (!/^42501:/.test(r ?? "")) bad.push({ t, role, r });
      }
      const o = await ownerAttempt(`TRUNCATE public.${t} CASCADE`);
      if (!/^42501:/.test(o) || !/APPEND_ONLY|append-only|append only/i.test(o)) bad.push({ t, role: "owner", o });
      if ((await db.count(`SELECT count(*) n FROM public.${t}`)) !== n0) bad.push({ t, count: "changed" });
    }
    const priv = (await admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname = ANY($1)
       AND (has_table_privilege('service_role', c.oid, 'TRUNCATE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE') OR has_table_privilege('anon', c.oid, 'TRUNCATE'))`, [[...TRUNCATE_CLOSED, ...TRUNCATE_ALSO]])).rows;
    return bad.length === 0 && priv.length === 0 ? true : { bad: bad.slice(0, 12), priv };
  });
  await kase("c2.history-update-delete-refused", "UPDATE and DELETE of the authority history, the replacement intents and the framework history are refused for service_role, members and the table owner", async () => {
    const bad = [];
    const stmts = [["fs_report_authority_events", "reason"], ["fs_authority_replacement_intents", "report_id"], ["company_framework_events", "reason"]];
    for (const [t, col] of stmts) {
      for (const [role, uid] of [["service_role", null], ["authenticated", U.owner]]) {
        for (const sql of [`UPDATE public.${t} SET ${col} = ${col}`, `DELETE FROM public.${t}`]) { const r = await refusal(() => asRole(role, uid, sql)); if (!/^42501:/.test(r ?? "")) bad.push({ t, role, sql, r }); }
      }
      for (const sql of [`UPDATE public.${t} SET ${col} = ${col}`, `DELETE FROM public.${t}`]) {
        const n = await db.count(`SELECT count(*) n FROM public.${t}`);
        const o = await ownerAttempt(sql);
        // An empty table has no row for a row trigger to refuse; the framework history is filled by section D and re-checked in f1.
        if (n > 0 && o === "applied") bad.push({ t, owner: o });
      }
    }
    return bad.length === 0 ? true : bad;
  });

  // ── D. Governed framework changes ─────────────────────────────────────────────────────────────────────────────────
  group("D. The reporting framework changes only through the audited, owner-only function");
  const fw = (c) => db.one("SELECT reporting_framework::text f FROM public.companies WHERE id=$1", [c]).then((r) => r.f);
  const fwEvents = (c) => admin.query("SELECT from_framework, to_framework, actor_user_id, request_id, reason, id FROM public.company_framework_events WHERE company_id=$1 ORDER BY seq", [c]).then((r) => r.rows);
  const rpcSql = "SELECT public.set_company_reporting_framework($1,$2,$3,$4,$5) r";
  const setFw = (uid, c, to, expected, req = uuid(), reason = "Reporting framework decided by the owner") => asU(uid, rpcSql, [c, to, expected, reason, req]).then((r) => r.r);
  // The browser module itself, over the real database as the given user.
  const browserChange = (uid, companyId, from, to, requestId = uuid()) => changeReportingFramework({ rpc: (fn, args) => clientDb(db, uid).rpc(fn, args).then((r) => r, (e) => ({ data: null, error: e })) }, { companyId, from, to, requestId });

  await kase("d1.direct-framework-update-refused", "a direct UPDATE of companies.reporting_framework is refused for the owner and service_role (FRAMEWORK_CHANGE_REQUIRES_RPC, 42501); members cannot reach it; the owner's other company edits (description) still succeed; no framework event is recorded", async () => {
    const r = [];
    r.push(await refusal(() => asU(U.owner, "UPDATE public.companies SET reporting_framework='full_ifrs' WHERE id=$1 RETURNING id", [A])));
    r.push(await refusal(() => asRole("service_role", null, "UPDATE public.companies SET reporting_framework='full_ifrs' WHERE id=$1 RETURNING id", [A])));
    const member = await asRole("authenticated", U.partner, "UPDATE public.companies SET reporting_framework='full_ifrs' WHERE id=$1 RETURNING id", [A]).then((rows) => `rows:${rows.length}`, errOf);
    const rename = await asRole("authenticated", U.owner, "UPDATE public.companies SET description='Edited in company settings' WHERE id=$1 RETURNING description", [A]);
    const ok = r.every((x) => /^42501:FRAMEWORK_CHANGE_REQUIRES_RPC/.test(x ?? "")) && (member === "rows:0" || /^42501:/.test(member)) && rename[0]?.description === "Edited in company settings";
    return ok && (await fw(A)) === "ifrs_for_smes" && (await fwEvents(A)).length === 0 ? true : { r, member, rename };
  });

  // Company C: undecided framework with an authoritative certification (a decision taken after the trial balance).
  const C = (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Undecided entity',NULL) RETURNING id", [U.owner])).id;
  let cEvent;
  await kase("d2.authorized-change-audited-and-invalidates", "company C (no framework yet) holds an authoritative FY2026 certification; the owner sets IFRS for SMEs through the browser module: changed, the company holds it, one event records from/to/actor/request/reason, and the certification loses authority (dependency_changed)", async () => {
    const u = await k.upload(C, Y, csv(FY2026)); await k.review(C, u); const cert = await k.certify(C, u);
    const was = (await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [C, Y]))?.id;
    const req = uuid();
    const r = await browserChange(U.owner, C, null, "ifrs_for_smes", req);
    const ev = await fwEvents(C); cEvent = { req, id: ev[0]?.id };
    const now = (await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [C, Y]))?.id ?? null;
    const why = (await asU(U.owner, "SELECT public.tb_upload_authority($1) r", [u.id])).r.reason;
    return was === cert && r.kind === "changed" && r.from === null && r.to === "ifrs_for_smes" && (await fw(C)) === "ifrs_for_smes" && ev.length === 1 && ev[0].from_framework === null && ev[0].to_framework === "ifrs_for_smes"
      && ev[0].actor_user_id === U.owner && ev[0].request_id === req && ev[0].reason.length >= 8 && r.eventId === ev[0].id && now === null && why === "dependency_changed" ? true : { was, cert, r, ev, now, why };
  });
  await kase("d3.replay-and-idempotency", "the same request again is a replay naming the same event (no new event); the same request id for a different change is refused IDEMPOTENCY_CONFLICT; asking for the current value is unchanged with no event", async () => {
    const replay = await browserChange(U.owner, C, null, "ifrs_for_smes", cEvent.req); // the browser's retry: same request, same recorded reason
    const conflict = await refusal(() => setFw(U.owner, C, "full_ifrs", "ifrs_for_smes", cEvent.req));
    const same = await setFw(U.owner, C, "ifrs_for_smes", "ifrs_for_smes");
    return replay.kind === "replayed" && replay.eventId === cEvent.id && /^PT409:IDEMPOTENCY_CONFLICT/.test(conflict ?? "") && same.outcome === "unchanged" && (await fwEvents(C)).length === 1 ? true : { replay, conflict, same };
  });
  const D = (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Fresh entity',NULL) RETURNING id", [U.owner])).id;
  await kase("d4.business-refusals", "C now holds a framework and a certification: a change is refused FRAMEWORK_LOCKED; a stale expected value is refused STALE_FRAMEWORK; a check in flight is refused PROCESSING_IN_PROGRESS and the change succeeds once its lease has expired; an unsupported framework or a short reason is refused 22023; no refusal records an event or changes the company", async () => {
    const locked = await setFw(U.owner, C, "full_ifrs", "ifrs_for_smes");
    const stale = await setFw(U.owner, D, "full_ifrs", "ifrs_for_smes");
    const pid = (await db.one("INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, period_label, created_by, reporting_currency, reporting_start) VALUES ($1,'2026-12-31','FY2026',$2,'TZS','2026-01-01') RETURNING id", [D, U.owner])).id;
    const up = (await db.one("INSERT INTO public.trial_balance_uploads (file_name, file_path, file_size, status, company_id, period_year, period_id, user_id) VALUES ('tb.csv',$1,10,'processing',$2,2026,$3,$4) RETURNING id", [`${U.owner}/${uuid()}.csv`, D, pid, U.owner])).id;
    // A check in flight, as the engine leaves it between tb_begin_attempt and finalisation (inserted directly, triggers
    // suspended for this fixture only: the run's own start path is proven by s2Authority.mjs).
    const fixture = async (sql, params) => { const c = await db.pool.connect(); try { await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica"); const r = await c.query(sql, params); await c.query("COMMIT"); return r.rows[0]; } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } };
    const run = (await fixture("INSERT INTO public.engine_runs (company_id, actor_type, function_name, engine_version, status, source_table, source_record_id, period_year, lease_expires_at) VALUES ($1,'system','process-trial-balance','proof','running','trial_balance_uploads',$2,2026, now() + interval '5 minutes') RETURNING id", [D, up])).id;
    const busy = await setFw(U.owner, D, "full_ifrs", null);
    await fixture("UPDATE public.engine_runs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [run]);
    const invalid = await refusal(() => setFw(U.owner, D, "gaap", null));
    const short = await refusal(() => setFw(U.owner, D, "full_ifrs", null, uuid(), "short"));
    const evD0 = (await fwEvents(D)).length;
    const after = await setFw(U.owner, D, "full_ifrs", null);
    return locked.outcome === "refused" && locked.code === "FRAMEWORK_LOCKED" && locked.current === "ifrs_for_smes" && stale.code === "STALE_FRAMEWORK" && stale.current === null
      && busy.code === "PROCESSING_IN_PROGRESS" && /^22023:/.test(invalid ?? "") && /^22023:/.test(short ?? "") && evD0 === 0 && after.outcome === "changed" && (await fw(D)) === "full_ifrs"
      && (await fw(C)) === "ifrs_for_smes" && (await fwEvents(C)).length === 1 ? true : { locked, stale, busy, invalid, short, evD0, after };
  });
  await kase("d5.authorization-and-tenancy", "a member with every capability (the partner), another workspace's owner, service_role and anon are refused (42501); the owner cannot change another workspace's company; the other workspace reads none of this company's framework history and the owner reads it; the browser module reports a refusal as forbidden", async () => {
    const E = (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Second undecided entity',NULL) RETURNING id", [U.owner])).id;
    const r = [
      await refusal(() => setFw(U.partner, E, "full_ifrs", null)),
      await refusal(() => setFw(U.ownerB, E, "full_ifrs", null)),
      await refusal(() => setFw(U.owner, B, "full_ifrs", "ifrs_for_smes")),
      await refusal(() => asRole("service_role", null, rpcSql, [E, "full_ifrs", null, "Service changing the framework", uuid()])),
      await refusal(() => asRole("anon", null, rpcSql, [E, "full_ifrs", null, "Anonymous changing the framework", uuid()])),
    ];
    const viaBrowser = await browserChange(U.ownerB, E, null, "full_ifrs");
    const readB = await asRole("authenticated", U.ownerB, "SELECT count(*)::int n FROM public.company_framework_events WHERE company_id=$1", [C]);
    const readOwner = await asRole("authenticated", U.owner, "SELECT count(*)::int n FROM public.company_framework_events WHERE company_id=$1", [C]);
    return r.every((x) => /^42501:/.test(x ?? "")) && viaBrowser.kind === "forbidden" && readB[0].n === 0 && readOwner[0].n === 1 && (await fw(E)) === null && (await fw(B)) === "ifrs_for_smes" && (await fwEvents(E)).length === 0
      ? true : { r, viaBrowser, readB, readOwner };
  });

  // ── E. Concurrency ────────────────────────────────────────────────────────────────────────────────────────────────
  group("E. A FINAL and a framework change of one company serialise");
  await kase("e1.final-waits-for-framework-change", "a framework change of company A is held open (exclusive company lock); a replacement FINAL of A (lineage 3 replaces lineage 2) WAITS; after the change commits (refused FRAMEWORK_LOCKED: A has reports) the FINAL proceeds; the framework is unchanged and the authority is lineage 3 with a matching event", async () => {
    const t1 = await inFlight(U.owner, rpcSql, [A, "full_ifrs", "ifrs_for_smes", "Attempted change during a FINAL", uuid()]);
    const fin = settle(replace(U.owner, L3.rid, L3.v, L2.rid, L2.v, "Replaces lineage 2 while a framework change is held"));
    const waits = await stillPending(fin, 1500);
    await t1.commit();
    const f = await fin; const p = await pointer(); const ev = await events();
    return waits && t1.row.outcome === "refused" && t1.row.code === "FRAMEWORK_LOCKED" && f.ok && f.v.state === "FINAL" && p.report_id === L3.rid && p.authority_seq === 3
      && ev[ev.length - 1].kind === "REPLACED" && ev[ev.length - 1].publication_id === p.publication_id && (await fw(A)) === "ifrs_for_smes" ? true : { waits, t1: t1.row, f, p };
  });
  let L4;
  await kase("e2.framework-change-waits-for-final", "a replacement FINAL of A (lineage 4 replaces lineage 3) is held open (shared company lock + scope lock); a framework change of A WAITS; after the FINAL commits the change is refused FRAMEWORK_LOCKED; the framework is unchanged", async () => {
    L4 = await newLineage("l4");
    const t1 = await inFlight(U.owner, replaceSql, [A, L4.rid, L4.v, L3.rid, L3.v, "Replaces lineage 3 while a framework change is attempted"]);
    const chg = settle(setFw(U.owner, A, "full_ifrs", "ifrs_for_smes"));
    const waits = await stillPending(chg, 1500);
    await t1.commit();
    const c = await chg;
    return waits && t1.row.state === "FINAL" && c.ok && c.v.outcome === "refused" && c.v.code === "FRAMEWORK_LOCKED" && (await fw(A)) === "ifrs_for_smes" && (await pointer()).report_id === L4.rid ? true : { waits, t1: t1.row?.state, c };
  });
  await kase("e3.framework-changes-serialize", "two owners' sessions decide an undecided company concurrently (both expecting no framework): the second WAITS for the first and is then refused STALE_FRAMEWORK; exactly one event", async () => {
    const F = (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,'Raced entity',NULL) RETURNING id", [U.owner])).id;
    const t1 = await inFlight(U.owner, rpcSql, [F, "ifrs_for_smes", null, "First session decides", uuid()]);
    const second = settle(setFw(U.owner, F, "full_ifrs", null));
    const waits = await stillPending(second, 1500);
    await t1.commit();
    const s = await second;
    return waits && t1.row.outcome === "changed" && s.ok && s.v.outcome === "refused" && s.v.code === "STALE_FRAMEWORK" && s.v.current === "ifrs_for_smes" && (await fw(F)) === "ifrs_for_smes" && (await fwEvents(F)).length === 1 ? true : { waits, t1: t1.row, s };
  });
  await kase("e4.other-periods-not-blocked", "while a FINAL transition of A FY2026 holds its locks, the scope lock of A FY2025 is taken at once (the company lock is shared between periods) but the exclusive company lock is not", async () => {
    const held = await inFlight(U.owner, "SELECT to_jsonb(public._fs_scope_lock($1,$2)) r", [A, Y], "postgres");
    const other = settle(admin.query("BEGIN; SELECT public._fs_scope_lock($1, 2025); COMMIT;".replace("$1", `'${A}'`)));
    const otherWaits = await stillPending(other, 800);
    const excl = settle((async () => { const c = await db.pool.connect(); try { await c.query("BEGIN"); await c.query("SET LOCAL lock_timeout = '700ms'"); await c.query("SELECT pg_advisory_xact_lock(hashtextextended('cfoclose.fr_company:' || $1::text, 0))", [A]); await c.query("COMMIT"); } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } })());
    const e = await excl;
    await held.rollback();
    const o = await other;
    return !otherWaits && o.ok && !e.ok && /^55P03:/.test(e.e) ? true : { otherWaits, o, e };
  });

  // ── F. Invariants after everything ────────────────────────────────────────────────────────────────────────────────
  group("F. Invariants");
  await kase("f1.invariants-hold", "every authority pointer equals the publication of its latest authority event; the history is ESTABLISHED, REPLACED, REPLACED, REPLACED; lineage 1's FINAL row, sign-off and sealed bytes are still the pre-installation ones; the framework history refuses the table owner's UPDATE and DELETE", async () => {
    const bad = (await admin.query(`SELECT a.company_id, a.period_year FROM public.fs_report_authority a
      WHERE NOT EXISTS (SELECT 1 FROM (SELECT e.publication_id FROM public.fs_report_authority_events e WHERE e.company_id=a.company_id AND e.period_year=a.period_year AND e.kind <> 'CONFLICT_DETECTED' ORDER BY e.seq DESC LIMIT 1) l WHERE l.publication_id = a.publication_id)`)).rows;
    const kinds = (await events()).map((e) => e.kind).join(",");
    const l1Same = (await l1State()) === l1Snap;
    const bytesSame = hex(JSON.stringify([...bucket.entries()].map(([kk, b]) => [kk, hex(b)]))) === packBytesSha; // no pack was issued after setup
    const v = await verifyOfficialPack(deps, U.owner, L1Pack);
    const upd = await ownerAttempt("UPDATE public.company_framework_events SET reason = reason");
    const del = await ownerAttempt("DELETE FROM public.company_framework_events");
    return bad.length === 0 && kinds === "ESTABLISHED,REPLACED,REPLACED,REPLACED" && l1Same && bytesSame && v.outcome === "intact" && v.official === true && upd !== "applied" && del !== "applied" ? true : { bad, kinds, l1Same, v, upd, del };
  });

  const missing = CASES.map((c) => c.id).filter((id) => !recorded.some((r) => r.id === id));
  if (missing.length) throw new Error(`proof defect: cases never reached: ${missing.join(", ")}`);
}

main().then(async () => { writeResult(true, false); const ok = finish("track-a hardening", false); await db?.close(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error("CRASH:", e); writeResult(false, true, String(e?.message ?? e)); finish("track-a hardening", true); await db?.close(); process.exit(1); });
