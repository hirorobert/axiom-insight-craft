// frameworkPacks/ifrsForSmes.ts — the IFRS for SMEs pack, pinned per edition.
//
// Two editions exist and both are live for real reporting periods:
//   - 2015 edition (2015 Amendments, effective for annual periods beginning on or after 1 January 2017), which continues
//     to apply until the third edition's effective date;
//   - third edition (issued February 2025, effective for annual periods beginning on or after 1 January 2027, earlier
//     application permitted).
// Which one a report uses is decided by editionPolicy.ts from the period START and a recorded early-application
// election — never by a default.
//
// Citations were verified on 2026-10-08 against the sources in SOURCES (verification class per citation; see types.ts).
// Labels are short paraphrases; the cited paragraph is the authority. Nothing here asserts that a report complies.

import type { Citation, FrameworkPack, PackRequirement, PresentationLine, ScheduleDefinition, SourceDocument } from "./types";

export const SOURCES: Readonly<Record<string, SourceDocument>> = {
  "smes-2015-text": {
    id: "smes-2015-text",
    title: "IFRS for SMEs (2015 edition, incorporating the 2015 Amendments)",
    publisher: "IFRS Foundation",
    url: "https://iacsa.co.za/wp-content/uploads/2019/01/IFRS-for-SMES-2015.pdf",
    retrieved: "2026-10-08",
    sha256: "acc6500e58f9090eddc8e2b55bc531f93e718d320c7c40c695898bb82235eb9f",
    bytes: 1027941,
    note: "A copy of the IFRS Foundation's published 2015 text hosted by a third party; the text (headers read 'IFRS FOR SMES—2015 © IFRS Foundation') was extracted from these exact bytes.",
  },
  "smes-2025-text": {
    id: "smes-2025-text",
    title: "IFRS for SMEs Accounting Standard, third edition (2025), HTML",
    publisher: "IFRS Foundation",
    url: "https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2025/issued/html-ifrs-for-smes.html",
    retrieved: "2026-10-08",
    note: "Read through a fetch/extraction step; bytes not pinned.",
  },
  "smes-2025-supporting": {
    id: "smes-2025-supporting",
    title: "2025 IFRS for SMEs supporting materials",
    publisher: "IFRS Foundation",
    url: "https://www.ifrs.org/supporting-implementation/2025-ifrs-for-smes-supporting-materials/",
    retrieved: "2026-10-08",
    note: "States the third edition's effective date (1 January 2027), that earlier application is permitted and that the 2015 edition may be applied until then.",
  },
  "ey-ifrs-developments-235": {
    id: "ey-ifrs-developments-235",
    title: "IFRS Developments Issue 235 (March 2025)",
    publisher: "EY",
    url: "https://www.ey.com/content/dam/ey-unified-site/ey-com/en-sg/services/assurance/documents/ey-sg-ifrs-developments-issue-235-03-2025.pdf",
    retrieved: "2026-10-08",
    note: "Secondary: states that early adoption of the third edition must be disclosed.",
  },
};

type Edition = "2015" | "2025";
const T = (ed: Edition, paragraph: string): Citation =>
  ed === "2015" ? { source: "smes-2015-text", paragraph, verification: "PRIMARY_TEXT" } : { source: "smes-2025-text", paragraph, verification: "PRIMARY_EXTRACT" };

