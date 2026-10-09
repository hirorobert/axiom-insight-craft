/**
 * Sign-off & Exports › Sign-off. Saves report versions and signs them through the ONE canonical path.
 *
 *  - Evidence: collected while the statements are prepared (Statements › Evidence, EvidenceIntake); summarised here,
 *    read-only, with each file's state (stored, and whether the latest version is bound to it).
 *  - Save: the version is assembled from the server's current composition, notes and dependencies and committed with its
 *    evaluation in one server call; a retry repeats the same attempt.
 *  - Readiness: the server's blockers for the selected version, as returned.
 *  - Sign-off: REVIEWED (review_close), then FINAL (approve_certification), each confirmed with a reason. Self-approved
 *    and self-revalidated adjustments are disclosed before FINAL and in the sealed pack.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/workbench/DataTable";
import { adjustmentsClient, type AdjustmentsSummary } from "@/lib/closeReview/adjustments";
import { SOLO_OWNER_CONFIRMATION, type Readiness, type SavedVersion, type SignoffPolicy, type SignoffPolicyState } from "@/lib/reporting/signoff";
import { adjustmentDisclosures } from "@/lib/reporting/disclosures";
import { blockerText } from "@/lib/reporting/blockers";
import { Notice, type PageProps } from "./shared";
import { EvidenceIntake } from "./EvidenceIntake";

export function SignoffView(p: PageProps) {
  const latest = p.state.latest?.version ?? null;
  const selectedNo = p.reportVersion ?? latest?.reportVersion ?? null;
  const selected = p.state.versions.find((v) => v.reportVersion === selectedNo) ?? null;
  return (
    <div className="space-y-6 text-sm">
      <SignoffPolicyPanel {...p} />
      <EvidenceIntake {...p} mode="summary" />
      <Versions {...p} selected={selected} />
      {selected ? <Readiness_ {...p} version={selected} isLatest={selected.reportVersion === latest?.reportVersion} /> : <p>No report version is saved yet.</p>}
    </div>
  );
}

/**
 * The statement sign-off policy (20261024100000). Separate approvers by default: the final approval is recorded by
 * someone other than the reviewer. The owner may record both only under the solo-owner policy, set by a member who
 * manages members, with a reason and the exact confirmation; every pack signed that way discloses it.
 */
const POLICY_WORDS: Record<SignoffPolicy, string> = {
  separate_approvers: "Separate approvers — the final approval is recorded by someone other than the reviewer.",
  solo_owner: "Solo owner — the owner may both review and approve; every pack signed this way discloses it.",
};
const POLICY_OUTCOMES: Record<string, string> = {
  forbidden: "Only a member who manages members can change the sign-off policy.", feature_disabled: "Reporting is not enabled for this company.",
  confirmation_required: "The solo-owner policy needs the confirmation.", invalid_request: "A reason of at least 8 characters is required.",
  request_reused: "That request was already used for a different change; try again.",
};
function SignoffPolicyPanel(p: PageProps) {
  const [state, setState] = useState<SignoffPolicyState | null>(null);
  const [target, setTarget] = useState<SignoffPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setState(await p.clients.signoff.signoffPolicy(p.companyId)), [p.clients, p.companyId]);
  useEffect(() => { void load().catch((e) => setNotice((e as Error).message)); }, [load]);
  if (!state) return null;
  const policy: SignoffPolicy = state.policy ?? "separate_approvers";
  const other: SignoffPolicy = policy === "solo_owner" ? "separate_approvers" : "solo_owner";
  const change = async (reason: string) => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await p.clients.signoff.setSignoffPolicy(p.companyId, target, reason, target === "solo_owner" ? SOLO_OWNER_CONFIRMATION : null, crypto.randomUUID());
      setNotice(r.outcome === "recorded" ? "The sign-off policy is recorded." : POLICY_OUTCOMES[r.outcome] ?? `Not recorded (${r.outcome}).`);
      await load();
    } catch (e) { setNotice(`Not recorded: ${(e as Error).message}`); }
    finally { setBusy(false); setTarget(null); }
  };
  return (
    <section aria-labelledby="h-policy" data-testid="signoff-policy" data-policy={policy}>
      <h2 id="h-policy" className="text-base font-semibold">Sign-off policy</h2>
      <p>{POLICY_WORDS[policy]}{state.recorded ? <span className="text-muted-foreground"> Recorded {String(state.setAt ?? "").slice(0, 10)}{state.reason ? `: ${state.reason}` : ""}.</span> : <span className="text-muted-foreground"> (Default.)</span>}</p>
      {p.allowed.includes("manage_members") ? (
        <button type="button" className="mt-2 rounded-md border border-input px-3 py-1.5" onClick={() => setTarget(other)} data-testid="change-signoff-policy">
          {other === "solo_owner" ? "Allow the owner to review and approve (solo owner)" : "Require separate approvers"}
        </button>
      ) : null}
      <Notice text={notice} />
      <ConfirmDialog open={target !== null} title={target === "solo_owner" ? "Allow solo-owner sign-off" : "Require separate approvers"} period={`FY${p.periodYear}`} version="All versions signed from now on"
        consequences={target === "solo_owner" ? "The owner may record both the review and the final approval. Each pack signed that way names the owner as both and states this policy with its reason." : "The final approval must be recorded by someone other than the reviewer."}
        reasonMinLength={8} reasonLabel="Reason" confirmLabel="Record the policy" busy={busy}
        acknowledgement={target === "solo_owner" ? SOLO_OWNER_CONFIRMATION : undefined}
        onConfirm={(reason) => void change(reason)} onCancel={() => setTarget(null)} />
    </section>
  );
}

