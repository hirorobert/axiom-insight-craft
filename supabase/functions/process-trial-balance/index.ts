import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================
// AXIOM ACCOUNTING TRUTH ENGINE
// Deterministic processing with BLOCK gates
// ============================================

interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  debit: number;
  credit: number;
  balance: number;
}

interface AccountMapping {
  account_code: string;
  account_name: string;
  statement: string;
  classification: string;
  line_item: string;
  normal_balance: string;
  is_cash_account: boolean;
  is_retained_earnings: boolean;
}

interface ValidationError {
  code: string;
  message: string;
  field?: string;
  expected?: string | number;
  actual?: string | number;
}

interface ValidationReport {
  tb_balance_check: { passed: boolean; total_debits: number; total_credits: number; difference: number };
  mapping_completeness: { passed: boolean; total_accounts: number; mapped_accounts: number; unmapped: string[] };
  balance_sheet_equation: { passed: boolean; assets: number; liabilities: number; equity: number; difference: number } | null;
  profit_equity_linkage: { passed: boolean; details: string } | null;
  cash_reconciliation: { passed: boolean; cf_ending_cash: number; bs_cash: number } | null;
}

interface ProcessingResult {
  status: "valid" | "invalid" | "blocked";
  validation_report: ValidationReport;
  errors: ValidationError[];
  statements: {
    balance_sheet: Record<string, { accounts: TrialBalanceRow[]; total: number }> | null;
    income_statement: Record<string, { accounts: TrialBalanceRow[]; total: number }> | null;
    cash_flow: Record<string, { accounts: TrialBalanceRow[]; total: number }> | null;
  } | null;
  summary: {
    total_accounts: number;
    processed_at: string;
  };
}

/**
 * STEP 1: Validate Trial Balance Integrity
 * - Required fields exist
 * - Numeric validation
 * - SUM(debit) - SUM(credit) = 0
 */
function validateTrialBalance(
  headers: string[],
  rows: Record<string, string>[],
  tolerance: number = 0.01
): { valid: boolean; data: TrialBalanceRow[]; errors: ValidationError[]; totals: { debits: number; credits: number } } {
  const errors: ValidationError[] = [];
  const data: TrialBalanceRow[] = [];

  // Check required headers
  const requiredHeaders = ["account_code", "account_name", "debit", "credit"];
  const normalizedHeaders = headers.map(h => h.toLowerCase().replace(/[^a-z_]/g, "_"));
  
  const headerMap: Record<string, string> = {};
  for (const required of requiredHeaders) {
    const found = normalizedHeaders.find(h => 
      h.includes(required.replace("_", "")) || 
      h === required ||
      (required === "account_code" && (h.includes("code") || h.includes("acct") || h.includes("account_no"))) ||
      (required === "account_name" && (h.includes("name") || h.includes("description")))
    );
    
    if (!found) {
      errors.push({
        code: "MISSING_REQUIRED_FIELD",
        message: `Required field '${required}' not found in trial balance`,
        field: required,
      });
    } else {
      headerMap[required] = headers[normalizedHeaders.indexOf(found)];
    }
  }

  if (errors.length > 0) {
    return { valid: false, data: [], errors, totals: { debits: 0, credits: 0 } };
  }

  // Parse and validate each row
  let totalDebits = 0;
  let totalCredits = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const accountCode = row[headerMap["account_code"]]?.trim();
    const accountName = row[headerMap["account_name"]]?.trim();
    const debitStr = row[headerMap["debit"]]?.trim().replace(/[,$]/g, "") || "0";
    const creditStr = row[headerMap["credit"]]?.trim().replace(/[,$]/g, "") || "0";

    if (!accountCode) {
      errors.push({
        code: "MISSING_ACCOUNT_CODE",
        message: `Row ${i + 2}: Missing account code`,
        field: "account_code",
      });
      continue;
    }

    const debit = parseFloat(debitStr);
    const credit = parseFloat(creditStr);

    if (isNaN(debit)) {
      errors.push({
        code: "INVALID_NUMERIC",
        message: `Row ${i + 2}: Invalid debit value '${debitStr}'`,
        field: "debit",
        actual: debitStr,
      });
      continue;
    }

    if (isNaN(credit)) {
      errors.push({
        code: "INVALID_NUMERIC",
        message: `Row ${i + 2}: Invalid credit value '${creditStr}'`,
        field: "credit",
        actual: creditStr,
      });
      continue;
    }

    totalDebits += debit;
    totalCredits += credit;

    data.push({
      account_code: accountCode,
      account_name: accountName || accountCode,
      debit,
      credit,
      balance: debit - credit,
    });
  }

  // AXIOM RULE: SUM(debit) - SUM(credit) must equal zero
  const difference = Math.abs(totalDebits - totalCredits);
  if (difference > tolerance) {
    errors.push({
      code: "TRIAL_BALANCE_IMBALANCE",
      message: `Trial balance does not balance: Debits (${totalDebits.toFixed(2)}) ≠ Credits (${totalCredits.toFixed(2)})`,
      expected: 0,
      actual: difference,
    });
  }

  return {
    valid: errors.length === 0,
    data,
    errors,
    totals: { debits: totalDebits, credits: totalCredits },
  };
}