function requirements(ed: Edition): PackRequirement[] {
  const c = (p: string) => [T(ed, p)];
  const line = (letter: string, label: string, condition?: string): PackRequirement => ({
    id: `smes.sfp.4_2_${letter}`, kind: "LINE_ITEM", statement: "SFP", label, citations: c(`4.2(${letter})`),
    applicability: "CONDITIONAL", condition: condition ?? "The entity has amounts of this kind at either reporting date.", blocking: true,
  });
  const sci = (letter: string, label: string, condition?: string, blocking = true): PackRequirement => ({
    id: `smes.sci.5_5_${letter}`, kind: "LINE_ITEM", statement: "SCI", label, citations: c(`5.5(${letter})`),
    applicability: condition ? "CONDITIONAL" : "ALWAYS", condition, blocking,
  });
  return [
    // Complete set (3.17) and the statement-of-income-and-retained-earnings alternative (3.18).
    { id: "smes.set.sfp", kind: "STATEMENT", statement: "SFP", label: "Statement of financial position as at the reporting date", citations: c("3.17(a)"), applicability: "ALWAYS", blocking: true },
    { id: "smes.set.sci", kind: "STATEMENT", statement: "SCI", label: "Statement of comprehensive income (single statement, or income statement plus statement of comprehensive income)", citations: c("3.17(b)"), applicability: "ALWAYS", blocking: true },
    { id: "smes.set.socie", kind: "STATEMENT", statement: "SOCIE", label: "Statement of changes in equity for the reporting period", citations: [...c("3.17(c)"), ...c("6.3")], applicability: "CONDITIONAL",
      condition: "Required unless the paragraph 3.18 conditions are met and a statement of income and retained earnings is presented instead (recorded decision).", blocking: true },
    { id: "smes.set.scf", kind: "STATEMENT", statement: "SCF", label: "Statement of cash flows for the reporting period", citations: [...c("3.17(d)"), ...c("7.1")], applicability: "ALWAYS", blocking: true },
    { id: "smes.set.notes", kind: "STATEMENT", statement: "NOTES", label: ed === "2015" ? "Notes: summary of significant accounting policies and other explanatory information" : "Notes: material accounting policy information and other explanatory information",
      citations: c("3.17(e)"), applicability: "ALWAYS", blocking: true },
    // Comparatives and period.
    { id: "smes.comparatives", kind: "COMPARATIVE", label: "Comparative information for the previous comparable period, for all amounts presented", citations: c("3.14"), applicability: "ALWAYS", blocking: true },
    { id: "smes.period.annual", kind: "PERIOD", label: "A complete set at least annually; a longer or shorter period is disclosed with its reason and the non-comparability",
      citations: c("3.10"), applicability: "ALWAYS", blocking: true },
    // Statement of financial position: minimum line items (4.2) and the current/non-current distinction (4.4).
    line("a", "Cash and cash equivalents"),
    line("b", "Trade and other receivables"),
    line("c", "Financial assets not presented on another line"),
    line("d", "Inventories"),
    line("e", ed === "2015" ? "Property, plant and equipment" : "Property, plant and equipment (including bearer plants)"),
    line("ea", "Investment property at cost less depreciation and impairment"),
    line("f", "Investment property at fair value through profit or loss"),
    line("g", "Intangible assets"),
    line("h", "Biological assets at cost less depreciation and impairment"),
    line("i", "Biological assets at fair value through profit or loss"),
    line("j", "Investments in associates"),
    line("k", "Investments in jointly controlled entities"),
    line("l", "Trade and other payables"),
    line("m", "Financial liabilities not presented on another line"),
    line("n", "Current tax liabilities and assets"),
    line("o", "Deferred tax liabilities and assets (always non-current)"),
    line("p", "Provisions"),
    line("q", "Non-controlling interest, within equity", "The entity has a non-controlling interest (consolidated statements)."),
    line("r", "Equity attributable to the owners of the parent", "Always for an entity with equity; the label is 'equity' where there is no parent."),
    { id: "smes.sfp.4_4", kind: "CLASSIFICATION", statement: "SFP", label: "Current and non-current assets and liabilities presented separately (unless a liquidity presentation is more relevant)",
      citations: c("4.4"), applicability: "ALWAYS", blocking: true },
    // Statement of comprehensive income: minimum line items (5.5) and the expense analysis (5.11).
    sci("a", "Revenue"),
    sci("b", "Finance costs", "The entity has finance costs."),
    sci("c", "Share of profit or loss of associates and jointly controlled entities (equity method)", "The entity applies the equity method."),
    sci("d", "Tax expense"),
    sci("e", "Single amount for discontinued operations", "The entity has a discontinued operation."),
    sci("f", "Profit or loss"),
    sci("g", "Each item of other comprehensive income, by nature and reclassification group", "The entity has items of other comprehensive income."),
    sci("h", "Share of other comprehensive income of associates and jointly controlled entities", "The entity applies the equity method and they have other comprehensive income."),
    sci("i", "Total comprehensive income"),
    { id: "smes.sci.5_11", kind: "CLASSIFICATION", statement: "SCI", label: "Analysis of expenses by nature or by function (cost of sales shown separately under function)",
      citations: c("5.11"), applicability: "ALWAYS", blocking: true },
    // Disclosures.
    { id: "smes.note.compliance", kind: "DISCLOSURE", statement: "NOTES", label: "Explicit and unreserved statement of compliance", citations: c("3.3"), applicability: "ALWAYS", blocking: true },
    { id: "smes.note.identification", kind: "DISCLOSURE", statement: "NOTES", label: "Entity name, reporting date and period, presentation currency and rounding level displayed", citations: c("3.23"), applicability: "ALWAYS", blocking: true },
    { id: "smes.note.policies", kind: "DISCLOSURE", statement: "NOTES", label: ed === "2015" ? "Summary of significant accounting policies (measurement bases and other relevant policies)" : "Material accounting policy information",
      citations: c("8.5"), applicability: "ALWAYS", blocking: true },
    { id: "smes.note.judgements", kind: "DISCLOSURE", statement: "NOTES", label: "Significant judgements in applying accounting policies", citations: c("8.6"), applicability: "ALWAYS", blocking: true },
    { id: "smes.note.estimates", kind: "DISCLOSURE", statement: "NOTES", label: "Key sources of estimation uncertainty", citations: c("8.7"), applicability: "ALWAYS", blocking: true },
    { id: "smes.note.subclassifications", kind: "DISCLOSURE", statement: "NOTES", label: "Subclassifications of PPE, receivables, inventories, payables, provisions and classes of equity", citations: c("4.11"),
      applicability: "ALWAYS", blocking: true },
    { id: "smes.note.share_capital", kind: "DISCLOSURE", statement: "NOTES", label: "Share capital: classes, numbers, par value and reconciliation of shares outstanding", citations: c("4.12"),
      applicability: "CONDITIONAL", condition: "The entity has share capital.", blocking: true },
    // Movement schedules: a reconciliation of the carrying amount at the beginning and end of the period. Applicable when
    // the line has a carrying amount at either date (decided from the composition, never assumed). Each cited paragraph
    // says the reconciliation need not be presented for prior periods.
    { id: "smes.schedule.ppe", kind: "SCHEDULE", statement: "NOTES", label: "Property, plant and equipment: reconciliation of the carrying amount", citations: c("17.31(e)"),
      applicability: "CONDITIONAL", condition: "The line has a carrying amount at either reporting date.", blocking: true },
    { id: "smes.schedule.investment_property_cost", kind: "SCHEDULE", statement: "NOTES", label: "Investment property at cost: reconciliation of the carrying amount", citations: c("17.31(e)"),
      applicability: "CONDITIONAL", condition: "The line has a carrying amount at either reporting date.", blocking: true },
    { id: "smes.schedule.investment_property_fair_value", kind: "SCHEDULE", statement: "NOTES", label: "Investment property at fair value: reconciliation of the carrying amount", citations: c("16.10(e)"),
      applicability: "CONDITIONAL", condition: "The line has a carrying amount at either reporting date.", blocking: true },
    { id: "smes.schedule.intangibles", kind: "SCHEDULE", statement: "NOTES", label: "Intangible assets: reconciliation of the carrying amount", citations: c("18.27(e)"),
      applicability: "CONDITIONAL", condition: "The line has a carrying amount at either reporting date.", blocking: true },
    { id: "smes.schedule.provisions", kind: "SCHEDULE", statement: "NOTES", label: "Provisions: reconciliation for each class", citations: c("21.14(a)"),
      applicability: "CONDITIONAL", condition: "The line has a carrying amount at either reporting date.", blocking: true },
    { id: "smes.note.early_application", kind: "DISCLOSURE", statement: "NOTES", label: "The fact of earlier application of the edition", citations: ed === "2015" ? c("A1") : [{ source: "ey-ifrs-developments-235", paragraph: "early application disclosure", verification: "SECONDARY" }],
      applicability: "CONDITIONAL", condition: "The edition is applied before its effective date (recorded early-application election).", blocking: true },
  ];
}

