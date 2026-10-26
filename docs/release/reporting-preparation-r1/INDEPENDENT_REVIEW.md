# Independent release-candidate review — 26 October 2026

No merge, hosted mutation, deployment, publication or provider call.

## #201 — aef90b34c74a88cb968b9f507ae18dad9c03b2b7

No release-blocking defect established within the four-account correction scope after source review and an independent execution of the actual fallback-rule functions. Cost of sales, accumulated depreciation, interest income and the ambiguous bank loan produce the intended fallback results. This extraction does not replace the complete database/handler proof. GitHub CI run 40287743305 passed all nine automatic jobs, including the real-handler database proof and application journey; manual staging skipped.

The local source closure recomputes as d0e8eb018c50e870d561c1bd45b21472ab0d29fd57c199cee852bd6f9dee19db. This is a LOCAL SOURCE check, not deployed-source attestation. Reusing the deployed-verifier CLI on the local checkout prints misleading deployed/reuse wording; no conclusion about hosted code follows.

Boundary: conservative/ambiguous name handling is not complete accounting classification. Extended names such as short-term bank loan or current portion of long-term bank loan need further characterisation; no claim of universal correct suggestions is made. Reviewed mappings remain authoritative; deployment does not correct existing wrong approved mappings. The loan's maturity must be decided from terms.

## #202 — e57d277dc8a5c967f1b60d21f89d535025e3f94b

CHANGES REQUIRED. Existing 14 unit tests pass independently; the two additional component/transport reproductions below fail on that head. These are executed findings, not inferences from CI status.

1. **High priority: a late save replaces the newly selected account.** Mount the correction for 95000, submit a correction with its response delayed, navigate the same component to 91510, then release the original save. The account display reverts to 95000 although the active link/header context is 91510. The old save completion invokes its captured reload; that old reload increments the shared sequence and replaces newer context. It can also clear a new draft. Fix account/upload/actor scope ownership for asynchronous reads, saves and rechecks, reset scoped state, and reject obsolete completions before starting another read or refresh. A company/year layout remount does not address switching account query parameters in the same workspace.

2. **Medium priority: absent success payload is reported saved.** saveCorrection receives {data:null,error:null} and returns saved. It discards data entirely. Validate the canonical review-batch success receipt (including expected batch/count fields); absent, malformed, unrelated or incomplete success content must remain unknown, preserve the request identity and allow server-idempotent reconciliation. Do not strengthen this by guessing that a failed read means nothing was saved.

Additional scope to inspect while fixing the first issue: pending session storage is keyed by upload/account, but the server idempotency key is scoped by upload/firm_member/request ID. Ensure an uncertain attempt cannot be silently restored as another signed-in actor's attempt. This actor-switch scenario has not been executed in this review.

Required after corrections: failing-before/passing-after component tests and final-head CI. Do not change authority rules or silently repair hosted mappings. Send this report and reproducer to Claude; do not expand #201.

### Reproduction

Copy the following into src/components/workspace/AccountCorrection.review.test.ts on the reviewed #202 head and run the repository Vitest runner for that file. Both assertions express required safe behavior and currently fail. Uses a fake transport; no hosted data or provider calls.

```ts
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
```

## #203 — initial 4c221d63, corrected in this candidate

The initial cross-page evidence link had a valid href but no scroll/focus handler after asynchronously loaded content. Fixed with a root-scoped, two-target allowlist effect after successful reads, focusable section targets and two interaction tests. Earlier CI run 40290965670 clears only the original head. New exact-head CI is required.

This remains a presentation mitigation: server automatic applicability can still report not_applicable while composition is incomplete. Existing readiness blockers remain; no authoritative server status is rewritten. The server contract fix remains a separate forward-migration proposal. Desktop sticky rendering/real-browser scroll needs visual acceptance; mocked scrollIntoView tests demonstrate effect dispatch, not browser geometry.
