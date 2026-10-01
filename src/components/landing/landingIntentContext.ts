/**
 * The selected-service context for the public page (provider: LandingIntent.tsx). Presentation state only; a safe
 * default lets every section render on its own.
 */
import { createContext, useContext } from "react";
import type { ServiceIntentId } from "@/lib/commercial/serviceIntent";

export const DEFAULT_SERVICE: ServiceIntentId = "prepare-review";

export interface LandingIntentValue {
  readonly service: ServiceIntentId;
  readonly setService: (id: ServiceIntentId) => void;
}

export const LandingIntentContext = createContext<LandingIntentValue>({ service: DEFAULT_SERVICE, setService: () => undefined });

export function useLandingIntent(): LandingIntentValue {
  return useContext(LandingIntentContext);
}
