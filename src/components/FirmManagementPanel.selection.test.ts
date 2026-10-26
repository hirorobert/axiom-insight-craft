// @vitest-environment jsdom
import {act,createElement as h,Fragment} from "react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mount,click} from "@/lib/workbench/testkit/dom";
import {ManagementContext} from "@/components/account/managementState";
const f=vi.hoisted(()=>({user:{id:"owner"},rpc:vi.fn(),queries:[] as Array<{table:string;company?:string}>}));
vi.mock("@/contexts/AuthContext",()=>({useAuth:()=>({user:f.user})}));
vi.mock("@/components/ui/select",()=>({
 Select:({value,onValueChange,children}: {value:string;onValueChange:(v:string)=>void;children:unknown})=>h("select",{value,onChange:e=>onValueChange(e.target.value),"aria-label":"Company"},children as never),
 SelectTrigger:()=>null,SelectValue:()=>null,SelectContent:({children}:{children:unknown})=>h(Fragment,null,children as never),SelectItem:({value,children}:{value:string;children:unknown})=>h("option",{value},children as never),
}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{
 rpc:(...a:unknown[])=>f.rpc(...a),
 from:(table:string)=>{let company:string|undefined;const q:Record<string,unknown>={};for(const m of ["select","eq","in","order"]){q[m]=(key:string,value:string)=>{if(key==="company_id")company=value;return q;};}
 q.then=(resolve:(v:unknown)=>unknown)=>{f.queries.push({table,company});return Promise.resolve({error:null,data:table==="companies"?[{id:"arka",name:"ARKA",tin:null},{id:"test",name:"CFOClose Complete Test",tin:null}]:table==="profiles"?[{user_id:"owner",display_name:"Humphrey"}]:table==="firm_members"&&company?[{id:"m",company_id:company,user_id:"owner",role:"owner",accepted_at:"2026-01-01",created_at:"2026-01-01"}]:[{company_id:"arka"},{company_id:"test"}]}).then(resolve);};return q;},
}}));
import {FirmManagementPanel} from "./FirmManagementPanel";
let ui:ReturnType<typeof mount>|undefined;
const flush=async()=>{await act(async()=>{for(let i=0;i<14;i++)await Promise.resolve();});};
const view=(company="test")=>h(MemoryRouter,null,h(ManagementContext.Provider,{value:{origin:{pathname:`/workspace/${company}/2025`,search:"",hash:"",key:"origin",state:null},register:()=>{}}},h(FirmManagementPanel)));
beforeEach(()=>{sessionStorage.clear();f.queries=[];f.rpc.mockReset().mockResolvedValue({data:null,error:null});});afterEach(()=>ui?.unmount());
describe("team company continuity",()=>{
 it("opens in the actual workspace company and keeps it after refresh and remount",async()=>{
  ui=mount(view());await flush();expect(ui.container.querySelector("select")?.value).toBe("test");
  click([...ui.container.querySelectorAll("button")].find(b=>b.textContent?.trim()==="Refresh")!);await flush();
  expect(ui.container.querySelector("select")?.value).toBe("test");ui.unmount();ui=mount(view());await flush();expect(ui.container.querySelector("select")?.value).toBe("test");
 });
 it("ignores a remembered company absent from the server-owned list",async()=>{
  sessionStorage.setItem("cfoclose:team-company:owner","foreign");ui=mount(view("foreign"));await flush();expect(ui.container.querySelector("select")?.value).toBe("arka");
 });
});
