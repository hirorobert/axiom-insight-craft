import { describe, expect, it } from "vitest";
import { buildControlArgs, describeControlError, parseControl, type ProcessingControl } from "./processingControl";

const live: ProcessingControl = { hold: false, held_at: null, canary_company_ids: [], min_engine_generation: 3, reason: "r", version: 5 };
const canary = "659daa94-116c-4803-99f8-157e0bdd4c62";

describe("processing control", () => {
  it("pause keeps the current floor and canaries and passes the observed version", () => {
    const r = buildControlArgs("pause", live, "TB release");
    expect(r).toEqual({ args: { p_hold: true, p_canary_company_ids: [], p_min_engine_generation: 3, p_reason: "TB release", p_expected_version: 5 } });
  });
  it("requires a reason", () => {
    expect(buildControlArgs("pause", live, "  ")).toHaveProperty("error");
  });
  it("canary needs a hold and a valid ID, and raises the floor to 7", () => {
    expect(buildControlArgs("canary", live, "canary", canary)).toHaveProperty("error");
    const held = { ...live, hold: true, version: 6 };
    expect(buildControlArgs("canary", held, "canary", "x")).toHaveProperty("error");
    expect(buildControlArgs("canary", held, "canary", canary)).toEqual({ args: { p_hold: true, p_canary_company_ids: [canary], p_min_engine_generation: 7, p_reason: "canary", p_expected_version: 6 } });
  });
  it("resume is refused below floor 7 and clears canaries at 7", () => {
    expect(buildControlArgs("resume", { ...live, hold: true }, "resume")).toHaveProperty("error");
    const r = buildControlArgs("resume", { ...live, hold: true, min_engine_generation: 7, canary_company_ids: [canary], version: 7 }, "resume");
    expect(r).toEqual({ args: { p_hold: false, p_canary_company_ids: [], p_min_engine_generation: 7, p_reason: "resume", p_expected_version: 7 } });
  });
  it("never lowers a higher floor", () => {
    const r = buildControlArgs("pause", { ...live, min_engine_generation: 8 }, "pause");
    expect("args" in r && r.args.p_min_engine_generation).toBe(8);
  });
  it("classifies permission and version failures", () => {
    expect(describeControlError({ message: "NOT_A_COMMERCIAL_ADMIN", code: "42501" })).toMatch(/not an active commercial administrator/);
    expect(describeControlError({ message: "CONTROL_VERSION_CONFLICT: current version 6", code: "40001" })).toMatch(/changed the control/);
  });
  it("rejects malformed state", () => {
    expect(parseControl({ hold: "no" })).toBeNull();
    expect(parseControl({ ...live })).toEqual(live);
  });
});

import { describeSubmitOutcome, OUTCOME_UNCONFIRMED } from "./processingControl";
describe("uncertain outcomes", () => {
  it("never claims nothing changed for an unknown error or lost response", () => {
    expect(describeControlError({ message: "Failed to fetch" })).toBe(OUTCOME_UNCONFIRMED);
    expect(describeControlError({ message: "upstream timeout", code: "57014" })).not.toMatch(/Nothing was changed/);
    expect(describeControlError(undefined)).toBe(OUTCOME_UNCONFIRMED);
  });
  it("a thrown write is unconfirmed, and a failed read-back is stated", () => {
    const r = describeSubmitOutcome("thrown", false);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/could not be confirmed/);
    expect(r.text).toMatch(/could not be read/);
    expect(r.text).not.toMatch(/re-read from the server/);
  });
  it("a successful write with a failed read-back is saved but state unconfirmed", () => {
    const r = describeSubmitOutcome({ error: null }, false);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Saved\./);
    expect(r.text).toMatch(/could not be read/);
  });
  it("a known refusal keeps 'Nothing was changed' and reports the read-back", () => {
    const r = describeSubmitOutcome({ error: { message: "CONTROL_VERSION_CONFLICT: current version 6", code: "40001" } }, true);
    expect(r.text).toMatch(/Nothing was changed/);
    expect(r.text).toMatch(/re-read from the server/);
  });
});
