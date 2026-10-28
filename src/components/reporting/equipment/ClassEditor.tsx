import { formatMinor } from "@/lib/preparation/equipment";
import { classCharge } from "@/lib/preparation/depreciation";
import { MOVEMENT_SOURCE_TYPES, PPE_MOVEMENT_KINDS, type PpeMovementKind, type RollForwardResult, disposalResults, movementCarryingMinor, value } from "@/lib/preparation/equipmentSchedule";
import { emptyDisposal, emptyItem, emptyMovement, movementColumns, type EditorClass, type EditorMovement } from "@/lib/preparation/equipmentEditor";
import type { EquipmentClass } from "@/lib/preparation/equipmentModel";

const KIND_LABEL: Record<PpeMovementKind, string> = {
  additions: "Additions (purchases)", disposals: "Disposals (sold, scrapped, lost)", business_combinations: "Acquired through a business combination",
  revaluations_and_oci_impairment: "Revaluation or impairment in other comprehensive income", transfers_investment_property: "Transfer to or from investment property at fair value",
  impairment_profit_or_loss: "Impairment loss (or reversal) in profit or loss", depreciation: "Depreciation for the year", other: "Other change",
};
const SOURCE_LABEL: Record<(typeof MOVEMENT_SOURCE_TYPES)[number], string> = { register: "Fixed asset register", ledger_account: "Ledger movement account (identified and reviewed)", journal: "Journal", workpaper: "Reviewed workpaper" };
const input = "mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 text-sm";
const button = "rounded-md border border-input px-2 py-1 text-sm disabled:opacity-50";
const fmt = (minor: string | null, exponent: number) => (minor === null || value(minor) === null ? "—" : formatMinor(minor, exponent));

