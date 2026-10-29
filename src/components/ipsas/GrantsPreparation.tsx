/**
 * IPSAS accrual grants and revenue — agreement/evidence → period-specific assessment → obligations and satisfaction evidence →
 * server-calculated revenue, receivable and liability → reconciliation → generated note and remaining tasks. Everything shown as
 * calculated, confirmed or tied is what the SERVER returned; this component edits a payload, saves it with an expected revision and a
 * request identity, and displays the answer. Revenue is never derived from cash received or money spent; the form says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { afterFailure, afterReceipt, grantsClient, refusalWords, type GrantsContext, type SaveState } from "@/lib/ipsasAccrual/ipsasClient";
import { emptyGrant, emptyGrantsDraft, emptyObligation, fromMinor, newId, PRESENTATION, stableJson, type GrantsDraft } from "@/lib/ipsasAccrual/draft";
import { CLASSIFICATIONS_23, CLASSIFICATIONS_47, COMPLEXITIES, COMPLEXITY_LABELS, GRANT_ENTITY_QUESTIONS, SATISFACTION_BASES, computeGrants, generateGrantsNote, grantTasks, type Grant, type GrantsInput } from "@/lib/ipsasAccrual/grants";
import type { PrepTask } from "@/lib/ipsasAccrual/preview";
import { Amount, Select, Text } from "./fields";

const WORDS: Record<string, string> = {
  "restriction-only": "Restriction only — use is restricted, nothing must be returned", "enforceable-condition": "Condition — resources must be returned if the condition is not met",
  "binding-arrangement": "Binding arrangement with performance obligations", "without-binding-with-present-obligation": "No binding arrangement, but a present obligation",
  "without-binding-no-present-obligation": "No binding arrangement and no present obligation",
};
const BASIS_WORDS: Record<string, string> = { "milestone-delivered": "Milestone delivered and accepted", "output-measure": "Output measure achieved", "time-elapsed": "Time elapsed (agreement says so)", "agreement-stated-expenditure": "Expenditure the agreement itself names" };

function Banner({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state.kind === "idle") return null;
  const base = "rounded-md border px-3 py-2 text-sm";
  if (state.kind === "pending") return <p role="status" className={`${base} border-border`}>Saving…</p>;
  if (state.kind === "saved") return <p role="status" className={`${base} border-green-600/40`}>Saved{state.replay ? " (this request had already been recorded)" : ""}. This is the server's recorded version.</p>;
  if (state.kind === "refused") return <p role="alert" className={`${base} border-destructive/50`}>{refusalWords(state.outcome)}</p>;
  return (
    <div role="alert" className={`${base} border-amber-500/60`}>
      <p>We could not confirm whether this was saved. Nothing is assumed either way.</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>Send the same request again</Button>
    </div>
  );
}

export interface GrantsPreparationProps {
  companyId: string; periodYear: number; legalName: string; db: Pick<ReportingDb, "rpc">; canPrepare: boolean; canConfirm: boolean;
  /** Which area of the page is showing; the component always loads so it can report the next task, but draws only in prepare/review. */
  area: "bring" | "prepare" | "review" | "approve" | "issue";
  onNextTask?: (t: PrepTask | null) => void;
}

