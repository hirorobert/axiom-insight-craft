/**
 * qboRealmBackfill — the one-off protection and verification of realmIDs stored before the protection release (Intuit case 00232331;
 * docs/release/qbo-realm-protection-r1/README.md). Pure orchestration with injected dependencies: unit-tested in Node, run unchanged by the
 * qbo-realm-protect Edge Function.
 *
 * WHO MAY RUN IT: only a signed-in ACTIVE PLATFORM OWNER, decided by the database's own public.is_platform_owner(user) (an active
 * commercial_admins row at the platform_owner tier). Lovable Cloud does not expose the service-role credential to anyone, so the operation
 * cannot depend on a caller presenting it; and it must not be an ordinary member's endpoint. The caller's own session proves identity (a
 * valid signature, unexpired, with a user subject), the
 * database decides authority, and only then does the function use its service client for the service-only database functions below. A
 * service-role or anon token has no user and is refused; a member, a commercial-tier administrator or an inactive platform owner is refused;
 * an authority check that cannot be completed is refused (never assumed).
 *
 * SAFE TO REPEAT, TO RUN CONCURRENTLY AND TO RESUME: every row is decided by its own database call under a row lock that never overwrites
 * (protect answers already_protected for a row another run sealed first; verify answers already_verified), so an interrupted run leaves only
 * finished rows behind and the next run completes the rest.
 *
 *   protect  every live connection and every disconnect operation that has a plaintext realm and no envelope: seal it (bound to its workspace
 *            and environment), prove the envelope opens back to the plaintext, compute its keyed index, and submit through the service-only
 *            qbo_protect_connection_realm / qbo_protect_disconnect_realm (which refuse unless the plaintext equals the row's, never overwrite and
 *            never touch a terminal connection).
 *   verify   every such row: its envelope is OPENED with the key ring, must equal the stored plaintext, and the stored index must equal the index
 *            recomputed with the current index key; only then is the row marked verified (qbo_verify_connection_realm / _disconnect_realm, which
 *            compare once more with the plaintext the database holds). The cutover (Phase C) refuses unless every row is verified.
 *
 *   keys     READ ONLY: opens every live connection's realm envelope and refresh token and every disconnect operation's realm envelope with
 *            the configured key ring and counts what opened under which key id (qbo_realm_key_coverage() adds the stored counts, historical
 *            rows included). Nothing is written. It proves which key the deployed runtime needs before a key is retired.
 *   reseal   moves every LIVE row that is still sealed with an older key onto the current sealing key (QBO_TOKEN_KEY_NEXT_* once configured):
 *            the realm envelope of each live connection and each disconnect operation (opened, equal to the plaintext the database holds,
 *            index recomputed and unchanged, re-sealed, opened back) and each live refresh token (opened under its binding, re-sealed, opened
 *            back), each submitted by compare-and-swap through qbo_reseal_connection_realm / qbo_reseal_disconnect_realm /
 *            qbo_reseal_refresh_token. A row changed meanwhile answers 'stale' and a row under an import's lease answers 'busy': nothing is
 *            overwritten and the next run finishes it. Rows already under the current key are left alone, so it is safe to repeat.
 *
 *   index_keys  READ ONLY (20261230500000): resolves every live connection's and every disconnect operation's realm (envelope opened, equal
 *            to the plaintext, stored index recognised by the index key it names) and counts the stored indexes by index key id;
 *            qbo_realm_index_coverage() adds the stored counts, historical rows included. Nothing is written.
 *   reindex  moves every such row whose index was made by an older index key onto the current one (QBO_REALM_INDEX_KEY_NEXT_* once
 *            configured): the old index is recognised first, the new one computed from the same opened realm, and both are submitted by
 *            compare-and-swap through qbo_reindex_connection_realm / qbo_reindex_disconnect_realm (envelope and plaintext unchanged). A row
 *            changed meanwhile answers 'stale'; nothing is overwritten; rows already on the current key are left alone, so it is safe to repeat.
 *            Historical rows (terminal connections, import intents and pulls, consumed OAuth states) keep their index: no comparison reads it.
 *
 * The answer and every log line carry COUNTS only: never a realm, an envelope, an index, a key or a row id.
 */
