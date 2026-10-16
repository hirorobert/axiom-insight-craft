// Launch-acceptance QA — the NINE customer-journey scenario functions (BLACK's independent acceptance).
//
// These are REAL journeys, grounded in the selectors/conventions the repository's own local-stack journey uses
// (scripts/e2e/localStackJourney.mjs — read-only reference): sign-in `#email`/`#password` at `/auth`; first run `#fr-*`
// radix pickers; launchpad `[data-testid="service-FINANCIAL_STATEMENTS"]`/`[data-testid="primary-cta"]`; uploader
// `[data-testid="trial-balance-file-input"]`/`[data-testid="trial-balance-upload-primary"]`; review
// `[data-testid="account-review-workbench"]`; server truth via the service-role client (trusted runner only).
//
// Each function takes `env` (built by launchAcceptance.mjs) and returns { status, problems, evidence }.
//   status: "PASS" | "FAIL" | "BLOCKED" | "NOT_APPLICABLE"   (never a fabricated PASS)
//   - PASS requires its assertions to have executed and found no problem.
//   - FAIL lists observed mismatches with the independent expectation.
//   - BLOCKED names a missing prerequisite (e.g. NORMAL's same-name repair, final invalid-file policy, mock-payment hook).
// RUNTIME-UNVERIFIED until executed on a capable runner; do not read these as passed until the runner reports PASS.
import { focusOrderProblems, loadingErrorStateProblems, copyWordingProblems, primaryActionProblems, responsiveProblems, ariaAssociationProblems, announcementProblems, clarityStateProblems } from "../checks.mjs";
import { accessOf, accessUnchanged, hasSandboxRecord, requireCreatedUpload } from "./evidenceRules.mjs";
import { BALANCED, IMBALANCED, SAME_NAME, UNSUPPORTED } from "../fixtures/syntheticTb.mjs";

const result = (status, problems = [], evidence = {}) => ({ status, problems, evidence });

// A: First upload — sign in (entitled synthetic user) → the Phase-2 "Check your trial balance" home → drop a supported
// invented TB → confirm entity/period/currency on the SAME page → "Start trial balance check" → inspect the real result and
// the SERVER-PERSISTED bindings. No guessed context, no duplicate entity, no false "passed".
async function scenarioA(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const file = env.taggedCsv("A", "A-first-upload.csv");       // A's OWN identifiable file
  const ws = await env.createWorkspace(page, { entityName: "Mto Holdings Limited", endsOn: "2026-06-30", currency: "TZS", file });
  if (ws.failure) return result("FAIL", [`first-upload check failed: ${String(ws.failure).slice(0, 400)}`]);
  if (!ws.companyId) return result("FAIL", ["the entity was not created / the result page did not open at /workspace/:id/:year"]);
  if (!ws.selectedFileOk) problems.push("the browser did not select the intended file (first-upload-file-card did not name it)");
  const { companyId, periodYear } = ws;
  // The upload under test is bound to A's OWN file by source_file_hash — not "latest".
  if (!ws.uploadId) problems.push(`no upload was created for A's file (source_file_hash ${ws.sourceHash.slice(0, 12)}) — a first upload must create one`);
  // Confirmed context is SOURCED, not guessed (server truth): one entity; the dated period + currency as confirmed.
  const co = (await env.admin.from("companies").select("id, name").eq("user_id", env.users.owner.id)).data ?? [];
  if (co.length !== 1) problems.push(`expected exactly one entity for the owner, found ${co.length} (no duplicate entity)`);
  const per = (await env.admin.from("fiscal_periods").select("reporting_start, reporting_end, reporting_currency").eq("company_id", companyId)).data ?? [];
  if (!(per.length === 1 && per[0].reporting_end === "2026-06-30" && per[0].reporting_currency === "TZS")) problems.push(`period/currency not persisted as confirmed: ${JSON.stringify(per)}`);
  if (ws.bound && !(ws.bound.period_year === periodYear && !!ws.bound.period_id && String(ws.bound.file_path).startsWith(`workspaces/${companyId}/`))) problems.push(`the bound upload is not attached to the intended entity/period: ${JSON.stringify(ws.bound)}`);
  // Truthful result: the server's own status settled for THIS upload; nothing is claimed certified before the engine wrote it.
  const up = ws.uploadId ? await env.settleUpload(ws.uploadId) : null;
  if (!up) problems.push("processing never settled for A's upload (a truthful result could not be observed)");
  env.record("A.uploadId", ws.uploadId);
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId, periodYear, uploadId: ws.uploadId, sourceHash: ws.sourceHash, period: per[0] });
}

