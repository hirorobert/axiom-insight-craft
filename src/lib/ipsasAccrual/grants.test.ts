import { describe, expect, it } from "vitest";
import { computeGrants, generateGrantsNote, grantModel, grantTasks, type GrantsResult } from "./grants";
import { confirmed, DISPLAY, entity47, grantA, grantB, grantC, grantD, input23, input47, P47, TB47 } from "./grants.fixture";
import { emptyAnswer } from "../preparation/equipmentModel";

const codes = (r: GrantsResult) => r.issues.map((i) => `${i.code}|${i.grantId ?? ""}`);
const has = (r: GrantsResult, code: string) => r.issues.some((i) => i.code === code);

describe("period routing", () => {
  it("selects the vocabulary from the period start, and refuses a period outside the reviewed window", () => {
    expect(grantModel("2025-07-01")).toEqual({ model: "ipsas23", reviewed: true });
    expect(grantModel("2025-12-31").model).toBe("ipsas23");
    expect(grantModel("2026-01-01")).toEqual({ model: "ipsas47", reviewed: true });
    expect(grantModel("2023-07-01")).toEqual({ model: "ipsas23", reviewed: false });
    expect(grantModel("2027-01-01")).toEqual({ model: "ipsas47", reviewed: false });
    expect(grantModel(null)).toEqual({ model: null, reviewed: false });
    expect(has(computeGrants(input47({ period: { start: "2027-01-01", end: "2027-12-31" } })), "PERIOD_PROFILE_NOT_REVIEWED")).toBe(true);
    expect(has(computeGrants(input47({ period: null })), "PERIOD_UNKNOWN")).toBe(true);
  });
});

describe("IPSAS 47 period — hand-derived figures", () => {
  const r = computeGrants(input47());
  it("is ready for review with nothing open", () => { expect(r.issues).toEqual([]); expect(r.state).toBe("ready-for-review"); expect(r.model).toBe("ipsas47"); });
  it("takes revenue from satisfied obligations, not from cash", () => {
    const [a, b] = r.grants;
    expect(a.cumulativeRevenueMinor).toBe("650000000");
    expect(a.periodRevenueMinor).toBe("450000000");
    expect(a.liabilityMinor).toBe("550000000");
    expect(a.receivableMinor).toBe("450000000");
    expect(b.periodRevenueMinor).toBe("200000000");
    expect(b.liabilityMinor).toBe("0");
    expect(b.receivableMinor).toBe("0");
    expect(r.totals).toEqual({ periodRevenueMinor: "650000000", liabilityMinor: "550000000", receivableMinor: "450000000" });
  });
  it("is unchanged by the cash received and by anything but evidenced satisfaction (metamorphic)", () => {
    const moreCash = computeGrants(input47({ grants: [confirmed(grantA({ cashReceivedMinor: "1200000000" })), confirmed(grantB())], tb: { ...TB47, receivableMinor: "0" } }));
    expect(moreCash.grants[0].periodRevenueMinor).toBe("450000000");
    expect(moreCash.grants[0].receivableMinor).toBe("0");
    const noCash = computeGrants(input47({ grants: [confirmed(grantA({ cashReceivedMinor: "0" })), confirmed(grantB())], tb: { ...TB47, receivableMinor: "1200000000" } }));
    expect(noCash.grants[0].periodRevenueMinor).toBe("450000000");
    const g = grantA(); g.obligations[1] = { ...g.obligations[1], satisfiedMinor: "250000000" };
    const moreDone = computeGrants(input47({ grants: [confirmed(g), confirmed(grantB())], tb: { revenueMinor: "750000000", liabilityMinor: "450000000", receivableMinor: "450000000" } }));
    expect(moreDone.grants[0].periodRevenueMinor).toBe("550000000");
    expect(moreDone.issues).toEqual([]);
  });
  it("is unchanged by the order of grants and of obligations", () => {
    const g = grantA(); g.obligations.reverse();
    const swapped = computeGrants(input47({ grants: [confirmed(grantB()), confirmed(g)] }));
    expect(swapped.totals).toEqual(r.totals);
    expect(swapped.issues).toEqual([]);
  });
});

