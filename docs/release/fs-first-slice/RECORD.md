# Financial statements — first complete reporting slice: scope and decision record

Maintained by NORMAL (implementation owner). BLACK reviews against this record. One record; findings are
classified BLOCKER / NON-BLOCKING / QUESTION and batched. Evidence labels: SOURCE-INSPECTED / EXECUTED-LOCAL /
CI-PROVEN / HOSTED-VERIFIED / UNKNOWN. A green suite, filename or source module never proves an unexercised case.

## 1. Pinned heads

| What | Value | Evidence |
|---|---|---|
| Baseline (`origin/main`) | `29b0d945c1cbbd58bdca2314b48742c9b474c240` (merge of #169) | git |
| Diff `18bff84..29b0d94` outside `docs/` and `*.md` | **empty** — the FS implementation audited at `02c516a`/`18bff84` is byte-identical here | `git diff --stat 18bff84 origin/main -- . ':!docs' ':!*.md'` |
| Branch / worktree | `feat/fs-first-slice-20261018` at `D:/DevStorage/Temp/claude/fs-slice-20261018` | git worktree |
| Candidate head | `c0fc16e` first implementation; `65914ff` release packaging (wrapper batch `fs-controls-r1`); `a6e8c69`, `e408f04`, `f4acc2f` merge `origin/main` (#173 TB UX release; #175 pricing-p1 with migration 20261110100000; `dd2a29c` its hosted application as drizzle entry 0062); `453aeca` second pass (2015 edition only, adjustment-to-sign-off, prior-FINAL reconciliation, browser journey); `44fd72c` wrapper batch re-registered from those bytes; `a5de686` merges `origin/main` `50282a3` (#177, pricing-p1 journal close-out, hosted id 63) — registry comments and the pending list were the only conflicts; `ed09267` the safeupdate fix found by CI (every temp-table DELETE carries a WHERE clause) and `f3925d0` its repackaging — CI green on that head; `8bbb022` the Architectural Hardening Addendum pass (lineage lock in `fs_set_publication_state` v2, `publicationConcurrency.mjs`, architecture map) with the wrapper batch re-registered from its committed bytes; `origin/main` `c046c80` (#178, one release document, no overlap) merged after it; then the journey pass (2026-10-19, the owner's "complete the financial-statements customer journey" instruction): migration `20261112100000_fs_review_workflow_and_rollforward.sql` (reviewer workflow, prior-FINAL acceptance, roll-forward carry), the pages, `reviewWorkflow.mjs`, both journeys extended, batch `fs-journey-r1`; `20261111100000` and `20261112100000` are the two `PENDING_HOSTED_APPLY`; the control-repair checkpoint `3637d6a` is preserved untouched; the final head is the PR's | git; PR #176 (draft) |

## 2. Supported first slice (pinned)

| Dimension | Pinned value |
|---|---|
| Entity type | one standalone for-profit entity with share capital; no parent/subsidiaries, no associates, no groups |
| Framework | IFRS for SMEs only (`framework.kind = IFRS_FOR_SMES`); `framework.version` must equal the server-resolved pack id |
| Edition | **IFRS for SMEs 2015 edition only** (`ifrs-for-smes/2015`): the only edition whose requirement texts are verified against the pinned standard. The edition is still resolved from the period START by `fs_ifrs_for_smes_edition`; a period the policy resolves to the third edition (beginning on/after 2027-01-01, or a recorded early-application election) composes as before but is **refused at sign-off by name** (`FRAMEWORK_EDITION_UNSUPPORTED:ifrs-for-smes/2025`, blockers and binding trigger). Nothing older is presented as verified third-edition support. Pack **1.2.0** |
| Reporting period | one annual period (12 months, `smes.period.annual`); period dates from the company's authoritative reporting input |
| Provenance | `TRIAL_BALANCE_DERIVED` only: the authoritative certified trial balance of the period with approved Close Review adjustments (`fs_reporting_input`) |
| Comparative | exactly one prior period, authoritative (certified) or the approved first-period declaration; comparative approval bound to its identity |
| Evidence families used | TRANSACTION_LEDGER (CURRENT, COMPARATIVE), EQUITY_MOVEMENTS (CURRENT, COMPARATIVE), CASH_ACCOUNT_MAP (CURRENT), PRIOR_PERIOD_STATEMENTS (COMPARATIVE: signed prior-year SCF opening cash) |
| Statements | SFP, SCI (single statement, no OCI), SOCIE, SCF (direct method), notes |
| Supported accounting cases | presentation/classification of reviewed accounts; approved balanced adjustments; movement schedules (PPE, investment property, intangibles, provisions); preparer-supplied disclosure wording with recorded applicability; comparatives with governed restatements |
| Exclusions (refused by name, never composed) | OCI items, discontinued operations, equity-method shares (`REPORTING_CASE_UNSUPPORTED`); full IFRS, IPSAS accrual, IPSAS cash, any non-TB provenance (`PUBLICATION_PATH_UNSUPPORTED`); groups; first-time adoption / transition reliefs; recognition or measurement of anything (tax, ECL, leases, revenue measurement); indirect-method cash flow; more than one comparative |
| Required professional judgements (recorded decisions) | share capital applicability; discontinued operations / OCI / associates' OCI presence; events after the reporting period; parent / ultimate controlling party; related-party transactions; early application |

**Alternative presentations:** the 3.18 statement of income and retained earnings, the two-statement SCI, and the
liquidity presentation are **not** supported in this slice (no verified applicability rule): a document that omits
SOCIE is refused by `MISSING_STATEMENT:STATEMENT_OF_CHANGES_IN_EQUITY`.

**Indirect method:** assessed and not implemented. The existing direct-method route (ledger + cash account map +
account-by-account rollforward) is already built, evidence-bound and reconciled to the trial balance; an indirect
method would need a complete, classified non-cash-movement authority the system does not hold (see
DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001). Decision: keep direct; reconsider only with a product decision.

## 3. Component map (reuse / repair / new)

| Component | Status | Notes |
|---|---|---|
| `fs_reporting_input`, `fs_statement_composition` (SFP/SCI), `fs_notes_status`, `fs_comparatives_status`, `fs_reporting_dependencies`, `fs_publication_blockers`, `fs_set_publication_state`, `fs_bind_publication`, `fs_publication_bindings`, sign-off policy (20261024) | **reused + repaired** | repaired by `20261111100000_fs_publication_controls.sql` (§4) |
| `src/lib/financialGeneration/{cashFlowDirect,equityStatement,cashPerimeter,cashLedgerAuthority}.ts` | **reused** (deterministic browser generators, unchanged) | the server now recomputes every figure they produce and refuses any difference |
| `src/lib/reporting/{prepareVersion,signoff,blockers}.ts`, `financialGeneration/composedReport.ts` | reused; `blockers.ts` extended with the new refusal names | |
| `src/lib/frameworkPacks/ifrsForSmes.ts` | **repaired**: pack 1.2.0 adds the applicable disclosure requirements (§4.4) | pinned to the DB seed by `notesSchedules.mjs` |
| Reporting workbench UI (`src/components/reporting/*`) | reused; no new screens | journey unchanged: statements → notes → schedules → comparatives → sign-off → exports |
| `scripts/db-proof/publicationControls.mjs` | **new** | executed acceptance cases A–L (§6) |
| Release packaging (wrapper batch, drizzle journal entry, CI jobs) | **new** | generated from committed bytes after review (§8) |

Nothing was replaced. No parallel engine, no new prototype.

### 3a. Architecture map (Architectural Hardening Addendum, 2026-10-19): requirement → component → gap

One record, one report model. Each addendum section is mapped to the existing component that fulfils it, with the
material gap named where one remains. Labels: DONE (executed evidence in §7), PARTIAL, GAP (unfinished requirement).

| Addendum | Component that fulfils it | Status / material gap |
|---|---|---|
| §1 One authoritative report version | `financial_statement_reports` (one row per `report_id` lineage + `report_version`; `report_document` JSONB is the server-authoritative model the workspace, review, readiness and exports all read). The document identifies tenant (`company_id`), period (`period_year`, reporting dates), currency and exponent (from `fs_statement_composition`), framework/edition/rule pack (`reportingDependencies.packId`, pack version, rule-pack version in `financial_statement_evaluations`), source certifications and comparative authority, presentation/mapping, treatment and adjustment identities, evidence batches and disclosure decisions (all inside `reportingDependencies`, bound by `dependenciesSha256`), composition (`compositionSha256`), approvals (`financial_statement_publications` + `fs_publication_bindings`: document SHA-256, dependencies SHA-256, approver) | DONE. Allocation versions: presentation assignments are bound; there is no separate "allocation engine" in this product (a line is one account's assignment) — not a gap, a scope statement. Issued-artifact identity: the sealed pack prints the document and dependencies identities, but no artifact bytes/digest are retained server-side → see §8 |
| §2 Exact accounting and evidence | Browser generators and the server composition work in integer minor units (`bigint` in `canonicalStringify`, `numeric` in SQL; `_fs_ev_minor` parses to minor units with the composition's exponent); no binary float anywhere on the figure path. Every displayed amount is a `fact:…` id with lineage (`Trace`), the server recomputes every SCF/SOCIE/perimeter/roll-forward figure (`fs_evidence_statements`) and refuses any difference (`STATEMENT_FIGURE_MISMATCH`/`_NOT_COMPOSED`); source imbalance is preserved by the trial-balance review (statement equation) and the cash ledger reconciles account by account (`CASHFLOW_ACCOUNT_ROLLFORWARD`); two trial balances never establish cash movements — the ledger is evidence, missing evidence is `STATEMENT_EVIDENCE_MISSING` | DONE for the supported statements. Rounding policy: amounts are exact minor units; presentation rounding to thousands is NOT offered (no rounding rule to state) |
| §3 Server-enforced lifecycle | States and transitions: §3b below. `fs_set_publication_state` (v2 here: lineage lock + per-version lock, expected current version for FINAL, capability check after the locks, blockers re-evaluated under the lock, append-only publication row); `fs_bind_publication` (v4: dependencies re-check `BINDING_STALE`, path, edition, approver identity, separation of duties); FINAL immutable; a correction is a new version of the same lineage (successor with lineage by `report_version`) | DONE; concurrency proven by `publicationConcurrency.mjs` (§7.2). Gap: no explicit "superseded" marker on an earlier FINAL beyond the lineage order and `fs_prior_final_reconciliation` naming the latest issued version |
| §4 Consistent commands, concurrent users | `fs_commit_revision`: lineage advisory lock, `expected_report_version` (STALE_REPORT_VERSION on conflict), idempotency key with replay/REPLAY_CONFLICT; `prepareReportVersion`: resumable two-step save; `fs_set_publication_state`: exact replay on the same state, lineage + version locks; decisions/adjustments carry `request_id` replays (Close Review proofs) | DONE and proven (C1 duplicates, C2 concurrent edits, C3/C4 approval vs replacement, C5 revoked approver). No new orchestration added |
| §5 Database and API execution parity | CI "Real application end to end" (local Supabase stack: PostgREST, GoTrue, RLS, Edge Functions, production build in headless Chrome) runs the save and the REVIEWED → FINAL path with the API session's `safeupdate` guard; passed on `f3925d0` (§7.1) after the WHERE-clause fix. The proof refuses any bare DELETE/UPDATE statically. Temp-table cleanup vs authoritative tables: §3c | DONE for the save/publication path. Partial: the proof harness itself cannot load `safeupdate` (not shipped with the embedded PostgreSQL); the API path is CI-proven, not locally re-runnable |
| §6 Framework and edition support | `fs_ifrs_for_smes_edition` (edition from the period start or a recorded election), pack `ifrs-for-smes/2015` 1.2.0 (`fs_pack_requirements`), `PUBLICATION_PATH_UNSUPPORTED`, `FRAMEWORK_EDITION_UNSUPPORTED`; drafts compose and save under an unsupported edition (limited preparation allowed), only REVIEWED/FINAL are withheld | DONE for 2015-only. Structured list of remaining treatment/framework domains: §2 of this record (supported slice) and §9 — the presentation engine does not implement recognition and measurement rules; this is stated, not implied otherwise |
| §7 Complete preparer–reviewer experience | Readiness names the blocker by requirement/figure/evidence; **20261112100000**: `fs_review_comments` + `fs_review_comment_events` (version-bound, item-bound, append-only; blocking vs advisory; opened/responded/resolved/reopened with author, time, version and the item's content), `fs_review_comment_states` (state computed per version: resolved only while the item is unchanged, else reopened by change), `fs_publication_blockers` v4 (`REVIEW_COMMENT_UNRESOLVED:<id>`), `ReviewComments.tsx` on Statements (per line), Notes (per disclosure) and Sign-off (per version); roll-forward: `fs_rollforward_carries` + carry/decide/worklist, `RollforwardPanel.tsx` on the new period's Comparatives page | DONE for comments and carry (proof `reviewWorkflow.mjs`, both journeys). Remaining: comments on evidence items and report sections are supported by the server (`section`) but the pages offer figure and note anchors only |
| §8 Deterministic output and artifact safety | Draft and final share one rendering from the stored document (`ExportsView`, print/PDF); **the retained issued artifact is the EXISTING server-sealed official Reporting Pack** (`issue_official_reporting_pack` bound to the FINAL publication → `seal-reporting-pack` stores the server's canonical document in the private bucket without overwrite and the database seals its SHA-256; `verify` re-hashes the stored bytes; new `retrieve` action returns them again with the digest), reached from Exports through `OfficialPack.tsx` / `reviewWorkflow.ts` (decision 15) | DONE in the real-stack journey (issue, verify, retrieve, a second issuance never overwrites the first); the authoritative artifact format is the canonical JSON document (`application/json`); the printable pack and the CSV are renderings with no integrity claim; cross-format content equality is not asserted by a test (GAP, stated) |
| §9 Security and data handling | RLS + `assertCompanyMembership`-style checks in every RPC (SECURITY DEFINER with explicit company/actor checks); capabilities per member (`workspace_capability_allowed`); tenant isolation proven (K; e2e two-account isolation); synthetic data only; no model call anywhere in the slice | DONE; no change to the client-data guard |
| §10 Operational correctness | Failure classes by SQLSTATE and name (`item_not_found`, `already_resolved`, `not_resolved`, `already_decided`, `nothing_to_accept`, `not_accepted` added for the workflow): `22023 INVALID` (validation), `42501 FORBIDDEN` (permission), `PT409 STALE_REPORT_VERSION / BINDING_STALE / BLOCKED / CONFLICT / REPLAY_CONFLICT` (stale, blocked), `P0002 NOT_FOUND`, `PUBLICATION_PATH_UNSUPPORTED` / `FRAMEWORK_EDITION_UNSUPPORTED` (unsupported scope), missing evidence as a named blocker; `request_id`/idempotency keys on every command; `fs_audit_event` rows | PARTIAL: no correlation id threads a command through the report version and the publication attempt (the billing `correlationId` helper is not wired here); transient failures are not classified; no telemetry/monitoring, retention or operational ownership defined for the FS workload. Bounds and measurements: §3d |
| §11 Migration and release safety | Self-checking wrapper from committed bytes (`fs-controls-r1`), preflight/postcondition, drizzle mirror reconciliation (`RELEASE_JOURNAL`, hosted ids vs mirror tags: 0062 ↔ hosted 63), migration-authority guard; forward changes only; main merged into the candidate before every CI run | DONE for the candidate; hosted application and activation are separate decisions (B–D not established by A) |
| §12 Acceptance | `publicationControls.mjs` (A–L, J2, L2, ED, static contracts), `publicationConcurrency.mjs` (C1–C6), browser journeys (loopback and CI real stack) | DONE for the listed boundaries except reviewer return/resolution and rollover with carried treatment (GAP, §7 row) |
| §13 Finishing contract | this record | the candidate is a control-repair candidate (A); B–D not established |

### 3b. Lifecycle: states and allowed transitions (as enforced on the server today)

| From | To | Command | Server checks (all inside one transaction, under the lineage lock) |
|---|---|---|---|
| (no version) / version N | version N+1 saved (unsigned) | `fs_commit_revision` via `prepareReportVersion` | expected version = latest (else `STALE_REPORT_VERSION`), idempotency key (replay returns the same version; a different payload under the same key is `REPLAY_CONFLICT`), referenced evidence batches exist and are current, evaluation supplied; the two-step save (evidence, then bind) is resumable |
| version N (unsigned) | REVIEWED | `fs_set_publication_state(…,'REVIEWED')` | lineage lock then version lock; version exists for the company; exact replay returns the existing publication; `review_close` capability (checked after the locks — a revocation in flight is seen); an evaluation exists; `fs_publication_blockers` empty (figures, evidence, disclosures, comparatives, edition, path, prior-FINAL reconciliation); binding trigger: dependencies current and equal to the document's `dependenciesSha256` (`BINDING_STALE`), supported path and edition, approver identity recorded |
| REVIEWED | FINAL | `fs_set_publication_state(…,'FINAL')` | as above plus `approve_certification`, the version is the latest of its lineage (`STALE_REPORT_VERSION`), it is REVIEWED, separate approver unless the solo-owner policy (`SIGNOFF_SEPARATE_APPROVERS_REQUIRED`) |
| FINAL | (nothing) | — | immutable: any further state is `CONFLICT`; a correction is version N+1 of the same lineage (successor with lineage); `fs_prior_final_reconciliation` names the latest FINAL for the next period |
| any | direct table write | — | `fs_bind_publication` runs on every insert into `financial_statement_publications`, including a direct insert (case D); bindings and publications are append-only |

| any version | reviewer comment opened | `fs_review_comment_open` | `review_close`; the item exists in that version's document; the item's content identity recorded; request-id replay |
| comment open / reopened | responded | `fs_review_comment_respond` | `prepare_close` or `review_close`; recorded on the LATEST version with the item's content then |
| comment open / responded | resolved | `fs_review_comment_resolve` | `review_close` only (a preparer is refused); the content resolved against is recorded; for any later version the state is resolved only while that content is unchanged, else `reopened_by_change` |
| comment resolved | reopened | `fs_review_comment_reopen` | `review_close` only |
| version N (unsigned) | REVIEWED | as above | plus: no BLOCKING comment of the lineage is unresolved for version N (`REVIEW_COMMENT_UNRESOLVED:<id>`); advisory comments never block |
| FINAL (issued) | official artifact issued | `issue_official_reporting_pack` → `seal-reporting-pack` issue | existing path: single-use issuance bound to the FINAL publication; canonical document rendered by the database; stored without overwrite; sealed with its SHA-256; a second issuance is a second artifact, never a replacement; `verify` / `retrieve` re-read the stored bytes |
| next period | prior-FINAL differences accepted | `fs_accept_prior_final_differences` | `review_close`; binds the exact set of differences (`differencesSha256`); any new difference re-blocks; withdrawal is a new row |
| next period | carried items confirmed / withdrawn | `fs_rollforward_carry` → `fs_rollforward_decide` | `prepare_close`; confirmation writes through `fs_record_disclosure` / `fs_decide_requirement` with a reason naming the source; nothing carried is read by the notes status or the dependencies before that |

Not present (gaps, §9): an explicit WITHDRAWN/SUPERSEDED state on an issued version (the lineage order and
`fs_prior_final_reconciliation` name the latest issued version); comments anchored to evidence items in the pages (the
server accepts `section` anchors; the pages offer figures and notes).

### 3c. Temporary-table cleanup versus authoritative tables (addendum §5)

`fs_evidence_statements` composes the evidence statements in session temporary tables (`pg_temp.fs_ev_*`, `ON COMMIT
DROP`). Each call resets them with `DELETE FROM pg_temp.fs_ev_* WHERE true` — intentionally every row of a scratch table
that belongs to this transaction only. No authoritative table is touched by a DELETE or UPDATE anywhere in the migration
(the proof's static contract refuses any DELETE/UPDATE without a WHERE clause; the only predicates are `WHERE true` on the
seven `pg_temp` tables and keyed predicates on them). Retries and errors leave no partial authoritative state: the
function writes nothing outside `pg_temp`; the save and the sign-off paths that call it are single transactions.

### 3d. Input bounds and measured cases (addendum §10)

| Surface | Bound (enforced) | Measured |
|---|---|---|
| Evidence CSV intake (browser, `financialEvidence/intake.ts`) | comma-delimited only; `INTAKE_LIMITS.maxRows`; amounts must declare a currency and scale | six files of 7–8 rows: validated in the browser in the journeys |
| Revision commit (`fs_commit_revision`) | at most 64 evidence batches per revision; idempotency key 8–200 chars; expected version ≥ 0 | embedded PostgreSQL: the whole browser save (two steps, ~6 server calls) 2.1 s on the journey's data; CI real stack (PostgREST, GitHub runner): the evidence save step 5.4 s wall time including page waits, REVIEWED 3.5 s, FINAL 5.7 s — within the API session's statement budget |
| Trial balance intake | 2 MB / 20,000 rows / 40 columns CSV; workbooks 5 MB, 300 entries, 20,000 rows, 5 s budget (release package §11) | the TB CPU measurements are NOT transferred to the FS workload |
| FS workload under load | — | GAP: no representative or demanding FS case (many accounts, many evidence rows, many versions) has been measured; `fs_evidence_statements` cost grows with evidence rows and versions are unbounded per lineage |


## 4. Decisions (agreed unless marked OPEN)

1. **Figure authority for SCF and SOCIE** — the server recomputes, from the latest valid evidence batches and the
   composition, every figure the browser generators emit (same fact identities: `fact:line:cf:*:<period>`,
   `fact:line:eq:*:<period>`, `fact:cashperim:*`, `fact:cashroll:*`). `fs_reporting_dependencies/3` binds them;
   `fs_publication_blockers` v3 requires every figure present with exactly its amount and nothing else bound on
   the four statements. A tampered cash-flow or equity figure is `STATEMENT_FIGURE_MISMATCH`; an invented line is
   `STATEMENT_FIGURE_NOT_COMPOSED`.
2. **Server-side ties** (new blockers): SCF closing = cash perimeter of the SFP for each period
   (`CASHFLOW_CLOSING_CASH_TIE`); SCF opening = prior closing (`CASHFLOW_OPENING_NOT_PRIOR_CLOSING`); ledger
   movement = trial-balance movement per cash account (`CASHFLOW_ACCOUNT_ROLLFORWARD`); SOCIE component casting
   (`SOCIE_COMPONENT_DOES_NOT_CAST`); SOCIE closing = SFP total equity (`SOCIE_CLOSING_EQUITY_TIE`); SOCIE result =
   SCI profit or loss (`SOCIE_PROFIT_TIE`); SOCIE opening = prior closing per component
   (`SOCIE_OPENING_NOT_PRIOR_CLOSING`). Nothing is plugged; a difference is a named blocker.
3. **Fail closed on unsupported paths** — any report whose provenance is not `TRIAL_BALANCE_DERIVED` or whose
   framework is not `IFRS_FOR_SMES` gets `PUBLICATION_PATH_UNSUPPORTED:<framework>:<provenance>` from the blockers
   AND the binding trigger refuses it (defence in depth for a direct insert). The IFRS / IPSAS rows of
   `financial_statement_framework_requirements` stay (future architecture) but no longer open a generic path.
4. **Applicable disclosures (pack 1.2.0)** — new requirements, each versioned in `fs_pack_requirements` and mirrored
   in the TypeScript pack: going-concern assessment (3.8/3.9, always), date of authorisation for issue (32.9,
   always), key management personnel compensation (33.7, always), components of cash and cash equivalents (7.20,
   always), income tax components (29.39, decided by the data: applies when the composed tax line is non-zero),
   revenue (23.30, decided by the data: applies when the composed revenue line is non-zero), events after the
   reporting period (32.10–32.11, recorded decision), parent/ultimate controlling party (33.5, recorded decision),
   related-party transactions (33.9, recorded decision). An unmet applicable requirement blocks FINAL by name
   (`REQUIRED_DISCLOSURE_MISSING:*`, `REQUIREMENT_UNDECIDED:*`). Data-decided requirements cannot be decided by hand
   (`not_decidable`). Citation verification status: see §9 (QUESTION for BLACK).
5. **Sign-off / separation of duties** — unchanged: REVIEWED needs `review_close`, FINAL needs
   `approve_certification` (20260925140000); FINAL by the reviewer is refused unless the recorded `solo_owner`
   policy is in force and the approver is the owner (20261024100000). No three-person rule; no new exception.
   Legacy `statement_sign_offs` is not the FS path and is untouched.
6. **Edition binding** — the saved document's `framework.version` must equal the server-resolved pack id
   (`FRAMEWORK_EDITION_MISMATCH` / `FRAMEWORK_EDITION_UNRECORDED`).
7. **Evidence binding** — every evidence batch the server used for a figure must be among the version's
   `evidence_batch_ids` (`EVIDENCE_NOT_BOUND`); a superseded batch is already `EVIDENCE_SUPERSEDED`; two usable
   series of one family/role is `EVIDENCE_SERIES_AMBIGUOUS`; a batch in another currency or scale is
   `EVIDENCE_DENOMINATION_MISMATCH`.
8. **Roll-forward** — implemented in this candidate: `fs_prior_final_reconciliation` compares every comparative line
   AS REPORTED (the prior year's current authority) with the figure the prior year's latest issued FINAL version carries
   for that line; any difference (a prior-year adjustment approved after issue, a changed mapping, a line issued but no
   longer presented) is preserved and named `COMPARATIVE_NOT_AS_ISSUED:<factId>:<difference>` and blocks the new period;
   governed resolutions are a restatement of the comparative or a new issued prior-year version. A company with no issued
   prior year has nothing to reconcile to (`no_prior_final`). Together with the SOCIE/SCF opening-to-prior-closing ties
   this is the "reconcile, never silently carry" rule of design doc 11 §B.4. **Not built:** the carry-forward of
   presentation assignments, policy wording and applicability decisions into the new period with a "carried — re-confirm"
   marker, and the roll-forward worklist UI. Those remain part of the full reporting journey (§9).
9. **Edition** — the 2015 edition is the supported edition; the third edition is refused by name (decision taken
   2026-10-18 after the owner's instruction not to present older requirement texts as verified 2025 support).
10. **One order for approvals and version commits (addendum §3/§4, 2026-10-19)** — `fs_set_publication_state` v2 takes
    the report lineage's advisory lock (the one `fs_commit_revision` has always taken) before its per-version lock and
    before any check. An approval and a version commit of the same lineage never interleave: a replacement committed first
    makes the approval refuse (`BINDING_STALE`; `STALE_REPORT_VERSION` for FINAL), an approval committed first leaves the
    replacement as the next unsigned version, and a capability revoked while an approval waits is seen by it. Without the
    lock (the 20260925140000 text, re-installed for the proof's control-removed case) a FINAL approval held open while
    evidence is replaced commits a FINAL on a version that is no longer the latest — the regression the lock closes.
    Changes between a dependency write that takes no lineage lock (a disclosure, an adjustment) and an approval are
    bounded by the binding's point-in-time dependency identity: the version shows stale on the next read and FINAL
    re-checks it under the lock (case G); this is documented in §3b, not papered over.
12. **Reviewer comments are version-bound and item-bound; their state is computed, never flagged (journey pass, 2026-10-19).**
    A comment binds the exact saved version and item (a current-period fact id, a disclosure id, a statement type) and
    records the item's content identity when opened; every event (opened/responded/resolved/reopened) keeps author, time,
    the latest version at that moment and the item's content then. For any version, a resolved comment is resolved only
    while the item's content in that version equals the content it was resolved against — otherwise it reads reopened by
    change. Blocking findings block the version by name; advisory comments never do. A preparer cannot resolve, and a save
    cannot resolve: a new version only re-evaluates. Chosen over a mutable `status` column because a status column would
    let an unrelated save or a blanket action silently close a finding (the instruction's §3 prohibition).
13. **Prior-FINAL differences are accepted as an exact set, never absorbed.** `COMPARATIVE_NOT_AS_ISSUED` stays the
    default; a reviewer may accept EXACTLY the differences found (bound by `differencesSha256`) with a reason; the issued
    figure, the figure as now reported and the reason stay visible together, the acceptance is in the dependencies (so in
    every later version's binding), and any new or changed difference re-blocks. Chosen over reusing comparative
    restatements because a restatement moves the presented comparative away from the as-reported authority, which is not
    what a prior-period adjustment approved after issue needs.
14. **Roll-forward carries decisions, never amounts.** `fs_rollforward_carry` copies the prior year's in-force wording and
    applicability decisions as CARRIED records with provenance; nothing carried is current until the preparer confirms it,
    and confirmation writes through the existing authorities with a reason naming the source. A target period under
    another edition records every item as withdrawn (decided afresh). Presentation assignments are company-level and carry
    inherently; evidence is never carried (the worklist lists the families still to supply).
15. **The retained issued artifact is the existing server-sealed official Reporting Pack, reached only through one
    module.** `DEFECT-REPORTING-PACK-SEAL-RACE-001` (the reason `activation.test.ts` kept the reporting routes away from
    the sealing path) was repaired in `84cd8e0` (a failed seal never removes the canonical object) and `e698c3c` (#156:
    issuance never deletes or overwrites a stored object; unit regressions; 63/63 on real PostgreSQL). The guard now
    sanctions exactly `lib/reporting/reviewWorkflow.ts` (the issue RPC and the Edge Function's issue/verify/retrieve) over
    `lib/reporting/supabaseDb.ts`, still forbids the legacy commercial helper and any storage access, and keeps the legacy
    workspace unrouted. `retrieve` is a new action of the Edge Function: the stored bytes again, with the sealed digest,
    only when intact. The earlier release notes that call the defect open (R4/R5) describe the state at their dates.
11. **Addendum classification (2026-10-19)** — the candidate remains a control-repair candidate (addendum §11 A). The
    supported customer journey (B) is unfinished: persisted reviewer comments with resolution and reopening, roll-forward
    carry of decisions/wording with provenance and its worklist, and server-retained issued artifacts are GAPS named in
    §3a and §9, not cosmetic follow-ups. C (hosted deployment verification) and D (customer activation) are not
    established by anything here.

## 5. Implementation status (2026-10-18)

| Item | Status |
|---|---|
| Migration `20261111100000_fs_publication_controls.sql` | written; applied in every proof below (EXECUTED-LOCAL on embedded PostgreSQL 16, full chain replay) |
| TS pack 1.2.0 (`ifrsForSmes.ts`), coverage matrix + regenerated `docs/reporting/COVERAGE_IFRS_FOR_SMES.md`, `blockers.ts` texts, `notesStatus.ts` contract /2 or /3 | done; focused vitest (frameworkPacks, notes, reporting, financialGeneration, statements) green; `tsc --noEmit` clean |
| Proof `scripts/db-proof/publicationControls.mjs` (cases A–L) | 37/37 PASS with the control; 23/36 FAIL without it (`PUBLICATION_CONTROLS_ABSENT=1`) — the regression evidence |
| Existing proofs adapted to pack 1.2.0 and the supported-path refusal | `reportingKit.prepareReporting` records 1.2.0 by default; `signoffBinding.mjs` rebuilt on real evidence; `notesSchedules`, `readinessReadOnly`, `signoffPolicy`, `closeReviewAuthority`, acceptance-r1 fixtures extended — results in §7 |
| Release packaging | `docs/release/fs-controls-r1/{preflight,postcondition}.sql` written; CI step for the proof added; wrapper batch registration follows the final commit (§8) |
| Browser journey | not exercised (no Supabase stack reachable from this environment); no UI change was needed for the controls — the workbench already renders every blocker by name (`blockers.ts`) |

## 6. Acceptance matrix (updated with executed evidence in §7)

| Case | Mechanism | Evidence |
|---|---|---|
| A tamper SCF figure → FINAL refuses | `STATEMENT_FIGURE_MISMATCH` on `fact:line:cf:closing:CURRENT` | §7 |
| B tamper SOCIE figure → FINAL refuses | `STATEMENT_FIGURE_MISMATCH` on `fact:line:eq:total-closing:CURRENT` | §7 |
| C replace SCF/SOCIE evidence after REVIEWED | `EVIDENCE_SUPERSEDED`, `REPORTING_DEPENDENCIES_STALE`; FINAL refused; trigger `BINDING_STALE` | §7 |
| D unsupported framework/provenance | `PUBLICATION_PATH_UNSUPPORTED` for IFRS, IPSAS_ACCRUAL, IPSAS_CASH, DOCUMENT_REVIEWED; trigger refuses direct insert | §7 |
| E omit applicable disclosure | `REQUIRED_DISCLOSURE_MISSING:smes.note.going_concern` …; FINAL refused | §7 |
| F unauthorised / same-person approval | preparer `FORBIDDEN`; reviewer's own FINAL `SIGNOFF_SEPARATE_APPROVERS_REQUIRED` | §7 |
| G dependency change | stale approval; old binding never authorises the changed report | §7 |
| H happy path | figures reconcile to hand-computed values; REVIEWED → FINAL; bindings carry document and dependencies hashes | §7 |
| I issued history unchanged | FINAL document hash and bindings unchanged after later versions; bindings immutable | §7 |
| J roll forward | opening = prior closing checks (SCF, SOCIE) and the comparative-as-issued reconciliation to the prior FINAL (J2: a prior-year adjustment approved after issue is preserved and named for exactly the two lines it moved); decision carry-forward NOT built | §7 |
| K tenant isolation | company-B owner refused on every RPC and read for company A | §7 |
| L adjustments affect every dependent statement consistently | L2: an approved adjustment after REVIEWED makes the version stale; the next version carries the recomposed SFP/SCI (profit 5,095.00, payables 3,105.00); the equity statement is refused (`SOCIE_PROFIT_TIE`, `SOCIE_CLOSING_EQUITY_TIE`) until its evidence agrees; then it signs | §7 |
| ED unsupported edition | an early-application election resolves the period to the third edition: `FRAMEWORK_EDITION_UNSUPPORTED`; REVIEWED refused; trigger refuses a direct insert; withdrawing the election restores the 2015 edition | §7 |
| C1 repeated commands produce one effect | eight simultaneous saves of one attempt: two versions, every batch once; a copy refused `REPLAY_CONFLICT` converges on retry without writing | §7.2 |
| C2 concurrent edits cannot silently overwrite | two replacements released together: one wins, the other `STALE_REPORT_VERSION`, stores nothing; its retry builds on the winner | §7.2 |
| C3/C4 concurrent change vs approval | approval and evidence replacement wait on the lineage lock; FINAL held open while evidence is replaced: control removed → FINAL on a non-latest version (regression shown); control restored → the replacement waits, the FINAL was the latest at its commit | §7.2 |
| C5 revoked actor cannot complete a queued action | `review_close` revoked while the approval waits: refused 42501; restored: accepted | §7.2 |
| R1–R5 reviewer workflow | blocking comment blocks by name, advisory never; preparer responds, cannot resolve; viewer and other workspace refused; replay by request id; a save does not resolve; unchanged content stays resolved, an approved adjustment reopens by change with what changed; control removed → open finding does not block, restored → blocks; history with authors, versions, content; REVIEWED → FINAL | §7.3 |
| A1 authorised restatement of comparatives | a prior-year adjustment approved after issue blocks the next period by name; the preparer cannot accept; the reviewer accepts exactly that set → `accepted_differences`, no blocker, both figures kept; a further change re-blocks; withdrawal re-blocks; rows append-only | §7.3 |
| F1/F2 roll-forward | 13 wordings + 7 decisions carried with provenance; notes status and dependencies unchanged by the carry; confirmation writes through the authority with a source naming the prior year; withdrawal leaves no record; decided once; a third-edition target withdraws every item | §7.3 |
| Browser: reviewer return | loopback journey: the reviewer opens a blocking finding from the Statements line, Sign-off shows it and blocks; the preparer responds with no resolve control; the reviewer resolves; history opened → responded → resolved | §7.3 |
| Real stack: retained artifact and roll-forward | CI journey: issue → server-sealed → verify → retrieve again with the matching digest; a second issuance never overwrites the first; FY2027 uploaded, the prior issued report untouched, decisions carried and one confirmed through the panel | §7.3 (CI-PROVEN on the final head) |
| PostgREST path with guards enabled | CI real-stack journey on `f3925d0`: save, REVIEWED, FINAL through PostgREST with `safeupdate` | §7.1 (CI-PROVEN) |
| Browser journey | `scripts/browser-acceptance/reportingJourney.mjs` (headless Chrome over the loopback bridge to a disposable database): happy path through statements, notes, schedules, comparatives approval, evidence intake, save, REVIEWED, FINAL, export and PDF; missing-evidence recovery; changed-input recovery; viewer and other-workspace refusals | §7 |

## 7. Execution log

All runs: embedded PostgreSQL 16, the whole migration chain replayed from zero, synthetic data only
(`reportingKit.mjs` trial balances and evidence; nothing client-derived). Label: EXECUTED-LOCAL unless stated.

| Run | Result | What it establishes |
|---|---|---|
| `publicationControls.mjs` (control present) | **37/37 PASS** | cases A, B, C, D, E, F, G, H, I, J, K and L as listed in §6; hand-computed figures: SCF closing 12,500.00 / 8,000.00, net movement 4,500.00 / 3,000.00, operating 6,200.00, financing −1,700.00; SOCIE closing 21,000.00 / 16,600.00, result 5,100.00 / 3,100.00; ledger movement of account 1000 = trial-balance movement = 4,500.00 |
| `publicationControls.mjs` with `PUBLICATION_CONTROLS_ABSENT=1` (chain before the migration) | **FAILED as required: 23 of 36 assertions** — every case in E, H (figure binding), A, B, D, K (new RPC), C (dependency staleness), J and L; F, G, I pass because they rest on pre-existing controls | the regression that each new control prevents; without it a tampered SCF/SOCIE figure, an IPSAS or document-reviewed path and a missing applicable disclosure are NOT refused |
| `closeReviewAuthority.mjs` | **99/99 PASS** | Close Review blockers still isolated on a generic document; that document is now refused by name instead of signed |
| `signoffBinding.mjs` (rebuilt on real evidence through the browser's builder) | **19/19 PASS** | SFP/SCI figure, account, extra-line, unbound and stale refusals; REVIEWED → FINAL with bindings; stale after a change; trigger defence |
| `notesSchedules.mjs` | **40/40 PASS** | pack 1.2.0 vocabulary pinned to the TypeScript pack (50 rows at 1.1.0, 9 at 1.2.0); the nine new statuses and blockers in order; data-decided requirements not decidable by hand |
| `reportingClosure.mjs` | **19/19 PASS** | comprehensive-income decisions; two-step save; approver recording — unchanged behaviour on the new chain |
| `readinessReadOnly.mjs` | **20/20 PASS** | readiness readable through the API; stale after a change |
| `reportingWorkbench.mjs` | **22/22 PASS** | the browser's own workbench flow on the new chain |
| `acceptanceFixtures.mjs` | **17/17 PASS** | the acceptance-r1 fixtures (decisions and wording extended with the 1.2.0 rows) |
| `cashPerimeterScope.mjs` | **12/12 PASS** | per-period cash scope (DEFECT D-3) |
| `statementComposition.mjs`, `comparatives.mjs` | **37/37, 28/28 PASS** | composition and comparatives unchanged |
| `run.mjs` (persistence proof; its chain stops before 20261017 by design, unchanged file) | **279/279 PASS** | |
| `signoffPolicy.mjs` | **24/24 PASS** | the statement sign-off policy on the new chain (its own setup extended with the 1.2.0 wording) |
| `bunx tsc --noEmit -p tsconfig.app.json` | clean | |
| `bun run lint` | 0 errors, 153 warnings (the pre-existing baseline) | |
| `node scripts/audit_migrations.mjs --strict` | VERDICT: CLEAN (last: `20261111100000_fs_publication_controls.sql`) | |
| `node scripts/ci/assertSingleLockfile.mjs` | OK | |
| focused vitest (`src/lib/frameworkPacks src/lib/notes src/lib/reporting src/lib/financialGeneration src/lib/statements`) | 163 passed; one 5 s timeout in `activation.test.ts` while two database proofs ran concurrently (worker RPC timeout, not an assertion) — see the full-suite run below | |
| `bun run build` + `node scripts/ci/assertPackIsolation.mjs dist` | built in 1m 42s; PACK_ISOLATION: OK | |
| `node scripts/ci/assertMigrationAuthority.mjs` | OK; `PENDING_HOSTED_APPLY: 20261111100000_fs_publication_controls.sql` (expected: authored, not applied) | |
| `RELEASE_BATCH=fs-controls-r1 node scripts/db-proof/selfCheckingWrappers.mjs` | **32/32 PASS** — refusals before any statement, injected failures rolled back, hosted-executor model, re-application refused, postcondition, drizzle-orm migrate() | |
| `releaseJournal.test.ts` + `selfCheckingWrappers.test.ts` | 160/160 PASS (the source registered as PENDING hosted application) | |
| control-byte scan of every changed file | clean | |
| full `bun run test` (first run, concurrent with two database proofs) | 25 failures: vitest worker RPC timeouts and 5 s test timeouts under load, plus two deterministic ones — `serviceEnquiryMigrationContract.test.ts` and `activationReadinessMigration.test.ts` pin the exact migration list and needed the new file added (done) | |
| full `bun run test`, generous per-test timeout, before the main merges (`bunx vitest run --testTimeout=120000`) | 5899 passed, 5 failed: 4 × the inertness guard's "base is not an ancestor" (main had moved under the branch — resolved by merging main) and the envelope-guard test, which collects nothing while merge conflict markers are in the tree; every migration-list pin (`persistenceMigrationContract`, `billingTriggerRepairMigration`, `migrationAuthority`, `migrationReplayCompatibilityGuard`, `omega3CheckoutIntervalAuthority`, the two service-enquiry hygiene tests, `databaseInert`) now carries the new file | |
| guards after the merge (`databaseInert`, `inertBase`, `atomicEnvelope`, `migrationAuthority`) | 90/90 PASS | |
| full `bun run test` on the final merged head (`--testTimeout=600000`) | **5907 passed, 2 failed** — `atomicEnvelope.test.ts` (its own 120 s limit) and `migrationAuthority.test.ts` "0023 … any mutation fails closed" (its own 60 s limit): both copy the whole repository per fixture and exceed their hard-coded timeouts only under full-suite load on this Windows machine; both pass in isolation (90/90 with the other guards). No assertion failure anywhere. Release Gate on clean Linux CI is the authoritative run | EXECUTED-LOCAL |
| `RELEASE_BATCH=fs-controls-r1 selfCheckingWrappers.mjs` on the merged tree | **32/32 PASS** | |

### 7.1 Second pass (2026-10-18, after the owner's instruction: edition, adjustment-to-sign-off, roll-forward, browser)

| Run | Result | What it establishes |
|---|---|---|
| `publicationControls.mjs` (extended: ED, L2, J2) | **45/45 PASS** | ED: an early-application election resolves the period to `ifrs-for-smes/2025`; the new version is `FRAMEWORK_EDITION_UNSUPPORTED:ifrs-for-smes/2025`, REVIEWED refused, a direct publication refused by the trigger; withdrawing the election restores 2015. L2: after REVIEWED, a balanced rent-to-payables adjustment (5.00) is proposed and approved; the reviewed version is `REPORTING_INPUT_STALE` + `REPORTING_DEPENDENCIES_STALE` and FINAL is refused; the next version carries the recomposed figures (profit 5,095.00, payables 3,105.00, account 6100 2,405.00) and is refused `SOCIE_PROFIT_TIE:CURRENT:500` / `SOCIE_CLOSING_EQUITY_TIE:CURRENT:500` until re-supplied equity movements agree; then total equity 20,995.00 ties, ready, REVIEWED, FINAL. J2: a second adjustment (2.00) approved after that issue leaves the issued version unchanged; FY2027 certified; `fs_prior_final_reconciliation` names the latest issued FY2026 version and exactly the two moved lines (`COMPARATIVE_NOT_AS_ISSUED:…sfp.trade_and_other_payables:200`, `…sci.operating_expenses_by_function:200`); FY2026 itself has `no_prior_final` |
| `scripts/browser-acceptance/reportingJourney.mjs` (headless Chrome 1280×900, real pages over the loopback bridge, three simulated people) | **20/20 PASS** — evidence in `browser-evidence/` (11 screenshots, draft and sealed packs as PDF, the Exports page print, `results.json`) | statements with composed figures and keyboard lineage; notes recorded through the form; schedule reconciled; preparer cannot approve or sign; reviewer approves comparatives with a reason; **missing-evidence recovery** (the next action asks for the cash-flow and equity evidence; six files validated in the browser, stored as versions 1 and 2, no blocker); REVIEWED then FINAL; sealed pack with approver and binding hashes printed to PDF; draft watermark; **changed-input recovery** (the signed version stays FINAL, the next action asks for a new version and names the stale dependency); viewer read-only; other workspace refused; every request on loopback |
| journey step 7 (reviewer returns comments to the figure) | NOT exercised — the product has no persisted reviewer-comment store (design doc 11 §B.3c); listed in §9 |
| `publicationControls.mjs` with `PUBLICATION_CONTROLS_ABSENT=1` (extended proof; the chain stops before the migration) | **FAILS as required: 28 of 44 checks fail** | regression evidence: every control this migration introduces (figure binding of SCF/SOCIE, evidence binding, pack 1.2.0 statuses, `PUBLICATION_PATH_UNSUPPORTED`, the SCF/SOCIE ties, `FRAMEWORK_EDITION_UNSUPPORTED`, the prior-FINAL reconciliation) is absent without it; the 16 that still pass are behaviour the slice leaves unchanged (sign-off roles, tenant isolation, staleness of the stored document) |
| dependent reporting proofs on the changed chain | **all PASS** — signoffBinding 19/19, closeReviewAuthority 99/99, notesSchedules 40/40, reportingClosure 19/19, readinessReadOnly 20/20, reportingWorkbench 22/22, acceptanceFixtures 17/17, cashPerimeterScope 12/12, statementComposition 37/37, comparatives 28/28, signoffPolicy 24/24, `run.mjs` 279/279 | no earlier reporting behaviour regressed; the generic full-IFRS documents those proofs build are now refused by name (`PUBLICATION_PATH_UNSUPPORTED`) where they used to sign |
| full unit suite on the merged tree (`a5de686`, after #177) | **5908 passed, 2 failed, 10 skipped, 12 todo** — the two failures are `migrationAuthority.test.ts` "parity: loses its corrective statement" (5 s hard-coded timeout) and `atomicEnvelope.test.ts` "refuses every malicious fixture" (120 s hard-coded timeout); both pass when their files run alone (19 files, 1 failed = the pre-merge inertness base, resolved by the merge commit) | load timeouts of guard tests that spawn the migration-authority guard per fixture, not behaviour; CI runs them with its own budget |
| CI on `a2598c2` (CI-PROVEN): "Real application end to end" (local Supabase stack, production build, headless Chrome) | **FAILED at the evidence save** — the page's failure capture (`FAIL-Statements-six-evidence-files….txt` in the `real-app-evidence` artifact) reads "Not finished: DELETE requires a WHERE clause" | a genuine defect of the first candidate that no EXECUTED-LOCAL proof could see: Supabase's API sessions (PostgREST's `authenticator` role) load the `safeupdate` guard, which refuses a DELETE or UPDATE without a WHERE clause even inside a SECURITY DEFINER function; `fs_evidence_statements` reset its temp tables with bare `DELETE FROM pg_temp.fs_ev_*;` (11 statements). The embedded-PostgreSQL proofs and the loopback browser journey talk to PostgreSQL directly and never load that guard. **Fixed:** every one now reads `DELETE FROM … WHERE true;`; the proof gained a static contract refusing any bare DELETE/UPDATE in the migration; the journey's own sequence (non-calendar periods, distinct codes, the reclassification, pack 1.2.0 notes) was replayed on the embedded database through the browser's save code — saved and ready — so the only difference was the API-session guard. The two later journey failures (REVIEWED, FINAL, the layout re-check's `Version null`) cascade from the unsaved version |
| CI on `a2598c2` (CI-PROVEN): "Disposable-DB Contract Tests" | **FAILED in `serviceWithholding.mjs`'s static contract** — its pinned list of reviewed later migrations ended at `20261110100000`; the publication-controls migration was not named | fixed by naming it (that proof's LATER list); re-run locally 119/119 |
| every other CI job on `a2598c2` | PASS — Release Gate (frozen install, full suite), Lint/Build/Typecheck, Golden Fixtures, Migration Audit, Edge-function checks, Conflict-marker check | |
| wrapper batch `fs-controls-r1` re-registered from `453aeca9…`'s committed bytes (`44fd72c`) | **32/32 PASS** (`scripts/db-proof/selfCheckingWrappers.mjs`, fs-controls-r1 branch); `selfCheckingWrapper.mjs --check` clean; `assertMigrationAuthority.mjs` OK (60 drizzle entries mirrored, `PENDING_HOSTED_APPLY: 20261111100000`) | wrapper 88,769 B SHA-256 `06e2dbb2…` enclosing the 87,201 B source `42edba2b…` — superseded by the row below |
| wrapper batch `fs-controls-r1` re-registered again from `ed092672…`'s committed bytes (after the safeupdate fix) | **32/32 PASS** (`selfCheckingWrappers.mjs`, fs-controls-r1 branch); `--check` clean; migration-authority guard OK; registry and inertness tests 741/741 | wrapper 89,144 B SHA-256 `869d4cca…` enclosing the 87,576 B source `33392f86…` — superseded by the row below |
| wrapper batch `fs-controls-r1` re-registered from `8bbb0223…`'s committed bytes (the addendum pass: §9 lineage lock) | **32/32 PASS** (`selfCheckingWrappers.mjs`, fs-controls-r1 branch); `--check` clean; migration-authority guard OK (60 mirrored, `PENDING_HOSTED_APPLY: 20261111100000`) | wrapper 94,858 B SHA-256 `7c3c0b0d…` enclosing the 93,290 B source `b8b8bef6…` |
| CI on PR #176 | the first push failed only `databaseInert.test.ts` (the new migration and proof were not yet registered as reviewed) and then went CONFLICTING when #175 merged; both addressed by the merge commit `e408f04`. On `a2598c2` (after #177) seven jobs passed and two failed: the real-stack journey (the safeupdate DELETE defect, fixed) and the service-withholding static contract (list extended) — see §7.1. CI on the final head: see the PR | CI-PROVEN on `a2598c2`; the fixed head's run is the authority |

Decision taken during execution: `run.mjs` replays the chain only up to the sign-off completion requirements
(20261017100000) by design, so the control is not present there and the file is unchanged.

### 7.2 Third pass (2026-10-19, Architectural Hardening Addendum): concurrency, parity, architecture map

| Run | Result | What it establishes |
|---|---|---|
| `scripts/db-proof/publicationConcurrency.mjs` (new; embedded PostgreSQL 16, whole chain, the browser's own save code, a second connection holding the lineage lock to order the interleavings) | **__CONC__ PASS** | C1 eight simultaneous saves of one attempt → exactly two versions (evidence, bind), six batches once; a copy that read the store after another copy's evidence step is refused `REPLAY_CONFLICT` (its idempotency payload names a different "replaces" batch) and its retry of the same attempt converges on the bound version writing nothing. C2 two people replacing the ledger at once, released together from the lineage lock → one wins, the other `STALE_REPORT_VERSION` with nothing stored; the loser's retry builds on the winner's version. C3 REVIEWED and a replacement released together → both wait on the lineage lock; whichever commits first, the other cannot approve replaced content (`BINDING_STALE`, or FINAL refused `STALE_REPORT_VERSION`). C4 a FINAL approval transaction held open after `fs_set_publication_state` ran while a replacement starts: CONTROL REMOVED (the 20260925140000 function text installed) → the replacement is not held back and a FINAL stands on a version that is no longer the latest; CONTROL RESTORED → the replacement waits for the commit and the FINAL was the latest at its commit, its binding carrying the version's own dependencies. C5 `review_close` revoked while the approval waits → 42501; restored → accepted. C6 every binding equals its version's bound dependencies; no FINAL was ever published again |
| `publicationControls.mjs` on the migration with §9 (lineage lock) | **__PC2__ PASS** | the lock changes no outcome of A–L, J2, L2, ED |
| CI real-stack journey on `f3925d0` | PASS (§7.1) | the save and REVIEWED → FINAL through PostgREST with `safeupdate` enabled: the formerly failing save succeeds (addendum §5); the timings are in §3d |
| Architecture map, lifecycle, temp-table cleanup, bounds | §3a–§3d | requirement → component → gap, with every unfinished requirement named |

### 7.3 Journey pass (2026-10-19, the owner's "complete the financial-statements customer journey" instruction)

| Run | Result | What it establishes |
|---|---|---|
| `scripts/db-proof/reviewWorkflow.mjs` (new; embedded PostgreSQL 16, whole chain, the browser's own save code) | **33/33 PASS** | R1 a blocking comment on the payables figure blocks `REVIEW_COMMENT_UNRESOLVED:<id>`, the advisory one never; an unknown figure `item_not_found`. R2 the preparer cannot open or resolve (forbidden), the viewer and another workspace are refused everywhere; the preparer's response keeps the block; request-id replays answer the same record, a changed body is `request_reused`. R3 a new version with the same figures keeps the finding open (a blanket save resolves nothing); the reviewer resolves → ready → REVIEWED; reopening is the reviewer's; a profit-neutral reclassification (payables ↔ receivables, 5.00) moves the figure: the next version shows the resolved comment reopened by change with the old and new amounts, a comment on an unchanged figure stays resolved; re-resolved against the new content → ready. R4 CONTROL REMOVED (the 20261111100000 blockers text installed): an open blocking comment no longer blocks — the regression; CONTROL RESTORED: it blocks again. R5 events keep role, time, version and content; UPDATE/DELETE refused 42501; REVIEWED → FINAL. A1 FY2027: a 2.00 prior-year adjustment after issue → exactly two named differences block; the preparer cannot accept; the reviewer accepts → `accepted_differences`, no blocker, both figures kept beside the reason; a 1.00 further adjustment → acceptance not in force, re-blocked with the 3.00 set; accepted again; dependencies identity moved each time; withdrawal re-blocks; `nothing_to_accept` on a reconciled period; rows append-only. F1 FY2025 → FY2026: 13 wordings and 7 decisions carried with provenance; the viewer and another workspace refused; replay carries nothing; notes status and dependencies unchanged; the worklist names every item, the six evidence families still to supply and the prior-FINAL state; confirming a wording writes it through `fs_record_disclosure` with "Carried forward from FY2025" and the note reads provided; confirming a decision writes through `fs_decide_requirement`; withdrawal needs a reason and leaves no record; replay answers the same, a second decision is `already_decided`; direct UPDATE/DELETE refused. F2 FY2027 resolves to the third edition by the period policy: every item withdrawn `edition_changed:ifrs-for-smes/2015->ifrs-for-smes/2025`, none carried |
| `publicationControls.mjs` on the extended chain | **46/46 PASS** | blockers v4 changes no outcome of A–L, J2, L2, ED |
| `scripts/browser-acceptance/reportingJourney.mjs` (headless Chrome, loopback bridge) | **24/24 PASS** | the earlier 20 checks plus: the reviewer opens a blocking finding from the Statements line (screenshot 06b), Sign-off shows "Blocking finding · Open" and blocks in words; the preparer responds and has no resolve control (06c); the reviewer resolves with a note, the version is ready again and the history reads opened → responded → resolved (06d); Exports offers the owner the server-sealed official pack (08b; nothing issued on the loopback harness, which has no Edge Function) |
| CI "Real application end to end" (local Supabase stack) | see the PR's checks on the final head | adds: the reviewer-return cycle through PostgREST; the official pack issued, server-sealed, verified and retrieved again with the matching digest, a second issuance never overwriting the first; FY2027 uploaded with the prior issued report untouched; decisions carried and one confirmed through the roll-forward panel |
| unit suite (targeted) | reporting, seal module, pinned lists: 698/698; `activation.test.ts` now sanctions the two modules (decision 15) | |

## 8. Migration and deployment requirements

- Apply order: after `20261110100000` (pricing-p1, merged to main as #175, applied hosted on 2026-10-18 as drizzle entry 0062 / hosted id 63 — `dd2a29c`, closed out by #177 `50282a3`, mirrored in `RELEASE_JOURNAL`); no object overlap. `20261111100000` is the only batch still PENDING hosted application.
- Hosted apply only through the self-checking wrapper of the committed bytes, by the owner, with
  `docs/release/fs-controls-r1/preflight.sql` before and `postcondition.sql` after. **Not authorised by this kickoff.**
- Batch `fs-controls-r1` registered in `scripts/release/selfCheckingWrapper.mjs` at the implementation commit
  `8bbb0223cdc88636302cf33ef637fcb7c1f261a5` (the addendum pass; earlier registrations at `c0fc16e`, `453aeca` and
  `ed09267` are superseded): source 93,290 B SHA-256 `b8b8bef6…`, wrapper
  `release/wrappers/20261111100000_fs_publication_controls.wrapper.sql` 94,858 B SHA-256 `7c3c0b0d…`; all four submission
  forms in `scripts/ci/releaseJournal.mjs`; `selfCheckingWrapper.mjs --check` clean; the migration-authority guard lists
  the source as `PENDING_HOSTED_APPLY` (expected until the owner applies it; the drizzle journal entry is written by the
  apply tool, never here).
- **Second batch `fs-journey-r1`** (`20261112100000_fs_review_workflow_and_rollforward.sql`): applied AFTER `fs-controls-r1`
  (its preflight requires the lineage lock of 20261111100000); registered in `scripts/release/selfCheckingWrapper.mjs`
  from its committed bytes (identity in `scripts/ci/releaseJournal.mjs`), proven by `selfCheckingWrappers.mjs`
  (`RELEASE_BATCH=fs-journey-r1`: injected failure at `fs_review_comment_states`, rolled back with no journal row), with
  `docs/release/fs-journey-r1/preflight.sql` before and `postcondition.sql` after. Both batches are PENDING hosted
  application; nothing here authorises either.
- **One Edge Function change:** `seal-reporting-pack` gains the `retrieve` action (`_shared/reportingPackSeal.mjs`
  `retrieveOfficialPack`: the stored bytes again with the sealed digest, only when intact; the same workspace gate as
  `verify`). Deploying it is a separate step (`supabase functions deploy seal-reporting-pack`) after the owner's review; the
  `issue` and `verify` actions are unchanged. No feature-gate change: `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` and the
  company rollout allow-list are untouched.

## 9. Classification and remaining kickoff requirements

**Classification: control-repair candidate with the first reporting slice's server controls complete; the full
reporting journey is unfinished.** Every kickoff requirement is listed below with its status, so nothing is hidden.

| Kickoff requirement | Status |
|---|---|
| Authoritative figures across every supported statement (SFP, SCI, SOCIE, SCF) | DONE — server recomposition and binding; A, B, H, L, L2 executed |
| Dependency binding and stale approval (inputs, mappings, adjustments, evidence, allocations, framework/edition/rules, statements, disclosures) | DONE — C, G, L2 executed; edition bound |
| Fail closed for unsupported paths | DONE — D executed (blockers and trigger) |
| Authorised sign-off and separation of duties | UNCHANGED and re-proven — F |
| Applicable disclosures, versioned, with recorded applicability | DONE for the 2015 edition (pack 1.2.0) — E; the third edition is not verified and is refused |
| Cash flows and equity: indirect method | NOT implemented — direct-method-only support with explicit evidence (ledger, cash account map, equity movements, prior-period statements); `cashFlowEngines.ts` (pure, dormant) was assessed and not wired: it derives operating cash flow from the same TB deltas, so it would add no independent evidence and would need non-cash and movement evidence requirements that do not exist yet. The product is not suitable for broader SME preparation without this limitation (§9a) |
| Comparatives: signed prior-year cash-flow comparatives, prior-closing reconciliation | DONE — J, J2 |
| Roll-forward: compatible treatment reused, period evidence refreshed | DONE — carry with provenance and re-confirmation (F1), withdrawn under another edition (F2), worklist on the new period's Comparatives page, prior-FINAL reconciliation with authorised acceptance (A1); evidence never carried |
| Customer journey steps 1–10 | steps 1–9 exercised in the browser journeys (happy path, missing evidence, changed input, reviewer return and re-review, approval, retained artifact); step 10 roll-forward exercised in the real-stack journey (carry, confirm) and the proof (acceptance of differences); what remains is listed in §9a |
| Reviewer comments persisted against exact versions and items, with resolution history and reopening (addendum §7) | DONE — 20261112100000; `reviewWorkflow.mjs` R1–R5; both journeys |
| Issued artifact retained with its digest and bound to the approved version (addendum §8) | DONE through the existing server-sealed official pack (decision 15): issue, verify, retrieve in the real-stack journey; the Edge Function's `retrieve` action needs its own deploy |
| Concurrency and idempotency (addendum §3/§4) | DONE — lineage lock in `fs_set_publication_state` v2; `publicationConcurrency.mjs` C1–C6 |
| Database and API execution parity (addendum §5) | DONE (CI-PROVEN) for the save/publication path; the harness cannot load `safeupdate` locally |
| Operational correctness (addendum §10) | PARTIAL — failure classes and request ids exist; no correlation id across command → version → publication, no telemetry, no FS load measurement (§3d) |
| Rendering, exports, reproduction | UNCHANGED from the reporting release (sealed pack, PDF, lineage-tagged exports; the browser journey prints the sealed pack); byte-identical independently generated formats not promised |
| AI and server exposure | no model call anywhere in this slice; the `policy-compass` / MAONO findings of doc 12 untouched (separate track) |
| Privacy cleanup (#171) | separate track; synthetic data only here |
| Hosted application, activation, merge | NOT authorised; nothing applied |

## 9a. Open blockers / questions for the owner and BLACK

- **RESOLVED (edition):** the 1.2.0 citations are verified against the pinned 2015 text (SHA-256 `acc6500e…`): 3.8,
  3.9, 7.20, 23.30, 29.39, 32.9, 32.10, 32.11, 33.5, 33.7, 33.9 all read as cited (PRIMARY_TEXT). The third edition's
  text was reachable only through Section 7, so the third edition is **not** a supported edition of this slice: a report
  composed under it is refused by name. Supporting the third edition is a later item that needs its Sections 23, 29,
  32 and 33 verified (including 33.7A).
- **DONE (journey pass):** the reviewer-comment store, the roll-forward carry and worklist, the retained issued artifact
  through the existing official pack — see §7.3 and decisions 12–15.
- **OPEN (owner, stated limitations):** the indirect-method cash flow (direct-method-only; see §9); comments anchored to
  evidence items in the pages; cross-format content equality is not asserted by a test; the `retrieve` action of
  `seal-reporting-pack` needs its own deploy; the FS workload has no load measurement (§3d); correlation ids do not yet
  thread command → version → publication → artifact (the request ids, the audit ledger's DECISION_RECORDED events with
  the exact event name, the issuance ids and the sealed digests are the chain available today).
- **NOTE (addendum §3):** dependency writes that take no lineage lock (a disclosure, a comparatives approval, an
  adjustment decision) can commit while an approval transaction is open; the approval binds the dependencies identity
  it read, the version then reads as stale and FINAL re-checks under the lock. Serialising every dependency write on the
  lineage lock would touch eight more functions and was not done in this pass — the window is one transaction wide and
  the bound identity makes it visible, never silent.
- **NON-BLOCKING (design):** the refusal `PUBLICATION_PATH_UNSUPPORTED` is appended to the blocker list rather than
  returned early, so a generic document still sees every other gap; it can never be signed either way (the trigger
  refuses too). Confirm this presentation choice.
- **NOTE:** the browser journey runs the real workbench pages against a disposable PostgreSQL through a loopback bridge
  with a simulated identity header (not GoTrue); hosted/staging browser acceptance remains a separate owner-run step.
