import { effectKey } from "./money.ts";
import type { AdjustmentRow, CorrectionState, Line, Outcome } from "./types.ts";

export interface CorrectionRow { id: string; cid: string; approved: boolean; lines: Line[]; scope: string; reverses: string | null }
export interface CorrectionConflict { rule: string; outcome: Outcome; scope: string; detail: Record<string, unknown> }

/**
 * THE one authoritative set of effective corrections.
 *
 * Every approved-adjustment row, from whichever path produced it (a proposal approved in this evaluation, a persisted
 * adjustment), is reduced here to corrections keyed by IDENTITY. Only what this returns is added to the trial balance,
 * exactly once each.
 *
 *   one identity, one effect, many rows   duplicate submission, retry, reimport: counts once
 *   one identity, two effects             CORRECTION_IDENTITY_CONFLICT: neither applies, the scope holds
 *   two identities, one effect            CORRECTION_DUPLICATE_EFFECT: neither applies, a reviewer withdraws one
 *   an approved reversal                  removes its target and itself
 *   source verification                   retired (verified), suspended (partial, reversed) or kept
 */
export function effectiveCorrections(rows: readonly CorrectionRow[], verification: readonly CorrectionState[] = []): { effective: CorrectionRow[]; conflicts: CorrectionConflict[] } {
  const conflicts: CorrectionConflict[] = [];
  const byCid = new Map<string, CorrectionRow[]>();
  for (const r of rows) { const g = byCid.get(r.cid); if (g) g.push(r); else byCid.set(r.cid, [r]); }
  const candidates: CorrectionRow[] = [];
  for (const [cid, group] of byCid) {
    if (new Set(group.map((g) => effectKey(g.lines))).size > 1) {
      for (const sc of new Set(group.map((g) => g.scope))) conflicts.push({ rule: "CORRECTION_IDENTITY_CONFLICT", outcome: "confirmed", scope: sc, detail: { correction: cid } });
      continue;
    }
    if (group.length > 1) conflicts.push({ rule: "CORRECTION_DUPLICATE_IGNORED", outcome: "pass", scope: group[0].scope, detail: { correction: cid, copies: group.length } });
    const first = group.find((g) => g.approved) ?? group[0];
    candidates.push({ ...first, approved: group.some((g) => g.approved), reverses: group.find((g) => g.reverses)?.reverses ?? null });
  }
  const reversed = new Set(candidates.filter((c) => c.approved && c.reverses).flatMap((c) => [c.cid, c.reverses as string]));
  for (const id of reversed) { const c = candidates.find((x) => x.cid === id); if (c && !c.reverses) conflicts.push({ rule: "CORRECTION_REVERSED", outcome: "pass", scope: c.scope, detail: { correction: id } }); }
  let live = candidates.filter((c) => c.approved && !reversed.has(c.cid));
  const byEffect = new Map<string, CorrectionRow[]>();
  for (const c of live) { const k = effectKey(c.lines); const g = byEffect.get(k); if (g) g.push(c); else byEffect.set(k, [c]); }
  const dup = new Set<string>();
  for (const group of byEffect.values()) {
    if (group.length < 2) continue;
    for (const c of group) dup.add(c.cid);
    for (const sc of new Set(group.map((g) => g.scope))) conflicts.push({ rule: "CORRECTION_DUPLICATE_EFFECT", outcome: "confirmed", scope: sc, detail: { corrections: group.map((g) => g.cid).sort() } });
  }
  live = live.filter((c) => !dup.has(c.cid));
  live = live.filter((c) => { const v = verification.find((x) => x.id === c.cid); return v ? v.adjustment_applied : true; });
  return { effective: live, conflicts };
}

export function rowsFrom(persisted: readonly AdjustmentRow[]): CorrectionRow[] {
  return persisted.map((ra) => ({ id: ra.id, cid: ra.correction_id ?? ra.id, approved: ra.approved === true, lines: ra.lines, scope: ra.scope ?? "pack", reverses: ra.reverses ?? null }));
}
