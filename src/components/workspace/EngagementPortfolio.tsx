import { useActivity } from "@/components/feedback/useActivity";
import { PendingStatus } from "@/components/feedback/Activity";
/**
 * EngagementPortfolio — the engagements list, read page by page from the server (portfolioClient).
 *
 * Quiet by design: one primary action ("Upload trial balance"), a search box and three plain filters (status, purpose,
 * period) with a sort, then the list. Status is a word with an icon; colour only reinforces it. Each row offers the one
 * next action for its status. Paging is server-side (keyset): Previous and Next walk the pages; the page count line says
 * exactly how many engagements match. When the server's view token changes between pages, the list says so and offers
 * Refresh — it never silently mixes two different moments.
 */
import type React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCw, Search, Upload, XCircle, Columns3 } from "lucide-react";
import { readPortfolioFrameworks } from "@/lib/workspace/portfolioFrameworks";
import { FRAMEWORK_OPTIONS } from "@/lib/workspace/frameworkOptions";
const frameworkName = (value: string | null) => FRAMEWORK_OPTIONS.find((f) => f.value === value)?.label;
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  PORTFOLIO_PAGE_SIZE, PORTFOLIO_PURPOSES, PORTFOLIO_PURPOSE_LABEL, PORTFOLIO_STATUSES, PORTFOLIO_STATUS_VIEW, fetchPortfolioPage, portfolioDestination,
  type PortfolioCursor, type PortfolioPurpose, type PortfolioQuery, type PortfolioRow, type PortfolioSort, type PortfolioStatus,
} from "@/lib/workspace/portfolioClient";

