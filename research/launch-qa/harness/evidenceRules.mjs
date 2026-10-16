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
