#!/usr/bin/env node
/**
 * Ready for Reporting V3 — acceptance runner (rfr-acceptance/1).
 *
 *   node scripts/acceptance/rfr-v3/run.mjs --self-check
 *       RUNNER SELF-CHECK. Checks the fixtures against the reference model and their own arithmetic.
 *       Proves the fixtures are consistent with the specification. Proves nothing about CFOClose.
 *
 *   node scripts/acceptance/rfr-v3/run.mjs --implementation <adapter.mjs>
 *       IMPLEMENTATION TEST. Runs every case and mutation through an adapter that drives a real implementation
 *       (exports `meta` and `evaluate(inputs)`; optionally `runContract(id)` for C1-C7). The reference model is refused.
 *       Contracts without a runContract result are NOT_RUN, never passed.
 *
 *   node scripts/acceptance/rfr-v3/run.mjs --sandbox <manifest.json>
 *       SANDBOX CHECK (sandboxProof.mjs). LIVE_SANDBOX_PROOF only when the connector output equals an independent
 *       QuickBooks export AND the postings seeded into the sandbox company AND a recorded run produced that output.
 *       Without a recorded run: NOT_RUN (exit 3), reported as EXPORT_PARITY. Invalid or non-independent input: REFUSED (2).
 *
 * A green result in one category is never reported as another: every line and the JSON report carry the category,
 * and the exit code differs per outcome (0 pass, 1 fail, 2 refused/invalid, 3 not run).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { CASES, IMPLEMENTATION_CONTRACTS } from "./cases.mjs";
import * as reference from "./referenceModel.mjs";
import { checkSandbox } from "./sandboxProof.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const B = (s) => BigInt(s);

export function compare(result, exp, inputs) {
  const errs = [];
  const has = (f) => result.findings.some((r) => r.rule === f.rule && r.outcome === f.outcome && r.scope === f.scope && (f.resolved_by === undefined || r.resolved_by === f.resolved_by));
  for (const k of ["draft_eligible", "evidence_upload_allowed"]) if (exp[k] !== undefined && result[k] !== exp[k]) errs.push(`${k}: expected ${exp[k]}, got ${result[k]}`);
  for (const f of exp.findings ?? []) if (!has(f)) errs.push(`missing finding ${f.rule}/${f.outcome}@${f.scope}${f.resolved_by ? " resolved_by " + f.resolved_by : ""}`);
  if (exp.required_scopes && JSON.stringify([...exp.required_scopes].sort()) !== JSON.stringify(result.required_scopes ?? [])) errs.push(`required scopes: expected ${exp.required_scopes}, got ${result.required_scopes}`);
  for (const [s, rs] of Object.entries(exp.scope_reasons ?? {})) if (JSON.stringify(rs) !== JSON.stringify(result.scope_reasons?.[s])) errs.push(`scope_reasons ${s}: expected ${JSON.stringify(rs)}, got ${JSON.stringify(result.scope_reasons?.[s])}`);
  for (const [s, st] of Object.entries(exp.scopes ?? {})) if (result.scopes[s] !== st) errs.push(`scope ${s}: expected ${st}, got ${result.scopes[s] ?? "absent"}`);
  if (exp.proposals) {
    const norm = (ps) => JSON.stringify(ps.map((p) => ({ id: p.id, lines: [...p.lines].sort((a, b) => (a.account < b.account ? -1 : 1)) })).sort((a, b) => (a.id < b.id ? -1 : 1)));
    if (norm(result.proposals) !== norm(exp.proposals)) errs.push(`proposals differ: got ${norm(result.proposals)}`);
  }
  for (const a of exp.refusals ?? []) if (!result.refusals.some((r) => r.action === a)) errs.push(`missing refusal ${a}`);
  for (const [k, v] of Object.entries(exp.balances ?? {})) if (result.balances[k] !== v) errs.push(`balance ${k}: expected ${v}, got ${result.balances[k]}`);
  if (exp.finalization) {
    if (result.finalization.held !== exp.finalization.held) errs.push(`finalization held: expected ${exp.finalization.held}, got ${result.finalization.held} (${result.finalization.reasons.join(", ")})`);
    if (exp.finalization.reasons && JSON.stringify([...exp.finalization.reasons].sort()) !== JSON.stringify(result.finalization.reasons)) errs.push(`finalization reasons: expected ${exp.finalization.reasons}, got ${result.finalization.reasons}`);
  }
  if (exp.corrections_count !== undefined && result.corrections.length !== exp.corrections_count) errs.push(`corrections: expected ${exp.corrections_count}, got ${result.corrections.length}`);
  for (const c of exp.corrections ?? []) {
    const r = result.corrections.find((x) => x.id === c.id);
    if (!r) { errs.push(`correction ${c.id} absent`); continue; }
    for (const [k, v] of Object.entries(c)) if (JSON.stringify(r[k]) !== JSON.stringify(v)) errs.push(`correction ${c.id}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(r[k])}`);
  }
  if (exp.applied_adjustments && JSON.stringify(result.applied_adjustments) !== JSON.stringify([...exp.applied_adjustments].sort())) errs.push(`applied adjustments: expected ${exp.applied_adjustments}, got ${result.applied_adjustments}`);
  const appliedLines = [...result.proposals.filter((p) => result.applied_adjustments.includes(p.id)).flatMap((p) => p.lines), ...(inputs.reporting_adjustments ?? []).filter((r) => result.applied_adjustments.includes(r.id)).flatMap((r) => r.lines)];
  for (const a of exp.assertions ?? []) {
    const [name, x, y] = a.split(":");
    if (name === "no_adjustment_touches_cash" && appliedLines.some((l) => l.account === x)) errs.push(`assertion ${a} failed`);
    if (name === "cheque_once") {
      const n = (inputs.ledger?.entries ?? []).filter((e) => e.account === y && e.ref === x).length;
      if (n !== 1 || appliedLines.some((l) => l.account === y)) errs.push(`assertion ${a} failed (${n} postings)`);
    }
  }
  return errs;
}

export function compareMutation(result, m) {
  const errs = [];
  const e = m.expected;
  const inc = [...(e.add_findings ?? []), ...(e.replace_finding ? [e.replace_finding] : [])];
  for (const f of inc) if (!result.findings.some((r) => r.rule === f.rule && r.outcome === f.outcome && r.scope === f.scope)) errs.push(`missing finding ${f.rule}/${f.outcome}@${f.scope}`);
  if (e.replace_finding) { const f = e.replace_finding; if (result.findings.some((r) => r.rule === f.rule && r.scope === f.scope && r.outcome !== f.outcome)) errs.push(`finding ${f.rule}@${f.scope} still has another outcome`); }
  for (const [s, st] of Object.entries(e.scopes ?? {})) if (result.scopes[s] !== st) errs.push(`scope ${s}: expected ${st}, got ${result.scopes[s]}`);
  if (e.finalization_held !== undefined && result.finalization.held !== e.finalization_held) errs.push(`finalization held: expected ${e.finalization_held}, got ${result.finalization.held}`);
  if (e.finalization_reasons && JSON.stringify([...e.finalization_reasons].sort()) !== JSON.stringify(result.finalization.reasons)) errs.push(`finalization reasons: expected ${e.finalization_reasons}, got ${result.finalization.reasons}`);
  for (const r of e.finalization_reasons_include ?? []) if (!result.finalization.reasons.includes(r)) errs.push(`missing reason ${r}`);
  for (const id of e.proposals_exclude ?? []) if (result.proposals.some((p) => p.id === id)) errs.push(`unexpected proposal ${id}`);
  for (const a of e.refusals_include ?? []) if (!result.refusals.some((r) => r.action === a)) errs.push(`missing refusal ${a}`);
  return errs;
}

const patched = (inputs, patch) => ({ ...structuredClone(inputs), ...structuredClone(patch) });

function fixtureArithmetic(c) {
  const errs = [];
  const zero = (lines, what) => { if (lines.reduce((a, l) => a + B(l.amount), 0n) !== 0n) errs.push(`${what} does not balance`); };
  const tbSum = Object.values(c.inputs.tb?.accounts ?? {}).reduce((a, x) => a + B(x.closing), 0n);
  if (c.inputs.tb && tbSum !== 0n) errs.push("TB does not balance");
  for (const p of c.expected?.proposals ?? []) zero(p.lines, `proposal ${p.id}`);
  for (const p of c.inputs.opening_bridge?.proposals ?? []) zero(p.lines, `bridge proposal ${p.id}`);
  for (const r of c.inputs.reporting_adjustments ?? []) zero(r.lines, `adjustment ${r.id}`);
  for (const cv of c.inputs.correction_verification ?? []) { zero(cv.effect, `effect ${cv.id}`); for (const p of cv.snapshot.postings) zero(p.lines, `posting ${p.id}`); }
  if (["ewma", "ewma_constructed"].includes(c.origin) && !(c.sources ?? []).length) errs.push("EWMA fixture without sources");
  if (c.origin === "ewma_constructed" && !(c.constructed ?? []).length) errs.push("constructed fixture does not name what is constructed");
  if (!["ewma", "ewma_constructed", "synthetic"].includes(c.origin)) errs.push(`unknown origin ${c.origin}`);
  if (!c.expected?.finalization) errs.push("no expected finalization");
  return errs;
}

async function runCases(evaluate, label) {
  const rows = [];
  for (const c of CASES) {
    let errs = label === "RUNNER_SELF_CHECK" ? fixtureArithmetic(c) : [];
    let result;
    try { result = await evaluate(structuredClone(c.inputs)); errs = errs.concat(compare(result, c.expected, c.inputs)); }
    catch (e) { errs.push(`threw: ${e.message}`); }
    rows.push({ id: c.id, status: c.status, origin: c.origin, failure_mode: c.failure_mode ?? null, errors: errs });
    for (const m of c.mutations ?? []) {
      let me = [];
      try { const r = await evaluate(patched(c.inputs, m.patch)); me = compareMutation(r, m); } catch (e) { me.push(`threw: ${e.message}`); }
      rows.push({ id: m.id, status: c.status, origin: c.origin, mutation_of: c.id, errors: me });
    }
  }
  return rows;
}

function report(category, rows, extra = {}) {
  const failed = rows.filter((r) => r.errors.length);
  const out = { contract: "rfr-acceptance/1", category, generated_at: new Date().toISOString(), cases: rows.length, failed: failed.length, rows, ...extra };
  const file = join(process.env.RFR_REPORT_DIR ?? HERE, `report.${category.toLowerCase()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  for (const r of rows) console.log(`[${category}] ${r.errors.length ? "FAIL" : "ok  "} ${r.id}${r.status === "draft" ? " (draft fixture)" : ""}${r.errors.length ? "\n      " + r.errors.join("\n      ") : ""}`);
  console.log(`\n[${category}] ${rows.length - failed.length}/${rows.length} passed. Report: ${file}`);
  return failed.length ? 1 : 0;
}

async function selfCheck() {
  const rows = await runCases(reference.evaluate, "RUNNER_SELF_CHECK");
  const ids = CASES.map((c) => c.id);
  const meta = [];
  if (new Set(ids).size !== ids.length) meta.push("duplicate case ids");
  for (const n of [1, 2, 3, 4, 5]) if (!CASES.some((c) => c.failure_mode === n)) meta.push(`failure mode ${n} has no case`);
  for (const id of ["E1", "E2", "E3", "E4", "S1", "S2", "S3", "S4"]) if (!ids.includes(id)) meta.push(`required fixture ${id} missing`);
  if (!CASES.some((c) => c.pilot)) meta.push("no pilot fixture");
  rows.push({ id: "META", status: "frozen", errors: meta });
  const drafts = CASES.filter((c) => c.status === "draft").map((c) => ({ id: c.id, freeze_checks: c.freeze_checks ?? [] }));
  console.log("RUNNER SELF-CHECK: fixtures vs reference model. This is not evidence about CFOClose or QuickBooks.\n");
  const code = report("RUNNER_SELF_CHECK", rows, { draft_fixtures: drafts, implementation_contracts_not_evaluated: IMPLEMENTATION_CONTRACTS.map((c) => c.id), reference_model_sha256: sha(join(HERE, "referenceModel.mjs")) });
  for (const d of drafts) if (d.freeze_checks.length) console.log(`[RUNNER_SELF_CHECK] draft ${d.id}: ${d.freeze_checks.join("; ")}`);
  return code;
}

async function implementation(path) {
  const abs = resolve(path);
  const src = readFileSync(abs, "utf8");
  if (sha(abs) === sha(join(HERE, "referenceModel.mjs")) || /referenceModel\.mjs/.test(src)) { console.error("[IMPLEMENTATION_TEST] REFUSED: the adapter is or imports the reference model."); return 2; }
  const ad = await import(pathToFileURL(abs).href);
  if (ad.meta?.kind !== "implementation" || !ad.meta?.target_commit || typeof ad.evaluate !== "function") { console.error("[IMPLEMENTATION_TEST] REFUSED: adapter must export meta {kind:'implementation', target_commit} and evaluate()."); return 2; }
  const rows = await runCases(ad.evaluate, "IMPLEMENTATION_TEST");
  for (const c of IMPLEMENTATION_CONTRACTS.filter((x) => x.category === "database")) {
    if (typeof ad.runContract !== "function") { rows.push({ id: c.id, status: "NOT_RUN", errors: ["NOT_RUN: adapter has no runContract"] }); continue; }
    const r = await ad.runContract(c.id).catch((e) => ({ pass: false, detail: e.message }));
    rows.push({ id: c.id, status: r?.pass === true ? "run" : "failed", errors: r?.pass === true ? [] : [`contract failed: ${r?.detail ?? "no result"}`] });
  }
  return report("IMPLEMENTATION_TEST", rows, { adapter: { path: abs, sha256: sha(abs), meta: ad.meta } });
}

async function sandbox(path) {
  const r = checkSandbox(resolve(path));
  console.log("SANDBOX CHECK: judges operator-supplied files and a recorded run. It cannot see QuickBooks; it refuses every shortcut it can detect.\n");
  if (r.status === "REFUSED") { console.error(`[${r.category}] REFUSED: ${r.reason}`); return 2; }
  const rows = r.rows.map((x) => ({ ...x, status: x.status === "NOT_RUN" ? "NOT_RUN" : x.status }));
  // The report is named for what was actually shown: a sandbox proof only with a recorded run, otherwise export parity.
  const code = report(r.category, rows.map((x) => ({ ...x, errors: x.status === "NOT_RUN" ? [] : x.errors })), { sandbox_status: r.status, reason: r.reason ?? null, files: r.files });
  if (r.status === "NOT_RUN") { console.log(`\n[${r.category}] NOT_RUN: ${r.reason}`); for (const x of r.rows) for (const e of x.errors) console.log(`[${r.category}] ${x.id}: ${e}`); return code === 1 ? 1 : 3; }
  return r.status === "PASS" ? 0 : 1;
}

const [mode, arg] = process.argv.slice(2);
const code = mode === "--self-check" ? await selfCheck() : mode === "--implementation" && arg ? await implementation(arg) : mode === "--sandbox" && arg ? await sandbox(arg) : (console.error("usage: run.mjs --self-check | --implementation <adapter.mjs> | --sandbox <manifest.json>"), 2);
process.exit(code);
