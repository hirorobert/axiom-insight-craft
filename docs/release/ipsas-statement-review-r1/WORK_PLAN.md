# Authenticated IPSAS statement review

Baseline #227 at d235708620c37467a38863b2cf1092f835988d82 (rebased from #224 at a992cad). Preserved Claude's actor-bound page/client and all four mutation fixes; reused `_ipsas_authorize_mutation` rather than introduce a competing lock protocol. Read AGENTS.md and charter v4 before implementation. Adoption and accounting appointments remain unrecorded. User authorized implementation of the next server-owned signed-in review slice, not merge/install/deploy/publication/activation or paid services.

Applicable: P1/P2/P6, R1/R2/R7/R8/R10/R12/R13, G1/G2/G5/G9 and sections 11.1, 11.3–11.5. Reuse the existing authoritative certification, adjusted-account, period/currency, capability and lock helpers. Do not trust browser amounts, confirmations, hashes or readiness flags. Keep every issued SME version unchanged.

## Facts / gaps

- Existing signed-in route: `/workspace/:companyId/:periodYear/ipsas`, `src/pages/workspace/IpsasPreparationPage.tsx`.
- Existing server input: `_fs_reporting_input_compute`, including authoritative certifications, exact period/currency metadata, approved adjustments and current/prior adjusted account rows. It does not resolve an IPSAS edition or complete IPSAS workpapers.
- Existing `_fs_statement_composition_compute` resolves SME editions and cannot honestly serve IPSAS. Its presentation tables restrict the family to SMEs.
- Existing IPSAS PPE/grants revisions and assessments are separate preparation records. They do not provide verified cash-flow, component-net-assets, budget or full comparative-transition inputs.
- #226 is an offline composition candidate, not an authenticated source adapter. Do not import its user-supplied confirmation assertions into production.

## Owned slice

Add IPSAS-only append-only presentation revisions and authenticated review/save RPCs. Compose financial-position and financial-performance captions on the server from adjusted, authoritative accounts. Record explicit presentation choices rather than infer captions from names. Current and prior currency/period incompatibility remains visible; prior certified TB figures are labelled reference-only, never audited comparatives. Show unprepared cash flow, component net assets, budget and disclosures as explicit gaps.

Add a separate statement-review component to the existing signed-in IPSAS page with real source tracing, refresh, presentation choices and safe save/retry. Leave Claude's existing IpsasPreparation, GrantsPreparation, migrations and transports untouched. Update only the page wrapper as the integration point. No approval/issuance action is exposed.

Proofs: disposable PostgreSQL with real processing, permissions/direct-RPC/cross-company/role refusals, adjusted rows, exact arithmetic, stale inputs and revisions, retries, revoked permissions while waiting, preserved SME records; component recovery/concurrency, real server contracts, typecheck/build/guards. New migration remains unapplied and must be reviewed and installed through exact-byte transport before the new RPC can work hosted. Do not repeat old transports or register fictitious hosted history.
