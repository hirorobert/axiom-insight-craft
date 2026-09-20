/**
 * onboardingState — the ONE first-run state machine. Pure: no I/O, no clock, no URL.
 *
 * Workflow truth is durable, server-side state, never a query parameter, local flag or navigation history:
 *   - which services are in scope      ← the engagement mandate (append-only GRANT / REVOKE events)
 *   - whether the data choice was made ← `onboarding_progress.current_step` (one row per user × company × year)
 *   - whether data exists              ← the workspace's uploads
 *
 * The service registry is the canonical one in `mandate.ts` (CAPABILITY_OUTCOMES / CAPABILITY_ACTIVATES /
 * CAPABILITY_REQUIRES_EVIDENCE). Nothing here re-declares a catalogue.
 */

import {
  CAPABILITY_ACTIVATES,
  CAPABILITY_REQUIRES_EVIDENCE,
  owningCapability,
  type EngagementCapability,
} from "./mandate";

/** The persisted data choice. `null` = not yet decided. */
export type DataStartChoice = "import" | "empty";

/**
 * A service needs accounting data when its stages, or the evidence it relies on (followed transitively through the
 * services that own that evidence), include Prepare Data.
 */
export function requiresAccountingData(cap: EngagementCapability, seen: ReadonlySet<EngagementCapability> = new Set()): boolean {
  if (CAPABILITY_ACTIVATES[cap].includes("prepare") || CAPABILITY_REQUIRES_EVIDENCE[cap].includes("prepare")) return true;
  const next = new Set(seen).add(cap);
  return CAPABILITY_REQUIRES_EVIDENCE[cap].some((stage) => {
    const owner = owningCapability(stage);
    return !!owner && !next.has(owner) && requiresAccountingData(owner, next);
  });
}

export type LaunchState =
  /** No service is in scope: the launchpad is the one decision. */
  | "LAUNCHPAD"
  /** Services in scope need data and the user has not said how it will be provided. */
  | "DATA_CHOICE"
  /** The user chose to import; no trial balance exists yet. */
  | "IMPORT_PENDING"
  /** The user chose to start without data: a genuine, empty, fully usable workspace. */
  | "EMPTY_WORKSPACE"
  /** Onboarding is over: either data exists or no selected service needs data. */
  | "ACTIVE";

export interface LaunchInput {
  /** `null` while the mandate has not been declared (no engagement, or no service granted). */
  granted: readonly EngagementCapability[] | null;
  hasUpload: boolean;
  dataStart: DataStartChoice | null;
}

export function deriveLaunchState(input: LaunchInput): LaunchState {
  if (!input.granted || input.granted.length === 0) return "LAUNCHPAD";
  if (input.hasUpload) return "ACTIVE";
  if (!input.granted.some((c) => requiresAccountingData(c))) return "ACTIVE";
  if (input.dataStart === "import") return "IMPORT_PENDING";
  if (input.dataStart === "empty") return "EMPTY_WORKSPACE";
  return "DATA_CHOICE";
}

/** Canonical copy — used verbatim by the UI and asserted by the tests. */
export const LAUNCH_COPY = {
  launchpadHeading: "What would you like to complete?",
  dataChoiceHeading: "Add financial data",
  primaryAction: "Import trial balance",
  secondaryAction: "Start without data",
  emptyStateCta: "Import data",
  frameworkMissing: "Framework not selected",
  scopeEditor: "Manage services",
} as const;
