// The controlled PR #34 production release journal (Lovable, 2026-09-26): Drizzle entries 0013–0021 — explicitly
// REVIEWED here, entry by entry. Not an allow-list: each entry is pinned by its exact SHA-256 AND re-validated
// structurally, and any other `_pr34_` entry, or any change to these, fails the migration-authority guard.
//
//   0013  probe            reports the migration session identity; creates the empty table public._pr34_probe
//   0014  staging table    public._pr34_migration_bodies (verbatim authorized bodies + SHA-256); RLS on; no client role
//   0015  apply            20260925100000 (template "verbatim")
//   0016  apply prereq     20260915100000_financial_statement_documents.sql (template "verbatim_bytes"; applied out of
//                          source order on purpose: an older migration first applied in this release)
//   0017–0021  apply       20260925110000 … 20260925150000 (template "verbatim_once")
//   0022  apply            20260926160000 processing entitlement wall (template "verbatim_noop"; reviewed at f21a58f)
//   0024  apply            20260927100000 Trial Balance removal + official-output serialization (template
//                          "verbatim_noop_main": verbatim_noop with "approved main head"; reviewed at main 0d2a09e)
//
// An apply wrapper must be BYTE-IDENTICAL to its reviewed template rendered with its own source name, the SHA-256 of
// that source file in this repository (and, where pinned, its byte count). The templates below were reviewed once:
// each selects exactly ONE staged body by a constant name (WHERE name = v_name — no dynamic selection), refuses a
// missing body or a digest (or byte-count) mismatch, EXECUTEs exactly that body, and records applied_at only AFTER the
// EXECUTE, inside the same DO statement — so a failure rolls back the execution and the record atomically. No wrapper
// grants anything. The structural assertions below re-check these properties with the lexer.
//
// Release-only objects public._pr34_probe and public._pr34_migration_bodies remain in production PENDING CLEANUP.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lexSql } from "./atomicEnvelope.mjs";
import { checkGuardedEntry } from "../release/guardedEntry.mjs";
import { render as renderSelfCheckingWrapper } from "../release/selfCheckingWrapper.mjs";
import { checkTransportMirror } from "../release/stagedTransport.mjs";
import { BATCHES as TB_TRANSPORT_BATCHES, checkTransportMirror as checkTbTransportMirror } from "../release/tbStagedTransport.mjs";
import { BATCHES as FSI_TRANSPORT_BATCHES, checkTransportMirror as checkFsiTransportMirror } from "../release/fsIntegrityStagedTransport.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const REVIEWED_HEAD = "c2c1e8e171f4c23b428d7affc14ae3ee103020ed";

const header = (name) => `-- Applies authorized migration ${name}
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed file at head ${REVIEWED_HEAD}.
`;
const prologue = (name, digest, withBytes) => `DO $pr34$
DECLARE
  v_name TEXT := '${name}';
  v_expected TEXT := '${digest}';
  v_body TEXT;
  v_sha  TEXT;${withBytes ? "\n  v_bytes INT;" : ""}
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex')${withBytes ? ", octet_length(body)" : ""}
    INTO v_body, v_sha${withBytes ? ", v_bytes" : ""}
    FROM public._pr34_migration_bodies WHERE name = v_name;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'PR34: authorized body % is not staged. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
`;
const shaCheck = (word) => `  IF v_sha <> v_expected THEN
    RAISE EXCEPTION 'PR34: staged body % digest % does not match the ${word} digest %. Nothing was changed.', v_name, v_sha, v_expected USING ERRCODE = '55000';
  END IF;
`;
const epilogue = `  EXECUTE v_body;
  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34$;`;

// The processing-correction wrapper (0022, reviewed 2026-09-26 against approved head f21a58f): same safety properties
// (constant name, digest check, one EXECUTE, applied_at only after it, no grants); a second application RETURNs as a
// no-op instead of raising.
const noopWrapper = ({ name, digest, head, headLabel = "approved head" }) => `-- Digest-guarded application of the reviewed, authorized migration
-- supabase/migrations/${name}
-- (${headLabel} ${head}, SHA-256
--  ${digest}).
-- The body is read verbatim from the staging table public._pr34_migration_bodies and is executed only
-- when its digest matches exactly. Applying a second time is a no-op (applied_at already set).
DO $pr34_wrap_${name.slice(0, 14)}$
DECLARE
  v_name TEXT := '${name}';
  v_expected TEXT := '${digest}';
  v_body TEXT;
  v_sha TEXT;
  v_applied TIMESTAMPTZ;
BEGIN
  SELECT body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), applied_at
    INTO v_body, v_sha, v_applied
  FROM public._pr34_migration_bodies WHERE name = v_name;

  IF v_body IS NULL THEN
    RAISE EXCEPTION 'refused: reviewed migration body % is not staged', v_name USING ERRCODE = '55000';
  END IF;
  IF v_sha IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'refused: staged body digest % does not match the authorized digest %', v_sha, v_expected USING ERRCODE = '55000';
  END IF;
  IF v_applied IS NOT NULL THEN
    RAISE NOTICE 'already applied at %, nothing to do', v_applied;
    RETURN;
  END IF;

  EXECUTE v_body;

  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;
END
$pr34_wrap_${name.slice(0, 14)}$;`;   // (no trailing newline: exactly the reviewed file)

export const TEMPLATES = {
  verbatim_noop: noopWrapper,
  // 0024 (reviewed 2026-09-30): byte-identical to verbatim_noop except that the header names the approved MAIN head.
  verbatim_noop_main: (p) => noopWrapper({ ...p, headLabel: "approved main head" }),
  verbatim: ({ name, digest }) => header(name) + prologue(name, digest, false) + shaCheck("reviewed") + epilogue,
  verbatim_once: ({ name, digest }) => header(name) + prologue(name, digest, false) + shaCheck("reviewed") + `  IF (SELECT applied_at FROM public._pr34_migration_bodies WHERE name = v_name) IS NOT NULL THEN
    RAISE EXCEPTION 'PR34: % is already recorded as applied. Nothing was changed.', v_name USING ERRCODE = '55000';
  END IF;
` + epilogue,
  verbatim_bytes: ({ name, digest, bytes, blob }) => `-- Applies authorized prerequisite ${name}
-- verbatim from the release staging table, after asserting its SHA-256 digest matches the
-- reviewed Git blob ${blob} at head
-- ${REVIEWED_HEAD} (${bytes} bytes).
` + prologue(name, digest, true) + shaCheck("authorized") + `  IF v_bytes <> ${bytes} THEN
    RAISE EXCEPTION 'PR34: staged body % has % bytes, expected ${bytes}. Nothing was changed.', v_name, v_bytes USING ERRCODE = '55000';
  END IF;
` + epilogue,
};

