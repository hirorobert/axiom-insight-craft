import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { AlertCircle, HelpCircle, Loader2, CheckCircle } from "lucide-react";
import { normalizeAccountName } from "@/lib/normalizeAccountName";

// ── Types ──────────────────────────────────────────────────────────────────

interface NeedsReviewAccount {
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  balance: number;
  suggested_classification?: string;
  suggested_statement?: string;
  confidence_source?: string;
  reason: string;
}

interface AccountReviewPanelProps {
  uploadId: string;
  companyId: string;
  userId: string;
  needsReviewAccounts: NeedsReviewAccount[];
  onReprocessed: () => void;
}

// ── Classification helpers ─────────────────────────────────────────────────

const CLASSIFICATIONS = [
  { value: "current_assets",          label: "Current Assets" },
  { value: "non_current_assets",      label: "Non-Current Assets" },
  { value: "current_liabilities",     label: "Current Liabilities" },
  { value: "non_current_liabilities", label: "Non-Current Liabilities" },
  { value: "equity",                  label: "Equity" },
  { value: "revenue",                 label: "Revenue" },
  { value: "cost_of_goods_sold",      label: "Cost of Goods Sold" },
  { value: "operating_expenses",      label: "Operating Expenses" },
  { value: "other_income",            label: "Other Income" },
  { value: "taxes",                   label: "Taxes" },
] as const;

interface ClassMeta {
  statement: string;
  normal_balance: "debit" | "credit";
}

function classificationMeta(cls: string): ClassMeta {
  const table: Record<string, ClassMeta> = {
    current_assets:          { statement: "balance_sheet",    normal_balance: "debit"  },
    non_current_assets:      { statement: "balance_sheet",    normal_balance: "debit"  },
    current_liabilities:     { statement: "balance_sheet",    normal_balance: "credit" },
    non_current_liabilities: { statement: "balance_sheet",    normal_balance: "credit" },
    equity:                  { statement: "balance_sheet",    normal_balance: "credit" },
    revenue:                 { statement: "income_statement", normal_balance: "credit" },
    cost_of_goods_sold:      { statement: "income_statement", normal_balance: "debit"  },
    operating_expenses:      { statement: "income_statement", normal_balance: "debit"  },
    other_income:            { statement: "income_statement", normal_balance: "credit" },
    taxes:                   { statement: "income_statement", normal_balance: "debit"  },
  };
  return table[cls] ?? { statement: "income_statement", normal_balance: "debit" };
}

// Stable per-row key — mirrors accountKey() in the edge function.
function rowKey(a: NeedsReviewAccount): string {
  return a.account_code && a.account_code !== a.account_name
    ? a.account_code
    : `name:${a.account_name}`;
}

function isCoded(a: NeedsReviewAccount): boolean {
  return !!(a.account_code && a.account_code !== a.account_name);
}

// ── Component ──────────────────────────────────────────────────────────────

