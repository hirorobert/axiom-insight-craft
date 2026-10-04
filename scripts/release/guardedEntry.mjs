// Guarded native-migrator entries for the approved release sources (reviewed alongside scripts/db-proof/migratorRelease.mjs).
//
// drizzle-orm's migrate() (the native-compatible migrator; this repository pins 0.45.2) runs every pending entry and
// inserts its journal row inside ONE transaction, but it reads the latest journal row BEFORE that transaction and takes no
// lock, and the journal has no uniqueness. So any entry whose SQL can succeed a second time — a replay-safe source, or a
// wrapper that returns as a no-op when already applied — lets a stale or concurrent migrator run record a DUPLICATE
// journal row. The entry itself must therefore REFUSE a second application. A guarded entry is:
//
//   1. a guard DO block: a transaction advisory lock (all guarded entries serialize), the release ledger
//      public._release_migration_ledger (created if absent; RLS on; no grant to any client role, service_role included),
//      and RAISE 55000 when this source is already recorded — so the second run rolls back with its journal row;
//   2. the approved source file, byte for byte;
//   3. a record DO block: the source's own read-only post-apply verification must report every `ok` true (otherwise RAISE
//      55000), then the ledger row is inserted.
// All of it, and the migrator's journal row, commit or roll back together. No staging table is read.
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

export function guardPrefix({ source, digest, bytes, head }) {
  return `-- Guarded native application of supabase/migrations/${source}
-- (${bytes} bytes, SHA-256 ${digest}; approved main ${head}).
-- One migrator transaction: this guard, the approved source byte for byte, its postconditions and the ledger record; the
-- migrator records its journal row in the same transaction. A second application — a retry, a stale or a concurrent
-- migrator run — is REFUSED (SQLSTATE 55000), never a silent no-op, so it rolls back together with its journal row.
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
END
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
export function renderGuardedEntry({ source, sourceText, head, verifyText }) {
  const buf = Buffer.from(sourceText, "utf8");
  const meta = { source, digest: sha256(buf), bytes: buf.length, head };
  return guardPrefix(meta) + sourceText + recordSuffix({ ...meta, verifyText });
}

/** Problems with an entry claimed to be the guarded application of `source` (empty when exact). */
export function checkGuardedEntry(text, { source, head, repoRoot, verify }) {
  const sourceText = fs.readFileSync(path.join(repoRoot, "supabase/migrations", source), "utf8");
  const verifyText = fs.readFileSync(path.join(repoRoot, "scripts/db-preflight", verify), "utf8");
  const expected = renderGuardedEntry({ source, sourceText, head, verifyText });
  const problems = [];
  if (text !== expected) problems.push(`is not exactly the guarded entry for ${source} (approved source, guard, postconditions and ledger record)`);
  if (text.split(sourceText).length !== 2) problems.push(`must contain ${source} byte for byte exactly once`);
  return problems;
}

/** The two approved release sources, their verification files and the approved head. */
export const RELEASE_2026_10 = {
  head: "bf86417459003490e75cc3fd33e2ad83366f5fb1",
  entries: [
    { tag: "0027_apply_20261004100000_reconciliation_server_authority", source: "20261004100000_reconciliation_server_authority.sql",
      bytes: 34236, digest: "befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d", verify: "reconciliationAuthorityVerify.sql" },
    { tag: "0028_apply_20261005100000_safisha_ingestion_authority", source: "20261005100000_safisha_ingestion_authority.sql",
      bytes: 28693, digest: "d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425", verify: "safishaIngestionVerify.sql" },
  ],
};
