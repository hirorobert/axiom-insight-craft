/**
 * The controlled PR #34 release journal (Drizzle 0013–0022) is validated strictly by the migration-authority guard
 * (rule 8, scripts/ci/releaseJournal.mjs): every entry is pinned AND structurally re-checked; any mutation — and any
 * unreviewed release entry — fails. Not an allow-list.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_JOURNAL, SUBMISSION_FORMS, checkApplyWrapperStructure, checkReleaseEntry, checkReleaseInfrastructure, submittedForm } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.join(__dirname, "../../..");
const DZ = path.join(ROOT, "drizzle/migrations");
const SRC = path.join(ROOT, "supabase/migrations");
const read = (tag: string) => fs.readFileSync(path.join(DZ, `${tag}.sql`), "utf8");
const srcBytes = (name: string) => (fs.existsSync(path.join(SRC, name)) ? fs.readFileSync(path.join(SRC, name)) : null);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: Array<{ tag: string; source: string; how: string }>; releaseApplied: Array<{ tag: string; source: string }> };

const T25 = "0025_apply_20261001120000_annual_commercial_term";
const T29 = "0029_apply_20261007100000_treatment_authority_and_processing_control";
const S29 = "20261007100000_treatment_authority_and_processing_control.sql";
const H1_CANONICAL = "0010ec531f3924e3a63031a0f42185c94414ab72a15396b4a3d43499468092c6";
const H1_SUBMITTED = "3591b7d0a6a39db2bf479aa8ecb86e5c0b8c4f01bdb86cf166abb56fc5e23ae0";
const S2 = "20261008100000_processing_attempt_authority.sql";
const T30 = "0030_apply_20261008100000_processing_attempt_authority";
const S2_CANONICAL = "6ad6ac7d6aac244950a0e69bd1c278bea1eee5ac9e12c98e541ca9c961c9c25d";
const S2_SUBMITTED = "169a3771a009973114437a5bd24318083d05e391876f6dfbacfbaf994bb817b8";
const I1A_A1 = "20261009100000_currency_registry_and_reporting_periods.sql";
const I1A_A2 = "20261010100000_layout_templates_and_confirmations.sql";
const S25 = "20261001120000_annual_commercial_term.sql";
// The milestone's seven sources, with both registered forms recomputed from the final reviewed bytes.
// The reporting release (PRs #89–#94): all four forms registered before application. Recomputed below from the bytes.
const REPORTING = ["20261018100000_fs_statement_composition.sql", "20261019100000_fs_notes_and_schedules.sql", "20261020100000_fs_comparatives.sql",
  "20261021100000_fs_signoff_binding.sql", "20261022100000_fs_reporting_closure.sql"].map((name) => ({ name }));
// The readiness correction (DEFECT D-2): all four forms registered before application.
const READINESS = ["20261023100000_fs_report_readiness_volatility.sql"].map((name) => ({ name }));
// The statement sign-off policy (reporting r5): all four forms registered before application.
const SIGNOFF_POLICY = ["20261024100000_fs_signoff_approval_policy.sql"].map((name) => ({ name }));
// The commercial candidate (batch commercial-c1): all four forms of each registered before application.
const COMMERCIAL = ["20261025100000_commercial_enquiries.sql", "20261026100000_retire_browser_adjusting_journal_writes.sql"].map((name) => ({ name }));
const MILESTONE = [
  { name: "20261011100000_two_period_shared_source.sql", bytes: 33926, canonical: "5feb43d1268790f9b1b205d316081759c7912156c77bb34ba51e881b2297a01a", submitted: "e61a38b2de5353bb5f22a9b910bd86b3490746ae6d30ea9fae8bc291c80418a6" },
  { name: "20261012100000_layout_assist_controls.sql", bytes: 26700, canonical: "aa7ae748164aa1a0fd0fffe55fd362db53f10120223b5da81ceaf94ee4c447dd", submitted: "4a9a81b92acdbc2d07a88614676138d40bc93648ec7175a02ec36cbcb5368e39" },
  { name: "20261013100000_close_review_timeline.sql", bytes: 9148, canonical: "84787f004c83b2dd5258d14d323bb39c65c8eb37372122ce1b729e9b441598f0", submitted: "5edd6b46b326fce02872404d4dde6aac4fa50c5af9fec36356225938ec43a0d9" },
  { name: "20261014100000_close_review_findings.sql", bytes: 35821, canonical: "61b1bcffc1148f557e2aa62b8e245e12b9e8ef7a2a6a9e861ec94036a629ca3f", submitted: "936973b10ce839deb21b4284b098f981317871b6f22c81999370be1054ee4e48" },
  { name: "20261015100000_close_review_adjustments.sql", bytes: 51377, canonical: "75387e4ce9cb3dee63001b67c28bb76cebfccc156229b24e206d55c6588b58e2", submitted: "72b3c226f369d77975bef7f37ff05259732edb413f8a342b366012cb459ffeac" },
  { name: "20261016100000_fs_reporting_input.sql", bytes: 11306, canonical: "d6c019785cdd67301c539bfc7d4c413e365c917039da4dc27adcb4128c3a3a39", submitted: "824d85803148e5ae46a90ab300d62ea9d4f3116c9c17095b8cb57fd5dc9fa71c" },
  { name: "20261017100000_signoff_completion_requirements.sql", bytes: 21060, canonical: "4523efd91edb2f3028786c93adeffc2c73392595a33620ce5b2fb82558c3b5af", submitted: "013a0b0f440d6ffb6713f98acb22872cf9d73b2fbe41cb76801450eea8ccb32b" },
];

const D25 = "621f55c35bdadf3c7baa8c259056712dbfbbedbd25417a2a5d6a92fd4a1d38fa";

describe("the reviewed release journal", () => {
  it("every entry 0013–0022 and 0024 validates: exact content, exact template, digest = the source file in this repository", () => {
    for (const tag of Object.keys(RELEASE_JOURNAL)) expect(checkReleaseEntry(tag, read(tag), srcBytes).problems, tag).toEqual([]);
    // 14: 0028 (S1, release_verbatim, hosted journal id 29) joins the reviewed entries.
    // 15: 0029 (H1, release_verbatim_final_lf_removed) joins them; 16: 0030 (S2, the same kind).
    // 18: 0031 and 0032 (I1-A A1/A2, release_verbatim, identical form).
    // 25: 0033–0039 (the milestone, release_self_checking_wrapper, registered wrapper form).
    // 30: 0040–0044 (the reporting release, release_self_checking_wrapper; hosted 41–45).
    // 31: 0045 (the readiness correction, release_self_checking_wrapper; hosted 46).
    expect(Object.keys(RELEASE_JOURNAL)).toHaveLength(31);
  });
  it("pins the prerequisite and 140000 digests exactly as authorised", () => {
    expect(RELEASE_JOURNAL["0016_pr34_apply_prereq_20260915100000"]).toMatchObject({ digest: "e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712", bytes: 18569 });
    expect(sha(srcBytes("20260915100000_financial_statement_documents.sql")!)).toBe("e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712");
    expect(RELEASE_JOURNAL["0020_pr34_apply_20260925140000"].digest).toBe("c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a");
    for (const [tag, e] of Object.entries(RELEASE_JOURNAL)) if ("source" in e && e.source) expect(sha(srcBytes(e.source)!), tag).toBe(e.digest);
  });
  it("the guard accepts the repository: the wrappers apply 100000–150000, the processing correction 20260926160000 , the removal migration 20260927100000 (0024) and (out of order on purpose) the prerequisite; 0028 applies S1 byte for byte; only H1 (20261007100000) is pending (the parked 20261004100000 / 20261005100000 are quarantined)", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    // 0022 applied the processing correction (f21a58f); 0024 the removal migration (main 0d2a09e); 0025 the annual term
    // (release_verbatim); 0026 the withheld-service grant refusal (release_verbatim). Authored and not yet applied: 20261004100000 (reconciliation server authority) and
    // 20261005100000 (evidence ingestion authority).
    // S1 record: 0028 applied 20261006100000 byte for byte (release_verbatim; hosted journal id 29, created_at 1791299426677).
    // The parked 20261004100000 / 20261005100000 were never applied and are quarantined in supabase/migrations_historical/,
    // so the source chain is exactly the hosted journal: nothing pending, nothing skipped.
    // H1 (20261007100000) is applied as 0029: its source minus its single final LF (release_verbatim_final_lf_removed).
    // S2 (20261008100000) is applied as 0030 in the same registered form. Nothing is pending.
    // I1-A (20261009100000, currency registry and explicit reporting periods) is authored and pending hosted application.
    // I1-A (20261010100000, layout templates and confirmations) is authored and pending hosted application.
    // I1-A A1/A2 are applied (hosted 0031/0032, identical form).
    // The milestone 20261011100000–20261017100000 is applied as 0033–0039 through its self-checking wrappers. Nothing pending.
    expect(r.pending).toEqual(["20261024100000_fs_signoff_approval_policy.sql", "20261025100000_commercial_enquiries.sql", "20261026100000_retire_browser_adjusting_journal_writes.sql"]); // the statement sign-off policy (reporting r5), authored and pending hosted application // the reporting release is applied as 0040–0044 (hosted 41–45)
    expect(r.mirrored.find((m) => m.tag === T29)).toEqual({ tag: T29, source: S29, how: "release_verbatim_final_lf_removed" });
    expect(r.mirrored.find((m) => m.tag === T30)).toEqual({ tag: T30, source: S2, how: "release_verbatim_final_lf_removed" });
    expect(r.mirrored.find((m) => m.tag === "0028_apply_20261006100000_mapping_and_processing_authority")).toEqual({
      tag: "0028_apply_20261006100000_mapping_and_processing_authority", source: "20261006100000_mapping_and_processing_authority.sql", how: "release_verbatim" });
    expect(r.mirrored.find((m) => m.tag === "0026_apply_20261002100000_refuse_withheld_service_grants")?.how).toBe("release_verbatim");
    expect(r.mirrored.find((m) => m.tag === T25)).toEqual({ tag: T25, source: S25, how: "release_verbatim" });
    expect(r.releaseApplied).toEqual([{ tag: "0016_pr34_apply_prereq_20260915100000", source: "20260915100000_financial_statement_documents.sql" }]);
    expect(r.mirrored.filter((m) => m.how === "release_wrapper").map((m) => m.source)).toEqual([
      "20260925100000_global_capabilities_entitlements_pricing.sql", "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql",
      "20260925120000_reporting_pack_issuance_binding.sql", "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql",
      "20260925140000_workspace_capability_authorization.sql", "20260925150000_can_user_act_on_workspace_minimum_grant.sql",
      "20260926160000_trial_balance_processing_entitlement_wall.sql", "20260927100000_trial_balance_remove_from_active_use.sql",
    ]);
  });
  it("0024 is recognised by its exact reviewed tag only, pinned by SHA-256 and re-rendered from its template; any change fails closed", () => {
    const T = "0024_apply_20260927100000_trial_balance_remove_from_active_use";
    expect(RELEASE_JOURNAL[T]).toMatchObject({ template: "verbatim_noop_main", digest: "f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157", head: "0d2a09eaed9cd6f96790d57bfeb4cf681877b743" });
    expect(sha(srcBytes("20260927100000_trial_balance_remove_from_active_use.sql")!)).toBe("f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157");
    const text = read(T);
    expect(checkReleaseEntry(T, text, srcBytes).problems).toEqual([]);
    // The template differs from verbatim_noop in exactly the header's "approved main head".
    expect(text).toContain("-- (approved main head 0d2a09eaed9cd6f96790d57bfeb4cf681877b743, SHA-256");
    for (const [label, mutated] of [
      ["an extra grant", text.replace("  EXECUTE v_body;", "  EXECUTE v_body;\n  GRANT ALL ON public.companies TO anon;")],
      ["another digest", text.replace(/f512988f8998e8db8b814ca3d92b2cc52281cff6a1333a4e5b5b0279ac4c3157/g, "0".repeat(64))],
      ["another head", text.replace("0d2a09eaed9cd6f96790d57bfeb4cf681877b743", "a".repeat(40))],
      ["a trailing edit", text + "\n-- edited"],
    ] as const) expect(checkReleaseEntry(T, mutated, srcBytes).problems.length, label).toBeGreaterThan(0);
  });
});

describe("mutations fail — structurally, not only by the content pin", () => {
  const W = "0020_pr34_apply_20260925140000";
  const w = read(W);
  const structural = (text: string) => checkApplyWrapperStructure(text);
  it("a wrapper referencing another / unknown migration fails", () => {
    const t = w.replace(/20260925140000_workspace_capability_authorization\.sql/g, "20260925140001_unknown.sql");
    expect(checkReleaseEntry(W, t, srcBytes).problems.join("\n")).toMatch(/not exactly the reviewed|differs from its reviewed content/);
  });
  it("a different digest fails; a different byte count fails", () => {
    expect(checkReleaseEntry(W, w.replace("c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a", "0".repeat(64)), srcBytes).problems.join("\n")).toMatch(/not exactly the reviewed/);
    const P = "0016_pr34_apply_prereq_20260915100000";
    expect(checkReleaseEntry(P, read(P).replace(/18569/g, "18570"), srcBytes).problems.join("\n")).toMatch(/not exactly the reviewed/);
  });
  it("additional SQL fails (appended statement, extra DDL / grant inside the block)", () => {
    expect(structural(`${w}\nGRANT ALL ON public.companies TO anon;`)).toContain("is not exactly one DO statement");
    expect(structural(w.replace("  EXECUTE v_body;", "  EXECUTE v_body;\n  GRANT ALL ON public.companies TO anon;")).join("\n")).toMatch(/beyond selecting/);
    expect(structural(w.replace("  EXECUTE v_body;", "  DROP TABLE public.companies;\n  EXECUTE v_body;")).join("\n")).toMatch(/beyond selecting/);
  });
  it("dynamic or unconstrained selection fails", () => {
    expect(structural(w.replace("FROM public._pr34_migration_bodies WHERE name = v_name;", "FROM public._pr34_migration_bodies ORDER BY staged_at DESC LIMIT 1;")).join("\n")).toMatch(/other than the one named/);
    expect(structural(w.replace("  EXECUTE v_body;", "  EXECUTE format('%s', v_body);")).join("\n")).toMatch(/exactly the staged body|beyond selecting/);
    expect(structural(w.replace(/v_name TEXT := '[^']+';/, "v_name TEXT := current_setting('pr34.name');")).join("\n")).toMatch(/constant/);
  });
  it("recording applied_at before the execution succeeded fails", () => {
    const moved = w.replace("  EXECUTE v_body;\n  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;", "  UPDATE public._pr34_migration_bodies SET applied_at = now() WHERE name = v_name;\n  EXECUTE v_body;");
    expect(moved).not.toBe(w);
    expect(structural(moved).join("\n")).toMatch(/only after the EXECUTE/);
  });
  it("the probe or staging entry changing customer or accounting data, creating other objects, or granting a client role fails", () => {
    // (function replacements: "$$" in a replacement string would collapse to "$")
    expect(checkReleaseInfrastructure("probe", read("0013_pr34_probe_session_identity").replace("END\n$$;", () => "  UPDATE public.companies SET name = 'x';\nEND\n$$;")).join("\n")).toMatch(/UPDATE on COMPANIES/);
    expect(checkReleaseInfrastructure("probe", read("0013_pr34_probe_session_identity").replace("END\n$$;", () => "  DELETE FROM public.tax_computations;\nEND\n$$;")).join("\n")).toMatch(/DELETE on TAX_COMPUTATIONS/);
    expect(checkReleaseInfrastructure("probe", read("0013_pr34_probe_session_identity").replace("public._pr34_probe (id int)", "public.companies_copy (id int)")).join("\n")).toMatch(/only the release objects|may only create/);
    const staging = read("0014_pr34_release_staging_table");
    expect(checkReleaseInfrastructure("staging_table", staging.replace("TO sandbox_exec", "TO authenticated")).join("\n")).toMatch(/grants SELECT, INSERT to AUTHENTICATED/);
    expect(checkReleaseInfrastructure("staging_table", staging.replace("  EXECUTE 'REVOKE ALL ON public._pr34_migration_bodies FROM anon';\n", "")).join("\n")).toMatch(/must revoke all from ANON/);
    expect(checkReleaseInfrastructure("staging_table", staging.replace("ENABLE ROW LEVEL SECURITY", "DISABLE ROW LEVEL SECURITY")).join("\n")).toMatch(/RLS enabled/);
  });
  it("any content change to a reviewed entry fails by its pin as well", () => {
    for (const tag of Object.keys(RELEASE_JOURNAL)) expect(checkReleaseEntry(tag, `${read(tag)}\n-- edited`, srcBytes).problems.join("\n"), tag).toMatch(/differs from its reviewed content/);
  });
});

describe("the guard fails closed on the journal", () => {
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-journal-"));
    fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
    fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
    return dir;
  };
  const addEntry = (dir: string, tag: string, sql: string) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "drizzle/migrations/meta/_journal.json"), "utf8"));
    const idx = j.entries.length;
    j.entries.push({ ...j.entries[idx - 1], idx, tag });
    fs.writeFileSync(path.join(dir, "drizzle/migrations/meta/_journal.json"), JSON.stringify(j, null, 2));
    fs.writeFileSync(path.join(dir, `drizzle/migrations/${tag}.sql`), sql);
    fs.copyFileSync(path.join(dir, `drizzle/migrations/meta/${String(idx - 1).padStart(4, "0")}_snapshot.json`), path.join(dir, `drizzle/migrations/meta/${String(idx).padStart(4, "0")}_snapshot.json`));
  };
  it("a new, unreviewed release wrapper fails even when it is a perfect wrapper for a real migration", () => {
    const dir = copy();
    try {
      const w = read("0021_pr34_apply_20260925150000").replace(/20260925150000_can_user_act_on_workspace_minimum_grant\.sql/g, "20260926160000_trial_balance_processing_entitlement_wall.sql")
        .replace("3011c3414d7a0b5811015218ae35f8721663eaa32ddd7e5233f269fcb91daacb", sha(srcBytes("20260926160000_trial_balance_processing_entitlement_wall.sql")!));
      addEntry(dir, "0023_pr34_apply_20260926160000_again", w);
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/release: 0023_pr34_apply_20260926160000_again is a release entry that has not been reviewed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
  it("editing a reviewed wrapper, or removing it from the journal, fails", () => {
    const dir = copy();
    try {
      fs.appendFileSync(path.join(dir, "drizzle/migrations/0020_pr34_apply_20260925140000.sql"), "\nGRANT ALL ON public.companies TO anon;\n");
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/release: 0020_pr34_apply_20260925140000 differs from its reviewed content/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
  it("a changed source migration breaks its wrapper's digest", () => {
    const dir = copy();
    try {
      fs.appendFileSync(path.join(dir, "supabase/migrations/20260925140000_workspace_capability_authorization.sql"), "\n-- edited after it was applied\n");
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/0020_pr34_apply_20260925140000: the pinned digest does not match 20260925140000/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});

describe("0025 release_verbatim: exact tag, path, bytes, SHA-256 and byte-for-byte equality", () => {
  const text = () => read(T25);
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-0025-"));
    fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
    fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
    return dir;
  };
  const errs = (mutate: (dir: string) => void) => {
    const dir = copy();
    try { mutate(dir); return (checkMigrationAuthority(dir) as Result).errors.join("\n"); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const withEntry = <T>(patch: Record<string, unknown>, fn: () => T): T => {
    const e = RELEASE_JOURNAL[T25] as Record<string, unknown>;
    const saved = { ...e };
    Object.assign(e, patch);
    try { return fn(); } finally { for (const k of Object.keys(patch)) delete e[k]; Object.assign(e, saved); }
  };
  it("is pinned exactly and equals its source byte for byte", () => {
    expect(RELEASE_JOURNAL[T25]).toEqual({ kind: "release_verbatim", source: S25, bytes: 19294, digest: D25, sha256: D25 });
    const src = srcBytes(S25)!;
    expect(sha(src)).toBe(D25);
    expect(src.length).toBe(19294);
    expect(Buffer.from(text(), "utf8").equals(src)).toBe(true);
    expect(checkReleaseEntry(T25, text(), srcBytes).problems).toEqual([]);
  });
  it("rejects a whitespace change", () => {
    expect(checkReleaseEntry(T25, text().replace("\n", "\n "), srcBytes).problems.join("\n")).toMatch(/differs from its reviewed content|not byte-for-byte/);
    expect(checkReleaseEntry(T25, `${text()}\n`, srcBytes).problems.join("\n")).toMatch(/not byte-for-byte/);
  });
  it("rejects an added comment", () => {
    expect(checkReleaseEntry(T25, `-- note\n${text()}`, srcBytes).problems.join("\n")).toMatch(/not byte-for-byte/);
  });
  it("rejects a changed digest", () => {
    withEntry({ digest: "0".repeat(64) }, () => expect(checkReleaseEntry(T25, text(), srcBytes).problems.join("\n")).toMatch(/pinned digest does not match/));
    withEntry({ sha256: "0".repeat(64) }, () => expect(checkReleaseEntry(T25, text(), srcBytes).problems.join("\n")).toMatch(/differs from its reviewed content/));
  });
  it("rejects a changed byte count", () => {
    withEntry({ bytes: 19295 }, () => expect(checkReleaseEntry(T25, text(), srcBytes).problems.join("\n")).toMatch(/pinned byte count 19295/));
  });
  it("rejects a changed path", () => {
    withEntry({ source: "20261001120001_annual_commercial_term.sql" }, () => expect(checkReleaseEntry(T25, text(), srcBytes).problems.join("\n")).toMatch(/unknown migration/));
    expect(errs((d) => fs.renameSync(path.join(d, "supabase/migrations", S25), path.join(d, "supabase/migrations/20261001120001_annual_commercial_term.sql")))).toMatch(/0025_apply_20261001120000_annual_commercial_term applies an unknown migration/);
  }, 60_000);
  it("rejects removal from the journal", () => {
    expect(errs((d) => {
      const j = path.join(d, "drizzle/migrations/meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(j, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== T25);
      fs.writeFileSync(j, JSON.stringify(journal));
      fs.rmSync(path.join(d, `drizzle/migrations/${T25}.sql`));
    })).toMatch(/reviewed entry 0025_apply_20261001120000_annual_commercial_term is missing from the journal/);
  }, 60_000);
  it("rejects duplication", () => {
    expect(errs((d) => {
      const j = path.join(d, "drizzle/migrations/meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(j, "utf8"));
      const last = journal.entries[journal.entries.length - 1];
      journal.entries.push({ ...last, idx: journal.entries.length });
      fs.writeFileSync(j, JSON.stringify(journal));
    })).toMatch(/duplicate tags/);
  }, 60_000);
  it("rejects an unknown entry (no wildcard, no prefix rule)", () => {
    expect(checkReleaseEntry("0026_apply_20261001120000_annual_commercial_term", text(), srcBytes).problems.join("\n")).toMatch(/has not been reviewed/);
    expect(checkReleaseEntry("0025_apply_20261001120000_annual_commercial_term_v2", text(), srcBytes).problems.join("\n")).toMatch(/has not been reviewed/);
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => k.startsWith("0025"))).toEqual([T25]);
  });
});

describe("0029: H1 applied as its source minus its single final LF (release_verbatim_final_lf_removed)", () => {
  const src = () => srcBytes(S29)!;
  const mirror = () => fs.readFileSync(path.join(DZ, `${T29}.sql`));
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-0029-"));
    fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
    fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
    return dir;
  };
  const errs = (mutate: (dir: string) => void) => {
    const dir = copy();
    try { mutate(dir); return (checkMigrationAuthority(dir) as Result).errors.join("\n"); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const withMirror = (bytes: Buffer) => errs((dir) => fs.writeFileSync(path.join(dir, "drizzle/migrations", `${T29}.sql`), bytes));
  const withEntry = <T>(patch: Record<string, unknown>, fn: () => T): T => {
    const e = RELEASE_JOURNAL[T29] as Record<string, unknown>;
    const saved = { ...e };
    Object.assign(e, patch);
    try { return fn(); } finally { for (const k of Object.keys(e)) delete e[k]; Object.assign(e, saved); }
  };

  it("pins the canonical source and the submitted text separately", () => {
    expect(RELEASE_JOURNAL[T29]).toEqual({ kind: "release_verbatim_final_lf_removed", source: S29, bytes: 47457, digest: H1_CANONICAL,
      submittedBytes: 47456, sha256: H1_SUBMITTED });
    expect(SUBMISSION_FORMS[S29]).toEqual({ identical: { bytes: 47457, sha256: H1_CANONICAL }, finalLfRemoved: { bytes: 47456, sha256: H1_SUBMITTED } });
    expect([src().length, sha(src())]).toEqual([47457, H1_CANONICAL]);
    expect([mirror().length, sha(mirror())]).toEqual([47456, H1_SUBMITTED]);
  });
  it("the hosted mirror is exactly the source without its final byte, and nothing else (the source ends with two LFs)", () => {
    expect(src().subarray(-2).toString("hex")).toBe("0a0a");
    expect(mirror().equals(src().subarray(0, src().length - 1))).toBe(true);
    expect(submittedForm(S29, src(), mirror())).toBe("final_lf_removed");
    expect(checkReleaseEntry(T29, read(T29), srcBytes).problems).toEqual([]);
  });
  it("rejects the source byte for byte (not the registered form for 0029)", () => {
    expect(withMirror(src())).toMatch(/0029_apply_20261007100000[^\n]*(differs from its reviewed content|single final LF)/);
  }, 120_000);   // full-repository guard runs
  it("rejects removing BOTH trailing LFs", () => {
    const both = src().subarray(0, src().length - 2);
    expect(submittedForm(S29, src(), both)).toBeNull();
    expect(withMirror(both)).toMatch(/0029_apply_20261007100000/);
  }, 120_000);   // full-repository guard runs
  it("rejects every other change: an added LF or space, CRLF, a BOM, one changed byte, an added leading LF, collapsed whitespace", () => {
    const m = mirror();
    const variants: Record<string, Buffer> = {
      "extra LF": Buffer.concat([src(), Buffer.from("\n")]),
      "trailing space after the final LF": Buffer.concat([src(), Buffer.from(" ")]),
      "space instead of the final LF": Buffer.concat([m, Buffer.from(" ")]),
      "CRLF": Buffer.from(m.toString("utf8").replace(/\n/g, "\r\n"), "utf8"),
      "BOM": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), m]),
      "one changed byte": (() => { const b = Buffer.from(m); b[1000] = b[1000] === 0x41 ? 0x42 : 0x41; return b; })(),
      "added leading LF": Buffer.concat([Buffer.from([0x0a]), m]),
      "collapsed whitespace": Buffer.from(m.toString("utf8").replace(/ {2,}/g, " "), "utf8"),
    };
    for (const [label, bytes] of Object.entries(variants)) {
      expect(bytes.equals(m), label).toBe(false);
      expect(submittedForm(S29, src(), bytes), label).toBeNull();
      expect(withMirror(bytes), label).toMatch(/0029_apply_20261007100000/);
    }
  }, 120_000);   // full-repository guard runs
  it("rejects a changed canonical source (its pinned digest and registered form no longer match)", () => {
    expect(errs((dir) => fs.appendFileSync(path.join(dir, "supabase/migrations", S29), "-- note\n"))).toMatch(/0029_apply_20261007100000[^\n]*pinned digest/);
  }, 120_000);   // full-repository guard runs
  it("rejects a changed registration: another kind, another submitted hash, another byte count", () => {
    withEntry({ kind: "release_verbatim" }, () => expect(checkReleaseEntry(T29, read(T29), srcBytes).problems.join("\n")).toMatch(/byte-for-byte identical/));
    withEntry({ sha256: H1_CANONICAL }, () => expect(checkReleaseEntry(T29, read(T29), srcBytes).problems.join("\n")).toMatch(/differs from its reviewed content|not registered/));
    withEntry({ submittedBytes: 47455 }, () => expect(checkReleaseEntry(T29, read(T29), srcBytes).problems.join("\n")).toMatch(/expected 47455|not registered/));
  });
  it("without its reviewed entry, normalised parity cannot accept it (rule 9)", () => {
    const saved = RELEASE_JOURNAL[T29];
    delete (RELEASE_JOURNAL as Record<string, unknown>)[T29];
    try {
      expect((checkMigrationAuthority(ROOT) as Result).errors.join("\n")).toMatch(/0029_apply_20261007100000[^\n]*only through a reviewed RELEASE_JOURNAL entry/);
    } finally { (RELEASE_JOURNAL as Record<string, unknown>)[T29] = saved; }
  }, 120_000);   // full-repository guard runs
});

describe("S2: both submission forms registered ahead of application; applied as 0030 in the final-LF-removed form", () => {
  const src = () => srcBytes(S2)!;
  it("registers exactly the source and the source minus its single final LF", () => {
    expect(SUBMISSION_FORMS[S2]).toEqual({ identical: { bytes: 75683, sha256: S2_CANONICAL }, finalLfRemoved: { bytes: 75682, sha256: S2_SUBMITTED } });
    expect([src().length, sha(src())]).toEqual([75683, S2_CANONICAL]);
    expect(src().subarray(-2).toString("hex")).not.toBe("0a0a"); // exactly one trailing LF
    expect(sha(src().subarray(0, src().length - 1))).toBe(S2_SUBMITTED);
    expect(Object.keys(SUBMISSION_FORMS).sort()).toEqual([S29, S2, I1A_A1, I1A_A2, ...MILESTONE.map((m) => m.name), ...REPORTING.map((m) => m.name), ...READINESS.map((m) => m.name), ...SIGNOFF_POLICY.map((m) => m.name), ...COMMERCIAL.map((m) => m.name)].sort());
  });
  it("accepts only those two forms", () => {
    const s = src();
    expect(submittedForm(S2, s, s)).toBe("identical");
    expect(submittedForm(S2, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
    for (const bad of [s.subarray(0, s.length - 2), Buffer.concat([s, Buffer.from("\n")]), Buffer.concat([s.subarray(0, s.length - 1), Buffer.from(" ")]),
      Buffer.from(s.toString("utf8").replace(/\n/g, "\r\n"), "utf8"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), s])]) {
      expect(submittedForm(S2, s, bad)).toBeNull();
    }
  });
  it("0030 pins the canonical source and the submitted text separately; the mirror is the source minus its final byte", () => {
    const mirror = fs.readFileSync(path.join(DZ, `${T30}.sql`));
    expect(RELEASE_JOURNAL[T30]).toEqual({ kind: "release_verbatim_final_lf_removed", source: S2, bytes: 75683, digest: S2_CANONICAL,
      submittedBytes: 75682, sha256: S2_SUBMITTED });
    expect([mirror.length, sha(mirror)]).toEqual([75682, S2_SUBMITTED]);
    expect(mirror.equals(src().subarray(0, src().length - 1))).toBe(true);
    expect(checkReleaseEntry(T30, read(T30), srcBytes).problems).toEqual([]);
  });
  it("rejects the source byte for byte, both trailing bytes removed, CRLF or one changed byte in 0030", () => {
    const m = fs.readFileSync(path.join(DZ, `${T30}.sql`));
    const variants: Record<string, Buffer> = {
      "byte-identical source": src(),
      "last two bytes removed": src().subarray(0, src().length - 2),
      "CRLF": Buffer.from(m.toString("utf8").replace(/\n/g, "\r\n"), "utf8"),
      "one changed byte": (() => { const b = Buffer.from(m); b[2000] = b[2000] === 0x41 ? 0x42 : 0x41; return b; })(),
    };
    for (const [label, bytes] of Object.entries(variants)) {
      expect(checkReleaseEntry(T30, bytes.toString("utf8"), srcBytes).problems.length, label).toBeGreaterThan(0);
    }
  });
  it("without its reviewed entry, normalised parity cannot accept 0030 (rule 9)", () => {
    const saved = RELEASE_JOURNAL[T30];
    delete (RELEASE_JOURNAL as Record<string, unknown>)[T30];
    try {
      expect((checkMigrationAuthority(ROOT) as Result).errors.join("\n")).toMatch(/0030_apply_20261008100000[^\n]*only through a reviewed RELEASE_JOURNAL entry/);
    } finally { (RELEASE_JOURNAL as Record<string, unknown>)[T30] = saved; }
  }, 120_000);   // full-repository guard runs
});

describe("I1-A A1/A2: both submission forms registered ahead of application (nothing applied)", () => {
  const FORMS = [
    { name: I1A_A1, bytes: 49199, canonical: "27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509", submitted: "58d2df62f95aa99cd1e5a08aa9af6a58ed41b73d38d918a8fd6c5f8eb1bb374e" },
    { name: I1A_A2, bytes: 31976, canonical: "061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21", submitted: "f5aa525f5bf4ce1f5068c3ecf4f3c1002c3b0d6ab1948cafb6cf371ea8e69ba7" },
  ];
  for (const f of FORMS) {
    const src = () => srcBytes(f.name)!;
    it(`${f.name}: registers exactly the unchanged source and the source minus its single final LF`, () => {
      expect(SUBMISSION_FORMS[f.name]).toEqual({ identical: { bytes: f.bytes, sha256: f.canonical }, finalLfRemoved: { bytes: f.bytes - 1, sha256: f.submitted } });
      // The source in the repository is exactly the registered canonical form (unchanged since main a57d26a).
      expect([src().length, sha(src())]).toEqual([f.bytes, f.canonical]);
      expect(src()[src().length - 1]).toBe(0x0a);
      expect(src().subarray(-2).toString("hex")).not.toBe("0a0a"); // exactly one trailing LF
      expect(sha(src().subarray(0, src().length - 1))).toBe(f.submitted);
    });
    it(`${f.name}: accepts only those two forms; every other transformation is rejected`, () => {
      const s = src();
      expect(submittedForm(f.name, s, s)).toBe("identical");
      expect(submittedForm(f.name, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
      const text = s.toString("utf8");
      const rejected: [string, Buffer][] = [
        ["two final bytes removed", s.subarray(0, s.length - 2)],
        ["an extra final LF", Buffer.concat([s, Buffer.from("\n")])],
        ["final LF replaced by a space", Buffer.concat([s.subarray(0, s.length - 1), Buffer.from(" ")])],
        ["final LF replaced by CRLF", Buffer.concat([s.subarray(0, s.length - 1), Buffer.from("\r\n")])],
        ["CRLF line endings", Buffer.from(text.replace(/\n/g, "\r\n"), "utf8")],
        ["a UTF-8 byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), s])],
        ["leading whitespace", Buffer.concat([Buffer.from(" "), s])],
        ["trailing whitespace trimmed on every line", Buffer.from(text.replace(/[ \t]+\n/g, "\n"), "utf8")],
        ["comments stripped", Buffer.from(text.replace(/^--.*\n/gm, ""), "utf8")],
        ["first line removed", s.subarray(s.indexOf(0x0a) + 1)],
        ["one byte changed in the middle", (() => { const b = Buffer.from(s); b[Math.floor(b.length / 2)] ^= 0x01; return b; })()],
        ["empty text", Buffer.alloc(0)],
      ];
      for (const [label, bad] of rejected) {
        if (bad.equals(s) || bad.equals(s.subarray(0, s.length - 1))) continue; // a transformation that changed nothing is not a different text
        expect(submittedForm(f.name, s, bad), label).toBeNull();
      }
    });
    it(`${f.name}: a changed source no longer matches its registration (no form is accepted)`, () => {
      const changed = Buffer.concat([src(), Buffer.from("-- note\n")]);
      expect(submittedForm(f.name, changed, changed)).toBeNull();
      expect(submittedForm(f.name, changed, changed.subarray(0, changed.length - 1))).toBeNull();
    });
  }
  it("rule 9: without a reviewed RELEASE_JOURNAL entry, no Drizzle mirror is accepted — not even the registered forms, and never a normalised one", () => {
    for (const f of FORMS) {
      const s = src();
      const text = s.toString("utf8");
      const variants: [string, Buffer][] = [
        ["byte for byte", s], ["final LF removed", s.subarray(0, s.length - 1)],
        ["CRLF", Buffer.from(text.replace(/\n/g, "\r\n"), "utf8")], ["trailing whitespace trimmed", Buffer.from(text.replace(/\s+$/, ""), "utf8")],
      ];
      for (const [label, body] of variants) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-i1a-"));
        try {
          fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
          fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
          const j = JSON.parse(fs.readFileSync(path.join(dir, "drizzle/migrations/meta/_journal.json"), "utf8"));
          const idx = j.entries.length;
          const tag = `${String(idx).padStart(4, "0")}_mirror_${f.name.slice(0, 14)}`;
          j.entries.push({ ...j.entries[idx - 1], idx, tag });
          fs.writeFileSync(path.join(dir, "drizzle/migrations/meta/_journal.json"), JSON.stringify(j, null, 2));
          fs.writeFileSync(path.join(dir, `drizzle/migrations/${tag}.sql`), body);
          fs.copyFileSync(path.join(dir, `drizzle/migrations/meta/${String(idx - 1).padStart(4, "0")}_snapshot.json`), path.join(dir, `drizzle/migrations/meta/${String(idx).padStart(4, "0")}_snapshot.json`));
          const r = checkMigrationAuthority(dir) as Result;
          // A SECOND, unreviewed mirror is refused by name (the reviewed 0031/0032 entries do not extend to it).
          expect(r.ok, `${f.name} ${label}`).toBe(false);
          expect(r.mirrored.some((m) => m.tag === tag), `${f.name} ${label}`).toBe(false);
          expect(r.errors.some((e) => e.includes(tag)), `${f.name} ${label}`).toBe(true);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
      function src() { return srcBytes(f.name)!; }
    }
  }, 600_000);   // full-repository guard runs (eight)
  it("applied as 0031/0032 in the IDENTICAL form, each through exactly one reviewed release entry; nothing of I1-A pending", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(["20261024100000_fs_signoff_approval_policy.sql", "20261025100000_commercial_enquiries.sql", "20261026100000_retire_browser_adjusting_journal_writes.sql"]); // the statement sign-off policy (reporting r5), authored and pending hosted application // the reporting release is applied as 0040–0044 (hosted 41–45)
    expect(r.mirrored.filter((m) => m.source === I1A_A1 || m.source === I1A_A2)).toEqual([
      { tag: "0031_currency_registry_and_reporting_periods", source: I1A_A1, how: "release_verbatim" },
      { tag: "0032_layout_templates_and_confirmations", source: I1A_A2, how: "release_verbatim" },
    ]);
  }, 120_000);   // full-repository guard runs
});

describe("I1-A hosted application: 0031/0032 pinned to the canonical (identical) forms", () => {
  const CASES = [
    { tag: "0031_currency_registry_and_reporting_periods", source: I1A_A1, bytes: 49199, hash: "27970dfb5dcd84039d80424c0cb5c1bd8b6a672732967603b0b4a8a19a634509", when: 1791389044422 },
    { tag: "0032_layout_templates_and_confirmations", source: I1A_A2, bytes: 31976, hash: "061fcb0f5ea3bf6044bc5065cf393728f5ee7ead000beb33df6fd5ce78babe21", when: 1791389191617 },
  ];
  for (const c of CASES) {
    it(`${c.tag}: the mirror is the source byte for byte, the registered identical form, and its entry pins both`, () => {
      const mirror = fs.readFileSync(path.join(DZ, `${c.tag}.sql`));
      expect(RELEASE_JOURNAL[c.tag]).toEqual({ kind: "release_verbatim", source: c.source, bytes: c.bytes, digest: c.hash, sha256: c.hash });
      expect([mirror.length, sha(mirror)]).toEqual([c.bytes, c.hash]);
      expect(mirror.equals(srcBytes(c.source)!)).toBe(true);
      expect(submittedForm(c.source, srcBytes(c.source)!, mirror)).toBe("identical");
      expect(SUBMISSION_FORMS[c.source].identical).toEqual({ bytes: c.bytes, sha256: c.hash });
      expect(checkReleaseEntry(c.tag, read(c.tag), srcBytes).problems).toEqual([]);
    });
    it(`${c.tag}: the Drizzle journal and snapshot chain record it in order, after 0030`, () => {
      const j = JSON.parse(fs.readFileSync(path.join(DZ, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string; when: number }[] };
      const e = j.entries.find((x) => x.tag === c.tag)!;
      expect(e.when).toBe(c.when);
      const snap = (i: number) => JSON.parse(fs.readFileSync(path.join(DZ, `meta/${String(i).padStart(4, "0")}_snapshot.json`), "utf8")) as { id: string; prevId: string };
      expect(snap(e.idx).prevId).toBe(snap(e.idx - 1).id);
    });
    it(`${c.tag}: any other content is refused — a changed byte, the final-LF-removed form under this identical entry, or a changed source`, () => {
      const src = srcBytes(c.source)!;
      const flipped = Buffer.from(src); flipped[100] ^= 0x01;
      expect(checkReleaseEntry(c.tag, flipped.toString("utf8"), srcBytes).problems.join("\n")).toMatch(/differs from its reviewed content|not byte-for-byte/);
      expect(checkReleaseEntry(c.tag, src.subarray(0, src.length - 1).toString("utf8"), srcBytes).problems.join("\n")).toMatch(/differs from its reviewed content|expected/);
      const changedSource = (name: string) => (name === c.source ? Buffer.concat([src, Buffer.from("-- note\n")]) : srcBytes(name));
      expect(checkReleaseEntry(c.tag, read(c.tag), changedSource).problems.join("\n")).toMatch(/pinned digest/);
    });
  }
});

describe("the milestone's seven migrations: both submission forms registered ahead of application (nothing applied)", () => {
  it("registers exactly these seven, in release order, each as the final reviewed source and that source minus its single final LF", () => {
    const keys = Object.keys(SUBMISSION_FORMS);
    const after = REPORTING.length + READINESS.length + SIGNOFF_POLICY.length + COMMERCIAL.length;
    expect(keys.slice(-(MILESTONE.length + after), -after)).toEqual(MILESTONE.map((m) => m.name));
    for (const f of MILESTONE) {
      const src = srcBytes(f.name)!;
      // The two source forms, plus the self-checking wrapper's two forms (release/wrappers/; selfCheckingWrappers.test.ts).
      const w = fs.readFileSync(path.join(ROOT, "release/wrappers", f.name.replace(/\.sql$/, ".wrapper.sql")));
      expect(SUBMISSION_FORMS[f.name], f.name).toEqual({ identical: { bytes: f.bytes, sha256: f.canonical }, finalLfRemoved: { bytes: f.bytes - 1, sha256: f.submitted },
        wrapper: { bytes: w.length, sha256: sha(w) }, wrapperFinalLfRemoved: { bytes: w.length - 1, sha256: sha(w.subarray(0, w.length - 1)) } });
      // Recomputed here, independently of the registry: the bytes in the repository ARE the registered canonical form.
      expect([src.length, sha(src)], f.name).toEqual([f.bytes, f.canonical]);
      expect(src.includes(0x0d), `${f.name} has no CR byte`).toBe(false);
      expect(src.subarray(0, 3).toString("hex"), `${f.name} has no BOM`).not.toBe("efbbbf");
      expect(src[src.length - 1], f.name).toBe(0x0a);
      expect(src.subarray(-2).toString("hex"), f.name).not.toBe("0a0a"); // exactly one trailing LF
      expect(sha(src.subarray(0, src.length - 1)), f.name).toBe(f.submitted);
    }
  });
  it("accepts only those two forms of each; every other transformation is rejected", () => {
    for (const f of MILESTONE) {
      const s = srcBytes(f.name)!;
      expect(submittedForm(f.name, s, s)).toBe("identical");
      expect(submittedForm(f.name, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
      const text = s.toString("utf8");
      const rejected: [string, Buffer][] = [
        ["two final bytes removed", s.subarray(0, s.length - 2)],
        ["an extra final LF", Buffer.concat([s, Buffer.from("\n")])],
        ["final LF replaced by a space", Buffer.concat([s.subarray(0, s.length - 1), Buffer.from(" ")])],
        ["final LF replaced by CRLF", Buffer.concat([s.subarray(0, s.length - 1), Buffer.from("\r\n")])],
        ["CRLF line endings", Buffer.from(text.replace(/\n/g, "\r\n"), "utf8")],
        ["a UTF-8 byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), s])],
        ["leading whitespace", Buffer.concat([Buffer.from(" "), s])],
        ["trailing whitespace trimmed", Buffer.from(text.replace(/\s+$/, ""), "utf8")],
        ["comments stripped", Buffer.from(text.replace(/^--.*\n/gm, ""), "utf8")],
        ["one byte changed in the middle", (() => { const b = Buffer.from(s); b[Math.floor(b.length / 2)] ^= 0x01; return b; })()],
        ["another milestone source", srcBytes(MILESTONE[(MILESTONE.indexOf(f) + 1) % MILESTONE.length].name)!],
        ["empty text", Buffer.alloc(0)],
      ];
      for (const [label, bad] of rejected) {
        if (bad.equals(s) || bad.equals(s.subarray(0, s.length - 1))) continue; // a transformation that changed nothing is not a different text
        expect(submittedForm(f.name, s, bad), `${f.name}: ${label}`).toBeNull();
      }
      // A changed source no longer matches its registration: no form is accepted.
      const changed = Buffer.concat([s, Buffer.from("-- note\n")]);
      expect(submittedForm(f.name, changed, changed), f.name).toBeNull();
      expect(submittedForm(f.name, changed, changed.subarray(0, changed.length - 1)), f.name).toBeNull();
    }
  });
  it("rule 9: without reviewed RELEASE_JOURNAL entries, no Drizzle mirror of any of the seven is accepted — not even a registered form", () => {
    for (const form of ["identical", "final LF removed"] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-milestone-"));
      try {
        fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
        fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
        const jf = path.join(dir, "drizzle/migrations/meta/_journal.json");
        const j = JSON.parse(fs.readFileSync(jf, "utf8"));
        const tags: string[] = [];
        for (const f of MILESTONE) {
          const idx = j.entries.length;
          const tag = `${String(idx).padStart(4, "0")}_mirror_${f.name.slice(0, 14)}`;
          j.entries.push({ ...j.entries[idx - 1], idx, tag });
          const s = srcBytes(f.name)!;
          fs.writeFileSync(path.join(dir, `drizzle/migrations/${tag}.sql`), form === "identical" ? s : s.subarray(0, s.length - 1));
          fs.copyFileSync(path.join(dir, `drizzle/migrations/meta/${String(idx - 1).padStart(4, "0")}_snapshot.json`), path.join(dir, `drizzle/migrations/meta/${String(idx).padStart(4, "0")}_snapshot.json`));
          tags.push(tag);
        }
        fs.writeFileSync(jf, JSON.stringify(j, null, 2));
        const r = checkMigrationAuthority(dir) as Result;
        expect(r.ok, form).toBe(false);
        for (const tag of tags) {
          expect(r.mirrored.some((m) => m.tag === tag), `${form} ${tag}`).toBe(false);
          expect(r.errors.some((e) => e.includes(tag) && e.includes("only through a reviewed RELEASE_JOURNAL entry")), `${form} ${tag}`).toBe(true);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }, 300_000);   // full-repository guard runs (two)
  it("applied as 0033–0039 through their registered self-checking wrappers, in order; nothing pending", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(["20261024100000_fs_signoff_approval_policy.sql", "20261025100000_commercial_enquiries.sql", "20261026100000_retire_browser_adjusting_journal_writes.sql"]); // the statement sign-off policy (reporting r5), authored and pending hosted application // the reporting release is applied as 0040–0044 (hosted 41–45)
    const tags = ["0033_i1b_w1_two_period_shared_source", "0034_i1b_w2_layout_assist_controls", "0035_i1b_w3_close_review_timeline",
      "0036_i1b_w4_close_review_findings", "0037_i1b_w5_close_review_adjustments", "0038_i1b_w6_fs_reporting_input",
      "0039_i1b_w7_signoff_completion_requirements"];
    expect(r.mirrored.filter((m) => MILESTONE.some((x) => x.name === m.source))).toEqual(
      MILESTONE.map((m, i) => ({ tag: tags[i], source: m.name, how: "release_self_checking_wrapper" })));
  }, 120_000);
});

describe("the reporting release: all four forms of each source registered ahead of application (nothing applied)", () => {
  it("registers exactly the five, then the readiness correction last, in release order; each form recomputed here from the repository bytes", () => {
    const keys = Object.keys(SUBMISSION_FORMS);
    const tail = READINESS.length + SIGNOFF_POLICY.length + COMMERCIAL.length;
    expect(keys.slice(-(REPORTING.length + tail), -tail)).toEqual(REPORTING.map((m) => m.name));
    expect(keys.slice(-tail)).toEqual([...READINESS, ...SIGNOFF_POLICY, ...COMMERCIAL].map((m) => m.name));
    for (const { name } of [...REPORTING, ...READINESS, ...SIGNOFF_POLICY, ...COMMERCIAL]) {
      const src = fs.readFileSync(path.join(ROOT, "supabase/migrations", name));
      const w = fs.readFileSync(path.join(ROOT, "release/wrappers", name.replace(/\.sql$/, ".wrapper.sql")));
      expect(src.includes(0x0d), `${name} has no CR byte`).toBe(false);
      expect(src.subarray(0, 3).toString("hex"), `${name} has no BOM`).not.toBe("efbbbf");
      expect(src[src.length - 1], `${name} ends in an LF`).toBe(0x0a);
      expect(src[src.length - 2], `${name} ends in exactly one LF`).not.toBe(0x0a);
      expect((SUBMISSION_FORMS as Record<string, unknown>)[name], name).toEqual({
        identical: { bytes: src.length, sha256: sha(src) }, finalLfRemoved: { bytes: src.length - 1, sha256: sha(src.subarray(0, src.length - 1)) },
        wrapper: { bytes: w.length, sha256: sha(w) }, wrapperFinalLfRemoved: { bytes: w.length - 1, sha256: sha(w.subarray(0, w.length - 1)) } });
    }
  });
});
