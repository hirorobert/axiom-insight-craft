import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle,
  Edit2,
  Save,
  X,
  AlertTriangle,
  TrendingUp,
  BarChart3,
  PieChart,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useAuditLog } from "@/hooks/useAuditLog";

interface Account {
  accountCode?: string;
  accountName?: string;
  balance?: number;
  confidence?: number;
  category?: string;
  subcategory?: string;
}

interface AccountMappingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uploadId: string;
  mapping: {
    balanceSheet?: {
      assets?: { current?: Account[]; nonCurrent?: Account[] };
      liabilities?: { current?: Account[]; nonCurrent?: Account[] };
      equity?: Account[];
    };
    incomeStatement?: {
      revenue?: Account[];
      costOfGoodsSold?: Account[];
      operatingExpenses?: Account[];
      otherIncome?: Account[];
      taxes?: Account[];
    };
    cashFlow?: {
      operating?: Account[];
      investing?: Account[];
      financing?: Account[];
    };
  } | null;
  onSaveCorrections?: (corrections: Record<string, { category: string; subcategory: string }>) => void;
}

const STATEMENT_CATEGORIES = {
  balanceSheet: {
    label: "Balance Sheet",
    icon: BarChart3,
    subcategories: [
      "Assets - Current",
      "Assets - Non-Current",
      "Liabilities - Current",
      "Liabilities - Non-Current",
      "Equity",
    ],
  },
  incomeStatement: {
    label: "Income Statement",
    icon: TrendingUp,
    subcategories: [
      "Revenue",
      "Cost of Goods Sold",
      "Operating Expenses",
      "Other Income",
      "Taxes",
    ],
  },
  cashFlow: {
    label: "Cash Flow",
    icon: PieChart,
    subcategories: ["Operating", "Investing", "Financing"],
  },
};

function flattenAccounts(mapping: AccountMappingModalProps["mapping"]) {
  if (!mapping) return [];

  const accounts: (Account & { statement: string; section: string })[] = [];

  // Balance Sheet
  if (mapping.balanceSheet) {
    mapping.balanceSheet.assets?.current?.forEach((a) =>
      accounts.push({ ...a, statement: "balanceSheet", section: "Assets - Current" })
    );
    mapping.balanceSheet.assets?.nonCurrent?.forEach((a) =>
      accounts.push({ ...a, statement: "balanceSheet", section: "Assets - Non-Current" })
    );
    mapping.balanceSheet.liabilities?.current?.forEach((a) =>
      accounts.push({ ...a, statement: "balanceSheet", section: "Liabilities - Current" })
    );
    mapping.balanceSheet.liabilities?.nonCurrent?.forEach((a) =>
      accounts.push({ ...a, statement: "balanceSheet", section: "Liabilities - Non-Current" })
    );
    mapping.balanceSheet.equity?.forEach((a) =>
      accounts.push({ ...a, statement: "balanceSheet", section: "Equity" })
    );
  }

  // Income Statement
  if (mapping.incomeStatement) {
    mapping.incomeStatement.revenue?.forEach((a) =>
      accounts.push({ ...a, statement: "incomeStatement", section: "Revenue" })
    );
    mapping.incomeStatement.costOfGoodsSold?.forEach((a) =>
      accounts.push({ ...a, statement: "incomeStatement", section: "Cost of Goods Sold" })
    );
    mapping.incomeStatement.operatingExpenses?.forEach((a) =>
      accounts.push({ ...a, statement: "incomeStatement", section: "Operating Expenses" })
    );
    mapping.incomeStatement.otherIncome?.forEach((a) =>
      accounts.push({ ...a, statement: "incomeStatement", section: "Other Income" })
    );
    mapping.incomeStatement.taxes?.forEach((a) =>
      accounts.push({ ...a, statement: "incomeStatement", section: "Taxes" })
    );
  }

  // Cash Flow
  if (mapping.cashFlow) {
    mapping.cashFlow.operating?.forEach((a) =>
      accounts.push({ ...a, statement: "cashFlow", section: "Operating" })
    );
    mapping.cashFlow.investing?.forEach((a) =>
      accounts.push({ ...a, statement: "cashFlow", section: "Investing" })
    );
    mapping.cashFlow.financing?.forEach((a) =>
      accounts.push({ ...a, statement: "cashFlow", section: "Financing" })
    );
  }

  return accounts;
}

function getConfidenceColor(confidence: number) {
  if (confidence >= 90) return "text-accent";
  if (confidence >= 70) return "text-primary";
  if (confidence >= 50) return "text-yellow-500";
  return "text-destructive";
}

