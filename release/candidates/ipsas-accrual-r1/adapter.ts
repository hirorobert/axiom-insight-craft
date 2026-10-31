/** IPSAS preparation adapter for the existing INERT kernel. There is no live registration or issuance path. */
import { CANONICAL_CONCEPTS as C } from "@/lib/canonicalStatement/concepts";
import { money, formatMoney } from "@/lib/canonicalStatement/money";
import { CANONICAL_SCHEMA_VERSION, type CanonicalFinancialStatementReport, type MonetaryFact, type Statement, type StatementLine, type ProvenanceRecord } from "@/lib/canonicalStatement/types";
import { sha256Hex, canonicalStringify } from "@/lib/canonicalStatement/serialization";
import type { KernelAdapter, KernelIdentity } from "../framework-kernel-r1/kernel";
import { prepareNgo } from "./preparation";
import { refuse } from "./contracts";

type Prepared = ReturnType<typeof prepareNgo>;
export function assembleIpsasCandidate(prepared: Prepared, identity: KernelIdentity, packId: string): CanonicalFinancialStatementReport {
  if (identity.companyId !== prepared.scope.companyId) refuse("ADAPTER_SOURCE_COMPANY_MISMATCH");
  const { currency, scale } = prepared.scope, facts: MonetaryFact[] = [];
  const periods = [{ id: "CURRENT", data: prepared.current }, ...(prepared.comparative ? [{ id: "COMPARATIVE_1", data: prepared.comparative }] : [])];
  const provenance = (id: string, text: string): ProvenanceRecord => ({
    source: { sourceDocumentId: `ipsas-source:${prepared.sourceSha256}`, sourceHash: prepared.sourceSha256, artifactKind: "EVIDENCE_BATCH" },
    locator: { kind: "EVIDENCE_ROW", batchId: `ipsas-source:${prepared.sourceSha256}`, rowNumber: 1, derivation: id },
    extractionMethod: "EVIDENCE_BATCH_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: text,
  });
  const line = (id: string, label: string, concept: string, amount: (data: Prepared["current"]) => string | null,
    options: { credit?: boolean; children?: string[] } = {}): StatementLine => {
    const factBindings = periods.map(({id: periodId, data}) => {
      const amountMinor = amount(data), factId = `${id}:${periodId}`;
      const value = amountMinor === null ? null : money(currency, scale, BigInt(amountMinor));
      facts.push({ factId, version: 1, value, reportingPeriod: { periodId, isComparative: periodId !== "CURRENT" }, signConvention: "NATURAL",
        provenance: provenance(factId, value === null ? "MISSING — no opening fact was supplied" : `Candidate derivation ${factId}; ${formatMoney(value)} ${currency}; refer to bound source snapshot`), supersedesVersion: null });
      return { periodId, factId };
    });
    return { lineId: id, label, concept, role: options.children?.length ? "TOTAL" : "DETAIL", normalBalance: options.credit ? "CREDIT_NORMAL" : "DEBIT_NORMAL", isContra: false,
      factBindings, castingChildLineIds: options.children ?? [] };
  };
  const statements: Statement[] = [];
  const lineKeys = [...new Set(periods.flatMap(p => p.data.rows.map(r => r.id)))].sort();
  const rowMeta = (key: string) => periods.flatMap(p => p.data.rows).find(r => r.id === key)!;
  const value = (key: string, data: Prepared["current"]) => data.rows.find(r => r.id === key)?.amountMinor ?? "0";
  const position = lineKeys.filter(key => ["asset","liability","net-assets"].includes(rowMeta(key).nature)).map(key => {
    const r = rowMeta(key); return line(`ipsas:sfp:${key}`, `${r.label} (${r.section})`, key === "cash:current" ? C.CASH_AND_CASH_EQUIVALENTS_SFP : `ipsas:${key}`, d => value(key,d), {credit:r.nature!=="asset"});
  });
  const surplusPosition = line("ipsas:sfp:period-result", "Surplus or deficit for the period", "ipsas:result-in-net-assets", d=>d.totals.surplusMinor, {credit:true});
  const idsFor = (nature:string) => lineKeys.filter(k=>rowMeta(k).nature===nature).map(k=>`ipsas:sfp:${k}`);
  const positionTotals = [
    line("ipsas:sfp:assets", "Total assets", C.TOTAL_ASSETS, d=>d.totals.assetsMinor, {children:idsFor("asset")}),
    line("ipsas:sfp:liabilities", "Total liabilities", C.TOTAL_LIABILITIES, d=>d.totals.liabilitiesMinor, {credit:true,children:idsFor("liability")}),
    line("ipsas:sfp:net-assets", "Total net assets/equity", C.TOTAL_EQUITY, d=>d.totals.netAssetsMinor, {credit:true,children:[...idsFor("net-assets"),surplusPosition.lineId]}),
  ];
  statements.push({statementId:"ipsas:position",type:"STATEMENT_OF_FINANCIAL_POSITION",title:"INCOMPLETE — Statement of financial position",sections:[{sectionId:"ipsas:position:rows",label:"Prepared figures; accounting review outstanding",lines:[...position,surplusPosition,...positionTotals]}]});
  const performanceKeys = lineKeys.filter(k=>["revenue","expense"].includes(rowMeta(k).nature));
  const performance = performanceKeys.map(key=>line(`ipsas:performance:${key}`,rowMeta(key).label,`ipsas:${key}`,d=>String(BigInt(value(key,d))*(rowMeta(key).nature==="expense"?-1n:1n)),{credit:rowMeta(key).nature==="revenue"}));
  const resultLine = line("ipsas:performance:result","Surplus or deficit",C.NET_RESULT,d=>d.totals.surplusMinor,{credit:true,children:performance.map(l=>l.lineId)});
  statements.push({statementId:"ipsas:performance",type:"STATEMENT_OF_PROFIT_OR_LOSS",title:"INCOMPLETE — Statement of financial performance",sections:[{sectionId:"ipsas:performance:rows",label:"By nature; expenses shown as deductions",lines:[...performance,resultLine]}]});
  const opening = line("ipsas:net-assets:opening","Opening net assets/equity","ipsas:opening-net-assets",d=>d.netAssets.openingMinor,{credit:true});
  const resultInEquity = line("ipsas:net-assets:surplus","Surplus or deficit",C.SOCIE_PROFIT_OR_LOSS_TOTAL,d=>d.totals.surplusMinor,{credit:true});
  const movementIds = [...new Set(periods.flatMap(p=>p.data.netAssets.otherMovements.map(m=>m.id)))].sort();
  const netMovements = movementIds.map(id=>line(`ipsas:net-assets:movement:${id}`,periods.flatMap(p=>p.data.netAssets.otherMovements).find(m=>m.id===id)!.label,`ipsas:net-assets-movement:${id}`,d=>d.netAssets.otherMovements.find(m=>m.id===id)?.amountMinor??"0",{credit:true}));
  const closing = line("ipsas:net-assets:closing","Closing net assets/equity",C.SOCIE_CLOSING_TOTAL,d=>d.totals.netAssetsMinor,{credit:true,children:[opening.lineId,resultInEquity.lineId,...netMovements.map(m=>m.lineId)]});
  statements.push({statementId:"ipsas:net-assets",type:"STATEMENT_OF_CHANGES_IN_EQUITY",title:"INCOMPLETE — Statement of changes in net assets/equity",sections:[{sectionId:"ipsas:net-assets:rows",label:"Aggregate preparation — component disclosures still require review",lines:[opening,resultInEquity,...netMovements,closing]}]});
  const cashKeys=[...new Set(periods.flatMap(p=>p.data.cashFlow.lines.map(l=>l.id)))].sort();
  const cashDetails=cashKeys.map(key=>line(`ipsas:cash:${key}`,periods.flatMap(p=>p.data.cashFlow.lines).find(l=>l.id===key)!.label,`ipsas:cash:${key}`,d=>d.cashFlow.lines.find(l=>l.id===key)?.amountMinor??"0"));
  const activityTotals=["operating","investing","financing"].map(id=>line(`ipsas:cash:total:${id}`,`Net cash from ${id} activities`,`ipsas:cash-total:${id}`,d=>d.cashFlow.activities.find(a=>a.id===id)!.amountMinor,{children:cashKeys.filter(k=>periods.flatMap(p=>p.data.cashFlow.lines).find(l=>l.id===k)!.activity===id).map(k=>`ipsas:cash:${k}`)}));
  const openingCash=line("ipsas:cash:opening","Opening cash and cash equivalents","ipsas:cash-opening",d=>d.cashFlow.openingMinor);
  const exchange=line("ipsas:cash:exchange","Effect of exchange-rate changes","ipsas:cash-exchange",d=>d.cashFlow.exchangeEffectMinor);
  const closingCash=line("ipsas:cash:closing","Closing cash and cash equivalents",C.CASH_AND_CASH_EQUIVALENTS_CLOSING_CF,d=>d.cashFlow.closingMinor,{children:[openingCash.lineId,...activityTotals.map(l=>l.lineId),exchange.lineId]});
  statements.push({statementId:"ipsas:cash",type:"STATEMENT_OF_CASH_FLOWS",title:"INCOMPLETE — Statement of cash flows",sections:[{sectionId:"ipsas:cash:rows",label:"Direct-method preparation",lines:[...cashDetails,...activityTotals,openingCash,exchange,closingCash]}]});
  return {schemaVersion:CANONICAL_SCHEMA_VERSION,reportIdentity:{companyId:identity.companyId,reportId:identity.reportId,reportVersion:identity.reportVersion},entity:{legalName:prepared.legalName},period:{periodId:"CURRENT",startDate:prepared.scope.period.start,endDate:prepared.scope.period.end,periodYear:Number(prepared.scope.period.end.slice(0,4))},
    comparativePeriods:prepared.comparative?[{periodId:"COMPARATIVE_1",startDate:prepared.comparative.period.start,endDate:prepared.comparative.period.end,periodYear:Number(prepared.comparative.period.end.slice(0,4)),isRestated:false}]:[],
    framework:{kind:"IPSAS_ACCRUAL",version:packId},presentationCurrency:{currency,scale,roundingPolicy:{mode:"HALF_UP",scale},presentationMultiplier:1n},statements,facts,notes:[],noteReferences:[],accountingPolicies:[],
    textualDisclosures:[{disclosureId:"ipsas:candidate-limitations",text:`INCOMPLETE PREPARATION ONLY. Not approved or issued. Required budget preparation remains a separate candidate table; no canonical budget statement or complete notes exist. Open blockers: ${prepared.blockers.join("; ")}`,provenance:provenance("ipsas:candidate-limitations","Candidate limitations, not a compliance statement")}],provenanceOrigin:"TRIAL_BALANCE_DERIVED"};
}

