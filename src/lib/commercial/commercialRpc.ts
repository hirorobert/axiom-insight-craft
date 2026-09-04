import { supabase } from "@/integrations/supabase/client";
import type { PostgrestError } from "@supabase/supabase-js";
import type { LicenceStatus } from "./entitlementContract";

/**
 * Ω1 — narrow, single-boundary typed adapter for commercial RPC calls.
 *
 * `src/integrations/supabase/types.ts` is generated from the live database
 * schema and cannot be regenerated in this environment without live DB
 * access (migration 20260904180000_commercial_foundation_wave_omega1.sql is
 * CREATED_NOT_APPLIED — see CLAUDE.md §11). That means the generated
 * `Database["public"]["Functions"]` union does not yet know these RPCs
 * exist, and `supabase.rpc(name, args)` cannot be called with full inference
 * for them today.
 *
 * Rather than scatter `supabase.rpc("name" as never, ...)` (or `as any`)
 * across every call site — which throws away type information for the
 * ARGUMENTS and RETURN VALUE too, not just the function name — every
 * Ω1 commercial RPC call goes through `callCommercialRpc()` below. It is
 * the SOLE cast boundary in this module: the cast is scoped to the client's
 * `rpc` method signature only, and every function's argument and return
 * shape is fully and explicitly typed in `CommercialRpcSignature`, hand-
 * verified against the SQL definitions in the Ω1 migration. Nothing
 * downstream of a `callCommercialRpc()` call is untyped.
 *
 * Once the migration is applied and `types.ts` is regenerated, delete this
 * module's cast (the `as CommercialRpcClient` line) and pass `supabase`
 * directly — every call site's types are already correct and need no
 * further changes.
 */

export interface CommercialRpcSignature {
  get_my_billing_summary: {
    args: Record<string, never>;
    returns: {
      has_billing_customer: boolean;
      plan_code: string | null;
      licence_status: LicenceStatus | null;
      effective_start: string | null;
      effective_end: string | null;
      entitlements: string[];
    };
  };
  get_effective_entitlement: {
    args: { p_company_id: string; p_feature_code: string };
    returns: {
      status: "ENTITLED" | "NOT_ENTITLED" | "UNKNOWN";
      reason: string;
      licence_status: LicenceStatus | null;
      plan_code: string | null;
      source: "ACTIVE_LICENCE" | "ADMIN_OVERRIDE" | null;
    };
  };
}

type CommercialRpcName = keyof CommercialRpcSignature;

interface CommercialRpcClient {
  rpc: <N extends CommercialRpcName>(
    name: N,
    args?: CommercialRpcSignature[N]["args"],
  ) => Promise<{ data: CommercialRpcSignature[N]["returns"] | null; error: PostgrestError | null }>;
}

export async function callCommercialRpc<N extends CommercialRpcName>(
  name: N,
  ...args: CommercialRpcSignature[N]["args"] extends Record<string, never> ? [] : [CommercialRpcSignature[N]["args"]]
): Promise<{ data: CommercialRpcSignature[N]["returns"] | null; error: PostgrestError | null }> {
  // Sole cast boundary — see module doc comment above for why this is
  // necessary and why it does not weaken typing anywhere else.
  const client = supabase as unknown as CommercialRpcClient;
  return client.rpc(name, args[0]);
}
