/**
 * firstUpload.test.ts: the first-visit start (src/lib/workspace/firstUpload.ts) — the order of the existing authorities,
 * resume after a failure at every step without repeating any, and the three stages read from the server's milestones.
 * The authorities themselves are proven elsewhere (create_entity, open_engagement_with_period, the draft commit on real
 * PostgreSQL and the local stack; process-trial-balance by its own suites).
 */
import { describe, expect, it } from "vitest";
import { runStart, stagesFromMilestones, type ConfirmedStart, type StartDeps, type StartKeys, type StartProgress } from "./firstUpload";
import { WorkspaceSetupError } from "./workspaceSetupClient";

const C: ConfirmedStart = {
  draftId: "d1",
  entity: { kind: "new", name: "  Invented Trading Ltd " },
  period: { start: "2025-07-01", end: "2026-06-30", year: 2026, name: "Year ended 30 June 2026" },
  currency: "TZS",
};
const K: StartKeys = { entityRequestId: "er-1", commitKey: "ck-0123456789abcdef", checkRequestId: "cr-1" };

function deps(over: Partial<StartDeps> = {}) {
  const calls: string[] = [];
  const failOnce = new Set<string>();
  const counts = { entity: 0, period: 0, add: 0, check: 0 };
  const d: StartDeps = {
    createEntity: async (a) => { calls.push(`entity:${a.requestId}:${a.name}:${a.fiscalYearEnd}:${a.currency}`); if (failOnce.delete("entity")) throw new Error("network"); counts.entity++; return { kind: "created", companyId: "co-1", replayed: false }; },
    openPeriod: async (a) => { calls.push(`period:${a.companyId}:${a.start}:${a.end}:${a.currency}`); if (failOnce.delete("period")) throw new Error("network"); counts.period++; return { outcome: "opened", engagementId: "en-1", periodId: "pe-1", priorPeriodId: null, periodYear: 2026, created: true, granted: [] }; },
    commit: async (a) => { calls.push(`add:${a.draftId}:${a.commitKey}:${a.companyId}:${a.periodId}:${a.engagementId}:${a.periodYear}:${JSON.stringify(a.confirmation)}`); if (failOnce.delete("add")) throw Object.assign(new Error("This didn't finish. Try again; nothing will be added twice."), { retryable: true }); counts.add++; return { uploadId: "up-1" }; },
    check: async (a) => { calls.push(`check:${a.uploadId}:${a.requestId}`); if (failOnce.delete("check")) return { kind: "failed", failure: { step: "check", retry: "same_request", fileSaved: true, message: "The file is saved, but the check could not be completed. Check again; it will not be counted twice." } }; counts.check++; return { kind: "finished" }; },
    ...over,
  };
  return { d, calls, failOnce, counts };
}

describe("runStart: the existing authorities, in order, each once", () => {
  it("entity → period → add → check, with the trimmed name, the period end as year end, and the confirmed context bound to the commit", async () => {
    const { d, calls } = deps();
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "checked", periodYear: 2026, progress: { companyId: "co-1", periodId: "pe-1", engagementId: "en-1", uploadId: "up-1", checked: true } });
    expect(calls).toEqual([
      "entity:er-1:Invented Trading Ltd:2026-06-30:TZS",
      "period:co-1:2025-07-01:2026-06-30:TZS",
      'add:d1:ck-0123456789abcdef:co-1:pe-1:en-1:2026:{"entity":"Invented Trading Ltd","period":"Year ended 30 June 2026","currency":"TZS"}',
      "check:up-1:cr-1",
    ]);
  });
  for (const step of ["entity", "period", "add", "check"] as const) {
    it(`a failure at ${step} resumes there on retry; nothing before it runs again; every key is the same`, async () => {
      const { d, calls, failOnce, counts } = deps();
      failOnce.add(step);
      const first = await runStart(d, C, K, {});
      expect(first).toMatchObject({ kind: "failed", step, retryable: true });
      const n = calls.length;
      const second = await runStart(d, C, K, (first as { progress: StartProgress }).progress);
      expect(second.kind).toBe("checked");
      const order = ["entity", "period", "add", "check"];
      expect(calls.slice(n).map((c) => c.split(":")[0])).toEqual(order.slice(order.indexOf(step)));
      expect(counts).toEqual({ entity: 1, period: 1, add: 1, check: 1 });
      expect(new Set(calls.filter((c) => c.startsWith("add:")).map((c) => c.split(":")[2]))).toEqual(new Set([K.commitKey]));
    });
  }
  it("a finished start, run again with its progress, calls nothing", async () => {
    const { d, calls } = deps();
    const r = await runStart(d, C, K, {});
    calls.length = 0;
    const again = await runStart(d, C, K, (r as { progress: StartProgress }).progress);
    expect(again.kind).toBe("checked");
    expect(calls).toEqual([]);
  });
});

