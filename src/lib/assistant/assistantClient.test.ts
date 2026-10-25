/**
 * Ask CFOClose (Release 0.1) — the browser path (src/lib/assistant/assistantClient.ts) and the panel gate.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assistantSession, contextKeyFor, interpretAssistant, statusWords, type AssistantInvoke } from "./assistantClient";
import { ASK_CFOCLOSE_ENABLED } from "./gate";
import { FunctionsClient } from "@supabase/functions-js";
import { supabaseReportingDb } from "@/lib/reporting/supabaseDb";

const A = "99999999-9999-4999-8999-999999999999";
const B = "88888888-8888-4888-8888-888888888888";
const answer = { schemaVersion: "cfoclose-assistant-response/2", action: "explain_movement", label: "Explanation", contextDigest: "d", draftText: null,
  asOf: { compositionSha256: "b".repeat(64), periodYear: 2026, lineId: "sfp.x", lineLabel: "X", currency: "TZS" },
  blocks: [{ kind: "observation", author: "assistant", parts: [{ kind: "text", text: "Hello" }], sources: [] }] };
const httpError = (status: number, body: unknown) => ({ name: "FunctionsHttpError", context: new Response(JSON.stringify(body), { status }) });

describe("interpretAssistant", () => {
  it("maps answered, unavailable, stale, refused and failed bodies (2xx and HTTP errors alike)", async () => {
    expect(await interpretAssistant({ data: { status: "answered", answer, replay: true }, error: null })).toMatchObject({ kind: "answered", replay: true });
    expect(await interpretAssistant({ data: { status: "unavailable", message: "m" }, error: null })).toEqual({ kind: "unavailable", message: "m" });
    expect(await interpretAssistant({ data: null, error: httpError(409, { status: "stale", code: "STALE_CONTEXT", message: "s" }) })).toEqual({ kind: "stale", message: "s" });
    expect(await interpretAssistant({ data: null, error: httpError(429, { status: "refused", code: "AI_BUDGET_EXCEEDED", message: "b" }) }))
      .toEqual({ kind: "refused", code: "AI_BUDGET_EXCEEDED", message: "b" });
    expect(await interpretAssistant({ data: null, error: httpError(502, { status: "failed", code: "ANSWER_INVALID", message: "f" }) })).toMatchObject({ kind: "failed", code: "ANSWER_INVALID" });
  });
  it("a function that is not deployed (bodiless 404: nothing ran) is 'not available'", async () => {
    expect((await interpretAssistant({ data: null, error: httpError(404, "Not found") })).kind).toBe("not_deployed");
  });
  it("transport and gateway failures are UNCERTAIN (the request may have run), never settled", async () => {
    for (const error of [{ name: "FunctionsFetchError", context: new TypeError("network") }, { name: "FunctionsRelayError", context: new Response("", { status: 502 }) },
      httpError(504, "<html>gateway timeout</html>"), { message: "Edge Function returned a non-2xx status code" }]) {
      expect((await interpretAssistant({ data: null, error })).kind).toBe("uncertain");
    }
    expect((await interpretAssistant({ data: "<html>", error: null })).kind).toBe("uncertain");
  });
  it("a malformed answer is not shown (uncertain: the server's record is replayed on retry)", async () => {
    expect((await interpretAssistant({ data: { status: "answered", answer: { blocks: "<b>x</b>" } }, error: null })).kind).toBe("uncertain");
  });
});

describe("assistantSession", () => {
  const ok: AssistantInvoke = async () => ({ data: { status: "answered", answer }, error: null });
  it("sends only action, company, period, line, request id and an enumerated refinement — never a question or figures", async () => {
    const invoke = vi.fn(ok);
    const s = assistantSession(invoke, () => "id-1");
    await s.ask({ action: "draft_commentary", companyId: A, periodYear: 2026, lineId: "sfp.x", refinement: "shorter" });
    expect(invoke.mock.calls[0][1].body).toEqual({ action: "draft_commentary", companyId: A, periodYear: 2026, lineId: "sfp.x", requestId: "id-1", refinement: "shorter" });
  });
  it("a lost response keeps the request id (the retry replays); a settled attempt releases it (asking again is new)", async () => {
    let n = 0;
    const ids: string[] = [];
    const invoke = vi.fn(async (_: string, o: { body: Record<string, unknown> }) => { ids.push(String(o.body.requestId)); if (n++ === 0) throw new TypeError("network"); return { data: { status: "answered", answer }, error: null }; });
    const s = assistantSession(invoke as AssistantInvoke, (() => { let i = 0; return () => `id-${++i}`; })());
    const q = { action: "explain_movement" as const, companyId: A, periodYear: 2026, lineId: "sfp.x" };
    expect((await s.ask(q)).outcome.kind).toBe("uncertain");
    await s.ask(q);
    await s.ask(q);
    expect(ids).toEqual(["id-1", "id-1", "id-2"]);
  });
  it("REGRESSION: the REAL supabase-js client RETURNS FunctionsFetchError (it does not throw) — the retry keeps the request id", async () => {
    const ids: string[] = [];
    let n = 0;
    const customFetch = (async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).requestId);
      if (n++ === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: "answered", answer, replay: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new FunctionsClient("http://functions.invalid", { customFetch });
    const invoke: AssistantInvoke = (name, o) => client.invoke(name, o) as Promise<{ data: unknown; error: unknown }>;
    expect((await client.invoke("assistant-explain", { body: {} })).error?.name).toBe("FunctionsFetchError"); n = 0; ids.length = 0;
    const s = assistantSession(invoke, (() => { let i = 0; return () => `id-${++i}`; })());
    const q = { action: "explain_movement" as const, companyId: A, periodYear: 2026, lineId: "sfp.x" };
    expect((await s.ask(q)).outcome.kind).toBe("uncertain");
    expect((await s.ask(q)).outcome).toMatchObject({ kind: "answered", replay: true });
    expect(ids).toEqual(["id-1", "id-1"]);
    await s.ask(q);
    expect(ids).toEqual(["id-1", "id-1", "id-2"]);   // settled: asking again is a new request
  });
  it("REGRESSION: through the Statements page's transport (supabaseReportingDb), a returned fetch error keeps the id too", async () => {
    const ids: string[] = [];
    let n = 0;
    const customFetch = (async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).requestId);
      if (n++ === 0) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ status: "answered", answer }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const db = supabaseReportingDb({ rpc: () => Promise.resolve({ data: null, error: null }), from: () => ({}), functions: new FunctionsClient("http://functions.invalid", { customFetch }) });
    const invoke: AssistantInvoke = async (name, { body }) => db.invoke!(name, body);
    const s = assistantSession(invoke, (() => { let i = 0; return () => `id-${++i}`; })());
    const q = { action: "explain_movement" as const, companyId: A, periodYear: 2026, lineId: "sfp.x" };
    expect((await s.ask(q)).outcome.kind).toBe("uncertain");
    expect((await s.ask(q)).outcome.kind).toBe("answered");
    expect(ids).toEqual(["id-1", "id-1"]);
  });
  it("a request the server reports as still running keeps its id", async () => {
    const ids: string[] = [];
    let n = 0;
    const invoke: AssistantInvoke = async (_n, o) => { ids.push(String(o.body.requestId)); return n++ === 0
      ? { data: { status: "refused", code: "IN_PROGRESS", message: "running" }, error: null } : { data: { status: "answered", answer }, error: null }; };
    const s = assistantSession(invoke, (() => { let i = 0; return () => `id-${++i}`; })());
    const q = { action: "explain_movement" as const, companyId: A, periodYear: 2026, lineId: "sfp.x" };
    await s.ask(q); await s.ask(q);
    expect(ids).toEqual(["id-1", "id-1"]);
  });
  it("a response from another company, period or line — or an older request — is discarded", async () => {
    const s = assistantSession(ok);
    const first = await s.ask({ action: "explain_movement", companyId: A, periodYear: 2026, lineId: "sfp.x" });
    expect(s.accepts(first.ticket, contextKeyFor(B, 2026, "sfp.x"))).toBe(false);   // switched company while waiting
    const older = await s.ask({ action: "explain_movement", companyId: A, periodYear: 2026, lineId: "sfp.x" });
    const newer = await s.ask({ action: "draft_commentary", companyId: A, periodYear: 2026, lineId: "sfp.x" });
    expect(s.accepts(older.ticket, contextKeyFor(A, 2026, "sfp.x"))).toBe(false);
    expect(s.accepts(newer.ticket, contextKeyFor(A, 2026, "sfp.x"))).toBe(true);
    expect(s.accepts(newer.ticket, contextKeyFor(A, 2025, "sfp.x"))).toBe(false);
  });
});

describe("the panel", () => {
  it("status words: reporting is never presented as affected", () => {
    expect(statusWords("available")).toBeNull();
    for (const s of ["disabled", "not_enabled", "no_budget", "unavailable"]) expect(statusWords(s)).toBeTruthy();
    expect(statusWords("disabled")).toContain("unaffected");
  });
  it("the presentation gate is reviewed; server eligibility remains required", () => {
    expect(ASK_CFOCLOSE_ENABLED).toBe(true);
    const src = fs.readFileSync(path.resolve(__dirname, "gate.ts"), "utf8");
    expect(src).toMatch(/export const ASK_CFOCLOSE_ENABLED = true;/);
    expect(src).not.toMatch(/import\.meta\.env|process\.env|localStorage|sessionStorage|document\.cookie|URLSearchParams/);
  });
  it("renders answers as text (no HTML injection path) and never writes a financial record", () => {
    const panel = fs.readFileSync(path.resolve(__dirname, "../../components/reporting/AskCfoClosePanel.tsx"), "utf8");
    expect(panel).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    expect(panel).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    // The only server calls: the status read and the assistant function.
    expect([...panel.matchAll(/rpc\.current\("([a-z_]+)"/g)].map((m) => m[1])).toEqual(["internal_beta_status", "ai_assistant_status"]);
    const view = fs.readFileSync(path.resolve(__dirname, "../../components/reporting/StatementsView.tsx"), "utf8");
    expect(view.match(/ASK_CFOCLOSE_ENABLED \?/g)?.length).toBe(2);
  });
});