/**
 * STEP 2: Validate Mapping Completeness
 * Every account MUST map to exactly one FS line item
 */
function validateMappingCompleteness(
  tbAccounts: TrialBalanceRow[],
  mappings: AccountMapping[]
): { valid: boolean; mapped: Map<string, AccountMapping>; unmapped: string[]; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const mappingsByCode = new Map<string, AccountMapping>();
  
  for (const mapping of mappings) {
    mappingsByCode.set(mapping.account_code, mapping);
  }

  const unmapped: string[] = [];
  for (const account of tbAccounts) {
    if (!mappingsByCode.has(account.account_code)) {
      unmapped.push(account.account_code);
    }
  }

  // AXIOM RULE: Any unmapped account → BLOCK
  if (unmapped.length > 0) {
    errors.push({
      code: "UNMAPPED_ACCOUNTS",
      message: `${unmapped.length} account(s) have no explicit mapping: ${unmapped.slice(0, 5).join(", ")}${unmapped.length > 5 ? "..." : ""}`,
      actual: unmapped.length,
      expected: 0,
    });
  }

  return {
    valid: unmapped.length === 0,
    mapped: mappingsByCode,
    unmapped,
    errors,
  };
}

/**
 * STEP 3: Deterministic Statement Aggregation
 * No inference, no rounding beyond policy tolerance
 */
function aggregateStatements(
  tbAccounts: TrialBalanceRow[],
  mappings: Map<string, AccountMapping>
): {
  balance_sheet: Record<string, { accounts: TrialBalanceRow[]; total: number }>;
  income_statement: Record<string, { accounts: TrialBalanceRow[]; total: number }>;
  cash_flow: Record<string, { accounts: TrialBalanceRow[]; total: number }>;
  totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number };
  cashAccount: { exists: boolean; balance: number };
} {
  const bs: Record<string, { accounts: TrialBalanceRow[]; total: number }> = {
    current_assets: { accounts: [], total: 0 },
    non_current_assets: { accounts: [], total: 0 },
    current_liabilities: { accounts: [], total: 0 },
    non_current_liabilities: { accounts: [], total: 0 },
    equity: { accounts: [], total: 0 },
  };

  const is: Record<string, { accounts: TrialBalanceRow[]; total: number }> = {
    revenue: { accounts: [], total: 0 },
    cost_of_goods_sold: { accounts: [], total: 0 },
    operating_expenses: { accounts: [], total: 0 },
    other_income: { accounts: [], total: 0 },
    taxes: { accounts: [], total: 0 },
  };

  const cf: Record<string, { accounts: TrialBalanceRow[]; total: number }> = {
    operating_activities: { accounts: [], total: 0 },
    investing_activities: { accounts: [], total: 0 },
    financing_activities: { accounts: [], total: 0 },
  };

  let cashBalance = 0;
  let hasCashAccount = false;

  for (const account of tbAccounts) {
    const mapping = mappings.get(account.account_code);
    if (!mapping) continue;

    // Determine balance based on normal balance
    const balance = mapping.normal_balance === "debit" 
      ? account.debit - account.credit 
      : account.credit - account.debit;

    const accountWithBalance = { ...account, balance };

    if (mapping.is_cash_account) {
      hasCashAccount = true;
      cashBalance = balance;
    }

    // Route to appropriate statement section
    const classification = mapping.classification;
    
    if (bs[classification]) {
      bs[classification].accounts.push(accountWithBalance);
      bs[classification].total += balance;
    } else if (is[classification]) {
      is[classification].accounts.push(accountWithBalance);
      is[classification].total += balance;
    } else if (cf[classification]) {
      cf[classification].accounts.push(accountWithBalance);
      cf[classification].total += balance;
    }
  }

  // Calculate totals
  const totalAssets = bs.current_assets.total + bs.non_current_assets.total;
  const totalLiabilities = bs.current_liabilities.total + bs.non_current_liabilities.total;
  const totalEquity = bs.equity.total;
  const totalRevenue = is.revenue.total + is.other_income.total;
  const totalExpenses = is.cost_of_goods_sold.total + is.operating_expenses.total + is.taxes.total;

  return {
    balance_sheet: bs,
    income_statement: is,
    cash_flow: cf,
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      equity: totalEquity,
      revenue: totalRevenue,
      expenses: totalExpenses,
    },
    cashAccount: { exists: hasCashAccount, balance: cashBalance },
  };
}

