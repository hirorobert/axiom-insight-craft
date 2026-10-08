/**
 * The IFRS for SMEs pack: both editions pinned, citations traceable to their verified sources, the edition decided by the
 * period start (never a default), and a coverage matrix whose every claim names real code — with nothing VALIDATED until
 * an independent reviewer's golden fixture exists.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025, IFRS_FOR_SMES_PACKS, SOURCES } from "./ifrsForSmes";
import { resolveIfrsForSmesEdition } from "./editionPolicy";
import { IFRS_FOR_SMES_COVERAGE, renderCoverageMatrix } from "./coverage";

const ROOT = path.resolve(__dirname, "../../..");

describe("IFRS for SMEs packs: structure and citations", () => {
  for (const pack of IFRS_FOR_SMES_PACKS) {
    it(`${pack.id}: unique ids; every line presents a real requirement; every citation names a known source`, () => {
      const ids = pack.requirements.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      const lineIds = pack.lines.map((l) => l.id);
      expect(new Set(lineIds).size).toBe(lineIds.length);
      for (const l of pack.lines) expect(ids, l.id).toContain(l.requirementId);
      for (const r of pack.requirements) {
        expect(r.citations.length, r.id).toBeGreaterThan(0);
        for (const c of r.citations) {
          const src = SOURCES[c.source];
          expect(src, `${r.id} ${c.source}`).toBeDefined();
          // A PRIMARY_TEXT citation must name a source whose exact bytes are pinned.
          if (c.verification === "PRIMARY_TEXT") expect([src.sha256?.length, (src.bytes ?? 0) > 0], r.id).toEqual([64, true]);
        }
        if (r.applicability === "CONDITIONAL") expect(r.condition, r.id).toBeTruthy();
      }
    });
  }
  it("schedules: each satisfies a SCHEDULE requirement, reconciles real pack lines, and lists each movement kind once (both editions identical)", () => {
    for (const pack of IFRS_FOR_SMES_PACKS) {
      const lineIds = new Set(pack.lines.map((l) => l.id));
      for (const sch of pack.schedules) {
        expect(pack.requirements.find((r) => r.id === sch.requirementId)?.kind, sch.id).toBe("SCHEDULE");
        for (const l of sch.lineIds) expect(lineIds.has(l), `${sch.id} ${l}`).toBe(true);
        expect(new Set(sch.movements.map((m) => m.kind)).size, sch.id).toBe(sch.movements.length);
        expect(sch.priorPeriodRequired, sch.id).toBe(false);
      }
      expect(pack.requirements.filter((r) => r.kind === "SCHEDULE").map((r) => r.id).sort()).toEqual(pack.schedules.map((s) => s.requirementId).sort());
    }
    expect(JSON.stringify(IFRS_FOR_SMES_2025.schedules)).toBe(JSON.stringify(IFRS_FOR_SMES_2015.schedules));
    // Paragraphs read in both editions' text (2015 from pinned bytes): 17.31(e), 16.10(e), 18.27(e), 21.14(a).
    const cite = (id: string) => IFRS_FOR_SMES_2015.requirements.find((r) => r.id === id)!.citations[0];
    expect(["smes.schedule.ppe", "smes.schedule.investment_property_cost", "smes.schedule.investment_property_fair_value", "smes.schedule.intangibles", "smes.schedule.provisions"].map((id) => [cite(id).paragraph, cite(id).verification]))
      .toEqual([["17.31(e)", "PRIMARY_TEXT"], ["17.31(e)", "PRIMARY_TEXT"], ["16.10(e)", "PRIMARY_TEXT"], ["18.27(e)", "PRIMARY_TEXT"], ["21.14(a)", "PRIMARY_TEXT"]]);
    // PPE movements in the 17.31(e) order (i)–(viii).
    expect(IFRS_FOR_SMES_2015.schedules[0].movements.map((m) => m.kind)).toEqual(["additions", "disposals", "business_combinations", "revaluations_and_oci_impairment",
      "transfers_investment_property", "impairment_profit_or_loss", "depreciation", "other"]);
  });
  it("both editions carry exactly the same requirement ids (an edition changes citations and wording, not meaning)", () => {
    expect(IFRS_FOR_SMES_2025.requirements.map((r) => r.id)).toEqual(IFRS_FOR_SMES_2015.requirements.map((r) => r.id));
  });
  it("pins each edition's effective date and the wording that differs between them (independent expectations)", () => {
    expect(IFRS_FOR_SMES_2015.edition.effectiveForPeriodsBeginningOnOrAfter).toBe("2017-01-01");
    expect(IFRS_FOR_SMES_2025.edition.effectiveForPeriodsBeginningOnOrAfter).toBe("2027-01-01");
    const req = (p: typeof IFRS_FOR_SMES_2015, id: string) => p.requirements.find((r) => r.id === id)!;
    expect(req(IFRS_FOR_SMES_2015, "smes.note.policies").label).toMatch(/^Summary of significant accounting policies/);
    expect(req(IFRS_FOR_SMES_2025, "smes.note.policies").label).toMatch(/^Material accounting policy information$/);
    // The complete set: (a) SFP, (b) SCI, (c) SOCIE, (d) SCF, (e) notes — in both editions' text.
    for (const p of IFRS_FOR_SMES_PACKS) {
      expect(["smes.set.sfp", "smes.set.sci", "smes.set.socie", "smes.set.scf", "smes.set.notes"].map((id) => req(p, id).citations[0].paragraph))
        .toEqual(["3.17(a)", "3.17(b)", "3.17(c)", "3.17(d)", "3.17(e)"]);
    }
    // 4.2 has nineteen lettered items, (ea) included; 5.5 has nine.
    for (const p of IFRS_FOR_SMES_PACKS) {
      expect(p.requirements.filter((r) => r.id.startsWith("smes.sfp.4_2_")).map((r) => r.citations[0].paragraph))
        .toEqual(["a", "b", "c", "d", "e", "ea", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r"].map((l) => `4.2(${l})`));
      expect(p.requirements.filter((r) => r.id.startsWith("smes.sci.5_5_")).length).toBe(9);
    }
    // Early-application disclosure: verified in the 2015 text (A1); for the third edition only a secondary source states it.
    expect(req(IFRS_FOR_SMES_2015, "smes.note.early_application").citations).toEqual([{ source: "smes-2015-text", paragraph: "A1", verification: "PRIMARY_TEXT" }]);
    expect(req(IFRS_FOR_SMES_2025, "smes.note.early_application").citations[0].verification).toBe("SECONDARY");
  });
});

describe("edition policy: the period START decides; nothing defaults", () => {
  const CONFIRMED = { edition: "2025" as const, jurisdictionConfirmation: "Regulator circular ref. X/2026" };
  // Expected outcomes written by hand from the effective dates above — not derived from the implementation.
  const TABLE: [string | null, typeof CONFIRMED | null, string][] = [
    [null, null, "refused:PERIOD_START_UNKNOWN"],
    ["", null, "refused:PERIOD_START_UNKNOWN"],
    ["2026-02-30", null, "refused:PERIOD_START_UNKNOWN"],
    ["01/01/2026", null, "refused:PERIOD_START_UNKNOWN"],
    ["2016-12-31", null, "refused:EDITION_UNSUPPORTED"],
    ["2016-07-01", CONFIRMED, "refused:EDITION_UNSUPPORTED"],
    ["2017-01-01", null, "ifrs-for-smes/2015"],
    ["2025-07-01", null, "ifrs-for-smes/2015"],
    ["2026-12-31", null, "ifrs-for-smes/2015"],
    ["2026-01-01", CONFIRMED, "ifrs-for-smes/2025+early"],
    ["2026-01-01", { edition: "2025", jurisdictionConfirmation: " " }, "refused:EARLY_APPLICATION_UNCONFIRMED"],
    ["2027-01-01", null, "ifrs-for-smes/2025"],
    ["2027-01-01", CONFIRMED, "ifrs-for-smes/2025"],
    ["2031-04-01", null, "ifrs-for-smes/2025"],
  ];
  for (const [start, election, expected] of TABLE) {
    it(`${JSON.stringify(start)}${election ? " + election" : ""} → ${expected}`, () => {
      const d = resolveIfrsForSmesEdition(start, election);
      const got = d.state === "refused" ? `refused:${d.reason}` : `${d.pack.id}${d.earlyApplication ? "+early" : ""}`;
      expect(got).toBe(expected);
    });
  }
});

describe("coverage matrix: every claim names real code; nothing is VALIDATED without an independent reviewer", () => {
  it("every requirement has exactly one entry, and every entry a requirement", () => {
    expect(Object.keys(IFRS_FOR_SMES_COVERAGE).sort()).toEqual(IFRS_FOR_SMES_2015.requirements.map((r) => r.id).sort());
  });
  it("each IMPLEMENTED/VALIDATED entry names files that exist and symbols they export (or SQL literals they contain); MISSING names none", () => {
    for (const [id, e] of Object.entries(IFRS_FOR_SMES_COVERAGE)) {
      if (e.status === "MISSING") { expect(e.implementedBy ?? [], id).toEqual([]); continue; }
      expect((e.implementedBy ?? []).length, id).toBeGreaterThan(0);
      for (const ref of e.implementedBy!) {
        const file = path.join(ROOT, ref.file);
        expect(fs.existsSync(file), `${id}: ${ref.file}`).toBe(true);
        const text = fs.readFileSync(file, "utf8");
        if (ref.file.endsWith(".sql")) expect(text, `${id}: ${ref.symbol}`).toContain(ref.symbol);
        else expect(text, `${id}: ${ref.symbol}`).toMatch(new RegExp(`export (async )?(function|const|class|type|interface) ${ref.symbol}\\b`));
      }
      if (e.status === "VALIDATED") expect(e.validation, id).toMatchObject({ fixture: expect.any(String), reviewer: expect.any(String), signedOff: expect.any(String) });
    }
  });
  it("no requirement is VALIDATED today (no independent golden fixture exists); changing this is a deliberate, reviewed edit", () => {
    expect(Object.values(IFRS_FOR_SMES_COVERAGE).filter((e) => e.status === "VALIDATED")).toEqual([]);
  });
  it("docs/reporting/COVERAGE_IFRS_FOR_SMES.md is exactly the rendered matrix", () => {
    expect(fs.readFileSync(path.join(ROOT, "docs/reporting/COVERAGE_IFRS_FOR_SMES.md"), "utf8")).toBe(renderCoverageMatrix(IFRS_FOR_SMES_PACKS, IFRS_FOR_SMES_COVERAGE));
  });
});

describe("no compliance claim in reporting product code", () => {
  const DIRS = ["src/lib/frameworkPacks", "src/lib/statements", "src/lib/notes", "src/lib/comparatives", "src/lib/exports", "src/lib/financialStatementsWorkspace", "src/lib/financialGeneration", "src/lib/canonicalStatement",
    "src/lib/closeReview", "src/lib/workbench", "src/components/financialStatements", "src/components/closeReview", "src/components/workbench"];
  const CLAIM = /fully compliant|full compliance|complete (IFRS|IPSAS) compliance|compl(ies|iant) (fully )?with (the )?(IFRS|IPSAS)|(IFRS|IPSAS)[- ]compliant|guaranteed? compliance/i;
  it("no source file (tests excluded) asserts framework compliance", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(path.join(ROOT, d))) return;
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && CLAIM.test(fs.readFileSync(path.join(ROOT, rel), "utf8"))) hits.push(rel);
      }
    };
    DIRS.forEach(walk);
    expect(hits).toEqual([]);
  });
});
