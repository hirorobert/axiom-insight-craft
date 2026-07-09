// ============================================================
// UploadsStatusPanel — Iron Dome Nuclear Design · Diamond Grade
// Full uploads status page: search, filter, sort, retry,
// export CSV, live timestamps, expandable failure rows.
// ============================================================
import { useState, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Building2,
  FileSpreadsheet,
  Clock,
  AlertCircle,
  SortAsc,
  SortDesc,
  Filter,
  Loader2,
  Calendar,
} from "lucide-react";
import { CertUpload, fmtNum } from "./certification/types";
import { toast } from "sonner";

// ── Types ──────────────────────────────────────────────────────────────────
type Tone = "valid" | "blocked" | "review" | "processing";
type StatusFilter = "all" | "certified" | "blocked" | "review" | "processing";
type SortKey = "date_desc" | "date_asc" | "company" | "status";

// ── Helpers ────────────────────────────────────────────────────────────────
function toneFor(u: CertUpload): { tone: Tone; label: string } {
  if (
    u.is_valid === false ||
    u.status === "blocked" ||
    u.status === "error" ||
    u.status === "invalid"
  )
    return { tone: "blocked", label: "Blocked" };
  if (u.status === "needs_review") return { tone: "review",  label: "Review Required" };
  if (u.status === "complete" || u.is_valid === true) return { tone: "valid", label: "Certified" };
  return { tone: "processing", label: "Processing" };
}

const TONE_BADGE: Record<Tone, string> = {
  valid:      "bg-emerald-50 text-emerald-700 border-emerald-200",
  blocked:    "bg-red-50 text-red-700 border-red-200",
  review:     "bg-amber-50 text-amber-800 border-amber-200",
  processing: "bg-slate-100 text-slate-600 border-slate-200",
};
const TONE_ICON: Record<Tone, React.ReactNode> = {
  valid:      <CheckCircle className="w-3 h-3 text-emerald-600" />,
  blocked:    <XCircle    className="w-3 h-3 text-red-600"     />,
  review:     <AlertTriangle className="w-3 h-3 text-amber-600" />,
  processing: <Loader2   className="w-3 h-3 text-slate-500 animate-spin" />,
};

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function durationLabel(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return "—";
  const diff = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (isNaN(diff) || diff < 0) return "—";
  if (diff < 1000) return `${diff}ms`;
  if (diff < 60000) return `${(diff / 1000).toFixed(1)}s`;
  return `${Math.floor(diff / 60000)}m ${Math.floor((diff % 60000) / 1000)}s`;
}

// ── Main Component ─────────────────────────────────────────────────────────
interface Props {
  uploads: CertUpload[];
  selectedId: string | null;
  onSelect: (u: CertUpload) => void;
  onRefresh: () => Promise<void>;
}

