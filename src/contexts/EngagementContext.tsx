/**
 * EngagementContext — the mandate layer, kept separate from workspace data.
 *
 * Workflow truth (WorkspaceContext) and mandate truth (this context) are
 * orthogonal by construction: neither can overwrite the other.
 */

import { createContext, useContext } from "react";
import type { UseEngagementMandateReturn } from "@/hooks/useEngagementMandate";
import type { WorkspaceMissionView } from "@/lib/workspace/mandate";

export interface EngagementContextValue extends UseEngagementMandateReturn {
  /** Engine mission state composed with the mandate. Never mutated in place. */
  missionViews: WorkspaceMissionView[];
}

export const EngagementContext = createContext<EngagementContextValue | null>(null);

export function useEngagement(): EngagementContextValue {
  const ctx = useContext(EngagementContext);
  if (!ctx) throw new Error("useEngagement must be used inside WorkspaceLayout");
  return ctx;
}