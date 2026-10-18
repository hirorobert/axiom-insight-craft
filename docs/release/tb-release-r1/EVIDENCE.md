# Trial balance release tb-release-r1: hosted evidence record

This is the tracked record of hosted verification for the release (application identical from `96305da` through the current main); the application runtime is identical from `96305da`. Every check has a final status in the close-out table below. Nothing is inferred, and no entry is marked PASS without its own evidence.

**Repository rule:** this repository is public, so no company names, user identities or client data are recorded here. Upload and execution ids are synthetic-run identifiers.

## Close-out (consolidated, 2026-10-18)

**Implementation milestone: COMPLETED.** Installed and verified on hosted. The detail is in the sections below.

**Acceptance checks:**

| # | Check | Result | Source |
|---|---|---|---|
| 1 | Installation: journal rows 59–62 match the wrapper hashes; the five functions' fingerprints match | **PASS** | Lovable read-only report |
| 2 | Catalog postcondition (Record A) | **PASS**: `POSTCONDITION OK.` | Lovable, verbatim and read-only |
| 3 | Generation-6 runtime: summarised findings, count and SHA-256 (Record B, R1–R4) on runs 1 and 2 | **PASS** | Lovable, `runtimeEvidence.sql` |
| 4 | Refused replacement (`TOO_MANY_ACCOUNTS`) and explicit restore: the exact predecessor and its certification byte-identical, no new run | **PASS** | Lovable, plus the owner's screenshots |
| 5 | Over-10 MB replacement: data preservation (no upload, object or run; predecessor and certification unchanged) | **PASS** | Lovable read-only report |
| 5b | Over-10 MB replacement: a visible refusal message | **FAILED**: no message observed (a transient toast only). Display defect, see below. | The owner's observation |
| 6 | Same-name / different-code identity: 4000 and 4100 "Sales" stay distinct after review | **PASS** | Lovable read-only report |
| 7 | Review lineage: every account was cleared by an explicit, authorised confirmation | **PASS** | Lovable read-only report |
| 8 | Processing-control enforcement (catalog): the three triggers enabled; `processing_control_allows()` as reviewed | **PASS** | Lovable read-only report |
| 9 | Numeric CPU and headroom (HANDOFF §6.3) | **BLOCKED**: no correlated hosted CPU value; never waived | See "Hosted CPU" |
| 10 | Busy/retry (503 `PROCESSING_BUSY` and a successful retry) | **NOT EXERCISED** on hosted; covered in CI only | — |
| 11 | Reporting Pack seal and verify | **NOT EXERCISED**. Reachability is unresolved, pending the separate FS-lane gate reconciliation. The #157 repair is proven in CI only (63/63, real PostgreSQL). | — |

**Checks 6–8, in detail** (demo company `596d264c-db15-4e71-8d71-0d1d55d004af`, invented data):

**The same-name upload:** `1a5626c3-2a85-4294-980b-90f7a3509805` (`same-name-two-codes.csv`, SHA-256 `749eb246…`). It is `active_processed`, status `complete`, and it superseded `d54f3df1…`. Certification `03ba950c…` (sequence 76) is unchanged; its full-row SHA-256 is `7941016d…5ac05268f`.

**Its two runs**, both generation 6, completed, with no `error_code`:

| | Engine run | Started | Certification | Sequence | `requires_review` |
|---|---|---|---|---|---|
| First check | `acaa0cde-fd62-45ff-8109-a48083226071` | 13:10:57Z | `390021b2…` | 77 | **true** |
| After review | `29a53d1a-b9ec-40a0-b9a4-d0e4d11f7fa3` | 13:13:49Z | `c5ebf2d8-a70c-4219-8471-a6074f1bb6a1` | 78 | **false** |

**What cleared review:**
- **One authorised batch.** Batch `875128e0-6516-49e9-8236-150ef84a673b`, written at 2026-10-18 13:13:45.395932Z (**Save & reprocess**) by the firm member with role **owner** (id kept in the private record), recorded three decisions for this upload: 4000, 4100 and 1000.
- **Each decision:** `proposal_type MACHINE_SUGGESTION`, `decision_action USER_ACCEPTED_SUGGESTION`.
  - 4000 → revenue (`d3cee73d…`);
  - 4100 → revenue (`6bc25bc5…`);
  - 1000 → current_assets (`c68e0127…`).
