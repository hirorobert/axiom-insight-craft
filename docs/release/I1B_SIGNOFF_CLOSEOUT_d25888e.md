# Close-out — I1-B, I1-C, Close Review, reporting input, sign-off requirements (APPLIED)

- **Release source:** `main` `d25888ebb4fae636643c435e73068c6f343d9db8` (#76–#86), executed by Lovable through the
  self-checking wrappers in `release/wrappers/`.
- **Recorded on `main` by Lovable:** mirrors `0033`–`0039`, snapshots `0033`–`0039`, `_journal.json`, regenerated
  `src/integrations/supabase/types.ts` (commits `90fbf75`…`08c02a5`, "Completed release 1.7.2").
- **Evidence classes used below:** **VERIFIED HERE** (recomputed from this repository); **REPORTED** (Lovable's
  close-out, not independently observable from here); **NOT RUN**.

## 1. Hosted journal ↔ mirrors — VERIFIED HERE (bytes) / REPORTED (hosted ids)

Each mirror was recomputed here and is byte-identical to the registered wrapper form `wrapper` of its source (`cmp`,
SHA-256). The hosted hashes Lovable reported (16-hex prefixes) match these values. The hosted id is mirror index + 1, the
same offset as every earlier entry (for example, 0028 is hosted id 29).

| Mirror (tag) | Hosted id (REPORTED) | Source migration | Mirror bytes · SHA-256 (VERIFIED) | Encloses (bytes · SHA-256) | Journal `when` |
|---|---|---|---|---|---|
| `0033_i1b_w1_two_period_shared_source` | 34 | `20261011100000_two_period_shared_source.sql` | 35496 · `57abe7e393f6caabedc546df84ef16370cf5c055831fdf032597466812b35610` | 33926 · `5feb43d1…a01a` | 1791454905727 |
| `0034_i1b_w2_layout_assist_controls` | 35 | `20261012100000_layout_assist_controls.sql` | 28266 · `3d3ee7a8b317b53812f2933b9176a86af1a63debddb2c839037e96b12a4269c8` | 26700 · `aa7ae748…47dd` | 1791455035299 |
| `0035_i1b_w3_close_review_timeline` | 36 | `20261013100000_close_review_timeline.sql` | 10710 · `0746ef8bbbe59150997b3c81bd4ea13107b59e71c3c282748dfcd25f8dcad39d` | 9148 · `84787f00…98f0` | 1791455096771 |
| `0036_i1b_w4_close_review_findings` | 37 | `20261014100000_close_review_findings.sql` | 37385 · `58d982475f278eb76c0be99306e4e12c19f75f4664fe6584ae28afe021fad65b` | 35821 · `61b1bcff…ca3f` | 1791455254708 |
| `0037_i1b_w5_close_review_adjustments` | 38 | `20261015100000_close_review_adjustments.sql` | 52947 · `5c1bb4a5aa3fd510a8885f57e29a67f0a783e2252fe46ee6ffabecc1f803049f` | 51377 · `75387e4c…58e2` | 1791455472081 |
| `0038_i1b_w6_fs_reporting_input` | 39 | `20261016100000_fs_reporting_input.sql` | 12864 · `32aed095d1beebecf9a667f55dcd1e9bb6429a720843e817d4e6c0b5e9f379e9` | 11306 · `d6c01978…3a39` | 1791455558832 |
| `0039_i1b_w7_signoff_completion_requirements` | 40 | `20261017100000_signoff_completion_requirements.sql` | 22644 · `086e22b1da1c2239ab40b5ba3765c1a438c7c4c8291aef760e1bb2f722335477` | 21060 · `4523efd9…b5af` | 1791455665667 |

- Each entry is now a reviewed `release_self_checking_wrapper` entry in `RELEASE_JOURNAL`
  (`scripts/ci/releaseJournal.mjs`), pinned by source digest, form `wrapper`, mirror bytes and SHA-256. The guard reports
  **37 mirrored entries, nothing pending**. Any other text under these tags is refused, and so is a missing mirror for a
  reviewed entry (`selfCheckingWrappers.test.ts`, `releaseJournal.test.ts`).
- Snapshots `0033`–`0039` chain from `0032` (each `prevId` = the previous `id`) and are schema-less like every earlier entry.
- The wrapper-5 numbering question in Lovable's report is consistent with the above: tool output named the local mirror
  `0037_…`, while hosted id 38 holds the wrapper-5 hash. There is one row per wrapper and no duplicate (REPORTED).

## 2. Contract check (step 4.0) — REPORTED

The contract probe was refused by design (SQLSTATE 55000, `RELEASE_CONTRACT_PROBE`), and the journal stayed at max id 33
before wrapper 1. This is the first hosted observation that a refused submission writes no journal row. Lovable reported
it; it is not observable from here.

## 3. Generated types — REVIEWED HERE

A structural comparison (TypeScript compiler API, every `Database` member path) of `types.ts` at `d25888e` against
Lovable's regeneration found:
- **0 removed, 768 added, 1 changed.**
- The only change is `trial_balance_uploads.Relationships`, which gains `trial_balance_uploads_source_object_id_fkey` →
  `tb_source_objects`.
- The only additions to an existing table are `trial_balance_uploads.{Row,Insert,Update}.source_object_id`
  (`string | null`).
- Every added table and function is one created by the seven migrations; nothing else appears. The created objects that
  are not newly typed are trigger guards, plus re-created functions whose signatures did not change.

## 4. Postcondition and preservation — REPORTED

- `POSTCONDITION OK`, run read-only (`BEGIN READ ONLY … ROLLBACK`).
- **Adaptation:** the hosted login cannot execute `tbu_undo_window()` (42501), so its single call was replaced by
  `interval '10 minutes'`. **Verified equivalent here:** the function returns exactly `interval '10 minutes'`
  (`20260923100000_upload_lifecycle_retire_and_replace.sql`), and its EXECUTE is revoked from PUBLIC, anon and
  authenticated.
- Preservation (AFTER = BASELINE):

  | Count | Value |
  |---|---|
  | uploads | 27 |
  | legacy personal | 3 |
  | workspace | 24 |
  | shared-source uploads | 0 |
  | discards in undo window | 0 |
  | in-flight operations | 0 |
  | reservations | 28 |
  | certifications | 43 |
  | storage objects | 48 |
  | rollout companies (unchanged) | 1 |
  | kill switch (unchanged) | 0 |

- AI provider row `enabled = false`, no provider or model; 0 layout-assist runs; `layout-assist` not deployed; gates
  unchanged; frontend not published.

## 5. Open items carried forward

| Item | Status |
|---|---|
| Demo upload / discard / restore / past-window cleanup (procedure §8 step 2) | **NOT RUN** |
| Cross-workspace refusal on the hosted project | **NOT RUN** (no genuine second account) |
| Live "being checked" processing message on the hosted project | **NOT RUN** |
| Installed bundle fingerprint of `trial-balance-storage-cleanup` | **NOT AVAILABLE** (source fingerprint only) |
| **Installed `trial-balance-storage-cleanup` knows `source_shared`** | **UNVERIFIED.** Lovable "reused the earlier deployment" and did not redeploy, and the deployed version cannot be observed. This is safe today: there are 0 shared-source uploads, and the `main` handler fails closed (500, nothing deleted) on a shared source (`milestoneReleaseOrder.mjs`). **Activation gate:** before `TWO_PERIOD_INTAKE_ENABLED` is turned on, deploy the source closure `04ebf148992f85b0b224215bfacb36bcd6a1342f822346c0e018594bfc410b7f` (or observe `source_shared` on a demo shared-source discard). |

Nothing in this close-out upgrades a NOT RUN item to PASS.
