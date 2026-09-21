// The anti-abuse challenge boundary for anonymous enquiry submissions: a provider-neutral verifier contract, a Cloudflare
// Turnstile implementation of it, and the fail-closed configuration rules. Pure and dependency-injected (fetch and the
// environment are passed in), so every state is unit-testable without a Deno runtime.
//
// No approved CAPTCHA provider existed in this repository or its Lovable-managed configuration (no provider script, secret,
// auth.captcha setting or dependency anywhere), so Turnstile is integrated here — behind ChallengeVerifier, so a different
// provider is a new implementation of one small interface and changes nothing else.
//
// Guarantees (each has a test):
//   * the browser's token is only ever a CLAIM: success is decided by a server-to-provider call, never by a browser flag;
//   * the secret key exists only in the function environment: it is not returned, logged or put in any error;
//   * a missing, malformed or unsafe production configuration FAILS CLOSED — there is no silent development default;
//   * development bypass is explicit AND is honoured only on a local stack, so it cannot carry into a hosted project;
//   * timeout, provider outage, malformed provider response, replay and expiry all end in a refusal, never a pass;
//   * neither the token nor any network identifier is logged or sent to the provider (the optional remoteip is deliberately
//     omitted: verification does not need it and it keeps every client address inside this system).

import { CHALLENGE_ACTION } from "./serviceEnquiryContract.ts";

export type ChallengeVerdict =
  | { readonly kind: "passed" }
  /** The visitor's token is unusable: absent, invalid, expired or already used (replay). Ask them to complete the check again. */
  | { readonly kind: "rejected"; readonly reason: "missing" | "invalid" | "expired_or_replayed" }
  /** We could not reach a verdict. Never a pass: the submission is refused and the visitor may retry. */
  | { readonly kind: "unavailable"; readonly reason: "not_configured" | "misconfigured" | "timeout" | "provider_error" | "malformed_response" };

export interface ChallengeVerifier {
  readonly provider: string;
  /** Never throws. `token` is the untrusted browser-supplied response, or null when none was sent. */
  verify(token: string | null): Promise<ChallengeVerdict>;
}

// ── configuration ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnvReader {
  get(name: string): string | undefined;
}

export type ChallengeConfig =
  | { readonly mode: "turnstile"; readonly secret: string; readonly expectedHostnames: readonly string[] }
  | { readonly mode: "bypass_local_development" }
  | { readonly mode: "unconfigured"; readonly reason: "missing_secret" | "invalid_secret" | "invalid_mode" | "unsafe_bypass" | "test_secret_outside_local" };

export const ENV_MODE = "ENQUIRY_CHALLENGE_MODE"; // unset | "turnstile" | "bypass_for_local_development"
export const ENV_SECRET = "TURNSTILE_SECRET_KEY";
export const ENV_HOSTNAMES = "TURNSTILE_EXPECTED_HOSTNAMES"; // optional, comma separated; when set the token's hostname must match
export const BYPASS_MODE_VALUE = "bypass_for_local_development";

/** Hosts a local Supabase stack answers on. A hosted project's URL is never one of these. */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1", "kong", "host.docker.internal", "supabase_kong_axiom-insight-craft"];

