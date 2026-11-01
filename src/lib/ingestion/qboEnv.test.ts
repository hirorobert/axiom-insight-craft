// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readQboEnv } from "../../../supabase/functions/_shared/qboEnv";

// Invented values only.
const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const FULL: Record<string, string> = {
  QBO_CLIENT_ID_SANDBOX: "ABsandboxclientid0000000000000000000000", QBO_CLIENT_SECRET_SANDBOX: "sandbox-secret-not-real",
  QBO_REDIRECT_URI: "https://project.example.test/functions/v1/qbo-oauth-callback", QBO_APP_URL: "https://app.example.test/",
  QBO_TOKEN_KEY_ID: "k2", QBO_TOKEN_KEY_B64: b64(2),
};
const env = (o: Record<string, string | undefined>) => readQboEnv((n) => o[n]);

describe("connector configuration", () => {
  it("reads a complete sandbox configuration", () => {
    const c = env(FULL);
    expect(c.oauth("sandbox")).toEqual({ clientId: FULL.QBO_CLIENT_ID_SANDBOX, redirectUri: FULL.QBO_REDIRECT_URI });
    expect(c.credentials("sandbox")).toEqual({ clientId: FULL.QBO_CLIENT_ID_SANDBOX, clientSecret: FULL.QBO_CLIENT_SECRET_SANDBOX });
    expect(c.appUrl()).toBe("https://app.example.test");
    expect(c.minorVersion).toBe(75);
    expect(c.keys()?.current.id).toBe("k2"); expect(c.keys()?.all).toHaveLength(1);
  });
  it("production is configured only when ITS OWN id and secret are set: the sandbox ones never stand in", () => {
    expect(env(FULL).oauth("production")).toBeNull(); expect(env(FULL).credentials("production")).toBeNull();
    const c = env({ ...FULL, QBO_CLIENT_ID_PRODUCTION: "ABprodclientid000000000000000000000000", QBO_CLIENT_SECRET_PRODUCTION: "prod-secret-not-real" });
    expect(c.oauth("production")?.clientId).toBe("ABprodclientid000000000000000000000000");
  });
  it.each<[string, Record<string, string | undefined>]>([
    ["no client id", { ...FULL, QBO_CLIENT_ID_SANDBOX: undefined }],
    ["no secret", { ...FULL, QBO_CLIENT_SECRET_SANDBOX: "  " }],
    ["no redirect address", { ...FULL, QBO_REDIRECT_URI: undefined }],
    ["a redirect address that is not https", { ...FULL, QBO_REDIRECT_URI: "http://project.example.test/cb" }],
    ["a redirect address with a query", { ...FULL, QBO_REDIRECT_URI: "https://project.example.test/cb?x=1" }],
  ])("is not configured with %s", (_l, o) => { expect(env(o).oauth("sandbox")).toBeNull(); });
  it("an app address must be https without a query", () => {
    expect(env({ ...FULL, QBO_APP_URL: "http://app.example.test" }).appUrl()).toBeNull();
    expect(env({ ...FULL, QBO_APP_URL: "https://app.example.test?x=1" }).appUrl()).toBeNull();
    expect(env({ ...FULL, QBO_APP_URL: undefined }).appUrl()).toBeNull();
  });
  it("keys: none without a current key; a key that is not exactly 32 bytes is refused; a previous key is kept for opening only", () => {
    expect(env({ ...FULL, QBO_TOKEN_KEY_B64: undefined }).keys()).toBeNull();
    expect(env({ ...FULL, QBO_TOKEN_KEY_B64: btoa("short") }).keys()).toBeNull();
    expect(env({ ...FULL, QBO_TOKEN_KEY_ID: "BAD ID" }).keys()).toBeNull();
    const k = env({ ...FULL, QBO_TOKEN_KEY_PREV_ID: "k1", QBO_TOKEN_KEY_PREV_B64: b64(1) }).keys();
    expect(k?.current.id).toBe("k2"); expect(k?.all.map((x) => x.id)).toEqual(["k2", "k1"]);
    expect(env({ ...FULL, QBO_TOKEN_KEY_PREV_ID: "k2", QBO_TOKEN_KEY_PREV_B64: b64(1) }).keys()).toBeNull();
    expect(env({ ...FULL, QBO_TOKEN_KEY_PREV_ID: "k1", QBO_TOKEN_KEY_PREV_B64: "%%%" }).keys()).toBeNull();
  });
  it("the minor version defaults to 75 and refuses nonsense", () => {
    expect(env({ ...FULL, QBO_MINOR_VERSION: "40" }).minorVersion).toBe(40);
    for (const bad of ["abc", "-1", "1000", "7.5"]) expect(env({ ...FULL, QBO_MINOR_VERSION: bad }).minorVersion).toBe(75);
  });
});
