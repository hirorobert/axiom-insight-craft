import { describe, expect, it } from "vitest";
import { formatEquipmentAmount } from "./equipment";
import { classFromScheduleRow, deriveClass, excludeReviewedZeroMovements, isRecordedZeroMovement } from "./equipmentEditor";
import { classRollForward, depreciationTieOut } from "./equipmentSchedule";
import { parseEquipmentEditorV2 } from "./editorSchema";
const recorded=()=>classFromScheduleRow({classLabel:"Equipment",openingMinor:"1600000",closingMinor:"1400000",movements:[{kind:"depreciation",amountMinor:"-200000"},{kind:"additions",amountMinor:"0"},{kind:"disposals",amountMinor:"0"}]},2);

describe("recorded zero-effect review",()=>{
  it("does not drop zero net rows or infer their gross columns on load",()=>{
    const c=recorded();expect(c.movements.map(m=>m.kind)).toEqual(["depreciation","additions","disposals"]);
    expect(c.movements[2].grossMinor).toBe("");expect(c.answers).toEqual({});
    expect(isRecordedZeroMovement(c.movements[2],2)).toBe(true);
  });
  it("never removes a fully depreciated disposal whose nonzero columns cancel",()=>{
    const c=recorded();c.movements[2]={...c.movements[2],grossMinor:"1000.00",accumulatedDepreciationMinor:"1000.00",accumulatedImpairmentMinor:"0"};
    expect(isRecordedZeroMovement(c.movements[2],2)).toBe(false);
    const next=excludeReviewedZeroMovements(c,2,"Synthetic reviewer","Synthetic purchase and disposal log");
    expect(next.movements.map(m=>m.kind)).toEqual(["depreciation","disposals"]);
    expect(deriveClass(next,2).movements[1]).toMatchObject({grossMinor:"-100000",accumulatedDepreciationMinor:"-100000"});
    expect(next.answers.zero_effect_row_review.flags).toEqual({additions:true});
  });
  it("does not bulk-remove invalid precision or arbitrary new blank movements",()=>{
    const c=recorded(); c.movements[1].grossMinor="0.001";
    expect(isRecordedZeroMovement(c.movements[1],2)).toBe(false);
    expect(isRecordedZeroMovement({...c.movements[2],note:""},2)).toBe(false);
  });
  it("requires checker and evidence, retains the decision, and leaves the source object unchanged",()=>{
    const c=recorded();const before=JSON.stringify(c);
    expect(()=>excludeReviewedZeroMovements(c,2,"","evidence")).toThrow();
    expect(()=>excludeReviewedZeroMovements(c,2,"reviewer","")).toThrow();
    const next=excludeReviewedZeroMovements(c,2,"Synthetic reviewer","Synthetic register E-1");
    expect(JSON.stringify(c)).toBe(before); expect(next.movements.map(m=>m.kind)).toEqual(["depreciation"]);
    expect(next.answers.zero_effect_row_review).toMatchObject({status:"answered",checkedBy:"Synthetic reviewer",evidence:"Synthetic register E-1"});
    expect(next.answers.zero_effect_row_review.text).toContain("movements subsequently added");
  });
});
describe("exact currency presentation",()=>{
  it("formats large integers, negatives and currency precision without floating point",()=>{
    expect(formatEquipmentAmount("-200000",{currency:"TZS",exponent:2})).toBe("TZS -2,000.00");
    expect(formatEquipmentAmount("900719925474099312345",{currency:"TZS",exponent:2})).toBe("TZS 9,007,199,254,740,993,123.45");
    expect(formatEquipmentAmount("1234",{currency:"KWD",exponent:3})).toBe("KWD 1.234");
    expect(formatEquipmentAmount("1234",{currency:"JPY",exponent:0})).toBe("JPY 1,234");
  });
  it("changes explanation text only; exact reconciliation state and amounts remain identical",()=>{
    const cs=[{movements:[{kind:"depreciation" as const,grossMinor:"0",accumulatedDepreciationMinor:"200000",accumulatedImpairmentMinor:"0",source:{type:"register" as const,reference:"Synthetic register"},note:""}]}];
    const plain=depreciationTieOut(cs,[],[]),display=depreciationTieOut(cs,[],[],{currency:"TZS",exponent:2});
    expect({...display,problems:[]}).toEqual({...plain,problems:[]});
    expect(display.problems[0]).toContain("TZS 2,000.00");expect(display.differenceMinor).toBe("200000");
  });
});

import fs from "node:fs";
import { classCharge } from "./depreciation";
import { evaluateQuestions, unresolvedQuestions, chargeConsistencyProblems } from "./equipmentQuestions";
import { openingBridge, openingAnchorDate, parseSourceAmount } from "./equipment";
import { equipmentNoteProposalV2, policyProposalV2 } from "./equipmentProposals";
it("the declared synthetic FY2025 case reconciles exactly without claiming real management evidence",()=>{
  const f=JSON.parse(fs.readFileSync("docs/release/equipment-guided-start-r1/fixtures/synthetic-equipment-case.json","utf8"));
  expect(f).toMatchObject({fixtureOnly:true,synthetic:true,notManagementEvidence:true});
  const editor=parseEquipmentEditorV2(f,f.companyId,f.periodYear);
  const c=deriveClass(editor.classes[0],2);
  const charge=classCharge(c.estimate.items,f.period,c.estimate.convention);
  expect(charge).toMatchObject({state:"calculated",chargeMinor:f.expected.depreciationMinor});
  if(charge.state!=="calculated") throw new Error("charge missing");
  c.estimate.calculatedChargeMinor=charge.chargeMinor;
  const roll=classRollForward(c.label,{opening:c.opening,closing:c.closing},c.movements,c.disposals);
  expect(roll.state).toBe("agrees");expect(roll.scheduleRow).toMatchObject({openingMinor:f.expected.openingMinor,closingMinor:f.expected.closingMinor});
  const destinations=editor.destinations.map(d=>({...d,amountMinor:parseSourceAmount(d.amountMinor,2,0)!}));
  expect(depreciationTieOut([c],destinations,[{lineId:"sci.operating_expenses_by_function",amountMinor:f.expected.statementExpenseLineMinor}])).toMatchObject({state:"agrees",differenceMinor:"0"});
  expect(chargeConsistencyProblems(c,f.period).problems).toEqual([]);
  expect(unresolvedQuestions(evaluateQuestions({classes:[c],retiredClasses:[],destinations,entityAnswers:editor.entityAnswers},f.period))).toEqual([]);
  expect(openingAnchorDate(editor.priorDate,f.period.start)).toBe("2024-12-31");
  const bridge=openingBridge({origin:"manual",sourceRef:editor.priorReference,documentSha256:null,page:null,entity:"Synthetic SME",periodEnd:editor.priorDate,currency:"TZS",scale:2,label:"Synthetic equipment",amountMinor:f.expected.openingMinor,confirmed:true},[],f.expected.openingMinor,{entity:"Synthetic SME",priorPeriodEnd:"2024-12-31",currency:"TZS",exponent:2});
  expect(bridge.state).toBe("agrees");
  expect(policyProposalV2([c],"TZS",2)).toContain("10 years");
  expect(equipmentNoteProposalV2([c],editor.entityAnswers,destinations,"TZS",2)).toContain("14000.00");
});
