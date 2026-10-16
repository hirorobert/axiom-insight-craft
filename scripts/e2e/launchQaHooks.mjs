// Launch-acceptance QA hooks (NORMAL, evidence branch #144 only; never merged). Loaded by BLACK's runner through
// LAUNCH_QA_HOOKS. Supplies only what the existing isolated facilities ground today; anything not grounded stays undefined
// so its scenario reports BLOCKED with BLACK's precise reason (never a fabricated pass):
//   F  overLimitFixture — a file one account over the CURRENT upload policy (supabase/functions/_shared/uploadPolicy.ts),
//      with the refusal code the server gives for it;
//   G  sameNameRepairApplied — true only when the CI step VERIFIED, in the local database under test, that repair B's index
//      uq_acct_map_company_codeless_name exists and the old all-names index does not (LAUNCH_QA_SAME_NAME_REPAIR=verified);
//   D  mockPurchase — NOT supplied: the loopback mock providers run only inside the payment journey's own process with its
//      generated function configuration; sharing that setup is new journey code (a scope decision), so D stays BLOCKED;
//   E  replaceUpload / staleReplace — NOT supplied: the replacement controls need UI-driven steps that do not exist in this
//      harness yet, so E stays BLOCKED.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The runner runs under Node, which cannot import the TypeScript policy module: its values are read from its source.
const POLICY_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../supabase/functions/_shared/uploadPolicy.ts"), "utf8");
const num = (key) => { const m = new RegExp(`\\b${key}:\\s*([0-9_]+)`).exec(POLICY_SRC); if (!m) throw new Error(`upload policy ${key} not found`); return Number(m[1].replace(/_/g, "")); };
const TB_UPLOAD_POLICY = { maxAccounts: num("maxAccounts"), version: /version:\s*"([^"]+)"/.exec(POLICY_SRC)?.[1] ?? "unknown" };

export default function hooks(env) {
  const n = TB_UPLOAD_POLICY.maxAccounts + 1;
  const rows = ["Account code,Account name,Debit,Credit"];
  let total = 0;
  for (let i = 0; i < n - 1; i++) { rows.push(`${100000 + i},Invented account ${i},1.00,0.00`); total += 1; }
  rows.push(`999999,Invented equity,0.00,${total.toFixed(2)}`);
  return {
    overLimitFixture: { path: env.writeFile("F-over-account-limit.csv", rows.join("\n") + "\n"), accounts: n, expectedCode: "TOO_MANY_ACCOUNTS", policy: TB_UPLOAD_POLICY.version },
    sameNameRepairApplied: process.env.LAUNCH_QA_SAME_NAME_REPAIR === "verified",
  };
}
