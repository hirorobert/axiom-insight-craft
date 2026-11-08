#!/usr/bin/env bun
// BASELINE reproduction (no fix applied): can an authorised user with an OLD incorporation certificate and no earlier
// CFOClose trial balance suppress COMPARATIVE_PERIOD_MISSING, and does the complete sign-off path then reach FINAL?
// Uses only functions that exist on main and on the ready-for-reporting pilot head. Prints facts; asserts nothing.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/firstPeriodBypassReproduction.mjs
import { EVIDENCE_FY2026, FY2026, applyChain, certifier, chainFiles, clientDb, csv, DECISIONS_1_2_0, makeWorld, openDatabase, prepareReporting, uuid, WORDS_1_2_0 } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { withMissingComparativeDates } from "./lib/firstPeriodKit.mjs";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const out = [];
const say = (k, v) => { out.push([k, v]); console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`); };
const Y = 2026;
let db;
try {
  db = await openDatabase("fp_baseline");
  const bad = await applyChain(db);
  say("chain", bad ?? `applied ${chainFiles().length} migrations; head ${chainFiles().at(-1)}`);
  if (process.env.ISOLATE_CASHFLOW === "1") {
    // Disposable database only: take the cash-flow statement and its evidence out of the IFRS-for-SMEs requirement row, so the
    // comparative gate is the only thing under test (the product's cash-flow engine has no first-period path - see the PR).
    await db.admin.query("ALTER TABLE public.financial_statement_framework_requirements DISABLE TRIGGER trg_fsfr_immutable");
    await db.admin.query("UPDATE public.financial_statement_framework_requirements SET required_statement_types = array_remove(required_statement_types, 'STATEMENT_OF_CASH_FLOWS'), required_evidence_types = '{}' WHERE framework_kind = 'IFRS_FOR_SMES'");
    await db.admin.query("ALTER TABLE public.financial_statement_framework_requirements ENABLE TRIGGER trg_fsfr_immutable");
    say("isolation", "cash-flow statement and evidence types removed from the IFRS_FOR_SMES requirement row (disposable database)");
  }
  const W0 = await makeWorld(db);
  const { U } = W0;
  const N = await W0.company(U.owner, "Established SME Limited (incorporated 2018)");
  for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [N, U[k], k]);
  await W0.rollout(N, true);
  const W = { ...W0, A: N };
  const k = await certifier(db, U);
  // The ONLY trial balance CFOClose holds for this company is FY2026; the entity itself has existed since 2018.
  const up = await k.upload(N, Y, csv(FY2026)); await k.review(N, up); await k.certify(N, up);
  await prepareReporting(db, W, k, { year: Y, uploads: false, comparativesApproved: false });
  const as = (uid) => { const d = withMissingComparativeDates(clientDb(db, uid)); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const parse = (type) => {
    const r = ingestEvidence({ companyId: N, evidenceType: type, periodRole: "CURRENT", reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: EVIDENCE_FY2026[type], fileName: `${type.toLowerCase()}-${Y}.csv`, periodStart: `${Y}-01-01`, periodEnd: `${Y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected`);
    return r.batch;
  };
  const evidence = ["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map(parse);
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: N, periodYear: Y, legalName: "Established SME Limited", reportId: rid, newEvidence, idempotencyKey: `b-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });

  const rid = `rpt-fp-${uuid()}`;
  try { await pre.c.dependencies(N, Y); } catch (e) { say("dependencies parse issues", JSON.stringify(e.issues ?? String(e)).slice(0, 1500)); }
  try { await pre.c.input(N, Y); } catch (e) { say("input parse issues", JSON.stringify(e.issues ?? String(e)).slice(0, 1500)); }
  { const ri = (await db.asUser(U.owner, "SELECT public.fs_reporting_input($1,$2) r", [N, Y])).r; say("raw input comparative", JSON.stringify(ri.comparative)); say("raw input keys", Object.keys(ri)); }
  const r1 = await attempt(pre, rid, process.env.ISOLATE_CASHFLOW === "1" ? [] : evidence);
  say("v1 saved", r1.outcome + (r1.reportVersion ? ` v${r1.reportVersion}` : ` ${JSON.stringify(r1).slice(0, 300)}`));
  const rd1 = await partner.c.readiness(N, rid, r1.reportVersion);
  say("BEFORE declaration: readiness blockers", rd1.blockers);
  say("BEFORE declaration: COMPARATIVE_PERIOD_MISSING present", rd1.blockers.includes("COMPARATIVE_PERIOD_MISSING"));
  const cmp0 = (await db.asUser(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [N, Y]).catch((e) => ({ r: { error: e.message } }))).r;
  say("BEFORE declaration: comparatives state", cmp0?.comparative ? { state: cmp0.comparative.state, blockers: cmp0.comparative.blockers } : cmp0);

  // An authorised user (owner holds approve_certification) cites the 2018 certificate of incorporation.
  const decl = (await db.asUser(U.owner, "SELECT public.fs_declare_first_period($1,$2,true,'First period in CFOClose','certificate_of_incorporation','Certificate of incorporation no. 4471 (issued 2018)','2018-03-02') r", [N, Y])).r;
  say("declaration outcome (old certificate, entity incorporated 2018, period FY2026)", decl);
  const r2 = await attempt(pre, rid, []);
  say("v2 saved", r2.outcome + (r2.reportVersion ? ` v${r2.reportVersion}` : ` ${JSON.stringify(r2).slice(0, 300)}`));
  const rd2 = await partner.c.readiness(N, rid, r2.reportVersion);
  say("AFTER declaration: readiness blockers", rd2.blockers);
  say("AFTER declaration: COMPARATIVE_PERIOD_MISSING present", rd2.blockers.includes("COMPARATIVE_PERIOD_MISSING"));
  const cmp1 = (await db.asUser(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [N, Y]).catch((e) => ({ r: { error: e.message } }))).r;
  say("AFTER declaration: comparatives state", cmp1?.comparative ? { state: cmp1.comparative.state, blockers: cmp1.comparative.blockers, firstPeriodDeclared: cmp1.comparative.firstPeriodDeclared } : cmp1);

  // The complete sign-off path, separately.
  const refusal = async (fn) => { try { return await fn(); } catch (e) { return `REFUSED ${e.code ?? ""}: ${String(e.message).split("\n")[0].slice(0, 200)}`; } };
  const rv = await refusal(() => partner.c.setState(N, rid, r2.reportVersion, "REVIEWED", "Reviewed"));
  say("sign-off REVIEWED (partner)", typeof rv === "string" ? rv : rv.state);
  if (typeof rv !== "string") {
    const fin = await refusal(() => owner.c.setState(N, rid, r2.reportVersion, "FINAL", "Approved"));
    say("sign-off FINAL (owner)", typeof fin === "string" ? fin : fin.state);
  }
} catch (e) {
  say("CRASH", String(e?.stack ?? e).slice(0, 1500));
} finally {
  if (db) await db.close();
}
process.exit(0);
