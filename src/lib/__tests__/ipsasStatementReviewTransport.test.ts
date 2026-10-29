import {describe,it,expect} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {BATCHES,BOOTSTRAP_PREDECESSOR,TRANSPORT_DIR,artifactBytes,renderAll,renderApply,renderBootstrap,renderStage,checkTransportMirror,transportForms,sha256} from "../../../scripts/release/ipsasStatementReviewStagedTransport.mjs";
const root=path.resolve(__dirname,"../../..");
describe("statement-review exact-byte transport",()=>{
 it("pins the current authored source as well as the staged source",()=>{const a=BATCHES[0].artifacts.source,bytes=fs.readFileSync(path.join(root,a.path));expect(bytes.length).toBe(a.bytes);expect(sha256(bytes)).toBe(a.sha256);expect(artifactBytes(0,"source").equals(bytes)).toBe(true);});
 it("rejects unreviewed source bytes when the pinned commit is unavailable",()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ipsas-statement-source-"));try{const a=BATCHES[0].artifacts.source,p=path.join(dir,a.path);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,"changed SQL");expect(()=>artifactBytes(0,"source",dir)).toThrow("pinned identity");}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 it("every generated installation file is byte-identical to its generator",()=>{for(const [file,sql]of Object.entries(renderAll()))expect(fs.readFileSync(path.join(root,file),"utf8")).toBe(sql);});
 it("requires the revised grants predecessor and a new private schema",()=>{expect(BOOTSTRAP_PREDECESSOR.id).toBe(95);expect(renderBootstrap()).toContain("cfoclose_ipsas_statement_release");expect(renderBootstrap()).toContain("WRONG_PREDECESSOR");expect(renderApply(0)).toContain("LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE");});
 it("checks only the new public objects and all API-role privileges",()=>{const s=renderApply(0);expect(s).toContain("has_table_privilege(v_role, 'public.ipsas_presentation_revisions'");expect(s).toContain("has_sequence_privilege");expect(s).toContain("public.ipsas_save_presentation(uuid,integer,jsonb,uuid,text,uuid)");expect(s).not.toContain("has_table_privilege(v_role, 'public.ipsas_grant_revisions'");});
 it("validates exact forms and refuses edited migration text",()=>{for(const form of transportForms()){expect(checkTransportMirror(`0096_${form.name}`,form.text).problems).toEqual([]);expect(checkTransportMirror(`0096_${form.name}`,form.text+" ").problems.length).toBeGreaterThan(0);}});
 it("pins the execution search path and restores it, with consumption after execution",()=>{const s=renderApply(0);expect(s).toContain("'pg_catalog, public'");expect(s).toContain("set_config('search_path', v_search_path");expect(s.indexOf("EXECUTE v_source")).toBeLessThan(s.indexOf("SET consumed_at"));});
 it("stage generation contains the exact approved source bytes",()=>{const stage=renderStage(0,"source"),tag=`$cfoclose_ipsas_statement_stage_${BATCHES[0].artifacts.source.sha256.slice(0,16)}$`;expect(stage.slice(stage.indexOf(tag)+tag.length,stage.lastIndexOf(tag))).toBe(artifactBytes(0,"source").toString("utf8"));});
});
