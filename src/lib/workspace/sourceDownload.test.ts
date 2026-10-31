/**
 * sourceDownload.test.ts: the decision sequence of the trial-balance-source-download Edge Function
 * (supabase/functions/_shared/sourceDownload.ts) with every dependency injected, and the browser half
 * (src/lib/workspace/sourceDownload.ts): server answer handling and the integrity check before anything is saved.
 * The local-stack journey (scripts/e2e/sourceDownloadJourney.mjs) exercises the deployed function end to end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_EXPIRY_SECONDS, SIGNER_EXPIRY_TOLERANCE_SECONDS, computeLinkBounds, parseSourceDownloadRequest, runSourceDownload, safeDownloadName, signedUrlExpiryMs,
  type IssuanceDecision, type IssuanceRequest, type SourceDownloadDeps, type UploadTarget,
} from "../../../supabase/functions/_shared/sourceDownload";

const UP = "7a1e4d92-2f8b-4c3e-b056-f9a2d7e14b83";
const CO = "0c6bb3a1-5d2e-4a7f-9b1c-3e8f2a6d4c10";
const OTHER_CO = "5b9d7e21-8a43-4c6f-a2d0-1f7e3b9c8a54";
const USER = "2f4e6a80-1b3d-4f5a-8c7e-9d0b2a4c6e81";
const HASH = "a".repeat(64);

const upload = (over: Partial<UploadTarget> = {}): UploadTarget =>
  ({ id: UP, company_id: CO, user_id: USER, file_path: `workspaces/${CO}/src-1/tb.csv`, file_name: "Mwamba TB 2026.csv", file_size: 120, source_file_hash: HASH, ...over });

function deps(over: Partial<SourceDownloadDeps> = {}) {
  const d = {
    authenticate: vi.fn(async () => "user-1"),
    resolveUpload: vi.fn(async () => upload()),
    canDownload: vi.fn(async () => true),
    sign: vi.fn(async (path: string) => ({ url: `https://storage.invalid/sign/${path}?token=t` })),
    decide: vi.fn(async (_r: IssuanceRequest): Promise<IssuanceDecision> => "issued"),
    recordDenial: vi.fn(async () => {}),
    now: () => NOW(),
    ...over,
  };
  return d as typeof d & SourceDownloadDeps;
}
const REQ = { uploadId: UP, companyId: CO };
const T0 = Date.parse("2026-10-30T12:00:00.000Z");
let clockMs = T0;
const NOW = () => clockMs;
afterEach(() => { clockMs = T0; });

describe("request parsing: exactly an upload id and a company id", () => {
  it("accepts exactly { upload_id, company_id } as UUIDs", () => expect(parseSourceDownloadRequest({ upload_id: UP, company_id: CO })).toEqual(REQ));
  it("refuses a path, bucket, user, a missing or extra key and malformed ids", () => {
    for (const body of [{ upload_id: UP }, { company_id: CO }, { upload_id: UP, company_id: CO, path: "workspaces/x" }, { upload_id: UP, company_id: CO, bucket: "avatars" },
      { upload_id: UP, company_id: CO, user_id: USER }, { upload_id: "nope", company_id: CO }, { upload_id: UP, company_id: "nope" }, { upload_id: UP, company_id: 3 }, {}, null, [UP, CO]]) {
      expect(parseSourceDownloadRequest(body)).toBeNull();
    }
  });
});

describe("runSourceDownload", () => {
  it("authorized: signs EXACTLY the server-resolved object for the short window and returns the recorded fingerprint", async () => {
    const d = deps();
    await expect(runSourceDownload(d, REQ)).resolves.toEqual({
      status: 200, outcome: "ready", url: `https://storage.invalid/sign/workspaces/${CO}/src-1/tb.csv?token=t`, expires_in: DOWNLOAD_EXPIRY_SECONDS,
      file_name: "Mwamba TB 2026.csv", sha256: HASH, size: 120,
    });
    expect(d.sign).toHaveBeenCalledWith(`workspaces/${CO}/src-1/tb.csv`, DOWNLOAD_EXPIRY_SECONDS, "Mwamba TB 2026.csv");
    expect(d.canDownload).toHaveBeenCalledWith("user-1", CO);
    expect(DOWNLOAD_EXPIRY_SECONDS).toBeLessThanOrEqual(120);
  });
  it("unauthenticated → 401 and nothing is resolved or signed", async () => {
    const d = deps({ authenticate: vi.fn(async () => null) });
    await expect(runSourceDownload(d, REQ)).resolves.toEqual({ status: 401, outcome: "unauthenticated" });
    expect(d.resolveUpload).not.toHaveBeenCalled();
    expect(d.sign).not.toHaveBeenCalled();
  });
  it("without authority → 403 and nothing is signed", async () => {
    const d = deps({ canDownload: vi.fn(async () => false) });
    await expect(runSourceDownload(d, REQ)).resolves.toEqual({ status: 403, outcome: "forbidden" });
    expect(d.sign).not.toHaveBeenCalled();
  });
  it("authority is re-checked on EVERY request: a grant revoked between two requests refuses the second", async () => {
    let allowed = true;
    const d = deps({ canDownload: vi.fn(async () => allowed) });
    expect((await runSourceDownload(d, REQ)).outcome).toBe("ready");
    allowed = false;
    expect((await runSourceDownload(d, REQ)).outcome).toBe("forbidden");
    expect(d.canDownload).toHaveBeenCalledTimes(2);   // one precheck per request; the ordering point is the database decision, not a read
    expect(d.sign).toHaveBeenCalledTimes(1);
  });
  it("company binding: an upload of ANOTHER company, even for a caller who may act on the named company, is the same 403 as an unknown upload", async () => {
    const d = deps({ resolveUpload: vi.fn(async () => upload({ company_id: OTHER_CO, file_path: `workspaces/${OTHER_CO}/s/tb.csv` })) });
    const mismatched = await runSourceDownload(d, REQ);
    const unknown = await runSourceDownload(deps({ resolveUpload: vi.fn(async () => null) }), REQ);
    expect(mismatched).toEqual({ status: 403, outcome: "forbidden" });
    expect(unknown).toEqual(mismatched);
    expect(d.canDownload).not.toHaveBeenCalled();
    expect(d.sign).not.toHaveBeenCalled();
  });
  it("authority is checked against the UPLOAD's company, never the one the caller typed", async () => {
    const d = deps();
    await runSourceDownload(d, REQ);
    expect(d.canDownload).toHaveBeenCalledWith("user-1", CO);
  });
  it("a path outside the upload's own company, with traversal, or of the wrong shape is never signed", async () => {
    for (const file_path of [`workspaces/${OTHER_CO}/s/tb.csv`, `workspaces/${CO}/../${OTHER_CO}/tb.csv`, `workspaces/${CO}//tb.csv`, "/etc/passwd", `${OTHER_CO}/tb.csv`, `workspaces\\${CO}\\tb.csv`, ""]) {
      const d = deps({ resolveUpload: vi.fn(async () => upload({ file_path })) });
      const r = await runSourceDownload(d, REQ);
      expect(r.outcome, file_path).toBe("signing_failed");
      expect(d.sign).not.toHaveBeenCalled();
    }
  });
  it("a legacy upload (its uploader's personal folder) is served; another person's folder is not", async () => {
    const legacy = deps({ resolveUpload: vi.fn(async () => upload({ file_path: `${USER}/old.csv` })) });
    expect((await runSourceDownload(legacy, REQ)).outcome).toBe("ready");
    const foreign = deps({ resolveUpload: vi.fn(async () => upload({ file_path: `${OTHER_CO}/old.csv` })) });
    expect((await runSourceDownload(foreign, REQ)).outcome).toBe("signing_failed");
  });
  it("no recorded path or an object no longer in storage → 404 unavailable; a signing failure → 502", async () => {
    expect((await runSourceDownload(deps({ resolveUpload: vi.fn(async () => upload({ file_path: null })) }), REQ)).status).toBe(404);
    expect(await runSourceDownload(deps({ sign: vi.fn(async () => ({ missing: true as const })) }), REQ)).toEqual({ status: 404, outcome: "unavailable" });
    expect(await runSourceDownload(deps({ sign: vi.fn(async () => null) }), REQ)).toEqual({ status: 502, outcome: "signing_failed" });
  });
  it("a file the server has not fingerprinted yet is served with a null fingerprint (never an invented one)", async () => {
    const r = await runSourceDownload(deps({ resolveUpload: vi.fn(async () => upload({ source_file_hash: null })) }), REQ);
    expect(r).toMatchObject({ outcome: "ready", sha256: null });
  });
});

describe("runSourceDownload: atomic issuance decision (re-review of #229, findings 3 and 5)", () => {
  const issued = (d: ReturnType<typeof deps>) => d.decide.mock.calls[0][0] as IssuanceRequest;
  it("the link is returned ONLY when the database decision committed as issued; the decision carries the signing interval and the expiry, never the URL", async () => {
    const d = deps();
    const r = await runSourceDownload(d, REQ);
    expect(r).toMatchObject({ status: 200, outcome: "ready", expires_in: DOWNLOAD_EXPIRY_SECONDS });
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(issued(d)).toEqual({
      userId: "user-1", companyId: CO, uploadId: UP, signingStartedAt: "2026-10-30T12:00:00.000Z", signingCompletedAt: "2026-10-30T12:00:00.000Z",
      linkLifetimeSeconds: DOWNLOAD_EXPIRY_SECONDS, linkExpiryExactAt: null, sha256: HASH,
    });
    expect(JSON.stringify(d.decide.mock.calls)).not.toMatch(/token=|http|workspaces\//);
  });
  it("the ordinary read before signing is a precheck, not the ordering point: a withdrawal after it is decided by the database, and when it wins no link is returned", async () => {
    let release!: (v: { url: string }) => void;
    const d = deps({ sign: vi.fn(() => new Promise<{ url: string }>((resolve) => { release = resolve; })), decide: vi.fn(async () => "withdrawn_before_issue" as const) });
    const pending = runSourceDownload(d, REQ);
    await vi.waitFor(() => expect(d.sign).toHaveBeenCalled());
    release({ url: "https://storage.invalid/sign/x?token=SECRET-TOKEN" });   // the withdrawal committed while Storage was signing; the decision sees it
    const r = await pending;
    expect(r).toEqual({ status: 403, outcome: "forbidden" });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(d.canDownload).toHaveBeenCalledTimes(1);                          // exactly one ordinary read: nothing treats a second read as the linearization point
  });
  it("the decision committed first: a later withdrawal does not un-issue; the link is delivered under the contract (a bearer credential until its own expiry)", async () => {
    const d = deps();
    const r = await runSourceDownload(d, REQ);               // the decision committed as issued ...
    // ... and any withdrawal now happens after it. Nothing in the orchestration reads authority again or updates the record.
    expect(r.outcome).toBe("ready");
    expect(d.canDownload).toHaveBeenCalledTimes(1);
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(d.recordDenial).not.toHaveBeenCalled();
  });
  it("signing delay: with no readable signer expiry the request carries the signing interval and NO expiry; the reported time left is to the conservative floor", async () => {
    const d = deps({ sign: vi.fn(async () => { clockMs += 25_000; return { url: "https://storage.invalid/sign/x?token=t" }; }) });
    const r = await runSourceDownload(d, REQ);
    expect(issued(d)).toMatchObject({ signingStartedAt: "2026-10-30T12:00:00.000Z", signingCompletedAt: "2026-10-30T12:00:25.000Z", linkLifetimeSeconds: 60, linkExpiryExactAt: null });
    expect(r.expires_in).toBe(35);                                  // floor = signing START + 60 s = 12:01:00; now = 12:00:25 -> 35 s, NOT 60 s and NOT time to the ceiling (60)
    clockMs = T0;
    const slow = deps({ sign: vi.fn(async () => { clockMs += 10_000; return { url: "https://storage.invalid/sign/x?token=t" }; }), decide: vi.fn(async () => { clockMs += 20_000; return "issued" as const; }) });
    expect((await runSourceDownload(slow, REQ)).expires_in).toBe(30);   // 12:01:00 - 12:00:30
  });
  it("the signer's own expiry is passed as the EXACT expiry, and a link with an unexpected lifetime is discarded unissued", async () => {
    const exp = Math.floor((T0 + 45_000) / 1000);
    const d = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: exp * 1000 })) });
    const r = await runSourceDownload(d, REQ);
    expect(issued(d)).toMatchObject({ linkExpiryExactAt: new Date(exp * 1000).toISOString() });
    expect(r.expires_in).toBe(45);
    const long = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: T0 + (DOWNLOAD_EXPIRY_SECONDS + SIGNER_EXPIRY_TOLERANCE_SECONDS + 5) * 1000 })) });
    expect(await runSourceDownload(long, REQ)).toEqual({ status: 502, outcome: "signing_failed" });
    expect(long.decide).not.toHaveBeenCalled();
  });
  it("computeLinkBounds: exact when the signer's exp is known; otherwise a floor from signing START and a ceiling from signing COMPLETION, and validity uses the floor", () => {
    const exact = computeLinkBounds({ startedMs: 1_000, completedMs: 5_000, lifetimeSeconds: 60, exactMs: 40_000 });
    expect(exact).toEqual({ kind: "signer_exact", exactMs: 40_000, floorMs: 40_000, ceilingMs: 40_000 });
    const est = computeLinkBounds({ startedMs: 1_000, completedMs: 5_000, lifetimeSeconds: 60, exactMs: null });
    expect(est).toEqual({ kind: "estimated_bounds", exactMs: null, floorMs: 61_000, ceilingMs: 65_000 });
    expect(est.floorMs).toBeLessThanOrEqual(est.ceilingMs);
    // at t = 63 s the link is NOT provably valid (floor passed) although the ceiling has not: an upper bound proves nothing
    const now = 63_000;
    expect(est.floorMs > now).toBe(false);
    expect(est.ceilingMs > now).toBe(true);
  });
  it("expiry before issuance: a link that expired by the decision is not returned, with its own answer", async () => {
    const d = deps({ decide: vi.fn(async () => "expired_before_issue" as const) });
    const r = await runSourceDownload(d, REQ);
    expect(r).toEqual({ status: 503, outcome: "link_expired" });
    expect((r as { url?: string }).url).toBeUndefined();
  });
  it("a decision that could not be taken (lock timeout) or stored (database failure, audit-insert failure) returns no link", async () => {
    expect(await runSourceDownload(deps({ decide: vi.fn(async () => "unavailable" as const) }), REQ)).toEqual({ status: 503, outcome: "decision_unavailable" });
    for (const decide of [vi.fn(async () => { throw new Error("audit insert failed"); }), vi.fn(async () => "bogus" as unknown as IssuanceDecision)]) {
      const r = await runSourceDownload(deps({ decide }), REQ);
      expect(r).toEqual({ status: 503, outcome: "audit_unavailable" });
      expect((r as { url?: string }).url).toBeUndefined();
    }
  });
  it("response failure and a disconnected caller: the decision stands exactly as committed and nothing is updated, retried or recorded again", async () => {
    const d = deps();
    const delivered = await runSourceDownload(d, REQ);
    void delivered;                                                          // the caller never reads it (connection dropped, response failed)
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(d.recordDenial).not.toHaveBeenCalled();
    expect(d.sign).toHaveBeenCalledTimes(1);
  });
  it("a refusal stands even when its own record cannot be stored", async () => {
    const d = deps({ canDownload: vi.fn(async () => false), recordDenial: vi.fn(async () => { throw new Error("db down"); }) });
    await expect(runSourceDownload(d, REQ)).resolves.toEqual({ status: 403, outcome: "forbidden" });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.decide).not.toHaveBeenCalled();
  });
  it("denied is recorded for an authenticated caller who named a real upload of a real company; unauthenticated, unknown and mismatched requests record nothing", async () => {
    const denied = deps({ canDownload: vi.fn(async () => false) });
    await runSourceDownload(denied, REQ);
    expect(denied.recordDenial).toHaveBeenCalledWith({ userId: "user-1", companyId: CO, uploadId: UP, sha256: HASH });
    const unauthenticated = deps({ authenticate: vi.fn(async () => null) });
    const unknown = deps({ resolveUpload: vi.fn(async () => null) });
    const mismatched = deps({ resolveUpload: vi.fn(async () => upload({ company_id: OTHER_CO, file_path: `workspaces/${OTHER_CO}/s/tb.csv` })) });
    for (const d of [unauthenticated, unknown, mismatched]) { await runSourceDownload(d, REQ); expect(d.recordDenial).not.toHaveBeenCalled(); expect(d.decide).not.toHaveBeenCalled(); }
  });
});

describe("signedUrlExpiryMs: reads the signer's exp claim, stores nothing", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const tok = (claims: unknown) => `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
  it("returns exp in milliseconds, and null for a link without a readable token or exp", () => {
    expect(signedUrlExpiryMs(`http://kong:8000/storage/v1/object/sign/b/p.csv?token=${tok({ exp: 1_800_000_000 })}`)).toBe(1_800_000_000_000);
    for (const u of ["http://kong:8000/x", "http://kong:8000/x?token=", "http://kong:8000/x?token=abc", `http://kong:8000/x?token=${tok({})}`, `http://kong:8000/x?token=${tok({ exp: "soon" })}`, `http://kong:8000/x?token=${tok({ exp: -5 })}`, ""]) {
      expect(signedUrlExpiryMs(u), u).toBeNull();
    }
  });
});

describe("safeDownloadName", () => {
  it("keeps an ordinary name and strips anything that could break a header or a path", () => {
    expect(safeDownloadName("Mwamba TB 2026.csv")).toBe("Mwamba TB 2026.csv");
    expect(safeDownloadName('a"b\r\nc/../d.csv')).toBe("a_b__c_._d.csv");
    expect(safeDownloadName("..hidden")).toBe("hidden");
    expect(safeDownloadName("")).toBe("trial-balance");
    expect(safeDownloadName(null)).toBe("trial-balance");
    expect(safeDownloadName("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

// ── the browser half ────────────────────────────────────────────────────────────────────────────────────────────────
const supa = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (n: string, o: unknown) => supa.invoke(n, o) } } }));
afterEach(() => vi.clearAllMocks());

const BYTES = new TextEncoder().encode("Account code,Account name,Debit,Credit\n10457,Bank,1000.00,\n");
const sha = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
const served = (b: Uint8Array) => vi.fn(async () => new Response(b, { status: 200 }));

describe("fetchOriginalSource", () => {
  it("asks for exactly the upload and company, fetches the signed URL and returns bytes that match the recorded fingerprint", async () => {
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://storage.invalid/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=t", file_name: "tb.csv", sha256: await sha(BYTES) }, error: null });
    const { fetchOriginalSource } = await import("./sourceDownload");
    const f = served(BYTES);
    const file = await fetchOriginalSource(CO, UP, f as never, "https://storage.invalid");
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-source-download", { body: { upload_id: UP, company_id: CO } });
    expect(f).toHaveBeenCalledWith("https://storage.invalid/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=t");
    expect(file).toMatchObject({ fileName: "tb.csv", integrity: "matched", size: BYTES.byteLength });
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(BYTES);
  });
  it("bytes that do NOT match the recorded fingerprint are refused and never returned", async () => {
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://storage.invalid/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=t", file_name: "tb.csv", sha256: "0".repeat(64) }, error: null });
    const { fetchOriginalSource } = await import("./sourceDownload");
    await expect(fetchOriginalSource(CO, UP, served(BYTES) as never, "https://storage.invalid")).rejects.toMatchObject({ code: "integrity", retryable: true });
  });
  it("no recorded fingerprint: the bytes are returned and said to be unverified", async () => {
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://storage.invalid/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=t", file_name: "tb.csv", sha256: null }, error: null });
    const { fetchOriginalSource } = await import("./sourceDownload");
    await expect(fetchOriginalSource(CO, UP, served(BYTES) as never, "https://storage.invalid")).resolves.toMatchObject({ integrity: "not_recorded" });
  });
  it("a refused request fetches nothing: forbidden / unauthenticated / unavailable are distinct and not retryable", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    for (const [outcome, code] of [["forbidden", "forbidden"], ["unauthenticated", "unauthenticated"], ["unavailable", "unavailable"]] as const) {
      supa.invoke.mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ outcome }) } } });
      const f = vi.fn();
      await expect(fetchOriginalSource(CO, UP, f as never)).rejects.toMatchObject({ code, retryable: false });
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("a failed fetch or an unexpected answer is a retryable failure", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "signing_failed" }, error: null });
    await expect(fetchOriginalSource(CO, UP, vi.fn() as never)).rejects.toMatchObject({ code: "failed", retryable: true });
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://storage.invalid/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=t", sha256: null }, error: null });
    await expect(fetchOriginalSource(CO, UP, vi.fn(async () => new Response("no", { status: 400 })) as never)).rejects.toMatchObject({ code: "failed" });
  });
});

describe("rebaseSignedUrl", () => {
  const SIGNED = "http://kong:8000/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=abc&download=tb.csv";
  it("keeps the signed path and token and moves the request to the API origin this app is configured with", async () => {
    const { rebaseSignedUrl } = await import("./sourceDownload");
    expect(rebaseSignedUrl(SIGNED, "http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=abc&download=tb.csv");
    expect(rebaseSignedUrl(SIGNED, "https://ref.supabase.co/")).toBe("https://ref.supabase.co/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=abc&download=tb.csv");
    expect(rebaseSignedUrl(SIGNED, undefined)).toBe(SIGNED);
  });
  it("refuses anything that is not a signed object URL for the trial-balance bucket (never fetched)", async () => {
    const { rebaseSignedUrl } = await import("./sourceDownload");
    for (const bad of ["not a url", "http://kong:8000/storage/v1/object/sign/avatars/x.png?token=t", "http://kong:8000/storage/v1/object/public/trial-balance-files/x", "http://kong:8000/storage/v1/object/sign/trial-balance-files/x", "https://evil.example/anything", "javascript:alert(1)"]) {
      expect(rebaseSignedUrl(bad, "http://127.0.0.1:54321"), bad).toBeNull();
    }
  });
  it("fetchOriginalSource fetches the REBASED url, and a URL that is not a signed object URL is never fetched", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: SIGNED, file_name: "tb.csv", sha256: null }, error: null });
    const f = served(BYTES);
    await fetchOriginalSource(CO, UP, f as never, "http://127.0.0.1:54321");
    expect(f).toHaveBeenCalledWith("http://127.0.0.1:54321/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv?token=abc&download=tb.csv");
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://evil.example/x?token=t", file_name: "tb.csv", sha256: null }, error: null });
    const g = vi.fn();
    await expect(fetchOriginalSource(CO, UP, g as never, "http://127.0.0.1:54321")).rejects.toMatchObject({ code: "failed" });
    expect(g).not.toHaveBeenCalled();
  });
});

describe("signed-URL handling against unexpected origins and paths", () => {
  const BASE = "http://127.0.0.1:54321";
  const OK_PATH = "/storage/v1/object/sign/trial-balance-files/workspaces/c/s/tb.csv";
  it("refuses traversal out of the signed prefix, in any spelling, and anything under another bucket, route or scheme", async () => {
    const { rebaseSignedUrl } = await import("./sourceDownload");
    const hostile = [
      "http://kong:8000/storage/v1/object/sign/trial-balance-files/../../public/trial-balance-files/x?token=t",
      "http://kong:8000/storage/v1/object/sign/trial-balance-files/%2e%2e/%2e%2e/authenticated/x?token=t",
      "http://kong:8000/storage/v1/object/sign/trial-balance-files/..%2f..%2fx?token=t",
      "http://kong:8000/storage/v1/object/sign/trial-balance-filesX/x?token=t",
      "http://kong:8000/storage/v1/object/sign/avatars/x?token=t",
      "http://kong:8000/rest/v1/rpc/anything?token=t",
      "http://kong:8000/storage/v1/object/upload/sign/trial-balance-files/x?token=t",
      "ftp://kong:8000/storage/v1/object/sign/trial-balance-files/x?token=t",
      "data:text/plain,x", "", "//evil.example/storage/v1/object/sign/trial-balance-files/x?token=t",
    ];
    for (const u of hostile) {
      const r = rebaseSignedUrl(u, BASE);
      // either refused outright, or (a normalised path that still lies inside the prefix) kept inside it on OUR origin
      if (r !== null) { expect(r.startsWith(`${BASE}/storage/v1/object/sign/trial-balance-files/`), u).toBe(true); expect(r).not.toMatch(/\.\.|%2e/i); }
    }
    for (const u of hostile.slice(0, 8)) expect(rebaseSignedUrl(u, BASE), u).toBeNull();
    // and a trailing / empty segment or an empty object name
    for (const u of [`http://kong:8000${OK_PATH.replace(/tb.csv$/, "")}?token=t`, "http://kong:8000/storage/v1/object/sign/trial-balance-files/?token=t"]) expect(rebaseSignedUrl(u, BASE), u).toBeNull();
  });
  it("an unexpected ORIGIN is never contacted: only the path and token are used, against the configured origin", async () => {
    const { rebaseSignedUrl } = await import("./sourceDownload");
    for (const origin of ["https://evil.example", "http://user:pw@evil.example:81", "http://[::1]:9", "http://kong:8000"]) {
      const r = rebaseSignedUrl(`${origin}${OK_PATH}?token=abc`, BASE) as string;
      expect(r, origin).toBe(`${BASE}${OK_PATH}?token=abc`);
      expect(new URL(r).username).toBe("");
    }
  });
  it("a signed URL without a token is refused", async () => {
    const { rebaseSignedUrl } = await import("./sourceDownload");
    expect(rebaseSignedUrl(`http://kong:8000${OK_PATH}`, BASE)).toBeNull();
    expect(rebaseSignedUrl(`http://kong:8000${OK_PATH}?token=`, BASE)).toBeNull();
  });
  it("no failure message, and nothing written to the console by the service, contains the signed URL or its token", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    const secret = "SECRET-TOKEN-123";
    const url = `http://kong:8000${OK_PATH}?token=${secret}&download=tb.csv`;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const messages: string[] = [];
    try {
      for (const attempt of [
        async () => { supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url, file_name: "tb.csv", sha256: "0".repeat(64) }, error: null }); await fetchOriginalSource(CO, UP, served(BYTES) as never, BASE); },
        async () => { supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url, file_name: "tb.csv", sha256: null }, error: null }); await fetchOriginalSource(CO, UP, vi.fn(async () => { throw new TypeError(`fetch failed ${url}`); }) as never, BASE); },
        async () => { supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url, file_name: "tb.csv", sha256: null }, error: null }); await fetchOriginalSource(CO, UP, vi.fn(async () => new Response("no", { status: 403 })) as never, BASE); },
      ]) {
        try { await attempt(); } catch (e) { messages.push(String((e as Error).message), String((e as Error).stack ?? "")); }
      }
      for (const m of messages) { expect(m).not.toContain(secret); expect(m).not.toContain("kong:8000"); }
      expect(messages.length).toBeGreaterThan(0);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
