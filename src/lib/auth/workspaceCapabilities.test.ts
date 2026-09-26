/**
 * Workspace capabilities in the client (20260925140000): the UI reads the server's capability answer, never a job title.
 * The database authority itself (has_workspace_capability / workspace_capability_allowed in every policy and write
 * function) is proven on real PostgreSQL in scripts/db-proof/planCapabilities.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SIGN_OFF_TIER_CAPABILITY, canExercise, describeInvitationCapabilities, parseMyWorkspaceCapabilities } from "./workspaceCapabilities";

const ROOT = path.join(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("parseMyWorkspaceCapabilities — fail closed", () => {
  it("parses the server answer; only a capability that is both held and allowed can be exercised", () => {
    const s = parseMyWorkspaceCapabilities({
      access: true, capabilities: ["prepare_close", "issue_reporting_pack", "made_up"], allowed: ["prepare_close", "review_close"],
      has_current_plan: true, manage_billing: false,
    })!;
    expect(s.held).toEqual(["prepare_close", "issue_reporting_pack"]);
    expect(s.allowed).toEqual(["prepare_close"]);
    expect(canExercise(s, "prepare_close")).toBe(true);
    expect(canExercise(s, "review_close")).toBe(false);
    expect(canExercise(s, "issue_reporting_pack")).toBe(false);
  });
  it("no plan: capabilities are held but not exercisable (read-only)", () => {
    const s = parseMyWorkspaceCapabilities({ access: true, capabilities: ["prepare_close", "manage_members"], allowed: ["manage_members"], has_current_plan: false, manage_billing: true })!;
    expect(canExercise(s, "prepare_close")).toBe(false);
    expect(canExercise(s, "manage_members")).toBe(true);
    expect(s.hasCurrentPlan).toBe(false);
  });
  it("anything malformed, no access or missing is not allowed", () => {
    for (const raw of [null, undefined, "x", {}, { access: "true", capabilities: [], allowed: [] }, { access: true, capabilities: "prepare_close", allowed: [] }]) {
      expect(parseMyWorkspaceCapabilities(raw)).toBeNull();
    }
    expect(canExercise(null, "prepare_close")).toBe(false);
    const none = parseMyWorkspaceCapabilities({ access: false, capabilities: ["prepare_close"], allowed: ["prepare_close"] })!;
    expect(canExercise(none, "prepare_close")).toBe(false);
  });
  it("sign-off tiers map to capabilities, not titles", () => {
    expect(SIGN_OFF_TIER_CAPABILITY).toEqual({ preparer: "prepare_close", reviewer: "review_close", approver: "approve_certification" });
  });
});

describe("no job title decides anything in the client or at the Edge", () => {
  const files = [
    "src/components/PeriodCloseManager.tsx",
    "src/jurisdiction-packs/tz/KingaTaxPanel.tsx",
    "src/hooks/useEngagementMandate.ts",
    "src/hooks/useFinancialStatementsWorkspace.ts",
    "supabase/functions/invite-firm-member/index.ts",
  ];
  it.each(files)("%s authorizes by capability, never by comparing a title", (f) => {
    const src = read(f);
    expect(src).not.toMatch(/\[\s*["'](owner|partner|manager|preparer)["'][^\]]*\]\.includes\(/);
    expect(src).not.toMatch(/role\s*(===|!==)\s*["'](owner|partner|manager|preparer|viewer)["']/);
    expect(src).not.toMatch(/SENIOR_ROLES|ROLE_WEIGHT|TIER_MIN_WEIGHT/);
  });
  it("the invitation function asks for manage_members before anything else happens", () => {
    const src = read("supabase/functions/invite-firm-member/index.ts");
    const cap = src.indexOf('hasWorkspaceCapability((fn, args) => admin.rpc(fn, args), company_id, callerUser.id, "manage_members")');
    expect(cap).toBeGreaterThan(-1);
    expect(cap).toBeLessThan(src.indexOf("await admin.auth.admin.listUsers("));
    expect(cap).toBeLessThan(src.indexOf("admin.rpc(\"reserve_workspace_invitation\""));
  });
  it("the sign-off and scope controls read the server's capability answer", () => {
    expect(read("src/components/PeriodCloseManager.tsx")).toMatch(/get_my_workspace_capabilities/);
    expect(read("src/jurisdiction-packs/tz/KingaTaxPanel.tsx")).toMatch(/useWorkspaceCapabilities\(companyId\)/);
    expect(read("src/hooks/useEngagementMandate.ts")).toMatch(/canAmend: canExercise\(capabilities, "review_close"\)/);
  });
});

describe("an invitation shows exactly the capabilities it carries", () => {
  it("names the capabilities held on acceptance and, on a re-invitation, the withdrawn ones the title does not restore", () => {
    expect(describeInvitationCapabilities({ capabilities: ["issue_reporting_pack", "prepare_close"], withheld: ["approve_certification", "review_close"] }))
      .toBe("On acceptance: Issue Reporting Pack outputs, Prepare the close. Not included (withdrawn earlier; grant explicitly if intended): Approve certification, Review the close.");
    expect(describeInvitationCapabilities({ capabilities: [], withheld: [] })).toBe("On acceptance: no capabilities (view only).");
    expect(describeInvitationCapabilities({ capabilities: ["owner", "manage_billing", 7], role: "partner" })).toBe("On acceptance: no capabilities (view only).");
    expect(describeInvitationCapabilities(null)).toBe("On acceptance: no capabilities (view only).");
  });
  it("the invitation function returns the database's summary and the panel shows it", () => {
    const fn = fs.readFileSync(path.join(__dirname, "../../../supabase/functions/invite-firm-member/index.ts"), "utf8");
    expect(fn).toContain('admin.rpc("invitation_capability_summary", { p_company_id: company_id, p_user: invitedUserId })');
    expect(fn).toMatch(/capabilities: carried\.capabilities \?\? \[\],\s*withheld: carried\.withheld \?\? \[\]/);
    const panel = fs.readFileSync(path.join(__dirname, "../../components/FirmManagementPanel.tsx"), "utf8");
    expect(panel).toContain("{ description: describeInvitationCapabilities(data) }");
  });
});
