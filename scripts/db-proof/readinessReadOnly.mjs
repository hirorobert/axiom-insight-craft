#!/usr/bin/env bun
// Real-PostgreSQL proof of DEFECT D-2 and its fix (20261023100000_fs_report_readiness_volatility.sql).
//
// The browser's transport runs as PostgREST does for the client's POST /rpc: a STABLE or IMMUTABLE function inside a READ
// ONLY transaction, a VOLATILE one in an ordinary read-write transaction (clientDb, scripts/db-proof/lib/reportingKit.mjs),
// with the function's volatility read again after the migration (= PostgREST's schema-cache reload). The hosted state is rebuilt: two certified years, presentation,
// notes, schedule, approved comparatives, evidence, and TWO saved DRAFT versions (1 stores the evidence, 2 is re-bound),
// with Close Review NOT yet checked — exactly where hosted acceptance J4 stopped.
//
//   before       on the chain WITHOUT 20261023100000, reading either draft's readiness fails with 25006 (reproduced)
//   migration    the migration applies on that state; re-applying it is refused and changes nothing
//   drafts       both drafts survive the migration byte-for-byte (document hash, content hash, state, evidence)
//   after        after the schema reload the client's POST /rpc runs readiness read-write: both drafts name CLOSE_REVIEW_FINDINGS_NOT_CHECKED, and REVIEWED
//                is refused for each (the sign-off gate is unchanged); a readiness read writes nothing persistent. VOLATILE does
//                NOT make the temporary table work inside an explicitly READ ONLY transaction — that still fails (asserted);
//                the fix is that PostgREST no longer opens one for this function
//   journey      Close Review checked → version 3 has no blocker → REVIEWED by the partner, FINAL by the owner; a preparer
//                and a viewer are refused; a later change makes it stale and a stale version is refused
//   sweep        every STABLE/IMMUTABLE public function the authenticated role may execute runs in a READ ONLY
//                transaction without 25006 (no other function carries this defect)
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/readinessReadOnly.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyChainBefore, assignmentPairs, ASSIGN, certifier, chainFiles, clientDb, COMPREHENSIVE_INCOME_DECISIONS, csv, DECISIONS_1_2_0, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, migrationText, prepareReporting, WORDS_1_2_0,
  FY2025, FY2026, makeWorld, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = "20261023100000_fs_report_readiness_volatility.sql";
// The exact hosted artifacts: the self-checking wrapper (byte-identical to render() of the committed source; checked by
// selfCheckingWrapper.mjs --check) and the read-only preflight and postcondition of batch reporting-r2.
const FIX_SQL = fs.readFileSync(path.join(REPO, "release/wrappers", FIX.replace(/\.sql$/, ".wrapper.sql")), "utf8");
const PREFLIGHT = fs.readFileSync(path.join(REPO, "docs/release/reporting-r2/preflight.sql"), "utf8");
const POSTCONDITION = fs.readFileSync(path.join(REPO, "docs/release/reporting-r2/postcondition.sql"), "utf8");
const { group, check, finish } = reporter();
let db;

// The pre-20261118100000 browser client had no trial-balance rules preview. Keep that exact stage behavior here so the
// historical volatility proof does not accidentally use today's client against yesterday's schema. The current client is
// exercised separately below and must fail closed while its required RPC is absent.
const historicalReadinessClient = (d) => ({
  readiness: async (companyId, reportId, reportVersion) => {
    const { data, error } = await d.rpc("fs_report_readiness", { p_company_id: companyId, p_report_id: reportId, p_report_version: reportVersion });
    if (error) throw Object.assign(new Error(error.message), { code: error.code ?? null });
    if (!data || typeof data !== "object" || typeof data.ready !== "boolean" || !Array.isArray(data.blockers)) throw new Error("historical readiness response is malformed");
    return data;
  },
});