describe("IPSAS 23 period — restriction versus condition", () => {
  const r = computeGrants(input23());
  it("recognises a restricted grant as revenue (no liability) and a conditional grant only as the condition is satisfied", () => {
    expect(r.issues).toEqual([]);
    expect(r.model).toBe("ipsas23");
    const [c, d] = r.grants;
    expect(c.periodRevenueMinor).toBe("240000000"); expect(c.liabilityMinor).toBe("360000000"); expect(c.receivableMinor).toBe("0");
    expect(d.periodRevenueMinor).toBe("100000000"); expect(d.liabilityMinor).toBe("0"); expect(d.receivableMinor).toBe("60000000");
    expect(r.totals).toEqual({ periodRevenueMinor: "340000000", liabilityMinor: "360000000", receivableMinor: "60000000" });
  });
  it("a restriction is not made a liability by cash, spending or the size of the fund", () => {
    const big = computeGrants(input23({ grants: [confirmed(grantD({ considerationMinor: "900000000", recognisedResourcesMinor: "900000000", cashReceivedMinor: "900000000" }))], tb: { revenueMinor: "900000000", liabilityMinor: "0", receivableMinor: "0" } }));
    expect(big.grants[0].liabilityMinor).toBe("0");
    expect(big.grants[0].periodRevenueMinor).toBe("900000000");
  });
});

