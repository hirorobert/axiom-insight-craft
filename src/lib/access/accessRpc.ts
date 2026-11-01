import { supabase } from "@/integrations/supabase/client";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Single cast boundary for the platform-owner / access-administration RPCs (same rationale as
 * src/lib/commercial/commercialRpc.ts). These RPCs ship in 20261104100000_platform_owner_access_and_entity_allowance.sql,
 * which is authored and PENDING hosted application, so the generated `Database["public"]["Functions"]` union does not yet
 * know them. The cast is scoped to the rpc method's name/arg typing ONLY; callers type the return shape themselves. Once the
 * migration is applied and types.ts is regenerated, delete this module and call supabase.rpc directly.
 *
 * CF-02 (readiness assessment 2026-11-01): the method is invoked ON the client, never extracted. `SupabaseClient.rpc()`
 * reads `this.rest`, so a detached reference (`const rpc = supabase.rpc as …`) throws
 * "Cannot read properties of undefined (reading 'rest')" on every call — observed live on /admin/access.
 * boundRpcWrappers.test.ts calls this wrapper through a real SupabaseClient so that regression cannot return.
 */
type RpcFn = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: PostgrestError | null }>;
export const callAccessRpc: RpcFn = (name, args) => (supabase.rpc as unknown as RpcFn).call(supabase, name, args);
