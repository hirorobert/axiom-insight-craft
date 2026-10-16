/**
 * draftUpload.test.ts: the decision sequence of the trial-balance-draft Edge Function
 * (supabase/functions/_shared/draftUpload.ts), against a small STATEFUL model of the database and Storage so a stop at
 * every step, a lost response and a retry can be exercised. The model is a test double: the database rules themselves
 * are proven on real PostgreSQL (scripts/db-proof/trialBalanceDrafts.mjs) and the real function, Storage and Auth on the
 * local Supabase stack (scripts/e2e/draftJourney.mjs).
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseDraftRequest, runDraftRequest, type BeginResult, type DraftDeps, type DraftRequest } from "../../../supabase/functions/_shared/draftUpload";

const U = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const CO = "33333333-3333-4333-8333-333333333333";
const KEY = "commit-key-0123456789abcdef";
const BYTES = new TextEncoder().encode("code,name,debit,credit\n1000,Cash,10,0\n2000,Capital,0,10\n");
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const CONF = { entity: "Invented Trading Ltd", period: "1 Jan 2025 – 31 Dec 2025", currency: "TZS" };
const COMMIT: Extract<DraftRequest, { action: "commit" }> = { action: "commit", draftId: D, commitKey: KEY, companyId: CO, periodYear: 2025, periodId: null, engagementId: null, confirmation: CONF };

/** A minimal model of the recorded state the real database keeps. */
function world() {
  const storage = new Map<string, Uint8Array>();
  const draftPath = `drafts/${U}/${D}/tb.csv`;
  storage.set(draftPath, BYTES);
  const s = {
    storage, draftPath,
    draft: { state: "reserved" as string, sha: sha(BYTES), size: BYTES.byteLength },
    commit: null as null | { id: string; hash: string; reservation: string | null; verified: boolean; upload: string | null; state: string },
    reservations: new Map<string, { path: string; consumedBy: string | null; expired: boolean }>(),
    uploads: [] as string[],
    authorised: true,
    calls: [] as string[],
    failOnce: new Set<string>(),
    copyCorrupts: false,
  };
  const step = (name: string) => { s.calls.push(name); if (s.failOnce.delete(name)) throw Object.assign(new Error(`stop at ${name}`), { code: "STOP" }); };
  const hashOf = (r: typeof COMMIT) => JSON.stringify([r.draftId, r.companyId, r.periodYear, r.periodId, r.engagementId, r.confirmation]);
  let n = 0;
  const deps: DraftDeps = {
    authenticate: async () => U,
    signTarget: async () => ({ object_path: draftPath, signable: s.draft.state === "reserved", stored: storage.has(draftPath) }),
    signUpload: async (p) => ({ path: p, token: "t" }),
    canManage: async () => { step("canManage"); return s.authorised; },
    beginCommit: async (_u, r): Promise<BeginResult> => {
      step("begin");
      const h = hashOf(r);
      const base = { object_path: draftPath, file_name: "tb.csv", file_size: s.draft.size, content_sha256: s.draft.sha };
      if (s.commit) {
        if (s.commit.hash !== h) return { outcome: "conflict" } as BeginResult;
        const res = s.commit.reservation ? s.reservations.get(s.commit.reservation)! : null;
        const rs = !res ? "none" : res.consumedBy ? "consumed" : res.expired ? "expired" : "live";
        return { ...base, outcome: s.commit.state === "committed" ? "already_committed" : "resume", commit_id: s.commit.id, reservation_id: s.commit.reservation, reservation_state: rs, copy_verified: s.commit.verified, upload_id: s.commit.upload };
      }
      if (s.draft.state !== "reserved") return { outcome: "not_eligible" } as BeginResult;
      s.commit = { id: "c1", hash: h, reservation: null, verified: false, upload: null, state: "open" };
      s.draft.state = "committing";
      return { ...base, outcome: "started", commit_id: "c1", reservation_id: null, reservation_state: "none", copy_verified: false, upload_id: null };
    },
    reserveSource: async (co) => {
      step("reserve");
      if (!s.authorised) return { outcome: "forbidden", reservation_id: null, object_path: null };
      const id = `r${++n}`; const path = `workspaces/${co}/${id}/tb.csv`;
      s.reservations.set(id, { path, consumedBy: null, expired: false });
      return { outcome: "reserved", reservation_id: id, object_path: path };
    },
    recordReservation: async (_c, _u, id) => { step("record"); s.commit!.reservation = id; s.commit!.verified = false; return "recorded"; },
    reservationPath: async (id) => s.reservations.get(id)?.path ?? null,
    readObject: async (p) => { step(`read:${p.startsWith("drafts/") ? "draft" : "copy"}`); return storage.get(p) ?? null; },
    copyObject: async (from, to) => {
      step("copy");
      if (storage.has(to)) return false; // never overwrites
      const b = storage.get(from)!;
      storage.set(to, s.copyCorrupts ? b.slice(1) : b);
      return true;
    },
    removeObject: async (p) => { step("remove"); return storage.delete(p); },
    sha256: async (b) => sha(b),
    recordCopyVerified: async (_c, _u, h, size) => { step("verify"); if (h !== s.draft.sha || size !== s.draft.size) return "mismatch"; s.commit!.verified = true; return "verified"; },
    retire: async (old, _v, id) => {
      step("retire");
      const res = s.reservations.get(id)!;
      if (res.consumedBy) return { outcome: "replaced", new_upload_id: res.consumedBy, detail: null };
      if (old !== "u-old") return { outcome: "stale_version", new_upload_id: null, detail: null };
      const up = `u${s.uploads.length + 1}`; s.uploads.push(up); res.consumedBy = up;
      return { outcome: "replaced", new_upload_id: up, detail: null };
    },
    register: async (id) => {
      step("register");
      if (!s.authorised) return { outcome: "forbidden", upload_id: null, detail: null };
      const res = s.reservations.get(id)!;
      if (res.consumedBy) return { outcome: "already_registered", upload_id: res.consumedBy, detail: null };
      if (!storage.has(res.path)) return { outcome: "object_missing", upload_id: null, detail: null };
      const up = `u${s.uploads.length + 1}`; s.uploads.push(up); res.consumedBy = up;
      return { outcome: "registered", upload_id: up, detail: null };
    },
    finish: async (_c, _u, up) => {
      step("finish");
      if (s.commit!.state === "committed") return s.commit!.upload === up ? "already_committed" : "mismatch";
      if (!s.commit!.verified) return "not_verified";
      s.commit!.state = "committed"; s.commit!.upload = up; s.draft.state = "committed";
      return "committed";
    },
    rejectDraft: async () => { step("reject"); s.draft.state = "rejected"; return "rejected"; },
    cancelCommit: async () => "cancelled",
  };
  return { s, deps };
}

