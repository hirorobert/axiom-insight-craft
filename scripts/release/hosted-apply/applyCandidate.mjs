#!/usr/bin/env node
// applyCandidate — controlled application of ONE reviewed source migration to the hosted database, recorded in Lovable's
// ESTABLISHED Drizzle apply journal (drizzle.__drizzle_migrations), exactly as drizzle-orm 0.45.2's migrator records an
// entry: hash = SHA-256 of the entry file text, created_at = the entry's journal "when". No parallel journal.
//
// What it adds to the drizzle-orm migrator (which takes no lock and sets no timeout):
//   · the candidate's exact bytes and SHA-256 are verified against the pinned manifest before anything connects;
//   · the target is pinned: the expected project ref in the connection URL, and (for apply) the database's own
//     system_identifier as printed by `status`, and the journal's expected last entry (lineage);
//   · ONE transaction: pg_advisory_xact_lock + SHARE ROW EXCLUSIVE lock on the journal table, a re-check of the state
//     under the lock, the candidate SQL executed verbatim (one batch, as drizzle executes a file without breakpoints),
//     the journal row, and the postconditions re-verified — then COMMIT. Any failure rolls back schema AND journal;
//   · bounded waits: lock_timeout, statement_timeout and idle_in_transaction_session_timeout;
//   · read-only inspection runs in ONE snapshot (REPEATABLE READ), so a concurrent commit is never seen half-way;
//   · outcomes are classified: UNAPPLIED, APPLIED, ALREADY_APPLIED, CONFLICT, BUSY, FAILED, UNCERTAIN.
//
//   node scripts/release/hosted-apply/applyCandidate.mjs status --expect-ref <ref>
//   node scripts/release/hosted-apply/applyCandidate.mjs apply  --expect-ref <ref> --expect-system-id <id> --when <epoch-ms>
//   (the connection URL is read from $LOVABLE_DB_MIGRATION_URL, or the variable named by --url-env; it is never printed)
//
// Exit codes: 0 UNAPPLIED (status) | APPLIED | ALREADY_APPLIED; 2 refused before connecting or identity mismatch;
//             10 CONFLICT; 11 UNCERTAIN; 12 BUSY (lock wait exceeded); 13 FAILED (rolled back, nothing changed).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
export const ADVISORY_KEY = "cfoclose:hosted-migration-apply";
export const MANIFEST_PATH = path.join(HERE, "candidate-20261002100000.json");

export const EXIT = { OK: 0, REFUSED: 2, CONFLICT: 10, UNCERTAIN: 11, BUSY: 12, FAILED: 13 };

// ── candidate verification (no connection) ─────────────────────────────────────────────────────────────────────────

/** The candidate text, verified byte-for-byte against the manifest. Throws on any difference. */
export function loadCandidate(manifest, root = REPO) {
  const bytes = fs.readFileSync(path.join(root, manifest.source));
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== manifest.bytes) throw new Error(`candidate ${manifest.source} is ${bytes.length} bytes, expected ${manifest.bytes}`);
  if (sha !== manifest.sha256) throw new Error(`candidate ${manifest.source} SHA-256 ${sha}, expected ${manifest.sha256}`);
  const text = bytes.toString("utf8");
  // drizzle-orm records hash = sha256(file.toString()); identical to the byte hash only for clean UTF-8 without a BOM.
  if (crypto.createHash("sha256").update(text).digest("hex") !== sha || bytes[0] === 0xef) throw new Error("candidate is not clean UTF-8 (no BOM)");
  if (text.includes("--> statement-breakpoint")) throw new Error("candidate contains a drizzle statement-breakpoint; it must execute as one batch");
  return { text, sha, bytes: bytes.length };
}

