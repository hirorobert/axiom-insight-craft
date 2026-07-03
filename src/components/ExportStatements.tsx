/* Canonical Financial Model:
   production axiom/kinga_canonical_financial_model.md
   All financial data consumed by this module must conform
   to that contract.
   Key correction: statutory_rules audit field is 'notes', not 'source_note'.
   canonical_financial_records is a transaction ingestion table, not
   an account-balance table. Account balances live in trial_balance_uploads
   and account_mappings. */
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
    } | null;
    overallConfidence?: number;
  };
  summary?: {
    totalAccounts: number;
    confidenceScore?: number;
    totalAssets?: number;
    totalLiabilities?: number;
    totalEquity?: number;
    netIncome?: number;
    balanceSheetAccounts?: number;
    incomeStatementAccounts?: number;
    cashFlowAccounts?: number;
    unmappedAccounts?: number;
  };
}

interface FrameworkConfig {
  displayLabel: string;
  statementNames: {
    balanceSheet: string;
    incomeStatement: string;
    equity: string;
    cashFlow: string;
  };
  footer: string;
}

interface ExportStatementsProps {
  fileName: string;
  processingResult: ProcessingResult | null;
  uploadId: string;
  reportingFramework: string | null;
  companyName: string;
  companyTin: string;
  periodYearEnd: string;
}

/* REFACTOR NOTE: This branching is intentional for two
   frameworks. When a third framework is added, refactor
   to Framework Adapter pattern per Priority 8.
   Do not add a third branch here. */
function getFrameworkConfig(value: string): FrameworkConfig {
  if (value === "ifrs_for_smes") {
    return {
      displayLabel: "IFRS for SMEs",
      statementNames: {
        balanceSheet:    "Statement of Financial Position",
        incomeStatement: "Statement of Comprehensive Income",
        equity:          "Statement of Changes in Equity",
        cashFlow:        "Statement of Cash Flows",
      },
      footer:
        "Prepared in accordance with the International Financial Reporting " +
        "Standard for Small and Medium-sized Entities (IFRS for SMEs) as issued by the IASB.",
    };
  }
  if (value === "ipsas_accrual") {
    return {
      displayLabel: "IPSAS Accrual",
      statementNames: {
        balanceSheet:    "Statement of Financial Position",
        incomeStatement: "Statement of Financial Performance",
        equity:          "Statement of Changes in Net Assets/Equity",
        cashFlow:        "Statement of Cash Flows",
      },
      footer:
        "Prepared in accordance with International Public Sector Accounting " +
        "Standards (IPSAS) as issued by the IPSASB. Accrual basis.",
    };
  }
  throw new Error(
    `Export blocked: '${value}' is not a supported reporting framework. ` +
    `Supported values: ifrs_for_smes, ipsas_accrual.`
  );
}

