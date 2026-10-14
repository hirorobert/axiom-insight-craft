// commercial/onlinePaymentStatus.ts — the administrator's Online payment screen, as three separate facts. Pure.
//   1. Provider settings: from the admin-only diagnostics (complete / incomplete with setting NAMES / unavailable).
//      Complete settings do not prove the provider accepts them, that the merchant is approved, or that checkout is open.
//   2. Online payment state: the server's platform state.
//   3. This account: whether the server would let the signed-in account pay now, with the server's own reason.
// A failed or malformed read is an error to retry — never "none".

import type { CheckoutOptions } from "./checkoutClient";

export interface ProviderDiagnostic {
  provider: "POLAR" | "SNIPPE";
  route: "CARD" | "MOBILE_MONEY";
  status: "CONFIGURED" | "INCOMPLETE" | "UNAVAILABLE";
  environment: "sandbox" | "production" | null;
  missingSettings: string[];
  unavailableReason?: string;
}

const STATUSES = new Set(["CONFIGURED", "INCOMPLETE", "UNAVAILABLE"]);
const NAME = /^[A-Z][A-Z0-9_]*$/;

/** Server answer → diagnostics, or null when malformed (anything unexpected is refused, never guessed). */
export function parseProviderDiagnostics(raw: unknown): ProviderDiagnostic[] | null {
  const list = (raw as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) return null;
  const out: ProviderDiagnostic[] = [];
  for (const p of list as Record<string, unknown>[]) {
    if ((p?.provider !== "POLAR" && p?.provider !== "SNIPPE") || (p.route !== "CARD" && p.route !== "MOBILE_MONEY")
        || !STATUSES.has(String(p.status)) || !Array.isArray(p.missingSettings)
        || !(p.missingSettings as unknown[]).every((n) => typeof n === "string" && NAME.test(n))
        || !(p.environment === null || p.environment === "sandbox" || p.environment === "production")) return null;
    out.push({ provider: p.provider, route: p.route, status: p.status as ProviderDiagnostic["status"], environment: p.environment as ProviderDiagnostic["environment"],
      missingSettings: p.missingSettings as string[], ...(typeof p.unavailableReason === "string" ? { unavailableReason: p.unavailableReason } : {}) });
  }
  return out;
}

const ROUTE_LABEL = { CARD: "Card", MOBILE_MONEY: "Mobile money" } as const;
const PROVIDER_LABEL = { POLAR: "Polar", SNIPPE: "Snippe" } as const;

export function providerLine(d: ProviderDiagnostic): string {
  const head = `${ROUTE_LABEL[d.route]} · ${PROVIDER_LABEL[d.provider]}`;
  if (d.status === "UNAVAILABLE") return `${head}: unavailable${d.unavailableReason === "NOT_LAUNCHED" ? " (not launched)" : ""}`;
  if (d.status === "INCOMPLETE") return `${head}: settings incomplete — missing or invalid: ${d.missingSettings.join(", ") || "unknown"}`;
  return `${head}: settings complete (${d.environment}). Not a check that the provider accepts them or that payments are open.`;
}

const PLATFORM_LABEL: Record<string, string> = {
  PAYMENTS_DISABLED: "Payments disabled",
  SANDBOX_ONLY: "Sandbox only",
  LIVE_ACCEPTANCE: "Live acceptance (allow-listed testers only)",
  CUSTOMER_PAYMENTS_ENABLED: "Customer payments enabled",
};
export const platformLabel = (s: string | null): string => (s && PLATFORM_LABEL[s]) || "Unknown";

const REASON_LABEL: Record<string, string> = {
  PAYMENTS_DISABLED: "Payments disabled",
  PAYMENTS_NOT_OPEN: "Not open for this account in the current payment state",
  NO_PURCHASABLE_OFFER: "No approved price for this route",
  PAYMENT_PROVIDER_UNAVAILABLE: "Provider settings incomplete",
  OFFER_RESTRICTED_TO_UNAVAILABLE_PROVIDER: "Price restricted to an unavailable provider",
  OFFER_READ_FAILED: "Price could not be read",
};
export const reasonLabel = (r: string | undefined): string => (r && REASON_LABEL[r]) || "Refused";

/** Whether the signed-in account could pay for the plan now, per route, with the server's reason. */
export function accountEligibility(opts: CheckoutOptions): { allowed: boolean; lines: string[] } {
  const lines = opts.options.map((o) => `${ROUTE_LABEL[o.paymentRoute]}: ${o.available ? "allowed" : `refused — ${reasonLabel(o.reason)}`}`);
  return { allowed: opts.options.some((o) => o.available), lines };
}

/** Checkout options answer is well-formed enough to display. */
export function isCheckoutOptions(v: unknown): v is CheckoutOptions {
  const o = v as CheckoutOptions | null;
  return !!o && Array.isArray(o.options) && o.options.every((r) => (r?.paymentRoute === "CARD" || r?.paymentRoute === "MOBILE_MONEY") && typeof r.available === "boolean");
}
