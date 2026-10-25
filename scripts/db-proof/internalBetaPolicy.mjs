// Empty loopback database only. No hosted credentials, users, provider calls or financial writes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
const url = process.env.INTERNAL_BETA_PROOF_URL;
if (!url || !['localhost','127.0.0.1'].includes(new URL(url).hostname)) throw new Error('EMPTY_LOOPBACK_DATABASE_REQUIRED');
const db = new pg.Client({connectionString:url});
await db.connect();
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const U='33333333-3333-4333-8333-333333333333', V='44444444-4444-4444-8444-444444444444';
const H='a'.repeat(64);
let checks=0;
const ok=(name,test)=>{assert.ok(test,name); checks++; console.log('PASS',name);};
try {
  assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n,0);
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
    CREATE TABLE public.companies(id uuid PRIMARY KEY,user_id uuid);
    CREATE TABLE public.firm_members(id uuid,company_id uuid,user_id uuid,accepted_at timestamptz);
    CREATE TABLE public.commercial_admins(user_id uuid,active boolean);
    CREATE TABLE public.ai_assistant_settings(enabled boolean,data_handling_approved_at timestamptz,evaluation_approved_at timestamptz);
    INSERT INTO public.ai_assistant_settings VALUES(false,null,null);
    CREATE TABLE public.financial_statements_rollout_state(singleton boolean,kill_switch boolean);
    INSERT INTO public.financial_statements_rollout_state VALUES(true,false);
    CREATE TABLE public.financial_statements_rollout_companies(company_id uuid,enabled boolean);
    CREATE FUNCTION public.ai_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE'; END $$;
    CREATE FUNCTION public._workspace_access_basis(u uuid,c uuid) RETURNS text LANGUAGE sql STABLE AS $$
      SELECT 'member' WHERE EXISTS(SELECT 1 FROM public.companies WHERE id=c AND user_id=u)
       OR EXISTS(SELECT 1 FROM public.firm_members WHERE company_id=c AND user_id=u AND accepted_at IS NOT NULL) $$;
    CREATE FUNCTION public.has_workspace_capability(c uuid,u uuid,cap text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM public.companies WHERE id=c AND user_id=u) $$;
    INSERT INTO public.companies VALUES('${A}','${U}'),('${B}','${V}');
    INSERT INTO public.firm_members VALUES(gen_random_uuid(),'${A}','${U}',now()),(gen_random_uuid(),'${B}','${V}',now());
    INSERT INTO public.financial_statements_rollout_companies VALUES('${A}',true),('${B}',true);`);
  await db.query(fs.readFileSync('supabase/migrations/20261202100000_internal_beta_policy.sql','utf8'));
  ok('snapshot contains exactly existing authorized owners/members',(await db.query('select count(*)::int n from internal_beta_enrollments')).rows[0].n===2);
  ok('production approvals remain unset',(await db.query('select enabled,data_handling_approved_at,evaluation_approved_at from ai_assistant_settings')).rows[0].enabled===false);
  ok('API service cannot alter allowance',(await db.query("select has_table_privilege('service_role','internal_beta_policy','UPDATE') b")).rows[0].b===false);
  ok('API service cannot truncate history',(await db.query("select has_table_privilege('service_role','internal_beta_assistant_runs','TRUNCATE') b")).rows[0].b===false);
  ok('client cannot reserve',(await db.query("select has_function_privilege('authenticated','internal_beta_assistant_reserve(uuid,uuid,integer,text,text,uuid,text,text,text)','EXECUTE') b")).rows[0].b===false);
  await db.query("select set_config('test.uid',$1,false)",[U]);
  ok('manager reads only accepted team enrollment',(await db.query('select internal_beta_team_status($1) r',[A])).rows[0].r.length===1);
  await db.query("select set_config('test.uid',$1,false)",[V]);
  let denied=false; try {await db.query('select internal_beta_team_status($1)',[A]);} catch {denied=true;}
  ok('other workspace cannot read team enrollment',denied);
  await db.query("select set_config('test.uid','',false)");
  await db.query(`UPDATE internal_beta_policy SET reporting_enabled=true,ai_enabled=true,model='FAKE',
    prices='{"inputMicrosPerMTok":2000000,"outputMicrosPerMTok":10000000,"cacheWriteMicrosPerMTok":2500000,"cacheReadMicrosPerMTok":100000}',
    reservation_micros=124000,credits_confirmed_at=now(),pricing_confirmed_at=now();
    INSERT INTO internal_beta_synthetic_contexts VALUES('${A}',2026,'${H}','Synthetic local proof','local',now()),('${B}',2026,'${H}','Synthetic local proof','local',now());`);
  const reserve=async(u,c,id,hash=H)=>(await db.query('select internal_beta_assistant_reserve($1,$2,2026,$3,$4,$5,$6,$6,$7) r',
    [u,c,'sfp.cash','explain_movement',id,H,hash])).rows[0].r;
  const id='55555555-5555-4555-8555-555555555555';
  ok('nonmember denied',(await reserve(V,A,id)).code==='FORBIDDEN');
  ok('unregistered composition denied',(await reserve(U,A,id,'b'.repeat(64))).code==='SYNTHETIC_SCOPE_REQUIRED');
  const r=await reserve(U,A,id); ok('first synthetic request reserved',r.outcome==='reserved');
  ok('same id replays',(await reserve(U,A,id)).outcome==='replay');
  ok('another workspace shares concurrency cap',(await reserve(V,B,'66666666-6666-4666-8666-666666666666')).code==='CONCURRENCY_LIMIT');
  await db.query('select internal_beta_assistant_complete($1,$2,null,null,1,20,null,null,null,$3)',[r.runId,'ambiguous','PROVIDER_AMBIGUOUS']);
  const recorded=(await db.query('select actual_cost_micros,cost_known from internal_beta_assistant_runs')).rows[0];
  ok('unknown cost consumes reservation',Number(recorded.actual_cost_micros)===124000 && recorded.cost_known===false);
  await db.query('UPDATE internal_beta_policy SET prior_usage_reserved_micros=4876000');
  ok('global TOTAL budget exhausted across workspaces',(await reserve(V,B,'77777777-7777-4777-8777-777777777777')).code==='AI_BUDGET_EXCEEDED');
  let immutable=false; try{await db.query("update internal_beta_assistant_runs set state='reserved'");}catch{immutable=true;}
  ok('completed history immutable',immutable);
  await db.query(`INSERT INTO firm_members VALUES(gen_random_uuid(),'${A}','${V}',now())`);
  ok('later accepted member is NOT auto-enrolled',(await reserve(V,A,'88888888-8888-4888-8888-888888888888')).code==='FORBIDDEN');
  await db.query("select set_config('test.uid',$1,false)",[U]);
  ok('manager explicitly enrolls accepted colleague',(await db.query('select internal_beta_enroll_member($1,$2,$3) r',[A,V,'Accepted colleague beta access'])).rows[0].r.outcome==='recorded');
  ok('team status reflects enrollment',(await db.query('select internal_beta_team_status($1) r',[A])).rows[0].r.find(r=>r.userId===V)?.enrolled===true);
  console.log(`INTERNAL_BETA_POLICY: ${checks}/${checks} isolated PostgreSQL checks passed; not full-chain/hosted clearance`);
} finally {await db.end();}