/**
 * IPSAS accrual preparation — first chain (property, plant and equipment). Five navigable areas, one obvious next action
 * taken from the SERVER's persisted assessment. Everything shown as complete, confirmed or tied is what the server
 * returned; this page only edits a payload, saves it with an expected revision and a request identity, and displays the
 * answer. Official issuance is not available from here and the page says why.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ReportingDb } from "@/lib/reporting/signoff";
import { ipsasClient, afterFailure, afterReceipt, refusalWords, type IpsasContext, type SaveState, type PreparationKind } from "@/lib/ipsasAccrual/ipsasClient";
import { carrying, emptyClass, emptyDisposal, emptyItem, emptyPrior, emptyWorkpaper, denominationWords, fromMinor, knownPresentation, newId, sameDenomination, stableJson, type PriorDraft, type WorkpaperDraft } from "@/lib/ipsasAccrual/draft";
import { computePpeWorkpaper, PPE_ENTITY_QUESTIONS, type PpeClassInput, type PpeInput } from "@/lib/ipsasAccrual/ppeWorkpaper";
import { computeOpeningBridge } from "@/lib/ipsasAccrual/openingBridge";
import { generatePpePolicyNote } from "@/lib/ipsasAccrual/policyNote";
import { buildIncompletePreview, OFFICIAL_ISSUANCE_BLOCKERS, type TaskArea } from "@/lib/ipsasAccrual/preview";
import { Amount, Select, Text } from "./fields";
import { ExponentContext } from "./exponentContext";
import { GrantsPreparation } from "./GrantsPreparation";
import type { PrepTask } from "@/lib/ipsasAccrual/preview";

type Area = "bring" | "prepare" | "review" | "approve" | "issue";
const AREAS: [Area, string][] = [["bring", "Bring information"], ["prepare", "Complete preparation"], ["review", "Review report"], ["approve", "Approve"], ["issue", "Issue & history"]];
type Load = { kind: "loading" } | { kind: "refused"; outcome: string } | { kind: "unknown" } | { kind: "ready"; ctx: IpsasContext };
const KINDS = ["posted-journal", "prior-period-error", "policy-transition", "scope-change", "reclassification"] as const;
const neg = (m: string) => (m === "" ? "" : m === "0" ? "0" : m.startsWith("-") ? m.slice(1) : `-${m}`);

/** Opening/closing carrying and the disposals movement are derived from the exact columns the person typed, never typed twice. */
function normalise(c: PpeClassInput): PpeClassInput {
  const sum = (f: "costMinor" | "accumulatedDepreciationMinor" | "accumulatedImpairmentMinor") => c.disposals.reduce<bigint | null>((n, d) => (n === null || !/^(0|[1-9][0-9]*)$/.test(d[f]) ? null : n + BigInt(d[f])), 0n);
  const sc = sum("costMinor"), sd = sum("accumulatedDepreciationMinor"), si = sum("accumulatedImpairmentMinor");
  const movements = c.movements.map((m) => (m.kind === "disposals" && sc !== null && sd !== null && si !== null ? { ...m, grossMinor: (-sc).toString(), accumulatedDepreciationMinor: (-sd).toString(), accumulatedImpairmentMinor: (-si).toString() } : m));
  return { ...c, movements, opening: { ...c.opening, carryingMinor: carrying(c.opening.grossMinor, c.opening.accumulatedDepreciationMinor, c.opening.accumulatedImpairmentMinor) },
    closing: { ...c.closing, carryingMinor: carrying(c.closing.grossMinor, c.closing.accumulatedDepreciationMinor, c.closing.accumulatedImpairmentMinor) } };
}