// Presentation lines a reviewed account may be mapped to. One line per 4.2 item (SFP) and per 5.5 amount the trial balance
// can carry (SCI); SCI totals (profit or loss, total comprehensive income) are computed, never mapped. Expense lines follow
// 5.11: cost of sales (function) or nature lines, never both for one report (composition enforces one basis).
function lines(): PresentationLine[] {
  const sfp = (id: string, letter: string, label: string, natures: PresentationLine["natures"], position: PresentationLine["position"]): PresentationLine =>
    ({ id: `sfp.${id}`, statement: "SFP", label, requirementId: `smes.sfp.4_2_${letter}`, natures, position });
  const sci = (id: string, req: string, label: string, natures: PresentationLine["natures"]): PresentationLine =>
    ({ id: `sci.${id}`, statement: "SCI", label, requirementId: req, natures });
  return [
    sfp("cash_and_cash_equivalents", "a", "Cash and cash equivalents", ["asset"], "current"),
    sfp("trade_and_other_receivables", "b", "Trade and other receivables", ["asset"], "either"),
    sfp("other_financial_assets", "c", "Other financial assets", ["asset"], "either"),
    sfp("inventories", "d", "Inventories", ["asset"], "current"),
    sfp("property_plant_and_equipment", "e", "Property, plant and equipment", ["asset"], "non_current"),
    sfp("investment_property_cost", "ea", "Investment property (cost model)", ["asset"], "non_current"),
    sfp("investment_property_fair_value", "f", "Investment property (fair value)", ["asset"], "non_current"),
    sfp("intangible_assets", "g", "Intangible assets", ["asset"], "non_current"),
    sfp("biological_assets_cost", "h", "Biological assets (cost model)", ["asset"], "either"),
    sfp("biological_assets_fair_value", "i", "Biological assets (fair value)", ["asset"], "either"),
    sfp("investments_in_associates", "j", "Investments in associates", ["asset"], "non_current"),
    sfp("investments_in_jointly_controlled_entities", "k", "Investments in jointly controlled entities", ["asset"], "non_current"),
    sfp("trade_and_other_payables", "l", "Trade and other payables", ["liability"], "either"),
    sfp("other_financial_liabilities", "m", "Borrowings and other financial liabilities", ["liability"], "either"),
    sfp("current_tax", "n", "Current tax", ["asset", "liability"], "current"),
    sfp("deferred_tax", "o", "Deferred tax", ["asset", "liability"], "fixed_non_current"),
    sfp("provisions", "p", "Provisions", ["liability"], "either"),
    sfp("non_controlling_interest", "q", "Non-controlling interest", ["equity"], "equity"),
    sfp("equity_attributable_to_owners", "r", "Equity attributable to owners", ["equity"], "equity"),
    sci("revenue", "smes.sci.5_5_a", "Revenue", ["income"]),
    sci("other_income", "smes.sci.5_11", "Other income", ["income"]),
    sci("cost_of_sales", "smes.sci.5_11", "Cost of sales", ["expense"]),
    sci("operating_expenses_by_function", "smes.sci.5_11", "Distribution, administrative and other expenses (by function)", ["expense"]),
    sci("employee_benefits_expense", "smes.sci.5_11", "Employee benefits expense (by nature)", ["expense"]),
    sci("depreciation_and_amortisation", "smes.sci.5_11", "Depreciation and amortisation (by nature)", ["expense"]),
    sci("other_expenses_by_nature", "smes.sci.5_11", "Other expenses (by nature)", ["expense"]),
    sci("finance_costs", "smes.sci.5_5_b", "Finance costs", ["expense"]),
    sci("share_of_associates", "smes.sci.5_5_c", "Share of profit or loss of associates", ["income", "expense"]),
    sci("tax_expense", "smes.sci.5_5_d", "Tax expense", ["expense", "income"]),
  ];
}