export function ClassEditor(p: {
  cls: EditorClass; derived: EquipmentClass; roll: RollForwardResult; exponent: number; currency: string; period: { start: string; end: string } | null;
  estimateProblems: string[]; canRemove: boolean; onChange: (next: EditorClass) => void; onRemove: () => void;
}) {
  const { cls, exponent } = p;
  const L = cls.label.trim() || "this class";
  const set = (patch: Partial<EditorClass>) => p.onChange({ ...cls, ...patch });
  const setBal = (at: "opening" | "closing", key: keyof EditorClass["opening"], v: string) => set({ [at]: { ...cls[at], [key]: v } } as Partial<EditorClass>);
  const setMove = (i: number, patch: Partial<EditorMovement>) => set({ movements: cls.movements.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const setEst = (patch: Partial<EditorClass["estimate"]>) => set({ estimate: { ...cls.estimate, ...patch } });
  const unusedKinds = PPE_MOVEMENT_KINDS.filter((k) => !cls.movements.some((m) => m.kind === k));
  const hasDisposals = cls.movements.some((m) => m.kind === "disposals");
  const disposal = disposalResults(p.derived.disposals);
  const dep = p.derived.movements.find((m) => m.kind === "depreciation");
  const scheduleCharge = dep ? value(dep.accumulatedDepreciationMinor) : null;
  const e = cls.estimate;
  const charge = e.chargeSource === "calculated" && p.period ? classCharge(p.derived.estimate.items, p.period, e.convention) : null;
  const chargeMinor = e.chargeSource === "calculated" ? (charge?.state === "calculated" ? charge.chargeMinor : null) : e.chargeSource === "register" ? (value(p.derived.estimate.registerChargeMinor) === null ? null : p.derived.estimate.registerChargeMinor) : null;
  const chargeDifference = chargeMinor !== null && scheduleCharge !== null ? (scheduleCharge - BigInt(chargeMinor)).toString() : null;
  const bal = (at: "opening" | "closing") => (
    <fieldset className="min-w-0 space-y-1 rounded-md border border-border p-2">
      <legend className="px-1 text-sm font-medium">{at === "opening" ? "At the start of the year" : "At the end of the year"}</legend>
      {([["grossMinor", "total cost before depreciation (gross carrying amount)"], ["accumulatedDepreciationMinor", "depreciation charged in total (accumulated)"], ["accumulatedImpairmentMinor", "impairment recognised in total (accumulated)"], ["carryingMinor", "carrying amount (net)"]] as const).map(([key, label]) => (
        <label key={key} className="block text-sm">{label}
          <input inputMode="decimal" className={input} aria-label={`${L}: ${at} ${label}`} value={cls[at][key]} onChange={(ev) => setBal(at, key, ev.target.value)} />
        </label>
      ))}
    </fieldset>
  );
  return (
    <section className="min-w-0 max-w-full space-y-3 rounded-lg border border-border p-3" aria-label={`Class ${L}`} data-class-id={cls.classId}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block grow text-sm">Class name
          <input className={input} aria-label="Class name" value={cls.label} onChange={(ev) => set({ label: ev.target.value })} />
        </label>
        <span className="text-xs text-muted-foreground">{cls.origin === "existing" ? "On the recorded schedule" : "New in this preparation"}</span>
        {p.canRemove ? <button type="button" className={button} onClick={p.onRemove}>Remove {L}</button> : null}
      </div>
      <label className="block text-sm">Accounts in this class (codes or names)
        <input className={input} aria-label={`${L}: accounts`} value={cls.accounts} onChange={(ev) => set({ accounts: ev.target.value })} />
      </label>
      <p className="text-xs text-muted-foreground">Leave a box empty if you do not know; type 0 only if the register shows zero.</p>
      <div className="grid gap-2 md:grid-cols-2">{bal("opening")}{bal("closing")}</div>
      <p role="status" className="text-sm">Gross less accumulated amounts: {p.roll.netIdentity === null ? "more information needed" : p.roll.netIdentity.openingMinor === "0" && p.roll.netIdentity.closingMinor === "0" ? "agrees to the carrying amounts at both dates" : `differs (start ${fmt(p.roll.netIdentity.openingMinor, exponent)}, end ${fmt(p.roll.netIdentity.closingMinor, exponent)})`}.</p>

      <h4 className="font-medium">What happened to {L} during the year</h4>
      <p className="text-xs text-muted-foreground">Each change is stated in its columns: cost, accumulated depreciation, accumulated impairment. The effect on the carrying amount follows from them. Fixed-direction changes take positive amounts; for the other kinds a minus sign reduces the column. Every change names its record.</p>
      {cls.movements.map((m, i) => {
        const cols = movementColumns(m.kind);
        const effect = movementCarryingMinor(p.derived.movements[i]);
        const col = (key: "grossMinor" | "accumulatedDepreciationMinor" | "accumulatedImpairmentMinor", mode: "fixed+" | "fixed-" | "signed" | "none", label: string) =>
          mode === "none" ? null : (
            <label className="block text-sm">{label}{mode === "fixed-" ? " removed" : mode === "fixed+" ? " added" : " (signed)"}
              <input inputMode="decimal" className={input} aria-label={`${L}: ${KIND_LABEL[m.kind]} ${label}`} value={m[key]} onChange={(ev) => setMove(i, { [key]: ev.target.value } as Partial<EditorMovement>)} />
            </label>
          );
        return (
          <fieldset key={m.kind} className="min-w-0 space-y-1 rounded-md border border-border p-2" data-movement={m.kind}>
            <legend className="px-1 text-sm font-medium">{KIND_LABEL[m.kind]}</legend>
            {m.note ? <p className="text-xs">{m.note}</p> : null}
            <div className="grid gap-2 md:grid-cols-3">
              {col("grossMinor", cols.gross, "Cost")}
              {col("accumulatedDepreciationMinor", cols.depreciation, "Accumulated depreciation")}
              {col("accumulatedImpairmentMinor", cols.impairment, "Accumulated impairment")}
            </div>
            <p className="text-xs">Effect on the carrying amount: {fmt(effect, exponent)} {p.currency}.</p>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="block text-sm">Record it comes from
                <select className={input} aria-label={`${L}: ${KIND_LABEL[m.kind]} record type`} value={m.source.type} onChange={(ev) => setMove(i, { source: { ...m.source, type: ev.target.value as EditorMovement["source"]["type"] } })}>
                  <option value="">Choose the record</option>
                  {MOVEMENT_SOURCE_TYPES.map((t) => <option key={t} value={t}>{SOURCE_LABEL[t]}</option>)}
                </select>
              </label>
              <label className="block text-sm">Reference (account, report, journal or workpaper)
                <input className={input} maxLength={200} aria-label={`${L}: ${KIND_LABEL[m.kind]} reference`} value={m.source.reference} onChange={(ev) => setMove(i, { source: { ...m.source, reference: ev.target.value } })} />
              </label>
            </div>
            <button type="button" className={button} onClick={() => set({ movements: cls.movements.filter((_, j) => j !== i) })}>Remove this change</button>
          </fieldset>
        );
      })}
      {unusedKinds.length ? (
        <label className="block text-sm">Add a kind of change
          <select className={input} aria-label={`${L}: add a change`} value="" onChange={(ev) => { if (ev.target.value) set({ movements: [...cls.movements, emptyMovement(ev.target.value as PpeMovementKind)] }); }}>
            <option value="">Choose</option>
            {unusedKinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
      ) : null}
      <p role="status" className="text-sm" data-testid={`rollforward-${cls.classId}`}>Roll-forward of {L}: {p.roll.state === "agrees" ? "cost, accumulated depreciation, impairment and carrying amount all agree; evidence still requires review" : p.roll.state === "incomplete" ? `more information needed. ${p.roll.problems.join(" ")}` : p.roll.problems.join(" ")}</p>

      {hasDisposals ? (
        <div className="space-y-2">
          <h4 className="font-medium">Items disposed of</h4>
          <p className="text-xs text-muted-foreground">For each item: cost, depreciation to date, impairment to date and the money received. Leave proceeds unknown rather than typing 0; a verified nil is 0.</p>
          {cls.disposals.map((d, i) => {
            const r = disposal.items[i];
            const setD = (patch: Partial<typeof d>) => set({ disposals: cls.disposals.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <fieldset key={i} className="min-w-0 space-y-1 rounded-md border border-border p-2">
                <legend className="px-1 text-sm">Disposal {i + 1}</legend>
                <div className="grid gap-2 md:grid-cols-3">
                  <label className="block text-sm">Item<input className={input} aria-label={`${L}: disposal ${i + 1} item`} value={d.reference} onChange={(ev) => setD({ reference: ev.target.value })} /></label>
                  <label className="block text-sm">Date<input type="date" className={input} aria-label={`${L}: disposal ${i + 1} date`} value={d.date} onChange={(ev) => setD({ date: ev.target.value })} /></label>
                  <label className="block text-sm">Cost<input inputMode="decimal" className={input} aria-label={`${L}: disposal ${i + 1} cost`} value={d.costMinor} onChange={(ev) => setD({ costMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Depreciation to date<input inputMode="decimal" className={input} aria-label={`${L}: disposal ${i + 1} accumulated depreciation`} value={d.accumulatedDepreciationMinor} onChange={(ev) => setD({ accumulatedDepreciationMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Impairment to date<input inputMode="decimal" className={input} aria-label={`${L}: disposal ${i + 1} accumulated impairment`} value={d.accumulatedImpairmentMinor} onChange={(ev) => setD({ accumulatedImpairmentMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Money received
                    <input inputMode="decimal" className={input} aria-label={`${L}: disposal ${i + 1} proceeds`} value={d.proceedsMinor ?? ""} placeholder="unknown" onChange={(ev) => setD({ proceedsMinor: ev.target.value === "" ? null : ev.target.value })} />
                  </label>
                  <label className="block text-sm">Record type
                    <select className={input} aria-label={`${L}: disposal ${i + 1} record type`} value={d.source.type} onChange={(ev) => setD({ source: { ...d.source, type: ev.target.value as typeof d.source.type } })}>
                      <option value="">Choose the record</option>{MOVEMENT_SOURCE_TYPES.map((t) => <option key={t} value={t}>{SOURCE_LABEL[t]}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm md:col-span-2">Reference<input className={input} maxLength={200} aria-label={`${L}: disposal ${i + 1} reference`} value={d.source.reference} onChange={(ev) => setD({ source: { ...d.source, reference: ev.target.value } })} /></label>
                </div>
                <p className="text-xs">Carrying amount {fmt(r?.carryingMinor ?? null, exponent)}; {r?.gainMinor === null || r?.gainMinor === undefined ? "gain or loss not computed until the proceeds are confirmed" : `${BigInt(r.gainMinor) >= 0n ? "gain" : "loss"} ${fmt(r.gainMinor, exponent)} in profit or loss (not revenue)`}.</p>
                <button type="button" className={button} onClick={() => set({ disposals: cls.disposals.filter((_, j) => j !== i) })}>Remove disposal {i + 1}</button>
              </fieldset>
            );
          })}
          <button type="button" className={button} onClick={() => set({ disposals: [...cls.disposals, emptyDisposal()] })}>Add a disposed item</button>
        </div>
      ) : null}

      <h4 className="font-medium">How {L} is measured and depreciated</h4>
      <p className="text-xs text-muted-foreground">The entity's own estimates. No useful life, rate, residual value or convention is assumed; a tax class or a template is an example, never the estimate.</p>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block text-sm">After purchase, the class is kept at
          <select className={input} aria-label={`${L}: measurement basis`} value={e.basis} onChange={(ev) => setEst({ basis: ev.target.value as typeof e.basis })}>
            <option value="">Choose after review</option><option value="cost">what it cost, less depreciation and impairment</option><option value="revaluation">a regularly revalued amount (unsupported for finalisation: gains go to other comprehensive income)</option>
          </select>
        </label>
        <label className="block text-sm">The benefit is used up
          <select className={input} aria-label={`${L}: depreciation method`} value={e.method} onChange={(ev) => setEst({ method: ev.target.value as typeof e.method })}>
            <option value="">Choose after review</option><option value="straight-line">evenly each year (straight-line)</option><option value="reducing-balance">more in the early years (reducing balance)</option><option value="units-of-production">in line with output (units of production)</option>
          </select>
        </label>
        {e.method === "straight-line" ? <label className="block text-sm">Expected years of use<input inputMode="decimal" className={input} aria-label={`${L}: useful life in years`} value={e.lifeYears} onChange={(ev) => setEst({ lifeYears: ev.target.value })} /></label> : null}
        {e.method === "reducing-balance" ? <label className="block text-sm">Annual rate (%)<input inputMode="decimal" className={input} aria-label={`${L}: annual rate percent`} value={e.ratePercent} onChange={(ev) => setEst({ ratePercent: ev.target.value })} /></label> : null}
        {e.method === "units-of-production" ? <>
          <label className="block text-sm">Total expected output (units)<input inputMode="decimal" className={input} aria-label={`${L}: total expected output`} value={e.totalUnits} onChange={(ev) => setEst({ totalUnits: ev.target.value })} /></label>
          <label className="block text-sm">Output this year (units)<input inputMode="decimal" className={input} aria-label={`${L}: output this period`} value={e.unitsThisPeriod} onChange={(ev) => setEst({ unitsThisPeriod: ev.target.value })} /></label>
        </> : null}
        <label className="block text-sm">Expected to receive at the end (residual value; 0 only if nothing is expected)<input inputMode="decimal" className={input} aria-label={`${L}: residual value`} value={e.residualMinor} onChange={(ev) => setEst({ residualMinor: ev.target.value })} /></label>
        <label className="block text-sm">Part-year convention (the entity's policy)
          <select className={input} aria-label={`${L}: part-year convention`} value={e.convention} onChange={(ev) => setEst({ convention: ev.target.value as typeof e.convention })}>
            <option value="">Choose after review</option><option value="full-period">full period in which the item is available for use</option><option value="daily">pro rata by day from the available-for-use date</option>
          </select>
        </label>
      </div>
      <details>
        <summary className="text-sm">Factors considered for the useful life (expected usage; wear and maintenance; obsolescence; legal or contractual limits)</summary>
        {(["usage", "wear", "obsolescence", "legalLimits"] as const).map((k) => (
          <label key={k} className="block text-sm">{{ usage: "How heavily will it be used (capacity, output)?", wear: "Shifts, maintenance programme, care while idle?", obsolescence: "Could technology or market change make it obsolete?", legalLimits: "Any legal or contractual limit, such as a lease expiry?" }[k]}
            <input className={input} aria-label={`${L}: factor ${k}`} value={e.factors[k]} onChange={(ev) => setEst({ factors: { ...e.factors, [k]: ev.target.value } })} />
          </label>
        ))}
      </details>
      <label className="block text-sm">Where this year's depreciation charge comes from
        <select className={input} aria-label={`${L}: charge source`} value={e.chargeSource} onChange={(ev) => setEst({ chargeSource: ev.target.value as typeof e.chargeSource })}>
          <option value="">Choose</option><option value="calculated">calculated here from the assets or components below</option><option value="register">supplied by an external fixed asset register</option>
        </select>
      </label>
      {e.chargeSource === "register" ? (
        <div className="grid gap-2 md:grid-cols-2">
          <label className="block text-sm">Register and report<input className={input} maxLength={200} aria-label={`${L}: register reference`} value={e.registerReference} onChange={(ev) => setEst({ registerReference: ev.target.value })} /></label>
          <label className="block text-sm">Charge per the register<input inputMode="decimal" className={input} aria-label={`${L}: register charge`} value={e.registerChargeMinor} onChange={(ev) => setEst({ registerChargeMinor: ev.target.value })} /></label>
        </div>
      ) : null}
      {e.chargeSource === "calculated" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">One line per asset, or per component when parts wear out differently. The calculation uses exactly these inputs and the convention above; it is shown beside the schedule's charge, never written into it.</p>
          {e.items.map((it, i) => {
            const setI = (patch: Partial<typeof it>) => setEst({ items: e.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            const r = charge?.items[i]?.result;
            return (
              <fieldset key={i} className="min-w-0 space-y-1 rounded-md border border-border p-2">
                <legend className="px-1 text-sm">Asset or component {i + 1}</legend>
                <div className="grid gap-2 md:grid-cols-3">
                  <label className="block text-sm">Label<input className={input} aria-label={`${L}: item ${i + 1} label`} value={it.label} onChange={(ev) => setI({ label: ev.target.value })} /></label>
                  <label className="block text-sm">Cost<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} cost`} value={it.costMinor} onChange={(ev) => setI({ costMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Residual value<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} residual`} value={it.residualMinor} onChange={(ev) => setI({ residualMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Accumulated depreciation at the start<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} opening accumulated`} value={it.openingAccumulatedMinor} onChange={(ev) => setI({ openingAccumulatedMinor: ev.target.value })} /></label>
                  <label className="block text-sm">Method
                    <select className={input} aria-label={`${L}: item ${i + 1} method`} value={it.method} onChange={(ev) => setI({ method: ev.target.value as typeof it.method })}>
                      <option value="">Choose</option><option value="straight-line">straight-line</option><option value="reducing-balance">reducing balance</option><option value="units-of-production">units of production</option>
                    </select>
                  </label>
                  {it.method === "straight-line" ? <label className="block text-sm">Years<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} years`} value={it.lifeYears} onChange={(ev) => setI({ lifeYears: ev.target.value })} /></label> : null}
                  {it.method === "reducing-balance" ? <label className="block text-sm">Rate (%)<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} rate`} value={it.ratePercent} onChange={(ev) => setI({ ratePercent: ev.target.value })} /></label> : null}
                  {it.method === "units-of-production" ? <>
                    <label className="block text-sm">Total units<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} total units`} value={it.totalUnits} onChange={(ev) => setI({ totalUnits: ev.target.value })} /></label>
                    <label className="block text-sm">Units this year<input inputMode="decimal" className={input} aria-label={`${L}: item ${i + 1} units this period`} value={it.unitsThisPeriod} onChange={(ev) => setI({ unitsThisPeriod: ev.target.value })} /></label>
                  </> : null}
                  <label className="block text-sm">Available for use from (blank = whole year)<input type="date" className={input} aria-label={`${L}: item ${i + 1} available from`} value={it.availableFrom} onChange={(ev) => setI({ availableFrom: ev.target.value })} /></label>
                  <label className="block text-sm">Derecognised on (blank = still held)<input type="date" className={input} aria-label={`${L}: item ${i + 1} derecognised on`} value={it.derecognisedOn} onChange={(ev) => setI({ derecognisedOn: ev.target.value })} /></label>
                </div>
                <p className="text-xs">{!r ? "Period dates needed." : r.state === "calculated" ? `Charge ${formatMinor(r.chargeMinor, exponent)} (${r.basis}).` : `Cannot calculate yet: ${r.missing.join(", ")}.`}</p>
                <button type="button" className={button} onClick={() => setEst({ items: e.items.filter((_, j) => j !== i) })}>Remove item {i + 1}</button>
              </fieldset>
            );
          })}
          <button type="button" className={button} onClick={() => setEst({ items: [...e.items, emptyItem()] })}>Add an asset or component</button>
        </div>
      ) : null}
      <p role="status" className="text-sm" data-testid={`charge-${cls.classId}`}>
        {e.chargeSource === "" ? "Say where the charge comes from to compare it with the schedule." : chargeMinor === null ? "The charge is not available yet." : `${e.chargeSource === "calculated" ? "Calculated" : "Register"} charge ${formatMinor(chargeMinor, exponent)}; schedule depreciation ${scheduleCharge === null ? "not entered" : formatMinor(scheduleCharge.toString(), exponent)}${chargeDifference === null ? "" : chargeDifference === "0" ? "; they agree" : `; difference ${formatMinor(chargeDifference, exponent)} — explain it or correct the schedule; nothing is adjusted for you`}.`}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="block text-sm">Did the life, residual value or method change since last year?
          <select className={input} aria-label={`${L}: changed since prior`} value={e.changedSincePrior} onChange={(ev) => setEst({ changedSincePrior: ev.target.value as typeof e.changedSincePrior })}>
            <option value="">Choose</option><option value="no">No</option><option value="yes">Yes</option>
          </select>
        </label>
        {e.changedSincePrior === "yes" ? <>
          <label className="block text-sm">What changed and the new estimate<input className={input} aria-label={`${L}: change description`} value={e.changeDescription} onChange={(ev) => setEst({ changeDescription: ev.target.value })} /></label>
          <label className="block text-sm">Effect on this year's depreciation (signed)<input inputMode="decimal" className={input} aria-label={`${L}: change effect`} value={e.changeEffectMinor} onChange={(ev) => setEst({ changeEffectMinor: ev.target.value })} /></label>
        </> : null}
        <label className="block text-sm">Why these estimates reflect the entity's expected use<input className={input} aria-label={`${L}: rationale`} value={e.rationale} onChange={(ev) => setEst({ rationale: ev.target.value })} /></label>
        <label className="block text-sm">Evidence for the estimates<input className={input} aria-label={`${L}: estimate evidence`} value={e.evidence} onChange={(ev) => setEst({ evidence: ev.target.value })} /></label>
      </div>
      {p.estimateProblems.length ? <p role="status" className="text-sm">{p.estimateProblems.join(" ")}</p> : <p role="status" className="text-sm">Estimates recorded; accounting review still required.</p>}
    </section>
  );
}
