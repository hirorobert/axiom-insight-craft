/**
 * ProcessingAuthorityNotice — reads this upload's authority and processing history (tb_upload_authority,
 * tb_upload_attempts; S2) and renders ProcessingAuthorityNoticeView. Reads only; the action is the page's own reprocess
 * handler (tbu_request_reprocess, the one browser path).
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { loadUploadAuthority, ProcessingAuthorityNoticeView, type Rpc, type UploadAuthorityState } from "./ProcessingAuthorityNoticeView";

/** Reads on mount and whenever `refreshKey` changes (the upload's status/version moved). */
export function ProcessingAuthorityNotice({ uploadId, refreshKey, busy, canAct, onAction }: {
  uploadId: string;
  refreshKey: string;
  busy: boolean;
  canAct: boolean;
  onAction: () => void;
}) {
  const [state, setState] = useState<UploadAuthorityState>({ loaded: false, authority: null, attempts: null });
  const load = useCallback(async () => {
    try {
      setState(await loadUploadAuthority((fn, args) => (supabase as unknown as { rpc: Rpc }).rpc(fn, args), uploadId));
    } catch {
      setState({ loaded: true, authority: null, attempts: null });
    }
  }, [uploadId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return <ProcessingAuthorityNoticeView state={state} busy={busy} canAct={canAct} onAction={onAction} />;
}
