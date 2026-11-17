/**
 * qboRealmBackfill — the one-off, service-only protection and verification of realmIDs stored before the protection release (Intuit case
 * 00232331; docs/release/qbo-realm-protection-r1/README.md). Pure orchestration with injected dependencies: unit-tested in Node, run unchanged
 * by the qbo-realm-protect Edge Function.
 *
 *   protect  every live connection and every disconnect operation that has a plaintext realm and no envelope: seal it (bound to its workspace
 *            and environment), prove the envelope opens back to the plaintext, compute its keyed index, and submit through the service-only
 *            qbo_protect_connection_realm / qbo_protect_disconnect_realm (which refuse unless the plaintext equals the row's, never overwrite and
 *            never touch a terminal connection).
 *   verify   every such row: its envelope is OPENED with the key ring, must equal the stored plaintext, and the stored index must equal the index
 *            recomputed with the current index key; only then is the row marked verified (qbo_verify_connection_realm / _disconnect_realm, which
 *            compare once more with the plaintext the database holds). The cutover (Phase C) refuses unless every row is verified.
 *
 * AFTER THE CUTOVER (20261231100000-20261231300000) the database writers are gone (there is no plaintext left to compare): the database functions are
 * not supplied, "protect" only reports rows without protection, and "verify" opens every envelope and recomputes its index (a local check; nothing is
 * written).
 *
 * The answer and every log line carry COUNTS only: never a realm, an envelope, an index, a key or a row id.
 */
import { protectExistingRealm, resolveStoredRealm, PROTECTED_OUTCOMES, type ProtectArgs, type RealmKeys, type StoredRealm } from "./qboRealmProtection.ts";

export type BackfillAction = "protect" | "verify";
/** A connection, or a disconnect operation (whose id is its connection id). */
export interface BackfillRow extends StoredRealm { id: string }
export interface BackfillTally { total: number; protected: number; already: number; verified: number; unprotected: number; mismatched: number; refused: number }
export interface BackfillDeps {
  /** True only for a caller presenting the service-role credential itself. */
  authorize(): boolean;
  /** Live connections (status other than 'disconnected'). Terminal connections cannot change and are not listed. */
  listConnections(): Promise<BackfillRow[]>;
  /** Every disconnect operation. */
  listOperations(): Promise<BackfillRow[]>;
  /** The database writers; absent after the cutover. */
  protectConnection?(args: ProtectArgs): Promise<string>;
  protectOperation?(args: ProtectArgs): Promise<string>;
  verifyConnection?(args: ProtectArgs): Promise<string>;
  verifyOperation?(args: ProtectArgs): Promise<string>;
  /** qbo_realm_protection_status(): the database's own counts. */
  status(): Promise<Record<string, number>>;
}
export type BackfillResult =
  | { status: 200 | 409; outcome: "complete" | "incomplete"; action: BackfillAction; connections: BackfillTally; operations: BackfillTally; database: Record<string, number> }
  | { status: 400 | 401 | 500; outcome: "invalid_request" | "unauthorized" | "failed" };

export function parseBackfillRequest(body: unknown): { action: BackfillAction } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (Object.keys(o).length !== 1 || (o.action !== "protect" && o.action !== "verify")) return null;
  return { action: o.action };
}

/** Constant-time comparison of two credentials (no early exit on the first differing character). */
export function sameCredential(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const empty = (): BackfillTally => ({ total: 0, protected: 0, already: 0, verified: 0, unprotected: 0, mismatched: 0, refused: 0 });

async function protectRows(rows: BackfillRow[], keys: RealmKeys, submit: ((a: ProtectArgs) => Promise<string>) | undefined): Promise<BackfillTally> {
  const t = empty();
  for (const row of rows) {
    t.total++;
    if (row.realm_envelope) { t.already++; continue; }
    if (typeof row.realm_id !== "string" || !submit) { t.unprotected++; continue; }
    let outcome: string;
    try { outcome = await submit(await protectExistingRealm(row, keys)); } catch { t.refused++; continue; }
    if (outcome === "protected") t.protected++;
    else if (PROTECTED_OUTCOMES.has(outcome)) t.already++;
    else if (outcome === "realm_mismatch" || outcome === "index_conflict") t.mismatched++;
    else t.refused++;
  }
  return t;
}

async function verifyRows(rows: BackfillRow[], keys: RealmKeys, submit: ((a: ProtectArgs) => Promise<string>) | undefined): Promise<BackfillTally> {
  const t = empty();
  for (const row of rows) {
    t.total++;
    if (!row.realm_envelope || !row.realm_index) { t.unprotected++; continue; }
    // Opened with the key ring for the row's own workspace and environment; equal to the plaintext where it exists; index recomputed.
    const r = await resolveStoredRealm(row, keys, { allowPlaintext: false });
    if (!r.ok) { t.mismatched++; continue; }
    if (!submit) { t.verified++; continue; }   // after the cutover: opened and index recomputed; nothing to write
    let outcome: string;
    try { outcome = await submit({ p_connection: row.id, p_realm_id: r.realmId, p_realm_envelope: row.realm_envelope, p_realm_index: row.realm_index }); } catch { t.refused++; continue; }
    if (outcome === "verified" || outcome === "already_verified") t.verified++;
    else if (outcome === "realm_mismatch" || outcome === "envelope_mismatch") t.mismatched++;
    else t.refused++;
  }
  return t;
}

export async function runRealmBackfill(deps: BackfillDeps, keys: RealmKeys, req: { action: BackfillAction } | null): Promise<BackfillResult> {
  if (!deps.authorize()) return { status: 401, outcome: "unauthorized" };
  if (!req) return { status: 400, outcome: "invalid_request" };
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
