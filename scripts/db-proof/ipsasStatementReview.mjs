// Full native PostgreSQL proof; synthetic operator setup and real processing. Never a hosted database.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { openDatabase, applyChainBefore, makeWorld, certifier, csv, FY2025, FY2026, uuid, reporter, REPO } from "./lib/reportingKit.mjs";
import { PROOF, CASES } from "./ipsasStatementReview.manifest.mjs";
import { BATCHES, BOOTSTRAP_PREDECESSOR, artifactBytes, renderBootstrap, renderApply, renderStage, transportForms, PRESERVED_TABLES } from "../release/ipsasStatementReviewStagedTransport.mjs";
const resultFile=process.env.PROOF_RESULT_FILE ?? path.join(REPO,"proof-results",`${PROOF}.present.json`);
const manifestSha256=crypto.createHash("sha256").update(fs.readFileSync(new URL("./ipsasStatementReview.manifest.mjs",import.meta.url))).digest("hex");
const {check,finish}=reporter(), recorded=[], startedAt=new Date().toISOString();
let db, crashed=false, crashMessage=null;
const expectRefusal=async f=>{try{await f();return false;}catch(e){return e.code==="42501";}};
async function transportRefusal(sql,fragment){try{await db.admin.query(sql);return false;}catch(e){return String(e.message).includes(fragment);}}
const catalogue=async()=>JSON.stringify((await db.admin.query(`SELECT v FROM (
 SELECT 'relation:'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity||':'||coalesce(c.relacl::text,'') v FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ipsas_presentation_%'
 UNION ALL SELECT 'column:'||c.relname||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||a.attidentity::text||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ipsas_presentation_%' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'constraint:'||c.relname||':'||k.conname||':'||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ipsas_presentation_%'
 UNION ALL SELECT 'index:'||indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='ipsas_presentation_revisions'
 UNION ALL SELECT 'trigger:'||pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid='public.ipsas_presentation_revisions'::regclass AND NOT t.tgisinternal
 UNION ALL SELECT 'function:'||p.proname||':'||pg_get_function_identity_arguments(p.oid)||':'||p.prosecdef||':'||p.provolatile::text||':'||coalesce(p.proacl::text,'')||':'||coalesce(p.proconfig::text,'')||':'||md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('_ipsas_statement_captions','_ipsas_statement_review_compute','ipsas_statement_review','ipsas_save_presentation')
 ) q ORDER BY v`)).rows);
