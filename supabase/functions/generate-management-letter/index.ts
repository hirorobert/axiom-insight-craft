// ============================================================
// generate-management-letter — Sprint 4 Item 1
// Iron Dome Nuclear Design: all figures from DB (findings +
// tax_computations). No AI inference. No hallucinated numbers.
//
// Output shape:  { letter: LetterDocument }
// LetterDocument: addressee · date · reference · sections[]
//
// Sections (computed from real data):
//   1. Basis of Engagement
//   2. Executive Summary
//   A. Tax Computation Summary     ← tax_computations.computation_detail
//   B. Material Findings           ← findings table (open + in_progress)
//   C. Instalment Tax Obligations  ← ITA s.88 from engine result
//   D. Recommendations             ← derived from findings risk types
//   E. Sign-off block
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Formatting ───────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("en-TZ", { maximumFractionDigits: 0 }).format(Math.abs(n));

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

// ── Types ────────────────────────────────────────────────────
interface TableRow { label: string; value: string; highlight?: boolean; indent?: boolean }

interface FindingSummary {
  id: string;
  title: string;
  statute: string | null;
  category: string | null;
  type: string;
  status: string;
  period: string;
  exposureTzs: number;
  obligationTzs: number;
  penaltyTzs: number;
  interestTzs: number;
  totalTzs: number;
  riskLevel: "critical" | "high" | "medium" | "low";
}

interface LetterSection {
  id: string;
  heading: string;
  type: "text" | "table" | "findings" | "list";
  content?: string;
  rows?: TableRow[];
  findings?: FindingSummary[];
  items?: string[];
}

interface EngineResult {
  taxable_income_tzs?: number;
  cit_at_30pct_tzs?: number;
  minimum_tax_tzs?: number;
  tax_payable_tzs?: number;
  income_tax_provision_tzs?: number;
  cit_gap_tzs?: number;
  pbt_tzs?: number;
  total_revenue_tzs?: number;
  opening_cumulative_loss_tzs?: number;
  closing_cumulative_loss_tzs?: number;
  loss_absorbed_this_year_tzs?: number;
  amt_applies?: boolean;
  amt_computed_tzs?: number;
  wear_tear_allowance_tzs?: number;
  management_fee_disallowance_tzs?: number;
  thin_cap_disallowance_tzs?: number;
  engine_version?: string;
  [key: string]: unknown;
}

// ── Risk classification ──────────────────────────────────────
function riskLevel(exposureTzs: number): FindingSummary["riskLevel"] {
  if (exposureTzs >= 10_000_000) return "critical";
  if (exposureTzs >= 2_000_000)  return "high";
  if (exposureTzs >= 500_000)    return "medium";
  return "low";
}

// ── Instalment schedule (ITA s.88) ──────────────────────────
function instalmentDates(periodYear: number, periodEndMonth: number) {
  const startM = (periodEndMonth % 12) + 1;
  const startY = periodEndMonth === 12 ? periodYear : periodYear - 1;
  const addM = (m: number, y: number, n: number): string => {
    const total = (y * 12 + m - 1) + n;
    const rm = (total % 12) + 1;
    const ry = Math.floor(total / 12);
    const last = new Date(ry, rm, 0).getDate();
    return `${String(last).padStart(2,"0")} ${MONTHS[rm-1]} ${ry}`;
  };
  return [
    { label: "1st instalment (end of 3rd month)", due: addM(startM, startY, 3) },
    { label: "2nd instalment (end of 6th month)", due: addM(startM, startY, 6) },
    { label: "3rd instalment (end of 9th month)", due: addM(startM, startY, 9) },
    { label: "Final balance (year-end)",           due: addM(startM, startY, 12) },
  ];
}

// ── Auth ─────────────────────────────────────────────────────
async function validateAuth(
  authHeader: string | null,
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<{ userId?: string; error?: Response }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders }) };
  }
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders }) };
  }
  return { userId: user.id };
}

