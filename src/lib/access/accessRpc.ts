import { supabase } from "@/integrations/supabase/client";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Single cast boundary for the platform-owner / access-administration RPCs (same rationale as
 * src/lib/commercial/commercialRpc.ts). These RPCs ship in 20261104100000_platform_owner_access_and_entity_allowance.sql,
 * which is authored and PENDING hosted application, so the generated `Database["public"]["Functions"]` union does not yet
 * know them. The cast is scoped to the rpc method's name/arg typing ONLY; callers type the return shape themselves. Once the
 * migration is applied and types.ts is regenerated, delete this module and call supabase.rpc directly.
 */
type RpcFn = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: PostgrestError | null }>;
const rpc = supabase.rpc as unknown as RpcFn;
export const callAccessRpc = (name: string, args?: Record<string, unknown>) => rpc(name, args);
