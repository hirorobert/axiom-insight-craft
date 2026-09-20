/**
 * JurisdictionPanel / JurisdictionGate — the only way a global stage page reaches a jurisdiction pack.
 *
 *  - <JurisdictionGate> renders the neutral explanation (and the setting) when a stage cannot run because no filing
 *    jurisdiction is selected, or none ships a pack for the selected one.
 *  - <JurisdictionPanel> loads the selected jurisdiction's pack through the dynamic loader and renders one panel of it.
 *    With no jurisdiction, or one without a pack, it renders nothing and imports nothing.
 */

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { loadJurisdictionPack } from "@/lib/jurisdiction/packLoader";
import type { JurisdictionPack, PackPanelId, PackPanelProps } from "@/lib/jurisdiction/packTypes";
import { hasJurisdictionPack, serviceAvailability } from "@/lib/jurisdiction/registry";
import type { EngagementCapability } from "@/lib/workspace/mandate";
import FilingJurisdictionSetting from "@/components/jurisdiction/FilingJurisdictionSetting";

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

export function JurisdictionPanel({ jurisdiction, panel, ...props }: { jurisdiction: string | null | undefined; panel: PackPanelId } & PackPanelProps) {
  const { pack, loading } = useJurisdictionPack(jurisdiction);
  if (loading) return <Skeleton className="h-40 w-full" />;
  const Panel = pack?.panels[panel];
  return Panel ? <Panel {...props} /> : null;
}

/** Shown in place of a stage whose service cannot run yet. Returns null when the service is available. */
export function JurisdictionGate({ capability, jurisdiction, companyId, canChange }: { capability: EngagementCapability; jurisdiction: string | null | undefined; companyId: string; canChange: boolean }) {
  const a = serviceAvailability(capability, jurisdiction);
  if (a.available) return null;
  const gate = a as { reason: "JURISDICTION_REQUIRED" | "NO_PACK"; message: string };
  return (
    <div className="max-w-xl space-y-3 border border-border p-5" data-testid="jurisdiction-gate" data-reason={gate.reason}>
      <h2 className="text-base font-semibold text-foreground">Filing jurisdiction required</h2>
      <p className="text-sm text-muted-foreground">{gate.message}</p>
      {gate.reason === "JURISDICTION_REQUIRED" && <FilingJurisdictionSetting companyId={companyId} jurisdiction={jurisdiction ?? null} canChange={canChange} />}
    </div>
  );
}
