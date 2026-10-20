#!/usr/bin/env node
// applyJournalledWrappers.mjs — the file-based release runner for self-checking wrapper batches.
//
// It applies each registered wrapper to a PostgreSQL database THROUGH THE JOURNALLED MIGRATION CONTRACT the hosted project
// already uses (drizzle-orm's migrator, which Lovable's migrator runs): one transaction per migration holding the submitted
// text as one statement and its row in drizzle.__drizzle_migrations (hash = SHA-256 of the submitted text, created_at = the
// journal "when" in milliseconds). It also writes the repository mirror the migrator commits (drizzle/migrations/<tag>.sql,
// meta/<tag>_snapshot.json, a meta/_journal.json entry) so the repository journal and the hosted table agree.
//
// What it refuses to do: submit bytes that are not the registered wrapper of a registered source (SUBMISSION_FORMS); apply a
// batch whose preflight does not end PREFLIGHT OK; continue after a postcondition that does not end POSTCONDITION OK; change
// the recorded sign-offs (fs_publication_bindings is listed before the run and compared after every batch); resubmit a
// wrapper whose hash is already in the journal (it is reported as applied and skipped); run without a stated recovery point
// and operator; print or log the connection string.
//
//   RELEASE_DB_URL=postgres://… node scripts/release/applyJournalledWrappers.mjs \
//     --batches fs-controls-r1,fs-journey-r1,fs-bounds-r1,fs-capacity-r1,fs-memo-r1 \
//     --recovery-point "Supabase PITR / backup <timestamp as shown in the dashboard>" --operator "<name>" \
//     [--dry-run] [--mirror-dir drizzle/migrations] [--allow-enabled <company uuid>] \
//     [--demo-window deactivate --demo-company <uuid>]   (or, after Publish:  --restore-demo <uuid>)
//
// Exit 0: every requested batch is applied (or was already) and every check held. Exit 1: stopped; the log says where and
// what was observed. The log never contains credentials. Verified on a disposable database by
// scripts/db-proof/journalledRunner.mjs (CI "Journalled release runner proof").
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RELEASE_BATCHES } from "./selfCheckingWrapper.mjs";
import { SUBMISSION_FORMS } from "../ci/releaseJournal.mjs";

const { Client } = pg;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BINDINGS_SQL = "SELECT report_id, report_version, state, document_sha256, dependencies_sha256, approver_user_id, approved_at FROM public.fs_publication_bindings ORDER BY seq";

/** The batch-specific rules a preflight's printed rows must satisfy (besides PREFLIGHT OK). */
const PREFLIGHT_RULES = {
  "fs-bounds-r1": (results, ctx) => {
    const counts = results.find((r) => r.fields?.some((f) => f.name === "what"))?.rows ?? [];
    if (counts.length !== 6) return `expected the six over-bound counts, saw ${counts.length}`;
    const over = counts.filter((r) => Number(r.count) !== 0);
    return over.length ? `rows already over a bound: ${over.map((r) => `${r.what}=${r.count}`).join("; ")}` : null;
  },
  "fs-capacity-r1": (results, ctx) => {
    const listed = results.find((r) => r.fields?.some((f) => f.name === "total_read"))?.rows ?? [];
    const hit = listed.filter((r) => ctx.mustNotBeOverCapacity.has(String(r.company_id)));
    ctx.log(`      companies over the account envelope: ${listed.length}${listed.length ? " — " + listed.map((r) => `${r.company_id} (${r.total_read})`).join(", ") : ""}`);
    return hit.length ? `an enabled or demo company is over the account envelope: ${hit.map((r) => r.company_id).join(", ")}` : null;
  },
};

