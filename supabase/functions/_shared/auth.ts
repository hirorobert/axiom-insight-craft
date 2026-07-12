import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthResult {
  userId: string;
  email?: string;
}

export interface AuthError {
  error: string;
  status: number;
}

/**
 * Validates JWT token from Authorization header and returns user info.
 * Returns either AuthResult on success or AuthError on failure.
 */
export async function validateAuth(
  authHeader: string | null,
  corsHeaders: Record<string, string>
): Promise<{ result?: AuthResult; error?: Response }> {
  // Check for Authorization header
  if (!authHeader?.startsWith("Bearer ")) {
    console.error("Missing or invalid Authorization header");
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized", message: "Missing or invalid authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");

  // Validate token is not empty or malformed
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

    if (authError) {
      console.error("Auth validation error:", authError.message);
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Invalid or expired token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        ),
      };
    }

    if (!claims?.claims?.sub) {
      console.error("No user ID in claims");
      return {
        error: new Response(
          JSON.stringify({ error: "Unauthorized", message: "Invalid token claims" }),
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

    return {
      result: {
        userId: claims.claims.sub as string,
        email: claims.claims.email as string | undefined,
      },
    };
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

/**
 * Standard CORS headers for edge functions
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Handle CORS preflight request
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

/**
 * Verify the authenticated caller is a firm member of the target company.
 * Returns a 403 Response if not a member; undefined on success.
 * Uses the service-role admin client for the lookup so RLS cannot mask denial.
 */
export async function assertCompanyMembership(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  companyId: string,
): Promise<Response | undefined> {
  if (!companyId) {
    return new Response(
      JSON.stringify({ error: "Forbidden", message: "Missing company context" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const { data, error } = await adminClient
    .from("firm_members")
    .select("id")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .not("accepted_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return new Response(
      JSON.stringify({ error: "Forbidden", message: "Not a member of this company" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  return undefined;
}
