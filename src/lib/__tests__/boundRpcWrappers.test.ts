/**
 * CF-02 (independent readiness assessment, 2026-11-01): `supabase.rpc` was extracted UNBOUND in two wrappers
 * (`const rpc = supabase.rpc as unknown as RpcFn` in src/lib/access/accessRpc.ts and in staffQueue.replyToEnquiry).
 * supabase-js 2.86.2's `SupabaseClient.rpc()` is `return this.rest.rpc(fn, args, options)`, so every call through a
 * detached reference threw "Cannot read properties of undefined (reading 'rest')" — observed live on /admin/access —
 * while the unit tests stayed green because they injected an `rpc` double.
 *
 * These tests therefore go through a REAL SupabaseClient (createClient with a dummy URL/key and a captured fetch): the
 * wrapper must produce the PostgREST request for the named function. An unbound extraction fails here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ requests: [] as { url: string; method: string; body: string | null; apikey: string | null }[] }));

vi.mock("@/integrations/supabase/client", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    captured.requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null, apikey: headers.get("apikey") });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    supabase: createClient("http://localhost:54321", "test-anon-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch } }),
  };
});

import { supabase } from "@/integrations/supabase/client";
import { callAccessRpc } from "@/lib/access/accessRpc";
import { replyToEnquiry } from "@/lib/serviceEnquiry/staffQueue";

const RPC = "http://localhost:54321/rest/v1/rpc/";
const last = () => captured.requests[captured.requests.length - 1];

describe("CF-02: rpc wrappers call the method on the real client", () => {
  it("the defect class: a detached `supabase.rpc` reference throws on call (reads `this.rest`)", () => {
    const detached = supabase.rpc as unknown as (name: string) => unknown;
    expect(() => detached("get_access_overview")).toThrow(TypeError);
  });

  it("callAccessRpc(name) reaches PostgREST as POST /rest/v1/rpc/<name> with an empty body and returns the data", async () => {
    const before = captured.requests.length;
    const res = await callAccessRpc("get_access_overview");
    expect(captured.requests.length).toBe(before + 1);
    expect(last()).toMatchObject({ url: `${RPC}get_access_overview`, method: "POST", body: "{}", apikey: "test-anon-key" });
    expect(res).toMatchObject({ data: { ok: true }, error: null });
  });

  it("callAccessRpc(name, args) sends the arguments as the JSON body, unchanged", async () => {
    const args = { p_recipient_user_id: "11111111-1111-4111-8111-111111111111", p_capacity: 3, p_unlimited: false, p_reason: "test", p_effective_end: null, p_reauth_nonce: "n" };
    await callAccessRpc("owner_grant_entity_allowance", args);
    expect(last().url).toBe(`${RPC}owner_grant_entity_allowance`);
    expect(JSON.parse(last().body!)).toEqual(args);
  });

  it("replyToEnquiry reaches staff_reply_service_enquiry with the enquiry, body and request id", async () => {
    await expect(replyToEnquiry("22222222-2222-4222-8222-222222222222", "Thank you — we will be in touch.", "req-1")).resolves.toBeUndefined();
    expect(last().url).toBe(`${RPC}staff_reply_service_enquiry`);
    expect(JSON.parse(last().body!)).toEqual({ p_enquiry_id: "22222222-2222-4222-8222-222222222222", p_body: "Thank you — we will be in touch.", p_request_id: "req-1" });
  });
});

// ── Source guard: no module in src/ detaches a client method again ───────────────────────────────────────────────────
const SRC = resolve(__dirname, "../..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
};

describe("CF-02 source guard: client methods are never detached from `supabase`", () => {
  const files = walk(SRC);
  it("scans the application source", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("no `= supabase.rpc|from|functions.invoke as …` extraction, and no bare detached reference, anywhere in src/", () => {
    // A detached method loses `this`; the cast must be applied at the call: `(supabase.rpc as unknown as Fn).call(supabase, …)`
    // or `(supabase.rpc as unknown as Fn)(…)` (a parenthesised member call keeps its receiver).
    const detachedCast = /=\s*supabase\.(rpc|from|functions\.invoke)\s+as\b/;
    const detachedBare = /=\s*supabase\.(rpc|from|functions\.invoke)\s*[;,\n)]/;
    const offenders: string[] = [];
    for (const f of files) {
      // Code only: comments that describe the defect are not the defect.
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (detachedCast.test(src) || detachedBare.test(src)) offenders.push(relative(SRC, f).replace(/\\/g, "/"));
    }
    expect(offenders).toEqual([]);
  });
});
