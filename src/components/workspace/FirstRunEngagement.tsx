/**
 * FirstRunEngagement — global workspace creation screen.
 *
 * Ω∞ GLOBAL FIRST-RUN REMEDIATION
 *
 * Screen 1 of 2. Collects the minimum required to create a workspace:
 *   - Organization name (required)
 *   - Reporting period year + year-end date (required)
 *   - Functional currency (required — no default; must be explicitly selected)
 *   - Reporting framework (optional — can be set later in workspace settings)
 *
 * INVARIANTS
 * - No TIN, TRA, tax-registration, or jurisdiction-specific terminology.
 * - No pre-filled or seeded organization name.
 * - Currency has no default. The user must explicitly select it. No locale
 *   inference, no IP-based guessing (CODEX Phase 3A).
 * - Framework defaults to null — never manufacture certainty about
 *   standards the user has not declared (SAFF V5 PART IX).
 * - Framework options are limited to values the DB CHECK constraint
 *   can preserve after reload: decide_later → null, full_ifrs, ifrs_for_smes,
 *   ipsas_accrual, ipsas_cash. "Local GAAP" and "Other/custom" are
 *   intentionally omitted because they would both store as null, collapsing
 *   three distinct user choices into the same DB value with no way to
 *   distinguish them on next load (CODEX Phase 3B).
 * - No "I was invited" path — Auth.tsx has no invitation token handler and
 *   no mechanism to route an invited user to their workspace. Removed to
 *   avoid routing users into a dead end (CODEX Phase 3D).
 * - Idempotency: deduplication check prevents duplicate workspaces on
 *   double-click or retry. DB-level constraint absent (see Phase 3E report).
 * - Error handler maps known Supabase error classes to actionable messages.
 *   Form values are preserved on any recoverable failure.
 *
 * DB constraint: reporting_framework IN
 *   (null, 'ifrs_for_smes', 'full_ifrs', 'ipsas_accrual', 'ipsas_cash')
 */

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowRight, AlertCircle, RefreshCw } from "lucide-react";
import { classifyError } from "./workspaceCreateError";

// ── Constants ────────────────────────────────────────────────────────────────

// De-duplicated (June was duplicated in a prior draft)
const UNIQUE_FYE_OPTIONS = [
  { value: "12-31", label: "31 December" },
  { value: "06-30", label: "30 June" },
  { value: "03-31", label: "31 March" },
  { value: "09-30", label: "30 September" },
] as const;

const CURRENCY_OPTIONS = [
  { value: "USD", label: "USD — US Dollar" },
  { value: "EUR", label: "EUR — Euro" },
  { value: "GBP", label: "GBP — British Pound" },
  { value: "GHS", label: "GHS — Ghanaian Cedi" },
  { value: "KES", label: "KES — Kenyan Shilling" },
  { value: "NGN", label: "NGN — Nigerian Naira" },
  { value: "TZS", label: "TZS — Tanzanian Shilling" },
  { value: "UGX", label: "UGX — Ugandan Shilling" },
  { value: "ZAR", label: "ZAR — South African Rand" },
] as const;

/**
 * Reporting framework options.
 *
 * DB column allows: null | 'ifrs_for_smes' | 'full_ifrs' | 'ipsas_accrual' | 'ipsas_cash'
 *
 * Only options whose identity can be preserved after a reload are exposed here.
 * "Local GAAP" and "Other/custom" were removed because both would store as null —
 * indistinguishable from "Decide later" on next load (CODEX Phase 3B).
 */
const FRAMEWORK_OPTIONS: { value: string; label: string; dbValue: string | null }[] = [
  { value: "decide_later",  label: "Decide later",                        dbValue: null },
  { value: "full_ifrs",     label: "Full IFRS",                           dbValue: "full_ifrs" },
  { value: "ifrs_for_smes", label: "IFRS for SMEs",                      dbValue: "ifrs_for_smes" },
  { value: "ipsas_accrual", label: "IPSAS — public sector (accrual)",    dbValue: "ipsas_accrual" },
  { value: "ipsas_cash",    label: "IPSAS — public sector (cash basis)", dbValue: "ipsas_cash" },
];

// ── Component ────────────────────────────────────────────────────────────────

type SubmitState = "idle" | "submitting" | "error";