export function UploadsStatusPanel({ uploads, selectedId, onSelect, onRefresh }: Props) {
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [dateFrom,     setDateFrom]     = useState("");
  const [dateTo,       setDateTo]       = useState("");
  const [sortBy,       setSortBy]       = useState<SortKey>("date_desc");
  const [retrying,     setRetrying]     = useState<Set<string>>(new Set());
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [showFilters,  setShowFilters]  = useState(false);

  // ── Filter + Sort ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return uploads
      .filter((u) => {
        if (q) {
          const hit =
            u.file_name.toLowerCase().includes(q) ||
            (u.company_name ?? "").toLowerCase().includes(q);
          if (!hit) return false;
        }
        if (statusFilter !== "all") {
          const { tone } = toneFor(u);
          if (statusFilter === "certified"  && tone !== "valid")      return false;
          if (statusFilter === "blocked"    && tone !== "blocked")     return false;
          if (statusFilter === "review"     && tone !== "review")      return false;
          if (statusFilter === "processing" && tone !== "processing")  return false;
        }
        if (dateFrom && new Date(u.uploaded_at) < new Date(dateFrom)) return false;
        if (dateTo) {
          const to = new Date(dateTo);
          to.setHours(23, 59, 59, 999);
          if (new Date(u.uploaded_at) > to) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "date_desc") return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
        if (sortBy === "date_asc")  return new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime();
        if (sortBy === "company")   return (a.company_name ?? "").localeCompare(b.company_name ?? "");
        if (sortBy === "status")    return toneFor(a).tone.localeCompare(toneFor(b).tone);
        return 0;
      });
  }, [uploads, search, statusFilter, dateFrom, dateTo, sortBy]);

  // ── Summary counts ───────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = { certified: 0, blocked: 0, review: 0, processing: 0 };
    for (const u of uploads) {
      const { tone } = toneFor(u);
      if (tone === "valid")      c.certified++;
      else if (tone === "blocked")    c.blocked++;
      else if (tone === "review")     c.review++;
      else                            c.processing++;
    }
    return c;
  }, [uploads]);

  // ── Retry ────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(async (u: CertUpload, e: React.MouseEvent) => {
    e.stopPropagation();
    if (retrying.has(u.id)) return;

    setRetrying((prev) => new Set(prev).add(u.id));
    toast.info(`Retrying: ${u.file_name}…`);

    try {
      await supabase
        .from("trial_balance_uploads")
        .update({ status: "processing", processing_result: null, accounting_errors: null, is_valid: null })
        .eq("id", u.id);

      const { error: fnErr } = await supabase.functions.invoke("process-trial-balance", {
        body: { uploadId: u.id },
      });
      if (fnErr) throw fnErr;

      // Live poll until terminal status
      const TERMINAL = new Set(["complete", "error", "blocked", "needs_review"]);
      const pollId = setInterval(async () => {
        const { data } = await supabase
          .from("trial_balance_uploads")
          .select("status, is_valid, processing_result, processed_at, accounting_errors, validation_report")
          .eq("id", u.id)
          .single();

        if (data && TERMINAL.has(data.status)) {
          clearInterval(pollId);
          setRetrying((prev) => { const s = new Set(prev); s.delete(u.id); return s; });
          await onRefresh();
          const { tone, label } = toneFor({ ...u, ...data } as CertUpload);
          if (tone === "valid")  toast.success(`✓ Re-processed: ${label}`);
          else if (tone === "blocked") toast.error(`✗ Still blocked after retry — check the file.`);
          else                   toast.warning(`⚠ ${label} — review accounts before proceeding.`);
        }
      }, 2000);

      // 90-second safety timeout
      setTimeout(() => {
        clearInterval(pollId);
        setRetrying((prev) => { const s = new Set(prev); s.delete(u.id); return s; });
        onRefresh();
      }, 90_000);
    } catch (err) {
      setRetrying((prev) => { const s = new Set(prev); s.delete(u.id); return s; });
      toast.error(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [retrying, onRefresh]);

  // ── Export CSV ───────────────────────────────────────────────────────────
  const handleExportCSV = useCallback(() => {
    const header = [
      "ID", "File Name", "Company", "Status", "Is Valid",
      "Uploaded At", "Processed At", "Processing Duration",
      "Total Accounts", "Auto Classified", "Error Count",
      "BS Equation Diff (TZS)", "Total Debits", "Total Credits",
    ].join(",");

    const rows = filtered.map((u) => {
      const vr      = u.processing_result?.validation_report;
      const tb      = vr?.tb_balance_check;
      const eq      = vr?.balance_sheet_equation;
      const summary = u.processing_result?.summary;
      const errors  = u.processing_result?.errors ?? [];
      const dur     = durationLabel(u.uploaded_at, u.processed_at);

      return [
        u.id,
        u.file_name,
        u.company_name ?? "",
        toneFor(u).label,
        u.is_valid ?? "",
        u.uploaded_at,
        u.processed_at ?? "",
        dur,
        summary?.total_accounts ?? "",
        summary?.auto_classified ?? "",
        errors.length,
        eq?.difference?.toFixed(2) ?? "",
        tb?.total_debits?.toFixed(2)  ?? "",
        tb?.total_credits?.toFixed(2) ?? "",
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });

    const csv  = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `kinga_uploads_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filtered.length} rows`);
  }, [filtered]);

  // ── Expand toggle ────────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  // ── Clear filters ────────────────────────────────────────────────────────
  const clearFilters = () => {
    setSearch(""); setStatusFilter("all"); setDateFrom(""); setDateTo("");
  };
  const hasActiveFilters = search || statusFilter !== "all" || dateFrom || dateTo;

  return (
    <div className="flex flex-col border border-border bg-card rounded-none overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Trial Balances
          </h2>
          <p className="text-[9px] font-mono text-muted-foreground/60 mt-0.5">
            {import.meta.env.VITE_GIT_SHA
              ? `SHA ${String(import.meta.env.VITE_GIT_SHA).slice(0, 7)}`
              : "dev"}
            {import.meta.env.VITE_BUILD_TIMESTAMP
              ? ` · ${new Date(String(import.meta.env.VITE_BUILD_TIMESTAMP)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost" size="sm"
            onClick={handleExportCSV}
            className="h-7 gap-1 text-[11px] px-2"
            title="Export visible rows as CSV"
          >
            <Download className="w-3 h-3" /> CSV
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={onRefresh}
            className="h-7 px-2"
            title="Refresh list"
          >
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* ── Summary strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 divide-x divide-border border-b border-border text-[10px]">
        {([
          ["Certified", counts.certified, "text-emerald-700 font-semibold"],
          ["Blocked",   counts.blocked,   "text-red-700 font-semibold"],
          ["Review",    counts.review,    "text-amber-700 font-semibold"],
          ["Running",   counts.processing,"text-slate-600"],
        ] as const).map(([label, count, cls]) => (
          <button
            key={label}
            onClick={() => setStatusFilter(
              statusFilter === label.toLowerCase() ? "all"
              : label === "Certified" ? "certified"
              : label === "Blocked"   ? "blocked"
              : label === "Review"    ? "review"
              : "processing"
            )}
            className="flex flex-col items-center py-2 hover:bg-muted/40 transition-colors"
          >
            <span className={cls}>{count}</span>
            <span className="text-muted-foreground mt-0.5">{label}</span>
          </button>
        ))}
      </div>

      {/* ── Search + filter toggle ──────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-border space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search file or company…"
              className="h-7 pl-6 text-[11px] pr-2"
            />
          </div>
          <Button
            variant={hasActiveFilters ? "default" : "outline"}
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
            className="h-7 gap-1 text-[11px] px-2 shrink-0"
          >
            <Filter className="w-3 h-3" />
            {hasActiveFilters ? "Active" : "Filter"}
          </Button>
        </div>

        {showFilters && (
          <div className="space-y-2 pt-1 pb-0.5">
            {/* Status */}
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="certified">Certified</SelectItem>
                <SelectItem value="blocked">Blocked</SelectItem>
                <SelectItem value="review">Review Required</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
              </SelectContent>
            </Select>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-1.5">
              <div className="relative">
                <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-7 pl-6 text-[11px]"
                  title="From date"
                />
              </div>
              <div className="relative">
                <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-7 pl-6 text-[11px]"
                  title="To date"
                />
              </div>
            </div>

            {/* Sort */}
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
              <SelectTrigger className="h-7 text-[11px]">
                <SelectValue placeholder="Sort by…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date_desc">Newest first</SelectItem>
                <SelectItem value="date_asc">Oldest first</SelectItem>
                <SelectItem value="company">Company A–Z</SelectItem>
                <SelectItem value="status">Status</SelectItem>
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Result count ───────────────────────────────────────────────── */}
      {filtered.length !== uploads.length && (
        <div className="px-4 py-1.5 text-[10px] text-muted-foreground bg-muted/20 border-b border-border">
          Showing {filtered.length} of {uploads.length} uploads
        </div>
      )}

      {/* ── Upload rows ─────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="px-4 py-10 text-center text-[11px] text-muted-foreground">
          No uploads match the current filters.
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-y-auto max-h-[calc(100vh-420px)]">
          {filtered.map((u) => (
            <UploadRow
              key={u.id}
              upload={u}
              selected={u.id === selectedId}
              isRetrying={retrying.has(u.id)}
              isExpanded={expanded.has(u.id)}
              onSelect={onSelect}
              onRetry={handleRetry}
              onToggleExpand={toggleExpand}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── UploadRow ──────────────────────────────────────────────────────────────
interface RowProps {
  upload: CertUpload;
  selected: boolean;
  isRetrying: boolean;
  isExpanded: boolean;
  onSelect: (u: CertUpload) => void;
  onRetry: (u: CertUpload, e: React.MouseEvent) => void;
  onToggleExpand: (id: string, e: React.MouseEvent) => void;
}

function UploadRow({
  upload: u,
  selected,
  isRetrying,
  isExpanded,
  onSelect,
  onRetry,
  onToggleExpand,
}: RowProps) {
  const { tone, label } = toneFor(u);
  const canRetry = (tone === "blocked") && !isRetrying;

  const vr      = u.processing_result?.validation_report;
  const tb      = vr?.tb_balance_check;
  const eq      = vr?.balance_sheet_equation;
  const summary = u.processing_result?.summary;
  const errors: Array<{ code: string; message: string }> = u.processing_result?.errors ?? [];
  const dur     = durationLabel(u.uploaded_at, u.processed_at);

  // Derive "processing started" from summary.processed_at (set by engine at start of STEP 10)
  const engineStartedAt: string | null =
    u.processing_result?.summary?.processed_at ?? null;

  return (
    <li>
      {/* Main row */}
      <button
        onClick={() => onSelect(u)}
        className={[
          "w-full text-left px-3 py-2.5 border-l-2 transition-colors",
          selected
            ? "border-l-foreground bg-muted/60"
            : "border-l-transparent hover:bg-muted/30",
          isRetrying ? "opacity-75" : "",
        ].join(" ")}
      >
        {/* Row top: badge + actions */}
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider shrink-0 ${TONE_BADGE[tone]}`}
          >
            {isRetrying ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : TONE_ICON[tone]}
            {isRetrying ? "Retrying…" : label}
          </span>

          <span className="flex-1" />

          {/* Retry button */}
          {canRetry && (
            <button
              onClick={(e) => onRetry(u, e)}
              title="Re-process this upload"
              className="flex items-center gap-0.5 text-[9.5px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5 hover:bg-blue-100 transition-colors"
            >
              <RotateCcw className="w-2.5 h-2.5" /> Retry
            </button>
          )}
          {isRetrying && (
            <span className="text-[9.5px] text-muted-foreground italic">live…</span>
          )}

          {/* Expand toggle */}
          <button
            onClick={(e) => onToggleExpand(u.id, e)}
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
            title="Show timestamps and details"
          >
            {isExpanded
              ? <ChevronDown  className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />}
          </button>
        </div>

        {/* File name */}
        <p className="mt-1 text-[11.5px] font-semibold text-foreground truncate leading-tight" title={u.file_name}>
          <FileSpreadsheet className="inline w-3 h-3 mr-1 text-muted-foreground" />
          {u.file_name}
        </p>

        {/* Company + date */}
        <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-muted-foreground">
          {u.company_name && (
            <span className="flex items-center gap-0.5 truncate max-w-[120px]">
              <Building2 className="w-2.5 h-2.5 shrink-0" />
              {u.company_name}
            </span>
          )}
          <span className="flex items-center gap-0.5 shrink-0">
            <Clock className="w-2.5 h-2.5" />
            {new Date(u.uploaded_at).toLocaleString("en-US", {
              month: "short", day: "numeric",
              hour: "2-digit", minute: "2-digit",
            })}
          </span>
        </div>

        {/* Dr / Cr summary */}
        {(tb?.total_debits || tb?.total_credits) && (
          <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/80">
            Dr {fmtNum(tb?.total_debits, 2)} · Cr {fmtNum(tb?.total_credits, 2)}
          </p>
        )}
      </button>

      {/* ── Expanded detail row ──────────────────────────────────────── */}
      {isExpanded && (
        <div className="bg-slate-50 border-t border-dashed border-slate-200 px-4 py-3 text-[10.5px] space-y-3">

          {/* Progress timestamps */}
          <div>
            <p className="text-[9.5px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Progress Timestamps
            </p>
            <div className="grid grid-cols-1 gap-1">
              <TimestampRow
                icon={<Clock className="w-3 h-3 text-slate-500" />}
                label="Queued / Uploaded"
                value={fmtTs(u.uploaded_at)}
              />
              <TimestampRow
                icon={<Loader2 className="w-3 h-3 text-blue-500" />}
                label="Processing Started"
                value={fmtTs(engineStartedAt) !== "—" ? fmtTs(engineStartedAt) : "N/A (not tracked separately)"}
              />
              <TimestampRow
                icon={
                  tone === "valid"
                    ? <CheckCircle className="w-3 h-3 text-emerald-600" />
                    : tone === "blocked"
                    ? <XCircle className="w-3 h-3 text-red-600" />
                    : <AlertCircle className="w-3 h-3 text-amber-600" />
                }
                label="Completed"
                value={fmtTs(u.processed_at)}
              />
              <TimestampRow
                icon={<Clock className="w-3 h-3 text-slate-400" />}
                label="Total Duration"
                value={dur}
              />
            </div>
          </div>

          {/* Classification summary */}
          {summary && (
            <div>
              <p className="text-[9.5px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                Classification
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <KV k="Total accounts"  v={summary.total_accounts}   />
                <KV k="Auto-classified" v={summary.auto_classified}  />
                <KV k="Engine version"  v={summary.parser_version ?? "v2.x"} />
                <KV k="Rejected rows"   v={summary.rejected_rows ?? 0} />
              </div>
            </div>
          )}

          {/* Balance sheet equation */}
          {eq && (
            <div>
              <p className="text-[9.5px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                Balance Sheet Equation
              </p>
              <div className={`rounded px-2 py-1.5 text-[10.5px] ${eq.passed ? "bg-emerald-50 border border-emerald-200" : "bg-amber-50 border border-amber-200"}`}>
                {eq.passed
                  ? "✓ Assets = Liabilities + Closing Equity"
                  : `⚠ Difference: TZS ${fmtNum(eq.difference, 2)} — review account classifications`}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
                <KV k="Assets"         v={fmtNum(eq.assets,      2)} />
                <KV k="Liabilities"    v={fmtNum(eq.liabilities, 2)} />
                <KV k="Opening Equity" v={fmtNum(eq.equity,      2)} />
                <KV k="Net Income"     v={fmtNum(eq.net_income,  2)} />
              </div>
            </div>
          )}

          {/* Error details */}
          {errors.length > 0 && (
            <div>
              <p className="text-[9.5px] font-bold uppercase tracking-widest text-red-500 mb-1.5">
                Errors ({errors.length})
              </p>
              <div className="space-y-1">
                {errors.map((err, i) => (
                  <div
                    key={i}
                    className="rounded bg-red-50 border border-red-100 px-2 py-1.5"
                  >
                    <p className="font-mono font-semibold text-red-700 text-[9.5px]">{err.code}</p>
                    <p className="text-red-600 text-[10px] mt-0.5 leading-snug">{err.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function TimestampRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="text-slate-500 w-36 shrink-0">{label}</span>
      <span className="font-mono text-slate-700 text-[10px]">{value}</span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string | number | null | undefined }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{k}</span>
      <span className="font-semibold text-slate-700 tabular-nums">{v ?? "—"}</span>
    </div>
  );
}