function parseArgs(argv) {
  const o = { batches: [], recoveryPoint: null, operator: null, dryRun: false, mirrorDir: "drizzle/migrations", allowEnabled: [], demoWindow: null, demoCompany: null, restoreDemo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--batches") o.batches = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--recovery-point") o.recoveryPoint = v();
    else if (a === "--operator") o.operator = v();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--mirror-dir") o.mirrorDir = v();
    else if (a === "--allow-enabled") o.allowEnabled.push(v());
    else if (a === "--demo-window") o.demoWindow = v();
    else if (a === "--demo-company") o.demoCompany = v();
    else if (a === "--restore-demo") o.restoreDemo = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Everything the run needs, resolved and verified against the registry BEFORE any connection is opened. */
export function planRelease({ repo = REPO, batches, wrappersDir = path.join(repo, "release/wrappers"), docsDir = path.join(repo, "docs/release") }) {
  const plan = [];
  for (const id of batches) {
    const batch = RELEASE_BATCHES.find((b) => b.id === id);
    if (!batch) throw new Error(`REFUSED: ${id} is not a registered release batch`);
    for (const source of batch.sources) {
      const forms = SUBMISSION_FORMS[source];
      if (!forms?.wrapper || !forms?.wrapperFinalLfRemoved || !forms?.identical) throw new Error(`REFUSED: ${source} has no registered submission forms`);
      const wrapperPath = path.join(wrappersDir, source.replace(/\.sql$/, ".wrapper.sql"));
      const bytes = fs.readFileSync(wrapperPath);
      const h = sha256(bytes);
      if (bytes.length !== forms.wrapper.bytes || h !== forms.wrapper.sha256) {
        throw new Error(`REFUSED: ${path.basename(wrapperPath)} is not the registered wrapper of ${source} (${bytes.length} B ${h.slice(0, 12)}…; registered ${forms.wrapper.bytes} B ${forms.wrapper.sha256.slice(0, 12)}…)`);
      }
      if (bytes.includes(13)) throw new Error(`REFUSED: ${path.basename(wrapperPath)} carries CR bytes`);
      const text = bytes.toString("utf8");
      if (!text.includes(`c_sha256  CONSTANT text    := '${forms.identical.sha256}'`) || !text.includes(`c_bytes   CONSTANT integer := ${forms.identical.bytes};`)) {
        throw new Error(`REFUSED: ${path.basename(wrapperPath)} does not declare the registered source identity of ${source}`);
      }
      const pre = path.join(docsDir, batch.id, "preflight.sql"), post = path.join(docsDir, batch.id, "postcondition.sql");
      for (const f of [pre, post]) if (!fs.existsSync(f)) throw new Error(`REFUSED: ${path.relative(repo, f)} is missing`);
      plan.push({ batch: batch.id, source, wrapperPath, bytes, text, hash: h, hashFinalLfRemoved: forms.wrapperFinalLfRemoved.sha256, preflight: fs.readFileSync(pre, "utf8"), postcondition: fs.readFileSync(post, "utf8"), slug: source.replace(/^\d{14}_/, "").replace(/\.sql$/, "") });
    }
  }
  return plan;
}

/** Runs a read-only SQL file (DO blocks + SELECTs): returns its NOTICE lines and its result sets. */
async function runReadOnly(c, text) {
  const notices = [];
  const on = (m) => notices.push(String(m.message));
  c.on("notice", on);
  try {
    await c.query("BEGIN READ ONLY");
    const r = await c.query(text);
    await c.query("COMMIT");
    return { notices, results: Array.isArray(r) ? r : [r] };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* */ }
    return { notices, error: `${e.code ?? ""}:${String(e.message).split("\n")[0]}` };
  } finally { c.off("notice", on); }
}

const listing = async (c) => JSON.stringify((await c.query(BINDINGS_SQL)).rows);
const head = async (c) => (await c.query("SELECT id, hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1")).rows[0] ?? null;

