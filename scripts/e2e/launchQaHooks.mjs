// Launch-acceptance QA hooks (NORMAL, CI/integration; evidence branch #144 only; never merged). Loaded by BLACK's runner
// through LAUNCH_QA_HOOKS (the coordinated seam). Supplies the existing isolated FACILITIES; the browser journeys that use
// them are BLACK's (scenarios.mjs). Anything not supplied stays undefined, so its scenario reports BLOCKED.
//   F  overLimitFixture — a file one account over the CURRENT upload policy (supabase/functions/_shared/uploadPolicy.ts),
//      with the refusal code the server gives for it;
//   G  sameNameRepairApplied — true only when the CI step VERIFIED, in the local database under test, that repair B's index
//      uq_acct_map_company_codeless_name exists and the old all-names index does not (LAUNCH_QA_SAME_NAME_REPAIR=verified);
//   D  payments facility (LAUNCH_QA_PAYMENTS=1): the loopback mock providers and the payment functions served with
//      generated SANDBOX configuration (launchQaPayments.mjs). env.mockPurchase(page, user) is a sandbox card purchase
//      through the real checkout and the mock hosted page — by the product's rules it NEVER grants access;
//      env.payments.activateByAgreement(user) is the authorised path (manual activation); env.entitlementSnapshot(user)
//      is the server's statement of access. env.purchaseAuthorised stays false: a sandbox payment authorises nothing.
//   E  replacement: no facility is needed beyond the running stack — the replacement journey (FirstUpload's "Replace"
//      path / the workspace's replacement through retire_trial_balance_upload) is BLACK's browser journey.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The runner runs under Node, which cannot import the TypeScript policy module: its values are read from its source.
const POLICY_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/functions/_shared/uploadPolicy.ts"), "utf8");
const num = (key) => { const m = new RegExp(`\\b${key}:\\s*([0-9_]+)`).exec(POLICY_SRC); if (!m) throw new Error(`upload policy ${key} not found`); return Number(m[1].replace(/_/g, "")); };
const TB_UPLOAD_POLICY = { maxAccounts: num("maxAccounts"), version: /version:\s*"([^"]+)"/.exec(POLICY_SRC)?.[1] ?? "unknown" };

export default async function hooks(env) {
  const n = TB_UPLOAD_POLICY.maxAccounts + 1;
  const rows = ["Account code,Account name,Debit,Credit"];
  let total = 0;
  for (let i = 0; i < n - 1; i++) { rows.push(`${100000 + i},Invented account ${i},1.00,0.00`); total += 1; }
  rows.push(`999999,Invented equity,0.00,${total.toFixed(2)}`);
  const out = {
    overLimitFixture: { path: env.writeFile("F-over-account-limit.csv", rows.join("\n") + "\n"), accounts: n, expectedCode: "TOO_MANY_ACCOUNTS", policy: TB_UPLOAD_POLICY.version },
    sameNameRepairApplied: process.env.LAUNCH_QA_SAME_NAME_REPAIR === "verified",
  };
  if (process.env.LAUNCH_QA_PAYMENTS === "1") {
    const { startPaymentsFacility } = await import("./launchQaPayments.mjs");
    const payments = await startPaymentsFacility({ apiUrl: env.apiUrl, anonKey: env.anonKey, admin: env.admin, appOrigin: env.APP, outDir: env.outDir });
    Object.assign(out, {
      payments,
      mockPurchase: (page, user = env.users.preparer) => payments.sandboxCardPurchase(page, user),
      entitlementSnapshot: (user = env.users.preparer) => payments.entitlementSnapshot(user),
      purchaseAuthorised: false,
    });
  }
  return out;
}