/** The target must be the expected project: exactly its Supabase direct host, or its pooler user on a Supabase pooler host. */
export function checkTargetUrl(rawUrl, expectRef, { disposable = false, productionRef } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return "the connection URL is not a valid URL"; }
  if (disposable) {
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) return "disposable mode requires a loopback host";
    if (productionRef && rawUrl.includes(productionRef)) return "disposable mode refuses a URL naming the production project";
    return null;
  }
  if (!/^[a-z0-9]{20}$/.test(expectRef ?? "")) return "--expect-ref must be the 20-character project reference";
  const direct = u.hostname === `db.${expectRef}.supabase.co`;
  const pooler = /^[a-z0-9-]+.pooler.supabase.com$/.test(u.hostname) && decodeURIComponent(u.username) === `postgres.${expectRef}`;
  return direct || pooler ? null : `the connection URL does not name project ${expectRef} (expected db.${expectRef}.supabase.co, or user postgres.${expectRef} on *.pooler.supabase.com)`;
}

// ── inspection (read-only SQL) and the pure classifier ──────────────────────────────────────────────────────────────

export async function inspect(q, manifest) {
  const J = manifest.journal;
  const identity = (await q`SELECT (SELECT system_identifier::text FROM pg_control_system()) AS system_id, current_database() AS db,
    current_user AS role, current_setting('server_version') AS version`)[0];
  const journalExists = (await q`SELECT to_regclass(${`${J.schema}.${J.table}`}) IS NOT NULL AS ok`)[0].ok;
  const rows = journalExists
    ? await q.unsafe(`SELECT id, hash, created_at::text AS created_at FROM "${J.schema}"."${J.table}" ORDER BY created_at DESC NULLS LAST, id DESC`)
    : [];
  const names = Object.keys(manifest.postconditions.functions);
  const fns = await q`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.provolatile AS volatility, p.prosecdef AS secdef,
      p.proconfig AS config, p.proacl::text AS acl, p.proowner::regrole::text AS owner
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(${names})`;
  const T = manifest.postconditions.trigger;
  const trig = await q`SELECT t.tgname, t.tgtype, t.tgenabled, p.proname AS fn FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = to_regclass(${T.table}) AND t.tgname = ${T.name} AND NOT t.tgisinternal`;
  const rpcs = await q`SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ('grant_engagement_capability', 'open_engagement_with_scope')`;
  const lines = Object.fromEntries(Object.entries(manifest.postconditions.rpcLines).map(([fn, line]) => {
    const src = rpcs.find((r) => r.proname === fn)?.prosrc ?? null;
    return [fn, src === null ? null : src.split(line).length - 1];
  }));
  const rpcPrivileges = (await q`SELECT
      has_function_privilege('authenticated', 'public.grant_engagement_capability(uuid,text,text)', 'EXECUTE') AS grant_auth,
      has_function_privilege('anon', 'public.grant_engagement_capability(uuid,text,text)', 'EXECUTE') AS grant_anon,
      has_function_privilege('authenticated', 'public.open_engagement_with_scope(uuid,integer,text[],text)', 'EXECUTE') AS open_auth,
      has_function_privilege('anon', 'public.open_engagement_with_scope(uuid,integer,text[],text)', 'EXECUTE') AS open_anon`)[0];
  let behaviour = null;
  if (fns.some((f) => f.proname === "capability_customer_available")) {
    const all = [...manifest.postconditions.withheld, ...manifest.postconditions.available];
    behaviour = Object.fromEntries((await q`SELECT c, public.capability_customer_available(c) AS ok FROM unnest(${all}::text[]) c`).map((r) => [r.c, r.ok]));
  }
  return { identity, journalExists, rows, fns, trig, lines, rpcPrivileges, behaviour };
}