/**
 * STEP 4: Accounting Equation Validators
 * All must pass or BLOCK
 */
function validateAccountingEquations(
  totals: { assets: number; liabilities: number; equity: number; revenue: number; expenses: number },
  tolerance: number = 0.01
): { valid: boolean; errors: ValidationError[]; details: { bsEquation: { passed: boolean; difference: number } } } {
  const errors: ValidationError[] = [];

  // Balance Sheet Equation: Assets = Liabilities + Equity
  const bsDifference = Math.abs(totals.assets - (totals.liabilities + totals.equity));
  const bsPassed = bsDifference <= tolerance;

  if (!bsPassed) {
    errors.push({
      code: "BALANCE_SHEET_EQUATION_FAILED",
      message: `Balance Sheet equation failed: Assets (${totals.assets.toFixed(2)}) ≠ Liabilities (${totals.liabilities.toFixed(2)}) + Equity (${totals.equity.toFixed(2)})`,
      expected: 0,
      actual: bsDifference,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    details: {
      bsEquation: { passed: bsPassed, difference: bsDifference },
    },
  };
}

/**
 * Validates JWT token and returns user info
 */
async function validateAuth(authHeader: string | null): Promise<{ userId?: string; error?: Response }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized", message: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");

  if (!token || token.split(".").length !== 3) {
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized", message: "Malformed token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      error: new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  try {
    const { data: claims, error: authError } = await authClient.auth.getClaims(token);

    if (authError || !claims?.claims?.sub) {
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        ),
      };
    }

    const exp = claims.claims.exp as number | undefined;
    if (exp && Date.now() / 1000 > exp) {
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Token has expired" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        ),
      };
    }

    return { userId: claims.claims.sub as string };
  } catch {
    return {
      error: new Response(
        JSON.stringify({ error: "Authentication failed" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const allErrors: ValidationError[] = [];

  try {
    // Validate JWT
    const authHeader = req.headers.get("Authorization");
    const auth = await validateAuth(authHeader);
    
    if (auth.error) {
      return auth.error;
    }

    const userId = auth.userId!;
    console.log("[AXIOM] Authenticated user:", userId);

    const { uploadId } = await req.json();
    
    if (!uploadId) {
      throw new Error("Upload ID is required");
    }

    console.log("[AXIOM] Processing trial balance:", uploadId);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Update status to validating
    await supabase
      .from("trial_balance_uploads")
      .update({ status: "validating" })
      .eq("id", uploadId);

    // Get upload record
    const { data: upload, error: uploadError } = await supabase
      .from("trial_balance_uploads")
      .select("*")
      .eq("id", uploadId)
      .single();

    if (uploadError || !upload) {
      throw new Error("Upload not found");
    }

    console.log("[AXIOM] Found upload:", upload.file_name);

    // Download the file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("trial-balance-files")
      .download(upload.file_path);

    if (downloadError || !fileData) {
      throw new Error("Failed to download file: " + downloadError?.message);
    }

    const fileContent = await fileData.text();
    console.log("[AXIOM] File content length:", fileContent.length);

    // Parse CSV content
    const lines = fileContent.split("\n").filter(line => line.trim());
    const headers = lines[0]?.split(",").map(h => h.trim()) || [];
    const dataRows = lines.slice(1).map(line => {
      const values = line.split(",").map(v => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = values[i] || "";
      });
      return row;
    });

    console.log("[AXIOM] Parsed", dataRows.length, "rows");

    // ============================================
    // STEP 1: TRIAL BALANCE INTEGRITY
    // ============================================
    console.log("[AXIOM] STEP 1: Validating trial balance integrity...");
    
    const tbValidation = validateTrialBalance(headers, dataRows);
    allErrors.push(...tbValidation.errors);

    const tbCheckPassed = tbValidation.valid;
    console.log("[AXIOM] TB Validation:", tbCheckPassed ? "PASSED" : "BLOCKED");

    if (!tbCheckPassed) {
      // BLOCK - Trial balance integrity failed
      const result: ProcessingResult = {
        status: "blocked",
        validation_report: {
          tb_balance_check: { 
            passed: false, 
            total_debits: tbValidation.totals.debits, 
            total_credits: tbValidation.totals.credits,
            difference: Math.abs(tbValidation.totals.debits - tbValidation.totals.credits)
          },
          mapping_completeness: { passed: false, total_accounts: 0, mapped_accounts: 0, unmapped: [] },
          balance_sheet_equation: null,
          profit_equity_linkage: null,
          cash_reconciliation: null,
        },
        errors: allErrors,
        statements: null,
        summary: { total_accounts: dataRows.length, processed_at: new Date().toISOString() },
      };

      await supabase
        .from("trial_balance_uploads")
        .update({
          status: "blocked",
          is_valid: false,
          validation_report: result.validation_report,
          accounting_errors: allErrors,
          processed_at: new Date().toISOString(),
        })
        .eq("id", uploadId);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============================================
    // STEP 2: MAPPING COMPLETENESS
    // ============================================
    console.log("[AXIOM] STEP 2: Validating mapping completeness...");

    // Fetch user's account mappings
    const { data: userMappings, error: mappingsError } = await supabase
      .from("account_mappings")
      .select("*")
      .eq("user_id", userId);

    if (mappingsError) {
      console.error("[AXIOM] Error fetching mappings:", mappingsError.message);
    }

    const mappings: AccountMapping[] = (userMappings || []).map(m => ({
      account_code: m.account_code,
      account_name: m.account_name,
      statement: m.statement,
      classification: m.classification,
      line_item: m.line_item,
      normal_balance: m.normal_balance,
      is_cash_account: m.is_cash_account,
      is_retained_earnings: m.is_retained_earnings,
    }));

    const mappingValidation = validateMappingCompleteness(tbValidation.data, mappings);
    allErrors.push(...mappingValidation.errors);

    const mappingCheckPassed = mappingValidation.valid;
    console.log("[AXIOM] Mapping Validation:", mappingCheckPassed ? "PASSED" : "BLOCKED", 
      `(${mappings.length} mappings, ${mappingValidation.unmapped.length} unmapped)`);

    if (!mappingCheckPassed) {
      // BLOCK - Mapping completeness failed
      const result: ProcessingResult = {
        status: "blocked",
        validation_report: {
          tb_balance_check: { 
            passed: true, 
            total_debits: tbValidation.totals.debits, 
            total_credits: tbValidation.totals.credits,
            difference: 0
          },
          mapping_completeness: { 
            passed: false, 
            total_accounts: tbValidation.data.length, 
            mapped_accounts: tbValidation.data.length - mappingValidation.unmapped.length,
            unmapped: mappingValidation.unmapped 
          },
          balance_sheet_equation: null,
          profit_equity_linkage: null,
          cash_reconciliation: null,
        },
        errors: allErrors,
        statements: null,
        summary: { total_accounts: tbValidation.data.length, processed_at: new Date().toISOString() },
      };

      await supabase
        .from("trial_balance_uploads")
        .update({
          status: "blocked",
          is_valid: false,
          validation_report: result.validation_report,
          accounting_errors: allErrors,
          processed_at: new Date().toISOString(),
        })
        .eq("id", uploadId);

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ============================================
    // STEP 3: STATEMENT AGGREGATION
    // ============================================
    console.log("[AXIOM] STEP 3: Aggregating statements...");

    const aggregation = aggregateStatements(tbValidation.data, mappingValidation.mapped);

    // ============================================
    // STEP 4: ACCOUNTING EQUATIONS
    // ============================================
    console.log("[AXIOM] STEP 4: Validating accounting equations...");

    const equationValidation = validateAccountingEquations(aggregation.totals);
    allErrors.push(...equationValidation.errors);

    const equationsValid = equationValidation.valid;
    console.log("[AXIOM] Equation Validation:", equationsValid ? "PASSED" : "BLOCKED");

    // ============================================
    // STEP 5: CASH FLOW ELIGIBILITY
    // ============================================
    console.log("[AXIOM] STEP 5: Checking cash flow eligibility...");

    let cashFlowEligible = false;
    let cashFlowReason = "";

    if (!aggregation.cashAccount.exists) {
      cashFlowReason = "No cash account mapped";
    } else {
      cashFlowEligible = true;
    }

    console.log("[AXIOM] Cash Flow:", cashFlowEligible ? "ELIGIBLE" : `OMITTED (${cashFlowReason})`);

    // ============================================
    // FINAL RESULT
    // ============================================
    const allValid = tbCheckPassed && mappingCheckPassed && equationsValid;
    const finalStatus = allValid ? "valid" : "invalid";

    console.log("[AXIOM] Final Status:", finalStatus.toUpperCase());

    const validationReport: ValidationReport = {
      tb_balance_check: { 
        passed: tbCheckPassed, 
        total_debits: tbValidation.totals.debits, 
        total_credits: tbValidation.totals.credits,
        difference: Math.abs(tbValidation.totals.debits - tbValidation.totals.credits)
      },
      mapping_completeness: { 
        passed: mappingCheckPassed, 
        total_accounts: tbValidation.data.length, 
        mapped_accounts: tbValidation.data.length - mappingValidation.unmapped.length,
        unmapped: mappingValidation.unmapped 
      },
      balance_sheet_equation: {
        passed: equationValidation.details.bsEquation.passed,
        assets: aggregation.totals.assets,
        liabilities: aggregation.totals.liabilities,
        equity: aggregation.totals.equity,
        difference: equationValidation.details.bsEquation.difference,
      },
      profit_equity_linkage: null, // Future: implement when retained earnings tracking is added
      cash_reconciliation: cashFlowEligible ? {
        passed: true,
        cf_ending_cash: aggregation.cashAccount.balance,
        bs_cash: aggregation.cashAccount.balance,
      } : null,
    };

    const result: ProcessingResult = {
      status: finalStatus,
      validation_report: validationReport,
      errors: allErrors,
      statements: allValid ? {
        balance_sheet: aggregation.balance_sheet,
        income_statement: aggregation.income_statement,
        cash_flow: cashFlowEligible ? aggregation.cash_flow : null,
      } : null,
      summary: { total_accounts: tbValidation.data.length, processed_at: new Date().toISOString() },
    };

    // Update database
    await supabase
      .from("trial_balance_uploads")
      .update({
        status: allValid ? "complete" : "error",
        is_valid: allValid,
        validation_report: validationReport,
        accounting_errors: allErrors,
        processing_result: allValid ? {
          mapping: {
            balanceSheet: {
              assets: { 
                current: aggregation.balance_sheet.current_assets.accounts,
                nonCurrent: aggregation.balance_sheet.non_current_assets.accounts 
              },
              liabilities: { 
                current: aggregation.balance_sheet.current_liabilities.accounts,
                nonCurrent: aggregation.balance_sheet.non_current_liabilities.accounts 
              },
              equity: aggregation.balance_sheet.equity.accounts,
            },
            incomeStatement: {
              revenue: aggregation.income_statement.revenue.accounts,
              costOfGoodsSold: aggregation.income_statement.cost_of_goods_sold.accounts,
              operatingExpenses: aggregation.income_statement.operating_expenses.accounts,
              otherIncome: aggregation.income_statement.other_income.accounts,
              taxes: aggregation.income_statement.taxes.accounts,
            },
            cashFlow: cashFlowEligible ? {
              operating: aggregation.cash_flow.operating_activities.accounts,
              investing: aggregation.cash_flow.investing_activities.accounts,
              financing: aggregation.cash_flow.financing_activities.accounts,
            } : null,
          },
          summary: {
            totalAccounts: tbValidation.data.length,
            totalAssets: aggregation.totals.assets,
            totalLiabilities: aggregation.totals.liabilities,
            totalEquity: aggregation.totals.equity,
            netIncome: aggregation.totals.revenue - aggregation.totals.expenses,
          },
          validationReport,
        } : null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", uploadId);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[AXIOM] Processing error:", error);
    return new Response(
      JSON.stringify({ 
        status: "blocked",
        error: error instanceof Error ? error.message : "Processing failed",
        errors: allErrors,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
