#!/usr/bin/env bun
// Ask CFOClose Release 0.1 — the measured-cost and quality experiment. Runs the REAL gateway code (handleAssistant: envelope,
// validation, one correction, rendering, cost) over the 30 synthetic cases × 2 actions, with an in-memory reservation double.
//
//   DRY RUN (default; no network, no spend):
//     bun scripts/assistant-eval/run.mjs
//     → request sizes and the estimated cost per model, and whether the configured cap covers the planned run.
//
//   LIVE (spends API credits — only with the owner's authorization):
//     ASSISTANT_EVAL_CONFIRM=spend ANTHROPIC_API_KEY=… ASSISTANT_EVAL_MODEL=claude-sonnet-5-5 ASSISTANT_EVAL_CAP_USD=10 \
//       [ASSISTANT_EVAL_REPEATS=3] [ASSISTANT_EVAL_SET=dev|heldout|all] bun scripts/assistant-eval/run.mjs
//     → stops BEFORE any request whose reserved ceiling would take the run past the cap; writes results JSON and a CSV for
//       the accountant's review (answers, automatic checks, blank reviewer columns). Synthetic data only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";
import { handleAssistant } from "../../supabase/functions/_shared/assistantHandler.ts";
import { anthropicProvider, buildUserMessage, ceilingMicros, SYSTEM_PROMPT } from "../../supabase/functions/_shared/assistantProvider.ts";
import { buildEnvelope, envelopeDigest } from "../../supabase/functions/_shared/assistantFacts.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPANY = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const ACTIONS = ["explain_movement", "draft_commentary"];
// Dated price configuration (USD micro-units per million tokens), 2026-10-24, from Anthropic's published API prices.
// Re-check before a live run; the database's ai_assistant_settings is the authority in production.
const PRICES = {
  "claude-sonnet-5-5": { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, cacheWriteMicrosPerMTok: 2_500_000, cacheReadMicrosPerMTok: 100_000 },
  "claude-haiku-5-5": { inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000, cacheWriteMicrosPerMTok: 125_000, cacheReadMicrosPerMTok: 10_000 },
  "claude-opus-5-5": { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000, cacheWriteMicrosPerMTok: 5_000_000, cacheReadMicrosPerMTok: 200_000 },
};
// The proposed production bounds (ai_assistant_settings): the largest case is far below them.
const BOUNDS = { maxInputTokens: 6_000, maxOutputTokens: 1_200, maxRequestSeconds: 60 };
const usd = (micros) => `$${(micros / 1e6).toFixed(4)}`;

const set = process.env.ASSISTANT_EVAL_SET ?? "all";
const cases = CASES.filter((c) => set === "all" || (set === "heldout" ? c.heldOut : !c.heldOut));
const repeats = Math.max(1, Number(process.env.ASSISTANT_EVAL_REPEATS ?? 1));
const live = process.env.ASSISTANT_EVAL_CONFIRM === "spend";

// ── Sizes (both modes) ───────────────────────────────────────────────────────────────────────────────────────────────
const sizes = [];
for (const c of cases) for (const action of ACTIONS) {
  const b = buildEnvelope(c.composition, { action, companyId: COMPANY, periodYear: 2026, lineId: c.lineId });
  if (!b.ok) throw new Error(`case ${c.id}: ${b.code}`);
  const user = buildUserMessage(b.envelope, await envelopeDigest(b.envelope), null);
  sizes.push({ id: c.id, action, systemChars: SYSTEM_PROMPT.length, userChars: user.length });
}
const avgUser = sizes.reduce((s, x) => s + x.userChars, 0) / sizes.length;
const maxUser = Math.max(...sizes.map((x) => x.userChars));
// Typical English/JSON ≈ 3.5–4 characters per token; the gateway refuses above BOUNDS using a conservative 3.
const tok = (chars) => Math.ceil(chars / 3.5);
const est = { systemTokens: tok(SYSTEM_PROMPT.length), avgUserTokens: tok(avgUser), maxUserTokens: tok(maxUser), outputTokens: 450 };
const requests = sizes.length * repeats;
console.log(`cases ${cases.length} × actions ${ACTIONS.length} × repeats ${repeats} = ${requests} requests`);
console.log(`system prompt ≈ ${est.systemTokens} tokens (below the minimum cacheable length: no cache saving assumed); request ≈ ${est.avgUserTokens} tokens avg, ${est.maxUserTokens} max; answer ≈ ${est.outputTokens} tokens (assumed)`);
for (const [model, p] of Object.entries(PRICES)) {
  // The system prompt is below the provider's minimum cacheable length, so no cache saving is assumed: every input token at
  // the ordinary rate. 15% of requests are assumed to need the one correction (a second, longer call).
  const perCall = ((est.systemTokens + est.avgUserTokens) * p.inputMicrosPerMTok + est.outputTokens * p.outputMicrosPerMTok) / 1e6;
  const expected = requests * perCall * 1.15;
  const ceiling = ceilingMicros(2, BOUNDS.maxInputTokens, BOUNDS.maxOutputTokens, p);
  console.log(`${model.padEnd(18)} expected ≈ ${usd(perCall)} per call, ≈ ${usd(expected)} for the run; reserved ceiling ${usd(ceiling)} per request (two calls at the bounds)`);
}

