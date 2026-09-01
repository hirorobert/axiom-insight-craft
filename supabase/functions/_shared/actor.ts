// Ω∞ Phase 0A — server-side professional actor resolution.
//
// Builds on top of, does not replace, _shared/auth.ts. validateAuth() only
// ever returns { userId, email? } — it has never derived firm_members.id.
// This module closes that gap with one canonical helper, rather than each
// function continuing to inline its own (sometimes duplicated, sometimes
// altogether missing) membership query.
//
// NOT executed/tested in this environment — no Deno runtime is available
// here. Written to match the real, verified _shared/auth.ts signatures
// (validateAuth(authHeader, corsHeaders), assertCompanyMembership(
// adminClient, userId, companyId)) exactly as they exist today, not as
// earlier documentation (CLAUDE.md, SAFF directive V1) incorrectly claimed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface FirmMemberActor {
  firmMemberId: string;
  userId: string;
  companyId: string;
  role: string;
}

/**
 * Resolves the canonical professional actor for a request. Never trusts a
 * client-supplied firmMemberId — always derives it from a fresh,
 * accepted-membership query against firm_members, keyed on the JWT-derived
 * userId and the caller's asserted companyId.
 *
 * Returns the resolved actor on success, or a 403 Response to short-circuit
 * on failure (same calling convention as assertCompanyMembership:
 * `const denied = await resolveFirmMemberActor(...); if (denied instanceof Response) return denied;`).
 */
export async function resolveFirmMemberActor(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  companyId: string,
  corsHeaders: Record<string, string>,
): Promise<FirmMemberActor | Response> {
  if (!companyId) {
    return new Response(
      JSON.stringify({ error: "Forbidden", message: "Missing company context" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { data, error } = await adminClient
    .from("firm_members")
    .select("id, role")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .not("accepted_at", "is", null)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return new Response(
      JSON.stringify({ error: "Forbidden", message: "Not a member of this company" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // The Supabase client here has no Database generic (matching the existing
  // pattern in _shared/auth.ts), so query results type as `never` for field
  // access. A single cast on the whole row — not per-field casts on a
  // `never`-typed value, which cannot be indexed at all — makes this legal.
  const row = data as { id: string; role: string };

  return {
    firmMemberId: row.id,
    userId,
    companyId,
    role: row.role,
  };
}
