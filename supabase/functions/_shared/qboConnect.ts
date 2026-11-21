/**
 * qboConnect — the three steps of "Connect QuickBooks": starting the authorisation, receiving the browser when Intuit sends it back, and finishing it.
 * Pure orchestration with injected dependencies (unit-tested in Node, run unchanged in the qbo-connect-start, qbo-oauth-callback and qbo-finish-connection
 * Edge Functions).
 *
 *   START     an authenticated person asks to connect a workspace. We generate an unguessable state, store only its SHA-256 (qbo_start_oauth_state, which
 *             judges that the person holds BOTH rights the connector needs in that workspace), and return the authorisation address for the browser to open.
 *   CALLBACK  Intuit redirects the browser with ?code&state&realmId. There is NO login on that request, and the state proves only who STARTED the attempt,
 *             not who approved it (review r2, S4). So nothing is exchanged here: the code is sealed and parked with the state (qbo_record_oauth_return,
 *             which consumes the state exactly once), and the browser is sent back to the app carrying a one-time handoff code in the address FRAGMENT
 *             (never sent to a server, never in a Referer or an access log). Never the code, the state or a token.
 *   FINISH    the app, signed in, hands the handoff back (qbo-finish-connection). The database gives the sealed code back only if the signed-in person is
 *             the one who started the attempt, it has not expired (5 minutes) and they still hold both rights; any answer ends the handoff. Only then is
 *             the code exchanged through the read-only guard, the refresh token sealed (bound to workspace + environment + realm) and the envelope stored.
 *             A QuickBooks company approved by anyone else is therefore never connected, and no token for it ever exists.
 *
 * realmID PROTECTION (qboRealmProtection.ts; Intuit case 00232331; after the cutover): the callback parks the realm ONLY sealed to the handoff (like the
 * code) with its keyed index for both environments (the database keeps the state's own); finish opens it, checks it against the parked index, and stores
 * the connection with the realm sealed to the workspace and environment and its index. No plaintext realm is sent to or read from the database.
 *
 * An unknown, expired or already-used state is a plain refusal with no redirect: there is no trustworthy workspace to send the browser to.
 */
import type { QboEnvironment } from "./qboReadOnlyGuard.ts";
import { qboAuthorizeUrl } from "./qboReadOnlyGuard.ts";
import { connectionBinding, type EnvelopeBinding } from "./qboTokenEnvelope.ts";
import type { TokenResult } from "./qboTokenClient.ts";
import type { ProtectedRealm } from "./qboRealmProtection.ts";

export const OAUTH_STATE_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE = /^[A-Za-z0-9_-]{32,256}$/;
const REALM = /^[0-9]{1,20}$/;
const HANDOFF = /^[0-9a-f]{64}$/;

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

// ── callback: park the code, hand the browser back ───────────────────────────────────────────────────────────────────
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

/**
 * The binding of a parked authorisation code. The code is sealed BEFORE the state is consumed (so consuming and parking are one database step), when the
 * workspace is not yet known; the handoff's hash names the one row the code may live in, so a sealed code copied to another row fails to open.
 */
export function oauthReturnBinding(handoffHash: string): EnvelopeBinding {
  return { workspaceId: "qbo-oauth-return", connectionId: handoffHash, purpose: "qbo-auth-code" };
}

/** What the browser is sent back with: a plain status word in the query, or the one-time handoff code in the FRAGMENT (never sent to a server). */
export type ReturnBack = { status: "denied" | "failed" } | { handoff: string };
export interface ParkedRealm { envelope: string; indexSandbox: string; indexProduction: string }
export interface ParkedReturn { codeEnvelope: string; handoffHash: string; realm: ParkedRealm }
export interface CallbackDeps {
  sha256Hex(text: string): Promise<string>;
  /** 32 random bytes as 64 hex characters. */
  randomHandoff(): string;
  sealCode(code: string, binding: EnvelopeBinding): Promise<string>;
  /** The realm sealed to the handoff (verified to open back) and its index for both environments (qboRealmProtection.protectParkedRealm). */
  protectParkedRealm(realmId: string, handoffHash: string): Promise<ParkedRealm>;
  /** qbo_record_oauth_return: consumes the state once and, given a code, parks it. Null for an unknown, expired or used state, or a starter who lost a right. */
  recordReturn(stateHash: string, parked: ParkedReturn | null): Promise<{ companyId: string; environment: QboEnvironment; returnPeriodYear: number } | null>;
  /** The app's trial-balance page for that workspace and period, carrying `back` and nothing else. */
  returnTo(companyId: string, periodYear: number, back: ReturnBack): string;
}
export type CallbackResult = { status: 302; outcome: "handed_back" | "denied" | "failed"; location: string } | { status: 400; outcome: "invalid_request" | "unknown_state" };

