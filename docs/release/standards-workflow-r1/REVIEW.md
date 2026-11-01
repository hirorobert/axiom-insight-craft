# Standards sources and preparation workflow — 2026-11-01

Scope: metadata/source assessment and a frontend preparation-context repair. No standards text, taxonomy labels or supplied binaries are redistributed. No new accounting rule, framework support, SQL, compiler, approval, issuance or hosted setting is introduced.

## Applicable project rules

Read AGENTS.md and development charter v4. The charter remains proposed; this does not record adoption. This increment follows the existing server-authority boundary and the charter's P1/P2/P6, R6/R8/R13, G7/G9 and §11.5: one server edition, explicit denomination, source-bound preparation, an actionable recovery path and no unsupported compliance claim. It is not an engine rewrite or a new delivery-priority amendment.

## Source assessment

| Owner-supplied material | Verified identity and use | Boundary |
|---|---|---|
| IFRS-for-SMES-2015.pdf | 246 PDF pages, 1,027,941 bytes. SHA-256 `acc6500e58f9090eddc8e2b55bc531f93e718d320c7c40c695898bb82235eb9f`. Matches `SOURCES["smes-2015-text"]` already pinned in `src/lib/frameworkPacks/ifrsForSmes.ts`. Reviewed PDF pages 26 (3.17–3.22) and 42 (8.1–8.5): statement set, comparative presentation and systematic related notes. | The upload verifies an existing source; it does not create new accounting acceptance or establish completeness of the encoded requirement universe. |
| ifrs-for-smes-standard-markup.pdf | 236 PDF pages, 2,083,301 bytes. SHA-256 `35432b4136e53c6630a2426bcacdcfff8e70ae728533c1020f7af0f331de8c9e`. Cover/legal page identifies educational third-edition markup. PDF page 209, Appendix A1, describes the annual-period-start transition date and earlier application disclosure. | Educational change-analysis aid, explicitly not part of the Standard. Verify consequential rules against the issued third edition and jurisdictional adoption. Never silently replace the 2015 pack with markup content. |
| taxonomy-iti-ias1-2025-by-fs.pdf | 259 PDF pages, 3,013,016 bytes. SHA-256 `f46feab9f9d4474669b43ac590a1567c039c935cc65374984f63bfcfa8c1ae99`. The introduction distinguishes hierarchy, data formats, standard references and common-practice entries. | IAS 1-oriented presentation of taxonomy content; not a complete recognition/measurement engine, an SME pack or an IPSAS source. Common-practice concepts do not automatically become required disclosures. |
| IFRSAT-2025 (2).zip | 2,103,003 bytes, SHA-256 `302afc7f69c5f92697ab8d87a6f584406f4addaf7f905468052c280c2fe16d19`. 508 ZIP entries including directories. `META-INF/taxonomyPackage.xml` identifies the IFRS Foundation's final 2025-03-27 package and separate IAS 1, early-IFRS-18, management-commentary, extension and formula entry points. Core schema has 5,512 declared elements; 51 calculation and 97 presentation linkbase files were inventoried. | A concept count is not requirement coverage. Taxonomy imports, presentation trees and calculation relationships do not supply treatment decisions, complete disclosure applicability or certified filing validation. No archive extraction or external schema resolution was used in this assessment. |

Commercial redistribution/use permission must be established before embedding source text or taxonomy content. The current change contains original workflow code and metadata only, not copied policy/note templates.

## Verified progress snapshot (read-only, not deployment attestation)

Repository baseline: `4fb2a78950161b81ae6c89752b230f136d9c45da`, main as cloned on 2026-11-01. PR #229 was previously merged as `b56b91a8`; later merged changes include QuickBooks conversion/Excel reading and registry-backed company currency choices.

Live catalogue checks on the existing project found:
- migration journal head id **99**, hash `d31be75cbcd95962dda56aaea235521668780a8b7cd5a24643bf640c21f4f287`;
- `ipsas_prep_revisions`, `ipsas_grant_revisions`, `ipsas_presentation_revisions`, `trial_balance_source_download_events` present;
- `ipsas_prep_context`, `ipsas_grants_context`, `ipsas_statement_review` and the nine-argument `decide_trial_balance_source_download_issuance` present.

These checks supersede the earlier *paused before grants installation* account for object existence. They do not verify installed function-body identity, Edge Function deployment, frontend publication, customer authorization, accounting acceptance or official issuance.

