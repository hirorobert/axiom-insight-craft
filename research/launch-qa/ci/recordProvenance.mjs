// node research/launch-qa/ci/recordProvenance.mjs <outDir> — the launch-acceptance identity step (evidence branch only).
// Gathers the facts from git and the event (never assuming GITHUB_SHA is the PR head), writes identity.json through the pure
// provenanceRecord(), prints it, and exits 1 unless the relationship is verified (provenance.mjs).
//   env: LAUNCH_QA_CANDIDATE_SHA (application), LAUNCH_QA_PR_HEAD_SHA, LAUNCH_QA_BASE_SHA, LAUNCH_QA_EVENT
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { provenanceRecord } from "./provenance.mjs";

const out = path.resolve(process.argv[2] ?? "real-app-evidence/launch-qa");
fs.mkdirSync(out, { recursive: true });
const git = (...a) => { try { return { ok: true, text: execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() }; } catch { return { ok: false, text: "" }; } };
const lines = (t) => t.split("\n").map((s) => s.trim()).filter(Boolean);

const applicationSha = process.env.LAUNCH_QA_CANDIDATE_SHA ?? "";
const checkoutSha = git("rev-parse", "HEAD").text;
// Parents come from the commit object itself, which a shallow checkout still holds.
const checkoutParents = lines(git("cat-file", "-p", "HEAD").text).filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
const diff = git("diff", "--name-only", applicationSha, "HEAD");
const facts = {
  event: process.env.LAUNCH_QA_EVENT ?? null,
  applicationSha, applicationTree: git("rev-parse", `${applicationSha}^{tree}`).text || "unknown",
  prHeadSha: process.env.LAUNCH_QA_PR_HEAD_SHA ?? "", baseSha: process.env.LAUNCH_QA_BASE_SHA || null,
  checkoutSha, checkoutTree: git("rev-parse", "HEAD^{tree}").text || "unknown", checkoutParents,
  harnessTree: git("rev-parse", "HEAD:research/launch-qa").text || "unknown",
  applicationDiffAvailable: diff.ok, filesDifferingFromApplication: lines(diff.text),
  trackedModificationsBeforeBuild: lines(git("diff", "--name-only", "HEAD").text),
  recordedAt: new Date().toISOString(),
};
const rec = provenanceRecord(facts);
fs.writeFileSync(path.join(out, "identity.json"), `${JSON.stringify(rec, null, 2)}\n`);
console.log(JSON.stringify(rec, null, 2));
process.exit(rec.verified ? 0 : 1);
