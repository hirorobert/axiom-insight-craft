/**
 * serviceIntent — the visitor's chosen SERVICE (the outcome they came for), carried from the public page through
 * sign-up / sign-in to the right place. Navigational intent only: it never grants, implies or caches a capability.
 *
 * Closed registry. A service identifier is accepted only if it is exactly one of SERVICE_INTENT_IDS; anything else
 * (unknown, mixed case, padded, an object) is null. The same holds for the optional plan preference, which is
 * validated against PRICING_CATALOGUE.
 *
 * Carrying it across authentication — never only in the browser tab:
 *   · the URL (`?service=…&plan=…`) on every call to action and on Auth;
 *   · sessionStorage for the same-tab round trip (OAuth);
 *   · the new account's OWN server-stored user metadata (`service_intent`, written by signUp), which survives the
 *     confirmation link opened in any browser or tab. The confirmation link itself returns to the site root.
 * Every source is re-validated on read; the metadata is user-writable, so it is treated as untrusted input like the URL.
 *
 * After authentication (resolveServiceDestination, used by the Dashboard gateway):
 *   1. the identifier is re-validated here;
 *   2. the account's entitlement is read from the SERVER (get_my_billing_summary — the current licence and its
 *      feature codes) and classified by classifyEntitlement, the mirror of _resolve_entitlement_for_owner();
 *   3. not entitled (no plan, inactive licence, plan without the capability) → /plans, preserving the service;
 *   4. entitled → the service's workflow stage.
 * While the billing read is loading the gateway waits; if it fails, the intent is ignored for this visit (kept for the
 * next one) and the ordinary routing applies — a failed read never routes as if entitled.
 *
 * Admin overrides are not visible to this read, so an account entitled only by an override is sent to /plans: the
 * safe direction (no capability is ever assumed).
 */
import { CAPABILITIES, type CapabilityCode } from "./featureRegistry";
import { classifyEntitlement, isEntitledForPrivilegedUse } from "./entitlementContract";
import { PRICING_CATALOGUE, planByCode, planIncludes, type PlanCode } from "./pricingCatalogue";
import { isServiceIntentCustomerVisible, TRIAL_BALANCE_REVIEW } from "@/lib/workspace/moduleAvailability";

export const SERVICE_INTENT_IDS = ["prepare-review", "close-certification", "reporting-pack", "close-insights"] as const;
export type ServiceIntentId = (typeof SERVICE_INTENT_IDS)[number];

export interface ServiceIntentDefinition {
  readonly id: ServiceIntentId;
  readonly name: string;
  /** The capability the service needs — the authority is the server; this is the code it is checked against. */
  readonly capability: CapabilityCode;
  /** The workspace stage the service's workflow starts in (src/lib/workspace/stageMetadata.ts slugs). */
  readonly stage: "prepare" | "statements" | "monitor";
}

export const SERVICE_INTENTS: Readonly<Record<ServiceIntentId, ServiceIntentDefinition>> = {
  "prepare-review": { id: "prepare-review", name: TRIAL_BALANCE_REVIEW.title, capability: "CLOSE_ASSURANCE", stage: "prepare" },
  "close-certification": { id: "close-certification", name: CAPABILITIES.STATEMENT_CERTIFICATION.name, capability: "STATEMENT_CERTIFICATION", stage: "statements" },
  "reporting-pack": { id: "reporting-pack", name: CAPABILITIES.REPORTING_PACK_EXPORT.name, capability: "REPORTING_PACK_EXPORT", stage: "statements" },
  "close-insights": { id: "close-insights", name: CAPABILITIES.CLOSE_INSIGHTS.name, capability: "CLOSE_INSIGHTS", stage: "monitor" },
};

/** The services a customer can choose (moduleAvailability.ts): today, Trial balance review only. */
export const CUSTOMER_SERVICE_INTENT_IDS: readonly ServiceIntentId[] = SERVICE_INTENT_IDS.filter(isServiceIntentCustomerVisible);

/** Exact match against the closed registry AND the customer projection, else null: a withheld service never parses. */
export function parseServiceIntent(value: unknown): ServiceIntentId | null {
  return typeof value === "string" && (CUSTOMER_SERVICE_INTENT_IDS as readonly string[]).includes(value) ? (value as ServiceIntentId) : null;
}

/** A plan preference: the lower-case catalogue code ("solo", "practice", "firm", "enterprise"), else null. */
export function parsePlanIntent(value: unknown): PlanCode | null {
  if (typeof value !== "string" || value !== value.toLowerCase()) return null;
  return planByCode(value.toUpperCase())?.code ?? null;
}

/**
 * How the public page labels a service: "Included in every plan" when every catalogue plan includes its capability
 * (PLAN_FEATURE_MATRIX), otherwise "Plan required". Derived, never restated; there is no free plan either way.
 */
