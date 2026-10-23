import { TaskEditContext } from "./taskEditState";
/** Ephemeral navigation and edit state. Never used for permissions or financial readiness. */
import { createContext, useCallback, useContext, useEffect, useId, useRef } from "react";
import type { Location } from "react-router-dom";

export type EditState = { dirty: boolean; busy: boolean; discard?: () => void };
export type ManagementState = {
  origin: Location | null;
  register: (id: string, state: EditState | null) => void;
};
export const ManagementContext = createContext<ManagementState | null>(null);
export const useManagementSurface = () => useContext(ManagementContext);

export function useManagementEditGuard(dirty: boolean, busy: boolean, discard?: () => void) {
  const surface = useManagementSurface();
  const task = useContext(TaskEditContext);
  const register = surface?.register ?? task?.register;
  const id = useId();
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => {
    register?.(id, { dirty, busy, discard: () => discardRef.current?.() });
    return () => register?.(id, null);
  }, [register, id, dirty, busy]);
  // Only the owning command may release this after confirmed success, before navigating.
  return useCallback(() => register?.(id, null), [register, id]);
}

export function isManagementPath(path: string) {
  return path === "/settings" || path === "/settings/billing" || path === "/plans";
}

let returnFocusTarget: HTMLElement | null = null;
export function rememberManagementFocus(target: HTMLElement | null) { returnFocusTarget = target; }
export function managementFocusTarget() { return returnFocusTarget; }

/** Only accept a same-app workspace origin. An arbitrary URL in history state cannot become a redirect. */
export function managementOrigin(value: unknown): Location | null {
  const o = value as Location | null;
  if (!o || typeof o.pathname !== "string" || !/^\/(dashboard|workspace\/[^/]+\/\d{4}(?:\/[^?#]*)?|upload|uploads\/status|companies\/new)$/.test(o.pathname)) return null;
  if (typeof o.search !== "string" || typeof o.hash !== "string" || typeof o.key !== "string") return null;
  return o;
}