export async function runQboCallback(deps: CallbackDeps, query: CallbackQuery | null): Promise<CallbackResult> {
  if (!query) return { status: 400, outcome: "invalid_request" };
  const stateHash = await deps.sha256Hex(query.state);
  const handoff = !query.denied && query.code && query.realmId ? deps.randomHandoff() : null;
  if (handoff === null || !HANDOFF.test(handoff)) {
    // Declined at Intuit, or nothing usable came back: the state is consumed and nothing is parked.
    const consumed = await deps.recordReturn(stateHash, null);
    if (!consumed) return { status: 400, outcome: "unknown_state" };
    const status = query.denied ? "denied" : "failed";
    return { status: 302, outcome: status, location: deps.returnTo(consumed.companyId, consumed.returnPeriodYear, { status }) };
  }
  // The code is NOT exchanged here: it is parked, sealed, until the person who started the attempt hands the handoff back (runQboFinish).
  const handoffHash = await deps.sha256Hex(handoff);
  const codeEnvelope = await deps.sealCode(query.code!, oauthReturnBinding(handoffHash));
  const realm = await deps.protectParkedRealm(query.realmId!, handoffHash);
  const parked = await deps.recordReturn(stateHash, { codeEnvelope, handoffHash, realm });
  if (!parked) return { status: 400, outcome: "unknown_state" };
  return { status: 302, outcome: "handed_back", location: deps.returnTo(parked.companyId, parked.returnPeriodYear, { handoff }) };
}

// ── finish: the signed-in starter takes the code back, and only then is it exchanged ─────────────────────────────────
/** Exactly { handoff }: 64 hex characters. Nothing else is read (no workspace, realm or person: those come from the database and the login). */
export function parseFinishRequest(body: unknown): { handoff: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1 || keys[0] !== "handoff" || typeof o.handoff !== "string" || !HANDOFF.test(o.handoff)) return null;
  return { handoff: o.handoff };
}

export type TakenReturn =
  | { outcome: "taken"; companyId: string; environment: QboEnvironment; realmId: string | null; realmEnvelope: string | null; realmIndex: string | null; codeEnvelope: string }
  | { outcome: "not_yours" | "expired" | "forbidden" | "unknown" };
export interface FinishDeps {
  authenticate(): Promise<string | null>;
  sha256Hex(text: string): Promise<string>;
  /** qbo_take_oauth_return: single use whatever the answer; the code comes back only to the person who started the attempt. */
  takeReturn(handoffHash: string, actorUserId: string): Promise<TakenReturn>;
  openCode(envelope: string, binding: EnvelopeBinding): Promise<string | null>;
  /** Opens the realm parked with the handoff (null if it does not open). */
  openParkedRealm(envelope: string, handoffHash: string): Promise<string | null>;
  /** The keyed index of a realm in an environment. */
  realmIndex(realmId: string, environment: QboEnvironment): Promise<string>;
  /** The realm sealed to the workspace and environment, verified to open back, and its index (qboRealmProtection.protectRealm). */
  protectRealm(realmId: string, environment: QboEnvironment, companyId: string): Promise<ProtectedRealm>;
  oauthConfig(environment: QboEnvironment): OAuthConfig | null;
  exchangeCode(environment: QboEnvironment, code: string, redirectUri: string): Promise<TokenResult>;
  sealRefreshToken(refreshToken: string, binding: EnvelopeBinding): Promise<string>;
  /** Stores the connection with its realm protection only: the database never receives the realm in clear. */
  storeConnection(companyId: string, actorUserId: string, environment: QboEnvironment, envelope: string, refreshExpiresAt: string, hardExpiresAt: string | null, realm: ProtectedRealm): Promise<string>;
}
export type FinishResult =
  | { status: 200; outcome: "connected" }
  | { status: 400 | 401 | 403 | 409 | 410 | 500 | 502 | 503; outcome: "invalid_request" | "unauthenticated" | "not_yours" | "forbidden" | "expired" | "not_configured" | "failed" | "quickbooks_unavailable" | "rotation_in_progress" };

