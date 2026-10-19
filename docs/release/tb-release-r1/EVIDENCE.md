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
| DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001: a replaced over-limit file gets only a transient toast (`PrepareWorkspace.handleReplacePicked`) | Website review (TB UX) | Fixed in draft #170 (stacked on #168; persistent `role="alert"`); unmerged and unpublished |
| DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001: the accounts awaiting confirmation, and what **Save & reprocess** confirms, are not clear on screen | Website review (TB UX) | Partly covered by #164 (the pre-selected-suggestions notice); the per-row marker, the count on the action, the post-save summary and the "Previously reviewed" labels await the owner's go-ahead |
| Publication outside the hold: `cfoclose.com` serves this release's frontend; the publisher and time are unrecorded | Owner | Open finding |
| CPU observability (a hosted CPU value correlatable per check) | Carried forward; required before broad rollout or any raise of the upload bounds | Open |
| Orphan cleanup #149 | Separate; weekly read-only inventory | Deferred |

The review-confirmation defect is display only. The database shows the confirmation was explicit and authorised, by the owner.

Kept separate, each under its own hold: FS reconciliation (including Reporting Pack reachability), privacy containment, pricing #161 and TB UX.

## Disposition (owner decision, 2026-10-18): continued public processing with accepted residual risk

The owner chose continued public trial balance processing with accepted residual risk. It is **not** a controlled pilot, and no demo-only restriction is applied.
- `hold` stays **false** and `canary_company_ids` stays **empty**.
- The current upload limits (`tb-upload-policy-3`) are retained.
- Numeric CPU measurement stays **BLOCKED**; it is not labelled PASS.

**Prepared (not applied): the generation-6 floor update.** A commercial administrator applies it, signed in as themselves.
1. Re-read the control row: `SELECT hold, canary_company_ids, min_engine_generation, version FROM public.processing_release_control;`. It is expected to be `false`, `{}`, `3`, `5`; use the version actually read.
2. Call: `admin_set_processing_control(false, '{}', 6, 'tb-release-r1: generation 6 floor; continued public processing, residual risk accepted', <version read in step 1>)`
3. Expected: `hold false`, canary `{}`, `min_engine_generation 6`, version + 1. On `CONTROL_VERSION_CONFLICT`, stop and re-read. The floor can only rise, so it cannot be undone. Only generation 6 is deployed, so no deployed engine is retired.

**Emergency hold (available at any time, the same day on a stop condition):**
`admin_set_processing_control(true, '{}', 6, 'tb-release-r1 emergency hold: <reason>', <current version>)`
- The database then refuses every new check, everywhere, with `PT503 PROCESSING_HELD`.
- Release it with the same call with `hold` false, after the cause is understood and recorded.

**Failure and retry behaviour, as customers see it** (`src/lib/ingestion/uploadFlow.ts`, `process-trial-balance`):
- **Over a bound** (file > 10 MB in the browser; more than 2,000 accounts, 10,000 rows or 120,000 cells on the server): an explicit refusal naming the limit. Nothing is certified and the file stays saved.
  - Over 10 MB on the replace path: only a transient toast (DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001).
  - A refused replacement supersedes the previous trial balance until **Restore the previous trial balance** (verified).
- **Busy** (`503 PROCESSING_BUSY` with `Retry-After`), a dropped connection, or a 5xx including a CPU-limit **546**: *"The file is saved, but the check could not be completed — the connection dropped or the service was busy. Check again; it will not be counted twice."* The retry reuses the same request.
- **A killed or interrupted attempt:**
  - While its 600 s lease runs, a retry is answered "in progress" and the page waits.
  - After the lease, the retry abandons the attempt (`LEASE_EXPIRED`) and answers *"The earlier check of this file did not finish. Check it again."*. The next check is a new request.
  - A failed attempt never certifies anything, and a late finish by a stale worker is refused.
- **During an emergency hold:**
  - an upload's check shows the generic "service was busy … Check again" message above;
  - a reprocess shows *"Checking is paused briefly for a system update. Try again in a few minutes."*

  Neither says how long the hold lasts; this is a known limitation.

**Residual risks accepted by this decision:**
- **Unknown CPU headroom** for dense inputs within the limits. Successful test files do not prove headroom across all allowed inputs. A file could be terminated mid-check, with the 546 → "did not finish" path above. It is visible to the customer, and nothing is certified.
- **Monitoring is manual, without alerting.**
  - *Durable* (database): interrupted or expired processing attempts (`abandoned`/`LEASE_EXPIRED`, or `running` past `lease_expires_at`), failed generation-6 runs, refusals by code, the largest `accounts_read`. These show that an attempt did not finish, **not why**.
  - *Supplementary* (provider logs, retention and access unverified): `edge_logs` 546s and CPU-limit lines. A missing log is a gap, not "no events".
