// OBSOLETE (2026-10-05) — handoff r5 is void: hosted journal entry 0027 is the applied account-review digest fix
// (20261003100000), so r5's proposed 0027/0028 numbering conflicts with the hosted journal. Parked, NOT run in CI, and never
// to be applied as it stands. See release/candidates/OBSOLETE.md.
// Guarded release entries for the approved release sources (reviewed alongside scripts/db-proof/hostedExecutorRelease.mjs and
// scripts/db-proof/migratorRelease.mjs).
//
// Lovable's hosted executor (its own statement, 2026-10-05): one tool invocation submits ONE SQL string; the host runs it
// in its own transaction and inserts that entry's drizzle.__drizzle_migrations row in the SAME transaction. Two entries are
// two invocations, two transactions: 0027 can commit and 0028 fail. drizzle-orm's migrate() (the repository-compatible
// migrator) instead runs every pending entry in one transaction, but reads the latest journal row before it with no lock.
// Under either executor nothing makes the journal unique, so the ENTRY must refuse a second application. A guarded entry is:
//
//   1. a guard DO block: a transaction advisory lock (all guarded entries serialize), the release ledger
//      public._release_migration_ledger (created if absent; source is its primary key; RLS on; no grant to any client role,
//      service_role included); RAISE 55000 when this source is already recorded; and RAISE 55000 when a prerequisite
//      release source is not recorded with its exact digest -- so a retry, a stale or concurrent invocation, or an entry
//      submitted out of order rolls back together with its journal row;
//   2. the approved source file, byte for byte;
//   3. a record DO block: the source's own read-only post-apply verification must report every `ok` true (otherwise RAISE
//      55000), then the ledger row is inserted.
// No staging table is read. renderInspection() renders the read-only query that resolves an uncertain outcome.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LEDGER = "public._release_migration_ledger";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** The post-apply verification query of a source as a subquery body (its trailing ';' removed). */
function verificationBody(verifyText) {
  const t = verifyText.replace(/\s+$/, "");
  if (!t.endsWith(";")) throw new Error("a verification file must end with ';'");
  return t.slice(0, -1);
}

/** RAISE when a prerequisite release source is not recorded with its exact digest. */
function prerequisiteChecks(source, requires) {
  return requires.map((r) => `  IF NOT EXISTS (SELECT 1 FROM ${LEDGER} WHERE source = '${r.source}' AND source_sha256 = '${r.digest}') THEN
    RAISE EXCEPTION 'RELEASE_PREREQUISITE_MISSING: ${source} requires ${r.source} to be applied first; nothing was changed' USING ERRCODE = '55000';
  END IF;
`).join("");
}

export function guardPrefix({ source, digest, bytes, head, requires = [] }) {
  return `-- Guarded native application of supabase/migrations/${source}
-- (${bytes} bytes, SHA-256 ${digest}; approved main ${head}).
-- One transaction: this guard, the approved source byte for byte, its postconditions and the ledger record; the executor
-- records this entry's journal row in the same transaction. A second application (a retry, a stale or a concurrent
-- invocation) or an application before its prerequisite is REFUSED (SQLSTATE 55000), never a silent no-op, so it rolls
-- back together with its journal row.
DO $release_guard$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_release_ledger', 0));
  CREATE TABLE IF NOT EXISTS ${LEDGER} (
    source        text        PRIMARY KEY,
    source_sha256 text        NOT NULL,
    applied_at    timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE ${LEDGER} ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON ${LEDGER} FROM PUBLIC, anon, authenticated, service_role;
  IF EXISTS (SELECT 1 FROM ${LEDGER} WHERE source = '${source}') THEN
    RAISE EXCEPTION 'RELEASE_ALREADY_APPLIED: ${source} is already recorded; nothing was changed' USING ERRCODE = '55000';
  END IF;
${prerequisiteChecks(source, requires)}END
$release_guard$;
`;
}

export function recordSuffix({ source, digest, verifyText }) {
  return `
DO $release_record$
BEGIN
  IF EXISTS (SELECT 1 FROM (
${verificationBody(verifyText)}
  ) v WHERE v.ok IS NOT TRUE) THEN
    RAISE EXCEPTION 'RELEASE_POSTCONDITION_FAILED: ${source}; nothing was changed' USING ERRCODE = '55000';
  END IF;
  INSERT INTO ${LEDGER} (source, source_sha256) VALUES ('${source}', '${digest}');
END
$release_record$;
`;
}

/** The exact entry text for an approved source (sourceText byte-identical to the repository file). */
export function renderGuardedEntry({ source, sourceText, head, verifyText, requires = [] }) {
  const buf = Buffer.from(sourceText, "utf8");
  const meta = { source, digest: sha256(buf), bytes: buf.length, head, requires };
  return guardPrefix(meta) + sourceText + recordSuffix({ ...meta, verifyText });
}

