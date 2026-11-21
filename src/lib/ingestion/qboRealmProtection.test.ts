// @vitest-environment node
// realmID protection (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md): the module, its configuration and the backfill.
import { describe, expect, it, vi } from "vitest";
import {
  REALM_ENVELOPE_SHAPE, REALM_INDEX_SHAPE, oauthRealmBinding, openParkedRealm, openRealm, protectExistingRealm, protectParkedRealm, protectRealm, realmBinding,
  isUpgrade, keyVersion, realmForOperation, realmIndex, resolveStoredRealm, sealRealm, type RealmKeys, type StoredRealm,
} from "../../../supabase/functions/_shared/qboRealmProtection";
import { decideMaintenanceAuthority, parseBackfillRequest, runRealmBackfill, type BackfillDeps, type BackfillRow, type MaintenanceAuthority } from "../../../supabase/functions/_shared/qboRealmBackfill";
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

describe("[Phase C v2] key versions: forwards only", () => {
  it("reads k<N> and idx<N>, one spelling per version, nothing else", () => {
    expect(keyVersion("k2")).toEqual({ kind: "k", version: 2 }); expect(keyVersion("idx12")).toEqual({ kind: "idx", version: 12 });
    for (const bad of ["k0", "k02", "K2", "k", "idx", "k2 ", "x2", "k1234567890", "idx-1", ""]) expect(keyVersion(bad)).toBeNull();
  });
  it("an upgrade is the same kind and a strictly higher version", () => {
    expect(isUpgrade("k1", "k2")).toBe(true); expect(isUpgrade("idx2", "idx10")).toBe(true);
    for (const [a, b] of [["k2", "k2"], ["k3", "k2"], ["k1", "idx2"], ["idx1", "k2"], ["k1", "kx"], ["legacy", "k2"]]) expect(isUpgrade(a, b)).toBe(false);
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
    ["half a NEXT index key pair (id only)", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx2" }],
    ["half a NEXT index key pair (value only)", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_B64: b64(8) }],
    ["a NEXT index key named like the configured one", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx1", QBO_REALM_INDEX_KEY_NEXT_B64: b64(8) }],
    ["a NEXT index key equal to the configured one", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx2", QBO_REALM_INDEX_KEY_NEXT_B64: b64(9) }],
    ["a NEXT index key named like a token key", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "k2", QBO_REALM_INDEX_KEY_NEXT_B64: b64(8) }],
    ["a NEXT index key equal to a token key", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx2", QBO_REALM_INDEX_KEY_NEXT_B64: b64(2) }],
    ["a NEXT index key that is not 32 bytes", { ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx2", QBO_REALM_INDEX_KEY_NEXT_B64: btoa("short") }],
  ])("nothing with %s (the functions then answer not configured)", (_l, o) => { expect(env(o).realmKeys()).toBeNull(); });
  it("a NEXT index key makes every new index while the configured one only recognises; the configured value is never re-entered", () => {
    const k = env({ ...BASE, QBO_REALM_INDEX_KEY_NEXT_ID: "idx2", QBO_REALM_INDEX_KEY_NEXT_B64: b64(8) }).realmKeys();
    expect(k?.index.id).toBe("idx2"); expect(k?.indexAll?.map((x) => x.id)).toEqual(["idx2", "idx1"]);
    expect(Array.from(k!.indexAll![1].bytes)).toEqual(Array.from(new Uint8Array(32).fill(9)));
    expect(env(BASE).realmKeys()?.indexAll?.map((x) => x.id)).toEqual(["idx1"]);
  });
});

describe("index-key rotation: a stored index is recognised by the key it names", () => {
  const IDX2 = key("idx2", 8);
  const NEXT: RealmKeys = { ...KEYS, index: IDX2, indexAll: [IDX2, KEYS.index] };
  const NEWONLY: RealmKeys = { ...KEYS, index: IDX2 };
  it("an idx1 index resolves while idx1 is in the ring, and not once it is gone; an idx2 index resolves under idx2 alone", async () => {
    const p = await protectRealm(REALM, "sandbox", A, KEYS);
    const row = { company_id: A, environment: "sandbox" as const, realm_id: REALM, realm_envelope: p.envelope, realm_index: p.index };
    expect(await resolveStoredRealm(row, NEXT, { allowPlaintext: false })).toEqual({ ok: true, realmId: REALM, protected: true });
    expect(await resolveStoredRealm(row, NEWONLY, { allowPlaintext: false })).toEqual({ ok: false, reason: "mismatch" });
    const moved = { ...row, realm_index: await realmIndex(REALM, "sandbox", IDX2) };
    expect(await resolveStoredRealm(moved, NEWONLY, { allowPlaintext: false })).toEqual({ ok: true, realmId: REALM, protected: true });
    // A forged index under a recognised key name, or one naming no configured key, never resolves.
    expect(await resolveStoredRealm({ ...row, realm_index: "h1.idx2." + "0".repeat(64) }, NEXT, { allowPlaintext: false })).toEqual({ ok: false, reason: "mismatch" });
    expect(await resolveStoredRealm({ ...row, realm_index: "h1.idx9." + p.index.split(".")[2] }, NEXT, { allowPlaintext: false })).toEqual({ ok: false, reason: "mismatch" });
  });
  it("new indexes always use the NEXT key", async () => {
    expect((await protectRealm(REALM, "sandbox", A, NEXT)).index.startsWith("h1.idx2.")).toBe(true);
  });
});

describe("the one-off backfill (platform owner only)", () => {
  const rows = async (): Promise<BackfillRow[]> => [
    { id: A, company_id: A, environment: "sandbox", realm_id: REALM, realm_envelope: null, realm_index: null },
    { id: B, company_id: B, environment: "production", realm_id: "9130350000000002", ...(await (async () => { const p = await protectRealm("9130350000000002", "production", B, KEYS); return { realm_envelope: p.envelope, realm_index: p.index }; })()) },
  ];
  const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps => ({
    authorize: async () => ({ ok: true, actor: "owner" }), listConnections: rows, listOperations: async () => [],
    protectConnection: vi.fn(async () => "protected"), protectOperation: vi.fn(async () => "protected"),
    verifyConnection: vi.fn(async () => "verified"), verifyOperation: vi.fn(async () => "verified"), status: async () => ({ live_connections: 2 }), ...over,
  });
  it.each([
    [{ ok: false, reason: "unauthenticated" }, { status: 401, outcome: "unauthorized" }],
    [{ ok: false, reason: "forbidden" }, { status: 403, outcome: "forbidden" }],
    [{ ok: false, reason: "unavailable" }, { status: 503, outcome: "unavailable" }],
  ] as [MaintenanceAuthority, unknown][])("a refused authority (%o) lists, reads and writes nothing", async (authority, answer) => {
    const d = deps({ authorize: async () => authority, listConnections: vi.fn(rows), listOperations: vi.fn(async () => []), status: vi.fn(async () => ({})) });
    for (const action of ["protect", "verify"] as const) expect(await runRealmBackfill(d, KEYS, { action })).toEqual(answer);
    for (const f of [d.listConnections, d.listOperations, d.protectConnection, d.protectOperation, d.verifyConnection, d.verifyOperation, d.status]) expect(f).not.toHaveBeenCalled();
  });
  it("an authority check that throws is refused as unavailable, never assumed", async () => {
    expect(await runRealmBackfill(deps({ authorize: async () => { throw new Error("db down"); } }), KEYS, { action: "protect" })).toEqual({ status: 503, outcome: "unavailable" });
  });
  it("exactly { action }", async () => {
    expect(await runRealmBackfill(deps(), KEYS, null)).toEqual({ status: 400, outcome: "invalid_request" });
    for (const bad of [null, {}, [], "protect", { action: "drop" }, { action: "protect", realmId: REALM }, { action: "verify", sql: "select 1" }]) expect(parseBackfillRequest(bad)).toBeNull();
    for (const action of ["keys", "reseal", "index_keys", "reindex"]) expect(parseBackfillRequest({ action })).toEqual({ action });
    for (const bad of [{ action: "reseal", keyId: "k1" }, { action: "keys", key: "x" }, { action: "rotate" }, { action: "reindex", indexKey: "idx2" }, { action: "index" }]) expect(parseBackfillRequest(bad)).toBeNull();
  });
  it("index_keys and reindex: refused callers read nothing; reindex without the 20261230500000 database functions is unavailable, never partial", async () => {
    const d = deps({ authorize: async () => ({ ok: false, reason: "forbidden" }), listConnections: vi.fn(rows), listOperations: vi.fn(async () => []) });
    for (const action of ["index_keys", "reindex"] as const) expect(await runRealmBackfill(d, KEYS, { action })).toEqual({ status: 403, outcome: "forbidden" });
    expect(d.listConnections).not.toHaveBeenCalled();
    const old = deps({ listConnections: vi.fn(rows) });
    expect(await runRealmBackfill(old, KEYS, { action: "reindex" })).toEqual({ status: 503, outcome: "unavailable" });
    expect(old.listConnections).not.toHaveBeenCalled();
  });
  it("reindex: recognises the old index first, submits the new one by compare-and-swap with the unchanged envelope; counts only", async () => {
    const IDX2 = key("idx2", 8);
    const NEXT: RealmKeys = { ...KEYS, index: IDX2, indexAll: [IDX2, KEYS.index] };
    const all = await rows();
    const submit = vi.fn(async () => "reindexed");
    const res = await runRealmBackfill(deps({ listConnections: async () => all, reindexConnection: submit, reindexOperation: vi.fn(async () => "reindexed") }), NEXT, { action: "reindex" });
    expect(res).toMatchObject({ status: 409, outcome: "incomplete", currentIndexKeyId: "idx2", connectionIndexes: { total: 2, reindexed: 1, unreadable: 1 } });
    const a = (submit.mock.calls[0] as unknown[])[0] as Record<string, string>;
    expect(a.p_expected_index).toBe(all[1].realm_index); expect(a.p_realm_envelope).toBe(all[1].realm_envelope);
    expect(a.p_new_index).toBe(await realmIndex("9130350000000002", "production", IDX2));
    expect(JSON.stringify(res)).not.toContain("9130350000000002");
  });
  it("keys and reseal: refused callers read nothing; reseal without the 20261230400000 database functions is unavailable, never partial", async () => {
    const d = deps({ authorize: async () => ({ ok: false, reason: "forbidden" }), listConnections: vi.fn(rows), listOperations: vi.fn(async () => []) });
    for (const action of ["keys", "reseal"] as const) expect(await runRealmBackfill(d, KEYS, { action })).toEqual({ status: 403, outcome: "forbidden" });
    expect(d.listConnections).not.toHaveBeenCalled();
    const old = deps({ listConnections: vi.fn(rows) });
    expect(await runRealmBackfill(old, KEYS, { action: "reseal" })).toEqual({ status: 503, outcome: "unavailable" });
    expect(old.listConnections).not.toHaveBeenCalled();
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
  describe("[Phase C v2] rotation after the plaintext is gone, forwards only", () => {
    const K3 = key("k3", 3), IDX2 = key("idx2", 8);
    const ROT: RealmKeys = { current: K3, all: [K3, ...KEYS.all], index: IDX2, indexAll: [IDX2, KEYS.index] };
    const redacted = async (): Promise<BackfillRow> => ({ ...(await rows())[1], realm_id: null });
    const rot = (over: Partial<BackfillDeps>) => deps({ protectConnection: undefined, protectOperation: undefined, verifyConnection: undefined, verifyOperation: undefined, ...over });
    it("reseal: a redacted row is resealed onto the newer key with p_realm_id NULL; the realm never leaves the process", async () => {
      const row = await redacted();
      const submit = vi.fn(async () => "resealed");
      const r = await runRealmBackfill(rot({ listConnections: async () => [row], resealConnection: submit, resealOperation: vi.fn(async () => "resealed"), resealToken: vi.fn(async () => "resealed") }), ROT, { action: "reseal" });
      const a = (submit.mock.calls[0] as unknown[])[0] as Record<string, string | null>;
      expect(a.p_realm_id).toBeNull(); expect(a.p_expected_envelope).toBe(row.realm_envelope); expect(a.p_realm_index).toBe(row.realm_index);
      expect(a.p_new_envelope!.startsWith("v1.k3.")).toBe(true);
      expect(await openRealm(a.p_new_envelope!, "production", B, [K3])).toBe("9130350000000002");
      expect(r).toMatchObject({ connectionRealms: { resealed: 1 } });
      expect(JSON.stringify(r)).not.toContain("9130350000000002");
    });
    it("reseal: while a row still holds its plaintext it is sent for comparison", async () => {
      const submit = vi.fn(async () => "resealed");
      await runRealmBackfill(rot({ listConnections: async () => [(await rows())[1]], resealConnection: submit, resealOperation: vi.fn(), resealToken: vi.fn(async () => "resealed") }), ROT, { action: "reseal" });
      expect(((submit.mock.calls[0] as unknown[])[0] as Record<string, string>).p_realm_id).toBe("9130350000000002");
    });
    it("reindex: a redacted row is re-indexed under the newer index key with p_realm_id NULL and the envelope unchanged", async () => {
      const row = await redacted();
      const submit = vi.fn(async () => "reindexed");
      const r = await runRealmBackfill(rot({ listConnections: async () => [row], reindexConnection: submit, reindexOperation: vi.fn(async () => "reindexed") }), ROT, { action: "reindex" });
      const a = (submit.mock.calls[0] as unknown[])[0] as Record<string, string | null>;
      expect(a.p_realm_id).toBeNull(); expect(a.p_realm_envelope).toBe(row.realm_envelope); expect(a.p_expected_index).toBe(row.realm_index);
      expect(a.p_new_index).toBe(await realmIndex("9130350000000002", "production", IDX2));
      expect(r).toMatchObject({ status: 200, connectionIndexes: { reindexed: 1 } });
    });
    it("a downgrade is never submitted: a row on a NEWER key than the configured one is refused, not moved back", async () => {
      // The row was sealed under k3 and indexed under idx2; this process only has k2 sealing and idx1 indexing (a stale deployment).
      const newer: RealmKeys = { current: KEYS.current, all: [...KEYS.all, K3], index: KEYS.index, indexAll: [KEYS.index, IDX2] };
      const p = await protectRealm("9130350000000002", "production", B, ROT);
      const row: BackfillRow = { id: B, company_id: B, environment: "production", realm_id: null, realm_envelope: p.envelope, realm_index: p.index };
      const reseal = vi.fn(async () => "resealed"), reindex = vi.fn(async () => "reindexed");
      const r1 = await runRealmBackfill(rot({ listConnections: async () => [row], resealConnection: reseal, resealOperation: vi.fn(), resealToken: vi.fn() }), newer, { action: "reseal" });
      const r2 = await runRealmBackfill(rot({ listConnections: async () => [row], reindexConnection: reindex, reindexOperation: vi.fn() }), newer, { action: "reindex" });
      expect(reseal).not.toHaveBeenCalled(); expect(reindex).not.toHaveBeenCalled();
      expect(r1).toMatchObject({ status: 409, connectionRealms: { refused: 1 } }); expect(r2).toMatchObject({ status: 409, connectionIndexes: { refused: 1 } });
    });
    it("the database's own downgrade or mismatch answer is counted as incomplete, never as done", async () => {
      const row = await redacted();
      for (const answer of ["downgrade", "realm_mismatch", "stale", "invalid"]) {
        const r = await runRealmBackfill(rot({ listConnections: async () => [row], reindexConnection: async () => answer, reindexOperation: vi.fn() }), ROT, { action: "reindex" });
        expect(r).toMatchObject({ status: 409, outcome: "incomplete" });
      }
    });
    it("a row whose stored index names no configured index key (or a forged one) is unreadable or mismatched, and nothing is submitted", async () => {
      const row = { ...(await redacted()), realm_index: "h1.idx9." + "0".repeat(64) };
      const submit = vi.fn(async () => "reindexed");
      const r = await runRealmBackfill(rot({ listConnections: async () => [row], reindexConnection: submit, reindexOperation: vi.fn() }), ROT, { action: "reindex" });
      expect(submit).not.toHaveBeenCalled(); expect(r).toMatchObject({ status: 409, outcome: "incomplete" });
    });
  });
  it("a failure to list is a plain failure with nothing else said", async () => {
    expect(await runRealmBackfill(deps({ listConnections: async () => { throw new Error(REALM); } }), KEYS, { action: "verify" })).toEqual({ status: 500, outcome: "failed" });
  });
});

describe("who may run the backfill: only a signed-in active platform owner, decided by the database", () => {
  const JWT = "Bearer aaa.bbb.ccc";
  const decide = (header: string | null, user: string | null | Error, owner: unknown) => {
    const deps = {
      userIdOf: vi.fn(async () => { if (user instanceof Error) throw user; return user; }),
      isPlatformOwner: vi.fn(async () => { if (owner instanceof Error) throw owner; return owner; }),
    };
    return { deps, result: decideMaintenanceAuthority(header, deps) };
  };
  it("an active platform owner (the database answers exactly true) is admitted as themself", async () => {
    const { deps, result } = decide(JWT, "owner-uid", true);
    expect(await result).toEqual({ ok: true, actor: "owner-uid" });
    expect(deps.isPlatformOwner).toHaveBeenCalledWith("owner-uid");
  });
  it.each([
    ["no Authorization header", null],
    ["an empty header", ""],
    ["a Basic credential", "Basic dXNlcjpwYXNz"],
    ["a bearer that is not a JWT (an opaque secret key)", "Bearer sb_secret_abcdef"],
    ["a JWT with extra segments", "Bearer a.b.c.d"],
    ["lower-case scheme", "bearer aaa.bbb.ccc"],
    ["trailing data", "Bearer aaa.bbb.ccc extra"],
  ])("%s is unauthenticated and nothing is asked of the auth server or the database", async (_l, header) => {
    const { deps, result } = decide(header as string | null, "owner-uid", true);
    expect(await result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(deps.userIdOf).not.toHaveBeenCalled(); expect(deps.isPlatformOwner).not.toHaveBeenCalled();
  });
  it.each([
    ["the service-role or anon key (a JWT with no user)", null],
    ["an expired or forged session", new Error("invalid JWT")],
    ["an empty user id", ""],
  ])("%s is unauthenticated; the database is never asked", async (_l, user) => {
    const { deps, result } = decide(JWT, user as string | null | Error, true);
    expect(await result).toEqual({ ok: false, reason: "unauthenticated" });
    expect(deps.isPlatformOwner).not.toHaveBeenCalled();
  });
  it.each([
    ["an ordinary member or workspace owner", false],
    ["a commercial-tier administrator or an inactive platform owner", false],
    ["an answer that is not exactly true (string)", "true"],
    ["an answer that is not exactly true (number)", 1],
    ["no answer", null],
    ["an object", { is_platform_owner: true }],
  ])("%s is forbidden", async (_l, owner) => {
    expect(await decide(JWT, "member-uid", owner).result).toEqual({ ok: false, reason: "forbidden" });
  });
  it("a database that cannot answer is unavailable (fail closed)", async () => {
    expect(await decide(JWT, "owner-uid", new Error("connection reset")).result).toEqual({ ok: false, reason: "unavailable" });
  });
});
