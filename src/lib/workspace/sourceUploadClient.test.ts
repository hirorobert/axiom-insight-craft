/**
 * sourceUploadClient.test.ts: the browser half of workspace-scoped uploads (src/lib/workspace/sourceUpload.ts).
 * The browser never picks a bucket or a path. It reserves, uploads to the one signed object, then registers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const supa = vi.hoisted(() => ({ rpc: vi.fn(), invoke: vi.fn(), uploadToSignedUrl: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (n: string, a: unknown) => supa.rpc(n, a),
    functions: { invoke: (n: string, o: unknown) => supa.invoke(n, o) },
    storage: { from: () => ({ uploadToSignedUrl: (p: string, t: string, f: unknown) => supa.uploadToSignedUrl(p, t, f) }) },
  },
}));
afterEach(() => vi.clearAllMocks());

const FILE = new File(["x"], "tb.csv");
const rows = (r: Record<string, unknown>) => ({ data: [r], error: null });

describe("uploadWorkspaceSource", () => {
  it("reserve → sign → upload to exactly the signed workspace object", async () => {
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "reserved", reservation_id: "r1", object_path: "workspaces/co/s/tb.csv" }));
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "signed", path: "workspaces/co/s/tb.csv", token: "t" }, error: null });
    supa.uploadToSignedUrl.mockResolvedValueOnce({ data: {}, error: null });
    const { uploadWorkspaceSource } = await import("./sourceUpload");
    await expect(uploadWorkspaceSource("co", FILE)).resolves.toEqual({ reservationId: "r1", objectPath: "workspaces/co/s/tb.csv" });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-source-signer", { body: { reservation_id: "r1" } });
  });
  it("a caller without authority is refused before anything is uploaded", async () => {
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "forbidden", reservation_id: null, object_path: null }));
    const { uploadWorkspaceSource } = await import("./sourceUpload");
    await expect(uploadWorkspaceSource("co", FILE)).rejects.toMatchObject({ code: "forbidden", retryable: false });
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });
  it("a refused signing (e.g. revoked in between) uploads nothing", async () => {
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "reserved", reservation_id: "r1", object_path: "p" }));
    supa.invoke.mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ outcome: "forbidden" }) } } });
    const { uploadWorkspaceSource } = await import("./sourceUpload");
    await expect(uploadWorkspaceSource("co", FILE)).rejects.toMatchObject({ code: "forbidden" });
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });
});

describe("registerWorkspaceUpload", () => {
  it("registered / already_registered return the upload id", async () => {
    const { registerWorkspaceUpload } = await import("./sourceUpload");
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "registered", upload_id: "u1", detail: null }));
    await expect(registerWorkspaceUpload({ reservationId: "r1", fileSize: 1, periodYear: 2026 })).resolves.toBe("u1");
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "already_registered", upload_id: "u1", detail: null }));
    await expect(registerWorkspaceUpload({ reservationId: "r1", fileSize: 1 })).resolves.toBe("u1");
  });
  it("forbidden, active_upload_exists and object_missing are named, never success", async () => {
    const { registerWorkspaceUpload } = await import("./sourceUpload");
    for (const [outcome, retryable] of [["forbidden", false], ["active_upload_exists", false], ["object_missing", true]] as const) {
      supa.rpc.mockResolvedValueOnce(rows({ outcome, upload_id: null, detail: null }));
      await expect(registerWorkspaceUpload({ reservationId: "r1", fileSize: 1 })).rejects.toMatchObject({ code: outcome, retryable });
    }
  });
});
