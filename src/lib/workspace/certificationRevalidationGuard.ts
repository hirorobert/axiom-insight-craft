/**
 * certificationRevalidationGuard — pure state-machine for PPG-1R HIGH-1
 * ("stale CERTIFIED may remain visible while reprocessing is already
 * underway").
 *
 * PPG-1's fix only invalidated the pre-flight certification display at the
 * TERMINAL boundary of a reprocess poll (success/error/timeout). Codex
 * correctly rejected that: the entire window between "the backend accepted
 * the reprocess" and "the poll detects a terminal status" (up to 90s) left
 * whatever verdict was already on screen untouched — including a real but
 * now-superseded CERTIFIED.
 *
 * This module is the DECISION LOGIC only — extracted out of the React
 * event handlers in PrepareWorkspace.tsx / AccountReviewPanel.tsx so the
 * exact state transitions the mission requires can be hostile-tested as
 * pure function calls, without needing a component-rendering test harness
 * (this repository has none, and installing one is tooling expansion, not
 * a defect repair). React remains responsible only for wiring these
 * transitions to the right events and holding the resulting boolean in
 * state — it creates no certification authority of its own; the
 * server/database remains sole authority (Iron Dome §4.2).
 *
 * Invariant this machine enforces: once TRUE, the guard can only become
 * FALSE via a TERMINAL_CONFIRMED or UPLOAD_IDENTITY_CHANGED event — never
 * merely by time passing, never by a fetch returning ANY particular data
 * (a stale read while revalidating must not clear it), and never by an
 * unconfirmed timeout (the mission's explicit "remain non-authoritative/
 * pending rather than restoring stale CERTIFIED").
 */

export type CertificationGuardEvent =
  /** The reprocess/mutation request itself could not be started — nothing changed, guard is left exactly as it was. */
  | { type: "MUTATION_INITIATION_FAILED" }
  /** The backend confirmed it accepted the reprocess request — the currently-displayed certification is no longer safe to present as current, starting THIS instant. */
  | { type: "MUTATION_ACCEPTED" }
  /** A fresh read was taken AFTER confirming the backend reached a terminal status (complete/error/blocked/needs_review) for this exact reprocess. */
  | { type: "TERMINAL_CONFIRMED" }
  /** The poll window elapsed without ever observing a terminal status. No claim can be made about whether reprocessing is done — remain pending. */
  | { type: "TIMEOUT_NO_TERMINAL_CONFIRMED" }
  /** A different upload is now being displayed (replace, discard+undo, history selection) — any prior guard was scoped to the previous upload's lifecycle. */
  | { type: "UPLOAD_IDENTITY_CHANGED" };

/**
 * Applies one event to the current guard value. Never reads or writes
 * anything itself — purely `(bool, event) => bool`.
 */
export function reduceCertificationRevalidationGuard(
  isRevalidating: boolean,
  event: CertificationGuardEvent,
): boolean {
  switch (event.type) {
    case "MUTATION_INITIATION_FAILED":
      return isRevalidating;
    case "MUTATION_ACCEPTED":
      return true;
    case "TERMINAL_CONFIRMED":
      return false;
    case "TIMEOUT_NO_TERMINAL_CONFIRMED":
      return true;
    case "UPLOAD_IDENTITY_CHANGED":
      return false;
    default: {
      const _exhaustive: never = event;
      return isRevalidating;
    }
  }
}

/**
 * Rapid-second-invocation guard: a new reprocess/mutation must never be
 * started while the display is already in a revalidating window from a
 * prior one — starting a second concurrent poll against the same upload
 * would race two independent timers against the same certification state.
 */
export function canInitiateCertificationAffectingMutation(isRevalidating: boolean): boolean {
  return !isRevalidating;
}
