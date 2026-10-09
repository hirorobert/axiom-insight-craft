/**
 * Sign-off & Exports › Sign-off. Saves report versions and signs them through the ONE canonical path.
 *
 *  - Evidence: the cash-flow and changes-in-equity statements are built from evidence (transaction ledgers, equity
 *    movements, the cash account map, the signed prior-year statements' opening cash). Files are parsed in the browser
 *    and stored only by the atomic commit that saves the version — never on their own.
 *  - Save: the version is assembled from the server's current composition, notes and dependencies and committed with its
 *    evaluation in one server call; a retry repeats the same attempt.
 *  - Readiness: the server's blockers for the selected version, as returned.
 *  - Sign-off: REVIEWED (review_close), then FINAL (approve_certification), each confirmed with a reason. Self-approved
 *    and self-revalidated adjustments are disclosed before FINAL and in the sealed pack.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "@/components/workbench/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/workbench/DataTable";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import { EVIDENCE_TYPE_LABELS, type EvidenceBatch, type EvidenceType, type PeriodRole } from "@/lib/financialEvidence/types";
import { adjustmentsClient, type AdjustmentsSummary } from "@/lib/closeReview/adjustments";
import { latestEvidence, SOLO_OWNER_CONFIRMATION, type Readiness, type SavedVersion, type SignoffPolicy, type SignoffPolicyState, type StoredEvidence } from "@/lib/reporting/signoff";
import { prepareReportVersion } from "@/lib/reporting/prepareVersion";
import { adjustmentDisclosures } from "@/lib/reporting/disclosures";
import { blockerText } from "@/lib/reporting/blockers";
import { Notice, type PageProps } from "./shared";

const SLOTS: readonly { type: EvidenceType; role: PeriodRole; what: string }[] = [
  { type: "TRANSACTION_LEDGER", role: "CURRENT", what: "this year's cash transactions" },
  { type: "EQUITY_MOVEMENTS", role: "CURRENT", what: "this year's equity movements" },
  { type: "CASH_ACCOUNT_MAP", role: "CURRENT", what: "which accounts are cash and how they enter the cash flow" },
  { type: "TRANSACTION_LEDGER", role: "COMPARATIVE", what: "the prior year's cash transactions" },
  { type: "EQUITY_MOVEMENTS", role: "COMPARATIVE", what: "the prior year's equity movements" },
  { type: "PRIOR_PERIOD_STATEMENTS", role: "COMPARATIVE", what: "the signed prior-year statements (opening cash of the prior year)" },
];
const slotKey = (t: EvidenceType, r: PeriodRole) => `${t}|${r}`;

export function SignoffView(p: PageProps) {
  const reportId = p.state.versions[0]?.reportId ?? `fsr-${p.periodYear}-${p.companyId}`;
  const latest = p.state.latest?.version ?? null;
  const selectedNo = p.reportVersion ?? latest?.reportVersion ?? null;
  const selected = p.state.versions.find((v) => v.reportVersion === selectedNo) ?? null;
  return (
    <div className="space-y-6 text-sm">
      <SignoffPolicyPanel {...p} />
      <Evidence {...p} reportId={reportId} latest={latest} />
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

function Evidence(p: PageProps & { reportId: string; latest: SavedVersion | null }) {
  const [stored, setStored] = useState<StoredEvidence[] | null>(null);
  const [parsed, setParsed] = useState<Record<string, { batch: EvidenceBatch | null; problems: string[]; file: string }>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const attempt = useRef<{ key: string; id: string; at: string } | null>(null);
  const [picks, setPicks] = useState(0); // remounts the file inputs after a save, so no stale file name is shown
  const load = useCallback(async () => { setStored(latestEvidence(await p.clients.signoff.evidence(p.companyId, `FY${p.periodYear}`))); }, [p.clients, p.companyId, p.periodYear]);
  useEffect(() => { void load().catch(() => setStored([])); }, [load, p.state]);
  const canPrepare = p.allowed.includes("prepare_close");
  const year = (r: PeriodRole) => (r === "CURRENT" ? p.periodYear : p.periodYear - 1);
  const pick = async (t: EvidenceType, r: PeriodRole, f: File) => {
    const text = await f.text();
    const res = ingestEvidence({ companyId: p.companyId, evidenceType: t, periodRole: r, reportingPeriodId: `FY${p.periodYear}`, text, fileName: f.name, mimeType: f.type || "text/csv",
      currency: p.state.composition?.state === "composed" ? p.state.composition.current.currency : undefined, scale: p.state.composition?.state === "composed" ? p.state.composition.current.exponent : undefined,
      periodStart: `${year(r)}-01-01`, periodEnd: `${year(r)}-12-31` });
    const problems = (res.outcome === "PARSED" ? res.batch.diagnostics : res.diagnostics).filter((d) => d.severity === "ERROR").map((d) => d.message);
    setParsed((x) => ({ ...x, [slotKey(t, r)]: { batch: res.outcome === "PARSED" && problems.length === 0 ? res.batch : null, problems, file: f.name } }));
  };
  const ready = Object.values(parsed).filter((x) => x.batch).map((x) => x.batch!);
  const save = async () => {
    setBusy(true); setNotice(null); setDiagnostics([]);
    // One attempt per set of files: a retry (after any failure) resumes it; the server's versions decide where it continues.
    const key = JSON.stringify(ready.map((b) => b.evidenceBatchId));
    if (!attempt.current || attempt.current.key !== key) attempt.current = { key, id: `fsr-save-${(p.newRequestId ?? (() => crypto.randomUUID()))()}`, at: new Date().toISOString() };
    try {
      const r = await prepareReportVersion(p.db, p.clients.signoff, { companyId: p.companyId, periodYear: p.periodYear, legalName: p.legalName, reportId: p.reportId,
        newEvidence: ready, idempotencyKey: attempt.current.id, evaluatedAt: attempt.current.at });
      setDiagnostics(r.diagnostics.filter((d) => d.severity !== "INFO").map((d) => d.message));
      if (r.outcome === "saved") {
        attempt.current = null; setParsed({}); setPicks((n) => n + 1);
        setNotice(r.alreadyCurrent ? `Version ${r.reportVersion} is already saved on the current statements, notes and comparatives; nothing new was written.`
          : r.evidenceVersion ? `Version ${r.evidenceVersion} stored the evidence; version ${r.reportVersion} is saved on the dependencies it changed.` : `Version ${r.reportVersion} saved.`);
        await p.refresh();
      } else setNotice(`Not saved: ${r.reason}`);
    } catch (e) {
      // Nothing half-done is left signable: a stored-evidence version is stale until the next step. "Save" again resumes.
      setNotice(/STALE_REPORT_VERSION/.test(String((e as Error).message)) ? "Not finished: another version was saved meanwhile. Press save again to continue from it." : `Not finished: ${(e as Error).message} Press save again to continue; nothing is duplicated.`);
      await p.refresh();
    } finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="h-ev" data-testid="evidence">
      <h2 id="h-ev" className="text-base font-semibold">Evidence for the cash-flow and changes-in-equity statements</h2>
      <p className="text-muted-foreground">CSV files. Nothing is stored until a version is saved; the latest stored file of each kind is used.</p>
      <table className="mt-2 w-full text-sm">
        <thead><tr><th className="text-left">Evidence</th><th className="text-left">Stored</th>{canPrepare ? <th className="text-left">Replace or add</th> : null}</tr></thead>
        <tbody>
          {SLOTS.map((s) => {
            const st = stored?.find((x) => x.batch.evidenceType === s.type && x.batch.periodRole === s.role);
            const pr = parsed[slotKey(s.type, s.role)];
            return (
              <tr key={slotKey(s.type, s.role)} className="border-t border-border align-top">
                <td className="py-1 pr-2">{EVIDENCE_TYPE_LABELS[s.type]} — FY{year(s.role)}<span className="block text-xs text-muted-foreground">{s.what}</span></td>
                <td className="py-1 pr-2">{stored === null ? "…" : st ? <>{st.batch.sourceFileName ?? "file"} (version {st.version}, {st.batch.validationStatus.toLowerCase().replace(/_/g, " ")})</> : <span className="text-muted-foreground">None</span>}</td>
                {canPrepare ? (
                  <td className="py-1">
                    <input key={picks} type="file" accept=".csv,text/csv" aria-label={`${EVIDENCE_TYPE_LABELS[s.type]} FY${year(s.role)}`} data-slot={slotKey(s.type, s.role)}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(s.type, s.role, f); }} />
                    {pr ? (pr.batch ? <span className="block text-xs text-[#22663f]" data-parsed="ok">✓ {pr.file}: {pr.batch.document.rows.length} rows ready</span>
                      : <span className="block text-xs text-[#a12020]" role="alert">✕ {pr.file}: {pr.problems.slice(0, 3).join(" ")}</span>) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {canPrepare ? (
        <button type="button" className="mt-3 rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" disabled={busy || Object.values(parsed).some((x) => !x.batch)} onClick={() => void save()} data-testid="save-version">
          {busy ? "Saving…" : p.latest ? "Save a new report version" : "Save the first report version"}
        </button>
      ) : <p className="mt-2 text-muted-foreground">A preparer saves report versions.</p>}
      <Notice text={notice} />
      {diagnostics.length ? <ul className="mt-1 list-disc pl-5 text-xs" aria-label="Diagnostics">{diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
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
      {r.blockers.length ? <ul className="list-disc pl-5" data-testid="blockers">{r.blockers.map((b) => <li key={b}>{blockerText(b)} <code className="text-xs text-muted-foreground">{b}</code></li>)}</ul> : null}
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
