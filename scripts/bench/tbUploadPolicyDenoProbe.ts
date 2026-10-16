// Upload-policy probe in the Edge Runtime's engine (Deno, V8) with a HARD memory bound.
//
// The parent writes invented trial balances to a temporary directory; each case then runs in a CHILD Deno process whose
// V8 heap is capped (--max-old-space-size). The child runs exactly what the functions run on downloaded bytes: the
// upload-policy gate on the actual bytes (checkSourceBytesActual) and the shared reader with the same esm.sh xlsx the
// functions import. A child that exceeds the cap is terminated by V8: "terminated" is measured, not estimated.
// Invented data only. Run by CI (Edge function checks job); prints one JSON line per case and a summary table.
//
//   deno run --allow-read --allow-write --allow-run --allow-env --allow-net=esm.sh scripts/bench/tbUploadPolicyDenoProbe.ts [heapMb]
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { readTrialBalanceSource, type XlsxLike } from "../../supabase/functions/_shared/tbSource.ts";
import { checkSourceBytesActual, TB_UPLOAD_POLICY } from "../../supabase/functions/_shared/uploadPolicy.ts";

const SELF = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function invented(rows: number): (string | number)[][] {
  const out: (string | number)[][] = [["Account code", "Account name", "Debit", "Credit"]];
  let total = 0;
  for (let i = 1; i < rows; i++) { const d = ((i * 7919) % 100000) / 100; total += Math.round(d * 100); out.push([String(100000 + i), `Invented account ${i}`, d, 0]); }
  out.push(["999999", "Invented balancing equity", 0, total / 100]);
  return out;
}

async function child(file: string, fileName: string) {
  const bytes = await Deno.readFile(file);
  const t0 = performance.now();
  const gate = await checkSourceBytesActual(bytes, fileName);
  const r = gate ? null : readTrialBalanceSource(bytes, { fileName, periodYear: 2026, currency: "TZS" }, XLSX as unknown as XlsxLike);
  const ms = Math.round(performance.now() - t0);
  const m = Deno.memoryUsage();
  console.log(JSON.stringify({ ok: true, ms, rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576), refusedBy: gate?.code ?? r?.issues.find((i) => /TOO_MANY|TOO_LARGE/.test(i.code))?.code ?? null }));
}

if (Deno.args[0] === "--child") { await child(Deno.args[1], Deno.args[2]); Deno.exit(0); }

const heapMb = Number(Deno.args[0] ?? 150);
const dir = await Deno.makeTempDir({ prefix: "tb-policy-probe-" });
const cases: { kind: "csv" | "xlsx" | "xlsx-deflate"; rows: number }[] = [
  ...[10_000, 25_000, 50_000, 100_000, 150_000].map((rows) => ({ kind: "csv" as const, rows })),
  ...[5_000, 10_000, 25_000, 50_000, 75_000, 100_000].map((rows) => ({ kind: "xlsx" as const, rows })),
  ...[10_000, 50_000, 100_000].map((rows) => ({ kind: "xlsx-deflate" as const, rows })),
];
const rows: Record<string, unknown>[] = [];
for (const c of cases) {
  const data = invented(c.rows);
  const fileName = c.kind === "csv" ? "tb.csv" : "tb.xlsx";
  const file = `${dir}/${c.kind}-${c.rows}.${c.kind === "csv" ? "csv" : "xlsx"}`;
  if (c.kind === "csv") await Deno.writeTextFile(file, data.map((r) => r.join(",")).join("\n") + "\n");
  else {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "TB");
    await Deno.writeFile(file, new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: c.kind === "xlsx-deflate" }) as ArrayBuffer));
  }
  const size = (await Deno.stat(file)).size;
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", `--v8-flags=--max-old-space-size=${heapMb}`, "--allow-read", "--allow-net=esm.sh", "--allow-env", SELF, "--child", file, fileName],
    stdout: "piped", stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(p.stdout).trim().split("\n").pop() ?? "";
  let r: Record<string, unknown>;
  try { r = JSON.parse(out); } catch { r = { ok: false, terminated: true, code: p.code, stderr: new TextDecoder().decode(p.stderr).slice(-200) }; }
  const row = { ...c, fileMb: +(size / 1048576).toFixed(1), heapCapMb: heapMb, ...r };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await Deno.remove(dir, { recursive: true });
console.log(`\nUpload policy ${TB_UPLOAD_POLICY.version} under a ${heapMb} MB V8 heap cap (Deno ${Deno.version.deno}, V8 ${Deno.version.v8}):`);
for (const r of rows) console.log(`  ${String(r.kind).padEnd(13)} rows=${String(r.rows).padStart(7)} file=${String(r.fileMb).padStart(5)} MB  ${r.ok ? `${r.ms} ms, rss ${r.rssMb} MB, heap ${r.heapMb} MB${r.refusedBy ? `, refused ${r.refusedBy}` : ""}` : "TERMINATED (heap cap)"}`);
