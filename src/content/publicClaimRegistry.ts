/**
 * publicClaimRegistry — every capability/property claim rendered on the public marketing surface
 * (currently: the landing page, `src/pages/Index.tsx`, its section components under
 * `src/components/landing/`, the copy modules they read, and `index.html`), mapped to the exact
 * repository evidence that makes it true.
 *
 * Rule: nothing goes on the landing page — and nothing stays on it — without a row here. A claim
 * with no verifiable evidence is not softened, hedged or kept "for now": it is removed (see the
 * `prohibitedWording` entries below documenting language that was already found and removed for
 * exactly this reason). publicClaimRegistry.test.ts checks every quoted `claimText` against the
 * live landing-page source, so a future edit that silently strengthens or removes a claim without
 * updating its evidence fails the test, not the reader.
 *
 * A claim never appears here merely because it SOUNDS safe — `evidenceSource` must name a real
 * file (and line, where practical) a reviewer can open and check today.
 *
 * `evidenceScope` states what the evidence does NOT establish. A row whose scope note would have
 * to say "nothing is excluded" is a red flag: real evidence always has a boundary, and that
 * boundary is what keeps the public wording conservative.
 */

export interface PublicClaim {
  readonly id: string;
  /** The exact rendered text (or the stable substring a test can match against). */
  readonly claimText: string;
  /** Where this is proven true — a real file path (and line/symbol where practical). */
  readonly evidenceSource: string;
  /** What the evidence does NOT prove. Keeps the approved wording honest about its limits. */
  readonly evidenceScope: string;
  /** The wording actually approved for public use. */
  readonly approvedWording: string;
  /** Specific stronger phrasings that must NEVER be substituted in, and why each is currently false. */
  readonly prohibitedWording: readonly string[];
  /** ISO date this row was last checked against the live source. */
  readonly verifiedDate: string;
}