`docs/reporting/COVERAGE_IFRS_FOR_SMES.md` currently lists 59 encoded requirements per edition, with no entries marked independently VALIDATED. This is the bounded encoded inventory, not every applicable requirement of either edition. `src/lib/reporting/serverCompilation.ts` continues to refuse non-SME publication. Full IFRS and official IPSAS issuance are not enabled by the supplied taxonomy or this change.

## Implemented user-facing improvement

The current reporting reader obtains composition and notes in independent reads. A concurrent change can produce individually valid responses from different editions, periods or source revisions. Previously the preparation pages offered editing without checking that agreement, schedules always selected the 2015 schedule vocabulary, and missing composition silently supplied exponent 2.

Now:
1. Notes and schedules resolve their pack from the server's explicit pack id. No fallback edition is selected.
2. A composed statement snapshot must agree with preparation on pack id, period year and composition fingerprint before editing is offered.
3. A mismatch offers one **Refresh reporting workspace** action through the existing shared reader. Same-scope unfinished notes and schedules remain mounted but hidden and disabled until coherent inputs return, preserving their drafts without permitting interpretation under a different snapshot. The next-action bar names the same recovery. Refresh does not write or approve anything.
4. Schedule denomination comes from the server composition only. Without it, monetary display/entry is unavailable with a concrete explanation instead of assuming two decimals.
5. The selected pack supplies schedule definitions. Editing state is scoped to company, period, pack and (for schedules) currency/exponent.
6. A refreshed note list that no longer contains the selected requirement safely selects an existing row rather than passing an absent row into the editor. A successful save still depends on its server receipt; no value-based success inference is added.

The server remains authoritative and still refuses stale or unauthorized writes. This is a presentation and recovery repair, not a substitute for server transactions or an accounting migration. No automatic applicability decision, generated financial amount, wording or approval is introduced.

## How to use these sources next, within the existing architecture

| Existing workflow | Concrete increment | Acceptance evidence before support expands |
|---|---|---|
| Confirm period/framework | Extend the existing period-start/edition resolver with verified transition and local-adoption decisions where required. | Before/after effective dates, non-calendar periods, early-election authority and missing-adoption refusal. |
| Complete notes | Populate reviewed requirement-to-question/evidence structures by edition; reuse confirmed facts across schedules/notes. | A missing applicable fact creates an actionable task; unrelated disclosures remain unaffected; accountant checks completeness. |
| Review figures | Map approved facts to the selected taxonomy entry point, preserving exact concept, period/context, units and lineage. | A reviewer traces each fact to approved sources; ambiguous mappings remain unresolved; presentation and calculation tests do not assert treatment correctness. |
| Change edition | Use markup to identify candidate change impacts, then validate them against authoritative issued text. | Reassess affected answers/notes and comparatives; preserve original issued reports and record transition decisions. |
| Export/tag | Build a separate, versioned XBRL mapping/validation path; choose IAS 1 versus IFRS 18 explicitly. | Validate with a conformant processor and target filing rules; do not label a PDF or concept mapping as a valid XBRL filing. |
| IPSAS preparation | Reuse task, provenance, scope, money and review infrastructure. Author IPSAS-specific rules from IPSAS sources. | Separate qualified IPSAS review and complete applicable statement/note/treatment acceptance; IFRS taxonomy evidence is not substituted. |

Priority remains the supported report journey and the first evidenced accounting blocker. No new architecture is promised to eliminate every future redesign. No deployment or public compliance claim follows automatically from this document or passing software tests.


## Verification of this increment

- Final full unit suite with synthetic loopback Supabase settings and `unitNetworkGuard.cjs`: **7,237 passed, 10 skipped, 12 TODO**, 433 passed files and 1 skipped. Skipped database cases are not claimed as executed.
- Reporting-focused suite before the final two draft-preservation cases: **566 passed, 10 skipped**. Final workbench file: **29 passed**, including refresh recovery and draft suspension.
- Negative control: the 9 selected edition/denomination/context cases against baseline product files yield **5 failures / 4 passes**; all baseline swaps are restored byte-identically. The full repaired suite passes. These regressions exercise existing behavior, not a standards-compliance claim.
- `tsc --noEmit -p tsconfig.app.json`: passed. Production Vite build: passed (existing chunk-size/Browserslist warnings). Full lint: 0 errors; targeted final lint: 0 errors, with the existing `signedMinor` fast-refresh warning in SchedulesView.
- Existing server authorization, accounting fixture expectations, edition policy, source parsers, request identities, migrations, compiler artifacts and hosted settings are unchanged.
- Local verification is not independent accounting acceptance, hosted deployment or exact-head remote CI. A draft PR is the review handoff; merge and publication remain separate actions.
