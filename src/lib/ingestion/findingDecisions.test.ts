/**
 * Finding decisions and the evaluation manifest (engine generation 7; supabase/functions/_shared/tbFindingDecisions.ts).
 * The database re-checks the same rules (tb_finalize_attempt, scripts/db-proof/findingDecisions.mjs); these tests pin the
 * engine side: the requirement model (entity always; clearing by policy; amount-free trailing text never), decisions
 * cited by identity, non-resolving decisions turned into blocking findings with their recovery, and a manifest that always
 * agrees with the findings. Invented data only.
 */
import { describe, expect, it } from "vitest";
import {
  EVALUATION_RULES, FINDING_RULE, applyDecisions, evaluationManifest, manifestAgrees, readCurrentDecisions, readRequirements, sameDecisions,
  sameRequirements, type CurrentDecision, type DecisionFinding,
} from "../../../supabase/functions/_shared/tbFindingDecisions";

const entity: DecisionFinding = { code: "ENTITY_NAME_DIFFERS", layer: 2, severity: "warning", accountCode: null, message: "x", rows: [1], subject: "invented beta trading", file_entity: "Invented Beta Trading" };
const trailing: DecisionFinding = { code: "UNRECOGNISED_TRAILING_TEXT", layer: 2, severity: "warning", accountCode: null, message: "y", rows: [41, 42], subject: "rows:41,42" };
const clearing: DecisionFinding = { code: "CLEARING_ACCOUNT_BALANCE", layer: 2, severity: "warning", accountCode: "1190", message: "z", rows: [9], subject: "code:1190" };
const other: DecisionFinding = { code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: "4000", message: "classify" };
const DEFAULT = { ENTITY_NAME_DIFFERS: true, CLEARING_ACCOUNT_BALANCE: false, UNRECOGNISED_TRAILING_TEXT: false };
const POLICY = { ...DEFAULT, CLEARING_ACCOUNT_BALANCE: true };
const dec = (code: string, subject: string, action: string, resolves = true): CurrentDecision => ({ decisionId: `${code}-${action}`, code, subject, action, resolves });

