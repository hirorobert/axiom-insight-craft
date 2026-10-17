#!/usr/bin/env node
// Interim, operator-run Reporting Pack orphan sweep (repair C follow-up; owner decision 4(b) of the release package).
// Until a scheduled sweeper kind exists, a NAMED operator runs this by hand on a fixed cadence. It decides nothing itself:
// the ONLY deletion rule is supabase/functions/_shared/reportingPackOrphans.mjs (unsealed AND past issuance expiry + 1 h
// grace, or no issuance and older than 1 h; a sealed object is never deleted; each issuance is re-read immediately
// before each deletion). It lists through the existing service-role RPC public.reporting_pack_storage_orphans(), reads
// public.reporting_pack_issuances, and deletes only through the Storage API (direct storage.objects deletes are refused).
//
//   dry run (default):  node scripts/ops/reportingPackOrphanSweep.mjs --operator "<name>"
//   apply:              node scripts/ops/reportingPackOrphanSweep.mjs --operator "<name>" --apply --confirm <N>
//     N must equal the number of objects this run itself finds deletable; otherwise nothing is deleted (exit 2).
//   env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (never printed or recorded), ORPHAN_SWEEP_RECORDS_DIR (default
//        ~/cfoclose-ops/reporting-pack-orphan-sweeps). Records name company and issuance ids: they are PRIVATE operator
//        records and must never be committed to this (public) repository.
//   exit: 0 done, nothing alarming · 2 alert (a failure, a confirm mismatch, or a deletable object older than 14 days) ·
//         1 the run could not complete.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orphanDecision, sweepReportingPackOrphans, ORPHAN_GRACE_MS } from "../../supabase/functions/_shared/reportingPackOrphans.mjs";

const BUCKET = "reporting-packs";
export const STALE_ALERT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * One run. deps: listOrphans(), issuance(id), remove(path) — the same contract as sweepReportingPackOrphans. Pure apart
 * from deps; returns the record (without secrets) and the exit code.
 */
export async function runOrphanSweep({ deps, operator, apply = false, confirm = null, nowMs = Date.now(), graceMs = ORPHAN_GRACE_MS }) {
  if (!operator || !String(operator).trim()) throw new Error("an operator name is required (--operator)");
  const listed = await deps.listOrphans();
  // Inventory: the rule's own decision for every listed object, before anything is deleted.
  const inventory = [];
  for (const o of listed) {
    const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.json$/.exec(o.storage_path ?? "");
    const iss = m ? await deps.issuance(m[2]) : null;
    const d = orphanDecision(o, iss, nowMs, graceMs);
    const dueSince = iss?.expires_at ? Date.parse(iss.expires_at) + graceMs : Date.parse(o.created_at) + graceMs;
    inventory.push({ path: o.storage_path, created_at: o.created_at, issuance_expires_at: iss?.expires_at ?? null, sealed: !!iss?.consumed_at, decision: d.reason, deletable: d.delete, overdueMs: d.delete ? Math.max(0, nowMs - dueSince) : 0 });
  }
  const deletable = inventory.filter((i) => i.deletable);
  const alerts = [];
  if (deletable.some((i) => i.overdueMs > STALE_ALERT_MS)) alerts.push("a deletable object has been overdue for more than 14 days");
  if (inventory.some((i) => i.decision === "unknown_expiry" || i.decision === "unknown_age")) alerts.push("an object's age or expiry could not be read");
  let outcome = { deleted: [], kept: [], failed: [] }, mode = "dry_run";
  if (apply) {
    if (confirm === null || Number(confirm) !== deletable.length) {
      alerts.push(`confirm mismatch: --confirm ${confirm} but this run found ${deletable.length} deletable; nothing was deleted`);
      mode = "apply_refused";
    } else {
      mode = "apply";
      // The rule re-reads each issuance immediately before each deletion (a concurrent seal keeps the object).
      outcome = await sweepReportingPackOrphans(deps, Date.now() > nowMs ? Date.now() : nowMs, graceMs);
      if (outcome.failed.length) alerts.push(`${outcome.failed.length} deletion(s) failed (retried by the next run)`);
    }
  }
  const counts = {
    listed: inventory.length, sealedListed: inventory.filter((i) => i.sealed).length, deletable: deletable.length,
    keptByReason: inventory.filter((i) => !i.deletable).reduce((a, i) => ({ ...a, [i.decision]: (a[i.decision] ?? 0) + 1 }), {}),
    deleted: outcome.deleted.length, failed: outcome.failed.length,
  };
  if (counts.sealedListed) alerts.push(`${counts.sealedListed} listed object(s) belong to a sealed issuance (the listing should exclude them)`);
  return { record: { operator: String(operator).trim(), mode, nowIso: new Date(nowMs).toISOString(), graceMs, counts, alerts, inventory, outcome }, exitCode: alerts.length ? 2 : 0 };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const operator = arg("--operator"), apply = process.argv.includes("--apply"), confirm = arg("--confirm");
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const recordsDir = process.env.ORPHAN_SWEEP_RECORDS_DIR ?? path.join(os.homedir(), "cfoclose-ops", "reporting-pack-orphan-sweeps");
  try {
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("refusing a non-HTTPS, non-loopback URL");
    const { createClient } = await import("@supabase/supabase-js");
    const svc = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const deps = {
      listOrphans: async () => { const { data, error } = await svc.rpc("reporting_pack_storage_orphans"); if (error) throw error; return data ?? []; },
      issuance: async (id) => { const { data, error } = await svc.from("reporting_pack_issuances").select("expires_at, consumed_at").eq("id", id).maybeSingle(); if (error) throw error; return data ?? null; },
      remove: async (p) => { const { error } = await svc.storage.from(BUCKET).remove([p]); return { error }; },
    };
    const started = new Date().toISOString();
    const { record, exitCode } = await runOrphanSweep({ deps, operator, apply, confirm });
    const runId = `${started.replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
    fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
    const host = new URL(url).host;
    fs.writeFileSync(path.join(recordsDir, `${runId}.json`), JSON.stringify({ runId, host, startedAt: started, finishedAt: new Date().toISOString(), ...record }, null, 2), { mode: 0o600 });
    console.log(`run ${runId} on ${host} · ${record.mode} · listed ${record.counts.listed} · deletable ${record.counts.deletable} · deleted ${record.counts.deleted} · failed ${record.counts.failed}`);
    for (const a of record.alerts) console.log(`ALERT: ${a}`);
    console.log(`record: ${path.join(recordsDir, `${runId}.json`)} (private; never commit)`);
    process.exit(exitCode);
  } catch (e) {
    console.error(`the sweep could not complete: ${String(e?.message ?? e).replace(key ?? "\u0000", "[redacted]")}`);
    process.exit(1);
  }
}
