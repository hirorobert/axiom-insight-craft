import { describe, expect, it } from "vitest";
import { groupEngagements, periodDates, type GroupableEngagement } from "./engagementGroups";

const e = (o: Partial<GroupableEngagement> & { engagementId: string; companyId: string }): GroupableEngagement =>
  ({ companyName: "Synthetic SME Limited", periodYear: 2025, ...o });

describe("the account home groups engagements by company, with period dates, and keeps test workspaces apart", () => {
  it("one group per company; its periods latest first by recorded end date (non-calendar periods included)", () => {
    const { client, test } = groupEngagements([
      e({ engagementId: "a1", companyId: "A", companyName: "Alpha Ltd", periodYear: 2024, periodStart: "2023-07-01", periodEnd: "2024-06-30" }),
      e({ engagementId: "a2", companyId: "A", companyName: "Alpha Ltd", periodYear: 2025, periodStart: "2024-07-01", periodEnd: "2025-06-30" }),
      e({ engagementId: "b1", companyId: "B", companyName: "Beta Ltd" }),
    ]);
    expect(test).toEqual([]);
    expect(client.map((g) => g.companyId)).toEqual(["A", "B"]);
    expect(client[0].periods.map((p) => p.engagementId)).toEqual(["a2", "a1"]);
  });
  it("same-named companies are told apart (code, else creation date), never merged", () => {
    const { client } = groupEngagements([
      e({ engagementId: "1", companyId: "X", companyCode: "SYN-01" }),
      e({ engagementId: "2", companyId: "Y", companyCreatedAt: "2026-10-01T09:00:00Z" }),
      e({ engagementId: "3", companyId: "Z", companyName: "Unique Ltd" }),
    ]);
    expect(client.map((g) => [g.companyId, g.distinguisher])).toEqual([["X", "code SYN-01"], ["Y", "created 2026-10-01"], ["Z", null]]);
  });
  it("test and training workspaces come only from the recorded purpose — a demo-like name alone is client work", () => {
    const { client, test } = groupEngagements([
      e({ engagementId: "1", companyId: "T", companyName: "Acceptance Demo Co", workspacePurpose: "test" }),
      e({ engagementId: "2", companyId: "R", companyName: "Course Co", workspacePurpose: "training" }),
      e({ engagementId: "3", companyId: "D", companyName: "Demo Test Ltd", workspacePurpose: null }),
      e({ engagementId: "4", companyId: "C", companyName: "Client Ltd", workspacePurpose: "client" }),
    ]);
    expect(test.map((g) => g.companyId)).toEqual(["T", "R"]); // by name
    expect(client.map((g) => g.companyId)).toEqual(["C", "D"]);
  });
  it("period dates are shown only as recorded, never guessed", () => {
    expect(periodDates("2024-07-01", "2025-06-30")).toBe("1 Jul 2024 – 30 Jun 2025");
    expect(periodDates(null, "2025-06-30")).toBe("ended 30 Jun 2025");
    expect(periodDates(null, null)).toBeNull();
    expect(periodDates("garbage", "also")).toBeNull();
  });
});
