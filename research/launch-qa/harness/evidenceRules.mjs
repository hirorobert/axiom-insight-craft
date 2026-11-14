// Launch-acceptance QA — shared EVIDENCE rules that guard against the false positives NORMAL found on run 38919978092.
// Pure, so the regressions in evidenceRules.test.mjs cover the exact code the scenarios use.

// D false positive: the whole entitlement snapshot was compared, so the expected SANDBOX order/audit record (which grants
// NO access) false-FAILed as "access changed". Effective access is licenceStatus + plan ONLY.
export const accessOf = (s) => ({ licenceStatus: s?.licenceStatus ?? null, plan: s?.plan ?? null });
export const accessUnchanged = (a, b) => JSON.stringify(accessOf(a)) === JSON.stringify(accessOf(b));
export const hasSandboxRecord = (s) => (s?.licences ?? []).some((l) => /SANDBOX/i.test(typeof l === "string" ? l : JSON.stringify(l)));

// B/F/G false positive: assertions bound to the "latest upload", which was A's. The upload a scenario assesses MUST be the
// one it created, identified by its own file's source_file_hash — never the newest row for the company/period.
export function boundUploadId(rows, sourceHash) {
  const own = (rows ?? []).filter((r) => r && r.source_file_hash === sourceHash);
  return own.length === 1 ? own[0].id : null; // exactly the scenario's own upload, or nothing (never "latest")
}

// B false positive: B "passed" having uploaded nothing. Where an upload is required, its absence is a FAIL, not a pass.
export function requireCreatedUpload(uploadId, label) {
  return uploadId ? null : `no new upload was created for ${label} — nothing was uploaded (must FAIL, never a vacuous pass)`;
}

// EXACT binding (NORMAL, owner direction): identical file contents do not identify an upload. The upload a scenario
// assesses is the one its OWN draft produced: the signed-in user's draft of this file (content_sha256) created during the
// scenario → that draft's COMMITTED commit (which names the entity, the period year and period id) → the commit's upload_id
// → that upload row, whose company, period year and period id must equal the commit's and whose source_file_hash (when the
// server has recorded it) must equal the file's. Any ambiguity or mismatch binds nothing and says why.
export function bindCommittedUpload({ drafts, commits, upload }, { sourceHash, companyId = null, periodYear = null } = {}) {
  const ownDrafts = (drafts ?? []).filter((d) => d && d.content_sha256 === sourceHash);
  if (ownDrafts.length !== 1) return { uploadId: null, problems: [`expected exactly one draft of this file by this user in this scenario, found ${ownDrafts.length}`] };
  const d = ownDrafts[0];
  const done = (commits ?? []).filter((c) => c && c.draft_id === d.id && c.state === "committed");
  if (done.length !== 1) return { uploadId: null, draftId: d.id, problems: [`expected exactly one committed commit for the draft, found ${done.length}`] };
  const c = done[0];
  // The entity a commit binds is its target (tbd_finish_commit compares the upload's company_id to target_company_ref).
  const commitCompany = c.target_company_ref ?? c.company_id ?? null;
  const problems = [];
  if (!c.upload_id) problems.push("the committed commit names no upload");
  else if (!upload || upload.id !== c.upload_id) problems.push(`the upload the commit names (${c.upload_id}) was not found`);
  else {
    if (upload.company_id !== commitCompany) problems.push(`upload entity ${upload.company_id} ≠ commit entity ${commitCompany}`);
    if (companyId && upload.company_id !== companyId) problems.push(`upload entity ${upload.company_id} ≠ the entity the scenario intended ${companyId}`);
    if (upload.period_year !== c.period_year) problems.push(`upload period year ${upload.period_year} ≠ commit period year ${c.period_year}`);
    if (periodYear != null && upload.period_year !== periodYear) problems.push(`upload period year ${upload.period_year} ≠ the period the scenario intended ${periodYear}`);
    if ((c.period_id ?? null) !== (upload.period_id ?? null)) problems.push(`upload period ${upload.period_id} ≠ commit period ${c.period_id}`);
    if (upload.source_file_hash != null && upload.source_file_hash !== sourceHash) problems.push("the upload's recorded source hash is not this file's");
  }
  return { uploadId: problems.length ? null : upload.id, draftId: d.id, commitId: c.id, companyId: commitCompany, periodYear: c.period_year ?? null, periodId: c.period_id ?? null, problems };
}
