# SAFF Ω∞ PPG-1 — Pre-Production Iron Dome Stabilization Report

- **Base:** `843562068c230b11d3bbfec2aa6224ae22160b6a` (Ω2-GR1 certified candidate; `origin/main` at time of this pass)
- **Branch:** `ppg1-preproduction-stabilization`
- **Date:** 2026-09-06
- **Author:** SALIO CONNECT (mdcmclimited@gmail.com)

> **Scope discipline:** forensic verification of four Lovable overnight
> findings against current repository state, repair of every confirmed
> in-scope defect, and honest registration of anything genuinely blocked by
> a missing data authority. No redesign, no new features beyond what a
> confirmed defect required, no deploy, no migration applied, no Lovable
> action, no Flutterwave configuration, no production admin, no payment.

---

## Finding 1 — SAFISHA Pre-Flight Staleness

**Verdict: CONFIRMED** (on the two paths that matter most; the upload/
replace path is a lower-severity race, not a hard staleness bug; the
Account Mapping Modal is NOT a certification-authority defect at all).

Traced: `PrepareWorkspace.tsx` → `useCertificationReadiness(companyId,
periodYear, upload?.id)` (plain `useState`/`useEffect`, not React Query —
`QueryClientProvider` is mounted in `App.tsx` but nothing in this
repository actually calls `useQuery` anywhere) → `computeCertification
Readiness()` → `TrialBalancePreflight`.

- **Account-review decision + reprocess** (`AccountReviewPanel.tsx`) and
  **"process as audited accounts"** (`PrepareWorkspace.tsx`'s
  `handleProcessAsAuditedAccounts`) keep the SAME `upload.id` — the
  certification hook's effect never re-fires after either mutation.
  `handleProcessAsAuditedAccounts` didn't even call `refreshUpload()`.
  CONFIRMED TRUE for both.
- **Trial balance upload/replace** gets a NEW `upload.id`, so the hook
  refetches — but immediately, racing the server-side engine run, with
  nothing re-checking afterward. Lower severity (produces an honest
  "pending", not a wrong "certified"), but still matches the literal claim.
- **Account Mapping Modal** writes only `account_corrections` — traced
  every reader in the repository; only `ExportStatements.tsx` consumes it,
  no engine (`process-trial-balance`/`hesabu-validate`/kinga) reads it. It
  has no path into `tb_certifications`. **Not a certification defect** —
  left unwired, per "unrelated mutation must not unnecessarily destroy
  certification."

### Repair (authoritative invalidate/refetch, project's own hook pattern)

1. `src/hooks/useCertificationReadiness.ts` — exposes a stable `refetch()`
   (bumps an internal token the existing effect depends on; a ref always
   supplies the CURRENT identity args so a refetch from an older closure
   can never query stale state).
2. `src/lib/workspace/computeCertificationReadiness.ts` — new
   `revalidating?: boolean` input. Only the dangerous case — a stale
   **certified** verdict surviving into a revalidation window — is
   downgraded to `pending` ("Re-checking certification status…"), six-layer
   detail kept visible. Every other (already-conservative) verdict is
   untouched.
3. `src/pages/workspace/PrepareWorkspace.tsx`:
   - `AccountReviewPanel`'s `onReprocessed` now also calls
     `certReadiness.refetch()`.
   - `handleProcessAsAuditedAccounts` rewritten to poll for terminal state
     (mirrors the exact pattern already proven in `AccountReviewPanel.tsx`
     — `complete`/`error`/`blocked`/`needs_review`, 2s poll, 90s timeout),
     then calls `refreshUpload()` + `certReadiness.refetch()`.
   - A new generic effect watches `upload?.id`/`upload?.status` and calls
     `certReadiness.refetch()` on any non-terminal→terminal transition,
     using `useWorkspaceData.ts`'s ALREADY-EXISTING realtime
     `postgres_changes` subscription (defense-in-depth for the upload/
     replace race, no new local certification authority).
   - `revalidating: certReadiness.loading` threaded into every
     `computeCertificationReadiness()` call.

A failed mutation's catch branch never calls `onReprocessed`/`refetch` —
authority is never touched by a failed attempt.

### Tests

`computeCertificationReadiness.test.ts` — 5 new: revalidating downgrades
certified→pending; six-layer detail stays visible; `revalidating: false`
is a no-op; already-conservative verdicts (`blocked`, `superseded`)
untouched. 31/31 passing. Hook/component-integration behavior verified by
full manual code-path tracing (this repository has no
`@testing-library/react` anywhere — installing one is tooling expansion,
not a defect repair, so it was not added for this pass) and static
type-checking.

