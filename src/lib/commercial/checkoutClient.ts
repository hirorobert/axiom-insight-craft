// commercial/checkoutClient.ts — the browser's ONLY calls into online payment. It sends a plan code and a payment route
// (and, for mobile money, the payer's phone number); it never sends a price, currency, market or status, and never
// treats a redirect or a created checkout as payment. Access appears only when the server reports the verified order.

import { useEffect, useState } from "react";
import { parsePublicPrices, type PublicPrices } from "./planOffers";
import type { PlanCode } from "./pricingCatalogue";

export type PaymentRoute = "CARD" | "MOBILE_MONEY";

async function session() {
  const { supabase } = await import("@/integrations/supabase/client");
  const { data: { session } } = await supabase.auth.getSession();
  return { supabase, token: session?.access_token ?? null };
}
const fnUrl = (name: string) => `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;

/** Public prices and whether online payment is open (anonymous read). null until read, or when unavailable. */
export function usePublicPlanPrices(): PublicPrices | null {
  const [prices, setPrices] = useState<PublicPrices | null>(null);
  useEffect(() => {
    let live = true;
    import("@/integrations/supabase/client").then(({ supabase }) =>
      (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)("get_public_plan_prices"),
    ).then(({ data, error }) => { if (live && !error) setPrices(parsePublicPrices(data)); }, () => undefined);
    return () => { live = false; };
  }, []);
  return prices;
}

export interface RouteOption {
  paymentRoute: PaymentRoute;
  available: boolean;
  reason?: string;
  provider?: "POLAR" | "SNIPPE";
  environment?: "sandbox" | "production";
  amountMinor?: number;
  currencyCode?: string;
  currencyExponent?: number;
}
export interface Placement { kind: "NEW" | "RENEWAL" | "UPGRADE" | "AT_RENEWAL" | "BLOCKED_OPEN_ENDED" | "BLOCKED_QUEUED"; start?: string }
export interface CheckoutOptions { planCode: string; options: RouteOption[]; placement: Placement; platformState: string | null }

export async function getCheckoutOptions(plan: PlanCode): Promise<{ data: CheckoutOptions | null; error: string | null }> {
  const { token } = await session();
  if (!token) return { data: null, error: "NOT_SIGNED_IN" };
  try {
    const res = await fetch(`${fnUrl("commercial-create-checkout")}?planCode=${plan}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    return res.ok && json ? { data: json as CheckoutOptions, error: null } : { data: null, error: (json as { error?: string } | null)?.error ?? "OPTIONS_UNAVAILABLE" };
  } catch {
    return { data: null, error: "OPTIONS_UNAVAILABLE" };
  }
}

export type StartCheckoutResult =
  | { ok: true; saffReference: string; checkoutUrl: string; provider: string; paymentRoute: PaymentRoute; reused: boolean }
  | { ok: false; error: string; saffReference: string | null };

export async function startCheckout(plan: PlanCode, paymentRoute: PaymentRoute, phoneNumber: string | null): Promise<StartCheckoutResult> {
  const { token } = await session();
  if (!token) return { ok: false, error: "NOT_SIGNED_IN", saffReference: null };
  try {
    const res = await fetch(fnUrl("commercial-create-checkout"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ planCode: plan, billingInterval: "ANNUAL", paymentRoute, ...(paymentRoute === "MOBILE_MONEY" ? { phoneNumber } : {}) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: String(json.error ?? "CHECKOUT_FAILED"), saffReference: (json.saffReference ?? json.previousSaffReference ?? null) as string | null };
    return { ok: true, saffReference: String(json.saffReference), checkoutUrl: String(json.checkoutUrl), provider: String(json.provider),
      paymentRoute, reused: json.reused === true };
  } catch {
    // No answer: whether an attempt was created is unknown — the customer is sent to check, never to pay again.
    return { ok: false, error: "NETWORK", saffReference: null };
  }
}

export interface MyPayment {
  saff_reference: string; status: string; provider: string; plan_code: string; plan_name: string;
  amount_minor: number; currency_code: string; currency_exponent: number; billing_interval: string;
  created_at: string; completed_at: string | null; payment_reference: string | null; paid_at: string | null;
  licence_start: string | null; licence_end: string | null; reversal_type: string | null;
}

export async function getMyPayments(): Promise<MyPayment[] | null> {
  const { supabase } = await session();
  const { data, error } = await (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)("get_my_payments");
  return error || !Array.isArray(data) ? null : (data as MyPayment[]);
}

// ── Checkout intent across sign-up / sign-in / email confirmation ────────────────────────────────────────────────────
// Only a self-serve plan code is remembered (never a price), and only for one use; storage failures are harmless.
const INTENT_KEY = "cfoclose.checkoutPlan";
export function rememberCheckoutPlan(plan: PlanCode): void {
  try { localStorage.setItem(INTENT_KEY, plan); } catch { /* storage unavailable: the visitor chooses the plan again */ }
}
export function takeCheckoutPlan(isPlan: (v: string | null) => PlanCode | null): PlanCode | null {
  try {
    const v = localStorage.getItem(INTENT_KEY);
    localStorage.removeItem(INTENT_KEY);
    return isPlan(v);
  } catch {
    return null;
  }
}
