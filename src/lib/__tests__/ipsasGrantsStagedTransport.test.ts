import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BATCHES, BOOTSTRAP_PREDECESSOR, PRESERVED_TABLES, PREREQUISITES, RPCS, SOURCE_COMMIT, artifactBytes, checkTransportMirror, renderAll, renderApply, renderBootstrap, renderStage, transportForms, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/ipsasGrantsStagedTransport.mjs";
import { REGISTERED_TRANSPORT_FORMS as PREPARATION_FORMS } from "../../../scripts/release/ipsasStagedTransport.mjs";
import { RELEASE_JOURNAL } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = process.cwd();
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261208100000_ipsas_grants.sql"));

describe("IPSAS grants exact-byte staged transport", () => {
  it("pins the authored migration bytes and the IPSAS preparation transport's last entry as the only accepted journal head", () => {
    expect(SOURCE_COMMIT).toBe("2165066cd6d2dda2d3faca19d4b41a1fbd524817");
    expect(BATCHES).toHaveLength(1);
    expect(BATCHES[0].artifacts.source.bytes).toBe(32017);
    expect(artifactBytes(0, "source").equals(migration)).toBe(true);
    expect(BOOTSTRAP_PREDECESSOR.id).toBe(93);
    expect(BOOTSTRAP_PREDECESSOR.tag).toBe("0092_ipsas_1_preparation_staged_apply");
    expect(BOOTSTRAP_PREDECESSOR.hashes[0]).toBe(PREPARATION_FORMS.ipsas_1_preparation_staged_apply);
    expect(BOOTSTRAP_PREDECESSOR.hashes).toHaveLength(2);
  });
  it("renders the three committed files exactly, and pins both executable transport forms", () => {
    const all = renderAll();
    expect(Object.keys(all).sort()).toEqual(["release/staged-transport-ipsas-grants/00_ipsas_grants_staged_transport.sql", "release/staged-transport-ipsas-grants/10_ipsas_2_grants_staged_apply.sql", "release/staged-transport-ipsas-grants/stage/1_ipsas-2-grants.source.sql"]);
    for (const [rel, text] of Object.entries(all)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    for (const f of transportForms()) expect(f.hashes[0]).toBe((REGISTERED_TRANSPORT_FORMS as Record<string, string>)[f.name]);
  });
  it("stages the exact source text as inert data with a checked non-colliding delimiter", () => {
    const sql = renderStage(0, "source");
    expect(sql).toContain(migration.toString("utf8"));
    expect(sql.startsWith("INSERT INTO cfoclose_ipsas_grants_release.staged_artifacts")).toBe(true);
    expect(sql).not.toContain("EXECUTE v_source");
  });
  it("keeps the bootstrap private and apart from the preparation transport: its own schema, lock, error codes and tags", () => {
    const b = renderBootstrap();
    expect(b).toContain("CREATE SCHEMA cfoclose_ipsas_grants_release");
    expect(b).toContain("ENABLE ROW LEVEL SECURITY");
    expect(b).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(b).not.toMatch(/ALL FUNCTIONS IN SCHEMA public|CREATE POLICY|SECURITY DEFINER|cfoclose_eqp_release/);
    expect(b).not.toMatch(/cfoclose_ipsas_release\b/);
    expect(b).not.toContain("IPSAS_TRANSPORT_");
    expect(b).toContain("cfoclose_ipsas_grants_release_transport");
  });
  it("orders its checks: exact journal head, prerequisites, rehash, then execute, then privilege postconditions, baseline and consumption", () => {
    const s = renderApply(0);
    expect(s).toContain("v_pred_id <> 94");
    const at = (needle: string) => { const i = s.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at("WRONG_PREDECESSOR")).toBeLessThan(at("PREREQUISITE_MISSING"));
    expect(at("PREREQUISITE_MISSING")).toBeLessThan(at("encode(sha256(convert_to(s.body, 'UTF8'))"));
    expect(at("encode(sha256(convert_to(s.body, 'UTF8'))")).toBeLessThan(at("EXECUTE v_source"));
    expect(at("EXECUTE v_source")).toBeLessThan(at("IPSAS_GRANTS_TRANSPORT_POSTCONDITION"));
    expect(at("IPSAS_GRANTS_TRANSPORT_POSTCONDITION")).toBeLessThan(at("IPSAS_GRANTS_TRANSPORT_PRIVILEGE_POSTCONDITION"));
    expect(at("IPSAS_GRANTS_TRANSPORT_PRIVILEGE_POSTCONDITION")).toBeLessThan(at("IPSAS_GRANTS_TRANSPORT_BASELINE_CHANGED"));
    expect(at("IPSAS_GRANTS_TRANSPORT_BASELINE_CHANGED")).toBeLessThan(at("SET consumed_at"));
    // the source executes under a pinned search_path, restored straight after (unqualified names bind through it)
    expect(at("set_config('search_path', 'pg_catalog, public', true)")).toBeLessThan(at("EXECUTE v_source"));
    expect(at("EXECUTE v_source")).toBeLessThan(at("set_config('search_path', v_search_path, true)"));
    expect(at("set_config('search_path', v_search_path, true)")).toBeLessThan(at("IPSAS_GRANTS_TRANSPORT_POSTCONDITION"));
    expect(s).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK);$/m);
    expect(s).toContain("IN SHARE MODE;");
  });
  it("depends on the IPSAS preparation objects, names all three RPCs, and refuses any API-role privilege on the helpers", () => {
    const s = renderApply(0);
    for (const t of ["ipsas_prep_revisions", "ipsas_confirmations", "_ipsas_refusal(uuid,uuid,text)", "ipsas_prep_context(uuid,integer)"]) expect(JSON.stringify(PREREQUISITES), t).toContain(t);
    for (const t of PREREQUISITES.tables) expect(s).toContain(`public.${t}`);
    for (const f of PREREQUISITES.functions) expect(s).toContain(`public.${f}`);
    for (const f of RPCS) expect(s).toContain(`public.${f}`);
    expect(s).toContain("LIKE '\\_ipsas\\_%'");
  });
  it("preserves the IPSAS preparation history, the equipment and reporting records and actual runtime settings, and writes none of them", () => {
    expect(PRESERVED_TABLES).toEqual(expect.arrayContaining(["ipsas_prep_revisions", "ipsas_confirmations", "fs_schedule_submissions", "fs_disclosure_texts", "fs_publication_bindings", "reporting_pack_issuances", "financial_statements_rollout_state", "ai_assistant_settings", "commercial_platform_state", "fs_equipment_answers"]));
    const s = renderApply(0);
    for (const t of PRESERVED_TABLES) expect(s).toContain(`public.${t} t`);
    expect(s).not.toMatch(/UPDATE public\.|PAYMENTS_DISABLED|kill_switch\s*=\s*true/);
  });
  it("accepts a mirror only as the exact registered text (or with the migrator's one final LF)", () => {
    for (const f of transportForms()) {
      const tag = `9999_${f.name}`;
      expect(checkTransportMirror(tag, f.text).problems).toEqual([]);
      expect(checkTransportMirror(tag, `${f.text}\n`).problems).toEqual([]);
      expect(checkTransportMirror(tag, `${f.text}\n\n`).problems.length).toBeGreaterThan(0);
      expect(checkTransportMirror(tag, `${f.text} `).problems.length).toBeGreaterThan(0);
      expect(checkTransportMirror("9999_unregistered", f.text).problems.length).toBeGreaterThan(0);
    }
  });
  it("does not edit the preparation transport: its committed files hash to its registered forms", () => {
    const dir = path.join(ROOT, "release/staged-transport-ipsas");
    const hash = (f: string) => createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
    expect(hash("00_ipsas_staged_transport.sql")).toBe(PREPARATION_FORMS.ipsas_staged_transport);
    expect(hash("10_ipsas_1_preparation_staged_apply.sql")).toBe(PREPARATION_FORMS.ipsas_1_preparation_staged_apply);
  });
  it("claims nothing as hosted-applied: no Drizzle mirror, no journal entry and no release-journal registration exist for it", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => /ipsas/i.test(e.tag))).toBe(false);
    expect(Math.max(...journal.entries.map((e) => Number(e.tag.slice(0, 4))))).toBe(90);
    expect(fs.readdirSync(path.join(ROOT, "drizzle/migrations")).some((f) => /ipsas/i.test(f))).toBe(false);
    expect(Object.keys(RELEASE_JOURNAL).some((k) => /ipsas/i.test(k))).toBe(false);
  });
});
