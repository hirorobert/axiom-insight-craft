import { describe, expect, it } from "vitest";
import { CanonicalValidationError, safeValidateCanonicalReport, validateCanonicalReport } from "./validation";
import { IFRS_FULL_FIXTURE } from "./fixtures/ifrsFullFixture";
import { IPSAS_CASH_FIXTURE } from "./fixtures/ipsasCashFixture";
import { DEFECTIVE_FIXTURE } from "./fixtures/defectiveFixture";
import { CANONICAL_SCHEMA_VERSION } from "./types";
import type { CanonicalFinancialStatementReport } from "./types";

function isInvalid(input: unknown): boolean {
  return safeValidateCanonicalReport(input).status === "INVALID";
}

function issuesFor(input: unknown): readonly { path: readonly (string | number)[]; code: string; message: string }[] {
  const result = safeValidateCanonicalReport(input);
  if (result.status === "VALID") throw new Error("expected INVALID but got VALID");
  return result.issues;
}

describe("validateCanonicalReport / safeValidateCanonicalReport — the happy path", () => {
  it("accepts the IFRS golden fixture unchanged", () => {
    expect(() => validateCanonicalReport(IFRS_FULL_FIXTURE)).not.toThrow();
  });

  it("safeValidateCanonicalReport never throws, even for garbage input", () => {
    expect(() => safeValidateCanonicalReport(null)).not.toThrow();
    expect(() => safeValidateCanonicalReport(undefined)).not.toThrow();
    expect(() => safeValidateCanonicalReport(42)).not.toThrow();
    expect(() => safeValidateCanonicalReport("not a report")).not.toThrow();
    expect(() => safeValidateCanonicalReport({})).not.toThrow();
    expect(isInvalid(null)).toBe(true);
  });

  it("validateCanonicalReport throws CanonicalValidationError, carrying structured path-addressable issues", () => {
    try {
      validateCanonicalReport({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CanonicalValidationError);
      const err = e as CanonicalValidationError;
      expect(err.issues.length).toBeGreaterThan(0);
      expect(Array.isArray(err.issues[0].path)).toBe(true);
    }
  });

  it("a validation-passing aggregate can still be a defective one under the rule pack — see the defective fixture", () => {
    // This is the exact property section G's adversarial-fixture requirement
    // depends on: an aggregate can be schema-valid while still tripping
    // every business rule.
    expect(() => validateCanonicalReport(DEFECTIVE_FIXTURE)).not.toThrow();
  });

  it("the IPSAS cash fixture (no SFP at all) is valid for its own framework", () => {
    expect(() => validateCanonicalReport(IPSAS_CASH_FIXTURE)).not.toThrow();
  });
});

describe("1. schemaVersion must exactly equal CANONICAL_SCHEMA_VERSION", () => {
  it("rejects a mismatched schemaVersion", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, schemaVersion: "0.9.0" })).toBe(true);
  });
  it("confirms the constant itself is what golden fixtures declare", () => {
    expect(IFRS_FULL_FIXTURE.schemaVersion).toBe(CANONICAL_SCHEMA_VERSION);
  });
});

describe("2. reportVersion must be an integer >= 1", () => {
  it("rejects reportVersion 0", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportVersion: 0 } })).toBe(true);
  });
  it("rejects a non-integer reportVersion", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportVersion: 1.5 } })).toBe(true);
  });
});