import { openRealm, protectExistingRealm, realmIndex, resolveStoredRealm, sealRealm, PROTECTED_OUTCOMES, type ProtectArgs, type RealmKeys, type StoredRealm } from "./qboRealmProtection.ts";
import { connectionBinding, openSecret, sealSecret } from "./qboTokenEnvelope.ts";

export type BackfillAction = "protect" | "verify";
export type KeyAction = "keys" | "reseal";
export type IndexAction = "index_keys" | "reindex";
/** A connection, or a disconnect operation (whose id is its connection id). */
export interface BackfillRow extends StoredRealm { id: string; refresh_token_envelope?: string | null }
export interface BackfillTally { total: number; protected: number; already: number; verified: number; unprotected: number; mismatched: number; refused: number }
/** The caller's authority, decided before anything is listed or written. */
export type MaintenanceAuthority = { ok: true; actor: string } | { ok: false; reason: "unauthenticated" | "forbidden" | "unavailable" };
export interface BackfillDeps {
  /** Only an active platform owner (decideMaintenanceAuthority). */
  authorize(): Promise<MaintenanceAuthority>;
  /** Live connections (status other than 'disconnected'). Terminal connections cannot change and are not listed. */
  listConnections(): Promise<BackfillRow[]>;
  /** Every disconnect operation. */
  listOperations(): Promise<BackfillRow[]>;
  protectConnection(args: ProtectArgs): Promise<string>;
  protectOperation(args: ProtectArgs): Promise<string>;
  verifyConnection(args: ProtectArgs): Promise<string>;
  verifyOperation(args: ProtectArgs): Promise<string>;
  /** qbo_realm_protection_status(): the database's own counts. */
  status(): Promise<Record<string, number>>;
  /** 20261230400000: compare-and-swap re-seals and the stored counts by key id (absent before that migration). */
  resealConnection?(args: ResealArgs): Promise<string>;
  resealOperation?(args: ResealArgs): Promise<string>;
  resealToken?(args: { p_connection: string; p_expected_envelope: string; p_new_envelope: string }): Promise<string>;
  coverage?(): Promise<Record<string, number>>;
  /** 20261230500000: compare-and-swap re-indexes and the stored index counts by index key id (absent before that migration). */
  reindexConnection?(args: ReindexArgs): Promise<string>;
  reindexOperation?(args: ReindexArgs): Promise<string>;
  indexCoverage?(): Promise<Record<string, number>>;
}
export interface ResealArgs { p_connection: string; p_realm_id: string; p_expected_envelope: string; p_new_envelope: string; p_realm_index: string }
export interface ReindexArgs { p_connection: string; p_realm_id: string; p_realm_envelope: string; p_expected_index: string; p_new_index: string }
export type BackfillResult =
  | { status: 200 | 409; outcome: "complete" | "incomplete"; action: BackfillAction; connections: BackfillTally; operations: BackfillTally; database: Record<string, number> }
  | { status: 400 | 401 | 403 | 500 | 503; outcome: "invalid_request" | "unauthorized" | "forbidden" | "failed" | "unavailable" };

const ACTIONS: ReadonlySet<unknown> = new Set(["protect", "verify", "keys", "reseal", "index_keys", "reindex"]);
export function parseBackfillRequest(body: unknown): { action: BackfillAction | KeyAction | IndexAction } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (Object.keys(o).length !== 1 || !ACTIONS.has(o.action)) return null;
  return { action: o.action as BackfillAction | KeyAction | IndexAction };
}

const BEARER_JWT = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
export interface MaintenanceAuthorityDeps {
  /** The signed-in user the presented session belongs to, verified by the auth server; null when it is not a user's valid session. */
  userIdOf(authHeader: string): Promise<string | null>;
  /** public.is_platform_owner(user), asked of the database. */
  isPlatformOwner(userId: string): Promise<unknown>;
}
/** Exactly one authority: a signed-in user whom the database answers `true` for. Anything else (no session, a key that is not a user,
 *  a member, an administrator below the platform-owner tier, an inactive owner, an unreadable answer) is refused. */
export async function decideMaintenanceAuthority(authHeader: string | null, deps: MaintenanceAuthorityDeps): Promise<MaintenanceAuthority> {
  if (typeof authHeader !== "string" || !BEARER_JWT.test(authHeader)) return { ok: false, reason: "unauthenticated" };
  let userId: string | null;
  try { userId = await deps.userIdOf(authHeader); } catch { return { ok: false, reason: "unauthenticated" }; }
  if (typeof userId !== "string" || userId.length === 0) return { ok: false, reason: "unauthenticated" };
  let owner: unknown;
  try { owner = await deps.isPlatformOwner(userId); } catch { return { ok: false, reason: "unavailable" }; }
  return owner === true ? { ok: true, actor: userId } : { ok: false, reason: "forbidden" };
}

