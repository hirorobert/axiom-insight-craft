// Real dependencies for the service-enquiry Edge Functions (Deno only — the pure logic is in serviceEnquiryHandler.ts and is
// unit-tested there). Secrets are read from the function environment and never logged or returned.
//
// Configuration (all optional; absence fails SAFE and is reported truthfully to the requester):
//   ENQUIRY_EMAIL_ENABLED=true          switch on application email (requires LOVABLE_API_KEY, the platform key the auth hook already uses)
//   ENQUIRY_INTERNAL_NOTIFY_TO=<addr>   internal notification destination — never guessed; without it no internal email is attempted
//   LOVABLE_SEND_URL                    optional override, same variable the auth hook honours
//
// Anti-abuse challenge for ANONYMOUS submissions (unlike the email settings above, absence here refuses anonymous enquiries):
//   TURNSTILE_SECRET_KEY                Cloudflare Turnstile secret. Server-side only; never returned or logged.
//   TURNSTILE_EXPECTED_HOSTNAMES        optional, comma separated; when set, a token issued for any other hostname is refused
//   ENQUIRY_CHALLENGE_MODE              unset/"turnstile" (default) or "bypass_for_local_development" — the bypass is honoured ONLY
//                                       when SUPABASE_URL is a local stack; on a hosted project it is an error and enquiries are refused

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendLovableEmail } from "npm:@lovable.dev/email-js@0.1.0";
import type { DispatchDeps } from "./serviceEnquiryHandler.ts";
import { createChallengeVerifier, resolveChallengeConfig, type FetchLike } from "./serviceEnquiryChallenge.ts";

export function buildEnquiryDeps(): DispatchDeps {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const emailKey = Deno.env.get("LOVABLE_API_KEY") ?? "";
  const emailEnabled = Deno.env.get("ENQUIRY_EMAIL_ENABLED") === "true" && emailKey !== "";

  // Resolved once. Missing/unsafe configuration yields a verifier that refuses every anonymous submission (fail closed).
  const challenge = createChallengeVerifier(resolveChallengeConfig({ get: (name) => Deno.env.get(name) }), fetch as unknown as FetchLike);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let hmacKey: Promise<CryptoKey> | null = null;
  const getHmacKey = () =>
    (hmacKey ??= crypto.subtle.importKey("raw", new TextEncoder().encode(`cfoclose:service-enquiry:v1:${serviceKey}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  const userClient = (token: string) =>
    createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

  return {
    challenge,

    async rpc(fn, args) {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error: error ? { code: error.code, message: error.message } : null };
    },

    async verifyUserId(token) {
      const { data, error } = await userClient(token).auth.getClaims(token);
      const claims = data?.claims;
      if (error || !claims) return null;
      return claims.role === "authenticated" && typeof claims.sub === "string" ? claims.sub : null;
    },

    async isPlatformStaff(token) {
      const { data, error } = await userClient(token).rpc("current_platform_staff_role");
      return !error && typeof data === "string" && data.length > 0;
    },

    async hmacHex(purpose, value) {
      const sig = await crypto.subtle.sign("HMAC", await getHmacKey(), new TextEncoder().encode(`${purpose}:${value}`));
      return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
    },

    sendEmail: emailEnabled
      ? async (m) => {
          const r = await sendLovableEmail(
            { to: m.to, from: m.from, sender_domain: m.senderDomain, subject: m.subject, html: m.html, text: m.text, purpose: m.purpose, idempotency_key: m.idempotencyKey, label: "service-enquiry" },
            { apiKey: emailKey, sendUrl: Deno.env.get("LOVABLE_SEND_URL") },
          );
          if (!r.success) throw new Error("provider_rejected");
          return { providerMessageId: r.message_id ?? null };
        }
      : undefined,

    internalRecipient: (Deno.env.get("ENQUIRY_INTERNAL_NOTIFY_TO") ?? "").trim() || null,

    // Events carry codes and a correlation id only — never a message, address, token, payload or IP.
    log: (event) => console.log(JSON.stringify(event)),
    correlationId: () => `enq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}