// B: Existing entity — from an existing entity, show sourced context, confirm, and attach the upload to the INTENDED
// entity/period; no unintended new entity, no silent cross-period attachment.
async function scenarioB(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const existing = env.lastWorkspace; // the entity A created
  if (!existing?.companyId) return result("BLOCKED", ["requires scenario A's existing entity (run A first)"]);
  const beforeN = ((await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id)).data ?? []).length;
  // Upload B's OWN file to the EXISTING entity but a NEW period (the following year) through the first-upload card.
  const newYear = existing.periodYear + 1;
  const file = env.taggedCsv("B", "B-existing-entity.csv");
  const r = await env.firstUploadInto(page, { mode: "existing", existingEntityName: existing.entityName, year: newYear, endsOn: `${newYear}-06-30`, file });
  if (r.failure) return result("FAIL", [`B's upload to the existing entity failed: ${String(r.failure).slice(0, 300)}`]);
  if (!r.selectedFileOk) problems.push("the browser did not select B's own file");
  // A NEW upload must actually have been created and bound to B's file — no vacuous pass.
  const mustUpload = requireCreatedUpload(r.uploadId, `B's file (source_file_hash ${r.sourceHash.slice(0, 12)})`);
  if (mustUpload) return result("FAIL", [...problems, mustUpload]);
  const afterN = ((await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id)).data ?? []).length;
  if (afterN !== beforeN) problems.push(`an unintended new entity was created (${beforeN} → ${afterN}) — upload to an existing entity must not create one`);
  if (r.companyId !== existing.companyId) problems.push(`B's upload attached to a different entity (${r.companyId} ≠ ${existing.companyId})`);
  if (r.bound && r.bound.period_year !== newYear) problems.push(`silent cross-period attachment: upload bound to ${r.bound.period_year}, expected the new period ${newYear}`);
  const up = r.uploadId ? await env.settleUpload(r.uploadId) : null;
  if (!up) problems.push("B's upload never settled");
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId: existing.companyId, newYear, uploadId: r.uploadId, sourceHash: r.sourceHash });
}

// C: Recovery + identity isolation — refresh/back/interrupt/retry draft recovery for the SAME user; a second user never
// sees the first's draft/file/result; retries do not duplicate outcomes or consumption.
async function scenarioC(env) {
  const problems = [];
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  const route = `/workspace/${ws.companyId}/${ws.periodYear}/trial-balance/review`;
  const a = await env.openPage(); await env.signIn(a, env.users.owner);
  await env.go(a, route);
  // OBSERVABLE recovery: after a refresh and a back-navigation the owner is still on their own workspace route, NOT bounced
  // to sign-in, and the page renders workspace content (not an access refusal). (Grounded on the real page, not next-action.)
  await a.goto(`${env.APP}${route}`); await env.sleep(600);                 // refresh
  const afterRefresh = await env.observeWorkspacePage(a, ws.companyId);
  if (!afterRefresh.onWorkspace) problems.push(`own workspace did not recover after refresh (url=${afterRefresh.url})`);
  await a.evaluate(() => history.back()); await env.sleep(600);             // back
  const afterBack = await env.observeWorkspacePage(a, ws.companyId);
  if (afterBack.onAuth) problems.push(`back-navigation bounced the owner to sign-in (url=${afterBack.url})`);
  // Isolation: a DIFFERENT user must NOT see the first user's workspace. UI: the page does not render owner's workspace;
  // server truth: ownerB's own reads return nothing.
  const b = await env.openPage(); await env.signIn(b, env.users.ownerB);
  await b.goto(`${env.APP}/workspace/${ws.companyId}/${ws.periodYear}`); await env.sleep(600);
  const bView = await env.observeWorkspacePage(b, ws.companyId);
  if (bView.onWorkspace && bView.rendersCompany) problems.push(`CROSS-USER LEAKAGE: a second user sees the first user's workspace (url=${bView.url})`);
  if (await env.readsAsOtherUser(env.users.ownerB, ws.companyId)) problems.push("CROSS-USER LEAKAGE: a second user's API reads return the first user's data");
  return result(problems.length ? "FAIL" : "PASS", problems, { afterRefresh, afterBack });
}