export function ipsasProofAdapter(profile: "legacy"|"2025"|"2026", sourceSha256: string): KernelAdapter {
  const windows={legacy:{from:"2024-01-01",before:"2025-01-01"},"2025":{from:"2025-01-01",before:"2026-01-01"},"2026":{from:"2026-01-01",before:"2027-01-01"}};
  const packId=`ipsas-accrual/preparation-${profile}`;
  return {descriptor:{schema:"framework-kernel-descriptor/1",pack:{family:"IPSAS_ACCRUAL",packId,edition:`candidate-${profile}`,revision:"1"},canonicalKind:"IPSAS_ACCRUAL",periodStarts:windows[profile],
    adapter:{id:"ipsas-ngo-preparation-candidate",version:"1",sourceSha256},encodingSha256:sha256Hex(canonicalStringify({schema:"ipsas-ngo-source/1",profile,release:"preparation-only"}))},
    assemble:snapshot=>{
      const prepared=prepareNgo(snapshot.payload);
      if(prepared.scope.period.start!==snapshot.period.start||prepared.scope.period.end!==snapshot.period.end)refuse("ADAPTER_SOURCE_PERIOD_MISMATCH");
      if(Object.values(prepared.sourceSnapshot.profile.elections).some(Boolean))refuse("EARLY_ELECTION_REQUIRES_SEPARATE_ADAPTER");
      if(prepared.sourceSnapshot.openingAdjustments.length)refuse("RESTATEMENT_AND_TRANSITION_ADAPTER_NOT_IMPLEMENTED");
      return assembleIpsasCandidate(prepared,snapshot.identity,packId);
    }};
}
