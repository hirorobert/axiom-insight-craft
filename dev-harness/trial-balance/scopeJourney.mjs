// NON-PRODUCTION browser journey for the Trial balance review scope correction. Imported into the harness page
// (`const { run } = await import("/dev-harness/trial-balance/scopeJourney.mjs"); await run()`), it drives the REAL Prepare
// page (PrepareWorkspace on the in-browser synthetic backend) through its own controls and reads only what the page shows,
// plus the synthetic tables to prove reconciliation records are kept. Returns named pass/fail checks with the observed
// detail. Never part of the production bundle (outside src/; the app build's only input is index.html).
//
// Journey: failed validation → replacement with outstanding classifications → an existing INCOMPLETE reconciliation is
// opened on that upload → classifications confirmed through the page → "Reviewed trial balance"; then every
// reconciliation state × owner / Prepare-only viewer; then a Prepare-only replacement with a new unconfirmed account while
// a reconciliation is open.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (id) => document.querySelector(`[data-testid="${id}"]`)?.innerText?.replace(/\s+/g, " ").trim() ?? null;
const status = () => q("trial-balance-status") ?? "";
const tables = () => window.__tb.tables;
async function waitFor(pred, ms = 25000) { for (let t = 0; t < ms; t += 250) { if (pred()) return true; await sleep(250); } return false; }
const settled = () => !/validating|processing/.test(String(tables().trial_balance_uploads[0]?.status));

function observe() {
  const body = document.body.innerText;
  const l5 = [...document.querySelectorAll('[data-testid="trial-balance-checks"] li')].map((li) => li.innerText.replace(/\s+/g, " ").trim()).find((t) => /Bank and mobile-money evidence/.test(t)) ?? null;
  return {
    task: q("trial-balance-current-task"), status: q("trial-balance-status"), primary: q("trial-balance-primary-action"),
    evidencePanel: !!document.querySelector('#evidence-verification, [data-testid="evidence-verification"], [data-testid="evidence-by-reconcile"]'),
    evidenceUi: /Evidence verification|Verify against bank|Upload evidence|bank statements, mobile-money/i.test(body),
    forbiddenWords: body.match(/\breconciled\b|\baudited\b|\bassured\b|signed off/gi) ?? [],
    reviewWorkbench: !!document.querySelector('[data-testid="account-review-workbench"]'),
    l5,
  };
}
const snapshotRecords = () => JSON.stringify([tables().safisha_reconciliations, tables().safisha_exceptions]);

