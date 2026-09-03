/**
 * evidenceResolver.ts — Ω∞ Phase 3, Tier 2 evidence resolver.
 *
 * PURE FUNCTION. No Supabase, no DB, no network, no auth, no timestamps, no
 * random ids, no filesystem, no persistence, no controlledActivation, no
 * professional-authority reads. COMPUTES and RETURNS a
 * MachineEvidenceResolverOutput only.
 *
 * Consumes the certified Foundation Contract (evidenceResolverTypes.ts) and
 * the certified, dormant Tier 2 classifier (museClassifier.ts /
 * museIpsasRulePack.ts) exactly as they exist today. Neither is modified.
 *
 * Tier 1 is ABSENT from this repository (Gate finding, Phase 3 Tier1+2
 * Resolver Gate Section F/H): no statutory-code, GFSM, or Tanzania
 * Government CoA infrastructure exists anywhere. This resolver never
 * produces `tier: 1` evidence and never will until real, verified Tier 1
 * infrastructure is built in its own slice.
 *
 * Tier 2 safety gate: classifyMuseAccount() matches purely on
 * naturalAccountCode -- it does NOT itself check the rule's own
 * framework/jurisdiction/sourceSystem/entityClasses metadata against the
 * calling entity (verified: museClassifier.ts's RULES_BY_CODE lookup never
 * reads those fields). This resolver is therefore the ONLY place that
 * safety check exists. Tier 2 is evaluated ONLY when BOTH:
 *   reportingFramework === "IPSAS_ACCRUAL"
 *   sourceSystem        === "MUSE"
 * are true. If either fails, classifyMuseAccount() is never called at all
 * -- not called-then-discarded, which would risk exposing misleading
 * partial evidence.
 *
 * AccountNature adapter: museIpsasRulePack.ts's AccountNature
 * (ASSET|LIABILITY|NET_ASSETS|REVENUE|EXPENSE, IPSAS-locked, uppercase) is
 * a different enum from the Foundation Contract's AccountNature
 * (asset|liability|equity|income|expense, from ../safisha/types.ts,
 * generic). toGenericAccountNature() below is the one exhaustive,
 * compile-time-enforced translation between them -- never an `as` cast.
 *
 * Tier 7: classifyMuseAccount() already embeds Tier 7 (balance-side
 * evidence) in its own no-match branch. This resolver passes that through
 * as a read-only EvidenceObservation when it appears -- it never becomes an
 * AccountNatureProposal, FsPresentationProposal, or TaxonomyConceptProposal
 * (Tier 7 cannot independently resolve any dimension; see
 * balanceSideEvidence.ts and evidenceResolverTypes.ts's own certified
 * contract). balanceSideEvidence.ts is not modified or re-invoked directly
 * here -- only the already-certified classifier's own embedding of it is
 * read.
 *
 * Known, reported (not silently worked around) gap: MuseIpsasRule's own
 * `normalBalanceExpectation` field is never surfaced by
 * classifyMuseAccount()'s return shape (ClassificationOutcome has no such
 * field) -- so there is nothing for this resolver to carry into evidence
 * observations for it. Adding it would require modifying the certified
 * museClassifier.ts, which this slice does not do.
 */

import { classifyMuseAccount } from "./museClassifier";
import type { AccountNature as MuseAccountNature } from "./museIpsasRulePack";
import type { EntityClass, ReportingFramework, SourceSystem } from "./entityContext";
import type { AccountNature } from "../safisha/types";
import type {
  AccountDimension,
  DimensionResolution,
  AccountNatureResolution,
  FsPresentationResolution,
  SourceClassificationResolution,
  TaxonomyConceptResolution,
  AccountNatureProposal,
  FsPresentationProposal,
  SourceClassificationProposal,
  EvidenceObservation,
  BalanceSideObservation,
  EvidenceStrength,
  MachineEvidenceResolverOutput,
} from "./evidenceResolverTypes";

export interface ResolverInput {
  accountId: string;
  companyId: string;
  periodYear: number;
  naturalAccountCode: string;
  accountName: string;
  balance: number;
  entityClass: EntityClass | null;
  reportingFramework: ReportingFramework;
  sourceSystem: SourceSystem;
}

/**
 * The one exhaustive translation from museIpsasRulePack.ts's IPSAS-locked
 * AccountNature to the Foundation Contract's generic AccountNature. The
 * `default` branch is an exhaustiveness guard (`never`): adding a new value
 * to MuseAccountNature without updating this function fails to compile,
 * regardless of the repo's non-strict tsconfig.
 */
function toGenericAccountNature(museNature: MuseAccountNature): AccountNature {
  switch (museNature) {
    case "ASSET":
      return "asset";
    case "LIABILITY":
      return "liability";
    case "NET_ASSETS":
      return "equity";
    case "REVENUE":
      return "income";
    case "EXPENSE":
      return "expense";
    default: {
      const exhaustive: never = museNature;
      throw new Error(`Unmapped MUSE/IPSAS AccountNature: ${String(exhaustive)}`);
    }
  }
}