type VRow = SavedVersion;
function Versions(p: PageProps & { selected: SavedVersion | null }) {
  if (p.state.versions.length === 0) return null;
  const columns: DataColumn<VRow>[] = [
    { id: "v", header: "Version", render: (v) => <Link to={p.hrefFor("signoff", v.reportVersion)} aria-current={p.selected?.reportVersion === v.reportVersion ? "true" : undefined} className="text-primary underline">Version {v.reportVersion}</Link> },
    { id: "state", header: "State", render: (v) => (v.state === "DRAFT" ? "Draft" : v.state === "REVIEWED" ? "Reviewed" : "Final (sealed)") },
    { id: "at", header: "Saved", render: (v) => v.createdAt.slice(0, 16).replace("T", " ") },
    { id: "by", header: "By", render: (v) => `${v.creatorRole ?? "member"} ${v.creatorRef}` },
    { id: "latest", header: "", render: (v) => (v.isLatest ? "Latest" : "") },
  ];
  const rows = [...p.state.versions].sort((a, b) => b.reportVersion - a.reportVersion);
  return (
    <section aria-labelledby="h-v">
      <h2 id="h-v" className="text-base font-semibold">Report versions</h2>
      <DataTable label="Report versions" columns={columns} rows={rows} rowId={(v) => `${v.reportId}:${v.reportVersion}`} maxHeight={260} />
    </section>
  );
}

