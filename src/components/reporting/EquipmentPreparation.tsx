import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useManagementEditGuard } from "@/components/account/managementState";
import { presentationPending } from "@/lib/reporting/preparationGuidance";
import { formatMinor, openingAnchorDate, openingBridge, parseSourceAmount, type BridgeAdjustment, type SourceFact } from "@/lib/preparation/equipment";
import { classPreservation, classRollForward, depreciationTieOut, DESTINATION_TARGETS, EQUIPMENT_CONTENT_VERSION_V2, EQUIPMENT_CONTRACT_V2, openingGrossBridge, totalCarrying, value, type DepreciationDestination } from "@/lib/preparation/equipmentSchedule";
import { classCharge, DEPRECIATION_CALCULATOR_VERSION } from "@/lib/preparation/depreciation";
import { classFromScheduleRow, deriveClass, emptyEditorClass, minorOrText, type EditorClass } from "@/lib/preparation/equipmentEditor";
import { chargeConsistencyProblems, EQUIPMENT_QUESTIONS_VERSION, EQUIPMENT_SOURCE_V2, estimateProblems, evaluateQuestions, questionKey, unresolvedQuestions, type EvaluatedQuestion } from "@/lib/preparation/equipmentQuestions";
import { equipmentNoteProposalV2, estimatesProposalV2, policyProposalV2 } from "@/lib/preparation/equipmentProposals";
import { parseEquipmentEditorV2, type EquipmentEditorV2 } from "@/lib/preparation/editorSchema";
import type { Answer } from "@/lib/preparation/equipmentModel";
import type { EquipmentContextV2, NoteRequirement } from "@/lib/preparation/workpaperClient";
import { readPriorPage, type ReadPage } from "@/lib/preparation/priorReport";
import { ClassEditor } from "./equipment/ClassEditor";
import { QuestionPanel } from "./equipment/QuestionPanel";
import { EquipmentServerBridge } from "./EquipmentServerBridge";
import { Notice, type PageProps } from "./shared";

type Editor = Omit<EquipmentEditorV2, "read">;
const emptyEditor = (): Editor => ({
  sourceMode: "pdf", priorReference: "", page: "1", priorAmount: "", priorGross: "", priorAccumulated: "", priorDate: "", priorCurrency: "", priorUnits: "",
  adjustments: [], classes: [], retiredClasses: [], destinations: [], entityAnswers: {},
});
const inputClass = "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2";
const buttonClass = "rounded-md border border-input px-3 py-2 disabled:opacity-50";
const DESTINATION_WORDS: Record<(typeof DESTINATION_TARGETS)[number], string> = {
  "sci.depreciation_and_amortisation": "Depreciation and amortisation line (by nature)", "sci.cost_of_sales": "Cost of sales", "sci.operating_expenses_by_function": "Distribution, administrative and other expenses (by function)",
  "sci.other_expenses_by_nature": "Other expenses (by nature)", capitalised_inventories: "Capitalised into inventories (manufacturing)", capitalised_assets: "Capitalised into another asset", other: "Other (explain)",
};

/** Admitted only on a composed IFRS for SMEs 2015 report for a preparer. A workpaper is not an approval. */
export function EquipmentPreparation(p: PageProps) {
  const c = p.state.composition;
  if (!c || c.state !== "composed" || c.pack.packId !== "ifrs-for-smes/2015" || !p.allowed.includes("prepare_close")) return null;
  return (
    <EquipmentWorkpaper key={`${p.companyId}:${p.periodYear}`} {...p} currency={c.current.currency} exponent={c.current.exponent} compositionSha256={c.compositionSha256}
      statementClosingMinor={presentationPending(c) ? null : (c.lines.find((l) => l.lineId === "sfp.property_plant_and_equipment")?.current.amountMinor ?? null)}
      composedLines={c.lines.map((l) => ({ lineId: l.lineId, amountMinor: l.current.amountMinor }))} />
  );
}