describe("what it refuses to decide", () => {
  it("refuses a classification from the other period's vocabulary", () => {
    const wrong47 = computeGrants(input47({ grants: [confirmed(grantD()), confirmed(grantB())] }));
    expect(has(wrong47, "CLASSIFICATION_PERIOD_MISMATCH")).toBe(true);
    expect(wrong47.grants[0].periodRevenueMinor).toBeNull();
    expect(has(computeGrants(input23({ grants: [confirmed(grantA()), confirmed(grantD())] })), "CLASSIFICATION_PERIOD_MISMATCH")).toBe(true);
  });
  it("leaves an unclassified grant open; cash received does not classify it", () => {
    const r = computeGrants(input47({ grants: [confirmed(grantB({ classification: "" }))] }));
    expect(has(r, "GRANT_CLASSIFICATION_REQUIRED")).toBe(true);
    expect(r.grants[0].periodRevenueMinor).toBeNull();
    expect(r.totals.periodRevenueMinor).toBeNull();
  });
  it("routes each complexity to a governed workpaper and computes nothing for that grant", () => {
    for (const k of ["variableConsideration", "financing", "agent", "nonCash", "modification", "creditLoss", "foreignCurrency"] as const) {
      const g = grantB(); g.complexities = { ...g.complexities, [k]: true };
      const r = computeGrants(input47({ grants: [confirmed(g)] }));
      expect(has(r, "COMPLEX_GRANT_WORKPAPER_REQUIRED"), k).toBe(true);
      expect(r.grants[0].periodRevenueMinor, k).toBeNull();
    }
  });
  it("treats an unanswered complexity as unanswered, not as 'no'", () => {
    const g = grantB(); g.complexities = { ...g.complexities, agent: null };
    expect(has(computeGrants(input47({ grants: [confirmed(g)] })), "COMPLEXITY_UNANSWERED")).toBe(true);
  });
  it("refuses a grant that is not fully funded and cash above the recognised resources", () => {
    expect(has(computeGrants(input47({ grants: [confirmed(grantB({ recognisedResourcesMinor: "100000000" }))] })), "NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED")).toBe(true);
    expect(has(computeGrants(input47({ grants: [confirmed(grantB({ cashReceivedMinor: "200000001" }))] })), "CASH_EXCEEDS_RECOGNISED_RESOURCES")).toBe(true);
  });
  it("requires obligations to be allocated exactly and satisfied no more than allocated", () => {
    const short = grantA(); short.obligations[2] = { ...short.obligations[2], allocatedMinor: "299999999" };
    expect(has(computeGrants(input47({ grants: [confirmed(short)] })), "OBLIGATION_ALLOCATION_MISMATCH")).toBe(true);
    const over = grantA(); over.obligations[1] = { ...over.obligations[1], satisfiedMinor: "400000001" };
    expect(has(computeGrants(input47({ grants: [confirmed(over)] })), "OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION")).toBe(true);
    expect(has(computeGrants(input47({ grants: [confirmed(grantA({ obligations: [] }))] })), "OBLIGATIONS_REQUIRED")).toBe(true);
    expect(has(computeGrants(input47({ grants: [confirmed(grantB({ obligations: grantA().obligations }))] })), "OBLIGATIONS_CONTRADICT_CLASSIFICATION")).toBe(true);
  });
  it("requires a stated basis and evidence for any satisfied obligation: spending alone is not satisfaction", () => {
    const g = grantA(); g.obligations[0] = { ...g.obligations[0], satisfactionBasis: "", satisfactionEvidence: "" };
    expect(has(computeGrants(input47({ grants: [confirmed(g)] })), "SATISFACTION_EVIDENCE_MISSING")).toBe(true);
    const h = grantA(); h.obligations[0] = { ...h.obligations[0], satisfactionBasis: "agreement-stated-expenditure" as never, satisfactionEvidence: "" };
    expect(has(computeGrants(input47({ grants: [confirmed(h)] })), "SATISFACTION_EVIDENCE_MISSING")).toBe(true);
  });
  it("never reverses revenue silently", () => {
    const r = computeGrants(input47({ grants: [confirmed(grantA({ priorCumulativeRevenueMinor: "700000000" }))] }));
    expect(has(r, "REVENUE_REVERSAL_WORKPAPER_REQUIRED")).toBe(true);
    expect(r.grants[0].periodRevenueMinor).toBeNull();
  });
  it("keeps unknown amounts unknown", () => {
    const r = computeGrants(input47({ grants: [confirmed(grantB({ cashReceivedMinor: "" }))] }));
    expect(has(r, "GRANT_AMOUNT_NOT_EXACT")).toBe(true);
    expect(r.grants[0].receivableMinor).toBeNull();
  });
  it("routes early application and first-period transition to a workpaper, and requires them answered", () => {
    expect(has(computeGrants(input47({ entityAnswers: {} })), "ENTITY_QUESTION_UNRESOLVED:transition_47")).toBe(true);
    const first = { transition_47: { ...emptyAnswer(), status: "answered" as const, text: "First period under the new standard", evidence: "Board paper 2026-01", flags: { applies: true } } };
    const r = computeGrants(input47({ entityAnswers: first }));
    expect(has(r, "SPECIALISED_ROUTE_REQUIRED:transition_47")).toBe(true);
    expect(has(computeGrants(input23({ entityAnswers: {} })), "ENTITY_QUESTION_UNRESOLVED:early_application_47")).toBe(true);
    expect(computeGrants(input23({ entityAnswers: { early_application_47: { ...emptyAnswer(), status: "answered", text: "Elected early application", evidence: "Board minute", flags: { applies: true } } } })).issues.map((i) => i.code)).toContain("SPECIALISED_ROUTE_REQUIRED:early_application_47");
  });
  it("needs evidence for the agreement, the classification and the prior revenue", () => {
    expect(has(computeGrants(input47({ grants: [confirmed(grantB({ agreementEvidence: "" }))] })), "AGREEMENT_EVIDENCE_MISSING")).toBe(true);
    expect(has(computeGrants(input47({ grants: [confirmed(grantB({ classificationBasis: "short" }))] })), "GRANT_BASIS_MISSING")).toBe(true);
    expect(has(computeGrants(input47({ grants: [confirmed(grantA({ priorEvidence: "" }))] })), "PRIOR_REVENUE_EVIDENCE_MISSING")).toBe(true);
  });
  it("treats an unconfirmed assessment as a proposal", () => {
    const r = computeGrants(input47({ grants: [{ ...grantB(), assessmentConfirmed: false }], tb: { revenueMinor: "200000000", liabilityMinor: "0", receivableMinor: "0" } }));
    expect(codes(r)).toEqual([`GRANT_ASSESSMENT_UNCONFIRMED|${grantB().grantId}`]);
  });
  it("rejects duplicate grants", () => {
    const r = computeGrants(input47({ grants: [confirmed(grantB()), confirmed(grantB())] }));
    expect(has(r, "DUPLICATE_GRANT_ID")).toBe(true);
    expect(has(r, "DUPLICATE_GRANT_REFERENCE")).toBe(true);
  });
});

