import { useActivity } from "@/components/feedback/useActivity";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, LogOut, User } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface AccountIdentity { name?: string | null; email?: string | null }

/** Caller identity is never inferred from a workspace owner. */
export function AccountUserMenu({ identity, onSignOut }: { identity?: AccountIdentity; onSignOut: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useActivity(busy, "Signing out…");
  const name = identity?.name?.trim() || identity?.email || "Your account";
  const initial = (identity?.name?.trim() || identity?.email || "A").slice(0, 1).toUpperCase();
  return <DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger asChild><Button ref={trigger} variant="ghost" className="h-9 gap-2 px-1 sm:px-2" aria-label="Account menu">
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">{initial}</span>
    <span className="hidden max-w-40 truncate text-[13px] sm:inline">{name}</span><ChevronDown className="h-3 w-3" aria-hidden="true" />
  </Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64"
      onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }}>
      <DropdownMenuLabel className="break-words font-medium">{name}{identity?.email && <span className="mt-1 block break-all text-xs font-normal text-muted-foreground">{identity.email}</span>}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild><Link to="/settings?section=profile"><User className="mr-2 h-4 w-4" />Profile</Link></DropdownMenuItem>
      <DropdownMenuItem disabled={busy} data-testid="account-sign-out" onSelect={(e) => { e.preventDefault(); if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(false); void Promise.resolve().then(onSignOut).catch(() => setError(true)).finally(() => { inFlight.current = false; setBusy(false); }); }}>
        <LogOut className="mr-2 h-4 w-4" />{busy ? "Signing out…" : "Sign out"}
      </DropdownMenuItem>
      {error && <p role="alert" className="p-2 text-xs text-destructive">Could not sign out. Try again.</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
