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

// ── widget failure reporting ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Turnstile reports a client failure as a numeric code (110200 "domain not authorized", 110100/110110 "invalid sitekey",
 * 200500 "iframe load error", 300xxx/600xxx "challenge failure", …). The code identifies the cause and is safe to keep and show:
 * it carries no token, key, address or user data. Anything that is not a plain 3-6 digit code is dropped, never displayed.
 */
export function sanitizeChallengeErrorCode(raw: unknown): string | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return /^[0-9]{3,6}$/.test(text) ? text : null;
}

/** `render()` can throw a TurnstileError whose message carries the code, e.g. "[Cloudflare Turnstile] Error: 110200.". */
export function challengeErrorCodeFromThrown(thrown: unknown): string | null {
  const message = thrown instanceof Error ? thrown.message : typeof thrown === "string" ? thrown : "";
  const m = /\b([0-9]{6})\b/.exec(message);
  return m ? m[1] : null;
}

export type ChallengeFailureKind = "configuration" | "blocked" | "expired" | "challenge" | "unknown";

/** Coarse, honest classification of a Turnstile code, so the message can say what KIND of problem it is. */
export function classifyChallengeError(code: string | null): ChallengeFailureKind {
  if (code === null) return "unknown";
  if (["110100", "110110", "110200", "400020", "400070"].includes(code)) return "configuration";
  if (["110600", "110620", "200100"].includes(code)) return "expired";
  if (code.startsWith("2005")) return "blocked";
  if (code.startsWith("3") || code.startsWith("6")) return "challenge";
  return "unknown";
}

export type WidgetState =
  | { readonly phase: "loading"; readonly errorCode: null }
  | { readonly phase: "ready"; readonly errorCode: null }
  | { readonly phase: "failed"; readonly errorCode: string | null };

export type WidgetEvent =
  | { readonly type: "loading" }
  | { readonly type: "rendered" }
  | { readonly type: "solved" }
  | { readonly type: "error"; readonly code: string | null };

export const WIDGET_INITIAL: WidgetState = { phase: "loading", errorCode: null };

/**
 * Pure state machine for the widget's visible state. The error CODE is preserved (never discarded), and a later successful
 * solve clears an earlier error: Turnstile retries some failures itself, so a stale "could not be loaded" banner must not
 * outlive a widget that then worked. Nothing here holds a token.
 */
export function widgetReducer(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case "loading":
      return WIDGET_INITIAL;
    case "rendered":
      return state.phase === "failed" ? state : { phase: "ready", errorCode: null };
    case "solved":
      return { phase: "ready", errorCode: null };
    case "error":
      return { phase: "failed", errorCode: event.code };
  }
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
