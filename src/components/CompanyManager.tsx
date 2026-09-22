import { useState, useEffect } from "react";
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
import { Settings, Plus, Pencil, Trash2, Building2 } from "lucide-react";
import { useAuditLog } from "@/hooks/useAuditLog";
import { validateTin } from "@/components/workspace/CompanyTinDialog";
import { FrameworkConfirmationBanner } from "@/components/FrameworkConfirmationBanner";
import { Textarea } from "@/components/ui/textarea";
import { deriveCompanyFieldLock, guardCompanyFieldChange } from "@/lib/accounting/companyFieldLock";

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
 * FieldCorrectionAffordance — the one controlled path past a locked period/framework field.
 * Requires a non-empty reason before the field itself becomes editable again; the reason is what
 * confirmCorrection() stores and handleSubmit() later writes into the SAME audit_logs entry as the
 * update, alongside the old and new values — never a silent, unexplained change.
 */
function FieldCorrectionAffordance({
  reason,
  active,
  draftReason,
  onDraftReasonChange,
  onStart,
  onCancel,
  onConfirm,
  testId,
}: {
  reason: string | null;
  active: boolean;
  draftReason: string;
  onDraftReasonChange: (v: string) => void;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
}) {
  if (active) {
    return (
      <div className="space-y-2 rounded-md border border-border p-2.5" data-testid={`${testId}-correction-panel`}>
        <Label htmlFor={`${testId}-correction-reason`} className="text-xs">
          Reason for this correction (recorded in the audit log)
        </Label>
        <Textarea
          id={`${testId}-correction-reason`}
          value={draftReason}
          onChange={(e) => onDraftReasonChange(e.target.value)}
          placeholder="e.g. The original selection was a data-entry mistake, confirmed with the client on…"
          className="min-h-16 text-xs"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!draftReason.trim()}
            onClick={onConfirm}
            data-testid={`${testId}-confirm-correction`}
          >
            Confirm correction
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-amber-600 dark:text-amber-500" data-testid={`${testId}-lock-reason`}>
        {reason}
      </p>
      <button
        type="button"
        onClick={onStart}
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        data-testid={`${testId}-start-correction`}
      >
        Correct instead
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

  const [formData, setFormData] = useState<CompanyFormData>(EMPTY_FORM_DATA);

  // ── Period/framework contract (requirement #4): once ANY trial balance for this company has been
  // processed, reporting_framework and fiscal_year_end lock — a plain form save can never silently
  // reinterpret data that statements/tax output already depend on. "Correct instead" is the one
  // controlled path past the lock: a mandatory reason, recorded atomically with the update in the
  // SAME audit_logs entry (useAuditLog is already the approved write path for company edits — no
  // second, competing mutation is introduced).
  const [hasProcessedUpload, setHasProcessedUpload] = useState(false);
  const [frameworkCorrectionReason, setFrameworkCorrectionReason] = useState<string | null>(null);
  const [fiscalYearEndCorrectionReason, setFiscalYearEndCorrectionReason] = useState<string | null>(null);
  const [correctingField, setCorrectingField] = useState<"reporting_framework" | "fiscal_year_end" | null>(null);
  const [correctionDraftReason, setCorrectionDraftReason] = useState("");

  const fieldLock = deriveCompanyFieldLock({ hasProcessedUpload });
  const frameworkEditable = !fieldLock.locked || frameworkCorrectionReason !== null;
  const fiscalYearEndEditable = !fieldLock.locked || fiscalYearEndCorrectionReason !== null;

  const startCorrection = (field: "reporting_framework" | "fiscal_year_end") => {
    setCorrectingField(field);
    setCorrectionDraftReason("");
  };

  const confirmCorrection = () => {
    const reason = correctionDraftReason.trim();
    if (!reason || !correctingField) return;
    if (correctingField === "reporting_framework") setFrameworkCorrectionReason(reason);
    else setFiscalYearEndCorrectionReason(reason);
    setCorrectingField(null);
    setCorrectionDraftReason("");
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
    setHasProcessedUpload(false);
    setFrameworkCorrectionReason(null);
    setFiscalYearEndCorrectionReason(null);
    setCorrectingField(null);
    setCorrectionDraftReason("");
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

    // Fail closed even if a disabled control were somehow bypassed: a locked field may only reach
    // the database alongside its own recorded correction reason. This is the actual enforcement —
    // the disabled Select above is the affordance, guardCompanyFieldChange is the guarantee.
    const frameworkChanged = !!editingCompany && formData.reporting_framework !== editingCompany.reporting_framework;
    const fiscalYearEndChanged = !!editingCompany && resolvedFiscalYearEnd !== editingCompany.fiscal_year_end;
    const guard = guardCompanyFieldChange({
      locked: !!editingCompany && fieldLock.locked,
      frameworkChanged,
      frameworkCorrectionReason,
      fiscalYearEndChanged,
      fiscalYearEndCorrectionReason,
    });
    if (!guard.allowed) {
      toast.error(
        guard.blockedField === "reporting_framework"
          ? 'Reporting framework is locked because trial balance data has already been processed. Use "Correct instead" to change it.'
          : 'Fiscal year end is locked because trial balance data has already been processed. Use "Correct instead" to change it.',
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
          metadata: {
            name: formData.name,
            // The atomic audited mutation the period/framework contract requires: old value, new
            // value and the practitioner's own reason, in the SAME log entry as the update itself.
            ...(frameworkChanged && frameworkCorrectionReason
              ? {
                  reporting_framework_correction: {
                    from: editingCompany.reporting_framework,
                    to: formData.reporting_framework,
                    reason: frameworkCorrectionReason,
                  },
                }
              : {}),
            ...(fiscalYearEndChanged && fiscalYearEndCorrectionReason
              ? {
                  fiscal_year_end_correction: {
                    from: editingCompany.fiscal_year_end,
                    to: resolvedFiscalYearEnd,
                    reason: fiscalYearEndCorrectionReason,
                  },
                }
              : {}),
          },
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
    setHasProcessedUpload(false);
    setFrameworkCorrectionReason(null);
    setFiscalYearEndCorrectionReason(null);
    setCorrectingField(null);
    setCorrectionDraftReason("");
    // Values originate from the persisted row (never fabricated); the lock check is a separate,
    // best-effort read — a failed/slow read fails safe (stays unlocked → false) rather than ever
    // blocking a genuinely-new company's setup on a transient error.
    supabase
      .from("trial_balance_uploads")
      .select("id")
      .eq("company_id", company.id)
      .not("processed_at", "is", null)
      .limit(1)
      .then(({ data }) => setHasProcessedUpload(!!data && data.length > 0));
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
                <FieldCorrectionAffordance
                  reason={fieldLock.reason}
                  active={correctingField === "reporting_framework"}
                  draftReason={correctionDraftReason}
                  onDraftReasonChange={setCorrectionDraftReason}
                  onStart={() => startCorrection("reporting_framework")}
                  onCancel={() => setCorrectingField(null)}
                  onConfirm={confirmCorrection}
                  testId="reporting-framework"
                />
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
                {!fiscalYearEndEditable && (
                  <FieldCorrectionAffordance
                    reason={fieldLock.reason}
                    active={correctingField === "fiscal_year_end"}
                    draftReason={correctionDraftReason}
                    onDraftReasonChange={setCorrectionDraftReason}
                    onStart={() => startCorrection("fiscal_year_end")}
                    onCancel={() => setCorrectingField(null)}
                    onConfirm={confirmCorrection}
                    testId="fiscal-year-end"
                  />
                )}
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