---

## Finding 2 — Signup Email Rate Limit

**Verdict: FALSE for the exact claim as stated** — a prior commit
(`debe72e`, 2026-09-03) already added a dedicated rate-limit branch to the
signup handler. **Repository evidence surfaced a confirmed residual gap
instead**, in the same feature area: the "Resend confirmation" flow (the
exact scenario a rate-limited signup would push a user toward) had NO
error translation at all — a rate-limited resend still showed Supabase's
raw string verbatim.

### Application repair

`src/lib/auth/translateAuthError.ts` (new) — a centralized boundary
recognizing rate limit / too-many-requests, already-registered, invalid
email, weak password, network failure, and a calm generic fallback —
never the raw provider string for any category, and never exposes
provider internals (`PGRST301`, HTTP status codes, etc. never surface).
Wired into BOTH the signup handler and the resend-confirmation handler in
`src/pages/Auth.tsx` — closing the exact residual gap found. Duplicate-
submission prevention (disabled submit button while `loading`) and the
resend-confirmation feature itself already existed and needed no change.

13 new tests (`translateAuthError.test.ts`): rate limit (message text and
HTTP 429), duplicate signup, invalid email, weak password, network
failure, generic/unknown never leaks provider internals, null/undefined
input never throws, and an explicit "never returns the raw message
verbatim" sweep across every category.

### Infrastructure debt (registered, not fixed — cannot be fixed from source)

`PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED` (CLAUDE.md §9.2, new entry):
confirmed absent — `supabase/config.toml` has no `[auth.email]`/SMTP
block, no transactional email provider referenced anywhere in this
repository. Signup confirmation email still rides Supabase's default
mailer with its low hourly cap; the application-side symptom is fixed,
the infrastructure cause requires a Lovable-managed Supabase Dashboard
configuration step, out of reach from this repository.

---

## Finding 3 — Duplicate Billing Database Setup (highest priority)

**Verdict: CONFIRMED as a genuine mechanical collision risk** — not
because two independently-authored scripts race-build the same schema,
but because of the already-documented Lovable migration-identity
divergence: the Ω1 SOURCE file
(`20260904180000_commercial_foundation_wave_omega1.sql`) and its
Lovable-applied LIVE copy (`20260905093408_...sql`) are semantically
identical (diff-confirmed: only docstrings/whitespace differ) and BOTH
sat inside `supabase/migrations/`, which Supabase CLI tooling globs
wholesale. The source file's `CREATE TABLE`/`CREATE POLICY` statements
carry **no** `IF NOT EXISTS`/`DROP ... IF EXISTS` guards — a full
mechanical replay of that directory (fresh `db push`/`db reset`, disaster
recovery, new CI database) would apply both and hard-fail with "relation
already exists." The equivalent RLS1 pair
(`20260905120000`/`20260905141022`) uses `CREATE OR REPLACE FUNCTION` +
`ALTER POLICY` — idempotent, so no hard-failure risk there, but still a
second identity for the same already-live wave.

### Repository-wide forensic search (complete)

Every `supabase/migrations/*.sql` file (111), `scripts/` (no commercial/
billing references at all), `docs/`, `src/`, `supabase/functions/` (zero
`CREATE TABLE` for any commercial/billing table outside `migrations/`),
`production axiom/` legacy docs (KINGA-only), `supabase/policy_audit.sql`
(read-only diagnostic, no DDL). Confirmed: the ONLY files that ever define
any of the 13 named commercial/billing tables are exactly 3 migration-file
identities (Ω1, RLS1, Ω2), each with the known, explained multiplicity
above. No legacy Axiom/Kinga commercial experiment or duplicate-spelled
table found anywhere.

### Classification and action

