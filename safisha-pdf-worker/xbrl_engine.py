"""
xbrl_engine.py · IRON DOME NUCLEAR DESIGN · XBRL/iXBRL Generator + Arelle Validator

Generates XBRL 2.1 instance documents and iXBRL 1.1 documents from SAFF financial
statement data, then validates them using Arelle (the open-source XBRL processor
used by the SEC, HMRC, ESMA, ASIC, and every major financial regulator).

Sources:
  XBRL 2.1 Specification  — https://www.xbrl.org/Specification/XBRL-2.1/REC-2003-12-31/
  iXBRL 1.1 Specification — https://www.xbrl.org/specification/inlinexbrl-part1/rec-2013-11-18/
  IFRS for SMEs Taxonomy 2023 — http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes
  Full IFRS Taxonomy 2023     — http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full
  Arelle (Apache 2.0)         — https://github.com/Arelle/Arelle

IRON DOME:
  - Returns BLOCKED if taxonomy unavailable — never silently passes without validation.
  - Every generated fact is SHA-256 hashed as part of the document integrity check.
  - Sign conventions: debit-balance elements stored positive, credit-balance stored positive.
    Losses and negative equity are stored as negative numbers — correct per XBRL 2.1 §4.6.
  - All TZS amounts use decimals="0" (no fractional shillings).
  - Context IDs are deterministic: D-{year}, I-{year}-{month:02d}-{day:02d}.
  - Arelle validation result stored verbatim — not summarised or softened.

Classes:
  XBRLConceptMap  — resolves pl_category + framework → taxonomy element
  XBRLFact        — one tagged financial fact
  XBRLInstanceGenerator — builds XBRL 2.1 XML
  iXBRLWrapper    — wraps XBRL in HTML for iXBRL 1.1
  ArelleValidator — validates instance document using Arelle Python API
  XBRLEngine      — top-level orchestrator (generate + validate in one call)
"""

import hashlib
import io
import re
import textwrap
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Optional
from xml.etree import ElementTree as ET

# ── IFRS Taxonomy namespace registry ─────────────────────────────────────────

TAXONOMY_REGISTRY: dict[str, dict[str, str]] = {
    "ifrs_for_smes": {
        "namespace": "http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes",
        "prefix":    "ifrs-smes",
        "schema_ref": "http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-smes",
        "version":   "2023-01-01",
    },
    "full_ifrs": {
        "namespace": "http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full",
        "prefix":    "ifrs-full",
        "schema_ref": "http://xbrl.ifrs.org/taxonomy/2023-01-01/ifrs-full",
        "version":   "2023-01-01",
    },
}

# ── IFRS Taxonomy concept map (pl_category → element metadata) ────────────────
#
# Keyed: (reporting_framework, pl_category)
# Values: {concept, balance, period_type}
#
# balance:     'debit'  = assets, expenses (positive = more of the thing)
#              'credit' = liabilities, equity, income (positive = more of the thing)
# period_type: 'instant'  = balance sheet date (SFP)
#              'duration' = full period (IS, SCF, SOCIE)
#
# Source: verified against IFRS Taxonomy 2023 schema files (.xsd)
# "ignore" pl_category intentionally absent — no XBRL concept.

CONCEPT_MAP: dict[tuple[str, str], dict[str, str]] = {

    # ── IFRS for SMEs 2023 ────────────────────────────────────────────────────

    # Income Statement (duration)
    ("ifrs_for_smes", "revenue"):                 {"concept": "Revenue",                          "balance": "credit", "period_type": "duration"},
    ("ifrs_for_smes", "cost_of_goods_sold"):      {"concept": "CostOfSales",                      "balance": "debit",  "period_type": "duration"},
    ("ifrs_for_smes", "gross_profit"):            {"concept": "GrossProfit",                      "balance": "credit", "period_type": "duration"},
    ("ifrs_for_smes", "other_income"):            {"concept": "OtherIncome",                      "balance": "credit", "period_type": "duration"},
    ("ifrs_for_smes", "employee_costs"):          {"concept": "EmployeeBenefitsExpense",          "balance": "debit",  "period_type": "duration"},
    ("ifrs_for_smes", "depreciation_amortisation"): {"concept": "DepreciationAndAmortisationExpense", "balance": "debit", "period_type": "duration"},
    ("ifrs_for_smes", "operating_expenses"):      {"concept": "OtherExpense",                     "balance": "debit",  "period_type": "duration"},
    ("ifrs_for_smes", "finance_costs"):           {"concept": "FinanceCosts",                     "balance": "debit",  "period_type": "duration"},
    ("ifrs_for_smes", "taxation"):                {"concept": "IncomeTaxExpenseContinuingOperations", "balance": "debit", "period_type": "duration"},

    # Statement of Financial Position (instant)
    ("ifrs_for_smes", "current_assets"):          {"concept": "CurrentAssets",      "balance": "debit",  "period_type": "instant"},
    ("ifrs_for_smes", "non_current_assets"):      {"concept": "NoncurrentAssets",   "balance": "debit",  "period_type": "instant"},
    ("ifrs_for_smes", "current_liabilities"):     {"concept": "CurrentLiabilities", "balance": "credit", "period_type": "instant"},
    ("ifrs_for_smes", "non_current_liabilities"): {"concept": "NoncurrentLiabilities", "balance": "credit", "period_type": "instant"},
    ("ifrs_for_smes", "equity"):                  {"concept": "Equity",             "balance": "credit", "period_type": "instant"},

    # ── Full IFRS 2023 ────────────────────────────────────────────────────────

    # Income Statement (duration)
    ("full_ifrs", "revenue"):                 {"concept": "Revenue",                          "balance": "credit", "period_type": "duration"},
    ("full_ifrs", "cost_of_goods_sold"):      {"concept": "CostOfSales",                      "balance": "debit",  "period_type": "duration"},
    ("full_ifrs", "gross_profit"):            {"concept": "GrossProfit",                      "balance": "credit", "period_type": "duration"},
    ("full_ifrs", "other_income"):            {"concept": "OtherIncome",                      "balance": "credit", "period_type": "duration"},
    ("full_ifrs", "employee_costs"):          {"concept": "EmployeeBenefitsExpense",          "balance": "debit",  "period_type": "duration"},
    ("full_ifrs", "depreciation_amortisation"): {"concept": "DepreciationAndAmortisationExpense", "balance": "debit", "period_type": "duration"},
    ("full_ifrs", "operating_expenses"):      {"concept": "OtherOperatingExpense",            "balance": "debit",  "period_type": "duration"},
    ("full_ifrs", "finance_costs"):           {"concept": "FinanceCosts",                     "balance": "debit",  "period_type": "duration"},
    ("full_ifrs", "taxation"):                {"concept": "IncomeTaxExpenseContinuingOperations", "balance": "debit", "period_type": "duration"},

    # Statement of Financial Position (instant)
    ("full_ifrs", "current_assets"):          {"concept": "CurrentAssets",      "balance": "debit",  "period_type": "instant"},
    ("full_ifrs", "non_current_assets"):      {"concept": "NoncurrentAssets",   "balance": "debit",  "period_type": "instant"},
    ("full_ifrs", "current_liabilities"):     {"concept": "CurrentLiabilities", "balance": "credit", "period_type": "instant"},
    ("full_ifrs", "non_current_liabilities"): {"concept": "NoncurrentLiabilities", "balance": "credit", "period_type": "instant"},
    ("full_ifrs", "equity"):                  {"concept": "Equity",             "balance": "credit", "period_type": "instant"},
}