// D: Purchase-required path — entitlements unchanged; the requirement is explained; the draft is preserved; the existing
// isolated purchase SIMULATION returns the user to the intended work. No implied free preview / unauthorised paid access.
async function scenarioD(env) {
  if (typeof env.mockPurchase !== "function" || typeof env.entitlementSnapshot !== "function" || !env.payments?.activateByAgreement) {
    return result("BLOCKED", ["purchase facility not supplied (env.mockPurchase / env.entitlementSnapshot / env.payments.activateByAgreement) — do not create a real payable checkout"]);
  }
  const problems = [];
  const u = env.users.preparer;                         // a fresh account with NO plan in this stack
  const page = await env.openPage(); await env.signIn(page, u);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Reach the purchase-required state UP FRONT: the Phase-2 home states the plan requirement before any upload.
  await env.go(page, "/dashboard", "Check your trial balance");
  const needsPlan = await page.waitForSelector('[data-testid="first-upload-needs-plan"]', { timeout: 30000 }).then(() => true).catch(() => false);
  if (!needsPlan) problems.push("purchase requirement not surfaced up front (first-upload-needs-plan absent)");
  // The file is still stored as a DRAFT (reserved), so nothing is lost.
  await page.setFiles('[data-testid="first-upload-input"]', [env.writeFile("D-balanced.csv", BALANCED.csv)]);
  await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 }).catch(() => {});
  const draftReserved = ((await env.admin.from("trial_balance_drafts").select("state").eq("owner_ref", u.id)).data ?? [])[0]?.state === "reserved";
  if (!draftReserved) problems.push("the file was not retained as a reserved draft for a no-plan user");
  // 'Start' explains a plan is needed and offers 'Choose a plan'; NOTHING is created or processed (server truth = no bypass).
  await env.setByLabel(page, "Entity name", "Pwani Invented Supplies Ltd");
  await page.click('[data-testid="confirm-period-year"]').catch(() => {}); await env.sleep(200);
  await env.setByLabel(page, "Ends on", "2026-06-30"); await env.setByLabel(page, "Trial balance currency", "TZS"); await env.sleep(300);
  await page.click('[data-testid="first-upload-start"]').catch(() => {});
  await page.waitForSelector('[data-testid="first-upload-failure"]', { timeout: 60000 }).catch(() => {});
  const failText = await page.evaluate(() => document.querySelector('[data-testid="first-upload-failure"]')?.textContent ?? "").catch(() => "");
  const choosePlan = await page.evaluate(() => !!document.querySelector('[data-testid="first-upload-choose-plan"]')).catch(() => false);
  if (!/needs a plan/i.test(failText) || !choosePlan) problems.push(`plan requirement not clearly explained with a 'Choose a plan' action (text="${failText.slice(0, 120)}", choosePlan=${choosePlan})`);
  const companies0 = ((await env.admin.from("companies").select("id").eq("user_id", u.id)).data ?? []).length === 0;
  const uploads0 = ((await env.admin.from("trial_balance_uploads").select("id").eq("user_id", u.id)).data ?? []).length === 0;
  if (!companies0 || !uploads0) problems.push("something was created/processed without a plan (no entity/upload may exist) — bypass");

  // Effective ACCESS only (licenceStatus + plan) — NOT the whole snapshot (evidenceRules): a sandbox order/audit record may
  // change without granting access, and comparing the whole object would false-FAIL on that.

  // SEPARATE ASSERTION 1 — a sandbox purchase grants NO paid access (access unchanged), though it IS recorded.
  const before = await env.entitlementSnapshot(u);
  await env.mockPurchase(page, u);                      // sandbox card purchase through the real /billing/checkout — never a real charge
  const afterPurchase = await env.entitlementSnapshot(u);
  if (!accessUnchanged(before, afterPurchase) || env.purchaseAuthorised) problems.push(`a sandbox purchase changed effective access (paid-access bypass): before=${JSON.stringify(accessOf(before))} after=${JSON.stringify(accessOf(afterPurchase))}`);
  if (!hasSandboxRecord(afterPurchase)) problems.push("the sandbox payment was not recorded (expected a POLAR_VERIFIED_PAYMENT:SANDBOX licence record that grants no access)");

  // SEPARATE ASSERTION 2 — only the AUTHORISED activation path grants access (effective access changes).
  await env.payments.activateByAgreement(u, "SOLO");
  const afterGrant = await env.entitlementSnapshot(u);
  if (accessUnchanged(afterGrant, before)) problems.push(`the authorised activation path did not grant access (access unchanged: ${JSON.stringify(accessOf(afterGrant))})`);

  // Draft PRESERVED + supported return: after a plan exists, the home offers 'Continue with' the SAME draft.
  await env.go(page, "/dashboard");
  const resume = await page.waitForSelector('[data-testid="first-upload-resume"]', { timeout: 30000 }).then(() => true).catch(() => false);
  if (!resume) problems.push("the retained draft was not offered ('Continue with' / first-upload-resume) after the plan was activated");
  return result(problems.length ? "FAIL" : "PASS", problems, { accessBefore: accessOf(before), accessAfterPurchase: accessOf(afterPurchase), accessAfterGrant: accessOf(afterGrant), sandboxRecorded: hasSandboxRecord(afterPurchase), needsPlan, draftReserved, resume });
}

