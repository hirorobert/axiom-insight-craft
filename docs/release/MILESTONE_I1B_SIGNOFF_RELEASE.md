# Release procedure — I1-B two-year intake, I1-C layout assist controls, Close Review, reporting input, sign-off requirements

**Status: prepared, NOT applied, NOT deployed, NOT published.** Nothing in this document has been done to the hosted
project. Every step that changes hosted state (merge, migration apply, function deploy, frontend publish, enabling a
provider, releasing a gate) needs its own explicit owner authorization. Production project: `bvyivmmfjejbmqoydezk`.

This is the **one** ordered procedure for this milestone. It supersedes the per-PR deployment notes in PRs #76–#84 and the
milestone report of 2026-10-08 (`MILESTONE_REPORT_intake_closereview_signoff_2026-10-08.md`), whose migration hashes are
obsolete (the corrected sources below replace them).

## 0. What is released, and what stays withheld

| Area | Source PR | Customer-visible after this release? |
|---|---|---|
| Shared source for two reporting years in one file (I1-B) | #76 (schema, storage cleanup), #77 (intake UI) | **No** — `TWO_PERIOD_INTAKE_ENABLED = false` |
| AI layout-assist controls (I1-C) | #78 | **No** — `LAYOUT_ASSIST_ENABLED = false`; `layout-assist` has no provider (`provider: null` → `PROVIDER_DISABLED`); `ai_provider_settings.enabled = false` |
| Close Review timeline, findings, adjustments | #79, #80, #81 | **No** — pages `close-findings`/`close-adjustments` are not in `RELEASED_WORKBENCH_PAGES`; every RPC also requires `fs_rollout_allows(company)` (allow-list + kill switch) |
| Authoritative reporting input, sign-off requirements, self-approval disclosure | #82, #83, #84 | **No** — `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`; server functions behind the same rollout |

This milestone is **not** the completed financial-statements product, and the AI infrastructure is **not** operational
(no provider adapter, no approved data-handling terms, no evaluation). Restricted endpoints stay restricted.

## 1. Source commit and submission forms

