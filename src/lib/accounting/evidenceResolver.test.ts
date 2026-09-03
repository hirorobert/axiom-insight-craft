/**
 * evidenceResolver.test.ts — Ω∞ Phase 3, Tier 2 evidence resolver.
 *
 * Behavioral tests against the real, certified rule pack
 * (TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1) -- not synthetic fixtures -- plus
 * type-level checks for the dimension-safe contract the resolver returns.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { resolveEvidence, type ResolverInput } from "./evidenceResolver";
import type {
  AccountNatureResolution,
  FsPresentationResolution,
  SourceClassificationResolution,
  TaxonomyConceptResolution,
} from "./evidenceResolverTypes";

// ── Real, verified rule-pack fixtures (museIpsasRulePack.ts) ────────────────
// Chosen to cover all five MuseAccountNature values with HIGH confidence.

const BASE: Omit<ResolverInput, "naturalAccountCode" | "accountName" | "balance"> = {
  accountId: "acct-1",
  companyId: "company-1",
  periodYear: 2026,
  entityClass: "LOCAL_GOVERNMENT",
  reportingFramework: "IPSAS_ACCRUAL",
  sourceSystem: "MUSE",
};

const EXPENSE_INPUT: ResolverInput = {
  ...BASE,
  naturalAccountCode: "21111101", // Civil Servants -> EXPENSE, EMPLOYEE_COSTS, HIGH, AUTO_MAPPED_RULE
  accountName: "Civil Servants",
  balance: 58582200999.32,
};

const ASSET_INPUT: ResolverInput = {
  ...BASE,
  naturalAccountCode: "31112102", // Office buildings -> ASSET, PROPERTY_PLANT_EQUIPMENT_ADDITIONS, HIGH
  accountName: "Office buildings and structures Monetary",
  balance: 1000,
};

const LIABILITY_INPUT: ResolverInput = {
  ...BASE,
  naturalAccountCode: "33111113", // Revolving Fund -WYPD -> LIABILITY, PAYABLES_AND_ACCRUALS, HIGH
  accountName: "Revolving Fund -WYPD",
  balance: -500,
};

const NET_ASSETS_INPUT: ResolverInput = {
  ...BASE,
  naturalAccountCode: "63293101", // Accumulated Surplus/Deficit Opening -> NET_ASSETS, HIGH
  accountName: "Accumulated Surplus/Deficit Opening",
  balance: -900,
};

const REVENUE_INPUT: ResolverInput = {
  ...BASE,
  naturalAccountCode: "14150101", // Revenue from Land -> REVENUE, LOW, REVIEW_SUGGESTED
  accountName: "Revenue from Land",
  balance: 2612625,
};

const UNSEEN_CODE_NONZERO: ResolverInput = {
  ...BASE,
  naturalAccountCode: "99999999",
  accountName: "Never seen in Arusha data",
  balance: 12345.67,
};

const UNSEEN_CODE_ZERO: ResolverInput = {
  ...BASE,
  naturalAccountCode: "99999999",
  accountName: "Never seen in Arusha data",
  balance: 0,
};

// ── [A]/[B]/[C]/[D] a real Tier 2 exact-code match resolves 3 dimensions, ──
// ── leaves taxonomyConcept unresolved ───────────────────────────────────────

describe("[A] sourceClassification resolves at Tier 2 on a real exact-code match", () => {
  it("winningProposal carries the natural account code itself, tier 2", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is SourceClassificationResolution => r.dimension === "sourceClassification",
    );
    expect(resolution?.winningProposal?.proposal).toBe("21111101");
    expect(resolution?.winningProposal?.tier).toBe(2);
    expect(resolution?.winningProposal?.evidenceSource).toBe("SOURCE_SYSTEM_SIGNATURE");
  });
});

describe("[B] accountNature resolves at Tier 2 through the explicit adapter", () => {
  it("EXPENSE (MUSE/IPSAS) translates to expense (generic)", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("expense");
    expect(resolution?.winningProposal?.tier).toBe(2);
  });
});

describe("[C] fsPresentation resolves at Tier 2 from the IPSAS presentation code", () => {
  it("statementSection carries the presentationCode label, mappingMethod EXACT_CODE, no taxonomy profile", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is FsPresentationResolution => r.dimension === "fsPresentation",
    );
    expect(resolution?.winningProposal?.statementSection).toBe("EMPLOYEE_COSTS");
    expect(resolution?.winningProposal?.mappingMethod).toBe("EXACT_CODE");
    expect(resolution?.winningProposal?.taxonomyProfile).toBeNull();
    expect(resolution?.winningProposal?.tier).toBe(2);
  });
});

describe("[D] taxonomyConcept remains unresolved on a Tier 2 match -- never fabricated", () => {
  it("taxonomyConcept resolution has no winning proposal and appears in unresolvedDimensions", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is TaxonomyConceptResolution => r.dimension === "taxonomyConcept",
    );
    expect(resolution?.winningProposal).toBeNull();
    expect(output.unresolvedDimensions).toContain("taxonomyConcept");
  });
});

// ── [E]/[F]/[G] the framework/sourceSystem gate cannot be bypassed ──────────

describe("[E] reportingFramework !== IPSAS_ACCRUAL -- Tier 2 is never evaluated", () => {
  it("a real, otherwise-matching code produces zero resolution when framework is wrong", () => {
    const output = resolveEvidence({ ...EXPENSE_INPUT, reportingFramework: "IFRS_FOR_SMES" });
    expect(output.dimensionResolutions.every((r) => r.winningProposal === null)).toBe(true);
    expect(output.evidenceObservations).toHaveLength(0);
    expect(output.unresolvedDimensions).toHaveLength(4);
  });
});

describe("[F] sourceSystem !== MUSE -- Tier 2 is never evaluated", () => {
  it("a real, otherwise-matching code produces zero resolution when sourceSystem is wrong", () => {
    const output = resolveEvidence({ ...EXPENSE_INPUT, sourceSystem: "QUICKBOOKS" });
    expect(output.dimensionResolutions.every((r) => r.winningProposal === null)).toBe(true);
    expect(output.evidenceObservations).toHaveLength(0);
    expect(output.unresolvedDimensions).toHaveLength(4);
  });
});

describe("[G] a matching code alone cannot bypass the framework/source gate", () => {
  it("code '21111101' genuinely matches a rule (control case) yet still resolves nothing under a wrong framework AND a wrong sourceSystem simultaneously", () => {
    const controlOutput = resolveEvidence(EXPENSE_INPUT);
    expect(controlOutput.dimensionResolutions.some((r) => r.winningProposal !== null)).toBe(true);

    const gatedOutput = resolveEvidence({
      ...EXPENSE_INPUT,
      reportingFramework: "UNKNOWN",
      sourceSystem: "UNKNOWN",
    });
    expect(gatedOutput.dimensionResolutions.every((r) => r.winningProposal === null)).toBe(true);
  });
});

// ── [H] explicit exhaustive AccountNature translation, all five values ─────

describe("[H] explicit AccountNature translation covers all five MUSE/IPSAS values", () => {
  it("ASSET -> asset", () => {
    const output = resolveEvidence(ASSET_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("asset");
  });

  it("LIABILITY -> liability", () => {
    const output = resolveEvidence(LIABILITY_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("liability");
  });

  it("NET_ASSETS -> equity", () => {
    const output = resolveEvidence(NET_ASSETS_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("equity");
  });

  it("REVENUE -> income", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("income");
    // 14150101 is deliberately LOW confidence (REVIEW_SUGGESTED) in the rule
    // pack -- confirms the translation itself is independent of confidence tier.
    expect(resolution?.requiresReview).toBe(true);
  });

  it("EXPENSE -> expense", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    expect(resolution?.winningProposal?.proposal).toBe("expense");
  });
});

// ── [I] Tier 1 is never produced ─────────────────────────────────────────────

describe("[I] no Tier 1 proposal or observation can be produced", () => {
  it("no resolution's winning proposal ever carries tier 1, across every fixture", () => {
    const outputs = [
      resolveEvidence(EXPENSE_INPUT),
      resolveEvidence(ASSET_INPUT),
      resolveEvidence(LIABILITY_INPUT),
      resolveEvidence(NET_ASSETS_INPUT),
      resolveEvidence(REVENUE_INPUT),
      resolveEvidence(UNSEEN_CODE_NONZERO),
      resolveEvidence(UNSEEN_CODE_ZERO),
    ];
    for (const output of outputs) {
      for (const resolution of output.dimensionResolutions) {
        expect(resolution.winningProposal?.tier).not.toBe(1);
      }
      for (const observation of output.evidenceObservations) {
        expect(observation.tier).not.toBe(1);
      }
    }
  });
});

// ── [J] no taxonomy concept is ever fabricated ───────────────────────────────

describe("[J] no taxonomyConcept proposal is ever fabricated by this resolver", () => {
  it("taxonomyConcept never resolves, across every real and synthetic fixture", () => {
    const outputs = [
      resolveEvidence(EXPENSE_INPUT),
      resolveEvidence(ASSET_INPUT),
      resolveEvidence(LIABILITY_INPUT),
      resolveEvidence(NET_ASSETS_INPUT),
      resolveEvidence(REVENUE_INPUT),
      resolveEvidence(UNSEEN_CODE_NONZERO),
    ];
    for (const output of outputs) {
      const taxonomyResolution = output.dimensionResolutions.find(
        (r) => r.dimension === "taxonomyConcept",
      );
      expect(taxonomyResolution?.winningProposal).toBeNull();
    }
  });
});

// ── [K]/[L] Tier 2 miss -- Tier 7 may survive as observation only ──────────

describe("[K] exact-code miss with a non-zero balance: Tier 7 observation may survive, resolves nothing", () => {
  it("evidenceObservations may carry a tier-7 balance-side observation, but no dimension resolves", () => {
    const output = resolveEvidence(UNSEEN_CODE_NONZERO);
    expect(output.dimensionResolutions.every((r) => r.winningProposal === null)).toBe(true);

    const tier7 = output.evidenceObservations.find((o) => o.tier === 7);
    expect(tier7).toBeDefined();
    expect(tier7?.informsDimensions).toHaveLength(0);
    if (tier7 && "balanceSide" in tier7) {
      expect(tier7.balanceSide).toBe("DEBIT"); // 12345.67 is positive
    }
  });
});

describe("[L] exact-code miss with a zero balance: no fabricated Tier 7 evidence, no resolution", () => {
  it("no evidenceObservations at all, all dimensions unresolved", () => {
    const output = resolveEvidence(UNSEEN_CODE_ZERO);
    expect(output.evidenceObservations).toHaveLength(0);
    expect(output.dimensionResolutions.every((r) => r.winningProposal === null)).toBe(true);
    expect(output.unresolvedDimensions).toHaveLength(4);
  });
});

// ── [M]/[N] deterministic, no timestamps/random ids ─────────────────────────

describe("[M] deterministic: the same input twice produces a deep-equal semantic output", () => {
  it("two independent calls with the same real match produce identical output", () => {
    const first = resolveEvidence(EXPENSE_INPUT);
    const second = resolveEvidence(EXPENSE_INPUT);
    expect(first).toEqual(second);
  });

  it("two independent calls on a miss also produce identical output", () => {
    const first = resolveEvidence(UNSEEN_CODE_NONZERO);
    const second = resolveEvidence(UNSEEN_CODE_NONZERO);
    expect(first).toEqual(second);
  });
});

describe("[N] no timestamps or random ids anywhere in the module or its output", () => {
  it("MachineEvidenceResolverOutput has no resolvedAt/createdAt field (compile-time)", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    // @ts-expect-error -- resolvedAt does not exist on MachineEvidenceResolverOutput
    expect(output.resolvedAt).toBeUndefined();
    // @ts-expect-error -- createdAt does not exist on MachineEvidenceResolverOutput
    expect(output.createdAt).toBeUndefined();
  });

  it("the module source contains no Date.now()/new Date()/randomUUID calls", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(path.join(__dirname, "evidenceResolver.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/Date\.now\(\)|new Date\(|randomUUID/);
  });
});

// ── [O]/[P]/[Q] no professional-authority, DB, or activation dependency ────

describe("[O]/[P]/[Q] no professional-authority, Supabase/DB, or controlledActivation dependency", () => {
  it("the module source imports none of those", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(path.join(__dirname, "evidenceResolver.ts"), "utf-8");
    // Strip comments -- this file's own doc comments legitimately name these
    // concepts while explaining they are NOT imported; only executable code
    // (import statements, calls) must be checked.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/supabase|account_review_decisions|account_mappings|account_mapping_memory/i);
    expect(codeOnly).not.toMatch(/controlledActivation/);
  });
});

// ── [R] unresolvedDimensions correctly reflects unresolved dimensions ──────

describe("[R] unresolvedDimensions correctly reflects unresolved dimensions in every case", () => {
  it("a Tier 2 match: exactly taxonomyConcept is unresolved", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    expect(output.unresolvedDimensions).toEqual(["taxonomyConcept"]);
  });

  it("a Tier 2 miss (gate eligible, no code match): all four dimensions unresolved", () => {
    const output = resolveEvidence(UNSEEN_CODE_NONZERO);
    expect(output.unresolvedDimensions.sort()).toEqual(
      ["accountNature", "fsPresentation", "sourceClassification", "taxonomyConcept"].sort(),
    );
  });

  it("gate-ineligible: all four dimensions unresolved", () => {
    const output = resolveEvidence({ ...EXPENSE_INPUT, sourceSystem: "EXCEL" });
    expect(output.unresolvedDimensions.sort()).toEqual(
      ["accountNature", "fsPresentation", "sourceClassification", "taxonomyConcept"].sort(),
    );
  });
});

// ── [8] HIGH-confidence review policy is frozen by a direct test ───────────

describe("[8] HIGH-confidence Tier2 match: the certified review policy is locked", () => {
  it("21111101 (real, HIGH confidence): review flags and unresolvedDimensions match the frozen policy exactly", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    const byDimension = Object.fromEntries(
      output.dimensionResolutions.map((r) => [r.dimension, r.requiresReview]),
    );
    expect(byDimension.sourceClassification).toBe(false);
    expect(byDimension.accountNature).toBe(false);
    expect(byDimension.fsPresentation).toBe(false);
    expect(byDimension.taxonomyConcept).toBe(true);
    expect(output.unresolvedDimensions).toEqual(["taxonomyConcept"]);
    expect(output.requiresReviewOverall).toBe(true);
  });
});

// ── [9] LOW/LEXICAL real-rule regression: source identity vs classification ─

describe("[9] real LOW/LEXICAL rule (14150101, Revenue from Land): source identity and classification evidence stay separated", () => {
  it("[9A] sourceClassification.evidenceSource is SOURCE_SYSTEM_SIGNATURE, not the rule's LEXICAL_SIGNAL", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is SourceClassificationResolution => r.dimension === "sourceClassification",
    );
    expect(resolution?.winningProposal?.evidenceSource).toBe("SOURCE_SYSTEM_SIGNATURE");
  });

  it("[9B] sourceClassification is not mislabeled as LEXICAL_SIGNAL anywhere (proposal, resolution, or provenance)", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const resolution = output.dimensionResolutions.find(
      (r): r is SourceClassificationResolution => r.dimension === "sourceClassification",
    );
    expect(resolution?.winningProposal?.evidenceSource).not.toBe("LEXICAL_SIGNAL");
    expect(
      resolution?.winningProposal?.provenance.some((e) => e.source === "LEXICAL_SIGNAL"),
    ).toBe(false);
  });

  it("[9C] accountNature and fsPresentation still preserve the rule's real LEXICAL_SIGNAL classification evidence", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const natureResolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    const presentationResolution = output.dimensionResolutions.find(
      (r): r is FsPresentationResolution => r.dimension === "fsPresentation",
    );
    expect(natureResolution?.winningProposal?.evidenceSource).toBe("LEXICAL_SIGNAL");
    expect(presentationResolution?.winningProposal?.evidenceSource).toBe("LEXICAL_SIGNAL");
    expect(natureResolution?.winningProposal?.proposal).toBe("income"); // REVENUE -> income, adapter unaffected
  });

  it("[9D] accountNature and fsPresentation remain requiresReview:true because the real rule is REVIEW_SUGGESTED", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const natureResolution = output.dimensionResolutions.find(
      (r) => r.dimension === "accountNature",
    );
    const presentationResolution = output.dimensionResolutions.find(
      (r) => r.dimension === "fsPresentation",
    );
    expect(natureResolution?.requiresReview).toBe(true);
    expect(presentationResolution?.requiresReview).toBe(true);
  });

  it("[9E] source identity certainty does not upgrade accounting classification confidence", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    const sourceResolution = output.dimensionResolutions.find(
      (r): r is SourceClassificationResolution => r.dimension === "sourceClassification",
    );
    const natureResolution = output.dimensionResolutions.find(
      (r): r is AccountNatureResolution => r.dimension === "accountNature",
    );
    // Source identity is HIGH/deterministic...
    expect(sourceResolution?.winningProposal?.strength.classificationConfidence).toBe("HIGH");
    expect(sourceResolution?.winningProposal?.requiresReview).toBe(false);
    // ...but that HIGH certainty never leaks into the LOW-confidence
    // classification dimension -- the real rule's LOW confidence survives untouched.
    expect(natureResolution?.winningProposal?.strength.classificationConfidence).toBe("LOW");
    expect(natureResolution?.requiresReview).toBe(true);
  });
});

// ── [10] two observations, correctly scoped informsDimensions ──────────────

describe("[10] Tier2 match emits two evidence observations, correctly scoped", () => {
  it("a source-identity observation informing exactly sourceClassification, and a classification observation informing only supported accounting dimensions", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    expect(output.evidenceObservations).toHaveLength(2);

    const sourceIdentityObservation = output.evidenceObservations.find(
      (o) => o.evidenceSource === "SOURCE_SYSTEM_SIGNATURE" && o.tier === 2,
    );
    expect(sourceIdentityObservation?.informsDimensions).toEqual(["sourceClassification"]);

    const classificationObservation = output.evidenceObservations.find(
      (o) => o !== sourceIdentityObservation,
    );
    expect(classificationObservation?.informsDimensions.sort()).toEqual(
      ["accountNature", "fsPresentation"].sort(),
    );
    expect(classificationObservation?.informsDimensions).not.toContain("taxonomyConcept");
    expect(classificationObservation?.informsDimensions).not.toContain("sourceClassification");
  });

  it("no observation of either kind ever carries tier 1", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    for (const observation of output.evidenceObservations) {
      expect(observation.tier).not.toBe(1);
    }
  });

  it("the LOW/LEXICAL real rule (14150101) also emits exactly two correctly-scoped observations", () => {
    const output = resolveEvidence(REVENUE_INPUT);
    expect(output.evidenceObservations).toHaveLength(2);
    const sourceIdentityObservation = output.evidenceObservations.find(
      (o) => o.evidenceSource === "SOURCE_SYSTEM_SIGNATURE",
    );
    const classificationObservation = output.evidenceObservations.find(
      (o) => o.evidenceSource === "LEXICAL_SIGNAL",
    );
    expect(sourceIdentityObservation?.informsDimensions).toEqual(["sourceClassification"]);
    expect(classificationObservation?.informsDimensions.sort()).toEqual(
      ["accountNature", "fsPresentation"].sort(),
    );
  });
});

// ── Type-level: the resolver's output stays dimension-safe ─────────────────

describe("resolveEvidence's output is dimension-safe by construction", () => {
  it("dimensionResolutions is typed as the certified DimensionResolution union, not a loose shape", () => {
    const output = resolveEvidence(EXPENSE_INPUT);
    expectTypeOf(output.dimensionResolutions).toEqualTypeOf<
      import("./evidenceResolverTypes").DimensionResolution[]
    >();
  });
});