export function GrantsPreparation({ companyId, periodYear, legalName, db, canPrepare, canConfirm, area, onNextTask }: GrantsPreparationProps) {
  const client = useMemo(() => grantsClient(db), [db]);
  const [ctx, setCtx] = useState<GrantsContext | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState<GrantsDraft>(() => emptyGrantsDraft(companyId, periodYear));
  const [saves, setSaves] = useState<Record<string, SaveState>>({});
  const identities = useRef<Record<string, { id: string; fp: string }>>({});
  const scope = useRef(`${companyId}:${periodYear}`);
  scope.current = `${companyId}:${periodYear}`;

  const refresh = useCallback(async (reset: boolean) => {
    const mine = `${companyId}:${periodYear}`;
    try {
      const r = await client.context(companyId, periodYear);
      if (scope.current !== mine) return; // a late answer for another company or year is discarded
      if (r.outcome !== "available") { setProblem(refusalWords(r.outcome)); setCtx(null); return; }
      const c = r as GrantsContext;
      setProblem(null); setCtx(c);
      if (reset) setDraft((c.register?.payload as unknown as GrantsDraft) ?? emptyGrantsDraft(companyId, periodYear));
    } catch { if (scope.current === mine) setProblem("We could not read the saved grants. Nothing has changed."); }
  }, [client, companyId, periodYear]);
  useEffect(() => { setCtx(null); setSaves({}); identities.current = {}; void refresh(true); }, [refresh]);

  const saved = (ctx?.register?.payload as unknown as GrantsDraft | undefined) ?? null;
  const dirty = stableJson(draft) !== stableJson(saved ?? emptyGrantsDraft(companyId, periodYear));
  const live = ctx?.live ?? null;
  const model = live?.assessment?.model ?? null;

  // The review is built from what the SERVER holds, never from unsaved edits.
  const review = useMemo(() => {
    if (!ctx || !saved || !live?.assessment) return null;
    const input: GrantsInput = {
      period: live.period.start ? { start: live.period.start, end: live.period.end ?? live.period.start } : null, entityAnswers: saved.entityAnswers as GrantsInput["entityAnswers"],
      tb: { revenueMinor: live.tb?.revenueMinor ?? null, liabilityMinor: live.tb?.liabilityMinor ?? null, receivableMinor: live.tb?.receivableMinor ?? null },
      grants: saved.grants.map((g) => ({ ...g, assessmentConfirmed: live.confirmedGrants[g.grantId] === true })),
    };
    const result = computeGrants(input);
    const here = [...new Set(result.issues.map((i) => `${i.code}|${i.grantId ?? ""}`))].sort().join();
    return { input, result, note: generateGrantsNote(input, result, PRESENTATION, legalName), tasks: grantTasks(result), agrees: here === [...live.assessment.codes].sort().join() };
  }, [ctx, saved, live, legalName]);
  const nextTask = review?.tasks[0] ?? null;
  const unsavedNothing = ctx !== null && !saved ? ({ id: "grants:none", title: "Record the grants", missing: "No grant register is saved yet. Record each grant or donor agreement, or state that there are none.", why: "Grant revenue and any unfulfilled obligation depend on it.", acceptedEvidence: "Signed agreements.", responsible: "preparer", area: "prepare", target: "grants", status: "open", affects: ["Grant revenue"] } as PrepTask) : null;
  const reported = nextTask ?? unsavedNothing;
  useEffect(() => { onNextTask?.(reported); }, [reported?.id, onNextTask]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fp: string, call: (requestId: string) => Promise<{ outcome?: string; revisionId?: string; confirmationId?: string; replay?: boolean }>, resetAfter: boolean) => {
    const cur = identities.current[key];
    const id = cur && cur.fp === fp ? cur.id : newId(); // an unknown outcome retries with the ORIGINAL identity
    identities.current[key] = { id, fp };
    setSaves((s) => ({ ...s, [key]: { kind: "pending", requestId: id } }));
    try {
      const next = afterReceipt(id, await call(id));
      setSaves((s) => ({ ...s, [key]: next }));
      if (next.kind !== "unknown") delete identities.current[key];
      if (next.kind === "saved") await refresh(resetAfter);
    } catch { setSaves((s) => ({ ...s, [key]: afterFailure(id) })); }
  };
  const save = () => { const expected = ctx?.register?.id ?? null; void run("save", stableJson({ draft, expected }), (rid) => client.save(companyId, periodYear, draft as unknown as Record<string, unknown>, expected, rid), true); };
  const confirm = (grantId: string) => { const rev = ctx?.register?.id; if (rev) void run(`confirm:${grantId}`, stableJson({ grantId, rev }), (rid) => client.confirm(companyId, periodYear, grantId, rev, rid), false); };

  if (area !== "prepare" && area !== "review") return null;
  if (problem) return <p role="alert" className="py-4 text-sm">{problem}</p>;
  if (!ctx) return <p role="status" className="py-4 text-sm text-muted-foreground">Loading the saved grants…</p>;
  const a = live?.assessment ?? null;
  const edit = canPrepare;
  const setGrant = (i: number, fn: (g: Grant) => Grant) => setDraft((d) => ({ ...d, grants: d.grants.map((g, j) => (j === i ? fn(structuredClone(g)) : g)) }));
  const vocab = model === "ipsas23" ? CLASSIFICATIONS_23 : model === "ipsas47" ? CLASSIFICATIONS_47 : [];

  if (area === "review") {
    return (
      <section aria-labelledby="grv-h" className="space-y-3">
        <h2 id="grv-h" className="text-lg font-medium">Grants and revenue</h2>
        {!review || !a ? <p className="text-sm">No grant register is saved yet.</p> : <>
          <p className="text-sm">Reporting period read from the certified trial balance: <strong>{live!.period.start ?? "unknown"}</strong> to {live!.period.end ?? "unknown"} — {model === "ipsas23" ? "the vocabulary for periods beginning before 1 January 2026" : model === "ipsas47" ? "the vocabulary for periods beginning on or after 1 January 2026" : "no vocabulary can be selected"}. Server state: <strong>{a.state}</strong>.</p>
          {!review.agrees && <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm">This page and the server disagree about which grant matters are open. The server's list stands: {a.codes.join(", ") || "none"}.</p>}
          <div className="rounded-md border p-3 text-sm space-y-2">
            <h3 className="font-medium">Grant revenue note (draft) — {review.note.label}</h3>
            {review.note.policy.map((p) => <p key={p.id} className={p.unresolved ? "text-amber-700" : ""}>{p.text}</p>)}
            {review.note.table && (
              <div data-testid="grants-note-table" role="region" aria-label="Grants table (scroll sideways on a narrow screen)" tabIndex={0} className="overflow-x-auto">
                <table className="w-full text-xs" aria-label="Grants">
                  <caption className="text-left font-medium">Grants and revenue by agreement</caption>
                  <thead><tr><th scope="col" className="text-left">Agreement</th>{review.note.table.columns.map((c) => <th key={c} scope="col" className="text-right">{c}</th>)}</tr></thead>
                  <tbody>{review.note.table.rows.map((r) => <tr key={r.label + (r.grantId ?? "")}><th scope="row" className="text-left font-normal">{r.label}</th>{r.cells.map((c, k) => <td key={k} className="text-right tabular-nums">{c ?? "—"}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="rounded-md border p-3 text-sm">
            <h3 className="font-medium">What remains for grants ({review.tasks.length})</h3>
            {review.tasks.length === 0 ? <p>No open grant matters in this slice.</p> : (
              <ul className="space-y-2">{review.tasks.map((t) => (
                <li key={t.id} className="rounded border p-2"><p><strong>{t.title}.</strong> {t.missing}</p><p className="text-xs text-muted-foreground">Why: {t.why} Evidence: {t.acceptedEvidence} Who: {t.responsible}. Affects: {t.affects.join(", ")}.</p></li>))}</ul>)}
          </div>
        </>}
      </section>
    );
  }

  const questions = GRANT_ENTITY_QUESTIONS.filter((q) => q.when === model);
  return (
    <section aria-labelledby="gr-h" className="space-y-4 border-t pt-4">
      <h2 id="gr-h" className="text-lg font-medium">Grants and revenue</h2>
      <p className="text-sm text-muted-foreground">Revenue is recognised only as the entity evidences that an obligation is satisfied (or, for a pure restriction or an arrangement with no present obligation, when the resources are recognised). Cash received and money spent never decide it. Arrangements with variable amounts, financing, agency, non-cash resources, modifications, collection doubt or another currency cannot be completed here and stay open.</p>
      <p className="text-sm" role="status">Reporting period (read from the certified trial balance, not typed): <strong>{live?.period.start ?? "unknown"}</strong> to {live?.period.end ?? "unknown"}. {model === "ipsas23" ? "Classifications for periods beginning before 1 January 2026 apply." : model === "ipsas47" ? "Classifications for periods beginning on or after 1 January 2026 apply." : "Upload and certify the trial balance first."}</p>
      <div className="rounded-md border p-3 space-y-3">
        <h3 className="font-medium">Which trial balance accounts hold grant revenue, unfulfilled obligations and grant receivables?</h3>
        <p className="text-xs text-muted-foreground">Account codes, comma separated. The server reads their certified balances; an absent account leaves the figure unknown.</p>
        {([["revenueKeys", "gtb-rev", "Grant revenue accounts"], ["liabilityKeys", "gtb-liab", "Unfulfilled grant obligation accounts"], ["receivableKeys", "gtb-recv", "Grant receivable accounts"]] as const).map(([k, id, name]) => (
          <Text key={id} id={id} name={name} value={draft.tbSelection[k].join(", ")} disabled={!edit} onChange={(v) => setDraft((d) => ({ ...d, tbSelection: { ...d.tbSelection, [k]: v.split(",").map((x) => x.trim()).filter(Boolean) } }))} />
        ))}
      </div>
      {draft.grants.map((g, i) => {
        const fig = a?.grants.find((f) => f.grantId === g.grantId);
        return (
          <fieldset key={g.grantId} className="space-y-3 rounded-md border p-3">
            <legend className="px-1 font-medium">{g.reference || `Grant ${i + 1}`}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Text id={`gr${i}-ref`} name="Agreement reference" value={g.reference} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, reference: v }))} />
              <Text id={`gr${i}-grantor`} name="Grantor" value={g.grantor} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, grantor: v }))} />
              <Text id={`gr${i}-agr`} name="Signed agreement or award letter" value={g.agreementEvidence} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, agreementEvidence: v }))} />
            </div>
            <Select id={`gr${i}-class`} name="Classification for this period (the agreement's terms decide it, not the cash)" value={g.classification} disabled={!edit || vocab.length === 0}
              onChange={(v) => setGrant(i, (x) => ({ ...x, classification: v as Grant["classification"] }))} options={vocab.map((c) => [c, WORDS[c]] as [string, string])} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Text id={`gr${i}-basis`} name="Why it is classified this way (rights, obligations, any return clause)" value={g.classificationBasis} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, classificationBasis: v }))} />
              <Text id={`gr${i}-cev`} name="Agreement clauses relied on" value={g.classificationEvidence} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, classificationEvidence: v }))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <Amount id={`gr${i}-cons`} name="Agreed amount" value={g.considerationMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, considerationMinor: v }))} />
              <Amount id={`gr${i}-rec`} name="Resources recognised" value={g.recognisedResourcesMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, recognisedResourcesMinor: v }))} />
              <Amount id={`gr${i}-cash`} name="Cash received (does not decide revenue)" value={g.cashReceivedMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, cashReceivedMinor: v }))} />
              <Amount id={`gr${i}-prior`} name="Revenue recognised in earlier periods" value={g.priorCumulativeRevenueMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, priorCumulativeRevenueMinor: v }))} />
            </div>
            <Text id={`gr${i}-priorev`} name="Earlier-period schedule supporting that figure" value={g.priorEvidence} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, priorEvidence: v }))} />
            <h4 className="text-sm font-medium">Obligations and the evidence that each is satisfied</h4>
            {g.obligations.map((o, n) => (
              <div key={n} className="grid gap-2 rounded-md border p-2 sm:grid-cols-3">
                <Text id={`gr${i}-o${n}-id`} name="Obligation identity" value={o.id} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].id = v; return x; })} />
                <Text id={`gr${i}-o${n}-label`} name="Deliverable or condition" value={o.label} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].label = v; return x; })} />
                <Amount id={`gr${i}-o${n}-alloc`} name="Allocated amount" value={o.allocatedMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].allocatedMinor = v; return x; })} />
                <Amount id={`gr${i}-o${n}-sat`} name="Satisfied so far" value={o.satisfiedMinor} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].satisfiedMinor = v; return x; })} />
                <Select id={`gr${i}-o${n}-basis`} name="How it was satisfied" value={o.satisfactionBasis} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].satisfactionBasis = v as never; return x; })} options={SATISFACTION_BASES.map((b) => [b, BASIS_WORDS[b]] as [string, string])} />
                <Text id={`gr${i}-o${n}-ev`} name="Evidence (acceptance letter, delivery report)" value={o.satisfactionEvidence} disabled={!edit} onChange={(v) => setGrant(i, (x) => { x.obligations[n].satisfactionEvidence = v; return x; })} />
                <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setGrant(i, (x) => ({ ...x, obligations: x.obligations.filter((_, j) => j !== n) }))}>Remove obligation</Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setGrant(i, (x) => ({ ...x, obligations: [...x.obligations, emptyObligation(x.obligations.length + 1)] }))}>Add an obligation</Button>
            <h4 className="text-sm font-medium">Arrangements this slice cannot calculate</h4>
            <div className="grid gap-2 sm:grid-cols-3">
              {COMPLEXITIES.map((k) => (
                <Select key={k} id={`gr${i}-cx-${k}`} name={`Involves ${COMPLEXITY_LABELS[k]}?`} value={g.complexities[k] === true ? "yes" : g.complexities[k] === false ? "no" : ""} disabled={!edit}
                  onChange={(v) => setGrant(i, (x) => ({ ...x, complexities: { ...x.complexities, [k]: v === "yes" ? true : v === "no" ? false : null } }))} options={[["no", "No"], ["yes", "Yes (needs a governed workpaper)"]]} />
              ))}
            </div>
            <Text id={`gr${i}-cxb`} name="Basis for the answers above" value={g.complexityBasis} disabled={!edit} onChange={(v) => setGrant(i, (x) => ({ ...x, complexityBasis: v }))} />
            {fig && <p className="text-sm" role="status" data-testid={`gr${i}-figures`}>Server figures: revenue this period <strong>{fromMinor(fig.periodRevenueMinor) || "not computed"}</strong>; cumulative {fromMinor(fig.cumulativeRevenueMinor) || "not computed"}; unfulfilled obligation {fromMinor(fig.liabilityMinor) || "not computed"}; receivable {fromMinor(fig.receivableMinor) || "not computed"}.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!canConfirm || dirty || !ctx.register || live?.confirmedGrants[g.grantId] === true} onClick={() => confirm(g.grantId)}>{live?.confirmedGrants[g.grantId] ? "Assessment confirmed" : "Confirm this assessment"}</Button>
              <span className="text-xs text-muted-foreground">{live?.confirmedGrants[g.grantId] ? "Applies to this exact grant and period; any change voids it." : dirty ? "Save first; a confirmation applies to the saved grant." : "Until confirmed, the classification and figures are proposals."}</span>
              <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setDraft((d) => ({ ...d, grants: d.grants.filter((_, j) => j !== i) }))}>Remove grant</Button>
            </div>
            <Banner state={saves[`confirm:${g.grantId}`] ?? { kind: "idle" }} onRetry={() => confirm(g.grantId)} />
          </fieldset>
        );
      })}
      <Button type="button" variant="outline" disabled={!edit} onClick={() => setDraft((d) => ({ ...d, grants: [...d.grants, emptyGrant()] }))}>Add a grant</Button>
      <div className="space-y-3 rounded-md border p-3">
        <h3 className="font-medium">Questions that decide what else applies</h3>
        {[...questions, ...(draft.grants.length === 0 ? [{ id: "no_grants", label: "Does the entity have any grant or donor agreement this period?", when: model, routesTo: "recording each agreement" }] : [])].map((q) => {
          const ans = draft.entityAnswers[q.id];
          const set = (patch: { text?: string; evidence?: string; applies?: boolean | null }) => setDraft((d) => {
            const cur = d.entityAnswers[q.id] ?? { status: "unresolved" as const, text: "", evidence: "", checkedBy: "", flags: {} as Record<string, boolean> };
            const applies = patch.applies === undefined ? cur.flags.applies : patch.applies;
            return { ...d, entityAnswers: { ...d.entityAnswers, [q.id]: { ...cur, text: patch.text ?? cur.text, evidence: patch.evidence ?? cur.evidence, status: applies === true ? "answered" : "none_with_basis", flags: applies === null || applies === undefined ? {} : { applies } } as never } };
          });
          return (
            <fieldset key={q.id} className="grid gap-2 sm:grid-cols-3">
              <legend className="mb-1 text-sm">{q.label}</legend>
              <Select id={`ga-${q.id}`} name="Answer" value={ans?.flags.applies === true ? "yes" : ans?.flags.applies === false ? "no" : ""} disabled={!edit} onChange={(v) => set({ applies: v === "yes" ? true : v === "no" ? false : null })} options={[["no", "No"], ["yes", "Yes"]]} />
              <Text id={`ga-${q.id}-t`} name="Basis for the answer" value={ans?.text ?? ""} disabled={!edit} onChange={(v) => set({ text: v })} />
              <Text id={`ga-${q.id}-e`} name="Records checked" value={ans?.evidence ?? ""} disabled={!edit} onChange={(v) => set({ evidence: v })} />
            </fieldset>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={!edit || !dirty} onClick={save}>Save grants</Button>
        <Button type="button" variant="outline" disabled={!dirty} onClick={() => void refresh(true)}>Discard grant edits and reload the saved version</Button>
      </div>
      <Banner state={saves.save ?? { kind: "idle" }} onRetry={save} />
    </section>
  );
}