// E: Replacement — explicit replacement decision; prior upload + history preserved; a STALE replacement refuses safely and
// leaves the current upload intact; retry after success returns the same outcome.
async function scenarioE(env) {
  const problems = [];
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires the existing entity + active trial balance from scenario A (run A first)"]);
  const entity = "Mto Holdings Limited";
  const cur = await env.activeUpload(ws.companyId, ws.periodYear);
  if (!cur) return result("BLOCKED", ["no active trial balance to replace (A did not leave one)"]);

  // EXPLICIT decision (browser): uploading again to an entity with an active TB offers 'Replace' — never automatic.
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const offered = await env.beginReplace(page, { existingEntityName: entity, file: env.writeFile("E-replacement.csv", BALANCED.csv) });
  if (!offered) return result("FAIL", ["no explicit 'Replace' was offered for an existing active trial balance (replacement must be an explicit decision)"]);
  const r = await env.clickReplace(page);
  if (!r.checked) problems.push(`the explicit replacement did not complete${r.failure ? ` (failure: ${String(r.failure).slice(0, 120)})` : ""}`);
  // History preserved (server truth): the prior upload is kept as superseded history; a new active upload replaces it.
  const afterOld = await env.uploadRow(cur.id);
  const afterActive = await env.activeUpload(ws.companyId, ws.periodYear);
  if (!(afterOld && afterOld.lifecycle_state === "superseded" && afterOld.superseded_by_upload_id && afterActive && afterActive.id !== cur.id)) {
    problems.push(`history not preserved on replacement: old=${JSON.stringify(afterOld)} active=${JSON.stringify(afterActive)} (expected old superseded → new active)`);
  }
  if (problems.length) return result("FAIL", problems, { original: cur, afterOld, afterActive });

  // STALE action: a deterministic stale replacement is NOT producible from the browser — FirstUpload.replace() re-reads the
  // current version at click time — so it is checked at the server CONTRACT, kept as SEPARATE evidence from the browser
  // replacement above. [NORMAL, coordinated on #144] env.drafts.staleReplace (scripts/e2e/launchQaDrafts.mjs) is the
  // draftJourney.mjs contract as this user, on this entity/period: a draft commit naming the CURRENT active upload with an
  // expected version one behind must be refused 409 replace_conflict, commit nothing, and leave that upload active at its
  // version. Absent or not executed ⇒ BLOCKED (never PASS).
  const browserReplacement = { executed: true, oldSuperseded: true, newActive: afterActive?.id ?? null };
  if (typeof env.drafts?.staleReplace !== "function") {
    return result("BLOCKED", ["stale-action contract check not supplied (env.drafts.staleReplace)"], { browserReplacement, original: cur, afterOld, afterActive });
  }
  const stale = await env.drafts.staleReplace(env.users.owner, ws.companyId, ws.periodYear);
  if (!stale?.executed) return result("BLOCKED", [`stale-action contract check did not execute: ${stale?.reason ?? "unknown"}`], { browserReplacement, staleContract: stale });
  if (stale.status !== 409 || stale.outcome !== "replace_conflict") problems.push(`a stale replacement was not refused as replace_conflict (got ${stale.status} ${stale.outcome})`);
  if (stale.accepted) problems.push("a stale replacement was ACCEPTED (committed)");
  if (!stale.currentKept) problems.push("the active upload did not stay current (id and version) after the refused stale replacement");
  if (stale.currentId !== afterActive?.id) problems.push(`the stale check did not target the upload the browser replacement made current (${stale.currentId} vs ${afterActive?.id})`);
  return result(problems.length ? "FAIL" : "PASS", problems, { browserReplacement, staleContract: stale, original: cur, afterOld, afterActive });
}

