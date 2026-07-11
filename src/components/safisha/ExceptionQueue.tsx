/**
 * ExceptionQueue.tsx · SAFISHA Stage 5
 *
 * Shows all safisha_exceptions for a reconciliation. Allows reviewers to
 * approve / reject / escalate each pending exception.
 *
 * IRON DOME:
 *   - Resolution actions go through safisha-resolve Edge Function ONLY.
 *   - This component never writes directly to safisha_exceptions.
 *   - reviewer_id is determined server-side from the auth session.
 *   - Resolved exceptions are displayed as read-only audit evidence.
 *
 * Design:
 *   - Uses existing card/badge primitives from the SAFF ERP UI library
 *   - Colors: #0E1D30 (dark), #0E6B55 (green), #55657A (muted)
 *   - No new color tokens introduced
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge }    from "@/components/ui/badge";
import { Button }   from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import {
  AlertCircle, CheckCircle2, XCircle, ArrowUpCircle,
  Clock, AlertTriangle, Search, Filter,
} from "lucide-react";
import { Input }  from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import ConfidenceScoreBar from "./ConfidenceScoreBar";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SafishaException {
  id:               string;
  account_code:     string;
  account_name:     string | null;
  category:         "timing" | "needs_adjustment" | "investigate";
  variance:         number;
  age_days:         number;
  confidence_score: number | null;
  description:      string;
  reviewer_action:  "pending" | "approved" | "rejected" | "escalated";
  reviewer_id:      string | null;
  reviewer_note:    string | null;
  resolved_at:      string | null;
  created_at:       string;
}

interface Props {
  reconciliationId: string;
  confidenceScore:  number | null;
  onAllResolved:    () => void; // called when reconciliation reaches 'clean' or 'blocked'
  readOnly?:        boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ExceptionQueue({
  reconciliationId,
  confidenceScore,
  onAllResolved,
  readOnly = false,
}: Props) {
  const [exceptions, setExceptions] = useState<SafishaException[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [resolving,  setResolving]  = useState<string | null>(null); // exception id being resolved
  const [notes,      setNotes]      = useState<Record<string, string>>({}); // exception id → note
  const [filter,     setFilter]     = useState<string>("all");
  const [search,     setSearch]     = useState("");
  const [error,      setError]      = useState<string | null>(null);

  const loadExceptions = useCallback(async () => {
    setLoading(true);
    const { data, error: dbErr } = await supabase
      .from("safisha_exceptions")
      .select("id,account_code,account_name,category,variance,age_days,confidence_score,description,reviewer_action,reviewer_id,reviewer_note,resolved_at,created_at")
      .eq("reconciliation_id", reconciliationId)
      .order("category", { ascending: true })       // investigate first
      .order("variance",  { ascending: false });     // largest variance first

    if (dbErr) setError("Failed to load exceptions: " + dbErr.message);
    else setExceptions((data ?? []) as SafishaException[]);
    setLoading(false);
  }, [reconciliationId]);

  useEffect(() => { loadExceptions(); }, [loadExceptions]);

  const handleResolve = async (excId: string, action: "approved" | "rejected" | "escalated") => {
    setResolving(excId);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/safisha-resolve`,
        {
          method:  "POST",
          headers: {
            Authorization:  `Bearer ${session!.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            exception_id: excId,
            action,
            note: notes[excId] ?? null,
          }),
        }
      );

      const result = await res.json();
      if (!res.ok || result.error) {
        throw new Error(result.error ?? "Resolution failed");
      }

      // Reload exceptions to reflect new state
      await loadExceptions();

      // If reconciliation is now clean or blocked, notify parent
      if (result.recon_status === "clean" || result.recon_status === "blocked") {
        onAllResolved();
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setResolving(null);
    }
  };

  // ── Filtering & search ──────────────────────────────────────────────────────

  const displayed = exceptions.filter(exc => {
    const matchesFilter =
      filter === "all"     ? true :
      filter === "pending" ? exc.reviewer_action === "pending" :
      exc.reviewer_action === filter || exc.category === filter;

    const matchesSearch = !search || (
      exc.account_code.toLowerCase().includes(search.toLowerCase()) ||
      (exc.account_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      exc.description.toLowerCase().includes(search.toLowerCase())
    );

    return matchesFilter && matchesSearch;
  });

  const pendingCount = exceptions.filter(e => e.reviewer_action === "pending").length;
  const investigateCount = exceptions.filter(e => e.category === "investigate" && e.reviewer_action === "pending").length;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        Loading exception queue…
      </div>
    );
  }

  if (exceptions.length === 0) {
    return (
      <Card className="border-[#0E6B55]/30">
        <CardContent className="py-12 text-center">
          <CheckCircle2 className="h-10 w-10 text-[#0E6B55] mx-auto mb-3" />
          <p className="font-medium text-[#0E1D30]">No exceptions found</p>
          <p className="text-sm text-muted-foreground mt-1">
            All TB lines matched to evidence. Trial balance is clean.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header + confidence score */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-[#0E1D30]">
            Exception Queue
            {pendingCount > 0 && (
              <Badge variant="destructive" className="ml-2 text-xs">{pendingCount} pending</Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {investigateCount > 0
              ? `${investigateCount} unmatched item(s) require investigation before the tax engine can run.`
              : "Review timing and adjustment exceptions to clear the reconciliation."}
          </p>
        </div>
        {confidenceScore !== null && (
          <div className="w-48 shrink-0">
            <ConfidenceScoreBar score={confidenceScore} />
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search account or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <Filter className="h-3.5 w-3.5 mr-1.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All exceptions</SelectItem>
            <SelectItem value="pending">Pending only</SelectItem>
            <SelectItem value="investigate">Investigate</SelectItem>
            <SelectItem value="needs_adjustment">Needs adjustment</SelectItem>
            <SelectItem value="timing">Timing</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="escalated">Escalated</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded bg-red-50 border border-red-200 text-red-800 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Exception cards */}
      <div className="space-y-3">
        {displayed.map(exc => (
          <ExceptionCard
            key={exc.id}
            exc={exc}
            note={notes[exc.id] ?? ""}
            onNoteChange={note => setNotes(prev => ({ ...prev, [exc.id]: note }))}
            onResolve={handleResolve}
            resolving={resolving === exc.id}
            readOnly={readOnly || exc.reviewer_action !== "pending"}
          />
        ))}
      </div>

      {displayed.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-6">
          No exceptions match the current filter.
        </p>
      )}
    </div>
  );
}

// ── ExceptionCard ─────────────────────────────────────────────────────────────

interface CardProps {
  exc:          SafishaException;
  note:         string;
  onNoteChange: (note: string) => void;
  onResolve:    (id: string, action: "approved" | "rejected" | "escalated") => Promise<void>;
  resolving:    boolean;
  readOnly:     boolean;
}

function ExceptionCard({ exc, note, onNoteChange, onResolve, resolving, readOnly }: CardProps) {
  const [expanded, setExpanded] = useState(exc.category === "investigate");

  const categoryColor =
    exc.category === "investigate"      ? "text-red-600 border-red-200 bg-red-50"
    : exc.category === "needs_adjustment" ? "text-amber-700 border-amber-200 bg-amber-50"
    : /* timing */                          "text-blue-700 border-blue-200 bg-blue-50";

  const statusBadge =
    exc.reviewer_action === "approved"  ? <Badge className="bg-[#0E6B55] text-white text-xs">Approved</Badge>
    : exc.reviewer_action === "rejected"  ? <Badge variant="destructive" className="text-xs">Rejected</Badge>
    : exc.reviewer_action === "escalated" ? <Badge className="bg-amber-500 text-white text-xs">Escalated</Badge>
    : null;

  return (
    <Card className={`border ${exc.reviewer_action !== "pending" ? "opacity-75" : ""}`}>
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <CategoryIcon category={exc.category} />
            <div className="min-w-0">
              <CardTitle className="text-sm font-mono">{exc.account_code}</CardTitle>
              {exc.account_name && (
                <CardDescription className="text-xs truncate">{exc.account_name}</CardDescription>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className={`text-xs ${categoryColor}`}>
              {labelCategory(exc.category)}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground">
              {exc.variance > 0 ? `TZS ${exc.variance.toLocaleString()}` : "—"}
            </span>
            {statusBadge ?? (
              exc.confidence_score !== null && (
                <span className="text-xs text-muted-foreground">
                  {exc.confidence_score}%
                </span>
              )
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">{exc.description}</p>

          {exc.age_days > 0 && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {exc.age_days} day(s) between dates
            </div>
          )}

          {/* Resolved state — read-only audit display */}
          {exc.reviewer_action !== "pending" ? (
            <div className="p-2 rounded bg-muted/50 text-xs space-y-1">
              <p><span className="font-medium">Resolved:</span> {exc.reviewer_action} · {exc.resolved_at ? new Date(exc.resolved_at).toLocaleDateString() : "—"}</p>
              {exc.reviewer_note && (
                <p><span className="font-medium">Note:</span> {exc.reviewer_note}</p>
              )}
            </div>
          ) : !readOnly ? (
            /* Pending — show resolve actions */
            <div className="space-y-2 pt-1 border-t">
              <Textarea
                placeholder="Optional reviewer note…"
                value={note}
                onChange={e => onNoteChange(e.target.value)}
                className="text-xs min-h-0 h-16 resize-none"
                disabled={resolving}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-[#0E6B55] hover:bg-[#0E6B55]/90 text-white h-7 text-xs"
                  onClick={() => onResolve(exc.id, "approved")}
                  disabled={resolving}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  {resolving ? "Saving…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="flex-1 h-7 text-xs"
                  onClick={() => onResolve(exc.id, "rejected")}
                  disabled={resolving}
                >
                  <XCircle className="h-3.5 w-3.5 mr-1" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-7 text-xs border-amber-400 text-amber-700 hover:bg-amber-50"
                  onClick={() => onResolve(exc.id, "escalated")}
                  disabled={resolving}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5 mr-1" />
                  Escalate
                </Button>
              </div>
              {exc.category === "investigate" && (
                <p className="text-xs text-red-600">
                  Rejecting this exception will block the reconciliation.
                  Approve or escalate to allow the tax engine to run.
                </p>
              )}
            </div>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function CategoryIcon({ category }: { category: string }) {
  if (category === "investigate")      return <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />;
  if (category === "needs_adjustment") return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  return <Clock className="h-4 w-4 text-blue-500 shrink-0" />;
}

function labelCategory(cat: string): string {
  return cat === "investigate"      ? "Investigate"
       : cat === "needs_adjustment" ? "Needs adjustment"
       : "Timing";
}
