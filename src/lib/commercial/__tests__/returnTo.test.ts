// @vitest-environment jsdom
/**
 * Return to an unfinished order across sign-in (checkoutClient.rememberReturnTo / takeReturnTo): one of two fixed
 * destinations with a validated order reference, used once — never a free-form path (no open redirect).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
import { rememberReturnTo, takeReturnTo } from "../checkoutClient";

beforeEach(() => localStorage.clear());

describe("return to an unfinished order after sign-in", () => {
  it("the order page and the plans page naming the order, each used once", () => {
    rememberReturnTo({ kind: "order", ref: "SAFF-1729400000000-AB12CD34" });
    expect(takeReturnTo()).toBe("/billing/payment/return?ref=SAFF-1729400000000-AB12CD34");
    expect(takeReturnTo()).toBeNull();
    rememberReturnTo({ kind: "plans", ref: "SAFF-1729400000000-AB12CD34" });
    expect(takeReturnTo()).toBe("/plans?unfinished=SAFF-1729400000000-AB12CD34");
  });
  it("anything but a well-formed order reference is never stored or followed", () => {
    for (const ref of ["https://evil.example/x", "//evil.example", "SAFF-1&next=/x", "../../admin", "", "SAFF-"]) {
      rememberReturnTo({ kind: "order", ref });
      expect(takeReturnTo()).toBeNull();
    }
    localStorage.setItem("cfoclose.returnTo", JSON.stringify({ kind: "anywhere", ref: "SAFF-1729400000000-AB12CD34" }));
    expect(takeReturnTo()).toBeNull();
    localStorage.setItem("cfoclose.returnTo", "{not json");
    expect(takeReturnTo()).toBeNull();
    localStorage.setItem("cfoclose.returnTo", JSON.stringify({ kind: "order", ref: "javascript:alert(1)" }));
    expect(takeReturnTo()).toBeNull();
  });
});
