import type { Assignment } from "./client";
export const COMPANY="99999999-9999-4999-8999-999999999999", ACTOR="11111111-1111-4111-8111-111111111111", OTHER="22222222-2222-4222-8222-222222222222", REVISION="88888888-8888-4888-8888-888888888888";
export function reviewFixture(companyId=COMPANY, choices: Assignment[] | null=null) {
 const composed=choices!==null;
 const accounts=[...["current","comparative"].flatMap(period=>[
  {period,accountKey:"1000",accountName:"Bank",classification:"current_assets",section:"current_assets",debitMinor:"100000",creditMinor:"0",certifiedDebitMinor:"100000",certifiedCreditMinor:"0",adjustmentIds:[]},
  {period,accountKey:"4000",accountName:"Service fees",classification:"revenue",section:"income",debitMinor:"0",creditMinor:"100000",certifiedDebitMinor:"0",certifiedCreditMinor:"100000",adjustmentIds:[]},
 ])].map(a=>({...a,captionId:choices?.find(c=>c.period===a.period&&c.accountKey===a.accountKey)?.captionId ?? null,zeroDisposition:null,reason:null,status:composed?"presented":"needs_confirmation"}));
 const totals={state:composed?"composed":"incomplete",assetsMinor:composed?"100000":null,liabilitiesMinor:composed?"0":null,revenueMinor:composed?"100000":null,expensesMinor:composed?"0":null,surplusMinor:composed?"100000":null,netAssetsMinor:composed?"100000":null,balanceDifferenceMinor:"0"};
 return {outcome:"available",contract:"ipsas-statement-review/1",companyId,periodYear:2026,catalogueVersion:"1",current:{certificationId:OTHER,uploadId:OTHER,reportingStart:"2026-01-01",reportingEnd:"2026-12-31",currency:"TZS",exponent:2},
 comparative:{state:"available",usable:true,label:"Prior certified TB — reference only",certificationId:OTHER},revisionId:composed?REVISION:null,assignmentsCurrent:composed,sourceSha256:"a".repeat(64),inputSha256:(composed?"d":"b").repeat(64),compositionSha256:"c".repeat(64),accounts,
 lines:[{id:"cash",label:"Cash and cash equivalents",statement:"SFP",section:"current_assets",currentMinor:composed?"100000":null,comparativeMinor:composed?"100000":null},{id:"receivables_current",label:"Receivables",statement:"SFP",section:"current_assets",currentMinor:composed?"0":null,comparativeMinor:composed?"0":null},
 {id:"fees",label:"Fees and services",statement:"SFPERF",section:"income",currentMinor:composed?"100000":null,comparativeMinor:composed?"100000":null}],totals:{current:totals,comparative:totals},adjustmentsRequiringRevalidation:0,
 officialIssuance:{available:false,reasons:["Complete disclosures are not integrated.","Accountant acceptance is outstanding."]}};
}
