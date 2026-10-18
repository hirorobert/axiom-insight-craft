# Trial balance release tb-release-r1: hosted evidence record

This is the tracked record of hosted verification for main `02c516a` (the release); the application runtime is identical from `96305da`. Each entry is either **evidenced** (with its source) or **open**. Nothing is inferred, and no entry is marked PASS without its own evidence.

**Repository rule:** this repository is public, so no company names, user identities or client data are recorded here. Upload and execution ids are synthetic-run identifiers.

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

### Open: retrieve run 2's Shutdown from the existing log channel (no new upload)
Lovable reported seeing `Shutdown` events with `execution_id` and `cpu_time_used` in `function_logs` for another function. If the same read access returns them for `process-trial-balance`, §6.3 is evaluated **unchanged** on run 2, by its `execution_id`:
- the `Boot`, `[PTB] check=1` and `Shutdown` events correlate;
- `edge_logs` shows HTTP 200, with no 546;
- `cpu_time_used` ≤ 1,500 ms.

If that read access cannot return them, there is **no supported access route**, and the gate is decided by the recommendation below. It is never waived, and never marked PASS by default.

### If the lookup is unavailable
The measured-CPU gate (HANDOFF §6.3, ≤ 1,500 ms) stays **BLOCKED**. It is neither waived, revised nor marked PASS.

### Separate decision: provisional pilot acceptance (pending the owner's explicit, written decision)
This is a decision distinct from the measured-CPU gate, which stays BLOCKED. It would allow the generation floor and Publish for a **pilot**, without claiming the gate passed. Successful tested files do not prove CPU headroom across every allowed input (up to 2,000 accounts, 10,000 rows, 120,000 cells, 10 MiB).

**Evidence required before the decision (still to be recorded):**
1. Runs 1 and 2, both at the account bound: the `edge_logs` HTTP status for each request is 200, and no CPU-limit or `WorkerLimit` shutdown appears for their executions, as far as the logs show.
2. The hosted CPU hard limit, cited from Supabase's documentation ("2 s CPU time per request"). Plus the source fact that the supervisor terminates at the hard limit, answering 546 (`strategy_per_worker.rs` / `strategy_per_request.rs`).
3. The refusal, restore and account-identity checks below: PASS.

**Monitoring during the pilot** (read-only, daily by the named operator; records kept private):

```sql
SELECT count(*) FILTER (WHERE status IN ('failed','abandoned')) AS failed_or_abandoned,
       count(*) FILTER (WHERE error_code = 'LEASE_EXPIRED') AS lease_expired,
       count(*) AS runs
  FROM public.engine_runs
 WHERE function_name = 'process-trial-balance' AND engine_generation = 6 AND started_at >= now() - interval '1 day';
```

Also record `edge_logs` 546 responses for `process-trial-balance`, and the largest `accounts_read` processed each day.

**Stop conditions.** On any one of these, apply the processing hold (`admin_set_processing_control(true, …)`) and reopen the decision:
- any 546 or CPU-limit shutdown on `process-trial-balance`;
- an abandoned (`LEASE_EXPIRED`) generation-6 run on an upload of more than 1,000 accounts;
- a certification refused for a capacity reason other than the designed refusals (`TOO_MANY_ACCOUNTS`, `TOO_MANY_ROWS`, `TOO_MANY_CELLS`, file size).

Lowering the upload bounds would be a new reviewed policy change, never an ad-hoc edit.

**Review date: 2026-10-25.** On that date, the pilot is either confirmed on a week of hosted evidence or ended. The upload limits (`tb-upload-policy-3`) stay provisional until then.

**Residual risk accepted by this decision:**
- CPU headroom below the hard limit is unknown.
- A dense file at the bound could be terminated mid-check. That failure is explicit: a 546, nothing certified, and the attempt recovered after its 600 s lease.

## Remaining hosted checks: open
- **Refusal and restore (FY2027 demo period): PASS.** Source: Lovable's read-only report and the owner's browser screenshots, 2026-10-18. Contract followed: `20261109100000`.

  **The refused upload:** `091ad003-d203-43dd-8e32-1ed7c2172564` (`refusal-2001-accounts.csv`).
  - It was refused with `TOO_MANY_ACCOUNTS` and has 0 certifications.
  - It superseded the run-2 upload while refused. After the explicit browser **Restore the previous trial balance** (the owner completed the confirmation dialog), it is `retired`.

  **The restored predecessor:** `d54f3df1-a02c-4c68-a05a-6b7ea34d557a` (run 2, `resource-2000-accounts-run2.csv`).
  - It is the sole active upload, `active_processed`, with `superseded_by` NULL.
  - Its certification is unchanged and an exact match to the pre-replacement baseline: `03ba950c-be43-42c0-96da-d266aa479290`, sequence 76, engine run `1a7dbf0e-f56f-41a3-ac87-07abd0c91162`, certified 2026-10-18 10:59:38.980108+00, full-row SHA-256 `7941016d1676816cda78b001ded7606a484228417821b6a3d6669af5ac05268f`.
  - The restoration created no new engine run; the processing attempt remains 1.
- **Replacement over 10 MB** (`replacement-over-10mb.csv`, 12,000,039 B, SHA-256 `68fcd4851afb1f2c70ee6f19a36b7c93a72b4c4b4248f0c0f1ea028a4783e1e8`): open. Expected:
  - the page refuses the file before anything is uploaded ("larger than 10 MB");
  - no new `trial_balance_uploads` row exists;
  - the active upload stays `d54f3df1…`, its certification `03ba950c…` unchanged.
- Account identity: 4000 / 4100 "Sales" both kept.
- Busy/retry: PASS, or recorded **not triggered**. Accepting "not triggered" is the owner's decision; it is never marked PASS.
- Reporting Pack seal: **not exercised**. The official pack is unreachable in production builds (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`). Accepting that is the owner's decision; it is never marked PASS.

## Not release evidence
DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001 (the progress ledger keeps spinning on "Needs review"; unexecuted stages show "Done") is handed to the public website review session, which owns trial balance UX cleanup. It is fixed, display only, in draft PR #164 (head `31b2b9d`), which is not merged or published. It is not part of this release and does not block it.
