// ============================================================
// KingaFindingsPanel — Phase 3 UI
// Run Analysis + Findings preview + live findings table
// ============================================================

import { useState, useCallback } from "react";
import { supabase }               from "@/integrations/supabase/client";
import { Button }                 from "@/components/ui/button";
import { Badge }                  from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input }    from "@/components/ui/input";
import { Label }    from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle, CheckCircle2, XCircle, Play, Loader2,
  RefreshCw, ChevronDown, ChevronUp, Info, ShieldAlert, Plus,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PaymentRecord {
  amount: number;
  source: string;
  ref:    string | null;
}

interface FindingPreview {
  trigger_category:             string;
  statutory_rule_id:            string | null;
  base_amount_tzs:              number;
  computed_obligation_tzs:      number;
  declared_amount_tzs:          number;
  net_variance_tzs:             number;
  variance_pct:                 number | null;
  estimated_penalty_tzs:        number;
  estimated_total_exposure_tzs: number;
  months_overdue:               number;
  account_count:                number;
  payment_records:              PaymentRecord[];
}

interface ModuleCPreview {
  account_code: string;
  account_name: string;
  category:     string;
  balance_tzs:  number;
}

interface EngineResponse {
  engine_run_id:     string;
  company_id:        string;
  period_year:       number;
  period_month:      number;
  rules_evaluated:   number;
  rules_skipped:     number;
  findings_created:  number;
  findings_skipped:  number;
  payables_scanned:  number;
  payables_found:    number;
  payables_created:  number;
  payables_skipped:  number;
  total_findings:    number;
  dry_run:           boolean;
  errors:            { error_message: string; stage?: string }[];
  findings_preview?: FindingPreview[];
  payables_preview?: ModuleCPreview[];
}

interface LiveFinding {
  id:                      string;
  finding_type:            string;
  finding_category:        string | null;
  title:                   string;
  period_start:            string;
  period_end:              string;
  exposure_amount_tzs:     number;
  computed_obligation_tzs: number;
  penalty_amount_tzs:      number | null;
  status:                  string;
  created_at:              string;
  source_detail:           Record<string, unknown> | null;
}

interface KingaFindingsPanelProps {
  companyId:   string;
  uploadId:    string;
  periodYear:  number;
  periodMonth: number;
  companyName?: string;
  userId: string;
}

