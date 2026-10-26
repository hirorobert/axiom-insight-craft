// Whole-chain, disposable PostgreSQL. Reproduce the zero-enrollment deadlock before applying the forward fix.
import {applyChainBefore,makeWorld,migrationText,openDatabase,reporter,uuid} from './lib/reportingKit.mjs';
const {group,check,refused,finish}=reporter(); let db,crashed=false;
const FILE='20261204100000_internal_beta_team_bootstrap.sql';
try {
 db=await openDatabase('beta_team_bootstrap_proof');
 group('Reproduce and install');
 await check('the prior chain applies',async()=>await applyChainBefore(db,FILE)??true);
 const {U,A,B}=await makeWorld(db);
 const status=(actor=U.owner,company=A)=>db.asUser(actor,'SELECT public.internal_beta_team_status($1) r',[company]).then(r=>r.r);
 const enroll=(actor=U.owner,target=U.owner,company=A,reason='Explicit internal test enrollment')=>db.asUser(actor,'SELECT public.internal_beta_enroll_member($1,$2,$3) r',[company,target,reason]).then(r=>r.r);
 await refused('before fix: new owner cannot read enrollment','42501',()=>status());
 await refused('before fix: first owner cannot enroll','42501',()=>enroll());
 const preservation=async()=>JSON.stringify((await db.admin.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.commercial_licences t) licences,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY seq) FROM public.fs_publication_bindings t) bindings,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.companies t) companies,
  (SELECT to_jsonb(t) FROM public.internal_beta_policy t WHERE singleton) policy,
  (SELECT to_jsonb(t) FROM public.financial_statements_rollout_state t WHERE singleton) rollout`)).rows);
 const before=await preservation();
 await check('forward migration installs',async()=>{await db.admin.query(migrationText(FILE));return true;});
 await check('installation changes no enrollment or protected state',async()=>await preservation()===before && await db.count('SELECT count(*) n FROM public.internal_beta_enrollments')===0);
 await check('unenrolled owner sees accepted team',async()=>{const r=await status();return r.length===4 && r.every(m=>!m.enrolled);});
 group('Authority and refusals');
 for(const [name,actor]of [['other owner',U.ownerB],['viewer',U.viewer],['preparer',U.preparer]]){
  await refused(`${name} cannot read team`,'42501',()=>status(actor));
  await refused(`${name} cannot enroll`,'42501',()=>enroll(actor));
 }
 await refused('owner cannot cross companies','42501',()=>enroll(U.owner,U.ownerB,B));
 await refused('short reason refused','P0001',()=>enroll(U.owner,U.owner,A,'short'),'ACCEPTED_MEMBER_REQUIRED');
 await refused('nonmember target refused','P0001',()=>enroll(U.owner,U.ownerB),'ACCEPTED_MEMBER_REQUIRED');
 const pending=uuid(); await db.admin.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[pending,'pending@example.test']);
 await db.admin.query("INSERT INTO public.firm_members(company_id,user_id,role,accepted_at) VALUES($1,$2,'viewer',NULL)",[A,pending]);
 await refused('pending member refused','P0001',()=>enroll(U.owner,pending),'ACCEPTED_MEMBER_REQUIRED');
 await check('anonymous and service cannot call either function',async()=>{
  for(const role of ['anon','service_role'])for(const fn of ['public.internal_beta_team_status(uuid)','public.internal_beta_enroll_member(uuid,uuid,text)'])if((await db.one('SELECT has_function_privilege($1,$2,\'EXECUTE\') b',[role,fn])).b)return false;return true;
 });
 group('Concurrent and repeat enrollment');
 await check('twelve concurrent first-owner requests converge to one row and event',async()=>{
  const r=await Promise.all(Array.from({length:12},()=>enroll()));
  return r.every(v=>v.outcome==='recorded') && r.filter(v=>!v.replayed).length===1
   && await db.count('SELECT count(*) n FROM public.internal_beta_enrollments WHERE company_id=$1 AND user_id=$2',[A,U.owner])===1
   && await db.count("SELECT count(*) n FROM public.internal_beta_events WHERE action='ENROLL_MEMBER'")===1;
 });
 await check('read reflects enrolled owner',async()=>(await status()).find(r=>r.userId===U.owner)?.enrolled===true);
 await check('repeat does not append audit events',async()=>(await enroll()).replayed && await db.count("SELECT count(*) n FROM public.internal_beta_events WHERE action='ENROLL_MEMBER'")===1);
 await check('accepted colleague can be enrolled',async()=>(await enroll(U.owner,U.partner)).outcome==='recorded');
 await db.admin.query('UPDATE public.internal_beta_enrollments SET revoked_at=now() WHERE company_id=$1 AND user_id=$2',[A,U.partner]);
 await check('explicit re-enrollment restores revoked accepted member once',async()=>!(await enroll(U.owner,U.partner)).replayed && (await enroll(U.owner,U.partner)).replayed);
 await db.admin.query('DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2',[A,U.partner]);
 await check('removed enrolled member has no effective beta access',async()=>(await db.one('SELECT public.internal_beta_member($1,$2) b',[U.partner,A])).b===false);
 await refused('removed target cannot be re-enrolled','P0001',()=>enroll(U.owner,U.partner),'ACCEPTED_MEMBER_REQUIRED');
 await check('enrollment never opens reporting, spends AI or changes financial/commercial state',async()=>await preservation()===before);
} catch(e){crashed=true;console.error(e.stack??e);}
const ok=finish('BETA_TEAM_BOOTSTRAP',crashed);await db?.close();process.exit(ok?0:1);