describe("parseDraftRequest: the body carries only the operation's own inputs", () => {
  const body = { action: "commit", draft_id: D, commit_key: KEY, company_id: CO, period_year: 2025, period_id: null, engagement_id: null, confirmation: CONF };
  it("a well-formed commit, sign and cancel are accepted", () => {
    expect(parseDraftRequest(body)).toMatchObject({ action: "commit", draftId: D, companyId: CO, periodYear: 2025 });
    expect(parseDraftRequest({ action: "sign", draft_id: D })).toEqual({ action: "sign", draftId: D });
    expect(parseDraftRequest({ action: "cancel", commit_id: D })).toEqual({ action: "cancel", commitId: D });
  });
  it("an owner, path, bucket or user in the body is refused, never read", () => {
    for (const extra of [{ user_id: U }, { object_path: "drafts/x" }, { bucket: "b" }, { owner: U }]) {
      expect(parseDraftRequest({ ...body, ...extra })).toBeNull();
      expect(parseDraftRequest({ action: "sign", draft_id: D, ...extra })).toBeNull();
    }
  });
  it("the confirmed context is exactly entity, period and currency, each non-empty", () => {
    expect(parseDraftRequest({ ...body, confirmation: { entity: "A", period: "P" } })).toBeNull();
    expect(parseDraftRequest({ ...body, confirmation: { ...CONF, framework: "IFRS" } })).toBeNull();
    expect(parseDraftRequest({ ...body, confirmation: { ...CONF, entity: "  " } })).toBeNull();
  });
  it("malformed ids, keys and years are refused", () => {
    expect(parseDraftRequest({ ...body, draft_id: "x" })).toBeNull();
    expect(parseDraftRequest({ ...body, commit_key: "short" })).toBeNull();
    expect(parseDraftRequest({ ...body, period_year: 25 })).toBeNull();
    expect(parseDraftRequest({ ...body, period_year: "2025" })).toBeNull();
  });
});

