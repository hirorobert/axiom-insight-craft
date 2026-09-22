/**
 * engagementScopeChange — the pure decision behind EngagementScopeDialog's three modes
 * (declare / add / amend). Extracted so the "remove amendment-reason friction from ordinary
 * service discovery, preserve it only for material changes" rule is directly unit-tested rather
 * than only exercised through a rendered dialog.
 *
 * Material change = withdrawing a service that was already granted. Adding one — through "add" OR
 * through "amend" — never undoes or reinterprets anything that exists, so it never requires a
 * reason. Only "amend" can withdraw at all; "add" is addition-only by construction (the dialog
 * never lets an already-granted capability be toggled off while in "add" mode).
 */

import type { EngagementCapability } from "./mandate";

export type ScopeDialogMode = "declare" | "add" | "amend";

export interface ScopeChangeResult {
  added: EngagementCapability[];
  removed: EngagementCapability[];
  changed: boolean;
  /** True only when this change withdraws something AND the surface used is "amend". */
  removalRequiresReason: boolean;
}

export function deriveScopeChange(
  mode: ScopeDialogMode,
  current: EngagementCapability[],
  selected: EngagementCapability[],
): ScopeChangeResult {
  const added = selected.filter((c) => !current.includes(c));
  const removed = current.filter((c) => !selected.includes(c));
  const changed = added.length > 0 || removed.length > 0;
  const removalRequiresReason = mode === "amend" && removed.length > 0;
  return { added, removed, changed, removalRequiresReason };
}

export interface ScopeSaveGateInput {
  mode: ScopeDialogMode;
  saving: boolean;
  selected: EngagementCapability[];
  change: ScopeChangeResult;
  reason: string;
}

/** Whether the dialog's save action may fire. */
export function isScopeSaveDisabled(input: ScopeSaveGateInput): boolean {
  const { mode, saving, selected, change, reason } = input;
  if (saving) return true;
  if (selected.length === 0) return true;
  if (mode === "declare") return false;
  if (mode === "add") return change.added.length === 0;
  // amend
  if (!change.changed) return true;
  if (change.removalRequiresReason && reason.trim().length < 3) return true;
  return false;
}
