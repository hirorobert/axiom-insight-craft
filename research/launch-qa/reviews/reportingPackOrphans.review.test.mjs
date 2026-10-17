#!/usr/bin/env node
// Launch-QA review artifact (repair C, #143) — behavioural test for the orphan sweeper, the SOLE rule by which an unsealed
// reporting-pack object may be deleted. The repair's own change set ships `reportingPackSeal.test.ts` (the seal never
// removes the CANONICAL object) but NO behavioural test for `reportingPackOrphans.mjs`; this fills exactly that gap so the
// "never delete a sealed object / spare anything still sealable / re-decide on a fresh read" guarantees are EXECUTED, not
// only read. It imports the REAL module read-only (never edits it).
//
// RUN on a checkout that HAS the module (#143 branch or the combined candidate):
//   node research/launch-qa/reviews/reportingPackOrphans.review.test.mjs
// To execute elsewhere against the real module bytes, point ORPHANS_MODULE at a copy:
//   ORPHANS_MODULE=/abs/path/reportingPackOrphans.mjs node research/launch-qa/reviews/reportingPackOrphans.review.test.mjs
const modUrl = process.env.ORPHANS_MODULE
  ? (process.env.ORPHANS_MODULE.startsWith("file:") ? process.env.ORPHANS_MODULE : `file://${process.env.ORPHANS_MODULE}`)
  : new URL("../../../supabase/functions/_shared/reportingPackOrphans.mjs", import.meta.url).href;

let mod;
try { mod = await import(modUrl); }
catch (e) { console.error(`MODULE-UNAVAILABLE (run on a checkout that has the module, or set ORPHANS_MODULE): ${String(e.message).split("\n")[0]}`); process.exit(3); }
const { orphanDecision, sweepReportingPackOrphans, ORPHAN_GRACE_MS } = mod;

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d !== undefined ? `  — ${JSON.stringify(d)}` : ""}`); } };
const group = (n) => console.log(`\n== ${n}`);
const NOW = 1_000_000_000_000; // fixed clock (no Date.now in assertions)
const G = ORPHAN_GRACE_MS;
const iso = (ms) => new Date(ms).toISOString();

group("orphanDecision — a SEALED object is never deleted, whatever its age (criterion 5)");
check("sealed (consumed_at) → keep, even long past expiry", orphanDecision({ created_at: iso(0) }, { expires_at: iso(0), consumed_at: iso(1) }, NOW).delete === false);

group("orphanDecision — an issuance that may STILL be sealed is spared");
check("unsealed, before expiry+grace → keep (may still be sealed)", orphanDecision({}, { expires_at: iso(NOW), consumed_at: null }, NOW).delete === false);
check("unsealed, exactly at expiry+grace → keep (boundary is not yet past)", orphanDecision({}, { expires_at: iso(NOW - G), consumed_at: null }, NOW).delete === false);
check("unsealed, after expiry+grace → delete (can no longer be sealed)", orphanDecision({}, { expires_at: iso(NOW - G - 1), consumed_at: null }, NOW).delete === true);
check("unknown/invalid expiry → keep (fail-safe)", orphanDecision({}, { expires_at: "not-a-date", consumed_at: null }, NOW).delete === false);

group("orphanDecision — no issuance at all (stray object)");
check("no issuance, recent → keep", orphanDecision({ created_at: iso(NOW) }, null, NOW).delete === false);
check("no issuance, older than grace → delete", orphanDecision({ created_at: iso(NOW - G - 1) }, null, NOW).delete === true);
check("no issuance, unparseable created_at → keep (fail-safe)", orphanDecision({ created_at: "x" }, null, NOW).delete === false);

group("sweepReportingPackOrphans — re-decides on a FRESH read; a seal landing mid-sweep spares the object");
{
  // An expired-unsealed object whose FIRST read says delete, but which a concurrent seal consumes before the second read.
  const path = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.json";
  let reads = 0; const removed = [];
  const deps = {
    listOrphans: async () => [{ storage_path: path, created_at: iso(NOW - G - 10) }],
    issuance: async () => { reads++; return reads === 1 ? { expires_at: iso(NOW - G - 1), consumed_at: null } : { expires_at: iso(NOW - G - 1), consumed_at: iso(NOW) }; },
    remove: async (p) => { removed.push(p); return { error: null }; },
  };
  const report = await sweepReportingPackOrphans(deps, NOW, G);
  check("a seal that lands between the two reads spares the object (NOT deleted)", removed.length === 0 && report.deleted.length === 0, { removed, report });
  check("the object it spared is reported as kept (sealed), never silently dropped", report.kept.some((k) => /sealed/.test(k.reason)) || report.kept.length === 1, report.kept);
}
{
  // A genuinely stale orphan (both reads agree) IS deleted.
  const path = "33333333-3333-3333-3333-333333333333/44444444-4444-4444-4444-444444444444.json";
  const removed = [];
  const deps = { listOrphans: async () => [{ storage_path: path, created_at: iso(NOW - G - 10) }], issuance: async () => ({ expires_at: iso(NOW - G - 1), consumed_at: null }), remove: async (p) => { removed.push(p); return { error: null }; } };
  const report = await sweepReportingPackOrphans(deps, NOW, G);
  check("a genuinely expired-unsealed orphan (both reads agree) is deleted", removed.length === 1 && report.deleted.length === 1, { removed });
}
{
  // A failed deletion is recorded as failed (retried next run), never counted as deleted.
  const deps = { listOrphans: async () => [{ storage_path: "55555555-5555-5555-5555-555555555555/66666666-6666-6666-6666-666666666666.json", created_at: iso(NOW - G - 10) }], issuance: async () => null, remove: async () => ({ error: new Error("storage 500") }) };
  const report = await sweepReportingPackOrphans(deps, NOW, G);
  check("a failed deletion is reported failed, not deleted (idempotent retry next run)", report.failed.length === 1 && report.deleted.length === 0, report);
}

console.log(`\n${pass}/${pass + fail} orphan-sweeper review checks passed.  (Pure logic of repair C's sole deletion rule; executed.)`);
process.exit(fail ? 1 : 0);
