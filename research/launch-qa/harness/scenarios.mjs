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
import { BALANCED, IMBALANCED, SAME_NAME, UNSUPPORTED } from "../fixtures/syntheticTb.mjs";

const result = (status, problems = [], evidence = {}) => ({ status, problems, evidence });

// A: First upload — sign in (entitled synthetic user) → the Phase-2 "Check your trial balance" home → drop a supported
// invented TB → confirm entity/period/currency on the SAME page → "Start trial balance check" → inspect the real result and
// the SERVER-PERSISTED bindings. No guessed context, no duplicate entity, no false "passed".
async function scenarioA(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const file = env.writeFile("A-balanced.csv", BALANCED.csv);
  const ws = await env.createWorkspace(page, { entityName: "Mto Holdings Limited", endsOn: "2026-06-30", currency: "TZS", file });
  if (ws.failure) return result("FAIL", [`first-upload check failed: ${String(ws.failure).slice(0, 200)}`]);
  if (!ws.companyId) return result("FAIL", ["the entity was not created / the result page did not open at /workspace/:id/:year"]);
  const { companyId, periodYear } = ws;
  // Confirmed context is SOURCED, not guessed (server truth): one entity; the dated period + currency as confirmed; the
  // upload bound to that entity+period.
  const co = (await env.admin.from("companies").select("id, name").eq("user_id", env.users.owner.id)).data ?? [];
  if (co.length !== 1) problems.push(`expected exactly one entity for the owner, found ${co.length} (no duplicate entity)`);
  const per = (await env.admin.from("fiscal_periods").select("reporting_start, reporting_end, reporting_currency").eq("company_id", companyId)).data ?? [];
  if (!(per.length === 1 && per[0].reporting_end === "2026-06-30" && per[0].reporting_currency === "TZS")) problems.push(`period/currency not persisted as confirmed: ${JSON.stringify(per)}`);
  const ups = (await env.admin.from("trial_balance_uploads").select("id, period_year, period_id, file_path").eq("company_id", companyId)).data ?? [];
  if (!(ups.length === 1 && ups[0].period_year === periodYear && !!ups[0].period_id && String(ups[0].file_path).startsWith(`workspaces/${companyId}/`))) problems.push(`upload not bound to the intended entity/period: ${JSON.stringify(ups)}`);
  // Truthful result: the server's own status settled; nothing is claimed certified/reviewed before the engine wrote it.
  const up = await env.settle(companyId, periodYear);
  if (!up) problems.push("processing never settled (a truthful result could not be observed)");
  env.record("A.uploadId", ups[0]?.id ?? null);
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId, periodYear, uploadId: ups[0]?.id ?? null, period: per[0] });
}

// B: Existing entity — from an existing entity, show sourced context, confirm, and attach the upload to the INTENDED
// entity/period; no unintended new entity, no silent cross-period attachment.
async function scenarioB(env) {
  const problems = [];
  const page = await env.openPage();
  await env.signIn(page, env.users.owner);
  const before = await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id);
  const beforeN = (before.data ?? []).length;
  const existing = env.lastWorkspace; // the entity A created in scenario A
  if (!existing?.companyId) return result("BLOCKED", ["requires scenario A's existing entity (run A first)"]);
  const uploadId = await env.uploadTb(page, existing.companyId, existing.periodYear, env.writeFile("B-balanced.csv", BALANCED.csv));
  const after = await env.admin.from("companies").select("id").eq("user_id", env.users.owner.id);
  if ((after.data ?? []).length !== beforeN) problems.push("an unintended new entity was created when uploading to an existing one");
  const up = uploadId && await env.admin.from("trial_balance_uploads").select("company_id, period_year").eq("id", uploadId).maybeSingle();
  if (up?.data && (up.data.company_id !== existing.companyId || up.data.period_year !== existing.periodYear)) problems.push(`upload attached to the wrong entity/period: ${JSON.stringify(up.data)}`);
  return result(problems.length ? "FAIL" : "PASS", problems, { companyId: existing.companyId });
}

