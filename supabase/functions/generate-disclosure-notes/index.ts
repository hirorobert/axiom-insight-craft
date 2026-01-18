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

    console.log("Generating disclosure notes for upload:", uploadId);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch the upload with processing result
    const { data: upload, error: fetchError } = await supabase
      .from("trial_balance_uploads")
      .select("*")
      .eq("id", uploadId)
      .single();

    if (fetchError || !upload) {
      throw new Error("Upload not found");
    }

    if (!upload.processing_result?.mapping) {
      throw new Error("No financial mapping available for this upload");
    }

    const mapping = upload.processing_result.mapping;
    const summary = upload.processing_result.summary;

    // Build context from the mapped financial statements
    const financialContext = JSON.stringify({
      balanceSheet: {
        totalAssets: countAccounts(mapping.balanceSheet?.assets),
        totalLiabilities: countAccounts(mapping.balanceSheet?.liabilities),
        totalEquity: mapping.balanceSheet?.equity?.length || 0,
        assets: mapping.balanceSheet?.assets,
        liabilities: mapping.balanceSheet?.liabilities,
        equity: mapping.balanceSheet?.equity,
      },
      incomeStatement: {
        revenue: mapping.incomeStatement?.revenue,
        costOfGoodsSold: mapping.incomeStatement?.costOfGoodsSold,
        operatingExpenses: mapping.incomeStatement?.operatingExpenses,
        otherIncome: mapping.incomeStatement?.otherIncome,
        taxes: mapping.incomeStatement?.taxes,
      },
      cashFlow: mapping.cashFlow,
      summary: summary,
    }, null, 2);

    console.log("Calling Lovable AI for disclosure notes generation...");

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are NoteSynth, an expert financial disclosure notes generator for audit-ready financial statements. 
            
Your task is to generate professional, GAAP/IFRS-compliant disclosure notes based on the provided financial statement mappings.

Generate notes in the following categories:
1. Summary of Significant Accounting Policies
2. Revenue Recognition
3. Property, Plant and Equipment (if applicable)
4. Intangible Assets (if applicable)
5. Accounts Receivable and Allowances
6. Inventory Valuation (if applicable)
7. Long-term Debt and Borrowings
8. Stockholders' Equity
9. Income Taxes
10. Commitments and Contingencies
11. Related Party Transactions
12. Subsequent Events

For each applicable note:
- Provide clear, professional language suitable for audited financial statements
- Include relevant accounting policy descriptions
- Reference specific account categories from the mapped data
- Use appropriate hedging language ("may", "could", "management believes")
- Keep notes concise but comprehensive

Return a JSON object with the following structure:
{
  "notes": [
    {
      "id": "note-1",
      "title": "Note Title",
      "category": "Category Name",
      "content": "Full disclosure note text...",
      "relevance": "high|medium|low",
      "accountsReferenced": ["account1", "account2"]
    }
  ],
  "metadata": {
    "generatedAt": "ISO date",
    "totalNotes": number,
    "framework": "GAAP/IFRS"
  }
}`
          },
          {
            role: "user",
            content: `Generate professional financial disclosure notes based on the following mapped financial statements:

${financialContext}

Company: ${upload.company_name || "Company"}
File: ${upload.file_name}

Please generate all applicable disclosure notes for these financial statements.`
          }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "generate_disclosure_notes",
              description: "Generate structured financial disclosure notes",
              parameters: {
                type: "object",
                properties: {
                  notes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        title: { type: "string" },
                        category: { type: "string" },
                        content: { type: "string" },
                        relevance: { type: "string", enum: ["high", "medium", "low"] },
                        accountsReferenced: { type: "array", items: { type: "string" } }
                      },
                      required: ["id", "title", "category", "content", "relevance"]
                    }
                  },
                  metadata: {
                    type: "object",
                    properties: {
                      generatedAt: { type: "string" },
                      totalNotes: { type: "number" },
                      framework: { type: "string" }
                    },
                    required: ["generatedAt", "totalNotes", "framework"]
                  }
                },
                required: ["notes", "metadata"]
              }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "generate_disclosure_notes" } }
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (aiResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add funds to continue." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      throw new Error(`AI API error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log("AI response received");

    let disclosureNotes;
    
    // Extract from tool call response
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      disclosureNotes = JSON.parse(toolCall.function.arguments);
    } else {
      throw new Error("Failed to parse AI response");
    }

    // Update the upload record with the disclosure notes
    const updatedResult = {
      ...upload.processing_result,
      disclosureNotes: disclosureNotes
    };

    const { error: updateError } = await supabase
      .from("trial_balance_uploads")
      .update({ processing_result: updatedResult })
      .eq("id", uploadId);

    if (updateError) {
      console.error("Error updating upload:", updateError);
      throw new Error("Failed to save disclosure notes");
    }

    console.log("Disclosure notes generated successfully:", disclosureNotes.notes?.length, "notes");

    return new Response(
      JSON.stringify({ 
        success: true, 
        notes: disclosureNotes.notes,
        metadata: disclosureNotes.metadata
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error generating disclosure notes:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to generate disclosure notes";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function countAccounts(category: any): number {
  if (!category) return 0;
  let count = 0;
  if (category.current) count += category.current.length;
  if (category.nonCurrent) count += category.nonCurrent.length;
  return count;
}
