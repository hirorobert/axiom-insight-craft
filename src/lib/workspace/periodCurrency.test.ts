// @vitest-environment jsdom
/**
 * Period currency correction (20261113100000), browser side: the server's answers read strictly, the offered recovery
 * decided only from them, and the panel's request discipline (one request id per confirmation, deterministic re-check
 * ids, a recoverable re-check). Invented data only.
 */
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import {
  correctPeriodCurrency, decideCorrectionView, explainBlock, getCorrectionEligibility, readCurrencyMismatch,
  type Eligibility, type LastCorrection,
} from "@/lib/workspace/periodCurrency";

const P = "00000000-0000-4000-8000-0000000000a1", U = "00000000-0000-4000-8000-0000000000b1", OP = "00000000-0000-4000-8000-0000000000c1";
const rpcAnswer = (data: unknown, error: unknown = null) => async () => ({ data, error });
const mismatchResult = (checkedAgainst: string, codes: string[]) => ({ ingestion: {
  currency: checkedAgainst, issues: [{ code: "CURRENCY_MISMATCH", severity: "blocking" }],
  evidence: { currencyLabels: codes.map((code, i) => ({ code, text: code, row: 1, column: String.fromCharCode(67 + i) })) },
} });
const eligible = (currency: string, last: LastCorrection | null = null): Eligibility => ({ kind: "eligible", periodId: P, currency, lastCorrection: last });

describe("reading the server", () => {
  it("eligibility: eligible, not eligible with the named record, the last correction, and anything else unavailable", async () => {
    expect(await getCorrectionEligibility(rpcAnswer({ outcome: "eligible", currency: "USD", block: null, last_correction: null }), P))
      .toEqual({ kind: "eligible", periodId: P, currency: "USD", lastCorrection: null });
    const ne = await getCorrectionEligibility(rpcAnswer({ outcome: "not_eligible", currency: "USD",
      block: { code: "ACCEPTED_CERTIFICATION", relation: "public.tb_certifications", record_id: "r1", requires_review: true, certified_at: "2026-10-01T00:00:00Z" },
      last_correction: { event_id: "e1", from: "TZS", to: "USD", occurred_at: "2026-09-30T00:00:00Z", rechecks: [{ upload_id: U, operation_id: OP }] } }), P);
    expect(ne).toMatchObject({ kind: "not_eligible", block: { code: "ACCEPTED_CERTIFICATION", requiresReview: true, recordId: "r1" },
      lastCorrection: { eventId: "e1", to: "USD", rechecks: [{ uploadId: U, operationId: OP }] } });
    for (const d of [{ outcome: "not_found" }, { outcome: "unauthenticated" }])
      expect(await getCorrectionEligibility(rpcAnswer(d), P)).toEqual({ kind: "unavailable", reason: "not_authorised" });
    for (const d of [null, { outcome: "eligible" }])
      expect(await getCorrectionEligibility(rpcAnswer(d), P)).toEqual({ kind: "unavailable", reason: "error" });
    // Before the migration is applied the function does not exist: an error, never a claim about authority.
    expect(await getCorrectionEligibility(rpcAnswer(null, { message: "function does not exist" }), P)).toEqual({ kind: "unavailable", reason: "error" });
  });
  it("correction outcomes: corrected and a replay are one result; stale and refusals are named; transport errors throw", async () => {
    const input = { periodId: P, to: "TZS", from: "USD", reason: "Ledger kept in TZS", requestId: OP };
    expect(await correctPeriodCurrency(rpcAnswer({ outcome: "already_corrected", event_id: "e", from: "USD", to: "TZS", rechecks: [{ upload_id: U, operation_id: OP }] }), input))
      .toEqual({ kind: "corrected", eventId: "e", from: "USD", to: "TZS", rechecks: [{ uploadId: U, operationId: OP }], replayed: true });
    expect(await correctPeriodCurrency(rpcAnswer({ outcome: "stale", currency: "EUR" }), input)).toEqual({ kind: "stale", currency: "EUR" });
    expect(await correctPeriodCurrency(rpcAnswer({ outcome: "not_found" }), input)).toEqual({ kind: "refused", code: "not_found" });
    expect(await correctPeriodCurrency(rpcAnswer({ outcome: "busy" }), input)).toEqual({ kind: "busy" });
    await expect(correctPeriodCurrency(rpcAnswer(null, { message: "network" }), input)).rejects.toBeTruthy();
  });
  it("the mismatch is read only from a recorded CURRENCY_MISMATCH check", () => {
    expect(readCurrencyMismatch(mismatchResult("usd", ["TZS", "TZS"]))).toEqual({ checkedAgainst: "USD", fileCodes: ["TZS"] });
    expect(readCurrencyMismatch({ ingestion: { currency: "USD", issues: [{ code: "PERIOD_MISMATCH" }] } })).toBeNull();
    expect(readCurrencyMismatch(null)).toBeNull();
  });
});

