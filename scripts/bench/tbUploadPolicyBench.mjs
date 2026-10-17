#!/usr/bin/env bun
// Measured evidence for the trial balance upload policy (supabase/functions/_shared/uploadPolicy.ts).
//
// Runs the REAL shared reader (tbSource.readTrialBalanceSource: policy checks → parse → ingestion) on invented trial
// balances of increasing size, each case in a FRESH process so its peak memory is its own:
//   file bytes · declared expanded bytes (.xlsx) · rows · cells · read+ingest milliseconds · peak RSS (MB)
// and a concurrency run (N cases at once, separate processes). Invented data only (no client file is ever used).
//
// Limitations, stated with every report: this runs on Bun (JavaScriptCore) on the machine that runs it, not in the
// hosted Edge Runtime (Deno, V8, its own memory and CPU limits); absolute numbers differ there. The shape — how time
// and memory grow with rows, and the ratio between file bytes and work — is what the policy is chosen from.
//
//   bun scripts/bench/tbUploadPolicyBench.mjs [out.json]          (all cases)
//   bun scripts/bench/tbUploadPolicyBench.mjs --case csv 50000    (one case; prints one JSON line)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function invented(rows) {
  // Balanced: every account but the last has a debit; the last credit balances them all. Codes and names are invented.
  const lines = [["Account code", "Account name", "Debit", "Credit"]];
  let total = 0;
  for (let i = 1; i < rows; i++) { const d = ((i * 7919) % 100000) / 100; total += Math.round(d * 100); lines.push([String(100000 + i), `Invented account ${i}`, d.toFixed(2), "0.00"]); }
  lines.push(["999999", "Invented balancing equity", "0.00", (total / 100).toFixed(2)]);
  return lines;
}

const TMP = path.join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "cfoclose-tb-bench");
const fileFor = (kind, rows) => path.join(TMP, `${kind}-${rows}.${kind === "csv" ? "csv" : "xlsx"}`);

/** Writes the invented file once, in its OWN process, so the measured process holds only the bytes it reads. */
async function generate(kind, rows) {
  const XLSX = await import("xlsx");
  fs.mkdirSync(TMP, { recursive: true });
  const data = invented(rows);
  if (kind === "csv") { fs.writeFileSync(fileFor(kind, rows), data.map((r) => r.join(",")).join("\n") + "\n"); return; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data.map((r, i) => (i === 0 ? r : [r[0], r[1], Number(r[2]), Number(r[3])]))), "TB");
  fs.writeFileSync(fileFor(kind, rows), new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: kind === "xlsx-deflate" })));
}

async function oneCase(kind, rows) {
  const XLSX = await import("xlsx");
  const { readTrialBalanceSource } = await import(path.join(HERE, "../../supabase/functions/_shared/tbSource.ts"));
  const { zipDeclaredSizes, TB_UPLOAD_POLICY } = await import(path.join(HERE, "../../supabase/functions/_shared/uploadPolicy.ts"));
  const fileName = kind === "csv" ? "tb.csv" : "tb.xlsx";
  const bytes = new Uint8Array(fs.readFileSync(fileFor(kind, rows)));
  Bun.gc?.(true);
  const base = process.memoryUsage().rss;
  const t0 = performance.now();
  const r = readTrialBalanceSource(bytes, { fileName, periodYear: 2026, currency: "TZS" }, XLSX);
  const ms = performance.now() - t0;
  // The parse is synchronous, so a timer cannot sample during it: the process's lifetime maximum RSS is the peak (the
  // file was generated in another process, so nothing else in this process ever held a workbook).
  const peak = Math.max(process.memoryUsage().rss, (process.resourceUsage?.().maxRSS ?? 0) * 1024);
  const z = fileName.endsWith(".xlsx") ? zipDeclaredSizes(bytes) : null;
  const policy = r.issues.find((i) => ["FILE_TOO_LARGE", "WORKBOOK_TOO_LARGE_EXPANDED", "TOO_MANY_ROWS", "TOO_MANY_CELLS"].includes(i.code))?.code ?? null;
  return {
    kind, rows, fileBytes: bytes.byteLength, expandedBytes: z && z.ok ? z.uncompressed : null, cells: rows * 4,
    ms: Math.round(ms), baseRssMb: Math.round(base / 1048576), peakRssMb: Math.round(peak / 1048576), deltaMb: Math.round((peak - base) / 1048576),
    refusedBy: policy, blocking: r.blocking, policy: TB_UPLOAD_POLICY.version,
  };
}

if (process.argv[2] === "--generate") { await generate(process.argv[3], Number(process.argv[4])); process.exit(0); }
if (process.argv[2] === "--case") {
  console.log(JSON.stringify(await oneCase(process.argv[3], Number(process.argv[4]))));
  process.exit(0);
}

const run = (kind, rows) => {
  spawnSync(process.execPath, [SELF, "--generate", kind, String(rows)], { timeout: 600000 });
  const p = spawnSync(process.execPath, [SELF, "--case", kind, String(rows)], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 600000 });
  const line = (p.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(line); } catch { return { kind, rows, error: (p.stderr || p.error?.message || "failed").slice(0, 300) }; }
};
const runAsync = (kind, rows) => new Promise((resolve) => {
  const c = spawn(process.execPath, [SELF, "--case", kind, String(rows)]);
  let out = ""; c.stdout.on("data", (d) => { out += d; });
  c.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch { resolve({ kind, rows, error: "failed" }); } });
});

const results = { machine: { runtime: `bun ${Bun.version}`, platform: process.platform, arch: process.arch }, single: [], concurrent: null };
for (const kind of ["csv", "xlsx", "xlsx-deflate"]) {
  for (const rows of [1000, 10000, 50000, 100000, 200000, 250000]) {
    const r = run(kind, rows);
    results.single.push(r);
    console.log(JSON.stringify(r));
  }
}
const N = 4;
spawnSync(process.execPath, [SELF, "--generate", "xlsx", "100000"], { timeout: 600000 });
const t0 = performance.now();
const conc = await Promise.all(Array.from({ length: N }, () => runAsync("xlsx", 100000)));
results.concurrent = { processes: N, kind: "xlsx", rows: 100000, wallMs: Math.round(performance.now() - t0), each: conc };
console.log(JSON.stringify(results.concurrent));
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
