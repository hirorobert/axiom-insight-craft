// The two reconciliation migrations that were authored and proven but never applied to the hosted database. They are
// quarantined (S1 record, PPG-1 precedent) in supabase/migrations_historical/ as `.sql.historical`, so the source chain in
// supabase/migrations/ is exactly what the hosted journal has run.
//
// Their proofs keep running as REVIVAL CANDIDATES: every current migration first, then the parked SQL — the only order a
// revival (a new forward migration after the current head) could take. The quarantine notice is comment-only; the SQL
// after it is the original file byte for byte, and its SHA-256 is pinned here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PARKED_MIGRATIONS = Object.freeze({
  "20261004100000_reconciliation_server_authority.sql": "befca97c5f8fe1a1a8f1d13ab05100facf29417de5d32ab6aa6f2eb214d3425d",
  "20261005100000_safisha_ingestion_authority.sql": "d814bbebeeaa541cbbe703aa3c037759e0b41882f7c64575f58ee3ed24bcc425",
});

const NOTICE_END = "-- ════════════════════════════════════════════════════════════════════════════\n\n";

/** The current source chain (supabase/migrations/*.sql, sorted) — never containing a parked migration. */
export function currentChain(repo) {
  const files = fs.readdirSync(path.join(repo, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) if (f in PARKED_MIGRATIONS) throw new Error(`${f} is quarantined and must not be in supabase/migrations/`);
  return files;
}

/**
 * S2 (20261008100000): from it on, a trial balance run starts only through tb_begin_attempt, certifications are written only
 * by tb_finalize_attempt, and an upload's processing fields change only inside an attempt. Proofs that SIMULATE the previous
 * engine (a direct run insert + commit_tb_certification, direct processing-field writes as the service role) prove their
 * release on the chain BEFORE it; scripts/db-proof/s2Authority.mjs re-proves, on S2's schema, the contracts S2 re-creates.
 */
export const ATTEMPT_AUTHORITY_MIGRATION = "20261008100000_processing_attempt_authority.sql";

/**
 * Sign-off completion requirements (20261017100000): a trial-balance report becomes REVIEWED/FINAL only on the CURRENT
 * authoritative reporting input with a finished Close Review. scripts/db-proof/run.mjs marks SYNTHETIC trial-balance
 * reports REVIEWED/FINAL to prove the persistence contracts, so it proves them on the chain BEFORE this migration;
 * scripts/db-proof/closeReviewAuthority.mjs re-proves the publication path end to end on the new schema with
 * authoritative reports (and that synthetic ones are refused).
 */
export const SIGNOFF_REQUIREMENTS_MIGRATION = "20261017100000_signoff_completion_requirements.sql";

/** `files` up to, not including, `file` (all of them when it is absent). */
export function chainBefore(files, file) {
  const i = files.indexOf(file);
  return i < 0 ? files : files.slice(0, i);
}

/** The original SQL of a parked migration (the quarantine notice removed), verified against its pinned SHA-256. */
export function parkedMigrationSql(repo, file) {
  const expected = PARKED_MIGRATIONS[file];
  if (!expected) throw new Error(`${file} is not a parked migration`);
  const text = fs.readFileSync(path.join(repo, "supabase/migrations_historical", `${file}.historical`), "utf8");
  const at = text.indexOf(NOTICE_END); // the notice's closing bar (its opening bar is followed by text, not a blank line)
  if (!text.startsWith("-- ════") || at < 0) throw new Error(`${file}.historical has no quarantine notice`);
  const sql = text.slice(at + NOTICE_END.length);
  const sha = crypto.createHash("sha256").update(sql, "utf8").digest("hex");
  if (sha !== expected) throw new Error(`${file}: original SQL hash ${sha} does not equal the pinned ${expected}`);
  return sql;
}

/** Migration text by name: a current migration from supabase/migrations/, a parked one from its quarantine. */
export function migrationSql(repo, file) {
  return file in PARKED_MIGRATIONS ? parkedMigrationSql(repo, file) : fs.readFileSync(path.join(repo, "supabase/migrations", file), "utf8");
}