const empty = (): BackfillTally => ({ total: 0, protected: 0, already: 0, verified: 0, unprotected: 0, mismatched: 0, refused: 0 });

async function protectRows(rows: BackfillRow[], keys: RealmKeys, submit: (a: ProtectArgs) => Promise<string>): Promise<BackfillTally> {
  const t = empty();
  for (const row of rows) {
    t.total++;
    if (row.realm_envelope) { t.already++; continue; }
    if (typeof row.realm_id !== "string") { t.unprotected++; continue; }
    let outcome: string;
    try { outcome = await submit(await protectExistingRealm(row, keys)); } catch { t.refused++; continue; }
    if (outcome === "protected") t.protected++;
    else if (PROTECTED_OUTCOMES.has(outcome)) t.already++;
    else if (outcome === "realm_mismatch" || outcome === "index_conflict") t.mismatched++;
    else t.refused++;
  }
  return t;
}

async function verifyRows(rows: BackfillRow[], keys: RealmKeys, submit: (a: ProtectArgs) => Promise<string>): Promise<BackfillTally> {
  const t = empty();
  for (const row of rows) {
    t.total++;
    if (!row.realm_envelope || !row.realm_index) { t.unprotected++; continue; }
    // Opened with the key ring for the row's own workspace and environment; equal to the plaintext where it exists; index recomputed.
    const r = await resolveStoredRealm(row, keys, { allowPlaintext: false });
    if (!r.ok) { t.mismatched++; continue; }
    let outcome: string;
    try { outcome = await submit({ p_connection: row.id, p_realm_id: r.realmId, p_realm_envelope: row.realm_envelope, p_realm_index: row.realm_index }); } catch { t.refused++; continue; }
    if (outcome === "verified" || outcome === "already_verified") t.verified++;
    else if (outcome === "realm_mismatch" || outcome === "envelope_mismatch") t.mismatched++;
    else t.refused++;
  }
  return t;
}

export async function runRealmBackfill(deps: BackfillDeps, keys: RealmKeys, req: { action: BackfillAction | KeyAction | IndexAction } | null): Promise<BackfillResult | KeyResult | IndexResult> {
  let authority: MaintenanceAuthority;
  try { authority = await deps.authorize(); } catch { authority = { ok: false, reason: "unavailable" }; }
  if (!authority.ok) {
    return authority.reason === "forbidden" ? { status: 403, outcome: "forbidden" }
      : authority.reason === "unavailable" ? { status: 503, outcome: "unavailable" } : { status: 401, outcome: "unauthorized" };
  }
  if (!req) return { status: 400, outcome: "invalid_request" };
  if (req.action === "keys" || req.action === "reseal") return runKeyAction(deps, keys, req.action);
  if (req.action === "index_keys" || req.action === "reindex") return runIndexAction(deps, keys, req.action);
  try {
    const [conns, ops] = [await deps.listConnections(), await deps.listOperations()];
    const connections = req.action === "protect" ? await protectRows(conns, keys, deps.protectConnection) : await verifyRows(conns, keys, deps.verifyConnection);
    const operations = req.action === "protect" ? await protectRows(ops, keys, deps.protectOperation) : await verifyRows(ops, keys, deps.verifyOperation);
    const bad = (t: BackfillTally) => t.unprotected + t.mismatched + t.refused;
    const done = bad(connections) === 0 && bad(operations) === 0;
    return { status: done ? 200 : 409, outcome: done ? "complete" : "incomplete", action: req.action, connections, operations, database: await deps.status() };
  } catch {
    return { status: 500, outcome: "failed" };
  }
}

// ── key rotation: "keys" (read only) and "reseal" (20261230400000) ──────────────────────────────────────────────────────────────────────────
export interface KeyTally { total: number; byKey: Record<string, number>; resealed: number; already: number; none: number; stale: number; busy: number; unreadable: number; mismatched: number; refused: number }
export type KeyResult =
  | { status: 200 | 409; outcome: "complete" | "incomplete"; action: KeyAction; currentKeyId: string; connectionRealms: KeyTally; refreshTokens: KeyTally; operationRealms: KeyTally; database: Record<string, number> }
  | { status: 500 | 503; outcome: "failed" | "unavailable" };