- **No earlier decisions.** None predate this upload.
- **The result:** `decisions_logged: 3`, `mappings_written: 3`. There were no 23505 errors and no refusals.

**The mappings:** `account_mappings` holds three rows, keys `4000`, `4100` and `1000`. 4000 and 4100 are **distinct rows**, both named "sales", each linked to its own decision. The latest certification shows all three at `evidenceTier 1`: the company's own reviewed mapping, matched by exact code, written by that batch.

**Processing control:**
- `trg_er_processing_control` (`engine_runs`), `trg_tbu_processing_control` (`trial_balance_uploads`) and `trg_tbc_processing_control` (`tb_certifications`) are present and enabled (`O`).
- `processing_control_allows(p)` = `NOT hold OR p = ANY(canary_company_ids)`.
- The current row is `hold false`, `canary_company_ids []`, `min_engine_generation 3`, `version 5`.

**Outstanding defects, owners and boundaries** (none blocks this milestone):

| Defect | Owner lane | Status |
|---|---|---|
| DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001 | Website review (TB UX) | Fixed in draft #164; unmerged and unpublished |
| DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001: a replaced over-limit file gets only a transient toast (`PrepareWorkspace.handleReplacePicked`) | Website review (TB UX) | Separate follow-up |
| DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001: the accounts awaiting confirmation, and what **Save & reprocess** confirms, are not clear on screen | Website review (TB UX) | Open |
| Publication outside the hold: `cfoclose.com` serves this release's frontend; the publisher and time are unrecorded | Owner | Open finding |
| CPU observability (a hosted CPU value correlatable per check) | Carried forward; required before broad rollout or any raise of the upload bounds | Open |
| Orphan cleanup #149 | Separate; weekly read-only inventory | Deferred |

The review-confirmation defect is display only. The database shows the confirmation was explicit and authorised, by the owner.

Kept separate, each under its own hold: FS reconciliation (including Reporting Pack reachability), privacy containment, pricing #161 and TB UX.

## Proposed disposition: demo-only restricted processing (pending ONE owner approval)

- **The change:** one call by a commercial administrator, signed in as themselves. First re-read `processing_release_control`; it is expected to be `hold false`, `[]`, `3`, `version 5`. If anything differs, stop and use the current values.
  `admin_set_processing_control(true, '{596d264c-db15-4e71-8d71-0d1d55d004af}', 6, 'tb-release-r1 restricted processing: demo company only, generation 6', 5)`
  - **Expected result:** hold true, canary `{596d264c…}`, floor 6, version 6.
  - **On `CONTROL_VERSION_CONFLICT`:** stop and re-read.
- **What it enforces:** the database (check 8) refuses every other company's trial balance checks with `PT503 PROCESSING_HELD`. That covers new runs, processing updates and certifications, on the live site, the preview and direct calls alike. Only the demo company processes, and only at generation 6.
- **What it does not restrict:** sign-up, sign-in, the website and uploading itself.
- **The generation floor is not an audience restriction.** It only retires engines older than generation 6.
- **Emergency stop:** the same day, on any stop condition.
  `admin_set_processing_control(true, '{}', 6, 'tb-release-r1 processing stopped: <reason>', <current version>)`
  It clears the canary list, so all processing stops, the demo company's included. The floor stays at 6.