/** Thrown by storeConnection when the database refuses because an index-key rotation is in progress (QBO_INDEX_ROTATION_IN_PROGRESS): uniqueness by
 *  index is only sound while every live row is on one index key, so the connection is refused, never stored as a possible duplicate. Retryable. */
export class QboRotationInProgress extends Error {
  constructor() { super("index-key rotation in progress"); this.name = "QboRotationInProgress"; }
}
/** The database's mid-rotation refusal, recognised by its stable code prefix only (PostgREST passes the RAISE message through). */
export const isRotationRefusal = (error: { message?: string; code?: string } | null | undefined): boolean =>
  !!error && (error.code === "PT409" || (typeof error.message === "string" && error.message.startsWith("QBO_INDEX_ROTATION_IN_PROGRESS")));

export async function runQboFinish(deps: FinishDeps, req: { handoff: string } | null): Promise<FinishResult> {
  if (!req) return { status: 400, outcome: "invalid_request" };
  const userId = await deps.authenticate();
  if (!userId) return { status: 401, outcome: "unauthenticated" };
  const handoffHash = await deps.sha256Hex(req.handoff);
  // Who started the attempt is the database's record; who is finishing it is the login. Anyone else is refused BEFORE Intuit is touched.
  const taken = await deps.takeReturn(handoffHash, userId);
  if (taken.outcome === "not_yours" || taken.outcome === "forbidden") return { status: 403, outcome: taken.outcome };
  if (taken.outcome !== "taken") return { status: 410, outcome: "expired" };
  const cfg = deps.oauthConfig(taken.environment);
  if (!cfg) return { status: 503, outcome: "not_configured" };
  const code = await deps.openCode(taken.codeEnvelope, oauthReturnBinding(handoffHash));
  if (!code) return { status: 500, outcome: "failed" };
  // The realm, before Intuit is touched: opened from its parked envelope, which must agree with the parked plaintext and index where they exist.
  const realmId = await parkedRealm(deps, taken, handoffHash);
  if (!realmId) return { status: 500, outcome: "failed" };
  const realm = await deps.protectRealm(realmId, taken.environment, taken.companyId);
  const exchanged = await deps.exchangeCode(taken.environment, code, cfg.redirectUri);
  if (!exchanged.ok) {
    if (exchanged.reason === "invalid_grant") return { status: 410, outcome: "expired" };   // Intuit no longer accepts the code (too old, or used)
    return exchanged.reason === "unavailable" ? { status: 503, outcome: "quickbooks_unavailable" } : { status: 502, outcome: "failed" };
  }
  const envelope = await deps.sealRefreshToken(exchanged.tokens.refreshToken, connectionBinding(taken.companyId, realmId, taken.environment));
  try {
    await deps.storeConnection(taken.companyId, userId, taken.environment, envelope, exchanged.tokens.refreshExpiresAt, exchanged.tokens.hardExpiresAt, realm);
  } catch (e) {
    if (e instanceof QboRotationInProgress) return { status: 409, outcome: "rotation_in_progress" };
    throw e;
  }
  return { status: 200, outcome: "connected" };
}

/** The parked realm: ONLY its envelope opened for this handoff, which must match the parked index (and any plaintext, which the database no longer
 *  keeps). Null when nothing trustworthy is there: there is no plaintext fallback after the cutover. */
async function parkedRealm(deps: FinishDeps, taken: Extract<TakenReturn, { outcome: "taken" }>, handoffHash: string): Promise<string | null> {
  if (!taken.realmEnvelope || !taken.realmIndex) return null;
  const opened = await deps.openParkedRealm(taken.realmEnvelope, handoffHash);
  if (!opened || !REALM.test(opened)) return null;
  if (taken.realmId !== null && taken.realmId !== opened) return null;
  return taken.realmIndex === await deps.realmIndex(opened, taken.environment) ? opened : null;
}
