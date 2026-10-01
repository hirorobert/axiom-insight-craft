/**
 * LandingIntent — the one piece of state the public page holds: which service (outcome) the visitor is looking at.
 * Every call to action reads it (useLandingIntent) so the choice survives into sign-up / sign-in as a validated
 * `service=` identifier.
 *
 * Presentation state only. It grants nothing, is stored nowhere by the page itself (Auth remembers a validated
 * intent), and the context has a safe default so each section also renders on its own (tests, static markup).
 */

import { useState, type ReactNode } from "react";
import type { ServiceIntentId } from "@/lib/commercial/serviceIntent";
import { DEFAULT_SERVICE, LandingIntentContext } from "@/components/landing/landingIntentContext";

export function LandingIntentProvider({ children, initial }: { children: ReactNode; initial?: ServiceIntentId | null }) {
  const [service, setService] = useState<ServiceIntentId>(initial ?? DEFAULT_SERVICE);
  return <LandingIntentContext.Provider value={{ service, setService }}>{children}</LandingIntentContext.Provider>;
}
