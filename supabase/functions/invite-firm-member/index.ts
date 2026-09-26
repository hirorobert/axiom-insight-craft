// ============================================================
// invite-firm-member — Firm Management (Roadmap Item 8)
//
// Invites a user to a company's firm_members roster.
//
// Flow:
//   1. Validate the caller holds manage_members in this workspace (a capability, never a job title)
//   2. Named-user seat pre-check (seat_check_for_invitation)
//   3. An EXISTING account that is not yet a member is linked directly as an accepted member (no email:
//      inviteUserByEmail rejects existing accounts) — the database seat wall still decides. Otherwise the
//      invitee's own account is created UNCONFIRMED (no email yet)
//   4. Reserve the seat: reserve_workspace_invitation (a pending firm_members row with an expiry;
//      an existing pending / expired / cancelled invitation is refreshed or reissued, never duplicated)
//   5. Send the invitation email; on failure release the reservation (release_workspace_invitation)
//   6. Return { ok: true, userId, alreadyMember: false, reservation }
//
// Callers: FirmManagementPanel → supabase.functions.invoke()
//
// Named-user seats (20260925100000): every plan includes one named user; Practice and Firm may add purchased
// seats. Order (20260925110000): seat pre-check -> the person's own account created UNCONFIRMED (nothing sent) ->
// the seat RESERVED atomically (reserve_workspace_invitation; the database seat wall decides) -> only then the email.
// An email failure releases the reservation (release_workspace_invitation). A reservation expires on its own
// (invitation_reservation_ttl) and the account holder can cancel it. Refusals are HTTP 402 with a structured body
// { status, capability: "NAMED_USER_SEATS" }. Each invited person gets their own account; nothing is shared.
//
// Security:
//   • Admin client (service role) required for auth.admin.inviteUserByEmail
//   • RLS on firm_members enforced by trigger (owner-only writes for
//     non-owner roles are enforced by firm_members policies)
//   • Caller's JWT is checked: must hold manage_members in the target workspace (has_workspace_capability)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isSeatWallError, requireSeatForInvitation, seatRefusal } from "../_shared/paidAction.ts";
import { hasWorkspaceCapability } from "../_shared/namedUserAccess.ts";

