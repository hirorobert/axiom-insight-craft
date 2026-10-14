#!/usr/bin/env node
// ============================================================================
// FOCUSED FIXTURE PROOF — legacy statement_sign_offs authorization (WS-A)
//
// A self-contained fixture (NOT a full migration replay): it stands up the REAL
// statement_sign_offs table, the REAL trigger function bodies (hesabu_block_signoff,
// enforce_sso_distinct_signers, cascade_period_lock, statement_sign_off_certification_wall),
// the REAL final RLS policies (capability-split, as read back from production
// 2026-10-14), and capability/entitlement backing stubs — then drives the defect
// scenarios as a simulated PostgREST `authenticated` caller (SET ROLE + jwt claims).
//
// Modes:
//   default                     applies the candidate repair migration
//                               (supabase/migrations/20261103100000…sql); every
//                               scenario must reach its SECURE outcome.
//   SIGNOFF_PROOF_WITHOUT_REPAIR=1  skips the repair; the defect scenarios reach
//                               their INSECURE outcome (defect demonstrated).
//
// Connection: DB_PROOF_CONN=postgres://…@127.0.0.1:5432/… (loopback only; the
// production project ref is refused). Target server: PostgreSQL 17 (CI service).
// Synthetic fixtures only; no production credentials or data.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const REPAIR = path.join(REPO, "docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql");
const WITHOUT_REPAIR = process.env.SIGNOFF_PROOF_WITHOUT_REPAIR === "1";
const require = createRequire(process.env.DB_PROOF_MODULES_DIR
  ? path.join(path.resolve(process.env.DB_PROOF_MODULES_DIR), "noop.js") : import.meta.url);
const { Client, Pool } = require("pg");

const CONN = process.env.DB_PROOF_CONN;
if (!CONN) { console.error("Set DB_PROOF_CONN=postgres://…@127.0.0.1:5432/db (loopback)."); process.exit(2); }
if (CONN.includes(PRODUCTION_REF)) { console.error("REFUSED: production project ref."); process.exit(2); }
{ const u = new URL(CONN); if (!["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname)) { console.error(`REFUSED: ${u.hostname} not loopback.`); process.exit(2); } }

const U = { prep: "11111111-1111-1111-1111-111111111111", rev: "22222222-2222-2222-2222-222222222222",
            appr: "33333333-3333-3333-3333-333333333333", outsider: "44444444-4444-4444-4444-444444444444" };
const CO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", CO_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const UP_A = "0a0a0a0a-0000-0000-0000-00000000000a";
const hex64 = (s) => { let h=""; for(let i=0;h.length<64;i++) h+=Buffer.from(`${s}:${i}`).toString("hex"); return h.slice(0,64); };

const SETUP = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT anon, authenticated, service_role TO CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid $$;

CREATE TABLE IF NOT EXISTS public.companies (id uuid PRIMARY KEY, name text);
CREATE TABLE IF NOT EXISTS public.firm_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'preparer', UNIQUE(company_id, user_id));
CREATE TABLE IF NOT EXISTS public.trial_balance_uploads (
  id uuid PRIMARY KEY, company_id uuid NOT NULL, period_year int NOT NULL, status text DEFAULT 'complete');
CREATE TABLE IF NOT EXISTS public.hesabu_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), upload_id uuid NOT NULL, gate_satisfied boolean NOT NULL,
  status text, assertions_failed int DEFAULT 0, validated_at timestamptz NOT NULL DEFAULT now());

-- capability / entitlement backing (faithful to the real RLS/wall expressions)
CREATE TABLE IF NOT EXISTS public.test_caps (company_id uuid, user_id uuid, capability text, PRIMARY KEY(company_id,user_id,capability));
CREATE TABLE IF NOT EXISTS public.test_entitlements (company_id uuid, capability text, PRIMARY KEY(company_id,capability));
CREATE OR REPLACE FUNCTION public.workspace_capability_allowed(p_company uuid,p_user uuid,p_cap text)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.test_caps WHERE company_id=p_company AND user_id=p_user AND capability=p_cap) $$;
CREATE OR REPLACE FUNCTION public.has_workspace_capability(p_company uuid,p_user uuid,p_cap text)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT public.workspace_capability_allowed(p_company,p_user,p_cap) $$;
CREATE OR REPLACE FUNCTION public.named_user_access_active(p_company uuid,p_user uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.workspace_capability_entitled(p_company uuid,p_cap text)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.test_entitlements WHERE company_id=p_company AND capability=p_cap) $$;
CREATE OR REPLACE FUNCTION public._require_workspace_capability(p_company uuid,p_cap text)
  RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    IF NOT public.workspace_capability_entitled(p_company,p_cap) THEN
      RAISE EXCEPTION 'ENTITLEMENT_REQUIRED (%)', p_cap USING ERRCODE='check_violation'; END IF; END $$;