describe("commit: happy path and replay", () => {
  it("verifies the draft, reserves as the user, copies, verifies the copy, registers once, finishes", async () => {
    const { s, deps } = world();
    const r = await runDraftRequest(deps, COMMIT);
    expect(r).toMatchObject({ status: 200, outcome: "committed", upload_id: "u1", replayed: false });
    expect(s.calls).toEqual(["canManage", "begin", "read:draft", "reserve", "record", "read:copy", "copy", "read:copy", "verify", "register", "finish"]);
    expect(s.uploads).toEqual(["u1"]);
  });
  it("a lost response: the same request again replays the same upload, re-checking authority first", async () => {
    const { s, deps } = world();
    await runDraftRequest(deps, COMMIT);
    s.calls.length = 0;
    const again = await runDraftRequest(deps, COMMIT);
    expect(again).toMatchObject({ status: 200, outcome: "committed", upload_id: "u1", replayed: true });
    expect(s.calls).toEqual(["canManage", "begin"]);
    expect(s.uploads).toHaveLength(1);
  });
  it("a replay after authority was revoked is refused (no result is disclosed)", async () => {
    const { s, deps } = world();
    await runDraftRequest(deps, COMMIT);
    s.authorised = false; s.calls.length = 0;
    expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ status: 403, outcome: "forbidden" });
    expect(s.calls).toEqual(["canManage"]);
  });
  it("the same key with a changed target is a conflict; nothing is reserved, copied or registered", async () => {
    const { s, deps } = world();
    await runDraftRequest(deps, { ...COMMIT, periodYear: 2025 }).then(() => { s.calls.length = 0; });
    const r = await runDraftRequest(deps, { ...COMMIT, periodYear: 2024 });
    expect(r).toMatchObject({ status: 409, outcome: "commit_conflict" });
    expect(s.calls).toEqual(["canManage", "begin"]);
  });
});

describe("commit: a stop at every step resumes without duplicating anything", () => {
  for (const stopAt of ["begin", "read:draft", "reserve", "record", "copy", "verify", "register", "finish"]) {
    it(`stopped at ${stopAt}: the next call finishes with exactly one upload and one workspace copy`, async () => {
      const { s, deps } = world();
      s.failOnce.add(stopAt);
      const first = await runDraftRequest(deps, COMMIT);
      expect(first).toMatchObject({ outcome: "commit_failed", retryable: true });
      const second = await runDraftRequest(deps, COMMIT);
      expect(second).toMatchObject({ status: 200, outcome: "committed", upload_id: "u1" });
      expect(s.uploads).toEqual(["u1"]);
      // A reservation recorded before the stop is reused; the copy is never made twice for one reservation.
      expect([...s.storage.keys()].filter((p) => p.startsWith("workspaces/"))).toHaveLength(1);
    });
  }
  it("registration succeeded but its answer was lost (stop at finish): no second registration", async () => {
    const { s, deps } = world();
    s.failOnce.add("finish");
    await runDraftRequest(deps, COMMIT);
    s.calls.length = 0;
    await runDraftRequest(deps, COMMIT);
    expect(s.calls).toEqual(["canManage", "begin", "register", "finish"]);
    expect(s.uploads).toHaveLength(1);
  });
  it("a reservation that expired while stopped is replaced; the copy is made for the new one", async () => {
    const { s, deps } = world();
    s.failOnce.add("copy");
    await runDraftRequest(deps, COMMIT);
    s.reservations.get(s.commit!.reservation!)!.expired = true;
    const r = await runDraftRequest(deps, COMMIT);
    expect(r).toMatchObject({ outcome: "committed" });
    expect(s.reservations.size).toBe(2);
  });
});

describe("commit: integrity and refusals", () => {
  it("the stored draft does not hash to its reserved identity: the draft is rejected, nothing is copied or registered", async () => {
    const { s, deps } = world();
    s.storage.set(s.draftPath, new TextEncoder().encode("something else"));
    const r = await runDraftRequest(deps, COMMIT);
    expect(r).toMatchObject({ status: 422, outcome: "content_mismatch" });
    expect(s.calls).not.toContain("copy");
    expect(s.calls).not.toContain("register");
    expect(s.draft.state).toBe("rejected");
  });
  it("a copy whose bytes do not verify is removed and the call is retryable; it is never registered", async () => {
    const { s, deps } = world();
    s.copyCorrupts = true;
    const r = await runDraftRequest(deps, COMMIT);
    expect(r).toMatchObject({ status: 500, outcome: "copy_integrity_failed", retryable: true });
    expect(s.calls).toContain("remove");
    expect(s.uploads).toHaveLength(0);
    s.copyCorrupts = false;
    expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ outcome: "committed" });
  });
  it("without authority over the entity nothing happens at all", async () => {
    const { s, deps } = world();
    s.authorised = false;
    expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ status: 403, outcome: "forbidden" });
    expect(s.calls).toEqual(["canManage"]);
  });
  it("the period already has an active trial balance: an actionable refusal with the commit id (it can be cancelled)", async () => {
    const { deps } = world();
    deps.register = async () => ({ outcome: "active_upload_exists", upload_id: null, detail: null });
    const r = await runDraftRequest(deps, COMMIT);
    expect(r).toMatchObject({ status: 409, outcome: "active_upload_exists", commit_id: "c1" });
    expect(r.detail).toMatch(/already active for this period/);
  });
  it("Storage cannot be read: retryable, never a success", async () => {
    const { s, deps } = world();
    s.storage.delete(s.draftPath);
    expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ status: 503, outcome: "storage_unavailable", retryable: true });
  });
});

