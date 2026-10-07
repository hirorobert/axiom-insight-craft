# I1-A close-out — currency registry, explicit periods, manual trial-balance layouts (APPLIED)

- **Release source:** `main` `3e3e9001f97229d5072c95ef14c16897e5743a56` (handoff `I1A_LOVABLE_RELEASE_HANDOFF_3e3e900.md`, SHA-256 `49cdfcf2a5f447f041923fbc95e64825ef89f3ac12ee29709cba473e19f6f0a4`).
- **Hosted application recorded by Lovable on `main`:** mirror commits `52993f9` (0031), `c6c992f` (0032), types and the tsconfig exclusion in `a6b0bda`, summary commit `41b3587` ("Applied I1-A releases").
- **Production project:** `bvyivmmfjejbmqoydezk`.

## 1. Migrations — applied in their registered IDENTICAL (canonical) form

Each Drizzle mirror is the source migration byte for byte. The SHA-256 below was recomputed from the mirror files and equals the canonical form registered in `SUBMISSION_FORMS` (PR #73) before application.

| Hosted entry | Source | Bytes | SHA-256 (mirror = source = registered identical form) | Journal `when` |
|---|---|---|---|---|
| `0031_currency_registry_and_reporting_periods` | `20261009100000_currency_registry_and_reporting_periods.sql` | 49199 | `27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509` | 1791389044422 (2026-10-07T16:04:04.422Z) |
| `0032_layout_templates_and_confirmations` | `20261010100000_layout_templates_and_confirmations.sql` | 31976 | `061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21` | 1791389191617 (2026-10-07T16:06:31.617Z) |

- Both are now reviewed `RELEASE_JOURNAL` entries (`release_verbatim`, source digest and mirror SHA-256 pinned). The migration-authority guard reports **30 mirrored entries, nothing pending**; any other content under these tags, the final-LF-removed form under these identical entries, a changed source or a second unreviewed mirror is refused (`releaseJournal.test.ts`).
- Snapshots `0031_snapshot.json` / `0032_snapshot.json` chain from `0030` (`prevId` = previous `id`), schema-less like every prior entry; `_journal.json` lists them in order after 0030.

## 2. Generated types (`src/integrations/supabase/types.ts`) — reviewed

The regeneration matches the two migrations exactly and nothing else:

- new tables `currency_registry`, `fiscal_period_events`, `layout_templates`, `layout_confirmations`;
- `fiscal_periods`: `dates_basis`, `dates_confirmed_by`, `dates_confirmed_at`; the `fk_fp_reporting_currency` relationship to `currency_registry`; `reporting_currency` is now **required on insert** (its default was dropped by A1 — no TZS fallback);
- new functions `open_engagement_with_period`, `confirm_period_dates`, `complete_legacy_period_dates`, `layout_save_template`, `layout_record_confirmation`, and the internal `_layout_actor`, `_period_has_processing` (typed because they exist in `public`; their EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated`, and the two `layout_*` writers are granted to `service_role` only);
- the only removed line is the optional `reporting_currency?` on insert, replaced by the required one.

## 3. `tsconfig.app.json` exclusion — reviewed and pinned

Lovable added exactly one path to `exclude`: `src/lib/ingestion/characterizationCorpus.ts` — a **test helper** (`node:fs`, `node:path`, the `xlsx` package, `__dirname`) used only by `ingestCharacterization.test.ts`. Kept as is:

- the exclusion list is pinned to the three test globs plus that one file (`characterizationCorpusBoundary.test.ts`);
- no production module imports it (pinned; the only importer is the characterization test);
- its coverage is retained: the characterization test imports it and still pins all 154 corpus digests against origin/main's ingestion code.

## 4. Verification limits (carried forward, not closed here)

- **Not reapplied, not redeployed.** This close-out changes no migration, no function and no hosted state.
- **Function deployment** (`process-trial-balance` generation 4, `trial-balance-layout`) is as reported in Lovable's close-out; this repository cannot observe the hosted deployment, so the deployed closure digests (`1135d63f…10b10`, `82102bde…47e7`) are **not independently verified here**.
- **Cross-workspace check NOT performed.** The hosted cross-workspace (tenant-isolation) verification of the new tables and functions was not run at application time. Tenant isolation is proven on real PostgreSQL by `layoutAuthority.mjs` (another tenant: 403; RLS: no rows), `periodsAuthority.mjs` and `releaseOrder.mjs`, but **not observed on production**. It remains an open item before customer exposure.
- **The workbench gate stays off** (`WORKBENCH_NAVIGATION_ENABLED = false`); `UNPROVEN_MODULES_CUSTOMER_VISIBLE = false`; withheld services and open-defect restrictions are unchanged.
