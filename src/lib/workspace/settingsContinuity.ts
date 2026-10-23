import type { Location } from "react-router-dom";
/** Same-app navigation identity only. Settings never accept a different company from a query override. */
export function settingsWorkspace(origin: Location | null) {
  const m = origin?.pathname.match(/^\/workspace\/([^/]+)\/(\d{4})(?:\/|$)/);
  const year = m ? Number(m[2]) : 0;
  return m && year >= 2000 && year <= 2100 ? { companyId: m[1], periodYear: year } : null;
}
export const WORKSPACE_SETTINGS_SAVED = "cfoclose:workspace-settings-saved";
export function settingsSaved(companyId: string) {
  // Invalidation only: no values or progress are carried; every listener re-reads its existing authority.
  window.dispatchEvent(new CustomEvent(WORKSPACE_SETTINGS_SAVED, { detail: { companyId } }));
}
