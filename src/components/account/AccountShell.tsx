/** Shared signed-in frame. Presentation only; permissions remain server-owned. */
import { useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Building2, HelpCircle, LayoutGrid, Menu, Settings, Users, CreditCard } from "lucide-react";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { channel, mailtoHref } from "@/lib/contact/contactChannels";
import { AccountUserMenu, type AccountIdentity } from "./AccountUserMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const ACCOUNT_NAV = [
  { to: "/dashboard", label: "Engagements", icon: LayoutGrid },
  { to: "/settings?section=companies", label: "Companies", icon: Building2 },
] as const;
const REPORTING_STEPS = ["Company setup", "Trial Balance", "Close Review", "Financial Statements", "Sign-off & export"] as const;

function AccountRail({ setup = false, onNavigate }: { setup?: boolean; onNavigate?: () => void }) {
  const { pathname, search } = useLocation();
  return <div className="flex h-full flex-col px-3 py-5">
    <nav aria-label="Account navigation" className="space-y-1">
      {ACCOUNT_NAV.map(({ to, label, icon: Icon }) => {
        const active = !setup && (to === "/dashboard" ? pathname === "/dashboard" : pathname === "/settings" && new URLSearchParams(search).get("section") === "companies");
        return <Link key={to} to={to} onClick={onNavigate} state={to === "/dashboard" ? { forceHub: true } : undefined} aria-current={active ? "page" : undefined} className={`account-rail-link ${active ? "account-rail-link-active" : ""}`}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{label}
        </Link>;
      })}
    </nav>
    <div className="mt-6 border-t border-white/15 pt-5">
      <p className="px-3 text-xs font-medium text-white/75">Reporting workflow</p>
      <ol className="mt-3 space-y-1" aria-label="Reporting workflow">
        {REPORTING_STEPS.map((label, i) => <li key={label} aria-current={setup && i === 0 ? "step" : undefined}
          className={`flex items-center gap-3 rounded-sm px-3 py-2.5 text-[13px] ${setup && i === 0 ? "bg-white/10 font-medium text-white" : "text-white/80"}`}>
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${setup && i === 0 ? "bg-primary text-primary-foreground ring-2 ring-white/30" : "bg-white/65 text-slate-900"}`}>{i + 1}</span>{label}
        </li>)}
      </ol>
      <p className="mt-4 px-3 text-xs leading-5 text-white/70">{setup ? "Set up the company and its reporting period to begin." : "Choose an engagement to see its progress."}</p>
    </div>
    <div className="mt-auto border-t border-white/15 pt-4"><Link to="/contact" onClick={onNavigate} className="account-rail-link"><HelpCircle className="h-4 w-4" aria-hidden="true" />Help & support</Link></div>
  </div>;
}

export function AccountShell({ children, onSignOut, mainClassName = "w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-7", identity, setup = false }: {
  children: ReactNode; onSignOut: () => void | Promise<void>; mainClassName?: string; identity?: AccountIdentity; setup?: boolean;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  return <div className="flex min-h-screen flex-col bg-background" data-testid="account-shell">
    <a href="#account-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:bg-background focus:p-3">Skip to content</a>
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation"><Menu className="h-5 w-5" /></Button></SheetTrigger>
          <SheetContent side="left" className="account-rail w-64 border-0 p-0 pt-8"><SheetTitle className="sr-only">Navigation</SheetTitle><SheetDescription className="sr-only">Choose an account page or reporting workspace.</SheetDescription><AccountRail setup={setup} onNavigate={() => setNavigationOpen(false)} /></SheetContent></Sheet>
        <Link to="/dashboard" state={{ forceHub: true }} aria-label="CFOClose home" className="shrink-0"><CFOCloseWordmark className="text-lg" /></Link>
        <span className="hidden border-l border-border pl-5 text-[13px] font-medium text-muted-foreground lg:block">Your practice</span>
      </div>
      <nav aria-label="Account" className="flex shrink-0 items-center gap-2 sm:gap-4">
        <DropdownMenu open={settingsOpen} onOpenChange={setSettingsOpen}><DropdownMenuTrigger asChild><Button ref={settingsTrigger} variant="ghost" size="sm" className="gap-2 px-2" aria-label="Settings menu"><Settings className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Settings</span></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56"
            onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSettingsOpen(false); } }}
            onCloseAutoFocus={(event) => { event.preventDefault(); settingsTrigger.current?.focus(); }}><DropdownMenuLabel>Practice settings</DropdownMenuLabel><DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link to="/settings"><Settings className="mr-2 h-4 w-4" />All settings</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/settings?section=companies"><Building2 className="mr-2 h-4 w-4" />Companies</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/settings?section=firm"><Users className="mr-2 h-4 w-4" />Firm & team</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/settings?section=billing"><CreditCard className="mr-2 h-4 w-4" />Plan & billing</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/plans">View plans</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/settings/billing">Orders & receipts</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AccountUserMenu identity={identity} onSignOut={onSignOut} />
      </nav>
    </header>
    <div className="flex flex-1">
      <aside className="account-rail sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[224px] shrink-0 md:block"><AccountRail setup={setup} /></aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <main id="account-main" tabIndex={-1} className={mainClassName}>{children}</main>
        <footer className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground sm:px-6"><nav aria-label="Help and legal" className="flex flex-wrap gap-x-5 gap-y-2">
          <a href={mailtoHref("support")} className="inline-block py-1" data-testid="account-support-email" aria-label={`Support: email ${channel("support").address}`}>{channel("support").address}</a>
          <Link to="/privacy">Privacy Policy</Link><Link to="/terms">Terms of Service</Link>
        </nav></footer>
      </div>
    </div>
  </div>;
}