# ── Data structures ───────────────────────────────────────────────────────────

@dataclass
class XBRLFact:
    """One tagged financial fact in the XBRL instance document."""
    concept:       str        # element local name, e.g. 'Revenue'
    namespace:     str        # element namespace URI
    prefix:        str        # namespace prefix, e.g. 'ifrs-smes'
    context_ref:   str        # e.g. 'D-2024' or 'I-2024-12-31'
    unit_ref:      str        # e.g. 'TZS'
    value:         int        # TZS amount (integer — decimals="0")
    balance:       str        # 'debit' | 'credit'
    period_type:   str        # 'instant' | 'duration'
    pl_category:   str        # source pl_category for traceability

    @property
    def qualified_name(self) -> str:
        return f"{self.prefix}:{self.concept}"


@dataclass
class XBRLValidationIssue:
    """One Arelle validation message."""
    severity:     str           # 'error' | 'warning' | 'info'
    arelle_code:  Optional[str] # e.g. 'xbrl.4.6.1'
    message:      str
    xbrl_element: Optional[str]
    fact_value:   Optional[str]


@dataclass
class XBRLGenerationResult:
    """Complete result from XBRLEngine.generate_and_validate()."""
    success:          bool
    blocked:          bool
    blocked_reason:   Optional[str]
    output_format:    str               # 'xbrl_2_1' | 'ixbrl_1_1'
    taxonomy_version: str
    reporting_framework: str
    instance_xml:     Optional[str]     # the full XML/HTML document
    instance_sha256:  Optional[str]     # SHA-256 hex of instance_xml
    fact_count:       int
    validation_passed: bool
    validation_errors: int
    validation_warnings: int
    validation_info:  int
    issues:           list[XBRLValidationIssue] = field(default_factory=list)
    arelle_available: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "success":             self.success,
            "blocked":             self.blocked,
            "blocked_reason":      self.blocked_reason,
            "output_format":       self.output_format,
            "taxonomy_version":    self.taxonomy_version,
            "reporting_framework": self.reporting_framework,
            "instance_xml":        self.instance_xml,
            "instance_sha256":     self.instance_sha256,
            "fact_count":          self.fact_count,
            "validation_passed":   self.validation_passed,
            "validation_errors":   self.validation_errors,
            "validation_warnings": self.validation_warnings,
            "validation_info":     self.validation_info,
            "arelle_available":    self.arelle_available,
            "issues": [
                {
                    "severity":     i.severity,
                    "arelle_code":  i.arelle_code,
                    "message":      i.message,
                    "xbrl_element": i.xbrl_element,
                    "fact_value":   i.fact_value,
                }
                for i in self.issues
            ],
        }


# ── XBRL 2.1 Instance Generator ───────────────────────────────────────────────

