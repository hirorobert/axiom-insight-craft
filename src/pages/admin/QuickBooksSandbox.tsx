import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useActiveEngagements } from "@/hooks/useActiveEngagements";
import { useAuth } from "@/contexts/AuthContext";
import { sandboxAccessDeps, sandboxStorage } from "@/hooks/useQboSandboxAccess";
import { enrollSandbox, sandboxActor } from "@/lib/workspace/qboSandboxAccess";

function WorkspacePicker() {
  const { entries, loading, fetchFailed } = useActiveEngagements();
  const [chosen, setChosen] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const entry = entries.find(e => e.engagementId === chosen);
  const open = async () => {
    if (!entry || !confirmed || busy) return;
    setBusy(true); setError(null);
    const ok = await enrollSandbox(sandboxAccessDeps, sandboxStorage(), entry);
    if (ok) navigate(`/workspace/${entry.companyId}/${entry.periodYear}/trial-balance/review?engagement=${encodeURIComponent(entry.engagementId)}`);
    else { setError("Choose an empty workspace that you own. Access could not be established, or source files already exist. Nothing was imported."); setBusy(false); }
  };
  return <>
    <p>Use a separate empty company for sample QuickBooks data. Existing source files are never replaced by this test.</p>
    <p><Link className="underline" to="/companies/new">Create a separate test company</Link></p>
    {loading ? <p role="status">Reading workspaces…</p> : fetchFailed ? <p role="alert">Workspaces could not be read. Reload to try again.</p> : <>
      <label className="block space-y-2">Test company and reporting year
        <select className="block w-full rounded border border-border bg-background p-2" value={chosen} onChange={e => { setChosen(e.target.value); setConfirmed(false); setError(null); }} disabled={busy}>
          <option value="">Choose a workspace</option>
          {entries.filter(e => !e.workspaceState.currentUploadId).map(e => <option key={e.engagementId} value={e.engagementId}>{e.companyName} — {e.periodYear}</option>)}
        </select>
      </label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy || !entry} /><span>This is a test workspace for sample data, separate from client books.</span></label>
      {error && <p role="alert">{error}</p>}
      <Button onClick={() => void open()} disabled={!entry || !confirmed || busy}>{busy ? "Checking the test workspace…" : "Open Sandbox connection"}</Button>
    </>}
  </>;
}

export default function QuickBooksSandbox() {
  const { user, loading } = useAuth();
  const userId = user?.id;
  const [access, setAccess] = useState<{ actor: string; allowed: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setAccess(null);
    if (!loading && userId) void sandboxActor(sandboxAccessDeps).then(actor => { if (live) setAccess({ actor: userId, allowed: actor === userId }); });
    return () => { live = false; };
  }, [userId, loading]);
  const allowed = !!user && access?.actor === user.id && access.allowed;
  return <main className="mx-auto max-w-2xl space-y-5 px-4 py-8">
    <h1 className="text-2xl font-semibold">QuickBooks Sandbox rehearsal</h1>
    <p>Internal testing only. This does not enable customer QuickBooks access or production connections.</p>
    {loading ? <p role="status">Checking access…</p> : !user ? <Link className="underline" to="/auth">Sign in to continue</Link> : access?.actor !== user.id ? <p role="status">Checking access…</p> : !allowed ? <p role="alert">This rehearsal is available only to the platform owner.</p> : <WorkspacePicker />}
    <Link className="underline" to="/dashboard">Back to workspaces</Link>
  </main>;
}
