#!/usr/bin/env bun
// Real-PostgreSQL proof that the HOSTED ACCEPTANCE fixture set (docs/release/acceptance-r1/, rendered by
// scripts/release/renderAcceptanceFixtures.mjs) carries the hosted journey end to end — read from the FILES a tester
// uploads, not from the proof kit's constants — for a dedicated engagement dated FY2025 (current) / FY2024 (comparative):
//
//   setup        both years certified from the fixture trial balances; presentation, decisions, wording and the PPE
//                schedule from the fixture files
//   sign-off     refused while Close Review has not been checked (CLOSE_REVIEW_FINDINGS_NOT_CHECKED) — the blocker the
//                released Close Review › Findings page clears; then REVIEWED and FINAL by role
//   figures      every row of EXPECTED_TOTALS.csv against the stored document (current and comparative)
//   stale        a later change leaves the signed version FINAL but stale; signing it again is refused
//   access       the same owner's company that is not on the rollout allow-list is refused by the server
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/acceptanceFixtures.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyChain, certifier, clientDb, makeWorld, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/release/acceptance-r1");
const file = (n) => fs.readFileSync(path.join(DIR, n), "utf8");
// The fixture CSVs carry no quoted fields (asserted below), so a plain split is exact.
const rows = (n) => { const [h, ...r] = file(n).trimEnd().split("\n"); return r.map((l) => Object.fromEntries(l.split(",").map((v, i) => [h.split(",")[i], v]))); };
const minor = (s) => BigInt(Math.round(Number(s) * 100));
const Y = 2025, P = 2024;

