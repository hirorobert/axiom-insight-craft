/**
 * DiscardUploadDialog.test.ts — discardUpload()'s fail-closed behaviour.
 *
 * Root-cause coverage for the observed "Could not discard this trial balance." generic failure: the snapshot read
 * that makes a discard undo-able was never checked for its own error, so a transient failure there silently turned
 * an "irreversible with a 15-second undo" discard into a PERMANENTLY irreversible one, with no row ever deleted
 * either way (a false negative that also happens to be safe) — the real risk was any caller ever trusting a receipt
 * with row:null as if undo would work. This is fixed by aborting before anything is deleted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const supa = vi.hoisted(() => ({
  select: vi.fn(),
  del: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: () => supa.select(table) }) }),
      delete: () => ({ eq: () => supa.del(table) }),
    }),
    storage: { from: () => ({ download: (p: string) => supa.download(p), remove: (p: string[]) => supa.remove(p) }) },
  },
}));

afterEach(() => vi.clearAllMocks());

const TARGET = { id: "u1", file_name: "tb.xlsx", file_path: "co/tb.xlsx", status: "needs_review", is_valid: null };
const ROW = { id: "u1", file_name: "tb.xlsx", status: "needs_review" };

describe("discardUpload — fails closed when the pre-delete snapshot read itself fails", () => {
  it("aborts and deletes NOTHING when the snapshot SELECT returns an error — never silently proceeds without a receipt", async () => {
    supa.select.mockResolvedValueOnce({ data: null, error: { message: "network error", code: "PGRST000" } });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    await expect(discardUpload(TARGET)).rejects.toBeInstanceOf(DiscardError);
    expect(supa.del).not.toHaveBeenCalled();
    expect(supa.download).not.toHaveBeenCalled();
    expect(supa.remove).not.toHaveBeenCalled();
  });

  it("the thrown DiscardError is retryable, carries a reference id, and never contains the raw Postgres error text", async () => {
    supa.select.mockResolvedValueOnce({ data: null, error: { message: "relation \"internal_table\" does not exist", code: "42P01" } });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.retryable).toBe(true);
    expect(err.reference).toMatch(/^DSC-/);
    expect(err.safeMessage).toContain(err.reference);
    expect(err.safeMessage).not.toContain("internal_table");
    expect(err.safeMessage).not.toContain("42P01");
    expect(err.safeMessage).toMatch(/safe to try again/i);
  });
});

describe("discardUpload — the row DELETE failure is translated into a safe, actionable error", () => {
  it("a foreign-key violation (23503 — another record still depends on this upload) is NOT retryable and names no internal table", async () => {
    supa.select.mockResolvedValueOnce({ data: ROW, error: null });
    supa.download.mockResolvedValueOnce({ data: new Blob(["x"]) });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.del.mockResolvedValueOnce({ error: { message: 'update or delete on table "trial_balance_uploads" violates foreign key constraint "fk_x" on table "hesabu_validations"', code: "23503" } });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiscardError);
    const err = caught as InstanceType<typeof DiscardError>;
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/other records.*depend on it/i);
    expect(err.safeMessage).not.toContain("hesabu_validations");
    expect(err.safeMessage).not.toContain("fk_x");
    expect(err.safeMessage).not.toMatch(/safe to try again/i);
  });

  it("a non-foreign-key delete failure IS retryable", async () => {
    supa.select.mockResolvedValueOnce({ data: ROW, error: null });
    supa.download.mockResolvedValueOnce({ data: null });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.del.mockResolvedValueOnce({ error: { message: "connection reset", code: "08006" } });
    const { discardUpload, DiscardError } = await import("./DiscardUploadDialog");

    let caught: unknown;
    try {
      await discardUpload(TARGET);
    } catch (e) {
      caught = e;
    }
    expect((caught as InstanceType<typeof DiscardError>).retryable).toBe(true);
  });
});

describe("discardUpload — the happy path is unaffected", () => {
  it("returns a full receipt (row + file) when every step succeeds, so undo remains exact", async () => {
    supa.select.mockResolvedValueOnce({ data: ROW, error: null });
    const blob = new Blob(["contents"]);
    supa.download.mockResolvedValueOnce({ data: blob });
    supa.remove.mockResolvedValueOnce({ data: null, error: null });
    supa.del.mockResolvedValueOnce({ error: null });
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload(TARGET);
    expect(receipt).toEqual({ id: "u1", fileName: "tb.xlsx", row: ROW, filePath: "co/tb.xlsx", fileBlob: blob });
  });

  it("a target with no file_path skips storage entirely and still succeeds", async () => {
    supa.select.mockResolvedValueOnce({ data: ROW, error: null });
    supa.del.mockResolvedValueOnce({ error: null });
    const { discardUpload } = await import("./DiscardUploadDialog");

    const receipt = await discardUpload({ ...TARGET, file_path: null });
    expect(supa.download).not.toHaveBeenCalled();
    expect(receipt.fileBlob).toBeNull();
  });
});

describe("isCertifiedRun", () => {
  it("treats a complete or explicitly-valid run as certified evidence requiring the typed DISCARD gate", async () => {
    const { isCertifiedRun } = await import("./DiscardUploadDialog");
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "complete", is_valid: null })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "needs_review", is_valid: true })).toBe(true);
    expect(isCertifiedRun({ id: "1", file_name: "x", status: "needs_review", is_valid: false })).toBe(false);
    expect(isCertifiedRun(null)).toBe(false);
    expect(isCertifiedRun(undefined)).toBe(false);
  });
});
