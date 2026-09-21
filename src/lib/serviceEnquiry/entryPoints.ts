// The entry points from which a person can start an enquiry. Every one of them ends in the same form component and the same
// backend (the submit-service-enquiry Edge Function) — this registry exists so that fact is testable.

import type { ServiceCode, SourceContext } from "./contract";

export type EntryPointKind = "route" | "dialog";

export interface EntryPoint {
  readonly id: "header" | "footer" | "help_support" | "contact_page" | "workflow_donor" | "workflow_tax";
  readonly sourceContext: SourceContext;
  readonly kind: EntryPointKind;
  /** Where a route entry leads. Dialog entries open the same form in place. */
  readonly route?: string;
  readonly serviceCodes: readonly ServiceCode[];
}

export const CONTACT_ROUTE = "/contact";

/** The route contexts a /contact URL may carry in `?from=`. Anything else falls back to the contact page itself. */
export const ROUTE_SOURCE_CONTEXTS = ["site_header", "site_footer", "help_support"] as const;
export type RouteSourceContext = (typeof ROUTE_SOURCE_CONTEXTS)[number];

const isRouteSource = (v: string | null): v is RouteSourceContext => v !== null && (ROUTE_SOURCE_CONTEXTS as readonly string[]).includes(v);

/** The route (with its source context) that a header, footer or help link points to. */
export const contactHref = (source: RouteSourceContext): string => `${CONTACT_ROUTE}?from=${source}`;

export function sourceFromSearch(value: string | null): SourceContext {
  return isRouteSource(value) ? value : "contact_page";
}

export const ENTRY_POINTS: readonly EntryPoint[] = [
  { id: "header", sourceContext: "site_header", kind: "route", route: contactHref("site_header"), serviceCodes: ["general", "support"] },
  { id: "footer", sourceContext: "site_footer", kind: "route", route: contactHref("site_footer"), serviceCodes: ["general", "support"] },
  { id: "help_support", sourceContext: "help_support", kind: "route", route: contactHref("help_support"), serviceCodes: ["general", "support"] },
  { id: "contact_page", sourceContext: "contact_page", kind: "route", route: CONTACT_ROUTE, serviceCodes: ["general", "support"] },
  { id: "workflow_donor", sourceContext: "workflow_donor", kind: "dialog", serviceCodes: ["donor_reporting"] },
  { id: "workflow_tax", sourceContext: "workflow_tax", kind: "dialog", serviceCodes: ["tax_tanzania_preview", "tax_general"] },
];