async function rolloutChange(c, company, enabled, reason, operator) {
  await c.query("BEGIN");
  try {
    await c.query("SET LOCAL ROLE service_role");
    await c.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
    const r = await c.query("SELECT to_jsonb(public.fs_set_company_rollout($1::uuid, $2::boolean, $3::text, $4::text)) AS r", [company, enabled, reason, operator]);
    await c.query("COMMIT");
    return r.rows[0].r;
  } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; }
}

/**
 * Applies the planned batches. `url` is used for the connection only and is never logged. Returns the summary; throws on a
 * stop condition (after logging what was observed).
 */
export async function runRelease({ url, plan, recoveryPoint, operator, dryRun = false, repo = REPO, mirrorDir, allowEnabled = [], demoWindow = null, demoCompany = null, restoreDemo = null, log = console.log, now = () => Date.now() }) {
  if (!recoveryPoint || recoveryPoint.trim().length < 8) throw new Error("REFUSED: --recovery-point must name the confirmed recovery point (backup or PITR mark) before any hosted write");
  if (!operator || operator.trim().length < 2) throw new Error("REFUSED: --operator must name the person running the release");
  const summary = { recoveryPoint, operator, dryRun, applied: [], alreadyApplied: [], mirrors: [] };
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const who = (await c.query("SELECT current_user AS u, current_database() AS d")).rows[0];
    log(`== release runner: ${plan.length} wrapper(s) ${dryRun ? "(DRY RUN: no write)" : ""}; recovery point "${recoveryPoint}"; operator ${operator}; connected as ${who.u} to ${who.d}`);

    // 0. the journal head must be the repository journal's head (hash = the mirror file's SHA-256; created_at = its when)
    const journalPath = path.join(mirrorDir ?? path.join(repo, "drizzle/migrations"), "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const last = journal.entries[journal.entries.length - 1];
    const lastMirror = fs.readFileSync(path.join(path.dirname(path.dirname(journalPath)), `${last.tag}.sql`));
    const h0 = await head(c);
    if (!h0) throw new Error("STOP: drizzle.__drizzle_migrations is empty or missing");
    if (h0.hash !== sha256(lastMirror) || String(h0.created_at) !== String(last.when)) {
      throw new Error(`STOP: the hosted journal head (id ${h0.id}, hash ${h0.hash.slice(0, 12)}…, created_at ${h0.created_at}) is not the repository's ${last.tag} (${sha256(lastMirror).slice(0, 12)}…, ${last.when})`);
    }
    log(`   journal head: id ${h0.id} = ${last.tag} (${h0.hash.slice(0, 12)}…)`);

    // 1. rollout state: the kill switch and which companies are enabled
    const ks = (await c.query("SELECT kill_switch FROM public.financial_statements_rollout_state LIMIT 1")).rows[0]?.kill_switch;
    const enabled = (await c.query("SELECT company_id::text AS company_id FROM public.financial_statements_rollout_companies WHERE enabled ORDER BY company_id")).rows.map((r) => r.company_id);
    log(`   kill switch ${ks}; enabled companies: ${enabled.length ? enabled.join(", ") : "none"}`);
    const unexpected = enabled.filter((x) => !allowEnabled.includes(x));
    if (unexpected.length) throw new Error(`STOP: companies enabled for reporting that the run does not allow: ${unexpected.join(", ")}`);
    if (ks === true) throw new Error("STOP: the kill switch is engaged; decide first");

    // 2. the recorded sign-offs, listed once; compared after every batch
    const s0 = await listing(c);
    log(`   sign-off bindings recorded: ${JSON.parse(s0).length} row(s)`);

    // 3. optional demo window (an audited rollout change, as the owner's own script would make it)
    if (restoreDemo) {
      if (dryRun) log(`   DRY RUN: would restore reporting for ${restoreDemo}`);
      else { const r = await rolloutChange(c, restoreDemo, true, `FS first slice: reporting restored after installation and Publish (recovery point "${recoveryPoint}")`, operator); log(`   restored reporting for ${restoreDemo}: ${JSON.stringify(r)}`); summary.restored = restoreDemo; }
    }
    if (demoWindow === "deactivate") {
      if (!demoCompany) throw new Error("REFUSED: --demo-window deactivate needs --demo-company");
      if (dryRun) log(`   DRY RUN: would deactivate reporting for ${demoCompany} for the installation window`);
      else { const r = await rolloutChange(c, demoCompany, false, `FS first slice installation window (recovery point "${recoveryPoint}"); restored after Publish`, operator); log(`   installation window: reporting deactivated for ${demoCompany}: ${JSON.stringify(r)}`); summary.deactivated = demoCompany; }
    }
    const mustNotBeOverCapacity = new Set([...enabled, ...(demoCompany ? [demoCompany] : [])]);

    // 4. the batches, in order
    let prevTag = last.tag, idx = last.idx;
    for (const p of plan) {
      log(`-- ${p.batch}: ${p.source}`);
      const dup = (await c.query("SELECT id, hash FROM drizzle.__drizzle_migrations WHERE hash = ANY($1::text[])", [[p.hash, p.hashFinalLfRemoved]])).rows;
      if (dup.length) {
        const form = dup[0].hash === p.hash ? "wrapper" : "wrapper_final_lf_removed";
        const isHead = (await head(c))?.id === dup[0].id;
        if (isHead) {
          // The postcondition describes the state right after its batch; it is meaningful only while that batch is the journal head.
          const post = await runReadOnly(c, p.postcondition);
          if (post.error || !post.notices.some((n) => /POSTCONDITION OK/.test(n))) throw new Error(`STOP: ${p.batch} is journalled (id ${dup[0].id}) but its postcondition does not hold: ${post.error ?? post.notices.join(" | ")}`);
          log(`   already applied: journal id ${dup[0].id} holds its ${form} hash; it is the journal head and its postcondition holds; skipping`);
        } else log(`   already applied: journal id ${dup[0].id} holds its ${form} hash (a later batch is the head; its postcondition was checked when it was applied); skipping`);
        summary.alreadyApplied.push({ batch: p.batch, id: dup[0].id, form, head: isHead });
        idx += 1; prevTag = null;
        continue;
      }
      const pre = await runReadOnly(c, p.preflight);
      if (pre.error) throw new Error(`STOP: ${p.batch} preflight raised: ${pre.error}`);
      if (!pre.notices.some((n) => /PREFLIGHT OK/.test(n))) throw new Error(`STOP: ${p.batch} preflight did not end PREFLIGHT OK (${pre.notices.join(" | ")})`);
      const rule = PREFLIGHT_RULES[p.batch]?.(pre.results, { mustNotBeOverCapacity, log });
      if (rule) throw new Error(`STOP: ${p.batch} preflight: ${rule}`);
      if ((await listing(c)) !== s0) throw new Error(`STOP: the sign-off bindings changed before ${p.batch} was applied`);
      log(`   preflight OK`);
      if (dryRun) {
        log(`   DRY RUN: would apply ${p.bytes.length} B ${p.hash.slice(0, 12)}… and journal it`);
        const rest = plan.slice(plan.indexOf(p) + 1).map((x) => x.batch);
        if (rest.length) log(`   DRY RUN: ${rest.join(", ")} planned; their preflights require the previous batch applied and are not run now`);
        summary.dryRunStoppedAfter = p.batch;
        break;
      }

      const when = now();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '60s'");
        await c.query(p.text);
        await c.query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)", [p.hash, when]);
        await c.query("COMMIT");
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch { /* */ }
        const after = await head(c);
        throw new Error(`STOP: ${p.batch} apply failed and was rolled back (${e.code ?? ""}: ${String(e.message).split("\n")[0]}); journal head now id ${after?.id} ${after?.hash?.slice(0, 12)}…; determine the outcome before anything else`);
      }
      const h1 = await head(c);
      if (!h1 || h1.hash !== p.hash || String(h1.created_at) !== String(when)) throw new Error(`STOP: ${p.batch} committed but the journal head is not its row (id ${h1?.id}, ${h1?.hash?.slice(0, 12)}…)`);
      const post = await runReadOnly(c, p.postcondition);
      if (post.error || !post.notices.some((n) => /POSTCONDITION OK/.test(n))) throw new Error(`STOP: ${p.batch} applied (journal id ${h1.id}) but its postcondition does not hold: ${post.error ?? post.notices.join(" | ")}; do not continue`);
      if ((await listing(c)) !== s0) throw new Error(`STOP: ${p.batch} applied but the sign-off bindings differ from the listing before the run; do not continue`);
      log(`   applied: journal id ${h1.id}, hash ${p.hash.slice(0, 12)}…, created_at ${when}; postcondition OK; sign-offs unchanged`);

      // the repository mirror, as the migrator commits it
      idx += 1;
      const tag = `${String(idx).padStart(4, "0")}_${p.slug}`;
      const dir = mirrorDir ?? path.join(repo, "drizzle/migrations");
      fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
      fs.writeFileSync(path.join(dir, `${tag}.sql`), p.bytes);
      const prevSnapPath = path.join(dir, "meta", `${String(idx - 1).padStart(4, "0")}_snapshot.json`);
      const prevSnap = fs.existsSync(prevSnapPath) ? JSON.parse(fs.readFileSync(prevSnapPath, "utf8")).id : null;
      fs.writeFileSync(path.join(dir, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), JSON.stringify({ id: crypto.randomUUID(), prevId: prevSnap, version: "7", dialect: "postgresql", tables: {}, enums: {}, schemas: {}, views: {}, sequences: {}, roles: {}, policies: {}, _meta: { columns: {}, schemas: {}, tables: {} } }, null, 2) + "\n");
      const j = JSON.parse(fs.readFileSync(path.join(dir, "meta/_journal.json"), "utf8"));
      j.entries.push({ idx, version: "7", when, tag, breakpoints: true });
      fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(j, null, 2) + "\n");
      prevTag = tag;
      summary.applied.push({ batch: p.batch, id: h1.id, hash: p.hash, when, tag });
      summary.mirrors.push(`${tag}.sql`);
      log(`   mirror written: ${tag}.sql, meta/${String(idx).padStart(4, "0")}_snapshot.json, _journal.json entry idx ${idx}`);
    }
    if ((await listing(c)) !== s0) throw new Error("STOP: the sign-off bindings differ from the listing before the run");
    log(`== done: applied ${summary.applied.length}, already applied ${summary.alreadyApplied.length}; sign-offs unchanged`);
    return summary;
  } finally { await c.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  const url = process.env.RELEASE_DB_URL;
  if (!url) { console.error("REFUSED: RELEASE_DB_URL is not set (the connection string is read from the environment and never logged)"); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.resolve(process.cwd(), `release-run-${stamp}.log`);
  const redact = (s) => String(s).split(url).join("<RELEASE_DB_URL>");
  const log = (line) => { const l = redact(line); console.log(l); fs.appendFileSync(logPath, l + "\n"); };
  try {
    const plan = planRelease({ batches: o.batches });
    log(`plan: ${plan.map((p) => `${p.batch} ${p.hash.slice(0, 12)}…`).join("; ")}`);
    const s = await runRelease({ url, plan, recoveryPoint: o.recoveryPoint, operator: o.operator, dryRun: o.dryRun, mirrorDir: path.resolve(REPO, o.mirrorDir), allowEnabled: o.allowEnabled, demoWindow: o.demoWindow, demoCompany: o.demoCompany, restoreDemo: o.restoreDemo, log });
    log(`summary: ${JSON.stringify(s)}`);
    log(`log: ${logPath}`);
    process.exit(0);
  } catch (e) {
    log(`${String(e.message)}`);
    log(`log: ${logPath}`);
    process.exit(1);
  }
}