// ── Main ─────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl      = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey  = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseSvcKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const { userId, error: authErr } = await validateAuth(
      req.headers.get("Authorization"), supabaseUrl, supabaseAnonKey,
    );
    if (authErr) return authErr;

    const { uploadId } = await req.json();
    if (!uploadId) {
      return new Response(JSON.stringify({ error: "uploadId required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, supabaseSvcKey);

    // ── 1. Upload record ─────────────────────────────────────
    const { data: upload, error: uploadErr } = await admin
      .from("trial_balance_uploads")
      .select("company_id, company_name, fiscal_year_end, uploaded_at, reporting_framework")
      .eq("id", uploadId)
      .single();
    if (uploadErr || !upload) {
      return new Response(JSON.stringify({ error: "Upload not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Authorization: caller must be a firm_member of upload.company_id ──
    {
      const { data: member } = await admin
        .from("firm_members")
        .select("id")
        .eq("user_id", userId)
        .eq("company_id", upload.company_id)
        .not("accepted_at", "is", null)
        .limit(1)
        .maybeSingle();
      if (!member) {
        return new Response(
          JSON.stringify({ error: "Forbidden", message: "Not a member of this company" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── 1b. Company TIN (mandatory for all TRA-facing documents) ─
    const { data: companyRow } = await admin
      .from("companies")
      .select("tin")
      .eq("id", upload.company_id)
      .maybeSingle();
    const companyTin: string = companyRow?.tin ?? "";

    // ── 2. Latest committed tax computation ──────────────────
    // IRON DOME: correct column is `computation_detail` (not `result_json`).
    // `tax_computations` has no `period_month` column — derive from fiscal_year_end.
    const { data: computation } = await admin
      .from("tax_computations")
      .select("computation_detail, period_year, engine_version, created_at")
      .eq("upload_id", uploadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const r: EngineResult = (computation?.computation_detail as EngineResult) ?? {};
    const periodYear: number = computation?.period_year ?? new Date(upload.uploaded_at).getFullYear();
    // fiscal_year_end format "MM-DD" — month is the authoritative period-end month
    const fyePartsML = upload.fiscal_year_end?.match(/(\d{1,2})-(\d{1,2})/);
    const periodEndMonth: number = fyePartsML ? parseInt(fyePartsML[1]) : 12;
    const engineVersion: string = r.engine_version ?? computation?.engine_version ?? "v2";

    // ── 3. Findings (open + in_progress, this upload) ───────
    const { data: findingsRaw } = await admin
      .from("findings")
      .select([
        "id", "title", "statute_reference", "finding_type", "finding_category",
        "period_start", "period_end", "status",
        "exposure_amount_tzs", "computed_obligation_tzs",
        "interest_amount_tzs", "penalty_amount_tzs",
      ].join(", "))
      .eq("upload_id", uploadId)
      .in("status", ["open", "in_progress"])
      .order("exposure_amount_tzs", { ascending: false });

    const findings: FindingSummary[] = (findingsRaw ?? []).map((f: Record<string, unknown>) => {
      const exposure   = Number(f.exposure_amount_tzs ?? 0);
      const obligation = Number(f.computed_obligation_tzs ?? exposure);
      const penalty    = Number(f.penalty_amount_tzs ?? 0);
      const interest   = Number(f.interest_amount_tzs ?? 0);
      return {
        id:            String(f.id),
        title:         String(f.title),
        statute:       f.statute_reference ? String(f.statute_reference) : null,
        category:      f.finding_category  ? String(f.finding_category)  : null,
        type:          String(f.finding_type),
        status:        String(f.status),
        period: (() => {
          const ps = f.period_start ? new Date(String(f.period_start)) : null;
          const pe = f.period_end   ? new Date(String(f.period_end))   : null;
          return ps && pe
            ? `${fmtDate(ps)} to ${fmtDate(pe)}`
            : `FY${periodYear}`;
        })(),
        exposureTzs:   exposure,
        obligationTzs: obligation,
        penaltyTzs:    penalty,
        interestTzs:   interest,
        totalTzs:      obligation + penalty + interest,
        riskLevel:     riskLevel(exposure),
      };
    });

    const totalExposure  = findings.reduce((s, f) => s + f.exposureTzs, 0);
    const criticalCount  = findings.filter(f => f.riskLevel === "critical").length;
    const highCount      = findings.filter(f => f.riskLevel === "high").length;
    const companyName    = upload.company_name ?? "The Company";
    const framework      = upload.reporting_framework ?? "IFRS for SMEs";
    const fyEnd          = `${MONTHS[periodEndMonth - 1]} ${periodYear}`;
    const generatedAt    = new Date();
    const reference      = `SAFF/ML/${periodYear}/${String(generatedAt.getTime()).slice(-5)}`;
    const hasTax         = !!computation;
    const taxPayable     = r.tax_payable_tzs ?? 0;
    const citGap         = r.cit_gap_tzs ?? 0;

    // ── 4. Build sections ─────────────────────────────────────

    // Section 0 — Basis
    const secBasis: LetterSection = {
      id: "basis",
      heading: "Basis of Engagement",
      type: "text",
      content: `This Management Letter has been prepared by SAFF ERP on behalf of the engagement team, following review of the trial balance and financial data of ${companyName} for the financial year ended ${fyEnd}.

Our work was conducted for the purpose of assisting management in identifying material tax and accounting compliance issues. This letter does not constitute an audit opinion. It is based on procedures applied under the Income Tax Act Cap.332 R.E.2023 ("ITA"), the Tax Administration Act Cap.438 ("TAA"), the Finance Act 2026 (effective 01 July 2026), and ${framework}.

All monetary amounts are stated in Tanzanian Shillings (TZS). Findings are ranked by financial exposure and presented in descending order of risk.`,
    };

    // Section 1 — Executive Summary
    const execLines: string[] = [];
    if (findings.length === 0) {
      execLines.push(`No open compliance findings were identified for the financial year ended ${fyEnd}.`);
    } else {
      execLines.push(`Our review identified ${findings.length} open compliance finding${findings.length > 1 ? "s" : ""} for the financial year ended ${fyEnd}, representing a total estimated exposure of TZS ${fmt(totalExposure)}.`);
      if (criticalCount > 0) execLines.push(`${criticalCount} finding${criticalCount > 1 ? "s are" : " is"} rated CRITICAL (exposure ≥ TZS 10,000,000) and require immediate attention.`);
      if (highCount > 0)     execLines.push(`${highCount} finding${highCount > 1 ? "s are" : " is"} rated HIGH (exposure ≥ TZS 2,000,000).`);
    }
    if (hasTax && Math.abs(citGap) > 500_000) {
      execLines.push(`The income tax computation identifies a CIT provision gap of TZS ${fmt(citGap)} — ${citGap > 0 ? "an additional provision is required" : "the provision exceeds computed liability"}.`);
    }
    if (r.amt_applies) {
      execLines.push(`Alternative Minimum Tax (ITA s.89) applies — the Company has recorded losses for 3+ consecutive years. AMT payable: TZS ${fmt(r.amt_computed_tzs ?? 0)}.`);
    }
    const closingLoss = r.closing_cumulative_loss_tzs ?? 0;
    if (closingLoss > 0) {
      execLines.push(`An unrelieved tax loss pool of TZS ${fmt(closingLoss)} carries forward to future periods (ITA s.19).`);
    }

    const secSummary: LetterSection = {
      id: "executive-summary",
      heading: "Executive Summary",
      type: "list",
      items: execLines,
    };

    // Section A — Tax Computation
    const taxRows: TableRow[] = [];
    if (hasTax) {
      taxRows.push({ label: "Profit / (Loss) Before Tax", value: `TZS ${fmt(r.pbt_tzs ?? 0)}` });
      if ((r.wear_tear_allowance_tzs ?? 0) > 0)
        taxRows.push({ label: "Less: ITA s.34 Capital Allowances", value: `(TZS ${fmt(r.wear_tear_allowance_tzs!)})`, indent: true });
      if ((r.management_fee_disallowance_tzs ?? 0) > 0)
        taxRows.push({ label: "Add: ITA s.33 Mgmt Fee Disallowance", value: `TZS ${fmt(r.management_fee_disallowance_tzs!)}`, indent: true });
      if ((r.thin_cap_disallowance_tzs ?? 0) > 0)
        taxRows.push({ label: "Add: ITA s.24A Thin Cap Disallowance", value: `TZS ${fmt(r.thin_cap_disallowance_tzs!)}`, indent: true });
      if ((r.loss_absorbed_this_year_tzs ?? 0) > 0)
        taxRows.push({ label: "Less: ITA s.19 Prior-Year Loss Relief (70% cap)", value: `(TZS ${fmt(r.loss_absorbed_this_year_tzs!)})`, indent: true });
      const ti = r.taxable_income_tzs ?? 0;
      taxRows.push({ label: "Chargeable Income / (Loss)", value: ti < 0 ? `(TZS ${fmt(ti)})` : `TZS ${fmt(ti)}`, highlight: true });
      taxRows.push({ label: "CIT @ 30% (ITA s.4)", value: `TZS ${fmt(r.cit_at_30pct_tzs ?? 0)}` });
      taxRows.push({ label: "Minimum Tax @ 0.5% of Turnover (ITA s.65 / FA2026 s.31)", value: `TZS ${fmt(r.minimum_tax_tzs ?? 0)}` });
      taxRows.push({ label: "Tax Payable (Higher of CIT / Min)", value: `TZS ${fmt(taxPayable)}`, highlight: true });
      taxRows.push({ label: "Income Tax Provision (Booked)", value: `TZS ${fmt(r.income_tax_provision_tzs ?? 0)}` });
      const gap = citGap;
      taxRows.push({
        label: `CIT Provision Gap ${gap > 0 ? "(UNDERPROVISION)" : gap < 0 ? "(OVERPROVISION)" : ""}`,
        value: `TZS ${fmt(gap)}`,
        highlight: Math.abs(gap) > 500_000,
      });
    }

    const secTax: LetterSection = {
      id: "section-a-tax",
      heading: "Section A — Income Tax Computation Summary (ITA Cap.332 R.E.2023)",
      type: hasTax ? "table" : "text",
      content: hasTax ? undefined : "No committed tax computation found for this upload. Run and commit the tax computation in the Kinga Tax Engine before generating the management letter.",
      rows: hasTax ? taxRows : undefined,
    };

    // Section B — Findings
    const secFindings: LetterSection = {
      id: "section-b-findings",
      heading: "Section B — Material Compliance Findings",
      type: "findings",
      findings,
      content: findings.length === 0
        ? `No open compliance findings were identified for the financial year ended ${fyEnd}. This section will populate once the findings engine has been run.`
        : undefined,
    };

    // Section C — Instalment Schedule
    const instalments = instalmentDates(periodYear, periodEndMonth);
    const instAmount = taxPayable > 0 ? Math.round(taxPayable / 4) : 0;
    const instRows: TableRow[] = taxPayable > 0
      ? [
          ...instalments.map((ins, i) => ({
            label: `${ins.label} — due ${ins.due}`,
            value: `TZS ${fmt(i < 3 ? instAmount : taxPayable - instAmount * 3)}`,
            highlight: i === 3,
          })),
          { label: "Total Instalment Tax (ITA s.88)", value: `TZS ${fmt(taxPayable)}`, highlight: true },
        ]
      : [];

    const secInstalments: LetterSection = {
      id: "section-c-instalments",
      heading: "Section C — Instalment Tax Obligations (ITA s.88)",
      type: taxPayable > 0 ? "table" : "text",
      rows: taxPayable > 0 ? instRows : undefined,
      content: taxPayable > 0
        ? undefined
        : "No instalment tax obligation identified (tax payable is nil). This section will populate once the tax computation is committed.",
    };

    // Section D — Recommendations
    const recommendations: string[] = [];
    if (Math.abs(citGap) > 500_000 && citGap > 0) {
      recommendations.push(`Record an additional income tax provision of TZS ${fmt(citGap)} to align the booked provision with the ITA-computed liability (ITA s.4). Engage the finance team to process the adjusting journal entry before the financial statements are signed off.`);
    }
    if (taxPayable > 0) {
      recommendations.push(`Ensure instalment tax payments are made by the dates set out in Section C above (ITA s.88). Late payment attracts interest at 5%/month under TAA s.76. Set reminders for each due date.`);
    }
    if (r.amt_applies) {
      recommendations.push(`The Alternative Minimum Tax (AMT) has been triggered by three or more consecutive loss years (ITA s.89). Management should develop a profitability improvement plan to exit the AMT regime, as AMT is payable regardless of taxable income.`);
    }
    if (closingLoss > 0) {
      recommendations.push(`The unrelieved tax loss pool of TZS ${fmt(closingLoss)} should be tracked annually and absorbed at 70% of taxable income in profitable years (ITA s.19(2)). Consider whether a Deferred Tax Asset should be recognised in the financial statements (IFRS for SMEs s.29.7).`);
    }
    if ((r.management_fee_disallowance_tzs ?? 0) > 0) {
      recommendations.push(`Management fees of TZS ${fmt(r.management_fee_disallowance_tzs!)} were disallowed under ITA s.33 (cap: 1% of gross turnover). Review the management fee agreement and consider restructuring or reducing the fee to fall within the cap in future years.`);
    }
    findings.filter(f => f.riskLevel === "critical" || f.riskLevel === "high").forEach(f => {
      recommendations.push(`Finding "${f.title}" (exposure TZS ${fmt(f.exposureTzs)}) — ${f.statute ? `statute: ${f.statute}.` : ""} Request supporting evidence via the Evidence Request workflow and resolve before the TRA filing deadline.`);
    });
    if (recommendations.length === 0) {
      recommendations.push("No specific tax recommendations at this time. Continue monitoring compliance on a quarterly basis.");
    }

    const secRecs: LetterSection = {
      id: "section-d-recommendations",
      heading: "Section D — Recommendations",
      type: "list",
      items: recommendations,
    };

    // Section E — Sign-off
    const secSignOff: LetterSection = {
      id: "section-e-signoff",
      heading: "Sign-off",
      type: "text",
      content: `This Management Letter is prepared by SAFF ERP on behalf of the engagement team for the use of the Directors of ${companyName} only.

It should not be distributed to or relied upon by any third party without prior written consent of the engagement team. The findings and recommendations contained herein are based solely on information provided and do not constitute a legal or statutory opinion.

Engagement Reference: ${reference}
Generated: ${fmtDate(generatedAt)}
Engine: SAFF Kinga Engine ${engineVersion}
Framework: ${framework} / ITA Cap.332 R.E.2023 / Finance Act 2026

_____________________________
Engagement Partner / CPA
[Firm Name]
[NBAA / ICPAT Registration Number]
[Date]`,
    };

    // ── 5. Assemble letter ────────────────────────────────────
    const letter = {
      addressee:  `The Board of Directors\n${companyName}${companyTin ? `\nTIN: ${companyTin}` : ""}`,
      date:       fmtDate(generatedAt),
      reference,
      subject:    `Management Letter — Financial Year Ended ${fyEnd}`,
      sections: [secBasis, secSummary, secTax, secFindings, secInstalments, secRecs, secSignOff],
      metadata: {
        generatedAt:      generatedAt.toISOString(),
        companyName,
        companyTin,
        companyId:        upload.company_id,
        uploadId,
        periodYear,
        periodEndMonth,
        framework,
        engineVersion,
        findingCount:     findings.length,
        openFindingCount: findings.filter(f => f.status === "open").length,
        totalExposureTzs: totalExposure,
        citGapTzs:        citGap,
        taxPayableTzs:    taxPayable,
        hasCommittedComputation: hasTax,
      },
    };

    // ── 6. Persist to upload record (merge) ───────────────────
    const { data: existing } = await admin
      .from("trial_balance_uploads")
      .select("processing_result")
      .eq("id", uploadId)
      .single();
    const existingResult = (existing?.processing_result as Record<string, unknown>) ?? {};
    await admin
      .from("trial_balance_uploads")
      .update({ processing_result: { ...existingResult, managementLetter: letter } })
      .eq("id", uploadId);

    // ── 7. Audit log ──────────────────────────────────────────
    await admin.from("audit_logs").insert({
      user_id:     userId,
      action:      "generate_management_letter",
      entity_type: "trial_balance_upload",
      entity_id:   uploadId,
      metadata:    { finding_count: findings.length, total_exposure_tzs: totalExposure, period_year: periodYear },
    }).maybeSingle();

    return new Response(JSON.stringify({ letter }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("generate-management-letter error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