/** The reviewed release journal. Changing, adding or removing an entry requires a new review here. */
export const RELEASE_JOURNAL = {
  "0013_pr34_probe_session_identity": { kind: "probe", sha256: "c57e8d89f4e3716a4cb6d6539d41726b8e67cf3b15624d13cf420600a177e878",
    objects: ["public._pr34_probe"], pendingCleanup: true },
  "0014_pr34_release_staging_table": { kind: "staging_table", sha256: "f53362ad4bb0360b6c50b848414576b451d01eb64752cdce169ed7921c8d4c01",
    objects: ["public._pr34_migration_bodies"], pendingCleanup: true },
  "0015_pr34_apply_20260925100000": { kind: "apply", template: "verbatim", source: "20260925100000_global_capabilities_entitlements_pricing.sql",
    digest: "e864eacbd0a111463d03da7df170774f22683716a2a10cc99f5c569c42951297", sha256: "0779b2357547d76675da00fcfdc9b30f2f862c878f373209624929f0ba12ba74" },
  "0016_pr34_apply_prereq_20260915100000": { kind: "apply_prerequisite", template: "verbatim_bytes", source: "20260915100000_financial_statement_documents.sql",
    digest: "e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712", bytes: 18569, blob: "cc830915b2cc7a93b25a0b4514458f056294b9fb",
    sha256: "4ea7042035c128267655c277202f53856c50b556adf5cfe4f54356a0f6854a77", outOfOrder: true },
  "0017_pr34_apply_20260925110000": { kind: "apply", template: "verbatim_once", source: "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql",
    digest: "e2acec5154d7f9f71011a88033fa18fdfb6130089eb1845c42efe44c96fca8fa", sha256: "c3008b2435d00bd06341a99c666db5521848d1856b7da1a684fd7f5716b4e0e8" },
  "0018_pr34_apply_20260925120000": { kind: "apply", template: "verbatim_once", source: "20260925120000_reporting_pack_issuance_binding.sql",
    digest: "2be7dc36c3fbf9432b8eb606f35c2139bd834301ad7416694adc3a163b2550d3", sha256: "ee1ac0b111e69cac5a9a3ea720d36f03469f29907ce9f88873c722dcb0e24bd6" },
  "0019_pr34_apply_20260925130000": { kind: "apply", template: "verbatim_once", source: "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql",
    digest: "f0fb1b2b665a7562f761a2493faebc7f452f1df38844f5bdd49f8f45c6ef2fa1", sha256: "d96f22ec537b35bac157efd13c5d5d6c21506d4138a8f064f1c093414114882c" },
  "0020_pr34_apply_20260925140000": { kind: "apply", template: "verbatim_once", source: "20260925140000_workspace_capability_authorization.sql",
    digest: "c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a", sha256: "e92be771abd9b197c743032efffbd80a717de720228fe1deb9120dfeb58982e2" },
  "0021_pr34_apply_20260925150000": { kind: "apply", template: "verbatim_once", source: "20260925150000_can_user_act_on_workspace_minimum_grant.sql",
    digest: "3011c3414d7a0b5811015218ae35f8721663eaa32ddd7e5233f269fcb91daacb", sha256: "05b399d1baf6fa502ebfa2a6f89df2536c199699d78a409c52c6eb99337a1188" },
  // The approved processing correction (release blocker P-1), applied by Lovable after review at f21a58f.
  "0022_pr34_apply_20260926160000": { kind: "apply", template: "verbatim_noop", source: "20260926160000_trial_balance_processing_entitlement_wall.sql",
    digest: "d032fb0821210b59937e8f513d5de126fb31bbcffff151a91d459dd33914e868", head: "f21a58f7a8e9e2aa09840e5af716e445f6ab0b8b",
    sha256: "71f4353f1a599b534fbbf696440c9252d2d7debd64b56a36f83d1d1148c2d5a1" },
  // Trial Balance removal with official-output serialization and the READ COMMITTED rule (PR #35), applied by Lovable
  // after review at main 0d2a09e (PR #37 merged; main push CI green).
  "0024_apply_20260927100000_trial_balance_remove_from_active_use": { kind: "apply", template: "verbatim_noop_main",
    source: "20260927100000_trial_balance_remove_from_active_use.sql",
    digest: "f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157", head: "0d2a09eaed9cd6f96790d57bfeb4cf681877b743",
    sha256: "34f384b86caee59af34dfcd766e8f1cfc424051f4830e980394f9edd558a05ab" },
  // The 12-month commercial term (PR #41), applied by Lovable as a byte-for-byte copy of its source (kind
  // "release_verbatim"): exact tag, source path, byte count and SHA-256 pinned; the entry must equal the source exactly.
  "0025_apply_20261001120000_annual_commercial_term": { kind: "release_verbatim",
    source: "20261001120000_annual_commercial_term.sql", bytes: 19294,
    digest: "621f55c35bdadf3c7baa8c259056712dbfbbedbd25417a2a5d6a92fd4a1d38fa",
    sha256: "621f55c35bdadf3c7baa8c259056712dbfbbedbd25417a2a5d6a92fd4a1d38fa" },
  // Withheld-service grant refusal (approved at d03a0dd), applied by Lovable's native migrator as a byte-for-byte copy
  // (hosted journal id 27, created_at 1791025217619).
  "0026_apply_20261002100000_refuse_withheld_service_grants": { kind: "release_verbatim",
    source: "20261002100000_refuse_withheld_service_grants.sql", bytes: 10824,
    digest: "704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8",
    sha256: "704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8" },
  // S1 mapping and processing authority (PR #55, merged at 9e166f7), applied by Lovable's native migrator as a
  // byte-for-byte copy (hosted journal id 29, created_at 1791299426677 = 2026-10-06T15:10:26.677Z).
  "0028_apply_20261006100000_mapping_and_processing_authority": { kind: "release_verbatim",
    source: "20261006100000_mapping_and_processing_authority.sql", bytes: 43248,
    digest: "d189ddf5fa021c0c9a7a70536fd851b1152016269a7718ca8967f89837a967a6",
    sha256: "d189ddf5fa021c0c9a7a70536fd851b1152016269a7718ca8967f89837a967a6" },
  // H1 treatment authority and processing control (PR #58, merged in main 4b5806c), applied by Lovable's native migrator
  // (mirror commit 005187f) as its source MINUS ITS SINGLE FINAL LF BYTE — the one registered submission form for this
  // migration (SUBMISSION_FORMS below). The source ends "\n\n"; only the last byte is absent. Canonical source and
  // submitted text are pinned separately.
  "0029_apply_20261007100000_treatment_authority_and_processing_control": { kind: "release_verbatim_final_lf_removed",
    source: "20261007100000_treatment_authority_and_processing_control.sql", bytes: 47457,
    digest: "0010ec531f3924e3a63031a0f42185c94414ab72a15396b4a3d43499468092c6",
    submittedBytes: 47456,
    sha256: "3591b7d0a6a39db2bf479aa8ecb86e5c0b8c4f01bdb86cf166abb56fc5e23ae0" },
  // S2 processing-attempt authority (PR #62, merged in main 4b5806c), applied by Lovable's native migrator (mirror commit
  // da1ad01) in its pre-registered final-LF-removed form (SUBMISSION_FORMS, registered in PR #64 before application).
  "0030_apply_20261008100000_processing_attempt_authority": { kind: "release_verbatim_final_lf_removed",
    source: "20261008100000_processing_attempt_authority.sql", bytes: 75683,
    digest: "6ad6ac7d6aac244950a0e69bd1c278bea1eee5ac9e12c98e541ca9c961c9c25d",
    submittedBytes: 75682,
    sha256: "169a3771a009973114437a5bd24318083d05e391876f6dfbacfbaf994bb817b8" },
  // I1-A A1 (PR #70; submission forms registered in PR #73 before application), applied by Lovable's native migrator in
  // its registered IDENTICAL form — a byte-for-byte copy of the source (mirror commit 52993f9; journal "when"
  // 1791389044422 = 2026-10-07T16:04:04.422Z).
  "0031_currency_registry_and_reporting_periods": { kind: "release_verbatim",
    source: "20261009100000_currency_registry_and_reporting_periods.sql", bytes: 49199,
    digest: "27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509",
    sha256: "27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509" },
  // I1-A A2 (PR #71; forms registered in PR #73), applied the same way in its registered IDENTICAL form (mirror commit
  // c6c992f; journal "when" 1791389191617 = 2026-10-07T16:06:31.617Z).
  "0032_layout_templates_and_confirmations": { kind: "release_verbatim",
    source: "20261010100000_layout_templates_and_confirmations.sql", bytes: 31976,
    digest: "061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21",
    sha256: "061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21" },
  // I1-B/I1-C/Close Review/reporting input/sign-off (main d25888e; PRs #76–#86), applied 2026-10-08 by Lovable's hosted
  // migrator through the SELF-CHECKING WRAPPERS (release/wrappers/), each submitted byte for byte (the registered "wrapper"
  // form). Hosted journal ids 34–40; each hosted hash reported = SHA-256 of the submitted wrapper = SHA-256 of the mirror
  // below (recomputed here). The contract probe was refused (55000) with the journal unchanged at id 33 before wrapper 1.
  // Close-out: docs/release/I1B_SIGNOFF_CLOSEOUT_d25888e.md.
  // hosted id 34; journal "when" 1791454905727 = 2026-10-08T10:21:45.727Z.
  "0033_i1b_w1_two_period_shared_source": { kind: "release_self_checking_wrapper", source: "20261011100000_two_period_shared_source.sql",
    bytes: 33926, digest: "5feb43d1268790f9b1b205d316081759c7912156c77bb34ba51e881b2297a01a",
    form: "wrapper", submittedBytes: 35496, sha256: "57abe7e393f6caabedc546df84ef16370cf5c055831fdf032597466812b35610" },
  // hosted id 35; journal "when" 1791455035299 = 2026-10-08T10:23:55.299Z.
  "0034_i1b_w2_layout_assist_controls": { kind: "release_self_checking_wrapper", source: "20261012100000_layout_assist_controls.sql",
    bytes: 26700, digest: "aa7ae748164aa1a0fd0fffe55fd362db53f10120223b5da81ceaf94ee4c447dd",
    form: "wrapper", submittedBytes: 28266, sha256: "3d3ee7a8b317b53812f2933b9176a86af1a63debddb2c839037e96b12a4269c8" },
  // hosted id 36; journal "when" 1791455096771 = 2026-10-08T10:24:56.771Z.
  "0035_i1b_w3_close_review_timeline": { kind: "release_self_checking_wrapper", source: "20261013100000_close_review_timeline.sql",
    bytes: 9148, digest: "84787f004c83b2dd5258d14d323bb39c65c8eb37372122ce1b729e9b441598f0",
    form: "wrapper", submittedBytes: 10710, sha256: "0746ef8bbbe59150997b3c81bd4ea13107b59e71c3c282748dfcd25f8dcad39d" },
  // hosted id 37; journal "when" 1791455254708 = 2026-10-08T10:27:34.708Z.
  "0036_i1b_w4_close_review_findings": { kind: "release_self_checking_wrapper", source: "20261014100000_close_review_findings.sql",
    bytes: 35821, digest: "61b1bcffc1148f557e2aa62b8e245e12b9e8ef7a2a6a9e861ec94036a629ca3f",
    form: "wrapper", submittedBytes: 37385, sha256: "58d982475f278eb76c0be99306e4e12c19f75f4664fe6584ae28afe021fad65b" },
  // hosted id 38; journal "when" 1791455472081 = 2026-10-08T10:31:12.081Z.
  "0037_i1b_w5_close_review_adjustments": { kind: "release_self_checking_wrapper", source: "20261015100000_close_review_adjustments.sql",
    bytes: 51377, digest: "75387e4ce9cb3dee63001b67c28bb76cebfccc156229b24e206d55c6588b58e2",
    form: "wrapper", submittedBytes: 52947, sha256: "5c1bb4a5aa3fd510a8885f57e29a67f0a783e2252fe46ee6ffabecc1f803049f" },
  // hosted id 39; journal "when" 1791455558832 = 2026-10-08T10:32:38.832Z.
  "0038_i1b_w6_fs_reporting_input": { kind: "release_self_checking_wrapper", source: "20261016100000_fs_reporting_input.sql",
    bytes: 11306, digest: "d6c019785cdd67301c539bfc7d4c413e365c917039da4dc27adcb4128c3a3a39",
    form: "wrapper", submittedBytes: 12864, sha256: "32aed095d1beebecf9a667f55dcd1e9bb6429a720843e817d4e6c0b5e9f379e9" },
  // hosted id 40; journal "when" 1791455665667 = 2026-10-08T10:34:25.667Z.
  "0039_i1b_w7_signoff_completion_requirements": { kind: "release_self_checking_wrapper", source: "20261017100000_signoff_completion_requirements.sql",
    bytes: 21060, digest: "4523efd91edb2f3028786c93adeffc2c73392595a33620ce5b2fb82558c3b5af",
    form: "wrapper", submittedBytes: 22644, sha256: "086e22b1da1c2239ab40b5ba3765c1a438c7c4c8291aef760e1bb2f722335477" },
  // The reporting release (batch reporting-r1; main 25bc659; PRs #89–#94), applied 2026-10-08 by Lovable's hosted
  // migrator through the SELF-CHECKING WRAPPERS (release/wrappers/). Hosted journal ids 41–45. Each mirror below equals a
  // registered form of its wrapper (recomputed here): 0040–0042 the wrapper byte for byte, 0043–0044 the wrapper with exactly
  // its single final LF removed (both forms were registered before application). Close-out: docs/release/REPORTING_R1_CLOSEOUT_25bc659.md.
  // hosted id 41; journal "when" 1791481239602 = 2026-10-08T17:40:39.602Z.
  "0040_r1_w1_fs_statement_composition": { kind: "release_self_checking_wrapper", source: "20261018100000_fs_statement_composition.sql",
    bytes: 39206, digest: "18b239b602796b0f7071b4cd56c69611cca3e244f88af3c1c797ce79b461f7ca",
    form: "wrapper", submittedBytes: 40776, sha256: "57ef68a28c4df8750aa89901caf26d34b0f8f31f058bbebf934761c821944ca7" },
  // hosted id 42; journal "when" 1791481572752 = 2026-10-08T17:46:12.752Z.
  "0041_r1_w2_fs_notes_and_schedules": { kind: "release_self_checking_wrapper", source: "20261019100000_fs_notes_and_schedules.sql",
    bytes: 43911, digest: "b89c83bbc3bb9e93cbdd7532b8149aa15d776bee033fab9ae03f632f669087fa",
    form: "wrapper", submittedBytes: 45477, sha256: "554d29c672bc9604ee8f95b137c23ecaa1799771a8bb86879ee1abf6c3624127" },
  // hosted id 43; journal "when" 1791483333059 = 2026-10-08T18:15:33.059Z.
  "0042_r1_w3_fs_comparatives": { kind: "release_self_checking_wrapper", source: "20261020100000_fs_comparatives.sql",
    bytes: 47941, digest: "74119824182913d6f35068bb7a0a87409688d5009feba3d230540badae66b6b4",
    form: "wrapper", submittedBytes: 49493, sha256: "28ff6bdbe6197273358cb219083fbd84824b5f0456b25fc7b1a53e4d85dd513a" },
  // hosted id 44; journal "when" 1791483466336 = 2026-10-08T18:17:46.336Z.
  "0043_r1_w4_fs_signoff_binding": { kind: "release_self_checking_wrapper", source: "20261021100000_fs_signoff_binding.sql",
    bytes: 23593, digest: "9f69a03e69141fe954d4e63e95643077cabe8a1f8ab9fc18e328d2dab12d9d12",
    form: "wrapper_final_lf_removed", submittedBytes: 25150, sha256: "16b306bc4bc37f129d4b7eaf1ea93ffac463595872ab25a6f51f3a7acfe526fc" },
  // hosted id 45; journal "when" 1791483632651 = 2026-10-08T18:20:32.651Z.
  "0044_r1_w5_fs_reporting_closure": { kind: "release_self_checking_wrapper", source: "20261022100000_fs_reporting_closure.sql",
    bytes: 27142, digest: "307f3114af9433473ee31cb674ab8ac730b832852ded9793cc69ce8ea647f3aa",
    form: "wrapper_final_lf_removed", submittedBytes: 28703, sha256: "27ffb7e7515c5d0a48b1b5f56afb83d16b0cadb3f9887871fa8591bf89427fc3" },
  // The readiness correction (DEFECT D-2, batch reporting-r2). Hosted id 46; journal "when" 1791545776962 = 2026-10-09T11:36:16.962Z.
  "0045_fs_report_readiness_volatility": { kind: "release_self_checking_wrapper", source: "20261023100000_fs_report_readiness_volatility.sql",
    bytes: 2900, digest: "112d54165a9e937b41c76e4e1d73006d7c267092d78dd2cddc2c400d8acea19a",
    form: "wrapper", submittedBytes: 4480, sha256: "d1801b37175b10ae36215e1fc7a3529429da7fdba84d30c8f7571479fe4d1222" },
  // The commercial launch (main 9ac3456; PRs #101–#106), applied 2026-10-10 by Lovable's hosted migrator through the
  // SELF-CHECKING WRAPPERS, in release order: reporting-r5 (0046), commercial-c1 (0047–0050), commercial-p1 (0051). Hosted
  // journal ids 47–52; then commercial-p2 (0052, hosted 53). Each mirror is its registered wrapper byte for byte
  // (recomputed here). Nothing of the release is pending.
  // hosted id 47; journal "when" 1791651672909 = 2026-10-10T17:01:12.909Z.
  "0046_fs_signoff_approval_policy_wrapper": { kind: "release_self_checking_wrapper", source: "20261024100000_fs_signoff_approval_policy.sql",
    bytes: 13531, digest: "23a34a084fd7c2c0f6f51a63839ada07a47df0c16def867968c08a03b96f1202",
    form: "wrapper", submittedBytes: 15105, sha256: "74d6cd987a0063809414f336b17bd7afd3199ce3349f9b5ee3e7b1cf8e11487e" },
  // hosted id 48; journal "when" 1791651815555 = 2026-10-10T17:03:35.555Z.
  "0047_commercial_enquiries_wrapper": { kind: "release_self_checking_wrapper", source: "20261025100000_commercial_enquiries.sql",
    bytes: 18051, digest: "3051c74a0cf9b17ac212b95904b8acb8fa5bdd9c9158fa48e4d128540bc5064c",
    form: "wrapper", submittedBytes: 19613, sha256: "577cfa4c84399a22f50a9dfc52af2cfa68d09592c54a0440a41c3b39e46d8e90" },
  // hosted id 49; journal "when" 1791652150780 = 2026-10-10T17:09:10.780Z.
  "0048_retire_browser_adjusting_journal_writes_wrapper": { kind: "release_self_checking_wrapper", source: "20261026100000_retire_browser_adjusting_journal_writes.sql",
    bytes: 4584, digest: "d87b600ac0a798a09e7bc9eb5cc1667235952edaba4ec53aaa9b0b9225d64c6f",
    form: "wrapper", submittedBytes: 6182, sha256: "7ed2cee1836489a169f5193aa935291ecc9bceea5872f0b11aadc94c089c8934" },
  // hosted id 50; journal "when" 1791652154022 = 2026-10-10T17:09:14.022Z.
  "0049_workspace_purpose_wrapper": { kind: "release_self_checking_wrapper", source: "20261027100000_workspace_purpose.sql",
    bytes: 5638, digest: "c1daa138672875d148439017b1f5e09fd926574ede0a28c1e32b0a9580f45c7c",
    form: "wrapper", submittedBytes: 7192, sha256: "44daa7f7aa1305789cf1e342ddf49aae1e423dafc3a2213d1498ea91c06f2f2f" },
  // hosted id 51; journal "when" 1791652157742 = 2026-10-10T17:09:17.742Z.
  "0050_period_dates_from_company_wrapper": { kind: "release_self_checking_wrapper", source: "20261028100000_period_dates_from_company.sql",
    bytes: 10136, digest: "da14459f7557fb41ec25d91cba40801ba85245c0ae89c75ea72141be841fbc71",
    form: "wrapper", submittedBytes: 11708, sha256: "c2c3afed5cb93b225b466f3e5d0ecfba2ab2a701a94c0e50035006e6b0569529" },
  // hosted id 52; journal "when" 1791652405761 = 2026-10-10T17:13:25.761Z.
  "0051_payment_provider_routes_wrapper": { kind: "release_self_checking_wrapper", source: "20261029100000_payment_provider_routes.sql",
    bytes: 49007, digest: "3b1b14d93bb2ee7ef21d416a89d5fa3490848f4bce53827979d0290d76e42818",
    form: "wrapper", submittedBytes: 50575, sha256: "407e056d63f0083137bceb4dbb10c27beafba11c326701589ef838549d8b6627" },
  // hosted id 53; journal "when" 1791652611862 = 2026-10-10T17:16:51.862Z.
  "0052_paid_term_seat_preservation_wrapper": { kind: "release_self_checking_wrapper", source: "20261030100000_paid_term_seat_preservation.sql",
    bytes: 22439, digest: "ff5e89bae9aa261f68e85d504ba03b5f0c76230d97ca7d5fa6e247c169b1913f",
    form: "wrapper", submittedBytes: 24015, sha256: "8a54ebef4d13b2ed51b6740e2a2cd6be9e14b218553b45a397e53968f98f878f" },
  // The sandbox licence isolation correction (batch commercial-p3; main d2ab84b, PR #111), applied 2026-10-11 by Lovable's
  // hosted migrator through its SELF-CHECKING WRAPPER, byte for byte (recomputed here). It is 20261031110000, which
  // supersedes 20261031100000: that wrapper's one submission failed atomically (PT422 CANCELLED_LICENCE_IMMUTABLE) and wrote
  // no journal row; it is pinned only in SUPERSEDED_SUBMISSIONS and is never a registered form. Nothing is pending.
  // hosted id 54; journal "when" 1791725527221 = 2026-10-11T13:32:07.221Z.
  "0053_sandbox_licence_isolation_wrapper": { kind: "release_self_checking_wrapper", source: "20261031110000_sandbox_licence_isolation.sql",
    bytes: 52723, digest: "790a4fb8a6aa4b196513cb93383bc5452c2e89278876f2884bc10896a7884472",
    form: "wrapper", submittedBytes: 54295, sha256: "12a7e92421978e3c4bf2aaa939021558762c1ec47cf69baf703c0ee660adae83" },
  // Payment reversal authority (batch commercial-p4; main 6378bfe, PRs #114 and #115), applied 2026-10-12 by Lovable's hosted
  // migrator through its SELF-CHECKING WRAPPER, byte for byte (recomputed here). Nothing is pending.
  // hosted id 55; journal "when" 1791785944509 = 2026-10-12T06:19:04.509Z.
  "0054_payment_reversal_authority_wrapper": { kind: "release_self_checking_wrapper", source: "20261101100000_payment_reversal_authority.sql",
    bytes: 23281, digest: "b2477026bc1fa7c6767e609591328d61ffaca1f19bfdea0d4021a446536638ee",
    form: "wrapper", submittedBytes: 24855, sha256: "a8fe9755aaa8f655445ad1c0eb5810e6512920fa2f95daa176691e26fc8c38eb" },
  // Verified charge outcomes (batch commercial-p5; main d83542f, PR #118), applied 2026-10-13 by Lovable's hosted migrator
  // through its SELF-CHECKING WRAPPER, byte for byte (recomputed here). Nothing is pending.
  // hosted id 56; journal "when" 1791911338723 = 2026-10-13T17:08:58.723Z.
  "0055_verified_charge_outcomes_wrapper": { kind: "release_self_checking_wrapper", source: "20261102100000_verified_charge_outcomes.sql",
    bytes: 45711, digest: "b20bf253961a14c3a1c9e66b3602295831a81b614b2da8eae19295dc40e31ae4",
    form: "wrapper", submittedBytes: 47281, sha256: "a215cc20994f91c57fe0774401decd21a8129013a6fecb1e70ae3cf1567b57ea" },
  // Platform-owner access (access-a1, PR #131), applied 2026-10-15 by Lovable's hosted migrator through its
  // SELF-CHECKING WRAPPER, byte for byte (hosted id 57).
  "0056_platform_owner_access_and_entity_allowance_wrapper": { kind: "release_self_checking_wrapper", source: "20261104100000_platform_owner_access_and_entity_allowance.sql",
    bytes: 38630, digest: "1cf1dd3264fbc87ee850104028c760b24d1d0269b3addaefbae25ed505b2fb62",
    form: "wrapper", submittedBytes: 40236, sha256: "b14ba1cc83320bc14e658edc6b3ff5d5ec6cc2f21b4ff057e3915d7e82565d7a" },
  // Trial balance release (batch tb-release-r1; main 5f7a8fd, PRs #151 #153 #154 #157), applied 2026-10-18 by Lovable's hosted
  // migrator through its SELF-CHECKING WRAPPERS, byte for byte (mirrors identical to release/wrappers/). Nothing is pending.
  // hosted id 59; journal "when" 1792300021059 = 2026-10-18T05:07:01.059Z.
  "0058_trial_balance_drafts": { kind: "release_self_checking_wrapper", source: "20261106100000_trial_balance_drafts.sql",
    bytes: 48210, digest: "ec9c0fa7c18f797cc38991ee87ff80a14649d0207d737b3d1a7bd06838e3464d",
    form: "wrapper", submittedBytes: 49772, sha256: "ea99a5858ddf1aaae99c04ee732dee7a4e0d799ca10f39c8e61c81abdcf4f87f" },
  // hosted id 60; journal "when" 1792300154288 = 2026-10-18T05:09:14.288Z.
  "0059_certification_findings_capacity": { kind: "release_self_checking_wrapper", source: "20261107100000_certification_findings_capacity.sql",
    bytes: 34711, digest: "23d1286be5b9a28cc99a24c5b2f459acfd5c7784307e8c312805828a7f891be5",
    form: "wrapper", submittedBytes: 36295, sha256: "d76f6fa2a816e1907640e0ba5177feed2e93ec27ccd8ffa9499aacf9697b8bbb" },
  // hosted id 61; journal "when" 1792300217247 = 2026-10-18T05:10:17.247Z.
  "0060_account_identity_codeless_name": { kind: "release_self_checking_wrapper", source: "20261108100000_account_identity_codeless_name.sql",
    bytes: 12319, digest: "b443ea8cf8c440f8e08aca437f67cfb5e4a31b0908025c37c4ecdcd513d553c7",
    form: "wrapper", submittedBytes: 13901, sha256: "74bad382fefb611358214e541c9adf65f9e158d6bba5613adc3089eab8b55195" },
  // hosted id 62; journal "when" 1792300304995 = 2026-10-18T05:11:44.995Z.
  "0061_refused_replacement_restore": { kind: "release_self_checking_wrapper", source: "20261109100000_refused_replacement_restore.sql",
    bytes: 18790, digest: "ed189bfd036aaf173e952271516fb6482c0b84802cf7ca4b2e33d1121fff5d8c",
    form: "wrapper", submittedBytes: 20366, sha256: "ae02220e26c08042cb0cd08aa27bdbfdf2274bb1f5af9e53fc21d05bc027fdab" },
  // Unlimited team members (batch pricing-p1; main 100d43d, PR #175), applied 2026-10-18 by Lovable's hosted migrator
  // through its SELF-CHECKING WRAPPER, byte for byte (mirror identical to release/wrappers/). Nothing is pending.
  // hosted id 63; journal "when" 1792341986524 = 2026-10-18T16:46:26.524Z.
  "0062_unlimited_team_members_wrapper": { kind: "release_self_checking_wrapper", source: "20261110100000_unlimited_team_members.sql",
    bytes: 37312, digest: "5081c8199f53dbb68cf1e2c866f56668505537b901a19af9952cbf6ee8267009",
    form: "wrapper", submittedBytes: 38878, sha256: "d3f1ae17f8de24f23f85c49bb7c7f2bfe4d0c80aba4fc1fbcf79f887389bfb79" },
  // Period-currency correction (batch currency-c1; PR #179, main 4ead5c9), applied 2026-10-20 by Lovable's hosted migrator
  // through its SELF-CHECKING WRAPPER with the wrapper's single final LF removed (the registered wrapperFinalLfRemoved form).
  // hosted id 64; journal "when" 1792470872315 = 2026-10-20T04:34:32.315Z. OUT OF SOURCE ORDER on purpose (the precedent
  // of 0016): it was applied ahead of the authored, still-PENDING 20261111100000 and 20261112100000 of the financial-statements
  // slice (PR #176), whose wrappers apply later through their own preflights (none depends on 20261113100000).
  "0063_period_currency_correction": { kind: "release_self_checking_wrapper", source: "20261113100000_period_currency_correction.sql",
    bytes: 34382, digest: "91d098a5e6958ac2529fee1005ddc500e0fdbb072635ba3a1967840d3378466d",
    form: "wrapper_final_lf_removed", submittedBytes: 35955, sha256: "8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc", outOfOrder: true },
  // Financial-statements staged release (scripts/release/stagedTransport.mjs, reviewed 78e923d; originals from daa23e4),
  // applied 2026-10-21 by Lovable's hosted migrator, each submitted once in its registered no-final-LF form.
  // hosted id 65; "when" 1792601984044. Bootstrap of the private cfoclose_release schema; covers no source.
  "0064_fs_release_staged_transport": { kind: "staged_transport", sha256: "ea6e6ec703b42a9e2d100d2be70c609587d551655a56c89bf605c719afffaf32" },
  // hosted ids 66–70; "when" 1792602300202 / 1792602338481 / 1792602377600 / 1792602414913 / 1792602453026. Each executed
  // its batch's staged preflight, ORIGINAL wrapper and postcondition (byte-verified) in one transaction.
  "0065_fs_controls_r1_staged_apply": { kind: "staged_transport", sha256: "c845a02ca49f43bb5b55e69ad26a77b6af32f3fcda45f9fb0bdb74eee8ce9653" },
  "0066_fs_journey_r1_staged_apply": { kind: "staged_transport", sha256: "a421b7f9587f54d6c14077976ad2f42f2e5d8641fd2394b682b7cc5092d3217b" },
  "0067_fs_bounds_r1_staged_apply": { kind: "staged_transport", sha256: "1c6cb96f22e317b35d3c2e2b574ea99786500c5df46ce5d44b61bee418377d54" },
  "0068_fs_capacity_r1_staged_apply": { kind: "staged_transport", sha256: "0589f056ef0165c6b52adeb5d146a8cc58267682ba6b91c3cd7e2ffc96833008" },
  "0069_fs_memo_r1_staged_apply": { kind: "staged_transport", sha256: "dbff469ea43ae9c2f364cb602165c727d29cc6a96eade7d7f7217af4b0e2a496" },
  // Checkout recovery (#183), applied verbatim before the two pending Trial Balance workflow batches.
  // Hosted id 71; when 1792656911705. Pin the exact source and mirror; earlier TB sources stay pending.
  "0070_customer_checkout_abandon": { kind: "release_verbatim", source: "20261119100000_customer_checkout_abandon.sql",
    bytes: 4839, digest: "0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910", sha256: "0eb1405df641e956ca43b4ad652f9ca263029352637e98d1ce482d5c2bb19910", outOfOrder: true },
  // Trial Balance staged release (scripts/release/tbStagedTransport.mjs, merged d17ba53), applied 2026-10-22 by Lovable's
  // hosted migrator, each submitted once in its registered no-final-LF form. Hosted id 72: bootstrap (covers no source);
  // ids 73/74: tb-portfolio-a1 and tb-decisions-b1, each executing its byte-verified ORIGINAL wrapper and postcondition.
  "0071_tb_release_staged_transport": { kind: "tb_staged_transport", sha256: "b1e2a1351880e13ccfa7823a38433cdfb4118d019fd2a5aeb7ff0a31796cb7d0" },
  "0072_tb_portfolio_a1_staged_apply": { kind: "tb_staged_transport", sha256: "9076155c3babd11183f7bcb0860e14017c11c61a956a29720f93cdd9643ed323" },
  "0073_tb_decisions_b1_staged_apply": { kind: "tb_staged_transport", sha256: "a00b66ceaf9aced7b5017e445d9b1c32614ac606d70c0500feb1d10010263b03" },
  // fs-integrity-r1 (scripts/release/fsIntegrityStagedTransport.mjs): REGISTERED BEFORE hosted application, not applied.
  // Expected hosted ids 76–80 after 0074 (id 75); each mirror must be exactly its registered no-final-LF form.
  "0075_fs_integrity_staged_transport": { kind: "fsi_staged_transport", sha256: "8001cf3edcb607f62187c14eb4be57993c5f3f8e59d4b15d896d5a493a10e4c8" },
  "0076_fsi_1_server_compilation_staged_apply": { kind: "fsi_staged_transport", sha256: "21325cb1984c8e2e05ecc8ac532b75cc2c30dd1ff5a81b2914a4024f0d80b018" },
  "0077_fsi_2_integrity_gate_staged_apply": { kind: "fsi_staged_transport", sha256: "dc467960f2c87f0f02e3b26cb6705123a4c7d4e5b3b69aa7c56eaae375c576d3" },
  "0078_fsi_3_final_authority_staged_apply": { kind: "fsi_staged_transport", sha256: "b592d692c0b63614aee8ec67cd46e09272e9527571c9b6bef28ce3fd8bdc0f69" },
  "0079_fsi_4_document_structure_staged_apply": { kind: "fsi_staged_transport", sha256: "5481a1bbbc516140ee7717b65c0eed3adf75353b77d39aa96a32513a4a2ead35" },
};