describe("runStart: refusals say why and give the one next action", () => {
  it("entity capacity in use → choose a plan; the draft is kept; nothing else runs", async () => {
    const { d, calls } = deps({ createEntity: async () => ({ kind: "capacity", capacity: { capacity: 1, used: 1, planCode: "SOLO", determined: true } }) });
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "entity", retryable: false, next: "choose_plan" });
    expect((r as { message: string }).message).toMatch(/stays saved as a draft/);
    expect(calls).toEqual([]);
  });
  it("period setup refused for lack of a plan (42501) → choose a plan; the entity and file are kept", async () => {
    const { d } = deps({ openPeriod: async () => { throw new WorkspaceSetupError("NOT_AUTHORISED", "x"); } });
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "period", retryable: false, next: "choose_plan", progress: { companyId: "co-1" } });
  });
  it("a period the server refuses (overlap, year taken) is stated in its words and not retried blindly", async () => {
    const { d } = deps({ openPeriod: async () => ({ outcome: "refused", code: "PERIOD_OVERLAP", message: "These dates overlap another period of this company.", periodId: null }) });
    expect(await runStart(d, C, K, {})).toMatchObject({ kind: "failed", step: "period", retryable: false, message: "These dates overlap another period of this company." });
  });
  it("invalid dates or currency (22023) are not retryable", async () => {
    const { d } = deps({ openPeriod: async () => { throw new WorkspaceSetupError("INVALID", "CURRENCY_UNSUPPORTED — XYZ is not a supported monetary currency"); } });
    expect(await runStart(d, C, K, {})).toMatchObject({ kind: "failed", step: "period", retryable: false });
  });
  it("an expired or mismatched draft → upload again", async () => {
    for (const code of ["expired", "content_mismatch", "not_found"]) {
      const { d } = deps({ commit: async () => { throw Object.assign(new Error("Upload it again."), { code, retryable: false }); } });
      expect(await runStart(d, C, K, {})).toMatchObject({ kind: "failed", step: "add", retryable: false, next: "upload_again" });
    }
  });
  it("the check needs a plan (HTTP 402) → choose a plan; the file stays in the entity", async () => {
    const { d } = deps({ check: async () => ({ kind: "failed", failure: { step: "check", retry: "none", fileSaved: true, needsPlan: true, message: "The file is saved, but checking trial balances is not included in the current plan." } }) });
    expect(await runStart(d, C, K, {})).toMatchObject({ kind: "failed", step: "check", next: "choose_plan", progress: { uploadId: "up-1" } });
  });
  it("a permission refusal at the check is not mistaken for a plan problem", async () => {
    const { d } = deps({ check: async () => ({ kind: "failed", failure: { step: "check", retry: "none", fileSaved: true, message: "The file is saved, but you don't have permission to check trial balances in this workspace." } }) });
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "check", retryable: false });
    expect((r as { next?: string }).next).toBeUndefined();
  });
});

