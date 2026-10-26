// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AccountCorrection, type AccountCorrectionProps } from './AccountCorrection';
import { mount, typeInto, click } from '@/lib/workbench/testkit/dom';
import { saveCorrection } from '@/lib/workspace/accountCorrection';
const flush = async () => { for(let i=0;i<4;i++) await act(async()=>{ await new Promise(r=>setTimeout(r,0)); }); };
const UP='11111111-1111-4111-8111-111111111111';
const C='22222222-2222-4222-8222-222222222222';
function props(code:string, rpc:AccountCorrectionProps['rpc']):AccountCorrectionProps {
 const row={id:'f'+code,run_id:'run',rule_id:'A01',finding_key:'A01:'+code,severity:'warning',kind:'risk_indicator',mandatory:false,required_resolution:'explanation',account_key:code,account_code:code,account_name:'Account '+code,classification:'revenue',debit_minor:'1400000',credit_minor:'0',class_side_minor:'-1400000',detail:{}};
 return {companyId:C,periodYear:2025,link:{accountKey:code,findingKey:'A01:'+code,rule:'A01'},reportVersion:null,upload:{id:UP,status:'complete'},canCorrect:true,currentUserId:'u',
 findings:{summary:async()=>({state:'current',runId:'run',currency:'TZS',exponent:2,generatedAt:'2026-10-26T08:00:00Z',total:1,unresolved:1,unresolvedBlocking:0,ruleStatus:{}}),list:async()=>[row],states:async()=>[],refresh:async()=>({outcome:'generated'})} as never,
 readers:{runUpload:async()=>UP,latestRun:async()=>null,mapping:async()=>({classification:'revenue',review_decision_id:null}),decision:async()=>null,member:async()=>null,uploadStatus:async()=> 'complete'},rpc,startCheck:async()=>{},onUploadChanged:()=>{}};
}
describe('independent review reproductions',()=>{
 it('a missing success payload must stay unknown',async()=>{
  const outcome=await saveCorrection(async()=>({data:null,error:null}),{companyId:C,uploadId:UP,requestId:UP,decision:{} as never});
  expect(outcome.kind).toBe('unknown');
 });
 it('a late save for the previous account must not overwrite the newly selected account',async()=>{
  let finish!:(v:{data:unknown,error:null})=>void;
  const rpc:AccountCorrectionProps['rpc']=()=>new Promise(r=>{finish=r;});
  const render=(p:AccountCorrectionProps)=>h(MemoryRouter,null,h(AccountCorrection,p));
  const m=mount(render(props('95000',rpc)));
  try{
   await flush();
   const select=m.container.querySelector('select')!;
   act(()=>{select.value='cost_of_goods_sold';select.dispatchEvent(new Event('change',{bubbles:true}));});
   typeInto(m.container.querySelector('textarea')!,'Correct the saved expense classification');
   click(m.container.querySelector('[data-testid="correction-save"]')!);
   await flush();
   expect(finish).toBeTypeOf('function');
   m.rerender(render(props('91510',rpc)));await flush();
   expect(m.container.querySelector('[data-testid="correction-account"]')!.textContent).toContain('91510');
   await act(async()=>finish({data:{batch_id:UP,mappings_written:1,decisions_logged:1,non_reporting_decisions_recorded:0},error:null}));
   await flush();
   expect(m.container.querySelector('[data-testid="correction-account"]')!.textContent).toContain('91510');
  } finally {m.unmount();sessionStorage.clear();}
 });
});
