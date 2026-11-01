import { describe, expect, it, vi } from "vitest";
import { QBO_CONNECTOR_ENABLED, QBO_ENVIRONMENT, QBO_MESSAGES, RECORD_PENDING_NOTE, connectionState, fetchConnections, finishConnect, messageFor, pullFromQuickBooks, readHandoff, startConnect, type PullInput, type QboConnectionRow } from "./qboConnectorClient";

// Invented values only.
const COMPANY = "11111111-1111-1111-1111-111111111111";
const row = (over: Partial<QboConnectionRow> = {}): QboConnectionRow => ({ id: "c1", realm_id: "9341458607761798", environment: "sandbox", status: "active", refresh_expires_at: "2027-02-09T00:00:00Z", created_at: "2026-11-01T00:00:00Z", ...over });
const PULL: PullInput = { companyId: COMPANY, environment: "sandbox", realmId: "9341458607761798", startDate: "2026-01-01", endDate: "2026-10-31", periodYear: 2026, periodId: null, engagementId: null };
const fn = (answer: () => unknown) => ({ functions: { invoke: vi.fn(async () => answer() as { data: unknown; error: unknown }) } });
const failingWith = (json: unknown) => ({ data: null, error: { context: { json: async () => json } } });

describe("release state", () => {
  it("the connector is off and pointed at the development app until it is deliberately released", () => {
    expect(QBO_CONNECTOR_ENABLED).toBe(false);
    expect(QBO_ENVIRONMENT).toBe("sandbox");
  });
});

describe("connection state", () => {
  it("an unreadable status hides the card; no rows means none; the newest live connection of this environment decides", () => {
    expect(connectionState(null, "sandbox")).toEqual({ kind: "unavailable" });
    expect(connectionState([], "sandbox")).toEqual({ kind: "none" });
    expect(connectionState([row({ status: "disconnected" })], "sandbox")).toEqual({ kind: "none" });
    expect(connectionState([row({ environment: "production" })], "sandbox")).toEqual({ kind: "none" });
    expect(connectionState([row()], "sandbox")).toEqual({ kind: "connected", realmId: "9341458607761798" });
    expect(connectionState([row({ status: "reconnect_needed" })], "sandbox")).toEqual({ kind: "reconnect", realmId: "9341458607761798" });
    expect(connectionState([row({ id: "old", status: "reconnect_needed", created_at: "2026-01-01T00:00:00Z" }), row({ id: "new", realm_id: "777", created_at: "2026-06-01T00:00:00Z" })], "sandbox"))
      .toEqual({ kind: "connected", realmId: "777" });
  });
  it("reads status through the status function only, and treats any failure as unavailable", async () => {
    const rpc = vi.fn(async () => ({ data: [row()], error: null }));
    expect(await fetchConnections({ rpc } as never, COMPANY)).toEqual([row()]);
    expect(rpc).toHaveBeenCalledWith("qbo_connection_status", { p_company_id: COMPANY });
    expect(await fetchConnections({ rpc: async () => ({ data: null, error: { message: "no such function" } }) } as never, COMPANY)).toBeNull();
    expect(await fetchConnections({ rpc: async () => ({ data: "x", error: null }) } as never, COMPANY)).toBeNull();
    expect(await fetchConnections({ rpc: async () => { throw new Error("network"); } } as never, COMPANY)).toBeNull();
  });
});

