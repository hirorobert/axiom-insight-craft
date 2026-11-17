// @vitest-environment node
// realmID protection (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md): the module, its configuration and the backfill.
import { describe, expect, it, vi } from "vitest";
import {
  REALM_ENVELOPE_SHAPE, REALM_INDEX_SHAPE, oauthRealmBinding, openParkedRealm, openRealm, protectExistingRealm, protectParkedRealm, protectRealm, realmBinding,
  realmForOperation, realmIndex, resolveStoredRealm, sealRealm, type RealmKeys, type StoredRealm,
} from "../../../supabase/functions/_shared/qboRealmProtection";
import { parseBackfillRequest, runRealmBackfill, sameCredential, type BackfillDeps, type BackfillRow } from "../../../supabase/functions/_shared/qboRealmBackfill";
import { readQboEnv } from "../../../supabase/functions/_shared/qboEnv";
import { connectionBinding, openSecret } from "../../../supabase/functions/_shared/qboTokenEnvelope";

// Invented values only.
const key = (id: string, fill: number) => ({ id, bytes: new Uint8Array(32).fill(fill) });
const KEYS: RealmKeys = { current: key("k2", 2), all: [key("k2", 2), key("k1", 1)], index: key("idx1", 9) };
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const REALM = "9130350000000001";
const HANDOFF_HASH = "ab".repeat(32);

describe("the realm envelope", () => {
  it("is the token envelope under its own purpose, bound to the workspace and environment; it opens only there and never contains the realm", async () => {
    const env = await sealRealm(REALM, "sandbox", A, KEYS.current);
    expect(env).toMatch(REALM_ENVELOPE_SHAPE); expect(env).not.toContain(REALM); expect(env.split(".")[1]).toBe("k2");
    expect(realmBinding(A, "sandbox")).toEqual({ workspaceId: A, connectionId: "sandbox", purpose: "qbo-realm-id" });
    await expect(openRealm(env, "sandbox", A, KEYS.all)).resolves.toBe(REALM);
    for (const [e, c] of [["sandbox", B], ["production", A]] as const) await expect(openRealm(env, e, c, KEYS.all)).rejects.toThrow();
    await expect(openRealm(env, "sandbox", A, [key("k1", 1)])).rejects.toThrow();            // a ring without the sealing key
    await expect(openSecret(env, KEYS.all, connectionBinding(A, REALM, "sandbox"))).rejects.toThrow();   // never opens as a refresh token
    const tampered = env.slice(0, -2) + (env.endsWith("AA") ? "BB" : "AA");
    await expect(openRealm(tampered, "sandbox", A, KEYS.all)).rejects.toThrow();
  });
  it("opens with the previous key after rotation (new envelopes use the current key)", async () => {
    const old = await sealRealm(REALM, "sandbox", A, key("k1", 1));
    await expect(openRealm(old, "sandbox", A, KEYS.all)).resolves.toBe(REALM);
  });
  it("refuses a realm that is not 1 to 20 digits, an unknown environment, and an opened value that is not a realm", async () => {
    for (const bad of ["", "12a", "1".repeat(21), " 1"]) await expect(sealRealm(bad, "sandbox", A, KEYS.current)).rejects.toThrow();
    await expect(sealRealm(REALM, "staging" as never, A, KEYS.current)).rejects.toThrow();
  });
  it("a PARKED realm is bound to the handoff's hash, opens for no other handoff and never as a stored realm", async () => {
    const p = await protectParkedRealm(REALM, HANDOFF_HASH, KEYS);
    expect(oauthRealmBinding(HANDOFF_HASH)).toEqual({ workspaceId: "qbo-oauth-return", connectionId: HANDOFF_HASH, purpose: "qbo-realm-id" });
    await expect(openParkedRealm(p.envelope, HANDOFF_HASH, KEYS.all)).resolves.toBe(REALM);
    await expect(openParkedRealm(p.envelope, "cd".repeat(32), KEYS.all)).rejects.toThrow();
    await expect(openRealm(p.envelope, "sandbox", "qbo-oauth-return", KEYS.all)).rejects.toThrow();
    expect([p.indexSandbox, p.indexProduction]).toEqual([await realmIndex(REALM, "sandbox", KEYS.index), await realmIndex(REALM, "production", KEYS.index)]);
    expect(() => oauthRealmBinding("not-a-hash")).toThrow();
  });
});