function isTier2Eligible(input: ResolverInput): boolean {
  return input.reportingFramework === "IPSAS_ACCRUAL" && input.sourceSystem === "MUSE";
}

function emptyResolution<D extends AccountDimension>(dimension: D): {
  dimension: D;
  winningProposal: null;
  consideredProposals: never[];
  requiresReview: true;
} {
  return { dimension, winningProposal: null, consideredProposals: [], requiresReview: true };
}

function unresolvedDimensionsOf(resolutions: DimensionResolution[]): AccountDimension[] {
  return resolutions.filter((r) => r.winningProposal === null).map((r) => r.dimension);
}

function assembleOutput(
  input: ResolverInput,
  resolutions: DimensionResolution[],
  evidenceObservations: EvidenceObservation[],
): MachineEvidenceResolverOutput {
  return {
    accountId: input.accountId,
    companyId: input.companyId,
    periodYear: input.periodYear,
    entityClass: input.entityClass,
    reportingFramework: input.reportingFramework,
    evidenceObservations,
    dimensionResolutions: resolutions,
    unresolvedDimensions: unresolvedDimensionsOf(resolutions),
    corroborationConflicts: [],
    requiresReviewOverall: resolutions.some((r) => r.requiresReview),
  };
}

/** No Tier 2, no Tier 7 -- the gate itself failed, so classifyMuseAccount() is never called. */
function resolveGateIneligible(input: ResolverInput): MachineEvidenceResolverOutput {
  const resolutions: DimensionResolution[] = [
    emptyResolution("accountNature") as AccountNatureResolution,
    emptyResolution("fsPresentation") as FsPresentationResolution,
    emptyResolution("sourceClassification") as SourceClassificationResolution,
    emptyResolution("taxonomyConcept") as TaxonomyConceptResolution,
  ];
  return assembleOutput(input, resolutions, []);
}

/**
 * Tier 2 evaluated (gate passed) but the exact code did not match any rule.
 * classifyMuseAccount() may still have embedded Tier 7 (balance-side)
 * evidence in its UNRESOLVED result -- pass it through as an observation
 * only. No dimension resolves from it.
 */
function resolveTier2Miss(
  input: ResolverInput,
  outcome: ReturnType<typeof classifyMuseAccount>,
): MachineEvidenceResolverOutput {
  const resolutions: DimensionResolution[] = [
    emptyResolution("accountNature") as AccountNatureResolution,
    emptyResolution("fsPresentation") as FsPresentationResolution,
    emptyResolution("sourceClassification") as SourceClassificationResolution,
    emptyResolution("taxonomyConcept") as TaxonomyConceptResolution,
  ];

  const observations: EvidenceObservation[] = [];
  if (outcome.evidenceTier === 7 && outcome.balanceSide) {
    const tier7Observation: BalanceSideObservation = {
      tier: 7,
      evidenceSource: outcome.confidenceSource,
      detail: outcome.reason,
      informsDimensions: [],
      strength: {
        sourceAuthority: "LOW",
        mappingConfidence: "NONE",
        classificationConfidence: outcome.confidence,
      },
      balanceSide: outcome.balanceSide,
    };
    observations.push(tier7Observation);
  }

  return assembleOutput(input, resolutions, observations);
}

