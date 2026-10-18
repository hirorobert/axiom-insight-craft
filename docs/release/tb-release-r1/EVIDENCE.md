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

### Recommendation if no access route exists (pending the owner's explicit decision)
**Revise the resource acceptance policy, from "measured CPU ≤ 1,500 ms" to "no CPU-limit termination at the account bound, under the enforced hard limit".**
- **Evidence it would rest on:**
  - **How the limit is enforced** (`strategy_per_worker.rs` / `strategy_per_request.rs`): the supervisor terminates a worker whose CPU reaches `cpu_time_hard_limit_ms`. The request is then answered 546, with a CPU-related shutdown reason.
  - **What runs 1 and 2 must show:** both are 2,000-account checks (the account bound). Each must have `edge_logs` HTTP 200 for its request, a persisted generation-6 certification (R1–R4 PASS) and no CPU-limit event. Together these bound each run's CPU strictly below the hosted hard limit.
  - **What has to be cited:** the hosted hard limit itself, as Supabase's documented "2 s CPU time per request", from provider documentation.
- **Residual risk, stated:**
  - The headroom between real CPU and the hard limit is **unknown**. This revision proves "below the limit", not "≤ 1,500 ms".
  - A denser file at the bound could still be terminated. That failure is explicit (546; nothing certified; the attempt is recovered after its 600 s lease).
  - The provisional upload limits (`tb-upload-policy-3`) stay provisional, to be revisited after a week of hosted runs.
- **Decision:** the owner either approves this revision in writing (recorded here with the date), or keeps the gate BLOCKED. A separately reviewed measurement change is not offered, because none is possible on this runtime (see above).
To be recorded verbatim from provider logs:
- `execution_id` and function version;
- the `[PTB] worker=… check=1 http=200 …` line and its timestamp;
- the `Boot` timestamp and `boot_time`;
- the `Shutdown` timestamp, `cpu_time_used` and `reason`;
- no other `[PTB]` line for that `execution_id`;
- no 546 or CPU-limit line.

**Run-2 file:** `resource-2000-accounts-run2.csv`: 2,000 invented accounts, balanced, 78,930 B, SHA-256 `88cb10d1e1cf536e0e76cb217868ebc05f7e3e8174ff40833c786d07988d2020`. Its bytes differ from run 1 so that it is a new source.

Raw log records are preserved privately by the owner (this repository is public). Only the fields above are transcribed here.

**Decision:** PASS if `cpu_time_used` ≤ 1,500 ms and every condition holds; otherwise BLOCKED.

## Remaining hosted checks: open
- Refusal: 2,001 accounts → `TOO_MANY_ACCOUNTS`, 0 certifications.
- Replacement over 10 MB, refused in the page.
- Replacement → restore, with the predecessor's certifications unchanged.
- Account identity: 4000 / 4100 "Sales" both kept.
- Busy/retry: PASS, or recorded **not triggered**. Accepting "not triggered" is the owner's decision; it is never marked PASS.
- Reporting Pack seal: **not exercised**. The official pack is unreachable in production builds (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`). Accepting that is the owner's decision; it is never marked PASS.

## Not release evidence
DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001 (the progress ledger keeps spinning on "Needs review"; unexecuted stages show "Done") is handed to the public website review session, which owns trial balance UX cleanup. It is fixed, display only, in draft PR #164 (head `31b2b9d`), which is not merged or published. It is not part of this release and does not block it.
