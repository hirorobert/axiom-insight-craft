import { describe, expect, it } from "vitest";
import { deriveNextAction, isWorkspaceStage, WORKSPACE_STAGES } from "./nextAction";
import type { StructureModel, StructureDiagnostic } from "./structureModel";
import type { FindingView } from "./findingsView";

const model = (codes: StructureDiagnostic["code"][], blockers: string[] = []): StructureModel => ({
  framework: { label: "x", resolved: true },
  period: { label: "p", basisNote: null },
  comparative: { label: "2024", available: true },
  currency: { label: "TZS", resolved: true },
  scale: { label: "s" },
  mapping: null,
  composition: { entries: [], blockers },
  diagnostics: codes.map((code) => ({ code, severity: "BLOCKING" as const, message: code })),
  hasBlocking: codes.length > 0,
});
const view = (bucket: FindingView["bucket"]) => ({ bucket }) as FindingView;

describe("deriveNextAction", () => {
  it("has exactly seven ordered stages", () => {
    expect(WORKSPACE_STAGES).toEqual(["sources", "structure", "statements", "notes", "validate", "review", "outputs"]);
    expect(isWorkspaceStage("review")).toBe(true);
    expect(isWorkspaceStage("hesabu")).toBe(false);
  });

  it("returns the first unmet precondition, in order", () => {
    expect(deriveNextAction({ structure: model(["COMPARATIVE_MISSING", "FRAMEWORK_NOT_SET"]), views: [], hasReport: true }).stage).toBe("sources");
    expect(deriveNextAction({ structure: model(["FRAMEWORK_NOT_SET", "ACCOUNTS_UNMAPPED"]), views: [], hasReport: true }).stage).toBe("structure");
    expect(deriveNextAction({ structure: model(["ACCOUNTS_UNMAPPED"]), views: [], hasReport: true }).label).toBe("Resolve account mapping");
    expect(deriveNextAction({ structure: model([]), views: [view("BLOCKING"), view("INSUFFICIENT_EVIDENCE")], hasReport: true })).toMatchObject({ stage: "review", label: "Review 2 open findings" });
    expect(deriveNextAction({ structure: model([], ["SCF incomplete"]), views: [view("PASSED")], hasReport: true }).stage).toBe("statements");
    expect(deriveNextAction({ structure: model([]), views: [view("PASSED")], hasReport: true }).stage).toBe("outputs");
  });

  it("never proposes outputs while the statement set is incomplete", () => {
    expect(deriveNextAction({ structure: model([], ["Cash flow incomplete"]), views: [], hasReport: true }).stage).not.toBe("outputs");
  });
});
