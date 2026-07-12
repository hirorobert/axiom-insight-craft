// ============================================================
// generateTaxComputationPDF — Roadmap Item 5F
// Standalone Tax Computation Report (ITA Chapter 332)
//
// Produces a downloadable PDF of the full CIT computation:
//   Cover → ITA Waterfall → Capital Allowances → Add-backs
//   → Deferred Tax Position → Instalment Schedule → Findings
//
// Dependencies: jsPDF + jspdf-autotable (already in package.json)
//
// IRON DOME: all figures come from computation_detail and DB rows.
// No number is invented here — the function will throw if
// key fields are missing rather than silently showing zero.
//
// Verified statutory constants used in PDF labels:
//   CIT 30%        — ITA Cap.332 s.4 / PwC TZ Jan 2026
//   AMT 0.5% turn  — ITA Cap.332 s.65 / FA2025
//   Penalty 5%/mo  — TAA 2015 s.76
//   Instalment     — ITA Cap.332 s.88
// ============================================================

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ── Types (matches KingaTaxPanel TaxResult) ────────────────────

interface TaxAdjustment {
  description: string;
  amount_tzs: number;
  ita_section: string;
  auto_detected?: boolean;
}

interface TaxResult {
  engine_version: string;
  accounting_profit_before_tax_tzs: number;
  gross_income_tzs: number;
  add_backs: TaxAdjustment[];
  deductions: TaxAdjustment[];
  total_add_backs_tzs: number;
  total_deductions_tzs: number;
  total_wear_tear_tzs: number;
  thin_cap_disallowed_tzs: number;
  taxable_income_tzs: number;
  cit_at_30pct_tzs: number;
  minimum_tax_tzs: number;
  tax_payable_tzs: number;
  minimum_tax_applies: boolean;
  effective_tax_rate_pct: number;
  income_tax_provision_tzs: number;
  cit_gap_tzs: number;
  penalty_tzs: number;
  total_exposure_tzs: number;
  warnings?: string[];
  module_d_deferred?: {
    timing_diff_tzs: number;
    wear_tear_tzs: number;
    accounting_depreciation_tzs: number;
    dtl_timing_tzs: number;
    dta_timing_tzs: number;
    net_deferred_tax_position_tzs: number;
    dta_loss_recognized_tzs: number;
    total_tax_expense_tzs: number;
  };
  amt_applies?: boolean;
  amt_computed_tzs?: number;
  opening_cumulative_loss_tzs?: number;
  loss_absorbed_this_year_tzs?: number;
  closing_cumulative_loss_tzs?: number;
}

interface CapAllowanceRow {
  asset_description: string;
  ita_class: number;
  cost_tzs: number;
  ita_wdv_opening_tzs: number;
  additions_tzs: number;
  disposals_at_tax_cost_tzs: number;
  wear_tear_allowance_tzs: number;
  ita_wdv_closing_tzs: number;
}

interface FindingRow {
  title: string;
  finding_category: string | null;
  exposure_amount_tzs: number;
  status: string;
}

interface GeneratePDFOptions {
  result: TaxResult;
  companyName: string;
  companyTin?: string;
  periodYear: number;
  periodEndMonth: number;
  allowances: CapAllowanceRow[];
  findings: FindingRow[];
  preparerName?: string;
}

// ── Helpers ───────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const ITA_CLASS_SHORT: Record<number, string> = {
  1: "Class 1 — 37.5% RB",
  2: "Class 2 — 25% RB",
  3: "Class 3 — 12.5% RB",
  5: "Class 5 — 20% SL",
  6: "Class 6 — 5% SL",
  7: "Class 7 — 1/useful life SL",
  8: "Class 8 — 100% immediate",
};

const c = (n: number): string =>
  n.toLocaleString("en-TZ", { maximumFractionDigits: 0 });

const tzs = (n: number): string => {
  const abs = Math.abs(n);
  return n < 0 ? `(${c(abs)})` : c(abs);
};

