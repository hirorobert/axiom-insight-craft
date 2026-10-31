// Native proof of the workspace source-access repairs (independent review of #229, findings 2, 3 and 5), on the full migration chain in a disposable
// loopback database. Synthetic data only; never a hosted database; no Storage token is minted (the signer is a local stand-in, and says so).
//
// The download decision sequence under test is supabase/functions/_shared/sourceDownload.ts itself, run with REAL database dependencies: authority is
// can_user_act_on_workspace (as the service role, exactly as the function calls it), the upload row is read from trial_balance_uploads, the decision
// record is inserted into trial_balance_source_download_events as the service role. Only Storage signing is local: a deferred promise that returns
// an obviously fake URL, so the proof can place a withdrawal at an exact point of the sequence. That is orchestration evidence; it is NOT evidence of
// what Storage does with a token.
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChain, certifier, csv, FY2026, makeWorld, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./sourceAccessAuthority.manifest.mjs";
import { runSourceDownload } from "../../supabase/functions/_shared/sourceDownload.ts";

const results = [], failures = [];
const manifest = fs.readFileSync(new URL("./sourceAccessAuthority.manifest.mjs", import.meta.url));
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results/sourceAccessAuthority.present.json");
let db, W, U, completed = false, crashed = false, crashMessage = null, seq = 0;
async function kase(id, fn) {
  if (process.env.SOURCE_ONLY && !id.startsWith("setup.") && !id.includes(process.env.SOURCE_ONLY)) return;
  assert(CASES.some((c) => c.id === id), `case ${id} not in manifest`); assert(!results.some((c) => c.id === id), `duplicate ${id}`);
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) { results.push({ id, outcome: "fail", detail: `${e.code ?? ""}: ${String(e.message).split("\n")[0]}` }); failures.push(id); console.log("FAIL", id, "-", String(e.message).split("\n")[0].slice(0, 500)); }
}
const one = async (sql, p = []) => (await db.admin.query(sql, p)).rows[0];
const CAP = "manage_source_files";

