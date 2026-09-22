/**
 * publicClaimRegistry — every capability/property claim rendered on the public marketing surface
 * (currently: the landing page, `src/pages/Index.tsx` and its section components), mapped to the
 * exact repository evidence that makes it true.
 *
 * Rule: nothing goes on the landing page — and nothing stays on it — without a row here. A claim
 * with no verifiable evidence is not softened, hedged or kept "for now": it is removed (see the
 * `stronger.*` entries below documenting language that was already found and removed for exactly
 * this reason). publicClaimRegistry.test.ts checks every quoted `claimText` against the live
 * landing-page source, so a future edit that silently strengthens or removes a claim without
 * updating its evidence fails the test, not the reader.
 *
 * A claim never appears here merely because it SOUNDS safe — `evidenceSource` must name a real
 * file (and line, where practical) a reviewer can open and check today.
 */

export interface PublicClaim {
  readonly id: string;
  /** The exact rendered text (or the stable substring a test can match against). */
  readonly claimText: string;
  /** Where this is proven true — a real file path (and line/symbol where practical). */
  readonly evidenceSource: string;
  /** The wording actually approved for public use. */
  readonly approvedWording: string;
  /** Specific stronger phrasings that must NEVER be substituted in, and why each is currently false. */
  readonly prohibitedWording: readonly string[];
  /** ISO date this row was last checked against the live source. */
  readonly verifiedDate: string;
}

export const PUBLIC_CLAIM_REGISTRY: readonly PublicClaim[] = [
  {
    id: "seven-stage-workflow",
    claimText: "7-stage accounting workflow",
    evidenceSource: "src/lib/workspace/stageMetadata.ts (STAGE_SEQUENCE — exactly 7 entries: prepare, reconcile, statements, tax, compliance, filing, monitor)",
    approvedWording: "7-stage accounting workflow",
    prohibitedWording: ["fully automated 7-stage close", "AI-driven 7-stage workflow"],
    verifiedDate: "2026-09-22",
  },
  {
    id: "ifrs-framework-aware",
    claimText: "IFRS framework-aware",
    evidenceSource: "src/lib/accounting/frameworkAdapter.ts (CompanyReportingFrameworkDbValue: ifrs_for_smes | full_ifrs | ipsas_accrual | ipsas_cash) + src/lib/financialStatementsWorkspace/frameworkProfiles.ts",
    approvedWording: "IFRS framework-aware",
    prohibitedWording: ["IFRS-certified", "audited under IFRS", "ASC 606", "ASC 958"],
    verifiedDate: "2026-09-22",
  },
  {
    id: "h01-12-assurance-checks",
    claimText: "H-01–12 assurance checks",
    evidenceSource: "supabase/functions/hesabu-validate/index.ts — H-01 through H-12 are the actual assertion codes the function evaluates (e.g. H-01 SFP Fundamental Equation, H-12 IS PAT feeds SOCIE)",
    approvedWording: "H-01–12 assurance checks",
    prohibitedWording: ["12 independent audit opinions", "auditor-certified"],
    verifiedDate: "2026-09-22",
  },
  {
    id: "keyboard-accessible",
    claimText: "Keyboard accessible",
    evidenceSource: "src/components/Hero.tsx, Header.tsx, ProductTour.tsx — every interactive control is a real <a>/<button>/<Link> with a visible focus-visible:ring class, never a div with an onClick-only handler",
    approvedWording: "Keyboard accessible",
    prohibitedWording: [
      "WCAG AA",
      "WCAG 2.2 AA compliant",
      "WCAG-certified",
    ],
    // "WCAG AA" was the ORIGINAL trust-metric wording and was downgraded here (2026-09-22) precisely
    // because this repository has no accessibility conformance audit (no axe-core/pa11y test suite,
    // no third-party audit report) — asserting a specific conformance LEVEL without one is exactly
    // the kind of unsupported compliance claim this registry exists to catch. "Keyboard accessible"
    // is the narrower, independently-checkable claim that survives.
    verifiedDate: "2026-09-22",
  },
  {
    id: "hash-verified-source",
    claimText: "hash-verified source",
    evidenceSource: "supabase/functions/process-trial-balance/index.ts — sha256HexBytes(fileBuffer) is computed server-side and persisted as trial_balance_uploads.source_file_hash for every upload (search: sourceFileHash)",
    approvedWording: "hash-verified source",
    prohibitedWording: ["tamper-proof", "cryptographically immutable evidence"],
    verifiedDate: "2026-09-22",
  },
  {
    id: "actor-identity-server-session",
    claimText: "Every transition carries actor identity from the authenticated server session — no name supplied by the browser",
    evidenceSource: "CLAUDE.md §4.3 (firmMemberId canonical actor identity) + supabase/functions/_shared/auth.ts's validateAuth(); every financial-write edge function calls it before using firmMemberId, never a client-supplied value",
    approvedWording: "Every transition carries actor identity from the authenticated server session — no name supplied by the browser",
    prohibitedWording: ["blockchain-verified identity", "biometric verification"],
    verifiedDate: "2026-09-22",
  },
  {
    id: "no-card-required-free",
    claimText: "No card required to start free",
    evidenceSource: "src/constants/copy.ts CTA.primaryHref = \"/auth\" — sign-up is a plain email/password flow (src/pages/Auth.tsx) with no payment-collection step of any kind before an account exists",
    approvedWording: "No card required to start free",
    prohibitedWording: [
      "Cancel anytime",
    ],
    // "Cancel anytime" was REMOVED from ClosingCTA.tsx (2026-09-22): grepped the full repository for
    // a cancel-subscription capability (client or Supabase function) and found none. The paid plan's
    // checkout itself is real and server-authoritative (src/components/commercial/
    // CheckoutUpgradeButton.tsx, gated on a verified pricing-parity check) — but nothing anywhere
    // lets a subscriber cancel, so claiming they can was unsupported and is not restored until a
    // genuine cancellation path exists.
    verifiedDate: "2026-09-22",
  },
] as const;

export function findPublicClaim(id: string): PublicClaim | undefined {
  return PUBLIC_CLAIM_REGISTRY.find((c) => c.id === id);
}
