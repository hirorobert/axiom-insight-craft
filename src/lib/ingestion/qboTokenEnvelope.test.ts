// @vitest-environment node
import { describe, expect, it } from "vitest";
import { connectionBinding, keyFromBase64, openSecret, sealSecret, TokenEnvelopeError, type EnvelopeBinding, type EnvelopeKey } from "../../../supabase/functions/_shared/qboTokenEnvelope";

// Invented values only: the "tokens" below are not real, and the keys are fixed test bytes.
const KEY_A: EnvelopeKey = { id: "k1", bytes: new Uint8Array(32).fill(7) };
const KEY_B: EnvelopeKey = { id: "k2", bytes: new Uint8Array(32).fill(9) };
const BIND: EnvelopeBinding = { workspaceId: "11111111-1111-1111-1111-111111111111", connectionId: "c-1", purpose: "qbo-refresh-token" };
const TOKEN = "AB11-test-refresh-token-not-real-0001";

describe("token envelope", () => {
  it("round-trips, and the envelope does not contain the secret", async () => {
    const env = await sealSecret(TOKEN, KEY_A, BIND);
    expect(env.split(".")).toHaveLength(4);
    expect(env.startsWith("v1.k1.")).toBe(true);
    expect(env).not.toContain(TOKEN);
    expect(env).not.toContain(btoa(TOKEN));
    expect(await openSecret(env, [KEY_A], BIND)).toBe(TOKEN);
  });

  it("uses a fresh IV every time: the same secret never seals to the same envelope", async () => {
    const a = await sealSecret(TOKEN, KEY_A, BIND);
    const b = await sealSecret(TOKEN, KEY_A, BIND);
    expect(a).not.toBe(b);
  });

  it("is bound to its owner: another workspace, connection or purpose cannot open it", async () => {
    const env = await sealSecret(TOKEN, KEY_A, BIND);
    for (const other of [
      { ...BIND, workspaceId: "22222222-2222-2222-2222-222222222222" },
      { ...BIND, connectionId: "c-2" },
      { ...BIND, purpose: "qbo-access-token" },
    ]) {
      await expect(openSecret(env, [KEY_A], other)).rejects.toThrow("The stored secret could not be opened.");
    }
  });

  it("binds the fields without letting one shift into the next", async () => {
    const env = await sealSecret(TOKEN, KEY_A, { workspaceId: "ab", connectionId: "c", purpose: "p" });
    await expect(openSecret(env, [KEY_A], { workspaceId: "a", connectionId: "bc", purpose: "p" })).rejects.toBeInstanceOf(TokenEnvelopeError);
  });

  it("fails closed, with one non-revealing error, for a wrong key, a changed part, a relabelled key id or garbage", async () => {
    const env = await sealSecret(TOKEN, KEY_A, BIND);
    const [v, id, iv, ct] = env.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const cases = [
      { e: env, keys: [{ id: "k1", bytes: KEY_B.bytes }] }, // right id, wrong key
      { e: env, keys: [KEY_B] }, // key not present
      { e: [v, id, flip(iv), ct].join("."), keys: [KEY_A] }, // IV changed
      { e: [v, id, iv, flip(ct)].join("."), keys: [KEY_A] }, // ciphertext changed
      { e: [v, id, iv, ct.slice(0, -2)].join("."), keys: [KEY_A] }, // truncated tag
      { e: [v, "k2", iv, ct].join("."), keys: [KEY_A, { id: "k2", bytes: KEY_A.bytes }] }, // key id relabelled (bound in AAD)
      { e: ["v2", id, iv, ct].join("."), keys: [KEY_A] },
      { e: "garbage", keys: [KEY_A] },
      { e: "", keys: [KEY_A] },
      { e: [v, id, iv, "!!"].join("."), keys: [KEY_A] },
    ];
    for (const c of cases) {
      const err = await openSecret(c.e, c.keys, BIND).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(TokenEnvelopeError);
      expect(err.message).toBe("The stored secret could not be opened.");
    }
  });

  it("supports key rotation: new writes use the newest key, old envelopes still open with the key they name", async () => {
    const old = await sealSecret(TOKEN, KEY_A, BIND);
    const fresh = await sealSecret(TOKEN, KEY_B, BIND);
    expect(fresh.startsWith("v1.k2.")).toBe(true);
    expect(await openSecret(old, [KEY_B, KEY_A], BIND)).toBe(TOKEN);
    expect(await openSecret(fresh, [KEY_B, KEY_A], BIND)).toBe(TOKEN);
  });

  it("refuses a key that is not exactly 32 bytes, a bad key id, an empty secret and an incomplete binding", async () => {
    await expect(sealSecret(TOKEN, { id: "k1", bytes: new Uint8Array(16) }, BIND)).rejects.toThrow(/32 bytes/);
    await expect(sealSecret(TOKEN, { id: "K 1", bytes: KEY_A.bytes }, BIND)).rejects.toThrow(/key id/);
    await expect(sealSecret("", KEY_A, BIND)).rejects.toThrow(/no secret/);
    await expect(sealSecret(TOKEN, KEY_A, { ...BIND, workspaceId: "" })).rejects.toThrow(/binding/);
  });

  it("binds a connection by the identity that determines it (workspace, environment, QuickBooks company), since its row id does not exist yet", async () => {
    const b = connectionBinding("11111111-1111-1111-1111-111111111111", "9341458604136919", "sandbox");
    expect(b).toEqual({ workspaceId: "11111111-1111-1111-1111-111111111111", connectionId: "sandbox:9341458604136919", purpose: "qbo-refresh-token" });
    const env = await sealSecret(TOKEN, KEY_A, b);
    expect(await openSecret(env, [KEY_A], b)).toBe(TOKEN);
    await expect(openSecret(env, [KEY_A], connectionBinding(b.workspaceId, "9341458604136919", "production"))).rejects.toBeInstanceOf(TokenEnvelopeError);
    await expect(openSecret(env, [KEY_A], connectionBinding(b.workspaceId, "9341458604136920", "sandbox"))).rejects.toBeInstanceOf(TokenEnvelopeError);
  });

  it("reads a key from a base64 secret and refuses anything that is not 32 bytes", () => {
    const good = btoa(String.fromCharCode(...KEY_A.bytes));
    expect(keyFromBase64("k1", good).bytes).toEqual(KEY_A.bytes);
    expect(() => keyFromBase64("k1", btoa("short"))).toThrow(/32 bytes/);
    expect(() => keyFromBase64("k1", "%%%")).toThrow(/base64/);
    expect(() => keyFromBase64("BAD ID", good)).toThrow(/key id/);
  });
});