- **Stop conditions** (apply the emergency hold the same day):
  - an interrupted or expired attempt on an upload over 1,000 accounts;
  - any observed 546 or CPU-limit line;
  - an unexpected capacity refusal.
- **Review date: 2026-10-25.** Continue, lower the limits through a reviewed policy change, or hold.

**Daily durable check** (read-only):

```sql
SELECT count(*) FILTER (WHERE status = 'failed') AS failed,
       count(*) FILTER (WHERE status = 'abandoned' AND error_code = 'LEASE_EXPIRED') AS expired,
       count(*) FILTER (WHERE status = 'running' AND lease_expires_at < now()) AS running_past_lease,
       count(*) AS runs
  FROM public.engine_runs
 WHERE function_name = 'process-trial-balance' AND engine_generation = 6 AND started_at >= now() - interval '1 day';
```

**Responsibilities for explicit acceptance** (none assigned):
1. the daily monitoring operator;
2. the commercial administrator who applies the floor update, and the emergency hold when needed;
3. the owner of the 2026-10-25 review;
4. the weekly orphan-inventory operator.

**Outstanding UX defects** (website review / TB UX lane, display only, not blocking):
- DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001 (fixed in draft #164, unmerged);
- DEFECT-UX-TB-OVERSIZE-REPLACEMENT-FEEDBACK-001;
- DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001.

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
The final read-only lookup produced no correlated numeric `cpu_time_used` for either run. The measured-CPU gate (≤ 1,500 ms) stays **BLOCKED**; it is not waived or revised. The disposition is the owner's decision above (continued public processing with accepted residual risk), which supersedes the earlier "provisional pilot acceptance" draft.

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

## Follow-up releases and scope closure (2026-10-19)

The releases below were owner-authorised. The release review was performed by the author; independent review was not performed.

| Release | Merged | Hosted | Published bundle | Verification |
|---|---|---|---|---|
| TB UX: #164, #168, #170 and #172, integrated as #173 | `07b44e5` (required CI green) | none (frontend only) | `index-BobKt_0o.js`, then carried into `index-7gPZbnny.js` | **DEPLOYED, NOT EXERCISED** in a signed-in browser. The bundle contains the new interfaces, and they were verified only in the synthetic harness before merge. The signed-in smoke check is listed below. |
| Pricing enforcement: #175 (from #161 and #174) | `100d43d` (CI green) | Migration `20261110100000` through its self-checking wrapper: journal 63, hash `d3f1ae17…`; `POSTCONDITION OK` | none | **LIVE VERIFIED** (database, Lovable read-only) |
| Pricing wording and journal close-out: #177 | `50282a3` (CI green; mirror `0062` registered, nothing pending) | none | `index-7gPZbnny.js` | **LIVE VERIFIED** in the browser, 2026-10-19, at 1280 px and 375 px, on `/pricing` and the landing plans section. Solo, Practice and Firm read "Unlimited team members"; Enterprise reads "Team members by agreement" / "By agreement". Prices (USD 490 / 990 / 2,990) and entity capacities (1 / 5 / 25) are unchanged. No USD 200 seat price, no "named user", no horizontal overflow. |

#161 and #174 are closed as superseded; their preservation was verified file by file. The publication order held: the live bundle carried no unlimited wording until enforcement passed.

**Signed-in TB smoke check: PENDING** (owner, existing demo data only; no upload, nothing reprocessed). On the demo company's FY2027 trial balance page, confirm:
1. **The progress ledger** shows the completed check with no spinner, and stages that never ran read "Not applicable".
2. **The Classification record** lists 4000, 4100 and 1000 as confirmed by the owner at 13:13 on 18 Oct, in batch `875128e0…`.
3. **File options, then Replace,** with `replacement-over-10mb.csv`, shows the persistent "is larger than 10 MB" alert beside Replace. It stays until dismissed. The file is refused in the browser, so nothing is uploaded.
4. **On the account home,** the engagement's button names the actual next step, not "Resume".

**This release scope is closed.** Still open, outside it:
- CPU headroom: **BLOCKED**;
- monitoring responsibilities: **unassigned**;
- the generation-6 floor update: prepared, not applied;
- busy/retry: not exercised on hosted;
- Reporting Pack: FS lane;
- payments: the Polar sandbox correction pending on hosted, Snippe disabled, external Polar wording;
- privacy: `KAMANGA_MEDICS_TB_2025.csv` is tracked on `main` (#171);
- #149: deferred, and must be renumbered.