describe("reconciliation to the certified trial balance", () => {
  it("ties revenue, liability and receivable exactly; a difference is stated and never adjusted", () => {
    const r = computeGrants(input47({ tb: { revenueMinor: "650000001", liabilityMinor: "550000000", receivableMinor: "450000000" } }));
    expect(codes(r)).toEqual(["TB_GRANT_REVENUE_DIFFERENCE|"]);
    expect(r.grants[0].periodRevenueMinor).toBe("450000000");
  });
  it("treats an absent trial-balance figure as unknown, never zero", () => {
    const r = computeGrants(input47({ tb: { revenueMinor: null, liabilityMinor: null, receivableMinor: null } }));
    expect(codes(r).sort()).toEqual(["TB_GRANT_LIABILITY_UNKNOWN|", "TB_GRANT_RECEIVABLE_UNKNOWN|", "TB_GRANT_REVENUE_UNKNOWN|"]);
  });
  it("does not compare a total that could not be computed", () => {
    const r = computeGrants(input47({ grants: [confirmed(grantA()), confirmed(grantB({ classification: "" }))] }));
    expect(has(r, "TB_GRANT_REVENUE_DIFFERENCE")).toBe(false);
    expect(r.totals.periodRevenueMinor).toBeNull();
  });
  it("requires an explicit answer when no grant is recorded, and flags a contradiction", () => {
    expect(has(computeGrants(input47({ grants: [], tb: { revenueMinor: "0", liabilityMinor: "0", receivableMinor: "0" } })), "ENTITY_QUESTION_UNRESOLVED:no_grants")).toBe(true);
    const none = { ...entity47(), no_grants: { ...emptyAnswer(), status: "none_with_basis" as const, text: "No donor or grant agreements this period", evidence: "Board minutes and bank review", flags: { applies: false } } };
    expect(computeGrants(input47({ grants: [], entityAnswers: none, tb: { revenueMinor: "0", liabilityMinor: "0", receivableMinor: "0" } })).issues).toEqual([]);
    expect(has(computeGrants(input47({ grants: [], entityAnswers: none })), "TB_GRANT_REVENUE_DIFFERENCE")).toBe(true); // an empty schedule (0) against a trial balance that shows grant revenue is a stated difference
  });
});

describe("generated policy, note and tasks", () => {
  const input = input47();
  const gen = generateGrantsNote(input, computeGrants(input), DISPLAY, "Synthetic Community Trust");
  it("states the period's basis, each confirmed classification in words, and typed amounts", () => {
    const text = gen.policy.map((p) => p.text).join("\n");
    expect(text).toContain("revenue requirements that apply to reporting periods beginning on or after 1 January 2026");
    expect(text).toContain("Cash received and expenditure incurred do not by themselves determine");
    expect(text).toContain("binding arrangement with performance obligations");
    expect(text).toContain("no binding arrangement and no present obligation");
    expect(gen.table!.rows.at(-1)!.cells.slice(3)).toEqual(["TZS 6,500,000.00", "TZS 5,500,000.00", "TZS 4,500,000.00"]);
    expect(gen.bindings["fact.grants.total.period"]).toEqual({ kind: "amount", value: "650000000" });
  });
  it("generates no wording or figures for an unconfirmed assessment", () => {
    const i = input47({ grants: [{ ...grantA(), assessmentConfirmed: false }, confirmed(grantB())] });
    const g = generateGrantsNote(i, computeGrants(i), DISPLAY, "Synthetic Community Trust");
    expect(g.policy.find((p) => p.id === `policy.grants.${grantA().grantId}`)!.unresolved).toBe(true);
    expect(g.table!.rows.some((r) => r.grantId === grantA().grantId)).toBe(false);
    expect(g.table!.rows.some((r) => r.label === "Total")).toBe(false);
  });
  it("turns every open matter into a task that names what, why, evidence, who and where", () => {
    const r = computeGrants(input47({ grants: [{ ...grantA(), assessmentConfirmed: false }, confirmed(grantB({ classification: "" }))], entityAnswers: {} }));
    const tasks = grantTasks(r);
    expect(tasks.length).toBe(r.issues.length);
    for (const t of tasks) { expect(t.missing.length).toBeGreaterThan(10); expect(t.why.length).toBeGreaterThan(10); expect(t.acceptedEvidence.length).toBeGreaterThan(3); expect(t.affects.length).toBeGreaterThan(0); }
    expect(tasks.find((t) => t.id.includes("GRANT_ASSESSMENT_UNCONFIRMED"))?.responsible).toBe("reviewer");
  });
});
