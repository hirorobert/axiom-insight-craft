// Browser side of the anti-abuse challenge. The browser only DISPLAYS the widget and forwards its response token; whether the
// token is genuine is decided by the server (submit-service-enquiry verifies it with the provider). Nothing here is trusted
// by the server, and nothing here can turn the check off: a signed-in user's requests skip it only because the SERVER verifies
// their session, and a missing site key makes the form refuse to send rather than send unprotected.

import { CHALLENGE_ACTION } from "./contract";

/** A public Turnstile site key looks like `0x4AAAAAAA…` (or a documented test key `1x0000…AA`). Anything else is treated as absent. */
const SITE_KEY = /^[0-9A-Za-z_-]{8,100}$/;

export function readSiteKey(raw: unknown): string | null {
  return typeof raw === "string" && SITE_KEY.test(raw.trim()) ? raw.trim() : null;
}

/** The public site key installed at build time (VITE_TURNSTILE_SITE_KEY). It is public by design; the SECRET key is server-only. */
export const CHALLENGE_SITE_KEY: string | null = readSiteKey((import.meta.env as Record<string, unknown>).VITE_TURNSTILE_SITE_KEY);

export type ChallengeState =
  | "not_needed" // a signed-in user: protected by rate limits and idempotency
  | "required" // an anonymous visitor (or a session the server did not accept): show the widget and send its token
  | "unavailable"; // a challenge is required but this build has no site key: refuse to send

export function challengeState(input: { signedIn: boolean; forced: boolean; siteKey: string | null }): ChallengeState {
  if (input.signedIn && !input.forced) return "not_needed";
  return input.siteKey ? "required" : "unavailable";
}

// ── script loader (only ever runs when a form that needs a challenge is on screen) ─────────────────────────────────────────

export interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window !== "undefined" && window.turnstile) return Promise.resolve(window.turnstile);
  return (loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing")));
    script.onerror = () => {
      loading = null; // a later attempt may succeed
      reject(new Error("turnstile_load_failed"));
    };
    document.head.appendChild(script);
  }));
}

export { CHALLENGE_ACTION };
