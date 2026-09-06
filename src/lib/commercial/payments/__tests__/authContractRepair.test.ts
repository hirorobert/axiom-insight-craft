/**
 * Ω∞ Ω2 Auth Contract Repair — focused tests.
 *
 * Root cause: commercial-create-checkout and commercial-payment-status both
 * called `validateAuth(req)` — passing the Request object itself — against
 * the REAL contract in _shared/auth.ts:
 *
 *   validateAuth(authHeader: string | null, corsHeaders: Record<string,string>)
 *     -> Promise<{ result?: { userId: string; email?: string }; error?: Response }>
 *
 * `req.startsWith` does not exist, so `authHeader?.startsWith("Bearer ")`
 * inside validateAuth() threw a TypeError for every call — but both edge
 * functions wrapped validateAuth in a try/catch that swallowed this into a
 * generic, CORS-less 401, misreporting every request (valid or not) as
 * "Unauthorized" with no diagnostic trail.
 *
 * A second defect surfaced while verifying "valid JWT -> status path
 * proceeds" for commercial-payment-status: get_checkout_status() is
 * SECURITY DEFINER but scopes ITSELF via auth.uid() internally and is
 * GRANTed to `authenticated` only (never `service_role`). Calling it from a
 * service-role client (as the file did) leaves auth.uid() NULL inside
 * Postgres, so the owner-scoping WHERE clause never matches — every
 * legitimate caller would see "not found" forever, not just unauthenticated
 * ones. The fix forwards the caller's own JWT (anon key + their bearer
 * token), the same idiom _shared/auth.ts's own validateAuth() already uses
 * internally to verify that JWT.
 *
 * NON-EXECUTABLE DENO NOTICE: no live Deno runtime exists in this
 * environment, and _shared/auth.ts imports from a remote esm.sh URL that
 * Vitest/Node cannot resolve — so, as with every other Deno Edge Function
 * in this repository (webhookEvidenceModel.test.ts, marketPropagation.
 * test.ts), this file proves the fix via static source-text regression
 * guards, not execution.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const AUTH_SHARED_PATH = path.join(
  __dirname,
  "../../../../../supabase/functions/_shared/auth.ts",
);
const CREATE_CHECKOUT_PATH = path.join(
  __dirname,
  "../../../../../supabase/functions/commercial-create-checkout/index.ts",
);
const PAYMENT_STATUS_PATH = path.join(
  __dirname,
  "../../../../../supabase/functions/commercial-payment-status/index.ts",
);

function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const authSharedSrc = fs.readFileSync(AUTH_SHARED_PATH, "utf-8");
const createCheckoutSrc = fs.readFileSync(CREATE_CHECKOUT_PATH, "utf-8");
const createCheckoutCode = stripTsComments(createCheckoutSrc);
const paymentStatusSrc = fs.readFileSync(PAYMENT_STATUS_PATH, "utf-8");
const paymentStatusCode = stripTsComments(paymentStatusSrc);

describe("1. Verify contract — _shared/auth.ts's real, live signature (not assumed)", () => {
  it("validateAuth takes (authHeader: string | null, corsHeaders), not a Request", () => {
    expect(authSharedSrc).toMatch(
      /export async function validateAuth\(\s*authHeader: string \| null,\s*corsHeaders: Record<string, string>\s*\): Promise<\{ result\?: AuthResult; error\?: Response \}>/,
    );
  });

  it("AuthResult is { userId: string; email?: string } — no firmMemberId, no `user` object", () => {
    expect(authSharedSrc).toMatch(/export interface AuthResult \{\s*userId: string;\s*email\?: string;\s*\}/);
  });

  it("a missing/malformed Authorization header is rejected before any Supabase call is made", () => {
    const fn = authSharedSrc.match(/export async function validateAuth\([\s\S]*?\n\}/)?.[0] ?? "";
    const headerCheck = fn.match(/if \(!authHeader\?\.startsWith\("Bearer "\)\) \{([\s\S]*?)\n {2}\}/)?.[0] ?? "";
    expect(headerCheck).toMatch(/status: 401/);
    const headerCheckIndex = fn.indexOf(headerCheck);
    const clientCreationIndex = fn.indexOf("createClient(");
    expect(headerCheckIndex).toBeGreaterThan(-1);
    expect(headerCheckIndex).toBeLessThan(clientCreationIndex);
  });

  it("a malformed JWT (wrong dot-segment count) is rejected before any Supabase call is made", () => {
    const fn = authSharedSrc.match(/export async function validateAuth\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/token\.split\("\."\)\.length !== 3/);
  });
});

describe.each([
  ["commercial-create-checkout", () => createCheckoutSrc, () => createCheckoutCode],
  ["commercial-payment-status", () => paymentStatusSrc, () => paymentStatusCode],
])("%s — auth-helper integration repaired", (_name, getSrc, getCode) => {
  it("never passes the Request object into validateAuth", () => {
    const code = getCode();
    expect(code).not.toMatch(/validateAuth\(req\)/);
  });

  it("extracts the Authorization header explicitly via req.headers.get('Authorization')", () => {
    const code = getCode();
    expect(code).toMatch(/const authHeader = req\.headers\.get\('Authorization'\);/);
  });

  it("calls validateAuth with (authHeader, CORS_HEADERS) — the real two-argument contract", () => {
    const code = getCode();
    expect(code).toMatch(/validateAuth\(authHeader, CORS_HEADERS\)/);
  });

  it("consumes the real { result, error } return shape, not a bare object", () => {
    const code = getCode();
    expect(code).toMatch(/const \{ result: authResult, error: authError \} = await validateAuth\(authHeader, CORS_HEADERS\);/);
  });

  it("fails closed (401) on either an explicit error OR a missing result — never proceeds on a falsy-but-not-technically-error result", () => {
    const code = getCode();
    expect(code).toMatch(/if \(authError \|\| !authResult\) \{/);
  });

  it("the 401 response includes the CORS headers", () => {
    const src = getSrc();
    const authFailBlock = src.match(/if \(authError \|\| !authResult\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(authFailBlock).toMatch(/status: 401/);
    expect(authFailBlock).toMatch(/\.\.\.CORS_HEADERS/);
  });

  it("the 401 response preserves the request's own correlationId", () => {
    const src = getSrc();
    const authFailBlock = src.match(/if \(authError \|\| !authResult\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(authFailBlock).toMatch(/correlationId/);
  });

  it("no old try/catch-around-validateAuth pattern remains (the exact shape that swallowed the TypeError into a bare 401)", () => {
    const code = getCode();
    expect(code).not.toMatch(/try \{\s*await validateAuth\(req\);\s*\} catch/);
    expect(code).not.toMatch(/authResult = await validateAuth\(req\);/);
  });
});

describe("commercial-create-checkout — provider never reached on auth failure", () => {
  it("the auth check (validateAuth call) appears before offer resolution, provider routing, and the Flutterwave adapter call", () => {
    const authCallIndex = createCheckoutCode.indexOf("validateAuth(authHeader, CORS_HEADERS)");
    const resolveOfferIndex = createCheckoutCode.indexOf("resolve_commercial_offer");
    const providerRoutingIndex = createCheckoutCode.indexOf("selectPaymentProvider(");
    const adapterCallIndex = createCheckoutCode.indexOf("adapter.createCheckout(");
    expect(authCallIndex).toBeGreaterThan(-1);
    expect(authCallIndex).toBeLessThan(resolveOfferIndex);
    expect(authCallIndex).toBeLessThan(providerRoutingIndex);
    expect(authCallIndex).toBeLessThan(adapterCallIndex);
  });

  it("the 401 return statement is a genuine early return — no code path falls through to `user` before it", () => {
    const userDeclIndex = createCheckoutCode.indexOf("const user = { id: authResult.userId, email: authResult.email };");
    const authFailReturnIndex = createCheckoutCode.indexOf("return new Response(JSON.stringify({ error: 'Unauthorized', correlationId }), {");
    expect(authFailReturnIndex).toBeGreaterThan(-1);
    expect(authFailReturnIndex).toBeLessThan(userDeclIndex);
  });
});

describe("commercial-payment-status — genuine owner-scoping, no cross-customer leakage", () => {
  it("no longer creates the RPC client with the service-role key", () => {
    expect(paymentStatusCode).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(paymentStatusCode).not.toMatch(/SERVICE_KEY/);
  });

  it("creates the RPC client with the anon key and forwards the caller's own bearer token — preserving auth.uid() inside get_checkout_status", () => {
    expect(paymentStatusCode).toMatch(/createClient\(SUPABASE_URL, SUPABASE_ANON_KEY, \{\s*global: \{ headers: \{ Authorization: authHeader! \} \},\s*\}\)/);
  });

  it("the RPC client is constructed only AFTER the auth check — it can never be built from an unverified/absent Authorization header", () => {
    const authCheckIndex = paymentStatusCode.indexOf("if (authError || !authResult)");
    const clientIndex = paymentStatusCode.indexOf("createClient(SUPABASE_URL, SUPABASE_ANON_KEY");
    expect(authCheckIndex).toBeGreaterThan(-1);
    expect(clientIndex).toBeGreaterThan(-1);
    expect(authCheckIndex).toBeLessThan(clientIndex);
  });

  it("get_checkout_status is called with only the saff_reference — no owner/user id is ever passed from the browser; ownership is enforced server-side via the caller's own JWT", () => {
    const rpcCall = paymentStatusCode.match(/supabase\.rpc\('get_checkout_status', \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(rpcCall.trim()).toBe("p_saff_reference: saffReference,");
  });
});

describe("payment firewall — zero semantic change outside the auth-helper integration", () => {
  it("commercial-create-checkout still resolves the offer via resolve_commercial_offer and routes via selectPaymentProvider — unchanged pricing/routing authority", () => {
    expect(createCheckoutCode).toMatch(/supabase\.rpc\('resolve_commercial_offer', \{/);
    expect(createCheckoutCode).toMatch(/selectPaymentProvider\(/);
  });

  it("commercial-create-checkout still snapshots offer economics into payment_checkout_intents unchanged", () => {
    expect(createCheckoutCode).toMatch(/\.from\('payment_checkout_intents'\)\s*\n\s*\.insert\(\{/);
    expect(createCheckoutCode).toMatch(/expected_amount_minor:\s*offer\.amount_minor,/);
  });

  it("neither file references the webhook, Gate A/B verification, commit_verified_commercial_payment, licence, or entitlement authority", () => {
    for (const code of [createCheckoutCode, paymentStatusCode]) {
      expect(code).not.toMatch(/verifyWebhookAuthenticity|verifyTransaction|commit_verified_commercial_payment|commercial_licences|entitlement/i);
    }
  });

  it("neither file requires commercial_admin — both remain ordinary-customer entry points", () => {
    for (const code of [createCheckoutCode, paymentStatusCode]) {
      expect(code).not.toMatch(/commercial_admin|is_commercial_admin/i);
    }
  });
});