function schedules(): ScheduleDefinition[] {
  const ppe = [
    { kind: "additions", label: "Additions", sign: "increase" as const },
    { kind: "disposals", label: "Disposals", sign: "decrease" as const },
    { kind: "business_combinations", label: "Acquisitions through business combinations", sign: "increase" as const },
    { kind: "revaluations_and_oci_impairment", label: "Revaluations and impairment recognised or reversed in other comprehensive income", sign: "either" as const },
    { kind: "transfers_investment_property", label: "Transfers to and from investment property at fair value", sign: "either" as const },
    { kind: "impairment_profit_or_loss", label: "Impairment losses recognised or reversed in profit or loss", sign: "either" as const },
    { kind: "depreciation", label: "Depreciation", sign: "decrease" as const },
    { kind: "other", label: "Other changes", sign: "either" as const },
  ];
  return [
    { id: "ppe", requirementId: "smes.schedule.ppe", label: "Property, plant and equipment", lineIds: ["sfp.property_plant_and_equipment"], movements: ppe, priorPeriodRequired: false },
    { id: "investment_property_cost", requirementId: "smes.schedule.investment_property_cost", label: "Investment property (cost model)", lineIds: ["sfp.investment_property_cost"], movements: ppe, priorPeriodRequired: false },
    { id: "investment_property_fair_value", requirementId: "smes.schedule.investment_property_fair_value", label: "Investment property (fair value)", lineIds: ["sfp.investment_property_fair_value"],
      movements: [
        { kind: "additions", label: "Additions (other than through business combinations)", sign: "increase" },
        { kind: "business_combination_additions", label: "Additions through business combinations", sign: "increase" },
        { kind: "fair_value_gains_losses", label: "Net gains or losses from fair value adjustments", sign: "either" },
        { kind: "transfers_cost_model", label: "Transfers to and from investment property at cost", sign: "either" },
        { kind: "transfers_inventories_owner_occupied", label: "Transfers to and from inventories and owner-occupied property", sign: "either" },
        { kind: "other", label: "Other changes", sign: "either" },
      ], priorPeriodRequired: false },
    { id: "intangibles", requirementId: "smes.schedule.intangibles", label: "Intangible assets", lineIds: ["sfp.intangible_assets"],
      movements: [
        { kind: "additions", label: "Additions", sign: "increase" },
        { kind: "disposals", label: "Disposals", sign: "decrease" },
        { kind: "business_combinations", label: "Acquisitions through business combinations", sign: "increase" },
        { kind: "amortisation", label: "Amortisation", sign: "decrease" },
        { kind: "impairment", label: "Impairment losses", sign: "decrease" },
        { kind: "other", label: "Other changes", sign: "either" },
      ], priorPeriodRequired: false },
    { id: "provisions", requirementId: "smes.schedule.provisions", label: "Provisions", lineIds: ["sfp.provisions"],
      movements: [
        { kind: "additions", label: "Additions (including changes in the discounted amount)", sign: "increase" },
        { kind: "used", label: "Amounts charged against the provision", sign: "decrease" },
        { kind: "reversed", label: "Unused amounts reversed", sign: "decrease" },
      ], priorPeriodRequired: false },
  ];
}

