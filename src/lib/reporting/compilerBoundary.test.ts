import { describe, expect, it, vi } from "vitest";
import { compilationHandler } from "../../../supabase/functions/compile-financial-report/handler";
const body = { companyId: "11111111-1111-4111-8111-111111111111", reportId: "report-1", reportVersion: 1 };
function fixture(authenticated = true) {
  const record = vi.fn(async () => ({ data: { outcome: "compiled", matches: true }, error: null }));
  const compile = vi.fn(async () => ({ documentHash: "a".repeat(64), dependenciesHash: "b".repeat(64), canonicalDocument: { server: true }, evaluation: { findings: [] } }));
  const user = { auth: { getUser: async () => ({ data: { user: authenticated ? { id: "verified-user" } : null }, error: null }) }, rpc: vi.fn(), from: vi.fn() };
  return { record, compile, handler: compilationHandler({ user: () => user, service: () => ({ rpc: record }), compile }) };
}
const request = (b: unknown = body, token = "Bearer verified-token") => new Request("https://example.test/compile", { method: "POST", headers: { Authorization: token }, body: JSON.stringify(b) });
describe("compiler request trust boundary", () => {
  it("records the JWT-verified actor and server result, accepting identifiers only", async () => {
    const f = fixture(); expect((await f.handler(request())).status).toBe(200);
    expect(f.record).toHaveBeenCalledWith("fs_record_server_compilation", expect.objectContaining({ p_actor: "verified-user", p_canonical_document: { server: true }, p_report_version: 1 }));
  });
  it.each(["actor", "document", "findings", "validationStatus", "frameworkEdition"])("rejects caller-controlled %s before compiling or recording anything", async field => {
    const f = fixture(); expect((await f.handler(request({ ...body, [field]: "forged" }))).status).toBe(400);
    expect(f.compile).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("refuses anonymous/invalid sessions and malformed identifiers", async () => {
    const f = fixture(false); expect((await f.handler(request())).status).toBe(401); expect(f.record).not.toHaveBeenCalled();
    const good = fixture(); expect((await good.handler(request({ ...body, reportVersion: "1" }))).status).toBe(400);
    expect((await good.handler(request(null))).status).toBe(400); expect(good.compile).not.toHaveBeenCalled();
  });
  it("never records a receipt when the independent compiler fails", async () => {
    const f = fixture(); f.compile.mockRejectedValue(new Error("SERVER_EVIDENCE_INVALID"));
    expect((await f.handler(request())).status).toBe(409); expect(f.record).not.toHaveBeenCalled();
  });
  it.each([false, true])("bounds streamed bytes even with a missing or understated Content-Length (%s)", async understated => {
    const f = fixture(); const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)); }, cancel,
    });
    const req = new Request("https://example.test/compile", { method: "POST", body: stream,
      headers: { Authorization: "Bearer verified-token", ...(understated ? { "Content-Length": "1" } : {}) },
      duplex: "half" } as RequestInit);
    expect((await f.handler(req)).status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce(); expect(f.compile).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("accepts a valid request split across UTF-8 chunks and rejects invalid UTF-8", async () => {
    for (const invalid of [false, true]) {
      const f = fixture(); const bytes = invalid ? new Uint8Array([0xff]) : new TextEncoder().encode(JSON.stringify(body));
      const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
      const req = new Request("https://example.test/compile", { method: "POST", headers: { Authorization: "Bearer verified-token" }, body: stream, duplex: "half" } as RequestInit);
      expect((await f.handler(req)).status).toBe(invalid ? 400 : 200);
      expect(f.record).toHaveBeenCalledTimes(invalid ? 0 : 1);
    }
  });
});
