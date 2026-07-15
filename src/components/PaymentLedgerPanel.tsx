// ============================================================
// PaymentLedgerPanel — Sprint 4 Item 4
// Per-company payment tracking: exposure → paid → outstanding.
//
// Data sources:
//   • findings      → open statutory obligations + exposure amounts
//   • tax_payments  → payments recorded against each obligation
//   • companies     → name + TIN
//
// "Record Payment" writes a row to tax_payments with:
//   company_id, tax_category, period_year, period_month,
//   amount_paid_tzs, payment_date, payment_reference,
//   payment_source (preparer_declared | efdms_matched | tra_receipt)
//
// CONSTRAINTS (active):
//   • Do not delete evidence records.
//   • No silent status changes.
//   • Do not modify tax engine or findings engine.
// ============================================================

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Banknote, AlertTriangle, CheckCircle, RefreshCw,
  Building2, Plus, ChevronDown, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────

type PaymentSource = "preparer_declared" | "efdms_matched" | "tra_receipt";

interface Company {
  id: string;
  name: string;
  tin: string | null;
}

interface FindingRow {
  id: string;
  company_id: string;
  title: string;
  finding_category: string | null;
  status: string;
  period_end: string | null;
  exposure_amount_tzs: number;
  period_year?: number;
  period_month?: number;
}

interface PaymentRow {
  id: string;
  company_id: string;
  tax_category: string;
  period_year: number;
  period_month: number;
  amount_paid_tzs: number;
  payment_date: string;
  payment_reference: string | null;
  payment_source: PaymentSource;
}

interface EnrichedFinding {
  findingId: string;
  companyId: string;
  title: string;
  findingCategory: string;
  periodYear: number;
  periodMonth: number;
  exposureTzs: number;
  paidTzs: number;
  outstandingTzs: number;
}

interface CompanyLedger {
  company: Company;
  findings: EnrichedFinding[];
  totalExposure: number;
  totalPaid: number;
  totalOutstanding: number;
}

// Record payment form state
interface PaymentForm {
  findingKey: string;          // "category|year|month|companyId"
  amountTzs: string;
  paymentDate: string;
  paymentReference: string;
  paymentSource: PaymentSource;
}

// ── Helpers ───────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

