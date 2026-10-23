/** Route-backed links preserve the originating workspace without changing access authority. */
import { forwardRef } from "react";
import { Link, useLocation, type LinkProps } from "react-router-dom";
import { isManagementPath, rememberManagementFocus, useManagementSurface } from "./managementState";

/** Preserve the FIRST workspace across every tab and management subpage. Modified clicks stay ordinary links. */
export const ManagementLink = forwardRef<HTMLAnchorElement, LinkProps>(function ManagementLink({ state, onClick, ...props }, ref) {
  const location = useLocation();
  const surface = useManagementSurface();
  const origin = surface ? surface.origin : isManagementPath(location.pathname) ? null : location;
  return <Link {...props} ref={ref} onClick={(event) => {
    if (!surface && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      const menu = event.currentTarget.closest('[role="menu"]');
      const triggerId = menu?.getAttribute("aria-labelledby");
      rememberManagementFocus(triggerId ? document.getElementById(triggerId) : event.currentTarget);
    }
    onClick?.(event);
  }} state={{ ...state, managementOrigin: origin }} />;
});
