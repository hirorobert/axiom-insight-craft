// ============================================================
// TransferPricingPanel — Roadmap Item 5D (Module F)
// Transfer Pricing Risk Register + Arm's-Length Evidence Workflow
//
// DATA SOURCES (no engine changes):
//   • tax_computations.computation_detail → add_backs (requires_review:true)
//     and classification_warnings where category contains TP patterns
//   • findings table → linked finding if one was already created
//   • evidence_requests table → existing ER linked to the finding
//
// TP RISK CATEGORIES DETECTED:
//   1. Management fees / head-office charges (ITA s.33)
//   2. Royalties / technical service fees (ITA s.33)
//   3. Thin capitalisation — related-party debt (ITA s.12(2))
//   4. Thin-cap interest disallowance
//
// For each risk item, the panel shows:
//   • Detected accounts + amounts
//   • ITA cap vs detected (where applicable)
//   • Risk level (HIGH / REVIEW / LOW)
//   • OECD-aligned arm's-length documentation checklist (7 items)
//   • "Create Evidence Request" → writes findings + evidence_requests rows
//   • If finding already exists → shows EvidenceRequestPanel inline
//
// CONSTRAINTS (active):
//   • Do not modify findings engine or tax engine.
//   • Do not delete evidence records.
//   • No silent status changes.
// ============================================================

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertTriangle, ChevronDown, ChevronRight, RefreshCw,
  ShieldAlert, FileText, CheckCircle, Globe, Building,
} from "lucide-react";
import { EvidenceRequestPanel } from "@/components/EvidenceRequestPanel";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────

type RiskLevel = "HIGH" | "REVIEW" | "LOW";

interface TPRisk {
  id: string;
  category: string;               // "management_fee" | "royalty" | "thin_cap" | "interest"
  title: string;
  itraRef: string;
  detectedAmount: number;
  capAmount?: number;
  excessAmount?: number;
  accountNames: string[];
  riskLevel: RiskLevel;
  narrative: string;
  actionRequired: string;
  fromAddBack: boolean;           // true = already in add_backs, false = classification warning only
  findingId?: string;             // set if a finding exists for this risk
}

interface TaxResultSnapshot {
  add_backs: Array<{
    description: string;
    amount_tzs: number;
    ita_section: string;
    account_names: string[];
    requires_review?: boolean;
  }>;
  classification_warnings: Array<{
    category: string;
    message: string;
    accounts_found: string[];
    action_required: string;
  }>;
  total_debt_tzs?: number;
  total_equity_tzs?: number;
  debt_equity_ratio?: number;
  thin_cap_disallowed_tzs?: number;
  gross_income_tzs?: number;
}

// ── TP Document Checklist ─────────────────────────────────────

const TP_DOCS = [
  { id: "agreement",   label: "Signed management fee / service agreement" },
  { id: "cup",         label: "Comparable uncontrolled price (CUP) or benchmark analysis" },
  { id: "policy",      label: "Group transfer pricing policy document" },
  { id: "structure",   label: "Group structure chart showing related-party relationships" },
  { id: "board",       label: "Board resolution approving fee arrangement" },
  { id: "schedule",    label: "Cross-charges schedule with breakdown by service type" },
  { id: "substance",   label: "Evidence of actual service delivery (invoices, deliverables)" },
];

// Documents requested for TRA evidence package
const TP_EVIDENCE_DOCS = TP_DOCS.map((d) => d.label);

const THIN_CAP_DOCS = [
  "Shareholder / related-party loan agreements with interest rate terms",
  "Confirmation of lender residency status (resident vs non-resident)",
  "Group debt schedule identifying which lenders are resident financial institutions",
  "Board resolution for any inter-company borrowing",
  "Proof that resident bank loans have been excluded from the 7:3 ratio computation",
  "Thin capitalisation computation worksheet",
];

// ── Helpers ───────────────────────────────────────────────────

const fmt = (n: number) =>
  `TZS ${Math.abs(n).toLocaleString("en-TZ", { maximumFractionDigits: 0 })}`;

function riskBadge(level: RiskLevel) {
  const map = {
    HIGH:   "bg-red-500/10 text-red-700 border-red-500/30",
    REVIEW: "bg-amber-500/10 text-amber-700 border-amber-500/30",
    LOW:    "bg-secondary text-muted-foreground border-border",
  };
  return <Badge className={`text-[10px] ${map[level]}`}>{level}</Badge>;
}

// Detect TP-relevant content from add_backs
const TP_ADD_BACK_KEYWORDS = [
  "management", "professional fee", "technical service", "royalt", "franchise",
  "head office", "group service", "consultancy", "advisory fee", "parent company",
];

function isTpAddBack(desc: string): boolean {
  const d = desc.toLowerCase();
  return TP_ADD_BACK_KEYWORDS.some((k) => d.includes(k.toLowerCase()));
}

