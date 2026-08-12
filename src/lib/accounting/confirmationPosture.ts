/**
 * confirmationPosture.ts — Ω∞ Slice 2 companion.
 *
 * Turns a Provenance<T>'s confidence into the UX posture the directive
 * specifies (Section XVII): HIGH → quiet confirmation line, MEDIUM → one
 * compact question, LOW/NONE → ask explicitly, already-confirmed → never
 * ask again. Pure decision function only — no rendering, no Supabase I/O.
 * The actual confirmation UI is Slice 17.
 */

import type { Provenance } from "./entityContext";

export type ConfirmationPosture =
  | "QUIET_CONFIRMATION" // HIGH confidence: show a quiet, dismissible line
  | "COMPACT_QUESTION" // MEDIUM confidence: one compact "confirm / change" question
  | "EXPLICIT_ASK" // LOW/NONE confidence: ask explicitly, no default framing
  | "NO_PROMPT_NEEDED"; // already professionally confirmed — never ask again

/**
 * Decide how (if at all) to surface a Provenance<T> to the accountant.
 * Derives "already confirmed" from the provenance itself (confirmedBy +
 * confirmedAt both present) rather than a separate caller-supplied flag —
 * a single source of truth that can't be passed out of sync with confidence.
 *
 * Directive Section XVII: "Do not ask again on every upload once
 * professionally confirmed" — this short-circuits regardless of confidence.
 */
export function classifyConfirmationPosture<T>(p: Provenance<T>): ConfirmationPosture {
  if (p.confirmedBy && p.confirmedAt) return "NO_PROMPT_NEEDED";

  switch (p.confidence) {
    case "HIGH":
      return "QUIET_CONFIRMATION";
    case "MEDIUM":
      return "COMPACT_QUESTION";
    case "LOW":
    case "NONE":
      return "EXPLICIT_ASK";
  }
}
