# Financial-statements publication integrity gate (fs-integrity-r1) — record

Assignment: establish and repair the trust boundary from an uploaded trial balance to an official financial-statement
publication. Base: `origin/main` `b2dc21d` (2026-10-23). Branch: `fix/fs-publication-integrity-gate-20261023`.
Evidence labels: SOURCE-INSPECTED / EXECUTED-LOCAL (embedded PostgreSQL 16, the whole migration chain, the real
`process-trial-balance` handler, the browser's own client code in process) / CI-PROVEN / HOSTED-VERIFIED / NOT RUN.
Nothing here was merged, applied to a hosted project, deployed or published.

## A. Verdict

**NOT READY for production as a whole; READY WITHIN VERIFIED SCOPE for the repaired boundary on disposable infrastructure.**

Verified scope: an IFRS for SMEs (2015 edition) report derived from the authoritative certified trial balance of one
annual period with one comparative, saved by the reporting workbench, reviewed and finalised through
`fs_set_publication_state`, and issued as the server-sealed official Reporting Pack — on the embedded database, with
simulated `auth.uid()` (the mechanism PostgREST uses) and an in-memory model of the private bucket. Outside that scope
nothing new is claimed: hosted application, hosted grants, the real Edge runtime, Storage and GoTrue are NOT RUN here
(the CI "Real application end to end" job exercises the real stack for the honest journey when the PR runs).

## B. The actual path (as traced at `b2dc21d`)

| Transition | Authority (owner) | Actor / authorisation | Consistency boundary | Revision binding | Browser conclusions trusted? |
|---|---|---|---|---|---|
| Upload → persisted source | `trial_balance_uploads`, Storage (edge `process-trial-balance`, service role) | member; `validateAuth` + membership | one row + object; idempotent `clientRequestId` | `source_file_hash` | no (bytes re-read by the server) |
| Parsing / validation / finding resolution | `tb_certifications`, `engine_runs`, finding decisions (`20261118100000`) | preparer decisions; certification by the engine only | engine run; `tb_signoff_rules_blocker` refuses pre-generation-7 results at sign-off | engine generation, input hash | no |
| Account mapping / review | `account_mappings`, `account_review_decisions` (`resolve_account_review_batch`) | member; batch atomic | one transaction | certification id | no (server recomposes from mappings) |
| Accounting treatment / adjustments | Close Review (`20261013`–`20261015`): findings, two-person adjustment approval, revalidation | proposer ≠ approver (policy) | request-id replay | `certification_id` | no |
| Statement compilation | `fs_statement_composition` (memoised per transaction), `fs_evidence_statements` (SCF/SOCIE/perimeter/ledger roll-forward), `fs_notes_status`, `fs_comparatives_status`, `fs_reporting_dependencies` | reads under membership | one transaction per call | `dependenciesSha256` over every input identity | **before this change: partly** — the document's facts outside the four statements and its header were never compared (see C.1) |
| Evidence assessment | `financial_evidence_batches` via `fs_commit_revision` only; per-account ledger roll-forward | member with `prepare_close`, rollout on | atomic with the version; lineage advisory lock; idempotency key; `REPLAY_CONFLICT` | `evidence_batch_ids`, superseded detection | no (server recomputes) |
| Review | `fs_set_publication_state('REVIEWED')`, reviewer comments (`20261112`) | `review_close`; blockers re-evaluated under the lineage + version locks | one transaction; append-only publications; `fs_bind_publication` trigger | binding = document SHA-256 + dependencies SHA-256 + approver | **before: a preparer could withdraw a review (C.3) and clear findings (C.2)** |
| Finalisation | `fs_set_publication_state('FINAL')` | `approve_certification`; separate approver unless recorded `solo_owner`; latest version only | same locks; FINAL immutable; a correction is a new version | same | no |
| Official export | `issue_official_reporting_pack` → Edge `seal-reporting-pack` (service role, user from JWT) → `prepare_official_reporting_pack` / `seal_reporting_pack_server` (database renders and hashes the canonical document) | `issue_reporting_pack` + plan features; workspace access for verify/retrieve | issuance row lock; seal once; no overwrite | `final_publication_id`, canonical SHA-256 | **before: a superseded FINAL could be issued again (C.4)** |

Missing stages, stated: there is no XBRL/iXBRL or regulator filing producer in the supported slice (filing is withheld);
no recognition/measurement engine exists (presentation of reviewed accounts only); the legacy statements workspace
(`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`) is unrouted but its RPCs (`fs_save_report_version`,
`fs_save_evaluation`, `fs_append_decision`, `fs_apply_correction_group`) remain executable by members and were used
here as the tampering client (they bypass nothing the server checks at sign-off after this change).

## C. Evidence table

| Invariant | Prior behaviour (reproduced) | Reproduction | Implemented control | Test evidence | Remaining limitation |
|---|---|---|---|---|---|
| C.1 Every figure and header of a signed document is the server's | `fs_publication_blockers` v5 compared server figures only with facts **bound on the four statements**. A document saved with an empty browser evaluation and (a) a fabricated PPE note figure, (b) a second "version" of closing cash with another amount (the browser renders the highest version), (c) every fact re-denominated to USD / one fact rescaled, (d) the presentation currency relabelled, (e) the period or comparative header re-dated, (f) `provenanceOrigin` relabelled — was **ready with no blocker** and REVIEWED was accepted | `publicationIntegrityGate.mjs` W1 with `INTEGRITY_GATE_ABSENT=1`: each case `{"ready":true,"blockers":[],"ref":null}` | `20261123100000` — blockers v6 "document closure": `DOCUMENT_FACT_NOT_COMPOSED`, `NOTE_FACT_NOT_COMPOSED`, `DOCUMENT_FACT_DENOMINATION`, `DOCUMENT_CURRENCY_MISMATCH`, `DOCUMENT_PERIOD_MISMATCH`, `DOCUMENT_PROVENANCE_MISMATCH`; `fs_report_readiness`, `fs_set_publication_state` and the binding trigger all follow | EXECUTED-LOCAL: W1 8/8 refused by name with the gate; H0 shows the honest document's 154 facts are exactly the 154 server figures; `publicationControls.mjs` 50/50, `reviewWorkflow.mjs` 33/33, `signoffBinding.mjs` 19/19 and `run.mjs` 279/279 unchanged on the new chain | Text (wording, policies, checklist text) is preparer-supplied and is not verified against anything but the recorded disclosure texts' presence; the entity's legal name in the header is browser-supplied (no server authority for it exists) |
| C.2 Only a reviewer clears a blocking finding | `fs_append_decision` accepted `ACCEPT_FINDING` / `REJECT_FINDING` from any member holding `prepare_close`; `fs_unresolved_blocking_count` then dropped the finding | W2 absent: `{"a":null,"b":null,...,"n":2}` (both decisions recorded by the preparer) | `fs_append_decision` v2: `review_close` required for ACCEPT/REJECT (42501); DEFER / REQUEST_EVIDENCE unchanged | EXECUTED-LOCAL W2 3/3; `run.mjs` (partner decisions) unchanged | The browser-supplied evaluation remains an *additional* gate, not an authority: after C.1 no supported rule depends on it for figure integrity |
| C.3 Only a reviewer withdraws a recorded review | `fs_set_publication_state` checked no capability for `DRAFT`: a preparer moved a REVIEWED version back to DRAFT | W3 absent: `{"ref":null,"pub":["REVIEWED","DRAFT"]}` | v3: `DRAFT` on a REVIEWED version needs `review_close` (42501); nothing else changes (replay, FINAL immutability, lineage lock) | EXECUTED-LOCAL W3 3/3; `publicationConcurrency.mjs` text unchanged in its locked region | — |
| C.4 A superseded FINAL is never issued officially again | `_final_publication_for` found the FINAL of the exact version named; after a later version of the lineage was FINAL, the earlier one was still issued and sealed as official, and verify/retrieve disclosed nothing | W4 absent: issue → `issued`; the pre-opened issuance → `sealed`; verify `superseded:false` | `issue_official_reporting_pack` v2 + `_reporting_pack_seal_refusal` v2 → `superseded_final_version` (audited `REFUSED SUPERSEDED_FINAL_VERSION`); `reporting_pack_sealed_object` v2 + Edge module → `superseded` disclosed on verify/retrieve (official status of an intact pack unchanged); `fs_list_saved_versions` v2 → `supersededByFinal`; pages word it | EXECUTED-LOCAL W4 8/8 (issue, pending seal, verify, retrieve, list, new FINAL issues, outsider refused); unit tests `reportingPackSeal.test.ts` (superseded disclosure, 409 refusal) | The deployed Edge Function (closure `dd4f0855…`) does not read `superseded` and answers 500 on the seal-stage refusal until redeployed (closure `6c62bdcd…`); the database refusal holds regardless |
| C.5 Honest workflow still reaches FINAL and an official pack | — | — | — | EXECUTED-LOCAL: H0 + W4 happy path (ready → REVIEWED → FINAL → issued → sealed → verify intact/official → retrieve same bytes); I: FINAL document, hash and bindings byte-identical afterwards; audit rows carry the actor | Hosted browser acceptance NOT RUN |
| C.6 Concurrency, replay, idempotency | Already controlled (`fs_commit_revision` lineage lock + idempotency key + `REPLAY_CONFLICT`; `fs_set_publication_state` lineage + version locks, exact replay; `fs_apply_correction_group` atomic) | — | unchanged | SOURCE-INSPECTED; existing `publicationConcurrency.mjs` C1–C6 not re-run here | — |
| C.7 Tenant / role isolation | Already controlled (`fs_actor_member_id`: accepted member, `prepare_close`, current plan, rollout; `workspace_capability_allowed`; RLS) | — | unchanged | EXECUTED-LOCAL: outsider `not_found` / `workspace_access_denied` (W4); existing K cases in `publicationControls.mjs` | — |

## D. Commands run and results (2026-10-23, this machine; CI not yet run on the branch)

| Command | Result |
|---|---|
| `DB_PROOF_MODULES_DIR=… bun scripts/db-proof/publicationIntegrityGate.mjs` | **31/31 PASS** |
| `INTEGRITY_GATE_ABSENT=1 … bun scripts/db-proof/publicationIntegrityGate.mjs` | **16/30 PASS, 14 FAIL — exactly W1 (8), W2 (1), W3 (1), W4 (4)**: the prior behaviour, recorded |
| `bun scripts/db-proof/publicationControls.mjs` | 50/50 PASS (new chain) |
| `bun scripts/db-proof/reviewWorkflow.mjs` | 33/33 PASS (new chain) |
| `bun scripts/db-proof/signoffBinding.mjs` | 19/19 PASS (new chain) |
| `node scripts/db-proof/run.mjs` (financial-statements persistence proof) | 279/279 PASS (new chain) |
| `bunx tsc --noEmit -p tsconfig.app.json` | 0 errors |
| `bunx eslint` (changed source files) | 0 errors (pre-existing warnings only) |
| `bunx vitest run` — `reportingPackSeal`, `verifyDeployedClosure`, `closureText`, `billingTriggerRepairMigration`, `migrationReplayCompatibilityGuard`, `persistenceMigrationContract`, `migrationAuthority`, `tbStagedTransport`, `releaseJournal`, `src/lib/reporting/**`, `releaseScans`, `databaseInert`, `claudeFileMap` | all pass (`migrationAuthority` and `activation` time out under full-suite load and pass alone — a known trait) |
| Full `bun run test`, `bun run build`, pack-isolation guard, Deno tests, real-stack e2e | NOT RUN locally (CI on the pull request) |

## E. Deployment sequence (preparation only; nothing here was executed against a hosted project)

Prerequisites: hosted journal at 0074 with `fs-controls-r1` … `fs-memo-r1` (0065–0069) and the TB batches applied;
a fresh backup / point-in-time mark; the owner's journalled apply route (never the SQL-editor paste of the source).

1. **Register the batch** (`fs-integrity-r1`) in `scripts/release/selfCheckingWrapper.mjs` / `scripts/ci/releaseJournal.mjs`
   from the merge commit's bytes, generate `release/wrappers/20261123100000_….wrapper.sql`, run `selfCheckingWrappers.mjs`
   for it in CI. (Not done on this branch: the wrapper pins a source commit that does not exist until merge.)
2. **Preflight** — `docs/release/fs-integrity-r1/preflight.sql` (read-only) must print `PREFLIGHT OK`; keep its two listings.
3. **Apply** `20261123100000_fs_publication_integrity_gate.sql` through the journalled route (one transaction; its own
   preflight refuses a double apply and a missing predecessor; its postcondition raises on any deviation).
   Lock profile: `CREATE OR REPLACE FUNCTION` only — no table, index or policy change, no backfill, no long lock.
4. **Postcondition** — `docs/release/fs-integrity-r1/postcondition.sql` must print `POSTCONDITION OK`; the two listings
   byte-identical to the preflight's.
5. **Publish the frontend** (blocker wording, superseded disclosure on the Sign-off and Exports pages). Order relative to
   step 3 is free: an older frontend shows the new blocker codes verbatim with the generic sentence.
6. **Redeploy `seal-reporting-pack`** (required closure `6c62bdcd…`, `scripts/release/verifyDeployedClosure.mjs`). Until
   then the hosted function still issues/verifies/retrieves and the database still refuses a superseded issuance; it
   answers HTTP 500 with `outcome: superseded_final_version` on that refusal and does not disclose `superseded`.
7. **Monitor** — `financial_statement_audit_events` (`PUBLICATION_STATE_SET`), `reporting_pack_issuance_events`
   (`REFUSED` with `SUPERSEDED_FINAL_VERSION`), and the first readiness answers after the apply: a `DOCUMENT_*` blocker
   on a version the owner believes honest is an incident (it means the stored document was not built by the workbench).
8. **Recovery** — forward-only. Nothing is deleted or rewritten; a refusal leaves no partial state. If the gate refuses a
   legitimate case, the company is deactivated (`docs/release/sql/04_deactivate_company.sql`) while a forward
   migration redefines the one function; the previous function texts are in `20261115100000`, `20260919110000`,
   `20261111100000` and `20260925140000` for a reviewed forward re-install, never an ad-hoc edit.

## F. Unresolved production blockers (by consequence)

1. **Hosted application, deployment and acceptance of this gate are not done** — the repaired boundary exists only in
   source and on disposable databases; until applied, C.1–C.4 remain open on the hosted project.
2. **A second report LINEAGE of the same company, period and provenance can still reach FINAL** (`financial_statement_reports`
   has no per-period lineage rule; `_fs_prior_final_differences` takes the latest FINAL by publication order). The honest
   pages always extend the first lineage; a crafted client could finalise two lineages whose figures are identical (both
   bound to the same server figures) but whose wording differs. Needs its own proof pass (several existing proofs create
   parallel draft lineages) — registered, not repaired.
3. **The browser-supplied evaluation is still stored and still gates** (`BLOCKING_FINDINGS`, `RECONCILIATION_UNMET`), and the
   legacy `fs_save_evaluation` can append another evaluation to a version. After C.1 no supported figure or header depends
   on it; it remains an additional, non-authoritative gate. Retiring the legacy write RPCs needs the persistence proof
   (`run.mjs`) and the loopback bridge rewritten — out of this pass.
4. **Preparer-supplied text is not verified beyond presence**: disclosure wording, policies and the entity name are the
   preparer's; qualified accounting review of recognition, measurement and disclosure adequacy remains necessary
   (`docs/reporting/review-package/`, 0 VALIDATED rows). No IFRS / IFRS for SMEs / IPSAS compliance is claimed.
5. **Deployed Edge closure** — `seal-reporting-pack` hosted closure `dd4f0855…` predates the `superseded` disclosure (E.6).
6. Pre-existing registered defects and go-live gates are unchanged (`CLAUDE.md` §9.1–9.2: KINGA mapping tenancy, SAFISHA
   ledger gap, MAONO tables, legal review of Terms/Privacy, SMTP).
