import { describe, it, expect, vi } from "vitest";
import { generateCorrelationId, buildLogContext, logWithContext } from "./correlationId";

describe("generateCorrelationId", () => {
  it("produces distinct values on successive calls", () => {
    const a = generateCorrelationId();
    const b = generateCorrelationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("buildLogContext", () => {
  it("fills in a correlationId when none is supplied", () => {
    const ctx = buildLogContext({ companyId: "c1" });
    expect(ctx.correlationId).toBeTruthy();
    expect(ctx.companyId).toBe("c1");
  });

  it("preserves a caller-supplied correlationId instead of generating a new one", () => {
    const ctx = buildLogContext({ correlationId: "fixed-id", periodYear: 2026 });
    expect(ctx.correlationId).toBe("fixed-id");
    expect(ctx.periodYear).toBe(2026);
  });

  it("omits optional fields entirely when not provided, rather than writing undefined", () => {
    const ctx = buildLogContext({ correlationId: "fixed-id" });
    expect("companyId" in ctx).toBe(false);
    expect("periodYear" in ctx).toBe(false);
    expect("engineRunId" in ctx).toBe(false);
  });
});

describe("logWithContext", () => {
  it("routes error level to console.error with the message and context merged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logWithContext("error", "boom", { correlationId: "cid-1", companyId: "c1" });
    expect(spy).toHaveBeenCalledWith({ message: "boom", correlationId: "cid-1", companyId: "c1" });
    spy.mockRestore();
  });

  it("routes info level to console.info", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logWithContext("info", "ok", { correlationId: "cid-2" });
    expect(spy).toHaveBeenCalledWith({ message: "ok", correlationId: "cid-2" });
    spy.mockRestore();
  });
});