export const PUBLIC_CLAIM_REGISTRY: readonly PublicClaim[] = [
  {
    id: "trial-balance-review-scope",
    claimText: "Upload, check and review the accounts in your trial balance.",
    evidenceSource:
      "src/lib/workspace/moduleAvailability.ts (TRIAL_BALANCE_REVIEW — the only customer-reachable service: Prepare and Reconcile) + supabase/functions/process-trial-balance/index.ts (import, checks, classification) + src/lib/workspace/trialBalanceVerdict.ts (check verdict) + src/components/AccountReviewPanel.tsx (recorded account decisions), all reached from the Prepare stage",
    evidenceScope:
      "Proves a trial balance can be imported, checked and its unresolved accounts reviewed with a recorded decision. Does NOT prepare financial statements, certify a close, issue a Reporting Pack, analyse variance, forecast, compute tax or prepare any filing — those modules are withheld from customers (moduleAvailability.ts) until their authority is complete.",
    approvedWording: "Upload, check and review the accounts in your trial balance.",
    prohibitedWording: [
      "financial statements",
      "statement of financial position",
      "close certification",
      "certified close",
      "reporting pack",
      "variance",
      "forecast",
      "close insights",
      "tax computation",
      "compliance review",
      "filing pack",
      "framework-aware statements",
      // Carried from the retired statement, export and certification rows: never substituted in.
      "IFRS-certified",
      "audited under IFRS",
      "fully compliant",
      "statutory compliance",
      "complete financial statements",
      "asc 606",
      "asc 958",
      "XBRL",
      "iXBRL",
      "filing-ready",
      "audit-ready",
      "audit assurance",
      "provides an audit opinion",
      "auditor-certified",
      "12 independent audit opinions",
      "integrity guarantee",
    ],
    verifiedDate: "2026-10-02",
  },
  {
    id: "evidence-reconciliation",
    claimText: "reconcile it to supporting evidence",
    evidenceSource:
      "src/components/safisha/SafishaGate.tsx (mounted in the Prepare stage) → supabase/functions/safisha-ingest, safisha-match (bank / mobile-money / subledger evidence matched to the trial balance; trial_balance_uploads.safisha_status records the outcome)",
    evidenceScope:
      "Proves supporting evidence can be uploaded and matched to the trial balance, with exceptions held for resolution. Does NOT prove the evidence is complete for the period, and is not an audit of it.",
    approvedWording: "reconcile it to supporting evidence",
    prohibitedWording: ["fully reconciled books", "audit-ready", "guaranteed match"],
    verifiedDate: "2026-10-02",
  },
  {
    id: "attributable-review-decisions",
    claimText: "Review decisions are associated with authenticated user accounts.",
    evidenceSource:
      "supabase/functions/_shared/auth.ts validateAuth() — the actor is derived server-side from the verified JWT, never from the request body; account_review_decisions rows are written with that server-resolved actor (supabase/migrations/20260816120000_account_review_authority.sql, resolve_account_review_batch)",
    evidenceScope:
      "Proves a recorded review decision carries a server-resolved authenticated account. Does NOT prove that every write in the system is attributed, does not establish any approval hierarchy, and does not substitute for an organisation's own review policy.",
    approvedWording: "Review decisions are associated with authenticated user accounts.",
    prohibitedWording: [
      "every action",
      "all actions",
      "every decision",
      "blockchain-verified identity",
      "biometric verification",
      "four-eye",
      "unbroken audit trail",
    ],
    verifiedDate: "2026-09-24",
  },
  {
    id: "source-file-fingerprinting",
    claimText: "A SHA-256 fingerprint is recorded for supported trial-balance imports.",
    evidenceSource:
      "supabase/functions/process-trial-balance/index.ts — sha256HexBytes(fileBuffer) is computed server-side and persisted as trial_balance_uploads.source_file_hash for each processed upload (search: sourceFileHash)",
    evidenceScope:
      "Proves a hash of the imported file is computed and stored for the supported CSV/XLSX import path. Does NOT prove the stored file cannot be changed, does not prove continuous re-verification, and says nothing about files arriving by any other route.",
    approvedWording: "A SHA-256 fingerprint is recorded for supported trial-balance imports.",
    prohibitedWording: [
      "tamper-proof",
      "immutable",
      "cryptographically immutable evidence",
      "bulletproof",
    ],
    verifiedDate: "2026-09-24",
  },
  {
    id: "historical-output-protection",
    // Stated in the FAQ answer on lapsed subscriptions (the Close Assurance grid that also carried it was retired).
    claimText:
      "Supported historical outputs remain readable under the defined lifecycle and subscription rules",
    evidenceSource:
      "src/lib/financialStatementsWorkspace/savedVersions.ts + exports.ts (a persisted report version keeps its own evaluation lineage and content hash) and src/lib/commercial/entitlementContract.ts, whose resolution gates new privileged actions rather than reads of already-persisted versions",
    evidenceScope:
      "Proves persisted versions are addressable and retain their lineage under the current rules. Does NOT promise perpetual availability independent of those rules, and is not a data-retention or escrow commitment.",
    approvedWording:
      "Supported historical outputs remain readable under the defined lifecycle and subscription rules",
    prohibitedWording: ["forever", "perpetual access", "guaranteed retention"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "import-formats",
    claimText: "Trial balances import from CSV and XLSX",
    evidenceSource:
      "supabase/functions/process-trial-balance/index.ts — the ingestion path parses CSV and XLSX workbooks and records rejected rows; src/lib/workspace/sourceUpload.ts is the only browser path that reserves and registers such a source",
    evidenceScope:
      "Proves those two input formats are accepted by the live import path. Does NOT promise that an arbitrarily structured spreadsheet will map without review, and does not cover PDF or scanned sources.",
    approvedWording: "Trial balances import from CSV and XLSX",
    prohibitedWording: ["any format", "any spreadsheet", "automatic with no review"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "commercial-structure-unverified",
    claimText:
      "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer.",
    evidenceSource:
      "src/lib/commercial/featureRegistry.ts + entitlementContract.ts describe the feature vocabulary and resolution, but no server-side entity-count or named-user-count enforcement exists (the candidate BEFORE INSERT trigger was removed in the Ω1-R repair pass and company creation is unrestricted), additional-user billing is unimplemented, and commercial_platform_state remains PAYMENTS_DISABLED so src/components/commercial/CheckoutUpgradeButton.tsx fails closed",
    evidenceScope:
      "This row supports a DISCLOSURE, not a capability. It is the reason no price, offer or availability field appears in any structured data, metadata, or sitemap entry on this site.",
    approvedWording:
      "Entity limits, named-user capacity and self-serve payment activation are undergoing final enforcement verification. This preview is not a public commercial offer.",
    prohibitedWording: [
      "no credit card",
      "cancel anytime",
      "money-back guarantee",
      "start in seconds",
      "in minutes",
      "direct invoicing available",
    ],
    verifiedDate: "2026-09-24",
  },
] as const;

export function findPublicClaim(id: string): PublicClaim | undefined {
  return PUBLIC_CLAIM_REGISTRY.find((c) => c.id === id);
}