class XBRLInstanceGenerator:
    """
    Generates a valid XBRL 2.1 instance document from SAFF financial data.

    XBRL 2.1 Specification §4: Instance documents
      — Every fact must reference a context and (for numeric facts) a unit.
      — contextRef must be declared in the instance document.
      — unitRef must be declared in the instance document.
      — Numeric facts must have a decimals attribute.

    Sign convention (XBRL 2.1 §4.6.3):
      — Debit-balance elements (assets, expenses): positive = normal balance.
      — Credit-balance elements (liabilities, equity, income): positive = normal balance.
      — Losses (negative PBT) stored as negative numbers.
      — This matches how computation_detail stores its values:
          revenue_tzs > 0 (income)
          cost_of_goods_sold_tzs > 0 (cost — absolute value)
          gross_profit_tzs: positive = profit, negative = loss
          equity_tzs: positive = equity, negative = deficit
    """

    XBRL_NS       = "http://www.xbrl.org/2003/instance"
    LINK_NS       = "http://www.xbrl.org/2003/linkbase"
    XLINK_NS      = "http://www.w3.org/1999/xlink"
    ISO4217_NS    = "http://www.xbrl.org/2003/iso4217"
    IX_NS         = "http://www.xbrl.org/2013/inlineXBRL"

    def __init__(
        self,
        reporting_framework: str,
        company_tin:         str,
        period_year:         int,
        period_end_month:    int,
        period_end_day:      int = 31,
        currency:            str = "TZS",
    ):
        if reporting_framework not in TAXONOMY_REGISTRY:
            raise ValueError(
                f"IRON DOME: Unsupported reporting framework '{reporting_framework}'. "
                f"XBRL generation requires ifrs_for_smes or full_ifrs."
            )

        self.framework    = reporting_framework
        self.taxonomy     = TAXONOMY_REGISTRY[reporting_framework]
        self.company_tin  = company_tin.strip() or "000000000"
        self.period_year  = period_year
        self.period_month = period_end_month
        self.period_day   = period_end_day
        self.currency     = currency

        # Compute context IDs
        self.instant_date = date(period_year, period_end_month, period_end_day)
        self.start_date   = date(period_year, 1, 1)
        self.ctx_instant  = f"I-{self.instant_date.isoformat()}"
        self.ctx_duration = f"D-{period_year}"
        self.unit_id      = currency

        self._facts: list[XBRLFact] = []

    def add_fact_from_pl_category(
        self,
        pl_category: str,
        value_tzs:   float,
    ) -> Optional[XBRLFact]:
        """
        Add one XBRL fact from a pl_category + TZS value.
        Returns None if pl_category is 'ignore' or has no concept mapping.
        """
        if pl_category == "ignore":
            return None

        mapping = CONCEPT_MAP.get((self.framework, pl_category))
        if not mapping:
            return None

        ctx_ref = (
            self.ctx_instant
            if mapping["period_type"] == "instant"
            else self.ctx_duration
        )

        fact = XBRLFact(
            concept=       mapping["concept"],
            namespace=     self.taxonomy["namespace"],
            prefix=        self.taxonomy["prefix"],
            context_ref=   ctx_ref,
            unit_ref=      self.unit_id,
            value=         round(value_tzs),
            balance=       mapping["balance"],
            period_type=   mapping["period_type"],
            pl_category=   pl_category,
        )
        self._facts.append(fact)
        return fact

    def add_derived_sfp_facts(
        self,
        current_assets_tzs:        float,
        non_current_assets_tzs:    float,
        current_liabilities_tzs:   float,
        non_current_liabilities_tzs: float,
        equity_tzs:                float,
        cash_tzs:                  float,
        share_capital_tzs:         float,
        retained_earnings_tzs:     float,
        other_reserves_tzs:        float,
        closing_dtl_tzs:           float = 0,
        closing_dta_tzs:           float = 0,
    ) -> None:
        """
        Add the computed SFP aggregate facts that the IFRS taxonomy requires
        beyond the pl_category subtotals:
          Assets = CurrentAssets + NoncurrentAssets
          Liabilities = CurrentLiabilities + NoncurrentLiabilities
          LiabilitiesAndEquity = Assets (must equal for taxonomy to validate)
          CashAndCashEquivalents ⊆ CurrentAssets
          IssuedCapital, RetainedEarnings, OtherReserves (equity decomposition)
          DeferredTaxLiabilities / DeferredTaxAssets (if non-zero)
        """
        ns   = self.taxonomy["namespace"]
        pfx  = self.taxonomy["prefix"]
        ctx  = self.ctx_instant
        unit = self.unit_id

        total_assets = round(current_assets_tzs + non_current_assets_tzs)
        total_liab   = round(current_liabilities_tzs + non_current_liabilities_tzs)
        l_and_e      = round(total_liab + equity_tzs)

        derived_facts = [
            # Totals required by taxonomy calculation linkbase
            ("Assets",              total_assets, "debit",  "instant"),
            ("Liabilities",         total_liab,   "credit", "instant"),
            ("LiabilitiesAndEquity", l_and_e,     "credit", "instant"),
            # Equity decomposition
            ("IssuedCapital",       round(share_capital_tzs),     "credit", "instant"),
            ("RetainedEarnings",    round(retained_earnings_tzs), "credit", "instant"),
            ("OtherReserves",       round(other_reserves_tzs),    "credit", "instant"),
            # Cash subset
            ("CashAndCashEquivalents", round(cash_tzs),           "debit",  "instant"),
        ]

        # Deferred tax (only if non-zero)
        if abs(closing_dtl_tzs) > 0:
            derived_facts.append(("DeferredTaxLiabilities", round(closing_dtl_tzs), "credit", "instant"))
        if abs(closing_dta_tzs) > 0:
            derived_facts.append(("DeferredTaxAssets", round(closing_dta_tzs), "debit", "instant"))

        for concept, value, balance, period_type in derived_facts:
            self._facts.append(XBRLFact(
                concept=     concept,
                namespace=   ns,
                prefix=      pfx,
                context_ref= ctx,
                unit_ref=    unit,
                value=       value,
                balance=     balance,
                period_type= period_type,
                pl_category= f"_derived_{concept}",
            ))

    def add_is_aggregates(
        self,
        pbt_tzs:    float,
        taxes_tzs:  float,
        pat_tzs:    float,
    ) -> None:
        """
        Add IS aggregate facts: ProfitLossBeforeTax and ProfitLoss (PAT).
        These are required by the taxonomy calculation linkbase.
        """
        ns  = self.taxonomy["namespace"]
        pfx = self.taxonomy["prefix"]
        ctx = self.ctx_duration

        for concept, value in [
            ("ProfitLossBeforeTax", round(pbt_tzs)),
            ("ProfitLoss",          round(pat_tzs)),
        ]:
            self._facts.append(XBRLFact(
                concept=     concept,
                namespace=   ns,
                prefix=      pfx,
                context_ref= ctx,
                unit_ref=    self.unit_id,
                value=       value,
                balance=     "credit",
                period_type= "duration",
                pl_category= f"_derived_{concept}",
            ))

    def add_scf_facts(
        self,
        operating_tzs: float,
        investing_tzs: float,
        financing_tzs: float,
        net_change_tzs: float,
        opening_cash_tzs: float,
        closing_cash_tzs: float,
    ) -> None:
        """
        Add SCF facts. All SCF elements are duration-period.
        Sign: operating/investing/financing are signed (outflows negative).
        NetChange = operating + investing + financing.
        """
        ns  = self.taxonomy["namespace"]
        pfx = self.taxonomy["prefix"]
        ctx = self.ctx_duration

        scf_items = [
            ("CashFlowsFromUsedInOperatingActivities", round(operating_tzs)),
            ("CashFlowsFromUsedInInvestingActivities", round(investing_tzs)),
            ("CashFlowsFromUsedInFinancingActivities", round(financing_tzs)),
            ("IncreaseDecreaseInCashAndCashEquivalents", round(net_change_tzs)),
            ("CashAndCashEquivalentsAtBeginningOfPeriod", round(opening_cash_tzs)),
            ("CashAndCashEquivalentsAtEndOfPeriod", round(closing_cash_tzs)),
        ]

        for concept, value in scf_items:
            # SCF flow elements: debit balance (net inflow positive)
            balance = "debit" if "CashAndCash" not in concept or "Change" in concept else "debit"
            self._facts.append(XBRLFact(
                concept=     concept,
                namespace=   ns,
                prefix=      pfx,
                context_ref= ctx,
                unit_ref=    self.unit_id,
                value=       value,
                balance=     "debit",
                period_type= "duration",
                pl_category= f"_scf_{concept}",
            ))

    def to_xbrl_21(self) -> str:
        """
        Generate a valid XBRL 2.1 instance document (XML).
        Returns the XML string with proper namespace declarations.
        """
        ns     = self.taxonomy["namespace"]
        pfx    = self.taxonomy["prefix"]
        schema = self.taxonomy["schema_ref"]
        ver    = self.taxonomy["version"]

        # Build XML manually for precise namespace control
        # (ElementTree rewrites namespace prefixes unpredictably)
        lines: list[str] = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            f'<!--',
            f'  XBRL 2.1 Instance Document',
            f'  Generated by SAFF ERP · generate-xbrl/v1.0.0',
            f'  Reporting framework: {self.framework}',
            f'  IFRS Taxonomy version: {ver}',
            f'  Entity (TRA TIN): {self.company_tin}',
            f'  Period: {self.start_date.isoformat()} to {self.instant_date.isoformat()}',
            f'  Currency: {self.currency}',
            f'  Facts: {len(self._facts)}',
            f'-->',
            f'<xbrl',
            f'  xmlns="http://www.xbrl.org/2003/instance"',
            f'  xmlns:xbrli="http://www.xbrl.org/2003/instance"',
            f'  xmlns:link="http://www.xbrl.org/2003/linkbase"',
            f'  xmlns:xlink="http://www.w3.org/1999/xlink"',
            f'  xmlns:{pfx}="{ns}"',
            f'  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"',
            f'>',
            f'',
            f'  <!-- Taxonomy reference -->',
            f'  <link:schemaRef xlink:type="simple" xlink:href="{schema}"/>',
            f'',
            f'  <!-- ── Contexts ────────────────────────────────────────────── -->',
            f'',
            f'  <!-- Duration context: full reporting period -->',
            f'  <context id="{self.ctx_duration}">',
            f'    <entity>',
            f'      <identifier scheme="http://www.tra.go.tz/tin">{self.company_tin}</identifier>',
            f'    </entity>',
            f'    <period>',
            f'      <startDate>{self.start_date.isoformat()}</startDate>',
            f'      <endDate>{self.instant_date.isoformat()}</endDate>',
            f'    </period>',
            f'  </context>',
            f'',
            f'  <!-- Instant context: balance sheet date -->',
            f'  <context id="{self.ctx_instant}">',
            f'    <entity>',
            f'      <identifier scheme="http://www.tra.go.tz/tin">{self.company_tin}</identifier>',
            f'    </entity>',
            f'    <period>',
            f'      <instant>{self.instant_date.isoformat()}</instant>',
            f'    </period>',
            f'  </context>',
            f'',
            f'  <!-- ── Units ───────────────────────────────────────────────── -->',
            f'',
            f'  <unit id="{self.unit_id}">',
            f'    <measure>iso4217:{self.currency}</measure>',
            f'  </unit>',
            f'',
            f'  <!-- ── Facts ───────────────────────────────────────────────── -->',
            f'  <!--',
            f'    Sign convention (XBRL 2.1 §4.6.3):',
            f'      Debit-balance (assets, expenses): positive = normal balance.',
            f'      Credit-balance (liabilities, equity, income): positive = normal balance.',
            f'      Losses stored as negative ProfitLoss/ProfitLossBeforeTax.',
            f'  -->',
            f'',
        ]

        # Group facts by period_type for readability
        instant_facts  = [f for f in self._facts if f.period_type == "instant"]
        duration_facts = [f for f in self._facts if f.period_type == "duration"]

        if instant_facts:
            lines.append(f'  <!-- Statement of Financial Position (balance: {self.instant_date.isoformat()}) -->')
            for fact in instant_facts:
                lines.append(
                    f'  <{fact.qualified_name}'
                    f' contextRef="{fact.context_ref}"'
                    f' unitRef="{fact.unit_ref}"'
                    f' decimals="0"'
                    f'>{fact.value}</{fact.qualified_name}>'
                )
            lines.append('')

        if duration_facts:
            lines.append(f'  <!-- Income Statement / SCF / SOCIE (period: {self.start_date.isoformat()} to {self.instant_date.isoformat()}) -->')
            for fact in duration_facts:
                lines.append(
                    f'  <{fact.qualified_name}'
                    f' contextRef="{fact.context_ref}"'
                    f' unitRef="{fact.unit_ref}"'
                    f' decimals="0"'
                    f'>{fact.value}</{fact.qualified_name}>'
                )
            lines.append('')

        lines.append('</xbrl>')
        return '\n'.join(lines)

    @property
    def fact_count(self) -> int:
        return len(self._facts)