export function isLocalStack(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  try {
    const u = new URL(supabaseUrl);
    return LOCAL_HOSTS.includes(u.hostname.toLowerCase()) || u.hostname.toLowerCase().endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Cloudflare's published dummy secrets: 1x… always passes, 2x… always fails, 3x… yields a spent-token error. */
const CLOUDFLARE_TEST_SECRET = /^[123]x0{20,}[A-Za-z]{2}$/;

export function resolveChallengeConfig(env: EnvReader): ChallengeConfig {
  const local = isLocalStack(env.get("SUPABASE_URL"));
  const modeRaw = (env.get(ENV_MODE) ?? "").trim();

  if (modeRaw === BYPASS_MODE_VALUE) {
    // Explicit, and only honoured where it provably cannot be production. Elsewhere it is a configuration error, and the
    // endpoint refuses anonymous submissions rather than quietly running unprotected.
    return local ? { mode: "bypass_local_development" } : { mode: "unconfigured", reason: "unsafe_bypass" };
  }
  if (modeRaw !== "" && modeRaw !== "turnstile") return { mode: "unconfigured", reason: "invalid_mode" };

  const secret = (env.get(ENV_SECRET) ?? "").trim();
  if (secret === "") return { mode: "unconfigured", reason: "missing_secret" };
  if (secret.length < 16 || secret.length > 200 || /\s/.test(secret)) return { mode: "unconfigured", reason: "invalid_secret" };
  if (CLOUDFLARE_TEST_SECRET.test(secret) && !local) return { mode: "unconfigured", reason: "test_secret_outside_local" }; // the "always passes" key must never reach a hosted project

  const expectedHostnames = (env.get(ENV_HOSTNAMES) ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return { mode: "turnstile", secret, expectedHostnames };
}

// ── verifiers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const DEFAULT_VERIFY_TIMEOUT_MS = 3000;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const unavailable = (reason: Extract<ChallengeVerdict, { kind: "unavailable" }>["reason"]): ChallengeVerdict => ({ kind: "unavailable", reason });

/** Maps Turnstile's documented error codes. Anything unrecognised is "provider_error" — never a pass, never blamed on the visitor. */
function interpretErrorCodes(codes: readonly string[]): ChallengeVerdict {
  if (codes.includes("timeout-or-duplicate")) return { kind: "rejected", reason: "expired_or_replayed" };
  if (codes.includes("missing-input-response")) return { kind: "rejected", reason: "missing" };
  if (codes.includes("invalid-input-response")) return { kind: "rejected", reason: "invalid" };
  if (codes.includes("invalid-input-secret") || codes.includes("missing-input-secret")) return unavailable("misconfigured");
  return unavailable("provider_error"); // bad-request, internal-error, or something new
}

export function createTurnstileVerifier(config: { secret: string; expectedHostnames: readonly string[] }, fetchImpl: FetchLike, timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS): ChallengeVerifier {
  return {
    provider: "turnstile",
    async verify(token) {
      if (typeof token !== "string" || token === "") return { kind: "rejected", reason: "missing" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // The secret and the token go to the provider over TLS in the request body; nothing else is sent (no address).
        const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: config.secret, response: token }).toString(),
          signal: controller.signal,
        });
        const text = await res.text();
        if (text.length > MAX_PROVIDER_RESPONSE_BYTES) return unavailable("malformed_response");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return unavailable(res.ok ? "malformed_response" : "provider_error");
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return unavailable("malformed_response");
        const b = body as Record<string, unknown>;
        if (typeof b.success !== "boolean") return unavailable("malformed_response");

        if (b.success === false) {
          const codes = Array.isArray(b["error-codes"]) ? (b["error-codes"] as unknown[]).filter((c): c is string => typeof c === "string") : [];
          return interpretErrorCodes(codes);
        }
        // success === true, but the HTTP status must agree — a 5xx that carries a success body is not trusted.
        if (!res.ok) return unavailable("provider_error");
        // A token minted for another widget action, or on a hostname we do not serve, is not a valid answer to OUR challenge.
        if (typeof b.action === "string" && b.action !== CHALLENGE_ACTION) return { kind: "rejected", reason: "invalid" };
        if (config.expectedHostnames.length > 0) {
          const host = typeof b.hostname === "string" ? b.hostname.toLowerCase() : "";
          if (!config.expectedHostnames.includes(host)) return { kind: "rejected", reason: "invalid" };
        }
        return { kind: "passed" };
      } catch {
        // Aborted (timeout) or the network failed. The message is never inspected or logged: it could echo a URL.
        return unavailable(controller.signal.aborted ? "timeout" : "provider_error");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Refuses every anonymous submission. Used when configuration is missing or unsafe: fail closed, never open. */
export function createUnconfiguredVerifier(reason: "not_configured" | "misconfigured" = "not_configured"): ChallengeVerifier {
  return { provider: "unconfigured", verify: async () => unavailable(reason) };
}

/** Local development only (see resolveChallengeConfig). Still requires a token to be present, so the flow is exercised end to end. */
export function createLocalBypassVerifier(): ChallengeVerifier {
  return { provider: "bypass_local_development", verify: async (token) => (typeof token === "string" && token !== "" ? { kind: "passed" } : { kind: "rejected", reason: "missing" }) };
}

export function createChallengeVerifier(config: ChallengeConfig, fetchImpl: FetchLike, timeoutMs?: number): ChallengeVerifier {
  switch (config.mode) {
    case "turnstile":
      return createTurnstileVerifier(config, fetchImpl, timeoutMs);
    case "bypass_local_development":
      return createLocalBypassVerifier();
    default:
      return createUnconfiguredVerifier(config.reason === "missing_secret" ? "not_configured" : "misconfigured");
  }
}
