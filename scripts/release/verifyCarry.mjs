#!/usr/bin/env node
// Verifies the committed carry patch against the real #221 head: applies docs/release/ipsas-accrual-chain-r1/carry/ipsas-auth-journey.carry.patch to a
// scratch checkout of the base (default b434e76, #221's head) and requires the two resulting files to be byte-identical to the current HEAD's.
// Needs git history (it exits 2, "cannot verify", when the base commit is not available - for example in a shallow CI clone - and never claims success then).
//   node scripts/release/verifyCarry.mjs [baseCommit]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.argv[2] ?? "b434e76";
const PATCH = path.join(REPO, "docs/release/ipsas-accrual-chain-r1/carry/ipsas-auth-journey.carry.patch");
const FILES = ["scripts/e2e/ipsasAuthJourney.mjs", "src/lib/__tests__/ipsasAuthJourney.test.ts"];
const git = (args, cwd = REPO) => execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

try { git(["cat-file", "-e", `${BASE}^{commit}`]); } catch { console.error(`CARRY_UNVERIFIED: base commit ${BASE} is not in this clone (shallow or not fetched); nothing was checked`); process.exit(2); }
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-carry-"));
let ok = false;
try {
  git(["worktree", "add", "--detach", scratch, BASE]);
  git(["apply", "--whitespace=nowarn", PATCH], scratch);
  const problems = [];
  for (const f of FILES) {
    const got = fs.readFileSync(path.join(scratch, f));
    const want = fs.readFileSync(path.join(REPO, f));
    if (sha(got) !== sha(want)) problems.push(`${f}: patched ${sha(got).slice(0, 12)} != HEAD ${sha(want).slice(0, 12)}`);
    else console.log(`  ${f}  ${sha(got).slice(0, 16)}  identical to HEAD`);
  }
  if (problems.length) { console.error(`CARRY_MISMATCH:\n  ${problems.join("\n  ")}`); }
  else { console.log(`CARRY_VERIFIED: the patch turns ${BASE} into the current files byte for byte`); ok = true; }
} catch (e) { console.error(`CARRY_FAILED: ${String(e.stderr ?? e.message).split("\n")[0]}`); }
finally { try { git(["worktree", "remove", "--force", scratch]); } catch { /* */ } }
process.exit(ok ? 0 : 1);