if (!live) {
  console.log("\nDRY RUN — nothing was sent. Set ASSISTANT_EVAL_CONFIRM=spend (with the owner's authorization) for a live run.");
  process.exit(0);
}

// ── Live run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.ASSISTANT_EVAL_MODEL;
const capMicros = Math.round(Number(process.env.ASSISTANT_EVAL_CAP_USD) * 1e6);
if (!key || !model || !PRICES[model] || !(capMicros > 0)) {
  console.error("Live run needs ANTHROPIC_API_KEY, ASSISTANT_EVAL_MODEL (one of the priced models) and ASSISTANT_EVAL_CAP_USD.");
  process.exit(2);
}
const prices = PRICES[model];
const reserveMicros = ceilingMicros(2, BOUNDS.maxInputTokens, BOUNDS.maxOutputTokens, prices);
const provider = anthropicProvider(key);
let spent = 0;
const results = [];
for (let r = 1; r <= repeats; r++) for (const c of cases) for (const action of ACTIONS) {
  if (spent + reserveMicros > capMicros) { console.log(`STOPPED at the cap: spent ${usd(spent)} of ${usd(capMicros)}`); r = repeats + 1; break; }
  let completed = null;
  const t0 = Date.now();
  const out = await handleAssistant(USER, { action, companyId: COMPANY, periodYear: 2026, lineId: c.lineId, requestId: crypto.randomUUID() }, {
    provider,
    readComposition: async () => c.composition,
    rpc: async (name, args) => {
      if (name === "ai_assistant_reserve") return { data: { outcome: "reserved", runId: crypto.randomUUID(), model, prices, ...BOUNDS }, error: null };
      if (name === "ai_assistant_complete") { completed = args; return { data: { outcome: "completed" }, error: null }; }
      return { data: null, error: { code: "42883" } };
    },
    now: () => Date.now(),
  });
  const cost = completed?.p_actual_cost_micros ?? reserveMicros;
  spent += cost;
  const answer = out.body.answer;
  results.push({ repeat: r, case: c.id, title: c.title, heldOut: c.heldOut, action, status: out.body.status, code: out.body.code ?? null,
    attempts: completed?.p_attempts ?? null, usage: completed?.p_usage ?? null, costMicros: cost, ms: Date.now() - t0,
    validation: completed?.p_validation ?? null,
    text: answer ? answer.blocks.map((b) => `[${b.kind}] ${b.parts.map((p) => p.text).join("")}`).join("\n") : null, checks: c.checks });
  console.log(`r${r} case ${String(c.id).padStart(2)} ${action.padEnd(17)} ${String(out.body.status).padEnd(9)} attempts ${completed?.p_attempts ?? "-"} ${usd(cost)} ${Date.now() - t0}ms`);
}
const ok = results.filter((x) => x.status === "answered");
const firstTry = ok.filter((x) => x.attempts === 1);
const lat = results.map((x) => x.ms).sort((a, b) => a - b);
const summary = { model, requests: results.length, answered: ok.length, firstAttemptValid: firstTry.length, spentMicros: spent,
  costPerSuccessfulActionMicros: ok.length ? Math.round(spent / ok.length) : null, p50ms: lat[Math.floor(lat.length / 2)] ?? null, p95ms: lat[Math.floor(lat.length * 0.95)] ?? null };
console.log(JSON.stringify(summary, null, 1));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(HERE, "results");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${model}-${stamp}.json`), JSON.stringify({ summary, results }, null, 1));
const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(outDir, `${model}-${stamp}-review.csv`), ["repeat,case,held_out,action,status,answer,checks,reviewer_accurate(Y/N),reviewer_unsupported_claim(Y/N),reviewer_acceptable(Y/minor edit/N),reviewer_minutes_saved,reviewer_notes",
  ...results.map((x) => [x.repeat, x.case, x.heldOut, x.action, x.status, q(x.text), q(x.checks.join(" | ")), "", "", "", "", ""].join(","))].join("\n"));
console.log(`results written to ${outDir}`);
