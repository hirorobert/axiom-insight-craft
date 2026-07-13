/**
 * WorkspaceContext — shared workspace data for all engine pages.
 * Provided by WorkspaceLayout, consumed by every workspace child.
 */

import { createContext, useContext } from "react";
import type { UseWorkspaceDataReturn } from "@/hooks/useWorkspaceData";

export type WorkspaceContextValue = UseWorkspaceDataReturn;

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used inside WorkspaceLayout");
  }
  return ctx;
}