-- the REAL table (verbatim shape)
CREATE TABLE IF NOT EXISTS public.statement_sign_offs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_year integer NOT NULL,
  upload_id uuid NOT NULL REFERENCES public.trial_balance_uploads(id),
  statements_hash text,
  preparer_id uuid REFERENCES auth.users(id), preparer_signed_at timestamptz, preparer_note text,
  reviewer_id uuid REFERENCES auth.users(id), reviewer_signed_at timestamptz, reviewer_note text,
  approver_id uuid REFERENCES auth.users(id), approver_signed_at timestamptz, approver_note text,
  preparer_firm_member_id uuid, reviewer_firm_member_id uuid, approver_firm_member_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparer_signed','reviewer_signed','approved','locked')),
  locked_at timestamptz, locked_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_year));
ALTER TABLE public.statement_sign_offs ENABLE ROW LEVEL SECURITY;

-- REAL trigger: HESABU gate (BEFORE INSERT only — the defect surface)
CREATE OR REPLACE FUNCTION public.hesabu_block_signoff() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_pass int; BEGIN
  IF NEW.preparer_signed_at IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_pass FROM public.hesabu_validations WHERE upload_id=NEW.upload_id AND gate_satisfied=true;
  IF v_pass=0 THEN RAISE EXCEPTION 'HESABU GATE: not validated' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS hesabu_gate_before_signoff ON public.statement_sign_offs;
CREATE TRIGGER hesabu_gate_before_signoff BEFORE INSERT ON public.statement_sign_offs FOR EACH ROW EXECUTE FUNCTION public.hesabu_block_signoff();

-- REAL trigger: distinct signers
CREATE OR REPLACE FUNCTION public.enforce_sso_distinct_signers() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
  IF NEW.reviewer_id IS NOT NULL AND NEW.preparer_id IS NOT NULL AND NEW.reviewer_id=NEW.preparer_id THEN RAISE EXCEPTION 'distinct: reviewer=preparer' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.approver_id IS NOT NULL AND NEW.preparer_id IS NOT NULL AND NEW.approver_id=NEW.preparer_id THEN RAISE EXCEPTION 'distinct: approver=preparer' USING ERRCODE='restrict_violation'; END IF;
  IF NEW.approver_id IS NOT NULL AND NEW.reviewer_id IS NOT NULL AND NEW.approver_id=NEW.reviewer_id THEN RAISE EXCEPTION 'distinct: approver=reviewer' USING ERRCODE='restrict_violation'; END IF;
  RETURN NEW; END $$;
DROP TRIGGER IF EXISTS sso_distinct_signers ON public.statement_sign_offs;
CREATE TRIGGER sso_distinct_signers BEFORE INSERT OR UPDATE ON public.statement_sign_offs FOR EACH ROW EXECUTE FUNCTION public.enforce_sso_distinct_signers();

-- REAL trigger: cascade period lock (BEFORE UPDATE only)
CREATE OR REPLACE FUNCTION public.cascade_period_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.locked_at IS NOT NULL AND OLD.locked_at IS NULL THEN NEW.status:='locked'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_cascade_period_lock ON public.statement_sign_offs;
CREATE TRIGGER trg_cascade_period_lock BEFORE UPDATE ON public.statement_sign_offs FOR EACH ROW EXECUTE FUNCTION public.cascade_period_lock();

-- REAL trigger: certification entitlement wall (BEFORE INSERT OR UPDATE)
CREATE OR REPLACE FUNCTION public.statement_sign_off_certification_wall() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
  PERFORM public._require_workspace_capability(NEW.company_id,'STATEMENT_CERTIFICATION'); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_sso_statement_certification_wall ON public.statement_sign_offs;
CREATE TRIGGER trg_sso_statement_certification_wall BEFORE INSERT OR UPDATE ON public.statement_sign_offs FOR EACH ROW EXECUTE FUNCTION public.statement_sign_off_certification_wall();

