// @vitest-environment jsdom
import {createElement as h,act,useState} from "react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {mount,click} from "@/lib/workbench/testkit/dom";
import {WorkspaceRefreshButton} from "./WorkspaceRefreshButton";
import {useWorkspaceRefresh} from "@/hooks/useWorkspaceRefresh";
let ui:ReturnType<typeof mount>|undefined;
afterEach(()=>ui?.unmount());
const flush=async()=>{await act(async()=>{for(let i=0;i<8;i++)await Promise.resolve();});};
function Reader({company,year,read}:{company:string;year:number;read:()=>Promise<unknown>}){useWorkspaceRefresh(company,read,year);const [draft,setDraft]=useState("unsaved");return h("input",{value:draft,onChange:e=>setDraft(e.target.value)});}
describe("workspace refresh",()=>{
 it("waits for matching readers, coalesces double clicks and keeps mounted draft",async()=>{
  let finish!:(v:boolean)=>void;
  const root=vi.fn(async()=>true), matching=vi.fn(()=>new Promise<boolean>(r=>{finish=r;})),other=vi.fn(async()=>true);
  ui=mount(h("div",null,h(Reader,{company:"a",year:2025,read:matching}),h(Reader,{company:"b",year:2025,read:other}),h(Reader,{company:"a",year:2024,read:other}),h(WorkspaceRefreshButton,{companyId:"a",periodYear:2025,reads:[root]})));
  const input=ui.container.querySelector("input")!;
  const b=ui.container.querySelector("button")!;click(b);click(b);await flush();
  expect(root).toHaveBeenCalledTimes(1);expect(matching).toHaveBeenCalledTimes(1);expect(other).not.toHaveBeenCalled();
  expect(b.disabled).toBe(true);expect(ui.container.textContent).toContain("Refreshing workspace");
  await act(async()=>finish(true));await flush();expect(ui.container.textContent).toContain("Workspace updated");
  expect(ui.container.querySelector("input")).toBe(input);expect(input.value).toBe("unsaved");
 });
 it("never announces Updated after any reader fails and supports retry",async()=>{
  const root=vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  ui=mount(h(WorkspaceRefreshButton,{companyId:"a",periodYear:2025,reads:[root]}));
  click(ui.container.querySelector("button")!);await flush();expect(ui.container.textContent).toContain("Refresh incomplete");
  click(ui.container.querySelector("button")!);await flush();expect(ui.container.textContent).toContain("Workspace updated");
 });
});
