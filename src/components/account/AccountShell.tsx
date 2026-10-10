/**
 * AccountShell — the ONE navigation frame for a signed-in person outside a workspace: the account home (/dashboard),
 * /plans, /billing/checkout and /billing/orders. Signed out, the same pages keep the public Header and Footer (the
 * public header never appears for a signed-in account page, and the public footer's "Sign in" is never shown to
 * someone already signed in) — see AccountOrPublicFrame. This file depends on no session or client, so it renders anywhere.
 *
 * Navigation only: it decides nothing about plans, entitlements or companies. Every action reached from it is
 * re-checked by the server (RLS, create_entity, acquire_checkout_attempt).
 */
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";

/** "Home" is a text link from the sm breakpoint up; on a phone the logo (labelled "CFOClose home") is the home link, so the
 *  account links and Sign out fit at 320–375 px without a scroller. */
export const ACCOUNT_NAV: readonly { readonly to: string; readonly label: string; readonly wideOnly?: boolean }[] = [
  { to: "/dashboard", label: "Home", wideOnly: true },
  { to: "/plans", label: "Plans" },
  { to: "/billing/orders", label: "Orders" },
  { to: "/settings", label: "Settings" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-2 py-1.5 text-[13px] ${isActive ? "font-semibold text-foreground underline underline-offset-4" : "text-muted-foreground hover:text-foreground"}`;

/** The signed-in frame. The caller supplies sign-out (it owns the session). */
export function AccountShell({ children, onSignOut, mainClassName = "mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-5 sm:py-14" }: {
  children: ReactNode;
  onSignOut: () => void;
  mainClassName?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background" data-testid="account-shell">
      <a href="#account-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:text-sm">
        Skip to content
      </a>
      <header className="flex h-14 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
        <Link to="/dashboard" aria-label="CFOClose home" className="shrink-0"><CFOCloseWordmark className="text-lg" /></Link>
        {/* The links scroll if the screen is very narrow; Sign out never scrolls out of view. `relative` on the button is the
            containing block of its screen-reader label (absolutely positioned), which would otherwise widen the page. */}
        <nav aria-label="Account" className="flex min-w-0 items-center gap-1 sm:gap-2">
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-2">
            {ACCOUNT_NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end className={(a) => `${linkClass(a)}${n.wideOnly ? " hidden sm:inline" : ""}`}>{n.label}</NavLink>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={onSignOut} className="relative h-8 shrink-0 rounded-none px-2 text-[13px]" data-testid="account-sign-out">
            <LogOut className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Sign out</span>
          </Button>
        </nav>
      </header>
      <main id="account-main" tabIndex={-1} className={mainClassName}>{children}</main>
      <footer className="border-t border-border px-4 py-5 text-[12px] text-muted-foreground sm:px-6">
        <nav aria-label="Help and legal" className="flex flex-wrap gap-x-4 gap-y-1">
          <Link to="/contact" className="hover:text-foreground">Contact</Link>
          <Link to="/privacy" className="hover:text-foreground">Privacy Policy</Link>
          <Link to="/terms" className="hover:text-foreground">Terms of Service</Link>
        </nav>
      </footer>
    </div>
  );
}
