/**
 * D3 compensating controls (client side). The hosted API (Supabase PostgREST /rest/v1, Auth /auth/v1, Functions /functions/v1)
 * sends no `Cache-Control: no-store` today, and the platform setting that would add it is not available to this project
 * (ALTER ROLE authenticator is superuser-only; escalated to Lovable). These controls DO NOT set any HTTP response header and do
 * not change what an intermediary may do; they only stop THIS browser from storing or re-showing signed-in data:
 *
 *  1. every request to the project's Supabase origin is made with `cache: "no-store"` (the browser neither reads nor writes its
 *     HTTP cache for it);
 *  2. on sign-out, session expiry or an account switch, the in-memory query cache and the user-scoped application keys of the
 *     tab's sessionStorage are cleared, and an account switch reloads the page so no component keeps the previous user's data;
 *  3. a page restored from the back/forward cache is reloaded when the signed-in user is no longer the one it was rendered for.
 *
 * Pure helpers plus small installers; no financial calculation, payment control or entitlement is touched.
 */

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

/** True when `url` is on the Supabase origin (scheme + host + port), never by prefix-matching a longer host. */
export function isSupabaseRequest(url: string, supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl) return false;
  try {
    return new URL(url).origin === new URL(supabaseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Wraps a fetch so that requests to the Supabase origin use `cache: "no-store"`. An explicit `cache` chosen by the caller is
 * kept; requests to any other origin pass through unchanged.
 */
export function withNoStore(fetchImpl: FetchFn, supabaseUrl: string | undefined): FetchFn {
  return (input, init) => {
    if (!isSupabaseRequest(urlOf(input), supabaseUrl)) return fetchImpl(input, init);
    if (init?.cache) return fetchImpl(input, init);
    if (typeof Request !== "undefined" && input instanceof Request && !init) {
      return fetchImpl(new Request(input, { cache: "no-store" }));
    }
    return fetchImpl(input, { ...(init ?? {}), cache: "no-store" });
  };
}

const INSTALLED = Symbol.for("cfoclose.noStoreFetch");

/**
 * Installs the no-store wrapper on `target.fetch` once. Skipped where the Fetch API has no `cache` mode (feature detection), so
 * it never changes behaviour on a runtime that would reject the option. Returns whether the wrapper is (now) installed.
 */
export function installNoStoreFetch(target: { fetch?: FetchFn } & Record<PropertyKey, unknown>, supabaseUrl: string | undefined): boolean {
  if (target[INSTALLED]) return true;
  if (typeof target.fetch !== "function" || !supabaseUrl) return false;
  if (typeof Request === "undefined" || !("cache" in Request.prototype)) return false;
  const original = target.fetch.bind(target) as FetchFn;
  target.fetch = withNoStore(original, supabaseUrl);
  target[INSTALLED] = true;
  return true;
}

export type AuthTransition = "none" | "clear" | "reload";

/**
 * What an auth change requires of the client's sensitive state:
 * - signed out (explicitly, by expiry or refresh failure) → clear;
 * - a different user than the one the page holds → reload (clearing alone would leave component state rendered);
 * - first sign-in, token refresh or the same user → nothing.
 */
export function decideAuthTransition(previousUserId: string | null, event: string, nextUserId: string | null): AuthTransition {
  if (previousUserId && nextUserId && previousUserId !== nextUserId) return "reload";
  if (event === "SIGNED_OUT" || (previousUserId && !nextUserId)) return "clear";
  return "none";
}

/**
 * Application keys in sessionStorage that belong to the signed-in user's work (drafts, pending corrections, statement-review
 * recovery, team and sandbox preferences): every `cfoclose:` / `cfoclose.` key EXCEPT the public, pre-sign-in ones below, which
 * carry no financial data and must survive a sign-out (the chosen service and outcome, and a public enquiry's receipt and
 * in-flight attempt, which prevent a duplicate submission).
 */
const APP_KEY = /^cfoclose[:.]/;
const PUBLIC_KEYS = [/^cfoclose:service-intent:v1$/, /^cfoclose:selected-outcome:v1$/, /^cfoclose:enquiry-(receipt|attempt):v1:/];
export const isSensitiveSessionKey = (key: string): boolean => APP_KEY.test(key) && !PUBLIC_KEYS.some((p) => p.test(key));

/** Clears client-held copies of signed-in data: the whole query cache, and the user-scoped application keys of sessionStorage. */
export function clearSensitiveClientState(deps: {
  queryClient?: { clear: () => void } | null;
  storage?: Pick<Storage, "length" | "key" | "removeItem"> | null;
}): void {
  try { deps.queryClient?.clear(); } catch { /* nothing cached */ }
  try {
    const s = deps.storage;
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k !== null && isSensitiveSessionKey(k)) keys.push(k); }
    for (const k of keys) s.removeItem(k);
  } catch { /* storage unavailable */ }
}

/**
 * Back/forward-cache guard: when a page is restored from the bfcache (`pageshow` with `persisted`), compare the user it was
 * rendered for with the current session's user and reload when they differ (including "now signed out"). Returns a remover.
 */
export function installBfcacheGuard(
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  renderedUserId: () => string | null,
  currentUserId: () => Promise<string | null>,
  reload: () => void,
): () => void {
  const onPageShow = async (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    const now = await currentUserId().catch(() => null);
    if (now !== renderedUserId()) reload();
  };
  win.addEventListener("pageshow", onPageShow as EventListener);
  return () => win.removeEventListener("pageshow", onPageShow as EventListener);
}