describe("3. IDs must be non-empty and unique within their namespace", () => {
  it("rejects an empty reportId", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, reportIdentity: { ...IFRS_FULL_FIXTURE.reportIdentity, reportId: "" } })).toBe(true);
  });

  it("rejects two statements sharing a statementId", () => {
    const duplicated = { ...IFRS_FULL_FIXTURE, statements: [IFRS_FULL_FIXTURE.statements[0], { ...IFRS_FULL_FIXTURE.statements[0] }] };
    expect(isInvalid(duplicated)).toBe(true);
  });

  it("rejects two lines sharing a lineId across the whole report", () => {
    const [sfp, ...rest] = IFRS_FULL_FIXTURE.statements;
    const duplicatedLine = { ...sfp.sections[0].lines[0] };
    const mutated = {
      ...IFRS_FULL_FIXTURE,
      statements: [{ ...sfp, sections: [{ ...sfp.sections[0], lines: [...sfp.sections[0].lines, duplicatedLine] }, ...sfp.sections.slice(1)] }, ...rest],
    };
    expect(isInvalid(mutated)).toBe(true);
  });

  it("rejects two notes sharing a noteId", () => {
    const mutated = { ...IFRS_FULL_FIXTURE, notes: [...IFRS_FULL_FIXTURE.notes, { ...IFRS_FULL_FIXTURE.notes[0] }] };
    expect(isInvalid(mutated)).toBe(true);
  });

  it("rejects two note references sharing a noteReferenceId", () => {
    const mutated = { ...IFRS_FULL_FIXTURE, noteReferences: [...IFRS_FULL_FIXTURE.noteReferences, { ...IFRS_FULL_FIXTURE.noteReferences[0] }] };
    expect(isInvalid(mutated)).toBe(true);
  });
});

describe("4. dates must be valid ISO calendar dates", () => {
  it("rejects a malformed date string", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { ...IFRS_FULL_FIXTURE.period, startDate: "not-a-date" } })).toBe(true);
  });
  it("rejects a calendar-invalid date (February 30th)", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { ...IFRS_FULL_FIXTURE.period, startDate: "2026-02-30" } })).toBe(true);
  });
  it("rejects April 31st (a real month with the wrong day count)", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { ...IFRS_FULL_FIXTURE.period, endDate: "2026-04-31" } })).toBe(true);
  });
});

describe("5. reporting startDate must be <= endDate", () => {
  it("rejects a period ending before it starts", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { ...IFRS_FULL_FIXTURE.period, startDate: "2026-12-31", endDate: "2026-01-01" } })).toBe(true);
  });
});

describe("6. periodYear must agree with the declared reporting-period convention", () => {
  it("rejects a periodYear matching neither the start nor end year", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { ...IFRS_FULL_FIXTURE.period, periodYear: 1999 } })).toBe(true);
  });
  it("accepts a fiscal year spanning two calendar years, labeled by its start year (IPSAS convention)", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, period: { periodId: "CURRENT", startDate: "2026-07-01", endDate: "2027-06-30", periodYear: 2026 } })).toBe(false);
  });
});

describe("7. current and comparative periodIds must be unique", () => {
  it("rejects two comparative periods sharing a periodId", () => {
    const dup = { ...IFRS_FULL_FIXTURE.comparativePeriods[0] };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, comparativePeriods: [...IFRS_FULL_FIXTURE.comparativePeriods, dup] })).toBe(true);
  });
});

describe("8. comparative periods must not reuse the current period's periodId", () => {
  it("rejects a comparative period declaring periodId \"CURRENT\"", () => {
    const bad = { ...IFRS_FULL_FIXTURE.comparativePeriods[0], periodId: "CURRENT" };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, comparativePeriods: [bad] })).toBe(true);
  });
});

describe("9. comparative startDate must be <= endDate", () => {
  it("rejects a comparative period ending before it starts", () => {
    const bad = { ...IFRS_FULL_FIXTURE.comparativePeriods[0], startDate: "2025-12-31", endDate: "2025-01-01" };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, comparativePeriods: [bad] })).toBe(true);
  });
});

describe("10. sourceHash must be exactly 64 hexadecimal characters", () => {
  it("rejects a short hash", () => {
    const badFact = { ...IFRS_FULL_FIXTURE.facts[0], provenance: { ...IFRS_FULL_FIXTURE.facts[0].provenance, source: { ...IFRS_FULL_FIXTURE.facts[0].provenance.source, sourceHash: "abc123" } } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [badFact, ...IFRS_FULL_FIXTURE.facts.slice(1)] })).toBe(true);
  });
  it("accepts uppercase hex too", () => {
    // A distinct sourceDocumentId avoids also tripping point 22 (conflicting
    // hashes for one sourceDocumentId) — this test isolates point 10 alone.
    const okFact = {
      ...IFRS_FULL_FIXTURE.facts[0],
      provenance: { ...IFRS_FULL_FIXTURE.facts[0].provenance, source: { ...IFRS_FULL_FIXTURE.facts[0].provenance.source, sourceDocumentId: "uppercase-hash-source", sourceHash: "A".repeat(64) } },
    };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [okFact, ...IFRS_FULL_FIXTURE.facts.slice(1)] })).toBe(false);
  });
});

