// Prompt remediation (cfoclose-assistant-prompt/2) for the failure classes seen in the synthetic evaluation of 2026-10-25.
// Offline only: no provider is contacted. The validator is unchanged — these tests prove the prompt now states each rule
// the validator enforces, and that the validator still refuses each recorded failure class.
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../../../supabase/functions/_shared/assistantProvider";
import { wordingErrors } from "../../../supabase/functions/_shared/assistantResponse";

describe("prompt v2 remediation", () => {
  it("has a new version so recorded runs stay attributable to the prompt they used", () => {
    expect(PROMPT_VERSION).toBe("cfoclose-assistant-prompt/2");
  });
  it("tells the model to cite the line source with period facts (failure: missing period source)", () => {
    expect(SYSTEM_PROMPT).toMatch(/period\.current, period\.comparative.*statement line source/s);
  });
  it("forbids missing blocks without an unavailable fact (failure: empty missing block)", () => {
    expect(SYSTEM_PROMPT).toContain("Write a \"missing\" block only when at least one listed fact is not available");
  });
  it("forbids figures in next steps (failure: next step cited figures)", () => {
    expect(SYSTEM_PROMPT).toContain("A \"next_step\" block contains text only: no factRef parts.");
  });
  it("bounds length so the JSON completes within the output bound (failure: truncated, not a JSON object)", () => {
    expect(SYSTEM_PROMPT).toContain("at most three sentences per block");
    expect(SYSTEM_PROMPT).toContain("Mention at most three contributing accounts");
    expect(SYSTEM_PROMPT).toContain("no preamble");
  });
  it("forbids copying numbered names and mentioning certifications (failures: digit, \"certified\")", () => {
    expect(SYSTEM_PROMPT).toContain("must not be copied into text");
    expect(SYSTEM_PROMPT).toContain("Do not mention certifications");
  });
  it("the validator still refuses every recorded wording failure class (safeguards unchanged)", () => {
    expect(wordingErrors("Account 4010 moved", "b").join()).toMatch(/digit/);
    expect(wordingErrors("The two accounts moved", "b").join()).toMatch(/quantity in words/);
    expect(wordingErrors("The certified balance", "b").join()).toMatch(/approval, verification/);
    expect(wordingErrors("It rose because of sales", "b").join()).toMatch(/causal/);
  });
});
