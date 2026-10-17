// node scripts/ops/reportingPackOrphanSweep.test.mjs — the interim operator sweep, with injected storage and database.
import { runOrphanSweep, STALE_ALERT_MS, MAX_CLOCK_SKEW_MS } from "./reportingPackOrphanSweep.mjs";

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}`); } };
const H = 3600_000, NOW = Date.parse("2026-10-20T12:00:00Z");
const co = "11111111-1111-1111-1111-111111111111";
const p = (iss) => `${co}/${iss}.json`;
const ID = { expired: "22222222-2222-2222-2222-222222222222", live: "33333333-3333-3333-3333-333333333333", sealed: "44444444-4444-4444-4444-444444444444", none: "55555555-5555-5555-5555-555555555555", old: "66666666-6666-6666-6666-666666666666" };
const world = () => {
  const issuances = {
    [ID.expired]: { expires_at: new Date(NOW - 3 * H).toISOString(), consumed_at: null },
    [ID.live]: { expires_at: new Date(NOW + 2 * H).toISOString(), consumed_at: null },
    [ID.sealed]: { expires_at: new Date(NOW - 5 * H).toISOString(), consumed_at: new Date(NOW - 6 * H).toISOString() },
    [ID.old]: { expires_at: new Date(NOW - STALE_ALERT_MS - 2 * H).toISOString(), consumed_at: null },
  };
  const objects = [ID.expired, ID.live, ID.none].map((i) => ({ storage_path: p(i), created_at: new Date(NOW - 4 * H).toISOString() }));
  const removed = [];
  const deps = { listOrphans: async () => objects, issuance: async (id) => issuances[id] ?? null, remove: async (path) => { removed.push(path); return { error: null }; } };
  return { deps, issuances, objects, removed };
};

{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", nowMs: NOW });
  check("dry run deletes nothing and inventories the rule's own decisions", w.removed.length === 0 && r.record.mode === "dry_run" && r.record.counts.deletable === 2 && r.exitCode === 0); }
{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW, serverNowMs: NOW });
  check("apply with the matching confirm deletes exactly the expired-unsealed and the no-issuance objects", r.record.mode === "apply" && w.removed.sort().join() === [p(ID.expired), p(ID.none)].sort().join()); }
{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 5, nowMs: NOW, serverNowMs: NOW });
  check("a confirm that does not match deletes nothing and alerts", w.removed.length === 0 && r.record.mode === "apply_refused" && r.exitCode === 2); }
{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, nowMs: NOW, serverNowMs: NOW });
  check("apply without a confirm deletes nothing", w.removed.length === 0 && r.exitCode === 2); }
{ // A seal lands between the inventory and the deletion: the rule re-reads the issuance and keeps the object.
  const w = world(); let reads = 0;
  w.deps.issuance = async (id) => { if (id === ID.expired && ++reads >= 2) return { ...w.issuances[id], consumed_at: new Date(NOW).toISOString() }; return w.issuances[id] ?? null; };
  const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW, serverNowMs: NOW });
  check("an issuance sealed concurrently is kept (re-read before deletion)", !w.removed.includes(p(ID.expired)) && r.record.outcome.kept.some((k) => k.path === p(ID.expired) && k.reason === "sealed")); }
{ const w = world(); w.objects.push({ storage_path: p(ID.old), created_at: new Date(NOW - 20 * 24 * H).toISOString() });
  const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", nowMs: NOW });
  check("a deletable object overdue for more than 14 days raises an alert", r.exitCode === 2 && r.record.alerts.some((a) => /14 days/.test(a))); }
{ const w = world(); w.deps.remove = async () => ({ error: { message: "storage unavailable" } });
  const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW, serverNowMs: NOW });
  check("a failed deletion is recorded and alerts (the next run retries it)", r.record.counts.failed === 2 && r.exitCode === 2); }
{ const w = world(); w.objects.push({ storage_path: p(ID.sealed), created_at: new Date(NOW - 8 * H).toISOString() });
  const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW, serverNowMs: NOW });
  check("a sealed object is never deleted, and its appearance in the listing alerts", !w.removed.includes(p(ID.sealed)) && r.record.alerts.some((a) => /sealed issuance/.test(a))); }
{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW + MAX_CLOCK_SKEW_MS + 60_000, serverNowMs: NOW });
  check("an operator clock ahead of the server's by more than the allowed skew deletes nothing", w.removed.length === 0 && r.record.mode === "apply_refused" && r.exitCode === 2); }
{ const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", apply: true, confirm: 2, nowMs: NOW });
  check("an apply without the server's clock deletes nothing", w.removed.length === 0 && r.exitCode === 2); }
{ // The operator clock 2 h ahead would call a just-expired issuance deletable; the server's earlier clock does not.
  const w = world(); const r = await runOrphanSweep({ deps: w.deps, operator: "Owner", nowMs: NOW + 4 * 60_000, serverNowMs: NOW - 2 * H });
  check("the earlier (server) clock decides: nothing becomes deletable early", r.record.counts.deletable < 2); }
{ let threw = false; try { await runOrphanSweep({ deps: world().deps, operator: " " }); } catch { threw = true; }
  check("an operator name is required", threw); }

console.log(`\n${pass}/${pass + fail} orphan-sweep runner checks passed.`);
process.exit(fail ? 1 : 0);
