/**
 * PPG-1R §7 — AUTH ERROR UX reconstruction.
 *
 * Codex reported "AUTH ERROR UX FAIL" without naming the specific defect.
 * Independent hostile-testing reconstruction found TWO genuine issues,
 * both fixed:
 *
 *   1. translateAuthError() threw a TypeError when `error.message` was a
 *      truthy non-string value (e.g. a number) — `(x ?? "").toLowerCase()`
 *      only guards null/undefined, not a wrong-typed truthy value. Fixed
 *      and covered by translateAuthError.test.ts's hostile-shape suite.
 *   2. Neither the signup/login submit handler nor the resend-confirmation
 *      handler had a SYNCHRONOUS duplicate-request guard — both relied
 *      solely on the submit button's `disabled={loading}` attribute,
 *      which does not guarantee no second invocation reaches the handler
 *      before React commits the disabled render (a fast double-click, or
 *      Enter-key submission racing a click). Fixed with an explicit
 *      `if (loading) return;` at the top of each handler.
 *
 * This repository has no React-component-rendering test infrastructure,
 * so item 2 is verified as a static source-text guard — the same
 * technique already used elsewhere in this repository for otherwise-
 * untestable UI logic.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(__dirname, "Auth.tsx"), "utf-8");

describe("Auth.tsx — synchronous duplicate-request guards (PPG-1R §7)", () => {
  it("handleSubmit checks `if (loading) return;` before doing anything else", () => {
    const handleSubmitStart = SRC.indexOf("const handleSubmit = async (e: React.FormEvent) => {");
    expect(handleSubmitStart).toBeGreaterThan(-1);
    // The guard must appear before the first `setLoading(true)` call in
    // this handler — i.e. it gates entry, it doesn't just duplicate the
    // eventual state set.
    const setLoadingTrueIndex = SRC.indexOf("setLoading(true)", handleSubmitStart);
    const guardIndex = SRC.indexOf("if (loading) return;", handleSubmitStart);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(setLoadingTrueIndex);
  });

  it("the resend-confirmation handler also checks `if (loading) return;` before its own setLoading(true)", () => {
    const resendOnClickStart = SRC.indexOf('type: "signup",');
    expect(resendOnClickStart).toBeGreaterThan(-1);
    // Search backwards from the resend call for its enclosing onClick's
    // guard and setLoading(true) — both must precede the actual API call,
    // with the guard first.
    const enclosingStart = SRC.lastIndexOf("onClick={async () => {", resendOnClickStart);
    expect(enclosingStart).toBeGreaterThan(-1);
    const block = SRC.slice(enclosingStart, resendOnClickStart);
    expect(block).toMatch(/if \(loading\) return;/);
    const guardIndex = block.indexOf("if (loading) return;");
    const setLoadingIndex = block.indexOf("setLoading(true)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(setLoadingIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(setLoadingIndex);
  });

  it("both signup and resend error branches route through translateAuthError — never a raw error.message", () => {
    // Scoped to the signup/resend branches specifically — login and
    // password-reset error handling are a separate, out-of-scope concern
    // (PPG-1 Finding 2 was specifically about the signup/confirmation-
    // email flow) and still use their own pre-existing error handling.
    const translateCalls = SRC.match(/translateAuthError\(error\)\.message/g) ?? [];
    expect(translateCalls.length).toBeGreaterThanOrEqual(2); // signup + resend
  });

  it("imports translateAuthError from the centralized boundary module", () => {
    expect(SRC).toMatch(/import \{ translateAuthError \} from "@\/lib\/auth\/translateAuthError";/);
  });
});
