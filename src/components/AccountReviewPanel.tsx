/**
 * AccountReviewPanel — the exception workbench.
 *
 * A financial workpaper, not a card feed: one row per unresolved account, with
 * SAFF's assessment and the accountant's decision on the same line. Unresolved
 * items sort first. Under 768px each row becomes a structured stacked record.
 *
 * Presentation change only. The save payload, `user_approved` provenance, the
 * exclusion semantics and the reprocess polling are byte-for-byte the prior
 * behaviour: a suggestion is never silently promoted to an authoritative
 * mapping — the accountant's decision is what gets written.
 */

import { useMemo, useState, useCallback } from "react";
import { ensureFreshSession } from "@/lib/ensureFreshSession";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Loader2, CheckCircle, Info } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { normalizeAccountName } from "@/lib/normalizeAccountName";
import {
  SurfaceCard,
  SurfaceCardHeader,
  StatusMark,
} from "@/components/workspace/ui/Surface";

/**
 * AssessmentHelp — the only new affordance on this workpaper. Explains the two
 * machine states without adding a card, a banner or a per-row paragraph.
 * Click/tap and Enter/Space open it; Escape closes and returns focus to the
 * trigger (Radix Popover). `title` is supplemental hover text only.
 */
function AssessmentHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="What these assessments mean"
          title="What these assessments mean"
          className="inline-flex items-center align-middle text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
        >
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[19rem] rounded-none p-4 text-[12px] leading-relaxed text-muted-foreground space-y-3"
      >
        <p>
          <span className="block font-medium text-foreground normal-case tracking-normal">
            No reliable suggestion
          </span>
          SAFF did not find enough reliable evidence to suggest a classification.
        </p>
        <p>
          <span className="block font-medium text-foreground normal-case tracking-normal">
            Conflicting evidence — review required
          </span>
          SAFF found competing signals and will not choose between them.
        </p>
      </PopoverContent>
    </Popover>
  );
}

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
  /** Deep-linked from the Overview exception count: show unresolved only. */
  focusUnresolved?: boolean;
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

const CLASS_LABEL: Record<string, string> = Object.fromEntries(
  CLASSIFICATIONS.map((c) => [c.value, c.label]),
);

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

