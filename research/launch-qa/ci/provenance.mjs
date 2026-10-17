// Launch-acceptance provenance (NORMAL, evidence branch only; never merged). Records — separately — the commits a CI run
// involves and VERIFIES how they relate, instead of assuming one equals another (BLACK's finding on run 38946721958: the
// harness recorded the checked-out commit 5c70e005, GitHub's synthetic pull-request merge of the PR head f23f347 into the
// base, under the name "harnessSha"; both were true, the label and the missing relationship were the defect).
//
//   applicationSha / applicationTree   the candidate application under test (LAUNCH_QA_CANDIDATE_SHA) and its tree
//   prHeadSha                          the commit pushed to the PR — it carries the harness (github.event.pull_request.head.sha)
//   baseSha                            the PR base at the event (github.event.pull_request.base.sha)
//   checkoutSha / checkoutParents      what CI actually checked out and built (git rev-parse HEAD; parents from the commit
//                                      object, which a shallow clone still contains)
//   harnessTree                        the content identity of research/launch-qa as executed (HEAD:research/launch-qa)
//
// Verified when: the checkout is either the PR head itself (push) or exactly the merge of the PR head into the base
// (pull_request: parents [base, head]); the checkout differs from the application only in the QA files; nothing was
// modified locally before the build.
export const QA_PATH = /^(research\/launch-qa\/|research\/compat\/|\.github\/workflows\/ci\.yml$)/;

export function checkoutKind({ event, prHeadSha, baseSha, checkoutSha, checkoutParents }) {
  const parents = checkoutParents ?? [];
  if (checkoutSha && prHeadSha && checkoutSha === prHeadSha) return "pr_head";
  if (event === "pull_request" && parents.length === 2 && parents[0] === baseSha && parents[1] === prHeadSha) return "pull_request_merge";
  return "unrelated";
}

export function provenanceProblems(p) {
  const problems = [];
  for (const k of ["applicationSha", "applicationTree", "prHeadSha", "checkoutSha", "harnessTree"]) {
    if (!p?.[k] || p[k] === "unknown") problems.push(`${k} was not recorded`);
  }
  const kind = checkoutKind(p ?? {});
  if (kind === "unrelated") problems.push(`the checkout ${p?.checkoutSha} is neither the PR head ${p?.prHeadSha} nor the merge of it into the base ${p?.baseSha} (parents ${JSON.stringify(p?.checkoutParents ?? [])})`);
  if (p?.applicationDiffAvailable === false) problems.push("the application commit could not be compared with the checkout");
  const outside = (p?.filesDifferingFromApplication ?? []).filter((f) => !QA_PATH.test(f));
  if (outside.length) problems.push(`the checkout differs from the application outside the QA files: ${outside.join(", ")}`);
  if ((p?.trackedModificationsBeforeBuild ?? []).length) problems.push(`tracked files were modified before the build: ${p.trackedModificationsBeforeBuild.join(", ")}`);
  return problems;
}

/** The record written to identity.json (and read by the harness, the gate and every evidence file). */
export function provenanceRecord(facts) {
  const problems = provenanceProblems(facts);
  return { ...facts, checkoutKind: checkoutKind(facts), verified: problems.length === 0, problems };
}
