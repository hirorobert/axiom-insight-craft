// commercial/offerings.ts — the ONE registry of what CFOCLOSE sells and how each is requested. Pure data and links.
//
//   Software subscriptions   a 12-month term: paid online where the team has opened it (planOffers.ts), otherwise sold by
//                            agreement and activated MANUALLY by our team (the activation request below). Plans and
//                            prices are the reviewed catalogue's (src/lib/commercial/pricingCatalogue.ts) — never restated.
//   Specialist services      forecasting, budgeting, financial analysis, accounting policies and close support are delivered
//                            by people and quoted separately from any subscription. They are NOT automated features of the
//                            software, and nothing here suggests otherwise.
//   Financial reporting      a pilot by invitation; not generally available; the accounting is not independently validated.
//
// Every request goes through the existing enquiry system (/contact), preselected by ?service= (and ?plan= for activation).

import { ACTIVATION_PLAN_CODES, SPECIALIST_SERVICE_CODES, type ActivationPlanCode } from "@/lib/serviceEnquiry/contract";
import { CONTACT_ROUTE } from "@/lib/serviceEnquiry/entryPoints";

export type SpecialistServiceCode = (typeof SPECIALIST_SERVICE_CODES)[number];
export type CommercialSource = "landing_plans" | "landing_services" | "plan_wall";

export interface SpecialistService {
  readonly code: SpecialistServiceCode;
  readonly name: string;
  /** One sentence: what the specialist does with the customer. */
  readonly description: string;
}

export const SPECIALIST_SERVICES: readonly SpecialistService[] = [
  { code: "forecasting", name: "Forecasting", description: "A specialist builds or reviews a forecast with you from your own figures and assumptions." },
  { code: "budgeting", name: "Budgeting", description: "A specialist helps you prepare or review an annual or project budget." },
  { code: "financial_analysis", name: "Financial analysis", description: "A specialist analyses your results, ratios and trends and explains what they show." },
  { code: "accounting_policies", name: "Accounting policies", description: "A specialist helps you draft or review accounting policies for your framework." },
  { code: "close_support", name: "Close support", description: "A specialist supports your month-end or year-end close and its review." },
];

/** Shown on every specialist service, wherever it appears. */
export const SPECIALIST_LABEL = "Specialist enquiry — delivered by people, quoted separately. Not an automated feature of the software.";

/** Shown beside every plan action. */
export const MANUAL_ACTIVATION_NOTE = "Plans requested here are activated by our team after we agree terms with you.";

export const REQUEST_ACTIVATION_LABEL = "Request activation";

const isPlan = (v: string | null): v is ActivationPlanCode => v !== null && (ACTIVATION_PLAN_CODES as readonly string[]).includes(v);
const isSpecialist = (v: string | null): v is SpecialistServiceCode => v !== null && (SPECIALIST_SERVICE_CODES as readonly string[]).includes(v);
const isSource = (v: string | null): v is CommercialSource => v === "landing_plans" || v === "landing_services" || v === "plan_wall";

export const activationHref = (plan: ActivationPlanCode, from: CommercialSource): string => `${CONTACT_ROUTE}?service=plan_activation&plan=${plan}&from=${from}`;
/** An activation request that names no plan yet (the requester chooses it in the form). */
export const activationRequestHref = (from: CommercialSource): string => `${CONTACT_ROUTE}?service=plan_activation&from=${from}`;
export const specialistHref = (code: SpecialistServiceCode, from: CommercialSource = "landing_services"): string => `${CONTACT_ROUTE}?service=${code}&from=${from}`;

export type ContactIntent =
  | { readonly kind: "general" }
  | { readonly kind: "activation"; readonly plan: ActivationPlanCode | null; readonly source: CommercialSource | null }
  | { readonly kind: "specialist"; readonly service: SpecialistService; readonly source: CommercialSource | null };

/** What a /contact URL asks for. Anything unrecognised is the general contact form — never a guessed service or plan. */
export function contactIntentFromSearch(params: URLSearchParams): ContactIntent {
  const service = params.get("service");
  const from = params.get("from");
  const source = isSource(from) ? from : null;
  if (service === "plan_activation") {
    const plan = params.get("plan");
    return { kind: "activation", plan: isPlan(plan) ? plan : null, source };
  }
  if (isSpecialist(service)) return { kind: "specialist", service: SPECIALIST_SERVICES.find((s) => s.code === service)!, source };
  return { kind: "general" };
}

/**
 * Every public string that names a specialist service. The withheld-module guards (moduleAvailability.test.ts,
 * publicClaimRegistry.test.ts) remove exactly these — and nothing else — before scanning for withheld-engine wording such
 * as "forecast": a people-delivered, separately quoted enquiry may name forecasting; no other copy may.
 */
export const SPECIALIST_PUBLIC_STRINGS: readonly string[] = [
  ...SPECIALIST_SERVICES.flatMap((s) => [s.name, s.description]),
  SPECIALIST_LABEL,
];
