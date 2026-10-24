# Financial Reporting Delivery Plan

| | |
|---|---|
| **Document ID** | CFR-DELIVERY-3 (supersedes CFR-DELIVERY-2 and -1, neither committed) |
| **Status** | Track A: gates and the hardening packages **implemented in source on the branch** (`track-a-r1`, draft PR #194), not installed. Track B: PROPOSED, provisional. **This plan authorizes nothing by itself.** |
| **Baseline** | `f3d1b40`; implementation branch `fix/track-a-release-hardening-20261024` |
| **Shared contracts** | Findings (master §3), trust model (§4), security (§5), identity (§6), concurrency and idempotency (§7), compiler trust (§8), manifest and replay (§9), accounting architecture (§10), publication and recovery (§11), operating models (§12), open items (§13) in `FINANCIAL_REPORTING_MASTER_SPEC.md`. Requirement rows in `FINANCIAL_REPORTING_COVERAGE_MATRIX.md`. |

## 0. Rules

1. **Repository law** (CLAUDE.md): migrations authored forward-only in `supabase/migrations/` and applied **only** through the journalled migrator with registered wrappers, preflight and postcondition (§9.4); no weakening of authentication, RLS, sign-off or stale-validation gates (§8.3); engine calculations need a statutory reference (§8.1); Bun `1.3.14` only (§14); registered defects are not fixed opportunistically (§9.1) — each fix below is its own reviewed package.
2. **Gates are separate facts.** For each package the following are recorded separately; none implies another: **G1** implementation complete · **G2** checks green on the exact commit · **G3** technically reviewed (engineering; accounting where relevant) · **G4** merged · **G5** backend installed (journal row + postcondition output recorded) · **G6** frontend published · **G7** activated for a recorded scope · **G8** real journey verified on hosted by a non-developer.
3. **No dates and no schedule conclusions.** No validated effort data exists. Packages are ordered by dependency and by the prioritization rule in §3.
4. **Incomplete specifications are labelled `SPEC INCOMPLETE`** and must be completed (as a documentation change) before G1 starts.

---

## 1. Track A — complete the existing restricted release

**Scope:** IFRS for SMEs 2015, trial-balance-derived, current rollout scope (one demo company per records), reporting functions `compile-financial-report` and `seal-reporting-pack`, migrations at hosted ids 77–80 plus the hardening batch `track-a-r1` (expected hosted ids 81–83). **Track A does not depend on any Track B package.**

**Acceptance is not activation.** Acceptance (A5) is a temporary, recorded window in which reporting is enabled for the **acceptance company only**, to run the hosted journey once; at its end reporting is returned to disabled. Activation (A6) is a separate owner decision that enables a recorded scope on the evidence of A1–A5. The hardening dispositions (A-H1, A-H2 installed and verified at A4) are resolved **before** the acceptance window opens; they are not deferred to the activation decision.

| Gate | Package | Outcome | Evidence required | Failure and recovery |
|---|---|---|---|---|
| A1 | **Exact-candidate checks** | The release commit is green in CI on the exact SHA | N-04 fixed (`0a735c9a`, `816c9838`: journal test and wrapper close-out test); CI run of the exact SHA green with no failure allowance: full unit suite, build, release journal, migration authority, db-contract-tests including `publicationIntegrityGate` (present and absent), `publicationAuthority`, `publicationAuthorityLegacy`, `trackAHardening` (28 cases, validated result), `trackAStagedTransport` (37 checks, `--check` of the generated transport), and the application journey | Any red check blocks A2–A6 (CLAUDE.md §14). Fix forward in a reviewed commit and re-run on the new SHA |
| A2 | **Deployed-function verification** | Both reporting functions proven to be the required closures | `supabase functions download` of each into a scratch directory; `node scripts/release/verifyDeployedClosure.mjs compile-financial-report <dir>` → `745c8170…`; `seal-reporting-pack` → `cdc5416f…`; recorded output committed to `docs/release/fs-integrity-r1/`. `track-a-r1` does not change these closures (master §8.2) | Mismatch → redeploy from the approved commit, re-download, re-verify. Download unavailable → owner records an explicit, scoped exception (currently none approved per `RECORD.md`) |
| A3 | **Hosted read-only state check** | Known hosted posture before installation | Read-only results recorded: journal head = id 80 with hash `5481a1bb…` (the transport's predecessor); kill switch value; rollout list; bindings fingerprint; consumed issuance count; effective grants of `service_role` on `fs_report_authority` and the fifteen history tables (Q-8); `docs/release/track-a-r1/preflight.sql` run read-only (it writes nothing) with its NOTICE recorded | A query that cannot be run is recorded as U, not assumed. Journal head ≠ 80 → stop: the transport refuses any other predecessor and must be re-registered |
| A4 | **Install `track-a-r1` around the frontend publication, reporting disabled throughout** | Hardening in force; the frontend that uses the audited framework function published | In order, recorded one by one: **A4.1** submit `00_track_a_staged_transport.sql` through the canonical journalled migrator (hosted id 81); **A4.2** stage the four batch-1 artifacts and the three batch-2 artifacts (`release/staged-transport-tra/stage/*.sql`; inert data, each byte-checked on insert); **A4.3** submit `10_tra_1_authority_hardening_staged_apply.sql` (id 82; runs preflight, the wrapper of `20261127100000`, postcondition 1; refuses unless bindings, issued packs, authority and every company's framework are unchanged); **A4.4** publish the frontend of the release commit with the kill switch ON; verify reporting routes show the disabled state and the company edit form saves a framework through the function; **A4.5** submit `20_tra_2_framework_guard_staged_apply.sql` (id 83; wrapper of `20261128100000`, postcondition 2). Record each journal row id and hash and each postcondition NOTICE | Each apply is one atomic statement: a refusal or interruption leaves nothing applied (proven, master §0.4 T6/T7); fix the cause and resubmit the same bytes. A4.5 must not be submitted before A4.4 is verified. A wrong frontend after A4.5 → republish the correct frontend; the guard is never removed as a recovery step |
| A5 | **Temporary acceptance window (acceptance company only)** | The full journey works on hosted once | Preconditions recorded **before** opening: A1–A4 complete; hardening dispositions resolved (A-H1, A-H2 installed — not risk-accepted); D-02 policy OD-8 noted. Opening: rollout enabled for the acceptance company only; kill switch per owner decision for the window. A non-developer runs J1–J11 (`HOSTED_EVIDENCE_2026-10-21.md` list) to FINAL; **one official issuance** sealed, verified and retrieved; superseded-disclosure check; a framework change attempt on a certified company refused by name. **Closing:** rollout for the acceptance company disabled again and the kill switch ON; record committed with open and close times | Any failure → close the window immediately (rollout off, kill switch ON); record; fix through A1–A4 again. The window never widens to another company |
| A6 | **Approved activation decision** | Owner records which scope is activated and on what evidence | Activation record citing A1–A5 records, the A4 installation record, and OD-8; scope listed company by company | Without the record, reporting stays disabled (the A5 close-out state) |

### Track A hardening packages — IMPLEMENTED in source (I), installed at A4

Demonstrated defects are not exempted because they also appear in Track B, and risk acceptance is not the default disposition.

#### A-H1 — FINAL authority, replacement intent and history TRUNCATE (D-05, D-06, D-09)

- **Status:** G1 complete (I); G2 pending CI on the exact SHA; G3–G8 open.
- **Outcome:** no API role writes `fs_report_authority`, its events or the replacement intents; the pointer cannot be deleted, re-scoped, sequence-skipped or moved without a matching event even by the table owner; the cross-lineage replacement is an owner-only intent keyed to the transaction; TRUNCATE refused on fifteen history tables for every API role and by trigger.
- **Contracts:** master §3 D-05, D-06, D-09; `20261127100000` §1–§6, §8.
- **Migration and compatibility:** additive; no row changed; old frontends unaffected. Preflight and postcondition 1 in the same transaction.
- **Evidence:** `trackAHardening.mjs` `b1`–`b7`, `c1`, `c2`, `f1`, `m1`–`m4` (28/28); existing authority, legacy, integrity, controls, concurrency proofs pass unchanged (master §0.4).
- **Failure and recovery:** atomic; forward repair only.
- **Expertise:** database security reviewer independent of the author (G3). A first independent review was done on the branch (RECORD §8); it does not replace G3.

#### A-H2 — Governed framework changes (D-01)

- **Status:** G1 complete (I); G2 pending CI on the exact SHA; G3–G8 open.
- **Outcome:** the reporting framework changes only through `set_company_reporting_framework` (owner; audited; idempotent; stale, processing and locked refusals, the lock rule ordered against new certifications and reports); the guard admits only the function's owner role with the transaction's own audited event; other company edits unchanged.
- **Contracts and sequence:** master §5.4 (batch 1 → frontend → batch 2), gate A4.
- **Evidence:** `trackAHardening.mjs` `d1`–`d6`, `e1`–`e6`; `companyFramework.test.ts`, `CompanyManager` tests.
- **Failure and recovery:** forward only; never by dropping the guard (master §5.4).

#### A-H3 — Server-authoritative blocking classification (D-02) — replaced by owner decision OD-8

- The rule inventory (master §3 D-02) shows non-core MEDIUM/LOW findings block in neither path, consistently; the only discrepancy is reviewer acceptance of server-detected CRITICAL/HIGH or `INSUFFICIENT_EVIDENCE` findings, which fails closed. **No code change is made without OD-8.** If OD-8 changes the policy, the change is a reviewed migration and, if it touches the compiler, a new bundle digest and closure, which re-opens A2.

#### A-H4 — Truthful refusal copy (N-01) and edition-correct rendering (O-02)

- **Outcome:** framework-specific refusal text; renderers use the document's recorded edition.
- **Components:** `StatementsView.tsx`, `SchedulesView.tsx`, `RollforwardPanel.tsx`, `NotesView.tsx`, `sealedPack.ts`.
- **Status:** not implemented in this candidate. N-01 is recommended before A4.4; O-02 must be fixed before any third-edition authorization.

---

## 2. Track B — expand accounting support (provisional)

### 2.1 Dependency order

```
B1 identity registry & framework decisions ─┐
B2 manifest & canonicalization ─────────────┼─► B5 registry-driven atomic publication (L1 lock, idempotency, manifest check)
B3 concurrency/idempotency unification ─────┘
B4 rule language & capability library ──┐
B6 allocation ledger ───────────────────┤
B7 treatment cases & governed judgments ┤ (needs B4, B6)
B8 applicability engine ────────────────┤ (needs B7)
B9 change events; restatement vs reissue┘ (needs B7)
B10 IFRS for SMEs validation + third edition   (needs B5, B4–B9, A-H4)
B11 IPSAS accrual pack ─► B12 IPSAS 24 budget engine   (need B5, B4–B9; Q-1, Q-2)
B13 issuance jobs & deterministic renderers    (needs B5)
B14 FX ─► B15 group reporting;  B9 ─► B16 first-time adoption
B17 full IFRS: IAS 1 profile and IFRS 18 profile (needs B14 for most entities; Q-3)
```

The graph is acyclic. No Track A gate depends on it.

### 2.2 Package specifications

Each lists: outcome · dependencies · reused mechanisms · new contracts · migration and compatibility · evidence · failure and recovery · acceptance · expertise · gates · completeness.

**B1 — Identity registry and framework decisions.** Outcome: framework decisions, standard versions, jurisdiction profile revisions, pack revisions, engine versions, release authorizations as records + events + projections (master §6). Reuses: `editionPolicy.ts` policy table tests; `fs_framework_elections`; A-H2 RPC. New contracts: master §6.3–§6.4 tables and functions. Migration: backfill one decision per company (effective from −∞, framework = current column, eligibility `LEGACY_UNVERIFIED`); pack revisions for `ifrs-for-smes/2015` and `/2025` from the TS source digest; `LEGACY_OPERATING` authorization for `/2015` scoped to the rollout list at backfill time, citing A5 evidence; **no `AUTHORIZED` event**; engine version row for the A2-verified closures; readers switch in a later migration after postcondition. Evidence: overlap, supersession, tenant, concurrency proofs (master §7.7 #6); backfill postcondition. Failure: readers fall back to the column only for `LEGACY_OPERATING` scopes until B5. Acceptance: resolution property tests incl. "1 Jul 2026 – 30 Jun 2027 does not resolve to SME third edition without election". Expertise: database; accounting reviewer for eligibility rules. Gates G1–G6. **Complete at contract level; DDL to be written.**

**B2 — Manifest and canonicalization.** Outcome: master §9.1–§9.4 implemented; manifest per saved version; receipts and approvals bind manifest digest. Reuses: `canonicalJson` (TS and Deno). New contracts: `fs_manifests`; strict parser; NFC + collision rejection; residual rule. Migration: historical versions keep no manifest (`LEGACY_REPLAY`). Compatibility: compiler bundle changes → new engine version, A2-style verification. Evidence: cross-runtime corpus (NFC/NFD keys, duplicates, bounds, negative residuals); replay test. Gates G1–G6. **Complete at contract level.**

**B3 — Concurrency and idempotency unification.** Outcome: master §7.2 lock order including L1 (L2 already implemented by `track-a-r1`); `fs_requests`; seal re-sequenced to L3 → L6 → row. Reuses: existing advisory locks, `tb_require_read_committed`, `uq_fscg_idem`. Evidence: master §7.7 scenarios 1–9 on held transactions. Failure: deadlock/serialization retry with same key. Gates G1–G5. **Complete at contract level.**

**B4 — Rule language CRL/1 and capability library.** Outcome: typed declarative rules; capabilities with statutory references. **SPEC INCOMPLETE:** grammar, type rules and capability signatures to be specified as a separate documentation package before G1.

**B5 — Registry-driven atomic publication.** Outcome: one transition function (master §11.2); framework literals removed from orchestration (`fs_bind_publication` `:398,:407`; blockers v7 `:405,:541,:559`; `20261123:157`; `serverCompilation.ts:49,:56`); receipt id on bindings (D-08); distinct designation audit (D-07). Reuses: v7 blockers kept verbatim with splice assertions (pattern of `20261124`/`20261126`). Evidence: a synthetic framework reaches REVIEWED through registry rows only (proves no orchestration literal remains); all existing publication proofs pass; idempotency and withdrawal proofs. Compatibility: old RPC names wrap the new function for one release. Gates G1–G6. **Complete at contract level.**

**B6 — Allocation ledger.** Outcome: master §9.3 conservation and residuals; dimension families. Reuses: presentation assignments backfilled as `DIRECT` full-amount allocations. Evidence: SME demo composition byte-identical before/after; conservation property tests on coherent scenarios. Gates G1–G6. **Complete at contract level.**

**B7 — Treatment cases and governed judgments.** Outcome: master §10.3–§10.4. Reuses: `close_review_adjustments` for entries; five SME schedules as external-schedule precursors. **SPEC INCOMPLETE:** topic schemas per framework (accounting content).

**B8 — Applicability engine.** Outcome: master §10.6. Reuses: `fs_requirement_decisions`, data- vs preparer-decided logic. Evidence: zero-balance-with-activity, related parties with zero balances, commitments with nothing recognised. Gates G1–G6. **Complete at contract level.**

**B9 — Change events; restatement versus reissue.** Outcome: master §10.5 per-standard transitions; original FINAL preserved; original-to-restated reconciliation. Reuses: `fs_comparative_restatements`, `asReportedMinor`, comparative approvals. Evidence: edition change with restated comparatives and untouched prior FINAL (document, bindings, packs byte-identical). Gates G1–G6. **Complete at contract level.**

**B10 — IFRS for SMEs: validation of 2015 and third edition.** Outcome: signed fixtures; requirements move to `VALIDATED`; third-edition source pinned; Appendix A transition rules as pack transition rules; `AUTHORIZED(scope)`. Dependencies: B5, B4–B9, A-H4. Evidence: ≥ 6 representative scenarios incl. S23 modified retrospective and prospective choices. Expertise: independent IFRS for SMEs reviewer; jurisdiction adviser for TZ scope (Q-2). Gates G1–G8. **SPEC INCOMPLETE** until the third-edition requirement decomposition exists.

**B11 — IPSAS accrual pack; B12 — IPSAS 24 budget engine.** See `IPSAS_ACCRUAL_SPEC.md`. Blocked by Q-1 (IPSAS 47 transition) for authorization and Q-2 for Tanzanian scope. **SPEC INCOMPLETE** for lines (reviewer decision) and topic schemas.

**B13 — Issuance jobs and deterministic renderers.** Outcome: master §11.4–§11.5, including fencing tokens on every worker write and on seal. Reuses: existing issue/prepare/store/seal functions and orphan listing. Evidence: master §11.6 recovery proofs; renderer determinism test (two renders byte-identical). Gates G1–G6. **Complete at contract level for jobs; renderer specification incomplete.**

**B14–B17** — **SPEC INCOMPLETE.** Scenarios remain refused by name (master §3 codes) until specified.

---

## 3. Prioritization (rule applied)

Rule: committed customer scope → applicable period start → adoption requirements → transition workload → estimated effort.

| Candidate | Committed scope | Period start | Adoption | Transition workload | Effort | Position |
|---|---|---|---|---|---|---|
| Track A (SME 2015, demo scope) | Existing release | Current periods | NBAA status U, but existing operation | None | Small (gates are verification) | **First** |
| IPSAS accrual | **Committed:** first customers close FY ending 30 June 2027 (owner) | 1 July 2026 | IPSAS 47/48 mandatory internationally; TZ U (Q-2) | IPSAS 47 effective 1 Jan 2026 (mandatory for this period); its transition text U (Q-1); the October 2024 amendments (paras 194A, 203A) effective 1 Jan 2027, so **not mandatory** for a period beginning 1 July 2026 (early application permitted); IPSAS 48 prospective option available; IPSAS 43/45/46 already effective | Large (B1–B9, B11, B12) | **Second**, gated by Q-1/Q-2 |
| IFRS for SMEs third edition | Not committed (OD-7) | 1 Jan 2027 (calendar-year entities; first closes after year end) or early election | TZ adoption U; repository notes NBAA had not adopted | Appendix A reliefs; S23 choice | Medium on top of B1–B9 | Third unless OD-7 commits customers earlier |
| Full IFRS | None | Profile depends on period start and IFRS 18 election | — | IFRS 18 retrospective + reconciliation | Large | Last |

---

## 4. Release gates: current versus future

| Decision | Requires |
|---|---|
| Track A acceptance window (acceptance company only) | A1–A4 records, including the `track-a-r1` installation (A-H1, A-H2 in force) |
| Track A activation for a recorded scope | A1–A5 records; A6 decision naming the scope |
| Any IPSAS REVIEWED | B5, B11 authorized: Q-1 resolved; pack revision `AUTHORIZED(scope)`; fixtures signed |
| Any TZ support claim | Q-2 resolved; jurisdiction profile revision verified |
| SME third edition FINAL | B10 authorized; O-02 fixed |
| Full IFRS | B17; Q-3 |

## 5. Executed evidence underlying this plan

Master §0.4 T1–T12 (disposable infrastructure only). No edge test, real-application journey or hosted check was run by this work; the CI run of PR #194 is the A1 evidence once green.
