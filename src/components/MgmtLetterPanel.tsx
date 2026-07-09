// ============================================================
// MgmtLetterPanel — Sprint 4 Item 1
// Renders the management letter produced by generate-management-letter.
// Features:
//   • Accordion per section with inline-edit mode
//   • Risk-badged findings table (Section B)
//   • jsPDF multi-page export
//   • Audit trail footer on each section
// ============================================================

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  FileText, Loader2, Download, PenLine, CheckCircle,
  AlertTriangle, AlertCircle, Info, RefreshCw, BookOpen,
} from "lucide-react";
import jsPDF from "jspdf";
import { useAuditLog } from "@/hooks/useAuditLog";

// ── Types (mirrors edge function output) ─────────────────────
interface TableRow { label: string; value: string; highlight?: boolean; indent?: boolean }

interface FindingSummary {
  id: string;
  title: string;
  statute: string | null;
  category: string | null;
  type: string;
  status: string;
  period: string;
  exposureTzs: number;
  obligationTzs: number;
  penaltyTzs: number;
  interestTzs: number;
  totalTzs: number;
  riskLevel: "critical" | "high" | "medium" | "low";
}

interface LetterSection {
  id: string;
  heading: string;
  type: "text" | "table" | "findings" | "list";
  content?: string;
  rows?: TableRow[];
  findings?: FindingSummary[];
  items?: string[];
}

interface LetterMetadata {
  generatedAt: string;
  companyName: string;
  periodYear: number;
  periodEndMonth: number;
  framework: string;
  engineVersion: string;
  findingCount: number;
  openFindingCount: number;
  totalExposureTzs: number;
  citGapTzs: number;
  taxPayableTzs: number;
  hasCommittedComputation: boolean;
}

interface LetterDocument {
  addressee: string;
  date: string;
  reference: string;
  subject: string;
  sections: LetterSection[];
  metadata: LetterMetadata;
}

interface MgmtLetterPanelProps {
  uploadId: string;
  existingLetter?: LetterDocument | null;
  onLetterGenerated?: () => void;
}

// ── Helpers ──────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

const RISK_CONFIG = {
  critical: { label: "CRITICAL", className: "bg-red-100 text-red-900 border-red-400 font-bold" },
  high:     { label: "HIGH",     className: "bg-orange-100 text-orange-900 border-orange-400" },
  medium:   { label: "MEDIUM",   className: "bg-amber-100 text-amber-900 border-amber-300" },
  low:      { label: "LOW",      className: "bg-blue-100 text-blue-800 border-blue-300" },
};

const RiskIcon = ({ level }: { level: FindingSummary["riskLevel"] }) => {
  if (level === "critical") return <AlertCircle className="w-3.5 h-3.5 text-red-700 flex-shrink-0" />;
  if (level === "high")     return <AlertTriangle className="w-3.5 h-3.5 text-orange-600 flex-shrink-0" />;
  if (level === "medium")   return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />;
  return <Info className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />;
};

// ── Section renderers ─────────────────────────────────────────
function SectionText({ content, editable, onChange }: {
  content: string; editable: boolean; onChange: (v: string) => void;
}) {
  return editable
    ? <Textarea value={content} onChange={e => onChange(e.target.value)}
        className="text-sm font-mono min-h-[180px] resize-y" />
    : <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{content}</p>;
}