function derivePeriod(periodEnd: string | null): { year: number; month: number } {
  if (!periodEnd) return { year: 0, month: 0 };
  const d = new Date(periodEnd);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

const SOURCE_LABELS: Record<PaymentSource, string> = {
  preparer_declared: "Preparer declared",
  efdms_matched:     "EFDMS matched",
  tra_receipt:       "TRA receipt",
};

// ── Component ─────────────────────────────────────────────────

export function PaymentLedgerPanel() {
  const { user } = useAuth();
  const [ledgers, setLedgers]         = useState<CompanyLedger[]>([]);
  const [loading, setLoading]         = useState(true);
  const [expanded, setExpanded]       = useState<Set<string>>(new Set());
  const [showDialog, setShowDialog]   = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [allFindings, setAllFindings] = useState<EnrichedFinding[]>([]);
  const [form, setForm] = useState<PaymentForm>({
    findingKey:       "",
    amountTzs:        "",
    paymentDate:      today(),
    paymentReference: "",
    paymentSource:    "preparer_declared",
  });

  const fetchLedger = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // 1. Companies
      const { data: companiesRaw, error: cErr } = await supabase
        .from("companies")
        .select("id, name, tin")
        .eq("is_active", true)
        .order("name");
      if (cErr) throw cErr;
      const companies: Company[] = (companiesRaw ?? []) as Company[];
      const companyMap = new Map<string, Company>(companies.map((c) => [c.id, c]));

      // 2. Open findings
      const { data: findingsRaw } = await supabase
        .from("findings")
        .select(
          "id, company_id, title, finding_category, status, period_end, exposure_amount_tzs"
        )
        .in("status", ["open", "in_progress"])
        .gt("exposure_amount_tzs", 0);

      // 3. All tax_payments
      const { data: paymentsRaw } = await supabase
        .from("tax_payments")
        .select(
          "id, company_id, tax_category, period_year, period_month, " +
          "amount_paid_tzs, payment_date, payment_reference, payment_source"
        )
        .order("payment_date", { ascending: false });

      // Index payments by "companyId|category|year|month"
      const paymentIndex = new Map<string, number>();
      for (const p of (paymentsRaw ?? []) as unknown as PaymentRow[]) {
        const key = `${p.company_id}|${p.tax_category}|${p.period_year}|${p.period_month}`;
        paymentIndex.set(key, (paymentIndex.get(key) ?? 0) + Number(p.amount_paid_tzs));
      }

      // 4. Enrich findings
      const enriched: EnrichedFinding[] = [];
      for (const f of (findingsRaw ?? []) as unknown as FindingRow[]) {
        const { year, month } = derivePeriod(f.period_end);
        const cat = f.finding_category ?? "unknown";
        const key = `${f.company_id}|${cat}|${year}|${month}`;
        const paid = paymentIndex.get(key) ?? 0;
        const exposure = Number(f.exposure_amount_tzs);
        enriched.push({
          findingId:       f.id,
          companyId:       f.company_id,
          title:           f.title,
          findingCategory: cat,
          periodYear:      year,
          periodMonth:     month,
          exposureTzs:     exposure,
          paidTzs:         Math.min(paid, exposure),
          outstandingTzs:  Math.max(0, exposure - paid),
        });
      }

      setAllFindings(enriched);

      // 5. Group into company ledgers
      const ledgerMap = new Map<string, CompanyLedger>();
      for (const ef of enriched) {
        const company = companyMap.get(ef.companyId);
        if (!company) continue;
        if (!ledgerMap.has(ef.companyId)) {
          ledgerMap.set(ef.companyId, {
            company,
            findings: [],
            totalExposure: 0,
            totalPaid: 0,
            totalOutstanding: 0,
          });
        }
        const ldr = ledgerMap.get(ef.companyId)!;
        ldr.findings.push(ef);
        ldr.totalExposure    += ef.exposureTzs;
        ldr.totalPaid        += ef.paidTzs;
        ldr.totalOutstanding += ef.outstandingTzs;
      }

      const sorted = Array.from(ledgerMap.values()).sort((a, b) =>
        b.totalOutstanding - a.totalOutstanding
      );
      setLedgers(sorted);

      // Auto-expand company with highest outstanding
      if (sorted.length > 0) {
        setExpanded(new Set([sorted[0].company.id]));
      }
    } catch (err) {
      console.error("PaymentLedgerPanel fetch error:", err);
      toast.error("Failed to load payment ledger");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLedger();
  }, [user]);

  // ── Record payment submit ─────────────────────────────────────

  const handleSubmit = async () => {
    if (!form.findingKey || !form.amountTzs || !form.paymentDate) {
      toast.error("Please fill in all required fields");
      return;
    }
    const amount = Number(form.amountTzs.replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) {
      toast.error("Amount must be a positive number");
      return;
    }

    const [category, yearStr, monthStr, companyId] = form.findingKey.split("|");
    setSubmitting(true);
    try {
      const { error } = await supabase.from("tax_payments").insert({
        company_id:        companyId,
        tax_category:      category,
        period_year:       Number(yearStr),
        period_month:      Number(monthStr),
        amount_paid_tzs:   amount,
        payment_date:      form.paymentDate,
        payment_reference: form.paymentReference.trim() || null,
        payment_source:    form.paymentSource,
        created_by:        user?.id,
      });
      if (error) throw error;

      toast.success("Payment recorded");
      setShowDialog(false);
      setForm({
        findingKey:       "",
        amountTzs:        "",
        paymentDate:      today(),
        paymentReference: "",
        paymentSource:    "preparer_declared",
      });
      await fetchLedger();
    } catch (err) {
      console.error("Record payment error:", err);
      toast.error("Failed to record payment");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Totals across all companies ───────────────────────────────

  const grandExposure    = ledgers.reduce((s, l) => s + l.totalExposure, 0);
  const grandPaid        = ledgers.reduce((s, l) => s + l.totalPaid, 0);
  const grandOutstanding = ledgers.reduce((s, l) => s + l.totalOutstanding, 0);

  // ── Toggle expand ─────────────────────────────────────────────

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────────

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Banknote className="w-5 h-5 text-primary" />
                Payment Ledger
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Tax exposure vs. paid vs. outstanding — across all companies
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchLedger}
                disabled={loading}
                className="gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => setShowDialog(true)}
                className="gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Record Payment
              </Button>
            </div>
          </div>

          {/* Grand totals strip */}
          {!loading && ledgers.length > 0 && (
            <div className="grid grid-cols-3 gap-3 pt-2">
              <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Total Exposure
                </p>
                <p className="text-sm font-bold font-mono text-foreground">
                  TZS {fmt(grandExposure)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-accent/20 px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Paid
                </p>
                <p className="text-sm font-bold font-mono text-accent-foreground">
                  TZS {fmt(grandPaid)}
                </p>
              </div>
              <div className={`rounded-lg border px-3 py-2 ${
                grandOutstanding > 0
                  ? "bg-red-500/10 border-red-500/20"
                  : "bg-accent/20 border-border"
              }`}>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Outstanding
                </p>
                <p className={`text-sm font-bold font-mono ${
                  grandOutstanding > 0 ? "text-red-700" : "text-foreground"
                }`}>
                  TZS {fmt(grandOutstanding)}
                </p>
              </div>
            </div>
          )}
        </CardHeader>

        <CardContent className="pt-0 space-y-3">
          {loading ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
              Loading ledger…
            </div>
          ) : ledgers.length === 0 ? (
            <div className="text-center py-10">
              <CheckCircle className="w-8 h-8 text-accent mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No open obligations to track. Well done.
              </p>
            </div>
          ) : (
            ledgers.map((ldr) => {
              const isOpen = expanded.has(ldr.company.id);
              const allClear = ldr.totalOutstanding === 0;
              return (
                <div
                  key={ldr.company.id}
                  className="rounded-lg border border-border overflow-hidden"
                >
                  {/* Company header row */}
                  <button
                    onClick={() => toggleExpand(ldr.company.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 bg-secondary/30 hover:bg-secondary/60 transition-colors text-left"
                  >
                    {isOpen
                      ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    }
                    <Building2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold text-foreground">
                        {ldr.company.name}
                      </span>
                      {ldr.company.tin && (
                        <span className="ml-1.5 font-mono text-[9px] text-muted-foreground bg-background px-1 py-0.5 rounded">
                          TIN: {ldr.company.tin}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <div className="text-right hidden sm:block">
                        <p className="text-[10px] text-muted-foreground">Exposure</p>
                        <p className="text-xs font-mono font-semibold">
                          TZS {fmt(ldr.totalExposure)}
                        </p>
                      </div>
                      <div className="text-right hidden sm:block">
                        <p className="text-[10px] text-muted-foreground">Paid</p>
                        <p className="text-xs font-mono font-semibold text-accent-foreground">
                          TZS {fmt(ldr.totalPaid)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">Outstanding</p>
                        <p className={`text-xs font-mono font-bold ${
                          allClear ? "text-accent-foreground" : "text-red-700"
                        }`}>
                          TZS {fmt(ldr.totalOutstanding)}
                        </p>
                      </div>
                      {allClear ? (
                        <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      )}
                    </div>
                  </button>

                  {/* Findings breakdown */}
                  {isOpen && (
                    <div className="divide-y divide-border">
                      {/* Column headers */}
                      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-1.5 bg-secondary/10">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          Obligation
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide text-right">
                          Exposure
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide text-right">
                          Paid
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide text-right">
                          Outstanding
                        </span>
                      </div>

                      {ldr.findings.map((ef) => (
                        <div
                          key={ef.findingId}
                          className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-3 py-2 items-center"
                        >
                          <div>
                            <p className="text-xs text-foreground font-medium leading-tight">
                              {ef.title}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {ef.periodYear}/{String(ef.periodMonth).padStart(2, "0")}
                            </p>
                          </div>
                          <span className="text-xs font-mono text-foreground text-right">
                            {fmt(ef.exposureTzs)}
                          </span>
                          <span className="text-xs font-mono text-accent-foreground text-right">
                            {fmt(ef.paidTzs)}
                          </span>
                          <span className={`text-xs font-mono font-semibold text-right ${
                            ef.outstandingTzs > 0 ? "text-red-700" : "text-muted-foreground"
                          }`}>
                            {fmt(ef.outstandingTzs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* ── Record Payment Dialog ───────────────────────────── */}
      <Dialog open={showDialog} onOpenChange={(o) => { if (!submitting) setShowDialog(o); }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Banknote className="w-4 h-4 text-primary" />
              Record Tax Payment
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto flex-1 pr-1 pt-1">
            {/* Obligation selector */}
            <div className="space-y-1.5">
              <Label htmlFor="findingKey">
                Obligation <span className="text-destructive">*</span>
              </Label>
              <Select
                value={form.findingKey}
                onValueChange={(v) => {
                  // Pre-fill amount with outstanding balance
                  const [cat, yr, mo, cid] = v.split("|");
                  const match = allFindings.find(
                    (f) =>
                      f.findingCategory === cat &&
                      f.periodYear === Number(yr) &&
                      f.periodMonth === Number(mo) &&
                      f.companyId === cid
                  );
                  setForm((prev) => ({
                    ...prev,
                    findingKey: v,
                    amountTzs: match ? String(match.outstandingTzs) : "",
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an obligation…" />
                </SelectTrigger>
                <SelectContent className="max-h-52 overflow-y-auto">
                  {ledgers.map((ldr) =>
                    ldr.findings
                      .filter((f) => f.outstandingTzs > 0)
                      .map((f) => {
                        const key = `${f.findingCategory}|${f.periodYear}|${f.periodMonth}|${f.companyId}`;
                        return (
                          <SelectItem key={key} value={key}>
                            <span className="text-xs">
                              {ldr.company.name} — {f.title} ({f.periodYear}/{String(f.periodMonth).padStart(2, "0")})
                            </span>
                          </SelectItem>
                        );
                      })
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <Label htmlFor="amount">
                Amount (TZS) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="amount"
                type="number"
                min="1"
                value={form.amountTzs}
                onChange={(e) => setForm({ ...form, amountTzs: e.target.value })}
                placeholder="e.g. 1500000"
              />
              {form.findingKey && (() => {
                const [cat, yr, mo, cid] = form.findingKey.split("|");
                const match = allFindings.find(
                  (f) =>
                    f.findingCategory === cat &&
                    f.periodYear === Number(yr) &&
                    f.periodMonth === Number(mo) &&
                    f.companyId === cid
                );
                if (!match) return null;
                return (
                  <p className="text-[10px] text-muted-foreground">
                    Outstanding: TZS {fmt(match.outstandingTzs)}
                  </p>
                );
              })()}
            </div>

            {/* Payment date */}
            <div className="space-y-1.5">
              <Label htmlFor="paymentDate">
                Payment Date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="paymentDate"
                type="date"
                value={form.paymentDate}
                onChange={(e) => setForm({ ...form, paymentDate: e.target.value })}
              />
            </div>

            {/* Reference */}
            <div className="space-y-1.5">
              <Label htmlFor="reference">
                Payment Reference
                <span className="ml-1 text-xs text-muted-foreground">
                  (TRA receipt no., EFD doc no., or bank ref)
                </span>
              </Label>
              <Input
                id="reference"
                value={form.paymentReference}
                onChange={(e) => setForm({ ...form, paymentReference: e.target.value })}
                placeholder="e.g. TRA/2026/001234"
              />
            </div>

            {/* Source */}
            <div className="space-y-1.5">
              <Label>Evidence Source</Label>
              <Select
                value={form.paymentSource}
                onValueChange={(v) => setForm({ ...form, paymentSource: v as PaymentSource })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(SOURCE_LABELS) as [PaymentSource, string][]).map(
                    ([val, label]) => (
                      <SelectItem key={val} value={val}>
                        {label}
                      </SelectItem>
                    )
                  )}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {form.paymentSource === "tra_receipt"
                  ? "TRA receipt — highest evidence weight."
                  : form.paymentSource === "efdms_matched"
                  ? "Matched against EFDMS data."
                  : "Preparer-declared — attach supporting document when available."}
              </p>
            </div>
          </div>

          <DialogFooter className="pt-3 gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDialog(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting} className="gap-1.5">
              {submitting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {submitting ? "Recording…" : "Record Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