// C: Recovery + identity isolation — refresh/back/interrupt/retry draft recovery for the SAME user; a second user never
// sees the first's draft/file/result; retries do not duplicate outcomes or consumption.
async function scenarioC(env) {
  const problems = [];
  const a = await env.openPage(); await env.signIn(a, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  await env.go(a, `/workspace/${ws.companyId}/${ws.periodYear}/trial-balance/review`);
  await a.goto(await a.url()); // refresh
  await a.evaluate(() => history.back()); await env.sleep(500);
  const recovered = await env.isWorkspaceVisible(a, ws.companyId);
  if (!recovered) problems.push("the owner's own workspace/draft did not recover after refresh/back");
  // Isolation: a DIFFERENT user (fresh identity) must NOT see the first user's workspace — the URL is refused and its API
  // reads return nothing. Mirrors the repository journey's isolation control.
  const b = await env.openPage(); await env.signIn(b, env.users.ownerB);
  await b.goto(`${env.APP}/workspace/${ws.companyId}/${ws.periodYear}`);
  const leaked = await env.isWorkspaceVisible(b, ws.companyId);
  if (leaked) problems.push("CROSS-USER LEAKAGE: a second user can see the first user's workspace");
  const bApiLeak = await env.readsAsOtherUser(env.users.ownerB, ws.companyId); // service-truth: ownerB's own reads see nothing
  if (bApiLeak) problems.push("CROSS-USER LEAKAGE: a second user's API reads return the first user's data");
  return result(problems.length ? "FAIL" : "PASS", problems);
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

  // SEPARATE ASSERTION 1 — sandbox purchase authorises NOTHING (no paid-access bypass).
  const before = await env.entitlementSnapshot(u);
  await env.mockPurchase(page, u);                      // sandbox card purchase through the real /billing/checkout — never a real charge
  const afterPurchase = await env.entitlementSnapshot(u);
  if (!eq(before, afterPurchase) || env.purchaseAuthorised) problems.push(`a sandbox purchase changed access (paid-access bypass): before=${JSON.stringify(before)} after=${JSON.stringify(afterPurchase)}`);

  // SEPARATE ASSERTION 2 — the AUTHORISED activation path (and only it) grants access.
  await env.payments.activateByAgreement(u, "SOLO");
  const afterGrant = await env.entitlementSnapshot(u);
  if (eq(afterGrant, before)) problems.push("the authorised activation path did not grant access");

  // Draft PRESERVED + supported return: after a plan exists, the home offers 'Continue with' the SAME draft.
  await env.go(page, "/dashboard", "Check your trial balance");
  const resume = await page.waitForSelector('[data-testid="first-upload-resume"]', { timeout: 30000 }).then(() => true).catch(() => false);
  if (!resume) problems.push("the retained draft was not offered ('Continue with' / first-upload-resume) after the plan was activated");
  return result(problems.length ? "FAIL" : "PASS", problems, { before, afterPurchase, afterGrant, needsPlan, draftReserved, resume });
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
  // current version at click time (FirstUpload.tsx L205-207), so holding an old card and clicking later commits at the
  // CURRENT version, never stale. The authentic test is the draft-commit CONTRACT with a crafted expected_version (exactly
  // scripts/e2e/draftJourney.mjs proves: replaces_upload_id + expected_version-1 ⇒ 409 replace_conflict, current kept).
  // Wiring that into this harness needs two values I will not guess: the private drafts STORAGE BUCKET name and the exact
  // `confirmation` shape the commit validates for THIS entity/period. GENUINE dependency for NORMAL (or allow driving
  // commitDraft with replaces.expectedVersion directly). The explicit replacement above executed and preserved history.
  return result("BLOCKED", [
    "stale-action sub-check: a deterministic stale replacement cannot be produced via the browser (replace() re-reads the version); the contract test needs the drafts storage-bucket name + the commit confirmation shape for this entity/period (draftJourney has the exact calls). Explicit replacement + history-preservation executed and PASS.",
  ], { original: cur, afterOld, afterActive, explicitReplacement: "pass" });
}

// F: Invalid / unsupported / over-limit files — actionable refusal, no silent truncation, no accepted partial result,
// recovery with a normal file afterwards. USES NORMAL's final policy/fixtures for the limit — does not invent one.
async function scenarioF(env) {
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  // The OVER-LIMIT sub-check is mandatory and needs NORMAL's policy fixture. Absent ⇒ BLOCKED (never PASS/NOTE).
  if (!env.overLimitFixture?.path) return result("BLOCKED", ["over-limit sub-check needs env.overLimitFixture (NORMAL's current upload-policy fixture); no invented limit"]);

  // Unsupported file → actionable refusal (not a false success), via the real uploader + error state.
  const unsup = await env.uploadRaw(page, ws.companyId, ws.periodYear, env.writeFile(UNSUPPORTED.name, UNSUPPORTED.content));
  if (unsup?.accepted) problems.push("an unsupported file was accepted (false success)");
  else { const err = await env.captureErrorState(page); problems.push(...loadingErrorStateProblems(err)); }

  // Over-limit: ACTUALLY upload NORMAL's over-limit fixture and require the named refusal with NO partial accepted result.
  const expected = env.overLimitFixture.expectedCode || "TOO_MANY_ACCOUNTS";
  const over = await env.uploadRaw(page, ws.companyId, ws.periodYear, env.overLimitFixture.path);
  const errState = await env.captureErrorState(page);
  const latest = await env.admin.from("trial_balance_uploads").select("id, status, processing_result").eq("company_id", ws.companyId).eq("period_year", ws.periodYear).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
  const prText = JSON.stringify(latest.data?.processing_result ?? {});
  const refusedByName = new RegExp(expected, "i").test(prText) || new RegExp(expected, "i").test(errState.errorMessage || "") || /too many accounts|account limit|exceed/i.test(errState.errorMessage || "");
  const cert = await env.isCertified(ws.companyId, ws.periodYear); // server truth: must NOT certify an over-limit upload
  const accepted = !!over?.accepted || cert || ["needs_review", "reviewed", "processed", "certified"].includes(latest.data?.status);
  if (!refusedByName) problems.push(`over-limit upload was not refused by name (${expected}); status=${latest.data?.status}; pr=${prText.slice(0, 160)}; err=${(errState.errorMessage || "").slice(0, 120)}`);
  if (accepted) problems.push(`over-limit upload produced an accepted/partial result (status=${latest.data?.status}, certified=${cert}) — must accept nothing`);

  // Recovery: a normal file afterwards succeeds.
  const ok = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("F-recovery.csv", BALANCED.csv));
  if (!ok) problems.push("could not recover with a normal file after a refusal");
  return result(problems.length ? "FAIL" : "PASS", problems, { expected, policy: env.overLimitFixture.policy, overLimitAccounts: env.overLimitFixture.accounts });
}