export function serviceAvailabilityLabel(id: ServiceIntentId): "Included in every plan" | "Plan required" {
  const capability = SERVICE_INTENTS[id].capability;
  return PRICING_CATALOGUE.every((p) => planIncludes(p.code, capability)) ? "Included in every plan" : "Plan required";
}

function query(service: ServiceIntentId | null, plan: PlanCode | null): string {
  const q = [service ? `service=${service}` : null, plan ? `plan=${plan.toLowerCase()}` : null].filter(Boolean);
  return q.length ? q.join("&") : "";
}

/** /auth?mode=signup&service=reporting-pack[&plan=practice] (or mode-less for sign-in). */
export function serviceAuthHref(mode: "signup" | "login", service: ServiceIntentId | null, plan: PlanCode | null = null): string {
  const rest = query(service, plan);
  if (mode === "signup") return `/auth?mode=signup${rest ? `&${rest}` : ""}`;
  return `/auth${rest ? `?${rest}` : ""}`;
}

export function plansHref(service: ServiceIntentId | null, plan: PlanCode | null = null): string {
  const rest = query(service, plan);
  return `/plans${rest ? `?${rest}` : ""}`;
}

// ── Carrying the intent across the authentication round trip (same tab) ──────────────────────────────────────────
// The URL carries it wherever it can (the confirmation link's redirect too); sessionStorage covers the same-tab
// OAuth round trip. Both are re-validated on every read.

export const SERVICE_INTENT_STORAGE_KEY = "cfoclose:service-intent:v1";

export interface StoredServiceIntent {
  readonly service: ServiceIntentId;
  readonly plan: PlanCode | null;
}

export function rememberServiceIntent(service: ServiceIntentId, plan: PlanCode | null): void {
  try {
    window.sessionStorage.setItem(SERVICE_INTENT_STORAGE_KEY, JSON.stringify({ service, plan: plan ? plan.toLowerCase() : null }));
  } catch {
    // Storage may be unavailable; the URL still carries the intent.
  }
}

export function readRememberedServiceIntent(): StoredServiceIntent | null {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(SERVICE_INTENT_STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return null;
    const service = parseServiceIntent((raw as Record<string, unknown>).service);
    return service ? { service, plan: parsePlanIntent((raw as Record<string, unknown>).plan) } : null;
  } catch {
    return null;
  }
}

export function clearServiceIntent(): void {
  try {
    window.sessionStorage.removeItem(SERVICE_INTENT_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}

/** The intent stored in the account's own user metadata at sign-up ({ v: 1, service, plan }), re-validated. */
export function intentFromUserMetadata(metadata: unknown): StoredServiceIntent | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).service_intent;
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).v !== 1) return null;
  const service = parseServiceIntent((raw as Record<string, unknown>).service);
  return service ? { service, plan: parsePlanIntent((raw as Record<string, unknown>).plan) } : null;
}

/** The intent for this visit: a valid URL value, else this tab's remembered one, else the account's own metadata. */
export function currentServiceIntent(search: string, userMetadata?: unknown): StoredServiceIntent | null {
  const params = new URLSearchParams(search);
  const service = parseServiceIntent(params.get("service"));
  if (service) return { service, plan: parsePlanIntent(params.get("plan")) };
  return readRememberedServiceIntent() ?? intentFromUserMetadata(userMetadata);
}

// ── Where an authenticated visitor with an intent goes ────────────────────────────────────────────────────────────

/** The server's billing snapshot, as useBillingSummary returns it (get_my_billing_summary). */
export interface BillingSnapshot {
  readonly hasBillingCustomer: boolean;
  readonly planCode: string | null;
  readonly licenceStatus: string | null;
  readonly entitlements: readonly string[];
}

export type ServiceDestination =
  | { kind: "none" }                                          // no intent: ordinary routing
  | { kind: "wait" }                                          // billing read in flight: do not route yet
  | { kind: "ignore" }                                        // billing read failed: ordinary routing, intent kept
  | { kind: "plans"; href: string }                           // not entitled: choose a plan, intent preserved
  | { kind: "workflow"; stage: ServiceIntentDefinition["stage"] };

export function resolveServiceDestination(
  intent: StoredServiceIntent | null,
  billing: { loading: boolean; error: boolean; summary: BillingSnapshot | null },
): ServiceDestination {
  const service = intent ? parseServiceIntent(intent.service) : null;
  if (!service) return { kind: "none" };
  if (billing.loading) return { kind: "wait" };
  if (billing.error) return { kind: "ignore" };
  const s = billing.summary;
  const entitlement = classifyEntitlement(
    SERVICE_INTENTS[service].capability,
    !!s?.hasBillingCustomer,
    s && s.planCode && s.licenceStatus
      ? { status: s.licenceStatus as never, planCode: s.planCode, featureCodes: s.entitlements }
      : null,
    false,
  );
  if (!isEntitledForPrivilegedUse(entitlement)) return { kind: "plans", href: plansHref(service, intent!.plan) };
  return { kind: "workflow", stage: SERVICE_INTENTS[service].stage };
}