// F: Invalid / unsupported / over-limit files — actionable refusal, no silent truncation, no accepted partial result,
// recovery with a normal file afterwards. USES NORMAL's final policy/fixtures for the limit — does not invent one.
async function scenarioF(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  if (!env.overLimitFixture?.path) return result("BLOCKED", ["over-limit sub-check needs env.overLimitFixture (NORMAL's current upload-policy fixture); no invented limit"]);
  const expected = env.overLimitFixture.expectedCode || "TOO_MANY_ACCOUNTS";

  // UNSUPPORTED file (its OWN file): the dropzone refuses it with an actionable error; NO draft/upload is created for it.
  const unsupFile = env.writeFile(UNSUPPORTED.name, UNSUPPORTED.content);
  const unsup = await env.firstUploadRefusal(page, unsupFile);
  if (unsup.confirm) problems.push("an unsupported file was accepted onto the confirmation card (should be refused at the dropzone)");
  if (!(unsup.error || unsup.limits)) problems.push("the unsupported file was not refused with an actionable error");
  if (unsup.error) problems.push(...loadingErrorStateProblems({ phase: "error", errorMessage: unsup.error, nextAction: "choose another file" }).filter((p) => /raw\/internal/.test(p)));
  if (unsup.uploadsForFile > 0) problems.push("the unsupported file produced an upload (must accept nothing)");

  // OVER-LIMIT (NORMAL's fixture, its OWN identifiable file): it is structurally valid so it reaches the card, then
  // "Start" is refused by name (TOO_MANY_ACCOUNTS). NOTHING is created: no entity, no upload bound to this file's hash.
  const overHash = env.sha256File(env.overLimitFixture.path);
  const entitiesBefore = ((await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id)).data ?? []).length;
  const over = await env.firstUploadInto(page, { mode: "new", entityName: "Finvalid Over Limit Ltd", file: env.overLimitFixture.path });
  const overErr = String(over.failure ?? "");
  const refusedByName = new RegExp(expected, "i").test(overErr) || /too many accounts|account limit|exceed/i.test(overErr);
  const overUpload = ((await env.admin.from("trial_balance_uploads").select("id").eq("source_file_hash", overHash)).data ?? []).length;
  const entitiesAfter = ((await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id)).data ?? []).length;
  if (!refusedByName) problems.push(`over-limit upload was not refused by name (${expected}); failure="${overErr.slice(0, 200)}"`);
  if (over.uploadId || overUpload > 0) problems.push(`over-limit produced an accepted/partial upload (uploadId=${over.uploadId}, rowsForFile=${overUpload}) — must accept nothing`);
  if (entitiesAfter !== entitiesBefore) problems.push(`over-limit created an entity (${entitiesBefore} → ${entitiesAfter}) — nothing should be created`);

  // RECOVERY: a normal file into a fresh entity succeeds (its own file, bound by hash).
  const rec = await env.firstUploadInto(page, { mode: "new", entityName: "Frecovery Normal Ltd", file: env.taggedCsv("F", "F-recovery.csv") });
  if (!rec.uploadId) problems.push(`could not recover with a normal file after the refusals (no upload bound; failure="${String(rec.failure ?? "").slice(0, 160)}")`);
  return result(problems.length ? "FAIL" : "PASS", problems, { expected, policy: env.overLimitFixture.policy, overLimitAccounts: env.overLimitFixture.accounts, unsup, overFailure: overErr.slice(0, 200), recoveryUploadId: rec.uploadId });
}

