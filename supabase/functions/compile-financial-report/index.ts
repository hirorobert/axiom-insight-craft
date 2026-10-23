import { createClient } from "https://esm.sh/@supabase/supabase-js@2.86.2";
import { compilationHandler } from "./handler.ts";
const url = Deno.env.get("SUPABASE_URL")!;
Deno.serve(compilationHandler({
  user: token => createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: token } }, auth: { persistSession: false } }),
  service: () => createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } }),
}));