const keyTally = (): KeyTally => ({ total: 0, byKey: {}, resealed: 0, already: 0, none: 0, stale: 0, busy: 0, unreadable: 0, mismatched: 0, refused: 0 });
const keyIdOf = (envelope: string) => envelope.split(".")[1] ?? "";
const count = (t: KeyTally, k: string) => { t.byKey[k] = (t.byKey[k] ?? 0) + 1; };
function tallyOutcome(t: KeyTally, outcome: string): void {
  if (outcome === "resealed") t.resealed++;
  else if (outcome === "already_resealed") t.already++;
  else if (outcome === "stale") t.stale++;
  else if (outcome === "busy") t.busy++;
  else if (outcome === "realm_mismatch" || outcome === "index_mismatch") t.mismatched++;
  else t.refused++;
}

/** One realm envelope: read (keys) or moved onto the current key (reseal). Returns the opened realm, or null when it could not be read. */
async function realmStep(row: BackfillRow, keys: RealmKeys, t: KeyTally, action: KeyAction, submit: ((a: ResealArgs) => Promise<string>) | undefined): Promise<string | null> {
  t.total++;
  if (!row.realm_envelope || !row.realm_index) { t.unreadable++; return null; }
  const r = await resolveStoredRealm(row, keys, { allowPlaintext: false });
  if (!r.ok) { if (r.reason === "mismatch") t.mismatched++; else t.unreadable++; return null; }
  const from = keyIdOf(row.realm_envelope);
  count(t, from);
  if (action === "keys") return r.realmId;
  if (from === keys.current.id) { t.already++; return r.realmId; }
  if (!submit || typeof row.realm_id !== "string") { t.refused++; return r.realmId; }   // re-sealing compares with the plaintext the database holds
  let next: string;
  try {
    next = await sealRealm(r.realmId, row.environment, row.company_id, keys.current);
    if ((await openRealm(next, row.environment, row.company_id, [keys.current])) !== r.realmId) { t.refused++; return r.realmId; }
  } catch { t.refused++; return r.realmId; }
  try { tallyOutcome(t, await submit({ p_connection: row.id, p_realm_id: r.realmId, p_expected_envelope: row.realm_envelope, p_new_envelope: next, p_realm_index: row.realm_index })); }
  catch { t.refused++; }
  return r.realmId;
}

/** One live refresh token, opened under its binding (workspace, realm, environment). */
async function tokenStep(row: BackfillRow, realmId: string | null, keys: RealmKeys, t: KeyTally, action: KeyAction, deps: BackfillDeps): Promise<void> {
  t.total++;
  const envelope = row.refresh_token_envelope;
  if (!envelope) { t.none++; return; }
  if (realmId === null) { t.unreadable++; return; }   // the binding needs the realm
  const binding = connectionBinding(row.company_id, realmId, row.environment);
  let token: string;
  try { token = await openSecret(envelope, keys.all, binding); } catch { t.unreadable++; return; }
  const from = keyIdOf(envelope);
  count(t, from);
  if (action === "keys") return;
  if (from === keys.current.id) { t.already++; return; }
  if (!deps.resealToken) { t.refused++; return; }
  let next: string;
  try {
    next = await sealSecret(token, keys.current, binding);
    if ((await openSecret(next, [keys.current], binding)) !== token) { t.refused++; return; }
  } catch { t.refused++; return; }
  try { tallyOutcome(t, await deps.resealToken({ p_connection: row.id, p_expected_envelope: envelope, p_new_envelope: next })); }
  catch { t.refused++; }
}

