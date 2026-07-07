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

interface StatementRow {
  category: string;
  subcategory: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
  balance: number;
  confidence: number;
  isCorrected: boolean;
}

interface Correction {
  account_code: string;
  corrected_category: string;
  corrected_subcategory: string;
}

// Raw account shape written by process-trial-balance v2+ inside each StatementSection.
interface RawAccountEntry {
  account_code: string;
  account_name: string;
  debit:        number;
  credit:       number;
  balance:      number;
}

interface StatementSection {
  accounts: RawAccountEntry[];
  total:    number;
}

// Canonical statements shape written by the edge function (processingResult.statements).
interface CanonicalStatements {
  balance_sheet?:    Record<string, StatementSection>;
  income_statement?: Record<string, StatementSection>;
  cash_flow?:        Record<string, StatementSection> | null;
}

export interface ProcessingResult {
  // Legacy shape (not written by current edge function; kept for forward-compat).
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
  // Canonical shape written by process-trial-balance v2+.
  statements?: CanonicalStatements;
  summary?: {
    // camelCase (legacy / display layer)
    totalAccounts?: number;
    confidenceScore?: number;
    totalAssets?: number;
    totalLiabilities?: number;
    totalEquity?: number;
    netIncome?: number;
    balanceSheetAccounts?: number;
    incomeStatementAccounts?: number;
    cashFlowAccounts?: number;
    unmappedAccounts?: number;
    // snake_case (written by process-trial-balance edge function v2+)
    total_accounts?: number;
    auto_classified?: number;
    processed_at?: string;
    parser_version?: string;
    columns_detected?: string[];
    rejected_rows?: number;
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

// ── Tax-engine result (minimal shape for export) ───────────────────────────
interface SCFEngineForExport {
  operating_activities: {
    profit_before_tax_tzs:                 number;
    add_depreciation_amortisation_tzs:     number;
    add_finance_costs_tzs:                 number;
    working_capital_changes: {
      delta_current_assets_excl_cash_tzs:  number;
      delta_current_liabilities_tzs:       number;
    };
    cash_generated_from_operations_tzs:    number;
    finance_costs_paid_tzs:                number;
    income_taxes_paid_tzs:                 number;
    net_cash_from_operating_tzs:           number;
  };
  investing_activities: {
    ppe_additions_tzs:            number;
    ppe_disposal_proceeds_tzs:    number;
    net_cash_from_investing_tzs:  number;
  };
  financing_activities: {
    change_in_long_term_debt_tzs: number;
    dividends_paid_tzs:           number;
    net_cash_from_financing_tzs:  number;
  };
  net_change_in_cash_tzs:   number;
  opening_cash_tzs:         number;
  closing_cash_tzs:         number;
  reconciles_to_sfp:        boolean;
  note:                     string;
  cpa_note:                 string;
  opening_data_available:   boolean;
}

interface SOCIEEngineForExport {
  share_capital:     { opening_tzs: number; issued_tzs: number;             closing_tzs: number; };
  retained_earnings: { opening_tzs: number; profit_for_year_tzs: number; dividends_declared_tzs: number; closing_tzs: number; };
  other_reserves:    { opening_tzs: number; movement_tzs: number;           closing_tzs: number; };
  total:             { opening_tzs: number; profit_for_year_tzs: number; other_movements_tzs: number; closing_derived_tzs: number; sfp_closing_tzs: number; };
  reconciles_to_sfp:              boolean;
  reconciliation_difference_tzs:  number;
  opening_data_available:         boolean;
  cpa_note:                       string;
}

export interface TaxResultForExport {
  scf_engine?:   SCFEngineForExport;
  socie_engine?: SOCIEEngineForExport;
}

interface ExportStatementsProps {
  fileName: string;
  processingResult: ProcessingResult | null;
  uploadId: string;
  reportingFramework: string | null;
  companyName: string;
  companyTin: string;
  periodYearEnd: string;
  companyCurrency?: string;
  taxResult?: TaxResultForExport | null;
}

// ── Canonical → legacy mapping adapter ────────────────────────────────────────
// process-trial-balance v2+ writes processingResult.statements (snake_case,
// flat per-classification keys).  collectAllData() consumes the legacy
// processingResult.mapping shape (camelCase, nested assets/liabilities).
// This adapter bridges the two without touching the edge function.
function sectionToAccountMappings(
  sections: Record<string, StatementSection> | null | undefined,
  key: string
): AccountMapping[] {
  return (
    sections?.[key]?.accounts?.map((a) => ({
      accountCode: a.account_code,
      accountName: a.account_name,
      debit:       a.debit,
      credit:      a.credit,
      balance:     a.balance,
      confidence:  0, // edge function does not write per-account confidence
    })) ?? []
  );
}

function statementsToMapping(
  statements: CanonicalStatements | undefined
): ProcessingResult["mapping"] | undefined {
  if (!statements) return undefined;
  const bs = statements.balance_sheet;
  const is = statements.income_statement;
  const cf = statements.cash_flow;
  return {
    balanceSheet: {
      assets: {
        current:    sectionToAccountMappings(bs, "current_assets"),
        nonCurrent: sectionToAccountMappings(bs, "non_current_assets"),
      },
      liabilities: {
        current:    sectionToAccountMappings(bs, "current_liabilities"),
        nonCurrent: sectionToAccountMappings(bs, "non_current_liabilities"),
      },
      equity: sectionToAccountMappings(bs, "equity"),
    },
    incomeStatement: {
      revenue:           sectionToAccountMappings(is, "revenue"),
      costOfGoodsSold:   sectionToAccountMappings(is, "cost_of_goods_sold"),
      operatingExpenses: sectionToAccountMappings(is, "operating_expenses"),
      otherIncome:       sectionToAccountMappings(is, "other_income"),
      taxes:             sectionToAccountMappings(is, "taxes"),
    },
    cashFlow: cf
      ? {
          operating: sectionToAccountMappings(cf, "operating_activities"),
          investing:  sectionToAccountMappings(cf, "investing_activities"),
          financing:  sectionToAccountMappings(cf, "financing_activities"),
        }
      : null,
  };
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
  companyCurrency = "TZS",
  taxResult = null,
}: ExportStatementsProps) {
  // Prefer the legacy 'mapping' key; fall back to reshaping the canonical
  // 'statements' object written by process-trial-balance v2+.
  const mapping = processingResult?.mapping
    ?? statementsToMapping(processingResult?.statements);
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
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Unknown error");
      return null;
    }
  };

  const formatCurrency = (value: number | undefined) => {
    if (value === undefined) return `${companyCurrency} 0`;
    return new Intl.NumberFormat("en-TZ", {
      style: "currency",
      currency: companyCurrency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
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
    const data: StatementRow[] = [];
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
    const cfg = resolveFramework();
    if (!cfg) return;
    if (!mapping) { toast.error("No data to export"); return; }

    const doc = new jsPDF();
    const baseFileName  = fileName.replace(/\.[^/.]+$/, "");
    const generatedAt   = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
    const autoCount     = summary?.auto_classified ?? 0;
    const totalCount    = summary?.total_accounts ?? summary?.totalAccounts ?? 0;
    const pageW         = doc.internal.pageSize.getWidth();

    // ── Helpers ───────────────────────────────────────────────────────────────
    const sum = (accs: AccountMapping[] | undefined) =>
      (accs ?? []).reduce((s, a) => s + (a.balance ?? 0), 0);

    const fmt = (v: number) => formatCurrency(Math.abs(v));
    const fmtSigned = (v: number) =>
      v < 0 ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v);

    // Section header row style (indigo strip)
    const secHead = { fillColor: [79, 70, 229] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: "bold" as const, fontSize: 8 };
    // Subtotal row style
    const subtotalStyle = { fillColor: [237, 233, 254] as [number, number, number], fontStyle: "bold" as const, fontSize: 8 };
    // Grand total row style
    const grandStyle = { fillColor: [49, 46, 129] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: "bold" as const, fontSize: 8.5 };
    // Normal account row
    const rowStyle = { fontSize: 7.5 as number, cellPadding: 1.8 };

    const addFooters = () => {
      const n = doc.getNumberOfPages();
      for (let i = 1; i <= n; i++) {
        doc.setPage(i);
        doc.setFontSize(6.5);
        doc.setTextColor(140);
        doc.text(cfg.footer, 14, doc.internal.pageSize.getHeight() - 9, { maxWidth: 130 });
        doc.text(`Page ${i} of ${n}`, pageW - 14, doc.internal.pageSize.getHeight() - 9, { align: "right" });
      }
    };

    // Stamp header block; returns updated y position
    const stampHeader = (y: number): number => {
      doc.setFontSize(14); doc.setTextColor(30);
      doc.text(companyName || "—", 14, y); y += 7;
      doc.setFontSize(8.5); doc.setTextColor(80);
      if (companyTin) { doc.text(`TIN: ${companyTin}`, 14, y); y += 4.5; }
      doc.text(`Period year end: ${periodYearEnd || "—"}`, 14, y);             y += 4.5;
      doc.text(`Framework: ${cfg.displayLabel}`, 14, y);                       y += 4.5;
      doc.text(`Generated: ${generatedAt} · ${totalCount > 0 ? `${autoCount}/${totalCount} accounts auto-classified` : "—"} · Kinga`, 14, y); y += 4.5;
      return y + 2;
    };

    // Build a 2-column statement table body from account sections
    // Returns array of {cells, meta} for autoTable body
    const buildSFPBody = (
      sections: { label: string; accounts: AccountMapping[] | undefined; subtotalLabel: string }[]
    ) => {
      type Row = [string, string];
      const body: Row[] = [];
      const styles: Record<number, object> = {};
      let row = 0;

      for (const sec of sections) {
        // Section header
        styles[row] = secHead;
        body.push([sec.label, ""]);
        row++;
        // Account lines
        for (const acc of (sec.accounts ?? [])) {
          body.push([`  ${acc.accountCode ? acc.accountCode + "  " : ""}${acc.accountName || "—"}`, fmt(acc.balance ?? 0)]);
          row++;
        }
        // Subtotal
        const total = sum(sec.accounts);
        styles[row] = subtotalStyle;
        body.push([`  ${sec.subtotalLabel}`, fmtSigned(total)]);
        row++;
      }
      return { body, styles };
    };

    // ── PAGE 1: Statement of Financial Position ───────────────────────────────
    let y = 14;
    y = stampHeader(y);

    doc.setFontSize(10); doc.setTextColor(30);
    doc.text("STATEMENT OF FINANCIAL POSITION", 14, y); y += 2;

    const bs = mapping.balanceSheet;
    const sfpSections = [
      { label: "ASSETS — Current Assets",     accounts: bs?.assets?.current,    subtotalLabel: "Total Current Assets" },
      { label: "ASSETS — Non-Current Assets", accounts: bs?.assets?.nonCurrent, subtotalLabel: "Total Non-Current Assets" },
      { label: "LIABILITIES — Current",       accounts: bs?.liabilities?.current,    subtotalLabel: "Total Current Liabilities" },
      { label: "LIABILITIES — Non-Current",   accounts: bs?.liabilities?.nonCurrent, subtotalLabel: "Total Non-Current Liabilities" },
      { label: "EQUITY",                       accounts: bs?.equity,             subtotalLabel: "Total Equity" },
    ];

    const { body: sfpBody, styles: sfpStyles } = buildSFPBody(sfpSections);

    // Totals rows
    const totalAssets = sum(bs?.assets?.current) + sum(bs?.assets?.nonCurrent);
    const totalLiab   = sum(bs?.liabilities?.current) + sum(bs?.liabilities?.nonCurrent);
    const totalEquity = sum(bs?.equity);
    sfpBody.push(["TOTAL ASSETS", fmtSigned(totalAssets)]);
    sfpStyles[sfpBody.length - 1] = grandStyle;
    sfpBody.push(["TOTAL LIABILITIES & EQUITY", fmtSigned(totalLiab + totalEquity)]);
    sfpStyles[sfpBody.length - 1] = grandStyle;

    autoTable(doc, {
      body:         sfpBody as [string, string][],
      startY:       y,
      styles:       rowStyle,
      columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 50, halign: "right" } },
      didParseCell: (d) => {
        if (d.section === "body" && sfpStyles[d.row.index]) {
          Object.assign(d.cell.styles, sfpStyles[d.row.index]);
        }
      },
    });

    // ── PAGE 2: Statement of Comprehensive Income ─────────────────────────────
    doc.addPage();
    y = 14;
    y = stampHeader(y);

    doc.setFontSize(10); doc.setTextColor(30);
    doc.text("STATEMENT OF COMPREHENSIVE INCOME", 14, y); y += 2;

    const is = mapping.incomeStatement;
    const totalRevenue  = sum(is?.revenue);
    const totalCOGS     = sum(is?.costOfGoodsSold);
    const grossProfit   = totalRevenue - totalCOGS;
    const totalOpex     = sum(is?.operatingExpenses);
    const opProfit      = grossProfit - totalOpex;
    const otherInc      = sum(is?.otherIncome);
    const taxCharge     = sum(is?.taxes);
    const pbt           = opProfit + otherInc;
    const pat           = pbt - taxCharge;

    type Row2 = [string, string];
    const sciBody: Row2[] = [];
    const sciStyles: Record<number, object> = {};
    let sciRow = 0;

    const addSciSection = (label: string, accounts: AccountMapping[] | undefined) => {
      sciStyles[sciRow] = secHead;
      sciBody.push([label, ""]); sciRow++;
      for (const acc of (accounts ?? [])) {
        sciBody.push([`  ${acc.accountCode ? acc.accountCode + "  " : ""}${acc.accountName || "—"}`, fmt(acc.balance ?? 0)]);
        sciRow++;
      }
    };
    const addSciTotal = (label: string, value: number, grand = false) => {
      sciStyles[sciRow] = grand ? grandStyle : subtotalStyle;
      sciBody.push([label, fmtSigned(value)]); sciRow++;
    };

    addSciSection("REVENUE", is?.revenue);
    addSciTotal("Total Revenue", totalRevenue);
    addSciSection("COST OF GOODS SOLD", is?.costOfGoodsSold);
    addSciTotal("GROSS PROFIT", grossProfit, false);
    addSciSection("OPERATING EXPENSES", is?.operatingExpenses);
    addSciTotal("OPERATING PROFIT / (LOSS)", opProfit, false);
    addSciSection("OTHER INCOME", is?.otherIncome);
    addSciTotal("PROFIT BEFORE TAX", pbt, false);
    addSciSection("INCOME TAX", is?.taxes);
    addSciTotal("PROFIT AFTER TAX", pat, true);

    autoTable(doc, {
      body:         sciBody as [string, string][],
      startY:       y,
      styles:       rowStyle,
      columnStyles: { 0: { cellWidth: 130 }, 1: { cellWidth: 50, halign: "right" } },
      didParseCell: (d) => {
        if (d.section === "body" && sciStyles[d.row.index]) {
          Object.assign(d.cell.styles, sciStyles[d.row.index]);
        }
      },
    });

    // ── PAGE 3: Notes to the Financial Statements ─────────────────────────────
    doc.addPage();
    y = 14;
    y = stampHeader(y);
    doc.setFontSize(10); doc.setTextColor(30);
    doc.text("NOTES TO THE FINANCIAL STATEMENTS", 14, y); y += 7;

    // Note 1 — Basis of Preparation
    doc.setFontSize(8.5); doc.setTextColor(30); doc.setFont("helvetica", "bold");
    doc.text("1.  Basis of Preparation", 14, y); y += 5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
    const note1Lines = doc.splitTextToSize(
      `These financial statements have been prepared in accordance with the ${cfg.displayLabel}. ` +
      `They are prepared on the accrual basis of accounting and present fairly the financial position, ` +
      `financial performance, and (where applicable) cash flows of the entity for the period ended ${periodYearEnd || "—"}.`,
      182
    );
    doc.text(note1Lines, 14, y); y += note1Lines.length * 4.5 + 3;

    // Note 2 — Reporting Currency
    doc.setFontSize(8.5); doc.setTextColor(30); doc.setFont("helvetica", "bold");
    doc.text("2.  Reporting Currency", 14, y); y += 5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
    const note2Lines = doc.splitTextToSize(
      `All amounts in these financial statements are expressed in ${companyCurrency}, which is the functional and presentation currency of the entity. ` +
      `No comparative figures are presented for the current period unless explicitly stated.`,
      182
    );
    doc.text(note2Lines, 14, y); y += note2Lines.length * 4.5 + 3;

    // Note 3 — Use of Estimates and Judgements
    doc.setFontSize(8.5); doc.setTextColor(30); doc.setFont("helvetica", "bold");
    doc.text("3.  Use of Estimates and Judgements", 14, y); y += 5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
    const note3Lines = doc.splitTextToSize(
      `The preparation of financial statements requires management to make estimates and assumptions that affect reported amounts. ` +
      `Actual results may differ from these estimates. Key areas of estimation include: depreciation and amortisation of non-current assets, ` +
      `impairment of receivables, and income tax provisions. These statements were computer-generated by Kinga from the entity's trial balance ` +
      `and must be reviewed and approved by management before publication or submission.`,
      182
    );
    doc.text(note3Lines, 14, y); y += note3Lines.length * 4.5 + 3;

    // Note 4 — Classification Summary (auto-generated, factual)
    if (totalCount > 0) {
      doc.setFontSize(8.5); doc.setTextColor(30); doc.setFont("helvetica", "bold");
      doc.text("4.  Account Classification Summary", 14, y); y += 5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
      const data4 = collectAllData(cfg);
      const corrCount = data4.filter(r => r.isCorrected).length;
      const note4Lines = doc.splitTextToSize(
        `The trial balance comprised ${totalCount} accounts. ` +
        (autoCount > 0
          ? `${autoCount} accounts (${Math.round((autoCount / totalCount) * 100)}%) were classified automatically by Kinga's six-tier classifier. `
          : "") +
        (corrCount > 0
          ? `${corrCount} account(s) were manually reclassified by the preparer after review. `
          : "") +
        `Accounts classified in this report are detailed in Appendix A.`,
        182
      );
      doc.text(note4Lines, 14, y); y += note4Lines.length * 4.5 + 3;
    }

    // Note 5 — Going Concern (standard disclosure)
    doc.setFontSize(8.5); doc.setTextColor(30); doc.setFont("helvetica", "bold");
    doc.text(`${totalCount > 0 ? "5" : "4"}.  Going Concern`, 14, y); y += 5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(60);
    const note5Lines = doc.splitTextToSize(
      `The financial statements have been prepared on the going concern basis. Management has assessed the entity's ability to ` +
      `continue as a going concern and has not identified material uncertainties that would cast significant doubt on this assessment. ` +
      `This disclosure should be reviewed by the responsible CPA and updated if management's assessment differs.`,
      182
    );
    doc.text(note5Lines, 14, y); y += note5Lines.length * 4.5 + 3;

    // ── PAGE 4: Statement of Changes in Equity (SOCIE) ───────────────────────
    doc.addPage();
    y = 14;
    y = stampHeader(y);
    doc.setFontSize(10); doc.setTextColor(30);
    doc.text("STATEMENT OF CHANGES IN EQUITY", 14, y); y += 2;

    const socie = taxResult?.socie_engine;
    if (socie) {
      type SocieRow = [string, string, string, string, string];
      const socieBody: SocieRow[] = [];
      const socieRowStyles: Record<number, object> = {};
      let sr = 0;
      const fmtS = (v: number) => v === 0 ? "—"
        : v < 0 ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v);

      // Header row
      socieRowStyles[sr] = { ...secHead, fontSize: 7 };
      socieBody.push(["", `Share Capital\n${companyCurrency}`, `Retained Earnings\n${companyCurrency}`, `Other Reserves\n${companyCurrency}`, `Total\n${companyCurrency}`]);
      sr++;

      // Opening balance
      socieBody.push([
        "Opening balance",
        fmtS(socie.share_capital.opening_tzs),
        fmtS(socie.retained_earnings.opening_tzs),
        fmtS(socie.other_reserves.opening_tzs),
        fmtS(socie.total.opening_tzs),
      ]); sr++;

      // Profit for year
      socieRowStyles[sr] = { fontStyle: "bold" as const, fillColor: [237, 233, 254] as [number, number, number] };
      socieBody.push([
        "Profit for the year",
        "—",
        fmtS(socie.retained_earnings.profit_for_year_tzs),
        "—",
        fmtS(socie.total.profit_for_year_tzs),
      ]); sr++;

      // Dividends
      if (socie.retained_earnings.dividends_declared_tzs !== 0) {
        socieBody.push([
          "Dividends declared",
          "—",
          fmtS(socie.retained_earnings.dividends_declared_tzs),
          "—",
          fmtS(socie.retained_earnings.dividends_declared_tzs),
        ]); sr++;
      }

      // Share capital issued
      if (socie.share_capital.issued_tzs !== 0) {
        socieBody.push([
          "Share capital issued",
          fmtS(socie.share_capital.issued_tzs),
          "—",
          "—",
          fmtS(socie.share_capital.issued_tzs),
        ]); sr++;
      }

      // Closing balance
      socieRowStyles[sr] = { ...grandStyle };
      socieBody.push([
        "Closing balance",
        fmtS(socie.share_capital.closing_tzs),
        fmtS(socie.retained_earnings.closing_tzs),
        fmtS(socie.other_reserves.closing_tzs),
        fmtS(socie.total.closing_derived_tzs),
      ]); sr++;

      autoTable(doc, {
        body:         socieBody as [string, string, string, string, string][],
        startY:       y,
        styles:       { fontSize: 7.5, cellPadding: 2 },
        columnStyles: {
          0: { cellWidth: 60 },
          1: { cellWidth: 30, halign: "right" },
          2: { cellWidth: 40, halign: "right" },
          3: { cellWidth: 30, halign: "right" },
          4: { cellWidth: 30, halign: "right" },
        },
        didParseCell: (d) => {
          if (d.section === "body" && socieRowStyles[d.row.index]) {
            Object.assign(d.cell.styles, socieRowStyles[d.row.index]);
          }
        },
      });
      // CPA note
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const soAfter = (doc as any).lastAutoTable.finalY + 3;
      doc.setFontSize(6.5); doc.setTextColor(140);
      const socieNote = doc.splitTextToSize(
        (socie.opening_data_available ? "✓ Opening balances loaded from prior-year records. " : "† Opening balances not available — first year or no prior period saved. ")
        + socie.cpa_note, 182);
      doc.text(socieNote, 14, soAfter);
    } else {
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(
        "Statement of Changes in Equity will appear here once the ITA Tax Analysis has been run and committed.",
        14, y + 6
      );
      doc.setFontSize(6.5); doc.setTextColor(160);
      doc.text("Run Kinga Tax Analysis and commit to generate this statement.", 14, y + 12);
    }

    // ── PAGE 5: Statement of Cash Flows (Indirect Method) ────────────────────
    doc.addPage();
    y = 14;
    y = stampHeader(y);
    doc.setFontSize(10); doc.setTextColor(30);
    doc.text("STATEMENT OF CASH FLOWS", 14, y);
    doc.setFontSize(7.5); doc.setTextColor(100);
    doc.text("(Indirect Method)", 14 + doc.getTextWidth("STATEMENT OF CASH FLOWS") + 4, y);
    y += 2;

    const scf = taxResult?.scf_engine;
    if (scf) {
      type Row2 = [string, string];
      const scfBody: Row2[] = [];
      const scfStyles: Record<number, object> = {};
      let scfR = 0;
      const fmtCF = (v: number) => v === 0 ? "—"
        : v < 0 ? `(${formatCurrency(Math.abs(v))})` : formatCurrency(v);

      // Operating
      scfStyles[scfR] = secHead;
      scfBody.push(["OPERATING ACTIVITIES", ""]); scfR++;
      scfBody.push(["  Profit before tax", fmtCF(scf.operating_activities.profit_before_tax_tzs)]); scfR++;
      scfBody.push(["  Add: Depreciation & amortisation", fmtCF(scf.operating_activities.add_depreciation_amortisation_tzs)]); scfR++;
      scfBody.push(["  Add: Finance costs (reclassified)", fmtCF(scf.operating_activities.add_finance_costs_tzs)]); scfR++;
      scfBody.push(["  Decrease/(increase) in working capital assets",
        fmtCF(scf.operating_activities.working_capital_changes.delta_current_assets_excl_cash_tzs)]); scfR++;
      scfBody.push(["  Increase/(decrease) in current liabilities",
        fmtCF(scf.operating_activities.working_capital_changes.delta_current_liabilities_tzs)]); scfR++;
      scfStyles[scfR] = subtotalStyle;
      scfBody.push(["  Cash generated from operations", fmtCF(scf.operating_activities.cash_generated_from_operations_tzs)]); scfR++;
      scfBody.push(["  Finance costs paid", fmtCF(scf.operating_activities.finance_costs_paid_tzs)]); scfR++;
      scfBody.push(["  Income taxes paid", fmtCF(scf.operating_activities.income_taxes_paid_tzs)]); scfR++;
      scfStyles[scfR] = grandStyle;
      scfBody.push(["NET CASH FROM OPERATING ACTIVITIES", fmtCF(scf.operating_activities.net_cash_from_operating_tzs)]); scfR++;

      // Investing
      scfBody.push(["", ""]); scfR++;
      scfStyles[scfR] = secHead;
      scfBody.push(["INVESTING ACTIVITIES", ""]); scfR++;
      scfBody.push(["  Purchase of property, plant & equipment", fmtCF(scf.investing_activities.ppe_additions_tzs)]); scfR++;
      scfBody.push(["  Proceeds from disposal of assets", fmtCF(scf.investing_activities.ppe_disposal_proceeds_tzs)]); scfR++;
      scfStyles[scfR] = grandStyle;
      scfBody.push(["NET CASH FROM INVESTING ACTIVITIES", fmtCF(scf.investing_activities.net_cash_from_investing_tzs)]); scfR++;

      // Financing
      scfBody.push(["", ""]); scfR++;
      scfStyles[scfR] = secHead;
      scfBody.push(["FINANCING ACTIVITIES", ""]); scfR++;
      scfBody.push(["  Increase/(decrease) in long-term borrowings", fmtCF(scf.financing_activities.change_in_long_term_debt_tzs)]); scfR++;
      scfBody.push(["  Dividends paid", fmtCF(scf.financing_activities.dividends_paid_tzs)]); scfR++;
      scfStyles[scfR] = grandStyle;
      scfBody.push(["NET CASH FROM FINANCING ACTIVITIES", fmtCF(scf.financing_activities.net_cash_from_financing_tzs)]); scfR++;

      // Summary
      scfBody.push(["", ""]); scfR++;
      scfStyles[scfR] = subtotalStyle;
      scfBody.push(["NET INCREASE/(DECREASE) IN CASH", fmtCF(scf.net_change_in_cash_tzs)]); scfR++;
      scfBody.push(["Cash and cash equivalents at beginning of year", fmtCF(scf.opening_cash_tzs)]); scfR++;
      scfStyles[scfR] = { ...grandStyle, fontSize: 8.5 };
      scfBody.push(["CASH AND CASH EQUIVALENTS AT END OF YEAR", fmtCF(scf.closing_cash_tzs)]); scfR++;

      autoTable(doc, {
        body:         scfBody as [string, string][],
        startY:       y,
        styles:       rowStyle,
        columnStyles: { 0: { cellWidth: 140 }, 1: { cellWidth: 40, halign: "right" } },
        didParseCell: (d) => {
          if (d.section === "body" && scfStyles[d.row.index]) {
            Object.assign(d.cell.styles, scfStyles[d.row.index]);
          }
        },
      });

      // Reconciliation notice
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scfAfter = (doc as any).lastAutoTable.finalY + 3;
      doc.setFontSize(6.5); doc.setTextColor(140);
      const reconLabel = scf.reconciles_to_sfp
        ? "✓ SCF closing cash reconciles to Statement of Financial Position balance."
        : `⚠ SCF closing cash does NOT reconcile to SFP balance. Review cash account classification.`;
      const scfNoteLines = doc.splitTextToSize(
        reconLabel + "  " + scf.cpa_note, 182);
      doc.text(scfNoteLines, 14, scfAfter);
    } else {
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text(
        "Statement of Cash Flows will appear here once the ITA Tax Analysis has been run and committed.",
        14, y + 6
      );
    }

    // ── APPENDIX A: Trial Balance Listing ─────────────────────────────────────
    doc.addPage();
    y = 14;
    y = stampHeader(y);
    doc.setFontSize(9); doc.setTextColor(30);
    doc.text("APPENDIX A — TRIAL BALANCE LISTING (source data)", 14, y); y += 2;

    const data = collectAllData(cfg);
    const correctedCount = data.filter(r => r.isCorrected).length;
    if (correctedCount > 0) {
      doc.setFontSize(7.5); doc.setTextColor(5, 150, 105);
      doc.text(`${correctedCount} user-verified correction(s) shown in green`, 14, y); y += 4;
    }

    const tbData = data.map(row => [
      row.isCorrected ? `✓ ${row.subcategory}` : row.subcategory,
      row.code,
      row.name,
      formatCurrency(row.debit),
      formatCurrency(row.credit),
      formatCurrency(row.balance),
    ]);

    autoTable(doc, {
      head: [["Category", "Code", "Account Name", "Debit", "Credit", "Balance"]],
      body: tbData,
      startY: y,
      styles: { fontSize: 6.5, cellPadding: 1.6 },
      headStyles: { fillColor: [100, 100, 120] },
      alternateRowStyles: { fillColor: [248, 248, 252] },
      columnStyles: {
        0: { cellWidth: 30 },
        1: { cellWidth: 14 },
        2: { cellWidth: 70 },
        3: { cellWidth: 22, halign: "right" },
        4: { cellWidth: 22, halign: "right" },
        5: { cellWidth: 22, halign: "right" },
      },
      didParseCell: (d) => {
        if (d.section === "body" && data[d.row.index]?.isCorrected) {
          d.cell.styles.fillColor = [209, 250, 229];
          d.cell.styles.textColor = [5, 150, 105];
          d.cell.styles.fontStyle = "bold";
        }
      },
    });

    addFooters();
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
      ["Total accounts",       summary?.total_accounts ?? summary?.totalAccounts ?? 0],
      ["Auto-classified",      summary?.auto_classified != null && (summary?.total_accounts ?? summary?.totalAccounts ?? 0) > 0
        ? `${summary.auto_classified} of ${summary.total_accounts ?? summary.totalAccounts}`
        : "—"],
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
        row.isCorrected ? "Verified" : "Auto",
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
          row.isCorrected ? "Verified" : "Auto",
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
          row.isCorrected ? "Verified" : "Auto",
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
          row.isCorrected ? "Verified" : "Auto",
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
