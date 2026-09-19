// NON-PRODUCTION HARNESS. Renders the real FinancialStatementsWorkspace component
// tree with fixture data so the UI can be verified in a browser without an
// authenticated Supabase session or production data.
//
// Optional: `?bridge=http://127.0.0.1:54999&as=partner&company=A` connects the real
// transport to a DISPOSABLE PostgreSQL through the loopback bridge of
// scripts/db-proof/serve.mjs, so the whole save/conflict/publication path runs against
// real RLS and real SECURITY DEFINER functions. `as` names a fixture user; that is a
// simulated identity, not GoTrue authentication.
//
// Isolation guarantees (asserted by harnessIsolation.test.ts):
//   - lives outside src/ and is reachable only through the Vite dev server;
//   - `vite build` bundles index.html only, so this is never in dist/;
//   - it refuses to run at all unless import.meta.env.DEV is true;
//   - nothing under src/ imports it.
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "../src/index.css";
import { FinancialStatementsWorkspace } from "../src/components/financialStatements/FinancialStatementsWorkspace";
import { FsRpcTransport } from "../src/lib/financialStatementsWorkspace/rpcTransport";
import { buildFixture, type ScenarioId } from "./fixture";
import { bridgeBackend, loadSeed } from "./bridgeBackend";

if (!import.meta.env.DEV) {
  throw new Error("dev-harness is a non-production tool and cannot run in a production build.");
}

const q = new URLSearchParams(window.location.search);
const scenario = (q.get("scenario") ?? "defect") as ScenarioId;
const framework = q.get("fw") === "none" ? null : (q.get("fw") ?? "full_ifrs");
const fixture = buildFixture(scenario);
const signatures = q.get("sign") === "1" ? ["Director", "Auditor"] : undefined;
const bridge = q.get("bridge");
const simUser = q.get("as") ?? "owner";

async function boot() {
  let companyId = "harness-company";
  let transport: FsRpcTransport | null | undefined;
  if (bridge) {
    const seed = await loadSeed(bridge);
    companyId = q.get("company") === "B" ? seed.companyB : seed.companyA;
    transport = new FsRpcTransport(bridgeBackend(bridge, simUser));
  }
  const uploads = fixture.uploads.map((u) => ({ ...u, company_id: companyId }));
  const currentUpload = { ...fixture.currentUpload, company_id: companyId };

  createRoot(document.getElementById("root")!).render(
    <BrowserRouter>
      <div className="mx-auto max-w-5xl p-3 sm:p-6">
        <p className="mb-3 border border-dashed border-border p-2 text-xs text-muted-foreground" data-testid="harness-banner">
          NON-PRODUCTION HARNESS — fixture data · scenario “{scenario}” · framework “{framework ?? "not set"}”
          {bridge ? ` · disposable database via loopback bridge as simulated user “${simUser}” (not GoTrue)` : ""}
        </p>
        <FinancialStatementsWorkspace
          key={`${scenario}-${framework}-${simUser}-${companyId}`}
          companyId={companyId}
          periodYear={2025}
          companyName="Harness Trading Company Ltd"
          companyTin="123456789"
          reportingFramework={framework}
          currency="TZS"
          fiscalYearEnd={fixture.fiscalYearEnd}
          currentUpload={currentUpload}
          uploads={uploads}
          loadAccountMappings={fixture.loadAccountMappings}
          signatureBlocks={signatures}
          transport={transport}
        />
      </div>
    </BrowserRouter>,
  );
}

void boot();
