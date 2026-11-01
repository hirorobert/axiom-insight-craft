import { describe, expect, it, vi } from "vitest";
import { createQboTokenClient } from "../../../supabase/functions/_shared/qboTokenClient";
import { createGuardedQboFetch, QBO_TOKEN_URL } from "../../../supabase/functions/_shared/qboReadOnlyGuard";

// Invented values only: none of these is a real client id, secret, code or token.
const CREDS = { clientId: "ABtestclientidtestclientidtestclientid00", clientSecret: "test-secret-not-real-0001" };
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const OK_BODY = { token_type: "bearer", access_token: "access-not-real", refresh_token: "refresh-not-real", expires_in: 3600, x_refresh_token_expires_in: 8640000, x_refresh_token_hard_expires_in: 157680000 };
const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function client(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  const raw = vi.fn(async (url: string, init: Record<string, unknown>) => { calls.push({ url, init }); return respond(); });
  const c = createQboTokenClient(createGuardedQboFetch(raw as never), CREDS, () => NOW);
  return { c, calls, raw };
}

describe("authorisation code exchange", () => {
  it("posts the exact request the documentation describes, through the guard", async () => {
    const { c, calls } = client(() => reply(200, OK_BODY));
    await c.exchangeCode("code-not-real", "https://app.example.test/cb");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(QBO_TOKEN_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${btoa(`${CREDS.clientId}:${CREDS.clientSecret}`)}`);
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(h["x-include-refresh-token-hard-expires-in"]).toBe("true");
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body as string))).toEqual({ grant_type: "authorization_code", code: "code-not-real", redirect_uri: "https://app.example.test/cb" });
  });
  it("returns the tokens and the lifetimes as absolute times (rolling refresh expiry, five-year ceiling)", async () => {
    const { c } = client(() => reply(200, OK_BODY));
    const r = await c.exchangeCode("code-not-real", "https://app.example.test/cb");
    expect(r).toEqual({ ok: true, tokens: { accessToken: "access-not-real", refreshToken: "refresh-not-real", accessExpiresInSeconds: 3600,
      refreshExpiresAt: new Date(NOW + 8640000 * 1000).toISOString(), hardExpiresAt: new Date(NOW + 157680000 * 1000).toISOString() } });
  });
  it("reports a missing ceiling as null rather than inventing one", async () => {
    const { c } = client(() => reply(200, { ...OK_BODY, x_refresh_token_hard_expires_in: undefined }));
    const r = await c.exchangeCode("code-not-real", "https://app.example.test/cb");
    expect(r.ok && r.tokens.hardExpiresAt).toBe(null);
  });
});

describe("refresh", () => {
  it("posts grant_type=refresh_token with the stored token", async () => {
    const { c, calls } = client(() => reply(200, OK_BODY));
    const r = await c.refresh("old-refresh-not-real");
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body as string))).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh-not-real" });
  });
});

describe("failures are classified and never leak", () => {
  it.each<[string, () => Response | Promise<Response>, string]>([
    ["invalid_grant (the user must reconnect)", () => reply(400, { error: "invalid_grant" }), "invalid_grant"],
    ["another 400", () => reply(400, { error: "invalid_client" }), "rejected"],
    ["a 401", () => reply(401, { error: "invalid_client" }), "rejected"],
    ["a 500", () => reply(500, "boom"), "unavailable"],
    ["a 503", () => reply(503, { error: "x" }), "unavailable"],
    ["a network failure", () => { throw new Error("network down with secret test-secret-not-real-0001"); }, "unavailable"],
    ["a 200 that is not JSON", () => reply(200, "<html>"), "rejected"],
    ["a 200 with the wrong token type", () => reply(200, { ...OK_BODY, token_type: "mac" }), "rejected"],
    ["a 200 without an access token", () => reply(200, { ...OK_BODY, access_token: "" }), "rejected"],
    ["a 200 with a refresh token that has whitespace", () => reply(200, { ...OK_BODY, refresh_token: "a b" }), "rejected"],
    ["a 200 with a non-positive lifetime", () => reply(200, { ...OK_BODY, expires_in: 0 }), "rejected"],
    ["a 200 with a refresh lifetime that is a string", () => reply(200, { ...OK_BODY, x_refresh_token_expires_in: "8640000" }), "rejected"],
  ])("%s -> %s", async (_label, respond, reason) => {
    const { c } = client(respond);
    const r = await c.refresh("old-refresh-not-real");
    expect(r).toEqual({ ok: false, reason });
    expect(JSON.stringify(r)).not.toMatch(/secret|refresh-not-real|access-not-real/);
  });

  it("refuses an empty or malformed code or refresh token before any network call", async () => {
    const { c, raw } = client(() => reply(200, OK_BODY));
    expect(await c.exchangeCode("", "https://app.example.test/cb")).toEqual({ ok: false, reason: "rejected" });
    expect(await c.exchangeCode("has space", "https://app.example.test/cb")).toEqual({ ok: false, reason: "rejected" });
    expect(await c.refresh("x".repeat(513))).toEqual({ ok: false, reason: "rejected" });
    expect(raw).not.toHaveBeenCalled();
  });
});
