// Independent regression: real processing/adjustment authority in a disposable loopback database only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDatabase, applyChain, makeWorld, certifier, csv, FY2025, FY2026, uuid, REPO } from './lib/reportingKit.mjs';
import { PROOF, CASES } from './ipsasIndependentReview.manifest.mjs';
let db,failures=0,crashed=false;const cases=[],startedAt=new Date().toISOString();
const check=(id,actual,expected)=>{if(!CASES.some(c=>c.id===id)||cases.some(c=>c.id===id))throw Error(`Invalid case ${id}`);const ok=JSON.stringify(actual)===JSON.stringify(expected);console.log(`${ok?'PASS':'FAIL'} ${id}: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);cases.push({id,outcome:ok?'pass':'fail'});if(!ok)failures++;};
try {
 db=await openDatabase('ipsas_independent_review');
 const failed=await applyChain(db);if(failed)throw Error(failed);
 const W=await makeWorld(db),{U}=W,A=await W.company(U.owner,'Independent synthetic IPSAS','ipsas_accrual');
 for(const role of ['preparer','partner'])await db.admin.query('INSERT INTO public.firm_members(company_id,user_id,role,accepted_at) VALUES($1,$2,$3,now())',[A,U[role],role]);
 await W.rollout(A,true);const k=await certifier(db,U);let current;
 for(const [year,col]of [[2025,FY2025],[2026,FY2026]]){const u=await k.upload(A,year,csv(col));if(year===2025)await k.review(A,u);await k.certify(A,u);if(year===2026)current=u;}
 // Private helpers are deliberately not API callable: inspect their results as the database test operator, with the actor claim set.
 const inspect=async()=>{await db.admin.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[U.preparer]);return(await db.one(`SELECT public._ipsas_tb_facts($1,2026,'{"ppeAccountKeys":["1500","1510"],"depreciationExpenseKeys":["6200"]}') ppe, public._ipsas_tb_sum($1,2026,'["2000"]','credit')::text liability`,[A]));};
 let r=await inspect();check('initial authoritative PPE',[r.ppe.ppeCarryingClosingMinor,r.ppe.ppeCarryingOpeningMinor],['1400000','1600000']);
 check('incompatible PPE classification is unknown',(await db.one(`SELECT public._ipsas_tb_facts($1,2026,'{"ppeAccountKeys":["1000"],"depreciationExpenseKeys":["6200"]}') r`,[A])).r.ppeCarryingClosingMinor,null);
 const proposal=(await db.asUser(U.preparer,"SELECT public.close_review_propose_adjustment($1,2026,'Synthetic capital invoice supported by evidence',NULL,$2::jsonb,'{}'::uuid[],$3,NULL) r",[A,JSON.stringify([{accountKey:'1500',debitMinor:'30000',creditMinor:'0'},{accountKey:'2000',debitMinor:'0',creditMinor:'30000'}]),uuid()])).r;
 const decision=(await db.asUser(U.partner,"SELECT public.close_review_decide_adjustment($1,'approve','Invoice and asset register checked',NULL,$2) r",[proposal.adjustmentId,uuid()])).r;
 if(decision.outcome!=='recorded'&&decision.outcome!=='approved')throw Error(JSON.stringify(decision));
 r=await inspect();check('PPE includes approved adjustment',r.ppe.ppeCarryingClosingMinor,'1430000');check('grants tie includes approved adjustment',r.liability,'340000');
 await k.review(A,current); // A new reviewed mapping decision really invalidates the existing certifications.
 check('canonical authority refuses invalidated source',(await db.one('SELECT count(*)::int n FROM public.get_authoritative_certification($1,2026)',[A])).n,0);
 r=await inspect();check('PPE refuses invalidated source',r.ppe.ppeCarryingClosingMinor,null);check('opening refuses invalidated source',r.ppe.ppeCarryingOpeningMinor,null);check('grants refuse invalidated source',r.liability,null);
 check('grants period refuses invalidated source',(await db.one('SELECT public._ipsas_grants_period($1,2026) r',[A])).r,null);
} catch(e) {crashed=true;console.error(e);}
finally {
 if(db)await db.close();
 const output=process.env.PROOF_RESULT_FILE??path.join(REPO,'proof-results',`${PROOF}.present.json`);
 fs.mkdirSync(path.dirname(output),{recursive:true});
 fs.writeFileSync(output,JSON.stringify({proof:PROOF,mode:'present',manifestSha256:crypto.createHash('sha256').update(fs.readFileSync(new URL('./ipsasIndependentReview.manifest.mjs',import.meta.url))).digest('hex'),startedAt,finishedAt:new Date().toISOString(),completed:!crashed&&cases.length===CASES.length,crashed,cases},null,2)+'\n');
}
process.exit(failures||crashed?1:0);
