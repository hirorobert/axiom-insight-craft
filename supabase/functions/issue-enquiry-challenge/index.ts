// issue-enquiry-challenge — mints the first-party attestation challenge used when the third-party security-check widget cannot
// be reached (see _shared/enquiryAttestation.ts). It returns ONLY a signed, short-lived, public challenge: no secret, no
// identity, nothing about the caller. The signing secret never leaves the function environment, and minting a challenge grants
// nothing on its own — submit-service-enquiry still re-verifies the signature and the browser's work before any row is written.

import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { ATTESTATION_BITS, ATTESTATION_TTL_MS, ENV_ATTESTATION_SECRET, issueAttestation, readAttestationSecret } from "../_shared/enquiryAttestation.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return json(405, { ok: false, code: "method_not_allowed" });

  const secret = readAttestationSecret(Deno.env.get(ENV_ATTESTATION_SECRET));
  if (!secret) {
    // Fail closed and say so plainly: the caller falls back to the widget rather than being handed an unusable challenge.
    console.error(JSON.stringify({ event: "enquiry.attestation.issue", outcome: "unavailable", reason: "not_configured" }));
    return json(503, { ok: false, code: "attestation_unavailable" });
  }

  try {
    const issued = await issueAttestation(secret);
    return json(200, { ok: true, challenge: issued.challenge, bits: issued.bits, expires_at: issued.expiresAt, ttl_ms: ATTESTATION_TTL_MS, required_bits: ATTESTATION_BITS });
  } catch {
    console.error(JSON.stringify({ event: "enquiry.attestation.issue", outcome: "unavailable", reason: "mint_failed" }));
    return json(503, { ok: false, code: "attestation_unavailable" });
  }
});
