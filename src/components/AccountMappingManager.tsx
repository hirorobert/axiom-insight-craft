import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Map,
  Plus,
  Pencil,
  Trash2,
  Search,
  Upload,
  Download,
  BarChart3,
  TrendingUp,
  PieChart,
  DollarSign,
  BookOpen,
  Filter,
  FileUp,
  CheckCircle2,
  AlertCircle,
  X,
} from "lucide-react";
import { useAuditLog } from "@/hooks/useAuditLog";

// Types matching the database schema
type FinancialStatement = "balance_sheet" | "income_statement" | "cash_flow";
type AccountClassification =
  | "current_assets"
  | "non_current_assets"
  | "current_liabilities"
  | "non_current_liabilities"
  | "equity"
  | "revenue"
  | "cost_of_goods_sold"
  | "operating_expenses"
  | "other_income"
  | "taxes"
  | "operating_activities"
  | "investing_activities"
  | "financing_activities";

interface AccountMapping {
  id: string;
  account_code: string;
  account_name: string;
  statement: FinancialStatement;
  classification: AccountClassification;
  line_item: string;
  normal_balance: "debit" | "credit";
  is_cash_account: boolean;
  is_retained_earnings: boolean;
  created_at: string;
  updated_at: string;
}

// Classification options grouped by statement
const CLASSIFICATION_BY_STATEMENT: Record<FinancialStatement, AccountClassification[]> = {
  balance_sheet: [
    "current_assets",
    "non_current_assets",
    "current_liabilities",
    "non_current_liabilities",
    "equity",
  ],
  income_statement: [
    "revenue",
    "cost_of_goods_sold",
    "operating_expenses",
    "other_income",
    "taxes",
  ],
  cash_flow: ["operating_activities", "investing_activities", "financing_activities"],
};

// Display labels for classifications
const CLASSIFICATION_LABELS: Record<AccountClassification, string> = {
  current_assets: "Current Assets",
  non_current_assets: "Non-Current Assets",
  current_liabilities: "Current Liabilities",
  non_current_liabilities: "Non-Current Liabilities",
  equity: "Equity",
  revenue: "Revenue",
  cost_of_goods_sold: "Cost of Goods Sold",
  operating_expenses: "Operating Expenses",
  other_income: "Other Income",
  taxes: "Taxes",
  operating_activities: "Operating Activities",
  investing_activities: "Investing Activities",
  financing_activities: "Financing Activities",
};

// Display labels for statements
const STATEMENT_LABELS: Record<FinancialStatement, string> = {
  balance_sheet: "Balance Sheet",
  income_statement: "Income Statement",
  cash_flow: "Cash Flow",
};

// Icons for statements
const STATEMENT_ICONS: Record<FinancialStatement, React.ReactNode> = {
  balance_sheet: <BarChart3 className="w-4 h-4" />,
  income_statement: <TrendingUp className="w-4 h-4" />,
  cash_flow: <PieChart className="w-4 h-4" />,
};

// Default line items by classification
const DEFAULT_LINE_ITEMS: Record<AccountClassification, string[]> = {
  current_assets: ["Cash and Cash Equivalents", "Accounts Receivable", "Inventory", "Prepaid Expenses", "Other Current Assets"],
  non_current_assets: ["Property, Plant & Equipment", "Intangible Assets", "Investments", "Other Non-Current Assets"],
  current_liabilities: ["Accounts Payable", "Accrued Expenses", "Short-term Debt", "Current Portion of Long-term Debt", "Other Current Liabilities"],
  non_current_liabilities: ["Long-term Debt", "Deferred Tax Liabilities", "Pension Obligations", "Other Non-Current Liabilities"],
  equity: ["Common Stock", "Retained Earnings", "Additional Paid-in Capital", "Treasury Stock", "Other Comprehensive Income"],
  revenue: ["Net Sales", "Service Revenue", "Other Revenue"],
  cost_of_goods_sold: ["Cost of Goods Sold", "Cost of Services"],
  operating_expenses: ["Salaries & Wages", "Rent Expense", "Utilities", "Depreciation", "Amortization", "Other Operating Expenses"],
  other_income: ["Interest Income", "Dividend Income", "Gain on Sale of Assets", "Other Non-Operating Income"],
  taxes: ["Income Tax Expense", "Deferred Tax Expense"],
  operating_activities: ["Net Income", "Depreciation & Amortization", "Changes in Working Capital"],
  investing_activities: ["Purchase of PPE", "Sale of PPE", "Purchase of Investments", "Sale of Investments"],
  financing_activities: ["Issuance of Debt", "Repayment of Debt", "Issuance of Stock", "Dividends Paid", "Stock Repurchases"],
};