const { group, check, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("acceptance_proof");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const C = await W.company(U.owner, "Same owner, reporting not enabled");
  const k = await certifier(db, U);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const rid = `rpt-${A}-${Y}`;

  group("The fixture files");
  await check("no fixture CSV quotes a field (each is read by a plain split)", async () => fs.readdirSync(DIR).every((n) => !file(n).includes('"')) || "quoted field");
  await check("no fixture names FY2026 or a 2026 date", async () => fs.readdirSync(DIR).filter((n) => /2026/.test(n) || /\b2026-\d\d-\d\d\b/.test(file(n))) .length === 0 || "2026 present");

  // The read-only preflight a tester runs first (docs/release/sql/07_acceptance_preflight.sql), on the real schema.
  const PREFLIGHT = fs.readFileSync(path.join(DIR, "../sql/07_acceptance_preflight.sql"), "utf8");
  const preflight = async (company) => {
    const r = (await db.admin.query(PREFLIGHT.replaceAll("<DEMO_COMPANY_UUID>", company))).rows;
    return { verdict: r.find((x) => x.chk === "VERDICT").status, rows: r.map((x) => `${x.ord} ${x.status} ${x.chk}: ${x.detail}`) };
  };
  group("Preflight (read-only SQL)");
  await check("its fixture account list is exactly the accounts of account_classification.csv", async () => {
    const sql = [...PREFLIGHT.matchAll(/\('(9\d{4})'\)/g)].map((m) => m[1]).sort().join();
    const csvCodes = rows("account_classification.csv").map((r) => r["Account code"]).sort().join();
    return sql === csvCodes ? true : { sql, csvCodes };
  });
  await check("before setup: PATH_B (no certified dated year; 2024/2025 and the acceptance accounts unused)", async () => {
    const p = await preflight(A); return p.verdict === "PATH_B" ? true : p;
  });
  await check("a company that is not the one enabled company: BLOCKED (never prepare acceptance outside the allow-list)", async () => {
    const p = await preflight(C); return p.verdict === "BLOCKED" && p.rows.some((x) => x.startsWith("4 BLOCKED")) ? true : p;
  });

  group("Setup from the fixture files (dedicated FY2025/FY2024 engagement)");
  await check("FY2024 and FY2025 certified from the fixture trial balances; account review from account_classification.csv", async () => {
    // The professional account review a tester performs on Trial balance › Review, from account_classification.csv.
    const decisions = rows("account_classification.csv").map((r) => ({ account_code: r["Account code"], account_name: r["Account name"], proposal_type: "NONE",
      decision_action: "USER_MANUAL_CLASSIFICATION", statement: r.Statement, classification: r.Classification, normal_balance: r["Normal balance"], is_cash_account: r["Cash account"] === "yes" }));
    const p = await k.upload(A, P, file("trial_balance_FY2024_prior.csv"));
    await asU(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, p.id, uuid(), JSON.stringify(decisions)]);
    await k.certify(A, p);
    const c = await k.upload(A, Y, file("trial_balance_FY2025_current.csv")); await k.certify(A, c);
    return true;
  });
  await check("presentation from presentation_assignments.csv", async () => {
    const pairs = rows("presentation_assignments.csv").map((r) => ({ accountKey: r["Account code"], lineId: r["Presentation line"] }));
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Acceptance fixture r1 presentation',$3)", [A, JSON.stringify(pairs), uuid()]);
    return true;
  });
  await check("decisions, wording and the PPE schedule from the fixture files", async () => {
    for (const r of rows("decisions_FY2025.csv"))
      await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,$3,$4,$5,$6)", [A, Y, r.Requirement, r.Decision === "Applicable" ? "applicable" : "not_applicable", r.Reason, uuid()]);
    for (const r of rows("notes_wording_FY2025.csv"))
      await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Acceptance notes v1',$5)", [A, Y, r.Requirement, Object.values(r)[1], uuid()]);
    const s = rows("ppe_schedule_FY2025.csv")[0];
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,$4,$5)", [A, Y, JSON.stringify([{ classLabel: s.Class,
      openingMinor: String(minor(s["Opening carrying amount"])), closingMinor: String(minor(s["Closing carrying amount"])),
      movements: [{ kind: s.Movement.toLowerCase(), amountMinor: String(minor(s.Amount)) }] }]), s.Source, uuid()]);
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the FY2024 acceptance statements',$3) r", [A, Y, uuid()]);
    return true;
  });

  const parse = (n, type, role) => {
    const y = role === "CURRENT" ? Y : P;
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: file(n), fileName: n, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${n} rejected: ${r.diagnostics.map((x) => x.code).join(",")}`);
    return r.batch;
  };
  const evidence = () => [
    parse("evidence_FY2025_current_transaction_ledger.csv", "TRANSACTION_LEDGER", "CURRENT"),
    parse("evidence_FY2025_current_equity_movements.csv", "EQUITY_MOVEMENTS", "CURRENT"),
    parse("evidence_FY2025_current_cash_account_map.csv", "CASH_ACCOUNT_MAP", "CURRENT"),
    parse("evidence_FY2024_comparative_transaction_ledger.csv", "TRANSACTION_LEDGER", "COMPARATIVE"),
    parse("evidence_FY2024_comparative_equity_movements.csv", "EQUITY_MOVEMENTS", "COMPARATIVE"),
    parse("evidence_FY2024_comparative_prior_period_statements.csv", "PRIOR_PERIOD_STATEMENTS", "COMPARATIVE"),
  ];
  const save = (newEvidence) => prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Acceptance Synthetic Engagement", reportId: rid,
    newEvidence, idempotencyKey: `acc-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const latest = async () => (await owner.c.versions(A, Y)).filter((v) => v.isLatest).at(-1);

  group("Sign-off needs a checked Close Review");
  await check("evidence stored with a version; that version is blocked by CLOSE_REVIEW_FINDINGS_NOT_CHECKED and REVIEWED is refused", async () => {
    const s = await save(evidence());
    if (s.outcome !== "saved") return { s: s.outcome, d: s.diagnostics?.filter((x) => x.severity === "ERROR") };
    const v = (await latest()).reportVersion;
    const r = await partner.c.readiness(A, rid, v);
    let refused = false; try { await partner.c.setState(A, rid, v, "REVIEWED", "should be refused"); } catch { refused = true; }
    return r.blockers.includes("CLOSE_REVIEW_FINDINGS_NOT_CHECKED") && refused ? true : { blockers: r.blockers, refused };
  });
  await check("Close Review › Findings checked and its findings explained; the next version has no blocker", async () => {
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    for (const f of (await db.admin.query("SELECT id FROM public.close_review_findings WHERE run_id=$1", [run.runId])).rows)
      await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2025 (synthetic)',$2) r", [f.id, uuid()]);
    const s = await save([]);
    const v = (await latest()).reportVersion;
    const r = await partner.c.readiness(A, rid, v);
    return s.outcome === "saved" && r.blockers.length === 0 ? true : { s: s.outcome, v, blockers: r.blockers };
  });

  group("Figures — EXPECTED_TOTALS.csv against the stored document");
  let doc, signed;
  const dump = () => doc.statements.flatMap((s) => s.sections.flatMap((x) => x.lines.map((l) => `${s.type} ${l.lineId} ${l.factBindings.map((b) => b.periodId).join("/")}`)));
  const value = (type, re, period) => {
    const f = doc.statements.filter((s) => s.type === type).flatMap((s) => s.sections.flatMap((x) => x.lines)).filter((l) => re.test(l.lineId))
      .map((l) => l.factBindings.find((b) => b.periodId === period)?.factId).filter(Boolean).map((id) => doc.facts.find((x) => x.factId === id));
    return f.length ? BigInt(f[0].value.minorUnits.__bigint__ ?? f[0].value.minorUnits) : null;
  };
  // EXPECTED_TOTALS row → the statement and the document line that carries it.
  const LOCATE = {
    "Financial position|Total assets": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalAssetsMinor$/],
    "Financial position|Total equity": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalEquityMinor$/],
    "Financial position|Total liabilities": ["STATEMENT_OF_FINANCIAL_POSITION", /^line:sfp:total:totalLiabilitiesMinor$/],
    "Comprehensive income|Profit before tax": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:profitBeforeTaxMinor$/],
    "Comprehensive income|Profit for the period": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:profitOrLossMinor$/],
    "Comprehensive income|Total comprehensive income": ["STATEMENT_OF_PROFIT_OR_LOSS", /^line:sci:total:totalComprehensiveIncomeMinor$/],
    "Cash flows|Net cash from operating activities": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:operating:net$/],
    "Cash flows|Net cash from financing activities": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:financing:net$/],
    "Cash flows|Cash at the end of the period": ["STATEMENT_OF_CASH_FLOWS", /^line:cf:closing$/],
    "Changes in equity|Total equity at the end of the period": ["STATEMENT_OF_CHANGES_IN_EQUITY", /^line:eq:total-closing$/],
  };
  await check("every statement row of EXPECTED_TOTALS.csv equals the stored document (current and comparative)", async () => {
    signed = (await latest()).reportVersion;
    doc = (await owner.c.report(rid, signed)).document;
    const bad = [];
    for (const r of rows("EXPECTED_TOTALS.csv")) {
      const at = LOCATE[`${r.Statement}|${r.Line}`];
      if (!at) { if (r.Statement !== "PPE schedule") bad.push(`no locator for ${r.Statement} / ${r.Line}`); continue; }
      for (const [col, period] of [["FY2025 (current)", "CURRENT"], ["FY2024 (comparative)", "COMPARATIVE_1"]]) {
        if (!r[col]) continue;
        const got = value(at[0], at[1], period);
        if (got !== minor(r[col])) bad.push(`${r.Statement} / ${r.Line} / ${period}: expected ${r[col]}, got ${got === null ? "absent" : String(got)}`);
      }
    }
    if (bad.length) fs.writeFileSync(process.env.ACCEPTANCE_DUMP ?? "/dev/null", dump().join(String.fromCharCode(10)));
    return bad.length === 0 ? true : { bad };
  });
  await check("the PPE schedule row (closing 14,000.00) is the recorded schedule", async () => {
    const s = (await db.admin.query("SELECT closing_total::text c, opening_total::text o FROM public.fs_schedule_submissions WHERE company_id=$1 AND period_year=$2 AND schedule_id='ppe' ORDER BY seq DESC LIMIT 1", [A, Y])).rows[0];
    const exp = minor(rows("EXPECTED_TOTALS.csv").find((r) => r.Statement === "PPE schedule")["FY2025 (current)"]);
    return s && (minor(s.c) === exp || BigInt(s.c.split(".")[0]) === exp) ? true : s ?? "no schedule recorded";
  });

  group("Sign-off, then stale-result refusal");
  await check("REVIEWED by the partner, FINAL by the owner", async () => {
    await partner.c.setState(A, rid, signed, "REVIEWED", "Acceptance review");
    await owner.c.setState(A, rid, signed, "FINAL", "Acceptance approval");
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return JSON.stringify(pub) === JSON.stringify([`${signed}:REVIEWED`, `${signed}:FINAL`]) ? true : pub;
  });
  await check("a wording change leaves the signed version FINAL but stale; signing a stale version is refused", async () => {
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives and residual values (acceptance placeholder).','Acceptance notes v2',$3)", [A, Y, uuid()]);
    const r = await partner.c.readiness(A, rid, signed);
    // A stale version a reviewer has not yet signed: the version before the signed one was saved before Close Review.
    let refused = false; try { await partner.c.setState(A, rid, signed - 1, "REVIEWED", "stale"); } catch (e) { refused = /REPORTING_DEPENDENCIES_STALE/.test(String(e?.message)); }
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return r.blockers.includes("REPORTING_DEPENDENCIES_STALE") && refused && pub.includes(`${signed}:FINAL`) ? true : { blockers: r.blockers, refused, pub };
  });

  group("Preflight after the engagement exists");
  await check("PATH_A on FY2025 (a dated, certified year with its certified prior year); Path B now reports its years and accounts in use", async () => {
    const p = await preflight(A);
    return p.verdict === "PATH_A" && p.rows.some((x) => x.startsWith("6 OK") && x.includes("FY2025 2025-01-01..2025-12-31 TZS"))
      && p.rows.some((x) => x.startsWith("7 BLOCKED")) && p.rows.some((x) => x.startsWith("8 BLOCKED")) ? true : p;
  });

  group("A company the same owner can access, not on the rollout allow-list");
  await check("access reports NOT_ALLOWLISTED; reporting reads and writes are refused for it", async () => {
    const acc = (await asU(U.owner, "SELECT public.financial_statements_workspace_access($1) r", [C])).r;
    const o = clientDb(db, U.owner);
    const read = await o.rpc("fs_statement_composition", { p_company_id: C, p_period_year: Y });
    const write = await o.rpc("fs_assign_presentation", { p_company_id: C, p_assignments: [{ accountKey: "1000", lineId: "sfp.cash_and_cash_equivalents" }], p_reason: "should be refused", p_request_id: uuid() });
    return acc.enabled === false && acc.reason === "NOT_ALLOWLISTED" && (read.error || read.data?.state === "unavailable") && write.data?.outcome === "feature_disabled" ? true : { acc, read: read.error ?? read.data, write: write.error ?? write.data };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("ACCEPTANCE_FIXTURES", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
