/**
 * sessionGuard.test.ts — SQLSTATE 42501 means "authorization denied", not "session invalid".
 *
 * Regression: sessionGuard treated any 42501 / 403 / "permission denied" as an expired session and
 * signed the user out, so a genuine permission answer on one panel destroyed a perfectly valid session.
 * Only proven authentication invalidation may sign out; a denial for a valid session is reported and the
 * user stays signed in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getUser: vi.fn(), signOut: vi.fn(), getSession: vi.fn(), refreshSession: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal("window", { location: { pathname: "/workspace/x", assign } });
  auth.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const PERMISSION_DENIED = { code: "42501", message: "permission denied for table companies" };

describe("classification", () => {
  it("42501, 403 and 'permission denied' are authorization denials, never session invalidation", async () => {
    const { isSessionInvalid, isAuthorizationDenied } = await import("./sessionGuard");
    for (const e of [PERMISSION_DENIED, { status: 403, message: "forbidden" }, { message: "new row violates row-level security policy: permission denied" }]) {
      expect(isSessionInvalid(e)).toBe(false);
      expect(isAuthorizationDenied(e)).toBe(true);
    }
  });

  it("expired/invalid JWTs and missing sessions are session invalidation", async () => {
    const { isSessionInvalid, isAuthorizationDenied } = await import("./sessionGuard");
    for (const e of [
      { code: "PGRST301", message: "JWT expired" }, { status: 401, message: "Unauthorized" }, { message: "invalid JWT: unable to parse" },
      { code: "session_not_found" }, { code: "user_not_found", status: 403 }, { name: "AuthSessionMissingError", message: "Auth session missing!" },
    ]) {
      expect(isSessionInvalid(e)).toBe(true);
      expect(isAuthorizationDenied(e)).toBe(false);
    }
  });

  it("ordinary data errors are neither", async () => {
    const { isAuthorizationFailure } = await import("./sessionGuard");
    expect(isAuthorizationFailure({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isAuthorizationFailure(null)).toBe(false);
    expect(isAuthorizationFailure("x")).toBe(false);
  });
});

describe("handleIfAuthorizationFailure", () => {
  it("VALID SESSION + 42501: reports the denial, keeps the session, never signs out or redirects", async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await expect(handleIfAuthorizationFailure(PERMISSION_DENIED)).resolves.toBe(true);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).toMatch(/still signed in/i);
  });

  it("VALID SESSION + 403: the same — no sign-out", async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: { id: "u1" } }, error: null });
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await handleIfAuthorizationFailure({ status: 403, message: "forbidden" });
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("a burst of denials from several panels shows one toast, not a stack", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await Promise.all([handleIfAuthorizationFailure(PERMISSION_DENIED), handleIfAuthorizationFailure(PERMISSION_DENIED), handleIfAuthorizationFailure(PERMISSION_DENIED)]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("42501 while the auth server confirms the session is gone: signs out (proven invalidation)", async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 } });
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await handleIfAuthorizationFailure(PERMISSION_DENIED);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(assign).toHaveBeenCalledWith("/auth");
  });

  it("42501 while the session check itself fails on the network: NOT proof of anything, no sign-out", async () => {
    auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } });
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await handleIfAuthorizationFailure(PERMISSION_DENIED);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("an expired JWT (PGRST301) signs out without a second round-trip", async () => {
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await expect(handleIfAuthorizationFailure({ code: "PGRST301", message: "JWT expired" })).resolves.toBe(true);
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(assign).toHaveBeenCalledWith("/auth");
  });

  it("a non-auth error is left to the caller (returns false, no toast, no sign-out)", async () => {
    const { handleIfAuthorizationFailure } = await import("./sessionGuard");
    await expect(handleIfAuthorizationFailure({ code: "23505" })).resolves.toBe(false);
    expect(toastError).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
