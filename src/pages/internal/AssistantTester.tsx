import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Send } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type QaState = { allowed: boolean; spendingEnabled?: boolean };
export default function AssistantTester() {
  const { user, loading } = useAuth();
  const userId = user?.id;
  const [access, setAccess] = useState<QaState | null>(null);
  const [caseId, setCaseId] = useState("1");
  const [action, setAction] = useState("explain_movement");
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function refresh() {
    setAccess(null);
    const { data, error } = await supabase.functions.invoke("assistant-qa", { body: { action: "status" } });
    if (error) { setMessage("Tester access could not be checked. Refresh to try again."); return; }
    setAccess(data as QaState);
  }
  useEffect(() => { if (!loading && userId) void refresh(); }, [loading, userId]);
  async function run() {
    if (lock.current || !access?.allowed || !access.spendingEnabled) return;
    lock.current = true; setBusy(true); setAnswer(null); setMessage("");
    try {
      const { data, error } = await supabase.functions.invoke("assistant-qa", {
        body: { action, caseId: Number(caseId), requestId: crypto.randomUUID() },
      });
      if (error) { setMessage("The outcome is unconfirmed. No automatic retry was made."); return; }
      if (data.status !== "answered") { setMessage(data.message ?? "The answer was withheld."); return; }
      setAnswer(data.answer.blocks.map((b: { parts: { text: string }[] }) => b.parts.map(p => p.text).join("")).join("\n\n"));
    } catch { setMessage("The outcome is unconfirmed. No automatic retry was made."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
    <Link to="/dashboard" className="text-sm text-muted-foreground underline">Back to companies</Link>
    <h1 className="text-2xl font-semibold">Ask CFOClose · tester</h1>
    {!user && !loading ? <Link to="/auth" className="underline">Sign in</Link> : null}
    {loading || (user && !access && !message) ? <p>Checking tester access…</p> : null}
    {access && !access.allowed ? <p>Tester access is not available for this account.</p> : null}
    {access?.allowed ? <>
      <p className="text-sm text-muted-foreground">Synthetic development cases · not accountant-approved</p>
      {!access.spendingEnabled && <p>API spending is paused.</p>}
      <div className="flex flex-wrap gap-3">
        <Select value={caseId} onValueChange={setCaseId}><SelectTrigger className="w-40" aria-label="Development case"><SelectValue /></SelectTrigger><SelectContent>{Array.from({ length: 20 }, (_, i) => <SelectItem key={i + 1} value={String(i + 1)}>Case {i + 1}</SelectItem>)}</SelectContent></Select>
        <Select value={action} onValueChange={setAction}><SelectTrigger className="w-56" aria-label="Assistant action"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="explain_movement">Explain movement</SelectItem><SelectItem value="draft_commentary">Draft commentary</SelectItem></SelectContent></Select>
        <Button onClick={run} disabled={busy || !access.spendingEnabled}><Send className="mr-2 h-4 w-4" />Run case</Button>
      </div>
      {answer && <div className="whitespace-pre-wrap border-l-2 border-primary pl-5">{answer}</div>}
    </> : null}
    {message && <p role="status">{message}</p>}
    {user && <Button variant="outline" onClick={refresh} disabled={busy}><RefreshCw className="mr-2 h-4 w-4" />Refresh access</Button>}
  </main>;
}