/**
 * /admin/enquiries — the platform-staff triage queue.
 *
 * This route is a SCREEN, not a security boundary: authorization is enforced by the database. Every read and write is a
 * staff_* function that refuses (42501) anyone who is not ACTIVE platform staff — an ordinary company owner or administrator
 * is not platform staff, and gets the permission-denied state below with NO data fetched. Filters live in the URL so a view
 * can be shared and survives a refresh. Notification state is shown separately from enquiry status.
 */

import { useMemo } from "react";
import NotFound from "@/pages/NotFound";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Inbox, Loader2, RefreshCw, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { jurisdictionName } from "@/lib/jurisdiction/registry";
import { QueueError, SERVICE_LABELS, PAGE_SIZE, fetchStaffRole, listEnquiries, parseQueueFilters, retryPendingNotifications, toSearchParams, type QueueFilters, type QueueRow } from "@/lib/serviceEnquiry/staffQueue";
import { SERVICE_CODES } from "@/lib/serviceEnquiry/contract";
import { QueueFiltersPanel } from "@/components/enquiry/queue/QueueFilters";
import { EnquiryDetailSheet } from "@/components/enquiry/queue/EnquiryDetailSheet";
import { NotificationChip, StatusBadge } from "@/components/enquiry/queue/StatusBadge";

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

