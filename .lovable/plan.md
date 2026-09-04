# SAFF Ω∞ Production Closure — One Pass

Canonical start: `30c1350c607a0a4865c790ee212c35481b268351` · Backend `bvyivmmfjejbmqoydezk`

I am in plan mode, so nothing is executed yet. Approving this plan runs the whole
pass below in one go and returns the single final release report.

## A. Apply the one authorized migration

Verified live now (read-only): all three `account_mappings` flags are
`NOT NULL DEFAULT false`, and live `resolve_account_review_batch` is the
pre-tri-state version (`coalesce(...,false)` on insert,
`is_cash_account = EXCLUDED.is_cash_account` on conflict). Pre-conditions match.

Apply exactly `supabase/migrations/20260904120000_account_review_flag_preservation.sql`
(drops NOT NULL + DEFAULT on the three flags; replaces the RPC with the
preservation logic). No other migration, no history repair, no reset.

Verify after: three columns NULLABLE/no default; RPC text matches canonical;
tri-state behaviour in a rollback-only transaction against synthetic fixtures:
existing TRUE + omitted → TRUE; explicit FALSE → FALSE; explicit TRUE → TRUE;
new row + omitted → NULL. Migration fails ⇒ stop, report, no improvised rollback.

## B/C. MAONO classification root cause and repair

Confirmed defect: `public.account_classifications` does not exist live;
`maono-compute/index.ts:319-324` throws on the query error (hard fail), and
`maono-cashflow/index.ts:130-144` swallows it via `(accts ?? [])`, collapsing
missing evidence into cash/AR/AP = 0.

Repair, read-only and reusing existing authority (no new accounting truth):
1. Trace lineage across `process-trial-balance`, `account_mappings`,
   `account_review_decisions`, `tb_certifications` /
   `get_authoritative_certification`, `period_closing_balances` and
   `_shared/maonoAnalyticalContract.ts` to name the one authoritative
   projection carrying the classification semantics MAONO needs.
2. Point `maono-compute` and `maono-cashflow` at that source, scoped to the
   run's own uploads/company/period.
3. Where classification or evidence is genuinely unavailable, return
   UNKNOWN / CANNOT_ASSESS / null through the existing analytical contract —
   never 0, false, empty, or NOT_APPLICABLE.
4. Sweep `maono-risk`, `maono-monitor`, `maono-root-cause`, `maono-decide` for
   the same root cause (legacy table reference or unknown→zero) and fix only
   those occurrences.

`account_classifications` is not created as a new mutable authority. A DB object
is added only if the lineage trace proves a read-only, provenance-carrying
projection over existing authority is the intended source — one additive,
RLS-safe forward migration at most, otherwise code-only.

## D. Authority collision gate

Prove before deploying: no new classification authority, no duplicate decision
ledger, no React writes to financial tables, no MAONO write into SAFISHA/HESABU
truth, no KINGA dependency, no prior-period evidence promoted, no sign-as-
classification, no manufactured zero. Must reach AUTHORITY_COLLISION = NONE or
deployment stops.

## F. Tests and gates

Add/extend tests for: evidence present; evidence absent; missing table does not
throw an uncontrolled DB error; absence never becomes zero; UNKNOWN propagation;
cross-company and cross-run isolation; no stale-run alert bleed; missing KINGA
enrichment ⇒ UNKNOWN; Phase-6 omitted flag preserves state; new omitted flag is
NULL; explicit false distinct from omitted.

Gates required before any deploy: full test suite pass, typecheck pass, build
pass, no release-blocking lint error, `git diff --check` clean. Unrelated
warnings are not touched.

## G. Optional AI

Check presence of `ANTHROPIC_API_KEY` in the live function environment (value
never revealed). Present ⇒ `maono-decide` may ship if its tests pass. Absent ⇒
report `OPTIONAL_AI_HELD_NO_SECRET`, hold those two functions, keep the frontend
honest about the unavailable narrative capability, and do not block the
deterministic release.

## H/I. Release

Deploy only the functions whose source actually changed and passed verification
(expected: `maono-compute`, `maono-cashflow`, plus `maono-risk` /
`process-trial-balance` only if genuinely changed), shipping
`_shared/maonoAnalyticalContract.ts` consistently. Then publish the frontend
from the canonical-derived tree and check `cfoclose.com` / `www.cfoclose.com`.

## J. Production acceptance

Run the 20-point smoke and authenticated acceptance path (load, auth, workspace,
certification authority, Account Review tri-state preservation, HESABU no
regression, MAONO opens without 500 and without period/run contamination,
UNKNOWN not zero, RLS and anon-DML checks, domain serves the release), using
isolated test data only.

Note: authenticated browser acceptance depends on a live preview session; if the
test browser reports signed-out, those items are reported NOT TESTABLE with the
exact blocker rather than guessed.

## K/L. Provenance and commit

The ~53 historical identity divergences stay registered as
MIGRATION_PROVENANCE_DEBT_ONLY — no repair, no replay. Source changes land as
one clean commit `fix(maono): remove legacy classification dependency and
preserve unknown evidence`, excluding Lovable artifacts and unrelated files, no
force-push. Note: direct GitHub push credentials are not available to this
environment; the commit lands in the Lovable-managed tree and GitHub main is
updated only through the platform's supported sync, reported honestly either way.

## Final output

One report with the 25 requested items and the required final verdict line.
