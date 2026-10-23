#!/usr/bin/env bun
// Real-PostgreSQL proof of the publication lifecycle under concurrent users (Architectural Hardening Addendum §3/§4,
// §12) — through the browser's own client code (src/lib/reporting) where a page would act, with a second connection
// holding the lineage's advisory lock to make the interleavings deterministic:
//
//   C1a duplicate submission     8 simultaneous saves of ONE attempt → two versions (evidence, bind), every batch once; every
//                                copy ends in exactly one allowed way: saved, PT409 REPLAY_CONFLICT (server), or the client's
//                                identity-change refusal (exact text) — anything else fails the proof
//   C1b the identity-change refusal, DETERMINISTIC (Codex re-review of 2c9f685): a second company; one copy is paused by an
//                                explicit barrier between its authoritative reads (after fs_notes_status answered, before
//                                fs_reporting_dependencies is asked); a competing copy of the same attempt commits the
//                                evidence; the paused copy resumes and is refused by the client with the exact reason,
//                                having issued no fs_commit_revision; the retry with the SAME key converges on two
//                                versions and six batches, no duplicate; no sleep orders anything
//   C2  concurrent edits         two people replace the ledger at once → one wins; the other is refused STALE_REPORT_VERSION
//                                (PT409) with nothing stored; their retry builds on the winner's version
//   C3  approval vs replacement  REVIEWED and an evidence replacement of the same lineage, released together: both wait
//                                on the lineage lock (20261111100000 §9); whichever commits first, the other cannot approve
//                                or finalise replaced content
//   C4  FINAL in flight          an approval transaction held open after fs_set_publication_state ran, a replacement
//                                started meanwhile. CONTROL REMOVED (the 20260925140000 function text installed for the
//                                case, together with the later compiler lineage-lock trigger): the replacement is not held back, and after the approval commits a FINAL stands
//                                on a version that is no longer the latest — the regression. CONTROL RESTORED: the
//                                replacement waits for the approval; the FINAL was the latest at its commit and its
//                                binding carries the version's own dependencies
//   C5  revoked approver         a capability revoked while the approval waits on the lock is seen by that approval (42501);
//                                restored, the approval is accepted
//   C6  invariants               every binding equals its version's bound dependencies; a FINAL version never changes
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/publicationConcurrency.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import { applyChain, certifier, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const { group, check, finish } = reporter();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Settles a promise into { ok, v } / { ok, e } so a race can be inspected after the fact. */
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` }));
/** True when the (already started) promise has not settled after `ms`. */
const stillPending = (p, ms) => Promise.race([p.then(() => false, () => false), sleep(ms).then(() => true)]);
let db;

async function main() {
  db = await openDatabase("pubconc_proof");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);

  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const parse = (type, role = "CURRENT", text = null) => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = text ?? (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  // A replacement ledger with the SAME totals (every tie still holds) but different rows: the customer receipts split in
  // two, differently per tag, so each is a distinct batch (a description change alone keeps the batch identity).
  const T1 = "T1,2026-03-31,1000,Receipts from customers,28700.00,,OPERATING,Receipts from customers";
  const SPLITS = { preparer: 20000, owner: 18000, race: 15000, "control-removed": 12000, "control-restored": 11000 };
  const replacement = (tag) => {
    const a = SPLITS[tag]; if (!a) throw new Error(`no split for ${tag}`);
    const rows = `T1a,2026-03-31,1000,Receipts from customers,${a}.00,,OPERATING,Receipts from customers\nT1b,2026-03-31,1000,Receipts from customers,${28700 - a}.00,,OPERATING,Receipts from customers`;
    return [parse("TRANSACTION_LEDGER", "CURRENT", EVIDENCE_FY2026.TRANSACTION_LEDGER.replace(T1, rows))];
  };
  const attempt = (who, rid, newEvidence, key = `attempt-${uuid()}`) =>
    prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: key, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const versions = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const batchesOf = (company) => db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [company]);
  const IDENTITY_CHANGED = "The statements or notes changed while the version was being prepared; try again.";
  /** The browser's client with an explicit barrier: every RPC the preparation issues is logged with its answer, and the FIRST
   *  time `pauseAfter` has answered, the preparation waits until `resume()` — exactly between two of its authoritative reads. */
  const gatedClient = (uid, pauseAfter) => {
    const base = clientDb(db, uid);
    let resolveGate, resolvePaused, pausedOnce = false;
    const gate = new Promise((r) => { resolveGate = r; });
    const paused = new Promise((r) => { resolvePaused = r; });
    const log = [];
    const d = {
      rpc: async (fn, args) => {
        const r = await base.rpc(fn, args);
        log.push({ fn, data: r.data, error: r.error });
        if (fn === pauseAfter && !pausedOnce) { pausedOnce = true; resolvePaused(); await gate; }
        return r;
      },
      select: (table, filters) => base.select(table, filters),
      invoke: (name, body) => base.invoke(name, body),
    };
    return { d, c: signoffClient(d), log, paused, resume: () => resolveGate() };
  };
  const latest = (rid) => db.count("SELECT coalesce(max(report_version),0) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const batches = () => db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [A]);
  const pubs = (rid) => db.admin.query("SELECT report_version AS v, state FROM public.financial_statement_publications WHERE report_id=$1 ORDER BY seq", [rid]).then((r) => r.rows);
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);
  const lineageKey = (rid) => `financial_statement_reports:${rid}`;
  const versionKey = (rid, v) => `financial_statement_publications:${rid}:${v}`;
  /** A second connection holding an advisory lock, as another transaction in flight would. */
  const hold = async (key) => {
    const c = await db.pool.connect();
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    let released = false;
    return { release: async () => { if (released) return; released = true; await c.query("COMMIT"); c.release(); } };
  };
  /** fs_set_publication_state run as `who` inside a transaction this proof holds open: the function has executed, its
   *  locks are held, nothing is committed until `commit()` — another user's action meanwhile shows what the locks order. */
  const approvalInFlight = async (uid, rid, v, state, reason) => {
    const c = await db.pool.connect();
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL statement_timeout = '15s'");
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
      const r = await c.query("SELECT to_jsonb(public.fs_set_publication_state($1,$2,$3,$4,$5)) r", [rid, v, A, state, reason]);
      return { row: r.rows[0].r, commit: async () => { await c.query("COMMIT"); c.release(); } };
    } catch (error) {
      await c.query("ROLLBACK");
      c.release();
      throw error;
    }
  };
  // 20260925140000 holds the function inside an EXECUTE block ($function$ then the outer quote); 20261111100000 holds it plainly.
  const FN = /CREATE OR REPLACE FUNCTION public\.fs_set_publication_state[\s\S]*?AS \$function\$[\s\S]*?\$function\$/;
  const installPublicationState = async (file) => { const m = migrationText(file).match(FN); if (!m) throw new Error(`no fs_set_publication_state in ${file}`); await db.admin.query(`${m[0]};`); };
  const revoke = (cap, who) => asU(U.owner, "SELECT public.revoke_member_capability($1,$2,$3,'Removed for the proof step') r", [A, who, cap]);
  const grant = (cap, who) => asU(U.owner, "SELECT public.grant_member_capability($1,$2,$3,'Restored after the proof step') r", [A, who, cap]);

  group("Setup through the real functions");
  await check("prepared: two certified years, presentation, Close Review, notes (pack 1.2.0), schedule, comparatives approved", async () => { await prepareReporting(db, W, k, { year: Y }); return true; });

  // ── C1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C1. Duplicate submission: one attempt, eight simultaneous saves");
  const rid = `rpt-conc-${uuid()}`;
  await check("exactly two versions exist (the evidence step and the bound step) and every stored batch once; every save that answered names the same bound version; a save that met the other copies' writes mid-flight is refused REPLAY_CONFLICT (PT409) and its retry of the SAME attempt converges on that version without writing", async () => {
    const key = `attempt-${uuid()}`;
    const ev = allEvidence();
    const rs = await Promise.all(Array.from({ length: 8 }, () => settle(attempt(pre, rid, ev, key))));
    const saved = rs.filter((r) => r.ok && r.v.outcome === "saved");
    const failed = rs.filter((r) => !r.ok);
    // The client's own refusal: a copy whose authoritative reads straddled another copy's evidence commit (C1b forces it).
    const identityRefused = rs.filter((r) => r.ok && r.v.outcome === "refused" && r.v.reason === IDENTITY_CHANGED);
    const other = rs.filter((r) => r.ok && r.v.outcome !== "saved" && !(r.v.outcome === "refused" && r.v.reason === IDENTITY_CHANGED));
    const bound = new Set(saved.map((r) => r.v.reportVersion));
    const n = await versions(rid), b = await batches();
    // Strict allowlist: saved (all on the same bound version), PT409 REPLAY_CONFLICT from the server (the idempotency payload
    // includes "which stored batch this replaces"; a copy that read the store after another copy's evidence step sends a
    // different payload under the same key and is refused rather than silently merged), or the client's identity-change
    // refusal with its exact text. Any other refusal, a server INVALID, a deadlock or an infrastructure error fails here.
    if (!(n === 2 && b === 6 && saved.length + failed.length + identityRefused.length === 8 && other.length === 0 && saved.length >= 1 && bound.size === 1 && bound.has(2) && failed.every((r) => /^PT409:REPLAY_CONFLICT/.test(r.e))))
      return { n, b, saved: saved.length, identityRefused: identityRefused.length, bound: [...bound], failed: failed.map((r) => r.e).slice(0, 3), other: other.map((r) => `${r.v.outcome}: ${r.v.reason}`).slice(0, 3) };
    console.log(`        C1a outcomes: saved ${saved.length}, REPLAY_CONFLICT ${failed.length}, client identity-change refusal ${identityRefused.length}`);
    const again = await attempt(pre, rid, ev, key);
    return again.outcome === "saved" && again.reportVersion === 2 && again.alreadyCurrent === true && (await versions(rid)) === 2 && (await batches()) === 6 ? true : { again };
  });
  await check("the bound version is ready: the race left nothing half-done", async () => {
    const r = await readiness(rid, 2);
    return r.ready === true ? true : r.blockers;
  });

  // ── C1b ──────────────────────────────────────────────────────────────────────
  group("C1b. The identity-change refusal, forced with explicit barriers (a second company, one attempt, two copies)");
  const D = await W.company(U.owner, "Synthetic SME (deterministic interleaving)");
  for (const role of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [D, U[role], role]);
  await W.rollout(D, true);
  await check("the second company is prepared through the real functions (two certified years, presentation, Close Review, notes, schedule, comparatives)", async () => { await prepareReporting(db, { ...W, A: D }, k, { year: Y }); return (await batchesOf(D)) === 0 ? true : { batches: await batchesOf(D) }; });
  const parseD = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: D, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const evD = [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parseD(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parseD(t, "COMPARATIVE"))];
  const ridD = `rpt-conc-det-${uuid()}`;
  const keyD = `attempt-${uuid()}`;
  const attemptD = (who, key = keyD) => prepareReportVersion(who.d, who.c, { companyId: D, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridD, newEvidence: evD, idempotencyKey: key, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  let pausedCopy, competing;
  await check("barrier: the paused copy has read the composition and the notes for its evidence step and stops BEFORE asking for the dependencies; nothing of it is written", async () => {
    pausedCopy = gatedClient(U.preparer, "fs_notes_status");
    pausedCopy.result = settle(attemptD(pausedCopy));
    await pausedCopy.paused;
    const fns = pausedCopy.log.map((x) => x.fn);
    const ok = fns.includes("fs_statement_composition") && fns.at(-1) === "fs_notes_status" && !fns.includes("fs_reporting_dependencies") && !fns.includes("fs_commit_revision")
      && (await versions(ridD)) === 0 && (await batchesOf(D)) === 0;
    return ok ? true : { fns, versions: await versions(ridD), batches: await batchesOf(D) };
  });
  await check("while it waits, a competing copy of the SAME attempt commits the evidence step and the bind step: version 2, six batches, two fs_commit_revision calls - all attributed to that copy", async () => {
    competing = gatedClient(U.preparer, "none");
    const r = await attemptD(competing);
    const commits = competing.log.filter((x) => x.fn === "fs_commit_revision" && !x.error).length;
    const ok = r.outcome === "saved" && r.reportVersion === 2 && commits === 2 && (await versions(ridD)) === 2 && (await batchesOf(D)) === 6
      && pausedCopy.log.filter((x) => x.fn === "fs_commit_revision").length === 0;
    return ok ? true : { r, commits, versions: await versions(ridD), batches: await batchesOf(D) };
  });
  await check("resumed, the paused copy is refused BY THE CLIENT with the exact reason: the notes identity it read differs from the one the dependencies now carry (the composition is unchanged); it issued no fs_commit_revision; still two versions and six batches", async () => {
    pausedCopy.resume();
    const r = await pausedCopy.result;
    const notes = pausedCopy.log.find((x) => x.fn === "fs_notes_status")?.data;
    const comp = pausedCopy.log.find((x) => x.fn === "fs_statement_composition")?.data;
    const deps = pausedCopy.log.find((x) => x.fn === "fs_reporting_dependencies")?.data;
    const commits = pausedCopy.log.filter((x) => x.fn === "fs_commit_revision").length;
    const ok = r.ok && r.v.outcome === "refused" && r.v.reason === IDENTITY_CHANGED
      && typeof notes?.statusSha256 === "string" && typeof deps?.notesStatusSha256 === "string" && notes.statusSha256 !== deps.notesStatusSha256
      && comp?.compositionSha256 === deps?.compositionSha256
      && commits === 0 && (await versions(ridD)) === 2 && (await batchesOf(D)) === 6;
    if (ok) console.log(`        C1b refusal: client-side, outcome refused, reason "${r.v.reason}"; notes ${notes.statusSha256.slice(0, 12)}… → ${deps.notesStatusSha256.slice(0, 12)}…, composition unchanged ${String(comp.compositionSha256).slice(0, 12)}…`);
    return ok ? true : { r, notes: notes?.statusSha256, depsNotes: deps?.notesStatusSha256, comp: comp?.compositionSha256, depsComp: deps?.compositionSha256, commits, versions: await versions(ridD), batches: await batchesOf(D) };
  });
  await check("the retry with the SAME key through the normal preparation path, on refreshed reads, converges: saved, version 2 already current, no new commit; exactly two versions, six distinct batches each referenced by the bound version", async () => {
    const retry = gatedClient(U.preparer, "none");
    const r = await attemptD(retry);
    const commits = retry.log.filter((x) => x.fn === "fs_commit_revision").length;
    const ids = await db.admin.query("SELECT evidence_batch_ids AS ids FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=2", [ridD]);
    const refs = ids.rows[0]?.ids ?? [];
    const distinct = await db.count("SELECT count(DISTINCT evidence_batch_id) n FROM public.financial_evidence_batches WHERE company_id=$1", [D]);
    const ok = r.outcome === "saved" && r.reportVersion === 2 && r.alreadyCurrent === true && commits === 0 && (await versions(ridD)) === 2 && (await batchesOf(D)) === 6 && distinct === 6 && refs.length === 6 && new Set(refs).size === 6;
    return ok ? true : { r, commits, versions: await versions(ridD), batches: await batchesOf(D), distinct, refs: refs.length };
  });

  // ── C2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C2. Concurrent edits: two people replace the ledger at the same time");
  let v2 = 0, loser = null;
  await check("released together from the lineage lock: exactly one wins; the other is refused STALE_REPORT_VERSION (PT409) and stores nothing", async () => {
    const v0 = await latest(rid), b0 = await batches();
    const g = await hold(lineageKey(rid));
    const pa = settle(attempt(pre, rid, replacement("preparer"))), pb = settle(attempt(owner, rid, replacement("owner")));
    await sleep(800); // both have read the same latest version and dependencies and now wait at the lock
    await g.release();
    const [a, b] = await Promise.all([pa, pb]);
    const wins = [a, b].filter((r) => r.ok && r.v.outcome === "saved"), losers = [a, b].filter((r) => !r.ok);
    loser = a.ok ? { who: owner, tag: "owner" } : { who: pre, tag: "preparer" };
    const n = await versions(rid), bn = await batches();
    v2 = await latest(rid);
    return wins.length === 1 && losers.length === 1 && /PT409:.*STALE_REPORT_VERSION/.test(losers[0].e) && n === v0 + 2 && bn === b0 + 1 ? true : { a, b, n, v0, bn, b0 };
  });
  await check("the loser's retry (a new attempt, their own file) builds on the winner's version and saves; nothing of the lost attempt appeared before", async () => {
    if (!loser) return "no loser recorded";
    const v0 = await latest(rid), b0 = await batches();
    const r = await attempt(loser.who, rid, replacement(loser.tag));
    v2 = await latest(rid);
    return r.outcome === "saved" && r.reportVersion === v0 + 2 && v2 === v0 + 2 && (await batches()) === b0 + 1 ? true : r;
  });

  // ── C3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C3. Approval versus evidence replacement of the same lineage");
  await check("with the lineage lock held, BOTH the approval and the replacement wait; released together, whichever commits first, the other cannot approve replaced content", async () => {
    const vL = await latest(rid);
    const g = await hold(lineageKey(rid));
    const approval = settle(partner.c.setState(A, rid, vL, "REVIEWED", "Reviewed against the stored evidence"));
    const replace = settle(attempt(pre, rid, replacement("race")));
    await sleep(800);
    const bothWait = (await stillPending(approval, 1)) && (await stillPending(replace, 1));
    await g.release();
    const [ap, rp] = await Promise.all([approval, replace]);
    const ps = await pubs(rid);
    const after = await latest(rid);
    if (ap.ok) {
      // Approval first: vL is REVIEWED; the replacement then created two later versions; vL can no longer be FINAL.
      const fin = await settle(owner.c.setState(A, rid, vL, "FINAL", "Final after a replacement"));
      const rd = await readiness(rid, vL);
      return bothWait && rp.ok && after === vL + 2 && ps.some((p) => p.v === vL && p.state === "REVIEWED") && !fin.ok && /PT409:.*STALE_REPORT_VERSION/.test(fin.e) && rd.ready === false ? true : { bothWait, ap, rp, after, vL, ps, fin, rd: rd.blockers };
    }
    // Replacement first: the approval of vL met changed dependencies and was refused by the binding trigger.
    return bothWait && rp.ok && /PT409:.*BINDING_STALE/.test(ap.e) && !ps.some((p) => p.v === vL) ? true : { bothWait, ap, rp, ps };
  });

  // ── C4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C4. A FINAL approval while a replacement is already committing");
  // The replacement has read everything and waits only at fs_commit_revision's lineage lock (held here); the approval then
  // runs. Without the lineage lock in fs_set_publication_state the approval does not wait for it and the two interleave.
  let vR = 0;
  await check("the latest version is REVIEWED by the partner", async () => {
    vR = await latest(rid);
    const r = await partner.c.setState(A, rid, vR, "REVIEWED", "Reviewed against the evidence");
    return r.state === "REVIEWED" ? true : r;
  });
  await check("CONTROL REMOVED (old publication function and later compiler lineage lock removed in this throwaway database): the approval runs past the committing replacement; the replacement commits a newer version while the approval is still open; the approval then commits a FINAL on a version that is no longer the latest", async () => {
    await installPublicationState("20260925140000_workspace_capability_authorization.sql");
    // The compiler adds a second lineage lock. Remove BOTH controls only for this isolated regression reproduction.
    await db.admin.query("ALTER TABLE public.financial_statement_publications DISABLE TRIGGER trg_fsp_server_compilation");
    let g;
    try {
      g = await hold(lineageKey(rid));
      const replace = settle(attempt(pre, rid, replacement("control-removed")));
      await sleep(800); // past its reads, waiting at the lineage lock
      const fin = await approvalInFlight(U.owner, rid, vR, "FINAL", "Approved for issue (control removed)"); // ran: no lineage lock in the old text
      await g.release();
      const replaceFirst = !(await stillPending(replace, 5000)); // commits vR+1, vR+2 while the approval transaction is still open
      const diag = replaceFirst ? null : (await db.admin.query("SELECT a.pid, a.wait_event_type, a.wait_event, left(a.query,120) AS q, pg_blocking_pids(a.pid) AS by, (SELECT json_agg(json_build_object('t',l.locktype,'rel',l.relation::regclass::text,'m',l.mode)) FROM pg_locks l WHERE l.pid=a.pid AND NOT l.granted) AS waiting FROM pg_stat_activity a WHERE a.wait_event_type='Lock'")).rows;
      const between = replaceFirst ? await latest(rid) : null;
      await fin.commit();
      const rp = await replace;
      const ps = await pubs(rid);
      return replaceFirst && rp.ok && between === vR + 2 && fin.row.state === "FINAL" && ps.some((p) => p.v === vR && p.state === "FINAL") ? true : { replaceFirst, diag, rp, between, vR, ps, row: fin.row?.state };
    } finally {
      await g?.release();
      await installPublicationState("20261111100000_fs_publication_controls.sql");
      await db.admin.query("ALTER TABLE public.financial_statement_publications ENABLE TRIGGER trg_fsp_server_compilation");
    }
  });
  await check("the 20261111100000 text is installed again (postcondition of the migration holds)", async () => {
    const r = (await db.admin.query("SELECT position('financial_statement_reports:' IN pg_get_functiondef('public.fs_set_publication_state(text, integer, uuid, text, text)'::regprocedure)) > 0 AS locked")).rows[0];
    const trigger = (await db.admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.financial_statement_publications'::regclass AND tgname='trg_fsp_server_compilation'")).rows[0];
    return r.locked === true && trigger?.tgenabled === "O" ? true : { ...r, trigger };
  });
  let vR2 = 0, restoredFinal = null;
  await check("CONTROL RESTORED: a new version is REVIEWED; the same interleaving — the approval WAITS behind the committing replacement and is then refused STALE_REPORT_VERSION (or, had it been served first, the replacement would wait and follow as an unsigned draft)", async () => {
    await attempt(pre, rid, []);
    vR2 = await latest(rid);
    const rv = await partner.c.setState(A, rid, vR2, "REVIEWED", "Reviewed again");
    if (rv.state !== "REVIEWED") return rv;
    const g = await hold(lineageKey(rid));
    const replace = settle(attempt(pre, rid, replacement("control-restored")));
    await sleep(800);
    const finP = settle(approvalInFlight(U.owner, rid, vR2, "FINAL", "Approved for issue"));
    await sleep(800);
    const approvalWaits = await stillPending(finP, 1);
    await g.release();
    const fin = await finP; // settles once the lock is granted to the approval: refused by name, or ran (transaction open)
    if (fin.ok) {
      // Served first: it holds the lineage lock open; the replacement must wait until the approval commits.
      const replaceWaits = await stillPending(replace, 1500);
      await fin.v.commit();
      restoredFinal = vR2;
      const rp = await replace;
      return approvalWaits && replaceWaits && rp.ok && (await latest(rid)) === vR2 + 2 ? true : { approvalWaits, replaceWaits, rp };
    }
    // Served after the replacement's evidence step committed: refused; the replacement's second step then finishes.
    const rp = await replace;
    const ps = await pubs(rid);
    return approvalWaits && rp.ok && /PT409:.*STALE_REPORT_VERSION/.test(fin.e) && !ps.some((p) => p.v === vR2 && p.state === "FINAL") && (await latest(rid)) === vR2 + 2 ? true : { approvalWaits, rp, fin, ps };
  });

  // ── C5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C5. A revoked approver cannot complete a queued approval");
  let vN = 0;
  await check("a fresh bound version is ready for review", async () => {
    const r = await attempt(pre, rid, []);
    vN = await latest(rid);
    const rd = await readiness(rid, vN);
    return (r.outcome === "saved") && rd.ready === true ? true : { r, rd: rd.blockers };
  });
  await check("the partner's review_close is revoked WHILE their approval waits on the lineage lock: the approval is refused (42501); restored, it is accepted", async () => {
    const g = await hold(lineageKey(rid));
    const approval = settle(partner.c.setState(A, rid, vN, "REVIEWED", "Reviewed"));
    await sleep(500);
    const waits = await stillPending(approval, 1);
    await revoke("review_close", U.partner);
    await g.release();
    const ap = await approval;
    await grant("review_close", U.partner);
    const again = await settle(partner.c.setState(A, rid, vN, "REVIEWED", "Reviewed"));
    return waits && !ap.ok && /42501/.test(ap.e) && again.ok && again.v.state === "REVIEWED" ? true : { waits, ap, again };
  });

  // ── C6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("C6. Invariants after everything above");
  await check("every binding carries exactly the dependencies identity its version's document declares", async () => {
    const r = (await db.admin.query("SELECT count(*) FILTER (WHERE b.dependencies_sha256 IS DISTINCT FROM r.report_document #>> '{reportingDependencies,dependenciesSha256}') AS bad, count(*) AS n FROM public.fs_publication_bindings b JOIN public.financial_statement_reports r ON r.report_id=b.report_id AND r.report_version=b.report_version WHERE b.company_id=$1", [A])).rows[0];
    return Number(r.bad) === 0 && Number(r.n) >= 2 ? true : r;
  });
  await check("no FINAL version was ever published again; exactly one FINAL stands on a version that was not the latest at its commit — the control-removed one", async () => {
    const r = (await db.admin.query("SELECT p.report_version AS v, (SELECT count(*) FROM public.financial_statement_publications q WHERE q.report_id=p.report_id AND q.report_version=p.report_version AND q.seq > p.seq) AS later FROM public.financial_statement_publications p WHERE p.company_id=$1 AND p.state='FINAL' ORDER BY p.seq", [A])).rows;
    // A later version created AFTER a FINAL (a draft following an issue) is legitimate; the control-removed case is the one
    // where the newer version was committed BEFORE the FINAL: that FINAL is vR, recorded by C4 itself.
    const expected = [vR, ...(restoredFinal === null ? [] : [restoredFinal])];
    return JSON.stringify(r.map((x) => x.v)) === JSON.stringify(expected) && r.every((x) => Number(x.later) === 0) ? true : { finals: r, expected };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("PUBLICATION_CONCURRENCY", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
