import { describe, expect, it } from "vitest";
import { pickContinueEngagement } from "./continueEngagement";
import type { WorkspaceState } from "./types";

const st = (status: string) => ({ missions: { prepare: { status } } }) as unknown as WorkspaceState;
const e = (id: string, status?: string) => ({ engagementId: id, companyId: "c" + id, companyName: "Co " + id, periodYear: 2025, workspaceState: status ? st(status) : undefined });

describe("pickContinueEngagement", () => {
  it("offers nothing when every trial balance is finished or state is unknown", () => {
    expect(pickContinueEngagement([e("1", "passed"), e("2", "signed"), e("3")])).toBeNull();
  });
  it("picks the most recently opened unfinished engagement", () => {
    const r = pickContinueEngagement([e("1", "not_started"), e("2", "review_required"), e("3", "passed")], { "1": "2026-10-01", "2": "2026-10-20", "3": "2026-10-22" });
    expect(r?.engagementId).toBe("2");
  });
  it("keeps server order on ties", () => {
    expect(pickContinueEngagement([e("1", "blocked"), e("2", "in_progress")])?.engagementId).toBe("1");
  });
});
