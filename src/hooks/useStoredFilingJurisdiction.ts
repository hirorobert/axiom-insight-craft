/**
 * The filing jurisdiction a signed-in person's own companies explicitly store (companies.filing_jurisdiction), used ONLY to
 * pre-select the jurisdiction control inside the tax enquiry dialog — where it stays visible and editable, and is confirmed or
 * changed by the person.
 *
 * It never infers: no locale, currency, IP address or company name is consulted. It offers a value only when the person has
 * exactly one distinct stored jurisdiction across the companies they can see; zero, several, an error, or being signed out all
 * mean "no suggestion". The public workflow tile never uses it — the tile face is jurisdiction-neutral for everyone.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { isJurisdictionCode } from "@/lib/jurisdiction/registry";

export interface StoredJurisdiction {
  readonly code: string | null;
  readonly loading: boolean;
}

export function useStoredFilingJurisdiction(): StoredJurisdiction {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<StoredJurisdiction>({ code: null, loading: false });

  useEffect(() => {
    if (!userId) {
      setState({ code: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ code: null, loading: true });
    supabase
      .from("companies")
      .select("filing_jurisdiction")
      .not("filing_jurisdiction", "is", null)
      .then(({ data, error }) => {
        if (cancelled) return;
        const codes = new Set<string>();
        for (const row of data ?? []) if (isJurisdictionCode(row.filing_jurisdiction)) codes.add(row.filing_jurisdiction);
        setState({ code: !error && codes.size === 1 ? [...codes][0] : null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return state;
}
