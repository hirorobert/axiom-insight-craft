import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { COMPARATIVE_STATES, COMPARATIVE_WORDS, comparativesClient, parseComparativeStatus } from "./comparatives";

const SQL = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/20261020100000_fs_comparatives.sql"), "utf8");

describe("comparative states: one per server state", () => {
  it("every state fs_comparatives_status can return has its own words, and nothing else does", () => {
    const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.fs_comparatives_status"), SQL.indexOf("CREATE OR REPLACE FUNCTION public.fs_approve_comparatives"));
    const server = new Set([...fn.matchAll(/v_state := '([a-z_]+)'/g)].map((m) => m[1]));
    expect([...server].sort()).toEqual([...COMPARATIVE_STATES].sort());
    expect(Object.keys(COMPARATIVE_WORDS).sort()).toEqual([...COMPARATIVE_STATES].sort());
  });
  it("only an approved comparative or an approved first-period exception satisfies the requirement — reference-only never does", () => {
    expect(COMPARATIVE_STATES.filter((s) => COMPARATIVE_WORDS[s].satisfiesRequirement).sort()).toEqual(["approved", "first_period_exception"]);
    expect(COMPARATIVE_WORDS.reference_only.detail).toMatch(/never count as approved/);
    expect(COMPARATIVE_WORDS.different_currency.detail).toMatch(/translation is not supported yet/);
  });
});

describe("payload and server calls", () => {
  const evaluated = { state: "evaluated", statusSha256: "c".repeat(64), comparative: { contract: "fs-comparatives-status/1", periodYear: 2026, state: "unapproved",
    composedComparativeState: "available", required: true, firstPeriodDeclared: false, comparativeSha256: "a".repeat(64), compositionSha256: "b".repeat(64), approval: null,
    blockers: ["COMPARATIVE_NOT_APPROVED"] } };
  it("parses the evaluated payload and pass-through states; refuses an unknown comparative state", () => {
    expect(parseComparativeStatus(evaluated).state).toBe("evaluated");
    expect(parseComparativeStatus({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(() => parseComparativeStatus({ ...evaluated, comparative: { ...evaluated.comparative, state: "fine" } })).toThrow();
  });
  it("calls exactly the five server functions with these arguments", async () => {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "fs_comparatives_status" ? evaluated : { outcome: "recorded" }, error: null }));
    const c = comparativesClient({ rpc });
    await c.status("co", 2026);
    await c.bridge("co", 2026, "6150", "6100", "Renumbered", "r1");
    await c.proposeRestatement("co", 2026, [{ lineId: "sfp.inventories", section: "current_assets", deltaMinor: "100" }], "Error", "Note 14", "r2");
    await c.decideRestatement("rs", "approved", "Checked", "r3");
    await c.approve("co", 2026, true, "Agreed", "r4");
    expect(rpc.mock.calls.map((x) => x[0])).toEqual(["fs_comparatives_status", "fs_bridge_comparative_account", "fs_propose_restatement", "fs_decide_restatement", "fs_approve_comparatives"]);
    expect(rpc.mock.calls[3][1]).toEqual({ p_restatement_id: "rs", p_decision: "approved", p_reason: "Checked", p_request_id: "r3" });
  });
  it("writes no table and reaches no withheld service", () => {
    const src = fs.readFileSync(path.join(__dirname, "comparatives.ts"), "utf8");
    expect(src).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(src).not.toMatch(/kinga|generate-disclosure-notes|generate-management-letter|generate-xbrl/i);
  });
});