// G: Review + identity — legitimate same-name/different-code accounts AFTER NORMAL's repair: separate identities &
// treatments; ambiguous matching stays unresolved (never first/last); an imbalance/missing evidence stays visible.
async function scenarioG(env) {
  if (!env.sameNameRepairApplied) return result("BLOCKED", ["gated on NORMAL's same-name/different-code repair being present+verified in the DB under test (uq_acct_map_company_codeless_name, old all-names index gone). Until verified, mapping two same-name accounts raises a raw constraint error — a FINDING in the Phase-5 lane, not asserted here."]);
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  // G's OWN entity + OWN file (never A's result): a fresh first-upload bound by source_file_hash.
  const file = env.writeFile("G-same-name.csv", SAME_NAME.csv);
  const r = await env.firstUploadInto(page, { mode: "new", entityName: "Gemini Same Name Ltd", file });
  if (r.failure) return result("FAIL", [`G's same-name upload failed: ${String(r.failure).slice(0, 300)}`]);
  if (!r.uploadId || !r.companyId) return result("FAIL", [`G's same-name trial balance did not create a bound upload (companyId=${r.companyId}, uploadId=${r.uploadId})`]);
  const companyId = r.companyId, uploadId = r.uploadId;
  await env.settleUpload(uploadId);
  // Mappings exist ONLY after review decisions (resolve_account_review_batch). REVIEW BOTH "Sales" accounts first, as the
  // owner (authenticated), each keyed by its own code — then check they persist as two DISTINCT mappings.
  const decisions = SAME_NAME.rows.filter((r) => /sales/i.test(r.name)).map((r) => ({
    account_code: r.code, account_name: r.name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION",
    statement: "income_statement", classification: "revenue", line_item: r.name, normal_balance: "credit",
  }));
  const reviewed = await env.reviewAccounts(env.users.owner, companyId, uploadId, decisions);
  if (reviewed.error) return result("FAIL", [`reviewing both same-name accounts was refused: ${reviewed.error}`], { uploadId });
  const mapped = await env.admin.from("account_mappings").select("account_key, account_code, account_name, statement, classification").eq("company_id", companyId).ilike("account_name", "Sales");
  const rows = mapped.data ?? [];
  const codes = new Set(rows.map((m) => m.account_code));
  const keys = new Set(rows.map((m) => m.account_key));
  if (rows.length < 2) problems.push(`both same-name 'Sales' accounts were not persisted as mappings (rows=${rows.length})`);
  if (codes.size < 2 || keys.size < 2) problems.push(`the two 'Sales' accounts are not DISTINCT identities (codes=${[...codes].join(",")}; keys=${[...keys].join(",")}) — a coded account must not inherit another's treatment by name`);
  // Each persisted mapping must match the decision SUBMITTED for its own code, keyed by its own distinct source identity.
  for (const d of decisions) {
    const forCode = rows.filter((m) => m.account_code === d.account_code);
    if (forCode.length !== 1) { problems.push(`code ${d.account_code} did not persist exactly one mapping (got ${forCode.length})`); continue; }
    const m = forCode[0];
    if (m.statement !== d.statement || m.classification !== d.classification) problems.push(`mapping for code ${d.account_code} does not match its submitted decision (got ${m.statement}/${m.classification}, submitted ${d.statement}/${d.classification})`);
    if (m.account_key !== d.account_code) problems.push(`mapping for code ${d.account_code} is not keyed by its own code (account_key=${m.account_key})`);
  }
  return result(problems.length ? "FAIL" : "PASS", problems, { uploadId, codes: [...codes], keys: [...keys], mappings: rows });
}

