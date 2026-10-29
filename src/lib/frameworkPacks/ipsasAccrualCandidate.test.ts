/** No hosted access, external network, provider call, or accounting-validation assertion. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareNgo } from "../../../release/candidates/ipsas-accrual-r1/preparation";
import { resolveIpsasProfile } from "../../../release/candidates/ipsas-accrual-r1/profile";
import { prepareFixedGrant, prepareFx, prepareBudget } from "../../../release/candidates/ipsas-accrual-r1/ngoCalculations";
import { TOPICS } from "../../../release/candidates/ipsas-accrual-r1/inventory";
import { jsonSnapshot } from "../../../release/candidates/ipsas-accrual-r1/contracts";
import { ipsasProofAdapter } from "../../../release/candidates/ipsas-accrual-r1/adapter";
import { createProofRegistry, type KernelSnapshot } from "../../../release/candidates/framework-kernel-r1/kernel";
import { canonicalStringify } from "@/lib/canonicalStatement/serialization";
import { CANONICAL_CONCEPTS as C } from "@/lib/canonicalStatement/concepts";
import { evaluateComposedReport } from "@/lib/financialGeneration/composedReport";

const ROOT = path.resolve(__dirname, "../../..");
const DIR = path.join(ROOT, "docs/release/ipsas-accrual-r1/fixtures");
const fixture = () => JSON.parse(fs.readFileSync(path.join(DIR, "synthetic-ngo.json"), "utf8"));
const input = () => fixture().input;
function profileAt(start: string, end: string) {
  const p = input().profile;
  p.period = { start, end }; p.comparative = { start: `${Number(start.slice(0,4))-1}${start.slice(4)}`, end: `${Number(end.slice(0,4))-1}${end.slice(4)}` };
  for (const e of [p.jurisdictionEvidence, p.entityEvidence, p.transition.evidence]) e.period = p.period;
  p.initialApplications = { leases43: start >= "2025-01-01" ? "2025-07-01" : null, ppe45: start >= "2025-01-01" ? "2025-07-01" : null,
    revenue47: start >= "2026-01-01" ? start : null, transfers48: start >= "2026-01-01" ? start : null };
  if (start >= "2026-01-01") { p.transition.revenue47 = "cumulative-effect"; p.transition.transfers48 = "prospective"; }
  return p;
}
const evidence = () => input().evidence.find(e => e.id === "management-current");
function fx() {
  return { ...input().scope, itemId: "USD-bank", evidence: [evidence()], foreignCurrency: "USD", foreignScale: 2, foreignMinor: "10000", carryingFunctionalMinor: "24000000",
    nature: "asset", measurement: "monetary", recognitionDate: "2025-07-01", rateDate: "2026-06-30", rateNumerator: "2500", rateDenominator: "1", rounding: "HALF_UP" };
}

describe("IPSAS effective-period and adoption routing", () => {
  it.each([
    ["2024-07-01", "2025-06-30", "IPSAS17", "IPSAS13", "IPSAS23"],
    ["2025-07-01", "2026-06-30", "IPSAS45", "IPSAS43", "IPSAS23"],
    ["2026-07-01", "2027-06-30", "IPSAS45", "IPSAS43", "IPSAS47"],
  ])("routes the period starting %s, not the year-end label", (start,end,ppe,leases,revenue) => {
    const r = resolveIpsasProfile(profileAt(start,end));
    expect(r.selected.ppe).toBe(ppe); expect(r.selected.leases).toBe(leases); expect(r.selected.revenue).toContain(revenue);
    expect(r.publicationAuthorized).toBe(false);
  });
  it("accepts an evidenced non-public budget assessment rather than excluding the NGO", () => {
    const p = input().profile; p.publicBudget = "no";
    expect(resolveIpsasProfile(p).budgetComparison).toBe("not-applicable-by-recorded-assessment");
  });
  it("requires an answer when public-budget applicability is unknown", () => {
    const p = input().profile; p.publicBudget = "unresolved";
    expect(resolveIpsasProfile(p).blockers).toContain("BUDGET_APPLICABILITY_REQUIRED");
  });
  it.each(["2026-02-30", "2025-13-01", "2025-7-1", "", null])("refuses invalid start %s", start => {
    const p = input().profile; p.period.start = start; expect(() => resolveIpsasProfile(p)).toThrow();
  });
  it.each([
    ["basis","cash","ACCRUAL_BASIS_REQUIRED"], ["adoption","first-time","FIRST_TIME_ADOPTION_WORKPAPER_REQUIRED"],
    ["adoption","unresolved","ADOPTION_HISTORY_REQUIRED"], ["groupAssessment","group","GROUP_PREPARATION_NOT_IMPLEMENTED"],
    ["groupAssessment","unresolved","GROUP_ASSESSMENT_REQUIRED"], ["functionalCurrency","USD","FUNCTIONAL_TO_PRESENTATION_TRANSLATION_NOT_IMPLEMENTED"],
  ])("refuses unsupported or undecided %s=%s", (key,value,reason) => {
    const p = input().profile; p[key] = value; expect(() => resolveIpsasProfile(p)).toThrow(reason);
  });
  it("does not select an unreviewed future-period profile", () => {
    expect(() => resolveIpsasProfile(profileAt("2027-07-01","2028-06-30"))).toThrow("PERIOD_PROFILE_NOT_REVIEWED");
  });
  it("does not implement the concessionary amendment package by enabling a flag", () => {
    const p = input().profile; p.elections.concessionary2027 = evidence();
    expect(() => resolveIpsasProfile(p)).toThrow("CONCESSIONARY_2027_PROFILE_NOT_IMPLEMENTED");
  });
  it("enforces dependencies for early PPE adoption", () => {
    const p = profileAt("2024-07-01","2025-06-30"); p.elections.ppe45 = p.entityEvidence;
    expect(() => resolveIpsasProfile(p)).toThrow("PPE_EARLY_APPLICATION_PACKAGE_INCOMPLETE");
  });
  it("does not allow early IPSAS48 without IPSAS47", () => {
    const p = input().profile; p.elections.transfers48 = evidence();
    expect(() => resolveIpsasProfile(p)).toThrow("IPSAS48_REQUIRES_IPSAS47");
  });
  it("requires the revenue and transfer transition choices at initial application", () => {
    const p = profileAt("2026-07-01","2027-06-30"); p.transition.revenue47 = null; p.transition.transfers48 = null;
    expect(resolveIpsasProfile(p).blockers).toEqual(expect.arrayContaining(["TRANSITION_CHOICE_AND_EVIDENCE_REQUIRED:revenue47","TRANSITION_CHOICE_AND_EVIDENCE_REQUIRED:transfers48"]));
  });
  it("refuses an initial-application date in a future period", () => {
    const p = input().profile; p.initialApplications.leases43 = "2027-07-01";
    expect(() => resolveIpsasProfile(p)).toThrow("INITIAL_APPLICATION_AFTER_REPORTING_START");
  });
  it("requires a real comparative boundary, not an overlapping or skipped year", () => {
    const p = input().profile; p.comparative.end = p.period.end;
    expect(() => resolveIpsasProfile(p)).toThrow("COMPARATIVE_OVERLAPS_CURRENT");
    p.comparative.end = "2023-06-30"; p.comparative.start = "2022-07-01";
    expect(() => resolveIpsasProfile(p)).toThrow("COMPARATIVE_PERIOD_ADJACENCY_REQUIRED");
  });
});

describe("evidenced fixed-grant preparation", () => {
  it("releases only the evidenced satisfaction, not the amount spent or received", () => {
    const g = input().grants[0]; const r = prepareFixedGrant(g);
    expect(r).toMatchObject({standard:"IPSAS23",periodRevenueMinor:"1200000",remainingObligationMinor:"100000",publicationAuthorized:false});
  });
  it("does not turn a restriction alone into an obligation", () => {
    const g = input().grants[0]; g.classification = "restriction-only"; g.obligations = [];
    expect(prepareFixedGrant(g)).toMatchObject({cumulativeRevenueMinor:"1300000",remainingObligationMinor:"0"});
  });
  it("routes the new binding-arrangement model by the period", () => {
    const g = input().grants[0]; g.profile = profileAt("2026-07-01","2027-06-30"); g.evidence.forEach(e => e.period = g.profile.period); g.classification = "binding-arrangement";
    expect(prepareFixedGrant(g)).toMatchObject({standard:"IPSAS47",periodRevenueMinor:"1200000",remainingObligationMinor:"100000"});
  });
  it.each(["variableConsideration","financing","agent","nonCash","modification","creditLoss"])("requires a governed workpaper for %s", key => {
    const g = input().grants[0]; g.complexities[key] = true; expect(() => prepareFixedGrant(g)).toThrow("COMPLEX_GRANT_WORKPAPER_REQUIRED");
  });
  it("refuses an unassessed grant, partial funding, over-allocation and over-satisfaction", () => {
    const g = input().grants[0]; g.classification = "unresolved"; expect(() => prepareFixedGrant(g)).toThrow("GRANT_TERMS_ASSESSMENT_REQUIRED");
    g.classification = "enforceable-condition"; g.recognisedResourcesMinor = "1200000"; expect(() => prepareFixedGrant(g)).toThrow("NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED");
    g.recognisedResourcesMinor = "1300000"; g.obligations[0].allocatedMinor = "900000"; expect(() => prepareFixedGrant(g)).toThrow("OBLIGATION_ALLOCATION_MISMATCH");
    g.obligations[0].allocatedMinor = "800000"; g.obligations[0].satisfiedMinor = "800001"; expect(() => prepareFixedGrant(g)).toThrow("OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION");
  });
  it("refuses mismatched period classification, duplicate obligations and missing evidence", () => {
    const g = input().grants[0]; g.classification = "binding-arrangement"; expect(() => prepareFixedGrant(g)).toThrow("GRANT_CLASSIFICATION_PERIOD_MISMATCH");
    g.classification = "enforceable-condition"; g.obligations[1].id = g.obligations[0].id; expect(() => prepareFixedGrant(g)).toThrow("DUPLICATE_GRANT_OBLIGATION");
    g.obligations[1].id = "different"; g.obligations[1].evidenceId = "missing"; expect(() => prepareFixedGrant(g)).toThrow("OBLIGATION_EVIDENCE_MISSING");
  });
});

describe("foreign-currency preparation is exact and measurement-specific", () => {
  it("translates a monetary asset and distinguishes the gain from the liability loss", () => {
    const a = fx(); expect(prepareFx(a)).toMatchObject({functionalMinor:"25000000",exchangeGainMinor:"1000000"});
    a.nature = "liability"; expect(prepareFx(a).exchangeGainMinor).toBe("-1000000");
  });
  it("supports fractional rates and different currency precision without floats", () => {
    const a = fx(); a.foreignMinor = "12345"; a.rateNumerator = "25005"; a.rateDenominator = "10"; a.scale = 0;
    expect(prepareFx(a).functionalMinor).toBe("308687");
  });
  it("does not retranslate a non-monetary historical-cost item at the closing rate", () => {
    const a = fx(); a.measurement = "non-monetary-historical";
    expect(() => prepareFx(a)).toThrow("HISTORICAL_RATE_DATE_REQUIRED");
    a.rateDate = a.recognitionDate; a.rateNumerator = "2400";
    expect(prepareFx(a).exchangeGainMinor).toBe("0");
    a.carryingFunctionalMinor = "0"; expect(() => prepareFx(a)).toThrow("HISTORICAL_CARRYING_AMOUNT_MISMATCH");
  });
  it("refuses a stale monetary rate, non-monetary current value and overflowing output", () => {
    const a = fx(); a.rateDate = "2026-06-29"; expect(() => prepareFx(a)).toThrow("CLOSING_RATE_DATE_REQUIRED");
    a.rateDate = "2026-06-30"; a.measurement = "non-monetary-current-value"; expect(() => prepareFx(a)).toThrow("CURRENT_VALUE_FX_WORKPAPER_REQUIRED");
    a.measurement = "monetary"; a.foreignMinor = "9".repeat(31); a.rateNumerator = "9".repeat(25); expect(() => prepareFx(a)).toThrow("TRANSLATED_AMOUNT_RANGE_EXCEEDED");
  });
  it.each(["rateNumerator","rateDenominator"])("never invents a missing or zero %s", key => {
    const a = fx(); a[key] = "0"; expect(() => prepareFx(a)).toThrow(); a[key] = null; expect(() => prepareFx(a)).toThrow();
  });
});

describe("budget comparison and basis reconciliation", () => {
  it("reconciles the synthetic cash-basis budget to all three cash-flow activity anchors", () => {
    expect(prepareBudget(input().budget)).toMatchObject({state:"reconciled",blockers:[]});
  });
  it("keeps a genuine zero base distinct from an undefined percentage", () => {
    const b = input().budget; b.rows[0].originalMinor = "0"; b.rows[0].finalMinor = "0"; b.rows[0].varianceAssessment = "material"; b.rows[0].varianceExplanation = "SYNTHETIC unexpected grant receipt.";
    const r = prepareBudget(b); expect(r.rows[0]).toMatchObject({varianceMinor:"1300000",variancePercentHundredths:null});
  });
  it("requires materiality decisions, variance explanations and original-to-final revision explanations", () => {
    const b = input().budget; b.rows[0].finalMinor = "1400000"; b.rows[0].revisionExplanation = null;
    expect(prepareBudget(b).blockers).toContain("BUDGET_VARIANCE_ASSESSMENT_REQUIRED:grant");
    b.rows[0].varianceAssessment = "material"; expect(prepareBudget(b).blockers).toContain("BUDGET_VARIANCE_EXPLANATION_REQUIRED:grant");
    b.rows[0].finalMinor = "1300000"; expect(prepareBudget(b).blockers).toContain("BUDGET_REVISION_EXPLANATION_REQUIRED:grant");
  });
  it("refuses duplicate anchors; exposes an unexplained basis difference without a plug", () => {
    const b = input().budget; b.anchors[1].name = "operating";
    expect(() => prepareBudget(b)).toThrow("BUDGET_RECONCILIATION_ANCHORS_REQUIRED");
    b.anchors[1].name = "investing"; b.anchors[0].financialStatementMinor = "800001";
    const r = prepareBudget(b); expect(r.blockers).toContain("BUDGET_BASIS_BRIDGE_DIFFERENCE:operating"); expect(r.reconciliations[0].differenceMinor).toBe("-1");
  });
  it("requires five anchors for an accrual budget, not just the cash total", () => {
    const b = input().budget; b.budgetBasis = "accrual";
    expect(() => prepareBudget(b)).toThrow("BUDGET_RECONCILIATION_ANCHORS_REQUIRED");
    b.anchors.push({name:"revenue",financialStatementMinor:"1200000",evidenceId:b.completenessEvidenceId,bridge:[{id:"grant-deferral",amountMinor:"-100000",kind:"basis",reason:"Synthetic deferred grant obligation",evidenceId:b.completenessEvidenceId}]});
    b.anchors.push({name:"expense",financialStatementMinor:"700000",evidenceId:b.completenessEvidenceId,bridge:[{id:"depreciation",amountMinor:"200000",kind:"basis",reason:"Synthetic non-cash depreciation",evidenceId:b.completenessEvidenceId}]});
    expect(prepareBudget(b).blockers).toEqual([]);
  });
  it("does not turn an internal donor budget into an IPSAS24 statement", () => {
    const b = input().budget; b.publiclyAvailable = "no";
    expect(() => prepareBudget(b)).toThrow("SUPPLEMENTARY_DONOR_BUDGET_IS_NOT_IPSAS24");
    b.rows=[]; b.anchors=[]; expect(prepareBudget(b).state).toBe("not-applicable");
  });
});

describe("complete synthetic source pipeline and adversarial evidence", () => {
  it("equals the independently written current/comparative workings; never authorises publication", () => {
    const f=fixture(), r=prepareNgo(f.input);
    expect(r.current.totals).toEqual(f.expected.current); expect(r.comparative!.totals).toEqual(f.expected.comparative);
    expect(r.current.cashFlow.closingMinor).toBe(f.expected.currentCashClosingMinor);
    expect(r.comparative!.cashFlow.closingMinor).toBe(f.expected.comparativeCashClosingMinor);
    expect(r.current.blockers).toEqual([]); expect(r.comparative!.blockers).toEqual([]);
    expect(r.blockers).toContain("REQUIREMENT_UNIVERSE_NOT_ACCOUNTING_REVIEWED");
    expect(r.label).toBe("INCOMPLETE — PREPARATION ONLY"); expect(r.publicationAuthorized).toBe(false);
    expect(r.grants.reduce((n,g)=>n+BigInt(g.periodRevenueMinor),0n).toString()).toBe(f.expected.grantRevenueMinor);
    expect(r.grants.reduce((n,g)=>n+BigInt(g.remainingObligationMinor),0n).toString()).toBe(f.expected.grantObligationsMinor);
  });
  it("retains gross cash receipts and payments even when their labels match", () => {
    const s=input(); s.current.cash.movements[1].label=s.current.cash.movements[0].label;
    const r=prepareNgo(s); expect(r.current.cashFlow.lines.filter(l=>l.activity==="operating").map(l=>l.amountMinor).sort()).toEqual(["-500000","1300000"]);
  });
  it("keeps credit accumulated depreciation negative inside the asset caption", () => {
    const p=prepareNgo(input()).current.rows.find(r=>r.id==="ppe:non-current")!;
    expect(p.amountMinor).toBe("1200000"); expect(p.sources.find(s=>s.accountId==="accdep")!.amountMinor).toBe("-400000");
  });
  it("keeps equal account codes distinct by source account id; duplicate identity is refused", () => {
    const s=input(); s.current.accounts[1].code=s.current.accounts[0].code;
    expect(prepareNgo(s).current.totals).toEqual(fixture().expected.current);
    s.current.accounts[1].id=s.current.accounts[0].id; expect(()=>prepareNgo(s)).toThrow("DUPLICATE_SOURCE_ACCOUNT_ID");
  });
  it("refuses nonzero unmapped accounts and requires a disposition even for zero accounts", () => {
    const s=input(); s.current.accounts[0].lineId=null; expect(()=>prepareNgo(s)).toThrow("ACCOUNT_PRESENTATION_REQUIRED");
    const q=input();q.current.accounts.push({id:"zero",code:"x",label:"Zero account",debitMinor:"0",creditMinor:"0",lineId:null,section:null,zeroDisposition:null,evidenceId:"tb-current"});
    expect(()=>prepareNgo(q)).toThrow("ACCOUNT_PRESENTATION_REQUIRED");
    q.current.accounts.at(-1).zeroDisposition="movement-source-reviewed"; expect(prepareNgo(q).current.totals).toEqual(fixture().expected.current);
  });
  it("refuses unbalanced or post-close source TBs instead of inventing a balancing account", () => {
    const s=input();s.current.accounts[0].debitMinor="900001";expect(()=>prepareNgo(s)).toThrow("TRIAL_BALANCE_NOT_BALANCED");
    s.current.accounts[0].debitMinor="900000";s.current.mode="post-close";expect(()=>prepareNgo(s)).toThrow("POST_CLOSE_PERFORMANCE_LEDGER_REQUIRED");
  });
  it("never combines sources with different currencies, precision or accounting bases",()=>{
    const s=input();s.comparative.currency="USD";expect(()=>prepareNgo(s)).toThrow("SOURCE_DENOMINATION_MISMATCH");
    s.comparative.currency="TZS";s.comparative.scale=0;expect(()=>prepareNgo(s)).toThrow("SOURCE_DENOMINATION_MISMATCH");
    s.comparative.scale=2;s.comparative.basis="cash";expect(()=>prepareNgo(s)).toThrow("SOURCE_ACCRUAL_BASIS_REQUIRED");
  });
  it("requires cash-account continuity and net-asset continuity; never plugs either residual", () => {
    const s=input();s.current.cash.openings[0].openingMinor="500001";
    const r=prepareNgo(s);expect(r.blockers).toContain("CURRENT:CASH_ACCOUNT_DIFFERENCE:bank");expect(r.blockers).toContain("OPENING_CASH_BRIDGE_WORKPAPER_REQUIRED");
    const q=input();q.current.netAssets.openingMinor="1300001";expect(prepareNgo(q).blockers).toEqual(expect.arrayContaining(["CURRENT:NET_ASSET_ROLL_FORWARD_DIFFERENCE","OPENING_NET_ASSETS_BRIDGE_DIFFERENCE"]));
  });
  it("reconciles internal cash transfers by paired source movements, never as external revenue/expense", () => {
    const s=input();const a={...s.current.accounts[0],id:"cash-two",code:"1010",debitMinor:"0",creditMinor:"0"};s.current.accounts.push(a);
    s.current.cash.openings.push({accountId:a.id,openingMinor:"0",exchangeEffectMinor:"0",evidenceId:"cash-current"});
    const m={...s.current.cash.movements[0],activity:"internal",transferId:"transfer",label:"Internal bank transfer"};
    s.current.cash.movements.push({...m,id:"out",amountMinor:"-100",accountId:"bank"},{...m,id:"in",amountMinor:"100",accountId:a.id});
    s.current.accounts[0].debitMinor="899900";a.debitMinor="100";
    expect(prepareNgo(s).current.cashFlow.activities.find(a=>a.id==="operating")!.amountMinor).toBe("800000");
    s.current.cash.movements.at(-1).amountMinor="99";expect(()=>prepareNgo(s)).toThrow("INTERNAL_CASH_TRANSFER_NOT_RECONCILED");
  });
  it("does not accept a fabricated budget anchor or grant schedule that disagrees with the statements", () => {
    const s=input();s.budget.anchors[0].financialStatementMinor="800001";
    expect(prepareNgo(s).blockers).toContain("BUDGET_ANCHOR_STATEMENT_MISMATCH:operating");
    const q=input();q.grants[0].obligations[1].satisfiedMinor="399999";expect(prepareNgo(q).blockers).toContain("GRANT_SCHEDULE_STATEMENT_DIFFERENCE");
  });
  it("binds scope and source identity; refuses missing, cross-entity and contradictory evidence", () => {
    const s=input();s.scope.companyId="other";expect(()=>prepareNgo(s)).toThrow("PROFILE_SOURCE_SCOPE_MISMATCH");
    const q=input();q.current.accounts[0].evidenceId="missing";expect(()=>prepareNgo(q)).toThrow("FACT_EVIDENCE_MISSING");
    const t=input();t.evidence[0].companyId="other";expect(()=>prepareNgo(t)).toThrow("EVIDENCE_SCOPE_MISMATCH");
    const v=input();v.evidence.push({...v.evidence[0],sourceRevision:"a".repeat(64)});expect(()=>prepareNgo(v)).toThrow("EVIDENCE_ID_REUSED");
  });
  it("cannot waive mandatory topics or declare the topic inventory a reviewed requirement universe", () => {
    const s=input();s.assessments=[{topicId:"presentation",status:"not-applicable",basis:"Synthetic unsupported waiver",evidence:evidence(),workpaperReference:null}];
    expect(()=>prepareNgo(s)).toThrow("MANDATORY_TOPIC_CANNOT_BE_WAIVED");
    s.assessments=TOPICS.map(([id])=>({topicId:id,status:"applicable",basis:"Synthetic scenario assessment",evidence:evidence(),workpaperReference:"SYNTHETIC workpaper reference"}));
    const r=prepareNgo(s);expect(r.blockers).toContain("FRAMEWORK_CONTENT_NOT_ACCOUNTING_VALIDATED");expect(r.publicationAuthorized).toBe(false);
  });
  it("keeps the accounting identity stable when budget and grant inputs are reordered", () => {
    const s=input(), a=prepareNgo(s);s.budget.rows.reverse();s.budget.anchors.reverse();s.grants.reverse();
    const b=prepareNgo(s);expect(b.accountingResultSha256).toBe(a.accountingResultSha256);expect(b.sourceSha256).not.toBe(a.sourceSha256);
  });
  it("does not present comparative arithmetic as reviewed transition compliance", () => {
    expect(prepareNgo(input()).blockers).toContain("COMPARATIVE_FRAMEWORK_AND_TRANSITION_REVIEW_REQUIRED");
  });
  it("returns detached immutable results and reproducible content identities", () => {
    const s=input(), r=prepareNgo(s), again=prepareNgo(input());
    expect(r.sourceSha256).toBe(again.sourceSha256);expect(r.accountingResultSha256).toBe(again.accountingResultSha256);
    s.current.accounts[0].debitMinor="999";expect(r.sourceSnapshot.current.accounts[0].debitMinor).toBe("900000");expect(Object.isFrozen(r.current.rows[0])).toBe(true);
  });
  it("separates unchanged accounting results from changed source provenance and row ordering", () => {
    const s=input(), a=prepareNgo(s);
    const change=(v:unknown)=>{if(v&&typeof v==="object"){if((v as {id?:string}).id==="management-current") (v as {sourceRevision:string}).sourceRevision="f".repeat(64);Object.values(v).forEach(change);}};
    change(s);s.current.accounts.reverse();s.current.cash.movements.reverse();
    const b=prepareNgo(s);expect(b.accountingResultSha256).toBe(a.accountingResultSha256);expect(b.sourceSha256).not.toBe(a.sourceSha256);expect(b.provenanceSha256).not.toBe(a.provenanceSha256);
  });
  it.each([null, "0.01", 1, Number.MAX_SAFE_INTEGER+1])("does not coerce a missing or non-integer source amount (%s)", value => {
    const s=input();s.current.accounts[0].debitMinor=value;expect(()=>prepareNgo(s)).toThrow();
  });
});

it("rejects an initial application before the standard was published",()=>{
  const p=profileAt("2026-07-01","2027-06-30");p.initialApplications.revenue47="1900-01-01";
  expect(()=>resolveIpsasProfile(p)).toThrow("INITIAL_APPLICATION_BEFORE_STANDARD_ISSUED");
});

describe("IPSAS through the existing canonical kernel (preparation only)",()=>{
  const identity={companyId:"synthetic-ngo-no-hosted-record",reportId:"synthetic-ipsas-no-hosted-report",reportVersion:1};
  const snapshot=(registry:ReturnType<typeof createProofRegistry>):KernelSnapshot=>({schema:"framework-kernel-snapshot/1",identity,selection:registry.inventory[0],period:input().scope.period,evaluatedAt:"2026-10-29T08:00:00Z",payload:input()});
  it("assembles four real canonical statements and passes the independent arithmetic/tie rules",async()=>{
    const registry=createProofRegistry([ipsasProofAdapter("2025","a".repeat(64))]);
    const result=await registry.compile(snapshot(registry),identity);
    expect(result.document.framework.kind).toBe("IPSAS_ACCRUAL");expect(result.document.statements).toHaveLength(4);
    for(const id of ["sfp-equation","subtotal-casting","cashflow-closing-cash-reconciliation","equity-closing-tie","equity-profit-tie"]){
      const findings=result.evaluation.findings.filter(f=>f.ruleId===id);
      expect(findings.length,id).toBeGreaterThan(0);expect(findings.every(f=>f.outcome==="PASS"||f.outcome==="NOT_APPLICABLE"),canonicalStringify(findings)).toBe(true);
    }
    expect(result.publicationAuthorized).toBe(false);expect(result.document.textualDisclosures[0].text).toContain("no canonical budget statement or complete notes exist");
  });
  it("catches an independently injected financial-position error through the existing rule pack",async()=>{
    const registry=createProofRegistry([ipsasProofAdapter("2025","a".repeat(64))]);const result=await registry.compile(snapshot(registry),identity);
    const doc=structuredClone(result.document),position=doc.statements.find(s=>s.type==="STATEMENT_OF_FINANCIAL_POSITION")!;
    const line=position.sections.flatMap(s=>s.lines).find(l=>l.concept===C.TOTAL_ASSETS)!;
    const id=line.factBindings.find(b=>b.periodId==="CURRENT")!.factId;
    (doc.facts.find(f=>f.factId===id)!.value as {minorUnits:bigint}).minorUnits+=1n;
    expect(evaluateComposedReport(doc,()=>"2026-10-29T08:00:00Z").findings.some(f=>f.ruleId==="sfp-equation"&&f.outcome==="FAIL")).toBe(true);
  });
  it("does not lose a missing comparative opening by treating it as zero",async()=>{
    const registry=createProofRegistry([ipsasProofAdapter("2025","a".repeat(64))]);const s=snapshot(registry);
    (s.payload as ReturnType<typeof input>).comparative.netAssets.openingMinor=null;
    const result=await registry.compile(s,identity);
    expect(result.document.facts.some(f=>f.value===null)).toBe(true);
    expect(result.evaluation.findings.some(f=>f.outcome==="INSUFFICIENT_EVIDENCE")).toBe(true);
    expect(result.publicationAuthorized).toBe(false);
  });
  it("rejects changed company scope and adapter period rather than compiling another entity",async()=>{
    const registry=createProofRegistry([ipsasProofAdapter("2025","a".repeat(64))]);const s=snapshot(registry);s.identity={...identity,companyId:"other"};
    await expect(registry.compile(s,s.identity)).rejects.toThrow("ADAPTER_SOURCE_COMPANY_MISMATCH");
    const t=snapshot(registry);t.period.end="2026-06-29";await expect(registry.compile(t,identity)).rejects.toThrow("ADAPTER_SOURCE_PERIOD_MISMATCH");
  });
});

describe("source artifact and runtime boundaries", () => {
  it("pins actual synthetic artifact bytes rather than invented source hashes", () => {
    for (const e of input().evidence) expect(createHash("sha256").update(fs.readFileSync(path.join(DIR,e.locator))).digest("hex")).toBe(e.sourceRevision);
  });
  it("does not invoke getters, accept sparse arrays, functions or prototype-key data", () => {
    let invoked=false;const g=Object.defineProperty({},"value",{get(){invoked=true;return 0},enumerable:true});
    expect(()=>jsonSnapshot(g)).toThrow("SOURCE_NOT_JSON");expect(invoked).toBe(false);
    expect(()=>jsonSnapshot(new Array(2))).toThrow("SOURCE_NOT_JSON");expect(()=>jsonSnapshot({x:()=>1})).toThrow("SOURCE_NOT_JSON");
    expect(()=>jsonSnapshot(JSON.parse('{"__proto__":{}}'))).toThrow("SOURCE_NOT_JSON");
  });
  it("bounds source recursion and string payloads before parsing and hashing", () => {
    let v:unknown=0;for(let i=0;i<34;i++)v={next:v};expect(()=>jsonSnapshot(v)).toThrow("SOURCE_STRUCTURE_LIMIT");
    expect(()=>jsonSnapshot("x".repeat(8000001))).toThrow("SOURCE_SIZE_LIMIT");
  });
  it("has no production source import or provider/DB transport", () => {
    const walk=(dir:string):string[]=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
    const imports=walk(path.join(ROOT,"src")).filter(p=>/\.[cm]?[jt]sx?$/.test(p)&&!p.includes(".test.")).filter(p=>fs.readFileSync(p,"utf8").includes("ipsas-accrual-r1"));
    expect(imports).toEqual([]);
    for(const p of walk(path.join(ROOT,"release/candidates/ipsas-accrual-r1")).filter(p=>p.endsWith(".ts"))) expect(fs.readFileSync(p,"utf8")).not.toMatch(/\bfetch\s*\(|createClient\s*\(|Deno\.serve|\.from\s*\(/);
  });
});
