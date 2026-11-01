/**
 * qboTokenClient — the two token calls of the QuickBooks Online authorisation-code flow, through the read-only guard's fetch
 * (supabase/functions/_shared/qboReadOnlyGuard.ts; the guard allows a POST to the token address and nothing else on that host):
 *
 *   exchangeCode   authorisation code -> access token + refresh token (+ their lifetimes)
 *   refresh        refresh token      -> access token + the newest refresh token
 *
 * Intuit's lifetimes (documentation read 2026-10-31): access token 3,600 s; refresh token rolling 100 days, "always store the latest
 * refresh_token"; five-year hard limit (returned only when the request asks for it, which this client always does).
 *
 * Pure apart from the injected fetch and clock. It never logs, never puts a token, code, secret or response body in an error, and
 * classifies every failure into three reasons the caller can act on: invalid_grant (the user must reconnect), rejected (a request
 * Intuit refused for another reason) and unavailable (a network or server problem; safe to retry).
 */
import { QBO_TOKEN_URL, type GuardedRequest } from "./qboReadOnlyGuard.ts";

export interface QboClientCredentials { clientId: string; clientSecret: string }

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresInSeconds: number;
  /** When the refresh token stops working unless it is used again (rolling). */
  refreshExpiresAt: string;
  /** The five-year ceiling, or null if Intuit did not state it. */
  hardExpiresAt: string | null;
}

export type TokenFailure = "invalid_grant" | "rejected" | "unavailable";
export type TokenResult = { ok: true; tokens: QboTokens } | { ok: false; reason: TokenFailure };

type GuardedFetch = (req: GuardedRequest) => Promise<Response>;

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e10;
const token = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/\s/.test(v);

export function createQboTokenClient(guardedFetch: GuardedFetch, creds: QboClientCredentials, now: () => number = Date.now) {
  const basic = `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`;

  async function call(form: Record<string, string>): Promise<TokenResult> {
    let res: Response;
    try {
      res = await guardedFetch({
        method: "POST",
        url: QBO_TOKEN_URL,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: basic,
          "x-include-refresh-token-hard-expires-in": "true",
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.status >= 500) return { ok: false, reason: "unavailable" };
    if (res.status !== 200) {
      const err = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
      return { ok: false, reason: err === "invalid_grant" ? "invalid_grant" : "rejected" };
    }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    if (String(b.token_type).toLowerCase() !== "bearer" || !token(b.access_token, 4096) || !token(b.refresh_token, 512)
        || !positiveInt(b.expires_in) || !positiveInt(b.x_refresh_token_expires_in)) {
      return { ok: false, reason: "rejected" };
    }
    const t = now();
    return {
      ok: true,
      tokens: {
        accessToken: b.access_token,
        refreshToken: b.refresh_token,
        accessExpiresInSeconds: b.expires_in,
        refreshExpiresAt: new Date(t + b.x_refresh_token_expires_in * 1000).toISOString(),
        hardExpiresAt: positiveInt(b.x_refresh_token_hard_expires_in) ? new Date(t + b.x_refresh_token_hard_expires_in * 1000).toISOString() : null,
      },
    };
  }

  return {
    exchangeCode: (code: string, redirectUri: string): Promise<TokenResult> =>
      !token(code, 512) ? Promise.resolve({ ok: false, reason: "rejected" }) : call({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken: string): Promise<TokenResult> =>
      !token(refreshToken, 512) ? Promise.resolve({ ok: false, reason: "rejected" }) : call({ grant_type: "refresh_token", refresh_token: refreshToken }),
  };
}
