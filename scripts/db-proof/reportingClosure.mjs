#!/usr/bin/env bun
// Real-PostgreSQL proof of the reporting closure (20261022100000 and the resumable save), through the browser's own
// client code (src/lib/reporting) where a page would act:
//
//   comprehensive income  5.5(e), (g), (h) undecided block; "not applicable" (with a reason) satisfies; "applicable" is
//                         UNSUPPORTED and refused by name at sign-off; 5.5(i) is composed only with no OCI, equals profit or
//                         loss (hand-computed) and is a bound figure; 5.5(i) itself cannot be decided by hand
//   two-step save         a failure after the evidence step (response lost, or the bind step never sent) leaves a version
//                         that cannot be signed; retrying the same attempt resumes it: no duplicate evidence, no extra
//                         version, every input binding kept; a concurrent save and a concurrent edit are absorbed
//   approver              every binding records the authenticated approver (user, membership, role, the display name on
//                         record — or none, never invented), the approval time and the server's document hash; a
//                         publication written without a session is refused
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/reportingClosure.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import { applyChain, certifier, clientDb, COMPREHENSIVE_INCOME_DECISIONS, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const { group, check, refused, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("closure_proof");
  group("Replay");
  await check("the whole chain applies, 20261022100000 included", async () => (await applyChain(db)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const decide = (id, decision, reason = "Decided from the engagement file") => asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6) r", [A, Y, id, decision, reason, uuid()]).then((r) => r.r);
  const notes = () => asU(U.owner, "SELECT public.fs_notes_status($1,$2) r", [A, Y]).then((r) => r.r);
  const req = (n, id) => n.requirements.find((r) => r.requirementId === id);
  const deps = () => asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y]).then((r) => r.r);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const text = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const versions = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const batches = () => db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [A]);
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);

  group("Setup through the real functions (the kit records the three Section 5 decisions as not applicable)");
  await check("prepared (certified years, presentation, Close Review, notes, schedules, comparatives approved)", async () => {
    await prepareReporting(db, W, k, { year: Y });
    return true;
  });

  group("Comprehensive income — decided, composed or refused by name; missing never means not applicable");
  await check("5.5(i) cannot be decided by hand (it follows (g) and (h)); only (e), (g), (h) take a decision", async () => {
    const r = await decide("smes.sci.5_5_i", "not_applicable");
    return r.outcome === "not_decidable" ? true : r;
  });
  await check("with no OCI and no discontinued operation: total comprehensive income is composed, 5,100.00 / 3,100.00 = profit or loss (hand-computed), and is a bound figure", async () => {
    const n = await notes();
    const i = req(n, "smes.sci.5_5_i");
    const d = await deps();
    const f = Object.fromEntries(d.figures.map((x) => [x.factId, x.amountMinor]));
    return i.status === "composed" && i.totalsMinor.current === "510000" && i.totalsMinor.comparative === "310000"
      && f["fact:current:total:totalComprehensiveIncomeMinor"] === "510000" && f["fact:comparative:total:totalComprehensiveIncomeMinor"] === "310000"
      && !d.blockers.some((b) => /smes\.sci\.5_5|COMPREHENSIVE/.test(b)) ? true : { i, blockers: d.blockers };
  });
  for (const [id, label] of [["smes.sci.5_5_g", "items of other comprehensive income"], ["smes.sci.5_5_e", "a discontinued operation"], ["smes.sci.5_5_h", "a share of associates' OCI"]]) {
    await check(`${label} present: the case is UNSUPPORTED, stated as such, and refused by name${id !== "smes.sci.5_5_e" ? "; total comprehensive income is not composed" : ""}`, async () => {
      await decide(id, "applicable", "Present in the periods presented");
      try {
        const n = await notes();
        const r = req(n, id), i = req(n, "smes.sci.5_5_i");
        const d = await deps();
        const ok = r.status === "unsupported" && /not supported/i.test(r.basis) && d.blockers.includes(`REPORTING_CASE_UNSUPPORTED:${id}`)
          && (id === "smes.sci.5_5_e" ? i.status === "composed" : i.status === "unsupported" && d.blockers.includes("REPORTING_CASE_UNSUPPORTED:smes.sci.5_5_i")
            && !d.figures.some((x) => x.factId.endsWith(":total:totalComprehensiveIncomeMinor")));
        return ok ? true : { r, i, blockers: d.blockers };
      } finally { await decide(id, "not_applicable", "Reconsidered: none in the periods presented"); }
    });
  }
  await check("a decision missing for the period blocks: a new year with nothing decided shows all three undecided and no total", async () => {
    // Another company-year where nothing is decided: FY2026 of the same company after withdrawing nothing is impossible
    // (decisions are history), so read the server's evaluation for an undecided year directly through its helper.
    const r = (await db.one("SELECT public._fs_comprehensive_income($1, 2031, public.fs_statement_composition($1, 2026)) r", [A])).r;
    const st = Object.fromEntries(r.requirements.map((x) => [x.requirementId, x.status]));
    return JSON.stringify(st) === JSON.stringify({ "smes.sci.5_5_e": "undecided", "smes.sci.5_5_g": "undecided", "smes.sci.5_5_h": "undecided", "smes.sci.5_5_i": "undecided" })
      && JSON.stringify(r.blockers) === JSON.stringify(COMPREHENSIVE_INCOME_DECISIONS.map((x) => `REQUIREMENT_UNDECIDED:${x}`)) ? true : r;
  });

  group("Two-step save — failure between the steps, retries, concurrency");
  // A transport that executes a call and then loses its response, or refuses to send it, at a chosen point.
  const faulty = (base, plan) => {
    let commits = 0;
    return { ...base, rpc: async (fn, args) => {
      if (fn === "fs_commit_revision") {
        commits += 1;
        if (plan.dropBeforeCommit === commits) return { data: null, error: { message: "network unreachable (injected; not sent)" } };
        const r = await base.rpc(fn, args);
        if (plan.loseResponseOfCommit === commits) return { data: null, error: { message: "connection reset (injected; the server committed)" } };
        return r;
      }
      return base.rpc(fn, args);
    } };
  };
  const ridR = `rpt-recover-${uuid()}`;
  const keyR = `attempt-${uuid()}`;
  const attempt = (d) => prepareReportVersion(d, signoffClient(d), { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridR, newEvidence: allEvidence(), idempotencyKey: keyR, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  await check("a failure AFTER the evidence step (its response lost): the stored-evidence version exists, is stale and cannot be signed", async () => {
    let threw = null;
    try { await attempt(faulty(pre.d, { loseResponseOfCommit: 1 })); } catch (e) { threw = e.message; }
    const n = await versions(ridR);
    const r1 = await readiness(ridR, 1);
    let refusal = null;
    try { await partner.c.setState(A, ridR, 1, "REVIEWED", "Attempted review of the evidence version"); } catch (e) { refusal = e.message; }
    return /connection reset/.test(threw ?? "") && n === 1 && r1.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /BLOCKED/.test(refusal ?? "") ? true : { threw, n, b: r1.blockers, refusal };
  });
  await check("retrying the same attempt resumes it: exactly one more version (bound, signable), no evidence duplicated, every input binding kept", async () => {
    const before = await batches();
    const r = await attempt(pre.d);
    const n = await versions(ridR);
    const v2 = await db.one("SELECT evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=2", [ridR]);
    const v1 = await db.one("SELECT evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=1", [ridR]);
    const ready = await readiness(ridR, 2);
    return r.outcome === "saved" && r.reportVersion === 2 && n === 2 && (await batches()) === before && v1.evidence_batch_ids.every((x) => v2.evidence_batch_ids.includes(x)) && ready.ready === true
      ? true : { r: r.outcome, v: r.reportVersion, n, before, after: await batches(), v1: v1.evidence_batch_ids, v2: v2.evidence_batch_ids, b: ready.blockers };
  });
  await check("retrying again (the bind step's response was also lost, or the person pressed save twice) writes nothing", async () => {
    const r = await attempt(pre.d);
    return r.outcome === "saved" && r.reportVersion === 2 && r.alreadyCurrent === true && (await versions(ridR)) === 2 ? true : { r, n: await versions(ridR) };
  });
  const ridS = `rpt-send-${uuid()}`;
  await check("a failure BEFORE the bind step is sent: the retry sends it once; still no duplicate evidence", async () => {
    // A new lineage whose first save needs no evidence step (all evidence is held): the bind step is commit #1.
    const before = await batches();
    let threw = null;
    const go = (d) => prepareReportVersion(d, signoffClient(d), { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridS, newEvidence: allEvidence(), idempotencyKey: `attempt-${ridS}`, evaluatedAt: "2027-02-03T09:00:00.000Z" });
    try { await go(faulty(pre.d, { dropBeforeCommit: 1 })); } catch (e) { threw = e.message; }
    const n0 = await versions(ridS);
    const r = await go(pre.d);
    return /network unreachable/.test(threw ?? "") && n0 === 0 && r.reportVersion === 1 && (await versions(ridS)) === 1 && (await batches()) === before ? true : { threw, n0, r, n: await versions(ridS) };
  });
  await check("a concurrent edit between the steps (a disclosure recorded): the bind step binds the newer dependencies", async () => {
    const rid = `rpt-edit-${uuid()}`;
    const key = `attempt-${rid}`;
    const ledger2 = ingestEvidence({ companyId: A, evidenceType: "CASH_ACCOUNT_MAP", periodRole: "CURRENT", reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2,
      text: "account_key,category,effect,include_in_cash_flow,note\n1000,BANK_ACCOUNT,ADD,Y,Main operating account (confirmed with the bank)\n", fileName: "cash-map-v2.csv" }).batch;
    const go = (d) => prepareReportVersion(d, signoffClient(d), { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence: [ledger2], idempotencyKey: key, evaluatedAt: "2027-02-04T09:00:00.000Z" });
    try { await go(faulty(pre.d, { loseResponseOfCommit: 1 })); } catch { /* the evidence step committed */ }
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.judgements','No judgements beyond the estimates note.','Notes v3',$3)", [A, Y, uuid()]);
    const r = await go(pre.d);
    const d = await deps();
    const bound = (await owner.c.report(rid, r.reportVersion)).document.reportingDependencies.dependenciesSha256;
    const ready = await readiness(rid, r.reportVersion);
    return bound === d.dependenciesSha256 && ready.ready === true ? true : { r, b: ready.blockers };
  });
  await check("two people save the same files at once: one version each step, the evidence stored once, the loser resumes on the winner", async () => {
    const rid = `rpt-race-${uuid()}`;
    const map3 = () => ingestEvidence({ companyId: A, evidenceType: "CASH_ACCOUNT_MAP", periodRole: "CURRENT", reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2,
      text: "account_key,category,effect,include_in_cash_flow,note\n1000,BANK_ACCOUNT,ADD,Y,Main operating account (bank letter 2027-01-31)\n", fileName: "cash-map-v3.csv" }).batch;
    const before = await batches();
    const go = (uid, key) => { const d = clientDb(db, uid); return prepareReportVersion(d, signoffClient(d), { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence: [map3()], idempotencyKey: key, evaluatedAt: "2027-02-05T09:00:00.000Z" }); };
    const res = await Promise.allSettled([go(U.preparer, `a-${rid}`), go(U.owner, `b-${rid}`)]);
    const losers = res.filter((x) => x.status === "rejected");
    for (const [i, x] of res.entries()) if (x.status === "rejected") await go(i === 0 ? U.preparer : U.owner, `${i === 0 ? "a" : "b"}-${rid}`);
    const added = (await batches()) - before;
    const latest = await db.one("SELECT max(report_version) v FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
    const ready = await readiness(rid, Number(latest.v));
    return added === 1 && ready.ready === true ? true : { added, latest: latest.v, losers: losers.map((x) => String(x.reason?.message ?? x.reason).slice(0, 120)), b: ready.blockers };
  });

  await check("an unsupported case blocks sign-off of a complete report by name (REVIEWED refused)", async () => {
    const rid = `rpt-ci-${uuid()}`;
    const s = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence: [], idempotencyKey: `k-${uuid()}`, evaluatedAt: "2027-02-01T09:00:00.000Z" });
    const ready = await readiness(rid, s.reportVersion);
    await decide("smes.sci.5_5_g", "applicable", "OCI on revaluation of property");
    try {
    const s2 = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence: [], idempotencyKey: `k-${uuid()}`, evaluatedAt: "2027-02-01T09:00:00.000Z" });
    const blocked = await readiness(rid, s2.reportVersion);
    let refusal = null;
    try { await partner.c.setState(A, rid, s2.reportVersion, "REVIEWED", "Attempted review with OCI present"); } catch (e) { refusal = e.message; }
    return ready.ready === true && blocked.blockers.includes("REPORTING_CASE_UNSUPPORTED:smes.sci.5_5_g") && blocked.blockers.includes("REPORTING_CASE_UNSUPPORTED:smes.sci.5_5_i") && /BLOCKED/.test(refusal ?? "")
      ? true : { ready: ready.blockers, blocked: blocked.blockers, refusal };
    } finally { await decide("smes.sci.5_5_g", "not_applicable", "Reconsidered: no revaluation in the periods presented"); }
  });

  group("The approver — authenticated, recorded, never invented");
  const ridA = `rpt-approver-${uuid()}`;
  await check("REVIEWED by the partner (display name on record) and FINAL by the owner (none on record): each binding carries the authenticated user, membership, role, name or NULL, time and the server's document hash", async () => {
    await db.admin.query("INSERT INTO public.profiles (user_id, display_name) VALUES ($1,'Pat Partner') ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name", [U.partner]);
    await db.admin.query("UPDATE public.profiles SET display_name = NULL WHERE user_id = $1", [U.owner]);
    const s = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridA, newEvidence: [], idempotencyKey: `k-${ridA}`, evaluatedAt: "2027-02-07T09:00:00.000Z" });
    await partner.c.setState(A, ridA, s.reportVersion, "REVIEWED", "Reviewed against the evidence");
    await owner.c.setState(A, ridA, s.reportVersion, "FINAL", "Approved for issue");
    const rows = (await db.admin.query(`SELECT b.state, b.approver_user_id, b.approver_firm_member_id, b.approver_role, b.approver_display_name, b.approved_at = p.created_at AS at_ok,
        b.document_sha256 = encode(sha256(convert_to(r.report_document::text,'UTF8')),'hex') AS hash_ok, m.user_id AS member_user
      FROM public.fs_publication_bindings b JOIN public.financial_statement_publications p ON p.id = b.publication_id
      JOIN public.financial_statement_reports r ON r.report_id = b.report_id AND r.report_version = b.report_version
      JOIN public.firm_members m ON m.id = b.approver_firm_member_id WHERE b.report_id = $1 ORDER BY b.seq`, [ridA])).rows;
    const [rv, fin] = rows;
    return rows.length === 2 && rv.approver_user_id === U.partner && rv.member_user === U.partner && rv.approver_display_name === "Pat Partner" && rv.approver_role === "partner"
      && fin.approver_user_id === U.owner && fin.member_user === U.owner && fin.approver_display_name === null && rows.every((x) => x.at_ok && x.hash_ok) ? true : rows;
  });
  await check("the record is readable by the company's members (the pack shows the recorded name), and is append-only", async () => {
    const b = await partner.c.bindings(ridA);
    let upd = null;
    try { await db.admin.query("UPDATE public.fs_publication_bindings SET approver_display_name = 'Someone else'"); } catch (e) { upd = e.code; }
    return b.length === 2 && b.some((x) => x.approverDisplayName === "Pat Partner") && b.some((x) => x.state === "FINAL" && x.approverDisplayName === null && x.approverRole) && upd === "42501" ? true : { b, upd };
  });
  const ridX = `rpt-noauth-${uuid()}`;
  let vX = 0;
  await check("a publication written without an authenticated session is refused and records nothing", async () => {
    vX = (await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridX, newEvidence: [], idempotencyKey: `k-${ridX}`, evaluatedAt: "2027-02-06T09:00:00.000Z" })).reportVersion;
    const member = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.partner])).id;
    let code = null;
    try { await db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'REVIEWED','bypass attempt here',$4)", [ridX, vX, A, member]); } catch (e) { code = e.code; }
    return ["PT409", "42501"].includes(code) && (await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1", [ridX])) === 0 ? true : code;
  });
  await check("a session that names ANOTHER member as the approver is refused (APPROVER_NOT_AUTHENTICATED), even on a current, ready version", async () => {
    const owners = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner])).id;
    const c = await db.pool.connect();
    let msg = null;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [U.partner]);
      await c.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,$2,$3,'REVIEWED','impersonation attempt',$4)", [ridX, vX, A, owners]);
    } catch (e) { msg = `${e.code}:${String(e.message).split(":")[0]}`; } finally { await c.query("ROLLBACK").catch(() => {}); c.release(); }
    return msg === "42501:APPROVER_NOT_AUTHENTICATED" ? true : msg;
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("REPORTING_CLOSURE", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
