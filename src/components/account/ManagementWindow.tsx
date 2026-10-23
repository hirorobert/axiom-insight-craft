import { TaskNavigationProtection } from "./TaskNavigationProtection";
import { TaskEditContext, TaskEditProvider } from "./taskEditState";
import { settingsWorkspace } from "@/lib/workspace/settingsContinuity";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBeforeUnload, useBlocker, useLocation, useNavigate, type Location } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { Building2, CreditCard, FileText, ShieldCheck, User, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { AccountShell } from "./AccountShell";
import { ManagementLink } from "./ManagementNavigation";
import { ManagementContext, managementFocusTarget, managementOrigin, isManagementPath, type EditState } from "./managementState";

const ITEMS = [
  { to: "/settings?section=profile", key: "profile", label: "Profile", icon: User },
  { to: "/settings?section=firm", key: "firm", label: "Practice & team", icon: Users },
  { to: "/settings?section=companies", key: "companies", label: "Companies", icon: Building2 },
  { to: "/settings?section=billing", key: "billing", label: "Plan & billing", icon: CreditCard },
  { to: "/plans", key: "plans", label: "View plans", icon: CreditCard },
  { to: "/settings/billing", key: "orders", label: "Orders & receipts", icon: FileText },
  { to: "/settings?section=security", key: "security", label: "Security & activity", icon: ShieldCheck },
];


function ManagementWindow({ origin, children }: { origin: Location | null; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const editSnapshot = useRef<Record<string, EditState>>({});
  const register = useCallback((id: string, state: EditState | null) => {
    const previous = editSnapshot.current;
    if (state && previous[id]?.dirty === state.dirty && previous[id]?.busy === state.busy) return;
    if (!state && !previous[id]) return;
    const next = { ...previous }; if (state) next[id] = state; else delete next[id];
    // A confirmed save may return in the same effect flush as its clean registration.
    // The blocker must observe that registration synchronously, before the UI rerenders.
    editSnapshot.current = next; setEdits(next);
  }, []);
  const task = useContext(TaskEditContext);
  const taskDirty = Object.values(task?.edits ?? {}).some((s) => s.dirty);
  const taskBusy = Object.values(task?.edits ?? {}).some((s) => s.busy);
  const ownDirty = Object.values(edits).some((s) => s.dirty);
  const ownBusy = Object.values(edits).some((s) => s.busy);
  const leavesTask = (next: Location) => !isManagementPath(next.pathname) && (!origin || next.pathname !== origin.pathname || next.search !== origin.search || next.hash !== origin.hash);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (Object.values(editSnapshot.current).some((s) => s.dirty || s.busy) || (leavesTask(nextLocation) && (taskDirty || taskBusy))) &&
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.key !== nextLocation.key));
  const guardingTask = blocker.state === "blocked" && leavesTask(blocker.location);
  const dirty = ownDirty || (guardingTask && taskDirty), busy = ownBusy || (guardingTask && taskBusy);
  useBeforeUnload(useCallback((event) => { if (ownDirty || ownBusy || taskDirty || taskBusy) { event.preventDefault(); event.returnValue = ""; } }, [ownDirty, ownBusy, taskDirty, taskBusy]));
  const close = () => navigate(origin ? `${origin.pathname}${origin.search}${origin.hash}` : "/dashboard", {
    replace: true, state: origin?.state ?? { forceHub: true }, preventScrollReset: true,
  });
  const items = settingsWorkspace(origin) ? [{ to: "/settings?section=engagement", key: "engagement", label: "Reporting period", icon: FileText }, ...ITEMS] : ITEMS;
  const active = location.pathname === "/plans" ? "plans" : location.pathname === "/settings/billing" ? "orders" : new URLSearchParams(location.search).get("section") ?? "profile";
  const context = useMemo(() => ({ origin, register }), [origin, register]);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo?.(0, 0); }, [location.pathname, location.search]);
  return <ManagementContext.Provider value={context}>
    <Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45" />
        <Dialog.Content className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background shadow-2xl focus:outline-none sm:inset-x-6 sm:inset-y-[5vh] sm:mx-auto sm:max-w-6xl sm:rounded-md sm:border sm:border-border"
          onPointerDownOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => {
            const remembered = managementFocusTarget();
            const trigger = remembered?.isConnected ? remembered : document.querySelector<HTMLElement>('[aria-label="Settings menu"], [data-management-trigger]');
            (trigger ?? document.querySelector<HTMLElement>("main"))?.focus();
          }); }}>
          <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-[#252b36] px-5 text-white sm:px-6">
            <div><Dialog.Title className="text-base font-semibold">Practice settings</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-white/75">Manage your account and practice. Close to return to your work.</Dialog.Description></div>
            <Dialog.Close asChild><button type="button" aria-label="Close practice settings" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"><X className="h-5 w-5" aria-hidden="true" /></button></Dialog.Close>
          </header>
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div className="shrink-0 border-b border-border p-3 sm:hidden"><label htmlFor="management-mobile-section" className="sr-only">Settings section</label><select id="management-mobile-section" value={items.some((item) => item.key === active) ? active : "profile"} className="h-11 w-full rounded-sm border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => { const item = items.find((entry) => entry.key === event.target.value); if (item) navigate(item.to, { state: { managementOrigin: origin } }); }}>{items.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
            <nav aria-label="Practice settings" className="hidden shrink-0 gap-1 overflow-y-auto border-r border-border bg-muted/25 p-3 sm:flex sm:w-52 sm:flex-col">
              {items.map(({ to, key, label, icon: Icon }) => <ManagementLink key={key} to={to} aria-current={active === key ? "page" : undefined}
                className={`flex min-h-11 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-sm px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === key ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon className="h-4 w-4" aria-hidden="true" />{label}</ManagementLink>)}
            </nav>
            <div ref={body} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:px-8" data-testid="management-body">{children}</div>
          </div>
          <footer className="shrink-0 border-t border-border bg-background px-5 py-3 sm:px-6">
            {blocker.state === "blocked" ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">{busy ? "A save is still in progress. Wait for its result before leaving." : dirty ? "You have unsaved changes. Discard them and continue?" : "The save has finished. Close the window or keep working."}</p>
              <div className="flex gap-2"><Button variant="outline" onClick={() => blocker.reset()}>Keep editing</Button>{!busy && dirty && <Button variant="destructive" onClick={() => { Object.values(edits).forEach((edit) => edit.discard?.()); if (guardingTask) Object.values(task?.edits ?? {}).forEach((edit) => edit.discard?.()); blocker.proceed(); }}>Discard changes</Button>}</div>
            </div> : <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground" role="status">{busy ? "Saving changes…" : dirty ? "Unsaved changes" : "Close to return to your work."}</p><Dialog.Close asChild><Button variant="outline">Close</Button></Dialog.Close></div>}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </ManagementContext.Provider>;
}

/** Background Routes keep the actual workspace mounted. Public plan discovery remains a normal public page. */
export function ManagementRouter({ children }: { children: (location?: Location) => ReactNode }) {
  return <TaskEditProvider><ManagementRoutes>{children}</ManagementRoutes></TaskEditProvider>;
}
function ManagementRoutes({ children }: { children: (location?: Location) => ReactNode }) {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const previousOrigin = useRef<Location | null>(null);
  const active = !!user && isManagementPath(location.pathname);
  const supplied = managementOrigin((location.state as { managementOrigin?: unknown } | null)?.managementOrigin);
  const origin = active ? supplied ?? previousOrigin.current : null;
  useEffect(() => { previousOrigin.current = active ? origin : null; }, [active, origin]);
  return <>
    {!active && <TaskNavigationProtection />}
    {!active ? children(location) : origin ? children(origin) : <AccountShell onSignOut={async () => { await signOut(); navigate("/auth", { replace: true }); }} identity={{ name: user?.user_metadata?.display_name, email: user?.email }}><h1 className="text-2xl font-semibold">Your practice</h1><p className="mt-2 text-sm text-muted-foreground">Close settings to open your engagements.</p></AccountShell>}
    {active && <ManagementWindow origin={origin}>{children(location)}</ManagementWindow>}
  </>;
}
