// @vitest-environment jsdom
import {createElement as h,act} from "react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mount,click} from "@/lib/workbench/testkit/dom";
const f=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock("@/integrations/supabase/client",()=>({supabase:{rpc:(...a:unknown[])=>f.rpc(...a)}}));
import {InternalBetaTeamAccess} from "./InternalBetaTeamAccess";
let ui:ReturnType<typeof mount>|undefined;
const flush=async()=>{await act(async()=>{for(let i=0;i<10;i++)await Promise.resolve();});};
const view=(companyId="a")=>h(MemoryRouter,null,h(InternalBetaTeamAccess,{companyId,members:[{userId:"owner",role:"owner",displayName:"Owner"}]}));
beforeEach(()=>f.rpc.mockReset());afterEach(()=>ui?.unmount());
describe("visible enrollment recovery",()=>{
 it("a refused status shows recovery instead of hiding the whole feature",async()=>{
  f.rpc.mockResolvedValueOnce({data:null,error:{code:"42501"}}).mockResolvedValue({data:[{userId:"owner",enrolled:false}],error:null});
  ui=mount(view());await flush();expect(ui.container.textContent).toContain("could not be read");
  click(ui.container.querySelector("button")!);await flush();expect(ui.container.textContent).toContain("Enable beta access");
 });
 it("first owner enrollment has a synchronous duplicate guard and a confirmed read",async()=>{
  let enrolled=false;
  f.rpc.mockImplementation(async(name:string)=>name==="internal_beta_team_status"?{data:[{userId:"owner",enrolled}],error:null}:(enrolled=true,{data:{outcome:"recorded"},error:null}));
  ui=mount(view());await flush();const b=ui.container.querySelector("button")!;click(b);click(b);await flush();
  expect(f.rpc.mock.calls.filter(c=>c[0]==="internal_beta_enroll_member")).toHaveLength(1);
  expect(ui.container.textContent).toContain("Enrolled");expect(ui.container.querySelector('a[href="/commercial/admin?tab=internal-beta"]')).not.toBeNull();
 });
 it("a late old-company read cannot show its enrollment in the next company",async()=>{
  let resolve!:(v:unknown)=>void;
  f.rpc.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({data:[{userId:"owner",enrolled:false}],error:null});
  ui=mount(view());ui.rerender(view("b"));await flush();await act(async()=>resolve({data:[{userId:"owner",enrolled:true}],error:null}));await flush();
  expect(ui.container.textContent).toContain("Enable beta access");expect(ui.container.querySelector("a")).toBeNull();
 });
});