async function newAccount() {
  const uid = uuid();
  await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid, `srcowner-${uid}@example.test`]);
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 8 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  return uid;
}
/** A workspace with an upload; `U.preparer` is an accepted member, `U.partner` a pending invitation-free collaborator (no membership), `U.viewer` another member. */
async function workspace() {
  const owner = await newAccount();
  const A = await W.company(owner, `Source access case ${++seq}`, "ipsas_accrual");
  const k = await certifier(db, { ...U, owner });
  const upload = await k.upload(A, 2026, csv(FY2026));
  return { A, owner, uploadId: upload.id };
}
const addMember = (A, uid, role = "preparer") => db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, uid, role]);
const grant = async (w, uid, cap = CAP) => { const r = (await db.asRole("authenticated", w.owner, "SELECT * FROM public.grant_workspace_capability($1,$2,$3)", [w.A, uid, cap]))[0]; assert.equal(r.outcome, "granted", JSON.stringify(r)); return r.grant_id; };
const allowed = async (w, uid) => (await db.asService("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [uid, w.A, CAP])).r;
const removeMember = (w, uid) => db.asRole("authenticated", w.owner, "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, uid]);
const openGrants = async (w, uid) => Number((await one("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL", [w.A, uid])).n);

/** The function's own decision sequence with real authority, upload and record; the signer is the only stand-in. */
function deps(w, uid, over = {}) {
  return {
    authenticate: async () => uid,
    resolveUpload: async (id) => (await one("SELECT id, company_id, user_id, file_path, file_name, file_size, source_file_hash FROM public.trial_balance_uploads WHERE id=$1", [id])) ?? null,
    canDownload: async (userId, companyId) => (await db.asService("SELECT public.can_user_act_on_workspace($1,$2,$3) r", [userId, companyId, CAP])).r === true,
    sign: async () => ({ url: "https://signer.invalid/proof-only-not-a-storage-token" }),
    record: async (e) => {
      try {
        await db.asService("INSERT INTO public.trial_balance_source_download_events (company_id, upload_id, actor_user_id, outcome, link_expires_at, object_sha256) VALUES ($1,$2,$3,$4,$5,$6)",
          [e.companyId, e.uploadId, e.userId, e.outcome, e.expiresAt, e.sha256]);
        return true;
      } catch { return false; }
    },
    ...over,
  };
}
const request = (w) => ({ uploadId: w.uploadId, companyId: w.A });
const events = (w) => db.admin.query("SELECT outcome, link_expires_at, object_sha256, actor_user_id FROM public.trial_balance_source_download_events WHERE company_id=$1 ORDER BY occurred_at, id", [w.A]).then((r) => r.rows);

try {
  db = await openDatabase("source_access_authority");
  await kase("setup.chain-and-world", async () => {
    const err = await applyChain(db); assert.equal(err, null, String(err));
    W = await makeWorld(db); U = W.U;
  });
  if (failures.length) throw new Error("setup failed");

  // ── finding 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("removal.the-grant-is-revoked-in-the-removing-transaction", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); const g = await grant(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "precondition: the member's grant authorises file access");
    const res = await removeMember(w, U.preparer); assert.equal(res.length, 0);
    assert.equal((await one("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer])).n, "0", "the membership is gone");
    assert.equal(await allowed(w, U.preparer), false, "removal must end file access: the real database predicate is now false");
    const row = await one("SELECT revoked_at, revoked_by_user_id FROM public.workspace_capability_grants WHERE id=$1", [g]);
    assert(row.revoked_at && row.revoked_by_user_id === w.owner, "the grant is revoked, by the person who removed the member");
    const ev = await one("SELECT action, outcome, actor_user_id FROM public.workspace_capability_grant_events WHERE grant_id=$1 AND action='revoke'", [g]);
    assert.deepEqual([ev.action, ev.outcome, ev.actor_user_id], ["revoke", "applied", w.owner], "the revocation is recorded exactly as an explicit revocation is");
  });
  await kase("removal.the-download-path-refuses-and-records-the-denial", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer);
    assert.equal((await runSourceDownload(deps(w, U.preparer), request(w))).outcome, "ready", "precondition: before removal the member is served");
    await removeMember(w, U.preparer);
    const r = await runSourceDownload(deps(w, U.preparer), request(w));
    assert.deepEqual(r, { status: 403, outcome: "forbidden" }, "after removal a NEW link request is refused");
    assert.deepEqual((await events(w)).map((e) => e.outcome), ["issued", "denied"]);
  });
  await kase("removal.a-collaborator-who-was-never-a-member-keeps-access", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer); await grant(w, U.partner);   // partner: grant only, no membership
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, U.partner), true, "the supported grant-only collaborator path is not removed by removing someone else");
    assert.equal(await openGrants(w, U.partner), 1);
  });
  await kase("removal.owner-other-members-and-other-workspaces-are-untouched", async () => {
    const w = await workspace(), other = await workspace();
    for (const x of [w, other]) await addMember(x.A, U.preparer);
    await addMember(w.A, U.viewer); await grant(w, U.preparer); await grant(w, U.viewer); await grant(other, U.preparer);
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, w.owner), true, "the workspace owner is unaffected");
    assert.equal(await allowed(w, U.viewer), true, "another member's grant is unaffected");
    assert.equal(await allowed(other, U.preparer), true, "the same person's grant in ANOTHER workspace is unaffected: revocation is scoped to the workspace they were removed from");
  });
  await kase("removal.reinstatement-does-not-resurrect-old-grants", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); await grant(w, U.preparer);
    await removeMember(w, U.preparer); await addMember(w.A, U.preparer);
    assert.equal(await allowed(w, U.preparer), false, "re-adding the person does not bring back what removal ended");
    await grant(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "an explicit new grant by the owner does");
    assert.equal(Number((await one("SELECT count(*) n FROM public.workspace_capability_grants WHERE company_id=$1 AND grantee_user_id=$2", [w.A, U.preparer])).n), 2, "the revoked grant stays as history beside the new one");
  });
  await kase("removal.a-pending-invitation-removes-nothing", async () => {
    const w = await workspace(); await grant(w, U.preparer);                                                   // an independent grant ...
    await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,invitation_expires_at) VALUES ($1,$2,'preparer', now() + interval '1 day')", [w.A, U.preparer]);   // ... and a pending invitation, never accepted
    await removeMember(w, U.preparer);
    assert.equal(await allowed(w, U.preparer), true, "deleting a never-accepted invitation ends no access, because it gave none");
  });
  await kase("removal.a-demotion-changes-the-title-not-independent-grants", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer, "partner"); await grant(w, U.preparer);
    await db.asRole("authenticated", w.owner, "UPDATE public.firm_members SET role='viewer' WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer]);
    assert.equal(await allowed(w, U.preparer), true, "a title change is not removal: independent grants are explicit and are kept");
  });
  await kase("removal.the-whole-removal-rolls-back-together", async () => {
    const w = await workspace(); await addMember(w.A, U.preparer); const g = await grant(w, U.preparer);
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated"); await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [w.owner]);
      await c.query("DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [w.A, U.preparer]);
      await c.query("ROLLBACK");
    } finally { c.release(); }
    assert.equal(await allowed(w, U.preparer), true, "a rolled-back removal leaves the grant in force");
    assert.equal((await one("SELECT revoked_at FROM public.workspace_capability_grants WHERE id=$1", [g])).revoked_at, null);
    assert.equal(Number((await one("SELECT count(*) n FROM public.workspace_capability_grant_events WHERE grant_id=$1 AND action='revoke'", [g])).n), 0);
  });

  // ── finding 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("signing.withdrawal-while-signing-returns-no-link", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    let release; const signing = new Promise((r) => { release = r; });
    let signerStarted; const started = new Promise((r) => { signerStarted = r; });
    const d = deps(w, U.preparer, { sign: async () => { signerStarted(); await signing; return { url: "https://signer.invalid/SECRET-proof-token" }; } });
    const pending = runSourceDownload(d, request(w));
    await started;                                                                     // authority was read once and signing is now pending
    await db.asRole("authenticated", w.owner, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [w.A, U.preparer, CAP]);   // the real revocation commits meanwhile
    release();
    const r = await pending;
    assert.deepEqual(r, { status: 403, outcome: "forbidden" });
    assert(!JSON.stringify(r).includes("SECRET"), "the minted link was discarded unseen");
    assert.deepEqual((await events(w)).map((e) => e.outcome), ["withdrawn_before_issue"]);
  });
  await kase("signing.withdrawal-after-the-second-read-is-ordered-after-issuance", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    let atRecord; const reached = new Promise((r) => { atRecord = r; }); let go; const gate = new Promise((r) => { go = r; });
    const base = deps(w, U.preparer);
    const d = { ...base, record: async (e) => { atRecord(); await gate; return base.record(e); } };   // pause AFTER the second authority read, before the record and the return
    const pending = runSourceDownload(d, request(w));
    await reached;
    await db.asRole("authenticated", w.owner, "SELECT * FROM public.revoke_workspace_capability($1,$2,$3)", [w.A, U.preparer, CAP]);
    go();
    const r = await pending;
    assert.equal(r.outcome, "ready", "a withdrawal that commits after the second read is ordered after the issuance: the link is returned (a bearer credential for its short life)");
    assert.deepEqual((await events(w)).map((e) => e.outcome), ["issued"]);
    assert.equal(await allowed(w, U.preparer), false, "and the very next request is refused");
  });

  // ── finding 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("record.issuance-is-recorded-before-the-link-and-holds-no-url", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    const order = []; const base = deps(w, U.preparer);
    const r = await runSourceDownload({ ...base, record: async (e) => { order.push(`record:${e.outcome}`); const ok = await base.record(e); order.push("stored"); return ok; } }, request(w));
    order.push("returned"); assert.equal(r.outcome, "ready"); assert.deepEqual(order, ["record:issued", "stored", "returned"]);
    const rows = await events(w); assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, "issued"); assert(rows[0].link_expires_at, "an issued record carries the link's expiry"); assert.equal(rows[0].actor_user_id, U.preparer);
    const cols = (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='trial_balance_source_download_events'")).rows.map((x) => x.column_name);
    assert(!cols.some((c) => /url|token|path|signed/.test(c)), `no column can hold a URL, token or path: ${cols.join(",")}`);
    const dump = JSON.stringify((await db.admin.query("SELECT * FROM public.trial_balance_source_download_events WHERE company_id=$1", [w.A])).rows);
    assert(!/signer\.invalid|token|workspaces\//.test(dump), "no stored value contains a URL, a token or a path");
  });
  await kase("record.no-record-no-link", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    await db.admin.query("REVOKE INSERT ON public.trial_balance_source_download_events FROM service_role");     // a REAL storage failure: the insert is refused by the database
    try {
      const r = await runSourceDownload(deps(w, U.preparer), request(w));
      assert.deepEqual(r, { status: 503, outcome: "audit_unavailable" }); assert.equal(r.url, undefined, "no link without its record");
    } finally { await db.admin.query("GRANT INSERT ON public.trial_balance_source_download_events TO service_role"); }
    assert.equal((await events(w)).length, 0);
  });
  await kase("record.append-only-and-readable-only-by-the-workspace-owner", async () => {
    const w = await workspace(); await grant(w, U.preparer);
    await runSourceDownload(deps(w, U.preparer), request(w));
    const id = (await one("SELECT id FROM public.trial_balance_source_download_events WHERE company_id=$1", [w.A])).id;
    for (const sql of ["UPDATE public.trial_balance_source_download_events SET outcome='denied' WHERE id=$1", "DELETE FROM public.trial_balance_source_download_events WHERE id=$1"]) {
      await assert.rejects(() => db.admin.query(sql, [id]), /append-only/, "even the database owner cannot change or delete a record");
    }
    await assert.rejects(() => db.admin.query("TRUNCATE public.trial_balance_source_download_events"), /append-only/);
    await assert.rejects(() => db.asRole("authenticated", w.owner, "INSERT INTO public.trial_balance_source_download_events (company_id, upload_id, actor_user_id, outcome) VALUES ($1,$2,$3,'denied')", [w.A, w.uploadId, w.owner]), /permission denied/, "no signed-in user can write a record");
    assert.equal((await db.asRole("authenticated", w.owner, "SELECT id FROM public.trial_balance_source_download_events WHERE company_id=$1", [w.A])).length, 1, "the workspace owner can read the workspace's records");
    assert.equal((await db.asRole("authenticated", U.preparer, "SELECT id FROM public.trial_balance_source_download_events WHERE company_id=$1", [w.A])).length, 0, "the person who was served cannot");
    assert.equal((await db.asRole("authenticated", U.ownerB, "SELECT id FROM public.trial_balance_source_download_events", [])).length, 0, "another workspace's owner sees nothing of it");
  });
  completed = failures.length === 0;
} catch (e) { crashed = true; crashMessage = `${e.code ?? ""}: ${e.stack ?? e.message}`; console.error(crashMessage); process.exitCode = 1; }
finally {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: "present", manifestSha256: crypto.createHash("sha256").update(manifest).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
  console.log(`SOURCE_ACCESS_AUTHORITY: ${results.filter((r) => r.outcome === "pass").length}/${CASES.length} passed${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);
  if (failures.length) process.exitCode = 1;
  await db?.close(); process.exit(process.exitCode ?? 0);
}
