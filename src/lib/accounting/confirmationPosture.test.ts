/**
 * confirmationPosture.test.ts
 *
 * Slice 2 — proves the confidence -> UX posture mapping from directive
 * Section XVII, including the "never ask again once confirmed" override.
 */

import { describe, it, expect } from "vitest";
import { classifyConfirmationPosture } from "./confirmationPosture";
import { unknownProvenance, type Provenance } from "./entityContext";

function provenance(overrides: Partial<Provenance<string>>): Provenance<string> {
  return { ...unknownProvenance("x"), ...overrides };
}

describe("classifyConfirmationPosture", () => {
  it("HIGH confidence -> QUIET_CONFIRMATION", () => {
    expect(classifyConfirmationPosture(provenance({ confidence: "HIGH" }))).toBe(
      "QUIET_CONFIRMATION",
    );
  });

  it("MEDIUM confidence -> COMPACT_QUESTION", () => {
    expect(classifyConfirmationPosture(provenance({ confidence: "MEDIUM" }))).toBe(
      "COMPACT_QUESTION",
    );
  });

  it("LOW confidence -> EXPLICIT_ASK", () => {
    expect(classifyConfirmationPosture(provenance({ confidence: "LOW" }))).toBe("EXPLICIT_ASK");
  });

  it("NONE confidence -> EXPLICIT_ASK", () => {
    expect(classifyConfirmationPosture(provenance({ confidence: "NONE" }))).toBe("EXPLICIT_ASK");
  });

  it("confirmedBy + confirmedAt overrides even LOW confidence to NO_PROMPT_NEEDED", () => {
    const p = provenance({
      confidence: "LOW",
      confirmedBy: "firm-member-1",
      confirmedAt: "2026-01-01T00:00:00Z",
    });
    expect(classifyConfirmationPosture(p)).toBe("NO_PROMPT_NEEDED");
  });

  it("a partial confirmation (only confirmedBy, no confirmedAt) does NOT count as confirmed", () => {
    const p = provenance({ confidence: "HIGH", confirmedBy: "firm-member-1" });
    expect(classifyConfirmationPosture(p)).toBe("QUIET_CONFIRMATION");
  });
});