describe("applyDecisions — the requirement model", () => {
  it("default workspace: only the entity finding holds acceptance; clearing and trailing text are review notes", () => {
    const r = applyDecisions([entity, trailing, clearing, other], [], DEFAULT);
    expect(r.undecided.map((f) => f.code)).toEqual(["ENTITY_NAME_DIFFERS"]);
    expect(r.notes.map((f) => f.code)).toEqual(["UNRECOGNISED_TRAILING_TEXT", "CLEARING_ACCOUNT_BALANCE"]);
    expect(r.findings.filter((f) => f.code !== "NEEDS_REVIEW").map((f) => [f.code, f.decision_required]))
      .toEqual([["ENTITY_NAME_DIFFERS", true], ["UNRECOGNISED_TRAILING_TEXT", false], ["CLEARING_ACCOUNT_BALANCE", false]]);
    expect(r.findings.find((f) => f.code === "NEEDS_REVIEW")).toEqual(other); // not a decision-taking finding: unchanged
  });
  it("under a require-decision policy an unexplained clearing balance holds acceptance; trailing text never does", () => {
    const r = applyDecisions([trailing, clearing], [], POLICY);
    expect(r.undecided.map((f) => f.code)).toEqual(["CLEARING_ACCOUNT_BALANCE"]);
    expect(r.notes.map((f) => f.code)).toEqual(["UNRECOGNISED_TRAILING_TEXT"]);
  });
  it("cites each current decision by identity; a decision for another subject never applies", () => {
    const r = applyDecisions([entity, clearing], [dec("ENTITY_NAME_DIFFERS", "invented beta trading", "same_entity"), dec("CLEARING_ACCOUNT_BALANCE", "code:1195", "explained")], POLICY);
    expect(r.findings.find((f) => f.code === "ENTITY_NAME_DIFFERS")?.decision).toEqual({ id: "ENTITY_NAME_DIFFERS-same_entity", action: "same_entity" });
    expect(r.findings.find((f) => f.code === "CLEARING_ACCOUNT_BALANCE")?.decision).toBeUndefined();
    expect(r.undecided.map((f) => f.code)).toEqual(["CLEARING_ACCOUNT_BALANCE"]);
  });
  it("a different-entity decision blocks with the recovery; 'part of the trial balance' blocks with a layout correction", () => {
    const r = applyDecisions([entity, trailing], [dec("ENTITY_NAME_DIFFERS", "invented beta trading", "different_entity", false),
      dec("UNRECOGNISED_TRAILING_TEXT", "rows:41,42", "part_of_trial_balance", false)], DEFAULT);
    expect(r.blocking.map((b) => [b.code, b.severity])).toEqual([["ENTITY_WRONG_DESTINATION", "error"], ["LAYOUT_CORRECTION_REQUIRED", "error"]]);
    expect(r.blocking[0].message).toContain("Invented Beta Trading");
    expect(r.findings.filter((f) => f.decision).length).toBe(2);
    expect(r.findings.some((f) => /plug|adjust|suspense entry/i.test(f.message))).toBe(false);
  });
  it("an unknown requirement is never guessed", () => {
    expect(() => applyDecisions([entity], [], {})).toThrow(/no requirement known/);
  });
  it("the post-snapshot comparisons: decisions by id and action in any order; requirements code by code", () => {
    const a = [dec("A_CODE", "s", "x"), dec("B_CODE", "t", "y")];
    expect(sameDecisions(a, [...a].reverse())).toBe(true);
    expect(sameDecisions(a, [a[0]])).toBe(false);
    expect(sameRequirements(DEFAULT, { ...DEFAULT })).toBe(true);
    expect(sameRequirements(DEFAULT, POLICY)).toBe(false);
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
  it("maps the duplicate, period and review codes that must not bypass a generation-7 manifest, and rejects unknown codes", () => {
    expect(FINDING_RULE.DUPLICATE_ACCOUNT_CODE).toBe("duplicate_identities");
    expect(FINDING_RULE.PERIOD_MISMATCH).toBe("period_and_currency");
    expect(FINDING_RULE.NEEDS_REVIEW).toBe("classification");
    const rules = evaluationManifest([], "complete", true).rules;
    expect(manifestAgrees([{ ...other, code: "UNSUPPORTED_SYNTHETIC_FINDING" }], rules)).toBe(false);
  });
});

describe("reading the authorities", () => {
  it("decisions are read strictly; a missing function is 'unavailable' (refuse before writing); other errors throw", async () => {
    const ok = await readCurrentDecisions(async () => ({ data: [{ decision_id: "d", code: "C_CODE", subject: "s", action: "a", resolves: true }], error: null }), "u");
    expect(ok).toEqual({ kind: "read", decisions: [{ decisionId: "d", code: "C_CODE", subject: "s", action: "a", resolves: true }] });
    expect(await readCurrentDecisions(async () => ({ data: null, error: { code: "PGRST202" } }), "u")).toEqual({ kind: "unavailable" });
    await expect(readCurrentDecisions(async () => ({ data: null, error: { code: "57014" } }), "u")).rejects.toThrow(/lookup failed/);
    await expect(readCurrentDecisions(async () => ({ data: [{ code: "x" }], error: null }), "u")).rejects.toThrow(/malformed/);
  });
  it("requirements are read strictly: every decision-taking code must be answered; a missing function is 'unavailable'", async () => {
    expect(await readRequirements(async () => ({ data: DEFAULT, error: null }), "c")).toEqual({ kind: "read", requirements: DEFAULT });
    expect(await readRequirements(async () => ({ data: null, error: { code: "42883" } }), "c")).toEqual({ kind: "unavailable" });
    await expect(readRequirements(async () => ({ data: { ENTITY_NAME_DIFFERS: true }, error: null }), "c")).rejects.toThrow(/malformed/);
  });
});
