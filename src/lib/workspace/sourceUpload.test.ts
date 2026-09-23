/**
 * sourceUpload.test.ts: the decision sequence of the trial-balance-source-signer Edge Function
 * (supabase/functions/_shared/sourceUpload.ts), with every dependency injected. The hosted staging proof
 * (scripts/upload_lifecycle_staging.mjs) exercises the deployed function end to end.
 */
import { describe, expect, it, vi } from "vitest";
import { parseSourceUploadRequest, runSourceUpload, type ReservationTarget, type SourceUploadDeps } from "../../../supabase/functions/_shared/sourceUpload";

const RES = "7a1e4d92-2f8b-4c3e-b056-f9a2d7e14b83";
const reservation = (over: Partial<ReservationTarget> = {}): ReservationTarget =>
  ({ company_id: "co-1", object_path: "workspaces/co-1/src-1/tb.csv", actor_user_id: "user-1", expired: false, consumed: false, ...over });

function deps(over: Partial<SourceUploadDeps> = {}) {
  const d = {
    authenticate: vi.fn(async () => "user-1"),
    resolveReservation: vi.fn(async () => reservation()),
    canManage: vi.fn(async () => true),
    signUpload: vi.fn(async (path: string) => ({ path, token: "signed-token" })),
    ...over,
  };
  return d as typeof d & SourceUploadDeps;
}

describe("request parsing: only a reservation id", () => {
  it("accepts exactly { reservation_id: uuid }", () => expect(parseSourceUploadRequest({ reservation_id: RES })).toEqual({ reservationId: RES }));
  it("refuses bucket/path/workspace/user substitution and malformed input", () => {
    for (const body of [{ reservation_id: RES, path: "workspaces/other/x.csv" }, { reservation_id: RES, bucket: "avatars" }, { reservation_id: RES, company_id: "x" },
      { reservation_id: RES, user_id: "x" }, { reservation_id: "nope" }, {}, null, [RES]]) expect(parseSourceUploadRequest(body)).toBeNull();
  });
});

describe("runSourceUpload", () => {
  it("authorized: signs EXACTLY the server-resolved workspace path", async () => {
    const d = deps();
    await expect(runSourceUpload(d, RES)).resolves.toEqual({ status: 200, outcome: "signed", path: "workspaces/co-1/src-1/tb.csv", token: "signed-token" });
    expect(d.signUpload).toHaveBeenCalledWith("workspaces/co-1/src-1/tb.csv");
    expect(d.canManage).toHaveBeenCalledWith("user-1", "co-1");
  });
  it("unauthenticated → 401, nothing resolved", async () => {
    const d = deps({ authenticate: vi.fn(async () => null) });
    await expect(runSourceUpload(d, RES)).resolves.toMatchObject({ status: 401 });
    expect(d.resolveReservation).not.toHaveBeenCalled();
  });
  it("unknown reservation → 404; someone else's reservation → 403; nothing signed", async () => {
    const a = deps({ resolveReservation: vi.fn(async () => null) });
    await expect(runSourceUpload(a, RES)).resolves.toMatchObject({ status: 404, outcome: "stale_reservation" });
    const b = deps({ resolveReservation: vi.fn(async () => reservation({ actor_user_id: "someone-else" })) });
    await expect(runSourceUpload(b, RES)).resolves.toMatchObject({ status: 403, outcome: "forbidden" });
    expect(a.signUpload).not.toHaveBeenCalled(); expect(b.signUpload).not.toHaveBeenCalled();
  });
  it("revoked / never-granted caller → 403 even with a valid reservation", async () => {
    const d = deps({ canManage: vi.fn(async () => false) });
    await expect(runSourceUpload(d, RES)).resolves.toMatchObject({ status: 403, outcome: "forbidden" });
    expect(d.signUpload).not.toHaveBeenCalled();
  });
  it("consumed → 409; expired → 410", async () => {
    await expect(runSourceUpload(deps({ resolveReservation: vi.fn(async () => reservation({ consumed: true })) }), RES)).resolves.toMatchObject({ status: 409, outcome: "already_registered" });
    await expect(runSourceUpload(deps({ resolveReservation: vi.fn(async () => reservation({ expired: true })) }), RES)).resolves.toMatchObject({ status: 410, outcome: "expired" });
  });
  it("a reservation whose path is not inside its own workspace is never signed", async () => {
    const d = deps({ resolveReservation: vi.fn(async () => reservation({ object_path: "workspaces/co-2/src/tb.csv" })) });
    await expect(runSourceUpload(d, RES)).resolves.toMatchObject({ outcome: "signing_failed" });
    expect(d.signUpload).not.toHaveBeenCalled();
  });
  it("a signer answering for a different path is rejected", async () => {
    const d = deps({ signUpload: vi.fn(async () => ({ path: "workspaces/co-1/other/x.csv", token: "t" })) });
    await expect(runSourceUpload(d, RES)).resolves.toMatchObject({ status: 502, outcome: "signing_failed" });
  });
});