function Readiness_(p: PageProps & { version: SavedVersion; isLatest: boolean }) {
  const [r, setR] = useState<Readiness | null>(null);
  const [adj, setAdj] = useState<AdjustmentsSummary | null>(null);
  const [confirm, setConfirm] = useState<null | "REVIEWED" | "FINAL">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const adjClient = useMemo(() => adjustmentsClient(p.db as unknown as Parameters<typeof adjustmentsClient>[0]), [p.db]);
  const load = useCallback(async () => {
    setR(await p.clients.signoff.readiness(p.companyId, p.version.reportId, p.version.reportVersion));
    setAdj(await adjClient.summary(p.companyId, p.periodYear).catch(() => null));
  }, [p.clients, p.companyId, p.periodYear, p.version, adjClient]);
  useEffect(() => { void load().catch((e) => setNotice((e as Error).message)); }, [load, p.state]);
  const disclosures = adjustmentDisclosures(adj);
  const sign = async (state: "REVIEWED" | "FINAL", reason: string) => {
    setBusy(true);
    try {
      await p.clients.signoff.setState(p.companyId, p.version.reportId, p.version.reportVersion, state, reason);
      setNotice(state === "REVIEWED" ? `Version ${p.version.reportVersion} is reviewed.` : `Version ${p.version.reportVersion} is final and sealed.`);
      await p.refresh();
    } catch (e) { setNotice(`Not recorded: ${(e as Error).message.replace(/^[a-z_]+: /, "")}`); await load(); }
    finally { setBusy(false); setConfirm(null); }
  };
  if (!r) return <p role="status">Reading the version's readiness…</p>;
  const next = p.version.state === "DRAFT" ? "REVIEWED" : p.version.state === "REVIEWED" ? "FINAL" : null;
  const allowed = next === "REVIEWED" ? p.allowed.includes("review_close") : next === "FINAL" ? p.allowed.includes("approve_certification") : false;
  return (
    <section aria-labelledby="h-r" data-testid="readiness" data-ready={r.ready}>
      <h2 id="h-r" className="text-base font-semibold">Version {p.version.reportVersion} — {p.version.state === "FINAL" ? "final and sealed" : r.ready ? "ready" : `${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"}`}</h2>
      {r.blockers.length ? (
        <>
          <ul className="list-disc pl-5" data-testid="blockers">{r.blockers.map((b) => <li key={b}>{blockerText(b)}</li>)}</ul>
          <details className="mt-1 text-xs text-muted-foreground" data-testid="blocker-codes">
            <summary>Technical details</summary>
            <ul className="ml-4 list-disc">{r.blockers.map((b) => <li key={b}><code>{b}</code></li>)}</ul>
          </details>
        </>
      ) : null}
      {disclosures.length ? (
        <div className="mt-2 border-l-[3px] border-[#7a4a00] bg-[#fdf8ee] px-3 py-2" data-testid="self-approval-disclosure">
          <p className="font-medium">Disclosed in the sign-off pack:</p>
          <ul className="list-disc pl-5">{disclosures.map((d) => <li key={d.number}>Adjustment {d.number}: {[d.selfApproved ? "self-approved" : null, d.selfRevalidated ? "self-revalidated" : null].filter(Boolean).join(" and ")} — {d.reason}</li>)}</ul>
        </div>
      ) : null}
      {next && p.isLatest ? (allowed ? (
        <button type="button" className="mt-3 rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" disabled={!r.ready || busy} onClick={() => setConfirm(next)} data-testid={`sign-${next.toLowerCase()}`}>
          {next === "REVIEWED" ? "Mark reviewed" : "Approve as final"}
        </button>
      ) : <p className="mt-2 text-muted-foreground">{next === "REVIEWED" ? "A reviewer marks the version reviewed." : "A partner approves the version as final."}</p>) : null}
      {p.version.state === "FINAL" ? <p className="mt-2"><Link className="text-primary underline" to={p.hrefFor("exports", p.version.reportVersion)}>Export the sealed report →</Link></p> : null}
      <Notice text={notice} />
      <ConfirmDialog open={confirm !== null} title={confirm === "FINAL" ? "Approve as final" : "Mark reviewed"} period={`FY${p.periodYear}`} version={`Version ${p.version.reportVersion}`}
        consequences={confirm === "FINAL" ? "The version is sealed: it can never change. A later change to the statements, notes or comparatives needs a new version and a new sign-off." : "The version is recorded as reviewed against its evidence. Final approval is a separate step."}
        reasonMinLength={3} reasonLabel="Reason" confirmLabel={confirm === "FINAL" ? "Approve as final" : "Mark reviewed"} busy={busy}
        acknowledgement={confirm === "FINAL" && disclosures.length ? `I have read the ${disclosures.length} disclosed self-approval/self-revalidation item(s); they are printed in the sealed pack.` : undefined}
        onConfirm={(reason) => confirm && void sign(confirm, reason)} onCancel={() => setConfirm(null)} />
    </section>
  );
}