const preservedTables=async()=>{const o={};for(const table of PRESERVED_TABLES)o[table]=(await db.one(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) v FROM public.${table} t`)).v;return JSON.stringify(o);};
async function kase(id,fn){if(!CASES.some(c=>c.id===id)||recorded.some(c=>c.id===id))throw Error(`Invalid proof identity ${id}`);let ok=false,detail="";await check(id,async()=>{try{const r=await fn();ok=r===true;detail=ok?"":JSON.stringify(r);return r;}catch(e){detail=`${e.code??""}: ${e.message}`;throw e;}});recorded.push({id,outcome:ok?"pass":"fail",...(detail?{detail}: {})});}
const captions={1000:"cash",1100:"receivables_current",1200:"inventories",1500:"ppe",1510:"ppe",2000:"payables",2100:"other_liabilities_current",2500:"borrowings_non_current",3000:"contributed_capital",3100:"accumulated",4000:"fees",4100:"investment_income",5000:"supplies",6000:"employees",6100:"supplies",6200:"depreciation",6300:"finance",7000:"other_expenses"};
// Bounded polling observes the actual wait in pg_stat_activity; timeout is a failing proof, never a guessed sleep.
async function waitForLock(pid){for(let i=0;i<100;i++){const row=await db.one("SELECT wait_event_type t FROM pg_stat_activity WHERE pid=$1",[pid]);if(row?.t==="Lock")return;await new Promise(r=>setTimeout(r,20));}throw Error("Request did not enter the expected lock wait");}
async function session(uid){const c=await db.pool.connect();await c.query("BEGIN");await c.query("SET LOCAL statement_timeout='15s'");await c.query("SET LOCAL ROLE authenticated");await c.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[uid]);return c;}
try{
 db=await openDatabase("ipsas_statement_review");
 await kase("setup.chain",async()=>{const f=await applyChainBefore(db,BATCHES[0].source);return f?{chainFailure:f}:true;});
 const W=await makeWorld(db),{U}=W,A=await W.company(U.owner,"Synthetic IPSAS review","ipsas_accrual");
 for(const k of ["preparer","partner","viewer"])await db.admin.query("INSERT INTO public.firm_members(company_id,user_id,role,accepted_at) VALUES($1,$2,$3,now())",[A,U[k],k]);
 await W.rollout(A,true);
 const k=await certifier(db,U);
 const read=async(uid=U.preparer,company=A)=>(await db.asUser(uid,"SELECT public.ipsas_statement_review($1,2026) r",[company])).r;
 const assignments=r=>r.accounts.map(a=>({period:a.period,accountKey:a.accountKey,captionId:captions[a.accountKey],zeroDisposition:null,reason:null}));
 const intent=r=>({scope:r,choices:assignments(r),request:uuid()});
 const save=async(i,uid=U.preparer)=>(await db.asUser(uid,"SELECT public.ipsas_save_presentation($1,2026,$2::jsonb,$3,$4,$5) r",[A,JSON.stringify(i.choices),i.scope.revisionId,i.scope.inputSha256,i.request])).r;
 const count=()=>db.count("SELECT count(*)::int n FROM public.ipsas_presentation_revisions");
 const preserved=async()=>JSON.stringify((await db.admin.query(`SELECT 'companies' kind,to_jsonb(t) row FROM public.companies t WHERE id=$1 UNION ALL SELECT 'publication',to_jsonb(t) FROM public.financial_statement_publications t UNION ALL SELECT 'reports',to_jsonb(t) FROM public.financial_statement_reports t WHERE company_id=$1 ORDER BY 1,2`,[W.A])).rows);
 const before=await preserved(); let firstIntent,firstReceipt;
 await db.admin.query("CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations(id integer PRIMARY KEY,hash text NOT NULL)");
 await kase("transport.wrong-predecessor",async()=>await transportRefusal(renderBootstrap(),"WRONG_PREDECESSOR"));
 await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES($1,$2)",[BOOTSTRAP_PREDECESSOR.id,BOOTSTRAP_PREDECESSOR.hashes[0]]);
 const forms=transportForms();
 await db.admin.query(renderBootstrap());await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES($1,$2)",[BOOTSTRAP_PREDECESSOR.id+1,forms[0].hashes[0]]);
 await kase("transport.missing-stage",async()=>await transportRefusal(renderApply(0),"IPSAS_STATEMENT_TRANSPORT_UNCERTAIN_STAGE"));
 await kase("transport.exact-install-and-catalogue",async()=>{
   let direct;await db.admin.query("BEGIN");try{await db.admin.query("SET LOCAL search_path=pg_catalog,public");await db.admin.query(artifactBytes(0,"source").toString("utf8"));direct=await catalogue();}finally{await db.admin.query("ROLLBACK");}
   const preservedBefore=await preservedTables();await db.admin.query(renderStage(0,"source"));
   await db.admin.query("BEGIN");try{await db.admin.query(renderApply(0));await db.admin.query("INSERT INTO drizzle.__drizzle_migrations VALUES($1,$2)",[BOOTSTRAP_PREDECESSOR.id+2,forms[1].hashes[0]]);await db.admin.query("COMMIT");}catch(e){await db.admin.query("ROLLBACK");throw e;}
   // Deparse under the same path as the direct reference; stored function bodies and ACLs must match.
   await db.admin.query("BEGIN");let installed;try{await db.admin.query("SET LOCAL search_path=pg_catalog,public");installed=await catalogue();}finally{await db.admin.query("ROLLBACK");}
   return direct===installed&&preservedBefore===await preservedTables();
 });
 await kase("transport.replay-refused",async()=>await transportRefusal(renderApply(0),"WRONG_PREDECESSOR"));
 await kase("setup.certified-periods",async()=>{for(const [y,col]of [[2025,FY2025],[2026,FY2026]]){const u=await k.upload(A,y,csv(col));if(y===2025)await k.review(A,u);await k.certify(A,u);}return(await read()).accounts.length===36;});
 await kase("auth.privileges",async()=>{
  const r=await db.one("SELECT has_function_privilege('authenticated','public.ipsas_statement_review(uuid,integer)','EXECUTE') a,has_function_privilege('anon','public.ipsas_statement_review(uuid,integer)','EXECUTE') b,has_function_privilege('service_role','public.ipsas_statement_review(uuid,integer)','EXECUTE') c,has_function_privilege('authenticated','public._ipsas_statement_review_compute(uuid,integer)','EXECUTE') d");
  return r.a&&!r.b&&!r.c&&!r.d&&await expectRefusal(()=>db.asUser(U.owner,"SELECT * FROM public.ipsas_presentation_revisions"));
 });
 await kase("auth.roles-and-tenants",async()=>{const v=await read(U.viewer),o=await read(U.ownerB),x=await read(U.owner,A);return v.outcome==="forbidden"&&o.outcome==="forbidden"&&x.outcome==="available"&&await expectRefusal(()=>db.asRole("anon",null,"SELECT public.ipsas_statement_review($1,2026)",[A]))&&await expectRefusal(()=>db.asService("SELECT public.ipsas_statement_review($1,2026)",[A]));});
 await kase("auth.framework-rollout",async()=>{await W.rollout(W.A,true);const s=await read(U.owner,W.A);await W.rollout(A,false);const off=await read();await W.rollout(A,true);return s.outcome==="framework_not_ipsas_accrual"&&off.outcome==="feature_disabled";});
 await kase("auth.reviewer-read-without-prepare",async()=>{await db.asUser(U.owner,"SELECT public.revoke_member_capability($1,$2,'prepare_close','Proof review-only access')",[A,U.partner]);try{const r=await read(U.partner);return r.outcome==="available"&&(await save(intent(r),U.partner)).outcome==="forbidden";}finally{await db.asUser(U.owner,"SELECT public.grant_member_capability($1,$2,'prepare_close','Proof restore')",[A,U.partner]);}});
 await kase("read.incomplete-is-not-zero",async()=>{const r=await read();return r.totals.current.state==="incomplete"&&r.totals.current.assetsMinor===null&&r.lines.every(l=>l.currentMinor===null);});
 await kase("save.presentation-and-hand-totals",async()=>{firstIntent=intent(await read());firstReceipt=await save(firstIntent);const r=await read();return firstReceipt.outcome==="recorded"&&r.totals.current.assetsMinor==="3300000"&&r.totals.current.liabilitiesMinor==="1200000"&&r.totals.current.surplusMinor==="510000"&&r.totals.current.netAssetsMinor==="2100000"&&r.totals.current.balanceDifferenceMinor==="0";});
 await kase("read.contra-and-provenance",async()=>{const r=await read(),ppe=r.lines.find(l=>l.id==="ppe"),contra=r.accounts.find(a=>a.period==="current"&&a.accountKey==="1510");return ppe.currentMinor==="1400000"&&ppe.comparativeMinor==="1600000"&&contra.creditMinor==="600000"&&contra.certifiedCreditMinor==="600000"&&Array.isArray(contra.adjustmentIds);});
 await kase("read.prior-reference-only",async()=>{const r=await read();return r.comparative.usable&&r.comparative.label.includes("reference only")&&r.totals.comparative.assetsMinor==="2880000"&&r.totals.comparative.netAssetsMinor==="1660000";});
 await kase("save.invalid-fields-and-caption",async()=>{const i=intent(await read());i.choices[0].amountMinor="999";const forged=await save(i);delete i.choices[0].amountMinor;i.request=uuid();i.choices.find(a=>a.accountKey==="1000").captionId="borrowings_current";return forged.outcome==="invalid_request"&&(await save(i)).outcome==="incompatible_caption";});
 await kase("save.duplicate-unknown-and-stale",async()=>{const i=intent(await read());i.choices.push(i.choices[0]);const dup=await save(i);i.choices.pop();i.request=uuid();i.choices[0].accountKey="unknown";const unknown=await save(i);const stale=await save({...firstIntent,request:uuid()});return dup.outcome==="duplicate_account"&&unknown.outcome==="unknown_account"&&stale.outcome==="stale";});
 await kase("save.same-request-replay",async()=>{const n=await count();const r=await save(firstIntent);return r.replay&&r.revisionId===firstReceipt.revisionId&&await count()===n;});
 await kase("save.changed-intent-refused",async()=>{const i=structuredClone(firstIntent);i.choices=[];return(await save(i)).outcome==="request_reused";});
 await kase("save.concurrent-request",async()=>{const i=intent(await read()),n=await count(),r=await Promise.all(Array.from({length:10},()=>save(i)));return r.every(x=>x.outcome==="recorded")&&new Set(r.map(x=>x.revisionId)).size===1&&await count()===n+1;});
 await kase("save.concurrent-revision",async()=>{const r=await read(),n=await count(),results=await Promise.all(Array.from({length:10},()=>save(intent(r))));return results.filter(x=>x.outcome==="recorded").length===1&&results.filter(x=>x.outcome==="stale").length===9&&await count()===n+1;});
 await kase("source.approved-adjustment-invalidates",async()=>{
  const old=await read();const p=(await db.asUser(U.preparer,"SELECT public.close_review_propose_adjustment($1,2026,'Synthetic rent accrual supported by invoice',NULL,$2::jsonb,'{}'::uuid[],$3,NULL) r",[A,JSON.stringify([{accountKey:"6100",debitMinor:"30000",creditMinor:"0"},{accountKey:"2000",debitMinor:"0",creditMinor:"30000"}]),uuid()])).r;
  const d=(await db.asUser(U.partner,"SELECT public.close_review_decide_adjustment($1,'approve','Invoice and lease checked',NULL,$2) r",[p.adjustmentId,uuid()])).r;
  const r=await read();return d.outcome==="recorded"&&!r.assignmentsCurrent&&r.totals.current.assetsMinor===null&&r.sourceSha256!==old.sourceSha256&&(await save(intent(old))).outcome==="stale";
 });
 await kase("source.adjusted-versus-certified",async()=>{await save(intent(await read()));const r=await read(),rent=r.accounts.find(a=>a.period==="current"&&a.accountKey==="6100");return rent.debitMinor==="270000"&&rent.certifiedDebitMinor==="240000"&&rent.adjustmentIds.length===1&&r.totals.current.surplusMinor==="480000"&&r.totals.current.netAssetsMinor==="2070000";});
 await kase("auth.revocation-before-admission",async()=>{
  const i=intent(await read()),n=await count(),revoker=await session(U.owner),writer=await session(U.preparer);
  try{
   await revoker.query("SELECT public.revoke_member_capability($1,$2,'prepare_close','Proof revocation before admission')",[A,U.preparer]);
   const pid=(await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   const waiting=writer.query("SELECT public.ipsas_save_presentation($1,2026,$2::jsonb,$3,$4,$5) r",[A,JSON.stringify(i.choices),i.scope.revisionId,i.scope.inputSha256,i.request]);
   await waitForLock(pid);await revoker.query("COMMIT");const r=(await waiting).rows[0].r;await writer.query("COMMIT");return r.outcome==="forbidden"&&await count()===n;
  }finally{await revoker.query("ROLLBACK");await writer.query("ROLLBACK");revoker.release();writer.release();await db.asUser(U.owner,"SELECT public.grant_member_capability($1,$2,'prepare_close','Proof restore')",[A,U.preparer]);}
 });
 await kase("auth.admitted-write-before-revocation",async()=>{
  const i=intent(await read()),blocker=await db.pool.connect(),writer=await session(U.preparer),revoker=await session(U.owner);
  try{
   // Test-only insert barrier: the writer has passed the actual authority boundary before waiting here.
   await db.admin.query("CREATE FUNCTION public.__ipsas_review_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('ipsas_review_test_boundary',0)); RETURN NEW; END $$; REVOKE ALL ON FUNCTION public.__ipsas_review_test_barrier() FROM PUBLIC,anon,authenticated,service_role; CREATE TRIGGER ipsas_review_test_barrier BEFORE INSERT ON public.ipsas_presentation_revisions FOR EACH ROW EXECUTE FUNCTION public.__ipsas_review_test_barrier()");
   await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('ipsas_review_test_boundary',0))");
   const wpid=(await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   const write=writer.query("SELECT public.ipsas_save_presentation($1,2026,$2::jsonb,$3,$4,$5) r",[A,JSON.stringify(i.choices),i.scope.revisionId,i.scope.inputSha256,i.request]);await waitForLock(wpid);
   const rpid=(await revoker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
   const revoke=revoker.query("SELECT public.revoke_member_capability($1,$2,'prepare_close','Proof revoke admitted writer')",[A,U.preparer]);await waitForLock(rpid);
   await blocker.query("COMMIT");const r=(await write).rows[0].r;await writer.query("COMMIT");await revoke;await revoker.query("COMMIT");return r.outcome==="recorded"&&(await save(i)).outcome==="forbidden";
  }finally{await blocker.query("ROLLBACK");await writer.query("ROLLBACK");await revoker.query("ROLLBACK");blocker.release();writer.release();revoker.release();await db.admin.query("DROP TRIGGER IF EXISTS ipsas_review_test_barrier ON public.ipsas_presentation_revisions; DROP FUNCTION IF EXISTS public.__ipsas_review_test_barrier()");await db.asUser(U.owner,"SELECT public.grant_member_capability($1,$2,'prepare_close','Proof restore')",[A,U.preparer]);}
 });
 await kase("auth.strict-isolation-refused",async()=>{const i=intent(await read()),c=await db.pool.connect();try{await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ");await c.query("SET LOCAL ROLE authenticated");await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[U.preparer]);try{await c.query("SELECT public.ipsas_save_presentation($1,2026,$2::jsonb,$3,$4,$5)",[A,JSON.stringify(i.choices),i.scope.revisionId,i.scope.inputSha256,i.request]);return false;}catch(e){return e.code==="PT412"&&e.message==="READ_COMMITTED_REQUIRED";}}finally{await c.query("ROLLBACK");c.release();}});
 await kase("history.append-only",async()=>{const before=await count();try{await db.admin.query("DELETE FROM public.ipsas_presentation_revisions WHERE company_id=$1",[A]);return false;}catch(e){return e.code==="42501"&&String(e.message).includes("IPSAS_PREPARATION_IMMUTABLE")&&await count()===before;}});
 await kase("preserve.sme-and-publications",async()=>before===await preserved());
 await kase("read.never-issuable",async()=>{const r=await read();return r.officialIssuance.available===false&&r.officialIssuance.reasons.length>=3;});
 if(!finish("IPSAS_STATEMENT_REVIEW",false))process.exitCode=1;
}catch(e){crashed=true;crashMessage=String(e.message);process.exitCode=1;console.error(crashMessage);}
finally{if(db)await db.close();fs.mkdirSync(path.dirname(resultFile),{recursive:true});fs.writeFileSync(resultFile,JSON.stringify({proof:PROOF,mode:"present",manifestSha256,startedAt,finishedAt:new Date().toISOString(),completed:!crashed&&recorded.length===CASES.length,crashed,crashMessage,cases:recorded},null,2)+"\n");}
