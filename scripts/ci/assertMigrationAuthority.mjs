#!/usr/bin/env node
// Migration authority guard.
//
// This repository has TWO migration representations:
//   supabase/migrations/   the AUTHORED source of truth: every schema change is written here, forward-only, and CI
//                          replays the whole chain on disposable PostgreSQL (release gate, contract harness, proofs).
//   drizzle/migrations/    Lovable's APPLY JOURNAL for the hosted database (drizzle-kit, LOVABLE_DB_MIGRATION_URL,
//                          drizzle.__drizzle_migrations). Lovable adds an entry when a source migration is applied to the
//                          hosted database; its SQL is the source migration with comments stripped.
// Two representations are only safe with a deterministic parity check. This guard proves, on every CI run, that:
//   1. the journal, its SQL files and its snapshots agree (sequential idx, unique tags, no stray files);
//   2. every Drizzle migration mirrors exactly ONE source migration — byte-equal after comment / whitespace
//      normalisation — or is one of the explicitly pinned, reviewed exceptions below (verified, never skipped);
//   3. mirrors appear in source order, and every source migration between the first and the last mirrored one is
//      mirrored or reconciled (no source migration was skipped by the hosted journal);
//   4. source migrations newer than the last mirrored one are listed as PENDING_HOSTED_APPLY (authored, not yet applied
//      by Lovable) — that is the expected state of an unmerged or unapplied change, never an error;
//   5. a registered difference is RESOLVED only by a named forward migration that exists and contains the exact
//      corrective statements (its own journal mirror must then match it byte for byte, like any other);
//   6. no source migration and no journal entry may grant the service-only workspace-authority predicates to anyone
//      else, or re-create them without revoking them from PUBLIC, anon and authenticated in the same file (a
//      re-created function would otherwise inherit the platform's default EXECUTE grants).
// It never connects to a database and never writes a file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAtomicEnvelope, parseAtomicEnvelope, unwrapAtomicEnvelope } from "./atomicEnvelope.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Reviewed exceptions. Each is verified by the rule named, never skipped.
export const PINNED = {
  // Lovable's copy reorders two independent statements (plpgsql resolves functions at run time) AND differs from its
  // source in ONE statement: it revokes EXECUTE on can_user_act_on_workspace(uuid, uuid, text) from PUBLIC and anon but
  // NOT from authenticated (MIGRATION-AUTHORITY-DRIFT-0006: a signed-in user could ask whether ANY user can act on ANY
  // workspace). An applied journal entry is history and is never edited; the difference is RESOLVED forward by
  // 20260925150000, which converges both histories to EXECUTE for service_role only. Verified: identical statement
  // multiset except exactly this one, and the resolving migration contains the exact corrective statements.
  "0006_pr32_02_upload_lifecycle_retire_and_replace": {
    source: "20260923100000_upload_lifecycle_retire_and_replace.sql", rule: "same_statements",
    knownDifference: {
      source: "REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon, authenticated",
      drizzle: "REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon",
      resolvedBy: "20260925150000_can_user_act_on_workspace_minimum_grant.sql",
      resolution: [
        "REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon, authenticated",
        "GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO service_role",
      ],
    },
  },
  // The service-enquiry intake was applied through the elevated SQL path; this entry is a pure fail-closed assertion
  // that the live schema matches the source and changes nothing. Verified to contain a single DO block and no DDL/DML.
  "0003_service_enquiry_intake_reconciliation_assert": { source: "20260921100000_service_enquiry_intake.sql", rule: "assertion_only" },
};

// Service-only predicates: EXECUTE for service_role (and the owner) only. See 20260925150000.
export const SERVICE_ONLY_FUNCTIONS = ["can_user_act_on_workspace", "workspace_authority_basis"];

const stripComments = (sql) => sql.replace(/\r/g, "").replace(/--[^\n]*/g, "");
const normalise = (sql) => stripComments(sql).replace(/\s+/g, " ").trim();

export function splitStatements(sql) {
  const out = []; let cur = ""; let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === "$") { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { const e = sql.indexOf(m[0], i + m[0].length); const j = e < 0 ? sql.length : e + m[0].length; cur += sql.slice(i, j); i = j; continue; } }
    if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// An atomic migration (one DO envelope, scripts/ci/atomicEnvelope.mjs) is judged by the statements it executes.