export function AccountReviewPanel({
  uploadId,
  companyId,
  userId,
  needsReviewAccounts,
  onReprocessed,
}: AccountReviewPanelProps) {
  // Pre-select suggestion where it exists; otherwise empty (Save stays disabled).
  const initialChoices: Record<string, string> = {};
  for (const a of needsReviewAccounts) {
    if (a.suggested_classification) {
      initialChoices[rowKey(a)] = a.suggested_classification;
    }
  }

  const [choices,      setChoices]      = useState<Record<string, string>>(initialChoices);
  const [excluded,     setExcluded]     = useState<Set<string>>(new Set());
  const [saving,       setSaving]       = useState(false);
  const [reprocessing, setReprocessing] = useState(false);

  const setChoice = useCallback((key: string, val: string) => {
    setChoices((prev) => ({ ...prev, [key]: val }));
  }, []);

  const toggleExclude = useCallback((key: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        // Clear pending choice — excluded rows need no classification.
        setChoices((c) => { const u = { ...c }; delete u[key]; return u; });
      }
      return next;
    });
  }, []);

  const pendingRows   = needsReviewAccounts.filter((a) => !excluded.has(rowKey(a)));
  const resolvedCount = pendingRows.filter((a) => !!choices[rowKey(a)]).length;
  const allResolved   = pendingRows.length > 0
    ? resolvedCount === pendingRows.length
    : excluded.size > 0; // all rows excluded is also valid
  const isWorking = saving || reprocessing;

  // ── Save & Reprocess ──────────────────────────────────────────────────────

  const handleSaveAndReprocess = async () => {
    if (!allResolved || isWorking) return;
    setSaving(true);

    try {
      // Build payload for non-excluded accounts.
      const rows = needsReviewAccounts
        .filter((a) => !excluded.has(rowKey(a)))
        .map((account) => {
          const classification = choices[rowKey(account)];
          const meta           = classificationMeta(classification);
          const normName       = normalizeAccountName(account.account_name);
          return {
            user_id:                 userId,
            company_id:              companyId,
            account_code:            isCoded(account) ? account.account_code : null,
            account_name:            account.account_name,
            normalized_account_name: normName,
            statement:               meta.statement,
            classification,
            line_item:               account.account_name, // default; editable via mapping manager
            normal_balance:          meta.normal_balance,
            is_cash_account:         false,
            is_retained_earnings:    false,
            is_payroll_account:      false,
            confidence_source:       "user_approved",
            approved_at:             new Date().toISOString(),
          };
        });

      if (rows.length > 0) {
        // Atomic upsert via the generated account_key column (COALESCE of
        // account_code and normalized_account_name). account_key is GENERATED
        // ALWAYS — not included in the payload; Postgres computes it.
        // Conflict target: uq_acct_map_company_key (full, non-partial index).
        // corrections always win → ignoreDuplicates defaults to false (DO UPDATE).
        const { error } = await supabase
          .from("account_mappings")
          .upsert(rows as never, { onConflict: "company_id,account_key" });
        if (error) throw error;
      }

      setSaving(false);
      setReprocessing(true);
      toast.info("Mappings saved — reprocessing upload…");

      // Reset upload status, then re-invoke edge function.
      await supabase
        .from("trial_balance_uploads")
        .update({ status: "processing", processing_result: null })
        .eq("id", uploadId);

      const { error: fnError } = await supabase.functions.invoke(
        "process-trial-balance",
        { body: { uploadId } }
      );
      if (fnError) throw fnError;

      // Poll for terminal state.
      const TERMINAL = new Set(["complete", "error", "blocked", "needs_review"]);
      const pollInterval = setInterval(async () => {
        const { data } = await supabase
          .from("trial_balance_uploads")
          .select("*")
          .eq("id", uploadId)
          .single();

        if (data && TERMINAL.has(data.status)) {
          clearInterval(pollInterval);
          setReprocessing(false);
          if (data.status === "complete") {
            toast.success("Reprocessing complete!");
          } else if (data.status === "needs_review") {
            toast.warning("Some accounts still need review.");
          } else {
            toast.error("Reprocessing encountered an error.");
          }
          onReprocessed();
        }
      }, 2000);

      // Timeout after 90 s — call onReprocessed so Dashboard can refresh.
      setTimeout(() => {
        clearInterval(pollInterval);
        setReprocessing(false);
        onReprocessed();
      }, 90_000);

    } catch (err) {
      console.error("AccountReviewPanel save error:", err);
      toast.error("Failed to save mappings. Please try again.");
      setSaving(false);
      setReprocessing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Card className="bg-card border-amber-500/30 ring-1 ring-amber-500/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-amber-500" />
          Account Review Required
          <Badge
            variant="outline"
            className="bg-amber-500/10 text-amber-500 border-amber-500/30 ml-2"
          >
            {needsReviewAccounts.length} unresolved
          </Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          These accounts could not be mapped automatically. Assign a classification
          to each, or mark it "Exclude from import" to skip it. All rows must be
          resolved before reprocessing.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        <TooltipProvider>
          {needsReviewAccounts.map((account) => {
            const key        = rowKey(account);
            const isExcluded = excluded.has(key);
            const choice     = choices[key];
            const hasChoice  = !!choice;

            return (
              <div
                key={key}
                className={`rounded-lg border p-3 transition-colors ${
                  isExcluded
                    ? "border-border bg-muted/30 opacity-60"
                    : hasChoice
                    ? "border-accent/30 bg-accent/5"
                    : "border-amber-500/20 bg-amber-500/5"
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  {/* Account identity */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {account.account_name}
                      </span>
                      {isCoded(account) && (
                        <Badge variant="outline" className="text-xs shrink-0">
                          {account.account_code}
                        </Badge>
                      )}
                      {/* Reason / confidence tooltip */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="shrink-0">
                            <HelpCircle className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground transition-colors" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <p className="text-xs">{account.reason}</p>
                          {account.confidence_source && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Source: {account.confidence_source}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Balance:{" "}
                      {account.balance.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-3 shrink-0">
                    <Select
                      value={isExcluded ? "" : (choice ?? "")}
                      onValueChange={(val) => setChoice(key, val)}
                      disabled={isExcluded || isWorking}
                    >
                      <SelectTrigger className="w-52 text-sm">
                        <SelectValue placeholder="Select classification…" />
                      </SelectTrigger>
                      <SelectContent>
                        {CLASSIFICATIONS.map((cls) => (
                          <SelectItem key={cls.value} value={cls.value}>
                            {cls.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
                      <Checkbox
                        checked={isExcluded}
                        onCheckedChange={() => toggleExclude(key)}
                        disabled={isWorking}
                        className="border-border"
                      />
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Exclude from import
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </TooltipProvider>

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-border">
          <p className="text-xs text-muted-foreground">
            {excluded.size > 0 && (
              <span>{excluded.size} excluded · </span>
            )}
            {pendingRows.length - resolvedCount} remaining
          </p>
          <Button
            onClick={handleSaveAndReprocess}
            disabled={!allResolved || isWorking}
            className="gap-2"
          >
            {isWorking ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {saving ? "Saving…" : "Reprocessing…"}
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                Save & Reprocess
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
