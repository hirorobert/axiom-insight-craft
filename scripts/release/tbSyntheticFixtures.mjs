#!/usr/bin/env node
// Invented trial balance files for the hosted checks of batch tb-release-r1 (docs/release/tb-release-r1/HANDOFF.md, step 6).
// Every account, name and amount is made up; nothing comes from a client. Deterministic: the same command always writes
// the same bytes, and each file's SHA-256 is printed so the evidence record can name the exact file used.
//
//   node scripts/release/tbSyntheticFixtures.mjs [outDir]     (default: ~/cfoclose-synthetic/tb-release-r1)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEADER = "Account code,Account name,Debit,Credit";

/** n accounts, balanced: n-1 invented expense/asset debits, one invented revenue credit equal to their sum. */
export function balanced(n, tag) {
  const rows = [HEADER];
  let total = 0;
  for (let i = 1; i < n; i++) {
    const amount = 1000 + i;
    total += amount;
    rows.push(`${100000 + i},Invented account ${tag} ${i},${amount}.00,`);
  }
  rows.push(`900000,Invented revenue ${tag},,${total}.00`);
  return rows.join("\n") + "\n";
}

export const FIXTURES = Object.freeze({
  // Step 6.1 — resource: exactly at the account bound (2,000), balanced; must be certified at generation 6.
  "resource-2000-accounts.csv": () => balanced(2000, "R"),
  // Step 6.3 — refusal: one account over the bound; must be refused TOO_MANY_ACCOUNTS with no certification.
  "refusal-2001-accounts.csv": () => balanced(2001, "X"),
  // Step 6.4/6.5 — the first upload, then the trial balance a refused replacement must restore to.
  "first-upload-small.csv": () => [HEADER, "4000,Invented sales,,60000.00", "5000,Invented cost of sales,32000.00,", "1000,Invented bank,28000.00,"].join("\n") + "\n",
  // Step 6.5 — a replacement the browser must refuse before upload (over the 10 MB raw-file limit).
  "replacement-over-10mb.csv": () => HEADER + "\n" + "100001,Invented padding account with a long descriptive name for size,1.00,0.00\n".repeat(150_000),
  // Step 6.6 — account identity: two coded accounts with the same name must both be reviewable.
  "same-name-two-codes.csv": () => [HEADER, "4000,Sales,,50000.00", "4100,Sales,,10000.00", "1000,Invented bank,60000.00,"].join("\n") + "\n",
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const out = path.resolve(process.argv[2] ?? path.join(os.homedir(), "cfoclose-synthetic", "tb-release-r1"));
  fs.mkdirSync(out, { recursive: true });
  for (const [name, make] of Object.entries(FIXTURES)) {
    const bytes = Buffer.from(make(), "utf8");
    fs.writeFileSync(path.join(out, name), bytes);
    console.log(`${name}  ${bytes.length} B  sha256 ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
  }
  console.log(`written to ${out}`);
}