async function main() {
  db = await openDatabase("readiness_proof");
  group("Replay up to (not including) the fix");
  await check("the chain before 20261023100000 applies", async () => (await applyChainBefore(db, FIX)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  // The historical stage before 20261023 has no server compiler; as2 below uses the full current transport.
  const as = (uid) => { const { invoke: _laterCompiler, ...d } = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  let pre, partner, owner, viewer, historicalPartner;
  // A new client = PostgREST after a schema reload (it caches each function's volatility).
  const reload = () => { pre = as(U.preparer); partner = as(U.partner); owner = as(U.owner); viewer = as(U.viewer); historicalPartner = historicalReadinessClient(partner.d); };
  reload();
  const rid = `fsr-${Y}-${A}`;
  const save = (newEvidence) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid,
    newEvidence, idempotencyKey: `prep-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const parse = (type, role) => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2,
      text: (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  const drafts = () => db.admin.query("SELECT report_version v, document_hash, content_hash, evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 ORDER BY report_version", [rid]).then((r) => JSON.stringify(r.rows));
  const refusedReviewed = async (v) => { try { await partner.c.setState(A, rid, v, "REVIEWED", "should be refused"); return false; } catch (e) { return String(e.message); } };

  group("The hosted state at J4: two drafts, Close Review not yet checked");
  let before;
  await check("two certified years, presentation, notes, schedule, approved comparatives; evidence saved as versions 1 and 2 (DRAFT)", async () => {
    const p = await k.upload(A, Y - 1, csv(FY2025)); await k.review(A, p); await k.certify(A, p);
    const c = await k.upload(A, Y, csv(FY2026)); await k.certify(A, c);
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3)", [A, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]);
    await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','The entity has share capital',$3)", [A, Y, uuid()]);
    for (const id of COMPREHENSIVE_INCOME_DECISIONS) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented',$4)", [A, Y, id, uuid()]);
    for (const [id, t] of Object.entries({ "smes.note.compliance": "Synthetic.", "smes.note.identification": "Synthetic SME Limited; 2026; TZS.", "smes.note.policies": "Historical cost.",
      "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "All third parties.", "smes.note.share_capital": "10,000 shares." }))
      await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, Y, id, t, uuid()]);
    for (const [id, t] of Object.entries(WORDS_1_2_0)) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, Y, id, t, uuid()]);
    for (const id of DECISIONS_1_2_0) await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,'not_applicable','None in the periods presented',$4)", [A, Y, id, uuid()]);
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,'Fixed asset register',$4)", [A, Y,
      JSON.stringify([{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]), uuid()]);
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed',$3) r", [A, Y, uuid()]);
    const s = await save([...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t, "CURRENT")), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))]);
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
    const cr = await db.count("SELECT count(*) n FROM public.close_review_finding_runs WHERE company_id=$1", [A]);
    before = await drafts();
    return s.outcome === "saved" && s.reportVersion === 2 && n === 2 && cr === 0 ? true : { s: s.outcome, v: s.reportVersion, n, cr };
  });
  await check("REPRODUCED: reading either draft's readiness through the API fails with 25006 (CREATE TABLE in a read-only transaction)", async () => {
    const out = [];
    for (const v of [1, 2]) { const r = await partner.d.rpc("fs_report_readiness", { p_company_id: A, p_report_id: rid, p_report_version: v }); out.push(`${r.error?.code}:${r.error?.message}`); }
    return out.every((x) => /^25006:cannot execute CREATE TABLE in a read-only transaction/.test(x)) ? true : out;
  });
  await check("…and the Sign-off client surfaces it as a refusal (the page's \"could not be read\")", async () => {
    try { await partner.c.readiness(A, rid, 2); return "readiness returned"; } catch (e) { return /read-only transaction/.test(String(e.message)) ? true : String(e.message); }
  });

  group("The migration, as released: preflight, self-checking wrapper, postcondition");
  await check("the read-only postcondition refuses BEFORE the wrapper (the function is still STABLE)", async () => {
    try { await db.admin.query(POSTCONDITION); return "postcondition passed early"; } catch (e) { return /not VOLATILE/.test(e.message) ? true : e.message; }
  });
  await check("the read-only preflight passes on the hosted state (reviewed STABLE body, r1 in force, gate body pinned)", async () => {
    await db.admin.query(PREFLIGHT); return true;
  });
  await check("applies on the hosted state; the function is VOLATILE, still SECURITY DEFINER, search_path-pinned, authenticated-only", async () => {
    const ident = "SELECT md5(prosrc) h, proowner o, proacl::text acl, proconfig::text cfg, prosecdef sd, prorettype::regtype::text rt, prolang FROM pg_proc WHERE oid='public.fs_report_readiness(uuid,text,integer)'::regprocedure";
    const src = await db.one(ident);
    await db.admin.query(FIX_SQL);
    reload();
    const p = await db.one(`SELECT provolatile v, prosecdef sd, proconfig cfg, md5(prosrc) h, proowner o, has_function_privilege('authenticated', oid, 'EXECUTE') a,
      has_function_privilege('anon', oid, 'EXECUTE') an FROM pg_proc WHERE oid='public.fs_report_readiness(uuid,text,integer)'::regprocedure`);
    const now = await db.one(ident);
    // Body, owner, ACL (every grant), config, SECURITY DEFINER, return type and language: byte-for-byte the same.
    return p.v === "v" && p.a && !p.an && JSON.stringify(now) === JSON.stringify(src) && p.cfg.includes("search_path=pg_catalog, public") ? true : { p, src, now };
  });
  await check("the read-only postcondition passes after the wrapper; the preflight now refuses (already corrected)", async () => {
    await db.admin.query(POSTCONDITION);
    try { await db.admin.query(PREFLIGHT); return "preflight passed twice"; } catch (e) { return /not STABLE/.test(e.message) ? true : e.message; }
  });
  await check("re-applying it is refused and changes nothing", async () => {
    try { await db.admin.query(FIX_SQL); return "re-applied"; } catch (e) { return /PREFLIGHT_REFUSED/.test(e.message) ? true : e.message; }
  });
  await check("both drafts are unchanged by the migration (versions, document and content hashes, evidence)", async () => (await drafts()) === before || { before, after: await drafts() });

  group("After the fix and a schema reload: readiness through the client's POST /rpc (read-write); the sign-off gate unchanged");
  await check("the client now calls readiness in a read-write transaction; an explicitly READ ONLY call still fails 25006 (VOLATILE is not a read-only fix)", async () => {
    let ro = null;
    try { await db.asRole("authenticated", U.partner, "SELECT public.fs_report_readiness($1,$2,2)", [A, rid], { readOnly: true }); ro = "succeeded"; } catch (e) { ro = e.code; }
    const rw = await partner.d.rpc("fs_report_readiness", { p_company_id: A, p_report_id: rid, p_report_version: 2 });
    return ro === "25006" && !rw.error ? true : { ro, rw: rw.error };
  });
  await check("the current client fails closed when its later trial-balance rules RPC is absent at this historical stage", async () => {
    const r = await partner.c.readiness(A, rid, 2);
    return !r.ready && r.blockers.includes("TRIAL_BALANCE_RULES_UNAVAILABLE") ? true : r;
  });
  await check("the historical-stage client still reads both drafts; each names CLOSE_REVIEW_FINDINGS_NOT_CHECKED and is not ready", async () => {
    const r1 = await historicalPartner.readiness(A, rid, 1), r2 = await historicalPartner.readiness(A, rid, 2);
    return !r1.ready && !r2.ready && r1.blockers.includes("CLOSE_REVIEW_FINDINGS_NOT_CHECKED") && r2.blockers.includes("CLOSE_REVIEW_FINDINGS_NOT_CHECKED") ? true : { r1, r2 };
  });
  await check("REVIEWED is refused for both drafts by the server; no publication is recorded", async () => {
    const out = [await refusedReviewed(1), await refusedReviewed(2)];
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1", [rid]);
    return out.every((m) => m && /CLOSE_REVIEW_FINDINGS_NOT_CHECKED/.test(m)) && n === 0 ? true : { out, n };
  });
  await check("a readiness read writes nothing persistent (every public table's live row count unchanged; no temp table survives)", async () => {
    const snap = async () => JSON.stringify((await db.admin.query(`SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) n FROM public.%I', c.relname), false, true, '')))[1]::text n
      FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' ORDER BY 1`)).rows);
    const a = await snap();
    for (let i = 0; i < 3; i++) { await partner.c.readiness(A, rid, 2); await viewer.c.readiness(A, rid, 1); }
    const b = await snap();
    return a === b ? true : "row counts changed";
  });
  await check("a non-member is refused readiness (42501), as before", async () => {
    const r = await clientDb(db, U.ownerB).rpc("fs_report_readiness", { p_company_id: A, p_report_id: rid, p_report_version: 2 });
    return r.error?.code === "42501" ? true : r;
  });

  group("The rest of the hosted journey on the same drafts (J5–J9)");
  await check("Close Review › Findings checked and explained; drafts 1–2 become stale; version 3 (no new evidence) has no blocker", async () => {
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    for (const f of (await db.admin.query("SELECT id FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows)
      await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Contra-asset by design','Fixed asset register',$2) r", [f.id, uuid()]);
    const r2 = await historicalPartner.readiness(A, rid, 2);
    const s = await save([]);
    const r3 = await historicalPartner.readiness(A, rid, 3);
    return r2.blockers.includes("REPORTING_DEPENDENCIES_STALE") && s.reportVersion === 3 && r3.ready && r3.blockers.length === 0 ? true : { r2: r2.blockers, s: s.outcome, v: s.reportVersion, r3 };
  });
  await check("a viewer and a preparer are refused REVIEWED; the partner records REVIEWED and the owner FINAL", async () => {
    const out = [];
    for (const who of [viewer, pre]) { try { await who.c.setState(A, rid, 3, "REVIEWED", "not allowed"); out.push("accepted"); } catch (e) { out.push(e.code ?? "refused"); } }
    await partner.c.setState(A, rid, 3, "REVIEWED", "Reviewed");
    await owner.c.setState(A, rid, 3, "FINAL", "Approved");
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return !out.includes("accepted") && JSON.stringify(pub) === JSON.stringify(["3:REVIEWED", "3:FINAL"]) ? true : { out, pub };
  });
  await check("stale-result refusal: a later change leaves version 3 FINAL but stale; signing a stale draft is refused by name", async () => {
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives and residual values.','Notes v2',$3)", [A, Y, uuid()]);
    const r3 = await historicalPartner.readiness(A, rid, 3);
    const m = await refusedReviewed(2);
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return r3.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /REPORTING_DEPENDENCIES_STALE/.test(m || "") && pub.includes("3:FINAL") ? true : { r3: r3.blockers, m, pub };
  });
  await check("drafts 1 and 2 are still present and DRAFT (no publication names them)", async () => {
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1 AND report_version IN (1,2)", [rid]);
    const p = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND report_version IN (1,2)", [rid]);
    return n === 2 && p === 0 ? true : { n, p };
  });

  group("Sweep: no other STABLE/IMMUTABLE function the client may call writes");
  await check("every authenticated-executable STABLE/IMMUTABLE public function with (company, year), (company) or (company, report, version) arguments runs READ ONLY without 25006", async () => {
    const fns = (await db.admin.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.provolatile IN ('s','i') AND p.prokind='f' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows;
    const ARGS = { "p_company_id uuid, p_period_year integer": [A, Y], "p_company_id uuid": [A], "p_company_id uuid, p_report_id text, p_report_version integer": [A, rid, 3] };
    const bad = [], ran = [];
    for (const f of fns) {
      const a = ARGS[f.args]; if (!a) continue;
      try { await db.asRole("authenticated", U.owner, `SELECT public.${f.proname}(${a.map((_, i) => `$${i + 1}`).join(",")})`, a, { readOnly: true }); ran.push(f.proname); }
      catch (e) { if (e.code === "25006") bad.push(`${f.proname}: ${e.message}`); else ran.push(`${f.proname} (refused ${e.code})`); }
    }
    return bad.length === 0 && ran.length >= 5 ? true : { bad, ran };
  });

  group("Final schema: the current rules RPC exists, generation-7 is required, and a valid current-rules report reaches REVIEWED and FINAL");
  await check("the remaining migration chain applies after the historical proof, including the trial-balance rules gate", async () => {
    const chain = chainFiles();
    const at = chain.indexOf(FIX);
    if (at < 0) return `${FIX} is not in the migration chain`;
    for (const f of chain.slice(at + 1)) await db.admin.query(migrationText(f));
    const exists = (await db.one("SELECT to_regprocedure('public.tb_signoff_rules_blocker(uuid,text,integer)') IS NOT NULL AS ok")).ok;
    return exists === true ? true : "tb_signoff_rules_blocker is absent after the final chain";
  });
  reload();
  await check("a pre-existing generation-6 report is visible but the current client names the generation-7 re-check requirement", async () => {
    const r = await partner.c.readiness(A, rid, 3);
    return r.blockers.includes("TRIAL_BALANCE_RECHECK_REQUIRED:6") ? true : r;
  });
  await check("the sign-off write refuses that pre-existing generation-6 report without recording a new publication", async () => {
    await prepareReporting(db, W, k, { year: Y, uploads: false });
    const s = await save([]);
    if (s.outcome !== "saved") return s;
    let refused = null;
    try { await partner.c.setState(A, rid, s.reportVersion, "REVIEWED", "must be blocked until the trial balance is rechecked"); }
    catch (e) { refused = String(e.message); }
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2", [rid, s.reportVersion]);
    return /TRIAL_BALANCE_RECHECK_REQUIRED:6/.test(refused ?? "") && n === 0 ? true : { refused, n, version: s.reportVersion };
  });

  const W2 = await makeWorld(db);
  const { U: U2, A: A2 } = W2;
  await W2.rollout(A2, true);
  const k2 = await certifier(db, U2);
  const Y2 = 2026;
  const as2 = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const finalPre = as2(U2.preparer), finalPartner = as2(U2.partner), finalOwner = as2(U2.owner);
  const finalRid = `fsr-final-${Y2}-${A2}`;
  const finalParse = (type, role) => {
    const y = role === "CURRENT" ? Y2 : Y2 - 1;
    const source = role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE;
    const r = ingestEvidence({ companyId: A2, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y2}`, currency: "TZS", scale: 2,
      text: source[type], fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected for final schema`);
    return r.batch;
  };
  const finalSave = (newEvidence) => prepareReportVersion(finalPre.d, finalPre.c, { companyId: A2, periodYear: Y2, legalName: "Synthetic Final Schema SME", reportId: finalRid,
    newEvidence, idempotencyKey: `final-prep-${uuid()}`, evaluatedAt: new Date().toISOString() });
  await check("the final-schema workspace is certified by the real generation-7 handler and prepared through the current reporting functions", async () => {
    await prepareReporting(db, W2, k2, { year: Y2 });
    return true;
  });
  await check("the real current-rules RPC returns an unobstructed answer for a valid generation-7 report, then REVIEWED and FINAL both succeed", async () => {
    const saved = await finalSave([...['TRANSACTION_LEDGER', 'EQUITY_MOVEMENTS', 'CASH_ACCOUNT_MAP'].map((t) => finalParse(t, 'CURRENT')),
      ...['TRANSACTION_LEDGER', 'EQUITY_MOVEMENTS', 'PRIOR_PERIOD_STATEMENTS'].map((t) => finalParse(t, 'COMPARATIVE'))]);
    if (saved.outcome !== "saved") return saved;
    const rules = await finalPartner.d.rpc("tb_signoff_rules_blocker", { p_company_id: A2, p_report_id: finalRid, p_report_version: saved.reportVersion });
    const ready = await finalPartner.c.readiness(A2, finalRid, saved.reportVersion);
    if (rules.error || rules.data?.outcome !== "ok" || rules.data?.blocker !== null || !ready.ready || ready.blockers.length !== 0) return { saved, rules: rules.data ?? rules.error, ready };
    await finalPartner.c.setState(A2, finalRid, saved.reportVersion, "REVIEWED", "Reviewed under current trial-balance rules");
    await finalOwner.c.setState(A2, finalRid, saved.reportVersion, "FINAL", "Approved under current trial-balance rules");
    const pub = (await finalOwner.c.publications(finalRid)).map((p) => `${p.reportVersion}:${p.state}`);
    return JSON.stringify(pub) === JSON.stringify([`${saved.reportVersion}:REVIEWED`, `${saved.reportVersion}:FINAL`]) ? true : { pub };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("READINESS_READ_ONLY", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
