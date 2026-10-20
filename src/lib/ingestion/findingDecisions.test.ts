/**
 * Finding decisions and the evaluation manifest (engine generation 7; supabase/functions/_shared/tbFindingDecisions.ts).
 * The database re-checks the same rules (tb_finalize_attempt, scripts/db-proof/findingDecisions.mjs); these tests pin the
 * engine side: decisions cited by identity, non-resolving decisions turned into blocking findings with their recovery,
 * undecided findings reported, and a manifest that always agrees with the findings. Invented data only.
 */
import { describe, expect, it } from "vitest";
import {
  EVALUATION_RULES, applyDecisions, evaluationManifest, manifestAgrees, readCurrentDecisions, sameDecisions, usesCarriedDecisions,
  type CurrentDecision, type DecisionFinding,
} from "../../../supabase/functions/_shared/tbFindingDecisions";

const entity: DecisionFinding = { code: "ENTITY_NAME_DIFFERS", layer: 2, severity: "warning", accountCode: null, message: "x", rows: [1], subject: "invented beta trading", file_entity: "Invented Beta Trading" };
const trailing: DecisionFinding = { code: "UNRECOGNISED_TRAILING_TEXT", layer: 2, severity: "warning", accountCode: null, message: "y", rows: [41, 42], subject: "rows:41,42" };
const clearing: DecisionFinding = { code: "CLEARING_ACCOUNT_BALANCE", layer: 2, severity: "warning", accountCode: "1190", message: "z", rows: [9], subject: "code:1190" };
const other: DecisionFinding = { code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: "4000", message: "classify" };
const dec = (code: string, subject: string, action: string, resolves = true, carried: string | null = null): CurrentDecision =>
  ({ decisionId: `${code}-${action}`, code, subject, action, resolves, carriedFromUploadId: carried });

describe("applyDecisions", () => {
  it("cites each current decision by identity and leaves findings without one undecided", () => {
    const r = applyDecisions([entity, trailing, clearing, other], [dec("ENTITY_NAME_DIFFERS", "invented beta trading", "same_entity")]);
    expect(r.findings.find((f) => f.code === "ENTITY_NAME_DIFFERS")?.decision).toEqual({ id: "ENTITY_NAME_DIFFERS-same_entity", action: "same_entity" });
    expect(r.undecided.map((f) => f.code)).toEqual(["UNRECOGNISED_TRAILING_TEXT", "CLEARING_ACCOUNT_BALANCE"]);
    expect(r.blocking).toEqual([]);
    expect(r.findings.find((f) => f.code === "NEEDS_REVIEW")).toEqual(other); // not a decision-taking finding: unchanged
  });
  it("a decision for a different subject never applies (identity, not code alone)", () => {
    const r = applyDecisions([clearing], [dec("CLEARING_ACCOUNT_BALANCE", "code:1195", "explained")]);
    expect(r.findings[0].decision).toBeUndefined();
    expect(r.undecided).toHaveLength(1);
  });
  it("a different-entity decision blocks with the recovery; 'part of the trial balance' blocks with a layout correction", () => {
    const r = applyDecisions([entity, trailing], [dec("ENTITY_NAME_DIFFERS", "invented beta trading", "different_entity", false),
      dec("UNRECOGNISED_TRAILING_TEXT", "rows:41,42", "part_of_trial_balance", false)]);
    expect(r.blocking.map((b) => [b.code, b.severity])).toEqual([["ENTITY_WRONG_DESTINATION", "error"], ["LAYOUT_CORRECTION_REQUIRED", "error"]]);
    expect(r.blocking[0].message).toContain("Invented Beta Trading");
    expect(r.blocking[1].message).toContain("41, 42");
    // Nothing is plugged, adjusted or dropped: the original findings stay, citing the decisions.
    expect(r.findings.filter((f) => f.decision).length).toBe(2);
    expect(r.findings.some((f) => /plug|adjust|suspense entry/i.test(f.message))).toBe(false);
  });
  it("carried-forward decisions are reported so the run records the company's decisions key", () => {
    expect(usesCarriedDecisions([dec("ENTITY_NAME_DIFFERS", "a", "same_entity", true, "00000000-0000-4000-8000-000000000001")])).toBe(true);
    expect(usesCarriedDecisions([dec("ENTITY_NAME_DIFFERS", "a", "same_entity")])).toBe(false);
  });
  it("the post-snapshot comparison is by decision id and action, in any order", () => {
    const a = [dec("A_CODE", "s", "x"), dec("B_CODE", "t", "y")];
    expect(sameDecisions(a, [...a].reverse())).toBe(true);
    expect(sameDecisions(a, [a[0]])).toBe(false);
  });
});

describe("evaluationManifest", () => {
  it("names every rule exactly once, 'finding' where a finding is, and agrees with the findings (as the database checks)", () => {
    for (const findings of [[], [entity], [entity, trailing, clearing], [{ ...entity, code: "TRIAL_BALANCE_IMBALANCE" }]]) {
      const m = evaluationManifest(findings, "complete", true);
      expect(m.format).toBe("tb-evaluation/1");
      expect(m.rules.map((r) => r.rule)).toEqual([...EVALUATION_RULES]);
      expect(manifestAgrees(findings, m.rules)).toBe(true);
    }
  });
  it("a check stopped at ingestion reports classification as not reached, and the balance only when it was evaluated", () => {
    const m = evaluationManifest([], "ingestion", false);
    expect(m.rules.find((r) => r.rule === "classification")?.outcome).toBe("not_reached");
    expect(m.rules.find((r) => r.rule === "balance")?.outcome).toBe("not_reached");
    expect(evaluationManifest([], "complete", true).rules.every((r) => r.outcome === "passed")).toBe(true);
  });
  it("manifestAgrees rejects an omitted rule and a 'passed' rule that has a finding", () => {
    const m = evaluationManifest([entity], "complete", true).rules;
    expect(manifestAgrees([entity], m.filter((r) => r.rule !== "trailing_text"))).toBe(false);
    expect(manifestAgrees([entity], m.map((r) => (r.rule === "entity_name" ? { ...r, outcome: "passed" } : r)))).toBe(false);
  });
});

describe("readCurrentDecisions", () => {
  it("reads rows strictly; a missing function is 'unavailable' (refuse before writing); other errors throw", async () => {
    const ok = await readCurrentDecisions(async () => ({ data: [{ decision_id: "d", code: "C_CODE", subject: "s", action: "a", resolves: true, carried_from_upload_id: null }], error: null }), "u");
    expect(ok).toEqual({ kind: "read", decisions: [{ decisionId: "d", code: "C_CODE", subject: "s", action: "a", resolves: true, carriedFromUploadId: null }] });
    expect(await readCurrentDecisions(async () => ({ data: null, error: { code: "PGRST202" } }), "u")).toEqual({ kind: "unavailable" });
    await expect(readCurrentDecisions(async () => ({ data: null, error: { code: "57014" } }), "u")).rejects.toThrow(/lookup failed/);
    await expect(readCurrentDecisions(async () => ({ data: [{ code: "x" }], error: null }), "u")).rejects.toThrow(/malformed/);
  });
});