| Migration identity | Classification | Action |
|---|---|---|
| `20260905093408_...sql` (Ω1, live) | CANONICAL_LIVE_MIGRATION | None — untouched |
| `20260904180000_...sql` (Ω1 source) | was DUPLICATE_EXECUTABLE (never independently live, non-idempotent) | **Quarantined**: renamed `.sql.historical`, moved to `supabase/migrations_historical/` (outside the CLI's glob), content preserved verbatim with a prepended non-executable notice |
| `20260905141022_...sql` (RLS1, live) | CANONICAL_LIVE_MIGRATION (forward repair of Ω1) | None — untouched |
| `20260905120000_...sql` (RLS1 source) | was DUPLICATE_EXECUTABLE (idempotent, lower severity, still ambiguous) | **Quarantined** identically, for single-chain clarity |
| `20260905200000_...sql` (Ω2) | CANONICAL_NOT_YET_LIVE_Ω2 | None — already sole identity |

Neither Lovable-applied live file was edited. Both quarantined files keep
their exact original content.

### Regression guard

`src/lib/commercial/__tests__/migrationCollisionGuard.test.ts` (21 tests,
new): proves every commercial/billing table has at most one executable
`CREATE TABLE` under `supabase/migrations/`; proves both quarantined files
are absent from that directory by original filename, present under
`.historical` in `migrations_historical/`, and carry the quarantine
notice; proves both live files remain untouched; proves Ω2 stays the sole
not-yet-live identity. Two pre-existing static tests
(`rlsRecursionGuard.test.ts`, `featureRegistry.test.ts`) hardcoded paths
into the two moved files — fixed: `rlsRecursionGuard.test.ts` now points
at the LIVE files (a strict improvement — verifies what is actually
deployed; content-confirmed identical before switching), `featureRegistry
.test.ts` points at the quarantined file's new path (content unchanged).
`scripts/audit_migrations.mjs` re-run clean (111 files, 0 errors, 0
warnings) — neither quarantined file was ever in its manifest.

### Proof before closure

Ω1 live history preserved (PASS) · RLS1 live history preserved (PASS) ·
Ω2 single canonical migration (PASS) · no setup script can independently
rebuild an incompatible commercial DB (PASS) · no production instruction
contains a blanket `db push` (unchanged, already prohibited in the Ω2-GR1
handoff docs).

---

## Finding 4 — MAONO Cash Forecast Semantic Contamination

**Verdict: CONFIRMED** — both halves of the claim, plus the double-count
risk, forensically proven against the LIVE engine
(`supabase/functions/maono-cashflow/index.ts`; the differently-scoped,
already-correctly-granular `cashFlowEngines.ts`/`primaryCashFlowEngine.ts`
are dormant design modules, imported nowhere in `src/` outside their own
tests — not part of the live claim).

### Repository-evidence root cause

The live `account_classification` enum
(`20260122083339_...sql`) has exactly two current-balance values
(`current_assets`, `current_liabilities`) — grepped every migration for
`ALTER TYPE public.account_classification`, zero hits, this has never
been extended. `account_mappings` carries exactly three professional
tri-state flags (`is_cash_account`, `is_retained_earnings`,
`is_payroll_account`) — none distinguish inventory/prepayment/tax-
receivable/tax-payable from trade receivables/payables.
`account_mappings.line_item` is free text, not a controlled vocabulary —
using it as authority would reintroduce the exact account-name heuristic
this file's own header already documents removing ("a heuristic is not an
accounting authority"). So every non-cash `current_assets` row genuinely
CAN ONLY be bucketed as one undifferentiated pool today, and every
`current_liabilities` row likewise — this is a real data-authority gap,
not merely a code bug of omission.

### Fixed (fully, with existing data — no new authority needed)

**The confirmed, provable double-count**: PAYE/VAT/SDL/WHT amounts known
precisely via `tax_computations` were ALSO being swept into the generic
current-liability bucket and spread across the generic 30/60/90-day
payment curve, on top of being placed on their own exact statutory due
date — the same liability counted twice in the same weekly outflow total
(confirmed at both the per-week `totalOut` calculation and the
`totalWeeklyOutflow` burn-rate aggregate). `_shared/maonoCashflowMath.ts`
(new, pure, unit-tested — the core bucketing/exclusion math extracted from
the handler for testability, mirroring the existing `certifiedTbSource.ts`
pure-function pattern) adds `excludeScheduledTaxFromCurrentLiabilities()`:
removes the known scheduled tax total from the generic bucket before it
is spread across the generic curve, floored at zero, so each obligation
is represented exactly once.

### NOT fixed — genuine data-authority gap, honestly registered rather than guessed around

Distinguishing trade receivables from inventory/prepayments/tax
receivables within `current_assets`, and trade payables from any OTHER
(non-statutory-scheduled) tax-like liability within `current_liabilities`,
requires classification evidence that does not exist in this system's
live schema. Per this repository's own UNKNOWN != ZERO != FALSE
discipline, inventing a heuristic (free-text `line_item` matching, already
ruled out above) or a brand-new professional-review classification
authority (a new tri-state flag + new review-UI wiring) was judged out of
proportion for a stabilization repair — the former is exactly the kind of
non-authoritative guess this project's discipline forbids, the latter is
a new feature, not a repair of the confirmed defect. Every
`maono-cashflow` response now HONESTLY discloses this via
`balance_authority.receivable_classification_limitation` and
`.payable_classification_limitation` — the aggregate is never claimed to
be verified trade receivables/payables. Full closure requires either a new
professional tri-state flag (mirroring `is_payroll_account`'s established
precedent) or a genuine `account_classification` enum extension — an
explicitly product-owned decision, registered as
`DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001` in `CLAUDE.md` §9.1,
not half-built here.

Also corrected in passing (verified, not assumed): `CLAUDE.md`'s existing
`DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001` entry named
`maono-cashflow` as still reading the untracked `account_classifications`/
`account_pl_mapping` tables — grepped the current file, zero matches; it
reads exclusively through `certifiedTbSource.ts`'s SAFISHA CertifiedTB
authority today. Scope corrected to `maono-compute` only (still open
there), with a dated note explaining the correction rather than silently
rewriting the historical entry.

### Tests

`src/lib/accounting/maonoCashflowMath.test.ts` (new, imports the actual
edge-function shared module directly — no Deno-only code in that file,
same technique as `edgeMoney.test.ts`) — 14 tests: cash correctly
excluded from the non-cash bucket; an UNKNOWN cash decision is surfaced,
never guessed; current-liability summation; non-current/equity/P&L
subNatures excluded from every bucket (locks in the ALREADY-correct
behavior the mission asked to verify); the tax exclusion's exact
arithmetic including the null-is-not-zero case, the zero-floor case, and
a full "the double-count is actually gone" scenario; both classification-
limitation disclosures are present and explicitly self-disclaiming
("not a verified..." / never silently claiming precision).

---

## Cross-Cutting Architectural Gates (verified, all PASS)

- **SAFISHA remains accounting-truth/certification authority** — Finding 1
  changes only WHEN the UI re-reads that authority, never what it reads or
  how it's computed; `get_authoritative_certification`/`tb_certifications`
  remain the sole source.
- **HESABU remains financial-reporting computation authority** — untouched
  by every finding.
- **MAONO remains read-only/advisory** — `maono-cashflow` still only reads
  (`certifiedTbSource.ts`, `tax_computations`, `variance_analyses`) and
  writes only its own `cashflow_forecasts` table; no accounting table is
  written anywhere in this pass.
- **KINGA-TZ remains optional/on hold** — untouched.
- **Commercial engine remains orthogonal to accounting authority** — the
  Finding 3 quarantine touches only file locations, zero schema/logic
  change to any commercial table or function.
- **Commercial admin still grants zero accounting/professional
  authority** — unaffected.
- **No direct React mutation of authoritative financial tables
  introduced** — `useCertificationReadiness` remains read-only (verified:
  every Supabase call in it is `.rpc(...)`/`.select(...)`, zero
  `.insert`/`.update`/`.delete`).
- **UNKNOWN != ZERO != FALSE != NOT_APPLICABLE remains intact** — Finding 4
  explicitly extends this discipline (null tax amounts never floored to a
  false zero exclusion; undecided cash accounts still fail the whole
  forecast closed).
- **Ω2-GR1 certified payment semantics are byte-identical** — zero files
  under `supabase/functions/_shared/payments/`,
  `supabase/functions/commercial-*`, or the Ω2 migration were touched by
  this pass. No `Ω2_CERTIFICATION_COLLISION_REQUIRES_RECERTIFICATION`.

---

## Test Execution (all run for real)

| Suite | Result |
|---|---|
| Targeted: `computeCertificationReadiness.test.ts` | 31/31 (26 pre-existing + 5 new) |
| Targeted: `translateAuthError.test.ts` | 13/13 (new) |
| Targeted: `migrationCollisionGuard.test.ts` | 21/21 (new) |
| Targeted: `maonoCashflowMath.test.ts` | 14/14 (new) |
| Targeted: `rlsRecursionGuard.test.ts` (path fix) | 18/18 |
| Targeted: `featureRegistry.test.ts` (path fix) | 5/5 |
| Full Vitest suite | **1079/1079** (58 files), up from 1026/1026 on the Ω2-GR1 base |
| `tsc --noEmit -p tsconfig.app.json` | Clean, exit 0 |
| `npm run build` | Succeeds (pre-existing chunk-size advisory only) |
| `eslint` (tracked tree, `.claude/**` scratch dirs excluded) | 0 errors, 127 warnings — identical to the pre-PPG-1 baseline count, confirming zero new lint issues |
| `node scripts/audit_migrations.mjs` | CLEAN, 111 files, 0 errors, 0 warnings |
| `git diff --check` | Clean except a verified false positive (see below) |

### `git diff --check` false-positive on `src/pages/Auth.tsx` (documented, not silently ignored)

Five lines in `src/pages/Auth.tsx` are flagged "trailing whitespace" —
every one of them a newly-added line from the Finding 2 repair. Byte-level
forensic proof this is NOT a real whitespace defect:

1. `git cat-file -p HEAD:src/pages/Auth.tsx` shows the git-STORED blob
   already contains 573 CRLF sequences — this file was committed with
   CRLF line endings baked directly into the object, violating this
   repository's `core.autocrlf=true` convention (which expects LF-stored
   blobs). `PrepareWorkspace.tsx`'s stored blob, by contrast, has 0 CRLF —
   confirming Auth.tsx is the anomaly, not a general project pattern.