function getConfidenceBadge(confidence: number) {
  if (confidence >= 90) return { variant: "default" as const, label: "High" };
  if (confidence >= 70) return { variant: "secondary" as const, label: "Medium" };
  if (confidence >= 50) return { variant: "outline" as const, label: "Low" };
  return { variant: "destructive" as const, label: "Review" };
}

export function AccountMappingModal({
  open,
  onOpenChange,
  uploadId,
  mapping,
  onSaveCorrections,
}: AccountMappingModalProps) {
  const { user } = useAuth();
  const { logAction } = useAuditLog();
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<
    Record<string, { category: string; subcategory: string; original?: { category: string; subcategory: string } }>
  >({});
  const [filter, setFilter] = useState<"all" | "lowConfidence" | "corrected">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingCorrections, setLoadingCorrections] = useState(false);

  // Load existing corrections from database
  useEffect(() => {
    const loadCorrections = async () => {
      if (!open || !uploadId || !user) return;
      
      setLoadingCorrections(true);
      const { data, error } = await supabase
        .from("account_corrections")
        .select("*")
        .eq("upload_id", uploadId);

      if (!error && data) {
        const loadedCorrections: Record<string, { category: string; subcategory: string; original?: { category: string; subcategory: string } }> = {};
        data.forEach((c) => {
          loadedCorrections[c.account_code] = {
            category: c.corrected_category,
            subcategory: c.corrected_subcategory,
            original: c.original_category && c.original_subcategory 
              ? { category: c.original_category, subcategory: c.original_subcategory }
              : undefined,
          };
        });
        setCorrections(loadedCorrections);
      }
      setLoadingCorrections(false);
    };

    loadCorrections();
  }, [open, uploadId, user]);
  const accounts = flattenAccounts(mapping);

  const filteredAccounts = accounts.filter((account) => {
    const matchesSearch =
      !searchQuery ||
      account.accountName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.accountCode?.toLowerCase().includes(searchQuery.toLowerCase());

    if (filter === "lowConfidence") {
      return matchesSearch && (account.confidence || 0) < 70;
    }
    if (filter === "corrected") {
      return matchesSearch && corrections[account.accountCode || ""];
    }
    return matchesSearch;
  });

  const handleCorrection = (
    accountCode: string,
    category: string,
    subcategory: string,
    originalCategory: string,
    originalSubcategory: string
  ) => {
    setCorrections((prev) => ({
      ...prev,
      [accountCode]: { 
        category, 
        subcategory, 
        original: { category: originalCategory, subcategory: originalSubcategory } 
      },
    }));
    setEditingAccount(null);
  };

  const handleSaveAll = async () => {
    if (!user || !uploadId) return;
    
    setSaving(true);
    try {
      // Get all accounts to find originals
      const accountsMap = new Map(
        accounts.map(a => [a.accountCode, { statement: a.statement, section: a.section }])
      );

      // Prepare upsert data
      const upsertData = Object.entries(corrections).map(([accountCode, correction]) => {
        const original = accountsMap.get(accountCode);
        return {
          upload_id: uploadId,
          account_code: accountCode,
          original_category: correction.original?.category || original?.statement || null,
          original_subcategory: correction.original?.subcategory || original?.section || null,
          corrected_category: correction.category,
          corrected_subcategory: correction.subcategory,
        };
      });

      const { error } = await supabase
        .from("account_corrections")
        .upsert(upsertData, { onConflict: "upload_id,account_code" });

      if (error) throw error;

      logAction({
        action: "correct_account_mapping",
        entityType: "trial_balance_upload",
        entityId: uploadId,
        metadata: { correctionCount: Object.keys(corrections).length },
      });
      onSaveCorrections?.(corrections);
      toast.success(`Saved ${Object.keys(corrections).length} corrections`);
      onOpenChange(false);
    } catch (error) {
      console.error("Error saving corrections:", error);
      toast.error("Failed to save corrections");
    } finally {
      setSaving(false);
    }
  };

  const lowConfidenceCount = accounts.filter((a) => (a.confidence || 0) < 70).length;
  const correctedCount = Object.keys(corrections).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col bg-card border-border">
        <DialogHeader className="pb-4 border-b border-border">
          <DialogTitle className="text-xl flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            Account Mapping Details
          </DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Review AI-generated account classifications and make manual corrections
          </p>
        </DialogHeader>

        {/* Filters and Search */}
        <div className="flex flex-col sm:flex-row gap-3 py-4">
          <Input
            placeholder="Search accounts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-secondary border-border"
          />
          <div className="flex gap-2">
            <Button
              variant={filter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter("all")}
            >
              All ({accounts.length})
            </Button>
            <Button
              variant={filter === "lowConfidence" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter("lowConfidence")}
              className="gap-1"
            >
              <AlertTriangle className="w-3 h-3" />
              Review ({lowConfidenceCount})
            </Button>
            <Button
              variant={filter === "corrected" ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter("corrected")}
              className="gap-1"
            >
              <CheckCircle className="w-3 h-3" />
              Corrected ({correctedCount})
            </Button>
          </div>
        </div>

        {/* Account List */}
        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-2">
            {filteredAccounts.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No accounts found matching your criteria</p>
              </div>
            ) : (
              filteredAccounts.map((account, index) => {
                const key = account.accountCode || `account-${index}`;
                const isEditing = editingAccount === key;
                const correction = corrections[key];
                const confidence = account.confidence || 85;
                const badge = getConfidenceBadge(confidence);

                return (
                  <div
                    key={key}
                    className={`p-4 rounded-xl border transition-all ${
                      isEditing
                        ? "bg-primary/5 border-primary/30"
                        : correction
                        ? "bg-accent/5 border-accent/30"
                        : "bg-secondary/30 border-border hover:border-primary/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {account.accountCode && (
                            <span className="text-xs font-mono text-muted-foreground">
                              {account.accountCode}
                            </span>
                          )}
                          <Badge variant={badge.variant} className="text-xs">
                            {badge.label}
                          </Badge>
                          {correction && (
                            <Badge variant="outline" className="text-xs text-accent border-accent/30">
                              Corrected
                            </Badge>
                          )}
                        </div>
                        <p className="font-medium text-foreground truncate">
                          {account.accountName || "Unknown Account"}
                        </p>
                        <div className="flex items-center gap-4 mt-2">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">Statement:</span>
                            <span className="text-foreground">
                              {correction?.category ||
                                STATEMENT_CATEGORIES[
                                  account.statement as keyof typeof STATEMENT_CATEGORIES
                                ]?.label ||
                                account.statement}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-muted-foreground">Section:</span>
                            <span className="text-foreground">
                              {correction?.subcategory || account.section}
                            </span>
                          </div>
                        </div>
                        {account.balance !== undefined && (
                          <p className="text-sm text-muted-foreground mt-1">
                            Balance: ${account.balance.toLocaleString()}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Confidence Score */}
                        <div className="text-right">
                          <div className="flex items-center gap-2">
                            <Progress value={confidence} className="w-16 h-2" />
                            <span className={`text-sm font-medium ${getConfidenceColor(confidence)}`}>
                              {confidence}%
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">confidence</p>
                        </div>

                        {/* Edit Button */}
                        {!isEditing ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingAccount(key)}
                            className="gap-1"
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingAccount(null)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Edit Form */}
                    {isEditing && (
                      <div className="mt-4 pt-4 border-t border-border space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label className="text-sm">Financial Statement</Label>
                            <Select
                              defaultValue={account.statement}
                              onValueChange={(value) => {
                                const subcat =
                                  STATEMENT_CATEGORIES[value as keyof typeof STATEMENT_CATEGORIES]
                                    ?.subcategories[0] || "";
                                handleCorrection(key, value, subcat, account.statement, account.section);
                              }}
                            >
                              <SelectTrigger className="bg-secondary border-border">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Object.entries(STATEMENT_CATEGORIES).map(([key, val]) => (
                                  <SelectItem key={key} value={key}>
                                    {val.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-sm">Section</Label>
                            <Select
                              defaultValue={account.section}
                              onValueChange={(value) =>
                                handleCorrection(key, account.statement, value, account.statement, account.section)
                              }
                            >
                              <SelectTrigger className="bg-secondary border-border">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {STATEMENT_CATEGORIES[
                                  account.statement as keyof typeof STATEMENT_CATEGORIES
                                ]?.subcategories.map((sub) => (
                                  <SelectItem key={sub} value={sub}>
                                    {sub}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            {filteredAccounts.length} of {accounts.length} accounts shown
            {correctedCount > 0 && ` • ${correctedCount} corrections pending`}
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="hero"
              onClick={handleSaveAll}
              disabled={correctedCount === 0 || saving}
              className="gap-2"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saving ? "Saving..." : `Save Corrections (${correctedCount})`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
