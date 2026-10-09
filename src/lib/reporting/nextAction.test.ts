import { describe, expect, it } from "vitest";
import { composition } from "@/lib/statements/compositionFixture";
import type { CompositionResult } from "@/lib/statements/composition";
import type { NotesStatusResult } from "@/lib/notes/notesStatus";
import type { ComparativeStatus } from "@/lib/comparatives/comparatives";
import { nextReportingAction, type NextActionInput } from "./nextAction";

const H = (c: string) => c.repeat(64);
const notes = (reqs: { id: string; kind: "DISCLOSURE" | "SCHEDULE" | "STATEMENT"; status: string; blocking?: boolean }[]): NotesStatusResult => ({
  state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: H("b"), periodYear: 2026, blockers: [], statusSha256: H("c"),
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
  it("notes, then schedules — only blocking requirements that need work", () => {
    expect(at({ notes: notes([{ id: "smes.note.policies", kind: "DISCLOSURE", status: "missing" }, { id: "smes.schedule.ppe", kind: "SCHEDULE", status: "closing_mismatch" }]) }))
      .toMatchObject({ page: "fs-notes", title: "Complete 1 note requirement" });
    expect(at({ notes: notes([{ id: "smes.schedule.ppe", kind: "SCHEDULE", status: "closing_mismatch" }, { id: "smes.note.x", kind: "DISCLOSURE", status: "missing", blocking: false }]) }))
      .toMatchObject({ page: "fs-schedules", title: "Complete 1 schedule" });
  });
  it("comparatives: an approval is a reviewer's step, so a preparer sees it as someone else's", () => {
    expect(at({ comparatives: cmp("unapproved"), allowed: ["prepare_close"] })).toMatchObject({ page: "fs-comparatives", tone: "blocked" });
    expect(at({ comparatives: cmp("unapproved") })).toMatchObject({ page: "fs-comparatives", tone: "todo" });
    expect(at({ comparatives: cmp("first_period_exception") }).page).toBe("signoff");
    expect(at({ comparatives: cmp("reference_only") }).title).toBe("Comparatives: Reference only");
  });
  it("then evidence, then a version on the current dependencies", () => {
    expect(at({ notes: notes([{ id: "smes.set.cash_flows", kind: "STATEMENT", status: "evidence_missing" }]) })).toMatchObject({ page: "fs-statements", title: expect.stringMatching(/evidence/) });
    expect(at({ latest: null }).title).toBe("Save the first report version");
    expect(at({ latest: { reportVersion: 2, state: "FINAL", blockers: ["REPORTING_DEPENDENCIES_STALE"] } }).title).toBe("Save a new report version");
  });
  it("then the version's own blockers, REVIEWED, FINAL — each by the role that may do it — and finally export", () => {
    expect(at({ latest: { reportVersion: 2, state: "DRAFT", blockers: ["BLOCKING_FINDINGS:1"] } }).title).toBe("Resolve 1 sign-off blocker");
    // Close Review is cleared on its own page (released with reporting), never by guessing on Sign-off.
    expect(at({ latest: { reportVersion: 2, state: "DRAFT", blockers: ["CLOSE_REVIEW_FINDINGS_NOT_CHECKED"] } })).toMatchObject({ page: "close-findings", title: "Check the Close Review findings", tone: "todo" });
    expect(at({ latest: { reportVersion: 2, state: "DRAFT", blockers: ["CLOSE_REVIEW_BLOCKING_FINDINGS:2"] }, allowed: ["review_close"] })).toMatchObject({ page: "close-findings", tone: "blocked" });
    expect(at({ latest: { reportVersion: 2, state: "DRAFT", blockers: ["CLOSE_REVIEW_FINDINGS_NOT_CHECKED"] } }).detail).toMatch(/Open Close Review › Findings/);
    expect(at({}).title).toBe("Review version 2");
    expect(at({ allowed: ["prepare_close"] })).toMatchObject({ title: "Version 2 awaits review", tone: "blocked" });
    expect(at({ latest: { reportVersion: 2, state: "REVIEWED", blockers: [] } }).title).toBe("Approve version 2 as final");
    expect(at({ latest: { reportVersion: 2, state: "REVIEWED", blockers: [] }, allowed: ["review_close"] }).tone).toBe("blocked");
    expect(at({ latest: { reportVersion: 2, state: "FINAL", blockers: [] } })).toMatchObject({ page: "exports", tone: "done" });
  });
});

