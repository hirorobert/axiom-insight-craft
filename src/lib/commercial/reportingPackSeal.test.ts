/**
 * Server-side sealing of official Reporting Pack bytes (supabase/functions/_shared/reportingPackSeal.ts, B-4). The
 * database side (service-role-only seal, bindings, replay, downgrade, closed output references) is proven on real
 * PostgreSQL in scripts/db-proof/billingSuspension.mjs and planCapabilities.mjs.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PACK_BYTES, packExtension, sealPack, verifyStoredPack, type SealDeps } from "../../../supabase/functions/_shared/reportingPackSeal";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const U = { user: "11111111-1111-4111-8111-111111111111", iss: "22222222-2222-4222-8222-222222222222", co: "33333333-3333-4333-8333-333333333333" };

function world(sealOutcome = "sealed") {
  const store = new Map<string, Uint8Array>();
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  let sealed: { path: string; sha: string } | null = null;
  const deps: SealDeps = {
    rpc: async (fn, args) => {
      rpcCalls.push([fn, args]);
      if (fn === "seal_reporting_pack_server") {
        if (sealOutcome === "sealed") sealed = { path: String(args.p_storage_path), sha: String(args.p_content_sha256) };
        return { data: { outcome: sealOutcome }, error: null };
      }
      if (fn === "reporting_pack_sealed_object") return { data: sealed ? { storage_path: sealed.path, content_sha256: sealed.sha, company_id: U.co } : null, error: null };
      return { data: null, error: { message: "unexpected" } };
    },
    put: async (p, b) => (store.has(p) ? { error: { message: "exists" } } : (store.set(p, b), { error: null })),
    remove: async (p) => store.delete(p),
    get: async (p) => store.get(p) ?? null,
    sha256Hex: async (b) => sha(b),
  };
  return { deps, store, rpcCalls };
}
const input = (bytes: Uint8Array, extra: Partial<Parameters<typeof sealPack>[1]> = {}) => ({
  userId: U.user, issuanceId: U.iss, companyId: U.co, periodYear: 2025, packKind: "financial_statements_pdf", outputRef: "upload:x",
  fileName: "statements.pdf", bytes, ...extra,
});

describe("the server hashes the bytes it received; no client hash is accepted", () => {
  it("seals with the SHA-256 of the received bytes and stores exactly those bytes at <company>/<issuance>.<ext>", async () => {
    const w = world();
    const bytes = new TextEncoder().encode("%PDF official");
    const r = await sealPack(w.deps, input(bytes));
    expect(r).toEqual({ httpStatus: 200, body: { outcome: "sealed", content_sha256: sha(bytes), issuance_id: U.iss } });
    expect(w.rpcCalls[0][1]).toMatchObject({ p_user: U.user, p_content_sha256: sha(bytes), p_storage_path: `${U.co}/${U.iss}.pdf`, p_byte_size: bytes.byteLength });
    expect(w.store.get(`${U.co}/${U.iss}.pdf`)).toEqual(bytes);
  });
  it("a client-chosen hash has nowhere to go: the handler input has no hash field and the seal uses the computed one", async () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../supabase/functions/seal-reporting-pack/index.ts"), "utf8");
    expect(src).not.toMatch(/content_sha256"\)|form\.get\("(sha|hash|content_sha256)/);
    const w = world();
    const doctored = new TextEncoder().encode("%PDF doctored");
    const r = await sealPack(w.deps, { ...input(doctored), ...( { content_sha256: "a".repeat(64) } as object) } as never);
    expect(r.body.content_sha256).toBe(sha(doctored));
    expect(r.body.content_sha256).not.toBe("a".repeat(64));
  });
  it("a refused seal (binding mismatch, altered output_ref, cross-format, expired, replay, downgrade) leaves nothing stored", async () => {
    for (const outcome of ["binding_mismatch", "expired", "already_sealed", "entitlement_required", "capability_required", "not_found"]) {
      const w = world(outcome);
      const r = await sealPack(w.deps, input(new Uint8Array([1, 2, 3])));
      expect(r.body.outcome).toBe(outcome);
      expect(r.httpStatus).not.toBe(200);
      expect(w.store.size).toBe(0);
    }
  });
  it("replacement bytes need a new issuance: the same issuance cannot be stored twice (no overwrite)", async () => {
    const w = world();
    await sealPack(w.deps, input(new Uint8Array([1])));
    const again = await sealPack(w.deps, input(new Uint8Array([2])));
    expect(again).toEqual({ httpStatus: 409, body: { outcome: "already_sealed" } });
    expect(w.store.get(`${U.co}/${U.iss}.pdf`)).toEqual(new Uint8Array([1]));
  });
  it("the file type must match the pack kind; bad ids, periods and sizes are refused before anything is stored", async () => {
    expect(packExtension("financial_statements_pdf", "x.xlsx")).toBeNull();
    expect(packExtension("tax_workpaper", "x.CSV")).toBe("csv");
    const w = world();
    for (const bad of [input(new Uint8Array([1]), { fileName: "x.exe" }), input(new Uint8Array([1]), { issuanceId: "nope" }), input(new Uint8Array([1]), { periodYear: 2025.5 }),
      input(new Uint8Array(0)), input(new Uint8Array(MAX_PACK_BYTES + 1))]) {
      expect((await sealPack(w.deps, bad)).body.outcome).toBe("invalid_request");
    }
    expect(w.store.size).toBe(0);
    expect(w.rpcCalls).toEqual([]);
  });
});

describe("storage object substitution after sealing is detected", () => {
  it("intact → substituted → missing", async () => {
    const w = world();
    const bytes = new TextEncoder().encode("official");
    await sealPack(w.deps, input(bytes));
    expect((await verifyStoredPack(w.deps, U.iss)).outcome).toBe("intact");
    w.store.set(`${U.co}/${U.iss}.pdf`, new TextEncoder().encode("swapped"));
    expect((await verifyStoredPack(w.deps, U.iss)).outcome).toBe("substituted");
    w.store.delete(`${U.co}/${U.iss}.pdf`);
    expect((await verifyStoredPack(w.deps, U.iss)).outcome).toBe("missing");
    expect((await verifyStoredPack(world().deps, U.iss)).outcome).toBe("not_found");
  });
});
