/**
 * AccountShell — the ONE navigation frame for a signed-in person outside a workspace: the account home (/dashboard),
 * /plans, /billing/checkout and /billing/orders. Signed out, the same pages keep the public Header and Footer (the
 * public header never appears for a signed-in account page, and the public footer's "Sign in" is never shown to
 * someone already signed in).
 *
 * Navigation only: it decides nothing about plans, entitlements or companies. Every action reached from it is
 * re-checked by the server (RLS, create_entity, acquire_checkout_attempt).
 */
import type { ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { useAuth } from "@/contexts/AuthContext";

export const ACCOUNT_NAV: readonly { readonly to: string; readonly label: string }[] = [
  { to: "/dashboard", label: "Home" },
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
        <nav aria-label="Account" className="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-2">
          {ACCOUNT_NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end className={linkClass}>{n.label}</NavLink>
          ))}
          <Button variant="ghost" size="sm" onClick={onSignOut} className="h-8 shrink-0 rounded-none px-2 text-[13px]" data-testid="account-sign-out">
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

/** A page reachable signed in or out: the account frame when signed in, the public frame otherwise. */
export function AccountOrPublicFrame({ children, publicMainClassName, accountMainClassName }: {
  children: ReactNode;
  publicMainClassName: string;
  accountMainClassName?: string;
}) {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  if (user) return <AccountShell mainClassName={accountMainClassName} onSignOut={() => { void signOut().then(() => navigate("/auth", { replace: true })); }}>{children}</AccountShell>;
  // While the session is being read, neither frame: no public "Sign in" flash for a signed-in person.
  if (loading) return <div className="min-h-screen bg-background"><main id="main-content" className={accountMainClassName ?? publicMainClassName}>{children}</main></div>;
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main id="main-content" className={publicMainClassName}>{children}</main>
      <Footer />
    </div>
  );
}
