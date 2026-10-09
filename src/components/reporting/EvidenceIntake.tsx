/**
 * Evidence for the cash-flow and changes-in-equity statements, collected while the statements are prepared
 * (Financial Statements › Statements) and summarised, read-only, on Sign-off.
 *
 * The evidence contract is unchanged: files are parsed in the browser and stored ONLY by the atomic commit that saves a
 * report version (prepareReportVersion → fs_commit_revision) — never on their own, and the saved version binds the exact
 * batches it used (SavedVersion.evidenceBatchIds). Each file's state is therefore stated explicitly:
 *   Selected     a file was chosen and is being read in this browser
 *   Validated    read in this browser with no error — NOT stored yet
 *   Rejected     read with errors; nothing will be stored
 *   Stored       held by the server (evidence version n)
 *   In version N the latest saved report version is bound to it
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ingestEvidence } from "@/lib/financialEvidence/intake";
import { EVIDENCE_TYPE_LABELS, type EvidenceBatch, type EvidenceType, type PeriodRole } from "@/lib/financialEvidence/types";
import { latestEvidence, type StoredEvidence } from "@/lib/reporting/signoff";
import { prepareReportVersion } from "@/lib/reporting/prepareVersion";
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

const EVIDENCE_STATE_WORDS = {
  none: "Not provided",
  selected: "Selected — reading the file",
  validated: "Validated in this browser — not stored yet",
  rejected: "Rejected — nothing will be stored",
  stored: "Stored — not in the latest saved version",
  bound: (v: number) => `Stored — in version ${v}`,
} as const;

type Picked = { state: "selected" | "validated" | "rejected"; batch: EvidenceBatch | null; problems: string[]; file: string };

export function EvidenceIntake(p: PageProps & { mode: "prepare" | "summary" }) {
  const reportId = p.state.versions[0]?.reportId ?? `fsr-${p.periodYear}-${p.companyId}`;
  const latest = p.state.latest?.version ?? null;
  const [stored, setStored] = useState<StoredEvidence[] | null>(null);
  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const attempt = useRef<{ key: string; id: string; at: string } | null>(null);
  const [picks, setPicks] = useState(0); // remounts the file inputs after a save, so no stale file name is shown
  const load = useCallback(async () => { setStored(latestEvidence(await p.clients.signoff.evidence(p.companyId, `FY${p.periodYear}`))); }, [p.clients, p.companyId, p.periodYear]);
  useEffect(() => { void load().catch(() => setStored([])); }, [load, p.state]);
  const canPrepare = p.allowed.includes("prepare_close") && p.mode === "prepare";
  const year = (r: PeriodRole) => (r === "CURRENT" ? p.periodYear : p.periodYear - 1);
  // Each file is checked against the period's RECORDED dates (fs_reporting_input) — a July–June company's ledger is never
  // judged against January–December. Unknown dates are refused, never assumed.
  const [dates, setDates] = useState<Record<PeriodRole, { start: string; end: string } | null> | null>(null);
  useEffect(() => {
    let live = true;
    const d = (x: { reportingStart?: string | null; reportingEnd?: string | null } | null | undefined) => (x?.reportingStart && x?.reportingEnd ? { start: x.reportingStart.slice(0, 10), end: x.reportingEnd.slice(0, 10) } : null);
    p.clients.signoff.input(p.companyId, p.periodYear).then(
      (i) => { if (live) setDates({ CURRENT: d(i.current), COMPARATIVE: d(i.comparative) }); },
      () => { if (live) setDates({ CURRENT: null, COMPARATIVE: null }); },
    );
    return () => { live = false; };
  }, [p.clients, p.companyId, p.periodYear]);
  const pick = async (t: EvidenceType, r: PeriodRole, f: File) => {
    setPicked((x) => ({ ...x, [slotKey(t, r)]: { state: "selected", batch: null, problems: [], file: f.name } }));
    const period = dates?.[r] ?? null;
    if (!period) {
      setPicked((x) => ({ ...x, [slotKey(t, r)]: { state: "rejected", batch: null, file: f.name,
        problems: [`The FY${year(r)} reporting period's dates are not recorded, so the file cannot be checked against them. Set the period in Trial Balance › Intake.`] } }));
      return;
    }
    const text = await f.text();
    const res = ingestEvidence({ companyId: p.companyId, evidenceType: t, periodRole: r, reportingPeriodId: `FY${p.periodYear}`, text, fileName: f.name, mimeType: f.type || "text/csv",
      currency: p.state.composition?.state === "composed" ? p.state.composition.current.currency : undefined, scale: p.state.composition?.state === "composed" ? p.state.composition.current.exponent : undefined,
      periodStart: period.start, periodEnd: period.end });
    const problems = (res.outcome === "PARSED" ? res.batch.diagnostics : res.diagnostics).filter((d) => d.severity === "ERROR").map((d) => d.message);
    const ok = res.outcome === "PARSED" && problems.length === 0;
    setPicked((x) => ({ ...x, [slotKey(t, r)]: { state: ok ? "validated" : "rejected", batch: ok ? res.batch : null, problems, file: f.name } }));
  };
  const ready = Object.values(picked).filter((x) => x.batch).map((x) => x.batch!);
  const save = async () => {
    setBusy(true); setNotice(null); setDiagnostics([]);
    // One attempt per set of files: a retry (after any failure) resumes it; the server's versions decide where it continues.
    const key = JSON.stringify(ready.map((b) => b.evidenceBatchId));
    if (!attempt.current || attempt.current.key !== key) attempt.current = { key, id: `fsr-save-${(p.newRequestId ?? (() => crypto.randomUUID()))()}`, at: new Date().toISOString() };
    try {
      const r = await prepareReportVersion(p.db, p.clients.signoff, { companyId: p.companyId, periodYear: p.periodYear, legalName: p.legalName, reportId,
        newEvidence: ready, idempotencyKey: attempt.current.id, evaluatedAt: attempt.current.at });
      setDiagnostics(r.diagnostics.filter((d) => d.severity !== "INFO").map((d) => d.message));
      if (r.outcome === "saved") {
        attempt.current = null; setPicked({}); setPicks((n) => n + 1);
        setNotice(r.alreadyCurrent ? `Version ${r.reportVersion} is already saved on the current statements, notes and comparatives; nothing new was written.`
          : r.evidenceVersion ? `The evidence is stored (version ${r.evidenceVersion}); draft version ${r.reportVersion} is saved on it.` : `Draft version ${r.reportVersion} saved.`);
        await p.refresh();
      } else setNotice(`Not saved: ${r.reason}`);
    } catch (e) {
      // Nothing half-done is left signable: a stored-evidence version is stale until the next step. "Save" again resumes.
      setNotice(/STALE_REPORT_VERSION/.test(String((e as Error).message)) ? "Not finished: another version was saved meanwhile. Press save again to continue from it." : `Not finished: ${(e as Error).message} Press save again to continue; nothing is duplicated.`);
      await p.refresh();
    } finally { setBusy(false); }
  };
  const stateOf = (st: StoredEvidence | undefined, pr: Picked | undefined): string => {
    if (pr) return EVIDENCE_STATE_WORDS[pr.state];
    if (!st) return EVIDENCE_STATE_WORDS.none;
    return latest && latest.evidenceBatchIds.includes(st.batch.evidenceBatchId) ? EVIDENCE_STATE_WORDS.bound(latest.reportVersion) : EVIDENCE_STATE_WORDS.stored;
  };
  const pending = Object.values(picked);
  return (
    <section aria-labelledby="h-ev" data-testid="evidence" data-mode={p.mode}>
      <h2 id="h-ev" className="text-base font-semibold">Evidence for the cash-flow and changes-in-equity statements</h2>
      {p.mode === "prepare" ? (
        <p className="text-muted-foreground">CSV files. A chosen file is read and validated in this browser; it is stored only together with a saved draft version, in one server step. The latest stored file of each kind is used.</p>
      ) : (
        <p className="text-muted-foreground">Collected in <Link className="text-primary underline" to={p.hrefFor("fs-statements", p.reportVersion)}>Financial Statements › Statements</Link>. Shown here for readiness only.</p>
      )}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="text-left">Evidence</th><th className="text-left">State</th><th className="text-left">File</th>{canPrepare ? <th className="text-left">Replace or add</th> : null}</tr></thead>
          <tbody>
            {SLOTS.map((s) => {
              const st = stored?.find((x) => x.batch.evidenceType === s.type && x.batch.periodRole === s.role);
              const pr = picked[slotKey(s.type, s.role)];
              return (
                <tr key={slotKey(s.type, s.role)} className="border-t border-border align-top" data-evidence-state={pr ? pr.state : st ? "stored" : "none"}>
                  <td className="py-1 pr-2">{EVIDENCE_TYPE_LABELS[s.type]} — FY{year(s.role)}<span className="block text-xs text-muted-foreground">{s.what}</span></td>
                  <td className="py-1 pr-2">{stored === null ? "…" : stateOf(st, pr)}
                    {pr?.state === "rejected" ? <span className="block text-xs text-[#a12020]" role="alert">{pr.problems.slice(0, 3).join(" ")}</span> : null}</td>
                  <td className="py-1 pr-2">{pr ? pr.file : st ? <>{st.batch.sourceFileName ?? "file"} <span className="text-xs text-muted-foreground">(evidence version {st.version})</span></> : <span className="text-muted-foreground">—</span>}</td>
                  {canPrepare ? (
                    <td className="py-1">
                      <input key={picks} type="file" accept=".csv,text/csv" aria-label={`${EVIDENCE_TYPE_LABELS[s.type]} FY${year(s.role)}`} data-slot={slotKey(s.type, s.role)}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(s.type, s.role, f); }} />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canPrepare ? (
        <>
          <button type="button" className="mt-3 rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
            disabled={busy || pending.length === 0 || pending.some((x) => x.state !== "validated")} onClick={() => void save()} data-testid="store-evidence">
            {busy ? "Saving…" : "Store the evidence and save a draft version"}
          </button>
          {pending.length > 0 && pending.some((x) => x.state === "validated") ? <p className="mt-1 text-xs text-muted-foreground" data-testid="evidence-unsaved">Validated files are not stored until you save.</p> : null}
        </>
      ) : p.mode === "summary" && p.allowed.includes("prepare_close") ? (
        <button type="button" className="mt-3 rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" disabled={busy} onClick={() => void save()} data-testid="save-version">
          {busy ? "Saving…" : latest ? "Save a new report version" : "Save the first report version"}
        </button>
      ) : p.mode === "summary" ? <p className="mt-2 text-muted-foreground">A preparer saves report versions.</p> : null}
      <Notice text={notice} />
      {diagnostics.length ? <ul className="mt-1 list-disc pl-5 text-xs" aria-label="Diagnostics">{diagnostics.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
    </section>
  );
}