// An invalid envelope is reported by rule 7 (never skipped); its raw text is then split as-is, so no statement is lost.
const unwrapOrRaw = (sql) => { try { return unwrapAtomicEnvelope(sql); } catch { return sql; } };
const statements = (sql) => splitStatements(normalise(unwrapOrRaw(sql))).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

export function checkMigrationAuthority(repo = REPO) {
  const errors = [];
  const srcDir = path.join(repo, "supabase/migrations");
  const dzDir = path.join(repo, "drizzle/migrations");
  const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith(".sql")).sort();
  const srcText = Object.fromEntries(sources.map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8")]));
  // 7. Every migration that claims the atomic envelope is exactly one valid envelope whose every executable statement is
  //    visible to this guard (fail closed: text outside it, dynamic SQL, malformed / reused / nested tags are refused).
  for (const f of sources) {
    if (!isAtomicEnvelope(srcText[f])) continue;
    try { parseAtomicEnvelope(srcText[f]); } catch (e) { errors.push(`source: ${f}: ${e.message}`); }
  }
  const byNormal = new Map(sources.map((f) => [normalise(srcText[f]), f]));

  const journal = JSON.parse(fs.readFileSync(path.join(dzDir, "meta/_journal.json"), "utf8"));
  const entries = journal.entries ?? [];
  const tags = entries.map((e) => e.tag);
  entries.forEach((e, i) => { if (e.idx !== i) errors.push(`journal: entry ${e.tag} has idx ${e.idx}, expected ${i}`); });
  if (new Set(tags).size !== tags.length) errors.push("journal: duplicate tags");
  const sqlFiles = fs.readdirSync(dzDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of sqlFiles) if (!tags.includes(f.replace(/\.sql$/, ""))) errors.push(`drizzle: ${f} is not in the journal`);
  for (const t of tags) {
    if (!sqlFiles.includes(`${t}.sql`)) errors.push(`journal: ${t} has no SQL file`);
    const n = t.slice(0, 4);
    if (!fs.existsSync(path.join(dzDir, `meta/${n}_snapshot.json`))) errors.push(`journal: ${t} has no snapshot`);
  }

  const mirrored = [];
  const knownDrift = [];
  const resolved = [];

  // Rule 6: the service-only predicates are never granted to anyone else, and never re-created without the revoke.
  const dzFiles = fs.readdirSync(dzDir).filter((f) => f.endsWith(".sql")).sort();
  const allSql = [...sources.map((f) => ["supabase/migrations/" + f, srcText[f]]), ...dzFiles.map((f) => ["drizzle/migrations/" + f, fs.readFileSync(path.join(dzDir, f), "utf8")])];
  for (const [name, text] of allSql) {
    const st = statements(text);
    for (const fnName of SERVICE_ONLY_FUNCTIONS) {
      // Unanchored: a statement may be wrapped in an atomic DO envelope (EXECUTE of the original text).
      const grant = new RegExp(`\\bGRANT [A-Z, ]+ ON FUNCTION public\\.${fnName}\\b[^;$]*? TO ([a-z_]+(?:\\s*,\\s*[a-z_]+)*)`, "gi");
      for (const s of st) {
        for (const m of s.matchAll(grant)) {
          if (!/^service_role$/i.test(m[1].trim())) errors.push(`permissions: ${name} grants ${fnName} to ${m[1].trim()} (service_role only)`);
        }
      }
      const recreated = st.some((s) => new RegExp(`\\b(CREATE (OR REPLACE )?FUNCTION|DROP FUNCTION( IF EXISTS)?) public\\.${fnName}\\b`, "i").test(s));
      const revoked = st.some((s) => new RegExp(`\\bREVOKE ALL ON FUNCTION public\\.${fnName}\\(uuid, uuid, text\\) FROM PUBLIC, anon, authenticated\\b`, "i").test(s));
      const historical = name === "drizzle/migrations/0006_pr32_02_upload_lifecycle_retire_and_replace.sql" && fnName === "can_user_act_on_workspace";
      if (recreated && !revoked && !historical) errors.push(`permissions: ${name} re-creates ${fnName} without revoking it from PUBLIC, anon and authenticated`);
    }
  }
  for (const t of tags) {
    const file = path.join(dzDir, `${t}.sql`);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const exact = byNormal.get(normalise(text));
    const pin = PINNED[t];
    if (exact && !pin) { mirrored.push({ tag: t, source: exact, how: "equal" }); continue; }
    if (!pin) { errors.push(`drizzle: ${t} matches no source migration (drift)`); continue; }
    if (!srcText[pin.source]) { errors.push(`drizzle: ${t} is pinned to a missing source ${pin.source}`); continue; }
    if (pin.rule === "same_statements") {
      const d = statements(text), src = statements(srcText[pin.source]);
      if (pin.knownDifference) {
        const di = d.indexOf(pin.knownDifference.drizzle), si = src.indexOf(pin.knownDifference.source);
        if (di < 0 || si < 0) errors.push(`drizzle: ${t}: the registered difference is no longer exactly as recorded (re-review)`);
        else { d.splice(di, 1); src.splice(si, 1); }
      }
      if (d.sort().join("\n;\n") !== src.sort().join("\n;\n")) errors.push(`drizzle: ${t} no longer has exactly the statements of ${pin.source}${pin.knownDifference ? " (beyond the one registered difference)" : ""}`);
      if (pin.knownDifference) {
        const kd = pin.knownDifference;
        const fix = kd.resolvedBy && srcText[kd.resolvedBy] ? statements(srcText[kd.resolvedBy]) : null;
        if (!kd.resolvedBy) knownDrift.push(`${t}: ${kd.drizzle} (source: ${kd.source})`);
        else if (!fix) errors.push(`drizzle: ${t}: the resolving migration ${kd.resolvedBy} is missing`);
        else if (!(kd.resolution ?? []).every((st) => fix.includes(st))) errors.push(`drizzle: ${t}: ${kd.resolvedBy} no longer contains the exact corrective statements`);
        else if (sources.indexOf(kd.resolvedBy) <= sources.indexOf(pin.source)) errors.push(`drizzle: ${t}: ${kd.resolvedBy} must come after ${pin.source}`);
        else resolved.push(`${t}: ${kd.drizzle} -> resolved by ${kd.resolvedBy}`);
      }
    } else if (pin.rule === "assertion_only") {
      const st = statements(text);
      if (st.length !== 1 || !/^DO \$/.test(st[0]) || /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE)\b(?![^$]*\$reconcile\$)/.test(st[0].replace(/'[^']*'/g, "''").replace(/RAISE EXCEPTION[^;]*/g, ""))) {
        errors.push(`drizzle: ${t} must be a single DO assertion block that changes nothing`);
      }
    } else errors.push(`drizzle: ${t} has an unknown pin rule`);
    mirrored.push({ tag: t, source: pin.source, how: pin.rule });
  }

  const order = mirrored.map((m) => sources.indexOf(m.source));
  for (let i = 1; i < order.length; i++) if (!(order[i] > order[i - 1])) errors.push(`drizzle: ${mirrored[i].tag} mirrors ${mirrored[i].source} out of source order`);
  const pending = [];
  if (mirrored.length > 0) {
    const first = Math.min(...order), last = Math.max(...order);
    const covered = new Set(mirrored.map((m) => m.source));
    for (let i = first; i <= last; i++) if (!covered.has(sources[i])) errors.push(`drizzle: source ${sources[i]} was skipped by the hosted apply journal`);
    for (let i = last + 1; i < sources.length; i++) pending.push(sources[i]);
  }
  return { ok: errors.length === 0, errors, mirrored, pending, knownDrift, resolved };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkMigrationAuthority();
  for (const e of r.errors) console.error(`  - ${e}`);
  for (const k of r.knownDrift) console.log(`  REGISTERED DRIFT (owner decision): ${k}`);
  for (const k of r.resolved) console.log(`  RESOLVED DRIFT: ${k}`);
  console.log(r.ok
    ? `MIGRATION_AUTHORITY: OK (${r.mirrored.length} Drizzle entries mirror source migrations; PENDING_HOSTED_APPLY: ${r.pending.length ? r.pending.join(", ") : "none"})`
    : `MIGRATION_AUTHORITY: DRIFT (${r.errors.length} problem(s))`);
  process.exitCode = r.ok ? 0 : 1;
}