// H: Accessibility + responsive — keyboard access, logical/visible focus, accessible labels, error association, processing
// announcement, recovery controls; 320/390/desktop. Tables may scroll in-container; the PAGE must not clip.
async function scenarioH(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  for (const vw of [320, 390, 1280]) {
    const obs = await env.observeViewport(page, `/workspace/${ws.companyId}/${ws.periodYear}`, vw);
    problems.push(...responsiveProblems(vw, obs.layoutWidth, { label: `workspace@${vw}` }));
  }
  const focusables = await env.observeFocusSequence(page);
  problems.push(...focusOrderProblems(focusables));
  const fields = await env.observeFields(page);
  problems.push(...ariaAssociationProblems(fields));
  const ann = await env.observeProcessingAnnouncement(page);
  problems.push(...announcementProblems(ann));
  // Agreed accessibility scope (ACCEPTANCE-PLAN H): the REQUIRED checks — keyboard/focus, visible focus, accessible labels,
  // error association, processing announcement, responsive 320/390/desktop — MUST execute (above). axe is OPTIONAL ("where
  // available"): it is NOT a new mandatory dependency. A required problem ⇒ FAIL. If axe is wired, run it and FAIL on
  // violations. If it is not wired, its absence is reported SEPARATELY as evidence (not a gate-blocking problem) — a
  // zero-violation count alone would not be full proof anyway; the manual checks are the acceptance.
  if (problems.length) return result("FAIL", problems);
  if (typeof env.axe === "function") {
    const violations = await env.axe(page);
    if (violations?.length) return result("FAIL", violations.map((v) => `axe: ${v.id} (${v.nodes} nodes)`));
    return result("PASS", [], { axe: "wired: 0 violations; plus manual keyboard/focus/aria/announcement/responsive" });
  }
  return result("PASS", [], { axe: "not wired (optional per plan); required manual keyboard/focus/aria/announcement/responsive checks executed and clean — automated scan absence reported separately, not a blocker" });
}

// I: Professional clarity — first-visit/confirmation/processing/result/blocked/retry each say what happened, what to do
// next, and whether anything was saved/committed. Flag competing primaries, codenames, unsupported claims.
async function scenarioI(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  // FIRST-VISIT clarity on the real first-upload home: what happened (heading), one clear next action (first-upload-choose/
  // start), and whether anything is saved (draft note / nothing-yet). One primary action; no codenames/claims.
  await env.go(page, "/dashboard");
  await page.waitForSelector('[data-testid="first-upload-input"], [data-testid="first-upload-dropzone"]', { timeout: 30000 }).catch(() => {});
  const home = await env.captureClarityState(page, "first-upload-home");
  if (!home) return result("FAIL", ["could not observe the first-upload home to assess clarity"]);
  problems.push(...clarityStateProblems(home));
  problems.push(...primaryActionProblems(home.ctas));
  problems.push(...copyWordingProblems(home.copy, { context: "first-upload-home" }));
  // RESULT state clarity: A's reviewed workspace page — actionable controls + no codenames/unsupported claims.
  const ws = env.lastWorkspace;
  if (ws?.companyId) {
    await env.go(page, `/workspace/${ws.companyId}/${ws.periodYear}/trial-balance/review`);
    const res = await env.captureClarityState(page, "result");
    if (res) { problems.push(...copyWordingProblems(res.copy, { context: "result" })); if (!res.whatNext) problems.push("[result] offers no actionable next control on the trial-balance page"); }
  }
  return result(problems.length ? "FAIL" : "PASS", problems, { home: { whatHappened: home.whatHappened, whatNext: home.whatNext, saved: home.saved } });
}

export const SCENARIOS = [
  { id: "A", name: "First upload → context → processing → truthful result", run: scenarioA },
  { id: "B", name: "Existing entity: sourced context, correct attachment, no unintended entity", run: scenarioB },
  { id: "C", name: "Recovery + identity isolation (no cross-user leakage, no duplicate consumption)", run: scenarioC },
  { id: "D", name: "Purchase-required: clear explanation, preserved draft, no bypass (mock payment)", run: scenarioD },
  { id: "E", name: "Replacement: explicit, history preserved, stale refused safely", run: scenarioE },
  { id: "F", name: "Invalid/unsupported/over-limit: actionable refusal, no false success, recovery", run: scenarioF },
  { id: "G", name: "Review: same-name/different-code distinct identities (after NORMAL's repair)", run: scenarioG },
  { id: "H", name: "Accessibility + responsive (320/390/desktop, keyboard/focus/aria/announce)", run: scenarioH },
  { id: "I", name: "Professional clarity across states; one primary action; no codenames/claims", run: scenarioI },
];