function SectionTable({ rows }: { rows: TableRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i} className={row.highlight ? "bg-[#0E1D30]/6 font-semibold" : ""}>
              <td className={`px-3 py-1.5 text-muted-foreground ${row.indent ? "pl-7" : ""}`}>{row.label}</td>
              <td className="px-3 py-1.5 text-right font-mono">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionFindings({ findings, emptyContent }: { findings: FindingSummary[]; emptyContent?: string }) {
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyContent ?? "No findings."}</p>;
  }
  return (
    <div className="space-y-3">
      {findings.map((f, i) => {
        const cfg = RISK_CONFIG[f.riskLevel];
        return (
          <div key={f.id} className={`rounded-lg border-l-4 bg-card border px-4 py-3 ${
            f.riskLevel === "critical" ? "border-l-red-500" :
            f.riskLevel === "high"     ? "border-l-orange-500" :
            f.riskLevel === "medium"   ? "border-l-amber-400" : "border-l-blue-400"
          }`}>
            <div className="flex items-start gap-2 mb-2">
              <RiskIcon level={f.riskLevel} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">
                    {i + 1}. {f.title}
                  </span>
                  <Badge className={`text-[10px] px-1.5 py-0 border ${cfg.className}`}>
                    {cfg.label}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {f.status.replace("_", " ").toUpperCase()}
                  </Badge>
                </div>
                {f.statute && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{f.statute}</p>
                )}
              </div>
            </div>
            <div className="overflow-hidden rounded border border-border mt-2">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="px-2 py-1 text-muted-foreground">Period</td>
                    <td className="px-2 py-1 font-mono">{f.period}</td>
                    <td className="px-2 py-1 text-muted-foreground">Principal obligation</td>
                    <td className="px-2 py-1 font-mono text-right">TZS {fmt(f.obligationTzs)}</td>
                  </tr>
                  <tr>
                    <td className="px-2 py-1 text-muted-foreground">Exposure</td>
                    <td className="px-2 py-1 font-mono text-destructive font-semibold">TZS {fmt(f.exposureTzs)}</td>
                    <td className="px-2 py-1 text-muted-foreground">Penalty + interest</td>
                    <td className="px-2 py-1 font-mono text-right">
                      TZS {fmt(f.penaltyTzs + f.interestTzs)}
                    </td>
                  </tr>
                  {f.totalTzs > f.exposureTzs && (
                    <tr className="bg-muted/30 font-semibold">
                      <td className="px-2 py-1" colSpan={2}>Total with penalties</td>
                      <td className="px-2 py-1 text-right font-mono" colSpan={2}>
                        TZS {fmt(f.totalTzs)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SectionList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className="text-muted-foreground mt-0.5 flex-shrink-0">•</span>
          <span className="text-foreground leading-relaxed">{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ── PDF export ───────────────────────────────────────────────
function exportToPDF(letter: LetterDocument, editedSections: Record<string, string>) {
  const doc = new jsPDF({ orientation: "portrait", format: "a4" });
  const margin = 18;
  const pageW = doc.internal.pageSize.getWidth();
  const contentW = pageW - margin * 2;
  let y = margin;

  const newPage = () => { doc.addPage(); y = margin; };
  const checkY = (needed = 10) => { if (y + needed > 270) newPage(); };

  // Header
  doc.setFontSize(16); doc.setFont("helvetica", "bold"); doc.setTextColor(14, 29, 48);
  doc.text("MANAGEMENT LETTER", pageW / 2, y, { align: "center" }); y += 8;
  doc.setFontSize(11); doc.setFont("helvetica", "normal"); doc.setTextColor(60, 60, 60);
  doc.text(letter.subject, pageW / 2, y, { align: "center" }); y += 6;
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text(`Ref: ${letter.reference}   |   ${letter.date}`, pageW / 2, y, { align: "center" }); y += 8;

  // Addressee
  doc.setFontSize(10); doc.setFont("helvetica", "normal"); doc.setTextColor(40);
  letter.addressee.split("\n").forEach(line => { doc.text(line, margin, y); y += 5; });
  y += 4;
  doc.setDrawColor(200); doc.line(margin, y, pageW - margin, y); y += 6;

  // Sections
  letter.sections.forEach(sec => {
    checkY(20);
    // Heading
    doc.setFontSize(11); doc.setFont("helvetica", "bold"); doc.setTextColor(14, 29, 48);
    doc.text(sec.heading, margin, y); y += 6;
    doc.setFont("helvetica", "normal"); doc.setTextColor(50);

    const content = editedSections[sec.id] ?? sec.content;

    if (sec.type === "text" && content) {
      const lines = doc.splitTextToSize(content, contentW);
      lines.forEach((line: string) => { checkY(6); doc.setFontSize(9); doc.text(line, margin, y); y += 4.5; });
    }
    if (sec.type === "list" && sec.items) {
      sec.items.forEach(item => {
        checkY(10);
        const lines = doc.splitTextToSize(`• ${item}`, contentW - 4);
        lines.forEach((line: string) => { doc.setFontSize(9); doc.text(line, margin + 2, y); y += 4.5; });
        y += 1;
      });
    }
    if (sec.type === "table" && sec.rows) {
      sec.rows.forEach(row => {
        checkY(6);
        doc.setFontSize(8.5);
        const indent = row.indent ? 8 : 0;
        if (row.highlight) doc.setFont("helvetica", "bold");
        doc.text(row.label, margin + indent, y);
        doc.text(row.value, pageW - margin, y, { align: "right" });
        if (row.highlight) doc.setFont("helvetica", "normal");
        y += 5;
      });
    }
    if (sec.type === "findings" && sec.findings) {
      if (sec.findings.length === 0 && sec.content) {
        const lines = doc.splitTextToSize(sec.content, contentW);
        lines.forEach((line: string) => { checkY(6); doc.setFontSize(9); doc.text(line, margin, y); y += 4.5; });
      }
      sec.findings.forEach((f, i) => {
        checkY(30);
        doc.setFontSize(9.5); doc.setFont("helvetica", "bold");
        doc.text(`${i + 1}. ${f.title} [${f.riskLevel.toUpperCase()}]`, margin, y); y += 5;
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        doc.text(`Period: ${f.period}`, margin + 4, y); y += 4;
        doc.text(`Exposure: TZS ${fmt(f.exposureTzs)}  |  Obligation: TZS ${fmt(f.obligationTzs)}  |  Penalty+Interest: TZS ${fmt(f.penaltyTzs + f.interestTzs)}`, margin + 4, y); y += 4;
        if (f.statute) { doc.text(`Statute: ${f.statute}`, margin + 4, y); y += 4; }
        y += 2;
      });
    }
    y += 8;
  });

  doc.save(`management-letter-${letter.metadata.periodYear}.pdf`);
  toast.success("Management letter exported to PDF");
}

// ── Main component ───────────────────────────────────────────
export function MgmtLetterPanel({ uploadId, existingLetter, onLetterGenerated }: MgmtLetterPanelProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [letter, setLetter] = useState<LetterDocument | null>(existingLetter ?? null);
  const [editedSections, setEditedSections] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const { logAction } = useAuditLog();

  const generate = async () => {
    setIsGenerating(true);
    toast.info("Generating management letter…");
    try {
      const { data, error } = await supabase.functions.invoke("generate-management-letter", {
        body: { uploadId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setLetter(data.letter);
      toast.success("Management letter generated");
      logAction({
        action: "generate_management_letter",
        entityType: "trial_balance_upload",
        entityId: uploadId,
        metadata: { finding_count: data.letter.metadata.findingCount },
      });
      onLetterGenerated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate letter");
    } finally {
      setIsGenerating(false);
    }
  };

  const meta = letter?.metadata;

  if (!letter) {
    return (
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Management Letter
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-primary/10 flex items-center justify-center">
              <BookOpen className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold mb-2">Generate Management Letter</h3>
            <p className="text-muted-foreground text-sm mb-6 max-w-md mx-auto">
              Produces a structured management letter for directors based on committed tax computation
              and open compliance findings. No AI inference — all figures from the Kinga Engine.
            </p>
            <Button variant="hero" onClick={generate} disabled={isGenerating} className="gap-2">
              {isGenerating
                ? <><Loader2 className="w-4 h-4 animate-spin" />Generating…</>
                : <><FileText className="w-4 h-4" />Generate Management Letter</>}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Management Letter
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {letter.subject} · {letter.date} · Ref: {letter.reference}
          </p>
          {meta && (
            <div className="flex flex-wrap gap-2 mt-2">
              <Badge variant="outline" className="text-[10px]">
                {meta.findingCount} finding{meta.findingCount !== 1 ? "s" : ""}
              </Badge>
              {meta.totalExposureTzs > 0 && (
                <Badge className="text-[10px] bg-destructive/15 text-destructive border-destructive/30">
                  Exposure TZS {fmt(meta.totalExposureTzs)}
                </Badge>
              )}
              {!meta.hasCommittedComputation && (
                <Badge className="text-[10px] bg-amber-100 text-amber-900 border-amber-300">
                  No committed computation
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px]">
                Kinga {meta.engineVersion}
              </Badge>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="outline" size="sm" onClick={() => exportToPDF(letter, editedSections)} className="gap-1.5">
            <Download className="w-3.5 h-3.5" />Export PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={generate} disabled={isGenerating} className="gap-1.5">
            {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Regenerate
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {/* Letter header block */}
        <div className="mb-4 border border-border rounded-xl p-4 bg-muted/10 text-xs text-muted-foreground font-mono space-y-0.5">
          <div><span className="font-semibold text-foreground">To:</span> {letter.addressee.replace("\n", ", ")}</div>
          <div><span className="font-semibold text-foreground">Date:</span> {letter.date}</div>
          <div><span className="font-semibold text-foreground">Ref:</span> {letter.reference}</div>
          <div><span className="font-semibold text-foreground">Re:</span> {letter.subject}</div>
        </div>

        <ScrollArea className="h-[520px] pr-3">
          <Accordion type="multiple" defaultValue={["basis", "executive-summary"]} className="space-y-2">
            {letter.sections.map(sec => {
              const isEditing = editingId === sec.id;
              const editedContent = editedSections[sec.id] ?? sec.content ?? "";
              const hasFindings = sec.type === "findings" && (sec.findings?.length ?? 0) > 0;
              const findingCount = sec.findings?.length ?? 0;

              return (
                <AccordionItem
                  key={sec.id}
                  value={sec.id}
                  className="border border-border rounded-xl px-4 data-[state=open]:bg-secondary/20"
                >
                  <AccordionTrigger className="hover:no-underline py-3">
                    <div className="flex items-center gap-3 text-left">
                      <div className="flex-1">
                        <span className="font-semibold text-sm text-foreground">{sec.heading}</span>
                        {hasFindings && (
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            ({findingCount} finding{findingCount !== 1 ? "s" : ""})
                          </span>
                        )}
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-4">
                    <div className="space-y-3">
                      {sec.type === "text" && (
                        <SectionText
                          content={editedContent}
                          editable={isEditing}
                          onChange={v => setEditedSections(prev => ({ ...prev, [sec.id]: v }))}
                        />
                      )}
                      {sec.type === "table" && sec.rows && <SectionTable rows={sec.rows} />}
                      {sec.type === "table" && !sec.rows && sec.content && (
                        <p className="text-sm text-muted-foreground">{sec.content}</p>
                      )}
                      {sec.type === "findings" && (
                        <SectionFindings findings={sec.findings ?? []} emptyContent={sec.content} />
                      )}
                      {sec.type === "list" && sec.items && <SectionList items={sec.items} />}

                      {/* Edit toggle — text sections only */}
                      {sec.type === "text" && (
                        <div className="flex items-center gap-2 pt-1">
                          {isEditing ? (
                            <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs"
                              onClick={() => setEditingId(null)}>
                              <CheckCircle className="w-3 h-3" />Done editing
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" className="gap-1.5 h-7 text-xs text-muted-foreground"
                              onClick={() => setEditingId(sec.id)}>
                              <PenLine className="w-3 h-3" />Edit section
                            </Button>
                          )}
                          {editedSections[sec.id] && editedSections[sec.id] !== sec.content && (
                            <span className="text-[10px] text-amber-600">● unsaved edits</span>
                          )}
                        </div>
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </ScrollArea>

        <div className="mt-4 pt-3 border-t border-border text-xs text-muted-foreground flex items-center justify-between">
          <span>
            Generated {meta ? new Date(meta.generatedAt).toLocaleString("en-TZ", {
              day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
            }) : "—"} · Kinga Engine {meta?.engineVersion ?? "—"}
          </span>
          <span className="italic">Review all sections before delivery to client directors.</span>
        </div>
      </CardContent>
    </Card>
  );
}