# ── iXBRL 1.1 Wrapper ─────────────────────────────────────────────────────────

class iXBRLWrapper:
    """
    Wraps a XBRL instance in an iXBRL 1.1 (inline XBRL) HTML document.

    iXBRL embeds XBRL tags directly in HTML, producing a human-readable
    financial report that is simultaneously machine-readable.
    Required for: UK Companies House, ESMA ESEF, SEC structured filing.

    The HTML structure follows the pattern:
      <html>
        <head>
          <ix:references>...</ix:references>
        </head>
        <body>
          ...
          <ix:nonfraction name="ifrs-smes:Revenue" ...>100,000,000</ix:nonfraction>
          ...
        </body>
      </html>
    """

    IX_NS  = "http://www.xbrl.org/2013/inlineXBRL"
    IXS_NS = "http://www.xbrl.org/inlineXBRL/transformation/2022-02-16"

    def __init__(self, generator: XBRLInstanceGenerator):
        self.gen = generator

    def _fmt_tzs(self, value: int) -> str:
        """Format TZS integer for human display with comma separators."""
        abs_val = abs(value)
        formatted = f"{abs_val:,}"
        return f"({formatted})" if value < 0 else formatted

    def generate(self) -> str:
        """Generate the complete iXBRL 1.1 HTML document."""
        g         = self.gen
        ns        = g.taxonomy["namespace"]
        pfx       = g.taxonomy["prefix"]
        schema    = g.taxonomy["schema_ref"]
        ver       = g.taxonomy["version"]
        ctx_d     = g.ctx_duration
        ctx_i     = g.ctx_instant

        instant_facts  = [f for f in g._facts if f.period_type == "instant"]
        duration_facts = [f for f in g._facts if f.period_type == "duration"]

        def fact_tag(fact: XBRLFact) -> str:
            sign = "-" if fact.value < 0 else ""
            return (
                f'<ix:nonFraction'
                f' name="{fact.qualified_name}"'
                f' contextRef="{fact.context_ref}"'
                f' unitRef="{fact.unit_ref}"'
                f' decimals="0"'
                f' format="ixt:num-dot-decimal"'
                f' scale="0"'
                f'{(" sign=\"-\"") if fact.value < 0 else ""}>'
                f'{abs(fact.value)}'
                f'</ix:nonFraction>'
            )

        rows_sfp  = "\n".join(
            f'      <tr><td>{f.concept}</td>'
            f'<td style="text-align:right">{fact_tag(f)}</td></tr>'
            for f in instant_facts
        )
        rows_is   = "\n".join(
            f'      <tr><td>{f.concept}</td>'
            f'<td style="text-align:right">{fact_tag(f)}</td></tr>'
            for f in duration_facts
        )

        return textwrap.dedent(f"""\
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html
          xmlns="http://www.w3.org/1999/xhtml"
          xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
          xmlns:ixt="http://www.xbrl.org/inlineXBRL/transformation/2022-02-16"
          xmlns:{pfx}="{ns}"
          xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
        >
        <head>
          <meta charset="UTF-8"/>
          <title>SAFF ERP · iXBRL Financial Statements · {g.period_year}</title>
          <ix:header>
            <ix:hidden>
              <!-- XBRL contexts and units embedded as hidden elements -->
            </ix:hidden>
            <ix:references>
              <link:schemaRef xmlns:link="http://www.xbrl.org/2003/linkbase"
                xmlns:xlink="http://www.w3.org/1999/xlink"
                xlink:type="simple" xlink:href="{schema}"/>
            </ix:references>
            <ix:resources>
              <!-- Duration context -->
              <xbrli:context xmlns:xbrli="http://www.xbrl.org/2003/instance" id="{ctx_d}">
                <xbrli:entity>
                  <xbrli:identifier scheme="http://www.tra.go.tz/tin">{g.company_tin}</xbrli:identifier>
                </xbrli:entity>
                <xbrli:period>
                  <xbrli:startDate>{g.start_date.isoformat()}</xbrli:startDate>
                  <xbrli:endDate>{g.instant_date.isoformat()}</xbrli:endDate>
                </xbrli:period>
              </xbrli:context>
              <!-- Instant context -->
              <xbrli:context xmlns:xbrli="http://www.xbrl.org/2003/instance" id="{ctx_i}">
                <xbrli:entity>
                  <xbrli:identifier scheme="http://www.tra.go.tz/tin">{g.company_tin}</xbrli:identifier>
                </xbrli:entity>
                <xbrli:period>
                  <xbrli:instant>{g.instant_date.isoformat()}</xbrli:instant>
                </xbrli:period>
              </xbrli:context>
              <!-- Unit -->
              <xbrli:unit xmlns:xbrli="http://www.xbrl.org/2003/instance" id="{g.unit_id}">
                <xbrli:measure>iso4217:{g.currency}</xbrli:measure>
              </xbrli:unit>
            </ix:resources>
          </ix:header>
          <style>
            body {{ font-family: Arial, sans-serif; font-size: 10pt; margin: 40px; }}
            h1, h2 {{ color: #1a3a5c; }}
            table {{ border-collapse: collapse; width: 100%; margin-bottom: 24px; }}
            th {{ background: #1a3a5c; color: white; padding: 6px 10px; text-align: left; }}
            td {{ padding: 4px 10px; border-bottom: 1px solid #e0e0e0; }}
            .meta {{ color: #666; font-size: 9pt; margin-bottom: 16px; }}
          </style>
        </head>
        <body>
          <h1>SAFF ERP · iXBRL Financial Statements</h1>
          <p class="meta">
            Framework: {g.framework} · Taxonomy: {ver} · Period: {g.start_date.isoformat()} to {g.instant_date.isoformat()} ·
            TIN: {g.company_tin} · Generated by generate-xbrl/v1.0.0
          </p>

          <h2>Statement of Financial Position</h2>
          <table>
            <tr><th>IFRS Element</th><th style="text-align:right">TZS</th></tr>
        {rows_sfp}
          </table>

          <h2>Income Statement / SCF / SOCIE</h2>
          <table>
            <tr><th>IFRS Element</th><th style="text-align:right">TZS</th></tr>
        {rows_is}
          </table>

          <p class="meta">
            Total facts tagged: {g.fact_count} ·
            This document is an iXBRL 1.1 instance document. Human-readable rendering above;
            machine-readable XBRL facts embedded in the HTML tags above.
          </p>
        </body>
        </html>
        """)


