/**
 * The layout-assist evaluation harness (scripts/ai/layoutAssistEval.ts): it measures a provider through the production
 * pipeline and refuses to run without the owner's thresholds. Proven with an oracle provider (perfect), a careless one
 * (wrong number format) and one that suggests a layout where none is expected.
 */
import { describe, expect, it } from "vitest";
import { evaluateLayoutAssist, type EvalCase, type EvalThresholds } from "../../../scripts/ai/layoutAssistEval";
import type { LayoutAssistProvider } from "../../../supabase/functions/_shared/layoutAssist";

const enc = (s: string) => new TextEncoder().encode(s);
const PROFILE = (debit: string, credit: string, fmt: "dot_comma" | "comma_dot") => ({
  format: "layout-template/1" as const, sheet: { kind: "csv" as const }, headerRow: 1, numberFormat: fmt, balanceSign: null,
  columns: { accountCode: "Kontonummer", accountName: "Kontobezeichnung", debit, credit, balance: null, dimensions: [] },
});
const CORPUS: EvalCase[] = [
  { id: "german", fileName: "a.csv", currency: "EUR", periodYear: 2025, bytes: enc('Kontonummer;Kontobezeichnung;Soll;Haben\n1000;Bank;"1.500,25";\n3000;Kapital;;"1.500,25"\n'), expected: PROFILE("Soll", "Haben", "dot_comma") },
  { id: "custom-en", fileName: "b.csv", currency: "USD", periodYear: 2025, bytes: enc('Kontonummer,Kontobezeichnung,Sum1,Sum2\n1000,Bank,"1,500.25",\n3000,Capital,,"1,500.25"\n'), expected: PROFILE("Sum1", "Sum2", "comma_dot") },
  // Not a trial balance: the right answer is no fitting layout.
  { id: "not-a-tb", fileName: "c.csv", currency: "USD", periodYear: 2025, bytes: enc("Kontonummer,Kontobezeichnung,Note\nx,y,z\n"), expected: null },
];
const T: EvalThresholds = { exactTemplateAccuracy: 0.9, fieldAccuracy: 0.95, fitAccuracy: 0.9, refusalCorrectness: 1, latencyP95Ms: 5000, meanCostMicros: 2000 };
const prov = (f: (sample: unknown) => unknown, cost: number | null = 1000): LayoutAssistProvider =>
  ({ id: "eval", model: "m", promptVersion: "p", propose: async (s) => ({ proposal: f(s), costMicros: cost }) });
// An oracle that knows the corpus by its sample shape (number pattern in the first data row).
const oracle = prov((s) => {
  const json = JSON.stringify(s);
  if (json.includes("head:note")) return { format: "layout-proposal/1", sheetIndex: 0, headerRow: 9, columns: {}, numberFormat: "comma_dot", balanceSign: null };
  const fmt = json.includes("num:9.999,99") ? "dot_comma" : "comma_dot";
  return { format: "layout-proposal/1", sheetIndex: 0, headerRow: 1, columns: { accountCode: 0, accountName: 1, debit: 2, credit: 3, balance: null, dimensions: [] }, numberFormat: fmt, balanceSign: null };
});

describe("layout-assist evaluation harness", () => {
  it("requires every owner threshold (no defaults) and a corpus", async () => {
    await expect(evaluateLayoutAssist(oracle, CORPUS, { ...T, refusalCorrectness: undefined } as never)).rejects.toThrow(/refusalCorrectness is required/);
    await expect(evaluateLayoutAssist(oracle, [], T)).rejects.toThrow(/corpus is empty/);
  });
  it("an accurate provider passes, measured through the production pipeline (whole-file validation included)", async () => {
    const r = await evaluateLayoutAssist(oracle, CORPUS, T);
    expect(r.metrics).toMatchObject({ exactTemplateAccuracy: 1, fieldAccuracy: 1, fitAccuracy: 1, refusalCorrectness: 1, meanCostMicros: 1000 });
    expect(r.passed).toBe(true);
    expect(r.cases.find((c) => c.id === "not-a-tb")!.outcome).toBe("SUGGESTION_UNUSABLE");
  });
  it("a careless provider (wrong number format) fails on exactness and fit, with the reasons", async () => {
    const careless = prov(() => ({ format: "layout-proposal/1", sheetIndex: 0, headerRow: 1, columns: { accountCode: 0, accountName: 1, debit: 2, credit: 3, balance: null, dimensions: [] }, numberFormat: "plain_dot", balanceSign: null }));
    const r = await evaluateLayoutAssist(careless, CORPUS, T);
    expect(r.passed).toBe(false);
    expect(r.metrics.exactTemplateAccuracy).toBe(0);
    expect(r.failures.join(" ")).toMatch(/exactTemplateAccuracy/);
  });
  it("a provider that reports no cost is counted at the cost threshold, never as free", async () => {
    const r = await evaluateLayoutAssist(prov(() => ({}), null), CORPUS, T);
    expect(r.metrics.meanCostMicros).toBe(T.meanCostMicros);
  });
});
