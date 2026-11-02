import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase, applyChain, makeWorld, uuid } from './lib/reportingKit.mjs';
const db = await openDatabase('qbo_readiness');
let passed=0;
const check = async (label,fn) => { await fn(); passed++; console.log('PASS',label); };
try {
 assert.equal(await applyChain(db),null);
 const w=await makeWorld(db);
 const baseline=await db.one("select (select count(*) from public.qbo_pulls) pulls,(select count(*) from public.fs_publication_bindings) bindings,(select count(*) from public.reporting_pack_issuances) packs");
 await db.admin.query(fs.readFileSync('release/candidates/qbo-readiness-r2/20261214100000_qbo_readiness_controls.sql','utf8'));
 await check('history unchanged',async()=>assert.deepEqual(await db.one("select (select count(*) from public.qbo_pulls) pulls,(select count(*) from public.fs_publication_bindings) bindings,(select count(*) from public.reporting_pack_issuances) packs"),baseline));
 const svc=(s,p=[])=>db.asService(s,p);
 const env='v1.k1.'+'a'.repeat(20)+'.'+'b'.repeat(50);
 const store=async()=> (await svc("select public.qbo_store_connection($1,$2,'123','sandbox',$3,now()+interval '100 days',null) id",[w.A,w.U.owner,env])).id;
 const id=await store(); const rid=uuid();
 const lease=(await svc('select public.qbo_acquire_refresh_lease($1,$2,90) id',[id,env])).id;
 await check('cross tenant denied',async()=>assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.ownerB,rid])).r.outcome,'forbidden'));
 await check('disconnect waits for import',async()=>assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r.outcome,'busy'));
 const next='v1.k1.'+'c'.repeat(20)+'.'+'d'.repeat(50);
 await check('rotation retains full-import lease',async()=>{assert.equal((await svc("select public.qbo_rotate_refresh_token($1,$2,$3,now()+interval '100 days',null) r",[id,env,next])).r,true);assert.equal((await db.one('select refresh_lease_id from public.qbo_connections where id=$1',[id])).refresh_lease_id,lease);});
 await svc('select public.qbo_release_refresh_lease($1,$2)',[id,lease]);
 await check('terminal local state and encrypted pending revoke',async()=>{const r=(await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r;assert.equal(r.outcome,'pending');const row=await db.one('select status,refresh_token_envelope from public.qbo_connections where id=$1',[id]);assert.equal(row.status,'disconnected');assert.equal(row.refresh_token_envelope,null);});
 await check('same request replay and wrong request conflict',async()=>{assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r.outcome,'pending');assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,uuid()])).r.outcome,'request_conflict');});
 await check('disconnected token cannot rotate or lease',async()=>{assert.equal((await svc("select public.qbo_rotate_refresh_token($1,$2,$3,now()+interval '100 days',null) r",[id,next,env])).r,false);assert.equal((await svc('select public.qbo_acquire_refresh_lease($1,$2,90) r',[id,next])).r,null);});
 await check('pending revoke blocks reconnect',async()=>assert.rejects(store,/QBO_REVOKE_PENDING/));
 await check('clients cannot read pending envelope or call writers',async()=>{for(const role of ['anon','authenticated']){await assert.rejects(()=>db.asRole(role,w.U.owner,'select * from public.qbo_disconnect_operations'),/permission denied/);await assert.rejects(()=>db.asRole(role,w.U.owner,'select public.qbo_begin_disconnect($1,$2,$3)',[id,w.U.owner,rid]),/permission denied/);}});
 await check('ack deletes pending token and is retry-safe',async()=>{assert.equal((await svc('select public.qbo_finish_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r,true);assert.equal((await svc('select public.qbo_finish_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r,true);assert.equal((await db.one('select pending_envelope from public.qbo_disconnect_operations where connection_id=$1',[id])).pending_envelope,null);});
 await check('reconnect creates new identity, never resurrects disconnected',async()=>{const fresh=await store();assert.notEqual(fresh,id);assert.equal((await db.one('select status from public.qbo_connections where id=$1',[id])).status,'disconnected');});
 const scope = (await db.asUser(w.U.owner,"select * from public.open_engagement_with_period($1,'2026-01-01','2026-12-31','USD',ARRAY['FINANCIAL_STATEMENTS'],NULL,NULL,NULL)",[w.A]));
 const p=(await db.one("select id from public.fiscal_periods where company_id=$1 and reporting_end='2026-12-31'",[w.A])).id;
 await check('saved period is tenant scoped and client year cannot override',async()=>{
  assert.equal((await svc('select public.qbo_saved_period($1,$2,$3,2026,null) r',[w.U.ownerB,w.A,p])).r,null);
  assert.equal((await svc('select public.qbo_saved_period($1,$2,$3,2025,null) r',[w.U.owner,w.A,p])).r,null);
  assert.equal((await svc('select public.qbo_saved_period($1,$2,$3,2026,null) r',[w.U.owner,w.A,p])).r.start,'2026-01-01');
 });
 const fresh=(await db.one("select id from public.qbo_connections where company_id=$1 and status='active'",[w.A])).id;
 const activeLease=(await svc('select public.qbo_acquire_refresh_lease($1,$2,90) id',[fresh,env])).id;
 await check('obsolete lease cannot rotate a later worker token',async()=>{
  assert.equal((await svc("select public.qbo_rotate_leased_token($1,$2,$3,$4,now()+interval '100 days',null) r",[fresh,uuid(),env,next])).r,false);
  assert.equal((await svc("select public.qbo_rotate_leased_token($1,$2,$3,$4,now()+interval '100 days',null) r",[fresh,activeLease,env,next])).r,true);
 });
 const reservation=(await db.asUser(w.U.owner,"select * from public.reserve_trial_balance_source($1,'quickbooks.csv')",[w.A])).reservation_id;
 const basis={kind:'fiscal-ytd-as-of',fiscalStartMonth:1,fiscalStart:'2026-01-01',asOf:'2026-12-31',currency:'USD',accountingMethod:'Accrual',preferencesSha256:'a'.repeat(64)};
 const args=[p,JSON.stringify(basis),reservation,fresh,w.U.owner,'123','sandbox','2026-01-01','2026-12-31','Accrual',75,'USD',45,'b'.repeat(64),'c'.repeat(64),'d'.repeat(64)];
 const record='select public.qbo_record_fiscal_pull_intent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) r';
 await check('fiscal provenance written once; changed fiscal facts fail',async()=>{
  const a=await svc(record,args);const b=await svc(record,args);assert.equal(a.r,b.r);
  const forged=[...args];forged[1]=JSON.stringify({...basis,fiscalStartMonth:7});await assert.rejects(()=>svc(record,forged),/QBO_FISCAL_BASIS_MISMATCH/);
  assert.equal((await db.one('select count(*)::int n from public.qbo_fiscal_pull_basis where reservation_id=$1',[reservation])).n,1);
 });
 await check('no registered upload after disconnect wins fence',async()=>{
  await svc('select public.qbo_release_refresh_lease($1,$2)',[fresh,activeLease]);
  await svc('select public.qbo_begin_disconnect($1,$2,$3)',[fresh,w.U.owner,uuid()]);
  const path=(await db.one('select object_path from public.trial_balance_source_reservations where id=$1',[reservation])).object_path;
  await assert.rejects(()=>db.admin.query("insert into public.trial_balance_uploads(file_name,file_path,file_size,status,user_id,company_id,period_year,period_id) values('quickbooks.csv',$1,100,'pending',$2,$3,2026,$4)",[path,w.U.owner,w.A,p]),/QBO_CONNECTION_UNAVAILABLE/);
  assert.equal((await db.one('select count(*)::int n from public.trial_balance_uploads where file_path=$1',[path])).n,0);
 });
 console.log(`QBO_READINESS ${passed}/${passed} passed (disposable PostgreSQL; no Intuit)`);
} finally { await db.close(); }