async function runKeyAction(deps: BackfillDeps, keys: RealmKeys, action: KeyAction): Promise<KeyResult> {
  if (action === "reseal" && (!deps.resealConnection || !deps.resealOperation || !deps.resealToken)) return { status: 503, outcome: "unavailable" };
  try {
    const [conns, ops] = [await deps.listConnections(), await deps.listOperations()];
    const connectionRealms = keyTally(), refreshTokens = keyTally(), operationRealms = keyTally();
    for (const row of conns) {
      const realmId = await realmStep(row, keys, connectionRealms, action, deps.resealConnection);
      await tokenStep(row, realmId, keys, refreshTokens, action, deps);
    }
    for (const row of ops) await realmStep(row, keys, operationRealms, action, deps.resealOperation);
    const bad = (t: KeyTally) => t.unreadable + t.mismatched + t.refused + t.stale + t.busy;
    const done = bad(connectionRealms) + bad(refreshTokens) + bad(operationRealms) === 0;
    const database = deps.coverage ? await deps.coverage() : await deps.status();
    return { status: done ? 200 : 409, outcome: done ? "complete" : "incomplete", action, currentKeyId: keys.current.id, connectionRealms, refreshTokens, operationRealms, database };
  } catch {
    return { status: 500, outcome: "failed" };
  }
}

// ── index-key rotation: "index_keys" (read only) and "reindex" (20261230500000) ─────────────────────────────────────────────────────────────
export interface IndexTally { total: number; byKey: Record<string, number>; reindexed: number; already: number; stale: number; unreadable: number; mismatched: number; refused: number }
export type IndexResult =
  | { status: 200 | 409; outcome: "complete" | "incomplete"; action: IndexAction; currentIndexKeyId: string; connectionIndexes: IndexTally; operationIndexes: IndexTally; database: Record<string, number> }
  | { status: 500 | 503; outcome: "failed" | "unavailable" };
const indexTally = (): IndexTally => ({ total: 0, byKey: {}, reindexed: 0, already: 0, stale: 0, unreadable: 0, mismatched: 0, refused: 0 });

/** One stored index: counted by the key that made it (index_keys), or moved onto the current index key (reindex). */
async function indexStep(row: BackfillRow, keys: RealmKeys, t: IndexTally, action: IndexAction, submit: ((a: ReindexArgs) => Promise<string>) | undefined): Promise<void> {
  t.total++;
  if (!row.realm_envelope || !row.realm_index) { t.unreadable++; return; }
  // Opened, equal to the plaintext, and the stored index recognised by the index key it names: only then is the row's realm known.
  const r = await resolveStoredRealm(row, keys, { allowPlaintext: false });
  if (!r.ok) { if (r.reason === "mismatch") t.mismatched++; else t.unreadable++; return; }
  const from = row.realm_index.split(".")[1] ?? "";
  t.byKey[from] = (t.byKey[from] ?? 0) + 1;
  if (action === "index_keys") return;
  if (from === keys.index.id) { t.already++; return; }
  if (!submit || typeof row.realm_id !== "string") { t.refused++; return; }   // re-indexing compares with the plaintext the database holds
  let next: string;
  try { next = await realmIndex(r.realmId, row.environment, keys.index); } catch { t.refused++; return; }
  let outcome: string;
  try { outcome = await submit({ p_connection: row.id, p_realm_id: r.realmId, p_realm_envelope: row.realm_envelope, p_expected_index: row.realm_index, p_new_index: next }); }
  catch { t.refused++; return; }
  if (outcome === "reindexed") t.reindexed++;
  else if (outcome === "already_reindexed") t.already++;
  else if (outcome === "stale") t.stale++;
  else if (outcome === "realm_mismatch" || outcome === "envelope_mismatch") t.mismatched++;
  else t.refused++;
}

async function runIndexAction(deps: BackfillDeps, keys: RealmKeys, action: IndexAction): Promise<IndexResult> {
  if (action === "reindex" && (!deps.reindexConnection || !deps.reindexOperation)) return { status: 503, outcome: "unavailable" };
  try {
    const [conns, ops] = [await deps.listConnections(), await deps.listOperations()];
    const connectionIndexes = indexTally(), operationIndexes = indexTally();
    for (const row of conns) await indexStep(row, keys, connectionIndexes, action, deps.reindexConnection);
    for (const row of ops) await indexStep(row, keys, operationIndexes, action, deps.reindexOperation);
    const bad = (t: IndexTally) => t.unreadable + t.mismatched + t.refused + t.stale;
    const done = bad(connectionIndexes) + bad(operationIndexes) === 0;
    const database = deps.indexCoverage ? await deps.indexCoverage() : await deps.status();
    return { status: done ? 200 : 409, outcome: done ? "complete" : "incomplete", action, currentIndexKeyId: keys.index.id, connectionIndexes, operationIndexes, database };
  } catch {
    return { status: 500, outcome: "failed" };
  }
}