describe("the realm index", () => {
  it("is keyed, deterministic and shaped; not bound to the workspace; differs by environment, realm and key", async () => {
    const i = await realmIndex(REALM, "sandbox", KEYS.index);
    expect(i).toMatch(REALM_INDEX_SHAPE); expect(i).not.toContain(REALM); expect(i.split(".")[1]).toBe("idx1");
    expect(await realmIndex(REALM, "sandbox", KEYS.index)).toBe(i);
    expect(await realmIndex(REALM, "production", KEYS.index)).not.toBe(i);
    expect(await realmIndex("9130350000000002", "sandbox", KEYS.index)).not.toBe(i);
    expect(await realmIndex(REALM, "sandbox", key("idx1", 8))).not.toBe(i);
    expect((await protectRealm(REALM, "sandbox", A, KEYS)).index).toBe((await protectRealm(REALM, "sandbox", B, KEYS)).index);   // shared-realm detection
  });
  it("refuses a malformed index key", async () => {
    await expect(realmIndex(REALM, "sandbox", { id: "BAD", bytes: new Uint8Array(32) })).rejects.toThrow();
    await expect(realmIndex(REALM, "sandbox", { id: "idx", bytes: new Uint8Array(16) })).rejects.toThrow();
  });
});

describe("reading a stored realm", () => {
  const stored = async (over: Partial<StoredRealm> = {}): Promise<StoredRealm> => {
    const p = await protectRealm(REALM, "sandbox", A, KEYS);
    return { company_id: A, environment: "sandbox", realm_id: REALM, realm_envelope: p.envelope, realm_index: p.index, ...over };
  };
  it("opens the envelope; equal to the plaintext while it exists; works with the plaintext gone", async () => {
    expect(await resolveStoredRealm(await stored(), KEYS, { allowPlaintext: false })).toEqual({ ok: true, realmId: REALM, protected: true });
    expect(await resolveStoredRealm(await stored({ realm_id: null }), KEYS, { allowPlaintext: false })).toEqual({ ok: true, realmId: REALM, protected: true });
  });
  it.each<[string, Partial<StoredRealm>, string]>([
    ["a plaintext that disagrees", { realm_id: "1" }, "mismatch"],
    ["an index that is not the realm's", { realm_index: "h1.idx1." + "0".repeat(64) }, "mismatch"],
    ["an index made with another index key (a re-index is needed)", { realm_index: "h1.idx0." + "0".repeat(64) }, "mismatch"],
    ["an envelope moved to another workspace", { company_id: B }, "unreadable"],
    ["an envelope of another environment", { environment: "production" }, "unreadable"],
    ["no envelope, plaintext not allowed", { realm_envelope: null, realm_index: null }, "unprotected"],
  ])("refuses %s", async (_l, over, reason) => {
    expect(await resolveStoredRealm(await stored(over), KEYS, { allowPlaintext: false })).toEqual({ ok: false, reason });
  });
  it("an unprotected row resolves to its plaintext only when allowed (dual-write phase)", async () => {
    expect(await resolveStoredRealm(await stored({ realm_envelope: null, realm_index: null }), KEYS, { allowPlaintext: true })).toEqual({ ok: true, realmId: REALM, protected: false });
  });
  it("for an operation: protects an unprotected row FIRST through the service-only function, and refuses when that is not possible", async () => {
    const row = { id: A, ...(await stored({ realm_envelope: null, realm_index: null })) };
    const submit = vi.fn(async () => "protected");
    expect(await realmForOperation(row, KEYS, submit)).toEqual({ ok: true, realmId: REALM, protected: true });
    const args = (submit.mock.calls[0] as unknown[])[0] as { p_connection: string; p_realm_id: string; p_realm_envelope: string; p_realm_index: string };
    expect(args.p_connection).toBe(A); expect(args.p_realm_id).toBe(REALM);
    expect(await openRealm(args.p_realm_envelope, "sandbox", A, KEYS.all)).toBe(REALM);
    expect(await realmForOperation(row, KEYS, async () => "already_protected")).toMatchObject({ ok: true });
    for (const outcome of ["realm_mismatch", "index_conflict", "terminal_unchanged", "not_found"]) expect(await realmForOperation(row, KEYS, async () => outcome)).toEqual({ ok: false, reason: "mismatch" });
    expect(await realmForOperation(row, KEYS, async () => { throw new Error("db"); })).toEqual({ ok: false, reason: "unprotected" });
    expect(await realmForOperation(row, KEYS, null)).toEqual({ ok: false, reason: "unprotected" });   // after the cutover: no plaintext fallback
    const sealed = { id: A, ...(await stored()) };
    const never = vi.fn(async () => "protected");
    expect(await realmForOperation(sealed, KEYS, never)).toMatchObject({ ok: true, realmId: REALM }); expect(never).not.toHaveBeenCalled();
  });
  it("protectExistingRealm verifies its own round trip and refuses a row with no plaintext", async () => {
    const a = await protectExistingRealm({ id: A, company_id: A, environment: "production", realm_id: REALM, realm_envelope: null, realm_index: null }, KEYS);
    expect(a.p_realm_index).toBe(await realmIndex(REALM, "production", KEYS.index));
    await expect(protectExistingRealm({ id: A, company_id: A, environment: "production", realm_id: null, realm_envelope: null, realm_index: null }, KEYS)).rejects.toThrow();
  });
});