function money(n: number): string {
  return n.toLocaleString("en-TZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * SAFF's read on the account, rendered as evidence — never as a decision.
 * A suggestion carries the classifier's own confidence source; absence of a
 * suggestion is stated plainly rather than dressed up.
 */
function assessment(a: NeedsReviewAccount): { headline: string; note: string; resolved: boolean } {
  // The engine's reason often restates the account name verbatim; repeating it
  // beside the name is noise, not evidence.
  const restatesName =
    !!a.reason && a.reason.includes(a.account_name) && /no classification found/i.test(a.reason);
  const reason = restatesName
    ? "No rule, saved mapping or dictionary match"
    : a.reason;
  if (a.suggested_classification) {
    return {
      headline: CLASS_LABEL[a.suggested_classification] ?? a.suggested_classification,
      note: reason || (a.confidence_source ? `Source: ${a.confidence_source}` : ""),
      resolved: true,
    };
  }
  // Two distinct machine states, never collapsed into one message:
  //   CONFLICT  — the engine found competing evidence and refused to choose
  //   NO_MATCH  — the engine found no evidence at all
  const isConflict = /conflict/i.test(a.reason ?? "");
  if (isConflict) {
    return {
      headline: "Conflicting evidence — review required",
      note: a.reason,
      resolved: false,
    };
  }
  return {
    headline: "No reliable suggestion",
    note: reason || "No deterministic evidence for this account.",
    resolved: false,
  };
}

// ── Component ──────────────────────────────────────────────────────────────

export function AccountReviewPanel({
  uploadId,
  companyId,
  userId,
  needsReviewAccounts,
  focusUnresolved = false,
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
  const [unresolvedOnly, setUnresolvedOnly] = useState(focusUnresolved);
  /** Focus mode: one undecided account on screen at a time. Presentation only. */
  const [focusMode, setFocusMode] = useState(true);
  const [skipped, setSkipped] = useState<string[]>([]);

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
  const remaining = pendingRows.length - resolvedCount;

  /** Unresolved first — the accountant's queue, in queue order. */
  const ordered = useMemo(() => {
    const rank = (a: NeedsReviewAccount) => {
      const key = rowKey(a);
      if (excluded.has(key)) return 2;
      return choices[key] ? 1 : 0;
    };
    return [...needsReviewAccounts].sort((a, b) => rank(a) - rank(b));
  }, [needsReviewAccounts, choices, excluded]);

  const visible = unresolvedOnly
    ? ordered.filter((a) => {
        const key = rowKey(a);
        return !excluded.has(key) && !choices[key];
      })
    : ordered;

  /**
   * In focus mode the queue is the undecided accounts only, deferred ones last,
   * and exactly one row is on screen. Nothing about saving changes.
   */
  const focusQueue = useMemo(() => {
    const undecided = ordered.filter((a) => {
      const key = rowKey(a);
      return !excluded.has(key) && !choices[key];
    });
    const rank = (a: NeedsReviewAccount) => (skipped.includes(rowKey(a)) ? 1 : 0);
    return [...undecided].sort((a, b) => rank(a) - rank(b));
  }, [ordered, excluded, choices, skipped]);

  const focusRow = focusQueue[0];
  const displayed = focusMode ? (focusRow ? [focusRow] : []) : visible;

  const deferCurrent = useCallback(() => {
    if (!focusRow) return;
    const key = rowKey(focusRow);
    setSkipped((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, [focusRow]);

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

      await ensureFreshSession();
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

  const decisionControls = (key: string, isExcluded: boolean, choice?: string) => (
    <div className="flex flex-col items-stretch gap-2 md:items-end">
      <Select
        value={isExcluded ? "" : (choice ?? "")}
        onValueChange={(val) => setChoice(key, val)}
        disabled={isExcluded || isWorking}
      >
        <SelectTrigger className="w-full md:w-[13.5rem] h-9 text-[13px] rounded-none">
          <SelectValue placeholder="Classify…" />
        </SelectTrigger>
        <SelectContent>
          {CLASSIFICATIONS.map((cls) => (
            <SelectItem key={cls.value} value={cls.value}>
              {cls.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <Checkbox
          checked={isExcluded}
          onCheckedChange={() => toggleExclude(key)}
          disabled={isWorking}
          className="border-border"
        />
        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
          Exclude from import
        </span>
      </label>
    </div>
  );

  return (
    <SurfaceCard data-testid="account-review-workbench" id="account-review">
      <SurfaceCardHeader
        label="Accounts requiring review"
        meta={
          <>
            {remaining} of {needsReviewAccounts.length} undecided
            {excluded.size > 0 && <span> · {excluded.size} excluded</span>}
          </>
        }
        action={
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setFocusMode((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {focusMode ? "Show the full list" : "Focus on one account"}
            </button>
            {!focusMode && (
              <button
                type="button"
                onClick={() => setUnresolvedOnly((v) => !v)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {unresolvedOnly ? "Show all accounts" : "Show undecided only"}
              </button>
            )}
          </div>
        }
      />

      <p className="px-5 py-3 text-[13px] text-muted-foreground border-b border-border leading-relaxed">
        {focusMode
          ? "One account at a time. Set a classification, or exclude it. Nothing is written until you save."
          : "SAFF could not map these accounts on evidence it can defend. Set a classification, or exclude the account explicitly. Nothing is written until you save."}
        {/* Mobile equivalent of the column-header affordance — the stacked
            records have no header row to hang it on. */}
        <span className="md:hidden ml-1.5">
          <AssessmentHelp />
        </span>
      </p>

      {focusMode && focusRow && (
        <div className="flex items-center justify-between gap-3 px-5 py-2 border-b border-border">
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground tabular-nums">
            Decision {Math.max(1, needsReviewAccounts.length - excluded.size - focusQueue.length + 1)} of{" "}
            {needsReviewAccounts.length - excluded.size}
          </p>
          {focusQueue.length > 1 && (
            <button
              type="button"
              onClick={deferCurrent}
              disabled={isWorking}
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Decide later
            </button>
          )}
        </div>
      )}

      {/* Desktop: workpaper table */}
      <div className="hidden md:block">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              {["Account", "Balance", "SAFF assessment", "Decision"].map((h, i) => (
                <th
                  key={h}
                  className={[
                    "px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground",
                    i === 1 ? "text-right" : "",
                    i === 3 ? "text-right w-[15rem]" : "",
                  ].join(" ")}
                >
                  {h}
                  {i === 2 && (
                    <span className="ml-1.5">
                      <AssessmentHelp />
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.map((account) => {
              const key        = rowKey(account);
              const isExcluded = excluded.has(key);
              const choice     = choices[key];
              const a          = assessment(account);

              return (
                <tr
                  key={key}
                  className={[
                    "border-b border-border align-top",
                    isExcluded ? "opacity-50" : "",
                  ].join(" ")}
                >
                  <td className="px-5 py-4 max-w-[18rem]">
                    <p className="text-[13px] font-medium text-foreground leading-snug">
                      {account.account_name}
                    </p>
                    {isCoded(account) && (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
                        {account.account_code}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right text-[13px] tabular-nums text-foreground whitespace-nowrap">
                    {money(account.balance)}
                  </td>
                  <td className="px-5 py-4 max-w-[20rem]">
                    <StatusMark
                      tone={a.resolved ? "active" : "warn"}
                      label={a.headline}
                    />
                    {a.note && (
                      <p className="mt-1 text-[11px] text-muted-foreground/80 leading-snug">
                        {a.note}
                      </p>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    {decisionControls(key, isExcluded, choice)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: structured stacked records — account, balance, assessment, decision */}
      <div className="md:hidden divide-y divide-border">
        {displayed.map((account) => {
          const key        = rowKey(account);
          const isExcluded = excluded.has(key);
          const choice     = choices[key];
          const a          = assessment(account);

          return (
            <div key={key} className={`px-5 py-4 ${isExcluded ? "opacity-50" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] font-medium text-foreground leading-snug min-w-0">
                  {account.account_name}
                  {isCoded(account) && (
                    <span className="block mt-1 font-mono text-[11px] text-muted-foreground/70">
                      {account.account_code}
                    </span>
                  )}
                </p>
                <span className="text-[13px] tabular-nums text-foreground whitespace-nowrap shrink-0">
                  {money(account.balance)}
                </span>
              </div>
              <div className="mt-3">
                <StatusMark tone={a.resolved ? "active" : "warn"} label={a.headline} />
                {a.note && (
                  <p className="mt-1 text-[11px] text-muted-foreground/80 leading-snug">
                    {a.note}
                  </p>
                )}
              </div>
              <div className="mt-4">{decisionControls(key, isExcluded, choice)}</div>
            </div>
          );
        })}
      </div>

      {displayed.length === 0 && (
        <p className="px-5 py-6 text-[13px] text-muted-foreground">
          Every account has a decision. Save and reprocess to rebuild the statements.
        </p>
      )}

      {/* Footer — the one action on this panel */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-border px-5 py-4">
        <p className="text-[12px] text-muted-foreground tabular-nums">
          {remaining > 0
            ? `${remaining} account${remaining === 1 ? "" : "s"} still need a decision`
            : "All decisions recorded"}
        </p>
        <Button
          onClick={handleSaveAndReprocess}
          disabled={!allResolved || isWorking}
          className="gap-2 rounded-none w-full sm:w-auto"
        >
          {isWorking ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {saving ? "Saving…" : "Reprocessing…"}
            </>
          ) : (
            <>
              <CheckCircle className="w-4 h-4" />
              Save &amp; reprocess
            </>
          )}
        </Button>
      </div>
    </SurfaceCard>
  );
}