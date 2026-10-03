// tbMixedVersions.mjs — old/new client × old/new server compatibility for the trial-balance release (#44/#45).
//
// Servers: process-trial-balance at SERVER_OLD (the deployed baseline: main) and SERVER_NEW (#44), each run under Deno
// through the in-memory doubles (functionpath/compatProbe.ts) over: dimensioned accounts (review and confirmation),
// three-decimal currency (balanced and off by 0.001), and retries (same and new request id).
// Clients: CLIENT refs (main, #44, #45) — each version's OWN trialBalanceVerdict (and #45's uploadFlow) evaluates every
// server output. Nothing is mocked on the client side; nothing touches a network database.
//
//   DENO_BIN=<deno> bun scripts/compat/tbMixedVersions.mjs [serverOld serverNew clientMain client44 client45]
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const [SERVER_OLD = "origin/main", SERVER_NEW = "origin/feat/tb-ingestion-integrity", CLIENT_MAIN = "origin/main", CLIENT_44 = "origin/feat/tb-ingestion-integrity", CLIENT_45 = "origin/feat/tb-upload-review-workflow"] = process.argv.slice(2);
const DENO = process.env.DENO_BIN ?? "deno";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tb-compat-"));
const sh = (cmd, cwd = REPO) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const sha = (ref) => sh(`git rev-parse ${ref}`).trim();

function extract(ref, paths, name) {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(work, `${name}.tar`);
  sh(`git archive --format=tar -o "${tar}" ${ref} ${paths.join(" ")}`);
  sh(`tar -xf "${tar}" -C "${dir}"`);
  return dir;
}

function serverOutputs(ref, name) {
  const dir = extract(ref, ["supabase/functions"], name);
  const fp = path.join(dir, "supabase/functions/process-trial-balance/functionpath");
  fs.mkdirSync(fp, { recursive: true });
  for (const f of ["supabaseDouble.ts", "serverDouble.ts", "import_map.json", "compatProbe.ts"]) {
    fs.copyFileSync(path.join(REPO, "supabase/functions/process-trial-balance/functionpath", f), path.join(fp, f));
  }
  const index = pathToFileURL(path.join(dir, "supabase/functions/process-trial-balance/index.ts")).href;
  const out = execSync(`"${DENO}" run --no-check --allow-env --allow-read --allow-net=esm.sh,deno.land --import-map="${path.join(fp, "import_map.json")}" "${path.join(fp, "compatProbe.ts")}"`,
    { encoding: "utf8", env: { ...process.env, PTB_INDEX: index }, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const line = out.split("\n").find((l) => l.startsWith("COMPAT_JSON "));
  if (!line) throw new Error(`no output from ${name}`);
  return JSON.parse(line.slice("COMPAT_JSON ".length));
}

async function client(ref, name) {
  const dir = extract(ref, ["src/lib/workspace", "src/lib/ingestion"], name);
  const verdict = await import(pathToFileURL(path.join(dir, "src/lib/workspace/trialBalanceVerdict.ts")).href);
  const flowFile = path.join(dir, "src/lib/ingestion/uploadFlow.ts");
  const flow = fs.existsSync(flowFile) ? await import(pathToFileURL(flowFile).href) : null;
  return { name, ref: sha(ref), verdict, flow };
}

const RESULTS = [];
const record = (combo, check, ok, detail) => RESULTS.push({ combo, check, ok, detail });

/** What a client's card shows for a server's stored result. */
function shown(c, s) {
  const pr = s.processing_result;
  const totals = c.verdict.readTrialBalanceTotals(pr);
  if (!totals) return { totals: null };
  const fmt = (m) => (c.verdict.formatTotal ? c.verdict.formatTotal(totals, m) : c.verdict.formatCents(m));
  return { totals: { debit: fmt(totals.debitCents), credit: fmt(totals.creditCents), difference: fmt(Math.abs(totals.differenceCents)) }, outOfBalance: c.verdict.isOutOfBalance(totals) };
}

function evaluate(c, serverName, out) {
  const combo = `${c.name} client × ${serverName} server`;
  // Currency precision: what is shown must be the exact amount, or nothing (refused) — never a rounded figure.
  for (const [key, debit, credit] of [["bhd_balanced", "1.234", "1.234"], ["bhd_off_by_0_001", "1.234", "1.233"]]) {
    const s = out[key];
    const view = shown(c, s);
    const exactOrRefused = view.totals === null || (view.totals.debit === debit && view.totals.credit === credit);
    const serverBlocked = s.status === "blocked";
    const contradiction = !!view.totals && serverBlocked && !view.outOfBalance && key === "bhd_off_by_0_001";
    record(combo, `currency ${key}: shown exactly or not at all`, exactOrRefused && !contradiction,
      `server ${s.status}; card ${view.totals ? `${view.totals.debit} / ${view.totals.credit} / diff ${view.totals.difference}${view.outOfBalance ? " (out of balance)" : " (balanced)"}` : "totals refused"}`);
  }
  // Dimensioned accounts: one review row per code (the panel keys and decides per code); confirmation completes.
  const review = out.dimension_review.processing_result.needs_review_accounts ?? [];
  const codes = review.map((r) => r.account_code);
  record(combo, "dimension: one review entry per account code", new Set(codes).size === codes.length, `review codes: ${codes.join(",") || "(none)"}; status ${out.dimension_review.status}`);
  const conf = out.dimension_confirmed;
  record(combo, "dimension: confirmation leads to an accepted trial balance with both department rows", conf.status === "complete" && conf.certifications.at(-1)?.codes.filter((x) => x === "6000").length === 2,
    `status ${conf.status}; certified 6000 rows: ${conf.certifications.at(-1)?.codes.filter((x) => x === "6000").length ?? 0}`);
  // Retries: what this client sends after a lost response, and where the upload ends up.
  if (c.flow) {
    const s = out.retry_same_id;
    const outcome = c.flow.classifyCheckAnswer({ httpStatus: s.response.http, body: s.response.body });
    record(combo, "retry: 'Check again' reuses the request id; the upload keeps its recorded status", outcome.kind === "finished" && s.status === "complete" && s.engine_runs === 1,
      `client → ${outcome.kind}; upload status after replay: ${s.status}; engine runs ${s.engine_runs}`);
  } else {
    const s = out.retry_new_id;
    record(combo, "retry: a new request id re-runs the check once more and records its outcome", s.status === "complete", `upload status: ${s.status}; engine runs ${s.engine_runs}`);
  }
}

const servers = { old: serverOutputs(SERVER_OLD, "server-old"), new: serverOutputs(SERVER_NEW, "server-new") };
const clients = [await client(CLIENT_MAIN, "main"), await client(CLIENT_44, "#44"), await client(CLIENT_45, "#45")];
for (const c of clients) for (const [n, out] of Object.entries(servers)) evaluate(c, n, out);

console.log(`servers: old=${sha(SERVER_OLD)} new=${sha(SERVER_NEW)}; clients: ${clients.map((c) => `${c.name}=${c.ref.slice(0, 7)}`).join(" ")}`);
let combo = "";
for (const r of RESULTS) {
  if (r.combo !== combo) { combo = r.combo; console.log(`\n== ${combo}`); }
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.check}\n        ${r.detail}`);
}
const failed = RESULTS.filter((r) => !r.ok).length;
console.log(`\n${RESULTS.length - failed}/${RESULTS.length} passed`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
