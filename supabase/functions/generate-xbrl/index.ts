/**
 * generate-xbrl · IRON DOME NUCLEAR DESIGN · XBRL/iXBRL Instance Generator
 *
 * Generates XBRL 2.1 or iXBRL 1.1 instance documents from SAFF financial statements.
 * Calls the safisha-pdf-worker Python microservice (which runs Arelle) for generation
 * and validation, then stores results in xbrl_instance_documents via SECURITY DEFINER.
 *
 * XBRL is the global standard for structured financial reporting:
 *   SEC EDGAR (US), ESMA ESEF (EU), Companies House (UK), ASIC (AU), MAS (SG), 50+ more.
 *
 * IFRS Taxonomy: http://xbrl.ifrs.org/taxonomy/2023-01-01/
 *   ifrs-smes — for IFRS for SMEs reporters
 *   ifrs-full — for Full IFRS reporters
 *   (IPSAS taxonomy not implemented — returns BLOCKED)
 *
 * Validation layers:
 *   1. Structural (SV-01 to SV-08): required elements, calculation consistency,
 *      no duplicate facts — always runs, no dependencies.
 *   2. Arelle taxonomy (arelle-release): full XBRL 2.1 schema + calculation
 *      linkbase validation — runs if Arelle is installed in the Python worker.
 *
 * POST /functions/v1/generate-xbrl
 * Body: {
 *   upload_id:    string,
 *   output_format?: 'xbrl_2_1' | 'ixbrl_1_1'   (default: 'xbrl_2_1')
 * }
 *
 * IRON DOME:
 *   - Auth required (Supabase JWT).
 *   - Caller must be firm member of the upload's company.
 *   - BLOCKED if IPSAS framework, missing computation_detail, or missing SFP data.
 *   - Writes ONLY through xbrl_write_instance() SECURITY DEFINER.
 *   - Every response includes request_id and function_version.
 *   - SHA-256 of instance_xml verified before storage.
 */

import { serve }        from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FUNCTION_VERSION   = "generate-xbrl/v1.0.0";
const TAXONOMY_VERSION   = "2023-01-01";