describe("starting a connection", () => {
  const ARGS = { companyId: COMPANY, periodYear: 2026, environment: "sandbox" as const };
  it("sends exactly the company, the environment and the period year, and follows only the https address the function built", async () => {
    const c = fn(() => ({ data: { outcome: "authorize", authorizeUrl: "https://appcenter.example.test/connect?state=abc" }, error: null }));
    expect(await startConnect(c, ARGS)).toEqual({ kind: "redirect", url: "https://appcenter.example.test/connect?state=abc" });
    expect(c.functions.invoke).toHaveBeenCalledWith("qbo-connect-start", { body: { companyId: COMPANY, environment: "sandbox", periodYear: 2026 } });
  });
  it.each<[string, () => unknown]>([
    ["a non-https address", () => ({ data: { outcome: "authorize", authorizeUrl: "http://evil.example.test/" }, error: null })],
    ["a javascript address", () => ({ data: { outcome: "authorize", authorizeUrl: "javascript:alert(1)" }, error: null })],
    ["no address", () => ({ data: { outcome: "authorize" }, error: null })],
  ])("never follows %s", async (_l, answer) => { expect((await startConnect(fn(answer), ARGS)).kind).toBe("failed"); });
  it("says the plain sentence for a refusal, whether it arrives as data or as an error body, and never throws", async () => {
    expect(await startConnect(fn(() => failingWith({ outcome: "forbidden" })), ARGS)).toEqual({ kind: "failed", message: QBO_MESSAGES.forbidden });
    expect(await startConnect(fn(() => ({ data: { outcome: "not_configured" }, error: null })), ARGS)).toEqual({ kind: "failed", message: QBO_MESSAGES.not_configured });
    const c = { functions: { invoke: async () => { throw new Error("offline"); } } };
    expect((await startConnect(c as never, ARGS)).kind).toBe("failed");
  });
});

describe("finishing a connection (review r2, S4)", () => {
  const H = "cd".repeat(32);
  it("reads the one-time handoff only from the fragment, only in its exact shape", () => {
    expect(readHandoff(`#qbo_handoff=${H}`)).toBe(H);
    for (const bad of ["", "#", `?qbo_handoff=${H}`, `qbo_handoff=${H}`, "#qbo_handoff=short", `#qbo_handoff=${H.toUpperCase()}`, `#other=${H}`, `#qbo_handoff=${H}x`]) expect(readHandoff(bad)).toBeNull();
    expect(readHandoff(`#a=1&qbo_handoff=${H}`)).toBe(H);
  });
  it("sends exactly the handoff, nothing else (the person comes from the login), and reports 'connected'", async () => {
    const c = fn(() => ({ data: { outcome: "connected" }, error: null }));
    expect(await finishConnect(c, H)).toEqual({ kind: "connected" });
    expect(c.functions.invoke).toHaveBeenCalledWith("qbo-finish-connection", { body: { handoff: H } });
  });
  it("says in plain words when someone else started it, when it took too long, and otherwise that it could not be connected; never throws", async () => {
    expect(await finishConnect(fn(() => failingWith({ outcome: "not_yours" })), H)).toEqual({ kind: "failed", outcome: "not_yours", message: QBO_MESSAGES.not_yours });
    expect(await finishConnect(fn(() => failingWith({ outcome: "expired" })), H)).toEqual({ kind: "failed", outcome: "expired", message: QBO_MESSAGES.expired });
    expect(await finishConnect(fn(() => failingWith({ outcome: "forbidden" })), H)).toMatchObject({ message: QBO_MESSAGES.forbidden });
    expect(await finishConnect(fn(() => failingWith({ outcome: "failed" })), H)).toMatchObject({ message: "QuickBooks could not be connected. Please try again." });
    expect(await finishConnect({ functions: { invoke: async () => { throw new Error("offline"); } } } as never, H)).toMatchObject({ kind: "failed", message: "QuickBooks could not be connected. Please try again." });
    expect(QBO_MESSAGES.not_yours).toContain("Nothing was shared");
  });
});

