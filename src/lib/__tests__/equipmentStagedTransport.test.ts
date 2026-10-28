import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BATCHES, BOOTSTRAP_PREDECESSOR, SOURCE_COMMIT, PRESERVED_TABLES, artifactBytes, checkTransportMirror, renderAll, renderApply, renderBootstrap, renderStage, transportForms, REGISTERED_TRANSPORT_FORMS } from "../../../scripts/release/equipmentStagedTransport.mjs";
import { RELEASE_JOURNAL, checkReleaseEntry } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";
const ROOT = process.cwd();
const read = (name: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", name));

describe("equipment exact-byte staged transport", () => {
  it("pins the approved merged sources and the actual predecessor, without changing them", () => {
    expect(SOURCE_COMMIT).toBe("b7ac24017b0b99a8ba2a125066d67e8f44d8284a");
    expect(BOOTSTRAP_PREDECESSOR.id).toBe(88);
    expect(BOOTSTRAP_PREDECESSOR.hash).toBe("238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8");
    expect(BATCHES.map(b => b.artifacts.source.bytes)).toEqual([18476,54129]);
    for (let i=0;i<2;i++) expect(artifactBytes(i,"source").equals(read(BATCHES[i].source))).toBe(true);
  });
  it("renders the five committed files exactly, and pins all three executable transport forms", () => {
    const all=renderAll(); expect(Object.keys(all)).toHaveLength(5);
    for(const [rel,text] of Object.entries(all)) expect(fs.readFileSync(path.join(ROOT,rel),"utf8"),rel).toBe(text);
    for(const f of transportForms()) expect(f.hashes[0]).toBe(REGISTERED_TRANSPORT_FORMS[f.name]);
  });
  it("stages exact source text as inert data with a checked non-colliding delimiter", () => {
    for(let i=0;i<2;i++) {
      const sql=renderStage(i,"source"); const source=artifactBytes(i,"source").toString("utf8");
      expect(sql).toContain(source); expect(sql.startsWith("INSERT INTO cfoclose_eqp_release.staged_artifacts")).toBe(true);
      expect(sql).not.toContain("EXECUTE v_source");
    }
  });
  it("keeps bootstrap private and revokes only its own three helpers", () => {
    const b=renderBootstrap();
    expect(b).toContain("ENABLE ROW LEVEL SECURITY");
    expect(b).toContain("ALL SEQUENCES IN SCHEMA cfoclose_eqp_release");
    expect(b).not.toMatch(/ALL FUNCTIONS IN SCHEMA public|CREATE POLICY|SECURITY DEFINER/);
    expect(b).toContain("ARRAY['anon', 'authenticated', 'service_role']");
    expect(b).toContain("octet_length(convert_to(NEW.body, 'UTF8'))");
  });
  it("checks exact journal position and rehashes source before execution and consumption", () => {
    for(let i=0;i<2;i++) {
      const s=renderApply(i);
      expect(s).toContain(`v_pred_id <> ${89+i}`);
      expect(s.indexOf("WRONG_PREDECESSOR")).toBeLessThan(s.indexOf("EXECUTE v_source"));
      expect(s.indexOf("encode(sha256(convert_to(s.body, 'UTF8'))")).toBeLessThan(s.indexOf("EXECUTE v_source"));
      expect(s.indexOf("EXECUTE v_source")).toBeLessThan(s.indexOf("SET consumed_at"));
      expect(s).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK);$/m);
      expect(s).toContain("IN SHARE MODE;");
    }
  });
  it("preserves existing schedules, disclosures and actual settings rather than resetting them", () => {
    expect(PRESERVED_TABLES).toEqual(expect.arrayContaining(["fs_schedule_submissions","fs_schedule_definitions","fs_disclosure_texts","commercial_platform_state","ai_assistant_settings","financial_statements_rollout_state"]));
    const s=renderApply(1);
    expect(s).toContain("public.fs_equipment_workpapers t");
    expect(s).toContain("public.fs_equipment_policy_insertions t");
    expect(s).not.toMatch(/UPDATE public\.|PAYMENTS_DISABLED|kill_switch\s*=\s*true/);
  });
  it("rejects changed mirrors and changed covered sources, allowing only one migrator-final LF", () => {
    const registry=RELEASE_JOURNAL as Record<string,unknown>;
    for(const f of transportForms()) {
      const tag=`9999_${f.name}`; registry[tag]={kind:"equipment_staged_transport",sha256:f.hashes[0]};
      try {
        expect(checkReleaseEntry(tag,f.text,read).problems).toEqual([]);
        expect(checkReleaseEntry(tag,`${f.text}\n`,read).problems).toEqual([]);
        expect(checkReleaseEntry(tag,`${f.text} `,read).problems.length).toBeGreaterThan(0);
        if(f.role==="apply") expect(checkReleaseEntry(tag,f.text,n=>Buffer.concat([read(n),Buffer.from(" ")])).problems.length).toBeGreaterThan(0);
        expect(checkTransportMirror("9999_unregistered",f.text).problems.length).toBeGreaterThan(0);
      } finally {delete registry[tag];}
    }
  });
  it("registers only the three actual installed mirrors and has no pending equipment sources", () => {
    const tags=["0088_equipment_staged_transport","0089_eqp_1_preparation_staged_apply","0090_eqp_2_multiclass_staged_apply"];
    expect(Object.keys(RELEASE_JOURNAL).filter(x=>x.includes("eqp_") || x.includes("equipment_staged_transport"))).toEqual(tags);
    for (const [i,f] of transportForms().entries()) {
      expect(fs.readFileSync(path.join(ROOT,"drizzle/migrations",`${tags[i]}.sql`),"utf8")).toBe(f.text);
      expect(RELEASE_JOURNAL[tags[i]]).toEqual({kind:"equipment_staged_transport",sha256:f.hashes[0]});
    }
    expect(checkMigrationAuthority(ROOT).pending).toEqual([]);
  });
  it("the canonical authority accepts future real mirrors only with reviewed registrations", () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"equipment-transport-authority-"));
    const registry=RELEASE_JOURNAL as Record<string,unknown>;const added:string[]=[];
    try {
      fs.cpSync(path.join(ROOT,"supabase/migrations"),path.join(dir,"supabase/migrations"),{recursive:true});
      fs.cpSync(path.join(ROOT,"drizzle"),path.join(dir,"drizzle"),{recursive:true});
      // Reconstruct the pre-equipment journal in this disposable fixture only; hosted history is immutable.
      const beforePath=path.join(dir,"drizzle/migrations/meta/_journal.json");
      const before=JSON.parse(fs.readFileSync(beforePath,"utf8"));
      for(const e of before.entries.filter((e: {idx:number})=>e.idx>=88)) {
        fs.rmSync(path.join(dir,"drizzle/migrations",`${e.tag}.sql`));
        fs.rmSync(path.join(dir,"drizzle/migrations/meta",`${String(e.idx).padStart(4,"0")}_snapshot.json`));
      }
      before.entries=before.entries.filter((e: {idx:number})=>e.idx<88);
      fs.writeFileSync(beforePath,JSON.stringify(before));
      const jf=path.join(dir,"drizzle/migrations/meta/_journal.json");const j=JSON.parse(fs.readFileSync(jf,"utf8"));let when=j.entries.at(-1).when;
      for(const f of transportForms()) {
        const idx=j.entries.length;const tag=`${String(idx).padStart(4,"0")}_${f.name}`;
        fs.writeFileSync(path.join(dir,"drizzle/migrations",`${tag}.sql`),f.text+"\n");
        fs.copyFileSync(path.join(dir,"drizzle/migrations/meta",`${String(idx-1).padStart(4,"0")}_snapshot.json`),path.join(dir,"drizzle/migrations/meta",`${String(idx).padStart(4,"0")}_snapshot.json`));
        j.entries.push({idx,version:"7",when:(when+=1000),tag,breakpoints:true});
        registry[tag]={kind:"equipment_staged_transport",sha256:f.hashes[0]};added.push(tag);
      }
      fs.writeFileSync(jf,JSON.stringify(j));
      const result=checkMigrationAuthority(dir);expect(result.errors).toEqual([]);expect(result.pending).toEqual([]);
      delete registry[added[0]];
      expect(checkMigrationAuthority(dir).errors.length).toBeGreaterThan(0);
    } finally {for(const tag of added) delete registry[tag];fs.rmSync(dir,{recursive:true,force:true});}
  },30000);
});