describe("11. an ESTIMATED extraction confidence score must be finite and within [0, 1]", () => {
  function withConfidence(score: number) {
    const badFact = {
      ...IFRS_FULL_FIXTURE.facts[0],
      provenance: { ...IFRS_FULL_FIXTURE.facts[0].provenance, extractionConfidence: { kind: "ESTIMATED" as const, score } },
    };
    return { ...IFRS_FULL_FIXTURE, facts: [badFact, ...IFRS_FULL_FIXTURE.facts.slice(1)] };
  }
  it("rejects a score above 1", () => expect(isInvalid(withConfidence(1.5))).toBe(true));
  it("rejects a negative score", () => expect(isInvalid(withConfidence(-0.1))).toBe(true));
  it("rejects a non-finite score", () => expect(isInvalid(withConfidence(Number.POSITIVE_INFINITY))).toBe(true));
  it("rejects NaN", () => expect(isInvalid(withConfidence(Number.NaN))).toBe(true));
  it("accepts exactly 0 and exactly 1", () => {
    expect(isInvalid(withConfidence(0))).toBe(false);
    expect(isInvalid(withConfidence(1))).toBe(false);
  });
});

describe("12. presentationMultiplier must be one of the supported values", () => {
  it("rejects an unsupported multiplier", () => {
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, presentationCurrency: { ...IFRS_FULL_FIXTURE.presentationCurrency, presentationMultiplier: 5n } })).toBe(true);
  });
  it("accepts 1n, 1000n, and 1000000n", () => {
    for (const multiplier of [1n, 1000n, 1000000n]) {
      expect(isInvalid({ ...IFRS_FULL_FIXTURE, presentationCurrency: { ...IFRS_FULL_FIXTURE.presentationCurrency, presentationMultiplier: multiplier } })).toBe(false);
    }
  });
});

describe("13. roundingPolicy.scale must equal presentationCurrency.scale", () => {
  it("rejects a mismatched rounding scale", () => {
    const bad = { ...IFRS_FULL_FIXTURE.presentationCurrency, roundingPolicy: { ...IFRS_FULL_FIXTURE.presentationCurrency.roundingPolicy, scale: 4 } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, presentationCurrency: bad })).toBe(true);
  });
});

describe("14. Money must be structurally well-formed (currency/scale shape)", () => {
  it("rejects a lowercase currency code", () => {
    const badFact = { ...IFRS_FULL_FIXTURE.facts[0], value: { ...IFRS_FULL_FIXTURE.facts[0].value, currency: "tzs" } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [badFact, ...IFRS_FULL_FIXTURE.facts.slice(1)] })).toBe(true);
  });
  it("rejects a negative scale", () => {
    const badFact = { ...IFRS_FULL_FIXTURE.facts[0], value: { ...IFRS_FULL_FIXTURE.facts[0].value, scale: -1 } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [badFact, ...IFRS_FULL_FIXTURE.facts.slice(1)] })).toBe(true);
  });
  it("deliberately does NOT reject a fact whose currency differs from the report's presentation currency — that is Rule 5's job, not validation's (see the defective fixture)", () => {
    const usdFact = { ...IFRS_FULL_FIXTURE.facts[0], factId: "usd-fact", value: { ...IFRS_FULL_FIXTURE.facts[0].value, currency: "USD" } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, usdFact] })).toBe(false);
  });
});