export default function FirstRunEngagement({
  onCreated,
}: {
  onCreated: (companyId: string, periodYear: number) => void;
}) {
  const { user } = useAuth();
  const defaultYear = new Date().getFullYear() - 1;

  // Form fields
  const [orgName, setOrgName]         = useState("");
  const [fye, setFye]                 = useState("12-31");
  const [periodYear, setPeriodYear]   = useState(String(defaultYear));
  // Phase 3A: No default currency. User must make an explicit selection.
  const [currency, setCurrency]       = useState("");
  const [framework, setFramework]     = useState("decide_later");

  // Submit state machine
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);
  const [canRetry, setCanRetry]       = useState(false);

  // Phase 3A: currency is required — canSubmit blocks until it is set. (Single-line for test regex.)
  const canSubmit = orgName.trim().length > 0 && currency.length > 0 && submitState !== "submitting";

  const yearOptions = Array.from({ length: 6 }, (_, i) => defaultYear + 1 - i);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !canSubmit) return;

    setSubmitState("submitting");
    setErrorMsg(null);

    try {
      const year = parseInt(periodYear, 10);
      const name = orgName.trim();

      // ── Idempotency guard ───────────────────────────────────────────────
      // Check for a workspace with the same name + fiscal year end before
      // inserting, so double-clicks and retries cannot create duplicates.
      // Note: this is a client-side pre-check only. The companies table has
      // no DB-level UNIQUE constraint on (user_id, name, fiscal_year_end).
      // See Phase 3E: WORKSPACE_CREATION_CONCURRENCY_SAFE = NO.
      const { data: existing } = await supabase
        .from("companies")
        .select("id, fiscal_year_end")
        .eq("user_id", user.id)
        .eq("name", name)
        .eq("is_active", true)
        .limit(5);

      // fiscal_year_end is a full ISO date 'YYYY-MM-DD' so the chosen reporting
      // year is persisted and recoverable on a later visit. Two workspaces with
      // the same name but different reporting years are NOT duplicates.
      // Legacy rows stored as bare 'MM-DD' carry no reporting year, so they can
      // never be confirmed as the same year the user just chose — they must NOT
      // be treated as duplicates, or a new workspace for a different year would
      // be silently skipped (the user would be dropped into the old workspace
      // with no new one created and no warning).
      const fiscalYearEnd = `${year}-${fye}`;
      const duplicate = existing?.find(
        (c) => c.fiscal_year_end === fiscalYearEnd,
      );

      if (duplicate) {
        // Already exists — treat as success and route in
        onCreated(duplicate.id as string, year);
        return;
      }

      // ── Map UI framework choice to DB-permitted value ───────────────────
      const chosen = FRAMEWORK_OPTIONS.find((f) => f.value === framework);
      const dbFramework = chosen?.dbValue ?? null;

      // ── Create workspace ────────────────────────────────────────────────
      const { data, error } = await supabase
        .from("companies")
        .insert({
          name:               name,
          fiscal_year_end:    fiscalYearEnd,   // full ISO date — e.g. '2022-12-31'
          currency:           currency,
          // null is intentional and correct — reporting_framework has no
          // NOT NULL DEFAULT after migration 20260903100000. Null means
          // "not yet declared", never "IFRS for SMEs by default".
          reporting_framework: dbFramework,
          user_id:             user.id,
        } as never)
        .select("id")
        .single();

      if (error) throw error;

      onCreated(data.id as string, year);
    } catch (err) {
      const classified = classifyError(err);
      setErrorMsg(classified.message);
      setCanRetry(classified.canRetry);
      setSubmitState("error");
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-[520px] space-y-6"
      aria-label="Create reporting workspace"
    >
      {/* Header */}
      <div className="space-y-1.5">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Step 1 of 2
        </p>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Set up your reporting workspace
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Add the organization and reporting period you want to work on.
          You can configure reporting and tax requirements later.
        </p>
      </div>

      {/* Fields */}
      <div className="space-y-4 border border-border p-5">

        {/* Organization name */}
        <div className="space-y-2">
          <Label htmlFor="fr-org">Organization name</Label>
          <Input
            id="fr-org"
            autoFocus
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Enter the organization you are reporting for"
            required
            aria-required="true"
          />
        </div>

        {/* Reporting period */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="fr-year">Reporting year</Label>
            <Select value={periodYear} onValueChange={setPeriodYear}>
              <SelectTrigger id="fr-year" aria-label="Reporting year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fr-fye">Period ends</Label>
            <Select value={fye} onValueChange={setFye}>
              <SelectTrigger id="fr-fye" aria-label="Reporting period end">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNIQUE_FYE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Functional currency — required, no default */}
        <div className="space-y-2">
          <Label htmlFor="fr-currency">
            Functional currency
            <span className="font-normal text-muted-foreground"> — required</span>
          </Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger
              id="fr-currency"
              aria-label="Functional currency"
              aria-required="true"
            >
              <SelectValue placeholder="Select your functional currency" />
            </SelectTrigger>
            <SelectContent>
              {CURRENCY_OPTIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Reporting framework — optional progressive disclosure */}
        <div className="space-y-2">
          <Label htmlFor="fr-framework">
            Reporting framework{" "}
            <span className="font-normal text-muted-foreground">— optional</span>
          </Label>
          <Select value={framework} onValueChange={setFramework}>
            <SelectTrigger id="fr-framework" aria-label="Reporting framework">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FRAMEWORK_OPTIONS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {framework === "decide_later" && (
            <p className="text-[12px] text-muted-foreground">
              You can set this later. Statement presentation and validation rules
              are applied once a framework is declared.
            </p>
          )}
        </div>
      </div>

      {/* Error state */}
      {submitState === "error" && errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-3 p-4 border border-destructive/40 bg-destructive/5 rounded-sm"
        >
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
          <div className="space-y-2 flex-1 min-w-0">
            <p className="text-sm text-destructive leading-relaxed">{errorMsg}</p>
            {canRetry && (
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                Try again
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Primary CTA */}
      <Button
        type="submit"
        size="lg"
        className="w-full gap-2"
        disabled={!canSubmit}
        aria-busy={submitState === "submitting"}
      >
        {submitState === "submitting"
          ? "Creating workspace…"
          : "Create workspace"}
        {submitState !== "submitting" && (
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>
    </form>
  );
}
