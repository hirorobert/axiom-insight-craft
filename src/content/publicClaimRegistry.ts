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
    id: "framework-aware-preparation",
    claimText: "framework-aware",
    evidenceSource:
      "src/lib/accounting/frameworkAdapter.ts (CompanyReportingFrameworkDbValue: ifrs_for_smes | full_ifrs | ipsas_accrual | ipsas_cash) + src/lib/financialStatementsWorkspace/frameworkProfiles.ts — the selected framework drives statement presentation and which preparation checks apply",
    evidenceScope:
      "Proves a framework selection exists and changes presentation and checks. Does NOT prove conformance with any standard, does not prove an external review of the output, and does not prove completeness of any disclosure set.",
    approvedWording: "framework-aware",
    prohibitedWording: [
      "IFRS-certified",
      "audited under IFRS",
      "fully compliant",
      "statutory compliance",
      "complete financial statements",
      "asc 606",
      "asc 958",
    ],
    verifiedDate: "2026-09-24",
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
    id: "controlled-access",
    claimText: "Access decisions are evaluated through authenticated workspace permissions.",
    evidenceSource:
      "src/lib/workspace/workspaceAccess.ts + src/components/workspace/WorkspaceAccessGate.tsx reading the server resolver get_workspace_access(workspace); supabase/migrations/20260923130000 defines it (owner / accepted member / explicit capability grant) and it fails closed on an unresolved state",
    evidenceScope:
      "Proves access is decided by a server resolver over authenticated identity, and that an unresolved answer denies. Does NOT prove the absence of defects, is not a penetration-test result, and is not a security certification of any kind.",
    approvedWording: "Access decisions are evaluated through authenticated workspace permissions.",
    prohibitedWording: ["soc 2", "soc2", "hipaa", "guaranteed", "zero errors"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "workspace-separation",
    claimText: "Workspace access rules separate entity and engagement data.",
    evidenceSource:
      "Row-level security policies on the tenant tables plus assertCompanyMembership() in supabase/functions/_shared/auth.ts, which every financial-write function calls before touching a company's rows",
    evidenceScope:
      "Proves per-workspace scoping is enforced in the database and re-checked in server functions. Does NOT claim physical or infrastructure-level isolation, and does not claim encryption of any store.",
    approvedWording: "Workspace access rules separate entity and engagement data.",
    prohibitedWording: ["encrypted storage", "air-gapped", "physically isolated"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "controlled-upload-lifecycle",
    claimText:
      "Uploads follow defined active, replacement, retirement, discard and recovery states.",
    evidenceSource:
      "supabase/migrations/20260923100000_upload_lifecycle_retire_and_replace.sql — trial_balance_uploads.lifecycle_state is CHECK-constrained to 8 server-authoritative states, changed only by the migration backfill, the certification trigger, the processing-start derivation and the SECURITY DEFINER lifecycle RPCs (retire / cancel replacement / restore); client roles are refused (42501)",
    evidenceScope:
      "Proves the state set and that transitions are server-controlled. Does NOT prove indefinite retention of a discarded source, and does not promise recovery after a discard has become terminal.",
    approvedWording:
      "Uploads follow defined active, replacement, retirement, discard and recovery states.",
    prohibitedWording: ["never deleted", "permanent archive", "impossible to overwrite"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "historical-output-protection",
    claimText:
      "Supported historical outputs remain readable under defined lifecycle and subscription rules.",
    evidenceSource:
      "src/lib/financialStatementsWorkspace/savedVersions.ts + exports.ts (a persisted report version keeps its own evaluation lineage and content hash) and src/lib/commercial/entitlementContract.ts, whose resolution gates new privileged actions rather than reads of already-persisted versions",
    evidenceScope:
      "Proves persisted versions are addressable and retain their lineage under the current rules. Does NOT promise perpetual availability independent of those rules, and is not a data-retention or escrow commitment.",
    approvedWording:
      "Supported historical outputs remain readable under defined lifecycle and subscription rules.",
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
    id: "export-formats",
    claimText: "exported as XLSX, PDF, CSV and structured JSON",
    evidenceSource:
      "src/components/ExportStatements.tsx (XLSX via the xlsx writer, PDF via jsPDF/autoTable) and src/lib/financialStatementsWorkspace/exports.ts (canonicalJsonExport, toCsv-backed findings/budget CSV) — both reached from the Statements stage",
    evidenceScope:
      "Proves these four outputs are produced by code reachable from the interface. Does NOT include any structured regulatory filing format: supabase/functions/generate-xbrl exists but depends on an external worker and is not reachable from the interface, which is why it is absent from the page.",
    approvedWording: "exported as XLSX, PDF, CSV and structured JSON",
    prohibitedWording: ["XBRL", "iXBRL", "filing-ready", "audit-ready", "audit assurance"],
    verifiedDate: "2026-09-24",
  },
  {
    id: "close-certification-internal-record",
    claimText: "It is not an external audit, an audit opinion, or any form of statutory assurance.",
    evidenceSource:
      "supabase/functions/hesabu-validate/index.ts evaluates the H-01..H-12 preparation assertions and tb_certifications records the outcome inside the workspace; no external party, opinion, or regulator submission exists anywhere in this repository",
    evidenceScope:
      "Proves certification is an internal, workspace-scoped preparation record. Deliberately claims nothing further — this row exists to keep the DISCLAIMER present, not to support a positive assurance claim.",
    approvedWording:
      "It is not an external audit, an audit opinion, or any form of statutory assurance.",
    prohibitedWording: [
      "audit opinion",
      "auditor-certified",
      "12 independent audit opinions",
      "integrity guarantee",
    ],
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