describe("15. every fact a binding/note/movement-schedule references must exist", () => {
  it("rejects a factBinding pointing at a nonexistent factId", () => {
    const [sfp, ...rest] = IFRS_FULL_FIXTURE.statements;
    const badLine = { ...sfp.sections[0].lines[0], factBindings: [{ periodId: "CURRENT", factId: "does-not-exist" }] };
    const mutated = { ...IFRS_FULL_FIXTURE, statements: [{ ...sfp, sections: [{ ...sfp.sections[0], lines: [badLine, ...sfp.sections[0].lines.slice(1)] }, ...sfp.sections.slice(1)] }, ...rest] };
    expect(isInvalid(mutated)).toBe(true);
  });

  it("rejects a Note.totalFactId pointing at a nonexistent fact", () => {
    const badNote = { noteId: "bad-note", noteNumber: "99", title: "Bad", monetaryFactIds: [], totalFactId: "does-not-exist" };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, notes: [...IFRS_FULL_FIXTURE.notes, badNote] })).toBe(true);
  });

  it("deliberately does NOT reject a NoteReference whose toNoteId/fromLineId is dangling — that is Rule 10's job (see the defective fixture, which has exactly this and still validates)", () => {
    const broken = { noteReferenceId: "nr-broken-standalone", fromLineId: "no-such-line", toNoteId: "no-such-note" };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, noteReferences: [...IFRS_FULL_FIXTURE.noteReferences, broken] })).toBe(false);
  });
});

describe("16. every (factId, version) pair must be unique", () => {
  it("rejects two facts sharing the same factId AND version", () => {
    const dup = { ...IFRS_FULL_FIXTURE.facts[0] };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, dup] })).toBe(true);
  });
});

describe("17. each fact lineage must begin at version 1 with supersedesVersion=null", () => {
  it("rejects a fact whose only version is 2", () => {
    const bad = { ...IFRS_FULL_FIXTURE.facts[0], factId: "orphan-v2", version: 2, supersedesVersion: 1 };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, bad] })).toBe(true);
  });
  it("rejects a version-1 fact that declares a non-null supersedesVersion", () => {
    const bad = { ...IFRS_FULL_FIXTURE.facts[0], factId: "bad-v1", version: 1, supersedesVersion: 5 };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, bad] })).toBe(true);
  });
});

describe("18. later fact versions must form one contiguous, non-branching chain", () => {
  it("rejects a version chain with a gap (1 then 3, no 2)", () => {
    const v1 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "gappy", version: 1, supersedesVersion: null };
    const v3 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "gappy", version: 3, supersedesVersion: 2 };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, v1, v3] })).toBe(true);
  });
  it("rejects a branching chain (two different v2's both claiming supersedesVersion=1)", () => {
    const v1 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "forked", version: 1, supersedesVersion: null };
    const v2a = { ...IFRS_FULL_FIXTURE.facts[0], factId: "forked", version: 2, supersedesVersion: 1 };
    const v2b = { ...IFRS_FULL_FIXTURE.facts[0], factId: "forked", version: 2, supersedesVersion: 1 };
    // v2a and v2b share (factId, version) so point 16 also fires — that's fine, both are genuine defects here.
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, v1, v2a, v2b] })).toBe(true);
  });
  it("accepts a genuine multi-version chain (1 -> 2 -> 3)", () => {
    const v1 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "clean-chain", version: 1, supersedesVersion: null };
    const v2 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "clean-chain", version: 2, supersedesVersion: 1 };
    const v3 = { ...IFRS_FULL_FIXTURE.facts[0], factId: "clean-chain", version: 3, supersedesVersion: 2 };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, v1, v2, v3] })).toBe(false);
  });
});

describe("20. casting children must exist, belong to the same statement, and never include the casting line itself", () => {
  it("rejects a castingChildLineIds entry pointing outside the statement", () => {
    const [sfp, pnl, ...rest] = IFRS_FULL_FIXTURE.statements;
    const foreignLineId = pnl.sections[0].lines[0].lineId;
    const totalLine = sfp.sections[0].lines.find((l) => l.role === "TOTAL")!;
    const badTotal = { ...totalLine, castingChildLineIds: [foreignLineId] };
    const mutatedSfp = { ...sfp, sections: sfp.sections.map((s) => ({ ...s, lines: s.lines.map((l) => (l.lineId === totalLine.lineId ? badTotal : l)) })) };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, statements: [mutatedSfp, pnl, ...rest] })).toBe(true);
  });

  it("rejects a line listing itself as its own casting child", () => {
    const [sfp, ...rest] = IFRS_FULL_FIXTURE.statements;
    const totalLine = sfp.sections[0].lines.find((l) => l.role === "TOTAL")!;
    const selfReferencing = { ...totalLine, castingChildLineIds: [...totalLine.castingChildLineIds, totalLine.lineId] };
    const mutatedSfp = { ...sfp, sections: sfp.sections.map((s) => ({ ...s, lines: s.lines.map((l) => (l.lineId === totalLine.lineId ? selfReferencing : l)) })) };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, statements: [mutatedSfp, ...rest] })).toBe(true);
  });
});