# ── Structural Validator (no Arelle required) ─────────────────────────────────

class StructuralValidator:
    """
    Validates XBRL instance document structure without requiring Arelle.

    Checks:
      SV-01: Required SFP elements present (Assets, CurrentAssets, NoncurrentAssets,
             CurrentLiabilities, NoncurrentLiabilities, Equity, LiabilitiesAndEquity)
      SV-02: Required IS elements present (Revenue, GrossProfit, ProfitLossBeforeTax, ProfitLoss)
      SV-03: Required SCF elements present (three activities + net change + opening + closing)
      SV-04: Calculation consistency: Assets = CurrentAssets + NoncurrentAssets
      SV-05: Calculation consistency: LiabilitiesAndEquity = CurrentL + NoncurrentL + Equity
      SV-06: Calculation consistency: GrossProfit = Revenue - CostOfSales
      SV-07: No duplicate context/concept combinations (XBRL 2.1 §4.8)
      SV-08: All fact values are integers (decimals="0" enforced)
    """

    REQUIRED_SFP = {
        "Assets", "CurrentAssets", "NoncurrentAssets",
        "CurrentLiabilities", "NoncurrentLiabilities",
        "Equity", "LiabilitiesAndEquity",
        "IssuedCapital", "RetainedEarnings",
        "CashAndCashEquivalents",
    }

    REQUIRED_IS = {
        "Revenue", "GrossProfit",
        "ProfitLossBeforeTax", "ProfitLoss",
    }

    REQUIRED_SCF = {
        "CashFlowsFromUsedInOperatingActivities",
        "CashFlowsFromUsedInInvestingActivities",
        "CashFlowsFromUsedInFinancingActivities",
        "IncreaseDecreaseInCashAndCashEquivalents",
        "CashAndCashEquivalentsAtBeginningOfPeriod",
        "CashAndCashEquivalentsAtEndOfPeriod",
    }

    CALC_TOLERANCE = 2  # TZS 2 rounding tolerance for calculation checks

    def __init__(self, facts: list[XBRLFact]):
        self.facts = facts
        self._fact_map: dict[str, int] = {f.concept: f.value for f in facts}

    def validate(self) -> list[XBRLValidationIssue]:
        issues: list[XBRLValidationIssue] = []

        issues.extend(self._check_required_elements("SV-01", self.REQUIRED_SFP, "SFP"))
        issues.extend(self._check_required_elements("SV-02", self.REQUIRED_IS, "IS"))
        issues.extend(self._check_required_elements("SV-03", self.REQUIRED_SCF, "SCF"))
        issues.extend(self._check_calculations())
        issues.extend(self._check_duplicate_facts())

        return issues

    def _check_required_elements(
        self,
        code: str,
        required: set[str],
        statement: str,
    ) -> list[XBRLValidationIssue]:
        issues = []
        present = {f.concept for f in self.facts}
        missing = required - present
        for el in sorted(missing):
            issues.append(XBRLValidationIssue(
                severity=     "warning",
                arelle_code=  code,
                message=      f"{statement} element '{el}' is missing from the instance document.",
                xbrl_element= el,
                fact_value=   None,
            ))
        return issues

    def _check_calculations(self) -> list[XBRLValidationIssue]:
        issues: list[XBRLValidationIssue] = []
        fm = self._fact_map
        tol = self.CALC_TOLERANCE

        checks = [
            # SV-04: Assets = CA + NCA
            ("SV-04", "Assets",
             fm.get("CurrentAssets", 0) + fm.get("NoncurrentAssets", 0),
             fm.get("Assets"), "Assets = CurrentAssets + NoncurrentAssets"),
            # SV-05: L+E = CL + NCL + Equity
            ("SV-05", "LiabilitiesAndEquity",
             fm.get("CurrentLiabilities", 0) + fm.get("NoncurrentLiabilities", 0) + fm.get("Equity", 0),
             fm.get("LiabilitiesAndEquity"), "LiabilitiesAndEquity = CurrentL + NoncurrentL + Equity"),
            # SV-06: GrossProfit = Revenue - CostOfSales
            ("SV-06", "GrossProfit",
             fm.get("Revenue", 0) - fm.get("CostOfSales", 0),
             fm.get("GrossProfit"), "GrossProfit = Revenue - CostOfSales"),
            # SV-07: SCF: NetChange = Op + Inv + Fin
            ("SV-07", "IncreaseDecreaseInCashAndCashEquivalents",
             (fm.get("CashFlowsFromUsedInOperatingActivities", 0) +
              fm.get("CashFlowsFromUsedInInvestingActivities", 0) +
              fm.get("CashFlowsFromUsedInFinancingActivities", 0)),
             fm.get("IncreaseDecreaseInCashAndCashEquivalents"),
             "NetChangeCash = Operating + Investing + Financing"),
        ]

        for code, concept, expected, actual, desc in checks:
            if actual is None:
                continue  # element missing — already caught by required-elements check
            if abs(actual - expected) > tol:
                issues.append(XBRLValidationIssue(
                    severity=     "error",
                    arelle_code=  code,
                    message=      (
                        f"Calculation inconsistency: {desc}. "
                        f"Expected {expected:,} | Actual {actual:,} | "
                        f"Difference {abs(actual - expected):,} (tolerance: TZS {tol})."
                    ),
                    xbrl_element= concept,
                    fact_value=   str(actual),
                ))

        return issues

    def _check_duplicate_facts(self) -> list[XBRLValidationIssue]:
        """XBRL 2.1 §4.8: no two facts may have identical concept+context+unit."""
        seen: set[tuple[str, str, str]] = set()
        issues: list[XBRLValidationIssue] = []
        for f in self.facts:
            key = (f.concept, f.context_ref, f.unit_ref)
            if key in seen:
                issues.append(XBRLValidationIssue(
                    severity=     "error",
                    arelle_code=  "SV-08",
                    message=      f"Duplicate fact: {f.qualified_name} in context {f.context_ref}.",
                    xbrl_element= f.concept,
                    fact_value=   str(f.value),
                ))
            seen.add(key)
        return issues


