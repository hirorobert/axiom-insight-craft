import { describe, expect, it, vi } from "vitest";
import { reviewClient } from "./reviewWorkflow";
import type { ReportingDb } from "./signoff";

const digest = "a".repeat(64);
const payload = (outcome: string) => ({ data: { outcome, document: '{"stored":true}', file_name: "official.json", content_sha256: digest }, error: null });
function setup(response = { outcome: "issued", issuance_id: "issuance-1", sealed: false }) {
  const rpc = vi.fn(async () => ({ data: response, error: null }));
  const invoke = vi.fn(async () => payload("sealed"));
  const db = { rpc, invoke, select: vi.fn() } as unknown as ReportingDb;
  return { client: reviewClient(db), rpc, invoke, save: vi.fn() };
}

describe("official pack delivery reconciliation", () => {
  it("uses the caller's same request identity across a lost-answer retry", async () => {
    const p = setup();
    p.invoke.mockResolvedValueOnce({ data: null, error: { message: "network" } } as never).mockResolvedValueOnce({ data: null, error: { message: "network" } } as never);
    expect(await p.client.issueOfficial("company", 2026, "report:1", p.save, "attempt-1")).toBe("failed");
    expect(p.save).not.toHaveBeenCalled();
    expect(await p.client.issueOfficial("company", 2026, "report:1", p.save, "attempt-1")).toBe("delivered");
    expect(p.rpc.mock.calls.map((c) => (c as unknown as [string, Record<string, unknown>])[1].p_request_id)).toEqual(["attempt-1", "attempt-1"]);
  });
  it("retrieves the same sealed issuance on an already-issued replay", async () => {
    const p = setup({ outcome: "already_issued", issuance_id: "issuance-1", sealed: true });
    p.invoke.mockResolvedValue(payload("retrieved"));
    expect(await p.client.issueOfficial("company", 2026, "report:1", p.save, "attempt-1")).toBe("delivered");
    expect(p.invoke).toHaveBeenCalledExactlyOnceWith("seal-reporting-pack", { action: "retrieve", issuance_id: "issuance-1" });
    expect(p.save).toHaveBeenCalledTimes(1);
  });
  it("reconciles a failed seal response by a read, without creating another issuance", async () => {
    const p = setup();
    p.invoke.mockResolvedValueOnce({ data: null, error: { message: "lost answer" } } as never).mockResolvedValueOnce(payload("retrieved"));
    expect(await p.client.issueOfficial("company", 2026, "report:1", p.save, "attempt-1")).toBe("delivered");
    expect(p.rpc).toHaveBeenCalledTimes(1);
    expect(p.invoke.mock.calls.map((c) => (c as unknown as [string, { action: string }])[1].action)).toEqual(["issue", "retrieve"]);
  });
  it("resumes a stored issuance without invoking the creation RPC", async () => {
    const p = setup();
    expect(await p.client.resumeOfficial("issuance-1", p.save)).toBe("delivered");
    expect(p.rpc).not.toHaveBeenCalled();
    expect(p.invoke).toHaveBeenCalledExactlyOnceWith("seal-reporting-pack", { action: "issue", issuance_id: "issuance-1" });
  });
  it("never saves a file when the server refuses the issuance or the seal", async () => {
    const p = setup();
    p.invoke.mockResolvedValue({ data: { outcome: "capability_required" }, error: null } as never);
    expect(await p.client.issueOfficial("company", 2026, "report:1", p.save, "attempt-1")).toBe("not_permitted");
    expect(p.save).not.toHaveBeenCalled();
  });
});
