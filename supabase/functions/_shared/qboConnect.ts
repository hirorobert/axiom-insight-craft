/**
 * qboConnect — the two halves of "Connect QuickBooks": starting the authorisation and finishing it when Intuit sends the browser back.
 * Pure orchestration with injected dependencies (unit-tested in Node, run unchanged in the qbo-connect-start and qbo-oauth-callback Edge Functions).
 *
 *   START     an authenticated person asks to connect a workspace. We generate an unguessable state, store only its SHA-256 (qbo_start_oauth_state, which
 *             judges that the person may prepare a trial balance in that workspace), and return the authorisation address for the browser to open.
 *   CALLBACK  Intuit redirects the browser with ?code&state&realmId. There is NO login on that request, so the single-use state is the only credential:
 *             it is consumed first (qbo_consume_oauth_state: unused, unexpired, and the person still holds the right), the code is exchanged for tokens
 *             through the read-only guard, the refresh token is sealed (AES-256-GCM, bound to workspace + environment + realm) and only the envelope is stored.
 *             The browser is sent back to the app with a status word and nothing else: never the code, the state or a token.
 *
 * What the browser can learn from a callback: connected, denied (the person declined at Intuit) or failed. An unknown, expired or already-used state
 * is a plain refusal with no redirect: we have no trustworthy workspace to send the browser to.
 */
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";
import { qboAuthorizeUrl } from "./qboReadOnlyGuard.ts";
import { connectionBinding, type EnvelopeBinding } from "./qboTokenEnvelope.ts";
import type { TokenResult } from "./qboTokenClient.ts";

export const OAUTH_STATE_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE = /^[A-Za-z0-9_-]{32,256}$/;
const REALM = /^[0-9]{1,20}$/;

export interface OAuthConfig { clientId: string; redirectUri: string }

// ── start ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseConnectStartRequest(body: unknown): { companyId: string; environment: QboEnvironment; periodYear: number } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 3 || keys[0] !== "companyId" || keys[1] !== "environment" || keys[2] !== "periodYear") return null;
  if (typeof o.companyId !== "string" || !UUID.test(o.companyId)) return null;
  if (o.environment !== "production" && o.environment !== "sandbox") return null;
  if (typeof o.periodYear !== "number" || !Number.isInteger(o.periodYear) || o.periodYear < 2000 || o.periodYear > 2100) return null;
  return { companyId: o.companyId, environment: o.environment, periodYear: o.periodYear };
}

export interface ConnectStartDeps {
  authenticate(): Promise<string | null>;
  oauthConfig(environment: QboEnvironment): OAuthConfig | null;
  /** 32 random bytes as 64 hex characters. */
  randomState(): string;
  sha256Hex(text: string): Promise<string>;
  startState(stateHash: string, companyId: string, actorUserId: string, environment: QboEnvironment, ttlSeconds: number, returnPeriodYear: number): Promise<"created" | "forbidden" | "invalid">;
}
export type ConnectStartResult =
  | { status: 200; outcome: "authorize"; authorizeUrl: string }
  | { status: 401 | 403 | 500 | 503; outcome: "unauthenticated" | "forbidden" | "state_failed" | "not_configured" };

export async function runQboConnectStart(deps: ConnectStartDeps, req: { companyId: string; environment: QboEnvironment; periodYear: number }): Promise<ConnectStartResult> {
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };
  const cfg = deps.oauthConfig(req.environment);
  if (!cfg) return { status: 503, outcome: "not_configured" };
  const state = deps.randomState();
  if (!STATE.test(state)) return { status: 500, outcome: "state_failed" };
  const outcome = await deps.startState(await deps.sha256Hex(state), req.companyId, userId, req.environment, OAUTH_STATE_TTL_SECONDS, req.periodYear);
  if (outcome === "forbidden") return { status: 403, outcome: "forbidden" };
  if (outcome !== "created") return { status: 500, outcome: "state_failed" };
  return { status: 200, outcome: "authorize", authorizeUrl: qboAuthorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state }) };
}

// ── callback ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CallbackQuery { state: string; code: string | null; realmId: string | null; denied: boolean }

/** Only the five parameters Intuit sends are read; anything malformed makes the whole request invalid. */
export function parseCallbackQuery(params: URLSearchParams): CallbackQuery | null {
  const state = params.get("state");
  if (!state || !STATE.test(state)) return null;
  const code = params.get("code");
  if (code !== null && (code.length === 0 || code.length > 512 || /\s/.test(code))) return null;
  const realm = params.get("realmId");
  if (realm !== null && !REALM.test(realm)) return null;
  const error = params.get("error");
  return { state, code, realmId: realm, denied: error !== null };
}

export type ReturnStatus = "connected" | "denied" | "failed";
export interface CallbackDeps {
  sha256Hex(text: string): Promise<string>;
  consumeState(stateHash: string): Promise<{ companyId: string; actorUserId: string; environment: QboEnvironment; returnPeriodYear: number } | null>;
  oauthConfig(environment: QboEnvironment): OAuthConfig | null;
  exchangeCode(environment: QboEnvironment, code: string, redirectUri: string): Promise<TokenResult>;
  sealRefreshToken(refreshToken: string, binding: EnvelopeBinding): Promise<string>;
  storeConnection(companyId: string, actorUserId: string, realmId: string, environment: QboEnvironment, envelope: string, refreshExpiresAt: string, hardExpiresAt: string | null): Promise<string>;
  /** Where to send the browser back to: the app's trial-balance page for that workspace and period, with a status word. It must contain nothing else. */
  returnTo(companyId: string, periodYear: number, status: ReturnStatus): string;
}
export type CallbackResult = { status: 302; outcome: ReturnStatus; location: string; connectionId?: string } | { status: 400; outcome: "invalid_request" | "unknown_state" };

export async function runQboCallback(deps: CallbackDeps, query: CallbackQuery | null): Promise<CallbackResult> {
  if (!query) return { status: 400, outcome: "invalid_request" };
  const consumed = await deps.consumeState(await deps.sha256Hex(query.state));
  if (!consumed) return { status: 400, outcome: "unknown_state" };
  const back = (outcome: ReturnStatus, connectionId?: string): CallbackResult => ({ status: 302, outcome, location: deps.returnTo(consumed.companyId, consumed.returnPeriodYear, outcome), ...(connectionId ? { connectionId } : {}) });
  if (query.denied) return back("denied");
  if (!query.code || !query.realmId) return back("failed");
  const cfg = deps.oauthConfig(consumed.environment);
  if (!cfg) return back("failed");
  try {
    const exchanged = await deps.exchangeCode(consumed.environment, query.code, cfg.redirectUri);
    if (!exchanged.ok) return back("failed");
    const envelope = await deps.sealRefreshToken(exchanged.tokens.refreshToken, connectionBinding(consumed.companyId, query.realmId, consumed.environment));
    const id = await deps.storeConnection(consumed.companyId, consumed.actorUserId, query.realmId, consumed.environment, envelope, exchanged.tokens.refreshExpiresAt, exchanged.tokens.hardExpiresAt);
    return back("connected", id);
  } catch {
    return back("failed");
  }
}