// 1.1.0: movement schedules (17.31(e), 16.10(e), 18.27(e), 21.14(a)) added.
export const IFRS_FOR_SMES_PACK_VERSION = "1.1.0";
/** Version of the presentation-line vocabulary alone (fs_presentation_lines.lines_version); changes only when `lines()` changes. */
export const IFRS_FOR_SMES_LINES_VERSION = "1.0.0";

export const IFRS_FOR_SMES_2015: FrameworkPack = Object.freeze<FrameworkPack>({
  id: "ifrs-for-smes/2015",
  family: "IFRS_FOR_SMES",
  edition: {
    id: "2015",
    title: "IFRS for SMEs (2015 edition, incorporating the 2015 Amendments)",
    issued: "2015-05",
    effectiveForPeriodsBeginningOnOrAfter: "2017-01-01",
    earlyApplication: { permitted: true, disclosureRequired: true, citations: [T("2015", "A1")] },
    effectiveDateCitations: [T("2015", "A1")],
  },
  packVersion: IFRS_FOR_SMES_PACK_VERSION,
  requirements: requirements("2015"),
  lines: lines(),
  schedules: schedules(),
  comparatives: { required: true, minimumPeriods: 1, citations: [T("2015", "3.14"), T("2015", "3.20")] },
});

export const IFRS_FOR_SMES_2025: FrameworkPack = Object.freeze<FrameworkPack>({
  id: "ifrs-for-smes/2025",
  family: "IFRS_FOR_SMES",
  edition: {
    id: "2025",
    title: "IFRS for SMEs Accounting Standard, third edition (2025)",
    issued: "2025-02",
    effectiveForPeriodsBeginningOnOrAfter: "2027-01-01",
    earlyApplication: { permitted: true, disclosureRequired: true,
      citations: [{ source: "smes-2025-supporting", paragraph: "effective date", verification: "PRIMARY_SUMMARY" }, { source: "ey-ifrs-developments-235", paragraph: "early application disclosure", verification: "SECONDARY" }] },
    effectiveDateCitations: [{ source: "smes-2025-supporting", paragraph: "effective date", verification: "PRIMARY_SUMMARY" }],
  },
  packVersion: IFRS_FOR_SMES_PACK_VERSION,
  requirements: requirements("2025"),
  lines: lines(),
  schedules: schedules(),
  comparatives: { required: true, minimumPeriods: 1, citations: [T("2025", "3.14")] },
});

export const IFRS_FOR_SMES_PACKS: readonly FrameworkPack[] = Object.freeze([IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025]);
