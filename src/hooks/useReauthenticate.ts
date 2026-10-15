import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Recent-reauthentication for privileged access-administration actions. Calls the `reauthenticate` Edge Function, which
 * re-verifies the caller's password server-side and mints a short-lived, single-use, user-bound nonce. The nonce is passed
 * to the next privileged RPC, which consumes it. The password never leaves this call and is never stored client-side.
 */
export function useReauthenticate() {
  const [busy, setBusy] = useState(false);
  const reauth = async (password: string): Promise<{ nonce: string } | { error: string }> => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("reauthenticate", { body: { password } });
      if (error) return { error: "We could not confirm your password. Please try again." };
      const nonce = data && typeof data === "object" ? (data as { nonce?: unknown }).nonce : undefined;
      if (typeof nonce !== "string" || nonce.length === 0) return { error: "Reauthentication failed." };
      return { nonce };
    } finally {
      setBusy(false);
    }
  };
  return { reauth, busy };
}