function EquipmentWorkpaper(p: PageProps & { currency: string; exponent: number; compositionSha256: string; statementClosingMinor: string | null; composedLines: { lineId: string; amountMinor: string }[] }) {
  const [reviewedComposition, setReviewedComposition] = useState(p.compositionSha256);
  const statementChanged = reviewedComposition !== p.compositionSha256;
  const [expectedPriorEnd, setExpectedPriorEnd] = useState<string | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string } | null>(null);
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  const [context, setContext] = useState<EquipmentContextV2 | null>(null);
  const [editor, setEditor] = useState<Editor>(emptyEditor);
  const [opened, setOpened] = useState(false), [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File | null>(null), [forceOcr, setForceOcr] = useState(false);
  const [reading, setReading] = useState(false), [read, setRead] = useState<ReadPage | null>(null), [image, setImage] = useState("");
  const [confirmed, setConfirmed] = useState(false), [coverageConfirmed, setCoverageConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const generation = useRef(0), live = useRef(true), activeRead = useRef<AbortController | null>(null);
  const id = useId();
  useEffect(() => { live.current = true; return () => { live.current = false; activeRead.current?.abort(); }; }, []);
  useEffect(() => {
    if (!read || read.preview.size === 0) { setImage(""); return; }
    const url = URL.createObjectURL(read.preview); setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [read]);
  useManagementEditGuard(dirty, busy || reading, () => { setDirty(false); setOpened(false); });
  useEffect(() => {
    if (!opened) return;
    let current = true;
    p.clients.signoff.input(p.companyId, p.periodYear).then((i) => {
      if (!current) return;
      setExpectedPriorEnd(openingAnchorDate(i.comparative?.reportingEnd, i.current?.reportingStart));
      const s = i.current?.reportingStart?.slice(0, 10), e = i.current?.reportingEnd?.slice(0, 10);
      setPeriod(s && e ? { start: s, end: e } : null);
    }, () => { if (current) { setExpectedPriorEnd(null); setPeriod(null); } });
    return () => { current = false; };
  }, [opened, p.clients, p.companyId, p.periodYear, p.compositionSha256]);
  const edit = (patch: Partial<Editor>, movementChange = false) => { setEditor((e) => ({ ...e, ...patch })); setDirty(true); if (movementChange) setCoverageConfirmed(false); };
  const setClass = (i: number, next: EditorClass) => edit({ classes: editor.classes.map((c, j) => (j === i ? next : c)) }, true);

  // ── Step 1: the prior report (one figure read from the page; optional printed gross and accumulated amounts) ──
  const resetSource = (f: File | null) => { generation.current++; activeRead.current?.abort(); setReading(false); setFile(f); setSourceDocumentId(null); setRead(null); setConfirmed(false); edit({ priorAmount: "" }); setNotice(null); };
  const readPage = async () => {
    if (!file || reading || (activeRead.current && !activeRead.current.signal.aborted)) return;
    const g = ++generation.current, controller = new AbortController();
    activeRead.current = controller; setReading(true); setRead(null); setConfirmed(false); setNotice(null);
    try {
      const result = await readPriorPage(file, Number(editor.page), controller.signal, (text) => { if (live.current && generation.current === g) setNotice(text); }, forceOcr);
      if (live.current && generation.current === g) { setRead(result); setNotice("Page read locally. Compare the original page, then confirm the figures and their units."); }
    } catch { if (live.current && generation.current === g) setNotice("The page could not be read. Try a different page or a clearer PDF. No financial facts were recorded."); }
    finally { if (live.current && generation.current === g) { activeRead.current = null; setReading(false); } }
  };
  const units = editor.priorUnits === "" ? null : Number(editor.priorUnits);
  const prior = units === null ? null : parseSourceAmount(editor.priorAmount, p.exponent, units);
  const priorGrossMinor = units === null || !editor.priorGross.trim() ? null : parseSourceAmount(editor.priorGross, p.exponent, units);
  const priorAccumulatedMinor = units === null || !editor.priorAccumulated.trim() ? null : parseSourceAmount(editor.priorAccumulated, p.exponent, units);
  const priorSourceReady = editor.sourceMode === "pdf" ? !!read : editor.priorReference.trim().length >= 3;
  const fact: SourceFact | null = priorSourceReady && prior !== null ? {
    origin: editor.sourceMode === "pdf" ? "document" : "manual", sourceRef: editor.sourceMode === "reference" ? editor.priorReference : undefined,
    documentSha256: editor.sourceMode === "pdf" ? read!.sha256 : null, page: editor.sourceMode === "pdf" ? read!.page : null,
    entity: p.legalName, periodEnd: editor.priorDate, currency: editor.priorCurrency, printedAmount: editor.priorAmount, printedUnitsExponent: units ?? undefined,
    scale: p.exponent, label: "Equipment carrying amount", amountMinor: prior, confirmed,
  } : null;

  // ── Derived checks: every class, the bridge, the tie-out, preservation, the questions ──
  const derived = editor.classes.map((c) => {
    const d = deriveClass(c, p.exponent);
    if (d.estimate.chargeSource === "calculated" && period) { const r = classCharge(d.estimate.items, period, d.estimate.convention); d.estimate.calculatedChargeMinor = r.state === "calculated" ? r.chargeMinor : ""; }
    return d;
  });
  const rolls = derived.map((c) => classRollForward(c.label, { opening: c.opening, closing: c.closing }, c.movements, c.disposals));
  const openingTotal = totalCarrying(derived, "opening"), closingTotal = totalCarrying(derived, "closing");
  const bridgeRows: BridgeAdjustment[] = editor.adjustments.map((a) => ({ amountMinor: minorOrText(a.amount, p.exponent), reason: `${a.category ? `[${a.category}] ` : ""}${a.reason}`, evidence: a.evidence }));
  const bridge = openingBridge(fact, bridgeRows, openingTotal ?? "", { entity: p.legalName, priorPeriodEnd: expectedPriorEnd ?? "", currency: p.currency, exponent: p.exponent });
  const grossBridge = openingGrossBridge({ grossMinor: editor.priorGross.trim() ? (priorGrossMinor ?? "x") : null, accumulatedMinor: editor.priorAccumulated.trim() ? (priorAccumulatedMinor ?? "x") : null }, derived);
  const derivedDestinations: DepreciationDestination[] = editor.destinations.map((d) => ({ ...d, amountMinor: minorOrText(d.amountMinor, p.exponent) }));
  const tie = depreciationTieOut(derived, derivedDestinations, p.composedLines);
  const preservation = classPreservation(context?.schedule?.rows ?? [], derived, editor.retiredClasses);
  const statementDifference = closingTotal !== null && p.statementClosingMinor !== null && value(p.statementClosingMinor) !== null ? (BigInt(closingTotal) - BigInt(p.statementClosingMinor)).toString() : null;
  const prep = { classes: derived, retiredClasses: editor.retiredClasses, destinations: derivedDestinations, entityAnswers: editor.entityAnswers as Record<string, Answer> };
  const questions = evaluateQuestions(prep, period ?? { start: "", end: "" });
  const unresolved = unresolvedQuestions(questions);
  const classEstimateProblems = derived.map((c) => [...estimateProblems(c.estimate, c.answers.components?.status === "answered" && c.answers.components.flags.components_identified === true), ...chargeConsistencyProblems(c, period).problems]);
  const ready = editor.classes.length > 0 && rolls.every((r) => r.state === "agrees") && bridge.state === "agrees" && (grossBridge.state === "agrees" || grossBridge.state === "not_provided")
    && preservation.problems.length === 0 && tie.state === "agrees" && statementDifference === "0" && !statementChanged && coverageConfirmed && !!period && /^\d{4}-\d{2}-\d{2}$/.test(editor.priorDate)
    && classEstimateProblems.every((x) => x.length === 0);
  const canCommitNotes = ready && unresolved.length === 0;
  const proposals: Record<NoteRequirement, string | null> = canCommitNotes
    ? { "smes.note.policies": policyProposalV2(derived, p.currency, p.exponent), "smes.note.estimates": estimatesProposalV2(derived, p.currency, p.exponent), "smes.note.subclassifications": equipmentNoteProposalV2(derived, prep.entityAnswers, derivedDestinations, p.currency, p.exponent) }
    : { "smes.note.policies": null, "smes.note.estimates": null, "smes.note.subclassifications": null };
  const buildWorkpaper = () => ({
    contract: EQUIPMENT_CONTRACT_V2, status: "preparation-not-approval", companyId: p.companyId, periodYear: p.periodYear, compositionSha256: reviewedComposition, statementChanged,
    currency: p.currency, exponent: p.exponent,
    priorSource: { fileName: file?.name ?? null, fact, priorGrossMinor, priorAccumulatedMinor, extraction: read ? { method: read.method, text: read.text.slice(0, 8000), characterCount: read.text.length, excerptTruncated: read.text.length > 8000 } : null },
    openingBridge: { adjustments: bridgeRows, openingMinor: openingTotal, result: bridge, grossResult: grossBridge },
    classes: derived, retiredClasses: editor.retiredClasses, destinations: derivedDestinations, entityAnswers: editor.entityAnswers,
    schedule: { rows: rolls.map((r) => r.scheduleRow), rollForwards: rolls.map((r) => ({ state: r.state, differences: r.differences })), closingMinor: closingTotal, statementClosingMinor: p.statementClosingMinor, statementDifferenceMinor: statementDifference, coverageConfirmed, tieOut: tie, preservation },
    questions: { applicable: questions.map((q) => ({ id: q.def.id, classId: q.classId, resolved: q.resolved })), unresolved: unresolved.map((q) => ({ id: q.def.id, classId: q.classId, problems: q.problems })) },
    proposals,
    contentVersion: EQUIPMENT_CONTENT_VERSION_V2, questionsVersion: EQUIPMENT_QUESTIONS_VERSION, calculatorVersion: DEPRECIATION_CALCULATOR_VERSION, source: EQUIPMENT_SOURCE_V2,
    editor: { ...editor, read: read ? { sha256: read.sha256, page: read.page, pages: read.pages, text: read.text, method: read.method } : null },
    exclusions: ["Not an audit or framework compliance conclusion", "Proposed note wording is recorded only when a named person saves the whole reviewed note", "Original PDF must be retained separately"],
  });
  const exportWorkpaper = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(buildWorkpaper(), null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `equipment-workpaper-${p.companyId}-FY${p.periodYear}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice("Workpaper downloaded. Keep the original PDF with it. The download is not a server save or an approval.");
  };
  const restore = (data: unknown, documentId: string | null) => {
    try {
      const parsed = parseEquipmentEditorV2(data, p.companyId, p.periodYear);
      generation.current++; activeRead.current?.abort(); setReading(false); setFile(null); setSourceDocumentId(documentId);
      const { read: savedRead, ...rest } = parsed;
      setEditor(rest); setRead(savedRead ? { ...savedRead, preview: new Blob([]) } : null); setConfirmed(false); setCoverageConfirmed(false); setDirty(true);
      setNotice("Saved preparation restored for review. The original page preview is not loaded. Reconfirm the source figures and the coverage of each class before recording.");
    } catch { setNotice("The saved preparation did not match this company, period or supported editor version. Current edits were kept."); }
  };
  const loadClasses = (rows: NonNullable<EquipmentContextV2["schedule"]>["rows"]) => {
    const present = new Set(editor.classes.map((c) => c.label.trim()));
    const added = rows.filter((r) => !present.has(r.classLabel.trim())).map((r) => classFromScheduleRow(r, p.exponent));
    edit({ classes: [...editor.classes, ...added] }, true);
    setNotice(added.length ? `${added.length} recorded class${added.length === 1 ? "" : "es"} loaded with their carrying amounts and recorded movements. Enter the cost and accumulated columns, the records and the estimates; nothing is assumed.` : "Every recorded class is already in this preparation.");
  };
  const retainSource = async () => {
    if (!file || !read || !p.db.invokeForm || busy) return;
    setBusy(true); const g = generation.current;
    try {
      const form = new FormData(); form.set("companyId", p.companyId); form.set("periodYear", editor.priorDate.slice(0, 4)); form.set("file", file);
      const result = await p.db.invokeForm("financial-statement-intake", form);
      if (!live.current || generation.current !== g) return;
      const docId = (result.data as { documentId?: string } | null)?.documentId;
      if (result.error || !docId || !/^[a-f0-9-]{36}$/i.test(docId)) throw new Error("not confirmed");
      setSourceDocumentId(docId); setNotice("Original intake acknowledged. Save the preparation to have the server verify and link the original document fingerprint.");
    } catch { if (live.current && generation.current === g) setNotice("Original PDF retention was not confirmed. The existing intake requires accepted membership and an available malware scanner. Your local file is kept; no scan bypass is used."); }
    finally { if (live.current && generation.current === g) setBusy(false); }
  };
  const answerFor = (q: EvaluatedQuestion): Answer | undefined => (q.classId ? (editor.classes.find((c) => c.classId === q.classId)?.answers[q.def.id] as Answer | undefined) : (editor.entityAnswers[q.def.id] as Answer | undefined));
  const onAnswer = (q: EvaluatedQuestion, a: Answer) => {
    if (q.classId) edit({ classes: editor.classes.map((c) => (c.classId === q.classId ? { ...c, answers: { ...c.answers, [q.def.id]: a } } : c)) });
    else edit({ entityAnswers: { ...editor.entityAnswers, [q.def.id]: a } });
  };
  const nextStep = !priorSourceReady || !confirmed ? 1 : bridge.state !== "agrees" || grossBridge.state === "difference" ? 2 : !editor.classes.length || rolls.some((r) => r.state !== "agrees") || !coverageConfirmed ? 3 : tie.state !== "agrees" ? 4 : unresolved.length ? 5 : 6;
  const money = (m: string | null) => (m === null || value(m) === null ? "—" : `${formatMinor(m, p.exponent)} ${p.currency}`);
  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="font-semibold">Prepare equipment from supporting records</h2>
      <p className="text-sm text-muted-foreground">Read the prior report, agree the opening amounts, reconcile every class through cost and accumulated deductions, record the entity's estimates, answer only the questions that apply, then review the proposed wording. No AI credits are used.</p>
      {!opened ? <button type="button" className={buttonClass} onClick={() => setOpened(true)}>Start guided equipment preparation</button> : (
        <fieldset disabled={busy} className="min-w-0 space-y-5">
          <p role="status" className="text-sm">Workpaper draft in this browser only. Download it before leaving; only the server save below records classes, answers and notes.</p>
          {statementChanged ? (
            <div role="alert" className="rounded-md border border-border p-3">
              <p>The server statement inputs changed. Your workpaper is kept. Review the refreshed figures and supporting records before saving.</p>
              <button type="button" className={buttonClass} onClick={() => { setReviewedComposition(p.compositionSha256); setConfirmed(false); }}>Review refreshed statement figures</button>
            </div>
          ) : null}
          <nav aria-label="Equipment preparation steps" className="flex flex-wrap gap-3 text-sm">
            {["Prior report", "Opening bridge", "Classes and movements", "Depreciation destinations", "Questions", "Proposals and save"].map((label, index) => (
              <a key={label} href={`#${id}-step-${index + 1}`} aria-current={nextStep === index + 1 ? "step" : undefined} className="text-primary underline">{index + 1}. {label}{nextStep === index + 1 ? " — next" : ""}</a>
            ))}
          </nav>

          <section id={`${id}-step-1`} className="space-y-2 scroll-mt-24" aria-label="Prior report evidence">
            <h3 className="font-medium">1. Read the prior report</h3>
            <p className="text-sm">PDF, including scanned pages; English OCR runs on your device. Read the page with the equipment note. Figures are never automatically accepted; a prior audited report does not prove this year's policy or balances.</p>
            <label className="block">Available prior-year source
              <select className={inputClass} value={editor.sourceMode} disabled={reading} onChange={(e) => { edit({ sourceMode: e.target.value as "pdf" | "reference" }); setConfirmed(false); setRead(null); }}>
                <option value="pdf">Prior financial statements PDF or scan</option>
                <option value="reference">A figure from last year's ledger or register, with its reference</option>
              </select>
            </label>
            {editor.sourceMode === "reference" ? (
              <label className="block">Prior figure source reference
                <input maxLength={100} className={inputClass} value={editor.priorReference} onChange={(e) => { edit({ priorReference: e.target.value }); setConfirmed(false); }} />
              </label>
            ) : (
              <>
                <label className="block">Prior financial statements
                  <input type="file" accept="application/pdf,.pdf" className={inputClass} disabled={reading} onChange={(e) => resetSource(e.target.files?.[0] ?? null)} />
                </label>
                <label className="block">Page containing the equipment note
                  <input type="number" min="1" max="200" className={inputClass} value={editor.page} disabled={reading} onChange={(e) => { edit({ page: e.target.value }); setRead(null); setConfirmed(false); }} />
                </label>
                <label className="flex gap-2"><input type="checkbox" checked={forceOcr} disabled={reading} onChange={(e) => { setForceOcr(e.target.checked); setRead(null); setConfirmed(false); }} /><span>Use OCR even if the page has some selectable text</span></label>
                <button type="button" className={buttonClass} disabled={!file || reading} onClick={() => void readPage()}>Read this page locally</button>
                {reading ? <button type="button" className={buttonClass} onClick={() => { generation.current++; activeRead.current?.abort(); setReading(false); setNotice("Reading cancelled; no financial facts were recorded."); }}>Cancel reading</button> : null}
                {read ? (
                  <>
                    <p className="text-xs break-all">{file?.name} · page {read.page} of {read.pages} · {read.method === "ocr" ? "OCR — review required" : "Extracted text — review required"} · SHA-256 {read.sha256}</p>
                    {image ? <img src={image} alt={`Original prior-report page ${read.page}; check the figures against this page`} className="max-h-96 max-w-full border border-border object-contain" /> : null}
                    <details><summary>Show extracted text</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{read.text || "No readable text found. Read the image directly."}</pre></details>
                  </>
                ) : null}
              </>
            )}
            <label className="block">Prior reporting date (from the report)
              <input type="date" className={inputClass} value={editor.priorDate} onChange={(e) => { edit({ priorDate: e.target.value }); setConfirmed(false); }} />
            </label>
            <label className="block">Equipment net amount as printed at that date (cost less depreciation; the carrying amount)
              <input inputMode="decimal" className={inputClass} value={editor.priorAmount} onChange={(e) => { edit({ priorAmount: e.target.value }); setConfirmed(false); }} />
            </label>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="block">Gross amount (cost) as printed, if the note shows it
                <input inputMode="decimal" className={inputClass} value={editor.priorGross} onChange={(e) => { edit({ priorGross: e.target.value }); setConfirmed(false); }} />
              </label>
              <label className="block">Accumulated depreciation and impairment as printed, if shown
                <input inputMode="decimal" className={inputClass} value={editor.priorAccumulated} onChange={(e) => { edit({ priorAccumulated: e.target.value }); setConfirmed(false); }} />
              </label>
            </div>
            <label className="block">Currency printed in the source
              <input maxLength={3} className={inputClass} value={editor.priorCurrency} onChange={(e) => { edit({ priorCurrency: e.target.value.toUpperCase() }); setConfirmed(false); }} />
            </label>
            <label className="block">Units printed in the source (look for "'000" or similar in the column heading)
              <select className={inputClass} value={editor.priorUnits} onChange={(e) => { edit({ priorUnits: e.target.value as Editor["priorUnits"] }); setConfirmed(false); }}>
                <option value="">Check and choose</option><option value="0">Whole currency units</option><option value="3">Thousands</option><option value="6">Millions</option>
              </select>
            </label>
            <p className="text-sm">Normalized amount: {prior === null ? "enter an exact amount and choose its printed units" : `${formatMinor(prior, p.exponent)} ${editor.priorCurrency || "(currency not confirmed)"}`}.</p>
            <label className="flex gap-2">
              <input data-testid="confirm-prior-figure" type="checkbox" checked={confirmed} disabled={!priorSourceReady || prior === null || !editor.priorDate || !editor.priorCurrency} onChange={(e) => { setConfirmed(e.target.checked); setDirty(true); }} />
              <span>I checked the {editor.sourceMode === "pdf" ? "original page" : "referenced supporting record"}: {p.legalName}, reporting date, {p.currency}, units and the equipment amounts. The normalized amount above correctly reflects the printed units.</span>
            </label>
          </section>

          <section id={`${id}-step-2`} className="space-y-2 scroll-mt-24" aria-label="Opening bridge">
            <h3 className="font-medium">2. Agree this year's opening amount to last year's closing amount</h3>
            <p className="text-sm">The opening carrying amount is the sum of the classes below ({money(openingTotal)}). Prior closing plus explained adjustments must equal it; an unexplained residual is never an asset.</p>
            {editor.adjustments.map((a, i) => (
              <fieldset className="min-w-0 border border-border p-2 space-y-2" key={i}>
                <legend>Opening adjustment {i + 1}</legend>
                <label className="block">Kind
                  <select className={inputClass} value={a.category} onChange={(e) => edit({ adjustments: editor.adjustments.map((v, j) => (j === i ? { ...v, category: e.target.value as typeof a.category } : v)) })}>
                    <option value="">Choose</option><option value="correction">Approved correction of an error</option><option value="restatement">Authorised restatement (goes through Comparatives)</option><option value="scope_change">Scope change</option><option value="transition_adjustment">Transition to the IFRS for SMEs (deemed cost)</option><option value="other">Other (explain)</option>
                  </select>
                </label>
                {(["amount", "reason", "evidence"] as const).map((key) => (
                  <label className="block" key={key}>{key === "amount" ? "Adjustment amount (use a minus sign to reduce the opening amount)" : key === "reason" ? "Reason" : "Supporting record"}
                    <input className={inputClass} value={a[key]} onChange={(e) => edit({ adjustments: editor.adjustments.map((v, j) => (j === i ? { ...v, [key]: e.target.value } : v)) })} />
                  </label>
                ))}
                <button type="button" className={buttonClass} onClick={() => edit({ adjustments: editor.adjustments.filter((_, j) => i !== j) })}>Remove adjustment {i + 1}</button>
              </fieldset>
            ))}
            <button type="button" className={buttonClass} onClick={() => edit({ adjustments: [...editor.adjustments, { amount: "", reason: "", evidence: "", category: "" }] })}>Add an explained opening adjustment</button>
            <p className="text-sm">Expected opening anchor date from the saved period dates: {expectedPriorEnd ?? "unavailable"}{expectedPriorEnd ? "" : <> — <Link className="underline" to={p.hrefFor("fs-statements", p.reportVersion)}>record the period dates</Link> before recording the schedule</>}.</p>
            <p role="status" data-testid="bridge-status">Opening bridge: {bridge.state === "agrees" ? "arithmetic agrees; evidence still requires review" : bridge.state === "difference" ? `unexplained difference ${formatMinor(bridge.differenceMinor!, p.exponent)} ${p.currency}` : `more information needed. ${bridge.problems.join(" ")}`}</p>
            <p role="status" data-testid="gross-bridge-status">Gross amounts against the prior report: {grossBridge.state === "not_provided" ? "not compared (no printed gross or accumulated amounts entered)" : grossBridge.state === "agrees" ? "agree" : grossBridge.state === "incomplete" ? "more information needed" : `differ (gross ${grossBridge.grossDifferenceMinor === null ? "—" : formatMinor(grossBridge.grossDifferenceMinor, p.exponent)}, accumulated ${grossBridge.accumulatedDifferenceMinor === null ? "—" : formatMinor(grossBridge.accumulatedDifferenceMinor, p.exponent)}); explain the difference before recording`}.</p>
          </section>

          <section id={`${id}-step-3`} className="space-y-3 scroll-mt-24" aria-label="Equipment classes and movements">
            <h3 className="font-medium">3. Reconcile every class</h3>
            <p className="text-sm">Each class of equipment is disclosed separately. Two trial balances show a net change, not additions, disposals or cash flows: use a register, a ledger movement account you identified and reviewed, a journal or a reviewed workpaper for every change.</p>
            {context?.schedule ? <p className="text-sm">The recorded schedule has {context.schedule.rows.length} class{context.schedule.rows.length === 1 ? "" : "es"} ({context.schedule.rows.map((r) => r.classLabel).join(", ")}). Each must be kept or retired with a reason; a class is never dropped silently.</p> : null}
            {editor.classes.map((c, i) => (
              <ClassEditor key={c.classId} cls={c} derived={derived[i]} roll={rolls[i]} exponent={p.exponent} currency={p.currency} period={period} estimateProblems={classEstimateProblems[i]} canRemove
                onChange={(next) => setClass(i, next)} onRemove={() => edit({ classes: editor.classes.filter((_, j) => j !== i) }, true)} />
            ))}
            <button type="button" className={buttonClass} data-testid="add-class" onClick={() => edit({ classes: [...editor.classes, emptyEditorClass()] }, true)}>Add a class</button>
            {editor.retiredClasses.map((r, i) => (
              <fieldset key={i} className="min-w-0 space-y-1 border border-border p-2">
                <legend>Retired class {i + 1}</legend>
                {(["label", "reason", "evidence"] as const).map((key) => (
                  <label key={key} className="block text-sm">{key === "label" ? "Class name on the recorded schedule" : key === "reason" ? "Why it is no longer a class" : "Supporting record"}
                    <input className={inputClass} value={r[key]} onChange={(e) => edit({ retiredClasses: editor.retiredClasses.map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)) })} />
                  </label>
                ))}
                <button type="button" className={buttonClass} onClick={() => edit({ retiredClasses: editor.retiredClasses.filter((_, j) => j !== i) })}>Remove retirement {i + 1}</button>
              </fieldset>
            ))}
            {preservation.missing.length ? <button type="button" className={buttonClass} onClick={() => edit({ retiredClasses: [...editor.retiredClasses, ...preservation.missing.map((label) => ({ label, reason: "", evidence: "" }))] })}>Retire a recorded class with a reason</button> : null}
            {preservation.problems.length ? <p role="alert" className="text-sm" data-testid="preservation">{preservation.problems.join(" ")}</p> : null}
            <label className="flex gap-2">
              <input data-testid="confirm-movement-coverage" type="checkbox" checked={coverageConfirmed} onChange={(e) => { setCoverageConfirmed(e.target.checked); setDirty(true); }} />
              <span>I checked that every change in each class is listed with its record. A kind of change that is not listed did not happen, rather than being unknown.</span>
            </label>
            <p className="text-sm">Server statement closing amount: {p.statementClosingMinor === null ? "unavailable — complete presentation assignments first" : money(p.statementClosingMinor)}; classes total {money(closingTotal)}.</p>
            <p role="status" data-testid="statement-status">Statement check: {statementDifference === null ? "more information needed" : statementDifference === "0" ? "the classes agree to the server statement line" : `the classes differ from the server statement line by ${formatMinor(statementDifference, p.exponent)} ${p.currency}`}.</p>
          </section>

          <section id={`${id}-step-4`} className="space-y-2 scroll-mt-24" aria-label="Depreciation destinations">
            <h3 className="font-medium">4. Where the depreciation went</h3>
            <p className="text-sm">The depreciation per the classes ({tie.scheduleDepreciationMinor === null ? "not available" : money(tie.scheduleDepreciationMinor)}) must be accounted for by its destinations: the expense line it is presented in, and any amount capitalised into inventories or another asset. A difference is explained, never posted from here.</p>
            {editor.destinations.map((d, i) => (
              <fieldset key={i} className="min-w-0 space-y-1 border border-border p-2">
                <legend>Destination {i + 1}</legend>
                <label className="block text-sm">Target
                  <select className={inputClass} aria-label={`Destination ${i + 1} target`} value={d.target} onChange={(e) => edit({ destinations: editor.destinations.map((x, j) => (j === i ? { ...x, target: e.target.value as typeof d.target } : x)) })}>
                    <option value="">Choose</option>{DESTINATION_TARGETS.map((t) => <option key={t} value={t}>{DESTINATION_WORDS[t]}{p.composedLines.find((l) => l.lineId === t) ? ` (composed ${formatMinor(p.composedLines.find((l) => l.lineId === t)!.amountMinor, p.exponent)})` : t.startsWith("sci.") ? " (not composed for this entity)" : ""}</option>)}
                  </select>
                </label>
                <label className="block text-sm">Amount<input inputMode="decimal" className={inputClass} aria-label={`Destination ${i + 1} amount`} value={d.amountMinor} onChange={(e) => edit({ destinations: editor.destinations.map((x, j) => (j === i ? { ...x, amountMinor: e.target.value } : x)) })} /></label>
                <label className="block text-sm">Supporting record<input className={inputClass} aria-label={`Destination ${i + 1} evidence`} value={d.evidence} onChange={(e) => edit({ destinations: editor.destinations.map((x, j) => (j === i ? { ...x, evidence: e.target.value } : x)) })} /></label>
                <label className="block text-sm">Explanation of any difference from the composed line<input className={inputClass} aria-label={`Destination ${i + 1} explanation`} value={d.explanation} onChange={(e) => edit({ destinations: editor.destinations.map((x, j) => (j === i ? { ...x, explanation: e.target.value } : x)) })} /></label>
                <button type="button" className={buttonClass} onClick={() => edit({ destinations: editor.destinations.filter((_, j) => j !== i) })}>Remove destination {i + 1}</button>
              </fieldset>
            ))}
            <button type="button" className={buttonClass} data-testid="add-destination" onClick={() => edit({ destinations: [...editor.destinations, { target: "", amountMinor: "", evidence: "", explanation: "" }] })}>Add a destination</button>
            <p role="status" data-testid="tieout-status">Depreciation tie-out: {tie.state === "agrees" ? "the destinations account for the whole charge" : tie.state === "incomplete" ? `more information needed. ${tie.problems.join(" ")}` : tie.problems.join(" ")}</p>
          </section>

          <section id={`${id}-step-5`} className="space-y-2 scroll-mt-24" aria-label="Preparation questions">
            <h3 className="font-medium">5. Answer the questions that apply</h3>
            <p className="text-sm">Original preparation questions for the 2015 edition, each with its purpose, accepted evidence and paragraph; independent accounting review is pending. Only applicable questions are asked; answered ones are kept and reused.</p>
            <QuestionPanel questions={questions} answerFor={answerFor} onAnswer={onAnswer} priorAnswers={context?.priorAnswers ?? []} />
          </section>

          <section id={`${id}-step-6`} className="space-y-2 scroll-mt-24" aria-label="Proposals and save">
            <h3 className="font-medium">6. Review the proposed wording, then record</h3>
            <p className="text-sm">The server remains responsible for reconciliation and report readiness. A balanced preparation does not establish IFRS for SMEs compliance. Opening adjustments here do not amend approved comparatives; record and approve any restatement through Comparatives.</p>
            {canCommitNotes ? (
              <>
                {(["smes.note.policies", "smes.note.estimates", "smes.note.subclassifications"] as const).map((r) => (
                  <label key={r} className="block">Proposed {r === "smes.note.policies" ? "equipment policy" : r === "smes.note.estimates" ? "equipment estimates" : "equipment note"} section — review required
                    <textarea readOnly rows={8} className={inputClass} value={proposals[r] ?? ""} data-testid={`proposal-${r}`} />
                  </label>
                ))}
              </>
            ) : <p className="text-sm" data-testid="proposals-pending">{ready ? "Answer every applicable question to prepare the proposed wording." : "Complete the bridge, every class, the destinations and the questions to prepare the proposed wording."}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={exportWorkpaper}>Download preparation workpaper</button>
              {p.db?.invokeForm ? <button type="button" className={buttonClass} disabled={busy || !file || !read || !confirmed || !editor.priorDate} onClick={() => void retainSource()}>Store original PDF through checked intake</button> : null}
            </div>
            {!ready ? <p className="text-sm" data-testid="not-ready">Before recording: confirm the prior figure and date, agree the opening bridge, reconcile every class with its records and estimates, account for the depreciation charge, and agree the classes to the server statement.</p> : null}
            <Link className="block text-primary underline" to={p.hrefFor("fs-notes", p.reportVersion)}>Next: review accounting policies and equipment disclosures in Notes</Link>
            <Link className="block text-primary underline" to={p.hrefFor("fs-comparatives", p.reportVersion)}>Review comparative figures and any restatement</Link>
          </section>
          {p.db ? (
            <EquipmentServerBridge key={`${p.companyId}:${p.periodYear}`} db={p.db} companyId={p.companyId} periodYear={p.periodYear} payload={buildWorkpaper()} canCommit={ready} canCommitNotes={canCommitNotes} proposals={proposals}
              sourceDocumentId={sourceDocumentId} onContext={setContext} onRestore={restore} onLoadClasses={loadClasses} refresh={p.refresh} newRequestId={p.newRequestId} />
          ) : null}
          <p className="text-xs text-muted-foreground">Questions: {questions.length} applicable, {unresolved.length} unresolved ({unresolved.map(questionKey).slice(0, 6).join(", ")}{unresolved.length > 6 ? ", …" : ""}).</p>
          <Notice text={notice} />
        </fieldset>
      )}
    </section>
  );
}
