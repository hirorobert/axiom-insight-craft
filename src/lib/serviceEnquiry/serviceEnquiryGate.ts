// serviceEnquiryGate.ts — the ONE rollout gate for the Phase 1 service enquiry experience: `service_enquiry_phase1`.
//
// Same discipline as the repository's other rollout gates (the financial-statements and document-review gates):
// a plain, source-controlled configuration. It is deliberately NOT a VITE_* variable, a runtime setting, a query parameter, a
// cookie, localStorage or any other browser-editable value — a user, and a deployment setting, cannot turn it on. Enabling it
// requires a reviewed code change to COMMITTED_CONFIG below.
//
// It is independent of every other gate and of authorization. It controls only whether the browser SHOWS the experience.
// It is never authority: submission is still an Edge Function that validates everything, and the staff queue is still refused
// by the database (42501) to anyone who is not active platform staff — whatever this gate says. The database migration and
// the Edge Functions are deployable, and behave identically, while this gate is OFF.
//
// FAIL CLOSED: the gate is ON only for one exact, well-formed configuration. A missing, null, mistyped, extended or
// differently-named configuration is OFF. Nothing here can throw or default to ON.

export const SERVICE_ENQUIRY_PHASE1_GATE = "service_enquiry_phase1" as const;

export interface ServiceEnquiryGateConfig {
  readonly gate: typeof SERVICE_ENQUIRY_PHASE1_GATE;
  readonly enabled: boolean;
}

/**
 * The committed rollout configuration. OFF in every environment, production included. Do not turn this on until the migration
 * is applied, the Edge Functions are deployed, platform staff are enrolled and application email is verified
 * (docs/operations/SERVICE_ENQUIRY_PHASE1.md).
 */
const COMMITTED_CONFIG: ServiceEnquiryGateConfig = { gate: SERVICE_ENQUIRY_PHASE1_GATE, enabled: false };

/** Pure. true ONLY for exactly `{ gate: "service_enquiry_phase1", enabled: true }`; everything else — including no config at all — is false. */
export function evaluateServiceEnquiryGate(config: unknown): boolean {
  try {
    if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
    const keys = Object.keys(config);
    if (keys.length !== 2 || !keys.includes("gate") || !keys.includes("enabled")) return false;
    const c = config as Record<string, unknown>;
    return c.gate === SERVICE_ENQUIRY_PHASE1_GATE && c.enabled === true;
  } catch {
    return false;
  }
}

export const SERVICE_ENQUIRY_PHASE1_ENABLED: boolean = evaluateServiceEnquiryGate(COMMITTED_CONFIG);

/** Every user-visible surface the gate controls. While OFF, none of them exists and the product is exactly what it was. */
export interface ServiceEnquirySurfaces {
  /** Contact link in the public header (desktop nav and mobile menu). */
  readonly headerContactLink: boolean;
  /** Contact link in the public footer. */
  readonly footerContactLink: boolean;
  /** "Help & support" in the header account menu and the workspace user menu. */
  readonly helpSupportLinks: boolean;
  /** The /contact route. Absent → the router's existing not-found behaviour. */
  readonly contactRoute: boolean;
  /** The /admin/enquiries route and its (lazy) staff queue code. Absent → existing not-found behaviour. */
  readonly staffQueueRoute: boolean;
  /** The donor/funder workflow tile (position 03). */
  readonly donorTile: boolean;
  /** The jurisdiction-gated tax experience. Off → the current tax outcome card, untouched. */
  readonly taxExperience: boolean;
  /** Whether the browser may call submit-service-enquiry at all. */
  readonly submissionAllowed: boolean;
}

export function surfacesFor(enabled: boolean): ServiceEnquirySurfaces {
  const on = enabled === true;
  return {
    headerContactLink: on,
    footerContactLink: on,
    helpSupportLinks: on,
    contactRoute: on,
    staffQueueRoute: on,
    donorTile: on,
    taxExperience: on,
    submissionAllowed: on,
  };
}

export const SERVICE_ENQUIRY_SURFACES: ServiceEnquirySurfaces = surfacesFor(SERVICE_ENQUIRY_PHASE1_ENABLED);