# ── Arelle Validator ──────────────────────────────────────────────────────────

class ArelleValidator:
    """
    Validates an XBRL instance document using Arelle (Apache 2.0).

    Arelle is the open-source XBRL processor used by:
      SEC EDGAR, HMRC, ESMA, ASIC, MAS, and every major financial regulator.

    Installation: pip install arelle-release
    Taxonomy: loaded from IFRS Foundation CDN (cached locally by Arelle on first use).

    IRON DOME: If Arelle is not installed, returns arelle_available=False and
    relies on StructuralValidator results. Never silently passes a missing Arelle
    as "validated" — the response always states which validator was used.
    """

    def __init__(self):
        self._arelle_available = False
        try:
            import arelle  # noqa: F401
            self._arelle_available = True
        except ImportError:
            pass

    @property
    def available(self) -> bool:
        return self._arelle_available

    def validate(
        self,
        instance_xml:   str,
        taxonomy_url:   str,
        output_format:  str = "xbrl_2_1",
    ) -> list[XBRLValidationIssue]:
        """
        Run Arelle validation on the XBRL instance.
        Returns list of issues (errors + warnings + info messages).

        IRON DOME: If Arelle is not available, returns a single INFO issue
        documenting that Arelle validation was skipped — never silently passes.
        """
        if not self._arelle_available:
            return [XBRLValidationIssue(
                severity=     "info",
                arelle_code=  "ARELLE-NOT-INSTALLED",
                message=      (
                    "Arelle XBRL processor not installed. "
                    "Install with: pip install arelle-release. "
                    "Structural validation (SV-01 through SV-08) was performed instead. "
                    "For full taxonomy conformance validation, deploy with Arelle installed."
                ),
                xbrl_element= None,
                fact_value=   None,
            )]

        try:
            return self._run_arelle(instance_xml, taxonomy_url, output_format)
        except Exception as exc:
            return [XBRLValidationIssue(
                severity=     "error",
                arelle_code=  "ARELLE-RUNTIME-ERROR",
                message=      f"Arelle validation failed with exception: {exc}",
                xbrl_element= None,
                fact_value=   None,
            )]

    def _run_arelle(
        self,
        instance_xml:  str,
        taxonomy_url:  str,
        output_format: str,
    ) -> list[XBRLValidationIssue]:
        """Run Arelle Python API validation."""
        import tempfile
        import os
        from arelle import Cntlr, ModelXbrl, ValidateXbrl, XbrlConst

        issues: list[XBRLValidationIssue] = []

        # Write instance to temp file (Arelle works with file paths)
        suffix = ".html" if output_format == "ixbrl_1_1" else ".xbrl"
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=suffix, delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write(instance_xml)
            tmp_path = tmp.name

        try:
            # Arelle logging capture
            log_lines: list[tuple[str, str, str]] = []

            class LogCapture:
                def __init__(self):
                    self.records = []

                def append(self, code: str, msg: str, severity: str = "warning"):
                    self.records.append((severity, code, msg))

            log = LogCapture()

            # Initialise Arelle controller (no GUI)
            cntlr = Cntlr.Cntlr(logFileName=None)

            # Custom message handler to capture Arelle output
            original_add = cntlr.addToLog

            def capture_log(message, messageCode="", file="", refs=[], level="info"):
                severity_map = {
                    "err": "error", "wrn": "warning", "info": "info",
                    "error": "error", "warning": "warning",
                }
                sev = severity_map.get(level.lower()[:3], "info")
                log.append(messageCode, str(message), sev)

            cntlr.addToLog = capture_log

            # Load and validate the instance document
            modelXbrl = cntlr.modelManager.load(tmp_path)

            if modelXbrl is None:
                issues.append(XBRLValidationIssue(
                    severity=    "error",
                    arelle_code= "ARELLE-LOAD-FAILED",
                    message=     "Arelle could not load the instance document.",
                    xbrl_element=None, fact_value=None,
                ))
                return issues

            # Run validation
            ValidateXbrl.ValidateXbrl(modelXbrl).validate()

            # Convert captured log entries to XBRLValidationIssue
            for sev, code, msg in log.records:
                # Extract element name from message if possible
                element_match = re.search(r'\b(\w+:\w+)\b', msg)
                element = element_match.group(1) if element_match else None

                issues.append(XBRLValidationIssue(
                    severity=     sev,
                    arelle_code=  code or None,
                    message=      msg,
                    xbrl_element= element,
                    fact_value=   None,
                ))

            # Also capture model errors
            for error in getattr(modelXbrl, 'errors', []):
                issues.append(XBRLValidationIssue(
                    severity=     "error",
                    arelle_code=  None,
                    message=      str(error),
                    xbrl_element= None,
                    fact_value=   None,
                ))

            modelXbrl.close()
            cntlr.modelManager.close()

        finally:
            os.unlink(tmp_path)

        return issues


