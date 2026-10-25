import { describe, expect, it } from "vitest";
import { qaAccess, qaCaseId, QA_COMPANY } from "../../../supabase/functions/_shared/assistantQaPolicy";
describe("synthetic-only tester scope", () => {
  it("allows only the authorized demo company", () => {
    expect(qaAccess(QA_COMPANY, true, true)).toBe(true);
    expect(qaAccess("e18d3218-185c-47cf-a4ef-1de4e02c6a83", true, true)).toBe(false);
  });
  it("requires explicit enrollment and current membership", () => {
    expect(qaAccess(QA_COMPANY, false, true)).toBe(false);
    expect(qaAccess(QA_COMPANY, true, false)).toBe(false);
  });
  it("admits development fixture identifiers, never held-out or arbitrary input", () => {
    expect(qaCaseId(1)).toBe(1);
    expect(qaCaseId(20)).toBe(20);
    for (const value of [0, 21, 30, "1", {}, 1.5, null]) expect(qaCaseId(value)).toBeNull();
  });
});