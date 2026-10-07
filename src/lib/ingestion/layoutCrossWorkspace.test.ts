/**
 * trial-balance-layout refuses a user of ANOTHER workspace for every file action — inspect, validate and confirm — with
 * the same 403 an unknown upload gets (no existence leak), and NOTHING past the authorization step runs: no entitlement
 * or source-binding RPC, no Storage read, no period/currency read, no layout read, no write. Pinned by the handler's
 * exact call log (only the network edges are doubled). The real handler on real PostgreSQL is proven by
 * scripts/db-proof/layoutAuthority.mjs ("another workspace's owner …"); hosted cross-workspace refusal was not run.
 */
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { handleLayoutRequest, type LayoutDeps } from "../../../supabase/functions/_shared/trialBalanceLayout";
import type { XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const OTHER_USER = "99999999-9999-4999-8999-999999999999";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
const LAYOUT = { format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "comma_dot", balanceSign: null,
  columns: { accountCode: "Code", accountName: "Name", debit: "Debit", credit: "Credit", balance: null, dimensions: [] } };

function deps(uploadExists = true) {
  const log: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    log.push(`rpc:${name}`);
    // The database's processing-authority resolver answers no row for a user of another workspace.
    if (name === "tbu_resolve_processing_actor") return { data: [], error: null };
    return { data: { allowed: true, code: "ALLOWED" }, error: null };
  });
  const d: LayoutDeps = {
    loadUpload: vi.fn(async () => { log.push("loadUpload"); return uploadExists ? { id: UPLOAD, company_id: "company-A", file_path: "a/tb.csv", file_name: "tb.csv", lifecycle_state: "active_processed", period_year: 2025 } : null; }),
    rpc: rpc as never,
    db: { from: vi.fn((t: string) => { log.push(`from:${t}`); throw new Error("no table may be read"); }) } as never,
    download: vi.fn(async () => { log.push("download"); return new TextEncoder().encode("Code,Name,Debit,Credit\n"); }),
    reportingCurrency: vi.fn(async () => { log.push("reportingCurrency"); return "TZS"; }),
    xlsx: XLSX as unknown as XlsxLike,
  };
  return { d, log };
}
const REQUESTS: [string, Record<string, unknown>][] = [
  ["inspect", { action: "inspect", uploadId: UPLOAD }],
  ["validate", { action: "validate", uploadId: UPLOAD, layout: LAYOUT }],
  ["confirm", { action: "confirm", uploadId: UPLOAD, layout: LAYOUT, expectedConfirmationNo: 0, numberFormatConfirmed: true }],
];

describe("cross-workspace layout access is refused before anything is read or written", () => {
  for (const [label, body] of REQUESTS) {
    it(`${label}: 403, and only the upload lookup and the authority resolver ran`, async () => {
      const { d, log } = deps();
      const r = await handleLayoutRequest(OTHER_USER, body, d);
      expect(r.status).toBe(403);
      expect(log).toEqual(["loadUpload", "rpc:tbu_resolve_processing_actor"]);
    });
  }
  it("every refusal has the same body as an upload that does not exist (no existence leak)", async () => {
    const bodies = new Set<string>();
    for (const [, body] of REQUESTS) {
      bodies.add(JSON.stringify((await handleLayoutRequest(OTHER_USER, body, deps(true).d)).body));
      bodies.add(JSON.stringify((await handleLayoutRequest(OTHER_USER, body, deps(false).d)).body));
    }
    expect(bodies.size).toBe(1);
  });
  it("the actor is the JWT user only: an actor named in the body is ignored", async () => {
    const { d, log } = deps();
    const r = await handleLayoutRequest(OTHER_USER, { ...REQUESTS[2][1], userId: "11111111-1111-4111-8111-111111111111", firmMemberId: "x", companyId: "company-A" }, d);
    expect(r.status).toBe(403);
    expect((d.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toMatchObject({ p_user_id: OTHER_USER, p_company_id: "company-A" });
    expect(log).not.toContain("download");
  });
});