const serviceLabel = (code: string): string => {
  const known = SERVICE_CODES.find((c) => c === code);
  return known ? SERVICE_LABELS[known] : code;
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="ghost" size="sm" asChild className="min-h-11 gap-2">
            <Link to="/dashboard">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Dashboard
            </Link>
          </Button>
          <h1 className="text-lg font-semibold text-foreground">Enquiry queue</h1>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

function StateCard({ icon, title, body, testId, action, alert }: { icon: React.ReactNode; title: string; body: string; testId: string; action?: React.ReactNode; alert?: boolean }) {
  return (
    <div className="mx-auto max-w-lg rounded-lg border border-border bg-card p-8 text-center" data-testid={testId} role={alert ? "alert" : "status"}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center text-muted-foreground">{icon}</div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function QueueRowItem({ row, selected, onOpen }: { row: QueueRow; selected: boolean; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className="grid w-full min-h-11 grid-cols-1 gap-x-4 gap-y-1 border-b border-border px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[9rem_minmax(0,1.4fr)_minmax(0,1fr)_9rem_10rem]"
        data-testid="queue-row"
      >
        <span className="font-mono text-sm font-semibold text-foreground">{row.public_reference}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-foreground">{row.requester_name}</span>
          <span className="block truncate text-xs text-muted-foreground">{row.requester_email}{row.organization ? ` · ${row.organization}` : ""}</span>
        </span>
        <span className="min-w-0 text-sm text-muted-foreground">
          <span className="block truncate">{serviceLabel(row.service_code)}</span>
          <span className="block truncate text-xs">{row.country_code ? jurisdictionName(row.country_code) : "No country"}</span>
        </span>
        <span><StatusBadge status={row.status} /></span>
        <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>{when(row.submitted_at)}</span>
          <NotificationChip label="Ack" state={row.acknowledgement} />
          <NotificationChip label="Internal" state={row.staff_notification} />
        </span>
      </button>
    </li>
  );
}

/** Behind the `service_enquiry_phase1` gate: while it is OFF the queue never mounts, so no staff query is ever issued. */
export default function EnquiryQueue() {
  return SERVICE_ENQUIRY_SURFACES.staffQueueRoute ? <EnquiryQueueScreen /> : <NotFound />;
}

function EnquiryQueueScreen() {
  const { user, loading: authLoading } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseQueueFilters(params), [params]);
  const update = (next: QueueFilters) => setParams(toSearchParams(next));

  const role = useQuery({ queryKey: ["staff-role", user?.id], queryFn: fetchStaffRole, enabled: Boolean(user), retry: false });
  const listKey = toSearchParams({ ...filters, id: null }).toString();
  const list = useQuery({
    queryKey: ["enquiry-list", listKey],
    queryFn: () => listEnquiries(filters),
    enabled: Boolean(role.data),
    retry: false,
    placeholderData: keepPreviousData,
  });

  const retry = useMutation({
    mutationFn: retryPendingNotifications,
    onSuccess: (t) => {
      toast.success(t.blocked > 0 ? `Email delivery is not configured for ${t.blocked} pending notification(s); they remain queued.` : `Notifications processed: ${t.sent} sent, ${t.retry} to retry, ${t.failed} failed.`);
      void list.refetch();
    },
    onError: () => toast.error("Could not process notifications."),
  });

  if (authLoading || (user && role.isPending)) {
    return (
      <Shell>
        <div className="space-y-3" role="status" aria-label="Loading">
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <StateCard testId="queue-signin" icon={<ShieldOff className="h-6 w-6" aria-hidden="true" />} title="Sign in required" body="The enquiry queue is for CFOClose platform staff. Please sign in to continue." action={<Button asChild><Link to="/auth">Sign in</Link></Button>} />
      </Shell>
    );
  }

  const forbidden = role.isError && role.error instanceof QueueError && role.error.kind === "forbidden";
  if (forbidden || (role.isSuccess && role.data === null)) {
    return (
      <Shell>
        <StateCard testId="queue-permission-denied" alert icon={<ShieldOff className="h-6 w-6" aria-hidden="true" />} title="You do not have access to this page" body="The enquiry queue is available to CFOClose platform staff only. Being an owner or administrator of a company does not grant platform access." action={<Button asChild variant="outline"><Link to="/dashboard">Back to dashboard</Link></Button>} />
      </Shell>
    );
  }

  if (role.isError) {
    return (
      <Shell>
        <StateCard testId="queue-role-error" alert icon={<RefreshCw className="h-6 w-6" aria-hidden="true" />} title="We could not check your access" body="Please try again." action={<Button variant="outline" onClick={() => void role.refetch()}>Try again</Button>} />
      </Shell>
    );
  }

  const data = list.data;
  const total = data?.total ?? 0;
  const first = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, filters.page * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Shell>
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside>
          <QueueFiltersPanel filters={filters} onChange={update} />
        </aside>

        <section aria-label="Enquiries" className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="queue-count">
              {list.isPending ? "Loading enquiries…" : total === 0 ? "No enquiries" : `Showing ${first}–${last} of ${total}`}
            </p>
            <Button type="button" variant="outline" className="min-h-11" disabled={retry.isPending} onClick={() => retry.mutate()}>
              {retry.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Retry pending notifications
            </Button>
          </div>

          {list.isPending && (
            <div className="space-y-2" role="status" aria-label="Loading enquiries">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}

          {list.isError && (
            <StateCard testId="queue-error" alert icon={<RefreshCw className="h-6 w-6" aria-hidden="true" />} title="We could not load the queue" body="Please try again." action={<Button variant="outline" onClick={() => void list.refetch()}>Try again</Button>} />
          )}

          {data && data.rows.length === 0 && (
            <StateCard testId="queue-empty" icon={<Inbox className="h-6 w-6" aria-hidden="true" />} title="No enquiries match" body="Nothing matches these filters yet. Adjust or clear the filters to see more." />
          )}

          {data && data.rows.length > 0 && (
            <>
              <div className="hidden grid-cols-[9rem_minmax(0,1.4fr)_minmax(0,1fr)_9rem_10rem] gap-x-4 border-b border-border px-3 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid" aria-hidden="true">
                <span>Reference</span>
                <span>Requester</span>
                <span>Service</span>
                <span>Status</span>
                <span>Received / email</span>
              </div>
              <ul className="rounded-lg border border-border bg-card md:rounded-none md:border-x-0 md:border-t-0" data-testid="queue-list" aria-busy={list.isFetching}>
                {data.rows.map((row) => (
                  <QueueRowItem key={row.id} row={row} selected={filters.id === row.id} onOpen={() => update({ ...filters, id: row.id })} />
                ))}
              </ul>
              <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3">
                <Button type="button" variant="outline" className="min-h-11" disabled={filters.page <= 1} onClick={() => update({ ...filters, page: filters.page - 1, id: null })}>
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {filters.page} of {pages}
                </span>
                <Button type="button" variant="outline" className="min-h-11" disabled={filters.page >= pages} onClick={() => update({ ...filters, page: filters.page + 1, id: null })}>
                  Next
                </Button>
              </nav>
            </>
          )}
        </section>
      </div>

      {filters.id && <EnquiryDetailSheet key={filters.id} id={filters.id} onClose={() => update({ ...filters, id: null })} />}
    </Shell>
  );
}
