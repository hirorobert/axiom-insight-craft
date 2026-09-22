import { describe, expect, it } from "vitest";
import { deriveScopeChange, isScopeSaveDisabled } from "./engagementScopeChange";
import type { EngagementCapability } from "./mandate";

const FS: EngagementCapability = "FINANCIAL_STATEMENTS";
const TAX: EngagementCapability = "TAX_COMPUTATION";
const COMPLIANCE: EngagementCapability = "COMPLIANCE_REVIEW";

describe("deriveScopeChange — service-scope UX: 'Start another service' vs 'Amend this engagement'", () => {
  it("add mode, pure addition: never requires a reason regardless of what's added", () => {
    const change = deriveScopeChange("add", [FS], [FS, TAX]);
    expect(change.added).toEqual([TAX]);
    expect(change.removed).toEqual([]);
    expect(change.removalRequiresReason).toBe(false);
  });

  it("amend mode, pure addition (no withdrawal): still no reason required — adding is never material", () => {
    const change = deriveScopeChange("amend", [FS], [FS, TAX]);
    expect(change.added).toEqual([TAX]);
    expect(change.removed).toEqual([]);
    expect(change.removalRequiresReason).toBe(false);
  });

  it("amend mode, a withdrawal: requires a reason — this is the one material change", () => {
    const change = deriveScopeChange("amend", [FS, TAX], [FS]);
    expect(change.removed).toEqual([TAX]);
    expect(change.removalRequiresReason).toBe(true);
  });

  it("amend mode, simultaneous add and remove: still requires a reason (the removal half is material)", () => {
    const change = deriveScopeChange("amend", [FS, TAX], [FS, COMPLIANCE]);
    expect(change.added).toEqual([COMPLIANCE]);
    expect(change.removed).toEqual([TAX]);
    expect(change.removalRequiresReason).toBe(true);
  });

  it("declare mode never requires a reason — there is no prior scope to explain a change against", () => {
    const change = deriveScopeChange("declare", [], [FS]);
    expect(change.removalRequiresReason).toBe(false);
  });

  it("no change at all: changed is false in every mode", () => {
    expect(deriveScopeChange("amend", [FS], [FS]).changed).toBe(false);
    expect(deriveScopeChange("add", [FS], [FS]).changed).toBe(false);
  });
});

describe("isScopeSaveDisabled", () => {
  const change = (mode: "declare" | "add" | "amend", current: EngagementCapability[], selected: EngagementCapability[]) =>
    deriveScopeChange(mode, current, selected);

  it("declare: enabled as soon as something is selected, no reason needed", () => {
    expect(isScopeSaveDisabled({ mode: "declare", saving: false, selected: [FS], change: change("declare", [], [FS]), reason: "" })).toBe(false);
  });

  it("declare: disabled with nothing selected", () => {
    expect(isScopeSaveDisabled({ mode: "declare", saving: false, selected: [], change: change("declare", [], []), reason: "" })).toBe(true);
  });

  it("add: disabled when nothing new is added (only already-active services selected)", () => {
    expect(isScopeSaveDisabled({ mode: "add", saving: false, selected: [FS], change: change("add", [FS], [FS]), reason: "" })).toBe(true);
  });

  it("add: enabled once a new service is added, no reason needed", () => {
    expect(isScopeSaveDisabled({ mode: "add", saving: false, selected: [FS, TAX], change: change("add", [FS], [FS, TAX]), reason: "" })).toBe(false);
  });

  it("amend: disabled when unchanged", () => {
    expect(isScopeSaveDisabled({ mode: "amend", saving: false, selected: [FS], change: change("amend", [FS], [FS]), reason: "" })).toBe(true);
  });

  it("amend: an addition-only change is enabled with an EMPTY reason — no friction for ordinary discovery", () => {
    expect(isScopeSaveDisabled({ mode: "amend", saving: false, selected: [FS, TAX], change: change("amend", [FS], [FS, TAX]), reason: "" })).toBe(false);
  });

  it("amend: a withdrawal is disabled until a reason of at least 3 characters is given", () => {
    const withdrawal = change("amend", [FS, TAX], [FS]);
    expect(isScopeSaveDisabled({ mode: "amend", saving: false, selected: [FS], change: withdrawal, reason: "" })).toBe(true);
    expect(isScopeSaveDisabled({ mode: "amend", saving: false, selected: [FS], change: withdrawal, reason: "no" })).toBe(true);
    expect(isScopeSaveDisabled({ mode: "amend", saving: false, selected: [FS], change: withdrawal, reason: "Client no longer needs this." })).toBe(false);
  });

  it("saving in flight always disables, in every mode", () => {
    expect(isScopeSaveDisabled({ mode: "declare", saving: true, selected: [FS], change: change("declare", [], [FS]), reason: "" })).toBe(true);
    expect(isScopeSaveDisabled({ mode: "add", saving: true, selected: [FS, TAX], change: change("add", [FS], [FS, TAX]), reason: "" })).toBe(true);
  });
});
