# IPSAS accrual implementation work record

Base: `db6cef701b0856b98cd485d30431ac7b1137f2e4`; isolated branch `feat/ipsas-accrual-ngo`.

Owner direction on 2026-10-29: develop IPSAS accrual for NGOs; full IFRS deferred. No paid API/Lovable usage, merges, hosted writes, installations or activation are authorised by this candidate. Existing SME controls and all installed SQL stay intact.

## Step 0 facts and gaps

| Boundary | Source | Verified result |
|---|---|---|
| composition gate | `supabase/migrations/20261018100000_fs_statement_composition.sql:141` | SME-specific production boundary; no IPSAS hosted integration claimed. |
| composition parser | `src/lib/statements/composition.ts:39` | SME-specific production boundary; no IPSAS hosted integration claimed. |
| assembler family | `src/lib/financialGeneration/composedReport.ts:125` | SME-specific production boundary; no IPSAS hosted integration claimed. |
| compiler gate | `src/lib/reporting/serverCompilation.ts:49` | SME-specific production boundary; no IPSAS hosted integration claimed. |
| kernel publication guard | `release/candidates/framework-kernel-r1/kernel.ts:143` | Existing source evidence; not an assertion of hosted installation or accounting validation. |
| prior capture | `src/components/reporting/EquipmentPreparation.tsx:196` | Existing source evidence; not an assertion of hosted installation or accounting validation. |
| equipment SQL | `supabase/migrations/20261206100000_fs_equipment_multiclass.sql:14` | Existing source evidence; not an assertion of hosted installation or accounting validation. |
| coverage | `docs/reporting/COVERAGE_IFRS_FOR_SMES.md:14` | Existing source evidence; not an assertion of hosted installation or accounting validation. |

Production composition, notes, compiler and issuance are NOT framework-neutral. The prior framework kernel is an inert proof, not a live engine. All later work must close these boundaries together and preserve existing SME receipt identities.

## Work plan and charter

Applicable: P1/P2/P4/P5/P6/P7/P8; R1/R2/R4/R6/R7/R8/R11/R12/R13; G1-G9; B2/B3/B4/B5/B6. A-01 is a PROPOSED priority/scope amendment, not fabricated adoption or accounting approval.

1. Implement strict IPSAS period/adoption profiles, a completeness-aware topic inventory, source/evidence-bound preparation calculations and a synthetic NGO case.
2. Exercise exact amounts, missing facts, contradictory evidence, scope/period changes, unsupported accounting cases and provenance; keep issuance unconditionally unavailable in this candidate.
3. Produce the actual remaining integration/standards-content gaps. Do not mark a topic-level inventory as complete paragraph-level coverage.

## Acceptance that remains necessary for a complete product

- Authenticated persisted NGO preparation, versioned accounting-approved requirement universe, author/reviewer appointments and licensed source use as necessary.
- IPSAS composition/notes/compilation/approval/issuance on the full migration chain, including direct-RPC, replay, concurrency, stale inputs and existing FINAL preservation proofs.
- Real authorised NGO evidence and a second materially different NGO; qualified accounting acceptance and no-coaching browser acceptance.
- Exact-byte forward transport and independent release approval before any installation. Deployed-source attestation remains unresolved; no self-declared digest substitutes for it.

## Verification

Implemented candidate and synthetic fixtures: see `release/candidates/ipsas-accrual-r1/README.md` and `SOURCES.md`. Proposed amendment: `docs/architecture/amendments/A01_IPSAS_NGO_PRIORITY.md`.

The canonical adapter produces four incomplete draft statements and exercises the existing numerical rule engine. Budget remains outside the canonical document; complete notes, policies, accounting-reviewed paragraph coverage and production integration are absent. Supplied evidence actors are not authenticated sign-ins. No universal compliance claim is made.

Local verification on the candidate contents:
- Candidate tests: 75 deterministic tests (included in full-suite result below).
- Candidate and application TypeScript checks: pass.
- Lint: zero errors, 180 existing warnings; production build passes.
- Pack isolation, single lockfile, migration authority and release journal: pass; no migration is added.
- Offline demo: assets 2,300,000, liabilities 500,000, net assets 1,800,000, revenue 1,200,000, expenses 700,000 and surplus 500,000 in TZS minor units (scale two); position difference zero. Output retains 39 explicit preparation/release blockers.
- No PostgreSQL proof, authenticated IPSAS browser journey, qualified accountant review, hosted deployment/attestation or live issuance was performed.
- Full suite: 6,746 passed; 10 skipped and 12 todo, across 403 passing files and one skipped file. No new failures.

## Exact next acceptance work

Implement authenticated persistence and server recomputation before any customer journey; complete and independently review the requirement register and applicable transaction workpapers; add canonical budget/presentation/notes and comparative transitions; then integrate compiler/authority/frozen issuance. A synthetic arithmetic success does not complete these tasks. Existing SME accounting output and installed migrations are unchanged.
