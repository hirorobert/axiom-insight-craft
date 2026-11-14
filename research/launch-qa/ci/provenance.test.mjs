// node research/launch-qa/ci/provenance.test.mjs — regression checks for the provenance relationship (pure).
import { checkoutKind, provenanceRecord } from "./provenance.mjs";

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}`); } };

const base = {
  event: "pull_request", applicationSha: "a".repeat(40), applicationTree: "t".repeat(40), harnessTree: "h".repeat(40),
  prHeadSha: "f23f34727b8e455fe8be47ee545a7245762e2574", baseSha: "00a2653b5736e89447334e1147aa25f5308b0393",
  checkoutSha: "5c70e005237c3e99e9a1b48f7a7a6a0a5b969c80",
  checkoutParents: ["00a2653b5736e89447334e1147aa25f5308b0393", "f23f34727b8e455fe8be47ee545a7245762e2574"],
  applicationDiffAvailable: true, filesDifferingFromApplication: ["research/launch-qa/checks.mjs", ".github/workflows/ci.yml"], trackedModificationsBeforeBuild: [],
};

// Run 38946721958, as GitHub recorded it: the checkout is the merge of the PR head into the base — related, not stale.
const r = provenanceRecord(base);
check("a pull-request merge checkout of the PR head into the base is verified", r.verified && r.checkoutKind === "pull_request_merge");
check("a push checkout equal to the PR head is verified", provenanceRecord({ ...base, event: "push", checkoutSha: base.prHeadSha, checkoutParents: ["x"] }).checkoutKind === "pr_head");
check("a merge whose second parent is not the PR head is refused", !provenanceRecord({ ...base, checkoutParents: [base.baseSha, "b".repeat(40)] }).verified);
check("a merge into a different base is refused", !provenanceRecord({ ...base, checkoutParents: ["c".repeat(40), base.prHeadSha] }).verified);
check("GITHUB_SHA is never assumed to be the PR head", checkoutKind({ ...base, prHeadSha: base.checkoutSha === base.prHeadSha ? "z" : base.prHeadSha }) === "pull_request_merge" && base.checkoutSha !== base.prHeadSha);
check("an application difference outside the QA files is refused", !provenanceRecord({ ...base, filesDifferingFromApplication: ["src/App.tsx"] }).verified);
check("an application that could not be compared is refused", !provenanceRecord({ ...base, applicationDiffAvailable: false }).verified);
check("a locally modified tree is refused", !provenanceRecord({ ...base, trackedModificationsBeforeBuild: ["src/x.ts"] }).verified);
check("a missing PR head is refused", !provenanceRecord({ ...base, prHeadSha: "" }).verified);
check("a missing harness tree is refused", !provenanceRecord({ ...base, harnessTree: "unknown" }).verified);

console.log(`\n${pass}/${pass + fail} provenance regression checks passed.`);
process.exit(fail ? 1 : 0);
