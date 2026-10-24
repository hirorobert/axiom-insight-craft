import { WorkspacePurposeSettings } from "@/components/workspace/WorkspacePurposeSettings";
import { FRAMEWORK_OPTIONS } from "@/lib/workspace/frameworkOptions";
import { useManagementEditGuard } from "@/components/account/managementState";
import { useBusyState } from "@/hooks/useBusyState";
import { useState, useEffect, useRef } from "react";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { EntityCapacityNotice } from "@/components/commercial/EntityCapacityNotice";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Settings, Plus, Pencil, Trash2, Building2, ArrowRight } from "lucide-react";
import { useAuditLog } from "@/hooks/useAuditLog";
import { validateTin } from "@/components/workspace/CompanyTinDialog";
import { FrameworkConfirmationBanner } from "@/components/FrameworkConfirmationBanner";
import { deriveCompanyFieldLock, deriveFrameworkFieldLock, guardCompanyFieldChange, type ProcessingCertainty } from "@/lib/accounting/companyFieldLock";
import { changeReportingFramework, frameworkRequestFor, type FrameworkChangeClient, type PendingFrameworkRequest, type ReportingFramework } from "@/lib/workspace/companyFramework";
import { saveCompanyEdit } from "@/lib/workspace/companyEdit";
import { capacityCopy } from "@/lib/commercial/paidActions";
import { parseCreateEntityOutcome } from "@/lib/commercial/entityCreation";

const FRAMEWORK_LABELS: Record<string, string> = {
  ifrs_for_smes: "IFRS for SMEs",
  full_ifrs: "Full IFRS",
  ipsas_accrual: "IPSAS Accrual",
  ipsas_cash: "IPSAS Cash Basis",
};

// A TIN is considered missing when it's null/blank, matches a known
// placeholder sentinel, or contains no digits (real TRA TINs are numeric).
const isTinMissing = (tin: string | null | undefined): boolean => {
  if (!tin) return true;
  const v = tin.trim();
  if (!v) return true;
  if (/^put[-_ ]?real/i.test(v)) return true;
  if (/placeholder|todo|tbd|xxx/i.test(v)) return true;
  if (!/\d/.test(v)) return true;
  return false;
};

interface Company {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  industry: string | null;
  fiscal_year_end: string;
  currency: string;
  /**
   * Phase 1 (SAFF V5 PART IX): companies.reporting_framework no longer has a
   * schema default — null means genuinely not yet selected. Never coalesce
   * this to "ifrs_for_smes" anywhere; detectEntityAccountingContext() already
   * treats null as UNKNOWN/NONE confidence correctly.
   */
  reporting_framework: string | null;
  tin: string | null;
  is_active: boolean;
  created_at: string;
}

interface CompanyFormData {
  name: string;
  code: string;
  tin: string;
  description: string;
  industry: string;
  fiscal_year_end: string;
  /**
   * Reporting year for NEW companies only. Combined with the MM-DD
   * fiscal_year_end into a full ISO date ('YYYY-MM-DD') on create, so new
   * rows never fall back to the legacy year-less format. Ignored when
   * editing (the stored row's own year prefix is preserved instead).
   */
  reporting_year: string;
  currency: string;
  reporting_framework: string | null;
}

const EMPTY_FORM_DATA: CompanyFormData = {
  name: "",
  code: "",
  tin: "",
  description: "",
  industry: "",
  fiscal_year_end: "12-31",
  reporting_year: String(new Date().getFullYear() - 1),
  currency: "TZS",
  reporting_framework: null,
};

/**
 * StartCorrectedEngagementAffordance — the one controlled path past locked period/framework fields.
 * There is no in-place mutation of any kind here: opening the picker and confirming a year only
 * ever calls `onStartCorrectedEngagement`, which navigates to the workspace for that company/year
 * through the existing authoritative creation path (ServiceLaunchpad → open_engagement_with_scope)
 * — the SAME idempotent, uniqueness-constrained entry point every other new engagement goes
 * through. Nothing here writes to `companies.reporting_framework` or `companies.fiscal_year_end`,
 * and nothing here copies the original engagement's certifications, drafts, reconciliations or
 * processing status — a corrected engagement always starts genuinely empty.
 */
