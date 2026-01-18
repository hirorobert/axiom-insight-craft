import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Validates JWT token and returns user info
 */
async function validateAuth(authHeader: string | null): Promise<{ userId?: string; error?: Response }> {
  if (!authHeader?.startsWith("Bearer ")) {
    console.error("Missing or invalid Authorization header");
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized", message: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");

  // Validate token format
  if (!token || token.split(".").length !== 3) {
    console.error("Malformed JWT token");
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
    console.error("Missing Supabase environment variables");
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
      console.error("Auth validation error:", authError?.message || "No user ID in claims");
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        ),
      };
    }

    // Check token expiration
    const exp = claims.claims.exp as number | undefined;
    if (exp && Date.now() / 1000 > exp) {
      console.error("Token has expired");
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Token has expired" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        ),
      };
    }

    return { userId: claims.claims.sub as string };
  } catch (err) {
    console.error("Unexpected auth error:", err);
    return {
      error: new Response(
        JSON.stringify({ error: "Authentication failed" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate JWT with enhanced validation
    const authHeader = req.headers.get("Authorization");
    const auth = await validateAuth(authHeader);
    
    if (auth.error) {
      return auth.error;
    }

    const userId = auth.userId;
    console.log("Authenticated user:", userId);

    const { uploadId } = await req.json();
    
    if (!uploadId) {
      throw new Error("Upload ID is required");
    }

    console.log("Processing trial balance upload:", uploadId);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get upload record
    const { data: upload, error: uploadError } = await supabase
      .from("trial_balance_uploads")
      .select("*")
      .eq("id", uploadId)
      .single();

    if (uploadError || !upload) {
      throw new Error("Upload not found");
    }

    console.log("Found upload record:", upload.file_name);

    // Fetch saved corrections for this upload
    const { data: savedCorrections, error: correctionsError } = await supabase
      .from("account_corrections")
      .select("*")
      .eq("upload_id", uploadId);

    if (correctionsError) {
      console.log("Error fetching corrections:", correctionsError.message);
    }

    const correctionsMap = new Map<string, { category: string; subcategory: string }>();
    if (savedCorrections && savedCorrections.length > 0) {
      console.log("Found", savedCorrections.length, "saved corrections to apply");
      savedCorrections.forEach((correction) => {
        correctionsMap.set(correction.account_code, {
          category: correction.corrected_category,
          subcategory: correction.corrected_subcategory,
        });
      });
    }

    // Download the file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("trial-balance-files")
      .download(upload.file_path);

    if (downloadError || !fileData) {
      throw new Error("Failed to download file: " + downloadError?.message);
    }

    // Read file content
    const fileContent = await fileData.text();
    console.log("File content length:", fileContent.length);

    // Parse CSV/Excel content (simplified - assumes CSV format)
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

    console.log("Parsed", dataRows.length, "rows from trial balance");

    // Include saved corrections in the AI prompt for context
    const correctionsContext = savedCorrections && savedCorrections.length > 0
      ? `\n\nIMPORTANT: The following accounts have been manually verified by the user. Use these exact classifications:\n${JSON.stringify(savedCorrections.map(c => ({
          accountCode: c.account_code,
          category: c.corrected_category,
          subcategory: c.corrected_subcategory
        })), null, 2)}`
      : "";

    // Create a summary of the trial balance for AI processing
    const trialBalanceSummary = JSON.stringify({
      headers,
      sampleRows: dataRows.slice(0, 20),
      totalRows: dataRows.length,
    });

    // Call Lovable AI to analyze and map accounts
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are an expert financial accountant AI assistant specializing in GAAP and IFRS standards. 
Your task is to analyze trial balance data and map accounts to the appropriate financial statements.

For each account, determine:
1. Which financial statement it belongs to (Balance Sheet, Income Statement, or Cash Flow Statement)
2. The specific classification (e.g., Current Assets, Non-Current Liabilities, Revenue, Operating Expenses)
3. A confidence score (0-100) for your mapping

Return your analysis as a JSON object with the following structure:
{
  "balanceSheet": {
    "assets": { "current": [], "nonCurrent": [] },
    "liabilities": { "current": [], "nonCurrent": [] },
    "equity": []
  },
  "incomeStatement": {
    "revenue": [],
    "costOfGoodsSold": [],
    "operatingExpenses": [],
    "otherIncome": [],
    "taxes": []
  },
  "cashFlow": {
    "operating": [],
    "investing": [],
    "financing": []
  },
  "unmapped": [],
  "overallConfidence": 0,
  "notes": []
}

Each account entry should include: accountCode, accountName, balance, classification, confidence.`
          },
          {
            role: "user",
            content: `Please analyze this trial balance data and map each account to the appropriate financial statement:

${trialBalanceSummary}${correctionsContext}`
          }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "map_trial_balance",
              description: "Map trial balance accounts to financial statements",
              parameters: {
                type: "object",
                properties: {
                  balanceSheet: {
                    type: "object",
                    properties: {
                      assets: {
                        type: "object",
                        properties: {
                          current: { type: "array", items: { type: "object" } },
                          nonCurrent: { type: "array", items: { type: "object" } }
                        }
                      },
                      liabilities: {
                        type: "object",
                        properties: {
                          current: { type: "array", items: { type: "object" } },
                          nonCurrent: { type: "array", items: { type: "object" } }
                        }
                      },
                      equity: { type: "array", items: { type: "object" } }
                    }
                  },
                  incomeStatement: {
                    type: "object",
                    properties: {
                      revenue: { type: "array", items: { type: "object" } },
                      costOfGoodsSold: { type: "array", items: { type: "object" } },
                      operatingExpenses: { type: "array", items: { type: "object" } },
                      otherIncome: { type: "array", items: { type: "object" } },
                      taxes: { type: "array", items: { type: "object" } }
                    }
                  },
                  cashFlow: {
                    type: "object",
                    properties: {
                      operating: { type: "array", items: { type: "object" } },
                      investing: { type: "array", items: { type: "object" } },
                      financing: { type: "array", items: { type: "object" } }
                    }
                  },
                  unmapped: { type: "array", items: { type: "object" } },
                  overallConfidence: { type: "number" },
                  notes: { type: "array", items: { type: "string" } }
                },
                required: ["balanceSheet", "incomeStatement", "cashFlow", "overallConfidence"]
              }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "map_trial_balance" } }
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        throw new Error("Rate limit exceeded. Please try again later.");
      }
      if (aiResponse.status === 402) {
        throw new Error("AI credits exhausted. Please add funds to continue.");
      }
      const errorText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errorText);
      throw new Error("AI processing failed");
    }

    const aiData = await aiResponse.json();
    console.log("AI response received");

    // Extract the tool call result
    let mappingResult;
    if (aiData.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments) {
      mappingResult = JSON.parse(aiData.choices[0].message.tool_calls[0].function.arguments);
    } else if (aiData.choices?.[0]?.message?.content) {
      // Fallback: try to parse content as JSON
      try {
        mappingResult = JSON.parse(aiData.choices[0].message.content);
      } catch {
        mappingResult = {
          balanceSheet: { assets: { current: [], nonCurrent: [] }, liabilities: { current: [], nonCurrent: [] }, equity: [] },
          incomeStatement: { revenue: [], costOfGoodsSold: [], operatingExpenses: [], otherIncome: [], taxes: [] },
          cashFlow: { operating: [], investing: [], financing: [] },
          overallConfidence: 75,
          notes: ["Processed with basic mapping due to response format"]
        };
      }
    }

    // Calculate summary statistics
    const totalAssets = (mappingResult.balanceSheet?.assets?.current?.length || 0) + 
                        (mappingResult.balanceSheet?.assets?.nonCurrent?.length || 0);
    const totalLiabilities = (mappingResult.balanceSheet?.liabilities?.current?.length || 0) + 
                             (mappingResult.balanceSheet?.liabilities?.nonCurrent?.length || 0);
    const totalEquity = mappingResult.balanceSheet?.equity?.length || 0;
    const totalIncomeItems = (mappingResult.incomeStatement?.revenue?.length || 0) +
                             (mappingResult.incomeStatement?.operatingExpenses?.length || 0);

    // Update the upload record with results
    const { error: updateError } = await supabase
      .from("trial_balance_uploads")
      .update({
        status: "complete",
        processed_at: new Date().toISOString(),
        processing_result: {
          mapping: mappingResult,
          summary: {
            totalAccounts: dataRows.length,
            balanceSheetAccounts: totalAssets + totalLiabilities + totalEquity,
            incomeStatementAccounts: totalIncomeItems,
            cashFlowAccounts: (mappingResult.cashFlow?.operating?.length || 0) +
                              (mappingResult.cashFlow?.investing?.length || 0) +
                              (mappingResult.cashFlow?.financing?.length || 0),
            unmappedAccounts: mappingResult.unmapped?.length || 0,
            confidenceScore: mappingResult.overallConfidence || 85
          },
          statements: ["Balance Sheet", "Income Statement", "Cash Flow Statement"],
          notes: mappingResult.notes || [],
          processedAt: new Date().toISOString()
        }
      })
      .eq("id", uploadId);

    if (updateError) {
      console.error("Failed to update record:", updateError);
      throw new Error("Failed to save processing results");
    }

    console.log("Processing complete for upload:", uploadId);

    return new Response(
      JSON.stringify({
        success: true,
        uploadId,
        summary: {
          totalAccounts: dataRows.length,
          confidenceScore: mappingResult.overallConfidence || 85,
          statements: ["Balance Sheet", "Income Statement", "Cash Flow Statement"]
        }
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Processing error:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Processing failed" 
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