- **Source:** the head of the release-preparation PR (the integrated release candidate: the stack #76 → #78 → #79 → #80 →
  #81 → #82 → #83 → #84 with #77 merged in). The commit SHA is recorded in that PR and in the handoff; after the PRs are
  merged into `main`, the identity that matters is the byte identity below, not a commit SHA.
- Each migration may be submitted by the hosted migrator in exactly one of two registered forms (`SUBMISSION_FORMS`,
  `scripts/ci/releaseJournal.mjs`): the source **byte for byte**, or the source with **exactly its single final LF
  removed**. No other transformation (CRLF, BOM, trimming, comment stripping) is acceptable. All seven sources are LF-only,
  BOM-free and end in exactly one LF (pinned by `releaseJournal.test.ts`).

| # | Source migration | Identical form: bytes · SHA-256 | Final-LF-removed form: bytes · SHA-256 |
|---|---|---|---|
| 1 | `20261011100000_two_period_shared_source.sql` | 33926 · `5feb43d1268790f9b1b205d316081759c7912156c77bb34ba51e881b2297a01a` | 33925 · `e61a38b2de5353bb5f22a9b910bd86b3490746ae6d30ea9fae8bc291c80418a6` |
| 2 | `20261012100000_layout_assist_controls.sql` | 26700 · `aa7ae748164aa1a0fd0fffe55fd362db53f10120223b5da81ceaf94ee4c447dd` | 26699 · `4a9a81b92acdbc2d07a88614676138d40bc93648ec7175a02ec36cbcb5368e39` |
| 3 | `20261013100000_close_review_timeline.sql` | 9148 · `84787f004c83b2dd5258d14d323bb39c65c8eb37372122ce1b729e9b441598f0` | 9147 · `5edd6b46b326fce02872404d4dde6aac4fa50c5af9fec36356225938ec43a0d9` |
| 4 | `20261014100000_close_review_findings.sql` | 35821 · `61b1bcffc1148f557e2aa62b8e245e12b9e8ef7a2a6a9e861ec94036a629ca3f` | 35820 · `936973b10ce839deb21b4284b098f981317871b6f22c81999370be1054ee4e48` |
| 5 | `20261015100000_close_review_adjustments.sql` | 51377 · `75387e4ce9cb3dee63001b67c28bb76cebfccc156229b24e206d55c6588b58e2` | 51376 · `72b3c226f369d77975bef7f37ff05259732edb413f8a342b366012cb459ffeac` |
| 6 | `20261016100000_fs_reporting_input.sql` | 11306 · `d6c019785cdd67301c539bfc7d4c413e365c917039da4dc27adcb4128c3a3a39` | 11305 · `824d85803148e5ae46a90ab300d62ea9d4f3116c9c17095b8cb57fd5dc9fa71c` |
| 7 | `20261017100000_signoff_completion_requirements.sql` | 21060 · `4523efd91edb2f3028786c93adeffc2c73392595a33620ce5b2fb82558c3b5af` | 21059 · `013a0b0f440d6ffb6713f98acb22872cf9d73b2fbe41cb76801450eea8ccb32b` |

Each migration begins with its own preflight block that raises `PREFLIGHT_REFUSED … nothing was changed` if any of its
objects already exists — re-applying, or applying over a partial earlier attempt, changes nothing.

## 2. Read-only hosted preflight

Run `docs/release/milestone-i1b-signoff/preflight.sql` against the target (it reads the catalogue and counts rows;
it writes nothing — the proof runs it inside a `READ ONLY` transaction). It must print `PREFLIGHT OK`. **Record every
`BASELINE …` line** — they are the reference for step 8. It refuses if any object of this release already exists, if a
prerequisite table or function of `main` (chain through hosted entry 0032) is missing, or if the rollout state row is
missing. Confirm out of band that the target is the intended project.

## 3. Deploy `trial-balance-storage-cleanup` FIRST (before migration 1)

Migration 1 makes a discard of one year of a shared file answer `source_shared` (record purged, file kept for the other
year). The handler on `main` does not know that outcome and maps it to `500 completion_failed` — it fails **closed**
(nothing is deleted), but users would see an error. The new handler is therefore deployed before the schema changes.

| Function | Closure digest (source) | Files |
|---|---|---|
| `trial-balance-storage-cleanup` | `04ebf148992f85b0b224215bfacb36bcd6a1342f822346c0e018594bfc410b7f` | `_shared/storageCleanup.ts` `b00724a2…96a1` (6960 B; on `main`: `13198c68…8d83`), `trial-balance-storage-cleanup/index.ts` `e0c33ee8…34fb` (4758 B; unchanged) |

Remote imports: `npm:@supabase/supabase-js@2`, `npm:@supabase/supabase-js@2/cors`. Regenerate the full manifest with
`node scripts/release/functionClosure.mjs trial-balance-storage-cleanup layout-assist --migrations <the seven>`.

**Shared-source deletion compatibility (proven, `milestoneReleaseOrder.mjs`):**
- the new handler on the **old** schema answers exactly as the old one (terminal discard → `completed`; in-window discard → `undo_window_open`, nothing deleted);
- the **old** handler on the **new** schema: a single-year discard → `completed` (one deletion); a shared-source discard → `500`, **nothing deleted**;
- the new handler on the new schema: a shared-source discard → `200 source_shared`, the file kept for its sibling;
- retiring (replacing) either year, or discarding one year, never deletes the file the other year still references; the sweeper deletes it exactly once, only after both years are discarded and both undo windows have passed (also under two concurrent sweeps).

The deployed bundle's identity cannot be observed from this repository: the digest above is the **source** closure. The
installed identity is whatever the platform reports after deployment; record it, do not claim it equals the source digest
unless the platform exposes a comparable digest.

## 4. Apply the seven migrations, in order, one at a time

Order: 1 → 7 as in the table. After **each** one: it reports success (no `PREFLIGHT_REFUSED`); the hosted journal gains
exactly one entry whose text is one of the two registered forms of that source; nothing else changed. After the seventh,
run `docs/release/milestone-i1b-signoff/postcondition.sql` (read-only): every new table exists with row-level
security, the release functions exist and none (other than a trigger function) is executable by `anon`, the AI provider
is disabled and no layout-assist run exists; it prints the `AFTER …` counts.

Proven on real PostgreSQL (one database upgraded from `main`'s schema, `milestoneReleaseOrder.mjs`): after every single
migration, legacy personal-path and workspace uploads stay bound, an in-window discard stays restorable (and is restored
at the end), and the real sweeper orchestration deletes nothing a bound upload references.

**Interruption.** No maintenance window is required by anything demonstrated: every migration creates new objects except
migration 1, which adds a nullable column with a foreign key to `trial_balance_uploads` and builds one index on it (a
short lock on that table while the index is built — writes to uploads wait for it). Apply it at low upload traffic. No
existing row is rewritten or backfilled (migration 2 inserts only the singleton `ai_provider_settings` row, disabled, in
its own new table). If the hosted migrator runs a migration in one transaction, a failure leaves nothing and the same
registered form can be re-applied. If it does not, a mid-file failure leaves part of the migration in place and the
migration's own preflight then refuses a retry — that is a stop condition to investigate, never to work around.

## 5. Functions

| Function | Change | Deploy? |
|---|---|---|
| `trial-balance-storage-cleanup` | new outcome `source_shared` | **Yes — step 3, before migration 1** |
| `layout-assist` | **new**; closure `6bf0c9db94722278db04d52d30f2b80995631d5e4289bfe0c2bfcbe4e122372b` (14 files; remote: `deno.land/std@0.168.0/http/server.ts`, `esm.sh/@supabase/supabase-js@2`, `esm.sh/xlsx@0.18.5`) | **Optional, after migration 2.** It authenticates the caller and then refuses every request with `PROVIDER_DISABLED` before reading anything. The frontend never calls it while `LAYOUT_ASSIST_ENABLED = false`. Leaving it undeployed is equally safe. |
| every other function | no source change in this milestone (`git diff main -- supabase/functions` touches only the files above) | No |

The trial-balance sweeper function is unchanged; the SQL it calls (`tbu_sweeper_candidates/claim/complete`) is replaced
by migration 1 with the same signatures, proven with the real orchestration (`runSourceSweep`) before and after.

## 6. Compatibility: old/new frontend × handler × schema

| Combination | Result | Evidence |
|---|---|---|
| Old frontend (`main`) × new schema | Works: no existing RPC changed signature; discard/restore/retire/purge keep their contracts | `milestoneReleaseOrder.mjs`, `uploadLifecycle.mjs`, `sharedSourceAuthority.mjs` |
| New frontend × old schema | Works: every new RPC is reached only through a gated page/flag (`TWO_PERIOD_INTAKE_ENABLED`, `LAYOUT_ASSIST_ENABLED`, `RELEASED_WORKBENCH_PAGES`, `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED`, all off) | static gate tests; not observed in a browser against the hosted project |
| New cleanup handler × old schema | Identical answers | proof |
| Old cleanup handler × new schema | Single-year discards complete; shared-source discards fail closed (500, nothing deleted) | proof |
| Old/new sweeper × any stage | Deletes nothing still referenced | proof (every stage) |

The frontend can therefore be published before or after the migrations; publish it **after** step 8 so that a
regression surfaces against the final schema. Publishing is a separate authorization.

## 7. Hosted journal reconciliation

After application, the Drizzle mirrors are accepted only through reviewed `RELEASE_JOURNAL` entries (rule 9 of
`assertMigrationAuthority.mjs`; registering a form applies nothing — the guard reports all seven as
`PENDING_HOSTED_APPLY` until then). A follow-up close-out PR records, per entry: tag, source, form (identical or
final-LF-removed), bytes and SHA-256 recomputed from the mirror file, journal `when`, and the snapshot chain — as
`I1A_CLOSEOUT_3e3e900.md` did for 0031/0032. A mirror in any other form is a stop condition.

## 8. Demo acceptance and preservation checks

1. Compare every `AFTER …` count with its `BASELINE …`: legacy personal-path uploads, workspace uploads, certifications,
   storage objects and reservations not lower (except by what users did in the window); in-flight operations drained or
   accounted for; `fs_rollout_enabled_companies` and `fs_kill_switch_on` **unchanged**.
2. On the demo workspace only: upload, discard and restore a trial balance; confirm a discard past its window is cleaned
   up (`completed`). Nothing in this milestone is visible to customers, so there is no customer acceptance step.
3. Open items carried forward, **not** closed by this release: **cross-workspace refusal not yet observed** on the hosted
   project; **live processing message not yet observed** on the hosted project.

## 9. Stop conditions and forward recovery

Stop and do not continue to the next step if: the preflight raises; a migration raises (including `PREFLIGHT_REFUSED`);
a hosted mirror is not one of the two registered forms; the postcondition raises; a preservation count dropped
unexpectedly; the cleanup handler returns `500` for a single-year discard.

Recovery is **forward only**. Never drop the new tables or the column (the sources are append-only by design and
`ON DELETE RESTRICT`). A failed migration that left nothing: fix the cause and re-apply the same registered form. If
a later step fails after earlier migrations were applied, leave them in place: they are inert while every gate is off.
If the new cleanup handler misbehaves, redeploying the old one is safe on any stage (it fails closed on shared sources,
none of which exist until two-year intake is enabled).

## 10. Visibility is a separate authorization

None of the following is part of this release; each needs its own decision: `TWO_PERIOD_INTAKE_ENABLED`,
`LAYOUT_ASSIST_ENABLED` (and a provider, approved data-handling terms, an evaluation, `ai_provider_settings.enabled`
with both approvals, workspace consent and budget), adding `close-findings`/`close-adjustments` to
`RELEASED_WORKBENCH_PAGES`, `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED`, and allow-listing any company in the
financial-statements rollout.

## Deployment checklist

- [ ] Owner authorization for this window recorded (merge, apply, deploy are each authorized).
- [ ] Release-preparation PR and #76–#84 merged; exact-head CI green on each.
- [ ] Step 2 preflight: `PREFLIGHT OK`; baseline recorded.
- [ ] Step 3: `trial-balance-storage-cleanup` deployed; installed identity recorded (source closure `04ebf148…0b7f`).
- [ ] Step 4: migrations 1–7 applied one at a time; each mirror is a registered form (bytes + SHA-256 recorded).
- [ ] Step 4: postcondition `POSTCONDITION OK`.
- [ ] Step 5: `layout-assist` deployed or deliberately left undeployed (record which).
- [ ] Step 8: preservation counts compared; demo upload/discard/restore/cleanup observed.
- [ ] Step 7: close-out PR with the reviewed `RELEASE_JOURNAL` entries opened.
- [ ] Frontend published only on separate authorization; every gate still off.
