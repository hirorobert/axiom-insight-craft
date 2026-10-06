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
import { RELEASE_JOURNAL, checkApplyWrapperStructure, checkReleaseEntry, checkReleaseInfrastructure } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.join(__dirname, "../../..");
const DZ = path.join(ROOT, "drizzle/migrations");
const SRC = path.join(ROOT, "supabase/migrations");
const read = (tag: string) => fs.readFileSync(path.join(DZ, `${tag}.sql`), "utf8");
const srcBytes = (name: string) => (fs.existsSync(path.join(SRC, name)) ? fs.readFileSync(path.join(SRC, name)) : null);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: Array<{ tag: string; source: string; how: string }>; releaseApplied: Array<{ tag: string; source: string }> };

const T25 = "0025_apply_20261001120000_annual_commercial_term";
const S25 = "20261001120000_annual_commercial_term.sql";
const D25 = "621f55c35bdadf3c7baa8c259056712dbfbbedbd25417a2a5d6a92fd4a1d38fa";

describe("the reviewed release journal", () => {
  it("every entry 0013–0022 and 0024 validates: exact content, exact template, digest = the source file in this repository", () => {
    for (const tag of Object.keys(RELEASE_JOURNAL)) expect(checkReleaseEntry(tag, read(tag), srcBytes).problems, tag).toEqual([]);
    expect(Object.keys(RELEASE_JOURNAL)).toHaveLength(13);
  });
  it("pins the prerequisite and 140000 digests exactly as authorised", () => {
    expect(RELEASE_JOURNAL["0016_pr34_apply_prereq_20260915100000"]).toMatchObject({ digest: "e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712", bytes: 18569 });
    expect(sha(srcBytes("20260915100000_financial_statement_documents.sql")!)).toBe("e996b26738bce27dea1a7154400ec8828a333e2e0ae99eac91632f93dd0a6712");
    expect(RELEASE_JOURNAL["0020_pr34_apply_20260925140000"].digest).toBe("c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a");
    for (const [tag, e] of Object.entries(RELEASE_JOURNAL)) if ("source" in e && e.source) expect(sha(srcBytes(e.source)!), tag).toBe(e.digest);
  });
  it("the guard accepts the repository: the wrappers apply 100000–150000, the processing correction 20260926160000 , the removal migration 20260927100000 (0024) and (out of order on purpose) the prerequisite; only 20261004100000, 20261005100000 and 20261006100000 are pending", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    // 0022 applied the processing correction (f21a58f); 0024 the removal migration (main 0d2a09e); 0025 the annual term
    // (release_verbatim); 0026 the withheld-service grant refusal (release_verbatim). Authored and not yet applied: 20261004100000 (reconciliation server authority) and
    // 20261005100000 (evidence ingestion authority).
    // 20261006100000 (S1 mapping and processing authority) is authored and pending hosted application likewise.
    expect(r.pending).toEqual(["20261004100000_reconciliation_server_authority.sql", "20261005100000_safisha_ingestion_authority.sql", "20261006100000_mapping_and_processing_authority.sql"]);
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