-- REAL final RLS policies (capability-split, as read back from production 2026-10-14)
DROP POLICY IF EXISTS sso_select ON public.statement_sign_offs;
CREATE POLICY sso_select ON public.statement_sign_offs FOR SELECT USING (EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND has_workspace_capability(fm.company_id,fm.user_id,'prepare_close')));
DROP POLICY IF EXISTS sso_insert ON public.statement_sign_offs;
CREATE POLICY sso_insert ON public.statement_sign_offs FOR INSERT WITH CHECK (EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND workspace_capability_allowed(fm.company_id,fm.user_id,'prepare_close')));
DROP POLICY IF EXISTS sso_update_preparer ON public.statement_sign_offs;
CREATE POLICY sso_update_preparer ON public.statement_sign_offs FOR UPDATE USING (locked_at IS NULL AND EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND workspace_capability_allowed(fm.company_id,fm.user_id,'prepare_close') AND NOT has_workspace_capability(fm.company_id,fm.user_id,'approve_certification'))) WITH CHECK (locked_at IS NULL AND reviewer_signed_at IS NULL AND approver_signed_at IS NULL AND EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND workspace_capability_allowed(fm.company_id,fm.user_id,'prepare_close') AND NOT has_workspace_capability(fm.company_id,fm.user_id,'approve_certification')));
DROP POLICY IF EXISTS sso_update_partner_owner ON public.statement_sign_offs;
CREATE POLICY sso_update_partner_owner ON public.statement_sign_offs FOR UPDATE USING (EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND workspace_capability_allowed(fm.company_id,fm.user_id,'approve_certification'))) WITH CHECK (EXISTS(SELECT 1 FROM firm_members fm WHERE fm.user_id=auth.uid() AND fm.company_id=statement_sign_offs.company_id AND workspace_capability_allowed(fm.company_id,fm.user_id,'approve_certification')) AND (reviewer_signed_at IS NULL OR reviewer_id IS DISTINCT FROM preparer_id) AND (approver_signed_at IS NULL OR (approver_id IS DISTINCT FROM preparer_id AND approver_id IS DISTINCT FROM reviewer_id)));

