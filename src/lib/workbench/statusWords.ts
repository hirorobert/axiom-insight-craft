/**
 * Status words: the one mapping from server status values to the words, icon and tone the workbench shows. Pure.
 *
 * Exhaustive over each server enum (a new server value fails to compile until it is mapped). Colour is never the only
 * signal: every status carries text and an icon glyph.
 */
import type { MissionStatus } from "@/lib/workspace/types";
import type { AuthorityReason } from "@/lib/workspace/uploadAuthority";

export type StatusTone = "ok" | "attention" | "blocked" | "stale" | "neutral" | "working";

export interface StatusWord {
  readonly text: string;
  readonly tone: StatusTone;
}

/** Icon glyph per tone (paired with text; decorative for assistive technology). */
export const TONE_ICON: Readonly<Record<StatusTone, string>> = Object.freeze({
  ok: "✓",
  attention: "!",
  blocked: "✕",
  stale: "↻",
  neutral: "–",
  working: "◷",
});

/** Text colour per tone. Each meets WCAG 2.2 AA (≥ 4.5:1) on white; asserted by statusWords.test.ts. */
export const TONE_COLOR: Readonly<Record<StatusTone, string>> = Object.freeze({
  ok: "#22663f",
  attention: "#7a4a00",
  blocked: "#a12020",
  stale: "#5b4b8a",
  neutral: "#5f6b7a",
  working: "#465263",
});

export const MISSION_STATUS_WORDS = Object.freeze({
  not_started: { text: "Not started", tone: "neutral" },
  in_progress: { text: "In progress", tone: "working" },
  ready: { text: "Ready", tone: "ok" },
  passed: { text: "Complete", tone: "ok" },
  review_required: { text: "Needs review", tone: "attention" },
  blocked: { text: "Blocked", tone: "blocked" },
  signed: { text: "Signed", tone: "ok" },
  locked: { text: "Not yet available", tone: "neutral" },
  not_applicable: { text: "Not applicable", tone: "neutral" },
} satisfies Record<MissionStatus, StatusWord>);

export const AUTHORITY_STATUS_WORDS = Object.freeze({
  current: { text: "Current", tone: "ok" },
  attempt_running: { text: "Checking", tone: "working" },
  attempt_failed: { text: "Check failed", tone: "blocked" },
  attempt_abandoned: { text: "Processing stopped", tone: "blocked" },
  not_certified: { text: "Not yet checked", tone: "neutral" },
  legacy_certification: { text: "Needs re-check", tone: "stale" },
  superseded_attempt: { text: "Replaced by a newer check", tone: "neutral" },
  invalidated: { text: "Needs re-check", tone: "stale" },
  source_changed: { text: "File changed — needs re-check", tone: "stale" },
  dependency_changed: { text: "Needs re-check", tone: "stale" },
  blocked: { text: "Blocked", tone: "blocked" },
  needs_review: { text: "Needs review", tone: "attention" },
  upload_not_active: { text: "Not in use", tone: "neutral" },
} satisfies Record<AuthorityReason, StatusWord>);

export function missionStatusWord(status: MissionStatus): StatusWord {
  return MISSION_STATUS_WORDS[status];
}

export function authorityStatusWord(reason: AuthorityReason): StatusWord {
  return AUTHORITY_STATUS_WORDS[reason];
}
