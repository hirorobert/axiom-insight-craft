# Financial-statements publication integrity (fs-integrity-r1) — the combined candidate of PR #191 and PR #192

Assignment: establish and repair the trust boundary from an uploaded trial balance to an official financial-statement
publication, and reconcile PR #191 (the independent server compilation) with PR #192 (document closure, reviewer-only
decisions, superseded-FINAL refusal, one FINAL authority per period, document structure) into one tested candidate.
Base: `origin/main` `b2dc21d72cd50473e572ee497eccb5b5d0128af9`. Branch: `fix/fs-publication-integrity-gate-20261023`
(PR #192; PR #191's branch `codex/report-document-authority` at `0225ee426b48da24cd50e6ca50aea96ab8ac3222` merged in).
Evidence labels: SOURCE-INSPECTED / EXECUTED-LOCAL (embedded PostgreSQL 16, the whole migration chain, the real
`process-trial-balance` handler, the real compiler bundle, the browser's own client code in process) / CI-PROVEN /
HOSTED-VERIFIED / NOT RUN. Nothing here was merged, applied to a hosted project, deployed or published.

## A. Verdict

**NOT READY for production as a whole; COMPLETE WITHIN VERIFIED SCOPE on disposable infrastructure for the combined boundary.**

Verified scope: an IFRS for SMEs (2015 edition) report derived from the authoritative certified trial balance of one
annual period with one comparative, saved by the reporting workbench, compiled by the server (`compile-financial-report`
module in process), reviewed and finalised through `fs_set_publication_state` / `fs_replace_final_authority`, and issued
as the server-sealed official Reporting Pack — on the embedded database, with simulated `auth.uid()` (the mechanism
PostgREST uses) and an in-memory model of the private bucket. Hosted application, hosted grants, the real Edge runtime,
Storage and GoTrue are NOT RUN here (CI's "Real application end to end" job exercises the real stack for the honest
journey when the pull request runs).

## B. The chain and what each migration owns

| Migration | Owner | What it decides | Reads / locks |
|---|---|---|---|
| `20261123100000_fs_server_compilation.sql` | PR #191 | A saved version is recompiled from a bounded server snapshot by the deployed compiler closure (digest pinned: `49fc0852…`); only the service role records the receipt; REVIEWED/FINAL and official issuance need a matching receipt without blocking findings (`fs_server_compilation_blocker`, spliced into `fs_publication_blockers`; triggers `trg_fsp_server_compilation`, `trg_rpi_server_compilation`) | lineage lock (`financial_statement_reports:<report_id>`) |
| `20261124100000_fs_publication_integrity_gate.sql` | PR #192 | Blockers v6 "document closure" (`DOCUMENT_FACT_NOT_COMPOSED`, `NOTE_FACT_NOT_COMPOSED`, `DOCUMENT_FACT_DENOMINATION`, `DOCUMENT_CURRENCY_MISMATCH`, `DOCUMENT_PERIOD_MISMATCH`, `DOCUMENT_PROVENANCE_MISMATCH`) **keeping the 20261123 splice verbatim**; `fs_append_decision` v2 and `fs_set_publication_state` v3 (`review_close` to clear a finding / withdraw a review); superseded FINAL never issued again (`superseded_final_version`), disclosed on verify/retrieve | lineage, version locks (unchanged) |
| `20261125100000_fs_final_authority.sql` | PR #192 | One current FINAL per reporting scope (`company_id`, `period_year`): `fs_report_authority` + append-only `fs_report_authority_events`; first FINAL establishes, same lineage succeeds, another lineage only as the explicit `fs_replace_final_authority` naming the exact replaced version (`AUTHORITY_CONFLICT`, `AUTHORITY_MISMATCH`, `AUTHORITY_REPLACE_SAME_LINEAGE`), legacy conflicts `CONFLICT_DETECTED` → `fs_designate_final_authority`; issue/seal/verify/readiness/versions/comparative read the explicit authority | `_fs_scope_lock(company, period)` FIRST |
| `20261126100000_fs_document_structure.sql` | PR #192 | Blockers v7 = v6 (+ the 20261123 splice) + `_fs_document_structure_blockers`: the whole presentation skeleton (statements, sections, line ids and labels, roles, normal balances, period bindings, casting children, fact period identities, provenance binding, shape; NULL-safe) compared with what the server composes | none new |

Why both controls stay: the compiler refuses a doctored document because no receipt can match it
(`SERVER_COMPILATION_REQUIRED`, then `SERVER_DOCUMENT_MISMATCH`), which depends on the `compile-financial-report`
deployment and the service role; the SQL gates name the exact defect in the saved document (`DOCUMENT_*`) with no such
dependency. In present mode the gate proof asserts BOTH name every tampered document.

**Lock order and linearisation (documented in `20261125100000`, shared by every writer):**
FINAL: scope → lineage → version → `tb_official_output_lock`. Seal: issuance row → scope → `tb_official_output_lock`.
Issue: scope only. `fs_server_compile_input` / `fs_record_server_compilation`: lineage only (never the scope lock after
it, so no cycle). `remove_trial_balance_upload` takes `tb_official_output_lock` and never the scope lock. The
linearisation point of "replacement vs seal" is the scope lock: whichever commits first is seen by the other — proven in
both interleavings with held transactions (`publicationAuthority.mjs` a11, a12).

## C. Evidence table

| Invariant | Prior behaviour (reproduced) | Control | Test evidence (all EXECUTED-LOCAL unless marked) | Remaining limitation |
|---|---|---|---|---|
| C.1 Every figure and header of a signed document is the server's | main: a version saved with an empty browser evaluation and a fabricated note figure, a second fact version, re-denominated / rescaled amounts, a re-labelled presentation currency, a re-dated period or comparative header, or a relabelled provenance was READY and REVIEWED | `20261124100000` blockers v6 (+ `20261123100000` compiler) | `publicationIntegrityGate.mjs` **present 40/40**; **absent (chain before 20261123, main's behaviour) 16/39: exactly the 23 weakness cases fail**, validated by `validateProofResult.mjs` against the manifest | text (wording, policies) is preparer-supplied; the entity's legal name is bound by 20261123 to `companies.name` at compilation |
| C.2 Only a reviewer clears a blocking finding | any `prepare_close` member could ACCEPT/REJECT | `fs_append_decision` v2 | gate W2 (present pass, absent fail) | — |
| C.3 Only a reviewer withdraws a recorded review | any `prepare_close` member could move REVIEWED→DRAFT | `fs_set_publication_state` v3 | gate W3 | — |
| C.4 A superseded FINAL is never issued officially again; disclosed | the earlier FINAL was issued and sealed after a later FINAL; verify disclosed nothing | `20261124100000` issue/seal v2, `reporting_pack_sealed_object` v2, Edge module `superseded` | gate W4 8/8; `reportingPackSeal.test.ts` | hosted `seal-reporting-pack` closure `dd4f0855…` predates the disclosure (required `cdc5416f…`) |
| C.5 Valid server figures whose MEANING a crafted document changes | main: swapped bindings, swapped period columns, relabelled or moved lines, a duplicated statement, a fact whose period field contradicts its identity, an unbound provenance, a malformed fact, a flipped role were READY | `20261126100000` structure | gate S1 9/9 present; all 9 fail absent | line ORDER within a section is not compared |
| C.6 One current FINAL per company and period (DEFECT-FS-PARALLEL-LINEAGE-FINAL-001) | two lineages of one period both reached FINAL; the comparative took the latest FINAL by order | `20261125100000` | `publicationAuthority.mjs` **18/18**: concurrent first FINALs → one authority, named refusal (a2); plain competing FINAL refused (a3); replacement needs `approve_certification`, a different approver, the exact current authority (a4, a5); explicit replacement moves the authority, REPLACED event, replaced lineage's FINAL/bindings/sealed bytes untouched (a7); retry is a replay (a8); replaced lineage: no issuance, pending seal refused, pack disclosed superseded (a9); new authority issues (a10); seal waits for a held replacement and is refused after it commits (a11); replacement waits for a held seal, artifact intact then disclosed superseded (a12); expiry and revocation at seal (a13); FY2027 comparative names the explicit authority (a14); tenant/scope isolation (a15); history (a16) | — |
| C.7 Legacy data with FINALs in two lineages | would have been silently "resolved" by order | backfill records `CONFLICT_DETECTED`, no pointer; everything refuses by name until designated | `publicationAuthorityLegacy.mjs` **12/12**: migration over existing data (l3), FINAL / replacement refused `AUTHORITY_CONFLICT_UNRESOLVED` (l4), issuance `authority_unresolved` audited and existing sealed pack intact (l5), next year `PRIOR_FINAL_AUTHORITY_UNRESOLVED:2026` (l6), designation authorization (l7), designation once, audited (l8), afterwards the other lineage superseded and the ordinary rules apply (l9), single-lineage scope backfilled to its latest FINAL and succession unchanged (l10) | the preflight lists such scopes for owner review before the apply; designation is a partner's explicit act on the Sign-off page |
| C.8 Server compilation (PR #191) still holds on the combined chain | — | `20261123100000` | `publicationControls.mjs` **71/71** (SC group: control removed = the 20261115 blockers text + compiler trigger disabled; restored = refused before compilation and `SERVER_DOCUMENT_MISMATCH` after; receipts, snapshot tampering, digest, lock separation, replay, tenant); `serverCompilation.test.ts`, `compilerBoundary.test.ts`; `node scripts/buildStatementCompiler.mjs --check` OK | the compiler trusts its own deployment and the service credential (README) |
| C.9 Concurrency, replay, idempotency of the existing controls | — | unchanged | `publicationConcurrency.mjs` **20/20** (C3 "replacement first": the approval is refused by the blockers it evaluates under the lineage lock — `NOT_LATEST_VERSION` / stale — the proof's expectation now names that as well as the older trigger refusal; "control removed" restores the LIVE v4 text afterwards) | — |
| C.10 Existing proofs on the new chain | — | — | `reviewWorkflow.mjs` 33/33; `signoffBinding.mjs`, `run.mjs`, `serviceWithholding.mjs`, `reportingClosure.mjs`, `closeReviewAuthority.mjs`, `signoffPolicy.mjs`, `readinessReadOnly.mjs`: see D | — |
| C.11 Negative proofs are evidence only through their structured result | `if bun proof; then exit 1; fi` (any failure counted) | `scripts/ci/validateProofResult.mjs` + manifests | `proofResultContract.test.ts` 8/8 (unexpected failure, infrastructure failure, incomplete report, duplicate, extra, wrong mode, exit-code mismatch, malformed); CI captures each run's exit status and uploads `proof-results/` | — |

## D. Commands run and results (2026-10-24, this machine, embedded PostgreSQL 16)

| Command | Result |
|---|---|
| `bun scripts/db-proof/publicationIntegrityGate.mjs` → `validateProofResult.mjs --mode present --exit-code 0` | 40/40, VALID |
| `INTEGRITY_GATE_ABSENT=1 bun scripts/db-proof/publicationIntegrityGate.mjs` → `--mode absent --exit-code 1` | 16 pass / 23 fail = exactly the manifest's weakness cases, VALID |
| `bun scripts/db-proof/publicationAuthority.mjs` → validator | 18/18, VALID |
| `bun scripts/db-proof/publicationAuthorityLegacy.mjs` → validator | 12/12, VALID |
| `bun scripts/db-proof/publicationControls.mjs` | 71/71 |
| `bun scripts/db-proof/publicationConcurrency.mjs` | 20/20 |
| `bun scripts/db-proof/reviewWorkflow.mjs` | 33/33 |
| `bun scripts/db-proof/signoffBinding.mjs` | 19/19 |
| `node scripts/db-proof/run.mjs` | 279/279 |
| `bun scripts/db-proof/serviceWithholding.mjs` (the previously failing CI step) | 119/119 (the exact later-migration inventory names the four migrations) |
| `bun scripts/db-proof/reportingClosure.mjs` | 19/19 |
| `bun scripts/db-proof/closeReviewAuthority.mjs` | 100/100 |
| `bun scripts/db-proof/signoffPolicy.mjs` | 24/24 (historical stage before 20261024; client without the compiler) |
| `bun scripts/db-proof/readinessReadOnly.mjs` | 26/26 |
| `node scripts/buildStatementCompiler.mjs --check` | STATEMENT_COMPILER_DEPLOYMENT: OK (digest `49fc0852…`) |
| `bunx tsc --noEmit -p tsconfig.app.json` | 0 errors |
| `bunx eslint .` | 0 errors (the 165 pre-existing warnings) |
| `bun run test` (full vitest) | 361 files / 6263 tests: 6182 passed, 29 skipped, 12 todo; the 40 failures of the first run (concurrent with the production build) were re-run alone: 462/464 pass; the 2 remaining fail only on this Windows machine (stagedTransport: symlink EPERM, needs symlink privilege) and run on CI Linux |
| `bun run build` + `node scripts/ci/assertPackIsolation.mjs dist` + `node scripts/ci/assertSingleLockfile.mjs` | built in 2m46s; PACK_ISOLATION OK; PACKAGE_MANAGER_AUTHORITY OK; MIGRATION_AUTHORITY OK (PENDING_HOSTED_APPLY: the four migrations) |
| Deno checks/tests, real-stack e2e, browser journeys | NOT RUN locally — CI on the pull request (see the PR for the run on the exact head) |

## E. Deployment sequence (preparation only; nothing here was executed against a hosted project)

Prerequisites: hosted journal at its current head with the FS batches applied; reporting rollout OFF for every company
(`fs_set_company_rollout`); a fresh backup / point-in-time mark; the owner's journalled apply route (never the SQL-editor
paste of the source).

1. **Register the batch** (`fs-integrity-r1`) in `scripts/ci/releaseJournal.mjs` from the merge commit's bytes (the four
   submission forms are registered on this branch: identical and final-LF-removed bytes/SHA-256 of each migration), generate
   the wrappers under `release/wrappers/`, run `selfCheckingWrappers.mjs` in CI.
2. **Preflight** — `docs/release/fs-integrity-r1/preflight.sql` (read-only) prints `PREFLIGHT OK` and three listings:
   the bindings and sealed packs to preserve; **the scopes with FINALs in more than one lineage** (reviewed with the owner:
   the backfill records them as unresolved and a partner must designate one afterwards; expected empty today); the unsigned
   candidates (every one needs the compiler receipt before it can be signed).
3. **Deploy `compile-financial-report`** (closure digest `49fc0852…`; `scripts/buildStatementCompiler.mjs --check` on the
   deployed tree) and **redeploy `seal-reporting-pack`** (closure `cdc5416f…`, `scripts/release/verifyDeployedClosure.mjs`).
   Rollout stays off: with the migrations unapplied the new functions are inert (`fs_record_server_compilation` does not
   exist yet → the compile request fails closed; nothing is written).
4. **Apply** `20261123100000`, `20261124100000`, `20261125100000`, `20261126100000` in that order, each one transaction
   through the journalled route (each preflight refuses a double or out-of-order apply; each postcondition raises on any
   deviation). Lock profile: `CREATE TABLE` of two new empty tables and `CREATE OR REPLACE FUNCTION`; the only backfill
   is `20261125100000`'s pointer/event rows (one per scope with a FINAL; empty today).
5. **Postcondition** — `docs/release/fs-integrity-r1/postcondition.sql` prints `POSTCONDITION OK`; the preserved listings
   byte-identical to the preflight's; the backfill listing agrees with the preflight's conflict listing.
6. **Publish the frontend** (blocker wording, `superseded`/authority disclosure, the replacement and designation actions on
   the Sign-off page, the compile-on-save path). Order relative to step 4 is free: an older frontend shows the new blocker
   codes verbatim with the generic sentence; a newer frontend against an older database degrades to the existing refusals
   (`replaceFinal` / `designateFinal` would answer 42883 "function does not exist" — the page offers them only when readiness
   returns `authority`, which an older server does not).
7. **Verify installed, then enable** rollout for the approved companies only, after the honest journey (save → compiled →
   REVIEWED → FINAL → official pack → verify) is exercised on the installed system.
8. **Monitor** — `financial_statement_audit_events` (`PUBLICATION_STATE_SET` with `replacesFinal` / `authorityDesignated`,
   `SERVER_REPORT_COMPILED`), `fs_report_authority_events`, `reporting_pack_issuance_events` (`REFUSED` with
   `SUPERSEDED_FINAL_VERSION` / `AUTHORITY_UNRESOLVED`). A `DOCUMENT_*` blocker on a version the owner believes honest is an
   incident (the stored document was not built by the workbench).
9. **Recovery** — forward-only; nothing is deleted or rewritten; a refusal leaves no partial state. If a gate refuses a
   legitimate case, deactivate the company (`docs/release/sql/04_deactivate_company.sql`) while a forward migration
   redefines the one function (previous texts: `20261115100000`, `20261111100000`, `20260925140000`, `20261123100000`).
   An unresolved authority is resolved only by `fs_designate_final_authority`; a wrong designation is corrected only by a
   later explicit replacement (both audited); the pointer is never edited by hand.

**Old/new compatibility.** Old database + new Edge/frontend: `compile-financial-report` fails closed (no receipt RPC), the
pages show the existing refusals; `seal-reporting-pack` cdc5416f… reads `superseded` only when the row carries it (an older database reads as not superseded) and answers 409 for the authority refusals.
New database + old Edge: the database refuses a superseded or unresolved issuance regardless; the old `seal-reporting-pack`
(dd4f0855…) answers 500 on that refusal and does not disclose `superseded`; no compile receipts can be recorded until the
function is deployed, so no NEW approval or issuance is possible (REVIEWED/FINAL answer `SERVER_COMPILATION_REQUIRED`) —
which is why step 3 precedes step 4 and rollout stays off throughout.

## F. Unresolved production blockers (by consequence)

1. **Hosted application, deployment and acceptance of this batch are not done** — the combined boundary exists only in
   source and on disposable databases; CI on the exact head is the only automated evidence beyond this machine.
2. **The browser-supplied evaluation is still stored and still gates** (`BLOCKING_FINDINGS`, `RECONCILIATION_UNMET`), and the
   legacy `fs_save_evaluation` can append another evaluation to a version. No supported figure, header or structure depends on
   it any more; it remains an additional, non-authoritative gate. Retiring the legacy write RPCs needs `run.mjs` and the
   loopback bridge rewritten — out of this pass.
3. **Preparer-supplied text is not verified beyond presence**: disclosure wording, policies and the entity name (bound to
   `companies.name` only at compilation) are the preparer's; qualified accounting review of recognition, measurement and
   disclosure adequacy remains necessary. No IFRS / IFRS for SMEs / IPSAS compliance is claimed.
4. **Deployed Edge closures** — `seal-reporting-pack` hosted `dd4f0855…` predates the disclosure; `compile-financial-report`
   is not deployed anywhere (E.3).
5. **The compiler's own boundaries** (`docs/reporting-server-compilation/README.md`): a database receipt is not an
   independent signature; the compiler trusts its deployment and the service credential; it proves the report follows the
   recorded source, not that the source is truthful.
6. Pre-existing registered defects and go-live gates are unchanged (`CLAUDE.md` §9.1–9.2).
