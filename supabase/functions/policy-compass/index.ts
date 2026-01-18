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

    const { question, context, financialData } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    console.log("Policy Compass request:", { question, hasContext: !!context, hasFinancialData: !!financialData });

    const systemPrompt = `You are Policy Compass, an expert accounting policy advisor. Your role is to provide structured, decision-tree guidance for accounting policy questions with ranked evidence from authoritative sources.

For each question, provide:
1. A clear decision path with numbered steps
2. Relevant accounting standards (GAAP/IFRS) with specific citations
3. Evidence ranked by relevance and authority
4. Practical implementation guidance
5. Common pitfalls to avoid

Format your response as JSON with this structure:
{
  "decision": {
    "title": "Policy Decision Title",
    "summary": "Brief summary of the recommended approach",
    "confidence": "high" | "medium" | "low"
  },
  "decisionTree": [
    {
      "step": 1,
      "question": "First decision point question",
      "options": [
        {"label": "Option A", "leads_to": 2, "description": "When to choose this"},
        {"label": "Option B", "leads_to": 3, "description": "When to choose this"}
      ]
    }
  ],
  "evidence": [
    {
      "rank": 1,
      "source": "ASC 606-10-25-1",
      "authority": "FASB",
      "relevance": "high",
      "summary": "Key guidance excerpt"
    }
  ],
  "implementation": [
    "Step-by-step implementation guidance"
  ],
  "pitfalls": [
    "Common mistake to avoid"
  ]
}

Always cite specific standards and provide practical, actionable guidance.`;

    const userPrompt = context 
      ? `Question: ${question}\n\nFinancial Context:\n${JSON.stringify(financialData, null, 2)}\n\nAdditional Context: ${context}`
      : `Question: ${question}${financialData ? `\n\nFinancial Context:\n${JSON.stringify(financialData, null, 2)}` : ""}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required. Please add funds to continue." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("No content in AI response");
    }

    // Parse JSON from the response
    let policyGuidance;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        policyGuidance = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error("Failed to parse AI response as JSON:", parseError);
      // Return a structured fallback
      policyGuidance = {
        decision: {
          title: "Policy Analysis",
          summary: content,
          confidence: "medium"
        },
        decisionTree: [],
        evidence: [],
        implementation: [content],
        pitfalls: []
      };
    }

    console.log("Policy Compass response generated successfully");

    return new Response(JSON.stringify({ guidance: policyGuidance }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Policy Compass error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
