import { describe, expect, it } from "vitest";
import { checkDetail } from "@/lib/workspace/checkDetail";

const issue = (message: string) => ({ code: "X", message, rows: [], kind: "review" as const });

describe("a check never restates a finding the card already lists", () => {
  it("a detail made only of listed findings becomes a pointer with their count", () => {
    const a = "Row 358 after the last account contains text that is not a recognised report footer and no amounts.";
    const b = "Clearing, suspense or in-transit account on row 339 has a balance. It needs reconciliation evidence.";
    expect(checkDetail(`${a} ${b}`, [issue(a), issue(b)])).toEqual({ text: "", pointsToFindings: 2 });
  });
  it("text that is not a listed finding is kept", () => {
    const a = "Row 5 is a duplicate.";
    expect(checkDetail(`Every amount is a valid number. ${a}`, [issue(a)])).toEqual({ text: "Every amount is a valid number.", pointsToFindings: 1 });
  });
  it("no listed findings: the detail is unchanged", () => {
    expect(checkDetail("The file was read successfully.", [])).toEqual({ text: "The file was read successfully.", pointsToFindings: 0 });
  });
});