/** Problems with an entry claimed to be the guarded application of `source` (empty when exact). */
export function checkGuardedEntry(text, { source, head, repoRoot, verify, requires = [] }) {
  const sourceText = fs.readFileSync(path.join(repoRoot, "supabase/migrations", source), "utf8");
  const verifyText = fs.readFileSync(path.join(repoRoot, "scripts/db-preflight", verify), "utf8");
  const expected = renderGuardedEntry({ source, sourceText, head, verifyText, requires });
  const problems = [];
  if (text !== expected) problems.push(`is not exactly the guarded entry for ${source} (approved source, guard, prerequisites, postconditions and ledger record)`);
  if (text.split(sourceText).length !== 2) problems.push(`must contain ${source} byte for byte exactly once`);
  return problems;
}

const R27 = { tag: "0027_apply_20261004100000_reconciliation_server_authority", source: "20261004100000_reconciliation_server_authority.sql",
  bytes: 34236, digest: "befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d", verify: "reconciliationAuthorityVerify.sql",
  probe: "to_regprocedure('public.safisha_record_match_result(uuid,uuid,jsonb)') IS NOT NULL", requires: [] };
// 0028's review items are decided only through 0027's safisha_decide_exception, and its completeness rules are 0027's:
// applied alone it would open review items that the pre-release resolve path could mark 'clean'. It therefore requires 0027.
const R28 = { tag: "0028_apply_20261005100000_safisha_ingestion_authority", source: "20261005100000_safisha_ingestion_authority.sql",
  bytes: 28693, digest: "d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425", verify: "safishaIngestionVerify.sql",
  probe: "to_regprocedure('public.safisha_ingest_evidence(uuid,uuid,text,text,text,jsonb,text,jsonb)') IS NOT NULL",
  requires: [{ source: R27.source, digest: R27.digest }] };

/** The two approved release sources (applied in this order), their verification files, prerequisites and the approved head;
 *  `after` is the hosted journal's latest entry before the release (0026). */
export const RELEASE_2026_10 = {
  head: "bf86417459003490e75cc3fd33e2ad83366f5fb1",
  after: "0026_apply_20261002100000_refuse_withheld_service_grants",
  entries: [R27, R28],
};

const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const count = (sql) => `(xpath('/row/n/text()', query_to_xml(${lit(sql)}, false, true, '')))[1]::text::bigint`;
const LEDGER_EXISTS = "to_regclass('public._release_migration_ledger') IS NOT NULL";
const JOURNAL_EXISTS = "to_regclass('drizzle.__drizzle_migrations') IS NOT NULL";

/**
 * The READ-ONLY inspection that resolves an uncertain outcome (a lost response, a timeout, an error) before any retry.
 * `entries` (in application order) carry `entrySha256` (the SHA-256 of the exact entry text submitted, which is its
 * expected journal hash) and `verifyText`; `afterHash` is the journal hash of the latest entry before the release.
 * One row per entry, then one 'release' row. An entry is APPLIED (exactly one ledger row, with the exact source digest;
 * exactly one journal row with the entry hash; no journal row with the bare source hash; objects present; every
 * postcondition true), NOT_APPLIED (none of it) or INCONSISTENT. The release is COMPLETE, NOT_STARTED, PARTIAL (a prefix
 * applied) or INCONSISTENT, including when the journal rows after the pre-release entry are not exactly the applied
 * entries. publication_permitted is true only when COMPLETE.
 */
