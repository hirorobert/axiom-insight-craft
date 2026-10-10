import { describe, expect, it } from "vitest";
import { sealedEditionTitle } from "./sealedPack";

const doc = (version: string | undefined, startDate: string, kind: "IFRS_FOR_SMES" | "IFRS" = "IFRS_FOR_SMES") =>
  ({ framework: version ? { kind, version } : { kind }, period: { periodId: "CURRENT", startDate, endDate: "x", periodYear: 0 } }) as never;

describe("a sealed pack's edition comes from the saved version, never the workspace", () => {
  it("prints the edition recorded with the version", () => {
    expect(sealedEditionTitle(doc("ifrs-for-smes/2015", "2025-01-01"))).toBe("IFRS for SMEs (2015 edition)");
    expect(sealedEditionTitle(doc("ifrs-for-smes/2025", "2025-01-01"))).toBe("IFRS for SMEs Accounting Standard (third edition, 2025)");
  });
  it("a version saved before the edition was recorded prints the edition its period start requires (as hosted version 6)", () => {
    expect(sealedEditionTitle(doc(undefined, "2025-01-01"))).toBe("IFRS for SMEs (2015 edition)");
    expect(sealedEditionTitle(doc(undefined, "2027-01-01"))).toBe("IFRS for SMEs Accounting Standard (third edition, 2025)");
  });
  it("another framework prints its own name", () => {
    expect(sealedEditionTitle(doc(undefined, "2025-01-01", "IFRS"))).toBe("IFRS");
  });
});
