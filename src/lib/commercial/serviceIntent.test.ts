/**
 * The service chosen on the public page survives authentication as navigational intent only: a closed registry,
 * re-validated on every read, routed on the SERVER's billing snapshot — never on anything the browser claims.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES } from "./featureRegistry";
import { PRICING_CATALOGUE } from "./pricingCatalogue";
import {
  SERVICE_INTENTS, SERVICE_INTENT_IDS, SERVICE_INTENT_STORAGE_KEY, clearServiceIntent, currentServiceIntent, intentFromUserMetadata, parsePlanIntent,
  parseServiceIntent, plansHref, readRememberedServiceIntent, rememberServiceIntent, resolveServiceDestination,
  serviceAuthHref, serviceAvailabilityLabel, type BillingSnapshot, CUSTOMER_SERVICE_INTENT_IDS } from "./serviceIntent";

const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  sessionStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};
afterEach(() => store.clear());

describe("closed registry", () => {
  it("exactly four services, each bound to a real capability and a real stage", () => {
    expect(SERVICE_INTENT_IDS).toEqual(["prepare-review", "close-certification", "reporting-pack", "close-insights"]);
    expect(CUSTOMER_SERVICE_INTENT_IDS).toEqual(["prepare-review"]);
    expect(SERVICE_INTENTS["prepare-review"].name).toBe("Trial balance review");
    for (const id of SERVICE_INTENT_IDS) {
      expect(CAPABILITIES[SERVICE_INTENTS[id].capability]).toBeDefined();
      expect(["prepare", "statements", "monitor"]).toContain(SERVICE_INTENTS[id].stage);
    }
  });
  it.each([
    ["prepare-review", "prepare-review"],
    // Withheld from customers (moduleAvailability.ts): registry identifiers that no longer parse from any source.
    ["reporting-pack", null], ["close-certification", null], ["close-insights", null],
    ["Prepare-Review", null], [" prepare-review", null], ["prepare-review ", null], ["prepare_review", null],
    ["REPORTING_PACK_EXPORT", null], ["", null], [null, null], [undefined, null], [42, null], [{ toString: () => "prepare-review" }, null],
    ["__proto__", null], ["constructor", null],
  ])("service %j → %j", (input, expected) => {
    expect(parseServiceIntent(input)).toBe(expected);
  });
  it.each([
    ["solo", "SOLO"], ["practice", "PRACTICE"], ["firm", "FIRM"], ["enterprise", "ENTERPRISE"],
    ["SOLO", null], ["paid", null], ["free", null], ["", null], [null, null], [7, null],
  ])("plan %j → %j", (input, expected) => {
    expect(parsePlanIntent(input)).toBe(expected);
  });
});

describe("availability is derived from the plan × capability matrix, never written", () => {
  it("every service is in every catalogue plan today → 'Included in every plan'; there is no free plan", () => {
    for (const id of SERVICE_INTENT_IDS) expect(serviceAvailabilityLabel(id)).toBe("Included in every plan");
    expect(PRICING_CATALOGUE.every((p) => p.monthlyMinor === null || p.monthlyMinor > 0)).toBe(true);
  });
});

describe("links carry validated identifiers only", () => {
  it("sign-up, sign-in and plans", () => {
    expect(serviceAuthHref("signup", "reporting-pack")).toBe("/auth?mode=signup&service=reporting-pack");
    expect(serviceAuthHref("signup", "reporting-pack", "PRACTICE")).toBe("/auth?mode=signup&service=reporting-pack&plan=practice");
    expect(serviceAuthHref("login", "close-insights")).toBe("/auth?service=close-insights");
    expect(serviceAuthHref("signup", null)).toBe("/auth?mode=signup");
    expect(plansHref("close-certification", "FIRM")).toBe("/plans?service=close-certification&plan=firm");
  });
});

describe("remembered intent is re-validated on every read", () => {
  it("round trip; a tampered value is dropped", () => {
    rememberServiceIntent("prepare-review", "SOLO");
    expect(readRememberedServiceIntent()).toEqual({ service: "prepare-review", plan: "SOLO" });
    store.set(SERVICE_INTENT_STORAGE_KEY, JSON.stringify({ service: "admin", plan: "solo" }));
    expect(readRememberedServiceIntent()).toBeNull();
    store.set(SERVICE_INTENT_STORAGE_KEY, "{not json");
    expect(readRememberedServiceIntent()).toBeNull();
    store.set(SERVICE_INTENT_STORAGE_KEY, JSON.stringify({ service: "prepare-review", plan: "platinum" }));
    expect(readRememberedServiceIntent()).toEqual({ service: "prepare-review", plan: null });
    clearServiceIntent();
    expect(readRememberedServiceIntent()).toBeNull();
  });
  it("a valid URL value wins over a remembered one; an invalid URL value falls back to the remembered one", () => {
    rememberServiceIntent("prepare-review", null);
    expect(currentServiceIntent("?service=prepare-review&plan=firm")).toEqual({ service: "prepare-review", plan: "FIRM" });
    expect(currentServiceIntent("?service=hack")).toEqual({ service: "prepare-review", plan: null });
  });
});

describe("the intent survives the confirmation link in ANOTHER browser or tab (no URL, no sessionStorage)", () => {
  // signUp stores { v: 1, service, plan } in the new account's own user metadata; the confirmation link returns to the
  // site root. A fresh browser has an empty sessionStorage and a bare URL — the metadata alone must carry the intent.
  const meta = { display_name: "A", service_intent: { v: 1, service: "prepare-review", plan: "practice" } };
  it("a fresh browser (empty storage, bare URL) recovers both service and plan from the account's metadata", () => {
    store.clear();
    expect(currentServiceIntent("", meta)).toEqual({ service: "prepare-review", plan: "PRACTICE" });
    expect(currentServiceIntent("?", meta)).toEqual({ service: "prepare-review", plan: "PRACTICE" });
  });
  it("service without a plan survives too", () => {
    expect(currentServiceIntent("", { service_intent: { v: 1, service: "prepare-review", plan: null } })).toEqual({ service: "prepare-review", plan: null });
  });
  it("precedence: a valid URL value, then this tab's remembered value, then the metadata", () => {
    rememberServiceIntent("prepare-review", "FIRM");
    expect(currentServiceIntent("?service=prepare-review", meta)).toEqual({ service: "prepare-review", plan: null });
    expect(currentServiceIntent("", meta)).toEqual({ service: "prepare-review", plan: "FIRM" });
  });
  it.each([
    ["no metadata", undefined],
    ["metadata without an intent", { display_name: "A" }],
    ["wrong version", { service_intent: { v: 2, service: "prepare-review", plan: "practice" } }],
    ["unknown service", { service_intent: { v: 1, service: "admin", plan: "practice" } }],
    ["array", { service_intent: ["prepare-review"] }],
    ["string", { service_intent: "prepare-review" }],
  ])("metadata is untrusted input: %s → no intent", (_label, m) => {
    expect(intentFromUserMetadata(m)).toBeNull();
  });
  it("a tampered plan in metadata is dropped, the service kept", () => {
    expect(intentFromUserMetadata({ service_intent: { v: 1, service: "prepare-review", plan: "platinum" } })).toEqual({ service: "prepare-review", plan: null });
  });
});

describe("where an authenticated account with an intent goes", () => {
  const intent = { service: "prepare-review" as const, plan: "PRACTICE" as const };
  const snap = (over: Partial<BillingSnapshot>): BillingSnapshot => ({ hasBillingCustomer: true, planCode: "PRACTICE", licenceStatus: "ACTIVE", entitlements: [], ...over });
  const go = (summary: BillingSnapshot | null, extra: { loading?: boolean; error?: boolean } = {}) =>
    resolveServiceDestination(intent, { loading: !!extra.loading, error: !!extra.error, summary });

  it("no intent → ordinary routing", () => {
    expect(resolveServiceDestination(null, { loading: true, error: false, summary: null })).toEqual({ kind: "none" });
  });
  it("billing read in flight → wait; failed → ignore (never routed as entitled)", () => {
    expect(go(null, { loading: true })).toEqual({ kind: "wait" });
    expect(go(snap({}), { error: true })).toEqual({ kind: "ignore" });
  });
  it("entitled (active or grace licence on a catalogue plan) → the service's workflow stage", () => {
    expect(go(snap({}))).toEqual({ kind: "workflow", stage: "prepare" });
    expect(go(snap({ licenceStatus: "GRACE", planCode: "SOLO" }))).toEqual({ kind: "workflow", stage: "prepare" });
    // A withheld service carried from an older link or record routes nowhere (ordinary routing applies).
    expect(resolveServiceDestination({ service: "close-insights" as never, plan: null }, { loading: false, error: false, summary: snap({}) })).toEqual({ kind: "none" });
    expect(resolveServiceDestination({ service: "prepare-review", plan: null }, { loading: false, error: false, summary: snap({}) })).toEqual({ kind: "workflow", stage: "prepare" });
  });
  it.each([
    ["no billing customer", { hasBillingCustomer: false }],
    ["no current licence", { planCode: null, licenceStatus: null }],
    ["pending licence", { licenceStatus: "PENDING" }],
    ["suspended licence", { licenceStatus: "SUSPENDED" }],
    ["expired licence", { licenceStatus: "EXPIRED" }],
    ["retired FREE plan", { planCode: "FREE" }],
    ["unknown plan", { planCode: "PLATINUM" }],
    ["unknown licence status", { licenceStatus: "WHATEVER" }],
  ])("not entitled (%s) → /plans with the service and plan preserved", (_label, over) => {
    expect(go(snap(over as Partial<BillingSnapshot>))).toEqual({ kind: "plans", href: "/plans?service=prepare-review&plan=practice" });
  });
  it("no summary at all → /plans (never assumed entitled)", () => {
    expect(go(null)).toEqual({ kind: "plans", href: "/plans?service=prepare-review&plan=practice" });
  });
  it("a tampered intent object is re-validated: an unknown service routes nowhere", () => {
    expect(resolveServiceDestination({ service: "admin" as never, plan: null }, { loading: false, error: false, summary: snap({}) })).toEqual({ kind: "none" });
  });
});

describe("wiring: the intent survives authentication and never grants", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "../../..", f), "utf8");

  it("the registry module reaches no backend", () => {
    expect(read("src/lib/commercial/serviceIntent.ts")).not.toMatch(/supabase|\.rpc\(|fetch\(|commercialRpc/);
  });
  it("Auth validates the identifier, remembers it in the tab, and stores it in the new account's own metadata; the confirmation link returns to the site root", () => {
    const auth = read("src/pages/Auth.tsx");
    expect(auth).toContain('parseServiceIntent(searchParams.get("service"))');
    expect(auth).toContain("rememberServiceIntent(selectedService, selectedPlan)");
    expect(auth).toContain("await signUp(email, password, displayName, selectedService ? { service: selectedService, plan: selectedPlan ? selectedPlan.toLowerCase() : null } : null)");
    expect(auth).toContain("emailRedirectTo: `${window.location.origin}/`,");
    expect(auth).not.toContain("serviceReturnPath");   // never a query-bearing redirect
    const ctx = read("src/contexts/AuthContext.tsx");
    expect(ctx).toContain("const redirectUrl = `${window.location.origin}/`;");
    expect(ctx).toContain("service_intent: { v: 1, service: serviceIntent.service, plan: serviceIntent.plan }");
  });
  it("the gateway routes on the server billing read: waits while loading, /plans when not entitled, the stage when entitled", () => {
    const dash = read("src/pages/Dashboard.tsx");
    expect(dash).toContain("resolveServiceDestination(serviceIntent, { loading: billingLoading, error: !!billingError, summary: billing })");
    expect(dash).toContain('serviceDestination.kind === "plans"');
    expect(dash).toContain("<Navigate to={serviceDestination.href} replace />");
    expect(dash).toMatch(/!fetchFailed && serviceDestination\.kind !== "wait"/);
    expect(dash).toContain("${route.entry.periodYear}${stageSuffix}");
    expect(dash).toContain("forceHub ? null : currentServiceIntent(location.search, user?.user_metadata)");
    expect(dash).toContain("supabase.auth.updateUser({ data: { service_intent: null } })");   // used once, then cleared
  });
  it("Index forwards only a validated intent; Plans shows only a validated one", () => {
    expect(read("src/pages/Index.tsx")).toContain("currentServiceIntent(window.location.search)");
    expect(read("src/pages/Plans.tsx")).toContain('parseServiceIntent(params.get("service"))');
  });
});