type Rpc = Parameters<typeof fetchPortfolioPage>[0];
// The client is loaded on first use, so importing this list never constructs it (pages and tests that render the hub
// without a browser session stay free of it).
const supabaseRpc: Rpc = async (fn, args) => {
  const { supabase } = await import("@/integrations/supabase/client");
  return (supabase.rpc as unknown as (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>)(fn, args);
};

const TONE_ICON = {
  danger: <XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />,
  success: <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />,
  progress: <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />,
  neutral: <CircleDashed className="h-4 w-4 text-muted-foreground" aria-hidden="true" />,
} as const;

function StatusChip({ status }: { status: PortfolioStatus }) {
  const v = PORTFOLIO_STATUS_VIEW[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-foreground" data-testid="portfolio-status" data-status={status}>
      {TONE_ICON[v.tone]}{v.label}
    </span>
  );
}

const dateTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const periodWords = (r: PortfolioRow) => (r.periodStart && r.periodEnd
  ? `${new Date(r.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} – ${new Date(r.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
  : `FY${r.periodYear}`);

function UploadCell({ row }: { row: PortfolioRow }) {
  if (!row.upload) return <span className="text-muted-foreground">No upload yet</span>;
  return (
    <span className="block min-w-0">
      <span className="block truncate text-foreground" title={row.upload.fileName}>{row.upload.fileName}</span>
      <span className="block text-[12px] text-muted-foreground">{dateTime(row.upload.uploadedAt)} · {row.upload.uploadedBy ?? "Uploader not recorded"}</span>
    </span>
  );
}

export function EngagementPortfolio({ onUpload, headingLevel = "h1", title = "Engagements", uploadHref, renderEntityOptions, compactHeader = false, readFrameworks = readPortfolioFrameworks, rpc = supabaseRpc }: {
  /** Omitted where the page already offers the upload as its one primary action. */
  onUpload?: () => void;
  /** A quiet link to the focused upload page (used where the page has another primary action). */
  uploadHref?: string;
  headingLevel?: "h1" | "h2";
  compactHeader?: boolean;
  readFrameworks?: typeof readPortfolioFrameworks;
  title?: string;
  /** Per-row entity options (e.g. recording the workspace purpose), shown under the entity name. */
  renderEntityOptions?: (row: PortfolioRow) => React.ReactNode;
  /** The server call; tests pass their own. */
  rpc?: Rpc;
}) {
  const Heading = headingLevel;
  const [frameworks, setFrameworks] = useState<Record<string, string | null>>({});
  const [showUpload, setShowUpload] = useState(false);
  const [showCurrency, setShowCurrency] = useState(false);
  const ids = { search: useId(), status: useId(), purpose: useId(), year: useId(), sort: useId(), heading: useId() };
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState<PortfolioQuery>({ search: "", statuses: [], purposes: [], periodYear: null, sort: "entity" });
  // pages[i] is the cursor that loads page i (page 0: null); the token is the first page's.
  const [pageIndex, setPageIndex] = useState(0);
  const cursors = useRef<(PortfolioCursor | null)[]>([null]);
  const firstToken = useRef<string | null>(null);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; rows: PortfolioRow[]; total: number; counts: Partial<Record<PortfolioStatus, number>>; hasNext: boolean }
    | { kind: "changed" }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  useActivity(state.kind === "loading", "Loading engagements…");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);

  // Search is applied after a short pause in typing (one request, not one per key).
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => (q.search === searchText ? q : { ...q, search: searchText })), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const load = useCallback(async (index: number, fresh: boolean) => {
    const mine = ++seq.current;
    setState({ kind: "loading" });
    if (fresh) { cursors.current = [null]; firstToken.current = null; }
    const page = await fetchPortfolioPage(rpc, query, cursors.current[index] ?? null).catch(() => ({ kind: "unavailable" as const }));
    if (mine !== seq.current) return;
    if (page.kind !== "ok") {
      setState({ kind: "error", message: page.kind === "refused" ? "That filter could not be applied. Clear the filters and try again." : "The engagements could not be loaded. Check your connection and try again." });
      return;
    }
    if (index === 0) firstToken.current = page.viewToken;
    else if (firstToken.current !== page.viewToken) { setState({ kind: "changed" }); return; }
    cursors.current[index + 1] = page.nextCursor;
    setFrameworks({});
    setPageIndex(index);
    setState({ kind: "ok", rows: page.rows, total: page.total, counts: page.statusCounts, hasNext: page.nextCursor !== null });
    // Supplementary labels never delay or prevent access to the server-authoritative list.
    const metadata = await readFrameworks(page.rows.map((r) => r.companyId)).catch(() => ({}));
    if (mine === seq.current) setFrameworks(metadata);
  }, [query, rpc, readFrameworks]);

  useEffect(() => { void load(0, true); return () => { ++seq.current; }; }, [load]);

  const go = (index: number) => { void load(index, false).then(() => headingRef.current?.focus()); };
  const setFilter = (patch: Partial<PortfolioQuery>) => setQuery((q) => ({ ...q, ...patch }));
  const counts = state.kind === "ok" ? state.counts : {};
  const countOf = (s: PortfolioStatus) => counts[s] ?? 0;
  const statusValue = query.statuses[0] ?? "";
  const purposeValue = query.purposes[0] ?? "";
  const range = useMemo(() => {
    if (state.kind !== "ok" || state.total === 0) return null;
    const from = pageIndex * PORTFOLIO_PAGE_SIZE + 1;
    return { from, to: from + state.rows.length - 1 };
  }, [state, pageIndex]);
  const select = "h-10 rounded-none border border-input bg-background px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <section aria-labelledby={ids.heading} className="space-y-3 rounded-sm border border-border bg-card p-3 sm:p-4" data-testid="engagement-portfolio">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading id={ids.heading} ref={headingRef} tabIndex={-1}
          className={compactHeader ? "text-sm font-medium text-muted-foreground outline-none" : headingLevel === "h1" ? "text-2xl font-semibold tracking-tight text-foreground outline-none" : "text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground outline-none"}>{title}</Heading>
        {onUpload && <Button onClick={onUpload} className="h-10 rounded-none" data-testid="portfolio-upload"><Upload className="mr-2 h-4 w-4" aria-hidden="true" />Upload trial balance</Button>}
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="ml-auto h-8 gap-2 rounded-sm"><Columns3 className="h-4 w-4" aria-hidden="true" />Columns</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuLabel>Additional columns</DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuCheckboxItem checked={showCurrency} onCheckedChange={setShowCurrency}>Currency</DropdownMenuCheckboxItem><DropdownMenuCheckboxItem checked={showUpload} onCheckedChange={setShowUpload}>Latest trial balance</DropdownMenuCheckboxItem></DropdownMenuContent>
        </DropdownMenu>
        {!onUpload && uploadHref && (
          <Link to={uploadHref} className="inline-flex h-10 items-center gap-2 border border-border px-3 text-[13px] font-medium hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="portfolio-upload-link">
            <Upload className="h-4 w-4" aria-hidden="true" />Upload trial balance</Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-[minmax(12rem,2fr)_repeat(4,minmax(0,1fr))]">
        <div className="relative col-span-2 xl:col-span-1">
          <label htmlFor={ids.search} className="sr-only">Search entity or identifier</label>
          <Search className="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input id={ids.search} type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} maxLength={100}
            placeholder="Search entity or identifier" className={`${select} w-full pl-8`} data-testid="portfolio-search" />
        </div>
        <div>
          <label htmlFor={ids.status} className="sr-only">Status</label>
          <select id={ids.status} value={statusValue} className={`${select} w-full`} data-testid="portfolio-filter-status"
            onChange={(e) => setFilter({ statuses: e.target.value ? [e.target.value as PortfolioStatus] : [] })}>
            <option value="">All statuses</option>
            {PORTFOLIO_STATUSES.map((s) => <option key={s} value={s}>{PORTFOLIO_STATUS_VIEW[s].label} ({countOf(s)})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={ids.purpose} className="sr-only">Purpose</label>
          <select id={ids.purpose} value={purposeValue} className={`${select} w-full`} data-testid="portfolio-filter-purpose"
            onChange={(e) => setFilter({ purposes: e.target.value ? [e.target.value as PortfolioPurpose] : [] })}>
            <option value="">All purposes</option>
            {PORTFOLIO_PURPOSES.map((p) => <option key={p} value={p}>{PORTFOLIO_PURPOSE_LABEL[p]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={ids.year} className="sr-only">Period year</label>
          <input id={ids.year} type="number" inputMode="numeric" min={1990} max={2100} placeholder="Period year" className={`${select} w-full`}
            value={query.periodYear ?? ""} data-testid="portfolio-filter-year"
            onChange={(e) => { const y = Number(e.target.value); setFilter({ periodYear: e.target.value && Number.isInteger(y) && y >= 1990 && y <= 2100 ? y : null }); }} />
        </div>
        <div>
          <label htmlFor={ids.sort} className="sr-only">Sort</label>
          <select id={ids.sort} value={query.sort} className={`${select} w-full`} data-testid="portfolio-sort"
            onChange={(e) => setFilter({ sort: e.target.value as PortfolioSort })}>
            <option value="entity">Sort: Entity name</option>
            <option value="period">Sort: Period, newest first</option>
            <option value="opened">Sort: Recently opened</option>
          </select>
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground" aria-live="polite" data-testid="portfolio-count">
        {state.kind === "loading" ? "Loading engagements…"
          : state.kind === "ok" ? (state.total === 0 ? "No engagements match." : `Showing ${range!.from}–${range!.to} of ${state.total} engagement${state.total === 1 ? "" : "s"}`)
          : ""}
      </p>

      {state.kind === "loading" && <PendingStatus label="Loading engagements…" skeleton />}
      {state.kind === "changed" && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 border border-border px-4 py-3 text-[13px]" data-testid="portfolio-changed">
          <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden="true" />This list changed while you were paging.</span>
          <Button variant="outline" className="h-9 rounded-none" onClick={() => void load(0, true)} data-testid="portfolio-refresh">Refresh</Button>
        </div>
      )}
      {state.kind === "error" && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-destructive/40 px-4 py-3 text-[13px]" data-testid="portfolio-error">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />{state.message}</span>
          <Button variant="outline" className="h-9 rounded-none" onClick={() => void load(0, true)}>Try again</Button>
        </div>
      )}

      {state.kind === "ok" && state.rows.length > 0 && (
        <>
          {/* Desktop: a table. Mobile: one card per engagement. */}
          <div className="hidden max-w-full overflow-x-auto rounded-sm border border-border md:block"><table className="hidden w-full min-w-[880px] border-collapse text-left text-[13px] md:table" data-testid="portfolio-table">
            <caption className="sr-only">Engagements, page {pageIndex + 1}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                <th scope="col" className="w-[22%] px-3 py-3 font-medium">Company</th>
                <th scope="col" className="px-3 py-3 font-medium">Framework</th>
                <th scope="col" className="py-2 pr-4 font-medium">Period</th>
                <th scope="col" className="px-3 py-3 font-medium">Purpose</th>
                {showCurrency && <th scope="col" className="px-3 py-3 font-medium">Currency</th>}
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                {showUpload && <th scope="col" className="px-3 py-3 font-medium">Latest trial balance</th>}
                <th scope="col" className="px-3 py-3 font-medium">Next action</th><th scope="col" className="px-2 py-3"><span className="sr-only">Company options</span></th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r) => (
                <tr key={r.engagementId} className="border-b border-border align-middle last:border-b-0 hover:bg-muted/20" data-testid={`portfolio-row-${r.engagementId}`}>
                  <td className="px-3 py-3">
                    <span className="block font-medium text-foreground">{r.companyName}</span>
                    <span className="block text-[12px] text-muted-foreground">{[r.companyCode, r.companyTin ? `Tax number ${r.companyTin}` : null].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{frameworks[r.companyId] === undefined ? "Unavailable" : frameworks[r.companyId] === null ? "Not declared" : frameworkName(frameworks[r.companyId]) ?? "Unrecognised"}</td>
                  <td className="px-3 py-3"><span className="block font-medium">FY{r.periodYear}</span><span className="block whitespace-nowrap text-xs text-muted-foreground">{periodWords(r)}</span></td>
                  <td className="px-3 py-3 text-xs">{PORTFOLIO_PURPOSE_LABEL[r.purpose]}</td>
                  {showCurrency && <td className="px-3 py-3">{r.currency ?? <span className="text-muted-foreground">Not set</span>}</td>}
                  <td className="px-3 py-3">{r.serviceWithheld ? <span className="text-[13px] text-muted-foreground" data-testid="portfolio-service-withheld">Service no longer offered</span> : <StatusChip status={r.status} />}</td>
                  {showUpload && <td className="max-w-[16rem] px-3 py-3"><UploadCell row={r} /></td>}
                  <td className="px-3 py-3 text-right">
                    {r.serviceWithheld ? null : <Link to={portfolioDestination(r)} className="inline-flex h-9 items-center whitespace-nowrap border border-border px-3 text-[13px] font-medium hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`portfolio-action-${r.engagementId}`}>
                      {PORTFOLIO_STATUS_VIEW[r.status].action}<span className="sr-only"> — {r.companyName}, FY{r.periodYear}</span>
                    </Link>}
                  </td>
                  <td className="px-2 py-3">{renderEntityOptions?.(r)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <ul className="grid grid-cols-1 gap-2 md:hidden" data-testid="portfolio-cards">
            {state.rows.map((r) => (
              <li key={r.engagementId} className="rounded-sm border border-border p-4">
                <div className="flex flex-col items-start justify-between gap-2 sm:flex-row">
                  <div className="min-w-0">
                    <p className="break-words font-medium text-foreground">{r.companyName}</p>
                    <p className="text-[12px] text-muted-foreground">{periodWords(r)} · {r.currency ?? "Currency not set"}</p>
                  </div>
                  {r.serviceWithheld ? <span className="text-[12px] text-muted-foreground">Service no longer offered</span> : <StatusChip status={r.status} />}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{frameworks[r.companyId] === undefined ? "Framework unavailable" : frameworkName(frameworks[r.companyId]) ?? "Framework not declared"} · {PORTFOLIO_PURPOSE_LABEL[r.purpose]}</div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[13px]"><UploadCell row={r} />{renderEntityOptions?.(r)}</div>
                {!r.serviceWithheld && <Link to={portfolioDestination(r)} className="mt-3 inline-flex h-10 w-full items-center justify-center border border-border text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {PORTFOLIO_STATUS_VIEW[r.status].action}<span className="sr-only"> — {r.companyName}, FY{r.periodYear}</span>
                </Link>}
              </li>
            ))}
          </ul>
          <nav aria-label="Engagement pages" className="flex items-center justify-between gap-3">
            <Button variant="outline" className="h-10 rounded-none" disabled={pageIndex === 0} onClick={() => go(pageIndex - 1)} data-testid="portfolio-previous">Previous</Button>
            <span className="text-[13px] text-muted-foreground">Page {pageIndex + 1}</span>
            <Button variant="outline" className="h-10 rounded-none" disabled={!state.hasNext} onClick={() => go(pageIndex + 1)} data-testid="portfolio-next">Next</Button>
          </nav>
        </>
      )}
    </section>
  );
}
