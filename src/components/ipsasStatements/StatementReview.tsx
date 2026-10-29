import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { TaskEditContext } from "@/components/account/taskEditState";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { formatMinorAmount } from "@/lib/presentation/amounts";
import { statementClient, choicesFrom, refusalMessage, recoverIntent, storeIntent, recoveryKey, type StatementReview as Review, type Assignment, type SaveIntent } from "@/lib/ipsasStatements/client";

type Props = { companyId: string; periodYear: number; actorId: string | null; canPrepare: boolean; db: Pick<ReportingDb,"rpc"> };
const encoded = (a: Assignment[]) => JSON.stringify(a);
export function StatementReview(props: Props) {
  const { companyId, periodYear, actorId, canPrepare, db } = props;
  const client = useMemo(() => statementClient(db), [db]);
  const scope = `${actorId ?? "signed-out"}:${companyId}:${periodYear}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const epoch = useRef(0), readSequence = useRef(0), mounted = useRef(false);
  const [serverView, setView] = useState<Review | null>(null), [draft, setDraft] = useState<Assignment[]>([]);
  const viewScope = useRef<string | null>(null);
  const view = viewScope.current === scope ? serverView : null;
  const draftRef = useRef(draft); draftRef.current = draft;
  const baseline = useRef("[]"), base = useRef<Review | null>(null), pending = useRef<SaveIntent | null>(null);
  const [busy,setBusy] = useState(false), busyRef = useRef(false), [uncertain,setUncertain] = useState(false);
  const [message,setMessage] = useState("Loading server-computed statements…"), [refreshQuestion,setRefreshQuestion] = useState(false);
  const [trace,setTrace] = useState<string | null>(null);
  const dirty = encoded(draft) !== baseline.current;
  const register = useContext(TaskEditContext)?.register;
  const invalidate = useCallback(() => { epoch.current++; readSequence.current++; },[]);
  const live = useCallback((e: number, s: string) => mounted.current && epoch.current === e && scopeRef.current === s, []);
  const install = (r: Review, reset: boolean) => {
    viewScope.current=scopeRef.current;
    setView(r);
    if (reset) { const next = choicesFrom(r); baseline.current=encoded(next); draftRef.current=next; setDraft(next); base.current=r; }
  };
  const refresh = useCallback(async () => {
    const mine=epoch.current, s=scope, request=++readSequence.current;
    if (!actorId) { setView(null); setMessage("Sign in to review statements."); return; }
    setMessage("Refreshing figures from the server…");
    try {
      const r=await client.read(companyId,periodYear);
      if (!live(mine,s) || request!==readSequence.current) return;
      if (r.outcome!=="available") { setView(null); setMessage(refusalMessage(r.outcome)); return; }
      install(r as Review,true); setMessage("Showing the server's saved figures. This is an incomplete draft.");
    } catch(e) { if(live(mine,s) && request===readSequence.current) { setView(null); setMessage(e instanceof Error ? e.message : "Statements could not be read."); } }
  },[actorId,companyId,periodYear,scope,client,live]);
  useEffect(() => {
    mounted.current=true; invalidate();
    setView(null); setDraft([]); baseline.current="[]"; base.current=null; pending.current=null; busyRef.current=false; setBusy(false); setUncertain(false); setTrace(null); setRefreshQuestion(false);
    if(actorId) { try { const recovered=recoverIntent(sessionStorage,actorId,companyId,periodYear); if(recovered) { pending.current=recovered; setUncertain(true); } } catch { /* blocked browser storage is not a page failure */ } }
    void refresh();
    return () => { mounted.current=false; invalidate(); };
  },[scope,refresh,actorId,companyId,periodYear,invalidate]);
  useEffect(() => {
    const id=`ipsas-statements:${scope}`;
    register?.(id,{dirty:dirty || uncertain,busy,discard:() => { if(base.current) { const a=choicesFrom(base.current); draftRef.current=a; setDraft(a); } }});
    return () => register?.(id,null);
  },[scope,dirty,uncertain,busy,register]);

  const send = async (intent: SaveIntent) => {
    if(!actorId || busyRef.current || !canPrepare) return;
    const mine=epoch.current,s=scope, submitted=encoded(intent.assignments), wasUnknown=uncertain;
    busyRef.current=true; setBusy(true); pending.current=intent; setUncertain(false);
    let recoverable=false; try { recoverable=storeIntent(sessionStorage,actorId,intent); } catch { /* storage getter can itself be refused */ }
    setMessage(recoverable ? "Saving presentation choices…" : "Saving choices. Recovery storage is unavailable; keep this page open until the answer arrives.");
    try {
      const receipt=await client.save(intent);
      if(!live(mine,s)) return;
      if(receipt.outcome!=="recorded") {
        setMessage(refusalMessage(receipt.outcome));
        // An original unknown attempt may have committed even if current access now refuses its replay.
        const unresolved=wasUnknown && !["stale","incompatible_caption","unknown_account","unknown_caption","duplicate_account","invalid_zero_disposition"].includes(receipt.outcome);
        setUncertain(unresolved);
        if(!unresolved) { pending.current=null; try { sessionStorage.removeItem(recoveryKey(actorId,companyId,periodYear)); } catch { /* no storage */ } }
        return;
      }
      try { sessionStorage.removeItem(recoveryKey(actorId,companyId,periodYear)); } catch { /* receipt remains authoritative */ }
      pending.current=null; setUncertain(false); setMessage("Presentation choices saved. Refreshing the server's statement figures…");
      const sequence=++readSequence.current;
      const r=await client.read(companyId,periodYear);
      if(!live(mine,s) || sequence!==readSequence.current) return;
      if(r.outcome!=="available") { setView(null); setMessage(`Your choices were saved. ${refusalMessage(r.outcome)}`); return; }
      const next=r as Review, unchanged=encoded(draftRef.current)===submitted;
      install(next,unchanged);
      if(!unchanged && next.revisionId===receipt.revisionId) { base.current=next; baseline.current=submitted; }
      setMessage(!unchanged ? "Your submitted choices were saved. Newer edits are still unsaved and have been kept." : "Saved. The figures below were recomputed by the server.");
    } catch(e) {
      if(live(mine,s)) { setUncertain(pending.current!==null); setMessage(pending.current ? "We could not confirm whether the choices were saved. Send the same request again; newer edits will be kept." : "Your choices were saved, but the refreshed figures could not be read. Refresh to see the server's latest version."); }
    } finally { if(live(mine,s)) { busyRef.current=false; setBusy(false); } }
  };
  const save = () => {
    const b=base.current;
    if(!b || busyRef.current || uncertain) return;
    void send({companyId,periodYear,assignments:structuredClone(draftRef.current),expectedRevision:b.revisionId,expectedInput:b.inputSha256,requestId:crypto.randomUUID()});
  };
  const update = (i: number, selection: string) => setDraft(a => { const next=a.map((v,j)=>i===j?{...v,captionId:selection.startsWith("zero:")?null:selection || null,zeroDisposition:selection.startsWith("zero:")?selection.slice(5) as Assignment["zeroDisposition"]:null,reason:null}:v);draftRef.current=next;return next; });
  const amount = (v: string | null) => v===null ? "Not composed" : formatMinorAmount(BigInt(v),view!.current.exponent);
  const unresolved=view?.accounts.filter(a=>!["presented","reviewed_zero"].includes(a.status)).length ?? 0;
  return <section id="ipsas-statements" aria-labelledby="ipsas-statements-title" className="mt-8 space-y-4 border-t pt-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="ipsas-statements-title" className="text-xl font-semibold">Statements and presentation</h2>
      <Button variant="outline" disabled={busy} onClick={()=>{if(dirty || uncertain)setRefreshQuestion(true);else void refresh();}}>Refresh statements</Button></div>
    <p role="status" aria-live="polite">{message}</p>
    {refreshQuestion && <div role="alert" className="rounded-md border p-3"><p>Refreshing will replace unsaved choices with the server's version. An unconfirmed save is not cancelled.</p>
      <Button variant="outline" onClick={()=>setRefreshQuestion(false)}>Keep editing</Button><Button variant="outline" disabled={busy} onClick={()=>{setRefreshQuestion(false);void refresh();}}>Discard edits and refresh</Button></div>}
    {uncertain && pending.current && <div role="alert"><p>An earlier save is unconfirmed. Matching figures on screen are not proof of its receipt.</p><Button disabled={busy || !canPrepare} onClick={()=>void send(pending.current!)}>Send the same request again</Button></div>}
    {view && <>
      <p className="rounded-md border border-amber-500/50 p-3"><strong>Incomplete draft — not approved or issued.</strong> Figures come from the supplied adjusted trial balance; balance alone does not confirm completeness. A post-close TB needs a separate performance ledger. Prior TB amounts are reference-only until the published comparative and transition work are completed.</p>
      <p>{view.current.reportingStart} to {view.current.reportingEnd} · {view.current.currency} · currency units, {view.current.exponent} decimal places.</p>
      {view.totals.current.balanceDifferenceMinor!=="0" && <p role="alert">The adjusted trial balance has an unexplained difference of {amount(view.totals.current.balanceDifferenceMinor)}. <a className="underline" href={`/workspace/${companyId}/${periodYear}/prepare`}>Review the trial balance</a>; no balancing amount is inserted.</p>}
      {!view.comparative.usable && <p role="alert">A comparable prior certified trial balance is unavailable. Confirm the prior period's dates, currency and units. <a className="underline" href={`/workspace/${companyId}/${periodYear-1}/prepare`}>Open prior-year preparation</a>.</p>}
      {view.adjustmentsRequiringRevalidation>0 && <p role="alert">Some adjustments need revalidation against the current trial balance. <a className="underline" href={`/workspace/${companyId}/${periodYear}/prepare`}>Review the trial balance and adjustments</a>.</p>}
      <details open={unresolved>0}><summary>Presentation choices — {unresolved} accounts need confirmation</summary>
        <p>Choose the caption for each reviewed account. No caption is guessed from its name. Change an incorrect classification in Account review first. Zero-balance accounts can also carry movements or disclosures.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="text-left">Current and prior certified accounts</caption><thead><tr><th>Period / account</th><th>Debit</th><th>Credit</th><th>Statement caption</th></tr></thead><tbody>
          {view.accounts.map((a,i)=><tr key={`${a.period}:${a.accountKey}`}><th scope="row" className="p-2 text-left">{a.period}: {a.accountKey} — {a.accountName}<span className="block font-normal">{a.classification}</span></th><td>{amount(a.debitMinor)}</td><td>{amount(a.creditMinor)}</td>
            <td><select aria-label={`Caption for ${a.period} ${a.accountKey}`} className="max-w-xs rounded border bg-background p-2" disabled={!canPrepare} value={draft[i]?.zeroDisposition?`zero:${draft[i].zeroDisposition}`:draft[i]?.captionId ?? ""} onChange={e=>update(i,e.target.value)}><option value="">Choose a caption</option>
              {view.lines.filter(l=>l.section===a.section).map(l=><option key={l.id} value={l.id}>{l.label}</option>)}
              {a.debitMinor===a.creditMinor && <><option value="zero:movement-source-reviewed">Zero balance — movement source reviewed</option><option value="zero:non-reporting-reviewed">Zero balance — no reporting use, reviewed</option></>}
            </select>{draft[i]?.zeroDisposition && <label className="block">Reason and evidence for {a.period} {a.accountKey}<input className="block rounded border bg-background p-2" disabled={!canPrepare} value={draft[i].reason ?? ""} maxLength={2000} onChange={e=>setDraft(v=>{const next=v.map((r,j)=>i===j?{...r,reason:e.target.value}:r);draftRef.current=next;return next;})}/></label>}</td></tr>)}
        </tbody></table></div>
        {canPrepare && <Button disabled={!dirty || busy || uncertain} onClick={save}>{busy?"Saving…":"Save presentation choices"}</Button>}
        <a className="ml-3 underline" href={`/workspace/${companyId}/${periodYear}/prepare`}>Open Account review</a>
      </details>
      {["SFP","SFPERF"].map(statement=><div key={statement} className="overflow-x-auto"><h3 className="font-semibold">{statement==="SFP"?"Statement of financial position":"Statement of financial performance"}</h3>
        <table className="w-full text-sm"><caption className="text-left">Server-computed captions; select a figure to see its source rows.</caption><thead><tr><th>Caption</th><th>Current</th><th>Prior certified TB — reference only</th></tr></thead><tbody>
          {view.lines.filter(l=>l.statement===statement && (view.accounts.some(a=>a.captionId===l.id) || (l.currentMinor!==null && l.currentMinor!=="0") || (l.comparativeMinor!==null && l.comparativeMinor!=="0"))).map(l=><tr key={l.id}><th scope="row" className="p-2 text-left">{l.label}<span className="block font-normal">{l.section}</span></th><td><button aria-label={`Trace current ${l.label}`} disabled={l.currentMinor===null} className="underline" onClick={()=>setTrace(`current:${l.id}`)}>{amount(l.currentMinor)}</button></td><td><button aria-label={`Trace prior ${l.label}`} disabled={l.comparativeMinor===null} className="underline" onClick={()=>setTrace(`comparative:${l.id}`)}>{amount(l.comparativeMinor)}</button></td></tr>)}
          {statement==="SFP" && <tr><th scope="row" className="p-2 text-left">Period surplus / (deficit) included in net assets</th><td>{amount(view.totals.current.surplusMinor)}</td><td>{amount(view.totals.comparative?.surplusMinor ?? null)}</td></tr>}
          {(statement==="SFP"?[["Total assets","assetsMinor"],["Total liabilities","liabilitiesMinor"],["Total net assets/equity","netAssetsMinor"]]:[["Total revenue","revenueMinor"],["Total expenses","expensesMinor"],["Surplus / (deficit)","surplusMinor"]]).map(([label,key])=><tr key={key} className="border-t font-semibold"><th scope="row" className="p-2 text-left">{label}</th><td>{amount(view.totals.current[key as "assetsMinor"])}</td><td>{amount(view.totals.comparative?.[key as "assetsMinor"] ?? null)}</td></tr>)}
        </tbody></table>
      </div>)}
      {trace && <div className="rounded-md border p-3" aria-label="Figure sources"><h3 className="font-semibold">Source of {trace}</h3><Button variant="outline" onClick={()=>setTrace(null)}>Close source details</Button>
        <p>Certification: {trace.startsWith("current:")?view.current.certificationId:String(view.comparative.certificationId ?? "Unavailable")}. Presentation revision: {view.revisionId ?? "None"}.</p>
        <ul>{view.accounts.filter(a=>`${a.period}:${a.captionId}`===trace && a.status==="presented").map(a=><li key={a.accountKey}>{a.accountKey} — {a.accountName}: certified debit {amount(a.certifiedDebitMinor)}, credit {amount(a.certifiedCreditMinor)}; adjusted debit {amount(a.debitMinor)}, credit {amount(a.creditMinor)}. Approved adjustments: {a.adjustmentIds.join(", ") || "none"}.</li>)}</ul>
        {!view.assignmentsCurrent && <p>Choices have not been confirmed for this source revision. No authoritative figure is shown.</p>}
      </div>}
      <div className="rounded-md border p-3"><h3 className="font-semibold">What remains before an official report</h3><ul className="list-disc pl-5">{view.officialIssuance.reasons.map(r=><li key={r}>{r}</li>)}</ul>
        <p>Continue with <a className="underline" href="#ipsas-preparation">equipment and grants preparation</a>. Cash flows require transaction evidence; two trial balances alone do not establish them.</p></div>
      <details><summary>Source version and integrity</summary><p className="break-all">Input: {view.inputSha256}<br/>Composition: {view.compositionSha256}</p></details>
    </>}
  </section>;
}
