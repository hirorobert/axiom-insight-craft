/**
 * Ask CFOClose (Release 0.1) — the Claude Messages API adapter (with a mocked fetch: no network, no credits), error
 * classification, cost arithmetic, and the reservation ceiling mirrored by the migration's CHECK.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { anthropicProvider, ceilingMicros, costMicros, ProviderError, SYSTEM_PROMPT } from "../../../supabase/functions/_shared/assistantProvider";

const req = (signal = new AbortController().signal) => ({ model: "claude-test", system: SYSTEM_PROMPT, messages: [{ role: "user" as const, content: "facts" }], maxTokens: 900, signal });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Claude adapter", () => {
  it("sends the model, bounds, cached system prompt and key header; reads text and all usage categories", async () => {
    const fetchFn = vi.fn(async () => ok({ content: [{ type: "text", text: "{\"a\":1}" }], stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 } }));
    const out = await anthropicProvider("sk-test", fetchFn as unknown as typeof fetch).complete(req());
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: "claude-test", max_tokens: 900, messages: [{ role: "user", content: "facts" }] });
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(out).toEqual({ text: "{\"a\":1}", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 2000, cacheReadTokens: 0 } });
  });

  it("classifies failures: 429 rate_limited, other 4xx rejected, 5xx failed, network/timeout ambiguous", async () => {
    const kind = async (f: () => Promise<Response>) => {
      try { await anthropicProvider("k", f as unknown as typeof fetch).complete(req()); return "none"; }
      catch (e) { return (e as ProviderError).kind; }
    };
    expect(await kind(async () => new Response("", { status: 429 }))).toBe("rate_limited");
    expect(await kind(async () => new Response("", { status: 400 }))).toBe("rejected");
    expect(await kind(async () => new Response("", { status: 401 }))).toBe("rejected");
    expect(await kind(async () => new Response("", { status: 529 }))).toBe("failed");
    expect(await kind(async () => { throw new DOMException("aborted", "AbortError"); })).toBe("ambiguous");
    expect(await kind(async () => new Response("not json", { status: 200 }))).toBe("ambiguous");
  });
});

describe("cost", () => {
  const P = { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, cacheWriteMicrosPerMTok: 2_500_000, cacheReadMicrosPerMTok: 100_000 };
  it("prices every usage category and rounds up", () => {
    expect(costMicros({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, P)).toBe(2_000_000);
    expect(costMicros({ inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, P)).toBe(2);
    expect(costMicros({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1 }, P)).toBe(1);
    expect(costMicros({ inputTokens: 3000, outputTokens: 400, cacheWriteTokens: 2000, cacheReadTokens: 1500 }, P)).toBe(6000 + 4000 + 5000 + 150);
  });
  it("the reservation ceiling covers two calls at the bounds with every input token at the higher input rate", () => {
    // 2 × ceil((10000 × 2.5 + 1200 × 10) micro-units) = 2 × 37000
    expect(ceilingMicros(2, 10_000, 1_200, P)).toBe(74_000);
  });
  it("the migration enforces the same ceiling as a CHECK on enabling", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20261127100000_assistant_controls.sql"), "utf8");
    expect(sql).toContain("max_cost_per_request_micros >= 2 * ceil(");
    expect(sql).toContain("GREATEST(price_input_micros_per_mtok, price_cache_write_micros_per_mtok)");
    expect(sql).toMatch(/INSERT INTO public\.ai_assistant_settings \(singleton, enabled\) VALUES \(true, false\)/);
  });
});

describe("as deployed", () => {
  it("the function wires the Claude adapter only when the environment names it and holds the key", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../supabase/functions/assistant-explain/index.ts"), "utf8");
    expect(src).toContain('name === "anthropic" && key ? anthropicProvider(key) : null');
    // The composition is read with the person's token, not the service role.
    expect(src).toMatch(/asPerson\.rpc\("fs_statement_composition"/);
    expect(src).not.toMatch(/service\.rpc\("fs_statement_composition"/);
    // Only the harness-mapped remote imports (std serve, supabase-js): no SDK fetched at runtime.
    expect([...src.matchAll(/from\s+"(https?:[^"]+)"/g)].map((m) => m[1]).sort()).toEqual(["https://deno.land/std@0.168.0/http/server.ts", "https://esm.sh/@supabase/supabase-js@2"]);
  });
});