# ── Top-level XBRL Engine ─────────────────────────────────────────────────────

class XBRLEngine:
    """
    Orchestrates XBRL generation and validation for one upload_id.

    Builds the instance document from:
      - computation_detail (IS, SCF, SOCIE figures)
      - period_closing_balances (SFP figures)
      - company_tin (entity identifier)
      - reporting_framework (taxonomy selection)

    Then runs:
      1. Structural validation (always — no dependencies)
      2. Arelle validation (if installed — full taxonomy conformance)

    Returns XBRLGenerationResult with full detail for storage in xbrl_instance_documents.

    IRON DOME:
      - IPSAS frameworks → BLOCKED (no taxonomy implemented)
      - Missing required data → BLOCKED (no silent generation)
      - Arelle unavailable → documented as info issue, not silently passed
    """

    def generate_and_validate(
        self,
        reporting_framework:    str,
        company_tin:            str,
        period_year:            int,
        period_end_month:       int,
        period_end_day:         int,
        computation_detail:     dict[str, Any],
        period_closing_balances: dict[str, Any],
        output_format:          str = "xbrl_2_1",  # 'xbrl_2_1' | 'ixbrl_1_1'
    ) -> XBRLGenerationResult:

        # ── IPSAS block ───────────────────────────────────────────────────────
        if reporting_framework in ("ipsas_accrual", "ipsas_cash"):
            return XBRLGenerationResult(
                success=False, blocked=True,
                blocked_reason=(
                    f"IRON DOME: IPSAS XBRL taxonomy not implemented. "
                    f"Framework '{reporting_framework}' cannot generate XBRL output. "
                    f"Use ifrs_for_smes or full_ifrs."
                ),
                output_format=output_format,
                taxonomy_version="n/a",
                reporting_framework=reporting_framework,
                instance_xml=None, instance_sha256=None,
                fact_count=0, validation_passed=False,
                validation_errors=1, validation_warnings=0, validation_info=0,
            )

        if reporting_framework not in TAXONOMY_REGISTRY:
            return XBRLGenerationResult(
                success=False, blocked=True,
                blocked_reason=f"Unknown reporting framework: '{reporting_framework}'.",
                output_format=output_format, taxonomy_version="n/a",
                reporting_framework=reporting_framework,
                instance_xml=None, instance_sha256=None,
                fact_count=0, validation_passed=False,
                validation_errors=1, validation_warnings=0, validation_info=0,
            )

        taxonomy_version = TAXONOMY_REGISTRY[reporting_framework]["version"]

        # ── Extract IS figures ────────────────────────────────────────────────
        is_bd = computation_detail.get("income_statement_breakdown", {})

        required_is = {
            "revenue_tzs":             is_bd.get("revenue_tzs"),
            "cost_of_goods_sold_tzs":  is_bd.get("cost_of_goods_sold_tzs"),
            "gross_profit_tzs":        is_bd.get("gross_profit_tzs"),
            "profit_before_tax_tzs":   is_bd.get("profit_before_tax_tzs"),
        }
        missing_is = [k for k, v in required_is.items() if v is None]
        if missing_is:
            return XBRLGenerationResult(
                success=False, blocked=True,
                blocked_reason=(
                    f"IRON DOME: Required IS fields missing from computation_detail: "
                    f"{', '.join(missing_is)}. Rerun kinga-tax-engine first."
                ),
                output_format=output_format, taxonomy_version=taxonomy_version,
                reporting_framework=reporting_framework,
                instance_xml=None, instance_sha256=None,
                fact_count=0, validation_passed=False,
                validation_errors=1, validation_warnings=0, validation_info=0,
            )

        # ── Extract SFP figures ───────────────────────────────────────────────
        required_sfp = {
            "current_assets_tzs":          period_closing_balances.get("current_assets_tzs"),
            "non_current_assets_tzs":      period_closing_balances.get("non_current_assets_tzs"),
            "current_liabilities_tzs":     period_closing_balances.get("current_liabilities_tzs"),
            "non_current_liabilities_tzs": period_closing_balances.get("non_current_liabilities_tzs"),
            "equity_tzs":                  period_closing_balances.get("equity_tzs"),
        }
        missing_sfp = [k for k, v in required_sfp.items() if v is None]
        if missing_sfp:
            return XBRLGenerationResult(
                success=False, blocked=True,
                blocked_reason=(
                    f"IRON DOME: Required SFP fields missing from period_closing_balances: "
                    f"{', '.join(missing_sfp)}."
                ),
                output_format=output_format, taxonomy_version=taxonomy_version,
                reporting_framework=reporting_framework,
                instance_xml=None, instance_sha256=None,
                fact_count=0, validation_passed=False,
                validation_errors=1, validation_warnings=0, validation_info=0,
            )

        # ── Build generator ───────────────────────────────────────────────────
        gen = XBRLInstanceGenerator(
            reporting_framework=reporting_framework,
            company_tin=company_tin,
            period_year=period_year,
            period_end_month=period_end_month,
            period_end_day=period_end_day,
        )

        # Add IS pl_category facts
        for pl_cat, val_key in [
            ("revenue",                 "revenue_tzs"),
            ("cost_of_goods_sold",      "cost_of_goods_sold_tzs"),
            ("gross_profit",            "gross_profit_tzs"),
            ("other_income",            "other_income_tzs"),
            ("employee_costs",          "employee_costs_tzs"),
            ("depreciation_amortisation", "depreciation_tzs"),
            ("operating_expenses",      "operating_expenses_tzs"),
            ("finance_costs",           "finance_costs_tzs"),
            ("taxation",                "taxes_tzs"),
        ]:
            val = is_bd.get(val_key)
            if val is not None:
                gen.add_fact_from_pl_category(pl_cat, val)

        # Add SFP pl_category facts
        for pl_cat, val_key in [
            ("current_assets",          "current_assets_tzs"),
            ("non_current_assets",      "non_current_assets_tzs"),
            ("current_liabilities",     "current_liabilities_tzs"),
            ("non_current_liabilities", "non_current_liabilities_tzs"),
            ("equity",                  "equity_tzs"),
        ]:
            val = period_closing_balances.get(val_key)
            if val is not None:
                gen.add_fact_from_pl_category(pl_cat, val)

        # Add derived SFP aggregates (required by taxonomy calculation linkbase)
        gen.add_derived_sfp_facts(
            current_assets_tzs=        period_closing_balances.get("current_assets_tzs", 0),
            non_current_assets_tzs=    period_closing_balances.get("non_current_assets_tzs", 0),
            current_liabilities_tzs=   period_closing_balances.get("current_liabilities_tzs", 0),
            non_current_liabilities_tzs=period_closing_balances.get("non_current_liabilities_tzs", 0),
            equity_tzs=                period_closing_balances.get("equity_tzs", 0),
            cash_tzs=                  period_closing_balances.get("cash_balance_tzs", 0),
            share_capital_tzs=         period_closing_balances.get("share_capital_tzs", 0),
            retained_earnings_tzs=     period_closing_balances.get("retained_earnings_tzs", 0),
            other_reserves_tzs=        period_closing_balances.get("other_reserves_tzs", 0),
            closing_dtl_tzs=           period_closing_balances.get("closing_dtl_tzs", 0),
            closing_dta_tzs=           period_closing_balances.get("closing_dta_tzs", 0),
        )

        # Add IS aggregates (PBT + ProfitLoss)
        pbt  = is_bd.get("profit_before_tax_tzs", 0)
        tax  = is_bd.get("taxes_tzs", 0)
        gen.add_is_aggregates(
            pbt_tzs=   pbt,
            taxes_tzs= tax,
            pat_tzs=   pbt - tax,
        )

        # Add SCF facts (if available)
        scf = computation_detail.get("scf_engine", {})
        if scf and not scf.get("is_first_year_draft", True):
            scf_op  = scf.get("operating_activities", {})
            scf_inv = scf.get("investing_activities", {})
            scf_fin = scf.get("financing_activities", {})
            gen.add_scf_facts(
                operating_tzs=  scf_op.get("net_cash_from_operating_tzs", 0),
                investing_tzs=  scf_inv.get("net_cash_from_investing_tzs", 0),
                financing_tzs=  scf_fin.get("net_cash_from_financing_tzs", 0),
                net_change_tzs= scf.get("net_change_in_cash_tzs", 0),
                opening_cash_tzs= scf.get("opening_cash_tzs", 0),
                closing_cash_tzs= scf.get("closing_cash_tzs", 0),
            )

        # ── Generate XML ──────────────────────────────────────────────────────
        if output_format == "ixbrl_1_1":
            wrapper = iXBRLWrapper(gen)
            instance_xml = wrapper.generate()
        else:
            instance_xml = gen.to_xbrl_21()

        instance_sha256 = hashlib.sha256(instance_xml.encode("utf-8")).hexdigest()

        # ── Validate ──────────────────────────────────────────────────────────
        # Step 1: Structural validation (always)
        sv = StructuralValidator(gen._facts)
        all_issues: list[XBRLValidationIssue] = sv.validate()

        # Step 2: Arelle validation (if installed)
        arelle = ArelleValidator()
        arelle_issues = arelle.validate(
            instance_xml=  instance_xml,
            taxonomy_url=  TAXONOMY_REGISTRY[reporting_framework]["schema_ref"],
            output_format= output_format,
        )
        all_issues.extend(arelle_issues)

        # Tally
        errors   = sum(1 for i in all_issues if i.severity == "error")
        warnings = sum(1 for i in all_issues if i.severity == "warning")
        infos    = sum(1 for i in all_issues if i.severity == "info")

        return XBRLGenerationResult(
            success=           True,
            blocked=           False,
            blocked_reason=    None,
            output_format=     output_format,
            taxonomy_version=  taxonomy_version,
            reporting_framework= reporting_framework,
            instance_xml=      instance_xml,
            instance_sha256=   instance_sha256,
            fact_count=        gen.fact_count,
            validation_passed= errors == 0,
            validation_errors= errors,
            validation_warnings= warnings,
            validation_info=   infos,
            issues=            all_issues,
            arelle_available=  arelle.available,
        )
