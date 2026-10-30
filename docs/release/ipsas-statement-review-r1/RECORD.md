> Historical candidate evidence. The independent review confirmed further defects in the #227/#228 chain. Unapplied PPE/grants source and all three transport fingerprints below are superseded by [the independent review](../ipsas-independent-review/REPORT.md). Existing CI evidence applies to its named commits; it does not validate the repairs. Nothing has been installed or published by this review.

# Authenticated statement review r1 — release candidate

Implementation branch: `feat/ipsas-authenticated-statement-review`. Dependency: remediation #227 at `d235708620c37467a38863b2cf1092f835988d82`; source introduced at `4e664b377a1536033d4a2cfa21a2af5b3375568a`. No merge, hosted installation, deploy, publication, activation or paid service is authorized or performed.

## Implemented

- The existing signed-in `/workspace/:companyId/:periodYear/ipsas` page links to a new statement/presentation section. Claude's preparation and grants components are unchanged. His actor-keyed preparation boundary and per-actor client are preserved; the new section also keys by actor/company/year.
- Server-only composition of financial position and performance from the existing authoritative certifications and approved adjustment layer. Every caption is explicitly chosen, never guessed from names. Contra balances keep their original sign. Unknown/unassigned figures are not reported as zero.
- Append-only presentation revisions, expected revision/source checks, durable request receipts, original-identity retry and actor-scoped session recovery. New edits survive a successful late response; obsolete results cannot start reads or alter another scope. Recovery storage contains presentation intent, not source financial amounts, and never establishes progress or authority.
- Reuses #227's `_ipsas_authorize_mutation` after request/report/TB locks and before replay lookup or insertion. Read-committed mutation boundary; revoked permissions are checked again. Stronger transaction isolation is refused. Only authenticated capability holders reach RPCs; no table/helper/sequence API grants.
- Fingerprints bind actual authoritative accounts, metadata, applicable approved adjustments and presentation revision. Unrelated PPE/grants edits are not dependencies of this two-statement composition and do not invalidate its choices.
- Original and adjusted debit/credit source details, certification and adjustment references, explicit refresh/discard behaviour and navigation protection through the existing task-edit registry.

## Honest scope

These are **trial-balance-derived draft statements**, not full IPSAS. A balanced TB does not establish complete revenue/expenses or a pre-close performance basis. Prior certified TB amounts are labelled reference-only, not audited or restated comparatives. Cash flows, net-assets components, applicable budget/disclosure workpapers, transition rules, accounting validation and frozen issuance remain blocked. There is no approval/issue action or compliance wording.

## Local evidence

- 52 focused client/component/remediation-boundary tests passed, including 26 new client/component cases; Claude's 13 PPE, 10 grants and 3 page-boundary tests are retained.
- Eight new staged-transport guard tests passed.
- TypeScript and targeted lint passed; production build passed (19.91 s on the implementation tree before final documentary/transport additions).
- WASM PostgreSQL 18.6: migration compilation, incomplete-is-not-zero, exact totals, contra credit, receipt replay, issuance=false and selected privilege checks passed **with source/authorization dependency stubs**. This is neither a full native chain nor concurrency acceptance.
- Native PostgreSQL could not start locally: this container cannot create/map the required non-root user. No root-check bypass was used. Native full-chain, multi-session and signed-in browser checks run only in the disposable CI environments. Their final results must be read from the PR; this record does not predeclare success.
- Full-suite and final-SHA CI results are reported in the PR. Skips/setup/operator checks are not product acceptance passes.

## Native / authenticated proof definitions

`scripts/db-proof/ipsasStatementReview.mjs` and its reviewed manifest exercise the real predecessor migration chain, then install the actual source through this release's staged transport. They compare the installed catalogue with direct execution, preserve prior public records, use the real trial-balance processor, and test role/tenant refusals, read-only review, no grants on helpers/table, exact independent totals, approved adjustments, stale choices, duplicate requests, competing revisions, explicit revocation both before and after admission, stricter isolation and append-only history. Test-only insertion barriers are removed afterwards. Results are validated against the manifest, never inferred from an aggregate suite count.

Three additional steps in the real-auth IPSAS browser journey fill presentation choices through the actual page, read the server result, trace the equipment figure and refresh. They use ordinary signed-in clients. Existing user/plan/membership/rollout setup remains operator fixture setup, not proven onboarding. The older carry record remains the #227 baseline evidence; it is not a promise that the old patch reproduces this branch's extended journey.

## Exact-byte installation transport

New private schema `cfoclose_ipsas_statement_release`; no modification to equipment, preparation or grants transports. Protocol follows the prior transport: pin source size/hash, stage immutable bytes, verify exact predecessor, execute with pinned search_path, validate privileges/preservation, consume once atomically.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `20261210100000_ipsas_statement_review.sql` | 19,538 | `ec966e4fd1598f947ccd58b096cde0a1b3f842456aa02acec6bf39db508091c2` |
| Bootstrap | 7,831 | `e61152d988e178d9f52ed3d36ec1d71a3cd22722e391651a07f1cb188a71652a` |
| Apply | 14,295 | `5da9a2604fb7f270c27edf20c5e56ca16adbb48acd10a9821b58386acf7a0bdd` |

Generated by `node scripts/release/ipsasStatementReviewStagedTransport.mjs --write`; `--check` and the unit tests must pass. Do not hand-edit generated SQL.

Expected predecessor is the **revised #227 grants transport**, conditional hosted journal id 95, whose allowed hashes are computed from the registered predecessor generator. No hosted state was re-read here. Bootstrap/apply would occupy 96/97 only if the predecessor is freshly verified and those positions are still next. A moved predecessor refuses, requiring review/regeneration; never bypass it or repeat earlier migrations.

No Drizzle mirror or hosted application is registered in advance. After separately authorized installation, verify preservation, source hashes, privilege matrix and authenticated behaviour, then record the actual mirrors/history and publish the matching frontend separately. No Edge Function deployment is required by this slice.

## Remaining release blockers

Independent code review; successful final-SHA native/real-auth evidence; authorized exact-byte hosted installation and mirror registration; matching frontend publication; authenticated hosted verification. Complete IPSAS accounting/disclosure/transition coverage, qualified accounting acceptance and frozen issuance remain separate platform work. Do not market this increment as complete IPSAS.
