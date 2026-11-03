import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase, applyChainBefore, makeWorld, uuid } from './lib/reportingKit.mjs';
const db = await openDatabase('qbo_readiness');
let passed=0;
const check = async (label,fn) => { await fn(); passed++; console.log('PASS',label); };
try {
 const source = '20261214100000_qbo_readiness_controls.sql';
 assert.equal(await applyChainBefore(db, source),null);
 const w=await makeWorld(db);
 const baseline=await db.one("select (select count(*) from public.qbo_pulls) pulls,(select count(*) from public.fs_publication_bindings) bindings,(select count(*) from public.reporting_pack_issuances) packs");
 const sql=fs.readFileSync(`supabase/migrations/${source}`,'utf8');
 await check('canonical envelope rolls back all earlier DDL on late failure',async()=>{
  const broken=sql.replace('\nEND\n$cfoclose_qbo_readiness$',"\nRAISE EXCEPTION 'QBO_PROOF_ROLLBACK';\nEND\n$cfoclose_qbo_readiness$");
  assert.notEqual(broken,sql);
  await assert.rejects(()=>db.admin.query(broken),/QBO_PROOF_ROLLBACK/);
  assert.equal((await db.one("select to_regclass('public.qbo_disconnect_operations') as t")).t,null);
 });
 await db.admin.query(sql);
 await check('accidental replay refuses without changing installed controls',async()=>{
  await assert.rejects(()=>db.admin.query(sql),/already exists/);
  assert.notEqual((await db.one("select to_regclass('public.qbo_disconnect_operations') as t")).t,null);
 });
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
 await check('same request replay and wrong request conflict',async()=>{assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,rid])).r.outcome,'revocation_busy');assert.equal((await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[id,w.U.owner,uuid()])).r.outcome,'request_conflict');});
 await check('disconnected token cannot rotate or lease',async()=>{assert.equal((await svc("select public.qbo_rotate_refresh_token($1,$2,$3,now()+interval '100 days',null) r",[id,next,env])).r,false);assert.equal((await svc('select public.qbo_acquire_refresh_lease($1,$2,90) r',[id,next])).r,null);});
 await check('pending revoke blocks reconnect',async()=>assert.rejects(store,/QBO_REVOKE_PENDING/));
 await check('pending revoke blocks reconnect in a different workspace too',async()=>assert.rejects(()=>svc("select public.qbo_store_connection($1,$2,'123','sandbox',$3,now()+interval '100 days',null)",[w.B,w.U.ownerB,env]),/QBO_REVOKE_PENDING/));
 await check('company deletion cannot strand a pending revocation',async()=>assert.rejects(()=>db.admin.query('delete from public.companies where id=$1',[w.A]),/Disconnect QuickBooks/));
 await check('clients cannot read pending envelope or call writers',async()=>{for(const role of ['anon','authenticated']){await assert.rejects(()=>db.asRole(role,w.U.owner,'select * from public.qbo_disconnect_operations'),/permission denied/);await assert.rejects(()=>db.asRole(role,w.U.owner,'select public.qbo_begin_disconnect($1,$2,$3)',[id,w.U.owner,rid]),/permission denied/);}});
 const revokeLease=(await db.one('select revoke_lease_id from public.qbo_disconnect_operations where connection_id=$1',[id])).revoke_lease_id;
 await check('wrong revocation lease cannot clear token material',async()=>{assert.equal((await svc('select public.qbo_finish_disconnect($1,$2,$3,$4) r',[id,w.U.owner,rid,uuid()])).r,false);assert.notEqual((await db.one('select pending_envelope from public.qbo_disconnect_operations where connection_id=$1',[id])).pending_envelope,null);});
 await check('ack deletes pending token and is retry-safe',async()=>{assert.equal((await svc('select public.qbo_finish_disconnect($1,$2,$3,$4) r',[id,w.U.owner,rid,revokeLease])).r,true);assert.equal((await svc('select public.qbo_finish_disconnect($1,$2,$3,$4) r',[id,w.U.owner,rid,revokeLease])).r,true);assert.equal((await db.one('select pending_envelope from public.qbo_disconnect_operations where connection_id=$1',[id])).pending_envelope,null);});
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
 const basis={operationLeaseId:activeLease,kind:'fiscal-ytd-as-of',fiscalStartMonth:1,fiscalStart:'2026-01-01',asOf:'2026-12-31',currency:'USD',accountingMethod:'Accrual',preferencesSha256:'a'.repeat(64)};
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
 await check('pending retry identities are own actor only and rights checked again',async()=>{
  const pending=await db.asUser(w.U.owner,'select public.qbo_pending_disconnect($1) r',[w.A]);assert.equal(pending.r.connectionId,fresh);
  assert.equal((await db.asUser(w.U.ownerB,'select public.qbo_pending_disconnect($1) r',[w.A])).r,null);
 });
 // Held transaction interleavings: the second actor blocks on the SAME row before it observes final state.
 const racingStore=async()=> (await svc("select public.qbo_store_connection($1,$2,'456','sandbox',$3,now()+interval '100 days',null) id",[w.A,w.U.owner,env])).id;
 const racingId=await racingStore();
 await check('disconnect wins concurrent lease acquisition without resurrection',async()=>{
  const holder=await db.pool.connect();
  try {
   await holder.query('BEGIN'); await holder.query('SET LOCAL ROLE service_role');
   const r=await holder.query('select public.qbo_begin_disconnect($1,$2,$3) r',[racingId,w.U.owner,uuid()]); assert.equal(r.rows[0].r.outcome,'pending');
   let resolved=false;const waiting=svc('select public.qbo_acquire_refresh_lease($1,$2,90) r',[racingId,env]).then(r=>{resolved=true;return r});
   await new Promise(r=>setTimeout(r,100));assert.equal(resolved,false);
   await holder.query('COMMIT');assert.equal((await waiting).r,null);
  } finally {await holder.query('ROLLBACK');holder.release();}
 });
 const other=(await svc("select public.qbo_store_connection($1,$2,'789','sandbox',$3,now()+interval '100 days',null) id",[w.A,w.U.owner,env])).id;
 await check('lease acquisition wins concurrent disconnect and prevents revoke',async()=>{
  const holder=await db.pool.connect();
  try {
   await holder.query('BEGIN');await holder.query('SET LOCAL ROLE service_role');
   await holder.query('select public.qbo_acquire_refresh_lease($1,$2,90) r',[other,env]);
   let resolved=false;const waiting=svc('select public.qbo_begin_disconnect($1,$2,$3) r',[other,w.U.owner,uuid()]).then(r=>{resolved=true;return r});
   await new Promise(r=>setTimeout(r,100));assert.equal(resolved,false);
   await holder.query('COMMIT');assert.equal((await waiting).r.outcome,'busy');
  } finally {await holder.query('ROLLBACK');holder.release();}
 });
 await check('shared live realm cannot be revoked by one workspace',async()=>{
  const first=(await svc("select public.qbo_store_connection($1,$2,'991','sandbox',$3,now()+interval '100 days',null) id",[w.A,w.U.owner,env])).id;
  await svc("select public.qbo_store_connection($1,$2,'991','sandbox',$3,now()+interval '100 days',null)",[w.B,w.U.ownerB,env]);
  const result=await svc('select public.qbo_begin_disconnect($1,$2,$3) r',[first,w.U.owner,uuid()]);
  assert.equal(result.r.outcome,'shared_connection');
 });
 console.log(`QBO_READINESS ${passed}/${passed} passed (disposable PostgreSQL; no Intuit)`);
} finally { await db.close(); }
