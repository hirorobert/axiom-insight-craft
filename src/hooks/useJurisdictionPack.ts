import { useEffect, useState } from "react";
import { loadJurisdictionPack } from "@/lib/jurisdiction/packLoader";
import type { JurisdictionPack } from "@/lib/jurisdiction/packTypes";
import { hasJurisdictionPack } from "@/lib/jurisdiction/registry";

/** Loads the selected jurisdiction's pack through the dynamic loader. Unset / pack-less jurisdictions load nothing. */
export function useJurisdictionPack(code: string | null | undefined): { pack: JurisdictionPack | null; loading: boolean } {
  const [state, setState] = useState<{ code: string | null | undefined; pack: JurisdictionPack | null; done: boolean }>({ code, pack: null, done: !code || !hasJurisdictionPack(code) });
  useEffect(() => {
    let cancelled = false;
    if (!code || !hasJurisdictionPack(code)) {
      setState({ code, pack: null, done: true });
      return;
    }
    setState({ code, pack: null, done: false });
    void loadJurisdictionPack(code)
      .then((pack) => !cancelled && setState({ code, pack, done: true }))
      .catch(() => !cancelled && setState({ code, pack: null, done: true }));
    return () => {
      cancelled = true;
    };
  }, [code]);
  return { pack: state.code === code ? state.pack : null, loading: !(state.code === code && state.done) };
}
