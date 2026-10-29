// NON-PRODUCTION HARNESS. Renders the real IPSAS accrual preparation component against a DISPOSABLE PostgreSQL through the
// loopback bridge of scripts/db-proof/serveIpsas.mjs.
//
//   ?bridge=http://127.0.0.1:54995&as=preparer   (as: owner | preparer | partner | viewer | outsider — a SIMULATED identity
//                                                 named to the bridge, not GoTrue authentication)
//   &nav=off                                     (no fixed sidebar, for width checks)
//
// Isolation: outside src/, reachable only through the Vite dev server, refuses to run in a production build, refuses a
// non-loopback bridge, and nothing under src/ imports it.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { IpsasPreparation } from "../../src/components/ipsas/IpsasPreparation";
import { loadAllowed, loadReportingSeed, reportingBridgeDb } from "../reporting/bridgeDb";

if (!import.meta.env.DEV) throw new Error("dev-harness is a non-production tool and cannot run in a production build.");

const q = new URLSearchParams(window.location.search);
const bridge = q.get("bridge") ?? "http://127.0.0.1:54995";
const simUser = q.get("as") ?? "preparer";
const showNav = q.get("nav") !== "off";
const db = reportingBridgeDb(bridge, simUser);

function Harness({ seed }: { seed: { companyId: string; periodYear: number } }) {
  const [allowed, setAllowed] = useState<string[] | null>(null);
  useEffect(() => { void loadAllowed(db, seed.companyId).then(setAllowed); }, [seed.companyId]);
  return (
    <div className="min-h-screen" style={{ display: "grid", gridTemplateColumns: showNav ? "15rem minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
      {showNav ? (
        <aside className="border-r border-border bg-muted/30 p-3" data-testid="harness-nav">
          <p className="text-xs text-muted-foreground">Harness · signed in as <strong data-testid="sim-user">{simUser}</strong> (simulated)</p>
        </aside>
      ) : null}
      <main className="mx-auto w-full max-w-5xl p-4">
        {allowed === null ? <p role="status">Loading…</p> : (
          <IpsasPreparation key={`${seed.companyId}:${seed.periodYear}`} companyId={seed.companyId} periodYear={seed.periodYear} legalName="Synthetic Community Trust" db={db}
            canPrepare={allowed.includes("prepare_close")} canConfirm={allowed.includes("review_close")} prepareHref="#/prepare" />
        )}
      </main>
    </div>
  );
}

async function boot() {
  const seed = await loadReportingSeed(bridge, simUser);
  createRoot(document.getElementById("root")!).render(<Harness seed={seed} />);
}
void boot();