-- GRANTS as read back from production (the over-broad state the repair contains)
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.statement_sign_offs TO authenticated;
GRANT ALL ON public.statement_sign_offs TO service_role;
GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
`;

const results = [];
const rec = (n, ok, d="") => { results.push({n,ok}); console.log(`  ${ok?"PASS":"FAIL"}  ${n}${ok||!d?"":`  — ${d}`}`); };

async function main() {
  const admin = new Client({ connectionString: CONN }); await admin.connect();
  const v = (await admin.query("show server_version")).rows[0].server_version;
  console.log(`\n== PostgreSQL ${v} · mode=${WITHOUT_REPAIR?"WITHOUT repair (demonstrate defects)":"WITH candidate repair"}`);
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;");
  await admin.query(SETUP);
  // seed
  await admin.query(`INSERT INTO auth.users(id) VALUES ($1),($2),($3),($4)`, [U.prep,U.rev,U.appr,U.outsider]);
  await admin.query(`INSERT INTO companies(id,name) VALUES ($1,'Synthetic A'),($2,'Synthetic B')`, [CO_A,CO_B]);
  const fmPrep=(await admin.query(`INSERT INTO firm_members(company_id,user_id,role) VALUES ($1,$2,'preparer') RETURNING id`,[CO_A,U.prep])).rows[0].id;
  await admin.query(`INSERT INTO firm_members(company_id,user_id,role) VALUES ($1,$2,'partner'),($1,$3,'partner'),($4,$5,'preparer')`,[CO_A,U.rev,U.appr,CO_B,U.outsider]);
  await admin.query(`INSERT INTO trial_balance_uploads(id,company_id,period_year) VALUES ($1,$2,2026)`,[UP_A,CO_A]);
  // capabilities: prep has prepare_close; appr has approve_certification; company A entitled to STATEMENT_CERTIFICATION
  await admin.query(`INSERT INTO test_caps(company_id,user_id,capability) VALUES ($1,$2,'prepare_close'),($1,$3,'approve_certification'),($1,$3,'prepare_close'),($1,$4,'approve_certification'),($1,$4,'prepare_close')`,[CO_A,U.prep,U.rev,U.appr]);
  await admin.query(`INSERT INTO test_caps(company_id,user_id,capability) VALUES ($1,$2,'prepare_close')`,[CO_B,U.outsider]);
  await admin.query(`INSERT INTO test_entitlements(company_id,capability) VALUES ($1,'STATEMENT_CERTIFICATION'),($2,'STATEMENT_CERTIFICATION')`,[CO_A,CO_B]);
  // a PRE-EXISTING locked, approved sign-off we will prove survives the repair (historical preservation).
  // Needs a passing validation present so the INSERT-only HESABU gate admits it at seed time.
  await admin.query(`INSERT INTO hesabu_validations(upload_id,gate_satisfied,status) VALUES ($1,true,'passed')`,[UP_A]);
  await admin.query(`INSERT INTO statement_sign_offs(company_id,period_year,upload_id,preparer_id,preparer_signed_at,reviewer_id,reviewer_signed_at,approver_id,approver_signed_at,locked_at,status,statements_hash)
                     VALUES ($1,2099,$2,$3,now(),$4,now(),$5,now(),now(),'locked',$6)`,[CO_A,UP_A,U.prep,U.rev,U.appr,hex64("hist")]);
  const histBefore=(await admin.query(`SELECT count(*) c FROM statement_sign_offs WHERE period_year=2099`)).rows[0].c;
  // Pre-seed a locked row for the C scenario (must exist before the repair trigger is installed,
  // because the repair makes locked rows immutable and forbids admin from manufacturing signed state).
  const cLockedId=(await admin.query(`INSERT INTO statement_sign_offs(company_id,period_year,upload_id,locked_at,status,statements_hash) VALUES ('${CO_A}',2051,'${UP_A}',now(),'locked','${hex64("l")}') RETURNING id`)).rows[0].id;

  if (!WITHOUT_REPAIR) { await admin.query(fs.readFileSync(REPAIR,"utf8")); }

  const pool = new Pool({ connectionString: CONN, max: 6 });
  async function asUser(uid, fn, role="authenticated") {
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)",[role,uid||""]);
      const r = await fn(c); await c.query("COMMIT"); return r;
    } catch(e){ try{await c.query("ROLLBACK")}catch{} throw e; } finally { c.release(); }
  }
  async function refused(name, uid, fn){ let ref=false,d=""; try{ await asUser(uid,fn);}catch(e){ref=true;d=String(e.message).split("\n")[0];}
    if (WITHOUT_REPAIR) rec(`${name}`, !ref, ref?`refused: ${d}`:"SUCCEEDED → defect demonstrated");
    else rec(`${name}`, ref, ref?"":"SUCCEEDED → repair did NOT close it"); }
  async function allowed(name, uid, fn){ let ok=true,d=""; try{await asUser(uid,fn);}catch(e){ok=false;d=String(e.message).split("\n")[0];} rec(name, ok, d); }

  // Each scenario uses a DISTINCT period_year so a success in without-repair mode
  // cannot collide with another on UNIQUE(company_id,period_year).
  const insP = (c,period,cols,vals) => c.query(`INSERT INTO statement_sign_offs(company_id,period_year,upload_id,${cols}) VALUES ('${CO_A}',${period},'${UP_A}',${vals})`);
  const setValidations = async (spec) => { await admin.query(`DELETE FROM hesabu_validations WHERE upload_id=$1`,[UP_A]);
    if (spec==='pass') await admin.query(`INSERT INTO hesabu_validations(upload_id,gate_satisfied,status) VALUES ($1,true,'passed')`,[UP_A]);
    if (spec==='stale') await admin.query(`INSERT INTO hesabu_validations(upload_id,gate_satisfied,status,validated_at) VALUES ($1,true,'passed',now()-interval '2h'),($1,false,'failed',now()-interval '1h')`,[UP_A]); };

  console.log("\n== scenarios (secure outcome = the write is refused unless noted)");

  // A — INSERT locked+approved, preparer NULL → HESABU gate skipped (INSERT gate only fires when preparer_signed_at set), tier skipped
  await setValidations('none');
  await refused("A · INSERT locked+approved bypasses HESABU gate & approver tier", U.prep,
    (c)=>insP(c,2026,"preparer_signed_at,approver_id,approver_signed_at,approver_firm_member_id,status,locked_at", `NULL,'${U.appr}',now(),gen_random_uuid(),'locked',now()`));

  // D/A' — production report's "nuance": draft INSERT (no gate) then UPDATE sets preparer_signed_at; the gate is INSERT-only so UPDATE is never gated
  await setValidations('none');
  await refused("D · draft INSERT then signed UPDATE accepts sign-off with NO passing validation", U.prep, async (c)=>{
    await insP(c,2027,"preparer_firm_member_id,status", `'${fmPrep}','draft'`);
    await c.query(`UPDATE statement_sign_offs SET preparer_id='${U.prep}', preparer_signed_at=now() WHERE company_id='${CO_A}' AND period_year=2027`);
  });

  // D stale — an earlier pass exists but the LATEST run FAILED
  await setValidations('stale');
  await refused("D · sign accepted against a stale pass / newer failing validation", U.prep,
    (c)=>insP(c,2028,"preparer_id,preparer_signed_at,preparer_firm_member_id", `'${U.prep}',now(),'${fmPrep}'`));

  // B — identity: a single approve_certification actor signs as preparer, reviewer AND approver (distinct ids). Needs a PASS present so the HESABU gate doesn't mask the identity defect in without-repair mode.
  await setValidations('pass');
  await refused("B · signer identity not bound to auth.uid() (one actor signs as others)", U.appr, (c)=>
    insP(c,2029,"preparer_id,preparer_signed_at,reviewer_id,reviewer_signed_at,approver_id,approver_signed_at,preparer_firm_member_id", `'${U.prep}',now(),'${U.rev}',now(),'${U.appr}',now(),'${fmPrep}'`));

  // E — status jumps straight to 'locked' (no *_signed_at → INSERT gate skipped), out of sequence
  await refused("E · status jumps to 'locked' without the tier sequence", U.appr, (c)=>
    insP(c,2030,"status,locked_at,statements_hash", `'locked',now(),'${hex64("x")}'`));

  // C — mutate the pre-seeded already-locked row as an approver
  await refused("C · locked sign-off row mutated post-lock", U.appr,
    (c)=>c.query(`UPDATE statement_sign_offs SET approver_note='tampered' WHERE id='${cLockedId}'`));

  // Tenant isolation — company-B actor cannot write a company-A sign-off (RLS; secure in BOTH modes)
  { let ref=false; try{ await asUser(U.outsider,(c)=>insP(c,2031,"preparer_firm_member_id,status", `'${fmPrep}','draft'`)); }catch{ ref=true; }
    rec("TENANT · company-B actor cannot INSERT a company-A sign-off (RLS, both modes)", ref); }

  // Privilege containment — authenticated must NOT hold TRUNCATE after repair; service_role retains ALL
  { const q=`SELECT has_table_privilege('authenticated','public.statement_sign_offs',$1) t`;
    const trunc=(await admin.query(q,['TRUNCATE'])).rows[0].t;
    const del=(await admin.query(q,['DELETE'])).rows[0].t;
    const svc=(await admin.query(`SELECT has_table_privilege('service_role','public.statement_sign_offs','TRUNCATE') t`)).rows[0].t;
    if (WITHOUT_REPAIR) rec("PRIV · (pre-repair) authenticated holds TRUNCATE (over-grant)", trunc===true, "expected over-grant present");
    else { rec("PRIV · authenticated no longer holds TRUNCATE", trunc===false);
           rec("PRIV · authenticated no longer holds DELETE", del===false);
           rec("PRIV · service_role retains TRUNCATE", svc===true); } }

  // Historical preservation — the pre-existing locked sign-off survives applying the repair
  { const after=(await admin.query(`SELECT count(*) c, bool_and(locked_at IS NOT NULL) locked FROM statement_sign_offs WHERE period_year=2099`)).rows[0];
    rec("HISTORY · pre-existing locked sign-off preserved (count & lock intact)", String(after.c)===String(histBefore) && after.locked===true, `before=${histBefore} after=${after.c}`); }

  // Positive control — a LEGITIMATE preparer sign-off (self id + latest pass) still succeeds (repair is not a blanket block)
  if (!WITHOUT_REPAIR) {
    await setValidations('pass');
    await allowed("POSITIVE · valid preparer sign-off (self id + latest pass) still succeeds", U.prep,
      (c)=>insP(c,2032,"preparer_id,preparer_signed_at,preparer_firm_member_id,status", `'${U.prep}',now(),'${fmPrep}','preparer_signed'`));
  }

  await pool.end(); await admin.end();
  const failed = results.filter(r=>!r.ok);
  console.log(`\n${results.length-failed.length}/${results.length} assertions as expected (${WITHOUT_REPAIR?"defects demonstrated":"repair verified"}).`);
  process.exit(failed.length?1:0);
}
main().catch(e=>{ console.error("PROOF ERROR:", e.message); process.exit(2); });