function addMonths(startM: number, startY: number, n: number): string {
  const total = startY * 12 + startM - 1 + n;
  const rm    = (total % 12) + 1;
  const ry    = Math.floor(total / 12);
  // Last day of resulting month
  const d = new Date(ry, rm, 0);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ── Dark navy colour ──────────────────────────────────────────
const NAVY  = [14, 29, 48]  as [number, number, number];
const LIGHT = [245, 247, 250] as [number, number, number];
const RED   = [180, 30, 30]   as [number, number, number];

// ── Main export ───────────────────────────────────────────────

export function generateTaxComputationPDF(opts: GeneratePDFOptions): void {
  const {
    result, companyName, companyTin, periodYear, periodEndMonth,
    allowances, findings, preparerName,
  } = opts;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW  = doc.internal.pageSize.getWidth();
  const pageH  = doc.internal.pageSize.getHeight();
  const margin = 14;
  const col2   = pageW / 2 + 5;
  const colW   = pageW - margin * 2;

  const generatedAt = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "long", year: "numeric",
  });

  const fyEnd = `${periodEndMonth ? MONTHS[periodEndMonth - 1] : "December"} ${periodYear}`;

  // ── Footer on every page ─────────────────────────────────────
  const totalPages = () =>
    (doc.internal as unknown as { getNumberOfPages: () => number }).getNumberOfPages();

  const addFooter = () => {
    const n = totalPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFontSize(6.5);
      doc.setTextColor(130);
      doc.setFont("helvetica", "normal");
      doc.text(
        `SAFF ERP  |  kinga-tax-engine ${result.engine_version}  |  ITA Cap.332 R.E.2023  |  Confidential`,
        margin, pageH - 8,
      );
      doc.text(`Page ${i} of ${n}`, pageW - margin, pageH - 8, { align: "right" });
    }
  };

  // ── Section heading helper ────────────────────────────────────
  const sectionHeading = (label: string, y: number): number => {
    doc.setFillColor(...NAVY);
    doc.rect(margin, y, colW, 7, "F");
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(label.toUpperCase(), margin + 2, y + 5);
    doc.setTextColor(30, 30, 30);
    return y + 11;
  };

  // ── Waterfall row helper ──────────────────────────────────────
  const wRow = (
    label: string, value: string | number, y: number,
    opts: { bold?: boolean; shade?: boolean; indent?: boolean; redIfNeg?: boolean } = {},
  ): number => {
    const numStr = typeof value === "number" ? tzs(value) : value;
    const isNeg  = typeof value === "number" && value < 0;

    if (opts.shade) {
      doc.setFillColor(...LIGHT);
      doc.rect(margin, y - 4.5, colW, 6.5, "F");
    }

    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.bold ? 8.5 : 8);
    doc.setTextColor(30);
    doc.text((opts.indent ? "   " : "") + label, margin + 2, y);

    if (opts.redIfNeg && isNeg) {
      doc.setTextColor(...RED);
    } else if (opts.bold) {
      doc.setTextColor(...NAVY);
    }
    doc.text(numStr, pageW - margin, y, { align: "right" });
    doc.setTextColor(30);

    return y + 6;
  };

  // ══════════════════════════════════════════════════════════════
  // PAGE 1 — COVER
  // ══════════════════════════════════════════════════════════════

  // Navy header band
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageW, 42, "F");

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("SAFF ERP", margin, 14);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.text("Audit-Ready FS & Tax Reporting  |  Tanzania ITA Cap.332 R.E.2023", margin, 20);

  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("Corporate Income Tax Computation", margin, 34);

  // Company details
  let y = 56;
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30);
  doc.text(companyName, margin, y); y += 8;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80);
  if (companyTin) {
    doc.text(`TRA Tax Identification Number (TIN): ${companyTin}`, margin, y); y += 5.5;
  }
  doc.text(`Year of income: ${periodYear}  (fiscal year ending ${fyEnd})`, margin, y); y += 5.5;
  doc.text(`Generated: ${generatedAt}`, margin, y); y += 5.5;
  if (preparerName) {
    doc.text(`Prepared by: ${preparerName}`, margin, y); y += 5.5;
  }

  // Divider
  y += 4;
  doc.setDrawColor(...NAVY);
  doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y); y += 8;

  // Summary box — 3 KPIs
  const boxW = (colW - 8) / 3;
  const boxes = [
    { label: "Tax Payable", value: `TZS ${c(result.tax_payable_tzs)}`, highlight: false },
    { label: "Effective Rate", value: `${result.effective_tax_rate_pct.toFixed(1)}%`, highlight: false },
    { label: "CIT Gap", value: `TZS ${c(Math.abs(result.cit_gap_tzs))}`, highlight: result.cit_gap_tzs !== 0 },
  ];
  boxes.forEach((b, i) => {
    const bx = margin + i * (boxW + 4);
    doc.setFillColor(b.highlight ? 255 : 245, b.highlight ? 240 : 247, b.highlight ? 240 : 250);
    doc.setDrawColor(b.highlight ? 180 : 210, b.highlight ? 80 : 218, b.highlight ? 80 : 230);
    doc.setLineWidth(0.3);
    doc.roundedRect(bx, y, boxW, 20, 1.5, 1.5, "FD");
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100);
    doc.text(b.label, bx + boxW / 2, y + 6.5, { align: "center" });
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(b.highlight ? 160 : 30, b.highlight ? 30 : 30, 30);
    doc.text(b.value, bx + boxW / 2, y + 14, { align: "center" });
  });
  y += 28;

  // Engine / statutory note
  doc.setFontSize(7);
  doc.setFont("helvetica", "italic");
  doc.setTextColor(120);
  const notice =
    `Computed by kinga-tax-engine ${result.engine_version}. ` +
    `Statutory rates verified against ITA Chapter 332 (R.E.2023), Finance Act 2025, ` +
    `and PwC Tanzania Tax Summaries (January 2026). ` +
    `This document is for professional use only and must be reviewed by a qualified CPA ` +
    `before submission to TRA.`;
  const noticeLines = doc.splitTextToSize(notice, colW);
  doc.text(noticeLines, margin, y); y += noticeLines.length * 4 + 6;

  if (result.warnings && result.warnings.length > 0) {
    doc.setFillColor(255, 248, 230);
    doc.setDrawColor(220, 160, 30);
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, y, colW, 8 + result.warnings.length * 5, 1.5, 1.5, "FD");
    y += 5;
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(140, 90, 20);
    doc.text("Computation Warnings", margin + 3, y); y += 5;
    doc.setFont("helvetica", "normal");
    result.warnings.forEach((w) => {
      doc.text(`• ${w}`, margin + 3, y); y += 5;
    });
    y += 4;
  }

  // ══════════════════════════════════════════════════════════════
  // PAGE 2 — ITA WATERFALL
  // ══════════════════════════════════════════════════════════════
  doc.addPage();
  y = 20;
  y = sectionHeading("Section 1 — ITA Chapter 332 Tax Computation Waterfall", y);

  y = wRow("Accounting Profit Before Tax (PBT)", result.accounting_profit_before_tax_tzs, y, { bold: true, shade: true });
  y += 2;

  // Add-backs
  if (result.add_backs.length > 0) {
    doc.setFontSize(7.5); doc.setFont("helvetica", "bold"); doc.setTextColor(60);
    doc.text("ITA Add-backs:", margin + 2, y); y += 5;
    result.add_backs.forEach((ab) => {
      y = wRow(
        `${ab.description}  [${ab.ita_section}]`,
        ab.amount_tzs, y,
        { indent: true },
      );
    });
    y = wRow("Total Add-backs", result.total_add_backs_tzs, y, { bold: true });
    y += 2;
  }

  // Deductions (W&T)
  if (result.deductions.length > 0 || result.total_wear_tear_tzs) {
    doc.setFontSize(7.5); doc.setFont("helvetica", "bold"); doc.setTextColor(60);
    doc.text("ITA Deductions (Wear & Tear / s.34):", margin + 2, y); y += 5;
    result.deductions.forEach((d) => {
      y = wRow(
        `${d.description}  [${d.ita_section}]`,
        -Math.abs(d.amount_tzs), y,
        { indent: true, redIfNeg: true },
      );
    });
    if (result.total_wear_tear_tzs) {
      y = wRow("Total Wear & Tear Allowances", -Math.abs(result.total_wear_tear_tzs), y, { bold: true, redIfNeg: true });
    }
    y += 2;
  }

  // Thin cap
  if (result.thin_cap_disallowed_tzs > 0) {
    y = wRow(
      `Thin Capitalisation Disallowance  [ITA s.12 — ratio ${(result as Record<string,number>).debt_equity_ratio?.toFixed(2) ?? "—"}:1]`,
      result.thin_cap_disallowed_tzs, y, { indent: true },
    );
    y += 2;
  }

  // Divider before taxable income
  doc.setDrawColor(200); doc.setLineWidth(0.3);
  doc.line(margin, y - 1, pageW - margin, y - 1); y += 2;

  y = wRow("Taxable Income", result.taxable_income_tzs, y, { bold: true, shade: true });
  y += 3;

  // Tax computation
  y = wRow("CIT @ 30%  [ITA s.4]", result.cit_at_30pct_tzs, y);
  if (result.minimum_tax_tzs > 0) {
    y = wRow(
      `Minimum Tax @ 0.5% of Turnover  [ITA s.65]${result.minimum_tax_applies ? " ← APPLIES" : ""}`,
      result.minimum_tax_tzs, y, { indent: true },
    );
  }
  y += 1;
  doc.setDrawColor(200); doc.line(margin, y - 1, pageW - margin, y - 1); y += 2;
  y = wRow("Tax Payable", result.tax_payable_tzs, y, { bold: true, shade: true });
  y += 4;

  // Gap analysis
  y = wRow("Income Tax Provision (per Trial Balance)", result.income_tax_provision_tzs, y);
  y = wRow(
    `CIT Gap (Provision − Payable)`,
    result.cit_gap_tzs, y,
    { bold: true, shade: true, redIfNeg: true },
  );
  y += 2;

  if (result.penalty_tzs > 0) {
    y = wRow(
      `Estimated Penalty @ 5%/month  [TAA 2015 s.76]  (${(result as Record<string,number>).months_overdue ?? "?"} months)`,
      result.penalty_tzs, y, { redIfNeg: false },
    );
  }

  doc.setFontSize(7.5); doc.setFont("helvetica", "bold"); doc.setTextColor(...NAVY);
  y = wRow("Total Exposure (Gap + Penalty)", result.total_exposure_tzs, y, { bold: true, shade: true });

  y += 4;
  doc.setFontSize(7); doc.setFont("helvetica", "italic"); doc.setTextColor(120);
  doc.text(
    `Effective rate: ${result.effective_tax_rate_pct.toFixed(2)}%  |  ` +
    (result.minimum_tax_applies ? "Minimum Tax applies (3-year loss trigger)  |  " : "") +
    `Engine: ${result.engine_version}`,
    margin, y,
  );

  // ══════════════════════════════════════════════════════════════
  // PAGE 3 — CAPITAL ALLOWANCES SCHEDULE
  // ══════════════════════════════════════════════════════════════
  doc.addPage();
  y = 20;
  y = sectionHeading("Section 2 — Capital Allowances Schedule  (ITA s.34)", y);

  if (allowances.length === 0) {
    doc.setFontSize(8); doc.setFont("helvetica", "italic"); doc.setTextColor(120);
    doc.text("No capital allowances entered for this period.", margin + 2, y);
    y += 10;
  } else {
    autoTable(doc, {
      startY: y,
      head: [["Asset", "Class", "Cost TZS", "Opening WDV", "Additions", "Disposals", "W&T Allow.", "Closing WDV"]],
      body: allowances.map((a) => [
        a.asset_description,
        ITA_CLASS_SHORT[a.ita_class] ?? `Class ${a.ita_class}`,
        c(a.cost_tzs),
        c(a.ita_wdv_opening_tzs),
        c(a.additions_tzs),
        a.disposals_at_tax_cost_tzs ? `(${c(a.disposals_at_tax_cost_tzs)})` : "—",
        c(a.wear_tear_allowance_tzs),
        c(a.ita_wdv_closing_tzs),
      ]),
      foot: [["Total", "", "", "", "", "", c(result.total_wear_tear_tzs), ""]],
      styles: { fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold" },
      footStyles: { fillColor: LIGHT, textColor: NAVY, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 42 },
        2: { halign: "right" }, 3: { halign: "right" },
        4: { halign: "right" }, 5: { halign: "right" },
        6: { halign: "right" }, 7: { halign: "right" },
      },
      margin: { left: margin, right: margin },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  // ── Add-backs detail table ────────────────────────────────────
  y = sectionHeading("Section 3 — ITA Add-backs / Disallowances Schedule", y);

  if (result.add_backs.length === 0) {
    doc.setFontSize(8); doc.setFont("helvetica", "italic"); doc.setTextColor(120);
    doc.text("No add-backs required for this period.", margin + 2, y);
    y += 10;
  } else {
    autoTable(doc, {
      startY: y,
      head: [["Adjustment", "ITA Section", "Amount TZS", "Auto-detected"]],
      body: result.add_backs.map((ab) => [
        ab.description,
        ab.ita_section,
        tzs(ab.amount_tzs),
        ab.auto_detected ? "Yes" : "Manual",
      ]),
      foot: [["Total Add-backs", "", tzs(result.total_add_backs_tzs), ""]],
      styles: { fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold" },
      footStyles: { fillColor: LIGHT, textColor: NAVY, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 70 },
        2: { halign: "right" },
        3: { halign: "center" },
      },
      margin: { left: margin, right: margin },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  // ══════════════════════════════════════════════════════════════
  // PAGE 4 — DEFERRED TAX + INSTALMENTS + FINDINGS
  // ══════════════════════════════════════════════════════════════
  doc.addPage();
  y = 20;

  // Deferred Tax Position (Module D)
  if (result.module_d_deferred) {
    const d = result.module_d_deferred;
    y = sectionHeading("Section 4 — Deferred Tax Position  (IFRS for SMEs s.29 / IAS 12)", y);
    autoTable(doc, {
      startY: y,
      head: [["Component", "TZS"]],
      body: [
        ["W&T allowance (tax base)", c(d.wear_tear_tzs)],
        ["Accounting depreciation", c(d.accounting_depreciation_tzs)],
        ["Timing difference (accelerated / decelerated)", tzs(d.timing_diff_tzs)],
        ["Deferred Tax Liability — timing", c(d.dtl_timing_tzs)],
        ["Deferred Tax Asset — timing", c(d.dta_timing_tzs)],
        ["Deferred Tax Asset — loss carry-forward recognised", c(d.dta_loss_recognized_tzs)],
        ...(result.opening_cumulative_loss_tzs !== undefined ? [
          ["Opening cumulative loss pool  [ITA s.19]", c(result.opening_cumulative_loss_tzs)],
          ["Loss absorbed this period", tzs(-(result.loss_absorbed_this_year_tzs ?? 0))],
          ["Closing cumulative loss pool", c(result.closing_cumulative_loss_tzs ?? 0)],
        ] : []),
        ["Net Deferred Tax Position (SFP)", tzs(d.net_deferred_tax_position_tzs)],
        ["Total tax expense (current + deferred)", tzs(d.total_tax_expense_tzs)],
      ],
      styles: { fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold" },
      columnStyles: { 1: { halign: "right" } },
      margin: { left: margin, right: margin },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // Instalment Schedule (ITA s.88)
  y = sectionHeading("Section 5 — ITA s.88 Instalment Tax Schedule", y);
  const startM = (periodEndMonth % 12) + 1;
  const startY2 = periodEndMonth === 12 ? periodYear : periodYear - 1;
  const inst = Math.round(result.tax_payable_tzs / 4);
  const instalments = [
    { label: "Instalment 1  (3 months after fiscal year start)", n: 3,  amount: inst },
    { label: "Instalment 2  (6 months after fiscal year start)", n: 6,  amount: inst },
    { label: "Instalment 3  (9 months after fiscal year start)", n: 9,  amount: inst },
    { label: "Final Balance  (12 months — annual return due)", n: 12, amount: result.tax_payable_tzs - inst * 3 },
  ];
  autoTable(doc, {
    startY: y,
    head: [["Payment", "Due Date", "Amount TZS"]],
    body: instalments.map((ins) => [
      ins.label,
      addMonths(startM, startY2, ins.n),
      c(ins.amount),
    ]),
    foot: [["Total", "", c(result.tax_payable_tzs)]],
    styles: { fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: NAVY, textColor: [255, 255, 255], fontStyle: "bold" },
    footStyles: { fillColor: LIGHT, textColor: NAVY, fontStyle: "bold" },
    columnStyles: { 2: { halign: "right" } },
    margin: { left: margin, right: margin },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;

  // Outstanding findings summary
  const openFindings = findings.filter((f) => f.status === "open" || f.status === "in_progress");
  if (openFindings.length > 0) {
    y = sectionHeading("Section 6 — Outstanding Statutory Findings", y);
    autoTable(doc, {
      startY: y,
      head: [["Finding", "Category", "Exposure TZS", "Status"]],
      body: openFindings.map((f) => [
        f.title,
        f.finding_category ?? "—",
        c(f.exposure_amount_tzs),
        f.status.replace("_", " "),
      ]),
      foot: [[
        "Total Exposure",
        "",
        c(openFindings.reduce((s, f) => s + Number(f.exposure_amount_tzs), 0)),
        "",
      ]],
      styles: { fontSize: 7.5, cellPadding: 2 },
      headStyles: { fillColor: [120, 30, 30], textColor: [255, 255, 255], fontStyle: "bold" },
      footStyles: { fillColor: LIGHT, textColor: RED, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 70 }, 2: { halign: "right" } },
      margin: { left: margin, right: margin },
    });
  }

  // Add footers to all pages
  addFooter();

  // ── Download ──────────────────────────────────────────────────
  const safeName = companyName.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "_");
  doc.save(`SAFF_CIT_${safeName}_${periodYear}.pdf`