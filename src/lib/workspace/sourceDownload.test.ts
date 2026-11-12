/**
 * sourceDownload.test.ts: the decision sequence of the trial-balance-source-download Edge Function
 * (supabase/functions/_shared/sourceDownload.ts) with every dependency injected, and the browser half
 * (src/lib/workspace/sourceDownload.ts): server answer handling and the integrity check before anything is saved.
 * The local-stack journey (scripts/e2e/sourceDownloadJourney.mjs) exercises the deployed function end to end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOWNLOAD_EXPIRY_SECONDS, DOWNLOAD_MIN_REMAINING_SECONDS, NO_CACHE, SIGNER_EXPIRY_TOLERANCE_SECONDS, parseSourceDownloadRequest, proxiedFileHeaders, runSourceDownload, safeDownloadName, signedUrlExpiryMs, storageErrorIsMissingObject,
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
    sign: vi.fn(async (path: string): Promise<{ url: string; expiresAtMs?: number | null }> => ({ url: `https://storage.invalid/sign/${path}?token=t`, expiresAtMs: NOW() + 60_000 })),
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

describe("request parsing: exactly an upload id and a company id (and optionally proxied delivery)", () => {
  it("accepts exactly { upload_id, company_id } as UUIDs (the original link answer)", () => expect(parseSourceDownloadRequest({ upload_id: UP, company_id: CO })).toEqual({ ...REQ, delivery: "link" }));
  it("accepts { upload_id, company_id, delivery: 'proxied' } and no other delivery value", () => {
    expect(parseSourceDownloadRequest({ upload_id: UP, company_id: CO, delivery: "proxied" })).toEqual({ ...REQ, delivery: "proxied" });
    for (const delivery of ["link", "PROXIED", "", null, true, { mode: "proxied" }]) expect(parseSourceDownloadRequest({ upload_id: UP, company_id: CO, delivery }), String(delivery)).toBeNull();
  });
  it("refuses a path, bucket, user, a missing or extra key and malformed ids", () => {
    for (const body of [{ upload_id: UP }, { company_id: CO }, { upload_id: UP, company_id: CO, path: "workspaces/x" }, { upload_id: UP, company_id: CO, bucket: "avatars" },
      { upload_id: UP, company_id: CO, user_id: USER }, { upload_id: "nope", company_id: CO }, { upload_id: UP, company_id: "nope" }, { upload_id: UP, company_id: 3 }, {}, null, [UP, CO],
      { upload_id: UP, company_id: CO, delivery: "proxied", path: "workspaces/x" }, { upload_id: UP, delivery: "proxied" }, { upload_id: "nope", company_id: CO, delivery: "proxied" }]) {
      expect(parseSourceDownloadRequest(body)).toBeNull();
    }
  });
});

describe("proxied file response headers (Intuit: no-cache and no-store, never private)", () => {
  it("are never cacheable, name the file safely and expose only the integrity headers the browser needs", () => {
    const h = proxiedFileHeaders("Mwamba TB 2026.csv", HASH.toUpperCase(), "131");
    expect(NO_CACHE).toBe("no-cache, no-store");
    expect(h).toEqual({
      "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="Mwamba TB 2026.csv"', "Cache-Control": "no-cache, no-store", "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff", "X-Source-File-Name": "Mwamba TB 2026.csv", "X-Source-Sha256": HASH,
      "Access-Control-Expose-Headers": "Content-Disposition, X-Source-File-Name, X-Source-Sha256", "Content-Length": "131",
    });
    expect(h["Cache-Control"]).not.toMatch(/private|max-age|public/);
  });
  it("a hostile name cannot break the header; an unrecorded or malformed fingerprint and a non-numeric length are left out", () => {
    const h = proxiedFileHeaders('a"; filename=evil.exe\r\nX: y', "not-a-hash", "12; x");
    expect(h["Content-Disposition"]).toMatch(/^attachment; filename="[A-Za-z0-9._ -]+"$/);
    expect(h["X-Source-File-Name"]).toMatch(/^[A-Za-z0-9._ -]+$/);
    expect("X-Source-Sha256" in h).toBe(false);
    expect("Content-Length" in h).toBe(false);
    expect("X-Source-Sha256" in proxiedFileHeaders("tb.csv", null, null)).toBe(false);
  });
  it("declares Storage's length only for an unencoded body: an encoded (gzip/br) answer is decoded by fetch, so its length is the compressed one", () => {
    expect(proxiedFileHeaders("tb.csv", null, "131", null)["Content-Length"]).toBe("131");
    expect(proxiedFileHeaders("tb.csv", null, "131", "identity")["Content-Length"]).toBe("131");
    for (const encoding of ["gzip", "br", "deflate", "gzip, br", "GZIP", "x-unknown"]) {
      const h = proxiedFileHeaders("tb.csv", HASH, "131", encoding);
      expect("Content-Length" in h, encoding).toBe(false);
      expect(h["Cache-Control"], encoding).toBe("no-cache, no-store");
      expect("Content-Encoding" in h, encoding).toBe(false);   // the decoded bytes are streamed; the encoding header is never forwarded
    }
  });
  it("the function passes Storage's Content-Encoding with its Content-Length", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("supabase/functions/trial-balance-source-download/index.ts", "utf8");
    expect(src).toContain('upstream.headers.get("content-length"), upstream.headers.get("content-encoding")');
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

describe("runSourceDownload: atomic issuance decision, freshness and expiry", () => {
  const sentToDecide = (d: ReturnType<typeof deps>) => d.decide.mock.calls[0][0] as IssuanceRequest;
  it("the link is returned ONLY when the database decision committed as issued; the decision carries the signing interval, the signer's exp and the margin, never the URL", async () => {
    const d = deps();
    const r = await runSourceDownload(d, REQ);
    expect(r).toMatchObject({ status: 200, outcome: "ready", expires_in: DOWNLOAD_EXPIRY_SECONDS });
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(sentToDecide(d)).toEqual({
      userId: "user-1", companyId: CO, uploadId: UP, signingStartedAt: "2026-10-30T12:00:00.000Z", signingCompletedAt: "2026-10-30T12:00:00.000Z",
      linkLifetimeSeconds: DOWNLOAD_EXPIRY_SECONDS, linkExpiryExactAt: "2026-10-30T12:01:00.000Z", minRemainingSeconds: DOWNLOAD_MIN_REMAINING_SECONDS, sha256: HASH,
    });
    expect(JSON.stringify(d.decide.mock.calls)).not.toMatch(/token=|http:|https:|workspaces\//);
  });
  it("the ordinary read before signing is a precheck, not the ordering point: a withdrawal after it is decided by the database, and when it wins no link is returned", async () => {
    let release!: (v: { url: string; expiresAtMs: number }) => void;
    const d = deps({ sign: vi.fn(() => new Promise<{ url: string; expiresAtMs: number }>((resolve) => { release = resolve; })), decide: vi.fn(async () => "withdrawn_before_issue" as const) });
    const pending = runSourceDownload(d, REQ);
    await vi.waitFor(() => expect(d.sign).toHaveBeenCalled());
    release({ url: "https://storage.invalid/sign/x?token=SECRET-TOKEN", expiresAtMs: T0 + 60_000 });
    const r = await pending;
    expect(r).toEqual({ status: 403, outcome: "forbidden" });
    expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    expect(d.canDownload).toHaveBeenCalledTimes(1);
  });
  it("the decision committed first: a later withdrawal does not un-issue; the link is delivered under the contract (a bearer credential until its own expiry)", async () => {
    const d = deps();
    const r = await runSourceDownload(d, REQ);
    expect(r.outcome).toBe("ready");
    expect(d.canDownload).toHaveBeenCalledTimes(1);
    expect(d.decide).toHaveBeenCalledTimes(1);
    expect(d.recordDenial).not.toHaveBeenCalled();
  });
  it("NO ESTIMATED EXPIRY: a link whose exp cannot be read is discarded, unissued and unrecorded (whole-second truncation makes any estimate unreliable)", async () => {
    // Storage truncates the signing instant to a whole second: signing at 12:00:00.900 yields exp 12:01:00.000, which is EARLIER than start + 60 s (12:01:00.900).
    // An estimate from the signing interval would have claimed the link was valid for 0.9 s that it did not have. No estimate is made.
    clockMs = T0 + 900;
    for (const expiresAtMs of [undefined, null, Number.NaN]) {
      const d = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=SECRET-TOKEN", expiresAtMs })) });
      const r = await runSourceDownload(d, REQ);
      expect(r).toEqual({ status: 502, outcome: "signing_failed" });
      expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
      expect(d.decide).not.toHaveBeenCalled();
    }
  });
  it("whole-second signer: the exp is passed to the decision exactly as the signer emitted it, with the margin", async () => {
    clockMs = T0 + 900;                                         // signing at ...:00.900
    const trueExp = Math.floor(clockMs / 1000) * 1000 + 60_000;  // the token's exp, truncated to the second
    const d = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: trueExp })) });
    const r = await runSourceDownload(d, REQ);
    expect(sentToDecide(d).linkExpiryExactAt).toBe(new Date(trueExp).toISOString());
    expect(trueExp).toBeLessThan(clockMs + 60_000);              // earlier than start + lifetime: the counterexample to every estimate
    expect(r.expires_in).toBe(59);                               // time to the signer's exp, floored: 59.1 s -> 59
  });
  it("boundary expiry: exactly the margin left is accepted; one millisecond less is refused, before any decision is taken", async () => {
    const edge = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: T0 + DOWNLOAD_MIN_REMAINING_SECONDS * 1000 })) });
    expect((await runSourceDownload(edge, REQ)).outcome).toBe("ready");
    const under = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: T0 + DOWNLOAD_MIN_REMAINING_SECONDS * 1000 - 1 })) });
    expect(await runSourceDownload(under, REQ)).toEqual({ status: 503, outcome: "link_expired" });
    expect(under.decide).not.toHaveBeenCalled();
  });
  it("delayed signing: the time left is to the signer's exp, so a slow signature shortens it; one that eats the margin is refused", async () => {
    const slow = deps({ sign: vi.fn(async () => { const expiresAtMs = clockMs + 60_000; clockMs += 25_000; return { url: "https://storage.invalid/sign/x?token=t", expiresAtMs }; }) });
    const r = await runSourceDownload(slow, REQ);
    expect(r.expires_in).toBe(35);
    clockMs = T0;
    const tooSlow = deps({ sign: vi.fn(async () => { const expiresAtMs = clockMs + 60_000; clockMs += 56_000; return { url: "https://storage.invalid/sign/x?token=t", expiresAtMs }; }) });
    expect(await runSourceDownload(tooSlow, REQ)).toEqual({ status: 503, outcome: "link_expired" });
    expect(tooSlow.decide).not.toHaveBeenCalled();
  });
  it("delayed decision: the link ran out while the database decision was taken -> never 'ready', and never 'ready' with expires_in 0", async () => {
    // The decision committed as issued (freshness was fine when it was judged), then this host's clock finds the margin gone.
    for (const lateBy of [56_000, 59_999, 60_000, 90_000]) {
      clockMs = T0;
      const d = deps({ decide: vi.fn(async () => { clockMs += lateBy; return "issued" as const; }) });
      const r = await runSourceDownload(d, REQ);
      expect(r, String(lateBy)).toEqual({ status: 503, outcome: "link_expired" });
      expect((r as { url?: string }).url).toBeUndefined();
      expect(d.decide).toHaveBeenCalledTimes(1);          // the decision is as committed; nothing is retried, updated or recorded again
    }
    clockMs = T0;
    const ok = deps({ decide: vi.fn(async () => { clockMs += 54_000; return "issued" as const; }) });
    expect(await runSourceDownload(ok, REQ)).toMatchObject({ status: 200, outcome: "ready", expires_in: 6 });
  });
  it("delayed response: whatever the clock does after the decision, 'ready' always carries at least the margin", async () => {
    for (let late = 0; late <= 60_000; late += 1_000) {
      clockMs = T0;
      const d = deps({ decide: vi.fn(async () => { clockMs += late; return "issued" as const; }) });
      const r = await runSourceDownload(d, REQ);
      if (r.outcome === "ready") expect(r.expires_in).toBeGreaterThanOrEqual(DOWNLOAD_MIN_REMAINING_SECONDS);
      else expect(r.outcome).toBe("link_expired");
    }
  });
  it("expiry before issuance: a link the database found past its margin is not returned, with its own answer", async () => {
    const d = deps({ decide: vi.fn(async () => "expired_before_issue" as const) });
    const r = await runSourceDownload(d, REQ);
    expect(r).toEqual({ status: 503, outcome: "link_expired" });
    expect((r as { url?: string }).url).toBeUndefined();
  });
  it("the signer's exp is trusted only within reason: a link that would outlive the request by more than the tolerance is discarded unissued", async () => {
    const long = deps({ sign: vi.fn(async () => ({ url: "https://storage.invalid/sign/x?token=t", expiresAtMs: T0 + (DOWNLOAD_EXPIRY_SECONDS + SIGNER_EXPIRY_TOLERANCE_SECONDS + 5) * 1000 })) });
    expect(await runSourceDownload(long, REQ)).toEqual({ status: 502, outcome: "signing_failed" });
    expect(long.decide).not.toHaveBeenCalled();
  });
  it("a decision that could not be taken (lock timeout, owner changed) or stored (database failure, audit-insert failure) returns no link", async () => {
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
    void delivered;
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

describe("storageErrorIsMissingObject: a removed object is 'unavailable', every other signing error is a signing failure", () => {
  it("recognises Storage's not-found messages in any spelling and nothing else", () => {
    for (const m of ["Object not found", "The resource was not found", "Not Found", "not  found", "notfound"]) expect(storageErrorIsMissingObject(m), m).toBe(true);
    for (const m of ["Rate limit exceeded", "Invalid JWT", "bucket unreachable", "", null, undefined, 404]) expect(storageErrorIsMissingObject(m), String(m)).toBe(false);
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
// What supabase.functions.invoke answers for an application/octet-stream response: { data: Blob, error: null, response }.
const servedFile = (b: Uint8Array, sha256: string | null, name = "tb.csv") => {
  const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-cache, no-store", "X-Source-File-Name": name });
  if (sha256) headers.set("X-Source-Sha256", sha256);
  return { data: new Blob([b]), error: null, response: new Response(null, { status: 200, headers }) };
};

describe("fetchOriginalSource (proxied delivery: the browser never receives or fetches a signed URL)", () => {
  it("asks for exactly the upload and company with proxied delivery and returns bytes that match the recorded fingerprint", async () => {
    supa.invoke.mockResolvedValueOnce(servedFile(BYTES, await sha(BYTES)));
    const { fetchOriginalSource } = await import("./sourceDownload");
    const file = await fetchOriginalSource(CO, UP);
    expect(supa.invoke).toHaveBeenCalledTimes(1);
    expect(supa.invoke).toHaveBeenCalledWith("trial-balance-source-download", { body: { upload_id: UP, company_id: CO, delivery: "proxied" } });
    expect(file).toMatchObject({ fileName: "tb.csv", integrity: "matched", size: BYTES.byteLength });
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(BYTES);
  });
  it("bytes that do NOT match the recorded fingerprint are refused and never returned", async () => {
    supa.invoke.mockResolvedValueOnce(servedFile(BYTES, "0".repeat(64)));
    const { fetchOriginalSource } = await import("./sourceDownload");
    await expect(fetchOriginalSource(CO, UP)).rejects.toMatchObject({ code: "integrity", retryable: true });
  });
  it("no recorded fingerprint: the bytes are returned and said to be unverified", async () => {
    supa.invoke.mockResolvedValueOnce(servedFile(BYTES, null));
    const { fetchOriginalSource } = await import("./sourceDownload");
    await expect(fetchOriginalSource(CO, UP)).resolves.toMatchObject({ integrity: "not_recorded", fileName: "tb.csv" });
  });
  it("forbidden / unauthenticated / unavailable are distinct and not retryable", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    for (const [outcome, code] of [["forbidden", "forbidden"], ["unauthenticated", "unauthenticated"], ["unavailable", "unavailable"]] as const) {
      supa.invoke.mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ outcome }) } } });
      await expect(fetchOriginalSource(CO, UP)).rejects.toMatchObject({ code, retryable: false });
    }
  });
  it("a delivery failure, an unreadable error and a LINK answer (an older function) are retryable failures; nothing is saved", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    supa.invoke.mockResolvedValueOnce({ data: null, error: { context: { json: async () => ({ outcome: "delivery_failed" }) } } });
    await expect(fetchOriginalSource(CO, UP)).rejects.toMatchObject({ code: "failed", retryable: true });
    supa.invoke.mockResolvedValueOnce({ data: null, error: { context: {} } });
    await expect(fetchOriginalSource(CO, UP)).rejects.toMatchObject({ code: "failed", retryable: true });
    supa.invoke.mockResolvedValueOnce({ data: { outcome: "ready", url: "https://storage.invalid/storage/v1/object/sign/trial-balance-files/x?token=t" }, error: null, response: new Response(null) });
    await expect(fetchOriginalSource(CO, UP)).rejects.toMatchObject({ code: "failed", retryable: true });
  });
  it("no failure message, and nothing written to the console, contains a signed URL or token", async () => {
    const { fetchOriginalSource } = await import("./sourceDownload");
    const secret = "SECRET-TOKEN-123";
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const messages: string[] = [];
    try {
      for (const answer of [
        { data: { outcome: "ready", url: `http://kong:8000/storage/v1/object/sign/trial-balance-files/x?token=${secret}` }, error: null, response: new Response(null) },
        { data: null, error: { message: `failed ${secret}`, context: { json: async () => ({ outcome: "delivery_failed" }) } } },
        servedFile(BYTES, "0".repeat(64)),
      ]) {
        supa.invoke.mockResolvedValueOnce(answer);
        try { await fetchOriginalSource(CO, UP); } catch (e) { messages.push(String((e as Error).message), String((e as Error).stack ?? "")); }
      }
      for (const m of messages) { expect(m).not.toContain(secret); expect(m).not.toContain("kong:8000"); }
      expect(messages.length).toBe(6);
      for (const sp of spies) expect(sp).not.toHaveBeenCalled();
    } finally { spies.forEach((sp) => sp.mockRestore()); }
  });
});