function StartCorrectedEngagementAffordance({
  reason,
  yearOptions,
  onStartCorrectedEngagement,
}: {
  reason: string | null;
  yearOptions: number[];
  onStartCorrectedEngagement: (year: number) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [year, setYear] = useState(String(yearOptions[0]));

  if (picking) {
    return (
      <div className="space-y-2 rounded-md border border-border p-2.5" data-testid="corrected-engagement-panel">
        <Label htmlFor="corrected-engagement-year" className="text-xs">
          Period for the corrected engagement
        </Label>
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger id="corrected-engagement-year" data-testid="corrected-engagement-year-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {yearOptions.map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          This opens a new, separate engagement for the same entity. The original engagement and every
          result already produced under it stay exactly as they are — nothing is copied or overwritten.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPicking(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onStartCorrectedEngagement(Number(year))}
            data-testid="confirm-corrected-engagement"
          >
            Continue <ArrowRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="field-lock-reason">
        {reason}
      </p>
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        data-testid="start-corrected-engagement"
      >
        Start corrected engagement
      </button>
    </div>
  );
}

export const CompanyManager = ({ presentation = "dialog", companyId, onDone }: {
  presentation?: "dialog" | "inline"; companyId?: string; onDone?: () => void;
}) => {
  const inline = presentation === "inline";
  const [saving, setSaving] = useBusyState("Saving company…");
  const [deleting, setDeleting] = useBusyState("Removing company…");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [finished, setFinished] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  // One request id per new-company form: a retried submission returns the SAME workspace (create_entity is idempotent).
  const [creationRequestId, setCreationRequestId] = useState<string>(() => crypto.randomUUID());
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [tinTouched, setTinTouched] = useState(false);
  const { user } = useAuth();
  const { capacity, loading: capacityLoading, error: capacityError, retry: retryCapacity } = useMyEntityCapacity(!!user);
  const canAdd = !capacityLoading && !capacityError && !!capacity?.determined && (capacity.unlimited === true || (capacity.capacity !== null && capacity.used !== null && capacity.used < capacity.capacity));
  const { logAction } = useAuditLog();
  const navigate = useNavigate();

  const [formData, setFormData] = useState<CompanyFormData>(EMPTY_FORM_DATA);
  const formBaseline = useRef(JSON.stringify(EMPTY_FORM_DATA));
  const lockRead = useRef(0);
  const [purposeEdit, setPurposeEdit] = useState({ dirty: false, busy: false });
  const dirty = formDialogOpen && (JSON.stringify(formData) !== formBaseline.current || purposeEdit.dirty);
  useManagementEditGuard(dirty, saving || deleting || purposeEdit.busy);
  const closeForm = () => {
    if (saving || purposeEdit.busy) return;
    if (dirty) { setDiscardPrompt(true); return; }
    setFormDialogOpen(false);
    if (companyId) setFinished(true);
  };

  // ── Period/framework contract: once ANY trial balance for this company has been processed,
  // reporting_framework and fiscal_year_end are IMMUTABLE — there is no reason-based override of
  // any kind (an audit log entry does not preserve financial consistency). "checking" is the
  // default the instant the edit dialog opens: the read has not resolved yet, so the fields stay
  // locked until a POSITIVE "not_processed" confirmation arrives — never optimistically unlocked
  // while uncertain, and a failed read locks just as hard as a confirmed "processed" (fail closed).
  const [processingCertainty, setProcessingCertainty] = useState<ProcessingCertainty>("checking");

  const fieldLock = deriveCompanyFieldLock({ processingCertainty });
  // The framework's own lock: a DECIDED framework follows fieldLock exactly; a never-decided one (NULL) may record its
  // first decision, which the server permits, audits and refuses while a check runs (deriveFrameworkFieldLock).
  const frameworkLock = deriveFrameworkFieldLock({ current: editingCompany ? editingCompany.reporting_framework : undefined, processingCertainty });
  const frameworkEditable = !frameworkLock.locked;
  // One request id per framework intent (company, expected current value, target): kept across an uncertain answer so a
  // resend is replayed by the server, never applied twice; a different intent gets a new id (frameworkRequestFor).
  const frameworkRequest = useRef<PendingFrameworkRequest | null>(null);
  const fiscalYearEndEditable = !fieldLock.locked;

  const correctedEngagementYearOptions = (() => {
    const stored = editingCompany?.fiscal_year_end;
    const storedYear = stored && /^\d{4}-\d{2}-\d{2}$/.test(stored) ? Number(stored.slice(0, 4)) : new Date().getFullYear();
    // Centred on the company's own stored year so the picker starts somewhere meaningful, never a
    // fabricated default — the user still explicitly confirms the period before anything opens.
    return Array.from({ length: 7 }, (_, i) => storedYear + 2 - i);
  })();

  const startCorrectedEngagement = (year: number) => {
    if (!editingCompany) return;
    // Keep inline edits mounted until the route blocker accepts leaving.
    if (!inline) { setFormDialogOpen(false); setDialogOpen(false); }
    // Pure navigation — no Supabase call, no mutation of this company's row, no copy of any
    // certification/draft/reconciliation/processing status from the original engagement. The
    // destination is the existing authoritative creation path: WorkspaceLayout/WorkspaceOverview
    // for this company+year, which renders ServiceLaunchpad (open_engagement_with_scope) when no
    // engagement exists yet for that period, or safely resumes the existing one if it does — the
    // DB's own uq_engagements_one_open_per_period constraint is what prevents a duplicate.
    navigate(`/workspace/${editingCompany.id}/${year}`);
  };

  const fetchCompanies = async () => {
    if (!user) return;
    setLoadError(false);
    try {
      const { data, error } = await supabase.from("companies").select("*").eq("is_active", true).order("name");
      if (error) throw error;
      setCompanies(data ?? []);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if ((dialogOpen || inline) && !companyId) {
      fetchCompanies();
    }
  }, [user, dialogOpen, inline, companyId]);

  const resetForm = () => {
    setDiscardPrompt(false);
    setFormData(EMPTY_FORM_DATA);
    formBaseline.current = JSON.stringify(EMPTY_FORM_DATA);
    setCreationRequestId(crypto.randomUUID());
    setEditingCompany(null);
    setTinTouched(false);
    // A brand-new company has nothing processed, but the very next handleEdit() sets this back to
    // "checking" first — resetForm() only ever runs between edits, never mid-check.
    ++lockRead.current;
    setProcessingCertainty("not_processed");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || purposeEdit.busy) return;

    if (formData.tin.trim() && tinError) {
      setTinTouched(true);
      toast.error(tinError);
      return;
    }

    // The form's dropdown only carries MM-DD. If the stored value was a full
    // ISO date ('YYYY-MM-DD'), re-apply its year prefix so saving an
    // unrelated edit never silently drops the reporting year. For a NEW
    // company, combine the MM-DD with the explicitly selected reporting year
    // so new rows are always stored as full ISO dates — never the legacy
    // year-less 'MM-DD' format, which cannot be year-matched later.
    const storedFye = editingCompany?.fiscal_year_end ?? "";
    const storedYearPrefix = /^\d{4}-\d{2}-\d{2}$/.test(storedFye) ? storedFye.slice(0, 5) : "";
    const yearPrefix = editingCompany
      ? storedYearPrefix
      : `${formData.reporting_year}-`;
    const resolvedFiscalYearEnd =
      yearPrefix && /^\d{2}-\d{2}$/.test(formData.fiscal_year_end)
        ? `${yearPrefix}${formData.fiscal_year_end}`
        : formData.fiscal_year_end;

    // Fail closed even if a disabled control were somehow bypassed (a direct handler invocation,
    // a devtools edit): a locked field can NEVER reach the database, unconditionally — there is no
    // reason parameter here through which that could be overridden. This is the actual enforcement;
    // the disabled Select above is only the affordance.
    const frameworkChanged = !!editingCompany && formData.reporting_framework !== editingCompany.reporting_framework;
    const fiscalYearEndChanged = !!editingCompany && resolvedFiscalYearEnd !== editingCompany.fiscal_year_end;
    const guard = guardCompanyFieldChange({
      locked: !!editingCompany && fieldLock.locked,
      frameworkLocked: !!editingCompany && frameworkLock.locked,
      frameworkChanged,
      fiscalYearEndChanged,
    });
    if (!guard.allowed) {
      toast.error(
        guard.blockedField === "reporting_framework"
          ? "Reporting framework is locked because trial balance data has already been processed. Start a corrected engagement instead."
          : "Fiscal year end is locked because trial balance data has already been processed. Start a corrected engagement instead.",
      );
      return;
    }

    if (!setSaving(true)) return;
    try {
      if (editingCompany) {
        // The reporting framework changes ONLY through the audited server operation (20261127100000); the database refuses
        // a direct update of it (20261128100000). Other company fields keep their direct, RLS-authorised update.
        if (frameworkChanged && !formData.reporting_framework) {
          // A recorded decision is changed to another framework, never cleared (the server has no "undecided" target).
          toast.error("A recorded reporting framework can be changed to another framework but not cleared.");
          return;
        }
        let pending: PendingFrameworkRequest | null = null;
        if (frameworkChanged && formData.reporting_framework) {
          pending = frameworkRequestFor(frameworkRequest.current, {
            companyId: editingCompany.id,
            from: (editingCompany.reporting_framework ?? null) as ReportingFramework | null,
            to: formData.reporting_framework as ReportingFramework,
          }, () => crypto.randomUUID());
          frameworkRequest.current = pending;
        }
        const editing = editingCompany;
        const outcome = await saveCompanyEdit({
          changeFramework: () => changeReportingFramework(supabase as unknown as FrameworkChangeClient, pending as PendingFrameworkRequest),
          updateDetails: async () => {
            const { error } = await supabase
              .from("companies")
              .update({
                name: formData.name,
                code: formData.code || null,
                tin: formData.tin.trim() || null,
                description: formData.description || null,
                industry: formData.industry || null,
                fiscal_year_end: resolvedFiscalYearEnd,
                currency: formData.currency,
              } as never)
              .eq("id", editing.id);
            return { error };
          },
        }, { frameworkTo: pending ? pending.to : null });
        // A definite answer ends the intent; an uncertain one keeps its request id for the resend.
        if (outcome.kind !== "framework_uncertain") frameworkRequest.current = null;
        if (outcome.kind !== "saved") {
          toast.error(outcome.message);
          // After anything that may have changed the row, re-read it before the next save: the form then sends only what
          // is still different (after a partial save, only the details).
          if (outcome.kind === "framework_uncertain" || outcome.kind === "partial") await refreshEditingCompany(editing.id);
          return;
        }
        if (outcome.frameworkChange?.kind === "changed" && editing.reporting_framework === null && processingCertainty !== "not_processed") {
          toast.message("Reporting framework recorded. Trial balance checks made before this decision must be run again under it.");
        }

        logAction({
          action: "update_company",
          entityType: "company",
          entityId: editingCompany.id,
          metadata: { name: formData.name },
        });

        toast.success("Company updated successfully");
      } else {
        // create_entity (20260925100000): created for the signed-in user; entity capacity enforced by the server;
        // idempotent per request id.
        const { data, error } = await supabase.rpc("create_entity" as never, {
          p_request_id: creationRequestId,
          p_name: formData.name,
          p_fiscal_year_end: resolvedFiscalYearEnd,
          p_currency: formData.currency,
          p_reporting_framework: formData.reporting_framework,
          p_code: formData.code || null,
          p_tin: formData.tin.trim() || null,
          p_description: formData.description || null,
          p_industry: formData.industry || null,
        } as never);

        if (error) throw error;

        const outcome = parseCreateEntityOutcome(data);
        if (outcome.kind === "capacity") {
          const copy = capacityCopy(outcome.capacity);
          toast.error(copy.title, { description: `${copy.unavailable} ${copy.remains}` });
          return;
        }
        if (outcome.kind !== "created") throw new Error("The company could not be created.");

        logAction({
          action: "create_company",
          entityType: "company",
          entityId: outcome.companyId,
          metadata: { name: formData.name },
        });

        toast.success("Company created successfully");
      }

      if (!purposeEdit.dirty && !purposeEdit.busy) {
        setFormDialogOpen(false);
        resetForm();
        if (companyId) setFinished(true); else fetchCompanies();
      } else { formBaseline.current = JSON.stringify(formData); }
      retryCapacity();
    } catch (error) {
      console.error("Company save error:", error);
      toast.error("Could not confirm the company save. Your entries are kept; check the company list before retrying.");
    }
    finally { setSaving(false); }
  };

  // Re-reads the edited company after an uncertain or partial save; the user's entries stay in the form.
  const refreshEditingCompany = async (id: string) => {
    try {
      const { data, error } = await supabase.from("companies").select("*").eq("id", id).maybeSingle();
      if (!error && data) setEditingCompany(data as Company);
    } catch { /* the toast already says the state could not be confirmed */ }
    fetchCompanies();
  };

  const handleEdit = (company: Company) => {
    const read = ++lockRead.current;
    setEditingCompany(company);
    // Fields stay locked (see processingCertainty's default) until this read positively confirms
    // "not_processed" — a slow or failed read must never be mistaken for "nothing has processed".
    setProcessingCertainty("checking");
    // Values originate from the persisted row (never fabricated). The lock check is a separate
    // read; both its resolved outcome AND its failure path are handled explicitly — there is no
    // implicit "unlocked" branch.
    supabase
      .from("trial_balance_uploads")
      .select("id")
      .eq("company_id", company.id)
      .not("processed_at", "is", null)
      .limit(1)
      .then(
        ({ data, error }) => {
          if (read !== lockRead.current) return;
          if (error) {
            setProcessingCertainty("check_failed");
            return;
          }
          setProcessingCertainty(data && data.length > 0 ? "processed" : "not_processed");
        },
        () => { if (read === lockRead.current) setProcessingCertainty("check_failed"); },
      );
    const editData: CompanyFormData = {
      name: company.name,
      code: company.code || "",
      tin: company.tin || "",
      description: company.description || "",
      industry: company.industry || "",
      // Stored value may be a full ISO date 'YYYY-MM-DD' (workspaces created
      // via first-run setup) or legacy 'MM-DD'. The dropdown only understands
      // MM-DD, so seed it with the month-day portion; the year prefix is
      // re-applied on save (see handleSubmit) so the reporting year is never
      // silently dropped.
      fiscal_year_end: /^\d{4}-\d{2}-\d{2}$/.test(company.fiscal_year_end)
        ? company.fiscal_year_end.slice(5)
        : company.fiscal_year_end,
      // Editing never uses this field (the stored row's own year prefix is
      // preserved on save), but seed it from the stored ISO year anyway so
      // the value is never fabricated if the row predates the ISO format.
      reporting_year: /^\d{4}-\d{2}-\d{2}$/.test(company.fiscal_year_end)
        ? company.fiscal_year_end.slice(0, 4)
        : String(new Date().getFullYear() - 1),
      currency: company.currency,
      // Phase 1: pass the real value through, including null. Coalescing to
      // "ifrs_for_smes" here would silently overwrite a genuinely-unset
      // company's framework the moment the edit dialog is saved.
      reporting_framework: company.reporting_framework,
    };
    setDiscardPrompt(false);
    formBaseline.current = JSON.stringify(editData);
    setFormData(editData);
    setFormDialogOpen(true);
  };

  useEffect(() => {
    if (!companyId || !user) return;
    let live = true;
    setLoading(true);
    void supabase.from("companies").select("*").eq("id", companyId).eq("is_active", true).maybeSingle().then(({ data, error }) => {
      if (!live) return;
      if (error || !data) setLoadError(true); else handleEdit(data);
      setLoading(false);
    }, () => { if (live) { setLoadError(true); setLoading(false); } });
    return () => { live = false; ++lockRead.current; };
    // The scoped editor is keyed by company at its host. Never reload and overwrite a dirty form on a callback change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, user?.id]);
  useEffect(() => { if (finished && !saving && !dirty) onDone?.(); }, [finished, saving, dirty, onDone]);

  const tinError = formData.tin.trim() ? validateTin(formData.tin) : null;
  const showTinError = tinTouched && !!tinError;

  const handleDelete = async (company: Company) => {
    if (!confirm(`Are you sure you want to delete "${company.name}"?`)) return;

    if (!setDeleting(true)) return;
    setDeletingId(company.id);
    try {
      const { error } = await supabase
        .from("companies")
        .update({ is_active: false })
        .eq("id", company.id);

      if (error) throw error;

      logAction({
        action: "delete_company",
        entityType: "company",
        entityId: company.id,
        metadata: { name: company.name },
      });

      toast.success("Company deleted");
      fetchCompanies();
      retryCapacity();
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete company");
    }
    finally { setDeleting(false); setDeletingId(null); }
  };

  const companyList = (
          <div className="space-y-4">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={!canAdd}
              onClick={() => {
                resetForm();
                setFormDialogOpen(true);
              }}
            >
              <Plus className="w-4 h-4" />
              Add Company
            </Button>
            <EntityCapacityNotice capacity={capacity} loading={capacityLoading} error={capacityError} onRetry={retryCapacity} />

            {loadError ? <p role="alert" className="py-4 text-sm text-destructive">Companies could not be loaded. <Button variant="outline" size="sm" onClick={fetchCompanies}>Try again</Button></p> : loading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>
            ) : companies.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No companies yet. Add one to organize your trial balances.
              </p>
            ) : (
              <div className="divide-y divide-border border border-border">
                {companies.map((company) => (
                  <div
                    key={company.id}
                    className="flex flex-wrap items-center justify-between gap-3 bg-card px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <Building2 className="w-4 h-4 text-primary" />
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{company.name}</span>
                          {company.code && (
                            <Badge variant="outline" className="text-xs">
                              {company.code}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-xs text-foreground/60 border-border">
                            {company.reporting_framework
                              ? FRAMEWORK_LABELS[company.reporting_framework] || company.reporting_framework
                              : "Not determined"}
                          </Badge>
                          {isTinMissing(company.tin) && (
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                              title="The tax identifier is missing or still a placeholder."
                            >
                              Tax identifier needed
                            </Badge>
                          )}
                        </div>
                        {company.industry && (
                          <p className="text-xs text-muted-foreground">{company.industry}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${company.name}`}
                        onClick={() => handleEdit(company)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        pending={deletingId === company.id} disabled={deleting}
                        aria-label={`Remove ${company.name}`}
                        onClick={() => handleDelete(company)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      >
                        {deletingId !== company.id && <Trash2 className="w-3 h-3" />}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
  );
  const companyForm = (
          <form onSubmit={handleSubmit} aria-busy={saving} className="space-y-4 overflow-y-auto flex-1 pr-1">
            {discardPrompt && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/30 p-4 text-sm"><p>Discard the unsaved company changes?</p><div className="flex gap-2"><Button type="button" variant="outline" onClick={() => setDiscardPrompt(false)}>Keep editing</Button><Button type="button" variant="destructive" onClick={() => { setFormDialogOpen(false); resetForm(); if (companyId) setFinished(true); }}>Discard changes</Button></div></div>}
            <fieldset disabled={saving} className="contents">
            <div className="space-y-2">
              <Label htmlFor="name">Company Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Acme Corporation"
                required
              />
            </div>

            {/* TIN — mandatory for TRA submissions */}
            <div className="space-y-2">
              <Label htmlFor="tin">
                Tax identifier
                <span className="ml-1 text-xs text-muted-foreground">(only where your filing jurisdiction requires it)</span>
              </Label>
              <Input
                id="tin"
                value={formData.tin}
                inputMode="numeric"
                maxLength={11}
                aria-invalid={showTinError}
                className={showTinError ? "border-destructive focus-visible:ring-destructive" : undefined}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
                  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean);
                  setFormData({ ...formData, tin: parts.join("-") });
                }}
                onBlur={() => setTinTouched(true)}
                placeholder="e.g. 100-123-456"
              />
              {showTinError ? (
                <p role="alert" className="text-xs text-destructive">{tinError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Exactly 9 digits, formatted as 123-456-789.</p>
              )}
            </div>

            {/* Reporting Framework — set once at company level */}
            <div className="space-y-2">
              <Label htmlFor="reporting_framework">Reporting Framework</Label>
              {editingCompany && (
                <FrameworkConfirmationBanner
                  reportingFrameworkDbValue={formData.reporting_framework}
                  companyCreatedAt={(editingCompany as { created_at?: string } | null)?.created_at ?? null}
                />
              )}
              <Select
                value={formData.reporting_framework ?? undefined}
                onValueChange={(value) => setFormData({ ...formData, reporting_framework: value })}
                disabled={!frameworkEditable}
              >
                <SelectTrigger data-testid="reporting-framework-select">
                  <SelectValue placeholder="Not determined — select a framework" />
                </SelectTrigger>
                <SelectContent>
                  {FRAMEWORK_OPTIONS.filter((framework) => framework.dbValue !== null).map((framework) => <SelectItem key={framework.value} value={framework.value}>{framework.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {!frameworkEditable ? (
                <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="reporting-framework-lock-reason">
                  {frameworkLock.reason}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Records the company’s reporting framework. Report availability is checked separately. Once decided, it is locked when trial balance data has been processed.
                </p>
              )}
            </div>

            <div className={`grid gap-4 ${editingCompany ? "grid-cols-2" : "grid-cols-3"}`}>
              {!editingCompany && (
                <div className="space-y-2">
                  <Label htmlFor="reporting_year">Reporting Year</Label>
                  <Select
                    value={formData.reporting_year}
                    onValueChange={(value) => setFormData({ ...formData, reporting_year: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => (
                        <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="fiscal_year_end">Fiscal Year End</Label>
                <Select
                  value={formData.fiscal_year_end}
                  onValueChange={(value) => setFormData({ ...formData, fiscal_year_end: value })}
                  disabled={!fiscalYearEndEditable}
                >
                  <SelectTrigger data-testid="fiscal-year-end-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="03-31">March 31</SelectItem>
                    <SelectItem value="06-30">June 30</SelectItem>
                    <SelectItem value="09-30">September 30</SelectItem>
                    <SelectItem value="12-31">December 31</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Select
                  value={formData.currency}
                  onValueChange={(value) => setFormData({ ...formData, currency: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TZS">TZS — Tanzanian Shilling</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="GBP">GBP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fieldLock.locked && editingCompany && (
              <StartCorrectedEngagementAffordance
                reason={fieldLock.reason}
                yearOptions={correctedEngagementYearOptions}
                onStartCorrectedEngagement={startCorrectedEngagement}
              />
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" disabled={saving} onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" pending={saving} pendingLabel="Saving company…" disabled={showTinError || saving || purposeEdit.busy}>
                {editingCompany ? "Update" : "Create"}
              </Button>
            </div>
            </fieldset>
          </form>
  );
  return <>
    {companyId && loading ? <p role="status">Reading company details…</p> : companyId && loadError ? <p role="alert">Company details could not be read. Close and try again.</p> : inline ? (formDialogOpen ? <section aria-label={editingCompany ? "Edit company" : "Add company"}>
      <div className="mb-5 flex items-center justify-between gap-3"><h3 className="text-base font-semibold">{editingCompany ? "Edit company" : "Add company"}</h3><Button type="button" variant="outline" disabled={saving} onClick={closeForm}>{companyId ? "Cancel" : "Back to companies"}</Button></div>
      {companyForm}
      {editingCompany && <WorkspacePurposeSettings key={editingCompany.id} companyId={editingCompany.id} onEditState={setPurposeEdit} disabled={saving || deleting} />}
    </section> : companyList) : <>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild><Button variant="outline" size="sm" className="gap-2"><Settings className="h-4 w-4" />Manage</Button></DialogTrigger>
        <DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>Manage companies</DialogTitle></DialogHeader>{companyList}</DialogContent>
      </Dialog>
      <Dialog open={formDialogOpen} onOpenChange={(open) => { if (!open) closeForm(); }}>
        <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col"><DialogHeader><DialogTitle>{editingCompany ? "Edit company" : "Add company"}</DialogTitle></DialogHeader>{companyForm}</DialogContent>
      </Dialog>
    </>}
  </>;
};