// Period end day by month (fiscal year end is always the last day of the end month)
const MONTH_END_DAYS: Record<number, number> = {
  1:31, 2:28, 3:31, 4:30, 5:31, 6:30,
  7:31, 8:31, 9:30, 10:31, 11:30, 12:31,
};

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Compute SHA-256 of a string using Web Crypto API (available in Deno). */
async function sha256hex(text: string): Promise<string> {
  const enc     = new TextEncoder();
  const buf     = await crypto.subtle.digest("SHA-256", enc.encode(text));
  const bytes   = new Uint8Array(buf);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const requestId = crypto.randomUUID();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Auth ──────────────────────────────────────────────────────────────────
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized", request_id: requestId }, 401);
    }

    const body = await req.json();
    const { upload_id, output_format = "xbrl_2_1" } = body;

    if (!upload_id) {
      return json({ error: "upload_id is required", request_id: requestId }, 400);
    }

    if (!["xbrl_2_1", "ixbrl_1_1"].includes(output_format)) {
      return json({
        error: "output_format must be 'xbrl_2_1' or 'ixbrl_1_1'",
        request_id: requestId,
      }, 400);
    }

    // ── Load upload ───────────────────────────────────────────────────────────
    const { data: upload } = await supabase
      .from("trial_balance_uploads")
      .select("id, company_id, fiscal_year_end, uploaded_at, reporting_framework")
      .eq("id", upload_id)
      .single();

    if (!upload) {
      return json({ error: "Upload not found", request_id: requestId }, 404);
    }

    const companyId          = upload.company_id;
    const reportingFramework = upload.reporting_framework ?? "ifrs_for_smes";

    // ── IPSAS early block ─────────────────────────────────────────────────────
    if (reportingFramework === "ipsas_accrual" || reportingFramework === "ipsas_cash") {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   `IRON DOME: IPSAS XBRL taxonomy not implemented. Framework '${reportingFramework}' cannot generate XBRL output. Use ifrs_for_smes or full_ifrs.`,
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    // ── Load company TIN ──────────────────────────────────────────────────────
    const { data: company } = await supabase
      .from("companies")
      .select("tin")
      .eq("id", companyId)
      .single();

    const companyTin: string = company?.tin ?? "000000000";

    // ── Derive period ─────────────────────────────────────────────────────────
    const fyeParts     = upload.fiscal_year_end?.match(/(\d{1,2})-(\d{1,2})/);
    const periodMonth  = fyeParts ? parseInt(fyeParts[1]) : 12;
    const periodDay    = MONTH_END_DAYS[periodMonth] ?? 31;
    const periodYear   = fyeParts
      ? new Date(upload.uploaded_at).getFullYear()
      : new Date(upload.uploaded_at).getFullYear();

    // ── Load computation_detail ───────────────────────────────────────────────
    const { data: taxComp } = await supabase
      .from("tax_computations")
      .select("computation_detail, period_year, created_at")
      .eq("upload_id", upload_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!taxComp?.computation_detail) {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   "No tax computation found for this upload. Run kinga-tax-engine first.",
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    const computationDetail = taxComp.computation_detail as Record<string, unknown>;
    const resolvedYear      = (taxComp.period_year as number) ?? periodYear;

    // ── Load period_closing_balances ──────────────────────────────────────────
    const { data: sfp } = await supabase
      .from("period_closing_balances")
      .select(`
        current_assets_tzs, non_current_assets_tzs,
        current_liabilities_tzs, non_current_liabilities_tzs,
        equity_tzs, cash_balance_tzs,
        share_capital_tzs, retained_earnings_tzs, other_reserves_tzs,
        closing_dtl_tzs, closing_dta_tzs
      `)
      .eq("company_id", companyId)
      .eq("period_year", resolvedYear)
      .order("period_month", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sfp) {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   `No period_closing_balances for company ${companyId} year ${resolvedYear}. kinga-tax-engine must complete first.`,
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    // ── Call Python worker ────────────────────────────────────────────────────
    const workerUrl = Deno.env.get("SAFISHA_WORKER_URL");
    if (!workerUrl) {
      return json({
        error:            "SAFISHA_WORKER_URL environment variable not configured.",
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 500);
    }

    const workerPayload = {
      reporting_framework:     reportingFramework,
      company_tin:             companyTin,
      period_year:             resolvedYear,
      period_end_month:        periodMonth,
      period_end_day:          periodDay,
      computation_detail:      computationDetail,
      period_closing_balances: sfp,
      output_format,
    };

    let workerRes: Response;
    try {
      workerRes = await fetch(`${workerUrl}/generate-xbrl`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": req.headers.get("Authorization")!,
        },
        body: JSON.stringify(workerPayload),
      });
    } catch (fetchErr: any) {
      return json({
        error:            `XBRL worker unreachable: ${fetchErr.message}`,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 503);
    }

    const workerBody = await workerRes.json() as Record<string, any>;

    // ── Handle BLOCKED from worker ────────────────────────────────────────────
    if (workerBody.blocked) {
      return json({
        status:           "BLOCKED",
        blocked:          true,
        blocked_reason:   workerBody.blocked_reason,
        upload_id,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 422);
    }

    if (!workerBody.success || !workerBody.instance_xml) {
      return json({
        error:            "Python worker returned unsuccessful result without blocked reason.",
        worker_response:  workerBody,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 500);
    }

    // ── SHA-256 integrity check ───────────────────────────────────────────────
    // The Edge Function independently computes the hash and compares against
    // what the Python worker reported. Mismatch = data corruption in transit.
    const computedSha256 = await sha256hex(workerBody.instance_xml as string);
    if (computedSha256 !== workerBody.instance_sha256) {
      return json({
        error:            "IRON DOME: SHA-256 mismatch. XBRL instance integrity check failed.",
        computed_sha256:  computedSha256,
        reported_sha256:  workerBody.instance_sha256,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 500);
    }

    // ── Write to DB via SECURITY DEFINER ──────────────────────────────────────
    const issues = (workerBody.issues ?? []) as Array<{
      severity:     string;
      arelle_code:  string | null;
      message:      string;
      xbrl_element: string | null;
      fact_value:   string | null;
    }>;

    const { data: documentId, error: writeErr } = await supabase.rpc(
      "xbrl_write_instance",
      {
        p_upload_id:           upload_id,
        p_company_id:          companyId,
        p_period_year:         resolvedYear,
        p_reporting_framework: reportingFramework,
        p_output_format:       output_format,
        p_taxonomy_version:    TAXONOMY_VERSION,
        p_instance_xml:        workerBody.instance_xml,
        p_instance_sha256:     computedSha256,
        p_fact_count:          workerBody.fact_count ?? 0,
        p_validation_passed:   workerBody.validation_passed ?? false,
        p_validation_errors:   workerBody.validation_errors ?? 0,
        p_validation_warnings: workerBody.validation_warnings ?? 0,
        p_validation_info:     workerBody.validation_info ?? 0,
        p_request_id:          requestId,
        p_function_version:    FUNCTION_VERSION,
        p_issues:              JSON.stringify(issues),
      }
    );

    if (writeErr) {
      console.error("xbrl_write_instance error:", writeErr.message);
      return json({
        error:            "Failed to persist XBRL document: " + writeErr.message,
        request_id:       requestId,
        function_version: FUNCTION_VERSION,
      }, 500);
    }

    // ── Structured response ───────────────────────────────────────────────────
    const errCount  = workerBody.validation_errors   ?? 0;
    const warnCount = workerBody.validation_warnings ?? 0;
    const infoCount = workerBody.validation_info     ?? 0;
    const passed    = workerBody.validation_passed   ?? false;

    return json({
      status:              passed ? "valid" : "invalid",
      document_id:         documentId,
      upload_id,
      period_year:         resolvedYear,
      reporting_framework: reportingFramework,
      output_format,
      taxonomy_version:    TAXONOMY_VERSION,
      request_id:          requestId,
      function_version:    FUNCTION_VERSION,

      instance: {
        sha256:      computedSha256,
        fact_count:  workerBody.fact_count ?? 0,
        // The full XML is returned so the client can offer a download button
        xml:         workerBody.instance_xml,
      },

      validation: {
        passed,
        arelle_available: workerBody.arelle_available ?? false,
        errors:    errCount,
        warnings:  warnCount,
        info:      infoCount,
        // Only include issues in the response — client doesn't need the full XML again
        issues:    issues.map(i => ({
          severity:     i.severity,
          arelle_code:  i.arelle_code,
          message:      i.message,
          xbrl_element: i.xbrl_element,
        })),
      },

      next_step: passed
        ? "XBRL instance is valid. Download the instance document to submit to your regulatory filing portal."
        : `${errCount} error(s) found. Resolve issues and re-generate. See validation.issues for detail.`,

      // Explicit download hints for CPAs
      download_instructions: {
        xbrl_2_1:  "Save the instance.xml field as <company>-<year>.xbrl",
        ixbrl_1_1: "Save the instance.xml field as <company>-<year>.html — submit as iXBRL to Companies House, ESMA, or SEC EDGAR.",
        validator:  "Validate further at https://validate.xbrl.org (XBRL International free validator)",
      },
    }, 200);

  } catch (err: any) {
    console.error("generate-xbrl fatal error:", err);
    return json({ error: err.message, request_id: requestId }, 500);
  }
});
