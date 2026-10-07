import { describe, expect, it } from "vitest";
import { contextChangeAnnouncement, contextKey, parseReportVersion, withContext } from "./context";

describe("workbench context", () => {
  it("parses the report version strictly", () => {
    expect(parseReportVersion("?v=4")).toBe(4);
    for (const bad of ["", "?v=0", "?v=-1", "?v=4.5", "?v=abc", "?v=04", "?v= 4"]) expect(parseReportVersion(bad), bad).toBeNull();
  });
  it("carries the version on every link and replaces a different one", () => {
    expect(withContext("/w/c/2025/trial-balance/review", { reportVersion: 4 })).toBe("/w/c/2025/trial-balance/review?v=4");
    expect(withContext("/w/x?v=3&tab=a", { reportVersion: 4 })).toBe("/w/x?v=4&tab=a");
    expect(withContext("/w/x?v=3", { reportVersion: null })).toBe("/w/x");
  });
  it("keys responses by company, period and version", () => {
    const a = { companyId: "c", periodYear: 2025, reportVersion: 4 };
    expect(contextKey(a)).not.toBe(contextKey({ ...a, periodYear: 2024 }));
    expect(contextKey(a)).not.toBe(contextKey({ ...a, reportVersion: 3 }));
    expect(contextKey(a)).not.toBe(contextKey({ ...a, companyId: "d" }));
  });
  it("announces an explicit context change, and nothing otherwise", () => {
    const a = { companyId: "c", periodYear: 2025, reportVersion: 4 };
    expect(contextChangeAnnouncement(a, { ...a, periodYear: 2024 })).toBe("Now viewing FY2024.");
    expect(contextChangeAnnouncement(a, { ...a, reportVersion: 3 })).toBe("Now viewing report version 3.");
    expect(contextChangeAnnouncement(a, a)).toBeNull();
  });
});
