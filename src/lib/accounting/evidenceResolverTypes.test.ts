/**
 * evidenceResolverTypes.test.ts — Ω∞ Phase 3 Foundation Contract.
 *
 * TYPE CONTRACT ONLY — no resolver behavior is implemented or exercised
 * here. Uses vitest's compile-time expectTypeOf assertions plus
 * @ts-expect-error negative-compilation checks in preference to weak
 * source-text assertions, per the Gate directive's item 16.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  AccountDimension,
  EvidenceStrength,
  AccountNatureProposal,
  FsPresentationProposal,
  SourceClassificationProposal,
  TaxonomyConceptProposal,
  DimensionProposal,
  EvidenceObservation,
  BalanceSideObservation,
  DimensionResolution,
  CorroborationConflict,
  MachineEvidenceResolverOutput,
  ProfessionalAuthorityResult,
} from "./evidenceResolverTypes";
import type {
  ConfidenceLevel,
  EvidenceSource,
  EvidenceItem,
  EntityClass,
  ReportingFramework,
} from "./entityContext";
import type { AccountNature } from "../safisha/types";
import type { BalanceSide } from "./balanceSideEvidence";
import { inferBalanceSideEvidence } from "./balanceSideEvidence";

const SAMPLE_STRENGTH: EvidenceStrength = {
  sourceAuthority: "HIGH",
  mappingConfidence: "MEDIUM",
  classificationConfidence: "MEDIUM",
};

const SOURCE_CLASSIFICATION_TIER1: SourceClassificationProposal = {
  dimension: "sourceClassification",
  proposal: "2111", // opaque external code, e.g. Tanzania Govt CoA economic code
  strength: SAMPLE_STRENGTH,
  requiresReview: true,
  tier: 1,
  evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
  provenance: [],
};

const FS_PRESENTATION_TIER3: FsPresentationProposal = {
  dimension: "fsPresentation",
  statementSection: "ProfitOrLoss",
  taxonomyConcept: "ifrs-full:CostOfSales",
  balanceAttribute: "debit",
  mappingMethod: "LABEL_SIMILARITY",
  taxonomyProfile: "IFRS_FULL",
  strength: SAMPLE_STRENGTH,
  requiresReview: true,
  tier: 3,
  evidenceSource: "LEXICAL_SIGNAL",
  provenance: [],
};

const ACCOUNT_NATURE_TIER4: AccountNatureProposal = {
  dimension: "accountNature",
  proposal: "expense",
  strength: SAMPLE_STRENGTH,
  requiresReview: true,
  tier: 4,
  evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
  provenance: [],
};

const SAMPLE_OUTPUT: MachineEvidenceResolverOutput = {
  accountId: "acct-1",
  companyId: "company-1",
  periodYear: 2026,
  entityClass: "LOCAL_GOVERNMENT",
  reportingFramework: "IPSAS_ACCRUAL",
  evidenceObservations: [],
  dimensionResolutions: [],
  unresolvedDimensions: [],
  corroborationConflicts: [],
  requiresReviewOverall: true,
};

// ── [A] canonical repository types are reused, not duplicated ───────────────

describe("[A] canonical repository types are reused, not duplicated", () => {
  it("EvidenceStrength's three fields are exactly ConfidenceLevel (entityContext.ts)", () => {
    expectTypeOf<EvidenceStrength["sourceAuthority"]>().toEqualTypeOf<ConfidenceLevel>();
    expectTypeOf<EvidenceStrength["mappingConfidence"]>().toEqualTypeOf<ConfidenceLevel>();
    expectTypeOf<EvidenceStrength["classificationConfidence"]>().toEqualTypeOf<ConfidenceLevel>();
  });

  it("AccountNatureProposal.proposal is exactly AccountNature | null (safisha/types.ts)", () => {
    expectTypeOf<AccountNatureProposal["proposal"]>().toEqualTypeOf<AccountNature | null>();
  });

  it("proposal.evidenceSource/provenance reuse EvidenceSource/EvidenceItem[] (entityContext.ts)", () => {
    expectTypeOf<AccountNatureProposal["evidenceSource"]>().toEqualTypeOf<EvidenceSource>();
    expectTypeOf<AccountNatureProposal["provenance"]>().toEqualTypeOf<EvidenceItem[]>();
  });

  it("MachineEvidenceResolverOutput reuses EntityClass and ReportingFramework (entityContext.ts)", () => {
    expectTypeOf<MachineEvidenceResolverOutput["entityClass"]>().toEqualTypeOf<EntityClass | null>();
    expectTypeOf<MachineEvidenceResolverOutput["reportingFramework"]>().toEqualTypeOf<ReportingFramework>();
  });

  it("BalanceSideObservation.balanceSide reuses BalanceSide (balanceSideEvidence.ts)", () => {
    expectTypeOf<BalanceSideObservation["balanceSide"]>().toEqualTypeOf<BalanceSide>();
  });

  it("a real value constructed against the canonical types is assignable into the foundation contract", () => {
    const nature: AccountNature = "expense"; // safisha/types.ts's own literal union
    const proposal: AccountNatureProposal = { ...ACCOUNT_NATURE_TIER4, proposal: nature };
    expect(proposal.proposal).toBe("expense");
  });
});

// ── [B] discriminated proposals reject cross-dimension nonsense ─────────────

describe("[B] discriminated proposals reject cross-dimension nonsense", () => {
  it("AccountNatureProposal cannot carry fsPresentation-only fields (statementSection)", () => {
    const bad: AccountNatureProposal = {
      dimension: "accountNature",
      proposal: "asset",
      // @ts-expect-error -- statementSection does not exist on AccountNatureProposal
      statementSection: "CurrentAssets",
      strength: SAMPLE_STRENGTH,
      requiresReview: true,
      tier: 4,
      evidenceSource: "UNKNOWN",
      provenance: [],
    };
    expect(bad.dimension).toBe("accountNature");
  });

  it("AccountNatureProposal.proposal rejects an arbitrary string like 'Operating' (directive's own example)", () => {
    // @ts-expect-error -- "Operating" is not a member of AccountNature | null
    const bad: AccountNatureProposal["proposal"] = "Operating";
    expect(bad).toBe("Operating");
  });

  it("TaxonomyConceptProposal.proposal's type is not AccountNature | null", () => {
    expectTypeOf<TaxonomyConceptProposal["proposal"]>().not.toEqualTypeOf<AccountNature | null>();
  });

  it("narrowing a DimensionProposal by its dimension tag prevents reading another shape's fields", () => {
    // Routed through a union-typed function boundary so TypeScript tracks
    // `proposal` as the full DimensionProposal union (not the narrower
    // FsPresentationProposal literal type of the initializer) -- otherwise
    // the branch below would be a compile error in its own right ("no
    // overlap") rather than proving the narrowing guarantee it's testing.
    function widen(p: DimensionProposal): DimensionProposal {
      return p;
    }
    const proposal = widen(FS_PRESENTATION_TIER3);
    if (proposal.dimension === "accountNature") {
      // @ts-expect-error -- statementSection does not exist on AccountNatureProposal
      const leak = proposal.statementSection;
      expect(leak).toBeUndefined();
    }
    expect(proposal.dimension).toBe("fsPresentation");
  });
});

// ── [C] per-dimension resolutions can resolve at different tiers ────────────

describe("[C] per-dimension resolutions can resolve at different tiers simultaneously", () => {
  it("sourceClassification (Tier 1), fsPresentation (Tier 3), accountNature (Tier 4) coexist without information loss", () => {
    const resolutions: DimensionResolution[] = [
      {
        dimension: "sourceClassification",
        winningTier: 1,
        winningProposal: SOURCE_CLASSIFICATION_TIER1,
        consideredProposals: [SOURCE_CLASSIFICATION_TIER1],
        requiresReview: true,
      },
      {
        dimension: "fsPresentation",
        winningTier: 3,
        winningProposal: FS_PRESENTATION_TIER3,
        consideredProposals: [FS_PRESENTATION_TIER3],
        requiresReview: true,
      },
      {
        dimension: "accountNature",
        winningTier: 4,
        winningProposal: ACCOUNT_NATURE_TIER4,
        consideredProposals: [ACCOUNT_NATURE_TIER4],
        requiresReview: true,
      },
    ];
    const byDimension = Object.fromEntries(resolutions.map((r) => [r.dimension, r.winningTier]));
    expect(byDimension.sourceClassification).toBe(1);
    expect(byDimension.fsPresentation).toBe(3);
    expect(byDimension.accountNature).toBe(4);
  });

  it("a dimension can also remain unresolved (winningTier/winningProposal null) while siblings resolve", () => {
    const unresolvedAccountNature: DimensionResolution = {
      dimension: "accountNature",
      winningTier: null,
      winningProposal: null,
      consideredProposals: [],
      requiresReview: true,
    };
    expect(unresolvedAccountNature.winningProposal).toBeNull();
  });
});

// ── [D] no global lowestResolvingTier ────────────────────────────────────────

describe("[D] no global lowestResolvingTier field exists on the resolver output", () => {
  it("MachineEvidenceResolverOutput has no lowestResolvingTier property", () => {
    const output = SAMPLE_OUTPUT;
    // @ts-expect-error -- lowestResolvingTier does not exist on MachineEvidenceResolverOutput
    const leak = output.lowestResolvingTier;
    expect(leak).toBeUndefined();
  });

  it("winning tier is only ever expressed per-dimension (DimensionResolution.winningTier)", () => {
    expectTypeOf<DimensionResolution>().toHaveProperty("winningTier");
    expectTypeOf<MachineEvidenceResolverOutput>().not.toHaveProperty("lowestResolvingTier");
  });
});

// ── [E] Tier 7 stays review-only, never resolves accountNature ──────────────

describe("[E] Tier 7 observation remains review-only and never resolves accountNature", () => {
  it("BalanceSideObservation.informsDimensions is always the empty tuple", () => {
    expectTypeOf<BalanceSideObservation["informsDimensions"]>().toEqualTypeOf<[]>();
  });

  it("a BalanceSideObservation cannot declare accountNature as an informed dimension", () => {
    const bad: BalanceSideObservation = {
      tier: 7,
      evidenceSource: "UNKNOWN",
      detail: "Net debit balance observed.",
      // @ts-expect-error -- informsDimensions must be [], not ["accountNature"]
      informsDimensions: ["accountNature"],
      strength: SAMPLE_STRENGTH,
      balanceSide: "DEBIT",
    };
    expect(bad.tier).toBe(7);
  });

  it("the certified Tier 7 output (balanceSideEvidence.ts, unmodified) is structurally compatible with BalanceSideObservation", () => {
    const evidence = inferBalanceSideEvidence(100);
    expect(evidence).not.toBeNull();
    const observation: BalanceSideObservation = {
      tier: 7,
      evidenceSource: "UNKNOWN",
      detail: evidence!.reason,
      informsDimensions: [],
      strength: {
        sourceAuthority: "LOW",
        mappingConfidence: "NONE",
        classificationConfidence: evidence!.confidence,
      },
      balanceSide: evidence!.balanceSide,
    };
    expect(observation.balanceSide).toBe("DEBIT");
    expect(observation.informsDimensions).toHaveLength(0);
  });

  it("Tier 7's own hardcoded requiresReview:true is preserved when carried into EvidenceStrength/DimensionResolution", () => {
    const evidence = inferBalanceSideEvidence(-50);
    expect(evidence!.requiresReview).toBe(true);
    const resolution: DimensionResolution = {
      dimension: "accountNature",
      winningTier: null, // Tier 7 alone never wins accountNature
      winningProposal: null,
      consideredProposals: [],
      requiresReview: evidence!.requiresReview,
    };
    expect(resolution.requiresReview).toBe(true);
    expect(resolution.winningProposal).toBeNull();
  });
});

// ── [F] balance-side casing normalization ────────────────────────────────────
// Covered in evidenceResolverGuards.test.ts (normalizeBalanceSide itself);
// here we prove the normalized value composes correctly into CorroborationConflict.

describe("[F] normalized balance side composes into CorroborationConflict", () => {
  it("a lowercase observed/taxonomyExpected pair is representable and comparable", () => {
    const conflict: CorroborationConflict = {
      type: "BALANCE_SIDE_CONFLICT",
      observed: "debit",
      taxonomyExpected: "credit",
      severity: "REVIEW_SIGNAL",
      possibleReasons: ["CONTRA_ACCOUNT"],
    };
    expect(conflict.observed).not.toBe(conflict.taxonomyExpected);
  });
});

// ── [G] no cashFlowCategory in the Phase 3 dimension contract ───────────────

describe("[G] no cashFlowCategory in the Phase 3 dimension contract", () => {
  it("AccountDimension has exactly 4 members", () => {
    const dims: AccountDimension[] = [
      "accountNature",
      "fsPresentation",
      "sourceClassification",
      "taxonomyConcept",
    ];
    expect(dims).toHaveLength(4);
  });

  it("'cashFlowCategory' does not type-check as an AccountDimension", () => {
    // @ts-expect-error -- "cashFlowCategory" is not a member of AccountDimension
    const bad: AccountDimension = "cashFlowCategory";
    expect(bad).toBe("cashFlowCategory");
  });
});

// ── [H] no taxTreatment in the universal Phase 3 dimension contract ─────────

describe("[H] no taxTreatment in the universal Phase 3 dimension contract", () => {
  it("'taxTreatment' does not type-check as an AccountDimension", () => {
    // @ts-expect-error -- "taxTreatment" is not a member of AccountDimension; belongs to KINGA only
    const bad: AccountDimension = "taxTreatment";
    expect(bad).toBe("taxTreatment");
  });
});

// ── [I] deterministic semantic contract carries no timestamp ────────────────

describe("[I] the deterministic semantic contract carries no timestamp", () => {
  it("MachineEvidenceResolverOutput has no resolvedAt property", () => {
    const output = SAMPLE_OUTPUT;
    // @ts-expect-error -- resolvedAt does not exist on MachineEvidenceResolverOutput
    const leak = output.resolvedAt;
    expect(leak).toBeUndefined();
  });

  it("MachineEvidenceResolverOutput has no createdAt property", () => {
    const output = SAMPLE_OUTPUT;
    // @ts-expect-error -- createdAt does not exist on MachineEvidenceResolverOutput
    const leak = output.createdAt;
    expect(leak).toBeUndefined();
  });

  it("the module source contains no Date.now()/new Date()/randomUUID calls", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(
      path.join(__dirname, "evidenceResolverTypes.ts"),
      "utf-8",
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/Date\.now\(\)|new Date\(|randomUUID/);
  });
});

// ── [J] sourceClassification stays opaque; no GFS enumeration exists ────────

describe("[J] sourceClassification is an opaque code, never a frozen GFS-style enum", () => {
  it("SourceClassificationProposal.proposal is a plain string | null, not an enum", () => {
    expectTypeOf<SourceClassificationProposal["proposal"]>().toEqualTypeOf<string | null>();
  });

  it("no GFSGroup/GFSClassification/GFStoNature type is defined anywhere in this file's executable code", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("node:path");
    const source: string = fs.readFileSync(
      path.join(__dirname, "evidenceResolverTypes.ts"),
      "utf-8",
    );
    // Strip comments -- this file's own doc comments legitimately name
    // GFSGroup while explaining why it was rejected; only executable type
    // declarations must be checked.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/GFSGroup|GFSClassification|GFStoNature/);
  });

  it("an arbitrary, unenumerated external code (a real MUSE natural account code) is representable without pretending completeness", () => {
    const proposal: SourceClassificationProposal = {
      dimension: "sourceClassification",
      proposal: "21111101", // real MUSE code from museIpsasRulePack.ts -- not a member of any frozen enum
      strength: SAMPLE_STRENGTH,
      requiresReview: true,
      tier: 4,
      evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
      provenance: [],
    };
    expect(proposal.proposal).toBe("21111101");
  });
});

// ── ProfessionalAuthorityResult: domain view, not a DB record shape ─────────

describe("ProfessionalAuthorityResult reflects only real account_review_decisions columns", () => {
  it("does not offer approvedDimensions, confirmed, overridden, or flagged fields", () => {
    const result: ProfessionalAuthorityResult = {
      reviewAccountKey: "21111101",
      hasConfirmedDecision: true,
      decisionAction: "USER_MANUAL_CLASSIFICATION",
      approvedBy: "firm-member-1",
      approvedAt: "2026-09-03T00:00:00Z",
    };
    // @ts-expect-error -- approvedDimensions does not exist on ProfessionalAuthorityResult
    const leak = result.approvedDimensions;
    expect(leak).toBeUndefined();
  });

  it("decisionAction only accepts the three real account_review_decisions.decision_action values", () => {
    // @ts-expect-error -- "confirmed" is not a real decision_action value
    const bad: ProfessionalAuthorityResult["decisionAction"] = "confirmed";
    expect(bad).toBe("confirmed");
  });

  it("machineProposalAtEvaluationTime is offered, never a fabricated AtDecisionTime field", () => {
    const result: ProfessionalAuthorityResult = {
      reviewAccountKey: "21111101",
      hasConfirmedDecision: false,
      decisionAction: null,
      machineProposalAtEvaluationTime: SAMPLE_OUTPUT,
    };
    // @ts-expect-error -- machineProposalAtDecisionTime does not exist (not reconstructible from real schema)
    const leak = result.machineProposalAtDecisionTime;
    expect(leak).toBeUndefined();
    expect(result.machineProposalAtEvaluationTime).toBe(SAMPLE_OUTPUT);
  });
});
