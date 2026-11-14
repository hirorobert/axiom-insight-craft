import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BATCHES, BOOTSTRAP_PREDECESSOR, MAX_BODY_BYTES, PREDECESSOR_SOURCE, PRESERVED_TABLES, REGISTERED_TRANSPORT_FORMS, SCHEMA, SOURCE_COMMIT,
  artifactBytes, checkTransportMirror, renderAll, renderApply, renderBootstrap, renderStage, transportForms,
} from "../../../scripts/release/rfrStagedTransport.mjs";
import { PRESERVED_TABLES as SOURCE_ACCESS_PRESERVED, REGISTERED_TRANSPORT_FORMS as SOURCE_ACCESS_FORMS } from "../../../scripts/release/sourceAccessStagedTransport.mjs";
import { RELEASE_JOURNAL } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = process.cwd();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const migration = (name: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", name));
const SOURCES = [
  ["20261223100000_first_period_governed_review_standalone.sql", 73411, "e7542b78ebfad1cf359ea77ea83307cabe63d3b49d7a0b937f73c4152040e3c4"],
  ["20261224100000_contra_account_designation.sql", 38243, "4539d9eff542352f370f234819cf792170a832ba66ca9f6621468fb80ead35ff"],
  ["20261225100000_ready_for_reporting_pilot.sql", 56101, "5374bb124399bfd37ddc17617a14af125b1c93c15dbf476c82a4f38a66d824d5"],
  ["20261226100000_issued_comparative_schedules.sql", 34059, "8ff7c5f97b8a1222230ab9ceb5aad02850d68b62c2b9f970df8dac3ceef37320"],
] as const;

describe("Ready-for-Reporting exact-byte staged transport (D7–D10)", () => {
  it("pins the four authored migration bytes, in release order, and hosted id 106 (D12's mirror) as the only accepted journal head", () => {
    expect(SOURCE_COMMIT).toBe("122069b46f201b6714ed50d6d2e00380dd41d170");
    expect(BATCHES.map((b) => b.source)).toEqual(SOURCES.map((s) => s[0]));
    BATCHES.forEach((b, i) => {
      expect(b.artifacts.source.bytes).toBe(SOURCES[i][1]);
      expect(b.artifacts.source.sha256).toBe(SOURCES[i][2]);
      expect(artifactBytes(i, "source").equals(migration(SOURCES[i][0]))).toBe(true);
      expect(b.batch).toBe(`rfr-${i + 1}`); expect(b.name).toBe(`rfr_${i + 1}_staged_apply`);
    });
    expect(MAX_BODY_BYTES).toBe(73411);
    expect(BOOTSTRAP_PREDECESSOR.id).toBe(106);
    expect(BOOTSTRAP_PREDECESSOR.tag).toBe("0105_statement_compiler_casting_declaration");
    const d12 = migration("20261228100000_statement_compiler_casting_declaration.sql");
    expect(d12.length).toBe(PREDECESSOR_SOURCE.bytes);
    expect(sha(d12)).toBe(PREDECESSOR_SOURCE.sha256);
    expect([...BOOTSTRAP_PREDECESSOR.hashes]).toEqual([sha(d12), sha(Buffer.concat([d12, Buffer.from("\n")]))]);
    // the hash the hosted journal recorded for id 106 (Lovable's plain mirror 0105 is the committed bytes, byte for byte)
    expect(BOOTSTRAP_PREDECESSOR.hashes[0]).toBe("f319b4600a013871c0c734ef4e5a7451becfada0787f88f4a5ca40a80d420294");
    expect(fs.readFileSync(path.join(ROOT, "drizzle/migrations/0105_statement_compiler_casting_declaration.sql")).equals(d12)).toBe(true);
  });

  it("renders the nine committed files exactly, and pins the five executable transport forms", () => {
    const all = renderAll();
    expect(Object.keys(all).sort()).toEqual([
      "release/staged-transport-rfr/00_rfr_staged_transport.sql",
      "release/staged-transport-rfr/10_rfr_1_staged_apply.sql",
      "release/staged-transport-rfr/20_rfr_2_staged_apply.sql",
      "release/staged-transport-rfr/30_rfr_3_staged_apply.sql",
      "release/staged-transport-rfr/40_rfr_4_staged_apply.sql",
      "release/staged-transport-rfr/stage/1_rfr-1.source.sql",
      "release/staged-transport-rfr/stage/2_rfr-2.source.sql",
      "release/staged-transport-rfr/stage/3_rfr-3.source.sql",
      "release/staged-transport-rfr/stage/4_rfr-4.source.sql",
    ]);
    for (const [rel, text] of Object.entries(all)) expect(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel).toBe(text);
    const forms = transportForms();
    expect(forms.map((f) => f.name)).toEqual(["rfr_staged_transport", "rfr_1_staged_apply", "rfr_2_staged_apply", "rfr_3_staged_apply", "rfr_4_staged_apply"]);
    for (const f of forms) expect(f.hashes[0]).toBe((REGISTERED_TRANSPORT_FORMS as Record<string, string>)[f.name]);
    // every executable form is well inside what the hosted migrator demonstrably carries (D4: 21,628 B succeeded; 73 KB did not)
    for (const f of forms) expect(f.bytes, f.name).toBeLessThan(21628);
  });

  it("stages each exact source text as inert data with a checked non-colliding delimiter", () => {
    BATCHES.forEach((b, i) => {
      const sql = renderStage(i, "source");
      expect(sql).toContain(migration(b.source).toString("utf8"));
      expect(sql.startsWith(`INSERT INTO ${SCHEMA}.staged_artifacts`)).toBe(true);
      expect(sql).not.toContain("EXECUTE v_source");
    });
  });

  it("keeps the bootstrap private and apart from the earlier transports: its own schema, lock, error codes and tags", () => {
    const b = renderBootstrap();
    expect(SCHEMA).toBe("cfoclose_rfr_release");
    expect(b).toContain("CREATE SCHEMA cfoclose_rfr_release");
    expect(b).toContain("ENABLE ROW LEVEL SECURITY");
    expect(b).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(b).toContain(`octet_length(convert_to(body, 'UTF8')) <= ${MAX_BODY_BYTES}`);
    expect(b).not.toMatch(/ALL FUNCTIONS IN SCHEMA public|CREATE POLICY|SECURITY DEFINER/);
    expect(b).not.toMatch(/cfoclose_(ipsas|source_access|release|beta|equipment)\b/);
    expect(b).toContain("cfoclose_rfr_release_transport");
    expect(b).toContain("v_pred_id <> 106");
  });

  it("chains the four applies: each needs the previous one consumed and exactly the previous journal row (107 → 108 → 109 → 110)", () => {
    BATCHES.forEach((b, i) => {
      const s = renderApply(i);
      expect(s).toContain(`v_pred_id <> ${107 + i}`);
      expect(s).toContain(i === 0 ? "c_prior CONSTANT text := NULL" : `c_prior CONSTANT text := 'rfr-${i}'`);
      expect(s).toContain("RFR_TRANSPORT_PRIOR_NOT_APPLIED");
      expect(s).toContain(`IF ${b.anyPresent} THEN`);
      expect(s).toContain(`IF NOT (${b.installed}) THEN`);
    });
  });

  it("orders its checks: exact journal head, prerequisites, prior batch, uncertain state, rehash, execute, postconditions, privileges, compiler identity, baseline, consumption", () => {
    for (let i = 0; i < BATCHES.length; i++) {
      const s = renderApply(i);
      const at = (needle: string) => { const j = s.indexOf(needle); expect(j, `${i}: ${needle}`).toBeGreaterThan(-1); return j; };
      expect(at("WRONG_PREDECESSOR")).toBeLessThan(at("PREREQUISITE_MISSING"));
      expect(at("PREREQUISITE_MISSING")).toBeLessThan(at("PRIOR_NOT_APPLIED"));
      expect(at("PRIOR_NOT_APPLIED")).toBeLessThan(at("UNCERTAIN_STATE"));
      expect(at("UNCERTAIN_STATE")).toBeLessThan(at("encode(sha256(convert_to(s.body, 'UTF8'))"));
      expect(at("encode(sha256(convert_to(s.body, 'UTF8'))")).toBeLessThan(at("EXECUTE v_source"));
      expect(at("EXECUTE v_source")).toBeLessThan(at("RFR_TRANSPORT_POSTCONDITION"));
      expect(at("RFR_TRANSPORT_POSTCONDITION")).toBeLessThan(at("RFR_TRANSPORT_PRIVILEGE_POSTCONDITION"));
      expect(at("RFR_TRANSPORT_PRIVILEGE_POSTCONDITION")).toBeLessThan(at("RFR_TRANSPORT_COMPILER_IDENTITY_CHANGED"));
      expect(at("RFR_TRANSPORT_COMPILER_IDENTITY_CHANGED")).toBeLessThan(at("RFR_TRANSPORT_BASELINE_CHANGED"));
      expect(at("RFR_TRANSPORT_BASELINE_CHANGED")).toBeLessThan(at("SET consumed_at"));
      expect(s).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK);$/m);
      expect(s).toContain("IN SHARE MODE;");
    }
  });

  it("pins the path for each source and restores the ORIGINAL path at session level, because every source sets its own search_path", () => {
    for (let i = 0; i < BATCHES.length; i++) {
      expect(migration(BATCHES[i].source).toString("utf8")).toMatch(/SET search_path/i);
      const s = renderApply(i);
      const at = (needle: string) => { const j = s.indexOf(needle); expect(j, needle).toBeGreaterThan(-1); return j; };
      expect(at("set_config('search_path', 'pg_catalog, public', true)")).toBeLessThan(at("EXECUTE v_source"));
      expect(at("EXECUTE v_source")).toBeLessThan(at("set_config('search_path', v_search_path, false)"));
      expect(at("set_config('search_path', v_search_path, false)")).toBeLessThan(at("RFR_TRANSPORT_POSTCONDITION"));
      expect(s).not.toContain("set_config('search_path', v_search_path, true)");
    }
  });

  it("refuses when ANY object a source creates already exists, and names the prerequisites each source builds on", () => {
    for (const b of BATCHES) {
      if (b.tables.length) { expect(b.anyPresent).toContain(" OR "); expect(b.installed).toContain(" AND "); }
      for (const t of b.tables) { expect(b.installed).toContain(`to_regclass('public.${t}')`); }
      const s = renderApply(BATCHES.indexOf(b));
      for (const t of b.prerequisites.tables) expect(s).toContain(`public.${t}`);
      for (const f of b.prerequisites.functions) expect(s).toContain(`public.${f}`);
      for (const f of b.functions) expect(s).toContain(`has_function_privilege(v_role, 'public.${f}', 'EXECUTE')`);
      for (const t of b.tables) expect(s).toContain(`has_table_privilege(v_role, 'public.${t}', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`);
    }
    // rfr-2 adds a column and re-creates five existing functions: presence of those functions is NOT an uncertain state.
    expect(BATCHES[1].anyPresent).toContain("is_contra_account");
    expect(BATCHES[1].anyPresent).not.toMatch(/resolve_account_review_batch|close_review_refresh_findings/);
    expect(BATCHES[1].installed).toContain("has_column_privilege('authenticated', 'public.account_mappings', 'is_contra_account', 'INSERT')");
    // rfr-4 needs rfr-1 and rfr-3 installed (its own PREFLIGHT says so); rfr-3 the scope lock; rfr-1 the legacy declarations.
    expect(BATCHES[3].prerequisites.functions).toEqual(expect.arrayContaining(["_rfr_blockers(uuid, text, integer)", "_fs_first_period_pending(uuid, integer)"]));
    expect(BATCHES[2].prerequisites.functions).toContain("_fs_scope_lock(uuid, integer)");
    expect(BATCHES[0].prerequisites.tables).toContain("fs_first_period_declarations");
  });

  it("preserves the earlier records plus the mappings, decisions, reports, publications, declarations, allow-list and compiler receipts; the contra column is the one tolerated shape change", () => {
    expect(PRESERVED_TABLES).toEqual(expect.arrayContaining([...SOURCE_ACCESS_PRESERVED, "account_mappings", "account_review_decisions", "financial_statement_reports",
      "financial_statement_publications", "fs_first_period_declarations", "financial_statements_rollout_companies", "fs_server_compilations"]));
    for (let i = 0; i < BATCHES.length; i++) {
      const s = renderApply(i);
      for (const t of PRESERVED_TABLES) expect(s).toContain(`public.${t} t`);
      expect(s).toContain("(to_jsonb(t) - 'is_contra_account')");
      expect(s).toContain("fs_server_compilations_compiler_sha256_check");
      expect(s).not.toMatch(/UPDATE public\.|PAYMENTS_DISABLED|kill_switch\s*=\s*true|financial_statements_rollout_companies SET/);
    }
  });

  it("none of the four sources touches the compiler identity, the payment configuration or the pilot allow-list", () => {
    for (const b of BATCHES) {
      const t = migration(b.source).toString("utf8");
      expect(t).not.toMatch(/compiler_sha256|fs_record_server_compilation|fs_server_compilations_compiler_sha256_check/);
      expect(t).not.toMatch(/commercial_platform_state|CUSTOMER_PAYMENTS_ENABLED|commercial_plans|commercial_offers|polar/i);
      expect(t).not.toMatch(/INSERT INTO public\.financial_statements_rollout_companies|UPDATE public\.financial_statements_rollout_companies|DELETE FROM public\.financial_statements_rollout_companies/);
    }
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

  it("does not edit the source-access transport, and registers exactly its five hosted entries (ids 107–111, applied 2026-11-14) as rfr_staged_transport", () => {
    const dir = path.join(ROOT, "release/staged-transport-source-access");
    const hash = (f: string) => createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
    expect(hash("00_source_access_staged_transport.sql")).toBe(SOURCE_ACCESS_FORMS.source_access_staged_transport);
    expect(hash("10_source_access_1_staged_apply.sql")).toBe(SOURCE_ACCESS_FORMS.source_access_1_staged_apply);
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /rfr_/.test(k))).toEqual(["0106_rfr_staged_transport", "0107_rfr_1_staged_apply", "0108_rfr_2_staged_apply", "0109_rfr_3_staged_apply", "0110_rfr_4_staged_apply"]);
    for (const [k, e] of Object.entries(RELEASE_JOURNAL).filter(([k]) => /rfr_/.test(k))) expect(e, k).toEqual({ kind: "rfr_staged_transport", sha256: (REGISTERED_TRANSPORT_FORMS as Record<string, string>)[k.slice(5)] });
  });
});