async function pickFile(name, csv) {
  const input = document.querySelector('input[type="file"]');
  const dt = new DataTransfer();
  dt.items.add(new File([csv], name, { type: "text/csv" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
async function firstUpload(name, csv) {
  await pickFile(name, csv);
  await sleep(400);
  document.querySelector('[data-testid="trial-balance-upload-primary"]')?.click();
  await waitFor(() => tables().trial_balance_uploads[0]?.file_name === name && settled() && /BLOCKED|NEEDS REVIEW|REVIEWED/i.test(status()));
  await sleep(600);
}
async function replace(name, csv) {
  await pickFile(name, csv);
  await waitFor(() => tables().trial_balance_uploads[0]?.file_name === name && settled() && /BLOCKED|NEEDS REVIEW|REVIEWED/i.test(status()));
  await sleep(1200);
}
const click = (id) => document.querySelector(`[data-testid="${id}"]`).click();

const UNBALANCED = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n4000,Sales revenue,,1400.00\n";
const BALANCED = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n2000,Trade payables,,600.00\n4000,Sales revenue,,1400.00\n";
const NEW_ACCOUNT = "Account Code,Account Name,Debit,Credit\n1000,Cash at bank,1500.00,\n1100,Trade receivables,500.00,\n1200,Prepaid rent,100.00,\n2000,Trade payables,,700.00\n4000,Sales revenue,,1400.00\n";
const RECON_STATES = ["none", "running", "open", "rejected", "partial", "escalated", "complete"];

export async function run() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const clean = (o) => !o.evidencePanel && !o.evidenceUi && o.forbiddenWords.length === 0;
  await waitFor(() => !!document.querySelector('[data-testid="harness-bar"]'), 30000);

  // 1. Failed validation.
  await firstUpload("unbalanced.csv", UNBALANCED);
  let o = observe();
  check("failed validation: Blocked, step 1 of 3, replace action, never Reviewed, no evidence matching", /BLOCKED/i.test(o.status) && /^Step 1 of 3/.test(o.task) && o.primary === "Replace with corrected Trial Balance" && clean(o), o);
  check("unevaluated supporting evidence reads 'Not checked yet · Not required for a reviewed trial balance' (never 'Passed')", o.l5 === "Bank and mobile-money evidence Not checked yet Not required for a reviewed trial balance.", o.l5);

  // 2. Outstanding classifications (replacement).
  await replace("balanced.csv", BALANCED);
  o = observe();
  check("outstanding classifications: Needs review, step 2 of 3, review workbench open, no evidence matching", /NEEDS REVIEW/i.test(o.status) && /^Step 2 of 3/.test(o.task) && o.reviewWorkbench && clean(o), o);

  // 3. An existing incomplete reconciliation on this upload (open session, pending exception) blocks nothing.
  click("recon-open");
  await sleep(1500);
  const records = snapshotRecords();
  o = observe();
  check("with an open reconciliation session: classification review stays reachable (step 2, workbench open)", /^Step 2 of 3/.test(o.task) && o.reviewWorkbench && clean(o), o);
  const save = [...document.querySelectorAll("button")].find((b) => /Save & reprocess/.test(b.innerText));
  save?.click();
  await waitFor(() => /REVIEWED/i.test(status()) && settled());
  await sleep(1200);
  o = observe();
  check("classifications confirmed with the session still open: Reviewed trial balance, step 3 of 3, no action, not an approval",
    /REVIEWED/i.test(o.status) && o.task === "Step 3 of 3 · Trial balance ready for statement preparation. Reviewed trial balance: checks passed and every account classification confirmed. This is not an approval of financial statements." && o.primary === null && clean(o), o);
  check("the reconciliation record and its pending exception are preserved", snapshotRecords() === records && tables().safisha_exceptions[0]?.reviewer_action === "pending", tables().safisha_reconciliations);

  // 4. Every reconciliation state, for the owner and for a Prepare-only viewer.
  const matrix = {};
  for (const viewer of ["owner", "prepare"]) {
    click(`viewer-${viewer}`);
    await sleep(1000);
    for (const k of RECON_STATES) {
      click(`recon-${k}`);
      await sleep(1300);
      const x = observe();
      matrix[`${viewer}/${k}`] = /REVIEWED/i.test(x.status) && /^Step 3 of 3/.test(x.task) && x.primary === null && clean(x);
    }
  }
  check("every reconciliation state × owner / Prepare-only: Reviewed trial balance, no evidence matching, never reconciled", Object.values(matrix).every(Boolean), matrix);

  // 5. Prepare-only replacement with a new, unconfirmed account while a reconciliation is open.
  click("viewer-owner");
  click("recon-open");
  await sleep(1000);
  const before = snapshotRecords();
  click("viewer-prepare");
  await sleep(1000);
  await replace("with-new-account.csv", NEW_ACCOUNT);
  o = observe();
  check("Prepare-only replacement with an unconfirmed account: Needs review, step 2 of 3, no account-review workbench for them, no evidence matching",
    /NEEDS REVIEW/i.test(o.status) && /^Step 2 of 3/.test(o.task) && !o.reviewWorkbench && clean(o), o);
  check("replacing the trial balance keeps every reconciliation record", snapshotRecords() === before && tables().trial_balance_uploads.some((u) => u.lifecycle_state === "superseded"), tables().trial_balance_uploads.map((u) => `${u.file_name}:${u.lifecycle_state}`));
  click("viewer-owner");

  return { passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
}