/** Tier 2 evaluated and the exact code matched a rule (AUTO_MAPPED_RULE or REVIEW_SUGGESTED). */
function resolveTier2Match(
  input: ResolverInput,
  outcome: ReturnType<typeof classifyMuseAccount>,
): MachineEvidenceResolverOutput {
  const requiresReview = outcome.outcome === "REVIEW_SUGGESTED";
  // Tier 2's rule pack assigns one confidence per rule. Until a real
  // multi-signal confidence model exists, all three EvidenceStrength values
  // mirror it directly -- no combination formula, no arithmetic invented.
  // Source identity vs classification evidence are genuinely different
  // claims and must not share one EvidenceStrength/evidenceSource/provenance
  // triple (Provenance Hardening findings 1/2). The resolver's own gate
  // (isTier2Eligible) has already deterministically established, before any
  // rule lookup, that sourceSystem === "MUSE" and the code matched exactly
  // -- that identity is never in question, regardless of how confidently
  // the RULE classifies what the code means. classificationStrength, in
  // contrast, carries the rule's own per-rule confidence untouched: a real
  // LOW/LEXICAL rule must stay LOW/review-requiring for accountNature and
  // fsPresentation, exactly as the rule pack itself asserts.
  const sourceClassificationStrength: EvidenceStrength = {
    sourceAuthority: "HIGH",
    mappingConfidence: "HIGH",
    classificationConfidence: "HIGH",
  };
  const classificationStrength: EvidenceStrength = {
    // HIGH because the rule pack itself is grounded in real, observed
    // Arusha DC MUSE trial-balance data (museIpsasRulePack.ts's own header)
    // -- not a statutory or GFSM claim, which this repository does not
    // possess (Tier 1 is absent; see resolveEvidence's own module doc).
    sourceAuthority: "HIGH",
    mappingConfidence: outcome.confidence,
    classificationConfidence: outcome.confidence,
  };

  const sourceClassificationProvenance = [
    {
      source: "SOURCE_SYSTEM_SIGNATURE" as const,
      detail: `Exact match against MUSE natural account code '${input.naturalAccountCode}' under confirmed IPSAS_ACCRUAL reporting framework and MUSE source system.`,
      ref: input.naturalAccountCode,
    },
  ];

  const sourceClassificationProposal: SourceClassificationProposal = {
    dimension: "sourceClassification",
    proposal: input.naturalAccountCode,
    strength: sourceClassificationStrength,
    // Source identity itself is never uncertain once the gate + exact
    // code match succeed -- decoupled from the rule's own classification
    // confidence, which may independently require review (see accountNature
    // / fsPresentation below).
    requiresReview: false,
    tier: 2,
    evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
    provenance: sourceClassificationProvenance,
  };

  const resolutions: DimensionResolution[] = [];
  const classificationInformedDimensions: AccountDimension[] = [];

  resolutions.push({
    dimension: "sourceClassification",
    winningProposal: sourceClassificationProposal,
    consideredProposals: [sourceClassificationProposal],
    requiresReview: false,
  });

  if (outcome.accountNature) {
    const accountNatureProposal: AccountNatureProposal = {
      dimension: "accountNature",
      proposal: toGenericAccountNature(outcome.accountNature),
      strength: classificationStrength,
      requiresReview,
      tier: 2,
      evidenceSource: outcome.confidenceSource,
      provenance: outcome.evidence,
    };
    resolutions.push({
      dimension: "accountNature",
      winningProposal: accountNatureProposal,
      consideredProposals: [accountNatureProposal],
      requiresReview,
    });
    classificationInformedDimensions.push("accountNature");
  } else {
    resolutions.push(emptyResolution("accountNature") as AccountNatureResolution);
  }

  if (outcome.presentationCode) {
    const fsPresentationProposal: FsPresentationProposal = {
      dimension: "fsPresentation",
      statementSection: outcome.presentationCode,
      mappingMethod: "EXACT_CODE",
      taxonomyProfile: null,
      strength: classificationStrength,
      requiresReview,
      tier: 2,
      evidenceSource: outcome.confidenceSource,
      provenance: outcome.evidence,
    };
    resolutions.push({
      dimension: "fsPresentation",
      winningProposal: fsPresentationProposal,
      consideredProposals: [fsPresentationProposal],
      requiresReview,
    });
    classificationInformedDimensions.push("fsPresentation");
  } else {
    resolutions.push(emptyResolution("fsPresentation") as FsPresentationResolution);
  }

  // Tier 2 has zero taxonomy-concept evidence -- never fabricated here.
  resolutions.push(emptyResolution("taxonomyConcept") as TaxonomyConceptResolution);

  const evidenceObservations: EvidenceObservation[] = [
    {
      tier: 2,
      evidenceSource: "SOURCE_SYSTEM_SIGNATURE",
      detail: sourceClassificationProvenance[0].detail,
      ref: input.naturalAccountCode,
      informsDimensions: ["sourceClassification"],
      strength: sourceClassificationStrength,
    },
  ];

  if (classificationInformedDimensions.length > 0) {
    evidenceObservations.push({
      tier: 2,
      evidenceSource: outcome.confidenceSource,
      detail: outcome.reason,
      ref: outcome.ruleId,
      informsDimensions: classificationInformedDimensions,
      strength: classificationStrength,
    });
  }

  return assembleOutput(input, resolutions, evidenceObservations);
}

/**
 * Resolve Tier 2 (and, on a Tier 2 miss, pass through any Tier 7 evidence
 * already embedded in the certified classifier) for one account. Pure,
 * deterministic, synchronous. Tier 1 is never produced -- it does not exist
 * in this repository.
 */
export function resolveEvidence(input: ResolverInput): MachineEvidenceResolverOutput {
  if (!isTier2Eligible(input)) {
    return resolveGateIneligible(input);
  }

  const outcome = classifyMuseAccount({
    naturalAccountCode: input.naturalAccountCode,
    accountName: input.accountName,
    balance: input.balance,
  });

  if (outcome.outcome === "UNRESOLVED") {
    return resolveTier2Miss(input, outcome);
  }

  return resolveTier2Match(input, outcome);
}
