/**
 * sourceDownload.test.ts: the decision sequence of the trial-balance-source-download Edge Function
 * (supabase/functions/_shared/sourceDownload.ts) with every dependency injected, and the browser half
 * (src/lib/workspace/sourceDownload.ts): server answer handling and the integrity check before anything is saved.
 * The local-stack journey (scripts/e2e/sourceDownloadJourney.mjs) exercises the deployed function end to end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_EXPIRY_SECONDS, parseSourceDownloadRequest, runSourceDownload, safeDownloadName, type SourceDownloadDeps, type UploadTarget,
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
    ...over,
  };
  return d as typeof d & SourceDownloadDeps;
}
const REQ = { uploadId: UP, companyId: CO };

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
    expect(d.canDownload).toHaveBeenCalledTimes(2);
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
