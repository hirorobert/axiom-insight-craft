/**
 * trialBalanceDraft.test.ts: the browser half of trial balance drafts (src/lib/workspace/trialBalanceDraft.ts), including
 * the rollout combinations a new frontend can meet: no migration, no function, and the function before its migration.
 * Each is an actionable 'drafts_unavailable' refusal, never a false success.
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

const FILE = new File(["code,name,debit,credit\n"], "tb.csv");
const DRAFT = { draftId: "d1", objectPath: "drafts/u/d1/tb.csv", expiresAt: "2026-10-23T00:00:00Z", replayed: false };
const TARGET = { companyId: "co", periodYear: 2025, confirmation: { entity: "Invented Ltd", period: "FY2025", currency: "TZS" } };
const rows = (r: Record<string, unknown>) => ({ data: [r], error: null });
/** What supabase-js returns for a non-2xx function answer. */
const httpError = (status: number, body: unknown) => ({ data: null, error: { context: { status, json: async () => body } } });

describe("reserveDraft", () => {
  it("sends the file's name, size and SHA-256 with the key; the same key returns the same draft (replayed)", async () => {
    const { reserveDraft, sha256Hex } = await import("./trialBalanceDraft");
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "replayed", draft_id: "d1", object_path: "drafts/u/d1/tb.csv", expires_at: "x" }));
    const r = await reserveDraft(FILE, "key-0123456789abcdef");
    expect(r).toMatchObject({ draftId: "d1", replayed: true });
    expect(supa.rpc).toHaveBeenCalledWith("reserve_trial_balance_draft", { p_file_name: "tb.csv", p_file_size: FILE.size, p_content_sha256: await sha256Hex(FILE), p_idempotency_key: "key-0123456789abcdef" });
  });
  it("the same key with another file is a conflict, never the other file's draft", async () => {
    const { reserveDraft } = await import("./trialBalanceDraft");
    supa.rpc.mockResolvedValueOnce(rows({ outcome: "conflict", draft_id: null, object_path: null, expires_at: null }));
    await expect(reserveDraft(FILE, "key-0123456789abcdef")).rejects.toMatchObject({ code: "conflict", retryable: false });
  });
  it("an empty or over-limit file is refused before anything is sent", async () => {
    const { reserveDraft } = await import("./trialBalanceDraft");
    await expect(reserveDraft(new File([], "e.csv"), "key-0123456789abcdef")).rejects.toMatchObject({ code: "invalid_file" });
    expect(supa.rpc).not.toHaveBeenCalled();
  });
  it("NEW FRONTEND / OLD BACKEND: the reserve function does not exist yet → drafts_unavailable with the entity-first way in", async () => {
    const { reserveDraft, DRAFT_MESSAGES } = await import("./trialBalanceDraft");
    supa.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(reserveDraft(FILE, "key-0123456789abcdef")).rejects.toMatchObject({ code: "drafts_unavailable", retryable: false, message: DRAFT_MESSAGES.unavailable });
  });
});

describe("uploadDraft", () => {
  it("uploads to exactly the signed draft object", async () => {
    const { uploadDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "signed", path: DRAFT.objectPath, token: "t" }, error: null });
    supa.uploadToSignedUrl.mockResolvedValueOnce({ data: {}, error: null });
    await uploadDraft(DRAFT, FILE);
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-draft", { body: { action: "sign", draft_id: "d1" } });
    expect(supa.uploadToSignedUrl).toHaveBeenCalledWith(DRAFT.objectPath, "t", FILE);
  });
  it("already stored (a retry after the upload finished): nothing is uploaded again", async () => {
    const { uploadDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce(httpError(409, { outcome: "already_stored" }));
    await uploadDraft(DRAFT, FILE);
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });
  it("a signed path other than the reserved one is never uploaded to", async () => {
    const { uploadDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "signed", path: "drafts/other/x", token: "t" }, error: null });
    await expect(uploadDraft(DRAFT, FILE)).rejects.toMatchObject({ code: "retry" });
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });
  it("INTERRUPTED ROLLOUT: migration applied, function not deployed (the gateway's own 404) → drafts_unavailable, nothing uploaded", async () => {
    const { uploadDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce(httpError(404, { code: "NOT_FOUND", message: "Requested function was not found" }));
    await expect(uploadDraft(DRAFT, FILE)).rejects.toMatchObject({ code: "drafts_unavailable" });
    expect(supa.uploadToSignedUrl).not.toHaveBeenCalled();
  });
  it("our function's own 404 (the draft is gone) is NOT mistaken for a missing function", async () => {
    const { uploadDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce(httpError(404, { outcome: "not_found" }));
    await expect(uploadDraft(DRAFT, FILE)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("commitDraft", () => {
  it("sends the commit key, target, period and confirmed context; returns the upload", async () => {
    const { commitDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "committed", upload_id: "u1", commit_id: "c1", replayed: false }, error: null });
    await expect(commitDraft("d1", "ck-0123456789abcdef", TARGET)).resolves.toEqual({ uploadId: "u1", commitId: "c1", replayed: false });
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-draft", { body: { action: "commit", draft_id: "d1", commit_key: "ck-0123456789abcdef", company_id: "co", period_year: 2025, period_id: null, engagement_id: null, confirmation: TARGET.confirmation } });
  });
  it("each refusal is named, with the server's actionable detail where there is one; none is a success", async () => {
    const { commitDraft } = await import("./trialBalanceDraft");
    const cases: [number, Record<string, unknown>, string, boolean][] = [
      [403, { outcome: "forbidden" }, "forbidden", false],
      [409, { outcome: "commit_conflict" }, "conflict", false],
      [409, { outcome: "active_upload_exists", detail: "A trial balance is already active for this period. Replace it…" }, "active_upload_exists", false],
      [422, { outcome: "content_mismatch" }, "content_mismatch", false],
      [410, { outcome: "expired" }, "expired", false],
      [500, { outcome: "commit_failed", retryable: true }, "retry", true],
      [503, { outcome: "storage_unavailable", retryable: true }, "retry", true],
      [503, { outcome: "drafts_unavailable" }, "drafts_unavailable", false],
    ];
    for (const [status, body, code, retryable] of cases) {
      supa.invoke.mockResolvedValueOnce(httpError(status, body));
      await expect(commitDraft("d1", "ck-0123456789abcdef", TARGET)).rejects.toMatchObject({ code, retryable });
    }
    supa.invoke.mockResolvedValueOnce(httpError(409, { outcome: "active_upload_exists", detail: "A trial balance is already active for this period. Replace it…" }));
    await expect(commitDraft("d1", "ck-0123456789abcdef", TARGET)).rejects.toThrow(/already active/);
  });
  it("a 'committed' answer without an upload id is not treated as success", async () => {
    const { commitDraft } = await import("./trialBalanceDraft");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "committed" }, error: null });
    await expect(commitDraft("d1", "ck-0123456789abcdef", TARGET)).rejects.toMatchObject({ code: "retry" });
  });
});

describe("newDraftKey", () => {
  it("is in the server's accepted alphabet and length, and unique", async () => {
    const { newDraftKey } = await import("./trialBalanceDraft");
    const a = newDraftKey(), b = newDraftKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a).not.toBe(b);
  });
});
