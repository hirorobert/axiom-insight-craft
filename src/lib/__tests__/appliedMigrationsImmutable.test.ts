/**
 * Already-applied migrations are never edited (forward-only). 20260925100000–20260925150000 are applied in production;
 * each must stay byte-identical to the reviewed PR #34 version (reviewed head c2c1e8e). Any further change goes into a
 * NEW forward migration (e.g. 20260926160000_trial_balance_processing_entitlement_wall.sql).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = path.join(__dirname, "../../../supabase/migrations");
const APPLIED: Record<string, string> = {
  "20260925100000_global_capabilities_entitlements_pricing.sql": "e864eacbd0a111463d03da7df170774f22683716a2a10cc99f5c569c42951297",
  "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql": "e2acec5154d7f9f71011a88033fa18fdfb6130089eb1845c42efe44c96fca8fa",
  "20260925120000_reporting_pack_issuance_binding.sql": "2be7dc36c3fbf9432b8eb606f35c2139bd834301ad7416694adc3a163b2550d3",
  "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql": "f0fb1b2b665a7562f761a2493faebc7f452f1df38844f5bdd49f8f45c6ef2fa1",
  "20260925140000_workspace_capability_authorization.sql": "c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a",
  "20260925150000_can_user_act_on_workspace_minimum_grant.sql": "3011c3414d7a0b5811015218ae35f8721663eaa32ddd7e5233f269fcb91daacb",
};

describe("applied migrations are immutable", () => {
  it.each(Object.entries(APPLIED))("%s is byte-identical to the reviewed PR #34 version", (file, sha) => {
    const bytes = fs.readFileSync(path.join(MIGRATIONS, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
  });
  it("the processing entitlement wall is a NEW forward migration after every applied one, and not inside any of them", () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const forward = "20260926160000_trial_balance_processing_entitlement_wall.sql";
    expect(files).toContain(forward);
    expect(files.indexOf(forward)).toBeGreaterThan(files.indexOf("20260925150000_can_user_act_on_workspace_minimum_grant.sql"));
    for (const f of Object.keys(APPLIED)) expect(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")).not.toMatch(/tbu_processing_wall|authorize_trial_balance_processing/);
  });
});
