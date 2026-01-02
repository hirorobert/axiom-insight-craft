import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, FileText, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { supabase } from "@/integrations/supabase/client";
import { useAuditLog } from "@/hooks/useAuditLog";

interface AccountMapping {
  accountCode?: string;
  accountName?: string;
  balance?: number;
  debit?: number;
  credit?: number;
  confidence?: number;
}

interface Correction {
  account_code: string;
  corrected_category: string;
  corrected_subcategory: string;
}

interface ProcessingResult {
  mapping?: {
    balanceSheet?: {
      assets?: { current?: AccountMapping[]; nonCurrent?: AccountMapping[] };
      liabilities?: { current?: AccountMapping[]; nonCurrent?: AccountMapping[] };
      equity?: AccountMapping[];
    };
    incomeStatement?: {
      revenue?: AccountMapping[];
      costOfGoodsSold?: AccountMapping[];
      operatingExpenses?: AccountMapping[];
      otherIncome?: AccountMapping[];
      taxes?: AccountMapping[];
    };
    cashFlow?: {
      operating?: AccountMapping[];
      investing?: AccountMapping[];
      financing?: AccountMapping[];
    };
    overallConfidence?: number;
  };
  summary?: {
    totalAccounts: number;
    confidenceScore: number;
  };
}

interface ExportStatementsProps {
  fileName: string;
  processingResult: ProcessingResult | null;
  uploadId: string;
}

