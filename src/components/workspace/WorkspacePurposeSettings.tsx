import { useEffect, useId, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useManagementEditGuard } from "@/components/account/managementState";
import { useBusyState } from "@/hooks/useBusyState";
import { Button } from "@/components/ui/button";
import { PURPOSE_WORDS, type WorkspacePurpose } from "@/lib/workspace/engagementGroups";
import { saveWorkspacePurpose, type PurposeClient, type PurposeRecord } from "@/lib/workspace/workspacePurposeClient";

const client: PurposeClient = {
  async read(companyId) {
    const { data, error } = await supabase.from("workspace_purpose_events" as never).select("purpose, reason, created_at").eq("company_id", companyId).order("seq", { ascending: false }).limit(1);
    if (error) throw new Error("The recorded purpose could not be read. Try again.");
    const row = (data as unknown as PurposeRecord[] | null)?.[0] ?? null;
    if (row && !Object.prototype.hasOwnProperty.call(PURPOSE_WORDS, row.purpose)) throw new Error("The recorded purpose is not recognised.");
    return row;
  },
  async write(companyId, purpose, reason) {
    const { data, error } = await supabase.rpc("set_workspace_purpose" as never, { p_company_id: companyId, p_purpose: purpose, p_reason: reason } as never);
    if (error) throw error;
    return data as { outcome?: string };
  },
};

/** Company metadata, deliberately outside the reporting journey. The existing owner-only, append-only RPC owns writes. */
export function WorkspacePurposeSettings({ companyId, transport = client, onEditState, disabled = false }: { companyId: string; transport?: PurposeClient; disabled?: boolean; onEditState?: (state: { dirty: boolean; busy: boolean }) => void }) {
  const id = useId();
  const [record, setRecord] = useState<PurposeRecord | null>(null);
  const [purpose, setPurpose] = useState<WorkspacePurpose | "">("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useBusyState("Saving workspace purpose…");
  const generation = useRef(0);
  const dirty = purpose !== (record?.purpose ?? "") || !!reason;
  useEffect(() => { onEditState?.({ dirty, busy }); return () => onEditState?.({ dirty: false, busy: false }); }, [dirty, busy, onEditState]);
  useManagementEditGuard(dirty, busy, () => { setPurpose(record?.purpose ?? ""); setReason(""); });
  useEffect(() => {
    const mine = ++generation.current;
    setLoading(true); setReadFailed(false);
    transport.read(companyId).then(value => {
      if (mine !== generation.current) return;
      setRecord(value); setPurpose(value?.purpose ?? ""); setReason(""); setLoading(false);
    }, () => { if (mine === generation.current) { setReadFailed(true); setLoading(false); } });
    return () => { generation.current = mine + 1; };
  }, [companyId, transport, attempt]);
  return <section className="mt-6 space-y-3 border-t border-border pt-5" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="text-base font-semibold">Workspace purpose</h3>
    <p className="text-sm text-muted-foreground">Label this company as client work, testing or training. This does not change its financial records, access or billing. Changes are kept in its audit history.</p>
    {loading ? <p role="status">Reading recorded purpose…</p> : readFailed ? <div role="alert"><p>The recorded purpose could not be read.</p><Button variant="outline" onClick={() => setAttempt(n => n + 1)}>Try again</Button></div> : <>
      <p className="text-sm" data-testid="recorded-purpose">Recorded: <strong>{record ? PURPOSE_WORDS[record.purpose] : "Not stated"}</strong></p>
      <form className="space-y-3" onSubmit={async e => {
        e.preventDefault(); if (!purpose || busy || disabled || !setBusy(true)) return;
        const mine = generation.current; setNotice(null);
        try {
          const value = await saveWorkspacePurpose(transport, companyId, purpose, reason);
          if (mine === generation.current) { setRecord(value); setPurpose(value.purpose); setReason(""); setNotice("Saved and confirmed."); }
        } catch (error) { if (mine === generation.current) setNotice(error instanceof Error ? error.message : "The purpose could not be confirmed. Try again."); }
        finally { if (mine === generation.current) setBusy(false); }
      }}>
        <fieldset disabled={busy || disabled} className="space-y-3">
          <label className="block text-sm" htmlFor={`${id}-purpose`}>Purpose</label>
          <select id={`${id}-purpose`} className="min-h-11 w-full border border-input bg-background px-3 text-sm" value={purpose} onChange={e => setPurpose(e.target.value as WorkspacePurpose)} required>
            <option value="" disabled>Select purpose</option>{(Object.keys(PURPOSE_WORDS) as WorkspacePurpose[]).map(p => <option key={p} value={p}>{PURPOSE_WORDS[p]}</option>)}
          </select>
          <label className="block text-sm" htmlFor={`${id}-reason`}>Reason for change</label>
          <input id={`${id}-reason`} className="min-h-11 w-full border border-input bg-background px-3 text-sm" value={reason} onChange={e => setReason(e.target.value)} minLength={3} maxLength={500} required />
          <Button type="submit" variant="outline" pending={busy} disabled={busy || !purpose || purpose === record?.purpose || reason.trim().length < 3}>Save purpose</Button>
        </fieldset>
      </form>
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </>}
  </section>;
}
