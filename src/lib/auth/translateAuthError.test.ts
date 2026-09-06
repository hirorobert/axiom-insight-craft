/**
 * PPG-1 Finding 2 — auth error translation boundary tests.
 *
 * Lovable's claim ("signup can hit Supabase's email rate limit, causing no
 * confirmation email and exposing the raw provider error") was found FALSE
 * for the primary signup path — a prior commit already added a rate-limit
 * branch there. Repository evidence surfaced a confirmed residual gap
 * instead: the "resend confirmation" flow had no translation at all, so a
 * rate-limited resend (the exact scenario that button exists to help with)
 * still showed the raw Supabase string. These tests cover the shared
 * translator now used by both call sites.
 */

import { describe, it, expect } from "vitest";
import { translateAuthError } from "./translateAuthError";

describe("translateAuthError — rate limit", () => {
  it("translates Supabase's raw rate-limit message", () => {
    const result = translateAuthError({ message: "email rate limit exceeded" });
    expect(result.category).toBe("rate_limited");
    expect(result.message).not.toMatch(/rate limit exceeded/i);
    expect(result.message).toMatch(/wait a little and try again/i);
  });

  it("translates a generic 'too many requests' message", () => {
    const result = translateAuthError({ message: "Too Many Requests" });
    expect(result.category).toBe("rate_limited");
  });

  it("translates by HTTP 429 status even without rate-limit wording", () => {
    const result = translateAuthError({ message: "unexpected_failure", status: 429 });
    expect(result.category).toBe("rate_limited");
  });

  it("points the user at Resend confirmation instead of creating a new account", () => {
    const result = translateAuthError({ message: "email rate limit exceeded" });
    expect(result.message).toMatch(/resend confirmation/i);
  });
});

describe("translateAuthError — duplicate signup", () => {
  it("translates 'User already registered'", () => {
    const result = translateAuthError({ message: "User already registered" });
    expect(result.category).toBe("already_registered");
    expect(result.message).toMatch(/already registered/i);
  });
});

describe("translateAuthError — invalid email", () => {
  it("translates an invalid-email provider message", () => {
    const result = translateAuthError({ message: "Unable to validate email address: invalid format" });
    expect(result.category).toBe("invalid_email");
  });
});

describe("translateAuthError — weak password", () => {
  it("translates a password-policy provider message", () => {
    const result = translateAuthError({ message: "Password should be at least 6 characters" });
    expect(result.category).toBe("weak_password");
  });
});

describe("translateAuthError — network failure", () => {
  it("translates a fetch failure", () => {
    const result = translateAuthError({ message: "Failed to fetch" });
    expect(result.category).toBe("network_error");
  });

  it("translates a generic network-error message", () => {
    const result = translateAuthError({ message: "NetworkError when attempting to fetch resource" });
    expect(result.category).toBe("network_error");
  });
});

describe("translateAuthError — generic/unknown failure never leaks provider internals", () => {
  it("falls back to a calm generic message for an unrecognized error shape", () => {
    const result = translateAuthError({ message: "PGRST301: JWT expired, code XK-42" });
    expect(result.category).toBe("unknown");
    expect(result.message).not.toMatch(/PGRST|JWT|XK-42/);
  });

  it("handles a null/undefined error without throwing", () => {
    expect(() => translateAuthError(null)).not.toThrow();
    expect(() => translateAuthError(undefined)).not.toThrow();
    expect(translateAuthError(null).category).toBe("unknown");
  });

  it("handles an error with an empty message", () => {
    const result = translateAuthError({ message: "" });
    expect(result.category).toBe("unknown");
  });

  it("never returns the raw message verbatim for any category", () => {
    const cases = [
      "email rate limit exceeded",
      "User already registered",
      "Unable to validate email address: invalid format",
      "Password should be at least 6 characters",
      "Failed to fetch",
      "some completely unrecognized internal error string",
    ];
    for (const message of cases) {
      const result = translateAuthError({ message });
      expect(result.message).not.toBe(message);
    }
  });
});
