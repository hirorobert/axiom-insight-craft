// @vitest-environment jsdom
/**
 * D3 compensating controls (client side). These tests prove what the browser does with signed-in data; they do NOT prove any HTTP
 * response header (that is the platform's, pending with Lovable support).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  clearSensitiveClientState, decideAuthTransition, installBfcacheGuard, installNoStoreFetch, isSensitiveSessionKey, isSupabaseRequest, withNoStore,
} from "../sensitiveDataControls";

const SB = "https://bvyivmmfjejbmqoydezk.supabase.co";
const ok = () => Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));

describe("no-store fetch for the Supabase origin", () => {
  it("matches the Supabase origin exactly, never a look-alike host or another origin", () => {
    expect(isSupabaseRequest(`${SB}/rest/v1/companies?select=id`, SB)).toBe(true);
    expect(isSupabaseRequest(`${SB}/auth/v1/token?grant_type=refresh_token`, SB)).toBe(true);
    expect(isSupabaseRequest(`${SB}/functions/v1/commercial-create-checkout`, SB)).toBe(true);
    expect(isSupabaseRequest("https://bvyivmmfjejbmqoydezk.supabase.co.evil.example/rest/v1/x", SB)).toBe(false);
    expect(isSupabaseRequest("https://cfoclose.com/assets/index.js", SB)).toBe(false);
    expect(isSupabaseRequest("https://api.polar.sh/v1/checkouts", SB)).toBe(false);
    expect(isSupabaseRequest(`${SB}/rest/v1/x`, undefined)).toBe(false);
  });

  it("adds cache: no-store to Supabase requests (string, URL and Request inputs), keeps headers and body, leaves other origins alone", async () => {
    const seen: { url: string; init?: RequestInit; req?: Request }[] = [];
    const base = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init, req: input instanceof Request ? input : undefined });
      return ok();
    });
    const f = withNoStore(base, SB);
    await f(`${SB}/rest/v1/companies?select=id`, { headers: { Authorization: "Bearer t" } });
    await f(new URL(`${SB}/rest/v1/rpc/x`), { method: "POST", body: "{}" });
    await f(new Request(`${SB}/auth/v1/user`));
    await f("https://cfoclose.com/plans");
    expect(seen[0].init).toMatchObject({ cache: "no-store", headers: { Authorization: "Bearer t" } });
    expect(seen[1].init).toMatchObject({ cache: "no-store", method: "POST", body: "{}" });
    expect(seen[2].req?.cache).toBe("no-store");
    expect(seen[3].init).toBeUndefined();
  });

  it("keeps a cache mode the caller chose explicitly", async () => {
    const base = vi.fn((_i: RequestInfo | URL, init?: RequestInit) => { expect(init?.cache).toBe("reload"); return ok(); });
    await withNoStore(base, SB)(`${SB}/rest/v1/x`, { cache: "reload" });
    expect(base).toHaveBeenCalledOnce();
  });

  it("installs once, only where the Fetch API supports a cache mode and a Supabase URL is configured", async () => {
    const calls: RequestInit[] = [];
    const target: Record<PropertyKey, unknown> & { fetch?: (i: RequestInfo | URL, init?: RequestInit) => Promise<Response> } = {
      fetch: (_i, init) => { calls.push(init ?? {}); return ok(); },
    };
    expect(installNoStoreFetch(target, undefined)).toBe(false);
    expect(installNoStoreFetch(target, SB)).toBe(true);
    const once = target.fetch;
    expect(installNoStoreFetch(target, SB)).toBe(true);
    expect(target.fetch).toBe(once); // not wrapped twice
    await target.fetch!(`${SB}/rest/v1/x`);
    expect(calls[0].cache).toBe("no-store");
  });

  it("covers the real supabase-js client: database, RPC, Functions and Auth requests all leave with cache: no-store", async () => {
    const inits: { url: string; cache?: RequestCache }[] = [];
    const target: Record<PropertyKey, unknown> & { fetch?: typeof fetch } = {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        inits.push({ url, cache: init?.cache ?? (input instanceof Request ? input.cache : undefined) });
        return url.includes("/auth/v1/") ? Promise.resolve(new Response(JSON.stringify({ message: "x" }), { status: 401 })) : ok();
      }) as typeof fetch,
    };
    installNoStoreFetch(target, SB);
    const realFetch = globalThis.fetch;
    globalThis.fetch = target.fetch!;
    try {
      const client = createClient(SB, "anon-key", { auth: { persistSession: false, autoRefreshToken: false } });
      await client.from("companies").select("id").limit(1);
      await client.rpc("get_public_plan_prices");
      await client.functions.invoke("commercial-payment-status", { body: {} });
      await client.auth.getUser("not-a-real-token");
    } finally { globalThis.fetch = realFetch; }
    const supa = inits.filter((r) => r.url.startsWith(SB));
    expect(supa.length).toBeGreaterThanOrEqual(4);
    expect(supa.map((r) => [new URL(r.url).pathname.split("/").slice(0, 3).join("/"), r.cache])).toEqual(
      expect.arrayContaining([["/rest/v1", "no-store"], ["/functions/v1", "no-store"], ["/auth/v1", "no-store"]]));
    expect(supa.every((r) => r.cache === "no-store")).toBe(true);
  });

  it("is the FIRST import of the app entry, before the app and the generated Supabase client", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../../main.tsx"), "utf8");
    expect(main.split("\n").find((l) => l.trim().startsWith("import"))).toBe('import "./lib/security/installNoStoreFetch";');
    const generated = fs.readFileSync(path.join(__dirname, "../../../integrations/supabase/client.ts"), "utf8");
    expect(generated).not.toContain("installNoStoreFetch"); // the Lovable-generated client stays untouched
  });
});

describe("auth transitions", () => {
  it("clears on sign-out and expiry, reloads on an account switch, and does nothing for sign-in or token refresh", () => {
    expect(decideAuthTransition(null, "INITIAL_SESSION", "u1")).toBe("none");
    expect(decideAuthTransition(null, "SIGNED_IN", "u1")).toBe("none");
    expect(decideAuthTransition("u1", "TOKEN_REFRESHED", "u1")).toBe("none");
    expect(decideAuthTransition("u1", "USER_UPDATED", "u1")).toBe("none");
    expect(decideAuthTransition("u1", "SIGNED_OUT", null)).toBe("clear");
    expect(decideAuthTransition("u1", "TOKEN_REFRESHED", null)).toBe("clear"); // a refresh that ends the session = expiry
    expect(decideAuthTransition("u1", "SIGNED_IN", "u2")).toBe("reload");
    expect(decideAuthTransition("u1", "INITIAL_SESSION", "u2")).toBe("reload");
  });

  it("clears the query cache and the user's sessionStorage keys, keeping the public pre-sign-in keys", () => {
    const qc = new QueryClient();
    qc.setQueryData(["statements", "company-a", 2025], { total: 14000 });
    sessionStorage.clear();
    sessionStorage.setItem("cfoclose:tb-draft-card:d1", '{"name":"Acme"}');
    sessionStorage.setItem("cfoclose.accountCorrection.v2.u1.up1.4001", "{}");
    sessionStorage.setItem("cfoclose:ipsas-presentation:u1:c1:2025", "{}");
    sessionStorage.setItem("cfoclose:team-company:u1", "c1");
    sessionStorage.setItem("cfoclose:qbo-sandbox:c1:2025", "owner");
    sessionStorage.setItem("cfoclose:service-intent:v1", '{"service":"tb"}');
    sessionStorage.setItem("cfoclose:selected-outcome:v1", "review");
    sessionStorage.setItem("cfoclose:enquiry-receipt:v1:contact", "{}");
    sessionStorage.setItem("cfoclose:enquiry-attempt:v1:contact", "{}");
    sessionStorage.setItem("other-library", "x");
    clearSensitiveClientState({ queryClient: qc, keyStore: sessionStorage });
    expect(qc.getQueryData(["statements", "company-a", 2025])).toBeUndefined();
    expect(Object.keys(sessionStorage).sort()).toEqual([
      "cfoclose:enquiry-attempt:v1:contact", "cfoclose:enquiry-receipt:v1:contact", "cfoclose:selected-outcome:v1", "cfoclose:service-intent:v1", "other-library",
    ]);
    expect(isSensitiveSessionKey("cfoclose:anything-new")).toBe(true); // a future user-scoped key is cleared by default
  });

  it("never throws when storage is unavailable", () => {
    const broken = { get length(): number { throw new Error("blocked"); }, key: () => null, removeItem: () => {} };
    expect(() => clearSensitiveClientState({ queryClient: null, keyStore: broken })).not.toThrow();
  });
});

describe("browser Back/Forward (bfcache)", () => {
  const pageshow = (persisted: boolean) => { const e = new Event("pageshow") as PageTransitionEvent; Object.defineProperty(e, "persisted", { value: persisted }); return e; };

  it("reloads a restored page when its user signed out or another user signed in, and leaves it when nothing changed", async () => {
    const reload = vi.fn();
    let current: string | null = "u1";
    const remove = installBfcacheGuard(window, () => "u1", async () => current, reload);
    window.dispatchEvent(pageshow(true)); await Promise.resolve(); await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    current = null;
    window.dispatchEvent(pageshow(true)); await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    current = "u2";
    window.dispatchEvent(pageshow(true)); await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(2);
    window.dispatchEvent(pageshow(false)); await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(2); // an ordinary load is not a restore
    remove();
    current = null;
    window.dispatchEvent(pageshow(true)); await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

// ── AuthProvider wiring (the real provider, with the Supabase client mocked) ──────────────────────────────────────────────────
type Listener = (event: string, session: { user: { id: string; email_confirmed_at?: string } } | null) => void;
const auth = vi.hoisted(() => ({ listener: null as null | ((e: string, s: unknown) => void), session: null as unknown, signOut: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: (e: string, s: unknown) => void) => { auth.listener = cb; return { data: { subscription: { unsubscribe: () => {} } } }; },
      getSession: () => Promise.resolve({ data: { session: auth.session } }),
      signOut: auth.signOut,
    },
  },
}));
vi.mock("@/hooks/useAuthAudit", () => ({ useAuthAudit: () => {} }));

describe("AuthProvider applies the controls", () => {
  let reload: ReturnType<typeof vi.fn>;
  const original = window.location;
  beforeEach(() => {
    reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } });
    sessionStorage.clear();
  });
  afterEach(() => { Object.defineProperty(window, "location", { configurable: true, value: original }); });

  async function mountProvider(qc: QueryClient) {
    const { AuthProvider, useAuth } = await import("@/contexts/AuthContext");
    const { mount } = await import("@/lib/workbench/testkit/dom");
    let api!: ReturnType<typeof useAuth>;
    function Probe() { api = useAuth(); return h("span", { "data-testid": "who" }, api.user?.id ?? "nobody"); }
    const ui = mount(h(QueryClientProvider, { client: qc }, h(AuthProvider, null, h(Probe))));
    await act(async () => { await Promise.resolve(); });
    return { ui, api: () => api, who: () => ui.container.querySelector('[data-testid="who"]')?.textContent };
  }
  const emit = async (event: string, id: string | null) => { await act(async () => { (auth.listener as Listener)(event, id ? { user: { id } } : null); }); };

  it("sign-out and session expiry: the previous user's cached financial data is gone and cannot be read afterwards", async () => {
    auth.session = { user: { id: "u1" } };
    const qc = new QueryClient();
    const m = await mountProvider(qc);
    await emit("SIGNED_IN", "u1");
    qc.setQueryData(["trial-balance", "company-a"], { debit: 100, credit: 100 });
    sessionStorage.setItem("cfoclose:tb-draft-card:d1", "{}");
    await emit("SIGNED_OUT", null);
    expect(qc.getQueryData(["trial-balance", "company-a"])).toBeUndefined();
    expect(sessionStorage.getItem("cfoclose:tb-draft-card:d1")).toBeNull();
    expect(m.who()).toBe("nobody");
    expect(reload).not.toHaveBeenCalled();
    m.ui.unmount();
  });

  it("explicit signOut() clears even if no SIGNED_OUT event arrives", async () => {
    auth.session = { user: { id: "u1" } };
    const qc = new QueryClient();
    const m = await mountProvider(qc);
    qc.setQueryData(["statements"], { ok: true });
    await act(async () => { await m.api().signOut(); });
    expect(auth.signOut).toHaveBeenCalled();
    expect(qc.getQueryData(["statements"])).toBeUndefined();
    m.ui.unmount();
  });

  it("account switch: another user signing in reloads the page instead of showing the previous user's data", async () => {
    auth.session = { user: { id: "u1" } };
    const qc = new QueryClient();
    const m = await mountProvider(qc);
    qc.setQueryData(["companies"], [{ id: "company-of-u1" }]);
    await emit("SIGNED_IN", "u2");
    expect(qc.getQueryData(["companies"])).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
    m.ui.unmount();
  });

  it("token refresh and re-sign-in of the same user keep the session's data (no needless clearing)", async () => {
    auth.session = { user: { id: "u1" } };
    const qc = new QueryClient();
    const m = await mountProvider(qc);
    qc.setQueryData(["companies"], [{ id: "c1" }]);
    await emit("TOKEN_REFRESHED", "u1");
    await emit("SIGNED_IN", "u1");
    expect(qc.getQueryData(["companies"])).toEqual([{ id: "c1" }]);
    expect(reload).not.toHaveBeenCalled();
    m.ui.unmount();
  });
});
