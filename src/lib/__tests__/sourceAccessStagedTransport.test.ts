import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANY_PRESENT, BATCHES, BOOTSTRAP_PREDECESSOR, INSTALLED, NEW_FUNCTIONS, PRESERVED_TABLES, PREREQUISITES, SOURCE_COMMIT,
  artifactBytes, checkTransportMirror, renderAll, renderApply, renderBootstrap, renderStage, transportForms, REGISTERED_TRANSPORT_FORMS,
} from "../../../scripts/release/sourceAccessStagedTransport.mjs";
import {
  HOSTED_ENTRY_97_VARIANT, REGISTERED_TRANSPORT_FORMS as STATEMENT_FORMS, renderApply as renderStatementApply, renderHostedEntry97Variant,
} from "../../../scripts/release/ipsasStatementReviewStagedTransport.mjs";
import { RELEASE_JOURNAL } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = process.cwd();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261211100000_source_access_authority_repairs.sql"));

describe("source-access exact-byte staged transport", () => {
  it("pins the authored migration bytes and hosted id 97 as the only accepted journal head, in every form it was recorded", () => {
    expect(SOURCE_COMMIT).toBe("9e5cb9121ec9b713f0206b0dfe6b002c6cfd38aa");
    expect(BATCHES).toHaveLength(1);
    expect(BATCHES[0].artifacts.source.bytes).toBe(25437);
    expect(BATCHES[0].artifacts.source.sha256).toBe("be582111440335aefc7da9c4cd7454f94e260f79b0e9098233d5e36c1736b344");
    expect(artifactBytes(0, "source").equals(migration)).toBe(true);
    expect(BOOTSTRAP_PREDECESSOR.id).toBe(97);
    expect(BOOTSTRAP_PREDECESSOR.tag).toBe("0096_ipsas_3_statement_review_staged_apply");
    const reviewed = renderStatementApply(0), variant = renderHostedEntry97Variant();
    expect([...BOOTSTRAP_PREDECESSOR.hashes]).toEqual([sha(reviewed), sha(`${reviewed}\n`), sha(variant), sha(`${variant}\n`)]);
    expect(BOOTSTRAP_PREDECESSOR.hashes[0]).toBe(STATEMENT_FORMS.ipsas_3_statement_review_staged_apply);
    expect(BOOTSTRAP_PREDECESSOR.hashes[2]).toBe(HOSTED_ENTRY_97_VARIANT.sha256);
    // the hash the hosted journal actually recorded for id 97
    expect(BOOTSTRAP_PREDECESSOR.hashes[3]).toBe(HOSTED_ENTRY_97_VARIANT.journalSha256);
    expect(BOOTSTRAP_PREDECESSOR.hashes[3]).toBe("023484a1f9ad9ce298b03ec3f15d76c8df2dec2a9b8675749ef334ab3f8e7c17");
  });

  it("renders the three committed files exactly, and pins both executable transport forms", () => {
    const all = renderAll();
    expect(Object.keys(all).sort()).toEqual([
      "release/staged-transport-source-access/00_source_access_staged_transport.sql",
      "release/staged-transport-source-access/10_source_access_1_staged_apply.sql",
      "release/staged-transport-source-access/stage/1_source-access-1.source.sql",
    ]);
    for (const [rel, text] of Object.entries(all)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    for (const f of transportForms()) expect(f.hashes[0]).toBe((REGISTERED_TRANSPORT_FORMS as Record<string, string>)[f.name]);
  });

  it("stages the exact source text as inert data with a checked non-colliding delimiter", () => {
    const sql = renderStage(0, "source");
    expect(sql).toContain(migration.toString("utf8"));
    expect(sql.startsWith("INSERT INTO cfoclose_source_access_release.staged_artifacts")).toBe(true);
    expect(sql).not.toContain("EXECUTE v_source");
  });

  it("keeps the bootstrap private and apart from the IPSAS transports: its own schema, lock, error codes and tags", () => {
    const b = renderBootstrap();
    expect(b).toContain("CREATE SCHEMA cfoclose_source_access_release");
    expect(b).toContain("ENABLE ROW LEVEL SECURITY");
    expect(b).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(b).not.toMatch(/ALL FUNCTIONS IN SCHEMA public|CREATE POLICY|SECURITY DEFINER/);
    expect(b).not.toMatch(/cfoclose_ipsas_(grants_|statement_)?release\b/);
    expect(b).not.toContain("IPSAS_");
    expect(b).toContain("cfoclose_source_access_release_transport");
  });

  it("orders its checks: exact journal head, prerequisites, uncertain state, rehash, execute, postconditions, privileges, baseline, consumption", () => {
    const s = renderApply(0);
    expect(s).toContain("v_pred_id <> 98");
    const at = (needle: string) => { const i = s.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at("WRONG_PREDECESSOR")).toBeLessThan(at("PREREQUISITE_MISSING"));
    expect(at("PREREQUISITE_MISSING")).toBeLessThan(at("UNCERTAIN_STATE"));
    expect(at("UNCERTAIN_STATE")).toBeLessThan(at("encode(sha256(convert_to(s.body, 'UTF8'))"));
    expect(at("encode(sha256(convert_to(s.body, 'UTF8'))")).toBeLessThan(at("EXECUTE v_source"));
    expect(at("EXECUTE v_source")).toBeLessThan(at("SOURCE_ACCESS_TRANSPORT_POSTCONDITION"));
    expect(at("SOURCE_ACCESS_TRANSPORT_POSTCONDITION")).toBeLessThan(at("SOURCE_ACCESS_TRANSPORT_PRIVILEGE_POSTCONDITION"));
    expect(at("SOURCE_ACCESS_TRANSPORT_PRIVILEGE_POSTCONDITION")).toBeLessThan(at("SOURCE_ACCESS_TRANSPORT_BASELINE_CHANGED"));
    expect(at("SOURCE_ACCESS_TRANSPORT_BASELINE_CHANGED")).toBeLessThan(at("SET consumed_at"));
    expect(s).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK);$/m);
    expect(s).toContain("IN SHARE MODE;");
  });

  it("pins the path for the source and restores the ORIGINAL path at session level, because the source sets its own search_path", () => {
    expect(migration.toString("utf8")).toContain("SET search_path TO public, pg_catalog;");
    const s = renderApply(0);
    const at = (needle: string) => { const i = s.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at("set_config('search_path', 'pg_catalog, public', true)")).toBeLessThan(at("EXECUTE v_source"));
    expect(at("EXECUTE v_source")).toBeLessThan(at("set_config('search_path', v_search_path, false)"));
    expect(at("set_config('search_path', v_search_path, false)")).toBeLessThan(at("SOURCE_ACCESS_TRANSPORT_POSTCONDITION"));
    // a transaction-local restore would let the source's SET outlive the commit on the migrator's connection (proved by the database proof)
    expect(s).not.toContain("set_config('search_path', v_search_path, true)");
  });

  it("refuses when ANY object the source creates already exists, and names the prerequisites and every privilege it must leave", () => {
    const s = renderApply(0);
    expect(ANY_PRESENT).toContain(" OR ");
    expect(ANY_PRESENT).not.toContain(" AND ");
    expect(s).toContain(`IF ${ANY_PRESENT} THEN`);
    expect(INSTALLED).toContain(" AND ");
    for (const f of NEW_FUNCTIONS) { expect(ANY_PRESENT).toContain(f); expect(INSTALLED).toContain(f); }
    expect(INSTALLED).toContain("trg_firm_members_revoke_workspace_grants");
    for (const t of PREREQUISITES.tables) expect(s).toContain(`public.${t}`);
    for (const f of PREREQUISITES.functions) expect(s).toContain(`public.${f}`);
    expect(JSON.stringify(PREREQUISITES)).toContain("workspace_authority_basis(uuid,uuid,text)");
    expect(JSON.stringify(PREREQUISITES)).toContain("_plan_write_lock(uuid)");
    expect(s).toContain("has_table_privilege(v_role, 'public.trial_balance_source_download_events', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')");
    expect(s).toContain("SOURCE_ACCESS_TRANSPORT_PRIVILEGE_POSTCONDITION");
  });

  it("preserves the earlier records and, because it adds a trigger to firm_members and acts on grants, the grants, grant events and memberships", () => {
    expect(PRESERVED_TABLES).toEqual(expect.arrayContaining(["ipsas_presentation_revisions", "ipsas_prep_revisions", "ipsas_grant_revisions", "fs_publication_bindings", "reporting_pack_issuances",
      "financial_statements_rollout_state", "ai_assistant_settings", "commercial_platform_state", "workspace_capability_grants", "workspace_capability_grant_events", "firm_members"]));
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

  it("does not edit the statement-review transport: its committed files hash to its registered forms", () => {
    const dir = path.join(ROOT, "release/staged-transport-ipsas-statement-review");
    const hash = (f: string) => createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
    expect(hash("00_ipsas_statement_review_staged_transport.sql")).toBe(STATEMENT_FORMS.ipsas_statement_review_staged_transport);
    expect(hash("10_ipsas_3_statement_review_staged_apply.sql")).toBe(STATEMENT_FORMS.ipsas_3_statement_review_staged_apply);
  });

  it("claims nothing as hosted-applied: no Drizzle mirror, no journal entry and no release-journal registration exist for it", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.some((e) => /source_access/i.test(e.tag))).toBe(false);
    expect(Math.max(...journal.entries.map((e) => Number(e.tag.slice(0, 4))))).toBe(96);
    expect(fs.readdirSync(path.join(ROOT, "drizzle/migrations")).some((f) => /source_access/i.test(f))).toBe(false);
    expect(Object.keys(RELEASE_JOURNAL).some((k) => /source_access/i.test(k))).toBe(false);
  });
});
