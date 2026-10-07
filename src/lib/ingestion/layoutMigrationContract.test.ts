/**
 * 20261010100000_layout_templates_and_confirmations.sql — static contract. The behaviour is proven on real PostgreSQL by
 * scripts/db-proof/layoutAuthority.mjs; this pins what the text itself must and must not do.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8");
const A2 = read("20261010100000_layout_templates_and_confirmations.sql");
const S2 = read("20261008100000_processing_attempt_authority.sql");
const fn = (sql: string, name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf("\n$$;\n", start) + 5);
};
/** Lines of `next` that are not in `prev`, and lines of `prev` missing from `next`. */
function lineDiff(prev: string, next: string) {
  const a = prev.split("\n");
  const b = next.split("\n");
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

describe("layout migration — S2 functions re-created with only the marked lines changed", () => {
  it("tb_begin_attempt: S2's definition plus the generation-4 refusal for an upload with a confirmation", () => {
    const d = lineDiff(fn(S2, "tb_begin_attempt"), fn(A2, "tb_begin_attempt"));
    expect(d.removed).toEqual([]);
    expect(d.added).toEqual([
      "  -- A2: an engine generation below 4 cannot read layout confirmations, so it never processes an upload that has one",
      "  -- (refused here, before anything is written).",
      "  IF coalesce(p_engine_generation, 0) < 4 AND EXISTS (SELECT 1 FROM public.layout_confirmations lc WHERE lc.upload_id = p_upload_id) THEN",
      "    RETURN jsonb_build_object('outcome', 'refused', 'code', 'LAYOUT_REQUIRES_CURRENT_ENGINE');",
    ]);
  });
  it("tb_snapshot_dependencies: S2's definition with the layout key accepted for the run's own upload only", () => {
    const d = lineDiff(fn(S2, "tb_snapshot_dependencies"), fn(A2, "tb_snapshot_dependencies"));
    expect(d.removed).toEqual(["                 OR (e->>'key') !~ '^(code:.+|name:.*|#framework|#currency|#dictionary)$') THEN"]);
    expect(d.added.join("\n")).toContain("#layout_confirmation:[0-9a-f-]{36}");
    expect(d.added.join("\n")).toContain("substring(e->>'key' FROM 22) <> v_run.source_record_id::text");
    expect("#layout_confirmation:".length + 1).toBe(22);
  });
});

describe("layout migration — append-only records, server-only writers, no destructive statement", () => {
  const code = A2.replace(/--[^\n]*/g, "");
  it("refuses to run over existing layout tables (preflight) and drops nothing", () => {
    expect(A2).toContain("PREFLIGHT_REFUSED: layout tables already exist");
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|FUNCTION|POLICY|TRIGGER|INDEX|TYPE)\b/i);
    const topLevel = code.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "");
    expect(topLevel).not.toMatch(/^\s*(DELETE\s+FROM|TRUNCATE\s|UPDATE\s|INSERT\s+INTO|ALTER\s+TABLE\s+public\.(?!layout_))/im);
  });
  it("both tables are append-only for every role (row and TRUNCATE triggers) and inserted only under the writer marker", () => {
    for (const t of ["layout_templates", "layout_confirmations"]) {
      expect(A2).toMatch(new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON public\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION public\\.layout_records_fence\\(\\)`));
      expect(A2).toMatch(new RegExp(`BEFORE TRUNCATE ON public\\.${t}\\s+FOR EACH STATEMENT EXECUTE FUNCTION public\\.layout_records_fence\\(\\)`));
    }
    expect(A2).toContain("current_setting('axiom.layout_writer', true), '') <> txid_current()::text");
  });
  it("clients read through workspace access only; the writers are granted to the service role alone", () => {
    expect(A2).toContain("REVOKE ALL ON TABLE public.layout_templates, public.layout_confirmations FROM PUBLIC, anon, authenticated;");
    expect(A2).toContain("GRANT SELECT ON TABLE public.layout_templates, public.layout_confirmations TO authenticated, service_role;");
    for (const sig of ["layout_save_template(uuid, uuid, uuid, integer, text, jsonb, text)", "layout_record_confirmation(uuid, uuid, integer, text, jsonb, text, jsonb, text, uuid, jsonb, jsonb)"]) {
      expect(A2).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(A2).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
    expect((A2.match(/USING \(public\.can_access_workspace\(company_id\)\)/g) ?? []).length).toBe(2);
  });
  it("the actor is derived from the user (processing authority + prepare_close), never taken from the caller", () => {
    expect(A2).toContain("public.workspace_capability_allowed(p_company_id, p_user_id, 'prepare_close')");
    expect(A2).toContain("public.tbu_resolve_processing_actor(p_user_id, p_company_id)");
    for (const name of ["layout_save_template", "layout_record_confirmation"]) expect(fn(A2, name)).not.toMatch(/p_firm_member_id|p_actor_type/);
  });
  it("a template has no file identity; a confirmation binds the source hash and the resolved hash, and keeps every row", () => {
    const templates = A2.slice(A2.indexOf("CREATE TABLE public.layout_templates"), A2.indexOf("CREATE INDEX idx_lt_company"));
    expect(templates).not.toMatch(/^\s+(source_file_hash|upload_id)\s/m);
    expect(templates).toContain("NOT (profile ? 'sourceFileHash')");
    expect(A2).toContain("rows_read = jsonb_array_length(row_dispositions)");
    expect(A2).toContain("resolved_profile->>'profileSha256' = profile_sha256");
    expect(A2).toContain("PERFORM public._tb_bump_dependency(v_row.company_id::text, '#layout_confirmation:' || p_upload_id::text);");
  });
});