interface AddPaymentForm {
  tax_category:      string;
  amount_paid_tzs:   string;
  payment_date:      string;
  payment_reference: string;
  notes:             string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTZS(n: number): string {
  return new Intl.NumberFormat("en-TZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleString("en", { month: "long", year: "numeric" });
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    sdl:                       "SDL",
    nssf:                      "NSSF",
    nhif:                      "NHIF",
    wcf:                       "WCF",
    paye:                      "PAYE",
    vat:                       "VAT",
    wht_undistributed_earnings:"WHT",
    service_levy_outstanding:  "Service Levy",
    sdl_outstanding:           "SDL Outstanding",
    nssf_outstanding:          "NSSF Outstanding",
    nhif_outstanding:          "NHIF Outstanding",
    wcf_outstanding:           "WCF Outstanding",
    tra_assessment:            "TRA Assessment",
    corporate_tax_outstanding: "Corporate Tax",
  };
  return labels[cat] ?? cat.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function severityFromExposure(exposure: number): "critical" | "high" | "medium" | "low" {
  if (exposure >= 50_000_000) return "critical";
  if (exposure >= 10_000_000) return "high";
  if (exposure >= 1_000_000)  return "medium";
  return "low";
}

const SEVERITY_STYLES = {
  critical: { row: "border-l-4 border-red-500 bg-red-50",   badge: "bg-red-100 text-red-800", icon: <XCircle className="w-4 h-4 text-red-600" /> },
  high:     { row: "border-l-4 border-orange-500 bg-orange-50", badge: "bg-orange-100 text-orange-800", icon: <AlertTriangle className="w-4 h-4 text-orange-600" /> },
  medium:   { row: "border-l-4 border-yellow-400 bg-yellow-50",  badge: "bg-yellow-100 text-yellow-800", icon: <AlertTriangle className="w-4 h-4 text-yellow-600" /> },
  low:      { row: "border-l-4 border-blue-400 bg-blue-50",   badge: "bg-blue-100 text-blue-800",  icon: <Info className="w-4 h-4 text-blue-600" /> },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold text-foreground">{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function PreviewRow({ finding, idx }: { finding: FindingPreview; idx: number }) {
  const [expanded, setExpanded] = useState(false);
  const severity = severityFromExposure(finding.estimated_total_exposure_tzs);
  const styles   = SEVERITY_STYLES[severity];

  return (
    <div className={`rounded-lg mb-2 overflow-hidden ${styles.row}`}>
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {styles.icon}
        <span className="font-semibold text-sm flex-1">{categoryLabel(finding.trigger_category)}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${styles.badge}`}>{severity.toUpperCase()}</span>
        <div className="text-right mr-4">
          <div className="text-sm font-bold">TZS {formatTZS(finding.net_variance_tzs)}</div>
          <div className="text-xs text-muted-foreground">net gap</div>
        </div>
        <div className="text-right mr-4">
          <div className="text-sm font-bold text-red-700">TZS {formatTZS(finding.estimated_total_exposure_tzs)}</div>
          <div className="text-xs text-muted-foreground">total exposure</div>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </div>
      {expanded && (
        <div className="px-4 pb-4 grid grid-cols-2 gap-3 text-sm border-t border-white/40 pt-3">
          <div>
            <div className="text-muted-foreground text-xs mb-1">Base (gross emoluments / equity)</div>
            <div className="font-mono">TZS {formatTZS(finding.base_amount_tzs)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">Gross obligation</div>
            <div className="font-mono">TZS {formatTZS(finding.computed_obligation_tzs)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">Declared paid</div>
            <div className="font-mono">TZS {formatTZS(finding.declared_amount_tzs)}</div>
            {finding.payment_records.length > 0 && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {finding.payment_records.map((p, i) => (
                  <div key={i}>{p.source}{p.ref ? ` — ${p.ref}` : ""}</div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">Net variance</div>
            <div className="font-mono font-bold text-red-700">TZS {formatTZS(finding.net_variance_tzs)}</div>
            {finding.variance_pct !== null && (
              <div className="text-xs text-muted-foreground">{finding.variance_pct}% underpaid</div>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">Estimated penalty (TAA s.76)</div>
            <div className="font-mono text-orange-700">TZS {formatTZS(finding.estimated_penalty_tzs)}</div>
            <div className="text-xs text-muted-foreground">{finding.months_overdue.toFixed(1)} months overdue × 5%/mo</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs mb-1">Total exposure</div>
            <div className="font-mono font-bold text-red-800 text-base">TZS {formatTZS(finding.estimated_total_exposure_tzs)}</div>
            <div className="text-xs text-muted-foreground">net gap + estimated penalty</div>
          </div>
          <div className="col-span-2">
            <div className="text-muted-foreground text-xs mb-1">Accounts in base ({finding.account_count})</div>
            <div className="text-xs italic text-muted-foreground">See source_detail.account_balances in findings table for full GL breakdown.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function PayableRow({ payable }: { payable: ModuleCPreview }) {
  const severity = severityFromExposure(payable.balance_tzs);
  const styles   = SEVERITY_STYLES[severity];
  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg mb-2 ${styles.row}`}>
      <ShieldAlert className="w-4 h-4 text-slate-500" />
      <div className="flex-1">
        <div className="text-sm font-semibold">{payable.account_name}</div>
        <div className="text-xs text-muted-foreground">{payable.account_code} — {categoryLabel(payable.category)}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-bold">TZS {formatTZS(payable.balance_tzs)}</div>
        <div className="text-xs text-muted-foreground">outstanding</div>
      </div>
    </div>
  );
}

function LiveFindingRow({ finding }: { finding: LiveFinding }) {
  const [expanded, setExpanded] = useState(false);
  const exposure = finding.exposure_amount_tzs ?? 0;
  const penalty  = finding.penalty_amount_tzs  ?? 0;
  const total    = exposure + penalty;
  const severity = severityFromExposure(total);
  const styles   = SEVERITY_STYLES[severity];

  return (
    <div className={`rounded-lg mb-2 overflow-hidden ${styles.row}`}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        {styles.icon}
        <div className="flex-1">
          <div className="text-sm font-semibold">{finding.title}</div>
          <div className="text-xs text-muted-foreground">
            {finding.period_start.substring(0, 7)} — {finding.status}
          </div>
        </div>
        <div className="text-right mr-4">
          <div className="text-sm font-bold">TZS {formatTZS(exposure)}</div>
          <div className="text-xs text-muted-foreground">net gap</div>
        </div>
        {penalty > 0 && (
          <div className="text-right mr-4">
            <div className="text-sm font-bold text-orange-700">+ TZS {formatTZS(penalty)}</div>
            <div className="text-xs text-muted-foreground">penalty est.</div>
          </div>
        )}
        <Badge variant="outline" className={`text-xs ${styles.badge}`}>{finding.finding_type}</Badge>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </div>
      {expanded && finding.source_detail && (
        <div className="px-4 pb-3 pt-2 border-t border-white/40">
          <pre className="text-xs bg-white/60 p-2 rounded overflow-auto max-h-48 text-slate-700">
            {JSON.stringify(finding.source_detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

function AddPaymentModal({
  companyId,
  createdBy,
  onSaved,
}: {
  companyId: string;
  createdBy: string;
  onSaved: () => void;
}) {
  const [open, setOpen]     = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [form, setForm]     = useState<AddPaymentForm>({
    tax_category:      "sdl",
    amount_paid_tzs:   "",
    payment_date:      new Date().toISOString().substring(0, 10),
    payment_reference: "",
    notes:             "",
  });

  const TAX_CATEGORIES = [
    { value: "sdl",                        label: "SDL" },
    { value: "nssf",                       label: "NSSF" },
    { value: "nhif",                       label: "NHIF" },
    { value: "wcf",                        label: "WCF" },
    { value: "paye",                       label: "PAYE" },
    { value: "vat",                        label: "VAT" },
    { value: "wht_undistributed_earnings", label: "WHT (Undistributed Earnings)" },
    { value: "service_levy",               label: "Service Levy" },
    { value: "corporate_tax",              label: "Corporate Tax" },
  ];

  const reset = () => setForm({
    tax_category:      "sdl",
    amount_paid_tzs:   "",
    payment_date:      new Date().toISOString().substring(0, 10),
    payment_reference: "",
    notes:             "",
  });

  const handleSave = async () => {
    if (!form.amount_paid_tzs || !form.payment_date) return;
    setSaving(true);
    setError(null);
    const d = new Date(form.payment_date);
    const { error: insErr } = await supabase.from("tax_payments").insert([{
      company_id:        companyId,
      tax_category:      form.tax_category,
      amount_paid_tzs:   parseFloat(form.amount_paid_tzs.replace(/,/g, "")),
      payment_date:      form.payment_date,
      period_year:       d.getFullYear(),
      period_month:      d.getMonth() + 1,
      payment_reference: form.payment_reference || undefined,
      notes:             form.notes || undefined,
      payment_source:    "preparer_declared",
      created_by:        createdBy,
    }]);
    setSaving(false);
    if (insErr) {
      setError(insErr.message);
      return;
    }
    reset();
    setOpen(false);
    onSaved();
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="w-4 h-4 mr-1" /> Record Payment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Declared Payment</DialogTitle>
            <DialogDescription>
              Enter what was actually paid to TRA / statutory authority. The engine will deduct
              this from the gross obligation to compute the net gap.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tax-category">Tax Category</Label>
              <select
                id="tax-category"
                className="flex h-11 w-full rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm text-foreground"
                value={form.tax_category}
                onChange={e => setForm(f => ({ ...f, tax_category: e.target.value }))}
              >
                {TAX_CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="amount-paid">Amount Paid (TZS)</Label>
              <Input
                id="amount-paid"
                inputMode="decimal"
                placeholder="e.g. 61,930,070"
                value={form.amount_paid_tzs}
                onChange={e => setForm(f => ({ ...f, amount_paid_tzs: e.target.value }))}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="payment-date">Payment Date</Label>
              <Input
                id="payment-date"
                type="date"
                value={form.payment_date}
                onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="payment-ref">TRA Receipt / Reference (optional)</Label>
              <Input
                id="payment-ref"
                placeholder="e.g. TRA-2025-12-001"
                value={form.payment_reference}
                onChange={e => setForm(f => ({ ...f, payment_reference: e.target.value }))}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="payment-notes">Notes (optional)</Label>
              <Textarea
                id="payment-notes"
                rows={2}
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              />
            </div>

            {error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !form.amount_paid_tzs || !form.payment_date}>
              {saving ? "Saving…" : "Save Payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function KingaFindingsPanel({
  companyId, uploadId, periodYear, periodMonth, companyName, userId,
}: KingaFindingsPanelProps) {
  const [phase,        setPhase]        = useState<"idle"|"preview"|"running"|"done"|"error">("idle");
  const [preview,      setPreview]      = useState<EngineResponse | null>(null);
  const [livefindings, setLiveFindings] = useState<LiveFinding[]>([]);
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null);
  const [expandErrors, setExpandErrors] = useState(false);

  // ── Load existing findings from DB ────────────────────────────────────────
  const loadLiveFindings = useCallback(async () => {
    const { data } = await supabase
      .from("findings")
      .select("id,finding_type,finding_category,title,period_start,period_end,exposure_amount_tzs,computed_obligation_tzs,penalty_amount_tzs,status,created_at,source_detail")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50);
    setLiveFindings((data as LiveFinding[]) ?? []);
  }, [companyId]);

  // ── Step 1: Dry run → preview ─────────────────────────────────────────────
  const runPreview = useCallback(async () => {
    setPhase("preview");
    setErrorMsg(null);
    setPreview(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setErrorMsg("Not authenticated."); setPhase("error"); return; }

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kinga-findings-engine`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        company_id:    companyId,
        upload_id:     uploadId,
        period_year:   periodYear,
        period_month:  periodMonth,
        triggered_by:  session.user.id,
        dry_run:       true,
      }),
    });

    const json: EngineResponse = await res.json();
    if (!res.ok || json.errors?.length > 0) {
      setErrorMsg(json.errors?.[0]?.error_message ?? "Engine returned an error.");
      setPreview(json);
      setPhase("error");
      return;
    }
    setPreview(json);
    setPhase("done");  // show preview, wait for user to commit
  }, [companyId, uploadId, periodYear, periodMonth]);

  // ── Step 2: Commit run ────────────────────────────────────────────────────
  const commitRun = useCallback(async () => {
    setPhase("running");
    setErrorMsg(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setErrorMsg("Not authenticated."); setPhase("error"); return; }

    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kinga-findings-engine`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        company_id:    companyId,
        upload_id:     uploadId,
        period_year:   periodYear,
        period_month:  periodMonth,
        triggered_by:  session.user.id,
        dry_run:       false,
      }),
    });

    const json: EngineResponse = await res.json();
    if (!res.ok) {
      setErrorMsg(json.errors?.[0]?.error_message ?? "Engine commit failed.");
      setPhase("error");
      return;
    }
    setPreview(json);
    await loadLiveFindings();
    setPhase("done");
  }, [companyId, uploadId, periodYear, periodMonth, loadLiveFindings]);

  // ── Total exposure summary ────────────────────────────────────────────────
  const totalExposure = (preview?.findings_preview ?? []).reduce(
    (s, f) => s + (f.estimated_total_exposure_tzs ?? 0), 0
  ) + (preview?.payables_preview ?? []).reduce((s, p) => s + p.balance_tzs, 0);

  const totalPenalty = (preview?.findings_preview ?? []).reduce(
    (s, f) => s + (f.estimated_penalty_tzs ?? 0), 0
  );

  const isLoading = phase === "preview" || phase === "running";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-primary" />
            Kinga — Statutory Compliance Analysis
          </CardTitle>
          <div className="flex items-center gap-2">
            <AddPaymentModal
              companyId={companyId}
              createdBy={userId}
              onSaved={loadLiveFindings}
            />
            {(phase === "done" || phase === "error") && (
              <Button variant="ghost" size="sm" onClick={() => { setPhase("idle"); setPreview(null); }}>
                <RefreshCw className="w-4 h-4 mr-1" /> Reset
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {companyName ? `${companyName} — ` : ""}{monthLabel(periodYear, periodMonth)}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">

        {/* ── IDLE STATE ── */}
        {phase === "idle" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Play className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="font-semibold">Run Compliance Analysis</p>
              <p className="text-sm text-muted-foreground mt-1">
                Checks SDL, WHT, and all verified statutory rules against this trial balance.
                A dry-run preview is shown before any findings are saved.
              </p>
            </div>
            <Button onClick={runPreview} className="mt-2">
              <Play className="w-4 h-4 mr-2" /> Run Analysis (Dry Run First)
            </Button>
            {livefindings.length === 0 && (
              <Button variant="link" size="sm" onClick={loadLiveFindings}>
                Load existing findings
              </Button>
            )}
          </div>
        )}

        {/* ── LOADING ── */}
        {isLoading && (
          <div className="flex flex-col items-center gap-3 py-10">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {phase === "preview" ? "Running dry-run analysis…" : "Committing findings to database…"}
            </p>
          </div>
        )}

        {/* ── PREVIEW / DONE ── */}
        {(phase === "done" || phase === "error") && preview && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SummaryCard
                label="Rules evaluated"
                value={String(preview.rules_evaluated)}
                sub={`${preview.rules_skipped} skipped`}
              />
              <SummaryCard
                label="Findings"
                value={String(preview.findings_created + preview.payables_created)}
                sub={`${preview.payables_found} statutory payables`}
              />
              <SummaryCard
                label="Total net gap"
                value={`TZS ${formatTZS(
                  (preview.findings_preview ?? []).reduce((s, f) => s + f.net_variance_tzs, 0)
                )}`}
                sub="after declared payments"
              />
              <SummaryCard
                label="Total exposure"
                value={`TZS ${formatTZS(totalExposure)}`}
                sub={`incl. est. penalty TZS ${formatTZS(totalPenalty)}`}
              />
            </div>

            {/* Errors */}
            {preview.errors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <button
                  className="flex items-center gap-2 w-full text-left text-sm font-medium text-yellow-800"
                  onClick={() => setExpandErrors(e => !e)}
                >
                  <AlertTriangle className="w-4 h-4" />
                  {preview.errors.length} engine warning{preview.errors.length > 1 ? "s" : ""}
                  {expandErrors ? <ChevronUp className="w-4 h-4 ml-auto" /> : <ChevronDown className="w-4 h-4 ml-auto" />}
                </button>
                {expandErrors && (
                  <ul className="mt-2 space-y-1">
                    {preview.errors.map((e, i) => (
                      <li key={i} className="text-xs text-yellow-700 bg-yellow-100 rounded px-2 py-1">
                        [{e.stage ?? "engine"}] {e.error_message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Module B — rule findings */}
            {(preview.findings_preview ?? []).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 text-foreground flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4 text-orange-500" />
                  Module B — Statutory Rule Findings
                </h3>
                {(preview.findings_preview ?? []).map((f, i) => (
                  <PreviewRow key={i} finding={f} idx={i} />
                ))}
              </div>
            )}

            {/* Module C — statutory payables */}
            {(preview.payables_preview ?? []).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 text-foreground flex items-center gap-1">
                  <ShieldAlert className="w-4 h-4 text-slate-500" />
                  Module C — Outstanding Statutory Payables (from Balance Sheet)
                </h3>
                {(preview.payables_preview ?? []).map((p, i) => (
                  <PayableRow key={i} payable={p} />
                ))}
              </div>
            )}

            {/* Commit button */}
            {preview.dry_run && (
              <div className="border-t pt-4 flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  This was a dry run. No findings have been saved yet.
                </div>
                <Button onClick={commitRun} variant="default" className="bg-red-600 hover:bg-red-700 text-white">
                  <ShieldAlert className="w-4 h-4 mr-2" />
                  Commit Findings to Database
                </Button>
              </div>
            )}

            {/* Committed confirmation */}
            {!preview.dry_run && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <CheckCircle2 className="w-4 h-4" />
                {preview.total_findings} finding{preview.total_findings !== 1 ? "s" : ""} committed.
                Engine run ID: <code className="font-mono text-xs">{preview.engine_run_id}</code>
              </div>
            )}
          </>
        )}

        {/* ── LIVE FINDINGS (from DB) ── */}
        {livefindings.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Committed Findings</h3>
              <Button variant="ghost" size="sm" onClick={loadLiveFindings}>
                <RefreshCw className="w-3 h-3 mr-1" /> Refresh
              </Button>
            </div>
            {livefindings.map(f => <LiveFindingRow key={f.id} finding={f} />)}
          </div>
        )}

      </CardContent>
    </Card>
  );
}

export default KingaFindingsPanel;
