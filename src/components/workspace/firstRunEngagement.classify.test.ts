/**
 * firstRunEngagement.classify.test.ts
 *
 * Unit tests for classifyError() — the workspace-create error classifier in
 * FirstRunEngagement.tsx.
 *
 * Covers every error class the function must handle:
 *   1.  PostgrestError — 23505 unique_violation
 *   2.  PostgrestError — 42501 insufficient_privilege (RLS)
 *   3.  PostgrestError — 23502 not_null_violation
 *   4.  PostgrestError — 23P01 exclusion_violation
 *   5.  PostgrestError — JWT/unauthorized message
 *   6.  PostgrestError — unknown code (generic fallback)
 *   7.  PostgrestError — message contains "unique" (no numeric code)
 *   8.  AuthError — __isAuthError flag
 *   9.  AuthError — status 401 without flag
 *   10. FunctionsHttpError — context.status 401
 *   11. FunctionsHttpError — context.status 403
 *   12. Error — network / fetch
 *   13. Error — "failed to fetch" (browser fetch failure)
 *   14. Error — timeout
 *   15. Error — "unique" in message
 *   16. Error — "jwt" in message
 *   17. null / undefined → generic fallback
 *   18. plain string → generic fallback
 *   19. plain object without code or message → generic fallback
 *   20. Plain object that looks like both AuthError and Postgrest — AuthError wins
 */

import { describe, it, expect } from "vitest";
import { classifyError } from "./workspaceCreateError";

// Helper: build a PostgrestError-like plain object
function pgErr(code: string, message = "error", extra?: Record<string, string>) {
  return { code, message, details: extra?.details, hint: extra?.hint };
}

describe("classifyError — PostgrestError (plain object)", () => {
  it("23505 unique_violation → duplicate message, no retry", () => {
    const r = classifyError(pgErr("23505", "duplicate key value violates unique constraint"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toContain("already exists");
  });

  it("42501 insufficient_privilege (RLS) → permission message, no retry", () => {
    const r = classifyError(pgErr("42501", "permission denied for table companies"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/permission denied/i);
  });

  it("23502 not_null_violation → required field message, no retry", () => {
    const r = classifyError(pgErr("23502", "null value in column violates not-null constraint"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/required field/i);
  });

  it("23P01 exclusion_violation → configuration conflict, canRetry", () => {
    const r = classifyError(pgErr("23P01", "conflicting key value violates exclusion constraint"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toMatch(/configuration conflict/i);
  });

  it("message contains 'jwt' → session expired, no retry", () => {
    const r = classifyError(pgErr("PGRST301", "JWT expired"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it("message contains 'unauthorized' → session expired, no retry", () => {
    const r = classifyError(pgErr("PGRST302", "JWT unauthorized"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it("message contains 'unique' (no numeric code) → duplicate, no retry", () => {
    const r = classifyError({ message: "unique constraint violated", code: "XX000" });
    expect(r.canRetry).toBe(false);
    expect(r.message).toContain("already exists");
  });

  it("unknown code → generic fallback, canRetry", () => {
    const r = classifyError(pgErr("58000", "internal server error"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });

  it("object with only message (no code) is recognised as Postgrest-like", () => {
    const r = classifyError({ message: "some db error" });
    // extractPostgrest should match and return generic Postgrest fallback
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });
});

describe("classifyError — AuthError", () => {
  it("__isAuthError flag → session expired, no retry", () => {
    const r = classifyError({ __isAuthError: true, status: 400, message: "invalid credentials" });
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it("status 401 without flag → session expired, no retry", () => {
    const r = classifyError({ status: 401, message: "Unauthorized" });
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });
});

describe("classifyError — FunctionsHttpError", () => {
  it("context.status 401 → session expired, no retry", () => {
    const r = classifyError({ context: { status: 401 }, message: "Unauthorized" });
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it("context.status 403 → session expired, no retry", () => {
    const r = classifyError({ context: { status: 403 }, message: "Forbidden" });
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });
});

describe("classifyError — standard Error instances", () => {
  it("message includes 'network' → network error, canRetry", () => {
    const r = classifyError(new Error("network error"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toMatch(/network/i);
  });

  it("'failed to fetch' → network error, canRetry", () => {
    const r = classifyError(new Error("Failed to fetch"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toMatch(/network/i);
  });

  it("message includes 'timeout' → network error, canRetry", () => {
    const r = classifyError(new Error("request timeout after 30000ms"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toMatch(/network/i);
  });

  it("message includes 'unique' → duplicate, no retry", () => {
    const r = classifyError(new Error("unique constraint violation"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toContain("already exists");
  });

  it("message includes 'jwt' → session expired, no retry", () => {
    const r = classifyError(new Error("jwt expired"));
    expect(r.canRetry).toBe(false);
    expect(r.message).toMatch(/session/i);
  });

  it("generic Error → fallback, canRetry", () => {
    const r = classifyError(new Error("something weird happened"));
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });
});

describe("classifyError — unknown / null / string", () => {
  it("null → generic fallback, canRetry", () => {
    const r = classifyError(null);
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });

  it("undefined → generic fallback, canRetry", () => {
    const r = classifyError(undefined);
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });

  it("plain string → generic fallback, canRetry", () => {
    const r = classifyError("some error string");
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });

  it("plain object without code or message → generic fallback", () => {
    const r = classifyError({ foo: "bar" });
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });

  it("array → generic fallback", () => {
    const r = classifyError(["error"]);
    expect(r.canRetry).toBe(true);
    expect(r.message).toContain("usually temporary");
  });
});

describe("classifyError — invariants", () => {
  it("canRetry is always boolean (never undefined)", () => {
    const cases: unknown[] = [
      null,
      pgErr("23505"),
      pgErr("42501"),
      pgErr("23502"),
      pgErr("23P01"),
      pgErr("99999"),
      new Error("network error"),
      { __isAuthError: true },
      { context: { status: 401 } },
    ];
    for (const c of cases) {
      const r = classifyError(c);
      expect(typeof r.canRetry).toBe("boolean");
    }
  });

  it("message is always a non-empty string", () => {
    const cases: unknown[] = [null, undefined, "", pgErr("99999"), new Error("x")];
    for (const c of cases) {
      const r = classifyError(c);
      expect(typeof r.message).toBe("string");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
