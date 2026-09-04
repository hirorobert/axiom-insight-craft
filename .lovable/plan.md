# SAFF Production Gate 0C — Canonical Main Synchronization

Read-only gate. No SQL applied, no function deployed, no publish, no secret change, no file in the project touched.

## 1. Sync mechanism — verified evidence

- Lovable's git remote is the platform-private mirror (`e7cc5596-…git`); there is no direct `github.com/hirorobert/axiom-insight-craft` remote inside the workspace.
- Mirror working branch: `edit/edt-be46d432-343e-475d-926d-b25dd47244f9`, HEAD `19de600465c9fca94af17b667890e5e5c5737ef9`.
- Mirror `origin/main` after an explicit fetch: `5c66946b278e060f21e2856bad79ed4552c66740`.
- `git cat-file -t 30c1350c…` in the mirror: object **not present**.
- `git ls-remote https://github.com/hirorobert/axiom-insight-craft main` → `30c1350c607a0a4865c790ee212c35481b268351`. GitHub canonical main is confirmed independently.

Conclusion: the mirror cannot be advanced from inside the sandbox by any non-destructive, platform-supported means. Mirror refs are platform-managed; pushing a hand-built commit would be exactly the "reconstruct/merge edit branch" action this gate forbids.

**Required UI action (you, before anything else):** open Git settings in this project, select branch `main`, and let it sync until it reports "In sync with GitHub". If it still shows `5c66946`, disconnect and reconnect the GitHub repository selecting `hirorobert/axiom-insight-craft`, branch `main`. Nothing else in this gate needs a UI action.

## 2. Canonical tree read directly from GitHub (read-only clone, outside the project)

Cloned `hirorobert/axiom-insight-craft` into a scratch directory; HEAD read back as `30c1350c607a0a4865c790ee212c35481b268351`. All Gate 0C artifact questions are answered from that tree.

- Canonical migration count: **107**. Mirror: **106**.
- `supabase/migrations/20260903100000_companies_reporting_framework_no_default.sql` — PRESENT canonically, ABSENT in mirror.
- `supabase/migrations/20260904120000_account_review_flag_preservation.sql` — PRESENT canonically, ABSENT in mirror.
- `supabase/functions/_shared/maonoAnalyticalContract.ts` — PRESENT canonically, ABSENT in mirror.
- Mirror carries two Lovable-generated migrations not on canonical main (`20260902173837…`, `20260903092335…`) — these are the platform-recorded identities of work already live.

## 3. TB certification authority (canonical main decides)

- `resolve_tb_certification`: **does not exist anywhere in canonical main.** It was a naming error in earlier reconnaissance, not a missing object. No function is to be created.
- Actual canonical authority: **write = `commit_tb_certification`**, **read = `get_authoritative_certification`**, over table **`tb_certifications`** (defined in `20260902130000` + `20260902150000`, consumed by `process-trial-balance`, `computeCertificationReadiness.ts`, `useCertificationReadiness.ts`).
- Live database: `commit_tb_certification`, `get_authoritative_certification`, `tb_certifications` all present. Certification authority is complete live — nothing pending.

## 4. ANTHROPIC_API_KEY

Only two executable functions reference it, both instantiating an Anthropic client directly:

- `maono-decide` — OPTIONAL_FEATURE (Phase 9 narrative decision paths). Required only if maono-decide is in the release set.
- `maono-root-cause` — OPTIONAL_FEATURE, same.

`maono-compute`, `maono-risk`, `maono-cashflow`, `maono-monitor` do **not** reference it; they import `_shared/maonoAnalyticalContract.ts`. So the Phase 9 analytical contract deployment does not require the key. No secret added.

## 5. Minimal production delta (recomputed against live state)

