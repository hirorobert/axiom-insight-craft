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
    // Ω∞ A+ closure: both functions now build every JSON response through a
    // shared jsonResponse(body, status) helper whose headers always spread
    // ...CORS_HEADERS — proven once at the helper definition, which every
    // 401 (and every other) response goes through, rather than requiring
    // each call site to repeat the spread inline.
    const src = getSrc();
    const helperMatch = src.match(/function jsonResponse\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(helperMatch).toMatch(/\.\.\.CORS_HEADERS/);
    expect(getCode()).toMatch(/return jsonResponse\(\{ error: 'Unauthorized', correlationId \}, 401\)/);
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
    const authFailReturnIndex = createCheckoutCode.indexOf("return jsonResponse({ error: 'Unauthorized', correlationId }, 401);");
    expect(authFailReturnIndex).toBeGreaterThan(-1);
    expect(authFailReturnIndex).toBeLessThan(userDeclIndex);
  });
});

describe("commercial-payment-status — genuine owner-scoping, no cross-customer leakage", () => {
  // Ω∞ A+ closure HIGH-1: GET and POST are now separate contracts.
  // get_checkout_status (the ownership-proving read) is used by BOTH, via
  // the SAME anon-key + caller's-own-JWT client (`readClient`). A
  // service-role client (`serviceClient`) exists only inside the POST
  // branch, and only for two RPCs: claim_verification_attempt (the durable
  // throttle claim) and commit_verified_commercial_payment (the actual
  // commit) — never for the ownership-proving read itself.
  it("get_checkout_status is called via the anon-key + caller's-own-JWT client (readClient), never the service-role client", () => {
    const readClientBlock = paymentStatusCode.match(/const readClient = createClient\(SUPABASE_URL, SUPABASE_ANON_KEY, \{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(readClientBlock).toMatch(/SUPABASE_ANON_KEY/);
    expect(readClientBlock).not.toMatch(/SERVICE_KEY/);
    expect(paymentStatusCode).toMatch(/readClient\.rpc\('get_checkout_status'/);
  });

  it("GET returns immediately after the ownership-proving read — no provider call, no RPC other than get_checkout_status, on the GET path", () => {
    const getBranch = paymentStatusCode.match(/if \(req\.method === 'GET'\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(getBranch).not.toMatch(/serviceClient|adapterFor|verifyTransactionByReference/);
    expect(getBranch).toMatch(/return jsonResponse/);
  });

  it("the service-role client is constructed only inside the POST branch, strictly after the ownership-proving anon-key client, and is used for exactly claim_verification_attempt and commit_verified_commercial_payment — nothing else", () => {
    const readClientIndex = paymentStatusCode.indexOf("createClient(SUPABASE_URL, SUPABASE_ANON_KEY");
    const serviceClientIndex = paymentStatusCode.indexOf("createClient(SUPABASE_URL, SERVICE_KEY)");
    expect(readClientIndex).toBeGreaterThan(-1);
    expect(serviceClientIndex).toBeGreaterThan(-1);
    expect(readClientIndex).toBeLessThan(serviceClientIndex);

    const serviceClientToEnd = paymentStatusCode.slice(serviceClientIndex);
    const rpcCallsAfter = serviceClientToEnd.match(/serviceClient\.rpc\(/g) ?? [];
    expect(rpcCallsAfter.length).toBe(2);
    expect(serviceClientToEnd).toMatch(/serviceClient\.rpc\('claim_verification_attempt'/);
    expect(serviceClientToEnd).toMatch(/serviceClient\.rpc\('commit_verified_commercial_payment'/);
  });

  it("a verification/commit attempt can only ever be reached via a successful claim_verification_attempt claim — the durable server-side throttle authority, never an in-process check", () => {
    expect(paymentStatusCode).toMatch(/claim_verification_attempt/);
    expect(paymentStatusCode).not.toMatch(/setTimeout|setInterval|Map\(\)|new Map</);
    const claimBranch = paymentStatusCode.match(/if \(!claim\.claimed\) \{([\s\S]*?)\n {2}\}/)?.[0] ?? "";
    expect(claimBranch).toMatch(/202/);
    expect(claimBranch).toMatch(/Retry-After/);
  });

  it("the claimed-verification branch is wrapped so its own failure can never break the underlying successful read this endpoint already produced", () => {
    expect(paymentStatusCode).toMatch(/try \{[\s\S]*?verifyTransactionByReference[\s\S]*?\} catch \(fallbackErr\)/);
  });

  it("readClient forwards the caller's own bearer token — preserving auth.uid() inside get_checkout_status", () => {
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
    const rpcCalls = [...paymentStatusCode.matchAll(/\.rpc\('get_checkout_status', \{([\s\S]*?)\}\)/g)];
    expect(rpcCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of rpcCalls) {
      expect(call[1].trim().replace(/,$/, "")).toBe("p_saff_reference: saffReference");
    }
  });

  it("claim_verification_attempt is called with the caller's own authenticated user id (authResult.userId), proving ownership server-side — never a browser-supplied owner id", () => {
    const rpcCall = paymentStatusCode.match(/serviceClient\.rpc\('claim_verification_attempt', \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(rpcCall).toMatch(/p_requesting_user_id:\s*authResult\.userId/);
  });
});

describe("payment firewall — zero semantic change outside the auth-helper integration", () => {
  it("commercial-create-checkout still resolves the offer via resolve_commercial_offer and routes via selectPaymentProvider — unchanged pricing/routing authority", () => {
    expect(createCheckoutCode).toMatch(/supabase\.rpc\('resolve_commercial_offer', \{/);
    expect(createCheckoutCode).toMatch(/selectPaymentProvider\(/);
  });

  it("commercial-create-checkout still snapshots offer economics into the checkout intent unchanged — now via acquire_checkout_attempt's RPC arguments rather than a raw table insert, since the atomic acquisition boundary (Ω∞ A+ closure BLOCKER-2) moved that INSERT into a DB-authoritative RPC", () => {
    const rpcCall = createCheckoutCode.match(/supabase\.rpc\('acquire_checkout_attempt', \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(rpcCall).toMatch(/p_amount_minor:\s*offer\.amount_minor,/);
    expect(rpcCall).toMatch(/p_currency_code:\s*offer\.currency_code,/);
    expect(rpcCall).toMatch(/p_market_code:\s*offer\.market_code,/);
  });

  it("commercial-create-checkout never references webhook/Gate-B verification, commit_verified_commercial_payment, licence, or entitlement authority — it only ever acquires/persists an intent, never commits one", () => {
    expect(createCheckoutCode).not.toMatch(/verifyWebhookAuthenticity|verifyTransaction|commit_verified_commercial_payment|commercial_licences|entitlement/i);
  });

  it("commercial-payment-status (Ω3-CHECKOUT correction) DOES now reference verifyTransactionByReference and commit_verified_commercial_payment — the intentional independent verify+commit fallback for a lost/delayed webhook — but still never references Gate A webhook-signature verification or entitlement resolution, which remain the webhook's and get_effective_entitlement's own exclusive concerns", () => {
    expect(paymentStatusCode).toMatch(/verifyTransactionByReference/);
    expect(paymentStatusCode).toMatch(/commit_verified_commercial_payment/);
    expect(paymentStatusCode).not.toMatch(/verifyWebhookAuthenticity/i);
    expect(paymentStatusCode).not.toMatch(/entitlement/i);
  });

  it("neither file requires commercial_admin — both remain ordinary-customer entry points", () => {
    for (const code of [createCheckoutCode, paymentStatusCode]) {
      expect(code).not.toMatch(/commercial_admin|is_commercial_admin/i);
    }
  });
});
