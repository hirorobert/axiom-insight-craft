#!/usr/bin/env bun
// Real-PostgreSQL proof of Ready for Reporting at the finalization boundary (20261216100000).
//
//   · opting a scope in changes nothing for scopes that did not opt in;
//   · an unevaluated, stale or held evaluation blocks REVIEWED and FINAL, while drafting stays available;
//   · C1/C2: BOTH orderings of a concurrent local change against FINAL, with real held transactions;
//   · C3: FINAL below READ COMMITTED is refused before any write;
//   · C4: every writer of a manifest input takes the scope lock (catalogue AND behaviour);
//   · C7: bound input bytes stay retrievable and unchangeable after FINAL;
//   · D5: the review binds CONTENT; QuickBooks freshness is a separate, expiring attestation bound to that content.
//
// Every case has a stable id in readinessFinalization.manifest.mjs; the run writes proof-results/readinessFinalization.present.json.
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/readinessFinalization.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyChain, certifier, chainFiles, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./readinessFinalization.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { runReadinessCheck } from "../../supabase/functions/_shared/readiness/index.ts";

const FILE = "20261216100000_ready_for_reporting_pilot.sql";
const MODE = "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` }));
const stillPending = async (p, ms) => Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
let db;

const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./readinessFinalization.manifest.mjs", import.meta.url), "utf8"));
const commit = (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { return null; } })();
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try { const r = await fn(); if (r === true) { outcome = "pass"; return true; } detail = JSON.stringify(r)?.slice(0, 1200) ?? ""; return r; }
    catch (e) { detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`; throw e; }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, commit, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

const Y = 2026;
const SCOPE = ["rfr-pilot-ipsas-accrual", "1.0.0"];

async function main() {
  db = await openDatabase("readiness_proof");
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const serviceRpc = {
    rpc: async (fn, args) => {
      const keys = Object.keys(args);
      try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k])); return { data: rows[0].r, error: null }; }
      catch (e) { return { data: null, error: { message: `${e.code ?? ""}:${e.message}` } }; }
    },
  };
  /** The Edge Function's job, in process: load → evaluate with the REAL engine → record. */
  const checkBooks = (company) => runReadinessCheck(serviceRpc, company, Y);
  const digest = async (company) => (await db.one("SELECT public.rfr_content_digest($1,$2) d", [company, Y])).d;
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };

  // A transaction held open as `uid` after running sql: its locks are held until commit()/rollback().
  const inFlight = async (uid, sql, params, { isolation } = {}) => {
    const c = await db.pool.connect();
    await c.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    try {
      const r = await c.query(sql, params);
      return { row: r.rows[0]?.r, commit: async () => { await c.query("COMMIT"); c.release(); }, rollback: async () => { await c.query("ROLLBACK"); c.release(); } };
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } c.release(); throw e; }
  };
  const finalSql = "SELECT to_jsonb(public.fs_set_publication_state(p_report_id => $1, p_report_version => $2, p_company_id => $3, p_state => 'FINAL', p_reason => 'Finalised for the proof')) r";
  const regEvidence = (uid, company, key, facts, req = uuid()) => asU(uid, "SELECT public.rfr_register_input($1,$2,'evidence',$3,$4::jsonb,'manual',NULL,$5) r", [company, Y, key, JSON.stringify({ kind: "other_document", extraction: "human_confirmed", facts }), req]).then((r) => r.r);

  /** One reporting world: two certified years, presentation, notes, comparatives, the evidence saved once. */
  async function reportingWorld(label) {
    const W = await makeWorld(db);
    const { U, A } = W;
    await W.rollout(A, true);
    const k = await certifier(db, U);
    const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
    const pre = as(U.preparer), partner = as(U.partner);
    const parse = (type, role = "CURRENT") => {
      const y = role === "CURRENT" ? Y : Y - 1;
      const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
      if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
      return r.batch;
    };
    const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
    const attempt = (rid, newEvidence = []) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
    const readiness = (rid, v) => partner.c.readiness(A, rid, v);
    const finals = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [rid]);
    /** Save a draft version through the browser's builder, and REVIEW it as the partner. */
    const draft = async (lbl) => { const rid = `rfr-${label}-${lbl}-${uuid()}`; const r = await attempt(rid); if (r.outcome !== "saved") throw new Error(`${lbl}: ${JSON.stringify(r).slice(0, 200)}`); return { rid, v: r.reportVersion }; };
    const reviewed = async (lbl) => { const L = await draft(lbl); const rv = await partner.c.setState(A, L.rid, L.v, "REVIEWED", `Reviewed ${lbl}`); if (rv.state !== "REVIEWED") throw new Error(`${lbl} not reviewed`); return L; };
    await prepareReporting(db, W, k, { year: Y });
    const seed = await attempt(`rfr-${label}-seed-${uuid()}`, allEvidence());
    if (seed.outcome !== "saved") throw new Error(`seed: ${JSON.stringify(seed).slice(0, 300)}`);
    return { W, U, A, k, pre, partner, attempt, readiness, finals, draft, reviewed };
  }

  group("Replay");
  await kase("setup.chain", `${FILE} is in the chain and the whole chain applies; re-applying is refused by its preflight`, async () => {
    if (!chainFiles().includes(FILE)) return `${FILE} missing`;
    const err = await applyChain(db); if (err) return err;
    const def = (await db.one("SELECT pg_get_functiondef('public.fs_publication_blockers(uuid, text, integer)'::regprocedure) d")).d;
    // The splice keeps every substring earlier proofs read, and adds exactly one call.
    if (!def.includes("_rfr_blockers") || !def.includes("REVIEW_COMMENT_UNRESOLVED") || !def.includes("fs_server_compilation_blocker") || !def.includes("_fs_document_structure_blockers")) return "splice lost a required substring";
    try { await db.admin.query(migrationText(FILE)); return "re-applied"; } catch (e) { return e.code === "P0001" && /PREFLIGHT_REFUSED/.test(e.message) ? true : `${e.code}: ${e.message}`; }
  });

  // ═════════════════════════════════════ World 1: opt-in, evaluation, contracts C1–C4, C7 ═════════════════════════════════════
  group("World 1");
  let w1;
  await kase("setup.world1", "two certified years, presentation, Close Review, notes, comparatives; the evidence saved once through the browser's builder", async () => { w1 = await reportingWorld("w1"); return true; });
  const { U, A } = w1 ?? {};
  await kase("a1.not-opted-in-unchanged", "a scope that never opted in: the draft is ready, no readiness blocker exists, and the readiness status says not_enabled", async () => {
    const L = await w1.draft("a1");
    const rd = await w1.readiness(L.rid, L.v);
    const st = (await asU(U.preparer, "SELECT public.rfr_status($1,$2) r", [A, Y])).r;
    return rd.ready === true && !rd.blockers.some((b) => b.startsWith("RFR_")) && st.state === "not_enabled" ? true : { rd, st };
  });
  await kase("a2.opt-in-and-authority", "opting in needs prepare_close and is recorded once; the browser cannot write the tables, run the engine, attest a source or register a QuickBooks input; unknown packs and facts are refused", async () => {
    const set = (uid, facts = { deposits: false }, pack = SCOPE) => asU(uid, "SELECT public.rfr_set_scope($1,$2,$3,$4,$5::jsonb,'Enable readiness for the pilot') r", [A, Y, pack[0], pack[1], JSON.stringify(facts)]).then((r) => r.r);
    const viewer = await set(U.viewer);
    const badPack = await set(U.preparer, { deposits: false }, ["other", "1.0.0"]);
    const badFact = await set(U.preparer, { colour: "red" });
    const ok = await set(U.preparer);
    const again = await set(U.preparer);
    const direct = await refusal(() => asU(U.preparer, "INSERT INTO public.rfr_inputs (company_id, period_year, family, key, payload, payload_sha256, source, actor_user_id, request_id) VALUES ($1,$2,'evidence','x','{}'::jsonb,$3,'manual',$4,$5)", [A, Y, "0".repeat(64), U.preparer, uuid()]));
    const runAuth = await refusal(() => asU(U.owner, "SELECT public.rfr_record_run($1,$2,$3,'{}'::jsonb)", [A, Y, "0".repeat(64)]));
    const attAuth = await refusal(() => asU(U.owner, "SELECT public.rfr_record_source_attestation($1,$2,NULL,NULL,now())", [A, Y]));
    const srcAuth = await refusal(() => asU(U.owner, "SELECT public.rfr_register_source_input($1,$2,$3,'ledger_snapshot','gl','{}'::jsonb,NULL,$4)", [A, Y, U.owner, uuid()]));
    const qboFromBrowser = (await asU(U.preparer, "SELECT public.rfr_register_input($1,$2,'ledger_snapshot','gl','{}'::jsonb,'qbo_api',NULL,$3) r", [A, Y, uuid()])).r;
    const upd = await refusal(() => db.admin.query("UPDATE public.rfr_scope_events SET reason='changed there' WHERE company_id=$1", [A]));
    return viewer.outcome === "forbidden" && badPack.outcome === "unknown_rule_pack" && badFact.outcome === "invalid_request" && ok.outcome === "recorded" && ok.enabled === true && again.outcome === "unchanged"
      && /^42501:/.test(direct ?? "") && /^42501:/.test(runAuth ?? "") && /^42501:/.test(attAuth ?? "") && /^42501:/.test(srcAuth ?? "") && qboFromBrowser.outcome === "invalid_request" && /RFR_APPEND_ONLY/.test(upd ?? "")
      ? true : { viewer, badPack, badFact, ok, again, direct, runAuth, attAuth, srcAuth, qboFromBrowser, upd };
  });
  let L1;
  await kase("a3.unevaluated-blocks-review-drafting-allowed", "after opting in, a draft can still be saved; it cannot be reviewed or finalized until an evaluation exists (RFR_NOT_EVALUATED)", async () => {
    L1 = await w1.draft("l1");
    const rd = await w1.readiness(L1.rid, L1.v);
    const rev = await refusal(() => w1.partner.c.setState(A, L1.rid, L1.v, "REVIEWED", "Reviewed before any evaluation"));
    return rd.ready === false && rd.blockers.includes("RFR_NOT_EVALUATED") && /RFR_NOT_EVALUATED/.test(rev ?? "") ? true : { rd: rd.blockers, rev };
  });
  await kase("a4.run-recorded-ready", "the engine's run over the stored rows is recorded; the required scopes are READY on positive proof; the adjusted layer equals the engine's balances", async () => {
    const r = await checkBooks(A);
    const st = (await asU(U.preparer, "SELECT public.rfr_status($1,$2) r", [A, Y])).r;
    const rd = await w1.readiness(L1.rid, L1.v);
    const res = r.result;
    return r.outcome === "recorded" && r.balancesAgree === true && res.scopes.pack === "READY" && res.scopes.rule_pack === "READY" && st.state === "current" && rd.ready === true ? true : { r: r.outcome, agree: r.balancesAgree, scopes: res?.scopes, st: st.state, blockers: rd.blockers };
  });
  await kase("a5.review-binds-content", "REVIEWED records the content digest it saw and the run it relied on", async () => {
    const rv = await w1.partner.c.setState(A, L1.rid, L1.v, "REVIEWED", "Reviewed the first lineage");
    const row = await db.one("SELECT content_sha256, run_id FROM public.rfr_reviews WHERE report_id=$1 AND report_version=$2", [L1.rid, L1.v]);
    const run = await db.one("SELECT content_sha256 FROM public.rfr_runs WHERE id=$1", [row.run_id]);
    return rv.state === "REVIEWED" && row.content_sha256 === (await digest(A)) && run.content_sha256 === row.content_sha256 ? true : { rv: rv.state, row, now: await digest(A) };
  });

  // ── C1: the change commits before FINAL recomputes ────────────────────────────────────────────────────────────────
  let d1;
  await kase("c1.change-commits-before-finalize", "a manifest-input change holds the scope lock; FINAL waits, then recomputes and refuses RFR_MANIFEST_STALE; no FINAL row, no manifest", async () => {
    d1 = await digest(A);
    const writer = await inFlight(U.preparer, "SELECT public.rfr_register_input($1,$2,'evidence','EV-1',$3::jsonb,'manual',NULL,$4) r", [A, Y, JSON.stringify({ kind: "other_document", extraction: "human_confirmed", facts: { amount: "100" } }), uuid()]);
    const fin = settle(asU(U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Finalised for the proof')) r", [L1.rid, L1.v, A]));
    const waits = await stillPending(fin, 1500);
    await writer.commit();
    const r = await fin;
    const manifests = await db.count("SELECT count(*) n FROM public.rfr_finalization_manifests WHERE company_id=$1", [A]);
    return waits && writer.row.outcome === "recorded" && !r.ok && /RFR_MANIFEST_STALE/.test(r.e) && (await w1.finals(L1.rid)) === 0 && manifests === 0 && (await digest(A)) !== d1 ? true : { waits, w: writer.row, r, manifests };
  });
  await kase("c1b.stale-review-refused", "with the evaluation re-run on the changed books, the review that saw the OLD content still cannot finalize (RFR_REVIEW_STALE)", async () => {
    const r = await checkBooks(A);
    const fin = await refusal(() => asU(U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Finalised for the proof')) r", [L1.rid, L1.v, A]));
    return r.outcome === "recorded" && /RFR_REVIEW_STALE/.test(fin ?? "") && !/RFR_MANIFEST_STALE/.test(fin ?? "") && (await w1.finals(L1.rid)) === 0 ? true : { r: r.outcome, fin };
  });
  let L2;
  await kase("c3.non-read-committed-refused", "FINAL at REPEATABLE READ is refused PT412 before any write; the version stays REVIEWED", async () => {
    L2 = await w1.reviewed("l2");
    const err = await refusal(async () => { const t = await inFlight(U.owner, finalSql, [L2.rid, L2.v, A], { isolation: "REPEATABLE READ" }); await t.rollback(); });
    const state = (await db.one("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2 ORDER BY seq DESC LIMIT 1", [L2.rid, L2.v])).state;
    return /^PT412:/.test(err ?? "") && state === "REVIEWED" && (await w1.finals(L2.rid)) === 0 ? true : { err, state };
  });
  let dFinal, manifestBefore;
  await kase("c2.finalize-commits-before-change", "FINAL holds the scope lock; the change waits, then commits; FINAL and its manifest are byte-identical afterwards, and the books now differ from the manifest", async () => {
    dFinal = await digest(A);
    const fin = await inFlight(U.owner, finalSql, [L2.rid, L2.v, A]);
    const writer = settle(asU(U.preparer, "SELECT public.rfr_register_input($1,$2,'evidence','EV-2',$3::jsonb,'manual',NULL,$4) r", [A, Y, JSON.stringify({ kind: "other_document", extraction: "human_confirmed", facts: { amount: "200" } }), uuid()]));
    const waits = await stillPending(writer, 1500);
    await fin.commit();
    const w = await writer;
    manifestBefore = await db.one("SELECT id, content_sha256, manifest_sha256, manifest::text AS m FROM public.rfr_finalization_manifests WHERE company_id=$1", [A]);
    const after = await digest(A);
    return waits && w.ok && w.v.r.outcome === "recorded" && fin.row.state === "FINAL" && (await w1.finals(L2.rid)) === 1 && manifestBefore.content_sha256 === dFinal && after !== dFinal
      && manifestBefore.manifest_sha256 === hex(manifestBefore.m) ? true : { waits, w, final: fin.row.state, m: manifestBefore?.content_sha256 === dFinal, changed: after !== dFinal };
  });

  // ── C4: every writer takes the scope lock ─────────────────────────────────────────────────────────────────────────────
  await kase("c4.every-writer-takes-the-scope-lock", "catalogue: every function that writes a manifest input takes _fs_scope_lock (or runs inside a transition that holds it) and the adjustment tables carry the lock trigger; behaviour: each writer WAITS while the scope lock is held", async () => {
    const writers = (await db.admin.query(`SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosrc ~ 'INSERT INTO public\\.rfr_(inputs|scope_events|corrections|source_attestations|runs)' ORDER BY 1`)).rows;
    const exempt = new Set(["rfr_propose_correction"]);   // its insert follows close_review_propose_adjustment, whose trigger takes the lock (checked below)
    const missing = writers.filter((w) => !exempt.has(w.proname) && !w.prosrc.includes("_fs_scope_lock")).map((w) => w.proname);
    const trig = (await db.admin.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_rfr_scope_lock_adjustments','trg_rfr_scope_lock_bindings','trg_rfr_scope_lock_events')`)).rows.map((r) => r.tgname).sort();
    // A proposal to decide while the lock is held.
    const prop = (await asU(U.preparer, "SELECT public.rfr_propose_correction($1,$2,'corr:c4:lock','payables',ARRAY['c4'],'Lock proof','proof',$3::jsonb,$4) r",
      [A, Y, JSON.stringify([{ accountKey: "1000", debitMinor: "100", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "100" }]), uuid()])).r;
    const lock = await db.pool.connect();
    await lock.query("BEGIN"); await lock.query("SELECT public._fs_scope_lock($1,$2)", [A, Y]);
    const probes = {
      register: settle(asU(U.preparer, "SELECT public.rfr_register_input($1,$2,'evidence','EV-C4',$3::jsonb,'manual',NULL,$4) r", [A, Y, JSON.stringify({ kind: "other_document", extraction: "human_confirmed", facts: {} }), uuid()])),
      withdraw: settle(asU(U.preparer, "SELECT public.rfr_withdraw_input($1,$2,'evidence','EV-1','Lock proof withdraw',$3) r", [A, Y, uuid()])),
      scope: settle(asU(U.preparer, "SELECT public.rfr_set_scope($1,$2,$3,$4,'{\"deposits\":true}'::jsonb,'Lock proof facts') r", [A, Y, ...SCOPE])),
      propose: settle(asU(U.preparer, "SELECT public.rfr_propose_correction($1,$2,'corr:c4:second','payables',ARRAY['c4b'],'Lock proof 2','proof',$3::jsonb,$4) r",
        [A, Y, JSON.stringify([{ accountKey: "1000", debitMinor: "50", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "50" }]), uuid()])),
      approve: settle(asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Approved under the lock proof',false,$2) r", [prop.adjustmentId, uuid()])),
      run: settle(db.asRole("service_role", null, "SELECT public.rfr_record_run($1,$2,$3,$4::jsonb) r", [A, Y, "0".repeat(64), JSON.stringify({ required_scopes: [], scopes: {}, finalization: {}, balances: {} })])),
      attest: settle(db.asRole("service_role", null, "SELECT public.rfr_record_source_attestation($1,$2,NULL,NULL,now()) r", [A, Y])),
    };
    await sleep(1200);
    const waiting = {};
    for (const [k, p] of Object.entries(probes)) waiting[k] = await stillPending(p, 50);
    await lock.query("ROLLBACK"); lock.release();
    const done = {};
    for (const [k, p] of Object.entries(probes)) done[k] = await p;
    const allWait = Object.values(waiting).every(Boolean);
    return missing.length === 0 && writers.length >= 4 && trig.length === 3 && allWait && done.approve.ok && done.approve.v.r.outcome === "recorded" ? true : { missing, writers: writers.map((w) => w.proname), trig, waiting, done: Object.fromEntries(Object.entries(done).map(([k, v]) => [k, v.ok ? (v.v?.r?.outcome ?? v.v?.[0]?.r?.outcome) : v.e])) };
  });

  await kase("c7.bound-evidence-retained", "the inputs bound by the FINAL manifest stay retrievable and unchangeable after the evidence is withdrawn and replaced; the manifest is immutable and names the content it bound", async () => {
    const bound = (await db.admin.query("SELECT id, family, key, payload_sha256 FROM public.rfr_inputs WHERE company_id=$1 AND period_year=$2 AND key='EV-1' ORDER BY seq", [A, Y])).rows;
    const w = (await asU(U.preparer, "SELECT public.rfr_withdraw_input($1,$2,'evidence','EV-1','Replacing the evidence after issue',$3) r", [A, Y, uuid()])).r;
    const re = await regEvidence(U.preparer, A, "EV-1", { amount: "999" });
    const after = (await db.admin.query("SELECT id, payload_sha256 FROM public.rfr_inputs WHERE id = ANY($1::uuid[])", [bound.map((b) => b.id)])).rows;
    const upd = await refusal(() => db.admin.query("UPDATE public.rfr_inputs SET payload='{}'::jsonb WHERE id=$1", [bound[0].id]));
    const del = await refusal(() => db.admin.query("DELETE FROM public.rfr_inputs WHERE id=$1", [bound[0].id]));
    const mupd = await refusal(() => db.admin.query("UPDATE public.rfr_finalization_manifests SET manifest='{}'::jsonb WHERE company_id=$1", [A]));
    const m = await db.one("SELECT manifest_sha256, manifest::text AS m, content_sha256 FROM public.rfr_finalization_manifests WHERE company_id=$1", [A]);
    return bound.length >= 1 && w.outcome === "recorded" && re.outcome === "recorded" && after.length === bound.length && after.every((a, i) => a.payload_sha256 === bound[i].payload_sha256)
      && /RFR_APPEND_ONLY/.test(upd ?? "") && /RFR_APPEND_ONLY/.test(del ?? "") && /RFR_APPEND_ONLY/.test(mupd ?? "") && m.manifest_sha256 === manifestBefore.manifest_sha256 && m.m === manifestBefore.m && m.content_sha256 === dFinal ? true : { bound, w, re, upd, del, mupd };
  });
  await kase("a6.next-version-sees-change", "a new version saved after the FINAL sees the later changes: the readiness blockers name RFR_MANIFEST_STALE", async () => {
    const L = await w1.draft("l3");
    const rd = await w1.readiness(L.rid, L.v);
    return rd.blockers.includes("RFR_MANIFEST_STALE") ? true : rd.blockers;
  });

  // ═════════════════════════════════════ World 2: QuickBooks-bound inputs — freshness is a separate attestation ═════════════════════════════════════
  group("World 2");
  let w2, L, glFp;
  const finalize2 = (rep) => refusal(() => asU(w2.U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Finalised for the proof')) r", [rep.rid, rep.v, w2.A]));
  const attest = (tbFp, glFingerprint, pulledAt) => db.asRole("service_role", null, "SELECT public.rfr_record_source_attestation($1,$2,$3,$4,$5) r", [w2.A, Y, tbFp, glFingerprint, pulledAt]).then((r) => r[0].r);
  await kase("setup.world2", "a second workspace whose ledger snapshot came from QuickBooks (service-role registration); the evaluation is READY and the draft is reviewed", async () => {
    w2 = await reportingWorld("w2");
    await asU(w2.U.preparer, "SELECT public.rfr_set_scope($1,$2,$3,$4,'{\"deposits\":false}'::jsonb,'Enable readiness for the pilot') r", [w2.A, Y, ...SCOPE]);
    const loaded = (await db.asRole("service_role", null, "SELECT public.rfr_load_inputs($1,$2) r", [w2.A, Y]))[0].r;
    const accounts = Object.fromEntries(loaded.accounts.map((a) => [a.key, (BigInt(a.debitMinor) - BigInt(a.creditMinor)).toString()]));
    const reg = (await db.asRole("service_role", null, "SELECT public.rfr_register_source_input($1,$2,$3,'ledger_snapshot','gl',$4::jsonb,NULL,$5) r", [w2.A, Y, w2.U.preparer, JSON.stringify({ snapshot: "qbo-pull-1", accounts, entries: [] }), uuid()]))[0].r;
    glFp = (await db.one("SELECT payload_sha256 FROM public.rfr_inputs WHERE company_id=$1 AND key='gl'", [w2.A])).payload_sha256;
    const r = await runReadinessCheck(serviceRpc, w2.A, Y);
    L = await w2.reviewed("q1");
    const nb = (await db.asRole("service_role", null, "SELECT * FROM public._rfr_bound_fingerprints($1,$2)", [w2.A, Y]))[0];
    return reg.outcome === "recorded" && r.outcome === "recorded" && r.result.scopes.ledger === "READY" && nb.qbo_bound === true && nb.gl_fingerprint === glFp ? true : { reg, r: r.outcome, scopes: r.result?.scopes, nb };
  });
  const dg = () => db.one("SELECT public.rfr_content_digest($1,$2) d", [w2.A, Y]).then((r) => r.d);
  await kase("f1.qbo-no-attestation-holds", "a QuickBooks-bound version with no source-freshness attestation cannot be finalized (RFR_SOURCE_FRESHNESS_UNDETERMINED)", async () => {
    const e = await finalize2(L);
    return /RFR_SOURCE_FRESHNESS_UNDETERMINED/.test(e ?? "") && (await w2.finals(L.rid)) === 0 ? true : e;
  });
  await kase("f2.qbo-expired-attestation-holds", "an attestation older than its ten minutes holds (RFR_SOURCE_FRESHNESS_STALE)", async () => {
    const a = await attest(null, glFp, new Date(Date.now() - 11 * 60_000));
    const e = await finalize2(L);
    return a.outcome === "confirmed" && /RFR_SOURCE_FRESHNESS_STALE/.test(e ?? "") ? true : { a, e };
  });
  await kase("f3.qbo-changed-source-holds", "a pull that finds the books changed is recorded as changed and holds (RFR_SOURCE_CHANGED); nothing is finalized", async () => {
    const a = await attest(null, "f".repeat(64), new Date(Date.now() - 30_000));
    const e = await finalize2(L);
    return a.outcome === "changed" && /RFR_SOURCE_CHANGED/.test(e ?? "") && (await w2.finals(L.rid)) === 0 ? true : { a, e };
  });
  let L2b;
  await kase("f4.qbo-attestation-for-other-content-holds", "a fresh, confirmed attestation made for the OLD content cannot finalize the changed books after they are re-reviewed (RFR_SOURCE_FRESHNESS_MISMATCH)", async () => {
    const before = await dg();
    const a = await attest(null, glFp, new Date(Date.now() - 20_000));
    await asU(w2.U.preparer, "SELECT public.rfr_register_input($1,$2,'evidence','EV-Q',$3::jsonb,'manual',NULL,$4) r", [w2.A, Y, JSON.stringify({ kind: "other_document", extraction: "human_confirmed", facts: { amount: "5" } }), uuid()]);
    const after = await dg();
    const r = await runReadinessCheck(serviceRpc, w2.A, Y);
    L2b = await w2.reviewed("q2");
    const e = await finalize2(L2b);
    return a.outcome === "confirmed" && before !== after && r.outcome === "recorded" && /RFR_SOURCE_FRESHNESS_MISMATCH/.test(e ?? "") && !/RFR_REVIEW_/.test(e ?? "") ? true : { a, before, after, e };
  });
  await kase("f5.identical-books-renew-without-rereview", "re-pulling IDENTICAL books registers nothing new (same content digest), a renewed attestation is bound to it, and the SAME review finalizes — no re-review", async () => {
    const d0 = await dg();
    const loaded = (await db.asRole("service_role", null, "SELECT public.rfr_load_inputs($1,$2) r", [w2.A, Y]))[0].r;
    const accounts = Object.fromEntries(loaded.accounts.map((a) => [a.key, (BigInt(a.debitMinor) - BigInt(a.creditMinor)).toString()]));
    const same = (await db.asRole("service_role", null, "SELECT public.rfr_register_source_input($1,$2,$3,'ledger_snapshot','gl',$4::jsonb,NULL,$5) r", [w2.A, Y, w2.U.preparer, JSON.stringify({ snapshot: "qbo-pull-1", accounts, entries: [] }), uuid()]))[0].r;
    const a = await attest(null, glFp, new Date(Date.now() - 5_000));
    const reviewsBefore = await db.count("SELECT count(*) n FROM public.rfr_reviews WHERE report_id=$1", [L2b.rid]);
    const fin = await asU(w2.U.owner, "SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,'FINAL','Finalised for the proof')) r", [L2b.rid, L2b.v, w2.A]);
    const m = await db.one("SELECT attestation_id, manifest FROM public.rfr_finalization_manifests WHERE company_id=$1", [w2.A]);
    return same.outcome === "unchanged" && d0 === await dg() && a.outcome === "confirmed" && fin.r.state === "FINAL" && reviewsBefore === 1 && (await db.count("SELECT count(*) n FROM public.rfr_reviews WHERE report_id=$1", [L2b.rid])) === 1
      && m.attestation_id === a.attestationId && /not detected/.test(m.manifest.sourceFreshness.note) ? true : { same, a, fin: fin.r.state, m };
  });
  await kase("f6.attestation-life-and-authority", "an attestation cannot outlive ten minutes (database constraint); a workspace with no QuickBooks input needs none and cannot record one", async () => {
    const life = await refusal(() => db.admin.query("INSERT INTO public.rfr_source_attestations (company_id, period_year, outcome, bound_content_sha256, pulled_at, expires_at) VALUES ($1,$2,'confirmed',$3, now(), now() + interval '11 minutes')", [w2.A, Y, "0".repeat(64)]));
    const notBound = (await db.asRole("service_role", null, "SELECT public.rfr_record_source_attestation($1,$2,NULL,NULL,now()) r", [A, Y]))[0].r;
    return /^23514:/.test(life ?? "") && notBound.outcome === "not_qbo_bound" ? true : { life, notBound };
  });

  const missing = CASES.map((c) => c.id).filter((id) => !recorded.some((r) => r.id === id));
  if (missing.length) throw new Error(`proof defect: cases never reached: ${missing.join(", ")}`);
}

main().then(async () => { writeResult(true, false); const ok = finish("readiness finalization", false); await db?.close(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error("CRASH:", e); writeResult(false, true, String(e?.message ?? e)); finish("readiness finalization", true); await db?.close(); process.exit(1); });
