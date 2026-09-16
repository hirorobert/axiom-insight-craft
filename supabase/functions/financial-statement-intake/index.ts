// financial-statement-intake — Ω∞ CFOCLOSE Document Review.
//
// Thin Deno.serve wiring only: authenticates, parses the multipart form,
// constructs the real service-role admin client, and delegates to
// handleIntake.ts for the actual orchestration (kept in its own
// side-effect-free module so it can be imported and unit-tested — via real,
// executed `deno test` — without binding a network listener or reaching
// @supabase/supabase-js's full dependency tree; see handleIntake.ts's own
// header for why that separation matters).
//
// Verification: `deno check index.ts` and `deno test` both pass for real in
// this function's directory — see the session's final report for the
// actual executed output. No "not tested, Deno unavailable" disclaimer
// applies to this function.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateAuth, corsHeaders, handleCors } from "../_shared/auth.ts";
import { resolveFirmMemberActor } from "../_shared/actor.ts";
import { sha256HexBytes } from "../_shared/hash.ts";
import { scanForMalware } from "./scanForMalware.ts";
import { handleIntake, type AdminClientLike } from "./handleIntake.ts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "MethodNotAllowed" }, 405);
  }

  // Step 1: authenticate.
  const { result: auth, error: authError } = await validateAuth(req.headers.get("Authorization"), corsHeaders);
  if (authError) return authError;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "ServerConfigurationError" }, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: "BadRequest", message: "Expected multipart/form-data." }, 400);
  }

  const companyId = String(form.get("companyId") ?? "");
  const periodYear = Number.parseInt(String(form.get("periodYear") ?? ""), 10);
  const artifactClassHint = form.get("artifactClassHint");
  const file = form.get("file");

  if (!companyId || !Number.isFinite(periodYear)) {
    return jsonResponse({ error: "BadRequest", message: "companyId and periodYear are required." }, 400);
  }
  if (!(file instanceof File)) {
    return jsonResponse({ error: "BadRequest", message: "No file was received." }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  return handleIntake(
    {
      resolveFirmMemberActor,
      scanForMalware,
      sha256HexBytes,
      admin: admin as unknown as AdminClientLike,
      malwareScanWebhookUrl: Deno.env.get("MALWARE_SCAN_WEBHOOK_URL"),
    },
    {
      userId: auth!.userId,
      companyId,
      periodYear,
      file: { name: file.name, type: file.type, size: file.size, bytes },
      artifactClassHint: typeof artifactClassHint === "string" ? artifactClassHint : undefined,
    },
  );
});
