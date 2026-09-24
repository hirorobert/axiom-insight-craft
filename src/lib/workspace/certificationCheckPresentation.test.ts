/**
 * certificationCheckPresentation.test.ts — the certification card counts only the four REQUIRED layers and shows
 * layers 5–6 as neutral informational assessments. Classification is by structured layer; tone is by structured
 * severity; message text is never read as state. computeCertificationReadiness is not modified — its verdict,
 * blocker-driving fields and counts are asserted unchanged here.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  computeCertificationReadiness, type CertificationReadinessInput, type TbCertificationExceptionRecord, type TbCertificationRow,
} from "./computeCertificationReadiness";
import { computePreflight } from "./computePreflight";
import { certificationRowForDisplay, presentReadiness } from "./certificationCheckPresentation";
import { TrialBalancePreflight } from "@/components/workspace/TrialBalancePreflight";

type Sev = TbCertificationExceptionRecord["severity"];
const x = (layer: 1 | 2 | 3 | 4 | 5 | 6, severity: Sev | string | null | undefined, message = "detail"): TbCertificationExceptionRecord =>
  ({ code: `L${layer}_SIGNAL`, layer, severity: severity as Sev, accountCode: null, message });
const row = (exceptions: TbCertificationExceptionRecord[], over: Partial<TbCertificationRow> = {}): TbCertificationRow => ({
  id: "c1", sequence_no: 1, company_id: "co", upload_id: "u1", period_year: 2025, is_blocking: false, requires_review: false,
  exceptions, certified_at: "2026-09-24T00:00:00Z", ...over,
});
const input = (r: TbCertificationRow | null, authoritative = true): CertificationReadinessInput =>
  ({ uploadExists: true, currentUploadId: "u1", authoritative: authoritative ? r : null, latestForUpload: r });
const present = (inp: CertificationReadinessInput) => presentReadiness(computeCertificationReadiness(inp), "Checks passed", certificationRowForDisplay(inp));
const tones = (p: ReturnType<typeof present>) => [...p.required, ...p.informational].map((c) => `${c.id}:${c.tone}`);

// The typical certified upload: supporting evidence not reconciled, no prior-period certification. Both are
// informational (severity info) whatever their message says.
const TYPICAL = row([x(5, "info", "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload"), x(6, "info", "NO_PRIOR: no authoritative certification exists for period 2024")]);

describe("certificationRowForDisplay mirrors the row computeCertificationReadiness draws its layers from", () => {
  // Distinguishable rows: which one readiness used shows in its layer-2 state (authoritative → review, latest → failed).
  const A = row([x(2, "warning")], { id: "auth" });
  const L = row([x(2, "error")], { id: "latest", is_blocking: true });
  const layer2 = (inp: CertificationReadinessInput) => computeCertificationReadiness(inp).checks.find((c) => c.id === "l2_data_quality")?.state;
  it.each([
    ["authoritative for this upload", { ...input(L), authoritative: A }, "auth", "review"],
    ["authoritative for another upload → latest", { ...input(L), authoritative: { ...A, upload_id: "other" } }, "latest", "failed"],
    ["no authoritative → latest", input(L, false), "latest", "failed"],
    ["no row at all", input(null, false), null, "pending"],
    ["read failed", { ...input(L), authoritative: A, fetchFailed: true }, null, "pending"],
  ] as const)("%s", (_n, inp, id, state) => {
    expect(certificationRowForDisplay(inp as CertificationReadinessInput)?.id ?? null).toBe(id);
    expect(layer2(inp as CertificationReadinessInput)).toBe(state);
  });
  it("no upload → no row, no checks", () => {
    expect(certificationRowForDisplay({ ...input(L), uploadExists: false })).toBeNull();
    expect(computeCertificationReadiness({ ...input(L), uploadExists: false }).checks).toEqual([]);
  });
});

describe("required checks: layers 1–4 only, 'Required checks passed · 4/4'", () => {
  it("typical certified upload", () => {
    const r = computeCertificationReadiness(input(TYPICAL));
    expect([r.verdict, r.passedCount, r.totalCount]).toEqual(["certified", 6, 6]); // readiness itself unchanged
    const p = present(input(TYPICAL));
    expect(p.countLabel).toBe("Required checks passed · 4/4");
    expect(p.required.map((c) => c.id)).toEqual(["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]);
    expect(p.required.every((c) => c.tone === "passed")).toBe(true);
    expect(p.informational.map((c) => c.id)).toEqual(["l5_supporting_evidence", "l6_prior_period"]);
  });
  it("a failed required layer keeps its failure and is not counted", () => {
    const p = present(input(row([x(3, "error", "Out of balance")], { is_blocking: true }), false));
    expect(p.countLabel).toBe("Checks failed · 3/4");
    expect(p.required.find((c) => c.id === "l3_arithmetic")?.tone).toBe("failed");
  });
  it("an unknown severity on a required layer is never counted as passed", () => {
    const p = present(input(row([x(3, "bogus")])));
    expect(p.required.find((c) => c.id === "l3_arithmetic")?.tone).toBe("unavailable");
    expect(p.countLabel).toBe("Certified · 3/4 required");
  });
  it("no certification yet: 'Checking · 0/4', all pending", () => {
    const p = present(input(null, false));
    expect(p.countLabel).toBe("Checking · 0/4");
    expect(tones(p).every((t) => t.endsWith(":pending"))).toBe(true);
  });
  it("the legacy five-check projection (Statements) is unchanged", () => {
    const legacy = computePreflight(null);
    const p = presentReadiness(legacy, "Checking");
    expect([p.layered, p.informational.length, p.countLabel]).toEqual([false, 0, `Checking · ${legacy.passedCount}/${legacy.totalCount}`]);
  });
});

describe("informational assessments: layers 5–6, tone from structured severity only", () => {
  const informational = (entries: TbCertificationExceptionRecord[]) => present(input(row(entries))).informational;
  it.each([
    ["info", "informational"],
    ["warning", "review"],
    ["error", "failed"],
    ["bogus", "unavailable"],
    ["INFO", "unavailable"],
    [null, "unavailable"],
    [undefined, "unavailable"],
  ] as const)("severity %s → %s (both layers)", (sev, tone) => {
    expect(informational([x(5, sev), x(6, sev)]).map((c) => c.tone)).toEqual([tone, tone]);
  });
  it("mixed: error wins; info with an unknown severity fails closed; warning with info is a warning", () => {
    expect(informational([x(5, "info"), x(5, "error")])[0].tone).toBe("failed");
    expect(informational([x(5, "info"), x(5, "bogus")])[0].tone).toBe("unavailable");
    expect(informational([x(5, "info"), x(5, "warning")])[0].tone).toBe("review");
  });
  it("a row with nothing for the layer is unavailable; no row at all is pending; never passed", () => {
    expect(informational([]).map((c) => c.tone)).toEqual(["unavailable", "unavailable"]);
    expect(present(input(null, false)).informational.map((c) => c.tone)).toEqual(["pending", "pending"]);
  });
  it("without the row (not supplied), a layered readiness never draws an informational layer as passed", () => {
    const p = presentReadiness(computeCertificationReadiness(input(TYPICAL)), "Checks passed", null);
    expect(p.informational.every((c) => c.tone === "unavailable")).toBe(true);
  });
  it("no input of any severity ever yields a passed informational row", () => {
    for (const sev of ["info", "warning", "error", "bogus", null, undefined]) {
      for (const layer of [5, 6] as const) expect(informational([x(layer, sev)]).every((c) => c.tone !== "passed")).toBe(true);
    }
  });
  it("the existing detail text is shown as-is (not interpreted)", () => {
    const [l5] = informational([x(5, "info", "any producer wording at all")]);
    expect(l5.text).toBe("any producer wording at all");
  });
});

describe("message wording cannot change classification, tone, count, verdict or access", () => {
  const WORDINGS = ["NOT_EVALUATED: x", "NO_PRIOR: x", "PASSED: everything is fine", "error: failed", "", "✓ ok", "NO_DIFFERENCE", "certified", "blocked!!!"];
  const scenario = (m: string) => input(row([x(2, "info", m), x(3, "warning", m), x(5, "info", m), x(6, "warning", m)], { requires_review: true }), false);
  const baseline = present(scenario("baseline"));
  const baseReadiness = computeCertificationReadiness(scenario("baseline"));
  it.each(WORDINGS.map((w) => [w]))("%j", (w) => {
    const p = present(scenario(w));
    expect(tones(p)).toEqual(tones(baseline));
    expect(p.countLabel).toBe(baseline.countLabel);
    expect(p.informational.map((c) => c.id)).toEqual(["l5_supporting_evidence", "l6_prior_period"]);
    const r = computeCertificationReadiness(scenario(w));
    // Stage access is driven by the readiness verdict — unchanged by wording.
    expect([r.verdict, r.passedCount, r.totalCount]).toEqual([baseReadiness.verdict, baseReadiness.passedCount, baseReadiness.totalCount]);
  });
});

describe("TrialBalancePreflight renders it", () => {
  const inp = input(TYPICAL);
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TrialBalancePreflight, {
    upload: null, readiness: computeCertificationReadiness(inp), certificationRow: certificationRowForDisplay(inp),
  })));
  it("'Required checks passed · 4/4', never 6/6", () => {
    expect(html).toContain("Required checks passed · 4/4");
    expect(html).not.toMatch(/6\/6/);
  });
  it("informational rows are neutral (no success glyph) and labelled as not counted", () => {
    expect(html).toContain("Informational assessments · not counted");
    for (const id of ["l5_supporting_evidence", "l6_prior_period"]) {
      const li = new RegExp(`<li data-testid="tb-check-${id}" data-tone="informational"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";
      expect(li).not.toBe("");
      expect(li).not.toMatch(/lucide-check\b|text-success/);
    }
  });
  it("the four required rows keep their success treatment", () => {
    for (const id of ["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]) {
      expect(html).toMatch(new RegExp(`<li data-testid="tb-check-${id}" data-tone="passed"`));
    }
  });
});
