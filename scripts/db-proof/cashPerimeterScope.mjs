#!/usr/bin/env bun
// Real-PostgreSQL proof of DEFECT D-3 and its fix: each period's cash accounts come from THAT period's authoritative
// reporting input (fs_reporting_input), never from the company's cash-flagged accounts at large.
//
// The hosted state is rebuilt from the acceptance fixture FILES (docs/release/acceptance-r1/): FY2025/FY2024 with the
// acceptance bank account 91000, PLUS earlier test data of the same company — accounts 1000 "Cash on hand" and 1010
// "Bank - CRDB current account" reviewed as cash in another year (FY2023), in neither of the report's trial balances.
//
//   reproduced   the pre-fix key source (company-wide account_mappings.is_cash_account) names 1000 and 1010; with it the
//                perimeter cannot be established and the map is not used — exactly the hosted v4 state
//   drafts       versions saved before the map are preserved byte for byte; certifications unchanged; 1000/1010 untouched
//   fix          the next version uses the map (stored, bound to the version), the perimeter is established, the
//                closing-cash and per-account roll-forward rules pass, every EXPECTED_TOTALS.csv row matches
//   sign-off     REVIEWED / FINAL; the export carries the cash-flow figures
//   stale        a later mapping change (91000 no longer reviewed as cash) invalidates the authority: the signed version is
//                stale and no new version is saved on it
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/cashPerimeterScope.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyChain, certifier, clientDb, makeWorld, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { cashScopeFromReportingInput, reviewedCashKeys } from "../../src/lib/reporting/cashScope.ts";
import { buildReportPack } from "../../src/lib/exports/reportPack.ts";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/release/acceptance-r1");
const file = (n) => fs.readFileSync(path.join(DIR, n), "utf8");
const rows = (n) => { const [h, ...r] = file(n).trimEnd().split("\n"); return r.map((l) => Object.fromEntries(l.split(",").map((v, i) => [h.split(",")[i], v]))); };
const minor = (s) => BigInt(Math.round(Number(s) * 100));
const Y = 2025, P = 2024;
const { group, check, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("cash_scope_proof");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const rid = `fsr-${Y}-${A}`;
  const review = (u, decisions) => asU(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, u.id, uuid(), JSON.stringify(decisions)]);
  const decision = (code, name, cls, st, nb, cash) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: cash });

  group("The hosted state: earlier test data (1000, 1010 cash in FY2023) and the FY2025/FY2024 acceptance engagement");
  let oldMappings;
  await check("FY2023 earlier test data: 1000 Cash on hand and 1010 Bank - CRDB reviewed as cash and certified", async () => {
    const u = await k.upload(A, 2023, "Account code,Account name,Debit,Credit\n1000,Cash on hand,500.00,\n1010,Bank - CRDB current account,1500.00,\n3001,Owner capital,,2000.00\n");
    await review(u, [decision("1000", "Cash on hand", "current_assets", "balance_sheet", "debit", true), decision("1010", "Bank - CRDB current account", "current_assets", "balance_sheet", "debit", true),
      decision("3001", "Owner capital", "equity", "balance_sheet", "credit", false)]);
    await k.certify(A, u);
    oldMappings = JSON.stringify((await db.admin.query("SELECT account_key, is_cash_account, classification, statement, updated_at FROM public.account_mappings WHERE company_id=$1 AND account_key IN ('1000','1010') ORDER BY 1", [A])).rows);
    return true;
  });
  await check("FY2024 and FY2025 certified from the fixture files; presentation, decisions, wording, schedule, comparatives, Close Review", async () => {
    const decisions = rows("account_classification.csv").map((r) => decision(r["Account code"], r["Account name"], r.Classification, r.Statement, r["Normal balance"], r["Cash account"] === "yes"));
    const p = await k.upload(A, P, file("trial_balance_FY2024_prior.csv")); await review(p, decisions); await k.certify(A, p);
    const c = await k.upload(A, Y, file("trial_balance_FY2025_current.csv")); await k.certify(A, c);
    const pairs = rows("presentation_assignments.csv").map((r) => ({ accountKey: r["Account code"], lineId: r["Presentation line"] }));
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Acceptance fixture r1 presentation',$3)", [A, JSON.stringify(pairs), uuid()]);
    for (const r of rows("decisions_FY2025.csv"))
      await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6)", [A, Y, r.Requirement, r.Decision === "Applicable" ? "applicable" : "not_applicable", r.Reason, uuid()]);
    for (const r of rows("notes_wording_FY2025.csv")) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Acceptance notes v1',$5)", [A, Y, r.Requirement, Object.values(r)[1], uuid()]);
    const s = rows("ppe_schedule_FY2025.csv")[0];
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,$4,$5)", [A, Y, JSON.stringify([{ classLabel: s.Class, openingMinor: String(minor(s["Opening carrying amount"])),
      closingMinor: String(minor(s["Closing carrying amount"])), movements: [{ kind: s.Movement.toLowerCase(), amountMinor: String(minor(s.Amount)) }] }]), s.Source, uuid()]);
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the FY2024 acceptance statements',$3) r", [A, Y, uuid()]);
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    for (const f of (await db.admin.query("SELECT id FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows)
      await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2025 (synthetic)',$2) r", [f.id, uuid()]);
    return true;
  });

  const parse = (n, type, role) => {
    const y = role === "CURRENT" ? Y : P;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: file(n), fileName: n, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${n} rejected: ${r.diagnostics.map((x) => x.code).join(",")}`);
    return r.batch;
  };
  const five = () => [parse("evidence_FY2025_current_transaction_ledger.csv", "TRANSACTION_LEDGER", "CURRENT"), parse("evidence_FY2025_current_equity_movements.csv", "EQUITY_MOVEMENTS", "CURRENT"),
    parse("evidence_FY2024_comparative_transaction_ledger.csv", "TRANSACTION_LEDGER", "COMPARATIVE"), parse("evidence_FY2024_comparative_equity_movements.csv", "EQUITY_MOVEMENTS", "COMPARATIVE"),
    parse("evidence_FY2024_comparative_prior_period_statements.csv", "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE")];
  const map = () => parse("evidence_FY2025_current_cash_account_map.csv", "CASH_ACCOUNT_MAP", "CURRENT");
  const save = (newEvidence) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "[DEMO] Acceptance Review", reportId: rid,
    newEvidence, idempotencyKey: `cs-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const latest = async () => (await owner.c.versions(A, Y)).filter((v) => v.isLatest).at(-1);
  const snapshot = async () => JSON.stringify({
    reports: (await db.admin.query("SELECT report_version, document_hash, content_hash, evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version <= 2 ORDER BY 1", [rid])).rows,
    certs: (await db.admin.query("SELECT id, upload_id, period_year, sequence_no FROM public.tb_certifications WHERE company_id=$1 ORDER BY sequence_no", [A])).rows,
  });

  group("REPRODUCED: the company-wide cash flags (the pre-fix key source)");
  await check("the company's cash-flagged accounts are 1000, 1010 and 91000; only 91000 is in the FY2025/FY2024 reporting input", async () => {
    const companyWide = (await pre.d.select("account_mappings", { company_id: A, is_cash_account: true })).data.map((r) => String(r.account_key)).sort();
    const input = await pre.c.input(A, Y);
    const scope = cashScopeFromReportingInput(input);
    return JSON.stringify(companyWide) === JSON.stringify(["1000", "1010", "91000"]) && JSON.stringify(reviewedCashKeys(scope.current)) === '["91000"]'
      && JSON.stringify(reviewedCashKeys(scope.comparative)) === '["91000"]' ? true : { companyWide, current: reviewedCashKeys(scope.current), prior: reviewedCashKeys(scope.comparative) };
  });
  await check("with those company-wide keys the perimeter is not established and the correct map is unused (the hosted v4 blocker)", async () => {
    const { applyEvidence } = await import("../../src/lib/financialGeneration/applyEvidence.ts");
    const s = await save(five());
    if (s.outcome !== "saved") return s;
    const doc = (await owner.c.report(rid, s.reportVersion)).document;
    const { deserializeReport } = await import("../../src/lib/financialStatementsWorkspace/persistenceContract.ts");
    const base = deserializeReport(JSON.stringify(doc));
    const r = applyEvidence({ report: { ...base, statements: base.statements.filter((x) => x.type !== "STATEMENT_OF_CASH_FLOWS") }, profile: (await import("../../src/lib/financialStatementsWorkspace/frameworkProfiles.ts")).FRAMEWORK_PROFILES.IFRS_FOR_SMES,
      evidence: [map()], cashAccountKeys: ["1000", "1010", "91000"] });
    const mapUse = r.use.find((u) => u.evidenceType === "CASH_ACCOUNT_MAP");
    return r.cashPerimeter?.status === "UNRESOLVED" && /Account 1000 is reviewed as a cash account/.test(r.cashPerimeter.reasons.join(" ")) && mapUse?.used === false ? true : { status: r.cashPerimeter?.status, reasons: r.cashPerimeter?.reasons, mapUse };
  });

  group("Drafts before the map: preserved");
  let before;
  await check("versions 1 and 2 are DRAFT without the cash account map (no perimeter, cash-flow statement evidence missing)", async () => {
    const r = await partner.c.readiness(A, rid, (await latest()).reportVersion);
    const map0 = await db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1 AND evidence_type='CASH_ACCOUNT_MAP'", [A]);
    before = await snapshot();
    return !r.ready && map0 === 0 ? true : { r, map0 };
  });

  group("The fix: the next version scopes the perimeter to the periods' own inputs");
  let v;
  await check("the map is used, STORED and BOUND to the new version; the perimeter is established", async () => {
    const s = await save([map()]);
    if (s.outcome !== "saved") return { s: s.outcome, reason: s.reason, d: s.diagnostics?.filter((x) => x.severity === "ERROR") };
    v = s.reportVersion;
    const stored = (await db.admin.query("SELECT evidence_batch_id FROM public.financial_evidence_batches WHERE company_id=$1 AND evidence_type='CASH_ACCOUNT_MAP'", [A])).rows.map((r) => r.evidence_batch_id);
    const bound = (await db.one("SELECT evidence_batch_ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, v])).evidence_batch_ids;
    const mapUse = s.use.find((u) => u.evidenceType === "CASH_ACCOUNT_MAP");
    return stored.length === 1 && bound.includes(stored[0]) && mapUse?.used === true && bound.length === 6 ? true : { stored, bound, mapUse };
  });
  await check("readiness: ready, no blocker; the closing-cash and per-account roll-forward rules PASS", async () => {
    const r = await partner.c.readiness(A, rid, v);
    const f = (await db.admin.query("SELECT findings FROM public.financial_statement_evaluations WHERE report_id=$1 AND report_version=$2", [rid, v])).rows[0].findings;
    const out = (id) => f.filter((x) => x.ruleId === id).map((x) => x.outcome);
    return r.ready && r.blockers.length === 0 && out("cashflow-closing-cash-reconciliation").every((o) => o === "PASS") && out("cashflow-closing-cash-reconciliation").length > 0
      && out("cashflow-account-rollforward").includes("PASS") && !f.some((x) => x.outcome === "FAIL" || x.outcome === "INSUFFICIENT_EVIDENCE") ? true
      : { r, bad: f.filter((x) => x.outcome !== "PASS" && x.outcome !== "NOT_APPLICABLE").map((x) => `${x.ruleId}:${x.outcome}`) };
  });
  let doc;
  await check("every EXPECTED_TOTALS.csv statement row equals the stored document, current and comparative", async () => {
    doc = (await owner.c.report(rid, v)).document;
    const LOC = {
      "Financial position|Total assets": /^line:sfp:total:totalAssetsMinor$/, "Financial position|Total equity": /^line:sfp:total:totalEquityMinor$/,
      "Financial position|Total liabilities": /^line:sfp:total:totalLiabilitiesMinor$/, "Comprehensive income|Profit before tax": /^line:sci:total:profitBeforeTaxMinor$/,
      "Comprehensive income|Profit for the period": /^line:sci:total:profitOrLossMinor$/, "Comprehensive income|Total comprehensive income": /^line:sci:total:totalComprehensiveIncomeMinor$/,
      "Cash flows|Net cash from operating activities": /^line:cf:operating:net$/, "Cash flows|Net cash from financing activities": /^line:cf:financing:net$/,
      "Cash flows|Cash at the end of the period": /^line:cf:closing$/, "Changes in equity|Total equity at the end of the period": /^line:eq:total-closing$/,
    };
    const value = (re, period) => {
      const id = doc.statements.flatMap((s) => s.sections.flatMap((x) => x.lines)).find((l) => re.test(l.lineId))?.factBindings.find((b) => b.periodId === period)?.factId;
      const f = id && doc.facts.find((x) => x.factId === id);
      return f ? BigInt(f.value.minorUnits.__bigint__ ?? f.value.minorUnits) : null;
    };
    const bad = [];
    for (const r of rows("EXPECTED_TOTALS.csv")) {
      const re = LOC[`${r.Statement}|${r.Line}`]; if (!re) continue;
      for (const [col, period] of [["FY2025 (current)", "CURRENT"], ["FY2024 (comparative)", "COMPARATIVE_1"]]) if (r[col] && value(re, period) !== minor(r[col])) bad.push(`${r.Line}/${period}: ${r[col]} vs ${value(re, period)}`);
    }
    return bad.length === 0 ? true : bad;
  });
  await check("drafts 1 and 2 and every certification are unchanged; accounts 1000 and 1010 untouched", async () => {
    const now = await snapshot();
    const old = JSON.stringify((await db.admin.query("SELECT account_key, is_cash_account, classification, statement, updated_at FROM public.account_mappings WHERE company_id=$1 AND account_key IN ('1000','1010') ORDER BY 1", [A])).rows);
    return now === before && old === oldMappings ? true : { same: now === before, oldSame: old === oldMappings };
  });

  group("Sign-off and export");
  await check("REVIEWED by the partner, FINAL by the owner; the sealed pack carries the cash-flow figures", async () => {
    await partner.c.setState(A, rid, v, "REVIEWED", "Acceptance review");
    await owner.c.setState(A, rid, v, "FINAL", "Acceptance approval");
    const b = (await owner.c.bindings(rid)).find((x) => x.state === "FINAL");
    const { deserializeReport } = await import("../../src/lib/financialStatementsWorkspace/persistenceContract.ts");
    const pack = buildReportPack({ document: deserializeReport(JSON.stringify(doc)), entityName: "[DEMO] Acceptance Review", editionTitle: "IFRS for SMES (2015 edition)", adjustments: [],
      signOff: { state: "FINAL", signedAt: "2026-10-09T12:00:00Z", signedBy: "Owner", contentHash: b.documentSha256, dependenciesSha256: b.dependenciesSha256 } });
    return b && pack.html.includes(b.documentSha256) && pack.csv.includes("6,200.00") && pack.csv.includes("12,500.00") ? true : { b: !!b, csv: pack.csv.split("\n").slice(0, 6) };
  });

  group("A later mapping change");
  await check("91000 no longer reviewed as cash: the authority is invalidated, the FINAL version is stale and no new version is saved on it", async () => {
    const cert = (await db.one("SELECT upload_id FROM public.get_authoritative_certification($1,$2)", [A, Y])).upload_id;
    await review({ id: cert }, [decision("91000", "Bank (acceptance r1)", "current_assets", "balance_sheet", "debit", false)]);
    const r = await partner.c.readiness(A, rid, v);
    const s = await save([]);
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return !r.ready && r.blockers.some((b) => /STALE|NO_AUTHORITY|INPUT/.test(b)) && s.outcome !== "saved" && pub.includes(`${v}:FINAL`) ? true : { blockers: r.blockers, s: s.outcome, reason: s.reason, pub };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("CASH_PERIMETER_SCOPE", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
