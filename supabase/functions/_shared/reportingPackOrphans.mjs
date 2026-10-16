// Reporting Pack orphan cleanup (repair C follow-up, 16 October 2026) — the ONLY rule by which an unsealed object in the
// private 'reporting-packs' bucket may be deleted. Pure orchestration over injected service-role dependencies; nothing
// here is scheduled or deployed by this change.
//
// An object at an issuance's path is kept while the issuance can still be sealed: a request may be storing or sealing it
// right now (deleting it then is the race repair C removed). An issuance can no longer be sealed once it has expired —
// the seal refuses 'expired' inside its row-locked transaction, and expires_at cannot be changed after issue — so an
// unsealed object becomes deletable only after its issuance's expiry PLUS a grace period longer than any seal
// transaction. An object at a path with no issuance at all is deletable after the same grace from its creation.
// A sealed object is never deleted (historical sealed artefacts are preserved), whatever its age.
//
// Retention: an unsealed canonical object lives until expires_at + ORPHAN_GRACE_MS (then the next sweep removes it).
// Failed cleanup: deletion is idempotent and every run re-lists from storage, so a failed deletion is retried by the
// next run; nothing is recorded as deleted unless storage confirmed it.

export const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const PATH = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.json$/;

/**
 * Whether an orphan may be deleted now. `issuance` is the row its path names ({ expires_at, consumed_at }) or null.
 * @returns {{ delete: boolean, reason: string }}
 */
export function orphanDecision(orphan, issuance, nowMs, graceMs = ORPHAN_GRACE_MS) {
  if (issuance && issuance.consumed_at) return { delete: false, reason: "sealed" };
  if (issuance) {
    const expires = Date.parse(issuance.expires_at);
    if (!Number.isFinite(expires)) return { delete: false, reason: "unknown_expiry" };
    return nowMs > expires + graceMs ? { delete: true, reason: "expired_unsealed" } : { delete: false, reason: "may_still_be_sealed" };
  }
  const created = Date.parse(orphan.created_at);
  if (!Number.isFinite(created)) return { delete: false, reason: "unknown_age" };
  return nowMs > created + graceMs ? { delete: true, reason: "no_issuance" } : { delete: false, reason: "recent" };
}

/**
 * One sweep. deps: listOrphans() → [{ storage_path, created_at }] (reporting_pack_storage_orphans), issuance(id) →
 * { expires_at, consumed_at } | null, remove(path) → { error }. Every deletion is re-decided on a fresh read first.
 */
export async function sweepReportingPackOrphans(deps, nowMs = Date.now(), graceMs = ORPHAN_GRACE_MS) {
  const report = { deleted: [], kept: [], failed: [] };
  for (const o of await deps.listOrphans()) {
    const m = PATH.exec(o.storage_path ?? "");
    const read = async () => (m ? await deps.issuance(m[2]) : null);
    const first = orphanDecision(o, await read(), nowMs, graceMs);
    if (!first.delete) { report.kept.push({ path: o.storage_path, reason: first.reason }); continue; }
    const again = orphanDecision(o, await read(), Date.now() > nowMs ? Date.now() : nowMs, graceMs);
    if (!again.delete) { report.kept.push({ path: o.storage_path, reason: again.reason }); continue; }
    let error = null;
    try { ({ error } = await deps.remove(o.storage_path)); } catch (e) { error = e; }
    if (error) report.failed.push({ path: o.storage_path, reason: String(error?.message ?? error).slice(0, 120) });
    else report.deleted.push({ path: o.storage_path, reason: again.reason });
  }
  return report;
}