describe("importing", () => {
  it("sends the documented keys, omits an absent period or engagement id, and returns what was imported", async () => {
    const c = fn(() => ({ data: { outcome: "imported", uploadId: "u-1", accountCount: 30, currency: "GBP" }, error: null }));
    expect(await pullFromQuickBooks(c, PULL)).toEqual({ kind: "imported", uploadId: "u-1", accountCount: 30, currency: "GBP", recordPending: false });
    expect(c.functions.invoke).toHaveBeenCalledWith("qbo-pull-trial-balance", { body: { companyId: COMPANY, environment: "sandbox", realmId: PULL.realmId, startDate: "2026-01-01", endDate: "2026-10-31", periodYear: 2026 } });
    await pullFromQuickBooks(c, { ...PULL, periodId: "p-1", engagementId: "e-1" });
    expect((c.functions.invoke.mock.calls[1] as unknown[])[1]).toMatchObject({ body: { periodId: "p-1", engagementId: "e-1" } });
  });
  it("a refusal carries its plain sentence and the server's detail for a refused report", async () => {
    const refused = await pullFromQuickBooks(fn(() => failingWith({ outcome: "report_refused", code: "UNBALANCED", message: "The report's debits and credits are not equal." })), PULL);
    expect(refused).toEqual({ kind: "failed", outcome: "report_refused", message: QBO_MESSAGES.report_refused, detail: "The report's debits and credits are not equal." });
  });
  it("a failure to save the source record means NOTHING was imported (the function stores nothing unless the record is on file), and says so", async () => {
    const prov = await pullFromQuickBooks(fn(() => failingWith({ outcome: "provenance_failed" })), PULL);
    expect(prov).toMatchObject({ kind: "failed", outcome: "provenance_failed", message: QBO_MESSAGES.provenance_failed });
    expect(QBO_MESSAGES.provenance_failed).toMatch(/^Nothing was imported/);
    expect(prov).not.toHaveProperty("uploadId");
  });
  it("'imported_record_pending' (HTTP 202) is an import: the trial balance is saved and its record is on file, only the final link is still being finished", async () => {
    const r = await pullFromQuickBooks(fn(() => ({ data: { outcome: "imported_record_pending", uploadId: "u-2", accountCount: 12, currency: "TZS" }, error: null })), PULL);
    expect(r).toEqual({ kind: "imported", uploadId: "u-2", accountCount: 12, currency: "TZS", recordPending: true });
    expect(RECORD_PENDING_NOTE).toMatch(/finishes by itself/);
    expect(RECORD_PENDING_NOTE).not.toMatch(/token|secret|envelope|oauth|jwt|SAFISHA|HESABU|KINGA|MAONO/i);
    expect((await pullFromQuickBooks(fn(() => ({ data: { outcome: "imported_record_pending" }, error: null })), PULL)).kind).toBe("failed");   // no upload id, no import
  });
  it("an answer that is not understood is the generic sentence, never a thrown error or a raw body", async () => {
    for (const answer of [() => ({ data: null, error: null }), () => ({ data: { outcome: "imported" }, error: null }), () => ({ data: { outcome: "something-new" }, error: null }), () => failingWith("<html>")]) {
      const r = await pullFromQuickBooks(fn(answer), PULL);
      expect(r.kind).toBe("failed");
      expect(JSON.stringify(r)).not.toContain("<html>");
    }
    const t = { functions: { invoke: async () => { throw new Error("offline"); } } };
    expect((await pullFromQuickBooks(t as never, PULL)).kind).toBe("failed");
  });
});

describe("the sentences", () => {
  const OUTCOMES = ["unauthenticated", "forbidden", "not_configured", "state_failed", "not_connected", "reconnect_needed", "token_unreadable", "busy", "rate_limited", "quickbooks_unavailable",
    "quickbooks_rejected", "report_failed", "report_unreadable", "report_too_large", "report_refused", "period_mismatch", "reserve_failed", "store_failed", "register_failed", "active_upload_exists",
    "provenance_failed", "pull_failed", "invalid_request"];
  it("every outcome the functions can answer has its own sentence", () => { for (const o of OUTCOMES) expect(QBO_MESSAGES[o], o).toBeTruthy(); });
  it("no sentence names an engine or exposes a credential term", () => {
    for (const [k, v] of Object.entries(QBO_MESSAGES)) {
      expect(v, k).not.toMatch(/SAFISHA|HESABU|KINGA|MAONO/);
      expect(v, k).not.toMatch(/token|secret|envelope|oauth|jwt|authori[sz]ation code/i);
    }
  });
  it("an unknown or missing outcome gets the generic sentence", () => {
    expect(messageFor(undefined)).toBe(QBO_MESSAGES.pull_failed);
    expect(messageFor("brand-new")).toBe(QBO_MESSAGES.pull_failed);
  });
});