function SaveBanner({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
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

export interface IpsasPreparationProps { companyId: string; periodYear: number; legalName: string; db: Pick<ReportingDb, "rpc">; canPrepare: boolean; canConfirm: boolean; prepareHref: string }

export function IpsasPreparation({ companyId, periodYear, legalName, db, canPrepare, canConfirm, prepareHref }: IpsasPreparationProps) {
  const client = useMemo(() => ipsasClient(db), [db]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [area, setArea] = useState<Area>("bring");
  const [wp, setWp] = useState<WorkpaperDraft>(() => emptyWorkpaper(companyId, periodYear, null));
  const [prior, setPrior] = useState<PriorDraft>(() => emptyPrior(companyId, periodYear, null));
  const [saves, setSaves] = useState<Record<string, SaveState>>({});
  /** The request last sent per save key, kept whole (payload, expected revision, identity) so an unknown outcome is retried as THE SAME request. */
  const identities = useRef<Record<string, { id: string; fp: string; call: (requestId: string) => ReturnType<typeof client.save>; snapshot?: { wp?: string; prior?: string } }>>({});
  const [grantsNext, setGrantsNext] = useState<PrepTask | null | undefined>(undefined);
  const scope = useRef(`${companyId}:${periodYear}`);
  scope.current = `${companyId}:${periodYear}`;
  /** The signed-in actor's client: an answer that belongs to another client is never applied. */
  const clientRef = useRef(client);
  clientRef.current = client;
  /** Only the newest operation per key may change that key's state; only one request per key is in flight. */
  const ops = useRef<Record<string, symbol>>({});
  const inflight = useRef<Set<string>>(new Set());
  /** Only the newest started read may set the server's version (an older read finishing late must not roll it back). */
  const readSeq = useRef(0);

  /**
   * Refetches the server's version. A draft is touched only as asked, and never destroys newer work:
   *   "reset"             replace the draft with the server's version (initial load; explicit discard)
   *   { ifSnapshot: fp }  adopt the server's version only if the draft is still exactly the snapshot that was submitted - an edit typed
   *                       after submission stays, and stays unsaved
   * Saving one thing never discards unsaved edits to another.
   */
  type Adopt = "reset" | { ifSnapshot: string } | undefined;
  const refresh = useCallback(async (adoptWp: Adopt, adoptPrior: Adopt) => {
    const mine = `${companyId}:${periodYear}`, myClient = client, seq = ++readSeq.current;
    const stale = () => scope.current !== mine || clientRef.current !== myClient || readSeq.current !== seq;
    const take = <T,>(adopt: Adopt, server: T) => (cur: T): T => (adopt === "reset" ? server : adopt && stableJson(cur) === adopt.ifSnapshot ? server : cur);
    try {
      const r = await client.context(companyId, periodYear);
      if (stale()) return; // a late answer for another company, year, actor or an older read is discarded
      if (r.outcome !== "available") { setLoad({ kind: "refused", outcome: r.outcome }); return; }
      const ctx = r as IpsasContext;
      setLoad({ kind: "ready", ctx });
      // A new draft is entered in the denomination the SERVER confirmed; a saved one keeps the denomination it was entered in (compared below).
      const confirmed = knownPresentation(ctx.assessment.presentation);
      if (adoptWp) setWp(take(adoptWp, (ctx.workpaper?.payload as unknown as WorkpaperDraft) ?? emptyWorkpaper(companyId, periodYear, confirmed)));
      if (adoptPrior) setPrior(take(adoptPrior, (ctx.priorFigures?.payload as unknown as PriorDraft) ?? emptyPrior(companyId, periodYear, confirmed)));
    } catch { if (!stale()) setLoad({ kind: "unknown" }); }
  }, [client, companyId, periodYear]);
  useEffect(() => { setLoad({ kind: "loading" }); setSaves({}); identities.current = {}; ops.current = {}; inflight.current = new Set(); void refresh("reset", "reset"); }, [refresh]);

  const ctx = load.kind === "ready" ? load.ctx : null;
  const savedWp = (ctx?.workpaper?.payload as unknown as WorkpaperDraft | undefined) ?? null;
  const savedPrior = (ctx?.priorFigures?.payload as unknown as PriorDraft | undefined) ?? null;
  /** The denomination the server confirmed (null while unknown or unsupported) and whether every saved draft was entered in it. */
  const pres = knownPresentation(ctx?.assessment.presentation);
  const denominationOk = !!pres && (!savedWp || sameDenomination(savedWp.presentation, pres)) && (!savedPrior || (savedPrior.currency === pres.currency && savedPrior.scale === pres.exponent));
  const wpDirty = stableJson(wp) !== stableJson(savedWp ?? emptyWorkpaper(companyId, periodYear, pres));
  const priorDirty = stableJson(prior) !== stableJson(savedPrior ?? emptyPrior(companyId, periodYear, pres));

  /**
   * One request per key is in flight; its answer confirms the SUBMITTED snapshot only (`snapshot` = what was sent). An answer that belongs to
   * another company, period or actor, or to an operation that has since been superseded, is dropped without touching any state. An unknown
   * outcome keeps the original request, so "send the same request again" resends exactly that request with its original identity.
   */
  const run = async (key: string, fp: string, call: (requestId: string) => ReturnType<typeof client.save>, snapshot?: { wp?: string; prior?: string }) => {
    if (inflight.current.has(key)) return; // never two uncontrolled submissions for the same thing
    const mine = scope.current, myClient = clientRef.current;
    const cur = identities.current[key];
    const id = cur && cur.fp === fp ? cur.id : newId(); // an unknown outcome retries with the ORIGINAL identity
    identities.current[key] = { id, fp, call, snapshot };
    const op = Symbol(key);
    ops.current[key] = op;
    inflight.current.add(key);
    const live = () => scope.current === mine && clientRef.current === myClient && ops.current[key] === op;
    setSaves((s) => ({ ...s, [key]: { kind: "pending", requestId: id } }));
    try {
      const r = await call(id);
      if (!live()) return;
      const next = afterReceipt(id, r);
      setSaves((s) => ({ ...s, [key]: next }));
      if (next.kind !== "unknown") delete identities.current[key];
      inflight.current.delete(key);
      if (next.kind === "saved") await refresh(snapshot?.wp ? { ifSnapshot: snapshot.wp } : undefined, snapshot?.prior ? { ifSnapshot: snapshot.prior } : undefined);
    } catch {
      if (!live()) return;
      inflight.current.delete(key);
      setSaves((s) => ({ ...s, [key]: afterFailure(id) }));
    }
  };
  const save = (kind: PreparationKind) => {
    const payload = structuredClone(kind === "ppe_workpaper" ? wp : prior) as unknown as Record<string, unknown>;
    const expected = (kind === "ppe_workpaper" ? ctx?.workpaper?.id : ctx?.priorFigures?.id) ?? null;
    const key = kind === "ppe_workpaper" ? "workpaper" : "prior";
    const snapshot = stableJson(payload);
    void run(key, stableJson({ payload, expected }), (rid) => client.save(companyId, periodYear, kind, payload, expected, rid), kind === "ppe_workpaper" ? { wp: snapshot } : { prior: snapshot });
  };
  const confirm = (kind: "ppe_class_estimate" | "prior_figure_set", subject: string) => {
    const rev = kind === "ppe_class_estimate" ? ctx?.workpaper?.id : ctx?.priorFigures?.id;
    if (!rev) return;
    void run(`confirm:${subject}`, stableJson({ kind, subject, rev }), (rid) => client.confirm(companyId, periodYear, kind, subject, rev, rid));
  };
  /** "Send the same request again": the stored original request (never the current draft) with its original identity. */
  const retry = (key: string) => {
    const orig = identities.current[key];
    if (!orig) return;
    void run(key, orig.fp, orig.call, orig.snapshot);
  };
  const isPending = (key: string) => saves[key]?.kind === "pending";

  // The review is computed from what the SERVER holds, never from unsaved edits.
  const review = useMemo(() => {
    if (!ctx || !savedWp || !pres || !denominationOk) return null;
    const a = ctx.assessment;
    const input: PpeInput = {
      period: savedWp.period, convention: savedWp.convention, entityAnswers: savedWp.entityAnswers as PpeInput["entityAnswers"], depreciationDifference: savedWp.depreciationDifference,
      tb: { ppeCarryingOpeningMinor: a.tb.ppeCarryingOpeningMinor ?? null, ppeCarryingClosingMinor: a.tb.ppeCarryingClosingMinor ?? null, depreciationExpenseMinor: a.tb.depreciationExpenseMinor ?? null },
      classes: savedWp.classes.map((c) => ({ ...c, estimateConfirmed: a.confirmedClasses[c.classId] === true })),
    };
    const result = computePpeWorkpaper(input);
    const published = (savedPrior?.lines ?? []).map((l) => ({ lineId: l.lineId, label: l.label, amountMinor: l.amountMinor, locator: l.locator, confirmed: a.priorConfirmed }));
    const bridge = computeOpeningBridge(published, [{ lineId: "ppe", label: "Property, plant and equipment", amountMinor: a.ppe?.totals.openingCarryingMinor ?? null, source: "register", reference: "PPE workpaper opening" }],
      (savedPrior?.items ?? []).map((i) => ({ ...i, kind: i.kind as never })));
    const note = generatePpePolicyNote(input, result, pres, legalName);
    const here = [...new Set(result.issues.map((i) => `${i.code}|${i.classId ?? ""}`))].sort().join();
    const server = [...(a.ppe?.codes ?? [])].sort().join();
    return { result, bridge, note, preview: buildIncompletePreview(result, bridge, note), agrees: here === server };
  }, [ctx, savedWp, savedPrior, legalName, pres, denominationOk]);

  if (load.kind === "loading") return <p role="status" className="py-8 text-sm text-muted-foreground">Loading the saved preparation…</p>;
  if (load.kind === "unknown") return <div role="alert" className="py-8 text-sm"><p>We could not read the saved preparation. Nothing has changed.</p><Button className="mt-2" variant="outline" size="sm" onClick={() => void refresh("reset", "reset")}>Try again</Button></div>;
  if (load.kind === "refused") return <p role="alert" className="py-8 text-sm">{refusalWords(load.outcome)}</p>;
  const a = ctx!.assessment;
  if (!pres || !denominationOk) {
    const st = a.presentation;
    const why = st?.state === "unsupported" ? "This company's reporting currency or units are not supported in this release, so no amount can be entered, read or confirmed."
      : !st || st.state === "unknown" ? "The reporting currency and units of this period are not confirmed yet - they come from the certified trial balance. Check the trial balance first; no amount can be entered or read until they are."
      : `The saved figures were entered in a different currency or unit than this company now reports in (${denominationWords(pres!)}). They are not shown, and cannot be changed or confirmed, because showing them would misstate every amount.`;
    return (
      <div className="space-y-4">
        <header className="space-y-1"><h1 className="text-xl font-semibold">{legalName} — IPSAS accrual, {periodYear}</h1></header>
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="denomination-blocked"><strong>Amounts are not available.</strong> {why}</div>
      </div>
    );
  }
  const ex = pres.exponent;
  const next = review?.preview.nextAction ?? (savedWp ? grantsNext : null);
  const edit = canPrepare;

  const setClass = (i: number, fn: (c: PpeClassInput) => PpeClassInput) => setWp((w) => ({ ...w, classes: w.classes.map((c, j) => (j === i ? normalise(fn(structuredClone(c))) : c)) }));

  return (
    <ExponentContext.Provider value={ex}>
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{legalName} — IPSAS accrual, {periodYear}</h1>
        <p className="text-sm text-muted-foreground">Amounts in {denominationWords(pres)}, as confirmed from the certified trial balance. Draft preparation only — not an IPSAS compliant report. {wpDirty || priorDirty ? "You have unsaved edits." : "Everything shown is the server's saved version."}</p>
        <div role="region" aria-label="Next step" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {next ? <><strong>Next:</strong> {next.title}. {next.missing} <Button type="button" size="sm" className="ml-2" onClick={() => setArea(next.area as TaskArea as Area)}>Go to {AREAS.find(([k]) => k === next.area)?.[1]}</Button></>
            : savedWp && grantsNext === undefined ? <span role="status">Checking the saved grants. Their remaining work is not confirmed yet.</span>
            : savedWp ? <><strong>The property, plant and equipment and grants preparation have no open matters.</strong> Official issuance is still unavailable — see Issue &amp; history.</> : <><strong>Next:</strong> bring in the trial balance and the prior report figure, then record the asset classes.</>}
        </div>
      </header>

      <nav role="tablist" aria-label="Preparation areas" className="flex flex-wrap gap-1">
        {AREAS.map(([k, l]) => <button key={k} role="tab" type="button" aria-selected={area === k} onClick={() => setArea(k)} className={`rounded-md border px-3 py-1.5 text-sm ${area === k ? "bg-primary text-primary-foreground" : "bg-background"}`}>{l}</button>)}
      </nav>

      {area === "bring" && (
        <section aria-labelledby="bring-h" className="space-y-4">
          <h2 id="bring-h" className="text-lg font-medium">Bring information</h2>
          <div className="rounded-md border p-3 text-sm space-y-1">
            <h3 className="font-medium">Trial balance</h3>
            {a.tb.certificationId ? <p>Current year certified by the platform{a.tb.isBlocking ? " — with a blocking exception; resolve it before relying on any figure" : a.tb.requiresReview ? " — review still outstanding" : ""}.</p> : <p>No certified trial balance for {periodYear} yet.</p>}
            <p>Property, plant and equipment per the certified rows: closing {fromMinor(a.tb.ppeCarryingClosingMinor, ex) || "unknown"}, opening {fromMinor(a.tb.ppeCarryingOpeningMinor, ex) || "unknown"}; depreciation expense {fromMinor(a.tb.depreciationExpenseMinor, ex) || "unknown"}.</p>
            <a className="underline" href={prepareHref}>Upload or review the trial balance</a>
          </div>
          <div className="rounded-md border p-3 space-y-3">
            <h3 className="font-medium">Which trial balance accounts are property, plant and equipment?</h3>
            <p className="text-xs text-muted-foreground">Account codes, comma separated. The server reads their certified balances itself; an account it cannot find leaves the figure unknown.</p>
            <Text id="tb-ppe" name="Cost and accumulated depreciation accounts" value={wp.tbSelection.ppeAccountKeys.join(", ")} disabled={!edit}
              onChange={(v) => setWp((w) => ({ ...w, tbSelection: { ...w.tbSelection, ppeAccountKeys: v.split(",").map((s) => s.trim()).filter(Boolean) } }))} />
            <Text id="tb-dep" name="Depreciation expense accounts" value={wp.tbSelection.depreciationExpenseKeys.join(", ")} disabled={!edit}
              onChange={(v) => setWp((w) => ({ ...w, tbSelection: { ...w.tbSelection, depreciationExpenseKeys: v.split(",").map((s) => s.trim()).filter(Boolean) } }))} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Text id="p-start" name="Reporting period starts" type="date" value={wp.period.start} disabled={!edit} onChange={(v) => setWp((w) => ({ ...w, period: { ...w.period, start: v } }))} />
              <Text id="p-end" name="Reporting period ends" type="date" value={wp.period.end} disabled={!edit} onChange={(v) => setWp((w) => ({ ...w, period: { ...w.period, end: v } }))} />
              <Select id="conv" name="Part-period depreciation policy" value={wp.convention} disabled={!edit} onChange={(v) => setWp((w) => ({ ...w, convention: v as WorkpaperDraft["convention"] }))}
                options={[["daily", "Pro rata by day"], ["full-period", "Whole period if available at any time"]]} />
            </div>
          </div>
          <div className="rounded-md border p-3 space-y-3">
            <h3 className="font-medium">Last year's published figure and the opening bridge</h3>
            <Amount id="prior-amt" name="Property, plant and equipment — carrying amount as printed in the prior report" value={prior.lines[0].amountMinor ?? ""} disabled={!edit}
              onChange={(v) => setPrior((p) => ({ ...p, lines: [{ ...p.lines[0], amountMinor: v === "" ? null : v }] }))} />
            <Text id="prior-loc" name="Where it is printed (statement and page)" value={prior.lines[0].locator} disabled={!edit} onChange={(v) => setPrior((p) => ({ ...p, lines: [{ ...p.lines[0], locator: v }] }))} />
            {a.bridge && <p className="text-sm" role="status">Opening bridge: <strong>{a.bridge.state}</strong>{a.bridge.lines[0] ? ` — printed ${fromMinor(a.bridge.lines[0].publishedMinor, ex) || "?"}, opening ${fromMinor(a.bridge.lines[0].openingMinor, ex) || "?"}${a.bridge.lines[0].residualMinor && a.bridge.lines[0].residualMinor !== "0" ? `, unexplained ${fromMinor(a.bridge.lines[0].residualMinor, ex)}` : ""}` : ""}. No balancing entry is ever created.</p>}
            {prior.items.map((it, n) => (
              <fieldset key={it.id} className="grid gap-2 rounded-md border p-2 sm:grid-cols-2">
                <legend className="px-1 text-xs">Explained difference {n + 1}</legend>
                <Select id={`bk-${n}`} name="Kind" value={it.kind} disabled={!edit} onChange={(v) => setPrior((p) => ({ ...p, items: p.items.map((x, j) => (j === n ? { ...x, kind: v } : x)) }))} options={KINDS.map((k) => [k, k.replace(/-/g, " ")])} />
                <Amount id={`ba-${n}`} name="Effect on the opening (opening minus printed)" value={it.amountMinor} disabled={!edit} onChange={(v) => setPrior((p) => ({ ...p, items: p.items.map((x, j) => (j === n ? { ...x, amountMinor: v } : x)) }))} />
                <Text id={`be-${n}`} name="Evidence (journal or restatement note)" value={it.evidenceRef} disabled={!edit} onChange={(v) => setPrior((p) => ({ ...p, items: p.items.map((x, j) => (j === n ? { ...x, evidenceRef: v } : x)) }))} />
                <Text id={`bu-${n}`} name="Who approved it, and where recorded" value={it.authorityReference} disabled={!edit} onChange={(v) => setPrior((p) => ({ ...p, items: p.items.map((x, j) => (j === n ? { ...x, authorityReference: v } : x)) }))} />
                <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setPrior((p) => ({ ...p, items: p.items.filter((_, j) => j !== n) }))}>Remove</Button>
              </fieldset>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setPrior((p) => ({ ...p, items: [...p.items, { id: `ITEM-${p.items.length + 1}`, groupId: "", lineId: "ppe", kind: "posted-journal", amountMinor: "", evidenceRef: "", authorityReference: "" }] }))}>Add an explained difference</Button>
              <Button type="button" size="sm" disabled={!edit || !priorDirty || isPending("prior")} onClick={() => save("prior_figures")}>Save prior figure</Button>
              <Button type="button" variant="outline" size="sm" disabled={!canConfirm || priorDirty || !ctx?.priorFigures || a.priorConfirmed || isPending("confirm:prior_figures")} onClick={() => confirm("prior_figure_set", "prior_figures")}>{a.priorConfirmed ? "Confirmed against the printed page" : "Confirm against the printed page"}</Button>
            </div>
            <SaveBanner state={saves.prior ?? saves["confirm:prior_figures"] ?? { kind: "idle" }} onRetry={() => retry(saves.prior ? "prior" : "confirm:prior_figures")} />
            {!canConfirm && <p className="text-xs text-muted-foreground">Confirmation needs a reviewer on this engagement.</p>}
          </div>
        </section>
      )}

      {area === "prepare" && (
        <section aria-labelledby="prep-h" className="space-y-4">
          <h2 id="prep-h" className="text-lg font-medium">Complete preparation — property, plant and equipment</h2>
          <p className="text-sm text-muted-foreground">Cost model only. Useful lives, methods and residual values are management's own estimates; nothing here suggests one. Revaluation, heritage, infrastructure, impairment and held-for-sale matters cannot be completed here and are shown as open until a governed workpaper exists.</p>
          {wp.classes.map((c, i) => (
            <fieldset key={c.classId} className="space-y-3 rounded-md border p-3">
              <legend className="px-1 font-medium">{c.label || `Asset class ${i + 1}`}</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <Text id={`c${i}-label`} name="Class name" value={c.label} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, label: v }))} />
                <Text id={`c${i}-acc`} name="Ledger accounts" value={c.accounts} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, accounts: v }))} />
                <Select id={`c${i}-model`} name="Measurement model" value={c.measurementModel} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, measurementModel: v as never, estimate: { ...x.estimate, basis: v === "revaluation" ? "revaluation" : "cost" } }))} options={[["cost", "Cost less depreciation and impairment"], ["revaluation", "Revaluation (not yet supported here)"]]} />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {(["opening", "closing"] as const).flatMap((w) => [
                  <Amount key={`${w}g`} id={`c${i}-${w}g`} name={`${w === "opening" ? "Opening" : "Closing"} cost`} value={c[w].grossMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, [w]: { ...x[w], grossMinor: v } }))} />,
                  <Amount key={`${w}d`} id={`c${i}-${w}d`} name={`${w === "opening" ? "Opening" : "Closing"} accumulated depreciation`} value={c[w].accumulatedDepreciationMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, [w]: { ...x[w], accumulatedDepreciationMinor: v } }))} />,
                  <Amount key={`${w}i`} id={`c${i}-${w}i`} name={`${w === "opening" ? "Opening" : "Closing"} accumulated impairment`} value={c[w].accumulatedImpairmentMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, [w]: { ...x[w], accumulatedImpairmentMinor: v } }))} />,
                ])}
                <Amount id={`c${i}-add`} name="Additions at cost" value={c.movements[0].grossMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, movements: x.movements.map((m, j) => (j === 0 ? { ...m, grossMinor: v } : m)) }))} />
                <Amount id={`c${i}-dep`} name="Depreciation charged (per ledger or register)" value={c.movements[2].accumulatedDepreciationMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, movements: x.movements.map((m, j) => (j === 2 ? { ...m, accumulatedDepreciationMinor: v } : m)) }))} />
                <Text id={`c${i}-src`} name="Register or ledger supporting the movements" value={c.movements[0].source.reference} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, movements: x.movements.map((m) => ({ ...m, source: { type: "register", reference: v } })) }))} />
              </div>
              <p className="text-xs text-muted-foreground">Carrying amounts are worked out from the three columns: opening {fromMinor(c.opening.carryingMinor, ex) || "—"}, closing {fromMinor(c.closing.carryingMinor, ex) || "—"}. The server checks both identities.</p>
              <h4 className="text-sm font-medium">Items disposed of</h4>
              {c.disposals.map((d, n) => (
                <div key={n} className="grid gap-2 rounded-md border p-2 sm:grid-cols-3">
                  <Text id={`c${i}-d${n}r`} name="Item" value={d.reference} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, disposals: x.disposals.map((y, j) => (j === n ? { ...y, reference: v } : y)) }))} />
                  <Amount id={`c${i}-d${n}c`} name="Cost" value={d.costMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, disposals: x.disposals.map((y, j) => (j === n ? { ...y, costMinor: v } : y)) }))} />
                  <Amount id={`c${i}-d${n}a`} name="Accumulated depreciation" value={d.accumulatedDepreciationMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, disposals: x.disposals.map((y, j) => (j === n ? { ...y, accumulatedDepreciationMinor: v } : y)) }))} />
                  <Amount id={`c${i}-d${n}p`} name="Proceeds" hint="Leave blank if not yet known — it is not read as zero." value={d.proceedsMinor ?? ""} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, disposals: x.disposals.map((y, j) => (j === n ? { ...y, proceedsMinor: v === "" ? null : v, source: { type: "register", reference: x.movements[0].source.reference } } : y)) }))} />
                  <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setClass(i, (x) => ({ ...x, disposals: x.disposals.filter((_, j) => j !== n) }))}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setClass(i, (x) => ({ ...x, disposals: [...x.disposals, { ...emptyDisposal(), source: { type: "register", reference: x.movements[0].source.reference } }] }))}>Add a disposal</Button>
              <h4 className="text-sm font-medium">Depreciable items and management's estimates</h4>
              <Select id={`c${i}-cs`} name="Where the charge comes from" value={c.estimate.chargeSource} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, chargeSource: v as never } }))} options={[["calculated", "Calculated here from the estimates below"], ["register", "Taken from the register"]]} />
              {c.estimate.chargeSource === "register" && <div className="grid gap-2 sm:grid-cols-2">
                <Amount id={`c${i}-rc`} name="Register's charge" value={c.estimate.registerChargeMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, registerChargeMinor: v } }))} />
                <Text id={`c${i}-rr`} name="Register report" value={c.estimate.registerReference} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, registerReference: v } }))} /></div>}
              {c.estimate.items.map((it, n) => (
                <div key={n} className="grid gap-2 rounded-md border p-2 sm:grid-cols-4">
                  <Text id={`c${i}-i${n}l`} name="Item" value={it.label} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, label: v } : y)) } }))} />
                  <Amount id={`c${i}-i${n}c`} name="Cost" value={it.costMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, costMinor: v } : y)) } }))} />
                  <Amount id={`c${i}-i${n}r`} name="Residual value" value={it.residualMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, residualMinor: v } : y)) } }))} />
                  <Amount id={`c${i}-i${n}o`} name="Accumulated depreciation at the start" value={it.openingAccumulatedMinor} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, openingAccumulatedMinor: v } : y)) } }))} />
                  <Select id={`c${i}-i${n}m`} name="Method" value={it.method} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, method: v as never } : y)) } }))} options={[["straight-line", "Straight-line"], ["reducing-balance", "Reducing balance"], ["units-of-production", "Units of production"]]} />
                  {it.method === "straight-line" && <Text id={`c${i}-i${n}y`} name="Useful life (years)" value={it.lifeYears} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, lifeYears: v } : y)) } }))} />}
                  {it.method === "reducing-balance" && <Text id={`c${i}-i${n}p`} name="Annual rate (%)" value={it.ratePercent} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, ratePercent: v } : y)) } }))} />}
                  <Text id={`c${i}-i${n}a`} name="Available for use from" type="date" value={it.availableFrom} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, availableFrom: v } : y)) } }))} />
                  <Text id={`c${i}-i${n}d`} name="Derecognised on" type="date" value={it.derecognisedOn} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.map((y, j) => (j === n ? { ...y, derecognisedOn: v } : y)) } }))} />
                  <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: x.estimate.items.filter((_, j) => j !== n) } }))}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, items: [...x.estimate.items, emptyItem()] } }))}>Add an item</Button>
              <div className="grid gap-3 sm:grid-cols-2">
                <Text id={`c${i}-rat`} name="Basis of the estimates (usage, wear, obsolescence, legal limits)" value={c.estimate.rationale} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, rationale: v } }))} />
                <Text id={`c${i}-ev`} name="Evidence reviewed" value={c.estimate.evidence} disabled={!edit} onChange={(v) => setClass(i, (x) => ({ ...x, estimate: { ...x.estimate, evidence: v } }))} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={!canConfirm || wpDirty || !ctx?.workpaper || a.confirmedClasses[c.classId] === true || isPending(`confirm:${c.classId}`)} onClick={() => confirm("ppe_class_estimate", c.classId)}>
                  {a.confirmedClasses[c.classId] ? "Estimates confirmed" : "Confirm these estimates"}</Button>
                <span className="text-xs text-muted-foreground">{a.confirmedClasses[c.classId] ? "A confirmation applies to these exact estimates; any change voids it." : wpDirty ? "Save first; a confirmation applies to the saved estimates." : "Until confirmed, the estimates are proposals."}</span>
                <Button type="button" variant="outline" size="sm" disabled={!edit} onClick={() => setWp((w) => ({ ...w, classes: w.classes.filter((_, j) => j !== i) }))}>Remove class</Button>
              </div>
              <SaveBanner state={saves[`confirm:${c.classId}`] ?? { kind: "idle" }} onRetry={() => retry(`confirm:${c.classId}`)} />
            </fieldset>
          ))}
          <Button type="button" variant="outline" disabled={!edit} onClick={() => setWp((w) => ({ ...w, classes: [...w.classes, emptyClass()] }))}>Add an asset class</Button>
          <div className="space-y-3 rounded-md border p-3">
            <h3 className="font-medium">Questions that decide what else applies</h3>
            {PPE_ENTITY_QUESTIONS.map((q) => {
              const ans = wp.entityAnswers[q.id];
              const set = (patch: Partial<NonNullable<typeof ans>> & { applies?: boolean | null }) => setWp((w) => {
                const cur = w.entityAnswers[q.id] ?? { status: "unresolved" as const, text: "", evidence: "", checkedBy: "", flags: {} };
                const applies = patch.applies === undefined ? cur.flags.applies : patch.applies;
                return { ...w, entityAnswers: { ...w.entityAnswers, [q.id]: { ...cur, ...patch, status: applies === true ? "answered" : "none_with_basis", flags: applies === null || applies === undefined ? {} : { applies } } as never } };
              });
              return (
                <fieldset key={q.id} className="grid gap-2 sm:grid-cols-3">
                  <legend className="mb-1 text-sm">{q.label}</legend>
                  <Select id={`q-${q.id}`} name="Answer" value={ans?.flags.applies === true ? "yes" : ans?.flags.applies === false ? "no" : ""} disabled={!edit} onChange={(v) => set({ applies: v === "yes" ? true : v === "no" ? false : null })} options={[["no", "No"], ["yes", "Yes"]]} />
                  <Text id={`q-${q.id}-t`} name="Basis for the answer" value={ans?.text ?? ""} disabled={!edit} onChange={(v) => set({ text: v })} />
                  <Text id={`q-${q.id}-e`} name="Records checked" value={ans?.evidence ?? ""} disabled={!edit} onChange={(v) => set({ evidence: v })} />
                </fieldset>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={!edit || !wpDirty || isPending("workpaper")} onClick={() => save("ppe_workpaper")}>Save preparation</Button>
            <Button type="button" variant="outline" disabled={!wpDirty} onClick={() => void refresh("reset", "reset")}>Discard edits and reload the saved version</Button>
          </div>
          <SaveBanner state={saves.workpaper ?? { kind: "idle" }} onRetry={() => retry("workpaper")} />
        </section>
      )}

      {area === "review" && (
        <section aria-labelledby="rev-h" className="space-y-4">
          <h2 id="rev-h" className="text-lg font-medium">Review report</h2>
          {!review ? <p className="text-sm">Nothing is saved yet. Save the preparation to see the draft note and what remains.</p> : <>
            <p className="rounded-md border border-amber-500/60 px-3 py-2 text-sm"><strong>{review.preview.label}</strong>{wpDirty || priorDirty ? " Unsaved edits are not included below." : ""}</p>
            {!review.agrees && <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm">This page and the server disagree about which matters are open. The server's list stands: {(a.ppe?.codes ?? []).join(", ") || "none"}.</p>}
            <div className="rounded-md border p-3 text-sm">
              <h3 className="font-medium">Property, plant and equipment</h3>
              <p>Carrying amount: opening {fromMinor(a.ppe?.totals.openingCarryingMinor, ex) || "unknown"}, closing {fromMinor(a.ppe?.totals.closingCarryingMinor, ex) || "unknown"}; depreciation {fromMinor(a.ppe?.totals.depreciationMinor, ex) || "unknown"}. Server state: <strong>{a.ppe?.state}</strong>.</p>
            </div>
            <div className="rounded-md border p-3 text-sm space-y-2">
              <h3 className="font-medium">Accounting policy (draft) — {review.note.label}</h3>
              {review.note.policy.map((p) => <p key={p.id} className={p.unresolved ? "text-amber-700" : ""}>{p.segments.map((s) => (s.t === "text" ? s.text : s.display)).join("")}</p>)}
              <div data-testid="note-tables" role="region" aria-label="Note tables (scroll sideways on a narrow screen)" tabIndex={0} className="space-y-3 overflow-x-auto">
              {review.note.tables.map((t) => (
                <table key={t.id} className="w-full text-xs" aria-label={t.title}>
                  <caption className="text-left font-medium">{t.title} (note.ppe)</caption>
                  <thead><tr><th scope="col" className="text-left">Class</th>{t.columns.map((c) => <th key={c} scope="col" className="text-right">{c}</th>)}</tr></thead>
                  <tbody>{t.rows.map((r) => <tr key={r.label + (r.classId ?? "")}><th scope="row" className="text-left font-normal">{r.label}</th>{r.cells.map((c, k) => <td key={k} className="text-right tabular-nums">{c ? c.display : "—"}</td>)}</tr>)}</tbody>
                </table>
              ))}
              </div>
            </div>
            <div className="rounded-md border p-3 text-sm">
              <h3 className="font-medium">What remains ({review.preview.tasks.length})</h3>
              {review.preview.tasks.length === 0 ? <p>No open matters in this slice.</p> : (
                <ul className="space-y-2">{review.preview.tasks.map((t) => (
                  <li key={t.id} className="rounded border p-2">
                    <p><strong>{t.title}.</strong> {t.missing}</p>
                    <p className="text-xs text-muted-foreground">Why: {t.why} Evidence: {t.acceptedEvidence} Who: {t.responsible}. Affects: {t.affects.join(", ")}.</p>
                    <Button type="button" variant="outline" size="sm" className="mt-1" onClick={() => setArea(t.area as TaskArea as Area)}>Open</Button>
                  </li>))}</ul>)}
            </div>
          </>}
        </section>
      )}

      {area === "approve" && (
        <section aria-labelledby="app-h" className="space-y-2">
          <h2 id="app-h" className="text-lg font-medium">Approve</h2>
          <p className="text-sm">Approval is not available for IPSAS reports yet. Estimate confirmations recorded in this preparation are management inputs to the draft; they are not the firm's review, the entity's authorisation of the statements, or an audit opinion.</p>
        </section>
      )}
      {area === "issue" && (
        <section aria-labelledby="iss-h" className="space-y-2">
          <h2 id="iss-h" className="text-lg font-medium">Issue &amp; history</h2>
          <p className="text-sm"><strong>Official issuance is unavailable.</strong> No IPSAS report has been issued for this company and nothing here can issue one. Why:</p>
          <ul className="list-disc pl-5 text-sm">{OFFICIAL_ISSUANCE_BLOCKERS.map((b) => <li key={b}>{b}</li>)}</ul>
        </section>
      )}
      <GrantsPreparation companyId={companyId} periodYear={periodYear} legalName={legalName} db={db} canPrepare={canPrepare} canConfirm={canConfirm} area={area} onNextTask={setGrantsNext} />
    </div>
    </ExponentContext.Provider>
  );
}
