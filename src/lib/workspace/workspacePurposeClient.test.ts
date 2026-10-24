import { describe, expect, it, vi } from "vitest";
import { saveWorkspacePurpose, type PurposeClient } from "./workspacePurposeClient";
const record = { purpose: "training" as const, reason: "Staff training", created_at: "2026-10-23T00:00:00Z" };
describe("purpose persistence confirmation", () => {
  it("confirms from the server after a successful write", async () => {
    const client: PurposeClient = { write: vi.fn().mockResolvedValue({ outcome: "recorded" }), read: vi.fn().mockResolvedValue(record) };
    expect(await saveWorkspacePurpose(client, "company", "training", "  Staff training  ")).toEqual(record);
    expect(client.write).toHaveBeenCalledWith("company", "training", "Staff training");
  });
  it("recovers a lost response from the recorded event", async () => {
    expect(await saveWorkspacePurpose({ write: async () => { throw new Error("Lost response"); }, read: async () => record }, "company", "training", "Staff training")).toEqual(record);
  });
  it("never reports success when readback failed or the latest value differs", async () => {
    await expect(saveWorkspacePurpose({ write: async () => ({ outcome: "recorded" }), read: async () => null }, "company", "training", "Staff training")).rejects.toThrow("could not be confirmed");
    await expect(saveWorkspacePurpose({ write: async () => ({ outcome: "recorded" }), read: async () => { throw new Error("Read unavailable"); } }, "company", "training", "Staff training")).rejects.toThrow("Read unavailable");
  });
  it("refuses forbidden writes and invalid reasons", async () => {
    const read = vi.fn();
    await expect(saveWorkspacePurpose({ write: async () => ({ outcome: "forbidden" }), read }, "company", "training", "Staff training")).rejects.toThrow("owner");
    expect(read).not.toHaveBeenCalled();
    const write = vi.fn();
    await expect(saveWorkspacePurpose({ write, read }, "company", "training", " ")).rejects.toThrow("3 to 500");
    expect(write).not.toHaveBeenCalled();
  });
});
