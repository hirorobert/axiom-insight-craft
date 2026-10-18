/**
 * ClassificationRecord — after the account review, what was confirmed for THIS trial balance, how and by whom, and which
 * accounts stood on a previously reviewed mapping (DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001).
 *
 * Read-only: it selects the stored decisions (account_review_decisions, append-only, written only by
 * resolve_account_review_batch with the server-resolved firm member), the deciding members and the company's mappings
 * (their review provenance). It writes nothing and decides nothing; a read it cannot make is said, never guessed.
 */
import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  buildReviewRecord, classificationWords, recordSummary, statementAccounts,
  type CompanyMapping, type DecisionMember, type RecordRow, type StoredDecision,
} from "@/lib/workspace/reviewConfirmation";

type Read = { state: "loading" } | { state: "failed" } | { state: "ready"; decisions: StoredDecision[]; members: DecisionMember[]; mappings: CompanyMapping[] };
type Chain = { select(c: string): Chain; eq(c: string, v: unknown): Chain; in(c: string, v: unknown[]): Chain; order(c: string, o?: { ascending: boolean }): PromiseLike<{ data: unknown[] | null; error: unknown }> } & PromiseLike<{ data: unknown[] | null; error: unknown }>;
const from = (t: string) => (supabase.from as unknown as (t: string) => Chain)(t);

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};

export function ClassificationRecord({ uploadId, companyId, currentUserId, processingResult, refreshKey }: {
  uploadId: string;
  companyId: string;
  currentUserId: string | null;
  processingResult: unknown;
  /** Changes when the upload's result changes (status, processed time), so the record is read again. */
  refreshKey: string;
}) {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [open, setOpen] = useState(true);
  const listId = useId();
  const accounts = statementAccounts(processingResult);

  useEffect(() => {
    let live = true;
    setRead({ state: "loading" });
    void (async () => {
      try {
        const dec = await from("account_review_decisions")
          .select("account_code, normalized_account_name, review_account_key, decision_action, new_value, firm_member_id, created_at, sequence_no")
          .eq("upload_id", uploadId).order("sequence_no", { ascending: true });
        if (dec.error) throw dec.error;
        const decisions = (dec.data ?? []) as StoredDecision[];
        const ids = [...new Set(decisions.map((d) => d.firm_member_id))];
        const mem = ids.length ? await from("firm_members").select("id, user_id, role, invited_email").in("id", ids) : { data: [], error: null };
        const map = await from("account_mappings").select("account_code, normalized_account_name, review_decision_id").eq("company_id", companyId);
        if (map.error) throw map.error;
        // A member row the reader may not see is shown as "a member of this workspace", never as someone else.
        if (live) setRead({ state: "ready", decisions, members: (mem.error ? [] : mem.data ?? []) as DecisionMember[], mappings: (map.data ?? []) as CompanyMapping[] });
      } catch {
        if (live) setRead({ state: "failed" });
      }
    })();
    return () => { live = false; };
  }, [uploadId, companyId, refreshKey]);

  if (accounts.length === 0) return null;
  const record = read.state === "ready" ? buildReviewRecord({ accounts, decisions: read.decisions, members: read.members, mappings: read.mappings, currentUserId }) : null;

  return (
    <section className="border border-border bg-card" aria-labelledby={`${listId}-h`} data-testid="classification-record">
      <Button type="button" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={listId}
        className="h-auto w-full justify-between rounded-none px-5 py-3.5 sm:px-7">
        <span id={`${listId}-h`} className="text-[13px] font-semibold text-foreground">Classification record <span className="font-normal text-muted-foreground">· {accounts.length} account{accounts.length === 1 ? "" : "s"}</span></span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </Button>
      <p role="status" aria-live="polite" className="border-t border-border px-5 py-3 text-[13px] text-foreground sm:px-7" data-testid="classification-record-summary">
        {read.state === "loading" ? "Reading the classification record…"
          : read.state === "failed" ? "The classification record could not be read. The classifications themselves are unchanged — try again later."
          : recordSummary(record!, when)}
      </p>
      {open && record && (
        <ul id={listId} className="border-t border-border" data-testid="classification-record-list">
          {record.rows.map((r) => <RecordItem key={r.key} r={r} />)}
        </ul>
      )}
    </section>
  );
}

function RecordItem({ r }: { r: RecordRow }) {
  return (
    <li className="flex flex-col gap-1 border-t border-border px-5 py-3 first:border-t-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-7" data-testid={`record-${r.key}`} data-basis={r.basis}>
      <div className="min-w-0">
        <p className="break-words text-[13px] font-medium text-foreground">
          {r.account_code ? <span className="mr-2 font-mono text-[12px] text-muted-foreground">{r.account_code}</span> : null}
          {r.account_name}
        </p>
        <p className="text-[12px] text-muted-foreground">{r.classification ? classificationWords(r.classification) : "Not on the statements"}</p>
      </div>
      <p className="shrink-0 text-[12px] sm:max-w-[22rem] sm:text-right">
        {r.basis === "confirmed_here" ? (
          <><span className="font-semibold text-foreground">Confirmed in this review</span><span className="block text-muted-foreground">{r.action} by {r.by}{r.at ? ` · ${when(r.at)}` : ""}</span></>
        ) : r.basis === "previously_reviewed" ? (
          <span className="font-semibold text-foreground">Previously reviewed<span className="block font-normal text-muted-foreground">On this company's reviewed mapping; not confirmed again in this run</span></span>
        ) : (
          <span className="text-muted-foreground">No review record found for this account</span>
        )}
      </p>
    </li>
  );
}