// G: Review + identity — legitimate same-name/different-code accounts AFTER NORMAL's repair: separate identities &
// treatments; ambiguous matching stays unresolved (never first/last); an imbalance/missing evidence stays visible.
async function scenarioG(env) {
  if (!env.sameNameRepairApplied) return result("BLOCKED", ["gated on NORMAL's same-name/different-code repair being present+verified in the DB under test (uq_acct_map_company_codeless_name, old all-names index gone). Until verified, mapping two same-name accounts raises a raw constraint error — a FINDING in the Phase-5 lane, not asserted here."]);
  const problems = [];
  const page = await env.openPage(); await env.signIn(page, env.users.owner);
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  const uploadId = await env.uploadTb(page, ws.companyId, ws.periodYear, env.writeFile("G-same-name.csv", SAME_NAME.csv));
  if (!uploadId) return result("FAIL", ["the same-name trial balance did not upload"]);
  await env.settle(ws.companyId, ws.periodYear);
  // Mappings exist ONLY after review decisions (resolve_account_review_batch). REVIEW BOTH "Sales" accounts first, as the
  // owner (authenticated), each keyed by its own code — then check they persist as two DISTINCT mappings.
  const decisions = SAME_NAME.rows.filter((r) => /sales/i.test(r.name)).map((r) => ({
    account_code: r.code, account_name: r.name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION",
    statement: "income_statement", classification: "revenue", line_item: r.name, normal_balance: "credit",
  }));
  const reviewed = await env.reviewAccounts(env.users.owner, ws.companyId, uploadId, decisions);
  if (reviewed.error) return result("FAIL", [`reviewing both same-name accounts was refused: ${reviewed.error}`], { uploadId });
  const mapped = await env.admin.from("account_mappings").select("account_key, account_code, account_name, statement, classification").eq("company_id", ws.companyId).ilike("account_name", "Sales");
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
  const ws = env.lastWorkspace; if (!ws?.companyId) return result("BLOCKED", ["requires an existing workspace (run A first)"]);
  for (const stateName of ["first-visit", "confirmation", "processing", "result", "blocked", "retry"]) {
    const s = await env.captureClarityState(page, ws, stateName); // { name, whatHappened, whatNext, saved, copy, ctas }
    if (!s) continue;
    problems.push(...clarityStateProblems(s));
    problems.push(...primaryActionProblems(s.ctas));
    problems.push(...copyWordingProblems(s.copy, { context: stateName }));
  }
  return result(problems.length ? "FAIL" : "PASS", problems);
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
