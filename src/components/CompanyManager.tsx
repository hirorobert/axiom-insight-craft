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
  reporting_framework: string;
  tin: string | null;
  is_active: boolean;
  created_at: string;
}

export const CompanyManager = () => {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const { user } = useAuth();
  const { logAction } = useAuditLog();

  const [formData, setFormData] = useState({
    name: "",
    code: "",
    tin: "",
    description: "",
    industry: "",
    fiscal_year_end: "12-31",
    currency: "TZS",
    reporting_framework: "ifrs_for_smes",
  });

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
    setFormData({
      name: "",
      code: "",
      tin: "",
      description: "",
      industry: "",
      fiscal_year_end: "12-31",
      currency: "TZS",
      reporting_framework: "ifrs_for_smes",
    });
    setEditingCompany(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

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
            fiscal_year_end: formData.fiscal_year_end,
            currency: formData.currency,
            reporting_framework: formData.reporting_framework,
          })
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
            fiscal_year_end: formData.fiscal_year_end,
            currency: formData.currency,
            reporting_framework: formData.reporting_framework,
            user_id: user.id,
          })
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
    setFormData({
      name: company.name,
      code: company.code || "",
      tin: company.tin || "",
      description: company.description || "",
      industry: company.industry || "",
      fiscal_year_end: company.fiscal_year_end,
      currency: company.currency,
      reporting_framework: company.reporting_framework || "ifrs_for_smes",
    });
    setFormDialogOpen(true);
  };

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
                            {FRAMEWORK_LABELS[company.reporting_framework] || company.reporting_framework}
                          </Badge>
                          {isTinMissing(company.tin) && (
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                              title="TRA TIN is missing or still a placeholder. Enter the real TIN."
                            >
                              TIN needed
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
                TRA Tax Identification Number (TIN)
                <span className="ml-1 text-xs text-muted-foreground">(required for TRA documents)</span>
              </Label>
              <Input
                id="tin"
                value={formData.tin}
                onChange={(e) => setFormData({ ...formData, tin: e.target.value })}
                placeholder="e.g. 100-123-456"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input
                  id="code"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  placeholder="ACME"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="industry">Industry</Label>
                <Input
                  id="industry"
                  value={formData.industry}
                  onChange={(e) => setFormData({ ...formData, industry: e.target.value })}
                  placeholder="Technology"
                />
              </div>
            </div>
            {/* Reporting Framework — set once at company level */}
            <div className="space-y-2">
              <Label htmlFor="reporting_framework">Reporting Framework</Label>
              <Select
                value={formData.reporting_framework}
                onValueChange={(value) => setFormData({ ...formData, reporting_framework: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ifrs_for_smes">IFRS for SMEs — private companies (default)</SelectItem>
                  <SelectItem value="full_ifrs" disabled>Full IFRS — coming soon</SelectItem>
                  <SelectItem value="ipsas_accrual">IPSAS Accrual — government / public sector</SelectItem>
                  <SelectItem value="ipsas_cash" disabled>IPSAS Cash Basis — coming soon</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Determines statement headers and output format. Cannot be changed after first report is generated.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fiscal_year_end">Fiscal Year End</Label>
                <Select
                  value={formData.fiscal_year_end}
                  onValueChange={(value) => setFormData({ ...formData, fiscal_year_end: value })}
                >
                  <SelectTrigger>
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
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description..."
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">
                {editingCompany ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};