/**
 * The reviewed SUBMITTED-TEXT forms of a source migration (R0). A hosted migrator may submit a source either byte for
 * byte, or with exactly its single final LF byte removed — nothing else: no trimming of more bytes, no whitespace, CRLF
 * or BOM normalisation. Each form is registered per migration with its exact byte count and SHA-256, so a mirror of a
 * source listed here is accepted only through a reviewed RELEASE_JOURNAL entry, never by the whitespace-normalised
 * parity of the ordinary mirror rule. A form registered here does not mean the migration is applied.
 *
 * The milestone's seven sources also register their SELF-CHECKING WRAPPER (scripts/release/selfCheckingWrapper.mjs):
 * exactly render(source, identical form) — one DO statement that re-verifies the enclosed bytes' count and SHA-256 in
 * PostgreSQL before executing them — or that text with exactly its single final LF removed. Both are pinned by byte
 * count and SHA-256; no other wrapper text is ever accepted, and the source's own two forms are unchanged.
 */
export const SUBMISSION_FORMS = Object.freeze({
  // Independent server compilation (PR #191): authored here, NOT applied; one atomic statement, exact bytes only.
  // The pinned compiler digest follows the deployed closure (statementCompiler.manifest.mjs); a regenerated bundle re-pins it here.
  "20261123100000_fs_server_compilation.sql": Object.freeze({
    identical: Object.freeze({ bytes: 23305, sha256: "7e25c896d34365c7ade29ee095f397a9d85979c74a5d2f5c8a9565ec1501e172" }),
    finalLfRemoved: Object.freeze({ bytes: 23304, sha256: "157c4f8eaa3e3a4cb4f8e85df6371b2467b8a6efb8d3eced84f730fa9f5ed678" }),
  }),
  // Publication integrity gate (PR #192): authored, NOT applied; exact bytes only.
  "20261124100000_fs_publication_integrity_gate.sql": Object.freeze({
    identical: Object.freeze({ bytes: 50518, sha256: "a71d60eba0dea2347f4c9d519c8e76e2ffa9ec3d986a54281957bb664bf07a03" }),
    finalLfRemoved: Object.freeze({ bytes: 50517, sha256: "1d232891a487adee706c50c0f9e2e89f555be11be68a68ddc80a3feef5eab276" }),
  }),
  // FINAL authority per reporting scope (PR #192): authored, NOT applied; exact bytes only.
  "20261125100000_fs_final_authority.sql": Object.freeze({
    identical: Object.freeze({ bytes: 67716, sha256: "394d12347da46476df0f551161ca5d6c5a82b781704b4a89c55bac12f258110a" }),
    finalLfRemoved: Object.freeze({ bytes: 67715, sha256: "26d3b4894045343ceae5e0d34a0f849202b389c1e81ece8ff681f31b15a1bbbd" }),
  }),
  // Document structure closure (PR #192): authored, NOT applied; exact bytes only.
  "20261126100000_fs_document_structure.sql": Object.freeze({
    identical: Object.freeze({ bytes: 62060, sha256: "81ffd8ecdb4ad6ef292a8608dabb9a9cc7f41f4dfa972f66ec5d2cae398dcb39" }),
    finalLfRemoved: Object.freeze({ bytes: 62059, sha256: "cb23d3aea9b7bd80c74cce1f8febb3376bb6f5afeeed4d737a0574c1e2908515" }),
  }),

  // H1: applied as 0029 in the final-LF-removed form.
  "20261007100000_treatment_authority_and_processing_control.sql": Object.freeze({
    identical: Object.freeze({ bytes: 47457, sha256: "0010ec531f3924e3a63031a0f42185c94414ab72a15396b4a3d43499468092c6" }),
    finalLfRemoved: Object.freeze({ bytes: 47456, sha256: "3591b7d0a6a39db2bf479aa8ecb86e5c0b8c4f01bdb86cf166abb56fc5e23ae0" }),
  }),
  // S2: both candidate forms were registered before application; applied as 0030 in the final-LF-removed form.
  "20261008100000_processing_attempt_authority.sql": Object.freeze({
    identical: Object.freeze({ bytes: 75683, sha256: "6ad6ac7d6aac244950a0e69bd1c278bea1eee5ac9e12c98e541ca9c961c9c25d" }),
    finalLfRemoved: Object.freeze({ bytes: 75682, sha256: "169a3771a009973114437a5bd24318083d05e391876f6dfbacfbaf994bb817b8" }),
  }),
  // I1-A A1 (PR #70, merged in main a57d26a): both candidate forms registered BEFORE application. Not applied.
  "20261009100000_currency_registry_and_reporting_periods.sql": Object.freeze({
    identical: Object.freeze({ bytes: 49199, sha256: "27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509" }),
    finalLfRemoved: Object.freeze({ bytes: 49198, sha256: "58d2df62f95aa99cd1e5a08aa9af6a58ed41b73d38d918a8fd6c5f8eb1bb374e" }),
  }),
  // I1-A A2 (PR #71, merged in main a57d26a): both candidate forms registered BEFORE application. Not applied.
  "20261010100000_layout_templates_and_confirmations.sql": Object.freeze({
    identical: Object.freeze({ bytes: 31976, sha256: "061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21" }),
    finalLfRemoved: Object.freeze({ bytes: 31975, sha256: "f5aa525f5bf4ce1f5068c3ecf4f3c1002c3b0d6ab1948cafb6cf371ea8e69ba7" }),
  }),
  // The I1-B / I1-C / Close Review / reporting-input / sign-off milestone (PRs #76-#84; registration in the release-
  // preparation PR): both candidate forms of each of the seven sources registered BEFORE application, from the final
  // reviewed bytes. Not applied.
  // I1-B shared source (PR #76).
  "20261011100000_two_period_shared_source.sql": Object.freeze({
    identical: Object.freeze({ bytes: 33926, sha256: "5feb43d1268790f9b1b205d316081759c7912156c77bb34ba51e881b2297a01a" }),
    finalLfRemoved: Object.freeze({ bytes: 33925, sha256: "e61a38b2de5353bb5f22a9b910bd86b3490746ae6d30ea9fae8bc291c80418a6" }),
    // Self-checking wrapper release/wrappers/20261011100000_two_period_shared_source.wrapper.sql:
    // render() of the identical form; it re-verifies those 33926 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 35496, sha256: "57abe7e393f6caabedc546df84ef16370cf5c055831fdf032597466812b35610" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 35495, sha256: "31e887ffa650a9e4bf1fd132784636d0bf01f55f0da7ef0b253fd73f3ba99c4f" }),
  }),
  // I1-C layout assist controls (PR #78).
  "20261012100000_layout_assist_controls.sql": Object.freeze({
    identical: Object.freeze({ bytes: 26700, sha256: "aa7ae748164aa1a0fd0fffe55fd362db53f10120223b5da81ceaf94ee4c447dd" }),
    finalLfRemoved: Object.freeze({ bytes: 26699, sha256: "4a9a81b92acdbc2d07a88614676138d40bc93648ec7175a02ec36cbcb5368e39" }),
    // Self-checking wrapper release/wrappers/20261012100000_layout_assist_controls.wrapper.sql:
    // render() of the identical form; it re-verifies those 26700 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 28266, sha256: "3d3ee7a8b317b53812f2933b9176a86af1a63debddb2c839037e96b12a4269c8" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 28265, sha256: "11208d3b5c2f38d9da4b10e10a0c224b8a5ceb9b43b7ff8bbca5a0415ecd895e" }),
  }),
  // Close Review timeline (PR #79).
  "20261013100000_close_review_timeline.sql": Object.freeze({
    identical: Object.freeze({ bytes: 9148, sha256: "84787f004c83b2dd5258d14d323bb39c65c8eb37372122ce1b729e9b441598f0" }),
    finalLfRemoved: Object.freeze({ bytes: 9147, sha256: "5edd6b46b326fce02872404d4dde6aac4fa50c5af9fec36356225938ec43a0d9" }),
    // Self-checking wrapper release/wrappers/20261013100000_close_review_timeline.wrapper.sql:
    // render() of the identical form; it re-verifies those 9148 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 10710, sha256: "0746ef8bbbe59150997b3c81bd4ea13107b59e71c3c282748dfcd25f8dcad39d" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 10709, sha256: "44262b5659adb7b05410c213dd3c3c2ebb9f69a8a99502ddd2b828023efd68a7" }),
  }),
  // Close Review findings (PR #80).
  "20261014100000_close_review_findings.sql": Object.freeze({
    identical: Object.freeze({ bytes: 35821, sha256: "61b1bcffc1148f557e2aa62b8e245e12b9e8ef7a2a6a9e861ec94036a629ca3f" }),
    finalLfRemoved: Object.freeze({ bytes: 35820, sha256: "936973b10ce839deb21b4284b098f981317871b6f22c81999370be1054ee4e48" }),
    // Self-checking wrapper release/wrappers/20261014100000_close_review_findings.wrapper.sql:
    // render() of the identical form; it re-verifies those 35821 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 37385, sha256: "58d982475f278eb76c0be99306e4e12c19f75f4664fe6584ae28afe021fad65b" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 37384, sha256: "7b523cb70315deb38695f2221a5f77b1365ce1b3dae48b0a4fd536fa4e8349a1" }),
  }),
  // Close Review adjustments (PR #81).
  "20261015100000_close_review_adjustments.sql": Object.freeze({
    identical: Object.freeze({ bytes: 51377, sha256: "75387e4ce9cb3dee63001b67c28bb76cebfccc156229b24e206d55c6588b58e2" }),
    finalLfRemoved: Object.freeze({ bytes: 51376, sha256: "72b3c226f369d77975bef7f37ff05259732edb413f8a342b366012cb459ffeac" }),
    // Self-checking wrapper release/wrappers/20261015100000_close_review_adjustments.wrapper.sql:
    // render() of the identical form; it re-verifies those 51377 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 52947, sha256: "5c1bb4a5aa3fd510a8885f57e29a67f0a783e2252fe46ee6ffabecc1f803049f" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 52946, sha256: "fce3bd490de6636192cf67b637f7041f96350b8a5f9e5c397ba0f8ed5acbf2a5" }),
  }),
  // financial-statements reporting input (PR #82).
  "20261016100000_fs_reporting_input.sql": Object.freeze({
    identical: Object.freeze({ bytes: 11306, sha256: "d6c019785cdd67301c539bfc7d4c413e365c917039da4dc27adcb4128c3a3a39" }),
    finalLfRemoved: Object.freeze({ bytes: 11305, sha256: "824d85803148e5ae46a90ab300d62ea9d4f3116c9c17095b8cb57fd5dc9fa71c" }),
    // Self-checking wrapper release/wrappers/20261016100000_fs_reporting_input.wrapper.sql:
    // render() of the identical form; it re-verifies those 11306 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 12864, sha256: "32aed095d1beebecf9a667f55dcd1e9bb6429a720843e817d4e6c0b5e9f379e9" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 12863, sha256: "b55a926dc272936af14d896cd6b7b3b21f74802f845f5797059d0d8c75552ed3" }),
  }),
  // sign-off completion requirements (PR #83).
  "20261017100000_signoff_completion_requirements.sql": Object.freeze({
    identical: Object.freeze({ bytes: 21060, sha256: "4523efd91edb2f3028786c93adeffc2c73392595a33620ce5b2fb82558c3b5af" }),
    finalLfRemoved: Object.freeze({ bytes: 21059, sha256: "013a0b0f440d6ffb6713f98acb22872cf9d73b2fbe41cb76801450eea8ccb32b" }),
    // Self-checking wrapper release/wrappers/20261017100000_signoff_completion_requirements.wrapper.sql:
    // render() of the identical form; it re-verifies those 21060 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 22644, sha256: "086e22b1da1c2239ab40b5ba3765c1a438c7c4c8291aef760e1bb2f722335477" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 22643, sha256: "eb3860c8b46a1fe3872014684c548f16f87c2946dcb51d7c34a84acf28d71737" }),
  }),  // The reporting release (PRs #89–#94; release/wrappers/ regenerated from 902a057): all four forms of each of the five
  // sources registered BEFORE application, from the final reviewed bytes. Not applied.
  "20261018100000_fs_statement_composition.sql": Object.freeze({
    identical: Object.freeze({ bytes: 39206, sha256: "18b239b602796b0f7071b4cd56c69611cca3e244f88af3c1c797ce79b461f7ca" }),
    finalLfRemoved: Object.freeze({ bytes: 39205, sha256: "8a33553c0a9a47d0d9b8eaa32ff125f765af554d4395f0c95645b8cb1daa6663" }),
    // Self-checking wrapper release/wrappers/20261018100000_fs_statement_composition.wrapper.sql:
    wrapper: Object.freeze({ bytes: 40776, sha256: "57ef68a28c4df8750aa89901caf26d34b0f8f31f058bbebf934761c821944ca7" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 40775, sha256: "401e09cb8f73238a09ca442f2b6c578d9d1e3bcb008551ba8a61aab9e3cc1b08" }),
  }),
  "20261019100000_fs_notes_and_schedules.sql": Object.freeze({
    identical: Object.freeze({ bytes: 43911, sha256: "b89c83bbc3bb9e93cbdd7532b8149aa15d776bee033fab9ae03f632f669087fa" }),
    finalLfRemoved: Object.freeze({ bytes: 43910, sha256: "e33bd899f7b27ec46fc60c6057b3a4f8d30cf856ed65f2dec1922aff667c3e64" }),
    // Self-checking wrapper release/wrappers/20261019100000_fs_notes_and_schedules.wrapper.sql:
    wrapper: Object.freeze({ bytes: 45477, sha256: "554d29c672bc9604ee8f95b137c23ecaa1799771a8bb86879ee1abf6c3624127" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 45476, sha256: "e41c8364c71fb60254edb4223f4921e1a5c17dedc6123a85170f133028e4c9b0" }),
  }),
  "20261020100000_fs_comparatives.sql": Object.freeze({
    identical: Object.freeze({ bytes: 47941, sha256: "74119824182913d6f35068bb7a0a87409688d5009feba3d230540badae66b6b4" }),
    finalLfRemoved: Object.freeze({ bytes: 47940, sha256: "8d9d9a02c818fc102b5ea7e1cbfd807251880cbff3e6aa0f0abdfdb6204eaacb" }),
    // Self-checking wrapper release/wrappers/20261020100000_fs_comparatives.wrapper.sql:
    wrapper: Object.freeze({ bytes: 49493, sha256: "28ff6bdbe6197273358cb219083fbd84824b5f0456b25fc7b1a53e4d85dd513a" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 49492, sha256: "66618f831ae2378d807c3a41c5309ac2f940b858616c33a019df608cd74f150d" }),
  }),
  "20261021100000_fs_signoff_binding.sql": Object.freeze({
    identical: Object.freeze({ bytes: 23593, sha256: "9f69a03e69141fe954d4e63e95643077cabe8a1f8ab9fc18e328d2dab12d9d12" }),
    finalLfRemoved: Object.freeze({ bytes: 23592, sha256: "71f52ddb39205a221fd6a58dd2726e2af45bdefc6e2c8c120fa2fb13572cd89d" }),
    // Self-checking wrapper release/wrappers/20261021100000_fs_signoff_binding.wrapper.sql:
    wrapper: Object.freeze({ bytes: 25151, sha256: "e6379644bfd4ea032cab9a17cf9db22be1bdc9821157992ef7cb487037f31305" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 25150, sha256: "16b306bc4bc37f129d4b7eaf1ea93ffac463595872ab25a6f51f3a7acfe526fc" }),
  }),
  "20261022100000_fs_reporting_closure.sql": Object.freeze({
    identical: Object.freeze({ bytes: 27142, sha256: "307f3114af9433473ee31cb674ab8ac730b832852ded9793cc69ce8ea647f3aa" }),
    finalLfRemoved: Object.freeze({ bytes: 27141, sha256: "f8f26b92dbf4054960892d973544363572265ea82c3a72b181983cf552db3707" }),
    // Self-checking wrapper release/wrappers/20261022100000_fs_reporting_closure.wrapper.sql:
    wrapper: Object.freeze({ bytes: 28704, sha256: "74e459e8198c98a37964b16d673285f24a6cba9d5813a1c75bbadb53398bd4a6" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 28703, sha256: "27ffb7e7515c5d0a48b1b5f56afb83d16b0cadb3f9887871fa8591bf89427fc3" }),
  }),
  "20261023100000_fs_report_readiness_volatility.sql": Object.freeze({
    identical: Object.freeze({ bytes: 2900, sha256: "112d54165a9e937b41c76e4e1d73006d7c267092d78dd2cddc2c400d8acea19a" }),
    finalLfRemoved: Object.freeze({ bytes: 2899, sha256: "4996df1772fa6bb67dbd6089ef685070c586680fec033442c61bcd197eb61877" }),
    // Self-checking wrapper release/wrappers/20261023100000_fs_report_readiness_volatility.wrapper.sql:
    wrapper: Object.freeze({ bytes: 4480, sha256: "d1801b37175b10ae36215e1fc7a3529429da7fdba84d30c8f7571479fe4d1222" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 4479, sha256: "8db7a158c6ed74eb02899efe9243ae80b7966187c42487f4c8fe6c41871e3216" }),
  }),
  "20261024100000_fs_signoff_approval_policy.sql": Object.freeze({
    identical: Object.freeze({ bytes: 13531, sha256: "23a34a084fd7c2c0f6f51a63839ada07a47df0c16def867968c08a03b96f1202" }),
    finalLfRemoved: Object.freeze({ bytes: 13530, sha256: "229f9e084e2d570dec710d30e851de04d222a69ff53bd4c6424e7d363819a949" }),
    // Self-checking wrapper release/wrappers/20261024100000_fs_signoff_approval_policy.wrapper.sql:
    wrapper: Object.freeze({ bytes: 15105, sha256: "74d6cd987a0063809414f336b17bd7afd3199ce3349f9b5ee3e7b1cf8e11487e" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 15104, sha256: "55673777745529f9a1a8a7f8be209e00665372ff2d1c383d17e61c6b7bbe2730" }),
  }),
  // The commercial candidate (batch commercial-c1): the enquiry additions, the retirement of browser journal writes, workspace purpose, periods from the company.
  "20261025100000_commercial_enquiries.sql": Object.freeze({
    identical: Object.freeze({ bytes: 18051, sha256: "3051c74a0cf9b17ac212b95904b8acb8fa5bdd9c9158fa48e4d128540bc5064c" }),
    finalLfRemoved: Object.freeze({ bytes: 18050, sha256: "3a43cb8c65e1d498235efdecf8012409b8a7af0d7f0bb7844a0cfe7a8a9cee05" }),
    // Self-checking wrapper release/wrappers/20261025100000_commercial_enquiries.wrapper.sql:
    wrapper: Object.freeze({ bytes: 19613, sha256: "577cfa4c84399a22f50a9dfc52af2cfa68d09592c54a0440a41c3b39e46d8e90" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 19612, sha256: "373c9ad836ec4f006fe626b79074ec181fae4c3c3bb58d465791808b6cde1986" }),
  }),
  "20261026100000_retire_browser_adjusting_journal_writes.sql": Object.freeze({
    identical: Object.freeze({ bytes: 4584, sha256: "d87b600ac0a798a09e7bc9eb5cc1667235952edaba4ec53aaa9b0b9225d64c6f" }),
    finalLfRemoved: Object.freeze({ bytes: 4583, sha256: "060e40537d196ef364a26811b2deda94e4753ade0e0afaa710aea9714042ef8f" }),
    // Self-checking wrapper release/wrappers/20261026100000_retire_browser_adjusting_journal_writes.wrapper.sql:
    wrapper: Object.freeze({ bytes: 6182, sha256: "7ed2cee1836489a169f5193aa935291ecc9bceea5872f0b11aadc94c089c8934" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 6181, sha256: "48f72943b146e65330f2563a4199151fefb1e59eae6c90999002a718f2e9f8ca" }),
  }),
  "20261027100000_workspace_purpose.sql": Object.freeze({
    identical: Object.freeze({ bytes: 5638, sha256: "c1daa138672875d148439017b1f5e09fd926574ede0a28c1e32b0a9580f45c7c" }),
    finalLfRemoved: Object.freeze({ bytes: 5637, sha256: "e461c0098c78a89f2026b07b4dc4d172b856e55bae65a4bc3565ba360639151f" }),
    // Self-checking wrapper release/wrappers/20261027100000_workspace_purpose.wrapper.sql:
    wrapper: Object.freeze({ bytes: 7192, sha256: "44daa7f7aa1305789cf1e342ddf49aae1e423dafc3a2213d1498ea91c06f2f2f" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 7191, sha256: "fcd896e5c034294aa1625aae19554da546ee785d5b9d310f28a9e99a80a43545" }),
  }),
  "20261028100000_period_dates_from_company.sql": Object.freeze({
    identical: Object.freeze({ bytes: 10136, sha256: "da14459f7557fb41ec25d91cba40801ba85245c0ae89c75ea72141be841fbc71" }),
    finalLfRemoved: Object.freeze({ bytes: 10135, sha256: "b1e70493f5f730887267b1ea300a0b71f5febfe8f6617c9eb1867712415392e7" }),
    // Self-checking wrapper release/wrappers/20261028100000_period_dates_from_company.wrapper.sql:
    wrapper: Object.freeze({ bytes: 11708, sha256: "c2c3afed5cb93b225b466f3e5d0ecfba2ab2a701a94c0e50035006e6b0569529" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 11707, sha256: "51104bb36a7f14dfd15fce8d585edc66437cf30a0677158e98c064fb75ae3943" }),
  }),
  // Online payment (batch commercial-p1): the provider routes and the renewal-aware placement of a paid term.
  "20261029100000_payment_provider_routes.sql": Object.freeze({
    identical: Object.freeze({ bytes: 49007, sha256: "3b1b14d93bb2ee7ef21d416a89d5fa3490848f4bce53827979d0290d76e42818" }),
    finalLfRemoved: Object.freeze({ bytes: 49006, sha256: "789666756ffaf9a2e74c998fde7ea006627fc5dd64ef853a62875085e10523ad" }),
    // Self-checking wrapper release/wrappers/20261029100000_payment_provider_routes.wrapper.sql:
    wrapper: Object.freeze({ bytes: 50575, sha256: "407e056d63f0083137bceb4dbb10c27beafba11c326701589ef838549d8b6627" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 50574, sha256: "8a4487f2ec15d1f660f4b060d12eb4092197f07865eb1d28fc063ae398bf2dcb" }),
  }),
  // Commercial launch closure (batch commercial-p2): an upgrade never ends paid additional named users automatically.
  "20261030100000_paid_term_seat_preservation.sql": Object.freeze({
    identical: Object.freeze({ bytes: 22439, sha256: "ff5e89bae9aa261f68e85d504ba03b5f0c76230d97ca7d5fa6e247c169b1913f" }),
    finalLfRemoved: Object.freeze({ bytes: 22438, sha256: "f5dcb32819bc450ffbd4ef1cc867e352d747f9220313dac0ac85547828bce57e" }),
    // Self-checking wrapper release/wrappers/20261030100000_paid_term_seat_preservation.wrapper.sql:
    wrapper: Object.freeze({ bytes: 24015, sha256: "8a54ebef4d13b2ed51b6740e2a2cd6be9e14b218553b45a397e53968f98f878f" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 24014, sha256: "89ba277da4415e5de3e1967541603891f7260f2b3f4f14dee2d76c08dbcc06c1" }),
  }),
  // Commercial release correction (batch commercial-p3): a sandbox payment never grants production access. It supersedes
  // 20261031100000, which failed atomically on submission (PT422 CANCELLED_LICENCE_IMMUTABLE) and is deliberately NOT a
  // registered form: its bytes are pinned in scripts/db-proof/lib/parkedMigrations.mjs (SUPERSEDED_SUBMISSIONS) only.
  "20261031110000_sandbox_licence_isolation.sql": Object.freeze({
    identical: Object.freeze({ bytes: 52723, sha256: "790a4fb8a6aa4b196513cb93383bc5452c2e89278876f2884bc10896a7884472" }),
    finalLfRemoved: Object.freeze({ bytes: 52722, sha256: "355bb954257d1db7f473d13d481db3d93652b5c6232c1201d1ae91a7bfa43a01" }),
    // Self-checking wrapper release/wrappers/20261031110000_sandbox_licence_isolation.wrapper.sql:
    wrapper: Object.freeze({ bytes: 54295, sha256: "12a7e92421978e3c4bf2aaa939021558762c1ec47cf69baf703c0ee660adae83" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 54294, sha256: "9014e097f874544be2bd4b991afbe299c6f9de76d41dedf2b6b3ed32d85c46ca" }),
  }),
  // Payment reversal authority (batch commercial-p4): every reversal bounded; a licence decision takes effect; an audited
  // refund workflow for providers that report no refunds (DEFECT-PAYMENT-REVERSAL-UNBOUND-001).
  "20261101100000_payment_reversal_authority.sql": Object.freeze({
    identical: Object.freeze({ bytes: 23281, sha256: "b2477026bc1fa7c6767e609591328d61ffaca1f19bfdea0d4021a446536638ee" }),
    finalLfRemoved: Object.freeze({ bytes: 23280, sha256: "7ec38bf8174505feb766d7363c23caf51bf00a6d48c2be6581e8bcdb998b0a6f" }),
    // Self-checking wrapper release/wrappers/20261101100000_payment_reversal_authority.wrapper.sql:
    wrapper: Object.freeze({ bytes: 24855, sha256: "a8fe9755aaa8f655445ad1c0eb5810e6512920fa2f95daa176691e26fc8c38eb" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 24854, sha256: "510deb91abf854a9301b1703b6d46cbb8325e16a02568b176bc16061d8865b2f" }),
  }),
  // Verified charge outcomes (batch commercial-p5): a verified charge is never dropped (DEFECT-VERIFIED-CHARGE-DROPPED-001).
  "20261102100000_verified_charge_outcomes.sql": Object.freeze({
    identical: Object.freeze({ bytes: 45711, sha256: "b20bf253961a14c3a1c9e66b3602295831a81b614b2da8eae19295dc40e31ae4" }),
    finalLfRemoved: Object.freeze({ bytes: 45710, sha256: "302bdd5c4759ee90ea3a45caefc5e7578e9e0bf9451cb6faabeeef7ba6670570" }),
    // Self-checking wrapper release/wrappers/20261102100000_verified_charge_outcomes.wrapper.sql:
    wrapper: Object.freeze({ bytes: 47281, sha256: "a215cc20994f91c57fe0774401decd21a8129013a6fecb1e70ae3cf1567b57ea" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 47280, sha256: "bf5cd81f20e2a6f7500398259491a3e634a9ec9d6b855775b98657fe9d74d15d" }),
  }),
  // Platform owner, access administration & entity allowances (batch access-a1): the packaging repair of PR #130's merged
  // migration (its embedded BEGIN/COMMIT removed; atomicity via the wrapper). Both source forms and both wrapper forms
  // registered BEFORE application, from the repaired source bytes at 1bd7b34. Authored, PENDING hosted application.
  "20261104100000_platform_owner_access_and_entity_allowance.sql": Object.freeze({
    identical: Object.freeze({ bytes: 38630, sha256: "1cf1dd3264fbc87ee850104028c760b24d1d0269b3addaefbae25ed505b2fb62" }),
    finalLfRemoved: Object.freeze({ bytes: 38629, sha256: "7c8b37c1cd73c4b0189d4ed8f3b613eba200729a136241f4d89af7c5cfc4e8f5" }),
    // Self-checking wrapper release/wrappers/20261104100000_platform_owner_access_and_entity_allowance.wrapper.sql:
    // render() of the identical form; it re-verifies those 38630 bytes and their SHA-256 in PostgreSQL first.
    wrapper: Object.freeze({ bytes: 40236, sha256: "b14ba1cc83320bc14e658edc6b3ff5d5ec6cc2f21b4ff057e3915d7e82565d7a" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 40235, sha256: "163a61cabf1fcf11c5d07f4e4f7e9581ac3e2fb8d7db4da54c59cd20d18a246a" }),
  }),
  // Trial balance release (batch tb-release-r1; main 365b370, PRs #151 + #153): all four forms of each source registered
  // BEFORE application, from the reviewed bytes at 365b370. Authored, PENDING hosted application.
  "20261106100000_trial_balance_drafts.sql": Object.freeze({
    identical: Object.freeze({ bytes: 48210, sha256: "ec9c0fa7c18f797cc38991ee87ff80a14649d0207d737b3d1a7bd06838e3464d" }),
    finalLfRemoved: Object.freeze({ bytes: 48209, sha256: "e7710cf2362b922846bad1ff0c7f48865d7384f96a5dde8c19d3a3ac596fa930" }),
    wrapper: Object.freeze({ bytes: 49772, sha256: "ea99a5858ddf1aaae99c04ee732dee7a4e0d799ca10f39c8e61c81abdcf4f87f" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 49771, sha256: "0e09d77e7baaa8669e337d32b9dc001ddc269e35ccc34df7cdd306649c81800d" }),
  }),
  "20261107100000_certification_findings_capacity.sql": Object.freeze({
    identical: Object.freeze({ bytes: 34711, sha256: "23d1286be5b9a28cc99a24c5b2f459acfd5c7784307e8c312805828a7f891be5" }),
    finalLfRemoved: Object.freeze({ bytes: 34710, sha256: "7c710c4baa659ec91f24513e823fe04e9485bf8f8756617dab604922491b657c" }),
    wrapper: Object.freeze({ bytes: 36295, sha256: "d76f6fa2a816e1907640e0ba5177feed2e93ec27ccd8ffa9499aacf9697b8bbb" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 36294, sha256: "ddfb8f28317a9f5ef287a64809f3f760b0494751f905f158963ca1d55a7b9566" }),
  }),
  "20261108100000_account_identity_codeless_name.sql": Object.freeze({
    identical: Object.freeze({ bytes: 12319, sha256: "b443ea8cf8c440f8e08aca437f67cfb5e4a31b0908025c37c4ecdcd513d553c7" }),
    finalLfRemoved: Object.freeze({ bytes: 12318, sha256: "69e4b1d2e09167b90503a1d1932f853fe8fb250edb337f77a0977c9a48991d3c" }),
    wrapper: Object.freeze({ bytes: 13901, sha256: "74bad382fefb611358214e541c9adf65f9e158d6bba5613adc3089eab8b55195" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 13900, sha256: "220c1aace654da12798e9dc6b33e1b4169f8569e47ae44040032207f760068df" }),
  }),
  "20261109100000_refused_replacement_restore.sql": Object.freeze({
    identical: Object.freeze({ bytes: 18790, sha256: "ed189bfd036aaf173e952271516fb6482c0b84802cf7ca4b2e33d1121fff5d8c" }),
    finalLfRemoved: Object.freeze({ bytes: 18789, sha256: "ac02313ae78031d683b53e6133e689ee99e9de5abe0f939a58e1aecadff85b52" }),
    wrapper: Object.freeze({ bytes: 20366, sha256: "ae02220e26c08042cb0cd08aa27bdbfdf2274bb1f5af9e53fc21d05bc027fdab" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 20365, sha256: "6b36347081f7e154ce1ddcdfb0179e782c7441b27162165698c83e78ca3231bd" }),
  }),
  // Unlimited team members (batch pricing-p1; PR #161 at 4fba8c5): all four forms registered BEFORE application.
  // Authored, PENDING hosted application.
  "20261110100000_unlimited_team_members.sql": Object.freeze({
    identical: Object.freeze({ bytes: 37312, sha256: "5081c8199f53dbb68cf1e2c866f56668505537b901a19af9952cbf6ee8267009" }),
    finalLfRemoved: Object.freeze({ bytes: 37311, sha256: "0a58d3dab14d3c233c1a08668b78971ce7f7eb8b5bad66bd526706c0c64388b3" }),
    wrapper: Object.freeze({ bytes: 38878, sha256: "d3f1ae17f8de24f23f85c49bb7c7f2bfe4d0c80aba4fc1fbcf79f887389bfb79" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 38877, sha256: "1fbcccc09d4fdcf1dff67045fc42515a5c0f7c93de246cd3301779a9b67d7a42" }),
  }),
  // Publication controls of the first IFRS for SMEs reporting slice (batch fs-controls-r1; 8bbb022): all four forms
  // registered BEFORE application, from the reviewed bytes at that commit. Authored, PENDING hosted application.
  "20261111100000_fs_publication_controls.sql": Object.freeze({
    identical: Object.freeze({ bytes: 93290, sha256: "b8b8bef6a9de61829f4a28269f63e9abef9c081666106c46723c69abdacfc95a" }),
    finalLfRemoved: Object.freeze({ bytes: 93289, sha256: "f1337535a75bb5c111ea591452a2edcfcc95b166c3e4771ddf0a87f7951453d0" }),
    wrapper: Object.freeze({ bytes: 94858, sha256: "7c3c0b0d9cd456f07a88da1c0930fb5e4a9c4bdeead6ea068008eca939470d56" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 94857, sha256: "acd55ee6fa3b3961c3bd10e14f65d705782db7b77cf777c759388e3172f13ce2" }),
  }),
  // The reviewed reporting journey (batch fs-journey-r1): all four forms registered BEFORE application; applied after fs-controls-r1.
  "20261112100000_fs_review_workflow_and_rollforward.sql": Object.freeze({
    identical: Object.freeze({ bytes: 71537, sha256: "e499ef6983ae9fd1ebd1063d9f2defe5d66e8c9c7d6d01fb497221fa4132a893" }),
    finalLfRemoved: Object.freeze({ bytes: 71536, sha256: "721e0461d3e8ea6c91a75ae5d02c4a9691331d4d1fc2939d84530d8ae5575823" }),
    wrapper: Object.freeze({ bytes: 73127, sha256: "8f7a1a98a0c34a250dbeb2c94a5c6f4f6d9528a0bf4509e8b1ee89649e135fcd" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 73126, sha256: "615b597594b99ad44c0037f6f17bcb845fa3bb08c1a1a66649cae481f0619c77" }),
  }),
  // The work bounds (batch fs-bounds-r1): all four forms registered BEFORE application; applied after fs-journey-r1.
  "20261114100000_fs_work_bounds.sql": Object.freeze({
    identical: Object.freeze({ bytes: 13548, sha256: "e024082d5c27db04ec1ccd1221ac4702d44549cf0d73be2caf4533aaebc37747" }),
    finalLfRemoved: Object.freeze({ bytes: 13547, sha256: "cc42b96a551f955f127d52b861f00520edab5168ce6347e63b4dcfaad36bbe33" }),
    wrapper: Object.freeze({ bytes: 15098, sha256: "778cfec6f62847def10b7d0938b7aa661ac2c22c2330b40009f3bc0e4682898b" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 15097, sha256: "461d9d38d31624820b672990e2719be619400b6181f1050a898931e7183f1215" }),
  }),
  // The account capacity (batch fs-capacity-r1): all four forms registered BEFORE application; applied after fs-bounds-r1.
  "20261115100000_fs_account_capacity.sql": Object.freeze({
    identical: Object.freeze({ bytes: 55481, sha256: "408e84e112022264c3ad6a11ac646c40d92792bbb5016466d47c136329f163f7" }),
    finalLfRemoved: Object.freeze({ bytes: 55480, sha256: "8300b4002c0e2e5a0c7484cd5e5cd5ade13364a0a59a56e77efd745fbb0bf373" }),
    wrapper: Object.freeze({ bytes: 57041, sha256: "d156d1aa434d290932c03f868d0a03779456a90cbdc269d473f8a0ecf9510428" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 57040, sha256: "8d9a7f8fa37bd430a624141d847bdb8907f1ac10913df6660aa9bcc83fec2dd2" }),
  }),
  // The transaction memo (batch fs-memo-r1): all four forms registered BEFORE application; applied after fs-capacity-r1.
  "20261116100000_fs_transaction_memo.sql": Object.freeze({
    identical: Object.freeze({ bytes: 26996, sha256: "9d278868a4d0bf5794232a6b576239aaef9efd8740aee9b4ddf7b11fe112ae17" }),
    finalLfRemoved: Object.freeze({ bytes: 26995, sha256: "0b436293c992ef65fa9c89c53d2227a4d58d6a62f241838cedca85850132e24b" }),
    wrapper: Object.freeze({ bytes: 28556, sha256: "f332c8b62ba87d99bc149644dd2e43580a6419f9e2d07a4db90666776a5c0321" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 28555, sha256: "7b07a40a8b8b495ece66d2e57d309e7d267408551470ebcebac68fc7ebebf171" }),
  }),
  // Period-currency correction (batch currency-c1; source commit 5581158): all four forms registered BEFORE application;
  // applied 2026-10-20 as 0063 in the wrapperFinalLfRemoved form (RELEASE_JOURNAL).
  "20261113100000_period_currency_correction.sql": Object.freeze({
    identical: Object.freeze({ bytes: 34382, sha256: "91d098a5e6958ac2529fee1005ddc500e0fdbb072635ba3a1967840d3378466d" }),
    finalLfRemoved: Object.freeze({ bytes: 34381, sha256: "cbb154b4a4c5f8b840c699ce0a66088775dd73e8d5bdad7bc8e3825fecb92746" }),
    wrapper: Object.freeze({ bytes: 35956, sha256: "723baa6cc28cefd0e82ffacb40ff2514aec8f0666d4b28a2c06e268214fb528a" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 35955, sha256: "8122917c23abca8726e7ee763796ffae568179233c9537b61a5aff35310f17bc" }),
  }),
  // Trial Balance workflow, Track A (batch tb-portfolio-a1; source commit ac8a396): all four forms registered BEFORE
  // application. PENDING hosted application (a separate, approved release step).
  "20261117100000_engagement_portfolio.sql": Object.freeze({
    identical: Object.freeze({ bytes: 26579, sha256: "a9eb6ca77c26a29e7c6f4230e0466fa4320e07d5537ec1f2a6baafaf989873f7" }),
    finalLfRemoved: Object.freeze({ bytes: 26578, sha256: "9c3302a0020e3f1c1ab5933ba4e085204c7c3f415fc7ffad6ef4c6a0efb803e3" }),
    wrapper: Object.freeze({ bytes: 28141, sha256: "c07611e571c7c65bf986a47ea6105b9c99e7c898d65c18f53c9afc652d34e08d" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 28140, sha256: "162393795b77f4c442a246665377c20166978b8e2a959448d8e74b3de90a9756" }),
  }),
  // Trial Balance workflow, Track B (batch tb-decisions-b1): all four forms are registered BEFORE application;
  // regenerated after the final-schema manifest, exhaustive finding-rule and capacity-proof corrections. PENDING hosted application.
  "20261118100000_tb_finding_decisions.sql": Object.freeze({
    identical: Object.freeze({ bytes: 99185, sha256: "223d15e3e7ee2d941af1c4152f7c206b6aceabee96624ae990b8ddf4282db216" }),
    finalLfRemoved: Object.freeze({ bytes: 99184, sha256: "38ae60d9b945b314c5922a44726237dbe0c393ba587c27313fc1199f72ba8a75" }),
    wrapper: Object.freeze({ bytes: 100714, sha256: "dab3fa1720468119b5f24f97ed045c2116f7a086c75125e1db9f45f9b5b8e4d8" }),
    wrapperFinalLfRemoved: Object.freeze({ bytes: 100713, sha256: "2869a20477367df2542676b0bf4c0aadc074a8420107241578f18df325916efa" }),
  }),
});

