// ============================================================
// EvidenceRequestPanel — Iron Dome Nuclear Design · Diamond Grade
// Sprint 3 Item 1: Evidence Request 6-step workflow UI.
//
// Wraps the existing evidence_requests table. No engine changes.
// Rules:
//   • No delete of evidence records.
//   • No silent status changes — every advance is explicit.
//   • Step 6 requires a TRA submission reference before closing.
//   • finding_id is immutable — enforced at DB layer (trigger).
// ============================================================

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button }   from "@/components/ui/button";
import { Input }    from "@/components/ui/input";
import { Label }    from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast }    from "sonner";
import {
  CheckCircle2, Loader2, Send, FileText, Bell,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvidenceRequest {
  id:                      string;
  finding_id:              string;
  documents_requested:     string[];
  current_step:            number;
  step1_requested_at:      string | null;
  step1_requested_by:      string | null;
  step2_last_reminder_at:  string | null;
  step2_reminder_count:    number;
  step3_received_at:       string | null;
  step3_received_by:       string | null;
  step4_review_started_at: string | null;
  step4_reviewed_at:       string | null;
  step4_reviewed_by:       string | null;
  step5_signoff_at:        string | null;
  step5_signed_by:         string | null;
  step6_submitted_at:      string | null;
  step6_submitted_by:      string | null;
  step6_submission_ref:    string | null;
  notes:                   string | null;
  created_at:              string;
  updated_at:              string;
}

export interface EvidenceRequestPanelProps {
  findingId:    string;
  findingTitle: string;
  userId:       string;
}

// ── Step metadata ──────────────────────────────────────────────────────────────

const STEPS: { step: number; label: string; desc: string }[] = [
  { step: 1, label: "Evidence Requested",
    desc: "CPA has formally requested the evidence package from the client." },
  { step: 2, label: "Awaiting Client",
    desc: "Waiting for the client to provide the requested documents." },
  { step: 3, label: "Evidence Received",
    desc: "CPA has confirmed receipt of all requested documents." },
  { step: 4, label: "Preparer Review",
    desc: "Preparer is reviewing received evidence and documenting findings." },
  { step: 5, label: "Partner Sign-off",
    desc: "Engagement partner is reviewing and approving the response pack." },
  { step: 6, label: "Submitted to TRA",
    desc: "Response pack formally submitted to TRA. Workflow closed." },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function stepTimestamp(er: EvidenceRequest, step: number): string | null {
  if (step === 1) return er.step1_requested_at;
  if (step === 2) return er.step2_last_reminder_at;   // informational only
  if (step === 3) return er.step3_received_at;
  if (step === 4) return er.step4_reviewed_at ?? er.step4_review_started_at;
  if (step === 5) return er.step5_signoff_at;
  if (step === 6) return er.step6_submitted_at;
  return null;
}

function isStepDone(er: EvidenceRequest, step: number): boolean {
  // Step 6 is "done" only when step6_submitted_at is set.
  if (step === 6) return !!er.step6_submitted_at;
  return er.current_step > step;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function EvidenceRequestPanel({
  findingId,
  findingTitle,
  userId,
}: EvidenceRequestPanelProps) {
  const [er,       setEr]       = useState<EvidenceRequest | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  // Create-form state
  const [showCreate, setShowCreate] = useState(false);
  const [docsInput,  setDocsInput]  = useState("");
  const [notesInput, setNotesInput] = useState("");

  // Step-6 TRA reference input
  const [traRef, setTraRef] = useState("");

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchEr = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("evidence_requests")
      .select("*")
      .eq("finding_id", findingId)
      .maybeSingle();
    if (error) toast.error(`Load failed: ${error.message}`);
    setEr(data as EvidenceRequest | null);
    setLoading(false);
  }, [findingId]);

  useEffect(() => { fetchEr(); }, [fetchEr]);

  // ── Create evidence request (Step 1) ─────────────────────────────────────

  const handleCreate = async () => {
    const docs = docsInput
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    if (docs.length === 0) {
      toast.error("Enter at least one document to request.");
      return;
    }

    setSaving(true);
    const { error } = await supabase.from("evidence_requests").insert({
      finding_id:          findingId,
      documents_requested: docs,
      current_step:        1,
      step1_requested_at:  new Date().toISOString(),
      step1_requested_by:  userId,
      notes:               notesInput.trim() || null,
    });
    setSaving(false);

    if (error) { toast.error(`Create failed: ${error.message}`); return; }
    toast.success("Evidence request created — Step 1 recorded.");
    setShowCreate(false);
    setDocsInput("");
    setNotesInput("");
    fetchEr();
  };

  // ── Advance step ───────────────────────────────────────────────────────────

  const advanceStep = async (fromStep: number) => {
    if (!er) return;
    setSaving(true);
    const now = new Date().toISOString();

    const patches: Record<number, Record<string, unknown>> = {
      1: { current_step: 2 },
      2: { current_step: 3, step3_received_at: now, step3_received_by: userId },
      3: { current_step: 4, step4_review_started_at: now },
      4: { current_step: 5, step4_reviewed_at: now, step4_reviewed_by: userId },
      5: { current_step: 6, step5_signoff_at: now, step5_signed_by: userId },
    };

    // Step 6 needs TRA ref — handled separately below
    if (fromStep === 6) {
      if (!traRef.trim()) {
        toast.error("Enter the TRA submission reference before closing.");
        setSaving(false);
        return;
      }
      const { error } = await supabase
        .from("evidence_requests")
        .update({ step6_submitted_at: now, step6_submitted_by: userId, step6_submission_ref: traRef.trim(), updated_at: now })
        .eq("id", er.id);
      setSaving(false);
      if (error) { toast.error(error.message); return; }
      toast.success("TRA submission recorded. Evidence request closed.");
      fetchEr();
      return;
    }

    const patch = patches[fromStep];
    if (!patch) { setSaving(false); return; }

    const { error } = await supabase
      .from("evidence_requests")
      .update({ ...patch, updated_at: now })
      .eq("id", er.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }

    const MSGS: Record<number, string> = {
      1: "Client notified — awaiting evidence.",
      2: "Evidence marked received — Step 3.",
      3: "Preparer review started — Step 4.",
      4: "Review complete — partner sign-off pending.",
      5: "Partner sign-off recorded — Step 6.",
    };
    toast.success(MSGS[fromStep] ?? "Step advanced.");
    fetchEr();
  };

  // ── Record reminder (Step 2 only) ─────────────────────────────────────────

  const recordReminder = async () => {
    if (!er) return;
    setSaving(true);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("evidence_requests")
      .update({ step2_last_reminder_at: now, step2_reminder_count: er.step2_reminder_count + 1, updated_at: now })
      .eq("id", er.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(`Reminder ${er.step2_reminder_count + 1} recorded.`);
    fetchEr();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-[11px] text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading evidence request…
      </div>
    );
  }

  // ── No request yet ─────────────────────────────────────────────────────────
  if (!er) {
    return (
      <div className="space-y-2.5">
        <p className="text-[10.5px] text-muted-foreground">
          No evidence request for this finding. Create one to begin the 6-step workflow.
        </p>
        {!showCreate ? (
          <Button
            variant="outline" size="sm"
            className="h-7 text-[11px] gap-1.5"
            onClick={() => setShowCreate(true)}
          >
            <FileText className="w-3 h-3" /> Create Evidence Request
          </Button>
        ) : (
          <div className="border border-border rounded p-3 bg-muted/20 space-y-3">
            <div>
              <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Documents to Request <span className="text-red-500">*</span>
              </Label>
              <Textarea
                value={docsInput}
                onChange={e => setDocsInput(e.target.value)}
                placeholder={"Trial Balance FY2025\nGeneral Ledger — SDL account\nPayroll summary Jan–Dec 2025"}
                rows={4}
                className="text-[11px] font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1">One document per line.</p>
            </div>
            <div>
              <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
                Notes (optional)
              </Label>
              <Textarea
                value={notesInput}
                onChange={e => setNotesInput(e.target.value)}
                placeholder="Context for the request or instructions to the client…"
                rows={2}
                className="text-[11px]"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-[11px] gap-1 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                onClick={handleCreate}
                disabled={saving}
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                Create &amp; Record Step 1
              </Button>
              <Button
                variant="ghost" size="sm"
                className="h-7 text-[11px]"
                onClick={() => { setShowCreate(false); setDocsInput(""); setNotesInput(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Evidence request exists ────────────────────────────────────────────────
  const isClosed = !!er.step6_submitted_at;

  return (
    <div className="space-y-3">

      {/* ── Meta header ── */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[9.5px] font-bold uppercase tracking-widest text-muted-foreground">
            Evidence Request Workflow
          </p>
          <p className="text-[9.5px] text-muted-foreground mt-0.5 font-mono">
            Created {fmtTs(er.created_at)} · Updated {fmtTs(er.updated_at)}
          </p>
        </div>
        {isClosed ? (
          <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9.5px] font-bold px-1.5 py-0.5 rounded">
            <CheckCircle2 className="w-2.5 h-2.5" /> CLOSED
          </span>
        ) : (
          <span className="inline-flex items-center bg-[#0E1D30]/10 text-[#0E1D30] text-[9.5px] font-bold px-1.5 py-0.5 rounded">
            Step {er.current_step} / 6
          </span>
        )}
      </div>

      {/* ── Documents requested ── */}
      <div className="border border-border rounded p-2.5 bg-muted/10">
        <p className="text-[9.5px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
          Documents Requested ({er.documents_requested.length})
        </p>
        <ul className="space-y-0.5">
          {er.documents_requested.map((doc, i) => (
            <li key={i} className="text-[11px] flex items-start gap-1.5">
              <span className="text-muted-foreground shrink-0 mt-0.5">·</span>
              {doc}
            </li>
          ))}
        </ul>
      </div>

      {/* ── Notes ── */}
      {er.notes && (
        <div className="border border-border rounded p-2.5 bg-muted/10">
          <p className="text-[9.5px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Notes</p>
          <p className="text-[11px]">{er.notes}</p>
        </div>
      )}

      {/* ── 6-step timeline ── */}
      <div>
        {STEPS.map(({ step, label, desc }, idx) => {
          const done    = isStepDone(er, step);
          const current = !isClosed && er.current_step === step;
          const pending = !done && !current;
          const ts      = stepTimestamp(er, step);
          const isLast  = idx === STEPS.length - 1;

          return (
            <div key={step} className="flex gap-3">
              {/* Column: circle + connector */}
              <div className="flex flex-col items-center">
                <div className={[
                  "w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold border",
                  done    ? "bg-emerald-600 border-emerald-600 text-white"
                  : current ? "bg-[#0E1D30] border-[#0E1D30] text-white"
                  :           "bg-background border-border text-muted-foreground",
                ].join(" ")}>
                  {done ? <CheckCircle2 className="w-3 h-3" /> : step}
                </div>
                {!isLast && (
                  <div className={`w-px flex-1 min-h-[20px] my-0.5 ${done ? "bg-emerald-300" : "bg-border"}`} />
                )}
              </div>

              {/* Step content */}
              <div className={`${isLast ? "pb-0" : "pb-3"} flex-1 min-w-0`}>
                <div className="flex items-center justify-between gap-2">
                  <p className={`text-[11px] font-semibold leading-tight ${pending ? "text-muted-foreground" : "text-foreground"}`}>
                    {label}
                  </p>
                  {ts && step !== 2 && (
                    <span className="text-[9px] font-mono text-muted-foreground shrink-0">{fmtTs(ts)}</span>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{desc}</p>

                {/* Step 2: reminder sub-info */}
                {step === 2 && er.step2_last_reminder_at && (
                  <p className="text-[9.5px] text-muted-foreground mt-0.5">
                    Last reminder: {fmtTs(er.step2_last_reminder_at)} ({er.step2_reminder_count} sent)
                  </p>
                )}

                {/* Step 6: TRA ref display when closed */}
                {step === 6 && er.step6_submission_ref && (
                  <p className="text-[9.5px] font-mono text-emerald-700 mt-0.5">
                    Ref: {er.step6_submission_ref}
                  </p>
                )}

                {/* ── Action buttons (current step only) ── */}
                {current && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">

                    {/* Step 1 → 2 */}
                    {step === 1 && (
                      <Button size="sm"
                        className="h-6 text-[10px] px-2 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                        onClick={() => advanceStep(1)} disabled={saving}>
                        {saving && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
                        Notify Client →
                      </Button>
                    )}

                    {/* Step 2 → 3 (+ reminder) */}
                    {step === 2 && (
                      <>
                        <Button size="sm" variant="outline"
                          className="h-6 text-[10px] px-2 gap-1"
                          onClick={recordReminder} disabled={saving}>
                          <Bell className="w-2.5 h-2.5" />
                          Record Reminder
                        </Button>
                        <Button size="sm"
                          className="h-6 text-[10px] px-2 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                          onClick={() => advanceStep(2)} disabled={saving}>
                          {saving && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
                          Mark Evidence Received →
                        </Button>
                      </>
                    )}

                    {/* Step 3 → 4 */}
                    {step === 3 && (
                      <Button size="sm"
                        className="h-6 text-[10px] px-2 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                        onClick={() => advanceStep(3)} disabled={saving}>
                        {saving && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
                        Start Preparer Review →
                      </Button>
                    )}

                    {/* Step 4 → 5 */}
                    {step === 4 && (
                      <Button size="sm"
                        className="h-6 text-[10px] px-2 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                        onClick={() => advanceStep(4)} disabled={saving}>
                        {saving && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
                        Mark Review Complete →
                      </Button>
                    )}

                    {/* Step 5 → 6 */}
                    {step === 5 && (
                      <Button size="sm"
                        className="h-6 text-[10px] px-2 bg-[#0E1D30] hover:bg-[#0E1D30]/90"
                        onClick={() => advanceStep(5)} disabled={saving}>
                        {saving && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
                        Record Partner Sign-off →
                      </Button>
                    )}

                    {/* Step 6 → closed (requires TRA ref) */}
                    {step === 6 && !er.step6_submitted_at && (
                      <div className="flex items-center gap-1.5 w-full mt-0.5">
                        <Input
                          value={traRef}
                          onChange={e => setTraRef(e.target.value)}
                          placeholder="TRA submission ref / receipt number"
                          className="h-6 text-[10.5px] font-mono flex-1"
                        />
                        <Button size="sm"
                          className="h-6 text-[10px] px-2 shrink-0 bg-[#0E6B55] hover:bg-[#0E6B55]/90"
                          onClick={() => advanceStep(6)}
                          disabled={saving || !traRef.trim()}>
                          {saving
                            ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            : <CheckCircle2 className="w-2.5 h-2.5" />
                          }
                          Record &amp; Close
                        </Button>
                      </div>
                    )}

                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
