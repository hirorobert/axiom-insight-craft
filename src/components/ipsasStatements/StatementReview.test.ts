// @vitest-environment jsdom
import {createElement as h,act} from "react";
import {afterEach,it,expect} from "vitest";
import {mount,click,type Mounted,axeViolations} from "@/lib/workbench/testkit/dom";
import {StatementReview} from "./StatementReview";
import {reviewFixture,COMPANY,ACTOR,OTHER,REVISION} from "@/lib/ipsasStatements/review.fixture";
import {recoveryKey} from "@/lib/ipsasStatements/client";
let m:Mounted|null=null;
afterEach(()=>{m?.unmount();m=null;sessionStorage.clear();});
const flush=async()=>{for(let i=0;i<8;i++)await act(async()=>{await Promise.resolve();});};
const button=(text:string)=>[...m!.container.querySelectorAll("button")].find(b=>b.textContent?.includes(text))!;
function server(save?: (args:Record<string,unknown>)=>Promise<unknown>){
 const calls:{name:string;args:Record<string,unknown>}[]=[],stored=new Map<string,unknown>();
 const db={rpc:async(name:string,args:Record<string,unknown>)=>{
  calls.push({name,args});
  if(name==="ipsas_statement_review")return{data:reviewFixture(args.p_company as string,stored.get(args.p_company as string) as never??null),error:null};
  const answer=save?await save(args):{outcome:"recorded",revisionId:REVISION,requestId:args.p_request,sourceSha256:"a".repeat(64)};
  if((answer as {outcome?:string}).outcome==="recorded")stored.set(args.p_company as string,structuredClone(args.p_assignments));
  return{data:answer,error:null};
 }};return{db,calls};
}
const props=(db:unknown,over={})=>({companyId:COMPANY,periodYear:2026,actorId:ACTOR,canPrepare:true,db,...over});
function select(value:string){const el=m!.container.querySelector('[aria-label="Caption for current 1000"]') as HTMLSelectElement;act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("change",{bubbles:true}));});}
it("loads real RPC figures, labels reference comparatives and offers a concrete next action",async()=>{const {db,calls}=server();m=mount(h(StatementReview,props(db) as never));await flush();expect(calls[0].name).toBe("ipsas_statement_review");expect(m.container.textContent).toContain("Incomplete draft — not approved or issued");expect(m.container.textContent).toContain("Prior certified TB — reference only");expect(m.container.textContent).toContain("Not composed");expect(m.container.querySelector('a[href$="/prepare"]')).not.toBeNull();});
it("preserves edits made while a save is waiting",async()=>{
 let finish!:(r:unknown)=>void;let sent:Record<string,unknown>;
 const {db}=server(args=>{sent=args;return new Promise(r=>finish=r);});m=mount(h(StatementReview,props(db) as never));await flush();select("cash");click(button("Save presentation choices"));await flush();select("receivables_current");
 await act(async()=>finish({outcome:"recorded",revisionId:REVISION,requestId:sent.p_request,sourceSha256:"a".repeat(64)}));await flush();
 expect((m.container.querySelector('[aria-label="Caption for current 1000"]') as HTMLSelectElement).value).toBe("receivables_current");expect(m.container.textContent).toContain("Newer edits are still unsaved");expect(button("Save presentation choices").disabled).toBe(false);
});
it.each(["company","actor"])("a late save cannot change the new %s context or start another read",async kind=>{
 let finish!:(r:unknown)=>void;let sent:Record<string,unknown>;const {db,calls}=server(args=>{sent=args;return new Promise(r=>finish=r);});
 m=mount(h(StatementReview,props(db) as never));await flush();select("cash");click(button("Save presentation choices"));await flush();
 m.rerender(h(StatementReview,props(db,kind==="company"?{companyId:OTHER}:{actorId:OTHER}) as never));await flush();const n=calls.length;
 await act(async()=>finish({outcome:"recorded",revisionId:REVISION,requestId:sent.p_request,sourceSha256:"a".repeat(64)}));await flush();
 expect(calls).toHaveLength(n);expect(m.container.textContent).not.toContain("choices saved");expect((m.container.querySelector('[aria-label="Caption for current 1000"]') as HTMLSelectElement).value).toBe("");
});
it("an ambiguous answer retries the original payload and identity, not newer edits",async()=>{
 let n=0;const {db,calls}=server(async args=>++n===1?{}:{outcome:"recorded",revisionId:REVISION,requestId:args.p_request,sourceSha256:"a".repeat(64)});
 m=mount(h(StatementReview,props(db) as never));await flush();select("cash");click(button("Save presentation choices"));await flush();expect(m.container.textContent).toContain("could not confirm");select("receivables_current");click(button("Send the same request again"));await flush();
 const saves=calls.filter(c=>c.name==="ipsas_save_presentation");expect(saves).toHaveLength(2);expect(saves[1].args).toEqual(saves[0].args);expect(m.container.textContent).toContain("Newer edits are still unsaved");
});
it("restores an uncertain request after remount only for its actor and scope",async()=>{
 const {db,calls}=server(async()=>({}));m=mount(h(StatementReview,props(db) as never));await flush();select("cash");click(button("Save presentation choices"));await flush();const request=calls.find(c=>c.name==="ipsas_save_presentation")!.args.p_request;
 m.unmount();m=mount(h(StatementReview,props(db) as never));await flush();click(button("Send the same request again"));await flush();expect(calls.filter(c=>c.name==="ipsas_save_presentation").at(-1)!.args.p_request).toBe(request);
 m.unmount();m=mount(h(StatementReview,props(db,{actorId:OTHER}) as never));await flush();expect(m.container.textContent).not.toContain("Send the same request again");expect(sessionStorage.getItem(recoveryKey(ACTOR,COMPANY,2026))).not.toBeNull();
});
it("Refresh responds to dirty work with explicit keep/discard actions",async()=>{
 const {db,calls}=server();m=mount(h(StatementReview,props(db) as never));await flush();select("cash");const n=calls.length;click(button("Refresh statements"));expect(m.container.textContent).toContain("Keep editing");expect(calls).toHaveLength(n);click(button("Keep editing"));expect((m.container.querySelector('select') as HTMLSelectElement).value).toBe("cash");
 click(button("Refresh statements"));click(button("Discard edits and refresh"));await flush();expect(calls.length).toBe(n+1);expect((m.container.querySelector('[aria-label="Caption for current 1000"]') as HTMLSelectElement).value).toBe("");
});
it("signed-out screens neither read nor persist a recovery intent",async()=>{const{db,calls}=server();m=mount(h(StatementReview,props(db,{actorId:null}) as never));await flush();expect(calls).toHaveLength(0);expect(sessionStorage.length).toBe(0);expect(m.container.textContent).toContain("Sign in");});
it("read-only users get no save action",async()=>{const{db}=server();m=mount(h(StatementReview,props(db,{canPrepare:false}) as never));await flush();expect(m.container.textContent).not.toContain("Save presentation choices");expect((m.container.querySelector('select') as HTMLSelectElement).disabled).toBe(true);});
it("the review screen has no detected structural accessibility violations",async()=>{const{db}=server();m=mount(h(StatementReview,props(db) as never));await flush();expect(await axeViolations(m.container)).toEqual([]);});
