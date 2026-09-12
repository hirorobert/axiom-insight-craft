import { supabase } from "@/integrations/supabase/client";
import type { PostgrestError } from "@supabase/supabase-js";
import type { LicenceStatus } from "./entitlementContract";

/**
 * Ω1 — narrow, single-boundary typed adapter for commercial RPC calls.
 *
 * `src/integrations/supabase/types.ts` is generated from the live database
 * schema and cannot be regenerated in this environment without live DB
 * access (migration 20260904180000_commercial_foundation_wave_omega1.sql is
 * CREATED_NOT_APPLIED — see CLAUDE.md §11). That means the generated
 * `Database["public"]["Functions"]` union does not yet know these RPCs
 * exist, and `supabase.rpc(name, args)` cannot be called with full inference
 * for them today.
 *
 * Rather than scatter `supabase.rpc("name" as never, ...)` (or `as any`)
 * across every call site — which throws away type information for the
 * ARGUMENTS and RETURN VALUE too, not just the function name — every
 * Ω1 commercial RPC call goes through `callCommercialRpc()` below. It is
 * the SOLE cast boundary in this module: the cast is scoped to the client's
 * `rpc` method signature only, and every function's argument and return
 * shape is fully and explicitly typed in `CommercialRpcSignature`, hand-
 * verified against the SQL definitions in the Ω1 migration. Nothing
 * downstream of a `callCommercialRpc()` call is untyped.
 *
 * Once the migration is applied and `types.ts` is regenerated, delete this
 * module's cast (the `as CommercialRpcClient` line) and pass `supabase`
 * directly — every call site's types are already correct and need no
 * further changes.
 */

export interface CommercialRpcSignature {
  get_my_billing_summary: {
    args: Record<string, never>;
    returns: {
      has_billing_customer: boolean;
      plan_code: string | null;
      licence_status: LicenceStatus | null;
      effective_start: string | null;
      effective_end: string | null;
      entitlements: string[];
      /** Ω3-CHECKOUT: the current licence's originating checkout interval, when one exists (NULL for FREE/admin-granted licences). */
      billing_interval: "MONTHLY" | "ANNUAL" | null;
      billing_interval_count: number | null;
    };
  };
  get_effective_entitlement: {
    args: { p_company_id: string; p_feature_code: string };
    returns: {
      status: "ENTITLED" | "NOT_ENTITLED" | "UNKNOWN";
      reason: string;
      licence_status: LicenceStatus | null;
      plan_code: string | null;
      source: "ACTIVE_LICENCE" | "ADMIN_OVERRIDE" | null;
    };
  };
  resolve_commercial_offer: {
    /**
     * Ω3-CHECKOUT: p_billing_interval is MANDATORY — never omitted, never
     * defaulted client-side. The Ω3-CHECKOUT trust boundary is exactly
     * { planCode, billingInterval } as the only economics-adjacent input
     * the browser may ever supply; everything else is server-resolved.
     */
    args: { p_plan_code: string; p_billing_interval: "MONTHLY" | "ANNUAL"; p_market_code?: string };
    returns: {
      resolution: "AVAILABLE" | "NOT_AVAILABLE" | "AMBIGUOUS" | "UNKNOWN";
      offer_id?: string;
      offer_code?: string;
      plan_id?: string;
      plan_code?: string;
      market_code?: string;
      requested_market?: string;
      fallback_to_global?: boolean;
      currency_code?: string;
      amount_minor?: number;
      currency_exponent?: number;
      billing_interval?: string;
      billing_interval_count?: number;
      provider_restriction?: string | null;
      reason?: string;
    };
  };
  admin_list_commercial_offers: {
    args: { p_plan_code?: string };
    returns: Array<{
      id: string; offer_code: string; plan_code: string; plan_id: string;
      market_code: string; currency_code: string; amount_minor: number;
      currency_exponent: number; billing_interval: string; billing_interval_count: number;
      is_active: boolean; is_purchasable: boolean;
      effective_start: string; effective_end: string | null;
    }>;
  };
  admin_upsert_commercial_offer: {
    args: {
      p_offer_code: string; p_plan_code: string; p_market_code: string;
      p_currency_code: string; p_amount_minor: number; p_currency_exponent: number;
      p_billing_interval: string; p_billing_interval_count: number;
      p_is_active: boolean; p_is_purchasable: boolean; p_reason: string;
      /** Ω3-CHECKOUT: product-scoped plan lookup. Defaults to 'CFOCLOSE' server-side if omitted. */
      p_product_code?: string;
    };
    returns: { offer_id: string; offer_code: string };
  };
}

type CommercialRpcName = keyof CommercialRpcSignature;

interface CommercialRpcClient {
  rpc: <N extends CommercialRpcName>(
    name: N,
    args?: CommercialRpcSignature[N]["args"],
  ) => Promise<{ data: CommercialRpcSignature[N]["returns"] | null; error: PostgrestError | null }>;
}