describe("21. movement schedules must contain valid fact references", () => {
  it("rejects a movement schedule whose closingBalanceFactId does not exist", () => {
    const [note] = IFRS_FULL_FIXTURE.notes;
    const badNote = { ...note, movementSchedule: { ...note.movementSchedule!, closingBalanceFactId: "does-not-exist" } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, notes: [badNote, ...IFRS_FULL_FIXTURE.notes.slice(1)] })).toBe(true);
  });
  it("rejects a movement schedule whose additionFactIds entry does not exist", () => {
    const [note] = IFRS_FULL_FIXTURE.notes;
    const badNote = { ...note, movementSchedule: { ...note.movementSchedule!, additionFactIds: ["does-not-exist"] } };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, notes: [badNote, ...IFRS_FULL_FIXTURE.notes.slice(1)] })).toBe(true);
  });
});

describe("22. no duplicate source-document IDs with conflicting hashes", () => {
  it("rejects two facts sharing a sourceDocumentId but disagreeing on sourceHash", () => {
    const conflicting = {
      ...IFRS_FULL_FIXTURE.facts[0],
      factId: "conflicting-source",
      provenance: {
        ...IFRS_FULL_FIXTURE.facts[0].provenance,
        source: { ...IFRS_FULL_FIXTURE.facts[0].provenance.source, sourceHash: "f".repeat(64) },
      },
    };
    expect(isInvalid({ ...IFRS_FULL_FIXTURE, facts: [...IFRS_FULL_FIXTURE.facts, conflicting] })).toBe(true);
  });
  it("accepts many facts sharing the same sourceDocumentId AND the same hash (the normal case — one uploaded document, many facts)", () => {
    expect(isInvalid(IFRS_FULL_FIXTURE)).toBe(false); // every fixture fact already shares FIXTURE_SOURCE
  });
});

describe("24. framework-specific structural contradictions must fail validation", () => {
  it("rejects an IPSAS_CASH report that contains a statement of financial position", () => {
    const mutated: CanonicalFinancialStatementReport = {
      ...IPSAS_CASH_FIXTURE,
      statements: [...IPSAS_CASH_FIXTURE.statements, IFRS_FULL_FIXTURE.statements[0]],
    };
    expect(isInvalid(mutated)).toBe(true);
  });
  it("rejects an IPSAS_CASH report with no cash receipts and payments statement", () => {
    expect(isInvalid({ ...IPSAS_CASH_FIXTURE, statements: [] })).toBe(true);
  });
  it("rejects a non-cash-basis report (IFRS) with no statement of financial position", () => {
    const withoutSfp = { ...IFRS_FULL_FIXTURE, statements: IFRS_FULL_FIXTURE.statements.filter((s) => s.type !== "STATEMENT_OF_FINANCIAL_POSITION") };
    expect(isInvalid(withoutSfp)).toBe(true);
  });
  it("rejects an IFRS report that (nonsensically) also contains a cash-receipts-and-payments statement", () => {
    const mutated = { ...IFRS_FULL_FIXTURE, statements: [...IFRS_FULL_FIXTURE.statements, IPSAS_CASH_FIXTURE.statements[0]] };
    expect(isInvalid(mutated)).toBe(true);
  });
});

describe("issues are path-addressable", () => {
  it("reports a specific, navigable path for a schemaVersion mismatch", () => {
    const issues = issuesFor({ ...IFRS_FULL_FIXTURE, schemaVersion: "bogus" });
    expect(issues.some((i) => i.path.join(".") === "schemaVersion")).toBe(true);
  });
});
