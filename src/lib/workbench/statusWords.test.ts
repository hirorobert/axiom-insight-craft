import { describe, expect, it } from "vitest";
import { AUTHORITY_REASONS } from "@/lib/workspace/uploadAuthority";
import { AUTHORITY_STATUS_WORDS, MISSION_STATUS_WORDS, TONE_COLOR, TONE_ICON } from "./statusWords";
import { contrast } from "./testkit/dom";

const MISSION = ["not_started", "in_progress", "ready", "passed", "review_required", "blocked", "signed", "locked", "not_applicable"];

describe("status words", () => {
  it("map every server value 1:1, with text", () => {
    expect(Object.keys(MISSION_STATUS_WORDS).sort()).toEqual([...MISSION].sort());
    expect(Object.keys(AUTHORITY_STATUS_WORDS).sort()).toEqual([...AUTHORITY_REASONS].sort());
    for (const w of [...Object.values(MISSION_STATUS_WORDS), ...Object.values(AUTHORITY_STATUS_WORDS)]) expect(w.text.length).toBeGreaterThan(0);
  });
  it("never rely on colour alone: every tone has an icon and a colour", () => {
    for (const t of Object.keys(TONE_COLOR) as (keyof typeof TONE_COLOR)[]) expect(TONE_ICON[t]).toBeTruthy();
  });
  it("every tone colour meets WCAG AA (4.5:1) on white and on the muted panel background", () => {
    for (const [tone, c] of Object.entries(TONE_COLOR)) {
      expect(contrast(c, "#ffffff"), tone).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, "#f7f8fa"), tone).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("never present a stale or unknown result as current", () => {
    for (const r of ["legacy_certification", "invalidated", "dependency_changed", "source_changed"] as const) expect(AUTHORITY_STATUS_WORDS[r].tone).toBe("stale");
    expect(AUTHORITY_STATUS_WORDS.current.tone).toBe("ok");
  });
});