- **Publish:** no further publish. The live frontend already serves this release.
- **Residual risks accepted by this approval:**
  - **CPU headroom is unknown.** Check 9 stays BLOCKED, and passing test files prove nothing about dense inputs within the bounds (2,000 accounts, 10,000 rows, 120,000 cells, 10 MiB). A dense file could be terminated mid-check: a visible 546, nothing certified, recovered after the 600 s lease.
  - **An inaccurate message.** Non-demo customers would see *"Processing is paused for a short system update. Try again in a few minutes."* This is a known limitation, not fixed in this release.
  - **Monitoring limitations:**
    - *Durable* (database): interrupted or expired processing attempts (`abandoned`/`LEASE_EXPIRED`, or `running` past `lease_expires_at`), failed generation-6 runs, refusals by code, the largest `accounts_read`. These identify that an attempt did not finish, **not why**.
    - *Supplementary* (provider logs, whose retention and access are unverified): `edge_logs` 546s and CPU-limit lines. A missing log is a gap, never "no events".
    - There is no alerting.
  - **Stop conditions:** an interrupted or expired attempt on an upload over 1,000 accounts; any 546 seen; an unexpected capacity refusal.
  - **Review date: 2026-10-25.**
- **Responsibilities for explicit acceptance** (none assigned):
  1. the daily monitoring operator (durable query, plus the supplementary logs where available; records kept private);
  2. the commercial administrator who applies the emergency stop the same day;
  3. the owner of the 2026-10-25 decision;
  4. the operator of the weekly orphan inventory.

## Installation (evidenced; Lovable report, 2026-10-18)

| Item | Result |
|---|---|
| Journal rows 59–62 | Hashes equal the registered wrapper hashes (`ea99a585…`, `d76f6fa2…`, `74bad382…`, `ae02220e…`). Stored wrappers byte-identical. Mirrors `0058`–`0061` registered by #158 (`ece9c8e`). |
| Five functions | Deployed with matching closure fingerprints: `trial-balance-draft` `55015e57…`, `process-trial-balance` `67cbf27b…`, `trial-balance-layout` `f943969b…`, `seal-reporting-pack` `095a9ed9…`, `trial-balance-source-sweeper` `5eb9ee15…`. `layout-assist` not deployed. |
| Sweeper readiness | `OPTIONS` → 405 is its intended server-only contract (`index.ts:18`: POST only, no CORS, ticket-authenticated). The readiness exception is documented in HANDOFF. |
| Processing control | Floor 3, version 5, unchanged. |
| Publication | **Open finding.** `cfoclose.com` serves `/assets/index-CvSeSTte.js`, which contains this release's frontend (restore control, draft flow), although Publish was to be held. The runtime app code is identical from `96305da` through `02c516a`. The publisher and time are not recorded in GitHub; the owner to confirm. |

