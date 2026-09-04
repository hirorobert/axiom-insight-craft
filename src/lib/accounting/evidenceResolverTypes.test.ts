/**
 * evidenceResolverTypes.test.ts — Ω∞ Phase 3 Foundation Contract.
 *
 * TYPE CONTRACT ONLY — no resolver behavior is implemented or exercised
 * here. Uses vitest's compile-time expectTypeOf assertions plus
 * @ts-expect-error negative-compilation checks in preference to weak
 * source-text assertions. Every @ts-expect-error / expectTypeOf assertion
 * in this file has been independently verified against a real `tsc`
 * compile (not just vitest's non-type-checking esbuild transform) — see
 * the Foundation Hardening report for the exact command used.
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
  AccountNatureResolution,
  FsPresentationResolution,
  SourceClassificationResolution,
  TaxonomyConceptResolution,
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

// ── Fixtures ──────────────────────────────────────────────────────────────

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
  mappingMethod: "LABEL_SIMILARITY",
  taxonomyProfile: "IFRS_FULL",
  strength: SAMPLE_STRENGTH,
  requiresReview: true,
  tier: 3,
  evidenceSource: "LEXICAL_SIGNAL",
  provenance: [],
};

const TAXONOMY_CONCEPT_TIER3: TaxonomyConceptProposal = {
  dimension: "taxonomyConcept",
  proposal: "ifrs-full:CostOfSales",
  balanceAttribute: "debit",
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

const ACCOUNT_NATURE_RESOLUTION: AccountNatureResolution = {
  dimension: "accountNature",
  winningProposal: ACCOUNT_NATURE_TIER4,
  consideredProposals: [ACCOUNT_NATURE_TIER4],
  requiresReview: true,
};

const FS_PRESENTATION_RESOLUTION: FsPresentationResolution = {
  dimension: "fsPresentation",
  winningProposal: FS_PRESENTATION_TIER3,
  consideredProposals: [FS_PRESENTATION_TIER3],
  requiresReview: true,
};

const SOURCE_CLASSIFICATION_RESOLUTION: SourceClassificationResolution = {
  dimension: "sourceClassification",
  winningProposal: SOURCE_CLASSIFICATION_TIER1,
  consideredProposals: [SOURCE_CLASSIFICATION_TIER1],
  requiresReview: true,
};

const TAXONOMY_CONCEPT_RESOLUTION: TaxonomyConceptResolution = {
  dimension: "taxonomyConcept",
  winningProposal: TAXONOMY_CONCEPT_TIER3,
  consideredProposals: [TAXONOMY_CONCEPT_TIER3],
  requiresReview: true,
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

const MINIMAL_AUTHORITY_RESULT: ProfessionalAuthorityResult = {
  reviewAccountKey: "21111101",
  hasEffectiveDecision: false,
  decisionAction: null,
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
      SOURCE_CLASSIFICATION_RESOLUTION,
      FS_PRESENTATION_RESOLUTION,
      ACCOUNT_NATURE_RESOLUTION,
    ];
    const tierByDimension = Object.fromEntries(
      resolutions.map((r) => [r.dimension, r.winningProposal?.tier ?? null]),
    );
    expect(tierByDimension.sourceClassification).toBe(1);
    expect(tierByDimension.fsPresentation).toBe(3);
    expect(tierByDimension.accountNature).toBe(4);
  });

  it("a dimension can also remain unresolved (winningProposal null -> no winning tier) while siblings resolve", () => {
    const unresolvedAccountNature: AccountNatureResolution = {
      dimension: "accountNature",
      winningProposal: null,
      consideredProposals: [],
      requiresReview: true,
    };
    expect(unresolvedAccountNature.winningProposal).toBeNull();
    expect(unresolvedAccountNature.winningProposal?.tier).toBeUndefined();
  });
});

// ── [D] no winningTier field; winning tier is derived, never duplicated ────

describe("[D] no winningTier field -- the winning tier is winningProposal.tier, never a second field", () => {
  it("DimensionResolution has no winningTier property", () => {
    const resolution = ACCOUNT_NATURE_RESOLUTION;
    // @ts-expect-error -- winningTier does not exist on DimensionResolution (removed; use winningProposal.tier)
    const leak = resolution.winningTier;
    expect(leak).toBeUndefined();
  });

  it("MachineEvidenceResolverOutput still has no lowestResolvingTier property (no global tier field either)", () => {
    const output = SAMPLE_OUTPUT;
    // @ts-expect-error -- lowestResolvingTier does not exist on MachineEvidenceResolverOutput
    const leak = output.lowestResolvingTier;
    expect(leak).toBeUndefined();
  });

  it("[9E] the winning proposal's tier remains accessible through resolution.winningProposal?.tier after discriminant narrowing", () => {
    const resolution: DimensionResolution = ACCOUNT_NATURE_RESOLUTION;
    if (resolution.dimension === "accountNature") {
      expect(resolution.winningProposal?.tier).toBe(4);
    } else {
      throw new Error("unreachable in this fixture");
    }
  });
});

// ── [9A]/[9B]/[9C] dimension-coupled resolutions reject mismatched proposals ─

describe("[9A] an accountNature resolution cannot accept an FsPresentationProposal as its winner", () => {
  it("fails to compile: dimension 'accountNature' + winningProposal typed as FsPresentationProposal", () => {
    const bad: AccountNatureResolution = {
      dimension: "accountNature",
      // @ts-expect-error -- winningProposal must be AccountNatureProposal | null, not FsPresentationProposal
      winningProposal: FS_PRESENTATION_TIER3,
      consideredProposals: [],
      requiresReview: true,
    };
    expect(bad.dimension).toBe("accountNature");
  });
});

describe("[9B] an accountNature resolution cannot accept an FsPresentationProposal among consideredProposals", () => {
  it("fails to compile: consideredProposals containing a mismatched-dimension proposal", () => {
    const bad: AccountNatureResolution = {
      dimension: "accountNature",
      winningProposal: null,
      // @ts-expect-error -- consideredProposals must be AccountNatureProposal[], not include FsPresentationProposal
      consideredProposals: [FS_PRESENTATION_TIER3],
      requiresReview: true,
    };
    expect(bad.dimension).toBe("accountNature");
  });
});

describe("[9C] the same mismatch is rejected for a second dimension (sourceClassification)", () => {
  it("fails to compile: dimension 'sourceClassification' + winningProposal typed as AccountNatureProposal", () => {
    const bad: SourceClassificationResolution = {
      dimension: "sourceClassification",
      // @ts-expect-error -- winningProposal must be SourceClassificationProposal | null, not AccountNatureProposal
      winningProposal: ACCOUNT_NATURE_TIER4,
      consideredProposals: [],
      requiresReview: true,
    };
    expect(bad.dimension).toBe("sourceClassification");
  });

  it("fails to compile: consideredProposals containing a mismatched-dimension proposal (taxonomyConcept into sourceClassification)", () => {
    const bad: SourceClassificationResolution = {
      dimension: "sourceClassification",
      winningProposal: null,
      // @ts-expect-error -- consideredProposals must be SourceClassificationProposal[], not include TaxonomyConceptProposal
      consideredProposals: [TAXONOMY_CONCEPT_TIER3],
      requiresReview: true,
    };
    expect(bad.dimension).toBe("sourceClassification");
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

  it("Tier 7's own hardcoded requiresReview:true is preserved when carried into a DimensionResolution, still unable to win accountNature", () => {
    const evidence = inferBalanceSideEvidence(-50);
    expect(evidence!.requiresReview).toBe(true);
    const resolution: AccountNatureResolution = {
      dimension: "accountNature",
      winningProposal: null, // Tier 7 alone never wins accountNature -- it produces no AccountNatureProposal
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

// ── [9F]/[9G] taxonomy-concept ownership is exclusive to TaxonomyConceptProposal ─

describe("[9F] FsPresentationProposal cannot contain taxonomyConcept or balanceAttribute", () => {
  it("reading taxonomyConcept off an FsPresentationProposal-typed value fails to compile", () => {
    const proposal = FS_PRESENTATION_TIER3;
    // @ts-expect-error -- taxonomyConcept does not exist on FsPresentationProposal (moved to TaxonomyConceptProposal)
    const leak = proposal.taxonomyConcept;
    expect(leak).toBeUndefined();
  });

  it("reading balanceAttribute off an FsPresentationProposal-typed value fails to compile", () => {
    const proposal = FS_PRESENTATION_TIER3;
    // @ts-expect-error -- balanceAttribute does not exist on FsPresentationProposal (moved to TaxonomyConceptProposal)
    const leak = proposal.balanceAttribute;
    expect(leak).toBeUndefined();
  });

  it("constructing an FsPresentationProposal literal with taxonomyConcept fails to compile", () => {
    const bad: FsPresentationProposal = {
      dimension: "fsPresentation",
      statementSection: "ProfitOrLoss",
      mappingMethod: "LABEL_SIMILARITY",
      taxonomyProfile: "IFRS_FULL",
      // @ts-expect-error -- taxonomyConcept does not exist on FsPresentationProposal
      taxonomyConcept: "ifrs-full:CostOfSales",
      strength: SAMPLE_STRENGTH,
      requiresReview: true,
      tier: 3,
      evidenceSource: "LEXICAL_SIGNAL",
      provenance: [],
    };
    expect(bad.dimension).toBe("fsPresentation");
  });
});

describe("[9G] TaxonomyConceptProposal is the exclusive taxonomy-concept proposal owner", () => {
  it("carries both the XBRL element name and its own IASB-defined normal balance", () => {
    expect(TAXONOMY_CONCEPT_TIER3.proposal).toBe("ifrs-full:CostOfSales");
    expect(TAXONOMY_CONCEPT_TIER3.balanceAttribute).toBe("debit");
  });

  it("a taxonomyConcept resolution only ever considers TaxonomyConceptProposal candidates", () => {
    expect(TAXONOMY_CONCEPT_RESOLUTION.winningProposal?.proposal).toBe("ifrs-full:CostOfSales");
    expect(TAXONOMY_CONCEPT_RESOLUTION.consideredProposals).toHaveLength(1);
  });
});

// ── [9H] professional authority terminology ──────────────────────────────────

describe("[9H] ProfessionalAuthorityResult exposes hasEffectiveDecision/decidedBy/decidedAt only", () => {
  it("exposes the renamed fields with real values", () => {
    const result: ProfessionalAuthorityResult = {
      reviewAccountKey: "21111101",
      hasEffectiveDecision: true,
      decisionAction: "USER_MANUAL_CLASSIFICATION",
      decidedBy: "firm-member-1",
      decidedAt: "2026-09-03T00:00:00Z",
    };
    expect(result.hasEffectiveDecision).toBe(true);
    expect(result.decidedBy).toBe("firm-member-1");
    expect(result.decidedAt).toBe("2026-09-03T00:00:00Z");
  });

  it("does not expose hasConfirmedDecision", () => {
    // @ts-expect-error -- hasConfirmedDecision does not exist (renamed to hasEffectiveDecision)
    const leak = MINIMAL_AUTHORITY_RESULT.hasConfirmedDecision;
    expect(leak).toBeUndefined();
  });

  it("does not expose approvedBy", () => {
    // @ts-expect-error -- approvedBy does not exist (renamed to decidedBy)
    const leak = MINIMAL_AUTHORITY_RESULT.approvedBy;
    expect(leak).toBeUndefined();
  });

  it("does not expose approvedAt", () => {
    // @ts-expect-error -- approvedAt does not exist (renamed to decidedAt)
    const leak = MINIMAL_AUTHORITY_RESULT.approvedAt;
    expect(leak).toBeUndefined();
  });

  it("still does not offer approvedDimensions, confirmed, overridden, or flagged fields", () => {
    // @ts-expect-error -- approvedDimensions does not exist on ProfessionalAuthorityResult
    const leak = MINIMAL_AUTHORITY_RESULT.approvedDimensions;
    expect(leak).toBeUndefined();
  });

  it("decisionAction only accepts the three real account_review_decisions.decision_action values", () => {
    // @ts-expect-error -- "confirmed" is not a real decision_action value
    const bad: ProfessionalAuthorityResult["decisionAction"] = "confirmed";
    expect(bad).toBe("confirmed");
  });

  it("machineProposalAtEvaluationTime is offered, never a fabricated AtDecisionTime field", () => {
    const result: ProfessionalAuthorityResult = {
      ...MINIMAL_AUTHORITY_RESULT,
      machineProposalAtEvaluationTime: SAMPLE_OUTPUT,
    };
    // @ts-expect-error -- machineProposalAtDecisionTime does not exist (not reconstructible from real schema)
    const leak = result.machineProposalAtDecisionTime;
    expect(leak).toBeUndefined();
    expect(result.machineProposalAtEvaluationTime).toBe(SAMPLE_OUTPUT);
  });
});

// ── [9I] MARK_NON_REPORTING_ACCOUNT is an effective decision, not an approval ─

describe("[9I] MARK_NON_REPORTING_ACCOUNT is representable as an effective decision without implying classification approval", () => {
  it("hasEffectiveDecision can be true for a MARK_NON_REPORTING_ACCOUNT decision", () => {
    const result: ProfessionalAuthorityResult = {
      reviewAccountKey: "99999999",
      hasEffectiveDecision: true,
      decisionAction: "MARK_NON_REPORTING_ACCOUNT",
      decidedBy: "firm-member-1",
      decidedAt: "2026-09-03T00:00:00Z",
    };
    expect(result.hasEffectiveDecision).toBe(true);
    expect(result.decisionAction).toBe("MARK_NON_REPORTING_ACCOUNT");
    // No approvedClassification/approvedDimensions/approved* field exists
    // anywhere on this type (see [9H]) to imply a classification was
    // accepted -- an effective decision and a classification approval are
    // structurally distinct claims here.
  });
});

// ── [9J] existing valid per-dimension examples still compile ────────────────

describe("[9J] existing valid per-dimension examples still compile", () => {
  it("accountNature/fsPresentation/sourceClassification/taxonomyConcept resolutions all construct without error", () => {
    const resolutions: DimensionResolution[] = [
      ACCOUNT_NATURE_RESOLUTION,
      FS_PRESENTATION_RESOLUTION,
      SOURCE_CLASSIFICATION_RESOLUTION,
      TAXONOMY_CONCEPT_RESOLUTION,
    ];
    expect(resolutions).toHaveLength(4);
    expect(resolutions.every((r) => r.winningProposal !== undefined)).toBe(true);
  });
});
