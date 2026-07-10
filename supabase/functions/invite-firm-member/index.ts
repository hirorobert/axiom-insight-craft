// ============================================================
// invite-firm-member — Firm Management (Roadmap Item 8)
//
// Invites a user to a company's firm_members roster.
//
// Flow:
//   1. Validate caller is owner of the company
//   2. Call supabase.auth.admin.inviteUserByEmail(email)
//      — creates auth user + sends email with magic link
//      — returns user.id even if user already exists
//   3. Upsert into firm_members:
//        { company_id, user_id, role, invited_by, invited_email,
//          accepted_at = null (for new invites) }
//   4. Return { ok: true, userId, alreadyMember: bool }
//
// Callers: FirmManagementPanel → supabase.functions.invoke()
//
// Security:
//   • Admin client (service role) required for auth.admin.inviteUserByEmail
//   • RLS on firm_members enforced by trigger (owner-only writes for
//     non-owner roles are enforced by firm_members policies)
//   • Caller's JWT is checked: must be owner of target company
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const allowedRoles = ["owner", "partner", "preparer", "viewer"];
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

    // ── Verify caller is owner of the company ─────────────────
    const { data: membership, error: memErr } = await admin
      .from("firm_members")
      .select("role")
      .eq("company_id", company_id)
      .eq("user_id", callerUser.id)
      .maybeSingle();

    if (memErr || !membership || membership.role !== "owner") {
      return new Response(
        JSON.stringify({ error: "You must be an owner of this company to invite members." }),
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
        .select("id, role")
        .eq("company_id", company_id)
        .eq("user_id", existingUser.id)
        .maybeSingle();

      if (existingMember) {
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
    }

    // ── Send invitation ───────────────────────────────────────
    const appUrl = Deno.env.get("APP_URL") ?? supabaseUrl.replace(".supabase.co", ".app");

    const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
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

    if (inviteErr) {
      console.error("Invite error:", inviteErr);
      return new Response(
        JSON.stringify({ error: inviteErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const invitedUserId = inviteData.user?.id;
    if (!invitedUserId) {
      return new Response(
        JSON.stringify({ error: "Invitation sent but could not retrieve user ID." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Insert firm_members row ───────────────────────────────
    // accepted_at = null → invitation pending
    // invited_email stored for display before they accept
    const { error: insertErr } = await admin.from("firm_members").insert({
      company_id,
      user_id:       invitedUserId,
      role,
      invited_by:    callerUser.id,
      invited_email: email,
      accepted_at:   null,
    });

    if (insertErr) {
      console.error("firm_members insert error:", insertErr);
      return new Response(
        JSON.stringify({ error: `Invitation sent but could not create member record: ${insertErr.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        userId: invitedUserId,
        alreadyMember: false,
        message: `Invitation sent to ${email}. They will appear as 'Pending' until they accept.`,
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