describe("configuration: the index key is its own secret", () => {
  const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
  const BASE: Record<string, string> = { QBO_TOKEN_KEY_ID: "k2", QBO_TOKEN_KEY_B64: b64(2), QBO_REALM_INDEX_KEY_ID: "idx1", QBO_REALM_INDEX_KEY_B64: b64(9) };
  const env = (o: Record<string, string | undefined>) => readQboEnv((n) => o[n]);
  it("reads the token ring and the index key together", () => {
    const k = env(BASE).realmKeys();
    expect(k?.current.id).toBe("k2"); expect(k?.index.id).toBe("idx1"); expect(k?.all.map((x) => x.id)).toEqual(["k2"]);
  });
  it.each<[string, Record<string, string | undefined>]>([
    ["no index key id", { ...BASE, QBO_REALM_INDEX_KEY_ID: undefined }],
    ["no index key", { ...BASE, QBO_REALM_INDEX_KEY_B64: " " }],
    ["an index key that is not 32 bytes", { ...BASE, QBO_REALM_INDEX_KEY_B64: btoa("short") }],
    ["an index key named like a token key", { ...BASE, QBO_REALM_INDEX_KEY_ID: "k2" }],
    ["an index key equal to a token key", { ...BASE, QBO_REALM_INDEX_KEY_B64: b64(2) }],
    ["an index key equal to the previous token key", { ...BASE, QBO_TOKEN_KEY_PREV_ID: "k1", QBO_TOKEN_KEY_PREV_B64: b64(9) }],
    ["no token key", { ...BASE, QBO_TOKEN_KEY_B64: undefined }],
  ])("nothing with %s (the functions then answer not configured)", (_l, o) => { expect(env(o).realmKeys()).toBeNull(); });
});

