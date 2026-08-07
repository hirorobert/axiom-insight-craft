import { describe, it, expect } from "vitest";
import {
  resolveActiveUpload,
  buildPrepareUploadRoute,
  type ResolvableUpload,
} from "./resolveActiveUpload";

interface U extends ResolvableUpload {
  id: string;
  period_year?: number | null;
  derived?: number;
}

const derive = (u: U) => u.derived ?? 0;

const A: U = { id: "a", period_year: 2025 };
const B: U = { id: "b", period_year: 2025 };
const C: U = { id: "c", period_year: 2024 };
const LEGACY: U = { id: "legacy", period_year: null, derived: 2023 };

const all = [A, B, C, LEGACY];

describe("resolveActiveUpload — pinned click never disappears", () => {
  it("resolves the pinned upload even when a sibling shares the same year", () => {
    for (const u of all) {
      const resolved = resolveActiveUpload({
        uploads: all,
        requestedUploadId: u.id,
        periodYear: 2025,
        derivePeriodYear: derive,
      });
      expect(resolved?.id).toBe(u.id);
    }
  });

  it("never returns null when the pinned upload exists", () => {
    const resolved = resolveActiveUpload({
      uploads: all,
      requestedUploadId: "b",
      periodYear: 1999,
      derivePeriodYear: derive,
    });
    expect(resolved?.id).toBe("b");
  });

  it("resolves a pinned legacy upload with a null period_year", () => {
    const resolved = resolveActiveUpload({
      uploads: all,
      requestedUploadId: "legacy",
      periodYear: 2025,
      derivePeriodYear: derive,
    });
    expect(resolved?.id).toBe("legacy");
  });

  it("falls back to year resolution when the pin is stale (deleted upload)", () => {
    const resolved = resolveActiveUpload({
      uploads: all,
      requestedUploadId: "deleted-id",
      periodYear: 2024,
      derivePeriodYear: derive,
    });
    expect(resolved?.id).toBe("c");
  });

  it("is idempotent — re-resolving the same pin returns the same record", () => {
    const args = {
      uploads: all,
      requestedUploadId: "c",
      periodYear: 2025,
      derivePeriodYear: derive,
    };
    expect(resolveActiveUpload(args)?.id).toBe(resolveActiveUpload(args)?.id);
  });
});

describe("resolveActiveUpload — unpinned resolution order", () => {
  it("prefers an exact period_year match", () => {
    expect(
      resolveActiveUpload({ uploads: all, periodYear: 2024, derivePeriodYear: derive })?.id,
    ).toBe("c");
  });

  it("falls back to the derived fiscal period for legacy uploads", () => {
    expect(
      resolveActiveUpload({ uploads: all, periodYear: 2023, derivePeriodYear: derive })?.id,
    ).toBe("legacy");
  });

  it("falls back to the most recent upload when nothing matches", () => {
    expect(
      resolveActiveUpload({ uploads: all, periodYear: 1990, derivePeriodYear: derive })?.id,
    ).toBe("a");
  });

  it("returns null only when there are no uploads at all", () => {
    expect(
      resolveActiveUpload({ uploads: [], requestedUploadId: "a", periodYear: 2025, derivePeriodYear: derive }),
    ).toBeNull();
  });
});

describe("buildPrepareUploadRoute — every click carries the pin", () => {
  it("pins the upload id", () => {
    expect(buildPrepareUploadRoute("co-1", 2025, "u-1")).toBe(
      "/workspace/co-1/2025/prepare?upload=u-1",
    );
  });

  it("omits the pin after a fresh upload", () => {
    expect(buildPrepareUploadRoute("co-1", 2025)).toBe("/workspace/co-1/2025/prepare");
    expect(buildPrepareUploadRoute("co-1", 2025, null)).toBe("/workspace/co-1/2025/prepare");
  });

  it("round-trips: the built route resolves back to the clicked upload", () => {
    for (const u of all) {
      const route = buildPrepareUploadRoute("co-1", 2025, u.id);
      const pinned = new URL(route, "http://localhost").searchParams.get("upload");
      const resolved = resolveActiveUpload({
        uploads: all,
        requestedUploadId: pinned,
        periodYear: 2025,
        derivePeriodYear: derive,
      });
      expect(resolved?.id).toBe(u.id);
    }
  });
});