export function renderInspection({ entries, afterHash }) {
  const tag = "$inspect$";
  for (const e of entries) if (e.verifyText.includes(tag)) throw new Error("a verification file contains the inspection quote tag");
  const rows = entries.map((e, i) => `  (${i + 1}, ${lit(e.tag)}, ${lit(e.source)}, ${lit(e.digest)}, ${lit(e.entrySha256)},
   CASE WHEN ${LEDGER_EXISTS} THEN ${count(`SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ${lit(e.source)}`)} ELSE 0 END,
   CASE WHEN ${LEDGER_EXISTS} THEN ${count(`SELECT count(*) AS n FROM public._release_migration_ledger WHERE source = ${lit(e.source)} AND source_sha256 = ${lit(e.digest)}`)} ELSE 0 END,
   CASE WHEN ${JOURNAL_EXISTS} THEN ${count(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ${lit(e.entrySha256)}`)} ELSE 0 END,
   CASE WHEN ${JOURNAL_EXISTS} THEN ${count(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ${lit(e.digest)}`)} ELSE 0 END,
   ${e.probe},
   CASE WHEN ${e.probe} THEN (xpath('/row/ok/text()', query_to_xml(${tag}SELECT bool_and(v.ok IS TRUE) AS ok FROM (
${verificationBody(e.verifyText)}
) v${tag}, false, true, '')))[1]::text::boolean END)`).join(",\n");
  const after = `SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE created_at > (SELECT max(created_at) FROM drizzle.__drizzle_migrations WHERE hash = ${lit(afterHash)})`;
  return `-- READ-ONLY release inspection: ${entries.map((e) => e.source).join(" + ")}.
-- Run inside BEGIN READ ONLY; ... ROLLBACK; before ANY retry after an uncertain outcome. It changes nothing.
-- One row per entry, then one 'release' row. Act only on next_step. Never insert, update or delete journal or ledger rows.
WITH e(ord, entry, source, source_sha256, entry_journal_hash, ledger_rows, ledger_rows_exact_digest, journal_rows_entry_hash,
       journal_rows_source_hash, objects_present, postconditions_ok) AS (VALUES
${rows}
),
s AS (
  SELECT e.*,
         CASE WHEN ledger_rows = 1 AND ledger_rows_exact_digest = 1 AND journal_rows_entry_hash = 1 AND journal_rows_source_hash = 0
                   AND objects_present AND postconditions_ok IS TRUE THEN 'APPLIED'
              WHEN ledger_rows = 0 AND journal_rows_entry_hash = 0 AND journal_rows_source_hash = 0 AND NOT objects_present THEN 'NOT_APPLIED'
              ELSE 'INCONSISTENT' END AS state
    FROM e
),
j AS (
  SELECT CASE WHEN ${JOURNAL_EXISTS} THEN ${count(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations WHERE hash = ${lit(afterHash)}`)} END AS pre_release_rows,
         CASE WHEN ${JOURNAL_EXISTS} THEN ${count(after)} END AS rows_after
),
r AS (
  SELECT CASE WHEN (SELECT pre_release_rows FROM j) IS DISTINCT FROM 1
                   OR (SELECT rows_after FROM j) IS DISTINCT FROM count(*) FILTER (WHERE state = 'APPLIED') THEN 'INCONSISTENT'
              WHEN bool_and(state = 'APPLIED') THEN 'COMPLETE'
              WHEN bool_and(state = 'NOT_APPLIED') THEN 'NOT_STARTED'
              WHEN bool_and(state IN ('APPLIED', 'NOT_APPLIED'))
                   AND NOT EXISTS (SELECT 1 FROM s a JOIN s b ON b.ord < a.ord WHERE a.state = 'APPLIED' AND b.state = 'NOT_APPLIED') THEN 'PARTIAL'
              ELSE 'INCONSISTENT' END AS state
    FROM s
)
SELECT s.ord, s.entry AS item, s.state,
       CASE WHEN (SELECT state FROM r) = 'INCONSISTENT' THEN 'STOP: inconsistent release state; escalate; do not resubmit; never edit the journal or the ledger'
            WHEN s.state = 'APPLIED' THEN 'none: applied; never resubmit this entry'
            WHEN NOT EXISTS (SELECT 1 FROM s p WHERE p.ord < s.ord AND p.state <> 'APPLIED') THEN 'submit this entry once, exactly as handed off'
            ELSE 'wait: the earlier entry must be applied first' END AS next_step,
       s.source, s.source_sha256, s.entry_journal_hash, s.ledger_rows, s.ledger_rows_exact_digest, s.journal_rows_entry_hash,
       s.journal_rows_source_hash, s.objects_present, s.postconditions_ok, NULL::bigint AS journal_rows_after_pre_release,
       NULL::boolean AS publication_permitted
  FROM s
UNION ALL
SELECT ${entries.length + 1}, 'release', (SELECT state FROM r),
       CASE (SELECT state FROM r) WHEN 'COMPLETE' THEN 'migrations complete; continue the release checklist'
                                  WHEN 'INCONSISTENT' THEN 'STOP: escalate; publication blocked'
                                  ELSE 'publication blocked until every entry is APPLIED' END,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, (SELECT rows_after FROM j), (SELECT state FROM r) = 'COMPLETE'
ORDER BY 1;
`;
}

/** Every rendered release file (path relative to the repository root -> exact text): both entries and the inspection. */
export function renderRelease(repoRoot, release = RELEASE_2026_10) {
  const read = (p) => fs.readFileSync(path.join(repoRoot, p), "utf8");
  const files = {};
  const entries = release.entries.map((e) => {
    const verifyText = read(`scripts/db-preflight/${e.verify}`);
    const text = renderGuardedEntry({ source: e.source, sourceText: read(`supabase/migrations/${e.source}`), head: release.head, verifyText, requires: e.requires });
    files[`release/candidates/${e.tag}.sql`] = text;
    return { ...e, verifyText, entrySha256: sha256(Buffer.from(text, "utf8")) };
  });
  const afterHash = sha256(Buffer.from(read(`drizzle/migrations/${release.after}.sql`), "utf8"));
  files["release/candidates/inspect_release_2026_10.sql"] = renderInspection({ entries, afterHash });
  return files;
}