/**
 * Which registered submission form `submitted` is of source `name` (`src` = its bytes): "identical", "final_lf_removed",
 * "wrapper", "wrapper_final_lf_removed" (the registered self-checking wrapper, rendered from `src`), or null (any other text, an unregistered source, or a source whose bytes no longer match its registration).
 */
export function submittedForm(name, src, submitted) {
  const forms = SUBMISSION_FORMS[name];
  if (!forms || !src || !submitted) return null;
  if (src.length !== forms.identical.bytes || sha256(src) !== forms.identical.sha256) return null;
  if (submitted.equals(src)) return "identical";
  if (forms.wrapper) {
    const w = Buffer.from(renderSelfCheckingWrapper(name, src), "utf8");
    if (w.length === forms.wrapper.bytes && sha256(w) === forms.wrapper.sha256) {
      if (submitted.equals(w)) return "wrapper";
      const wl = forms.wrapperFinalLfRemoved;
      if (wl && submitted.length === w.length - 1 && submitted.equals(w.subarray(0, w.length - 1))
          && submitted.length === wl.bytes && sha256(submitted) === wl.sha256) return "wrapper_final_lf_removed";
    }
  }
  const lf = forms.finalLfRemoved;
  if (lf && src[src.length - 1] === 0x0a && submitted.length === src.length - 1 && submitted.equals(src.subarray(0, src.length - 1))
      && submitted.length === lf.bytes && sha256(submitted) === lf.sha256) return "final_lf_removed";
  return null;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const code = (text) => lexSql(text).filter((t) => t.type !== "ws" && t.type !== "comment");
const words = (toks) => toks.filter((t) => t.type === "word").map((t) => t.text.toUpperCase());
const RELEASE_OBJECTS = new Set(["_PR34_PROBE", "_PR34_MIGRATION_BODIES"]);
const CLIENT_ROLES = new Set(["PUBLIC", "ANON", "AUTHENTICATED", "SERVICE_ROLE"]);

/** Tokens of a DO body (the single top-level DO statement), or null. */
function doBody(text) {
  const top = code(text);
  if (top.length !== 3 || top[0].text.toUpperCase() !== "DO" || top[1].type !== "dollar" || top[2].text !== ";") return null;
  return { tag: top[1].tag, toks: code(top[1].body) };
}

/** Structural re-check of an apply wrapper (on top of the exact template match). Returns problems. */
export function checkApplyWrapperStructure(text) {
  const problems = [];
  const d = doBody(text);
  if (!d) return ["is not exactly one DO statement"];
  const w = words(d.toks);
  const exec = w.flatMap((x, i) => (x === "EXECUTE" ? [i] : []));
  if (exec.length !== 1 || w[exec[0] + 1] !== "V_BODY") problems.push("must EXECUTE exactly the staged body v_body, once");
  const upd = w.indexOf("UPDATE");
  if (upd < 0 || upd < exec[0]) problems.push("applied_at must be recorded only after the EXECUTE succeeded");
  if (w.filter((x) => x === "UPDATE").length !== 1) problems.push("must record applied_at in exactly one UPDATE");
  if (w.some((x) => ["GRANT", "REVOKE", "INSERT", "DELETE", "TRUNCATE", "ALTER", "DROP", "CREATE", "FORMAT"].includes(x))) problems.push("contains SQL beyond selecting, checking, executing and recording its body");
  // Selection is only ever by the constant name: every FROM _pr34_migration_bodies is followed by WHERE name = v_name.
  const t = d.toks.map((x) => x.text).join(" ");
  const froms = t.match(/FROM public \. _pr34_migration_bodies WHERE name = v_name/g) ?? [];
  const tableRefs = t.match(/_pr34_migration_bodies/g) ?? [];
  if (froms.length + 1 !== tableRefs.length || !/UPDATE public \. _pr34_migration_bodies SET applied_at = now \( \) WHERE name = v_name/.test(t)) problems.push("selects or records a body other than the one named by its constant");
  if (!/v_name TEXT : = '[0-9]{14}_[a-z0-9_]+\.sql'/.test(t)) problems.push("the migration name must be a constant");
  return problems;
}

/** Structural check of the probe / staging entries. Returns problems. */
export function checkReleaseInfrastructure(kind, text) {
  const problems = [];
  const all = code(text);
  // Dollar-quoted bodies AND string literals are lexed as code too: dynamic SQL (EXECUTE '...') is inspected, never hidden.
  const unquote = (s) => s.slice(1, -1).replace(/''/g, "'");
  const flat = (toks) => toks.flatMap((x) => (x.type === "dollar" ? [x, ...flat(code(x.body))] : x.type === "string" ? [x, ...flat(code(unquote(x.text)))] : [x]));
  const toks = flat(all);
  const w = words(toks);
  // No DML on any table other than the release objects; no customer or accounting data is touched.
  for (let i = 0; i < w.length; i++) {
    if (["INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(w[i])) {
      const target = w.slice(i + 1, i + 6).find((x) => !["INTO", "FROM", "ONLY", "PUBLIC", "TABLE"].includes(x));
      if (w[i] === "INSERT" && w[i - 1] === "SELECT") continue;   // "GRANT SELECT, INSERT ON ..." privilege list
      if (!RELEASE_OBJECTS.has(target ?? "")) problems.push(`${w[i]} on ${target} (release entries may not change data)`);
    }
  }
  // Every CREATE / ALTER / COMMENT names a release object only.
  for (let i = 0; i < w.length; i++) {
    if (w[i] === "CREATE" || w[i] === "ALTER" || (w[i] === "COMMENT" && w[i + 1] === "ON")) {
      const target = w.slice(i + 1, i + 8).find((x) => x.startsWith("_PR34_") || !["TABLE", "IF", "NOT", "EXISTS", "ON", "PUBLIC"].includes(x));
      if (!RELEASE_OBJECTS.has(target ?? "")) problems.push(`${w[i]} of ${target} (only the release objects may be created or altered)`);
    }
  }
  // No client role is ever granted anything.
  const s = toks.filter((x) => x.type !== "string" && x.type !== "dollar").map((x) => x.text).join(" ").toUpperCase();
  for (const m of s.matchAll(/GRANT ([A-Z ,]+) ON [A-Z0-9_. ]+ TO ([A-Z_]+)/g)) {
    if (CLIENT_ROLES.has(m[2].trim())) problems.push(`grants ${m[1].trim().replace(/\s*,\s*/g, ", ")} to ${m[2].trim()}`);
  }
  if (kind === "staging_table") {
    if (!/ENABLE ROW LEVEL SECURITY/.test(s)) problems.push("the staging table must have RLS enabled");
    for (const role of ["PUBLIC", "ANON", "AUTHENTICATED"]) if (!new RegExp(`REVOKE ALL ON PUBLIC \\. _PR34_MIGRATION_BODIES FROM ${role}`).test(s)) problems.push(`the staging table must revoke all from ${role}`);
  }
  if (kind === "probe" && !/CREATE TABLE IF NOT EXISTS PUBLIC \. _PR34_PROBE/.test(s)) problems.push("the probe may only create public._pr34_probe");
  return problems;
}

/**
 * Validates one release journal entry. Returns { covers?: source, outOfOrder?: boolean, problems: string[] }.
 * `srcBytes(name)` returns the source migration's bytes (or null when missing).
 */
export function checkReleaseEntry(tag, text, srcBytes) {
  const entry = RELEASE_JOURNAL[tag];
  if (!entry) return { problems: [`${tag} is a release entry that has not been reviewed (add it to RELEASE_JOURNAL after review)`] };
  const problems = [];
  if (sha256(Buffer.from(text, "utf8")) !== entry.sha256) problems.push(`${tag} differs from its reviewed content (SHA-256)`);
  if (entry.kind === "release_verbatim") {
    const src = srcBytes(entry.source);
    if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
    const hosted = Buffer.from(text, "utf8");
    if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
    if (src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
    if (hosted.length !== entry.bytes) problems.push(`${tag}: has ${hosted.length} bytes, expected ${entry.bytes}`);
    if (!hosted.equals(src)) problems.push(`${tag} is not byte-for-byte identical to ${entry.source}`);
    if (SUBMISSION_FORMS[entry.source] && submittedForm(entry.source, src, hosted) !== "identical") {
      problems.push(`${tag} is not the registered identical submission form of ${entry.source}`);
    }
    // Explicitly reviewed out-of-order applications retain all byte/hash checks above.
    return { covers: entry.source, how: "release_verbatim", outOfOrder: entry.outOfOrder === true, problems };
  }
  if (entry.kind === "release_verbatim_final_lf_removed") {
    const src = srcBytes(entry.source);
    if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
    const hosted = Buffer.from(text, "utf8");
    if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
    if (src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
    if (hosted.length !== entry.submittedBytes) problems.push(`${tag}: has ${hosted.length} bytes, expected ${entry.submittedBytes}`);
    const lf = SUBMISSION_FORMS[entry.source]?.finalLfRemoved;
    if (!lf || lf.sha256 !== entry.sha256 || lf.bytes !== entry.submittedBytes) {
      problems.push(`${tag}: the final-LF-removed form is not registered for ${entry.source} (SUBMISSION_FORMS)`);
    }
    if (submittedForm(entry.source, src, hosted) !== "final_lf_removed") {
      problems.push(`${tag} is not exactly ${entry.source} with its single final LF byte removed`);
    }
    return { covers: entry.source, how: "release_verbatim_final_lf_removed", outOfOrder: false, problems };
  }
  if (entry.kind === "release_self_checking_wrapper") {
    // A hosted mirror of a registered self-checking wrapper: the reviewed entry pins the source (digest, bytes), the
    // form, and the mirror's own SHA-256 and byte count; the mirror must BE that registered wrapper form, byte for byte.
    const src = srcBytes(entry.source);
    if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
    const hosted = Buffer.from(text, "utf8");
    if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
    if (src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
    if (hosted.length !== entry.submittedBytes) problems.push(`${tag}: has ${hosted.length} bytes, expected ${entry.submittedBytes}`);
    const reg = entry.form === "wrapper" ? SUBMISSION_FORMS[entry.source]?.wrapper : entry.form === "wrapper_final_lf_removed" ? SUBMISSION_FORMS[entry.source]?.wrapperFinalLfRemoved : null;
    if (!reg || reg.sha256 !== entry.sha256 || reg.bytes !== entry.submittedBytes) problems.push(`${tag}: ${entry.form} is not a registered wrapper form of ${entry.source} (SUBMISSION_FORMS)`);
    if (submittedForm(entry.source, src, hosted) !== entry.form) problems.push(`${tag} is not exactly the registered ${entry.form} of ${entry.source}`);
    // A reviewed entry may declare itself applied OUT OF SOURCE ORDER (ahead of authored, still-pending sources): the parity
    // checker then counts it as applied without treating the earlier sources as skipped (the 0016 precedent).
    return { covers: entry.source, how: "release_self_checking_wrapper", outOfOrder: entry.outOfOrder === true, problems };
  }
  if (entry.kind === "fsi_staged_transport") {
    const r = checkFsiTransportMirror(tag, text);
    problems.push(...r.problems);
    if (sha256(Buffer.from(text.replace(/\n$/, ""), "utf8")) !== entry.sha256) problems.push(`${tag}: does not match its pinned SHA-256`);
    if (r.covers) {
      const batch = FSI_TRANSPORT_BATCHES.find((b) => b.source === r.covers);
      const src = srcBytes(r.covers);
      if (!batch || !src || src.length !== batch.artifacts.source.bytes || sha256(src) !== batch.artifacts.source.sha256) {
        problems.push(`${tag}: the covered reporting source ${r.covers} differs from its approved byte identity`);
      }
      return { covers: r.covers, how: "fsi_staged_transport", outOfOrder: false, problems };
    }
    return { problems };
  }
  if (entry.kind === "tb_staged_transport") {
    const r = checkTbTransportMirror(tag, text);
    problems.push(...r.problems);
    if (r.covers) {
      const batch = TB_TRANSPORT_BATCHES.find((b) => b.source === r.covers);
      const src = srcBytes(r.covers);
      if (!batch || !src || src.length !== batch.sourceArtifact.bytes || sha256(src) !== batch.sourceArtifact.sha256) {
        problems.push(`${tag}: the covered TB source ${r.covers} differs from its approved byte identity`);
      }
      return { covers: r.covers, how: "tb_staged_transport", outOfOrder: false, problems };
    }
    return { problems };
  }
  if (entry.kind === "staged_transport") {
    // A staged-transport entry (scripts/release/stagedTransport.mjs): the mirror must be exactly a REGISTERED transport
    // form; an apply covers its batch's source (the staged original wrapper it executed), the bootstrap covers nothing.
    const r = checkTransportMirror(tag, text);
    problems.push(...r.problems);
    return r.covers ? { covers: r.covers, how: "staged_transport", outOfOrder: false, problems } : { problems };
  }
  if (entry.kind === "probe" || entry.kind === "staging_table") {
    problems.push(...checkReleaseInfrastructure(entry.kind, text).map((p) => `${tag}: ${p}`));
    return { problems };
  }
  if (entry.kind === "release_guarded") return checkGuardedReleaseEntry(tag, entry, text, srcBytes, problems);
  const src = srcBytes(entry.source);
  if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
  if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
  if (entry.bytes !== undefined && src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
  const rendered = TEMPLATES[entry.template]?.({ name: entry.source, digest: sha256(src), bytes: src.length, blob: entry.blob, head: entry.head });
  if (rendered !== text.replace(/\r\n/g, "\n")) problems.push(`${tag} is not exactly the reviewed "${entry.template}" wrapper for ${entry.source}`);
  problems.push(...checkApplyWrapperStructure(text).map((p) => `${tag}: ${p}`));
  return { covers: entry.source, outOfOrder: entry.outOfOrder === true, problems };
}

/**
 * A guarded release entry (scripts/release/guardedEntry.mjs, reviewed with scripts/db-proof/hostedExecutorRelease.mjs):
 * the approved source byte for byte between a guard that REFUSES a second application and a record block that asserts
 * the source's read-only post-apply verification and writes the release ledger. Pinned by its own SHA-256 and re-rendered
 * from the repository's source and verification file.
 */
export function checkGuardedReleaseEntry(tag, entry, text, srcBytes, problems = []) {
  const src = srcBytes(entry.source);
  if (!src) return { problems: [...problems, `${tag} applies an unknown migration ${entry.source}`] };
  if (sha256(src) !== entry.digest) problems.push(`${tag}: the pinned digest does not match ${entry.source} in this repository`);
  if (src.length !== entry.bytes) problems.push(`${tag}: the pinned byte count ${entry.bytes} does not match ${entry.source} (${src.length})`);
  if (!fs.existsSync(path.join(REPO_ROOT, "scripts/db-preflight", entry.verify ?? ""))) problems.push(`${tag}: unknown verification file ${entry.verify}`);
  else problems.push(...checkGuardedEntry(text.replace(/\r\n/g, "\n"), { source: entry.source, head: entry.head, repoRoot: REPO_ROOT, verify: entry.verify, requires: entry.requires ?? [] }).map((p) => `${tag}: ${p}`));
  if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) problems.push(`${tag}: a release_guarded entry must pin its own SHA-256`);
  else if (sha256(Buffer.from(text, "utf8")) !== entry.sha256) problems.push(`${tag}: the entry's SHA-256 does not match its pinned value`);
  return { covers: entry.source, how: "release_guarded", outOfOrder: false, problems };
}

export const isReleaseTag = (tag) => /^\d{4}_pr34_/.test(tag) || Object.prototype.hasOwnProperty.call(RELEASE_JOURNAL, tag);