describe("the one-off backfill (service-only)", () => {
  const rows = async (): Promise<BackfillRow[]> => [
    { id: A, company_id: A, environment: "sandbox", realm_id: REALM, realm_envelope: null, realm_index: null },
    { id: B, company_id: B, environment: "production", realm_id: "9130350000000002", ...(await (async () => { const p = await protectRealm("9130350000000002", "production", B, KEYS); return { realm_envelope: p.envelope, realm_index: p.index }; })()) },
  ];
  const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps => ({
    authorize: () => true, listConnections: rows, listOperations: async () => [],
    protectConnection: vi.fn(async () => "protected"), protectOperation: vi.fn(async () => "protected"),
    verifyConnection: vi.fn(async () => "verified"), verifyOperation: vi.fn(async () => "verified"), status: async () => ({ live_connections: 2 }), ...over,
  });
  it("only a caller presenting the service credential; exactly { action }", async () => {
    expect(await runRealmBackfill(deps({ authorize: () => false }), KEYS, { action: "protect" })).toEqual({ status: 401, outcome: "unauthorized" });
    expect(await runRealmBackfill(deps(), KEYS, null)).toEqual({ status: 400, outcome: "invalid_request" });
    for (const bad of [null, {}, { action: "drop" }, { action: "protect", realmId: REALM }]) expect(parseBackfillRequest(bad)).toBeNull();
    expect(sameCredential("abc", "abc")).toBe(true);
    for (const [a, b] of [["abc", "abd"], ["abc", "abcd"], ["", ""]]) expect(sameCredential(a, b)).toBe(false);
  });
  it("protect: seals and submits only the unprotected rows; the answer is counts only", async () => {
    const d = deps();
    const r = await runRealmBackfill(d, KEYS, { action: "protect" });
    expect(r).toMatchObject({ status: 200, outcome: "complete", connections: { total: 2, protected: 1, already: 1 } });
    expect(d.protectConnection).toHaveBeenCalledTimes(1);
    for (const s of [REALM, "9130350000000002", "v1.", "h1.", A, B]) expect(JSON.stringify(r)).not.toContain(s);
  });
  it("protect: a database refusal or a mismatch is reported as incomplete", async () => {
    expect(await runRealmBackfill(deps({ protectConnection: async () => "realm_mismatch" }), KEYS, { action: "protect" })).toMatchObject({ status: 409, outcome: "incomplete", connections: { mismatched: 1 } });
    expect(await runRealmBackfill(deps({ protectConnection: async () => { throw new Error("db"); } }), KEYS, { action: "protect" })).toMatchObject({ status: 409, connections: { refused: 1 } });
  });
  it("verify: opens every envelope and compares with the plaintext before asking the database to mark it; an unprotected row is incomplete", async () => {
    const d = deps();
    const r = await runRealmBackfill(d, KEYS, { action: "verify" });
    expect(r).toMatchObject({ status: 409, outcome: "incomplete", connections: { total: 2, verified: 1, unprotected: 1 } });
    expect((d.verifyConnection as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ p_connection: B, p_realm_id: "9130350000000002" });
    const wrongPlain = deps({ listConnections: async () => [{ ...(await rows())[1], realm_id: "1" }] });
    expect(await runRealmBackfill(wrongPlain, KEYS, { action: "verify" })).toMatchObject({ connections: { mismatched: 1, verified: 0 } });
    expect(wrongPlain.verifyConnection).not.toHaveBeenCalled();
  });
  it("after the cutover (no database writers): protect only reports unprotected rows; verify is a local open-and-index check", async () => {
    const d = deps({ protectConnection: undefined, protectOperation: undefined, verifyConnection: undefined, verifyOperation: undefined });
    expect(await runRealmBackfill(d, KEYS, { action: "protect" })).toMatchObject({ status: 409, connections: { unprotected: 1, already: 1, protected: 0 } });
    const sealedOnly = deps({ verifyConnection: undefined, listConnections: async () => [{ ...(await rows())[1], realm_id: null }] });
    expect(await runRealmBackfill(sealedOnly, KEYS, { action: "verify" })).toMatchObject({ status: 200, outcome: "complete", connections: { verified: 1 } });
    const moved = deps({ verifyConnection: undefined, listConnections: async () => [{ ...(await rows())[1], realm_id: null, company_id: A }] });
    expect(await runRealmBackfill(moved, KEYS, { action: "verify" })).toMatchObject({ status: 409, connections: { mismatched: 1 } });
  });
  it("a failure to list is a plain failure with nothing else said", async () => {
    expect(await runRealmBackfill(deps({ listConnections: async () => { throw new Error(REALM); } }), KEYS, { action: "verify" })).toEqual({ status: 500, outcome: "failed" });
  });
});
