// frameworkPacks/types.ts — the shared contract every reporting-framework pack implements (IFRS for SMEs now; full
// IFRS and IPSAS packs later use the same shapes). Pure data: a pack states WHAT a framework edition requires, WHERE
// (paragraph citations, each with the source it was verified against and how), and which presentation lines a reviewed
// trial balance may be mapped to. It never computes accounting results and never claims compliance.

export type FrameworkFamily = "IFRS_FOR_SMES" | "IFRS" | "IPSAS_ACCRUAL" | "IPSAS_CASH";

/**
 * How a citation was checked:
 * - PRIMARY_TEXT: read in the standard's own text, from a copy whose bytes are pinned (SourceDocument.sha256);
 * - PRIMARY_EXTRACT: read in the standard-setter's published text through a fetch/extraction step whose bytes are not
 *   pinned (re-verify against the published text before relying on exact wording);
 * - PRIMARY_SUMMARY: stated by the standard-setter's own supporting material, not the paragraph itself;
 * - SECONDARY: stated by a third party only.
 */
export type Verification = "PRIMARY_TEXT" | "PRIMARY_EXTRACT" | "PRIMARY_SUMMARY" | "SECONDARY";

export interface SourceDocument {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  /** ISO date the source was read for this pack. */
  readonly retrieved: string;
  /** SHA-256 and size of the exact bytes read, when held (PRIMARY_TEXT requires them). */
  readonly sha256?: string;
  readonly bytes?: number;
  readonly note?: string;
}

export interface Citation {
  readonly source: string;
  /** Paragraph exactly as numbered in that edition, e.g. "3.17(c)". */
  readonly paragraph: string;
  readonly verification: Verification;
}

export type RequirementKind = "STATEMENT" | "LINE_ITEM" | "CLASSIFICATION" | "DISCLOSURE" | "COMPARATIVE" | "PERIOD";
export type StatementKey = "SFP" | "SCI" | "SOCIE" | "SCF" | "NOTES";

export interface PackRequirement {
  /** Stable across editions of one family: an edition changes citations and wording, never the id's meaning. */
  readonly id: string;
  readonly kind: RequirementKind;
  readonly statement?: StatementKey;
  /** Short paraphrase for people; the citation is the authority. */
  readonly label: string;
  readonly citations: readonly Citation[];
  /** ALWAYS: applies to every report. CONDITIONAL: applies when `condition` holds — decided and recorded, never assumed. */
  readonly applicability: "ALWAYS" | "CONDITIONAL";
  readonly condition?: string;
  /** Whether an unmet (or undecided) applicable requirement blocks REVIEWED/FINAL. */
  readonly blocking: boolean;
}

export type AccountNature = "asset" | "liability" | "equity" | "income" | "expense";

/** A line a reviewed account may be presented on. The vocabulary is the pack's; an account is mapped to exactly one. */
export interface PresentationLine {
  readonly id: string;
  readonly statement: "SFP" | "SCI";
  readonly label: string;
  /** The LINE_ITEM requirement this line presents. */
  readonly requirementId: string;
  /** Natures an account on this line may have (a payable is never an asset line). */
  readonly natures: readonly AccountNature[];
  /** SFP lines: which classification the line sits in. "fixed_non_current" = always non-current (deferred tax). */
  readonly position?: "current" | "non_current" | "either" | "fixed_non_current" | "equity";
}

export interface FrameworkEdition {
  readonly id: string;
  readonly title: string;
  readonly issued: string;
  /** First day of the annual periods it applies to (periods BEGINNING on or after). */
  readonly effectiveForPeriodsBeginningOnOrAfter: string;
  readonly earlyApplication: { readonly permitted: boolean; readonly disclosureRequired: boolean; readonly citations: readonly Citation[] };
  readonly effectiveDateCitations: readonly Citation[];
}

export interface FrameworkPack {
  /** e.g. "ifrs-for-smes/2015" — family + edition; what a report version pins. */
  readonly id: string;
  readonly family: FrameworkFamily;
  readonly edition: FrameworkEdition;
  /** Version of this pack's encoding (requirements, lines, citations). Any change bumps it; a stored report keeps its own. */
  readonly packVersion: string;
  readonly requirements: readonly PackRequirement[];
  readonly lines: readonly PresentationLine[];
  readonly comparatives: { readonly required: boolean; readonly minimumPeriods: number; readonly citations: readonly Citation[] };
}

/** How far a requirement is honoured by this product — the coverage matrix's three states, nothing in between. */
export type CoverageStatus = "VALIDATED" | "IMPLEMENTED_NOT_VALIDATED" | "MISSING";
