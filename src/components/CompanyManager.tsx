import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Building2, Plus, Pencil, Trash2, Check } from "lucide-react";
import { useAuditLog } from "@/hooks/useAuditLog";

interface Company {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  industry: string | null;
  fiscal_year_end: string;
  currency: string;
  is_active: boolean;
  created_at: string;
}

interface CompanyManagerProps {
  selectedCompanyId: string | null;
  onCompanySelect: (companyId: string | null) => void;
}

export const CompanyManager = ({ selectedCompanyId, onCompanySelect }: CompanyManagerProps) => {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const { user } = useAuth();
  const { logAction } = useAuditLog();

  const [formData, setFormData] = useState({
    name: "",
    code: "",
    description: "",
    industry: "",
    fiscal_year_end: "12-31",
    currency: "USD",
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
    fetchCompanies();
  }, [user]);

  const resetForm = () => {
    setFormData({
      name: "",
      code: "",
      description: "",
      industry: "",
      fiscal_year_end: "12-31",
      currency: "USD",
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
            description: formData.description || null,
            industry: formData.industry || null,
            fiscal_year_end: formData.fiscal_year_end,
            currency: formData.currency,
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
            description: formData.description || null,
            industry: formData.industry || null,
            fiscal_year_end: formData.fiscal_year_end,
            currency: formData.currency,
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
        onCompanySelect(data.id);
      }

      setDialogOpen(false);
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
      description: company.description || "",
      industry: company.industry || "",
      fiscal_year_end: company.fiscal_year_end,
      currency: company.currency,
    });
    setDialogOpen(true);
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

      if (selectedCompanyId === company.id) {
        onCompanySelect(null);
      }

      toast.success("Company deleted");
      fetchCompanies();
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete company");
    }
  };

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" />
            Companies
          </CardTitle>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Plus className="w-4 h-4" />
                Add Company
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingCompany ? "Edit Company" : "Add New Company"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
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
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="JPY">JPY</SelectItem>
                        <SelectItem value="CAD">CAD</SelectItem>
                        <SelectItem value="AUD">AUD</SelectItem>
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
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit">
                    {editingCompany ? "Update" : "Create"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : companies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No companies yet. Add one to organize your trial balances.
          </p>
        ) : (
          <div className="space-y-2">
            {/* All Companies option */}
            <button
              onClick={() => onCompanySelect(null)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                selectedCompanyId === null
                  ? "bg-primary/10 border-primary/30"
                  : "bg-secondary/50 border-border hover:border-primary/20"
              }`}
            >
              <div className="flex items-center gap-3">
                <Building2 className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">All Companies</span>
              </div>
              {selectedCompanyId === null && <Check className="w-4 h-4 text-primary" />}
            </button>

            {companies.map((company) => (
              <div
                key={company.id}
                className={`flex items-center justify-between p-3 rounded-lg border transition-all ${
                  selectedCompanyId === company.id
                    ? "bg-primary/10 border-primary/30"
                    : "bg-card border-border hover:border-primary/20"
                }`}
              >
                <button
                  onClick={() => onCompanySelect(company.id)}
                  className="flex-1 flex items-center gap-3 text-left"
                >
                  <Building2 className="w-4 h-4 text-primary" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{company.name}</span>
                      {company.code && (
                        <Badge variant="outline" className="text-xs">
                          {company.code}
                        </Badge>
                      )}
                    </div>
                    {company.industry && (
                      <p className="text-xs text-muted-foreground">{company.industry}</p>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  {selectedCompanyId === company.id && (
                    <Check className="w-4 h-4 text-primary mr-2" />
                  )}
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
      </CardContent>
    </Card>
  );
};