/** Postcondition failures for an applied candidate (empty = every postcondition holds). */
export function postconditionFailures(f, manifest) {
  const P = manifest.postconditions;
  const out = [];
  for (const [name, want] of Object.entries(P.functions)) {
    const got = f.fns.filter((x) => x.proname === name);
    if (got.length !== 1) { out.push(`function ${name}: ${got.length} definitions`); continue; }
    const g = got[0];
    if (g.args !== want.args) out.push(`function ${name}: args "${g.args}"`);
    if (g.volatility !== want.volatility) out.push(`function ${name}: volatility ${g.volatility}, expected ${want.volatility}`);
    if (g.secdef !== want.securityDefiner) out.push(`function ${name}: security definer ${g.secdef}`);
    if (!(g.config ?? []).some((c) => c === "search_path=pg_catalog, public")) out.push(`function ${name}: search_path not pinned`);
    if (g.acl !== `{${g.owner}=X/${g.owner}}`) out.push(`function ${name}: ACL ${g.acl} is not owner-only`);
  }
  if (f.trig.length !== 1) out.push(`trigger ${P.trigger.name}: ${f.trig.length} found`);
  else if (f.trig[0].tgtype !== P.trigger.tgtype || f.trig[0].fn !== P.trigger.function || f.trig[0].tgenabled !== "O") out.push(`trigger ${P.trigger.name}: tgtype ${f.trig[0].tgtype}, fn ${f.trig[0].fn}, enabled ${f.trig[0].tgenabled}`);
  for (const [fn, n] of Object.entries(f.lines)) if (n !== 1) out.push(`${fn}: availability line present ${n} time(s)`);
  const r = f.rpcPrivileges;
  if (!r.grant_auth || r.grant_anon || !r.open_auth || r.open_anon) out.push(`RPC privileges changed: ${JSON.stringify(r)}`);
  for (const c of P.withheld) if (f.behaviour?.[c] !== false) out.push(`capability_customer_available(${c}) is not false`);
  for (const c of P.available) if (f.behaviour?.[c] !== true) out.push(`capability_customer_available(${c}) is not true`);
  return out;
}

/** True when NOTHING of the candidate is present (the clean pre-state). */
export function isCleanPreState(f) {
  return f.fns.length === 0 && f.trig.length === 0 && Object.values(f.lines).every((n) => n === 0);
}

/**
 * Pure classification of the inspected facts.
 * @returns {{ outcome: "UNAPPLIED"|"ALREADY_APPLIED"|"CONFLICT", reason?: string, recordedAt?: string, failures?: string[] }}
 */
export function classify(f, manifest, { when = null } = {}) {
  const J = manifest.journal;
  if (!f.journalExists) return { outcome: "CONFLICT", reason: `journal ${J.schema}.${J.table} does not exist (wrong target?)` };
  const mine = f.rows.filter((r) => r.hash === manifest.sha256);
  const failures = postconditionFailures(f, manifest);
  if (mine.length > 1) return { outcome: "CONFLICT", reason: `the candidate is recorded ${mine.length} times in the journal`, failures };
  if (mine.length === 1) {
    if (failures.length) return { outcome: "CONFLICT", reason: "recorded in the journal but the postconditions do not hold", failures };
    if (when !== null && mine[0].created_at !== String(when)) return { outcome: "CONFLICT", reason: `already recorded with created_at ${mine[0].created_at}, not ${when}`, recordedAt: mine[0].created_at };
    return { outcome: "ALREADY_APPLIED", recordedAt: mine[0].created_at };
  }
  // Not recorded. The journal must end exactly where the reviewed lineage says it does.
  const last = f.rows[0];
  const L = J.expectedLastBeforeApply;
  if (!last || last.hash !== L.hash || last.created_at !== String(L.createdAt)) {
    return { outcome: "CONFLICT", reason: `journal lineage: last entry is ${last ? `${last.hash.slice(0, 12)}…@${last.created_at}` : "none"}, expected ${L.tag} (${L.hash.slice(0, 12)}…@${L.createdAt})` };
  }
  if (failures.length === 0) return { outcome: "CONFLICT", reason: "the candidate's objects are present but it is not recorded in the journal (applied out of band)" };
  if (!isCleanPreState(f)) return { outcome: "CONFLICT", reason: "part of the candidate is present without a journal record", failures };
  if (when !== null && !(Number(when) > Number(last.created_at))) return { outcome: "CONFLICT", reason: `--when ${when} must be greater than the last journal created_at ${last.created_at}` };
  return { outcome: "UNAPPLIED" };
}