export function ExportStatements({ fileName, processingResult, uploadId }: ExportStatementsProps) {
  const mapping = processingResult?.mapping;
  const summary = processingResult?.summary;
  const [corrections, setCorrections] = useState<Map<string, Correction>>(new Map());
  const { logAction } = useAuditLog();

  useEffect(() => {
    const fetchCorrections = async () => {
      if (!uploadId) return;
      
      const { data, error } = await supabase
        .from("account_corrections")
        .select("account_code, corrected_category, corrected_subcategory")
        .eq("upload_id", uploadId);

      if (!error && data) {
        const correctionMap = new Map<string, Correction>();
        data.forEach((c) => {
          correctionMap.set(c.account_code, c as Correction);
        });
        setCorrections(correctionMap);
      }
    };

    fetchCorrections();
  }, [uploadId]);

  const formatCurrency = (value: number | undefined) => {
    if (value === undefined) return "$0.00";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  };

  const getAllAccounts = (category: string, subcategory: string, accounts: AccountMapping[] | undefined) => {
    if (!accounts) return [];
    return accounts.map(acc => {
      const correction = corrections.get(acc.accountCode || "");
      const isCorrected = !!correction;
      
      return {
        category: isCorrected ? correction.corrected_category : category,
        subcategory: isCorrected ? correction.corrected_subcategory : subcategory,
        code: acc.accountCode || "",
        name: acc.accountName || "",
        debit: acc.debit || 0,
        credit: acc.credit || 0,
        balance: acc.balance || (acc.debit || 0) - (acc.credit || 0),
        confidence: acc.confidence || 0,
        isCorrected,
      };
    });
  };

  const collectAllData = () => {
    const data: any[] = [];

    // Balance Sheet
    if (mapping?.balanceSheet) {
      data.push(...getAllAccounts("Balance Sheet", "Current Assets", mapping.balanceSheet.assets?.current));
      data.push(...getAllAccounts("Balance Sheet", "Non-Current Assets", mapping.balanceSheet.assets?.nonCurrent));
      data.push(...getAllAccounts("Balance Sheet", "Current Liabilities", mapping.balanceSheet.liabilities?.current));
      data.push(...getAllAccounts("Balance Sheet", "Non-Current Liabilities", mapping.balanceSheet.liabilities?.nonCurrent));
      data.push(...getAllAccounts("Balance Sheet", "Equity", mapping.balanceSheet.equity));
    }

    // Income Statement
    if (mapping?.incomeStatement) {
      data.push(...getAllAccounts("Income Statement", "Revenue", mapping.incomeStatement.revenue));
      data.push(...getAllAccounts("Income Statement", "Cost of Goods Sold", mapping.incomeStatement.costOfGoodsSold));
      data.push(...getAllAccounts("Income Statement", "Operating Expenses", mapping.incomeStatement.operatingExpenses));
      data.push(...getAllAccounts("Income Statement", "Other Income", mapping.incomeStatement.otherIncome));
      data.push(...getAllAccounts("Income Statement", "Taxes", mapping.incomeStatement.taxes));
    }

    // Cash Flow
    if (mapping?.cashFlow) {
      data.push(...getAllAccounts("Cash Flow", "Operating Activities", mapping.cashFlow.operating));
      data.push(...getAllAccounts("Cash Flow", "Investing Activities", mapping.cashFlow.investing));
      data.push(...getAllAccounts("Cash Flow", "Financing Activities", mapping.cashFlow.financing));
    }

    return data;
  };

  const exportToPDF = () => {
    if (!mapping) {
      toast.error("No data to export");
      return;
    }

    const doc = new jsPDF();
    const data = collectAllData();
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");
    const correctedCount = data.filter(row => row.isCorrected).length;

    // Title
    doc.setFontSize(18);
    doc.setTextColor(40);
    doc.text("Financial Statement Mappings", 14, 20);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Source: ${fileName}`, 14, 28);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 34);
    doc.text(`AI Confidence Score: ${summary?.confidenceScore || 0}%`, 14, 40);
    
    if (correctedCount > 0) {
      doc.setTextColor(16, 185, 129); // Green color for corrections
      doc.text(`User-Verified Corrections: ${correctedCount} account(s)`, 14, 46);
      doc.setTextColor(100);
    }

    // Legend
    const startY = correctedCount > 0 ? 54 : 48;
    if (correctedCount > 0) {
      doc.setFontSize(8);
      doc.setTextColor(16, 185, 129);
      doc.text("* Green highlighted rows indicate user-verified corrections", 14, startY - 2);
      doc.setTextColor(100);
    }

    // Table with highlighted corrections
    const tableData = data.map(row => [
      row.isCorrected ? `✓ ${row.category}` : row.category,
      row.subcategory,
      row.code,
      row.name,
      formatCurrency(row.debit),
      formatCurrency(row.credit),
      formatCurrency(row.balance),
      row.isCorrected ? "Verified" : `${row.confidence}%`,
    ]);

    autoTable(doc, {
      head: [["Statement", "Category", "Code", "Account Name", "Debit", "Credit", "Balance", "Status"]],
      body: tableData,
      startY: startY + 2,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [79, 70, 229] },
      alternateRowStyles: { fillColor: [245, 245, 250] },
      columnStyles: {
        0: { cellWidth: 25 },
        1: { cellWidth: 28 },
        2: { cellWidth: 18 },
        3: { cellWidth: 40 },
        4: { cellWidth: 22, halign: "right" },
        5: { cellWidth: 22, halign: "right" },
        6: { cellWidth: 22, halign: "right" },
        7: { cellWidth: 18, halign: "center" },
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body') {
          const rowIndex = hookData.row.index;
          if (data[rowIndex]?.isCorrected) {
            hookData.cell.styles.fillColor = [209, 250, 229]; // Light green background
            hookData.cell.styles.textColor = [5, 150, 105]; // Green text
            hookData.cell.styles.fontStyle = 'bold';
          }
        }
      },
    });

    doc.save(`${baseFileName}-financial-statements.pdf`);
    toast.success("PDF exported successfully");
    logAction({
      action: "export_statements",
      entityType: "trial_balance_upload",
      entityId: uploadId,
      metadata: { format: "pdf", fileName: `${baseFileName}-financial-statements.pdf` },
    });
  };

  const exportToExcel = () => {
    if (!mapping) {
      toast.error("No data to export");
      return;
    }

    const data = collectAllData();
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");
    const correctedCount = data.filter(row => row.isCorrected).length;

    // Create workbook with multiple sheets
    const wb = XLSX.utils.book_new();

    // Summary sheet
    const summaryData = [
      ["Financial Statement Mappings"],
      [""],
      ["Source File", fileName],
      ["Generated Date", new Date().toLocaleDateString()],
      ["Total Accounts", summary?.totalAccounts || 0],
      ["AI Confidence Score", `${summary?.confidenceScore || 0}%`],
      ["User-Verified Corrections", correctedCount],
      [""],
      ["Note: Rows marked with ✓ indicate user-verified corrections"],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

    // All mappings sheet
    const allData = [
      ["Statement", "Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
      ...data.map(row => [
        row.category,
        row.subcategory,
        row.code,
        row.name,
        row.debit,
        row.credit,
        row.balance,
        row.isCorrected ? "Verified" : `${row.confidence}%`,
        row.isCorrected ? "✓ YES" : "",
      ]),
    ];
    const allSheet = XLSX.utils.aoa_to_sheet(allData);
    XLSX.utils.book_append_sheet(wb, allSheet, "All Mappings");

    // Corrected accounts sheet
    const correctedData = data.filter(row => row.isCorrected);
    if (correctedData.length > 0) {
      const corrSheet = XLSX.utils.aoa_to_sheet([
        ["Statement", "Category", "Account Code", "Account Name", "Debit", "Credit", "Balance"],
        ...correctedData.map(row => [row.category, row.subcategory, row.code, row.name, row.debit, row.credit, row.balance]),
      ]);
      XLSX.utils.book_append_sheet(wb, corrSheet, "User Corrections");
    }

    // Balance Sheet
    const bsData = data.filter(row => row.category === "Balance Sheet");
    if (bsData.length > 0) {
      const bsSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...bsData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, row.isCorrected ? "Verified" : `${row.confidence}%`, row.isCorrected ? "✓" : ""]),
      ]);
      XLSX.utils.book_append_sheet(wb, bsSheet, "Balance Sheet");
    }

    // Income Statement
    const isData = data.filter(row => row.category === "Income Statement");
    if (isData.length > 0) {
      const isSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...isData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, row.isCorrected ? "Verified" : `${row.confidence}%`, row.isCorrected ? "✓" : ""]),
      ]);
      XLSX.utils.book_append_sheet(wb, isSheet, "Income Statement");
    }

    // Cash Flow
    const cfData = data.filter(row => row.category === "Cash Flow");
    if (cfData.length > 0) {
      const cfSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...cfData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, row.isCorrected ? "Verified" : `${row.confidence}%`, row.isCorrected ? "✓" : ""]),
      ]);
      XLSX.utils.book_append_sheet(wb, cfSheet, "Cash Flow");
    }

    XLSX.writeFile(wb, `${baseFileName}-financial-statements.xlsx`);
    toast.success("Excel file exported successfully");
    logAction({
      action: "export_statements",
      entityType: "trial_balance_upload",
      entityId: uploadId,
      metadata: { format: "excel", fileName: `${baseFileName}-financial-statements.xlsx` },
    });
  };

  const isDisabled = !mapping;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={isDisabled}>
          <Download className="w-4 h-4" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={exportToPDF} className="gap-2 cursor-pointer">
          <FileText className="w-4 h-4" />
          Download as PDF
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportToExcel} className="gap-2 cursor-pointer">
          <FileSpreadsheet className="w-4 h-4" />
          Download as Excel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