export async function callCommercialRpc<N extends CommercialRpcName>(
  name: N,
  ...args: CommercialRpcSignature[N]["args"] extends Record<string, never> ? [] : [CommercialRpcSignature[N]["args"]]
): Promise<{ data: CommercialRpcSignature[N]["returns"] | null; error: PostgrestError | null }> {
  // Sole cast boundary — see module doc comment above for why this is
  // necessary and why it does not weaken typing anywhere else.
  const client = supabase as unknown as CommercialRpcClient;
  return client.rpc(name, args[0]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ω2 — real payment RPC signatures appended to the adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckoutIntentResponse {
  saffReference: string;
  checkoutUrl: string;
  expiresAt: string;
  provider: string;
}

export interface CheckoutStatusResponse {
  found: boolean;
  status: string | null;
  planCode: string | null;
  licenceStatus: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  correlationId: string;
}

/** Raw (snake_case) shape actually returned by get_checkout_status() via the Edge Function. */
interface RawCheckoutStatusResponse {
  found: boolean;
  status?: string;
  plan_code?: string | null;
  licence_status?: string | null;
  effective_start?: string | null;
  effective_end?: string | null;
  correlationId: string;
}

/**
 * Call the commercial-create-checkout Edge Function.
 * Browser sends ONLY a plan code and a MANDATORY billing interval (MONTHLY
 * or ANNUAL) — nothing else. The Ω3-CHECKOUT trust boundary is exactly
 * these two fields; market is NOT accepted here even optionally — the
 * server always resolves against GLOBAL (this launch's frozen, server-
 * owned market decision), and the Edge Function itself ignores any
 * marketCode field a caller might still send directly via the HTTP API.
 * The server independently resolves the actual commercial offer (plan +
 * interval + market + currency + price) via resolve_commercial_offer();
 * it never trusts a browser-supplied amount, currency, or market. Never
 * accepted: price, amount, currency, market, paid=true, any provider
 * secret.
 */
export async function createCheckoutIntent(
  planCode: string,
  billingInterval: "MONTHLY" | "ANNUAL",
): Promise<{ data: CheckoutIntentResponse | null; error: string | null }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, error: "Not authenticated" };

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/commercial-create-checkout`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ planCode, billingInterval }),
    },
  );
  const json = await res.json();
  if (!res.ok) return { data: null, error: json?.error ?? "Checkout failed" };
  return { data: json as CheckoutIntentResponse, error: null };
}

/**
 * Poll the commercial-payment-status Edge Function via GET.
 * Owner-scoped — only the user who created the intent can read it.
 * Ω∞ A+ closure HIGH-1: GET is now READ-ONLY on the server — it never
 * triggers provider verification or a commit. Safe to call at any
 * frequency. Maps the RPC's snake_case response onto the camelCase
 * contract PaymentReturn.tsx expects — this is the SOLE translation
 * boundary, so get_checkout_status() itself can stay in natural Postgres
 * snake_case.
 */
export async function pollCheckoutStatus(
  saffReference: string,
): Promise<{ data: CheckoutStatusResponse | null; error: string | null }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, error: "Not authenticated" };

  const url = new URL(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/commercial-payment-status`,
  );
  url.searchParams.set("ref", saffReference);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Authorization": `Bearer ${session.access_token}` },
  });
  const json = (await res.json()) as RawCheckoutStatusResponse;
  if (!res.ok) return { data: null, error: (json as unknown as { error?: string })?.error ?? "Status check failed" };

  return { data: mapRawCheckoutStatusResponse(json), error: null };
}

/**
 * Request one bounded recovery-verification attempt via POST to the same
 * Edge Function. Ω∞ A+ closure HIGH-1: the server durably throttles this
 * per-intent (claim_verification_attempt) — calling it does not guarantee
 * a provider call happens, and calling it frequently is safe by design.
 * Returns the same shape as pollCheckoutStatus on a full/claimed response;
 * returns `{ throttled: true, retryAfterSeconds }` when the server refused
 * the claim (already in flight or attempted too recently) — callers should
 * treat that identically to "no new information yet," never as an error.
 */
export async function requestPaymentVerificationRecovery(
  saffReference: string,
): Promise<{ data: CheckoutStatusResponse | null; throttled: boolean; retryAfterSeconds: number | null; error: string | null }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { data: null, throttled: false, retryAfterSeconds: null, error: "Not authenticated" };

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/commercial-payment-status`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ saffReference }),
    },
  );

  if (res.status === 202) {
    const json = await res.json().catch(() => ({}));
    return { data: null, throttled: true, retryAfterSeconds: (json as { retryAfterSeconds?: number }).retryAfterSeconds ?? null, error: null };
  }

  const json = (await res.json()) as RawCheckoutStatusResponse;
  if (!res.ok) return { data: null, throttled: false, retryAfterSeconds: null, error: (json as unknown as { error?: string })?.error ?? "Recovery request failed" };

  return { data: mapRawCheckoutStatusResponse(json), throttled: false, retryAfterSeconds: null, error: null };
}

function mapRawCheckoutStatusResponse(json: RawCheckoutStatusResponse): CheckoutStatusResponse {
  return {
    found: json.found,
    status: json.status ?? null,
    planCode: json.plan_code ?? null,
    licenceStatus: json.licence_status ?? null,
    effectiveStart: json.effective_start ?? null,
    effectiveEnd: json.effective_end ?? null,
    correlationId: json.correlationId,
  };
}