const TP_WARNING_KEYWORDS = [
  "Management Fee", "Royalt", "Thin Cap", "Technical Service",
  "transfer pric", "related party",
];

function isTpWarning(category: string): boolean {
  return TP_WARNING_KEYWORDS.some((k) =>
    category.toLowerCase().includes(k.toLowerCase())
  );
}

// ── Component ─────────────────────────────────────────────────

interface TransferPricingPanelProps {
  companyId: string;
  uploadId: string;
  periodYear: number;
  companyName?: string;
  userId: string;
}

export function TransferPricingPanel({
  companyId, uploadId, periodYear, companyName, userId,
}: TransferPricingPanelProps) {
  const { user } = useAuth();
  const [risks, setRisks]         = useState<TPRisk[]>([]);
  const [loading, setLoading]     = useState(true);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [creating, setCreating]   = useState<string | null>(null);

  const build = async () => {
    setLoading(true);
    try {
      // 1. Latest tax computation for this upload
      const { data: tc } = await supabase
        .from("tax_computations")
        .select("computation_detail")
        .eq("upload_id", uploadId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!tc?.computation_detail) {
        setRisks([]);
        setLoading(false);
        return;
      }

      const r = tc.computation_detail as TaxResultSnapshot;

      // 2. Existing findings for this company (to link evidence requests)
      const { data: existingFindings } = await supabase
        .from("findings")
        .select("id, finding_category, title")
        .eq("company_id", companyId)
        .in("finding_category", ["management_fee", "royalty", "thin_cap", "transfer_pricing", "corporate_tax"]);

      const findingByCategory = new Map<string, string>(
        (existingFindings ?? []).map((f) => [f.finding_category ?? "", f.id])
      );

      const detected: TPRisk[] = [];

      // ── A. TP add-backs (management fees exceeding ITA s.33 cap) ─────────
      for (const ab of (r.add_backs ?? [])) {
        if (!ab.requires_review) continue;
        if (!isTpAddBack(ab.description)) continue;

        const isThinCap = ab.description.toLowerCase().includes("thin cap");
        const cat = isThinCap ? "thin_cap" : "management_fee";

        detected.push({
          id:             `addback-${cat}`,
          category:       cat,
          title:          isThinCap
            ? "Thin Capitalisation — Interest Disallowance"
            : "Management / Professional Fee Add-back",
          itraRef:        isThinCap ? "ITA Cap.332 s.12(2)" : "ITA Cap.332 s.33",
          detectedAmount: ab.amount_tzs,
          accountNames:   ab.account_names ?? [],
          riskLevel:      "HIGH",
          narrative:      ab.description,
          actionRequired: isThinCap
            ? "Confirm which debt is owed to foreign / related parties (exclude resident bank debt). Recompute ratio after exclusions."
            : "Confirm nature of each payment: foreign related party (cap applies) vs domestic entity (fully deductible). Obtain TP documentation.",
          fromAddBack:    true,
          findingId:      findingByCategory.get(cat),
        });
      }

      // ── B. TP classification warnings (under cap but still flagged) ───────
      for (const w of (r.classification_warnings ?? [])) {
        if (!isTpWarning(w.category)) continue;
        const isThinCap = w.category.toLowerCase().includes("thin cap");
        const cat = isThinCap ? "thin_cap_review" : "management_fee_review";

        // Don't double-add if already in add_backs
        if (detected.some((d) => d.category === cat.replace("_review", ""))) continue;

        detected.push({
          id:             `warning-${cat}`,
          category:       cat,
          title:          isThinCap
            ? "Thin Capitalisation — Within Ratio (Review Required)"
            : "Management Fees — Within ITA s.33 Cap (Payee Confirmation Required)",
          itraRef:        isThinCap ? "ITA Cap.332 s.12(2)" : "ITA Cap.332 s.33",
          detectedAmount: 0,
          accountNames:   w.accounts_found ?? [],
          riskLevel:      "REVIEW",
          narrative:      w.message,
          actionRequired: w.action_required,
          fromAddBack:    false,
        });
      }

      // ── C. Thin cap ratio summary (if detected in result) ─────────────────
      if ((r.debt_equity_ratio ?? 0) > 0 && !detected.some((d) => d.category === "thin_cap")) {
        const ratio = r.debt_equity_ratio ?? 0;
        const disallowed = r.thin_cap_disallowed_tzs ?? 0;
        if (ratio > 0) {
          detected.push({
            id:             "thin-cap-ratio",
            category:       "thin_cap",
            title:          `Thin Capitalisation — Debt:Equity Ratio ${ratio.toFixed(2)}:1`,
            itraRef:        "ITA Cap.332 s.12(2)",
            detectedAmount: r.total_debt_tzs ?? 0,
            excessAmount:   disallowed > 0 ? disallowed : undefined,
            accountNames:   [],
            riskLevel:      ratio > 2.333 ? "HIGH" : "REVIEW",
            narrative:
              `Detected debt:equity ratio ${ratio.toFixed(2)}:1 against the ITA s.12(2) threshold of 2.33:1 (7:3). ` +
              `Total detected debt TZS ${fmt(r.total_debt_tzs ?? 0)}. Total equity TZS ${fmt(r.total_equity_tzs ?? 0)}. ` +
              (disallowed > 0
                ? `Interest disallowed: TZS ${fmt(disallowed)}.`
                : "Ratio appears within limit — verify after excluding resident bank debt."),
            actionRequired:
              "Apply s.12(5) exclusions: (i) remove resident financial institution debt, " +
              "(ii) remove WHT-subject non-resident bank debt. Recompute ratio on net qualifying debt only.",
            fromAddBack:    disallowed > 0,
            findingId:      findingByCategory.get("thin_cap"),
          });
        }
      }

      if (detected.length > 0) {
        setExpanded(new Set([detected[0].id]));
      }
      setRisks(detected);
    } catch (err) {
      console.error("TransferPricingPanel error:", err);
      toast.error("Failed to load transfer pricing risks");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { build(); }, [uploadId, companyId]);

  // ── Create finding + evidence request ────────────────────────

  const handleCreateER = async (risk: TPRisk) => {
    if (!user) return;
    setCreating(risk.id);
    try {
      const isThinCap = risk.category.includes("thin_cap");
      const evidenceDocs = isThinCap ? THIN_CAP_DOCS : TP_EVIDENCE_DOCS;

      // 1. Create finding if none exists
      let findingId = risk.findingId;
      if (!findingId) {
        const periodEnd = new Date(periodYear, 11, 31).toISOString().split("T")[0];
        const periodStart = new Date(periodYear - 1, 11, 31).toISOString().split("T")[0];

        const { data: newFinding, error: fErr } = await supabase
          .from("findings")
          .insert({
            company_id:          companyId,
            upload_id:           uploadId,
            title:               risk.title,
            description:         risk.narrative,
            finding_category:    isThinCap ? "thin_cap" : "management_fee",
            risk_level:          risk.riskLevel === "HIGH" ? "high" : "medium",
            status:              "open",
            period_start:        periodStart,
            period_end:          periodEnd,
            exposure_amount_tzs: risk.detectedAmount,
            ita_reference:       risk.itraRef,
            action_required:     risk.actionRequired,
          })
          .select("id")
          .single();

        if (fErr || !newFinding) throw fErr ?? new Error("Finding creation failed");
        findingId = newFinding.id;
      }

      // 2. Create evidence request
      const { error: erErr } = await supabase.from("evidence_requests").insert({
        finding_id:          findingId,
        documents_requested: evidenceDocs,
        current_step:        1,
        step1_requested_at:  new Date().toISOString(),
        step1_requested_by:  user.id,
        notes:
          `Transfer Pricing review — ${risk.title}. ` +
          `Detected by kinga-tax-engine. CPA action required: ${risk.actionRequired}`,
      });

      if (erErr) throw erErr;

      toast.success("Evidence request created. See Compliance Findings for the full workflow.");
      await build();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to create evidence request: ${msg}`);
    } finally {
      setCreating(null);
    }
  };

  // ── Toggle expand ─────────────────────────────────────────────

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────────

  if (!loading && risks.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            Transfer Pricing
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <CheckCircle className="w-7 h-7 text-green-600 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No transfer pricing risks detected in this computation.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Run and commit the tax computation to populate this panel.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const highCount   = risks.filter((r) => r.riskLevel === "HIGH").length;
  const reviewCount = risks.filter((r) => r.riskLevel === "REVIEW").length;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Globe className="w-5 h-5 text-primary" />
              Transfer Pricing — Risk Register
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {companyName ?? "Selected company"} · {periodYear} ·
              ITA Cap.332 s.12(2) + s.33 · auto-detected from tax computation
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={build} disabled={loading} className="gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Summary strip */}
        {!loading && (
          <div className="flex flex-wrap gap-3 pt-2">
            {highCount > 0 && (
              <div className="flex items-center gap-1.5 bg-red-500/10 rounded-lg px-3 py-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-red-600" />
                <span className="text-xs font-semibold text-red-700">
                  {highCount} high-risk item{highCount !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            {reviewCount > 0 && (
              <div className="flex items-center gap-1.5 bg-amber-500/10 rounded-lg px-3 py-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-xs font-semibold text-amber-700">
                  {reviewCount} item{reviewCount !== 1 ? "s" : ""} require review
                </span>
              </div>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Analysing transfer pricing risks…
          </div>
        ) : (
          risks.map((risk) => {
            const isOpen = expanded.has(risk.id);
            const hasER  = !!risk.findingId;

            return (
              <Collapsible key={risk.id} open={isOpen} onOpenChange={() => toggle(risk.id)}>
                <CollapsibleTrigger asChild>
                  <button className={`w-full flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    risk.riskLevel === "HIGH"
                      ? "bg-red-500/5 border-red-500/20 hover:border-red-500/40"
                      : risk.riskLevel === "REVIEW"
                      ? "bg-amber-500/5 border-amber-500/20 hover:border-amber-500/40"
                      : "bg-card border-border hover:border-primary/30"
                  }`}>
                    {isOpen
                      ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                      : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-xs font-semibold text-foreground">{risk.title}</p>
                        {riskBadge(risk.riskLevel)}
                        {hasER && (
                          <Badge variant="outline" className="text-[10px] text-green-700 border-green-500/30">
                            Evidence request open
                          </Badge>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                        {risk.itraRef}
                      </p>
                    </div>
                    {risk.detectedAmount > 0 && (
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs font-bold font-mono text-foreground">
                          {fmt(risk.detectedAmount)}
                        </p>
                        {risk.excessAmount && (
                          <p className="text-[10px] text-red-600 font-semibold">
                            Excess: {fmt(risk.excessAmount)}
                          </p>
                        )}
                      </div>
                    )}
                  </button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <div className="ml-4 mt-2 space-y-4 pb-2">
                    {/* Narrative */}
                    <div className="rounded-lg bg-secondary/30 border border-border px-3 py-2.5">
                      <p className="text-xs text-foreground leading-relaxed">{risk.narrative}</p>
                      {risk.accountNames.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {risk.accountNames.map((a) => (
                            <span key={a} className="text-[10px] bg-background border border-border px-1.5 py-0.5 rounded font-mono">
                              {a}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Action required */}
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-foreground">{risk.actionRequired}</p>
                    </div>

                    {/* Arm's-length documentation checklist */}
                    <div>
                      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide mb-2">
                        {risk.category.includes("thin_cap")
                          ? "Thin Cap Documentation Checklist"
                          : "Arm's-Length Documentation Checklist  (OECD TP Guidelines / TRA Practice)"}
                      </p>
                      <div className="space-y-1.5">
                        {(risk.category.includes("thin_cap") ? THIN_CAP_DOCS : TP_DOCS).map((doc, i) => {
                          const key = `${risk.id}-${typeof doc === "string" ? i : doc.id}`;
                          const label = typeof doc === "string" ? doc : doc.label;
                          return (
                            <div key={key} className="flex items-start gap-2">
                              <Checkbox
                                id={key}
                                checked={checklist[key] ?? false}
                                onCheckedChange={(v) =>
                                  setChecklist((prev) => ({ ...prev, [key]: !!v }))
                                }
                                className="mt-0.5"
                              />
                              <Label htmlFor={key} className="text-xs text-muted-foreground cursor-pointer">
                                {label}
                              </Label>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Evidence request section */}
                    {hasER && risk.findingId ? (
                      <div>
                        <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide mb-2">
                          Evidence Request Workflow
                        </p>
                        <EvidenceRequestPanel
                          findingId={risk.findingId}
                          findingTitle={risk.title}
                          userId={userId}
                        />
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 w-full"
                        disabled={creating === risk.id}
                        onClick={() => handleCreateER(risk)}
                      >
                        {creating === risk.id
                          ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          : <FileText className="w-3.5 h-3.5" />
                        }
                        {creating === risk.id ? "Creating…" : "Create Evidence Request"}
                      </Button>
                    )}

                    {/* Statutory reference box */}
                    <div className="rounded-lg bg-[#0E1D30]/5 border border-[#0E1D30]/15 px-3 py-2">
                      <p className="text-[10px] text-[#0E1D30]/70 font-mono font-semibold mb-0.5">
                        {risk.itraRef}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {risk.category.includes("thin_cap")
                          ? "ITA s.12(2): Interest on debt exceeding the 7:3 debt-to-equity ratio is disallowed. " +
                            "Applies only to exempt-controlled resident entities (s.12(1)). " +
                            "Resident bank debt excluded under s.12(5). " +
                            "Verified: ITA Cap.332 R.E.2023 + Deloitte TZ Aug 2025."
                          : "ITA s.33: Management, professional, consultancy and technical service fees " +
                            "paid to foreign related parties are deductible only up to 1% of gross income. " +
                            "Domestic payments are fully deductible — cap does not apply. " +
                            "Verified: ITA Cap.332 R.E.2023 + PwC Tanzania Jan 2026."}
                      </p>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