// ── runner ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const LOCK_ERRORS = new Set(["55P03"]);              // lock_not_available (lock_timeout)
const CONNECTION_ERRORS = new Set(["ECONNRESET", "EPIPE", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "57P01", "57P02", "57P03"]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = { command };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const key = k.slice(2);
    if (["disposable", "test-fail-before-commit"].includes(key)) { o[key] = true; continue; }
    o[key] = rest[++i];
    if (o[key] === undefined) throw new Error(`${k} needs a value`);
  }
  return o;
}

export async function run(argv, { env = process.env, log = console.log, root = REPO, postgresModule } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`REFUSED ${e.message}`); return EXIT.REFUSED; }
  if (!["status", "apply"].includes(opts.command)) { log("REFUSED usage: applyCandidate.mjs <status|apply> --expect-ref <ref> [--expect-system-id <id> --when <ms>]"); return EXIT.REFUSED; }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  let candidate;
  try { candidate = loadCandidate(manifest, root); } catch (e) { log(`REFUSED ${e.message}`); return EXIT.REFUSED; }
  log(`CANDIDATE ${manifest.source} bytes=${candidate.bytes} sha256=${candidate.sha}`);

  const url = env[opts["url-env"] ?? "LOVABLE_DB_MIGRATION_URL"];
  if (!url) { log(`REFUSED ${opts["url-env"] ?? "LOVABLE_DB_MIGRATION_URL"} is not set`); return EXIT.REFUSED; }
  const urlProblem = checkTargetUrl(url, opts["expect-ref"], { disposable: !!opts.disposable, productionRef: manifest.productionRef });
  if (urlProblem) { log(`REFUSED ${urlProblem}`); return EXIT.REFUSED; }
  if (opts["test-fail-before-commit"] && !opts.disposable) { log("REFUSED the failure-injection hook exists only in --disposable mode"); return EXIT.REFUSED; }

  let when = null;
  if (opts.command === "apply") {
    if (!/^[0-9]{13}$/.test(opts.when ?? "")) { log("REFUSED apply needs --when <13-digit epoch milliseconds> (the journal entry's when)"); return EXIT.REFUSED; }
    if (!/^[0-9]{1,20}$/.test(opts["expect-system-id"] ?? "")) { log("REFUSED apply needs --expect-system-id <system_identifier printed by status>"); return EXIT.REFUSED; }
    when = opts.when;
  }

  const timeouts = {
    lock: opts["lock-timeout"] ?? "5s",
    statement: opts["statement-timeout"] ?? "120s",
    idle: opts["idle-timeout"] ?? "120s",
  };
  for (const v of Object.values(timeouts)) if (!/^[0-9]{1,6}(ms|s|min)$/.test(v)) { log(`REFUSED invalid timeout ${v}`); return EXIT.REFUSED; }

  const postgres = postgresModule ?? (await import(pathToFileURL(path.join(root, "node_modules/postgres/src/index.js")).href)).default;
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15, idle_timeout: 5,
    connection: { application_name: "cfoclose-hosted-apply", statement_timeout: 30000 } });
  let commitSent = false;
  try {
    // ── read-only status ──────────────────────────────────────────────────────────────────────────────────────────
    const facts = await sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", (tx) => inspect(tx, manifest));
    log(`TARGET system_identifier=${facts.identity.system_id} database=${facts.identity.db} role=${facts.identity.role} server=${facts.identity.version}`);
    log(`JOURNAL entries=${facts.rows.length} last=${facts.rows[0] ? `${facts.rows[0].hash}@${facts.rows[0].created_at}` : "none"}`);
    if (opts["expect-system-id"] && opts["expect-system-id"] !== facts.identity.system_id) {
      log(`REFUSED system_identifier ${facts.identity.system_id} is not the expected ${opts["expect-system-id"]}`);
      return EXIT.REFUSED;
    }
    const before = classify(facts, manifest, { when });
    log(`STATUS ${before.outcome}${before.reason ? ` — ${before.reason}` : ""}${before.recordedAt ? ` (recorded created_at ${before.recordedAt})` : ""}`);
    for (const x of before.failures ?? []) log(`  · ${x}`);
    if (opts.command === "status") return before.outcome === "CONFLICT" ? EXIT.CONFLICT : EXIT.OK;
    if (before.outcome === "ALREADY_APPLIED") { log("ALREADY_APPLIED nothing to do"); return EXIT.OK; }
    if (before.outcome !== "UNAPPLIED") return EXIT.CONFLICT;

    // ── apply: one transaction ────────────────────────────────────────────────────────────────────────────────────
    const J = manifest.journal;
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${timeouts.lock}'`);
      await tx.unsafe(`SET LOCAL statement_timeout = '${timeouts.statement}'`);
      await tx.unsafe(`SET LOCAL idle_in_transaction_session_timeout = '${timeouts.idle}'`);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${ADVISORY_KEY}, 0))`;
      await tx.unsafe(`LOCK TABLE "${J.schema}"."${J.table}" IN SHARE ROW EXCLUSIVE MODE`);
      const locked = classify(await inspect(tx, manifest), manifest, { when });
      if (locked.outcome === "ALREADY_APPLIED") return { outcome: "ALREADY_APPLIED", recordedAt: locked.recordedAt };
      if (locked.outcome !== "UNAPPLIED") return { outcome: "CONFLICT", reason: locked.reason, failures: locked.failures };
      await tx.unsafe(candidate.text);                                   // the approved SQL, verbatim, one batch
      await tx.unsafe(`INSERT INTO "${J.schema}"."${J.table}" ("hash", "created_at") VALUES ($1, $2)`, [candidate.sha, when]);
      const after = await inspect(tx, manifest);
      const check = classify(after, manifest, { when });
      if (check.outcome !== "ALREADY_APPLIED") throw Object.assign(new Error(`postconditions failed inside the transaction: ${check.reason} ${JSON.stringify(check.failures ?? [])}`), { code: "POSTCONDITION" });
      if (opts["test-fail-before-commit"]) throw Object.assign(new Error("induced failure before COMMIT (test hook)"), { code: "INDUCED" });
      commitSent = true;                                                   // sql.begin issues COMMIT when this returns
      return { outcome: "APPLIED" };
    });
    if (result.outcome === "CONFLICT") { log(`CONFLICT ${result.reason}`); for (const x of result.failures ?? []) log(`  · ${x}`); return EXIT.CONFLICT; }
    if (result.outcome === "ALREADY_APPLIED") { log(`ALREADY_APPLIED (another invocation applied it; recorded created_at ${result.recordedAt})`); return EXIT.OK; }

    // ── read-only verification after COMMIT ───────────────────────────────────────────────────────────────────────
    const verify = classify(await sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", (tx) => inspect(tx, manifest)), manifest, { when });
    if (verify.outcome !== "ALREADY_APPLIED") { log(`UNCERTAIN committed, but the read-only verification reads ${verify.outcome}: ${verify.reason ?? ""}`); return EXIT.UNCERTAIN; }
    log(`APPLIED ${manifest.journalTag} hash=${candidate.sha} created_at=${when}`);
    log(`JOURNAL_ENTRY ${JSON.stringify({ idx: 26, version: "7", when: Number(when), tag: manifest.journalTag, breakpoints: true })}`);
    return EXIT.OK;
  } catch (e) {
    const code = e?.code ?? e?.errno;
    if (commitSent && CONNECTION_ERRORS.has(code)) { log(`UNCERTAIN the connection failed while committing (${code}); run \`status\` (read-only) to resolve`); return EXIT.UNCERTAIN; }
    if (LOCK_ERRORS.has(code)) { log(`BUSY a lock was not granted within ${timeouts.lock}; nothing was changed (${e.message})`); return EXIT.BUSY; }
    log(`FAILED rolled back, nothing was changed (${code ?? "error"}: ${String(e?.message ?? e).split("\n")[0]})`);
    return EXIT.FAILED;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.log(`FAILED ${e?.message ?? e}`); process.exit(EXIT.FAILED); });
}