// reserve_workspace_invitation outcome -> the structured seat refusal the client reads.
const RESERVATION_REFUSALS: Record<string, string> = {
  seat_limit_reached: "SEAT_LIMIT_REACHED",
  capacity_undetermined: "SEAT_CAPACITY_UNDETERMINED",
  named_user_suspended: "NAMED_USER_SUSPENDED",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── Clients ──────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Caller client — respects RLS, identifies the calling user
    const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Admin client — needed for auth.admin.inviteUserByEmail
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── Parse body ────────────────────────────────────────────
    const { email, company_id, role } = await req.json() as {
      email: string;
      company_id: string;
      role: "owner" | "partner" | "preparer" | "viewer";
    };

    if (!email || !company_id || !role) {
      return new Response(
        JSON.stringify({ error: "email, company_id, and role are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // The owner title is assigned only when a company is created; an invitation can never create another owner.
    const allowedRoles = ["partner", "preparer", "viewer"];
    if (!allowedRoles.includes(role)) {
      return new Response(
        JSON.stringify({ error: `Invalid role. Must be one of: ${allowedRoles.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Identify caller ───────────────────────────────────────
    const { data: { user: callerUser }, error: authErr } = await caller.auth.getUser();
    if (authErr || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Verify the caller may manage this workspace's members (manage_members, never a title) ──
    if (!(await hasWorkspaceCapability((fn, args) => admin.rpc(fn, args), company_id, callerUser.id, "manage_members"))) {
      return new Response(
        JSON.stringify({ status: "capability_required", capability: "manage_members", error: "You don't have permission to manage the members of this workspace." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Check if already a member ─────────────────────────────
    // Look up the user by email first
    const { data: existingUsers } = await admin.auth.admin.listUsers();
    const existingUser = (existingUsers?.users ?? []).find((u) => u.email === email);

    if (existingUser) {
      // Check if already a firm_member for this company
      const { data: existingMember } = await admin
        .from("firm_members")
        .select("id, role, accepted_at")
        .eq("company_id", company_id)
        .eq("user_id", existingUser.id)
        .maybeSingle();

      // A pending (possibly expired or cancelled) invitation is REISSUED below; only an accepted member is a conflict.
      if (existingMember?.accepted_at) {
        return new Response(
          JSON.stringify({
            ok: false,
            alreadyMember: true,
            currentRole: existingMember.role,
            message: `${email} is already a member of this company with role '${existingMember.role}'.`,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Named-user seat pre-check for the existing account (a person already counted needs no new seat).
      const noSeatExisting = await requireSeatForInvitation((fn, args) => admin.rpc(fn, args), company_id, existingUser.id, corsHeaders);
      if (noSeatExisting) return noSeatExisting;

      if (!existingMember) {
        // Existing account, not yet a member of this company: link them
        // directly. inviteUserByEmail would reject with email_exists (422) → 500.
        // The database seat wall still decides (an accepted insert must fit the allowance, whoever writes it).
        const { error: linkErr } = await admin.from("firm_members").insert({
          company_id,
          user_id:       existingUser.id,
          role,
          invited_by:    callerUser.id,
          invited_email: email,
          accepted_at:   new Date().toISOString(),
        });

        if (linkErr && isSeatWallError(linkErr)) {
          // A concurrent change took the last seat after the pre-check: the same structured refusal.
          const hint = (linkErr as { hint?: string }).hint;
          const refusal = seatRefusal({ allowed: false, code: hint === "SUSPENDED" ? "NAMED_USER_SUSPENDED" : hint === "UNDETERMINED" ? "SEAT_CAPACITY_UNDETERMINED" : "SEAT_LIMIT_REACHED" })!;
          return new Response(JSON.stringify(refusal.body), { status: refusal.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        if (linkErr) {
          console.error("firm_members link error:", linkErr);
          return new Response(
            JSON.stringify({ error: `Could not add existing user to this company: ${linkErr.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            userId: existingUser.id,
            alreadyMember: false,
            message: `${email} already has an account and has been added to this company.`,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // An existing account with a pending (possibly expired or cancelled) invitation: reissued below, never duplicated.
    }

    // ── Named-user seat pre-check (before any account is created or email sent) ──
    const noSeat = await requireSeatForInvitation((fn, args) => admin.rpc(fn, args), company_id, existingUser?.id ?? null, corsHeaders);
    if (noSeat) return noSeat;

    // ── The person's own account (created unconfirmed; nothing is sent yet) ──
    // Each invited person gets an individual account; a seat is reserved for that account, never shared.
    let invitedUserId = existingUser?.id ?? null;
    if (!invitedUserId) {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: false });
      if (createErr || !created?.user?.id) {
        console.error("Invite account creation error:", (createErr as { code?: string } | null)?.code ?? "unknown");
        return new Response(
          JSON.stringify({ status: "invitation_unavailable", error: "Invitation could not be prepared. Try again." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      invitedUserId = created.user.id;
    }

    // ── Reserve the seat atomically (the database seat wall decides) BEFORE any email is sent ──
    const { data: reservation, error: reserveErr } = await admin.rpc("reserve_workspace_invitation", {
      p_company_id: company_id, p_user: invitedUserId, p_role: role, p_invited_by: callerUser.id, p_invited_email: email,
    });
    const reserved = (reservation ?? {}) as { outcome?: string; member_id?: string };
    if (reserved.outcome === "already_member") {
      return new Response(JSON.stringify({ ok: false, alreadyMember: true, message: `${email} is already a member of this company.` }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (reserveErr || !["reserved", "reissued", "refreshed"].includes(reserved.outcome ?? "")) {
      const refusal = seatRefusal({ allowed: false, code: RESERVATION_REFUSALS[reserved.outcome ?? ""] ?? "UNAVAILABLE" })!;
      return new Response(JSON.stringify(refusal.body), { status: refusal.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── Send the invitation email (only now that the seat is reserved) ──
    const appUrl = Deno.env.get("APP_URL") ?? supabaseUrl.replace(".supabase.co", ".app");
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo: `${appUrl}/auth?invited=1`,
        data: {
          invited_company_id: company_id,
          invited_role: role,
          invited_by: callerUser.email ?? callerUser.id,
        },
      }
    );
    // An already-confirmed account receives no invitation email; its reservation stands and is accepted at the
    // person's next sign-in. Any other email failure releases the reservation (the row is kept as history).
    const alreadyRegistered = (inviteErr as { code?: string } | null)?.code === "email_exists";
    if (inviteErr && !alreadyRegistered) {
      console.error("Invite email error:", (inviteErr as { code?: string }).code ?? "unknown");
      await admin.rpc("release_workspace_invitation", { p_member_id: reserved.member_id });
      return new Response(
        JSON.stringify({ status: "email_failed", error: "Invitation email could not be sent. The seat was released; try again." }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // What this invitation actually carries, shown to the inviter: a title never grants or restores a capability, so a
    // re-invitation after a withdrawal names the capabilities it does NOT carry.
    const { data: summary } = await admin.rpc("invitation_capability_summary", { p_company_id: company_id, p_user: invitedUserId });
    const carried = (summary ?? {}) as { capabilities?: string[]; withheld?: unknown[] };

    return new Response(
      JSON.stringify({
        ok: true,
        userId: invitedUserId,
        alreadyMember: false,
        reservation: reserved.outcome,
        capabilities: carried.capabilities ?? [],
        withheld: carried.withheld ?? [],
        message: alreadyRegistered
          ? `${email} already has an account. The invitation is reserved and is accepted when they next sign in.`
          : `Invitation sent to ${email}. They will appear as 'Pending' until they accept.`,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("invite-firm-member error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
