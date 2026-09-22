import { useState, useEffect } from "react";
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
import { deriveCompanyFieldLock, guardCompanyFieldChange, type ProcessingCertainty } from "@/lib/accounting/companyFieldLock";

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

export const CompanyManager = () => {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [tinTouched, setTinTouched] = useState(false);
  const { user } = useAuth();
  const { logAction } = useAuditLog();
  const navigate = useNavigate();

  const [formData, setFormData] = useState<CompanyFormData>(EMPTY_FORM_DATA);

  // ── Period/framework contract: once ANY trial balance for this company has been processed,
  // reporting_framework and fiscal_year_end are IMMUTABLE — there is no reason-based override of
  // any kind (an audit log entry does not preserve financial consistency). "checking" is the
  // default the instant the edit dialog opens: the read has not resolved yet, so the fields stay
  // locked until a POSITIVE "not_processed" confirmation arrives — never optimistically unlocked
  // while uncertain, and a failed read locks just as hard as a confirmed "processed" (fail closed).
  const [processingCertainty, setProcessingCertainty] = useState<ProcessingCertainty>("checking");

  const fieldLock = deriveCompanyFieldLock({ processingCertainty });
  const frameworkEditable = !fieldLock.locked;
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
    setFormDialogOpen(false);
    setDialogOpen(false);
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

    const { data, error } = await supabase
      .from("companies")
      .select("*")
      .eq("is_active", true)
      .order("name");

    if (!error && data) {
      setCompanies(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (dialogOpen) {
      fetchCompanies();
    }
  }, [user, dialogOpen]);

  const resetForm = () => {
    setFormData(EMPTY_FORM_DATA);
    setEditingCompany(null);
    setTinTouched(false);
    // A brand-new company has nothing processed, but the very next handleEdit() sets this back to
    // "checking" first — resetForm() only ever runs between edits, never mid-check.
    setProcessingCertainty("not_processed");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

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

    try {
      if (editingCompany) {
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
            // Cast: generated types (src/integrations/supabase/types.ts) still
            // reflect the live NOT NULL DEFAULT schema — the migration
            // dropping it hasn't been deployed/regenerated from yet. Passing
            // null here is intentional and correct once it is; see
            // supabase/migrations/20260903100000_companies_reporting_framework_no_default.sql.
            reporting_framework: formData.reporting_framework,
          } as never)
          .eq("id", editingCompany.id);

        if (error) throw error;

        logAction({
          action: "update_company",
          entityType: "company",
          entityId: editingCompany.id,
          metadata: { name: formData.name },
        });

        toast.success("Company updated successfully");
      } else {
        const { data, error } = await supabase
          .from("companies")
          .insert({
            name: formData.name,
            code: formData.code || null,
            tin: formData.tin.trim() || null,
            description: formData.description || null,
            industry: formData.industry || null,
            fiscal_year_end: resolvedFiscalYearEnd,
            currency: formData.currency,
            // See the cast comment in the update branch above.
            reporting_framework: formData.reporting_framework,
            user_id: user.id,
          } as never)
          .select()
          .single();

        if (error) throw error;

        logAction({
          action: "create_company",
          entityType: "company",
          entityId: data.id,
          metadata: { name: formData.name },
        });

        toast.success("Company created successfully");
      }

      setFormDialogOpen(false);
      resetForm();
      fetchCompanies();
    } catch (error) {
      console.error("Company save error:", error);
      toast.error("Failed to save company");
    }
  };

  const handleEdit = (company: Company) => {
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
          if (error) {
            setProcessingCertainty("check_failed");
            return;
          }
          setProcessingCertainty(data && data.length > 0 ? "processed" : "not_processed");
        },
        () => setProcessingCertainty("check_failed"),
      );
    setFormData({
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
    });
    setFormDialogOpen(true);
  };

  const tinError = formData.tin.trim() ? validateTin(formData.tin) : null;
  const showTinError = tinTouched && !!tinError;

  const handleDelete = async (company: Company) => {
    if (!confirm(`Are you sure you want to delete "${company.name}"?`)) return;

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
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete company");
    }
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Settings className="w-4 h-4" />
            Manage
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Manage Companies
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 w-full"
              onClick={() => {
                resetForm();
                setFormDialogOpen(true);
              }}
            >
              <Plus className="w-4 h-4" />
              Add Company
            </Button>

            {loading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>
            ) : companies.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No companies yet. Add one to organize your trial balances.
              </p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {companies.map((company) => (
                  <div
                    key={company.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card border-border"
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
                        onClick={() => handleEdit(company)}
                        className="h-8 w-8 p-0"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(company)}
                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Form Dialog */}
      <Dialog open={formDialogOpen} onOpenChange={(open) => {
        setFormDialogOpen(open);
        if (!open) resetForm();
      }}>
        <DialogContent className="sm:max-w-md max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingCompany ? "Edit Company" : "Add New Company"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto flex-1 pr-1">
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
                  <SelectItem value="ifrs_for_smes">IFRS for SMEs — private companies</SelectItem>
                  <SelectItem value="full_ifrs" disabled>Full IFRS — coming soon</SelectItem>
                  <SelectItem value="ipsas_accrual">IPSAS Accrual — government / public sector</SelectItem>
                  <SelectItem value="ipsas_cash" disabled>IPSAS Cash Basis — coming soon</SelectItem>
                </SelectContent>
              </Select>
              {!frameworkEditable ? (
                <p className="text-xs text-amber-600 dark:text-amber-500" data-testid="reporting-framework-lock-reason">
                  {fieldLock.reason}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Determines statement headers and output format. Cannot be changed after first report is generated.
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
              <Button type="button" variant="outline" onClick={() => setFormDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={showTinError}>
                {editingCompany ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};