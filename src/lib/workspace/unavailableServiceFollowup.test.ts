/**
 * Hub hotfix follow-up: access answers are scoped to one authenticated identity, the click guard survives re-renders,
 * and concurrency evidence keeps the server's raw answers apart from the application's confirmed outcomes.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { accessQueryKey, createFlightHolder, gatesForKey, tallyConcurrency, GATE_COPY } from "./unavailableService";
import type { MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";

const ROOT = path.resolve(__dirname, "../../..");
const owner: MyWorkspaceCapabilities = { access: true, held: ["review_close"], allowed: ["review_close"], hasCurrentPlan: true } as never;

describe("access answers belong to one authenticated identity", () => {
  it("the key changes with the user, the companies (order-free) and a refresh", () => {
    const a = accessQueryKey("user-a", ["c2", "c1", "c1"], 0);
    expect(a.companyIds).toEqual(["c1", "c2"]);
    expect(accessQueryKey("user-a", ["c1", "c2"], 0).id).toBe(a.id);
    expect(accessQueryKey("user-b", ["c1", "c2"], 0).id).not.toBe(a.id);
    expect(accessQueryKey("user-a", ["c1", "c2"], 1).id).not.toBe(a.id);
    expect(accessQueryKey(null, ["c1"], 0).userId).toBeNull();
  });

  it("answers recorded for user A are never used for user B (B reads 'checking' until its own answer arrives)", () => {
    const keyA = accessQueryKey("user-a", ["c1"], 0);
    const answersForA = { keyId: keyA.id, byCompany: { c1: owner } };
    expect(gatesForKey(keyA, answersForA).c1).toEqual({ state: "allowed" });
    const keyB = accessQueryKey("user-b", ["c1"], 0);
    expect(gatesForKey(keyB, answersForA).c1).toEqual({ state: "checking", reason: GATE_COPY.checking });
  });

  it("after a refresh the earlier answer is discarded, and with no identity nothing is ever allowed", () => {
    const k0 = accessQueryKey("user-a", ["c1"], 0);
    const stale = { keyId: k0.id, byCompany: { c1: owner } };
    expect(gatesForKey(accessQueryKey("user-a", ["c1"], 1), stale).c1.state).toBe("checking");
    const signedOut = accessQueryKey(null, ["c1"], 0);
    expect(gatesForKey(signedOut, { keyId: signedOut.id, byCompany: { c1: owner } }).c1.state).toBe("checking");
  });

  it("the hook is keyed by the auth user, re-reads on refresh, and the hub re-reads gates after a refused grant", () => {
    const hook = fs.readFileSync(path.join(ROOT, "src/hooks/useReviewActionAccess.ts"), "utf8");
    expect(hook).toMatch(/accessQueryKey\(user\?\.id \?\? null, companyIds, generation\)/);
    expect(hook).toMatch(/a\.keyId === key\.id/); // a late answer for another key is dropped
    const dash = fs.readFileSync(path.join(ROOT, "src/pages/Dashboard.tsx"), "utf8");
    expect(dash).toMatch(/refreshReviewGates\(\)/);
    const hub = fs.readFileSync(path.join(ROOT, "src/hooks/useActiveEngagements.ts"), "utf8");
    expect(hub).toMatch(/shownForRef\.current !== identity/);
    expect(hub).toMatch(/runRef\.current === run/);
  });
});

describe("the click guard survives re-renders", () => {
  it("swapping the callback (a re-render) while in flight does not reset the guard", async () => {
    let release!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const holder = createFlightHolder<[string], void>(first);
    const p = holder.run("e1");
    // The parent re-renders and passes a NEW callback — exactly what the hub does on every render.
    const second = vi.fn(async () => undefined);
    holder.current = second;
    expect(holder.inFlight()).toBe(true);
    expect(await holder.run("e1")).toBeNull();
    expect(second).not.toHaveBeenCalled();
    release();
    await p;
    expect(holder.inFlight()).toBe(false);
    await holder.run("e1");
    expect(second).toHaveBeenCalledTimes(1); // the latest callback runs once the guard is free
  });

  it("the hub keeps ONE holder in a ref and never rebuilds it per render", () => {
    const hub = fs.readFileSync(path.join(ROOT, "src/pages/workspace/EngagementHub.tsx"), "utf8");
    expect(hub).toMatch(/useRef<[\s\S]*createFlightHolder/);
    expect(hub).toMatch(/if \(!flight\.current\) flight\.current = createFlightHolder/);
    expect(hub).not.toMatch(/useMemo\([\s\S]{0,60}singleFlight/);
  });
});

describe("concurrency evidence: raw server answers vs application-confirmed outcomes", () => {
  it("tallies each separately, never conflating an 'already granted' answer with a grant", () => {
    const raw = [{ error: null }, { error: { code: "23001" } }, { error: { code: "23001" } }, { error: { code: "40001" } }];
    const t = tallyConcurrency(raw, [{ ok: true }, { ok: true }, { ok: false, kind: "UNCONFIRMED", message: "x" }]);
    expect(t).toEqual({ raw: { granted: 1, alreadyGranted: 2, otherErrors: { "40001": 1 } }, confirmed: { ok: 2, notOk: { UNCONFIRMED: 1 } } });
  });

  it("the disposable proof reports both, creates its OWN uniquely named database and drops only that one", () => {
    const proof = fs.readFileSync(path.join(ROOT, "scripts/db-proof/hubTrialBalanceReview.mjs"), "utf8");
    expect(proof).toMatch(/RAW server answers/);
    expect(proof).toMatch(/APPLICATION-confirmed outcomes/);
    expect(proof).toMatch(/const PROOF_DB = `hub_proof_\$\{process\.pid\}_/);
    expect(proof).not.toMatch(/DROP DATABASE IF EXISTS hub_proof[^_]/);
    expect(proof).not.toMatch(/CREATE DATABASE hub_proof[^_"]/);
    expect(proof).toMatch(/DROP DATABASE IF EXISTS "\$\{PROOF_DB\}"/);
  });
});
