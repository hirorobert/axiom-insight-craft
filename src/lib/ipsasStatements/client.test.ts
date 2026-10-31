import { describe,it,expect } from "vitest";
import { statementClient, recoverIntent, storeIntent, recoveryKey, type SaveIntent } from "./client";
import { reviewFixture, COMPANY, ACTOR, OTHER, REVISION } from "./review.fixture";
const intent=():SaveIntent=>({companyId:COMPANY,periodYear:2026,assignments:[],expectedRevision:null,expectedInput:"b".repeat(64),requestId:ACTOR});
const client=(data:unknown,error:unknown=null)=>statementClient({rpc:async()=>({data,error})} as never);
describe("server review boundary",()=>{
 it("accepts only a validated server snapshot for the requested scope",async()=>{expect((await client(reviewFixture()).read(COMPANY,2026)).outcome).toBe("available");await expect(client(reviewFixture(OTHER)).read(COMPANY,2026)).rejects.toThrow("different reporting scope");});
 it.each(["inputSha256","sourceSha256","compositionSha256"])("refuses missing %s",async field=>{const r=reviewFixture();delete r[field];await expect(client(r).read(COMPANY,2026)).rejects.toThrow("incomplete");});
 it("refuses an issuance claim even alongside plausible financial figures",async()=>{const r=reviewFixture();r.officialIssuance.available=true;await expect(client(r).read(COMPANY,2026)).rejects.toThrow();});
 it("refuses numeric money, unsafe numbers and negative zero",async()=>{for(const value of [1,Number.MAX_SAFE_INTEGER+1,"-0","1.1"]){const r=reviewFixture();r.accounts[0].debitMinor=value as never;await expect(client(r).read(COMPANY,2026)).rejects.toThrow();}});
 it("makes missing installation explicit, without claiming a saved result",async()=>{await expect(client(null,{code:"PGRST202"}).read(COMPANY,2026)).rejects.toThrow("not installed");});
 it("does not turn an empty success into a save receipt",async()=>{await expect(client({}).save(intent())).rejects.toThrow("could not confirm");});
 it("requires the receipt for this exact request",async()=>{await expect(client({outcome:"recorded",revisionId:REVISION,sourceSha256:"a".repeat(64),requestId:OTHER}).save(intent())).rejects.toThrow("could not confirm");});
 it("requires a durable revision identity",async()=>{await expect(client({outcome:"recorded",requestId:ACTOR,sourceSha256:"a".repeat(64)}).save(intent())).rejects.toThrow();});
 it("accepts a valid durable receipt",async()=>{expect(await client({outcome:"recorded",requestId:ACTOR,sourceSha256:"a".repeat(64),revisionId:REVISION}).save(intent())).toEqual({outcome:"recorded",revisionId:REVISION});});
 it("passes only scope, choices, expected versions and request identity to the server",async()=>{let sent;const c=statementClient({rpc:async(name,args)=>{sent={name,args};return{data:{outcome:"stale"},error:null};}} as never);await c.save(intent());expect(sent.name).toBe("ipsas_save_presentation");expect(Object.keys(sent.args).sort()).toEqual(["p_assignments","p_company","p_expected_input","p_expected_revision","p_request","p_year"]);});
});
describe("unknown outcome recovery",()=>{
 const memory=()=>{const data=new Map<string,string>();return{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value),data};};
 it("restores exactly the actor/company/year/request intent",()=>{const s=memory(),i=intent();expect(storeIntent(s,ACTOR,i)).toBe(true);expect(recoverIntent(s,ACTOR,COMPANY,2026)).toEqual(i);expect(recoverIntent(s,OTHER,COMPANY,2026)).toBeNull();expect(recoverIntent(s,ACTOR,OTHER,2026)).toBeNull();expect(recoverIntent(s,ACTOR,COMPANY,2025)).toBeNull();});
 it("refuses a transplanted record belonging to another actor",()=>{const s=memory();storeIntent(s,ACTOR,intent());s.setItem(recoveryKey(OTHER,COMPANY,2026),s.getItem(recoveryKey(ACTOR,COMPANY,2026))!);expect(recoverIntent(s,OTHER,COMPANY,2026)).toBeNull();});
 it("does not retain expired or malformed recovery as a new save",()=>{const s=memory();storeIntent(s,ACTOR,intent());expect(recoverIntent(s,ACTOR,COMPANY,2026,Date.now()+86400001)).toBeNull();s.setItem(recoveryKey(ACTOR,COMPANY,2026),"{}");expect(recoverIntent(s,ACTOR,COMPANY,2026)).toBeNull();});
 it("handles refused browser storage",()=>{expect(storeIntent({setItem(){throw Error("blocked");}},ACTOR,intent())).toBe(false);expect(recoverIntent({getItem(){throw Error("blocked");}},ACTOR,COMPANY,2026)).toBeNull();});
});