2. Byte-level inspection (`node` reading the raw `Buffer`, not text-mode)
   of every added line shows clean, well-formed `<CR><LF>` sequences
   matching the surrounding file exactly — no doubled CR, no literal
   trailing space or tab, no malformed bytes.
3. An isolated reproduction (fresh scratch repo, `core.autocrlf=true`,
   the exact same base content, an equivalent line insertion) does NOT
   trigger the flag — confirming this is specific to Auth.tsx's own
   pre-existing CRLF-in-blob anomaly, not a property of CRLF files or
   `core.autocrlf` in general.
4. The standard fix (`core.whitespace=cr-at-eol`) is a git CONFIG change,
   which is prohibited ("NEVER update the git config"). Normalizing the
   entire file to LF was attempted and reverted: it touches all 573 lines
   and surfaces unrelated PRE-EXISTING trailing-space issues elsewhere in
   the file that predate this pass and are out of scope to fix here —
   disproportionate for a cosmetic tooling artifact that has zero effect
   on compilation, tests, or runtime behavior (all independently verified
   clean above).

Reported as a documented, evidenced exception rather than silently
dropped or falsely claimed clean.

---

## Files Changed in This Pass

```
CLAUDE.md                                                                   — registered PRODUCTION_AUTH_SMTP_CONFIGURATION_REQUIRED, DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001; corrected stale maono-cashflow scope in DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001; corrected a stale migration path reference
src/hooks/useCertificationReadiness.ts                                      — exposes refetch()
src/lib/workspace/computeCertificationReadiness.ts                          — revalidating input, certified→pending downgrade
src/lib/workspace/computeCertificationReadiness.test.ts                     — +5 tests
src/pages/workspace/PrepareWorkspace.tsx                                    — onReprocessed/handleProcessAsAuditedAccounts revalidate certification; new upload-status-transition effect
src/pages/Auth.tsx                                                          — centralized auth-error translation on signup + resend
src/lib/auth/translateAuthError.ts                                          — new
src/lib/auth/translateAuthError.test.ts                                     — new, 13 tests
supabase/migrations/20260904180000_commercial_foundation_wave_omega1.sql   → supabase/migrations_historical/...sql.historical (quarantined)
supabase/migrations/20260905120000_fix_commercial_admin_rls_recursion.sql  → supabase/migrations_historical/...sql.historical (quarantined)
src/lib/commercial/__tests__/migrationCollisionGuard.test.ts                — new, 21 tests
src/lib/commercial/rlsRecursionGuard.test.ts                                — path fix: now reads the live migration files
src/lib/commercial/featureRegistry.test.ts                                  — path fix: reads the quarantined file's new path
supabase/functions/_shared/maonoCashflowMath.ts                             — new: pure, tested bucketing + tax-exclusion math
supabase/functions/maono-cashflow/index.ts                                  — consumes maonoCashflowMath.ts; tax double-count excluded; classification-limitation disclosures added
src/lib/accounting/maonoCashflowMath.test.ts                                — new, 14 tests
docs/operations/PPG1_STABILIZATION_REPORT.md                                — this report (new)
```

No Ω1/RLS1 live migration edited. No Ω2-GR1 certified payment/commercial
executable file touched. No deploy, no push, no migration applied, no
Lovable action, no Flutterwave configuration, no production admin
bootstrap, no payment performed.