## Record A: catalog verification (`postcondition.sql`): evidenced
`postcondition.sql` at `3422002` (catalog-only, #159) was run verbatim, read-only, by the hosted read-only role and returned **`POSTCONDITION OK.`** (Lovable report, 2026-10-18). The original version stopped with `42501` because it invoked the service-role-only probe; that version is superseded.

## Record B: runtime verification (`runtimeEvidence.sql`): evidenced (Lovable report)
Upload `f0d5e808-7837-456e-8eeb-13081406868d` (the owner's hosted 2,000-account check, invented data):

| Check | Result |
|---|---|
| R1 | `engine_generation = 6`; the certification exists |
| R2 | `findings_summarized = true`, so the service-role probe ran on the processing path and answered |
| R3 | 2,002 findings stored = `findings_count`; recomputed SHA-256 = `findings_sha256` |
| R4 | 0 findings-store refusals |

Note: comparable CI 2,000-account runs recorded 2,003 findings. The count depends on the file's content, and R3's equality is the criterion.

Invocation `01a14e3c-3972-70f1-83c0-fdfc8c762535` is classified as an unauthenticated runtime probe, not a processing attempt (Lovable).

## Hosted CPU (HANDOFF §6.3, isolate upper bound)

### Provider-source citation: evidenced
`supabase/edge-runtime` at tag `v1.77.0`, the hosted runtime:
- **The field.** `ext/event_worker/events.rs` declares `ShutdownEvent { cpu_time_used: usize, … }`, set by `with_cpu_time_used(cpu_time_used_ms)`.
- **Where it comes from.** `crates/base/src/worker/supervisor/mod.rs` builds `WorkerEvents::Shutdown(ShutdownEvent { reason, memory_used, cpu_time_used: cpu_usage_ms })` from the supervisor strategy's result.
- **Units and the limit counter.** `crates/base/src/worker/supervisor/strategy_per_worker.rs` sets `cpu_usage_ms = accumulated / 1_000_000`, the worker thread's accumulated CPU time converted from nanoseconds to **milliseconds**. That same value is compared with `cpu_time_soft_limit_ms` and `cpu_time_hard_limit_ms`.
- **Per-request mode.** `strategy_per_request.rs` enforces limits on per-request deltas of the same timer, and returns the accumulated value (`cpu_usage_accumulated_ms`) at shutdown. That value is ≥ any one request.

Conclusion: `cpu_time_used` is the isolate's cumulative CPU time in milliseconds, from the CPU timer the limit is enforced on.

### Coverage: evidenced
The `process-trial-balance` closure at `3422002` has no child workers, no `waitUntil` and no subprocess. Its only timer is the in-isolate admission queue.

### Original upload `f0d5e808…`: CPU BLOCKED
Its runtime and storage evidence (Record B) stands. Its CPU telemetry is unavailable: the `[PTB]` line reports `cpu_ms=unavailable`, and no correlated `Shutdown` was captured. A completed status establishes neither CPU usage nor the absence of a provider-level 546. So its CPU gate is **BLOCKED** and is not carried forward.

### Run 2 (`resource-2000-accounts-run2.csv`): runtime integrity PASS, hosted CPU BLOCKED
- **Runtime integrity: PASS** (Lovable report, 2026-10-18).
- **Hosted CPU: BLOCKED.** The §6.3 correlation and numeric CPU were not obtained through the hosted channel.
- **No further owner uploads** are to be repeated for CPU.

### Why the function cannot measure its own CPU (edge-runtime `v1.77.0` source)
- **No `process.cpuUsage`.** `ext/node/polyfills/process.ts` defines `process.cpuUsage()` as `warnNotImplemented(...)`, returning `{ user: 0, system: 0 }`. Our `[PTB]` line therefore correctly reports `unavailable`.
- **No other CPU source.** `ext/runtime/js/namespaces.js` exposes `EdgeRuntime.getRuntimeMetrics()` only to the MAIN worker, never to a user worker. Its `RuntimeMetrics` (`types/global.d.ts`) holds heap and request counts and no CPU field.
- **Result:** no in-function measurement change can produce CPU time on this runtime. The only CPU figure is the supervisor's `Shutdown.cpu_time_used`, which is reachable only through the provider's log channel. Source support for that field is not proof that our hosted channel exposes it for a given run.

### Telemetry lookup: no correlated value; the gate stays BLOCKED
The final read-only lookup produced no correlated numeric `cpu_time_used` for either run. The measured-CPU gate (≤ 1,500 ms) stays **BLOCKED**; it is not waived or revised. The disposition is the separate demo-only restricted processing in the close-out above, which supersedes the earlier "provisional pilot acceptance" draft.

## Functional checks: final
- **Refusal and restore: PASS.** Refused upload `091ad003-d203-43dd-8e32-1ed7c2172564` (`TOO_MANY_ACCOUNTS`, 0 certifications, later `retired`); restored `d54f3df1-a02c-4c68-a05a-6b7ea34d557a`; certification `03ba950c-be43-42c0-96da-d266aa479290` (sequence 76) byte-identical (`7941016d…5ac05268f`); no new run. Source: Lovable plus the owner's screenshots.
- **Over-10 MB replacement** (`replacement-over-10mb.csv`, 12,000,039 B, SHA-256 `68fcd485…`):
  - data preservation **PASS**: no upload, object or engine run; predecessor and certification unchanged;
  - visible message **FAILED** (DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001).
- **Same-name identity and review lineage: PASS.** See the close-out.
- **Busy/retry: NOT EXERCISED** on hosted.
- **Reporting Pack seal: NOT EXERCISED.** Reachability unresolved in the FS lane.

## Not release evidence
The UX defects are listed in the close-out table, owned by the website review (TB UX) lane, and are display only. DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001 is fixed in draft #164, unmerged and unpublished.