export function ExportStatements({
  fileName,
  processingResult,
  uploadId,
  reportingFramework,
  companyName,
  companyTin,
  periodYearEnd,
}: ExportStatementsProps) {
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

  // Resolves and validates reporting_framework at the start of every export.
  // Returns null and shows a toast if the value is absent or unsupported.
  const resolveFramework = (): FrameworkConfig | null => {
    if (reportingFramework === null || reportingFramework === undefined) {
      toast.error(
        "Export blocked: reporting_framework is not set for this company. " +
        "Set it in Company Settings before exporting."
      );
      return null;
    }
    try {
      return getFrameworkConfig(reportingFramework);
    } catch (err: any) {
      toast.error(err.message);
      return null;
    }
  };

  const formatCurrency = (value: number | undefined) => {
    if (value === undefined) return "$0.00";
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  };

  const getAllAccounts = (
    category: string,
    subcategory: string,
    accounts: AccountMapping[] | undefined
  ) => {
    if (!accounts) return [];
    return accounts.map(acc => {
      const correction = corrections.get(acc.accountCode || "");
      const isCorrected = !!correction;
      return {
        category:    isCorrected ? correction.corrected_category    : category,
        subcategory: isCorrected ? correction.corrected_subcategory : subcategory,
        code:        acc.accountCode || "",
        name:        acc.accountName || "",
        debit:       acc.debit   || 0,
        credit:      acc.credit  || 0,
        balance:     acc.balance || (acc.debit || 0) - (acc.credit || 0),
        confidence:  acc.confidence || 0,
        isCorrected,
      };
    });
  };

  const collectAllData = (cfg: FrameworkConfig) => {
    const data: any[] = [];
    const sn = cfg.statementNames;

    if (mapping?.balanceSheet) {
      data.push(...getAllAccounts(sn.balanceSheet, "Current Assets",          mapping.balanceSheet.assets?.current));
      data.push(...getAllAccounts(sn.balanceSheet, "Non-Current Assets",      mapping.balanceSheet.assets?.nonCurrent));
      data.push(...getAllAccounts(sn.balanceSheet, "Current Liabilities",     mapping.balanceSheet.liabilities?.current));
      data.push(...getAllAccounts(sn.balanceSheet, "Non-Current Liabilities", mapping.balanceSheet.liabilities?.nonCurrent));
      data.push(...getAllAccounts(sn.balanceSheet, "Equity",                  mapping.balanceSheet.equity));
    }

    if (mapping?.incomeStatement) {
      data.push(...getAllAccounts(sn.incomeStatement, "Revenue",            mapping.incomeStatement.revenue));
      data.push(...getAllAccounts(sn.incomeStatement, "Cost of Goods Sold", mapping.incomeStatement.costOfGoodsSold));
      data.push(...getAllAccounts(sn.incomeStatement, "Operating Expenses", mapping.incomeStatement.operatingExpenses));
      data.push(...getAllAccounts(sn.incomeStatement, "Other Income",       mapping.incomeStatement.otherIncome));
      data.push(...getAllAccounts(sn.incomeStatement, "Taxes",              mapping.incomeStatement.taxes));
    }

    if (mapping?.cashFlow) {
      data.push(...getAllAccounts(sn.cashFlow, "Operating Activities", mapping.cashFlow.operating));
      data.push(...getAllAccounts(sn.cashFlow, "Investing Activities", mapping.cashFlow.investing));
      data.push(...getAllAccounts(sn.cashFlow, "Financing Activities", mapping.cashFlow.financing));
    }

    return data;
  };

  const exportToPDF = () => {
    // A — Read and validate reporting_framework at the start of export.
    const cfg = resolveFramework();
    if (!cfg) return; // B — NULL or unsupported: blocked above, do not continue.

    if (!mapping) {
      toast.error("No data to export");
      return;
    }

    const doc = new jsPDF();
    const data = collectAllData(cfg);
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");
    const correctedCount = data.filter(row => row.isCorrected).length;
    const generatedAt = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const sn = cfg.statementNames;

    // D — Stamp: company name, TIN, period, framework, generated time, Kinga line.
    let y = 14;
    doc.setFontSize(15);
    doc.setTextColor(40);
    doc.text(companyName || "—", 14, y);
    y += 7;

    doc.setFontSize(9);
    doc.setTextColor(80);
    if (companyTin) {
      doc.text(`TIN: ${companyTin}`, 14, y);
      y += 5;
    }
    doc.text(`Period year end: ${periodYearEnd || "—"}`, 14, y);                        y += 5;
    doc.text(`Reporting framework: ${cfg.displayLabel}`, 14, y);                        y += 5;
    doc.text(`Generated: ${generatedAt}`, 14, y);                                       y += 5;
    doc.text("Generated by Kinga — for professional review before submission", 14, y);  y += 5;
    doc.text(`Source file: ${fileName}`, 14, y);                                        y += 5;
    doc.text(`AI Confidence Score: ${summary?.confidenceScore || 0}%`, 14, y);          y += 3;

    if (correctedCount > 0) {
      doc.setTextColor(16, 185, 129);
      doc.text(`User-Verified Corrections: ${correctedCount} account(s)`, 14, y);
      y += 4;
      doc.setFontSize(8);
      doc.text("* Green highlighted rows indicate user-verified corrections", 14, y);
      y += 4;
      doc.setFontSize(9);
      doc.setTextColor(80);
    }

    y += 2;

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
      startY: y,
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [79, 70, 229] },
      alternateRowStyles: { fillColor: [245, 245, 250] },
      columnStyles: {
        0: { cellWidth: 28 },
        1: { cellWidth: 28 },
        2: { cellWidth: 16 },
        3: { cellWidth: 38 },
        4: { cellWidth: 22, halign: "right" },
        5: { cellWidth: 22, halign: "right" },
        6: { cellWidth: 22, halign: "right" },
        7: { cellWidth: 16, halign: "center" },
      },
      didParseCell: (hookData) => {
        if (hookData.section === "body") {
          const rowIndex = hookData.row.index;
          if (data[rowIndex]?.isCorrected) {
            hookData.cell.styles.fillColor = [209, 250, 229];
            hookData.cell.styles.textColor = [5, 150, 105];
            hookData.cell.styles.fontStyle = "bold";
          }
        }
      },
    });

    // D — Footer on every page with framework compliance statement.
    const pageCount = (doc as any).internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(120);
      const footerY = doc.internal.pageSize.getHeight() - 10;
      doc.text(cfg.footer, 14, footerY, { maxWidth: 180 });
    }

    doc.save(`${baseFileName}-financial-statements.pdf`);
    toast.success("PDF exported successfully");
    logAction({
      action: "export_statements",
      entityType: "trial_balance_upload",
      entityId: uploadId,
      metadata: {
        format: "pdf",
        fileName: `${baseFileName}-financial-statements.pdf`,
        reportingFramework: reportingFramework ?? "",
      },
    });
  };

  const exportToExcel = () => {
    // A — Read and validate reporting_framework at the start of export.
    const cfg = resolveFramework();
    if (!cfg) return; // B — NULL or unsupported: blocked above, do not continue.

    if (!mapping) {
      toast.error("No data to export");
      return;
    }

    const data = collectAllData(cfg);
    const baseFileName = fileName.replace(/\.[^/.]+$/, "");
    const correctedCount = data.filter(row => row.isCorrected).length;
    const generatedAt = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const sn = cfg.statementNames;

    const wb = XLSX.utils.book_new();

    // D — Summary sheet: company name, TIN, period, framework, generated time, Kinga line.
    const summaryData = [
      [companyName || "—"],
      [""],
      ["TIN",                 companyTin    || "—"],
      ["Period year end",     periodYearEnd || "—"],
      ["Reporting framework", cfg.displayLabel],
      ["Generated",           generatedAt],
      ["Generated by",        "Kinga — for professional review before submission"],
      [""],
      ["Source file",         fileName],
      ["Total accounts",      summary?.totalAccounts || 0],
      ["AI Confidence Score", `${summary?.confidenceScore || 0}%`],
      ["User-Verified Corrections", correctedCount],
      [""],
      ["Note: Rows marked with ✓ indicate user-verified corrections"],
      [""],
      [cfg.footer],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

    // All Mappings sheet
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
        ...correctedData.map(row => [
          row.category, row.subcategory, row.code, row.name,
          row.debit, row.credit, row.balance,
        ]),
      ]);
      XLSX.utils.book_append_sheet(wb, corrSheet, "User Corrections");
    }

    // C — Per-statement sheets using framework-specific names (capped at 31 chars for Excel).
    const bsData = data.filter(row => row.category === sn.balanceSheet);
    if (bsData.length > 0) {
      const bsSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...bsData.map(row => [
          row.subcategory, row.code, row.name, row.debit, row.credit, row.balance,
          row.isCorrected ? "Verified" : `${row.confidence}%`,
          row.isCorrected ? "✓" : "",
        ]),
      ]);
      XLSX.utils.book_append_sheet(wb, bsSheet, sn.balanceSheet.substring(0, 31));
    }

    const isData = data.filter(row => row.category === sn.incomeStatement);
    if (isData.length > 0) {
      const isSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...isData.map(row => [
          row.subcategory, row.code, row.name, row.debit, row.credit, row.balance,
          row.isCorrected ? "Verified" : `${row.confidence}%`,
          row.isCorrected ? "✓" : "",
        ]),
      ]);
      XLSX.utils.book_append_sheet(wb, isSheet, sn.incomeStatement.substring(0, 31));
    }

    const cfData = data.filter(row => row.category === sn.cashFlow);
    if (cfData.length > 0) {
      const cfSheet = XLSX.utils.aoa_to_sheet([
        ["Category", "Account Code", "Account Name", "Debit", "Credit", "Balance", "Status", "User Verified"],
        ...cfData.map(row => [
          row.subcategory, row.code, row.name, row.debit, row.credit, row.balance,
          row.isCorrected ? "Verified" : `${row.confidence}%`,
          row.isCorrected ? "✓" : "",
        ]),
      ]);
      XLSX.utils.book_append_sheet(wb, cfSheet, sn.cashFlow.substring(0, 31));
    }

    XLSX.writeFile(wb, `${baseFileName}-financial-statements.xlsx`);
    toast.success("Excel file exported successfully");
    logAction({
      action: "export_statements",
      entityType: "trial_balance_upload",
      entityId: uploadId,
      metadata: {
        format: "excel",
        fileName: `${baseFileName}-financial-statements.xlsx`,
        reportingFramework: reportingFramework ?? "",
      },
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
