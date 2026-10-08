import { describe, expect, it } from "vitest";
import { composition } from "@/lib/statements/compositionFixture";
import type { CompositionResult } from "@/lib/statements/composition";
import type { NotesStatusResult } from "@/lib/notes/notesStatus";
import type { ComparativeStatus } from "@/lib/comparatives/comparatives";
import { nextReportingAction, type NextActionInput } from "./nextAction";

const H = (c: string) => c.repeat(64);
const notes = (reqs: { id: string; kind: "DISCLOSURE" | "SCHEDULE" | "STATEMENT"; status: string; blocking?: boolean }[]): NotesStatusResult => ({
  state: "evaluated", contract: "fs-notes-status/1", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"),
  requirements: reqs.map((r) => ({ requirementId: r.id, kind: r.kind, status: r.status, blocking: r.blocking ?? true })),
} as NotesStatusResult);
const cmp = (state: string): ComparativeStatus => ({ state: "evaluated", statusSha256: H("e"), comparative: {
  contract: "fs-comparatives-status/1", periodYear: 2026, state, composedComparativeState: "available", required: true, firstPeriodDeclared: false,
  comparativeSha256: H("f"), compositionSha256: H("b"), approval: null, blockers: [] } } as ComparativeStatus);
const ready: NextActionInput = {
  composition: composition as CompositionResult, notes: notes([{ id: "smes.note.policies", kind: "DISCLOSURE", status: "provided" }]), comparatives: cmp("approved"),
  latest: { reportVersion: 2, state: "DRAFT", blockers: [] }, allowed: ["prepare_close", "review_close", "approve_certification"],
};
const at = (over: Partial<NextActionInput>) => nextReportingAction({ ...ready, ...over });

describe("the one next action follows the server's dependency chain", () => {
  it("statements first: not composed, then unassigned accounts (counted from the server's blockers)", () => {
    expect(at({ composition: { state: "no_authority" } }).detail).toMatch(/no reviewed trial balance/);
    const c = { ...composition, blockers: ["PRESENTATION_UNASSIGNED:3", "PRESENTATION_INCOMPATIBLE:1"] } as CompositionResult;
    expect(at({ composition: c })).toMatchObject({ page: "fs-statements", title: "Assign 4 accounts to statement lines" });
  });
  it("then notes, then schedules — only blocking requirements that need work", () => {
    expect(at({ notes: notes([{ id: "smes.note.policies", kind: "DISCLOSURE", status: "missing" }, { id: "smes.schedule.ppe", kind: "SCHEDULE", status: "closing_mismatch" }]) }))
      .toMatchObject({ page: "fs-notes", title: "Complete 1 note requirement" });
    expect(at({ notes: notes([{ id: "smes.schedule.ppe", kind: "SCHEDULE", status: "closing_mismatch" }, { id: "smes.note.x", kind: "DISCLOSURE", status: "missing", blocking: false }]) }))
      .toMatchObject({ page: "fs-schedules", title: "Complete 1 schedule" });
  });
  it("then comparatives: an approval is a reviewer's step, so a preparer sees it as someone else's", () => {
    expect(at({ comparatives: cmp("unapproved"), allowed: ["prepare_close"] })).toMatchObject({ page: "fs-comparatives", tone: "blocked" });
    expect(at({ comparatives: cmp("unapproved") })).toMatchObject({ page: "fs-comparatives", tone: "todo" });
    expect(at({ comparatives: cmp("first_period_exception") }).page).toBe("signoff");
    expect(at({ comparatives: cmp("reference_only") }).title).toBe("Comparatives: Reference only");
  });
  it("then evidence, then a version on the current dependencies", () => {
    expect(at({ notes: notes([{ id: "smes.set.cash_flows", kind: "STATEMENT", status: "evidence_missing" }]) }).title).toMatch(/evidence/);
    expect(at({ latest: null }).title).toBe("Save the first report version");
    expect(at({ latest: { reportVersion: 2, state: "FINAL", blockers: ["REPORTING_DEPENDENCIES_STALE"] } }).title).toBe("Save a new report version");
  });
  it("then the version's own blockers, REVIEWED, FINAL — each by the role that may do it — and finally export", () => {
    expect(at({ latest: { reportVersion: 2, state: "DRAFT", blockers: ["BLOCKING_FINDINGS:1"] } }).title).toBe("Resolve 1 sign-off blocker");
    expect(at({}).title).toBe("Review version 2");
    expect(at({ allowed: ["prepare_close"] })).toMatchObject({ title: "Version 2 awaits review", tone: "blocked" });
    expect(at({ latest: { reportVersion: 2, state: "REVIEWED", blockers: [] } }).title).toBe("Approve version 2 as final");
    expect(at({ latest: { reportVersion: 2, state: "REVIEWED", blockers: [] }, allowed: ["review_close"] }).tone).toBe("blocked");
    expect(at({ latest: { reportVersion: 2, state: "FINAL", blockers: [] } })).toMatchObject({ page: "exports", tone: "done" });
  });
});