interface MappingFormData {
  account_code: string;
  account_name: string;
  statement: FinancialStatement;
  classification: AccountClassification;
  line_item: string;
  normal_balance: "debit" | "credit";
  is_cash_account: boolean;
  is_retained_earnings: boolean;
}

const initialFormData: MappingFormData = {
  account_code: "",
  account_name: "",
  statement: "balance_sheet",
  classification: "current_assets",
  line_item: "",
  normal_balance: "debit",
  is_cash_account: false,
  is_retained_earnings: false,
};

// CSV Import types
interface CSVImportRow {
  account_code: string;
  account_name: string;
  statement: string;
  classification: string;
  line_item: string;
  normal_balance: string;
  is_cash_account: string;
  is_retained_earnings: string;
  isValid: boolean;
  errors: string[];
}

// Valid values for validation
const VALID_STATEMENTS = ["balance_sheet", "income_statement", "cash_flow"];
const VALID_CLASSIFICATIONS = Object.keys(CLASSIFICATION_LABELS);
const VALID_NORMAL_BALANCES = ["debit", "credit"];

export interface AccountMappingManagerRef {
  openDialog: () => void;
}

export const AccountMappingManager = forwardRef<AccountMappingManagerRef, object>((_, ref) => {
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<AccountMapping | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [mappingToDelete, setMappingToDelete] = useState<AccountMapping | null>(null);
  const [formData, setFormData] = useState<MappingFormData>(initialFormData);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatement, setFilterStatement] = useState<FinancialStatement | "all">("all");
  
  // CSV Import state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importData, setImportData] = useState<CSVImportRow[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  
  const { user } = useAuth();
  const { logAction } = useAuditLog();

  // Expose openDialog to parent via ref
  useImperativeHandle(ref, () => ({
    openDialog: () => setDialogOpen(true),
  }));

  // Fetch mappings
  const fetchMappings = async () => {
    if (!user) return;

    setLoading(true);
    const { data, error } = await supabase
      .from("account_mappings")
      .select("*")
      .order("account_code");

    if (!error && data) {
      setMappings(data as AccountMapping[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (dialogOpen) {
      fetchMappings();
    }
  }, [user, dialogOpen]);

  // Reset form
  const resetForm = () => {
    setFormData(initialFormData);
    setEditingMapping(null);
  };

  // Handle statement change - update classification options
  const handleStatementChange = (statement: FinancialStatement) => {
    const newClassification = CLASSIFICATION_BY_STATEMENT[statement][0];
    setFormData({
      ...formData,
      statement,
      classification: newClassification,
      line_item: DEFAULT_LINE_ITEMS[newClassification][0] || "",
    });
  };

  // Handle classification change - update line item options
  const handleClassificationChange = (classification: AccountClassification) => {
    setFormData({
      ...formData,
      classification,
      line_item: DEFAULT_LINE_ITEMS[classification][0] || "",
    });
  };

  // Handle form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // Validation
    if (!formData.account_code.trim()) {
      toast.error("Account code is required");
      return;
    }
    if (!formData.account_name.trim()) {
      toast.error("Account name is required");
      return;
    }

    try {
      if (editingMapping) {
        // Update existing
        const { error } = await supabase
          .from("account_mappings")
          .update({
            account_code: formData.account_code.trim(),
            account_name: formData.account_name.trim(),
            statement: formData.statement,
            classification: formData.classification,
            line_item: formData.line_item.trim(),
            normal_balance: formData.normal_balance,
            is_cash_account: formData.is_cash_account,
            is_retained_earnings: formData.is_retained_earnings,
          })
          .eq("id", editingMapping.id);

        if (error) throw error;

        logAction({
          action: "update_account_mapping",
          entityType: "account_mapping",
          entityId: editingMapping.id,
          metadata: { accountCode: formData.account_code },
        });

        toast.success("Mapping updated successfully");
      } else {
        // Check for duplicate account code
        const existingMapping = mappings.find(
          (m) => m.account_code.toLowerCase() === formData.account_code.trim().toLowerCase()
        );
        if (existingMapping) {
          toast.error(`Account code "${formData.account_code}" already exists`);
          return;
        }

        // Create new
        const { data, error } = await supabase
          .from("account_mappings")
          .insert({
            user_id: user.id,
            account_code: formData.account_code.trim(),
            account_name: formData.account_name.trim(),
            statement: formData.statement,
            classification: formData.classification,
            line_item: formData.line_item.trim(),
            normal_balance: formData.normal_balance,
            is_cash_account: formData.is_cash_account,
            is_retained_earnings: formData.is_retained_earnings,
          })
          .select()
          .single();

        if (error) throw error;

        logAction({
          action: "create_account_mapping",
          entityType: "account_mapping",
          entityId: data.id,
          metadata: { accountCode: formData.account_code },
        });

        toast.success("Mapping created successfully");
      }

      setFormDialogOpen(false);
      resetForm();
      fetchMappings();
    } catch (error) {
      console.error("Save error:", error);
      toast.error("Failed to save mapping");
    }
  };

  // Handle edit
  const handleEdit = (mapping: AccountMapping) => {
    setEditingMapping(mapping);
    setFormData({
      account_code: mapping.account_code,
      account_name: mapping.account_name,
      statement: mapping.statement,
      classification: mapping.classification,
      line_item: mapping.line_item,
      normal_balance: mapping.normal_balance as "debit" | "credit",
      is_cash_account: mapping.is_cash_account,
      is_retained_earnings: mapping.is_retained_earnings,
    });
    setFormDialogOpen(true);
  };

  // Handle delete confirmation
  const handleDeleteClick = (mapping: AccountMapping) => {
    setMappingToDelete(mapping);
    setDeleteConfirmOpen(true);
  };

  // Confirm delete
  const handleConfirmDelete = async () => {
    if (!mappingToDelete) return;

    try {
      const { error } = await supabase
        .from("account_mappings")
        .delete()
        .eq("id", mappingToDelete.id);

      if (error) throw error;

      logAction({
        action: "delete_account_mapping",
        entityType: "account_mapping",
        entityId: mappingToDelete.id,
        metadata: { accountCode: mappingToDelete.account_code },
      });

      toast.success("Mapping deleted");
      fetchMappings();
    } catch (error) {
      console.error("Delete error:", error);
      toast.error("Failed to delete mapping");
    } finally {
      setDeleteConfirmOpen(false);
      setMappingToDelete(null);
    }
  };

  // Export mappings as CSV
  const handleExport = () => {
    const headers = [
      "Account Code",
      "Account Name",
      "Statement",
      "Classification",
      "Line Item",
      "Normal Balance",
      "Is Cash Account",
      "Is Retained Earnings",
    ];

    const rows = mappings.map((m) => [
      m.account_code,
      m.account_name,
      m.statement,
      m.classification,
      m.line_item,
      m.normal_balance,
      m.is_cash_account ? "Yes" : "No",
      m.is_retained_earnings ? "Yes" : "No",
    ]);

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "account_mappings.csv";
    a.click();
    URL.revokeObjectURL(url);

    toast.success("Mappings exported successfully");
  };

  // Parse CSV file
  const parseCSV = (text: string): CSVImportRow[] => {
    const lines = text.split("\n").filter((line) => line.trim());
    if (lines.length < 2) return [];

    // Parse header to determine column indices
    const headerLine = lines[0];
    const headers = headerLine.split(",").map((h) => 
      h.replace(/^["']|["']$/g, "").trim().toLowerCase()
    );

    // Map header names to expected fields
    const headerMap: Record<string, number> = {};
    headers.forEach((h, i) => {
      if (h.includes("code")) headerMap.account_code = i;
      else if (h.includes("name") && !h.includes("company")) headerMap.account_name = i;
      else if (h.includes("statement")) headerMap.statement = i;
      else if (h.includes("classification") || h.includes("class")) headerMap.classification = i;
      else if (h.includes("line") || h.includes("item")) headerMap.line_item = i;
      else if (h.includes("balance") || h.includes("normal")) headerMap.normal_balance = i;
      else if (h.includes("cash")) headerMap.is_cash_account = i;
      else if (h.includes("retained") || h.includes("earnings")) headerMap.is_retained_earnings = i;
    });

    // Parse data rows
    const rows: CSVImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const values = parseCSVLine(line);
      
      const row: CSVImportRow = {
        account_code: values[headerMap.account_code] || "",
        account_name: values[headerMap.account_name] || "",
        statement: normalizeStatement(values[headerMap.statement] || ""),
        classification: normalizeClassification(values[headerMap.classification] || ""),
        line_item: values[headerMap.line_item] || "",
        normal_balance: normalizeNormalBalance(values[headerMap.normal_balance] || ""),
        is_cash_account: values[headerMap.is_cash_account] || "No",
        is_retained_earnings: values[headerMap.is_retained_earnings] || "No",
        isValid: true,
        errors: [],
      };

      // Validate row
      validateImportRow(row);
      rows.push(row);
    }

    return rows;
  };

  // Parse a single CSV line handling quoted values
  const parseCSVLine = (line: string): string[] => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && !inQuotes) {
        inQuotes = true;
      } else if (char === '"' && inQuotes) {
        inQuotes = false;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };

  // Normalize statement value
  const normalizeStatement = (value: string): string => {
    const v = value.toLowerCase().trim();
    if (v.includes("balance") || v === "bs") return "balance_sheet";
    if (v.includes("income") || v === "is" || v.includes("p&l") || v.includes("profit")) return "income_statement";
    if (v.includes("cash") || v === "cf") return "cash_flow";
    return v.replace(/\s+/g, "_");
  };

  // Normalize classification value
  const normalizeClassification = (value: string): string => {
    const v = value.toLowerCase().trim().replace(/[\s-]+/g, "_");
    // Try to match common variations
    if (v.includes("current") && v.includes("asset")) return "current_assets";
    if (v.includes("non") && v.includes("current") && v.includes("asset")) return "non_current_assets";
    if (v.includes("current") && v.includes("liab")) return "current_liabilities";
    if (v.includes("non") && v.includes("current") && v.includes("liab")) return "non_current_liabilities";
    if (v.includes("equity") || v.includes("capital")) return "equity";
    if (v.includes("revenue") || v.includes("sales") || v.includes("income") && !v.includes("other")) return "revenue";
    if (v.includes("cogs") || v.includes("cost_of_goods") || v.includes("cost of goods")) return "cost_of_goods_sold";
    if (v.includes("operating") && v.includes("exp")) return "operating_expenses";
    if (v.includes("other") && v.includes("income")) return "other_income";
    if (v.includes("tax")) return "taxes";
    if (v.includes("operating") && v.includes("activ")) return "operating_activities";
    if (v.includes("investing") || v.includes("investment")) return "investing_activities";
    if (v.includes("financing") || v.includes("finance")) return "financing_activities";
    return v;
  };

  // Normalize normal balance value
  const normalizeNormalBalance = (value: string): string => {
    const v = value.toLowerCase().trim();
    if (v === "dr" || v === "d" || v.includes("debit")) return "debit";
    if (v === "cr" || v === "c" || v.includes("credit")) return "credit";
    return v;
  };

  // Validate a single import row
  const validateImportRow = (row: CSVImportRow) => {
    row.errors = [];
    row.isValid = true;

    if (!row.account_code.trim()) {
      row.errors.push("Account code is required");
      row.isValid = false;
    }

    if (!row.account_name.trim()) {
      row.errors.push("Account name is required");
      row.isValid = false;
    }

    if (!VALID_STATEMENTS.includes(row.statement)) {
      row.errors.push(`Invalid statement: "${row.statement}"`);
      row.isValid = false;
    }

    if (!VALID_CLASSIFICATIONS.includes(row.classification)) {
      row.errors.push(`Invalid classification: "${row.classification}"`);
      row.isValid = false;
    }

    if (!row.line_item.trim()) {
      row.errors.push("Line item is required");
      row.isValid = false;
    }

    if (!VALID_NORMAL_BALANCES.includes(row.normal_balance)) {
      row.errors.push(`Invalid normal balance: "${row.normal_balance}"`);
      row.isValid = false;
    }

    // Check for duplicate in existing mappings
    const existingDuplicate = mappings.find(
      (m) => m.account_code.toLowerCase() === row.account_code.toLowerCase()
    );
    if (existingDuplicate) {
      row.errors.push("Account code already exists - will be skipped");
      row.isValid = false;
    }
  };

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".csv")) {
      toast.error("Please select a CSV file");
      return;
    }

    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const parsed = parseCSV(text);
      setImportData(parsed);
    };
    reader.readAsText(file);
  };

  // Handle import confirmation
  const handleImportConfirm = async () => {
    if (!user) return;

    const validRows = importData.filter((row) => row.isValid);
    if (validRows.length === 0) {
      toast.error("No valid rows to import");
      return;
    }

    setImportLoading(true);
    try {
      const insertData = validRows.map((row) => ({
        user_id: user.id,
        account_code: row.account_code.trim(),
        account_name: row.account_name.trim(),
        statement: row.statement as FinancialStatement,
        classification: row.classification as AccountClassification,
        line_item: row.line_item.trim(),
        normal_balance: row.normal_balance,
        is_cash_account: row.is_cash_account.toLowerCase() === "yes" || row.is_cash_account === "true",
        is_retained_earnings: row.is_retained_earnings.toLowerCase() === "yes" || row.is_retained_earnings === "true",
      }));

      const { error } = await supabase
        .from("account_mappings")
        .insert(insertData);

      if (error) throw error;

      logAction({
        action: "create_account_mapping",
        entityType: "account_mapping",
        metadata: { 
          importedCount: validRows.length,
          fileName: importFileName 
        },
      });

      toast.success(`Successfully imported ${validRows.length} mapping(s)`);
      setImportDialogOpen(false);
      setImportData([]);
      setImportFileName("");
      fetchMappings();
    } catch (error) {
      console.error("Import error:", error);
      toast.error("Failed to import mappings");
    } finally {
      setImportLoading(false);
    }
  };

  // Reset import state
  const resetImport = () => {
    setImportData([]);
    setImportFileName("");
  };

  // Filter mappings
  const filteredMappings = mappings.filter((m) => {
    const matchesSearch =
      !searchQuery ||
      m.account_code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.account_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.line_item.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatement = filterStatement === "all" || m.statement === filterStatement;

    return matchesSearch && matchesStatement;
  });

  // Group mappings by statement for display
  const groupedMappings = filteredMappings.reduce(
    (acc, mapping) => {
      if (!acc[mapping.statement]) {
        acc[mapping.statement] = [];
      }
      acc[mapping.statement].push(mapping);
      return acc;
    },
    {} as Record<FinancialStatement, AccountMapping[]>
  );

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Map className="w-4 h-4" />
            COA Mappings
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader className="pb-4 border-b border-border">
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Chart of Accounts Mappings
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Define explicit mappings from your Chart of Accounts to Financial Statement line items.
              These mappings will be used for deterministic processing—no AI inference.
            </p>
          </DialogHeader>

          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row gap-3 py-4">
            <div className="flex-1 flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by code, name, or line item..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select
                value={filterStatement}
                onValueChange={(v) => setFilterStatement(v as FinancialStatement | "all")}
              >
                <SelectTrigger className="w-44">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by statement" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statements</SelectItem>
                  <SelectItem value="balance_sheet">Balance Sheet</SelectItem>
                  <SelectItem value="income_statement">Income Statement</SelectItem>
                  <SelectItem value="cash_flow">Cash Flow</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setImportDialogOpen(true)} 
                className="gap-2"
              >
                <FileUp className="w-4 h-4" />
                Import CSV
              </Button>
              <Button variant="outline" size="sm" onClick={handleExport} className="gap-2">
                <Download className="w-4 h-4" />
                Export
              </Button>
              <Button
                size="sm"
                className="gap-2"
                onClick={() => {
                  resetForm();
                  setFormDialogOpen(true);
                }}
              >
                <Plus className="w-4 h-4" />
                Add Mapping
              </Button>
            </div>
          </div>

          {/* Mappings Table */}
          <ScrollArea className="flex-1 -mx-6 px-6">
            {loading ? (
              <div className="text-center py-12 text-muted-foreground">Loading mappings...</div>
            ) : filteredMappings.length === 0 ? (
              <div className="text-center py-12">
                <BookOpen className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground mb-2">
                  {searchQuery || filterStatement !== "all"
                    ? "No mappings match your search"
                    : "No account mappings defined yet"}
                </p>
                {!searchQuery && filterStatement === "all" && (
                  <p className="text-sm text-muted-foreground">
                    Add mappings to enable deterministic trial balance processing.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-6">
                {(Object.entries(groupedMappings) as [FinancialStatement, AccountMapping[]][]).map(
                  ([statement, statementMappings]) => (
                    <div key={statement}>
                      <div className="flex items-center gap-2 mb-3 sticky top-0 bg-background py-2">
                        {STATEMENT_ICONS[statement]}
                        <h3 className="font-semibold text-foreground">
                          {STATEMENT_LABELS[statement]}
                        </h3>
                        <Badge variant="secondary" className="text-xs">
                          {statementMappings.length}
                        </Badge>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-28">Code</TableHead>
                            <TableHead>Account Name</TableHead>
                            <TableHead>Classification</TableHead>
                            <TableHead>Line Item</TableHead>
                            <TableHead className="w-20">Balance</TableHead>
                            <TableHead className="w-20">Flags</TableHead>
                            <TableHead className="w-20 text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {statementMappings.map((mapping) => (
                            <TableRow key={mapping.id}>
                              <TableCell className="font-mono text-sm">
                                {mapping.account_code}
                              </TableCell>
                              <TableCell className="font-medium">{mapping.account_name}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs">
                                  {CLASSIFICATION_LABELS[mapping.classification]}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {mapping.line_item}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={mapping.normal_balance === "debit" ? "default" : "secondary"}
                                  className="text-xs"
                                >
                                  {mapping.normal_balance === "debit" ? "DR" : "CR"}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-1">
                                  {mapping.is_cash_account && (
                                    <span title="Cash Account">
                                      <DollarSign className="w-3 h-3 text-accent" />
                                    </span>
                                  )}
                                  {mapping.is_retained_earnings && (
                                    <span title="Retained Earnings">
                                      <BookOpen className="w-3 h-3 text-primary" />
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleEdit(mapping)}
                                    className="h-7 w-7 p-0"
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleDeleteClick(mapping)}
                                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )
                )}
              </div>
            )}
          </ScrollArea>

          {/* Footer */}
          <div className="pt-4 border-t border-border flex items-center justify-between text-sm text-muted-foreground">
            <span>{filteredMappings.length} mapping(s)</span>
            <span>
              Mappings are applied automatically when processing trial balances.
            </span>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Form Dialog */}
      <Dialog
        open={formDialogOpen}
        onOpenChange={(open) => {
          setFormDialogOpen(open);
          if (!open) resetForm();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingMapping ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
              {editingMapping ? "Edit Account Mapping" : "Add Account Mapping"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Account Code & Name */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="account_code">Account Code *</Label>
                <Input
                  id="account_code"
                  value={formData.account_code}
                  onChange={(e) => setFormData({ ...formData, account_code: e.target.value })}
                  placeholder="1000"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account_name">Account Name *</Label>
                <Input
                  id="account_name"
                  value={formData.account_name}
                  onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                  placeholder="Cash"
                  required
                />
              </div>
            </div>

            {/* Statement & Classification */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Financial Statement *</Label>
                <Select value={formData.statement} onValueChange={handleStatementChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="balance_sheet">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" />
                        Balance Sheet
                      </div>
                    </SelectItem>
                    <SelectItem value="income_statement">
                      <div className="flex items-center gap-2">
                        <TrendingUp className="w-4 h-4" />
                        Income Statement
                      </div>
                    </SelectItem>
                    <SelectItem value="cash_flow">
                      <div className="flex items-center gap-2">
                        <PieChart className="w-4 h-4" />
                        Cash Flow
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Classification *</Label>
                <Select value={formData.classification} onValueChange={handleClassificationChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLASSIFICATION_BY_STATEMENT[formData.statement].map((cls) => (
                      <SelectItem key={cls} value={cls}>
                        {CLASSIFICATION_LABELS[cls]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Line Item */}
            <div className="space-y-2">
              <Label>Line Item *</Label>
              <Select
                value={formData.line_item}
                onValueChange={(v) => setFormData({ ...formData, line_item: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select or type a line item" />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_LINE_ITEMS[formData.classification].map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Or enter a custom line item..."
                value={formData.line_item}
                onChange={(e) => setFormData({ ...formData, line_item: e.target.value })}
                className="mt-2"
              />
            </div>

            {/* Normal Balance */}
            <div className="space-y-2">
              <Label>Normal Balance *</Label>
              <Select
                value={formData.normal_balance}
                onValueChange={(v: "debit" | "credit") =>
                  setFormData({ ...formData, normal_balance: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">Debit (DR)</SelectItem>
                  <SelectItem value="credit">Credit (CR)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Special Flags */}
            <div className="space-y-3 p-3 rounded-lg bg-secondary/50 border border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Special Flags
              </p>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="is_cash_account" className="text-sm">
                    Cash Account
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Used for Cash Flow Statement tie-out
                  </p>
                </div>
                <Switch
                  id="is_cash_account"
                  checked={formData.is_cash_account}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_cash_account: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="is_retained_earnings" className="text-sm">
                    Retained Earnings
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Used for Profit-to-Equity linkage validation
                  </p>
                </div>
                <Switch
                  id="is_retained_earnings"
                  checked={formData.is_retained_earnings}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_retained_earnings: checked })
                  }
                />
              </div>
            </div>

            {/* Form Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setFormDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">{editingMapping ? "Update" : "Create"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Account Mapping</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the mapping for "{mappingToDelete?.account_code} -{" "}
              {mappingToDelete?.account_name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* CSV Import Dialog */}
      <Dialog 
        open={importDialogOpen} 
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          if (!open) resetImport();
        }}
      >
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="w-5 h-5 text-primary" />
              Import Account Mappings from CSV
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Upload a CSV file with your Chart of Accounts mappings. Use the Export function to get a template.
            </p>
          </DialogHeader>

          {importData.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-12">
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center w-full max-w-md">
                <Upload className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground mb-4">
                  Drag and drop a CSV file, or click to select
                </p>
                <label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <Button variant="outline" asChild className="cursor-pointer">
                    <span>Select CSV File</span>
                  </Button>
                </label>
                <div className="mt-6 text-left text-xs text-muted-foreground space-y-1">
                  <p className="font-medium">Expected columns:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    <li>Account Code (required)</li>
                    <li>Account Name (required)</li>
                    <li>Statement (balance_sheet, income_statement, cash_flow)</li>
                    <li>Classification (current_assets, equity, revenue, etc.)</li>
                    <li>Line Item (required)</li>
                    <li>Normal Balance (debit, credit)</li>
                    <li>Is Cash Account (Yes/No)</li>
                    <li>Is Retained Earnings (Yes/No)</li>
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* File info and stats */}
              <div className="flex items-center justify-between py-3 px-4 bg-secondary/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <FileUp className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-sm">{importFileName}</p>
                    <p className="text-xs text-muted-foreground">
                      {importData.length} row(s) found
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <span>{importData.filter((r) => r.isValid).length} valid</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <AlertCircle className="w-4 h-4 text-destructive" />
                    <span>{importData.filter((r) => !r.isValid).length} invalid</span>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={resetImport}
                    className="h-8 w-8 p-0"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Preview table */}
              <ScrollArea className="flex-1 -mx-6 px-6 border-y border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">Status</TableHead>
                      <TableHead className="w-24">Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Statement</TableHead>
                      <TableHead>Classification</TableHead>
                      <TableHead>Line Item</TableHead>
                      <TableHead className="w-16">Balance</TableHead>
                      <TableHead className="w-32">Errors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importData.map((row, index) => (
                      <TableRow 
                        key={index} 
                        className={!row.isValid ? "bg-destructive/5" : ""}
                      >
                        <TableCell>
                          {row.isValid ? (
                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                          ) : (
                            <AlertCircle className="w-4 h-4 text-destructive" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.account_code}
                        </TableCell>
                        <TableCell className="text-sm">{row.account_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {STATEMENT_LABELS[row.statement as FinancialStatement] || row.statement}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {CLASSIFICATION_LABELS[row.classification as AccountClassification] || row.classification}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {row.line_item}
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant={row.normal_balance === "debit" ? "default" : "secondary"}
                            className="text-xs"
                          >
                            {row.normal_balance === "debit" ? "DR" : row.normal_balance === "credit" ? "CR" : row.normal_balance}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {row.errors.length > 0 && (
                            <span className="text-xs text-destructive">
                              {row.errors[0]}
                              {row.errors.length > 1 && ` (+${row.errors.length - 1})`}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>

              {/* Actions */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-sm text-muted-foreground">
                  {importData.filter((r) => r.isValid).length} valid row(s) will be imported.
                  Invalid rows will be skipped.
                </p>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    onClick={() => setImportDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleImportConfirm}
                    disabled={importLoading || importData.filter((r) => r.isValid).length === 0}
                    className="gap-2"
                  >
                    {importLoading ? (
                      <>Importing...</>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        Import {importData.filter((r) => r.isValid).length} Mapping(s)
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
});

AccountMappingManager.displayName = "AccountMappingManager";