describe("commit: replacing the period's active trial balance (retire, never register)", () => {
  const REPLACE = { ...COMMIT, replaces: { uploadId: "u-old", expectedVersion: 3 } };
  it("registers through retire (one transaction on the server), never through register", async () => {
    const { s, deps } = world();
    const r = await runDraftRequest(deps, REPLACE);
    expect(r).toMatchObject({ status: 200, outcome: "committed", upload_id: "u1" });
    expect(s.calls).toContain("retire");
    expect(s.calls).not.toContain("register");
  });
  it("a stale version is refused in words (replace_conflict); nothing is registered; the current trial balance stays", async () => {
    const { s, deps } = world();
    const r = await runDraftRequest(deps, { ...REPLACE, replaces: { uploadId: "u-other", expectedVersion: 3 } });
    expect(r).toMatchObject({ status: 409, outcome: "replace_conflict", commit_id: "c1" });
    expect(r.detail).toMatch(/changed since you chose to replace it/);
    expect(s.uploads).toEqual([]);
  });
  it("a lost answer: the same request again answers the same new upload; no second replacement", async () => {
    const { s, deps } = world();
    s.failOnce.add("finish");
    await runDraftRequest(deps, REPLACE);
    const again = await runDraftRequest(deps, REPLACE);
    expect(again).toMatchObject({ outcome: "committed", upload_id: "u1" });
    expect(s.uploads).toEqual(["u1"]);
  });
  it("the request must name both the upload and the version it replaces", () => {
    const body = { action: "commit", draft_id: D, commit_key: KEY, company_id: CO, period_year: 2025, period_id: null, engagement_id: null, confirmation: CONF };
    expect(parseDraftRequest({ ...body, replaces_upload_id: U, expected_version: 3 })).toMatchObject({ replaces: { uploadId: U, expectedVersion: 3 } });
    expect(parseDraftRequest({ ...body, replaces_upload_id: U })).toBeNull();
    expect(parseDraftRequest({ ...body, expected_version: 3 })).toBeNull();
    expect(parseDraftRequest({ ...body, replaces_upload_id: "x", expected_version: 3 })).toBeNull();
    expect(parseDraftRequest(body)).toMatchObject({ replaces: null });
  });
});

describe("rollout: the function deployed before its migration", () => {
  for (const code of ["PGRST202", "42883", "42P01"]) {
    it(`a missing database function (${code}) is 'drafts_unavailable', never a false success`, async () => {
      const { deps } = world();
      deps.beginCommit = async () => { throw Object.assign(new Error("missing"), { code }); };
      expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ status: 503, outcome: "drafts_unavailable", retryable: false });
      deps.signTarget = async () => { throw Object.assign(new Error("missing"), { code }); };
      expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 503, outcome: "drafts_unavailable" });
    });
  }
});

describe("sign", () => {
  it("only the caller's own reserved, unstored draft is signed, for exactly its path", async () => {
    const { s, deps } = world();
    s.storage.delete(s.draftPath);
    expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 200, outcome: "signed", path: s.draftPath });
    s.storage.set(s.draftPath, BYTES);
    expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 409, outcome: "already_stored" });
    deps.signTarget = async () => null;
    expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 404, outcome: "not_found" });
    deps.signTarget = async () => ({ object_path: `drafts/someone-else/${D}/x`, signable: true, stored: false });
    expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 500, outcome: "signing_failed" });
  });
  it("an unauthenticated caller gets nothing", async () => {
    const { deps } = world();
    deps.authenticate = async () => null;
    expect(await runDraftRequest(deps, { action: "sign", draftId: D })).toMatchObject({ status: 401, outcome: "unauthenticated" });
    expect(await runDraftRequest(deps, COMMIT)).toMatchObject({ status: 401, outcome: "unauthenticated" });
  });
});