describe("an unsupported reporting case (20261022100000)", () => {
  it("is named first, as a stop rather than a to-do, before any other note work", () => {
    const n = notes([{ id: "smes.note.policies", kind: "DISCLOSURE", status: "missing" }, { id: "smes.sci.5_5_g", kind: "LINE_ITEM" as "DISCLOSURE", status: "unsupported" }]);
    const a = at({ notes: n });
    expect(a).toMatchObject({ page: "fs-notes", tone: "blocked", title: "This report cannot be finalised: a reporting case is not supported" });
    expect(a.detail).not.toMatch(/smes\./);
  });
});

describe("the journey order and readable tasks (commercial candidate)", () => {
  const summary = (o: object) => ({ state: "current", runId: "r", currency: "TZS", exponent: 2, generatedAt: "now", total: 3, unresolved: 0, unresolvedBlocking: 0, ruleStatus: {}, ...o }) as NextActionInput["closeReview"];
  it("Close Review comes first: an unchecked or stale run, then unresolved blocking findings — before statements", () => {
    expect(at({ closeReview: { state: "not_generated" } })).toMatchObject({ page: "close-findings", title: "Run the Close Review checks", tone: "todo" });
    expect(at({ closeReview: { state: "stale" } })).toMatchObject({ page: "close-findings", title: "Run the Close Review checks again" });
    expect(at({ closeReview: { state: "not_generated" }, allowed: ["review_close"] }).tone).toBe("blocked");
    expect(at({ closeReview: summary({ unresolved: 2, unresolvedBlocking: 2 }) })).toMatchObject({ page: "close-findings", title: "Resolve 2 blocking findings" });
    // Even with nothing composed yet, the findings step is named first; checked and clear, the statements step follows.
    expect(at({ closeReview: { state: "not_generated" }, composition: { state: "no_authority" } }).page).toBe("close-findings");
    expect(at({ closeReview: summary({}), composition: { state: "no_authority" } }).page).toBe("fs-statements");
    // Not read (undefined): the version's own Close Review blockers still apply.
    expect(at({ closeReview: undefined }).title).toBe("Review version 2");
  });
  it("comparatives are established before notes: a missing prior period is the next action even while notes are open", () => {
    const openNotes = notes([{ id: "smes.note.policies", kind: "DISCLOSURE", status: "missing" }]);
    expect(at({ notes: openNotes, comparatives: cmp("missing") }).page).toBe("fs-comparatives");
    expect(at({ notes: openNotes }).page).toBe("fs-notes");
  });
  it("names requirements by the framework pack's words, never by their identifiers, and explains the Notes page count", () => {
    const n = notes([
      { id: "smes.note.policies", kind: "DISCLOSURE", status: "missing" },
      { id: "smes.set.cash_flows", kind: "STATEMENT", status: "evidence_missing" },
      { id: "smes.set.changes_in_equity", kind: "STATEMENT", status: "evidence_missing" },
    ]);
    const a = at({ notes: n });
    expect(a.title).toBe("Complete 1 note requirement");
    expect(a.detail).not.toMatch(/smes\./);
    expect(a.detail).toMatch(/2 more need cash-flow or equity evidence \(Statements › Evidence\)/);
    const e = at({ notes: notes([{ id: "smes.set.cash_flows", kind: "STATEMENT", status: "evidence_missing" }]) });
    expect(e).toMatchObject({ page: "fs-statements", title: "Add the evidence for the cash-flow and equity statements" });
    expect(e.detail).not.toMatch(/smes\./);
  });
});