SCHEMA_CHANGE_ACTUALLY_PENDING — exactly one:
- `20260904120000_account_review_flag_preservation.sql`. Live `account_mappings.is_cash_account / is_retained_earnings / is_payroll_account` are all `is_nullable = NO`, `default false`. The migration drops NOT NULL and DEFAULT on exactly those three columns and replaces `resolve_account_review_batch` with the tri-state (NULL = no professional decision) preservation logic. Genuinely pending. Not executed.

SCHEMA_ALREADY_LIVE_UNDER_DIFFERENT_HISTORY_ID — no action:
- `20260903100000` (framework nullable, no default) — live, recorded as `20260903092335`.
- `20260902160000` (member read RLS) — live, recorded as `20260902173837`; policy verified present.
- `20260811000001` (mapping-memory security repair) — semantics verified live: view `security_invoker=ON`, zero anon grants.
- `20260720200000` / `20260720300000` / `20260811000000` / `20260816120000` / `20260902130000` / `20260902150000` — objects verified live.

EDGE_FUNCTION_CODE_PENDING — four, all differing from canonical:
- `maono-compute`, `maono-risk`, `maono-cashflow`, `maono-decide`. All 15 functions answer 401 (deployed, JWT-gated); none 404. The mirror versions cannot be deployed at all because `_shared/maonoAnalyticalContract.ts` is absent from the mirror.

FRONTEND_PENDING:
- Publish canonical main. Frontend has never been published (custom domains `cfoclose.com` / `www.cfoclose.com` attached, serving nothing). Substantial `src/` divergence confirmed (evidence resolver, comparative period adapter, balance-side evidence, framework presentation, TIN-gate removal tests and more exist only canonically).

MIGRATION_PROVENANCE_DEBT_ONLY:
- ~53 Lovable-generated remote identities vs repository identities. Registered as debt. No repair in this gate, no SQL.

SECRETS:
- None required unless `maono-decide` is included, in which case `ANTHROPIC_API_KEY` is required before it is deployed.

## 6. Release candidate sequence (after sync only — do not run yet)

1. Verify mirror HEAD = `30c1350c…`, migration count 107, three artifacts present.
2. Apply exactly one migration: `20260904120000_account_review_flag_preservation.sql`.
3. Deploy exactly: `maono-compute`, `maono-risk`, `maono-cashflow`, and `maono-decide` (only after `ANTHROPIC_API_KEY` is supplied, or drop `maono-decide` from the set).
4. Publish frontend from canonical main.
5. Unauthenticated smoke, then authenticated acceptance test.
6. Decide migration-history reconciliation separately.

KINGA-TZ remains on hold. `safisha-efdms-ingest` remains held.

## Verdict

CANONICAL_MAIN_SYNC_REQUIRES_USER_ACTION

SAFF PRODUCTION GATE 0C —
BACKEND bvyivmmfjejbmqoydezk —
CANONICAL MAIN 30c1350c607a0a4865c790ee212c35481b268351 —
LOVABLE SOURCE 19de600465c9fca94af17b667890e5e5c5737ef9 (origin/main 5c66946b278e060f21e2856bad79ed4552c66740) —
CANONICAL SYNC USER ACTION —
MIGRATIONS 106 mirror / 107 canonical —
PHASE6 TRI-STATE MIGRATION ABSENT (mirror) / PRESENT (canonical) / NOT LIVE —
MAONO CONTRACT ABSENT (mirror) / PRESENT (canonical) —
TB CERTIFICATION AUTHORITY commit_tb_certification + get_authoritative_certification over tb_certifications — ALL LIVE — resolve_tb_certification DOES NOT EXIST IN CANONICAL MAIN —
ANTHROPIC REQUIREMENT maono-decide + maono-root-cause ONLY — NOT REQUIRED BY PHASE 9 ANALYTICAL CONTRACT —
REMOTE DATABASE UNCHANGED —
NO EDGE FUNCTIONS DEPLOYED —
FRONTEND NOT PUBLISHED —
RELEASE NOT_READY (delta fully determined; blocked solely on mirror sync)
