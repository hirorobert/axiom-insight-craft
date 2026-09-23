/**
 * processingActor.test.ts: who may validate a workspace's trial balance (supabase/functions/_shared/processingActor.ts),
 * and the static contract of 20260923120000 that backs it. The real-PostgreSQL proof
 * (scripts/db-proof/uploadLifecycle.mjs) and the hosted proof (scripts/upload_lifecycle_staging.mjs) run it for real.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveProcessingActor, toProcessingActor } from "../../../supabase/functions/_shared/processingActor";

const U = "user-1";
const C = "co-1";
const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260923120000_workspace_user_engine_actor_and_source_sweeper.sql"), "utf8");
const ptb = fs.readFileSync(path.join(process.cwd(), "supabase/functions/process-trial-balance/index.ts"), "utf8");

describe("toProcessingActor", () => {
  it("an accepted firm member keeps the firm-member actor (unchanged boundary)", () => {
    expect(toProcessingActor({ actor_type: "user", firm_member_id: "fm-1", firm_member_role: "preparer", authority_basis: "firm_membership" }, U, C))
      .toEqual({ actorType: "user", firmMemberId: "fm-1", userId: U, companyId: C, role: "preparer", authorityBasis: "firm_membership" });
  });
  it("the owner or a grant holder with NO firm membership is a workspace_user actor", () => {
    expect(toProcessingActor({ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner", authority_capability: null }, U, C))
      .toEqual({ actorType: "workspace_user", userId: U, companyId: C, authorityBasis: "workspace_owner", authorityCapability: null });
    expect(toProcessingActor({ actor_type: "workspace_user", firm_member_id: null, authority_basis: "explicit_capability", authority_capability: "manage_source_files" }, U, C))
      .toMatchObject({ actorType: "workspace_user", authorityBasis: "explicit_capability", authorityCapability: "manage_source_files" });
  });
  it("anything else fails closed", () => {
    for (const row of [null, undefined, {}, { actor_type: "system" }, { actor_type: "user", firm_member_id: null, authority_basis: "firm_membership" },
      { actor_type: "user", firm_member_id: "fm", authority_basis: "firm_membership" },
      { actor_type: "workspace_user", firm_member_id: "fm", authority_basis: "workspace_owner" },
      { actor_type: "workspace_user", firm_member_id: null, authority_basis: "firm_membership" }]) {
      expect(toProcessingActor(row as never, U, C)).toBeNull();
    }
    expect(toProcessingActor({ actor_type: "workspace_user", authority_basis: "workspace_owner" }, "", C)).toBeNull();
  });
});

describe("resolveProcessingActor", () => {
  it("asks the database with the JWT user and the upload's workspace only", async () => {
    const rpc = vi.fn(async () => ({ data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null }));
    await expect(resolveProcessingActor(rpc, U, C)).resolves.toMatchObject({ actorType: "workspace_user" });
    expect(rpc).toHaveBeenCalledWith("tbu_resolve_processing_actor", { p_user_id: U, p_company_id: C });
  });
  it("no row → refused; a database error throws (never a silent allow)", async () => {
    await expect(resolveProcessingActor(async () => ({ data: [], error: null }), U, C)).resolves.toBeNull();
    await expect(resolveProcessingActor(async () => ({ data: null, error: { message: "x" } }), U, C)).rejects.toThrow();
  });
});

describe("process-trial-balance uses user-based authority", () => {
  it("resolves the actor through tbu_resolve_processing_actor, never a firm_members-only check", () => {
    expect(ptb).toMatch(/import \{ resolveProcessingActor, type ProcessingActor \} from "\.\.\/_shared\/processingActor\.ts"/);
    expect(ptb).not.toMatch(/resolveFirmMemberActor/);
    expect(ptb).toMatch(/actorType: resolvedActor\.actorType/);
  });
});

describe("20260923120000 static contract", () => {
  it("a workspace_user ledger row has a user and never a firm membership; 'user' and 'system' rows are unchanged", () => {
    for (const t of ["er", "ik"]) {
      expect(sql).toContain(`ADD CONSTRAINT chk_${t}_actor_type CHECK (actor_type IN ('user', 'workspace_user', 'system'))`);
    }
    expect(sql).toMatch(/actor_type = 'workspace_user' AND actor_user_id {2}IS NOT NULL AND firm_member_id IS NULL/);
    expect(sql).toMatch(/actor_type = 'user' {11}AND firm_member_id IS NOT NULL AND actor_user_id IS NULL/);
    expect(sql).toContain("UNIQUE NULLS NOT DISTINCT (company_id, firm_member_id, actor_user_id, function_name, client_request_id)");
    expect(sql).toMatch(/CREATE TRIGGER trg_er_actor_user_immutable BEFORE UPDATE ON public\.engine_runs/);
    expect(sql).toMatch(/CREATE TRIGGER trg_ik_actor_user_immutable BEFORE UPDATE ON public\.idempotency_keys/);
  });
  it("the resolver never creates a membership and is service_role only", () => {
    const body = sql.slice(sql.indexOf("FUNCTION public.tbu_resolve_processing_actor"), sql.indexOf("-- ── A3."));
    expect(body).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.tbu_resolve_processing_actor(uuid, uuid) TO service_role;");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.tbu_resolve_processing_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;");
  });
  it("every sweeper function is service_role only; no client role may run any of it", () => {
    for (const f of ["tbu_sweeper_candidates(integer)", "tbu_sweeper_complete(text, uuid)", "tbu_configure_source_sweeper(text)",
      "tbu_mint_source_sweeper_ticket()", "tbu_redeem_source_sweeper_ticket(text)", "tbu_run_source_sweeper()"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${f} FROM PUBLIC, anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO service_role;`);
      expect(sql).not.toContain(`GRANT EXECUTE ON FUNCTION public.${f} TO authenticated`);
    }
    expect(sql).toContain("REVOKE ALL ON public.tbu_source_sweeper_tickets FROM PUBLIC, anon, authenticated, service_role;");
    expect(sql).toContain("REVOKE ALL ON public.tbu_source_sweeper_config FROM PUBLIC, anon, authenticated, service_role;");
  });
  it("purge eligibility is exactly the undo window restore uses; only the hash of a ticket is stored", () => {
    expect(sql).toMatch(/o\.state = 'completed' AND o\.completed_at <= now\(\) - public\.tbu_undo_window\(\)/);
    expect(sql).toMatch(/v_op\.completed_at > now\(\) - public\.tbu_undo_window\(\) THEN RETURN 'not_eligible'/);
    expect(sql).toMatch(/encode\(sha256\(convert_to\(v_token, 'UTF8'\)\), 'hex'\)/);
  });
});
