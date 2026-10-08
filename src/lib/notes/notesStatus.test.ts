import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REQUIREMENT_STATUSES, STATUS_WORDS, needsWork, notesClient, parseNotesStatus, scheduleReconciliation, type RequirementState } from "./notesStatus";

// The notes status and, since 20261022100000, the comprehensive-income evaluation it appends.
const SQL = ["20261019100000_fs_notes_and_schedules.sql", "20261022100000_fs_reporting_closure.sql"]
  .map((f) => fs.readFileSync(path.join(__dirname, "../../../supabase/migrations", f), "utf8")).join("\n");

describe("status words: one per server state, nothing merged", () => {
  it("every status the database can return has its own word, and every word names a status the database returns", () => {
    // The server's states, read from fs_notes_status: v_status := '<state>' and the CASE outcomes.
    const server = new Set([...SQL.matchAll(/v_status := (?:CASE WHEN v_comp_ok THEN )?'([a-z_]+)'(?: ELSE '([a-z_]+)' END)?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
    expect([...server].sort()).toEqual([...REQUIREMENT_STATUSES].sort());
    expect(Object.keys(STATUS_WORDS).sort()).toEqual([...REQUIREMENT_STATUSES].sort());
    expect(new Set(Object.values(STATUS_WORDS)).size).toBe(REQUIREMENT_STATUSES.length);
  });
  it("needs-work states are exactly the unresolved ones (a not-verified opening is stated, not counted as done or failed)", () => {
    const states = REQUIREMENT_STATUSES.filter((s) => needsWork({ requirementId: "x", kind: "DISCLOSURE", blocking: true, status: s }));
    expect(states.sort()).toEqual(["closing_mismatch", "dates_unknown", "evidence_missing", "incomplete", "missing", "opening_mismatch", "undecided", "unsupported"].sort());
  });
});

describe("schedule reconciliation text (hand-written expectations)", () => {
  const ppe = (o: Partial<RequirementState>): RequirementState => ({ requirementId: "smes.schedule.ppe", kind: "SCHEDULE", blocking: true, status: "reconciled", scheduleId: "ppe", ...o });
  it("reconciled both ways", () => {
    const r = scheduleReconciliation(ppe({ scheduleOpeningMinor: "1600000", scheduleClosingMinor: "1400000", composedOpeningMinor: "1600000", composedClosingMinor: "1400000" }), 2)!;
    expect([r.opening.schedule.text, r.opening.statement.text, r.closing.schedule.text, r.closing.statement.text, r.difference]).toEqual(["16,000.00", "16,000.00", "14,000.00", "14,000.00", null]);
  });
  it("a closing mismatch shows its exact difference; an unverified opening shows the statement side as missing with the reason", () => {
    const a = scheduleReconciliation(ppe({ status: "closing_mismatch", scheduleClosingMinor: "1500000", composedClosingMinor: "1400000", differenceMinor: "100000", scheduleOpeningMinor: "1700000", composedOpeningMinor: "1600000" }), 2)!;
    expect(a.difference!.text).toBe("1,000.00");
    const b = scheduleReconciliation(ppe({ status: "reconciled_opening_unverified", scheduleOpeningMinor: "1600000", scheduleClosingMinor: "1400000", composedOpeningMinor: null, composedClosingMinor: "1400000" }), 2)!;
    expect([b.opening.statement.text, b.opening.statement.description]).toEqual(["—", "Not available: no authoritative prior-year statement"]);
  });
  it("a non-schedule requirement has no reconciliation", () => {
    expect(scheduleReconciliation({ requirementId: "smes.note.compliance", kind: "DISCLOSURE", blocking: true, status: "missing" }, 2)).toBeNull();
  });
});

describe("payload validation and server calls", () => {
  const evaluated = { state: "evaluated", contract: "fs-notes-status/2", packId: "ifrs-for-smes/2015", compositionSha256: "a".repeat(64), periodYear: 2026,
    requirements: [{ requirementId: "smes.note.compliance", kind: "DISCLOSURE", blocking: true, status: "missing" }], blockers: ["REQUIRED_DISCLOSURE_MISSING:smes.note.compliance"], statusSha256: "b".repeat(64) };
  it("accepts the evaluated payload and pass-through states; refuses an unknown status", () => {
    expect(parseNotesStatus(evaluated).state).toBe("evaluated");
    expect(parseNotesStatus({ state: "edition_unresolved", reason: "PERIOD_START_UNKNOWN" }).state).toBe("edition_unresolved");
    expect(() => parseNotesStatus({ ...evaluated, requirements: [{ ...evaluated.requirements[0], status: "done" }] })).toThrow();
  });
  it("calls the four server functions with exactly these arguments", async () => {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "fs_notes_status" ? evaluated : { outcome: "recorded" }, error: null }));
    const c = notesClient({ rpc });
    await c.status("co", 2026);
    await c.decide("co", 2026, "smes.note.share_capital", "applicable", "The entity has share capital", "r1");
    await c.disclose("co", 2026, "smes.note.compliance", "Prepared under the IFRS for SMEs.", "Notes v1", "r2");
    await c.recordSchedule("co", 2026, "ppe", [{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }], "FA register", "r3");
    expect(rpc.mock.calls.map((c2) => c2[0])).toEqual(["fs_notes_status", "fs_decide_requirement", "fs_record_disclosure", "fs_record_schedule"]);
    expect(rpc.mock.calls[2][1]).toEqual({ p_company_id: "co", p_period_year: 2026, p_requirement_id: "smes.note.compliance", p_body: "Prepared under the IFRS for SMEs.", p_source_ref: "Notes v1", p_request_id: "r2" });
  });
  it("writes no table, generates no wording, reaches no withheld service", () => {
    const src = fs.readFileSync(path.join(__dirname, "notesStatus.ts"), "utf8");
    expect(src).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(src).not.toMatch(/kinga|generate-disclosure-notes|generate-management-letter|generate-xbrl|anthropic|openai/i);
  });
});