describe("runStart: an existing entity (P2-4) and the purchase-required path", () => {
  const E: ConfirmedStart = { ...C, entity: { kind: "existing", companyId: "co-9", name: "Invented Existing Ltd" } };
  it("an existing entity is never created: period → add → check, against that entity, with its name on the confirmation", async () => {
    const { d, calls } = deps();
    const r = await runStart(d, E, K, {});
    expect(r).toMatchObject({ kind: "checked", progress: { companyId: "co-9" } });
    expect(calls.map((c) => c.split(":")[0])).toEqual(["period", "add", "check"]);
    expect(calls[0]).toContain("period:co-9:");
    expect(calls[1]).toContain('"entity":"Invented Existing Ltd"');
  });
  const refused = { openPeriod: async () => { throw new WorkspaceSetupError("NOT_AUTHORISED", "x"); } };
  it("a refusal for an existing entity whose cause the server cannot say names permission and plan, and offers no plan as the fix", async () => {
    for (const access of [undefined, async () => null, async () => { throw new Error("network"); }]) {
      const { d } = deps({ ...refused, access });
      const r = await runStart(d, E, K, {});
      expect(r).toMatchObject({ kind: "failed", step: "period", retryable: false, next: "choose_entity" });
      expect((r as { message: string }).message).toMatch(/permission.*active plan/);
    }
  });
  it("the account holder's account has no plan: says so, and the one action is Choose a plan", async () => {
    const { d } = deps({ ...refused, access: async () => ({ hasCurrentPlan: false, canPrepare: true, manageBilling: true }) });
    const r = await runStart(d, E, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "period", retryable: false, next: "choose_plan" });
    expect((r as { message: string }).message).toMatch(/^Your account has no active plan\./);
    expect((r as { message: string }).message).not.toMatch(/permission/);
  });
  it("someone else's account has no plan: never offers this person a purchase; asks the owner, or another entity", async () => {
    const { d } = deps({ ...refused, access: async () => ({ hasCurrentPlan: false, canPrepare: true, manageBilling: false }) });
    const r = await runStart(d, E, K, {});
    expect(r).toMatchObject({ kind: "failed", next: "choose_entity" });
    expect((r as { message: string }).message).toMatch(/account has no active plan\. Ask the account's owner/);
  });
  it("the plan is current but this person cannot prepare here: a permission refusal only, never a plan", async () => {
    const { d } = deps({ ...refused, access: async () => ({ hasCurrentPlan: true, canPrepare: false, manageBilling: false }) });
    const r = await runStart(d, E, K, {});
    expect(r).toMatchObject({ kind: "failed", next: "choose_entity" });
    expect((r as { message: string }).message).toMatch(/^You don't have permission to prepare/);
    expect((r as { message: string }).message).not.toMatch(/plan/);
  });
  it("no plan at all (capacity answer without a plan): a plan is needed; the draft is kept; nothing is created", async () => {
    const { d, calls } = deps({ createEntity: async () => ({ kind: "capacity", capacity: { capacity: 0, used: 0, planCode: null, determined: true } }) });
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "entity", next: "choose_plan", retryable: false });
    expect((r as { message: string }).message).toMatch(/needs a plan.*draft/);
    expect(calls).toEqual([]);
  });
});

describe("runStart: the period already has an active trial balance", () => {
  it("the refusal offers replacing it (a choice, never automatic) and carries the refused commit", async () => {
    const { d, calls } = deps({ commit: async () => { throw Object.assign(new Error("A trial balance is already active for this period."), { code: "active_upload_exists", retryable: false, commitId: "c-refused" }); } });
    const r = await runStart(d, C, K, {});
    expect(r).toMatchObject({ kind: "failed", step: "add", next: "replace", commitId: "c-refused", retryable: false });
    expect(calls.filter((c) => c.startsWith("check:"))).toEqual([]);
  });
  it("a chosen replacement is bound to the commit (the upload and the version seen)", async () => {
    let seen: unknown = null;
    const { d } = deps({ commit: async (a) => { seen = a.replaces; return { uploadId: "up-2" }; } });
    const r = await runStart(d, { ...C, replaces: { uploadId: "up-old", expectedVersion: 7 } }, K, { companyId: "co-1", periodId: "pe-1", engagementId: "en-1" });
    expect(r.kind).toBe("checked");
    expect(seen).toEqual({ uploadId: "up-old", expectedVersion: 7 });
  });
});

describe("stagesFromMilestones: File read → Columns confirmed → Checks completed, from the server's record only", () => {
  const all = (status: string) => ["read", "columns", "rows", "amounts", "balance", "classification", "recorded"].map((id) => ({ id, status }));
  it("nothing recorded → every stage pending (never shown as done)", () => {
    expect(stagesFromMilestones(null)).toEqual({ read: "pending", columns: "pending", checks: "pending" });
    expect(stagesFromMilestones([])).toEqual({ read: "pending", columns: "pending", checks: "pending" });
  });
  it("all passed → all done", () => expect(stagesFromMilestones(all("passed"))).toEqual({ read: "done", columns: "done", checks: "done" }));
  it("columns not identified → checks stay pending (no totals before column meaning)", () => {
    const m = all("not_reached"); m[0].status = "passed"; m[1].status = "failed";
    expect(stagesFromMilestones(m)).toEqual({ read: "done", columns: "failed", checks: "pending" });
  });
  it("a failed or review-needing later check is reported as such, never as done", () => {
    const f = all("passed"); f[4].status = "failed";
    expect(stagesFromMilestones(f).checks).toBe("failed");
    const r = all("passed"); r[5].status = "needs_review";
    expect(stagesFromMilestones(r).checks).toBe("needs_review");
    const p = all("passed"); p[6].status = "not_reached";
    expect(stagesFromMilestones(p).checks).toBe("pending");
  });
});