describe("what the card offers (server-decided; never a control the server refuses)", () => {
  const m = readCurrencyMismatch(mismatchResult("USD", ["TZS"]));
  it("eligible: offer the one currency the file names", () => {
    expect(decideCorrectionView(m, eligible("USD"), U)).toEqual({ kind: "offer", from: "USD", to: "TZS" });
  });
  it("already corrected after this check: re-check with the recorded deterministic id", () => {
    const v = decideCorrectionView(m, eligible("TZS", { eventId: "e", from: "USD", to: "TZS", occurredAt: "t", rechecks: [{ uploadId: U, operationId: OP }] }), U);
    expect(v).toEqual({ kind: "recheck", currency: "TZS", checkedAgainst: "USD", recheck: { uploadId: U, operationId: OP } });
  });
  it("not eligible: the named record and the route, no offer", () => {
    const v = decideCorrectionView(m, { kind: "not_eligible", periodId: P, currency: "USD", lastCorrection: null,
      block: { code: "DOWNSTREAM_RECORD", relation: "public.adjusting_journal_entries", recordId: "j1", requiresReview: null, certifiedAt: null } }, U);
    expect(v).toMatchObject({ kind: "blocked", reason: expect.stringContaining("adjusting journal entries"), route: "Replace the file with one whose amounts are in USD." });
  });
  it("mixed labels: no currency change can fix the file", () => {
    expect(decideCorrectionView(readCurrencyMismatch(mismatchResult("USD", ["TZS", "KES"])), eligible("USD"), U)).toMatchObject({ kind: "mixed", codes: ["KES", "TZS"] });
  });
  it("no authority or no read: nothing (the card's Replace stays)", () => {
    expect(decideCorrectionView(m, { kind: "unavailable", reason: "not_authorised" }, U)).toEqual({ kind: "none" });
    expect(decideCorrectionView(m, null, U)).toEqual({ kind: "none" });
    expect(decideCorrectionView(null, eligible("USD"), U)).toEqual({ kind: "none" });
  });
  it("explanations name the record: an accepted certification awaiting review is still a certification", () => {
    const e = explainBlock({ code: "ACCEPTED_CERTIFICATION", relation: "public.tb_certifications", recordId: "c", requiresReview: true, certifiedAt: "2026-10-01T00:00:00Z" }, "USD");
    expect(e.reason).toMatch(/already accepted in USD on 1 Oct 2026 \(it is awaiting account review\)/);
    // Financial-statement tables are named by family, never by table name (kept out of the entry chunk).
    const fs = explainBlock({ code: "DOWNSTREAM_RECORD", relation: "public.financial_evidence_batches", recordId: null, requiresReview: null, certifiedAt: null }, "USD");
    expect(fs.reason).toContain("financial statements work");
    expect(fs.reason).not.toContain("financial_evidence_batches");
    expect(explainBlock({ code: "PROCESSING_IN_PROGRESS", relation: null, recordId: null, requiresReview: null, certifiedAt: null }, "USD").route).toMatch(/Wait/);
  });
});

