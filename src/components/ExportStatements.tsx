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

interface AccountMapping {
  accountCode?: string;
  accountName?: string;
  balance?: number;
  debit?: number;
  credit?: number;
  confidence?: number;
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
}

export function ExportStatements({ fileName, processingResult }: ExportStatementsProps) {
  const mapping = processingResult?.mapping;
  const summary = processingResult?.summary;

  const formatCurrency = (value: number | undefined) => {
    if (value === undefined) return "$0.00";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  };

  const getAllAccounts = (category: string, subcategory: string, accounts: AccountMapping[] | undefined) => {
    if (!accounts) return [];
    return accounts.map(acc => ({
      category,
      subcategory,
      code: acc.accountCode || "",
      name: acc.accountName || "",
      debit: acc.debit || 0,
      credit: acc.credit || 0,
      balance: acc.balance || (acc.debit || 0) - (acc.credit || 0),
      confidence: acc.confidence || 0,
    }));
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

    // Title
    doc.setFontSize(18);
    doc.setTextColor(40);
    doc.text("Financial Statement Mappings", 14, 20);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Source: ${fileName}`, 14, 28);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 34);
    doc.text(`AI Confidence Score: ${summary?.confidenceScore || 0}%`, 14, 40);

    // Table
    const tableData = data.map(row => [
      row.category,
      row.subcategory,
      row.code,
      row.name,
      formatCurrency(row.debit),
      formatCurrency(row.credit),
      formatCurrency(row.balance),
      `${row.confidence}%`,
    ]);

    autoTable(doc, {
      head: [["Statement", "Category", "Code", "Account Name", "Debit", "Credit", "Balance", "Confidence"]],
      body: tableData,
      startY: 48,
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
    });

    doc.save(`${baseFileName}-financial-statements.pdf`);
    toast.success("PDF exported successfully");
  };

  const exportToExcel = () => {
    if (!mapping) {
      toast.error("No data to export");
      return;
    }

    const data = collectAllData();
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");

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
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

    // All mappings sheet
    const allData = [
      ["Statement", "Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Confidence"],
      ...data.map(row => [
        row.category,
        row.subcategory,
        row.code,
        row.name,
        row.debit,
        row.credit,
        row.balance,
        `${row.confidence}%`,
      ]),
    ];
    const allSheet = XLSX.utils.aoa_to_sheet(allData);
    XLSX.utils.book_append_sheet(wb, allSheet, "All Mappings");

    // Balance Sheet
    const bsData = data.filter(row => row.category === "Balance Sheet");
    if (bsData.length > 0) {
      const bsSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Confidence"],
        ...bsData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, `${row.confidence}%`]),
      ]);
      XLSX.utils.book_append_sheet(wb, bsSheet, "Balance Sheet");
    }

    // Income Statement
    const isData = data.filter(row => row.category === "Income Statement");
    if (isData.length > 0) {
      const isSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Confidence"],
        ...isData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, `${row.confidence}%`]),
      ]);
      XLSX.utils.book_append_sheet(wb, isSheet, "Income Statement");
    }

    // Cash Flow
    const cfData = data.filter(row => row.category === "Cash Flow");
    if (cfData.length > 0) {
      const cfSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Confidence"],
        ...cfData.map(row => [row.subcategory, row.code, row.name, row.debit, row.credit, row.balance, `${row.confidence}%`]),
      ]);
      XLSX.utils.book_append_sheet(wb, cfSheet, "Cash Flow");
    }

    XLSX.writeFile(wb, `${baseFileName}-financial-statements.xlsx`);
    toast.success("Excel file exported successfully");
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