describe("the panel (real component)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    mounted?.unmount(); mounted = null; vi.resetModules();
    for (const x of ["@/integrations/supabase/client", "@/lib/workspace/requestReprocess"]) vi.doUnmock(x);
  });
  const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); });
  const until = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await flush(); };

  async function setup(reprocessImpl: () => Promise<unknown>) {
    vi.resetModules(); // the static import above loaded the real modules; the panel must see the mocks
    let period = "USD";
    const corrections: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "get_period_currency_correction") return { data: { outcome: "eligible", currency: period, block: null, last_correction: null }, error: null };
      corrections.push(args);
      period = "TZS";
      return { data: { outcome: corrections.length === 1 ? "corrected" : "already_corrected", event_id: "e1", from: "USD", to: "TZS", rechecks: [{ upload_id: U, operation_id: OP }] }, error: null };
    });
    const ids: (string | undefined)[] = [];
    const reprocess = vi.fn(async (_id: string, deps: { newOperationId?: () => string }) => { ids.push(deps.newOperationId?.()); return reprocessImpl(); });
    vi.doMock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
    vi.doMock("@/lib/workspace/requestReprocess", () => ({
      requestReprocess: (_c: unknown, id: string, deps: { newOperationId?: () => string }) => reprocess(id, deps),
      ReprocessRefusedError: class extends Error {},
    }));
    const { PeriodCurrencyCorrection } = await import("@/components/workspace/PeriodCurrencyCorrection");
    const onChanged = vi.fn(), onEngaged = vi.fn();
    const props = { periodId: P, uploadId: U, processingResult: mismatchResult("USD", ["TZS"]) as unknown, ensureFreshSession: async () => undefined, onChanged, onEngaged };
    mounted = mount(createElement(PeriodCurrencyCorrection, props));
    const rerender = (patch: Partial<typeof props>) => mounted!.rerender(createElement(PeriodCurrencyCorrection, { ...props, ...patch }));
    await flush();
    const q = (id: string) => mounted!.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    return { corrections, reprocess, ids, onChanged, onEngaged, rerender, q };
  }

  it("states both currencies, requires a reason, and three quick clicks make one correction with one request id", async () => {
    const s = await setup(async () => ({ outcome: "accepted" }));
    expect(s.q("currency-correction-offer")?.textContent).toMatch(/labelled TZS; the period reports in USD/);
    click(s.q("currency-correction-start")!);
    expect((s.q("currency-correction-confirm") as HTMLButtonElement).disabled).toBe(true);
    typeInto(s.q("currency-correction-reason") as HTMLTextAreaElement, "Ledger kept in TZS");
    const confirm = s.q("currency-correction-confirm")!;
    click(confirm); click(confirm); click(confirm);
    await until(() => !!s.q("currency-correction-done"));
    expect(s.corrections).toHaveLength(1);
    expect(s.corrections[0]).toMatchObject({ p_period_id: P, p_new_currency: "TZS", p_expected_currency: "USD", p_reason: "Ledger kept in TZS" });
    expect(s.ids).toEqual([OP]);
    expect(s.q("currency-correction-done")?.textContent).toMatch(/now reports in TZS/);
    expect(s.onChanged).toHaveBeenCalled();
    expect(s.onEngaged).toHaveBeenCalled();
    // The re-check replaces the refused result: the panel keeps showing its own outcome (the page keeps it mounted).
    await act(async () => { s.rerender({ processingResult: { ingestion: { currency: "TZS", issues: [] } } }); });
    await flush();
    expect(s.q("currency-correction-done")?.textContent).toMatch(/now reports in TZS/);
  });

  it("a re-check that does not start shows the saved currency and retries with the same deterministic id", async () => {
    let fail = true;
    const s = await setup(async () => { if (fail) throw new Error("offline"); return { outcome: "replayed" }; });
    click(s.q("currency-correction-start")!);
    typeInto(s.q("currency-correction-reason") as HTMLTextAreaElement, "Ledger kept in TZS");
    click(s.q("currency-correction-confirm")!);
    await until(() => !!s.q("currency-correction-recheck-failed"));
    expect(s.q("currency-correction-recheck-failed")?.textContent).toMatch(/now reports in TZS \(saved\)/);
    fail = false;
    click(s.q("currency-correction-recheck")!);
    await until(() => !!s.q("currency-correction-done"));
    expect(s.ids).toEqual([OP, OP]);
    expect(s.q("currency-correction-done")).not.toBeNull();
    expect(s.corrections).toHaveLength(1);
  });
});
