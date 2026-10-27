import { useEffect, useId, useRef, useState } from "react";
import { workpaperClient } from "@/lib/preparation/workpaperClient";
import { parseEquipmentEditor } from "@/lib/preparation/editorSchema";
import { EquipmentServerBridge } from "./EquipmentServerBridge";
import {
  EQUIPMENT_QUESTIONS,
  EQUIPMENT_SOURCE,
  EQUIPMENT_CONTENT_VERSION,
  grossReconciliation,
  preparationInputs,
  type GrossBalances,
} from "@/lib/preparation/equipmentRequirements";
import { Link } from "react-router-dom";
import { useManagementEditGuard } from "@/components/account/managementState";
import { presentationPending } from "@/lib/reporting/preparationGuidance";
import { IFRS_FOR_SMES_2015 } from "@/lib/frameworkPacks/ifrsForSmes";
import {
  openingBridge,
  openingAnchorDate,
  reconcileEquipment,
  policyDraft,
  formatMinor,
  parseSourceAmount,
  type BridgeAdjustment,
  type EquipmentPolicy,
  type SourceFact,
} from "@/lib/preparation/equipment";
import { readPriorPage, type ReadPage } from "@/lib/preparation/priorReport";
import { Notice, outcomeText, useAttempt, type PageProps } from "./shared";
const signedMinor = (text: string, exponent: number) =>
  parseSourceAmount(text, exponent, 0);

const definition = IFRS_FOR_SMES_2015.schedules.find((s) => s.id === "ppe")!;
const initialPolicy: EquipmentPolicy = {
  assetClass: "",
  basis: "",
  method: "",
  usefulLife: "",
  residualValue: "",
  rationale: "",
  evidence: "",
};
const inputClass =
  "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2";
const buttonClass =
  "rounded-md border border-input px-3 py-2 disabled:opacity-50";

/** A workpaper is not an approval. Only Record schedule writes, through the existing server authority. */
export function EquipmentPreparation(p: PageProps) {
  const c = p.state.composition;
  if (
    !c ||
    c.state !== "composed" ||
    c.pack.packId !== "ifrs-for-smes/2015" ||
    !p.allowed.includes("prepare_close")
  )
    return null;
  // A different workspace/period unmounts pending work; a changed statement keeps the draft and requires renewed review.
  return (
    <EquipmentWorkpaper
      key={`${p.companyId}:${p.periodYear}`}
      {...p}
      currency={c.current.currency}
      exponent={c.current.exponent}
      compositionSha256={c.compositionSha256}
      statementClosingMinor={
        presentationPending(c)
          ? null
          : (c.lines.find(
              (l) => l.lineId === "sfp.property_plant_and_equipment",
            )?.current.amountMinor ?? null)
      }
    />
  );
}

function EquipmentWorkpaper(
  p: PageProps & {
    currency: string;
    exponent: number;
    compositionSha256: string;
    statementClosingMinor: string | null;
  },
) {
  const [reviewedComposition, setReviewedComposition] = useState(
    p.compositionSha256,
  );
  const statementChanged = reviewedComposition !== p.compositionSha256;
  const [expectedPriorEnd, setExpectedPriorEnd] = useState<string | null>(null);
  const existingSchedule =
    p.state.notes &&
    "requirements" in p.state.notes &&
    p.state.notes.requirements.some(
      (r) => r.requirementId === "smes.schedule.ppe" && !!r.submissionId,
    );
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  const [gross, setGross] = useState<Record<keyof GrossBalances, string>>({
    openingGross: "",
    openingDepreciation: "",
    openingImpairment: "",
    closingGross: "",
    closingDepreciation: "",
    closingImpairment: "",
  });
  const [judgements, setJudgements] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState(false),
    [dirty, setDirty] = useState(false);
  const [sourceMode, setSourceMode] = useState<"pdf" | "reference">("pdf"),
    [priorReference, setPriorReference] = useState("");
  const [file, setFile] = useState<File | null>(null),
    [page, setPage] = useState("1");
  const [forceOcr, setForceOcr] = useState(false);
  const [reading, setReading] = useState(false),
    [read, setRead] = useState<ReadPage | null>(null),
    [image, setImage] = useState("");
  const [priorCurrency, setPriorCurrency] = useState(""),
    [priorUnits, setPriorUnits] = useState("");
  const [priorAmount, setPriorAmount] = useState(""),
    [priorDate, setPriorDate] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const [opening, setOpening] = useState(""),
    [closing, setClosing] = useState("");
  const [adjustments, setAdjustments] = useState<
    { amount: string; reason: string; evidence: string }[]
  >([]);
  const [movementCoverageConfirmed, setMovementCoverageConfirmed] =
    useState(false);
  const [movementValues, setMovementValues] = useState<Record<string, string>>(
      {},
    ),
    [source, setSource] = useState("");
  const [policy, setPolicy] = useState<EquipmentPolicy>(initialPolicy);
  const [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    live = useRef(true),
    activeRead = useRef<AbortController | null>(null);
  const attempt = useAttempt(p.newRequestId),
    id = useId();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      activeRead.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!read || read.preview.size === 0) {
      setImage("");
      return;
    }
    const url = URL.createObjectURL(read.preview);
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [read]);
  useManagementEditGuard(dirty, busy || reading, () => {
    setDirty(false);
    setOpened(false);
  });
  useEffect(() => {
    if (!opened) return;
    let current = true;
    p.clients.signoff.input(p.companyId, p.periodYear).then(
      (i) => {
        if (current)
          setExpectedPriorEnd(
            openingAnchorDate(
              i.comparative?.reportingEnd,
              i.current?.reportingStart,
            ),
          );
      },
      () => {
        if (current) setExpectedPriorEnd(null);
      },
    );
    return () => {
      current = false;
    };
  }, [opened, p.clients, p.companyId, p.periodYear, p.compositionSha256]);
  const touch = (movementChange = false) => {
    setDirty(true);
    if (movementChange) setMovementCoverageConfirmed(false);
  };
  const resetSource = (f: File | null) => {
    generation.current++;
    activeRead.current?.abort();
    setReading(false);
    setFile(f);
    setSourceDocumentId(null);
    setRead(null);
    setConfirmed(false);
    setPriorAmount("");
    setNotice(null);
    touch();
  };
  const readPage = async () => {
    if (
      !file ||
      reading ||
      (activeRead.current && !activeRead.current.signal.aborted)
    )
      return;
    const g = ++generation.current,
      controller = new AbortController();
    activeRead.current = controller;
    setReading(true);
    setRead(null);
    setConfirmed(false);
    setNotice(null);
    try {
      const result = await readPriorPage(
        file,
        Number(page),
        controller.signal,
        (text) => {
          if (live.current && generation.current === g) setNotice(text);
        },
        forceOcr,
      );
      if (live.current && generation.current === g) {
        setRead(result);
        setNotice(
          "Page read locally. Compare the original page, then confirm the figure and its units.",
        );
      }
    } catch {
      if (live.current && generation.current === g)
        setNotice(
          "The page could not be read. Try a different page or a clearer PDF. No financial facts were recorded.",
        );
    } finally {
      if (live.current && generation.current === g) {
        activeRead.current = null;
        setReading(false);
      }
    }
  };
  const op = signedMinor(opening, p.exponent),
    cl = signedMinor(closing, p.exponent),
    prior =
      priorUnits === ""
        ? null
        : parseSourceAmount(priorAmount, p.exponent, Number(priorUnits));
  const priorSourceReady =
    sourceMode === "pdf" ? !!read : priorReference.trim().length >= 3;
  const fact: SourceFact | null =
    priorSourceReady && prior !== null
      ? {
          origin: sourceMode === "pdf" ? "document" : "manual",
          sourceRef: sourceMode === "reference" ? priorReference : undefined,
          documentSha256: sourceMode === "pdf" ? read!.sha256 : null,
          page: sourceMode === "pdf" ? read!.page : null,
          entity: p.legalName,
          periodEnd: priorDate,
          currency: priorCurrency,
          printedAmount: priorAmount,
          printedUnitsExponent: Number(priorUnits),
          scale: p.exponent,
          label: "Equipment carrying amount",
          amountMinor: prior,
          confirmed,
        }
      : null;
  const bridgeRows: BridgeAdjustment[] = adjustments.map((a) => ({
    amountMinor: signedMinor(a.amount, p.exponent) ?? "",
    reason: a.reason,
    evidence: a.evidence,
  }));
  const bridge = openingBridge(fact, bridgeRows, op ?? "", {
    entity: p.legalName,
    priorPeriodEnd: expectedPriorEnd ?? "",
    currency: p.currency,
    exponent: p.exponent,
  });
  const movements = definition.movements
    .filter((m) => (movementValues[m.kind] ?? "").trim())
    .map((m) => {
      const n = signedMinor(movementValues[m.kind], p.exponent);
      return {
        kind: m.kind,
        amountMinor:
          n === null
            ? ""
            : m.sign === "decrease" && BigInt(n) > 0n
              ? (-BigInt(n)).toString()
              : n,
        evidence: source,
      };
    });
  const rec = reconcileEquipment(
    op ?? "",
    movements,
    cl ?? "",
    p.statementClosingMinor,
  );
  const draft = policyDraft(policy);
  const ready =
    movementCoverageConfirmed &&
    !statementChanged &&
    !existingSchedule &&
    bridge.state === "agrees" &&
    rec.state === "agrees" &&
    policy.assetClass.trim().length >= 3 &&
    source.trim().length >= 3 &&
    /^\d{4}-\d{2}-\d{2}$/.test(priorDate);
  const buildWorkpaper = () => ({
    contract: "cfoclose-equipment-workpaper/1",
    status: "preparation-not-approval",
    companyId: p.companyId,
    periodYear: p.periodYear,
    compositionSha256: reviewedComposition,
    statementChanged,
    currency: p.currency,
    exponent: p.exponent,
    priorSource: {
      fileName: file?.name ?? null,
      fact,
      extraction: read
        ? {
            method: read.method,
            text: read.text.slice(0, 8000),
            characterCount: read.text.length,
            excerptTruncated: read.text.length > 8000,
          }
        : null,
    },
    openingBridge: {
      adjustments: bridgeRows,
      openingMinor: op,
      result: bridge,
    },
    schedule: {
      classLabel: policy.assetClass,
      movementCoverageConfirmed,
      movements,
      closingMinor: cl,
      result: rec,
    },
    policy: { answers: policy, draft },
    contentVersion: EQUIPMENT_CONTENT_VERSION,
    editor: {
      sourceMode,
      priorReference,
      page,
      priorAmount,
      priorDate,
      priorCurrency,
      priorUnits,
      opening,
      closing,
      adjustments,
      movementValues,
      source,
      policy,
      gross,
      judgements,
      read: read
        ? {
            sha256: read.sha256,
            page: read.page,
            pages: read.pages,
            text: read.text,
            method: read.method,
          }
        : null,
    },
    grossBalances: gross,
    judgements,
    exclusions: [
      "Not an audit or framework compliance conclusion",
      "Policy draft has not been saved in report notes",
      "Original PDF must be retained separately",
    ],
  });
  const exportWorkpaper = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(buildWorkpaper(), null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `equipment-workpaper-${p.companyId}-FY${p.periodYear}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(
      "Workpaper downloaded. Keep the original PDF with it. The download is not a server save or an approval.",
    );
  };
  const restore = (data: unknown, documentId: string | null) => {
    try {
      const parsed = parseEquipmentEditor(data, p.companyId, p.periodYear);
      generation.current++;
      activeRead.current?.abort();
      setReading(false);
      setFile(null);
      setSourceDocumentId(documentId);
      setSourceMode(parsed.sourceMode);
      setPriorReference(parsed.priorReference);
      setPage(parsed.page);
      setPriorAmount(parsed.priorAmount);
      setPriorDate(parsed.priorDate);
      setPriorCurrency(parsed.priorCurrency);
      setPriorUnits(parsed.priorUnits);
      setOpening(parsed.opening);
      setClosing(parsed.closing);
      setAdjustments(parsed.adjustments);
      setMovementValues(parsed.movementValues);
      setSource(parsed.source);
      setPolicy(parsed.policy);
      setGross(parsed.gross);
      setJudgements(parsed.judgements);
      setRead(parsed.read ? { ...parsed.read, preview: new Blob([]) } : null);
      setConfirmed(false);
      setMovementCoverageConfirmed(false);
      setDirty(true);
      setNotice(
        "Saved answers restored for review. The original page preview is not loaded. Reconfirm source figures and movement coverage before recording a schedule.",
      );
    } catch {
      setNotice(
        "Saved preparation did not match this company, period or supported editor version. Current edits were kept.",
      );
    }
  };
  const retainSource = async () => {
    if (!file || !read || !p.db.invokeForm || busy) return;
    setBusy(true);
    const g = generation.current;
    try {
      const form = new FormData();
      form.set("companyId", p.companyId);
      form.set("periodYear", priorDate.slice(0, 4));
      form.set("file", file);
      const result = await p.db.invokeForm("financial-statement-intake", form);
      if (!live.current || generation.current !== g) return;
      const id = (result.data as { documentId?: string } | null)?.documentId;
      if (result.error || !id || !/^[a-f0-9-]{36}$/i.test(id))
        throw new Error("not confirmed");
      setSourceDocumentId(id);
      setNotice(
        "Original intake acknowledged. Save the workpaper to have the server verify and link the original document fingerprint.",
      );
    } catch {
      if (live.current && generation.current === g)
        setNotice(
          "Original PDF retention was not confirmed. The existing intake requires accepted membership and an available malware scanner. Your local file is kept; no scan bypass is used.",
        );
    } finally {
      if (live.current && generation.current === g) setBusy(false);
    }
  };
  const grossResult = grossReconciliation(
    Object.fromEntries(
      Object.entries(gross).map(([k, v]) => [
        k,
        signedMinor(v, p.exponent) ?? "",
      ]),
    ) as GrossBalances,
    op,
    cl,
  );
  const preparation = preparationInputs(
    policy,
    grossResult.state,
    movementCoverageConfirmed ? rec.state : "incomplete",
    judgements,
  );
  const missingPreparation = preparation.filter((q) => !q.entered).length;
  const equipmentNote =
    missingPreparation === 0 && draft.text && op !== null && cl !== null
      ? [
          `${policy.assetClass} — equipment disclosure draft`,
          `Currency: ${p.currency}; amounts in whole currency units.`,
          `Opening gross amount ${gross.openingGross}; accumulated depreciation ${gross.openingDepreciation}; accumulated impairment ${gross.openingImpairment}; carrying amount ${formatMinor(op, p.exponent)}.`,
          `Closing gross amount ${gross.closingGross}; accumulated depreciation ${gross.closingDepreciation}; accumulated impairment ${gross.closingImpairment}; carrying amount ${formatMinor(cl, p.exponent)}.`,
          ...movements.map(
            (m) =>
              `${definition.movements.find((d) => d.kind === m.kind)?.label ?? m.kind}: ${formatMinor(m.amountMinor, p.exponent)}.`,
          ),
          `Component assessment: ${judgements.components}.`,
          `Restrictions, security and purchase commitments: ${judgements.restrictions}.`,
          policy.basis === "revaluation"
            ? `Valuation information: ${judgements.revaluation}.`
            : null,
          `Supporting movement record: ${source}. See the accounting policies for measurement and depreciation estimates.`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : null;
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const g = generation.current;
    const rows = [
      {
        classLabel: policy.assetClass.trim(),
        openingMinor: op!,
        closingMinor: cl!,
        movements: movements.map(({ kind, amountMinor }) => ({
          kind,
          amountMinor,
        })),
      },
    ];
    const reference =
      sourceMode === "pdf"
        ? `PPE workpaper; prior sha256 ${read!.sha256} page ${read!.page}; ${source.trim()}`
        : `PPE workpaper; manual prior reference ${priorReference.trim().slice(0, 100)}; ${source.trim()}`;
    try {
      const r = await workpaperClient(p.db).createSchedule(
        p.companyId,
        p.periodYear,
        rows,
        reference,
        attempt.idFor(
          JSON.stringify([p.companyId, p.periodYear, rows, reference]),
        ),
      );
      if (!live.current || generation.current !== g) return;
      if (
        r.outcome === "recorded" &&
        typeof r.submissionId === "string" &&
        /^[a-f0-9-]{36}$/i.test(r.submissionId)
      ) {
        attempt.done();
        setNotice(
          "Schedule recorded. Policy wording and the original PDF are not stored by this action. Download the workpaper, then review the policy draft in Notes.",
        );
        try {
          await p.refresh();
        } catch {
          if (live.current && generation.current === g)
            setNotice(
              `Schedule recorded (receipt ${r.submissionId}). The status could not be refreshed. Reload the page to check the server reconciliation; another save is not needed. Policy wording and the original PDF are not stored by this action.`,
            );
        }
      } else
        setNotice(
          r.outcome === "recorded"
            ? "Could not confirm the schedule save: the server receipt is incomplete. Retry the same unchanged schedule."
            : r.outcome === "schedule_exists"
              ? "A PPE schedule was recorded while you were preparing. Nothing was replaced. Open the full schedule editor to review every asset class."
              : outcomeText({ ...r, outcome: r.outcome }),
        );
    } catch {
      if (live.current && generation.current === g)
        setNotice(
          "Could not confirm the schedule save. Send the same unchanged schedule again to retrieve the server result without duplicating it.",
        );
    } finally {
      if (live.current && generation.current === g) setBusy(false);
    }
  };
  const copyPolicy = async () => {
    if (!draft.text) return;
    try {
      await navigator.clipboard.writeText(draft.text);
      if (live.current)
        setNotice(
          "Policy draft copied. Review and combine it with other applicable policies in Notes; it has not been saved or approved.",
        );
    } catch {
      if (live.current)
        setNotice(
          "Clipboard access was unavailable. Select and copy the policy draft below.",
        );
    }
  };
  const nextStep =
    !priorSourceReady || !confirmed
      ? 1
      : bridge.state !== "agrees"
        ? 2
        : rec.state !== "agrees"
          ? 3
          : !draft.text || missingPreparation > 0
            ? 4
            : 5;
  const editPolicy = (key: keyof EquipmentPolicy, value: string) => {
    setPolicy((v) => ({ ...v, [key]: value }));
    touch();
  };
  return (
    <section
      className="rounded-lg border border-border p-4 space-y-4"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="font-semibold">
        Prepare equipment from supporting records
      </h2>
      <p className="text-sm text-muted-foreground">
        Review the prior report, explain the opening bridge, reconcile
        movements, then draft the policy. No AI credits are used.
      </p>
      {!opened ? (
        <button
          type="button"
          className={buttonClass}
          onClick={() => setOpened(true)}
        >
          Start guided equipment preparation
        </button>
      ) : (
        <fieldset disabled={busy} className="space-y-5">
          <p role="status" className="text-sm">
            Workpaper draft in this browser only. Download it before leaving;
            only Record schedule saves the schedule to CFOClose. This replaces
            the entire PPE schedule, so use the existing multi-class editor if
            you have more than one class.
          </p>
          {statementChanged ? (
            <div role="alert" className="rounded-md border border-border p-3">
              <p>
                The server statement inputs changed. Your workpaper is kept.
                Review the refreshed figures and supporting records before
                saving.
              </p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setReviewedComposition(p.compositionSha256);
                  setConfirmed(false);
                }}
              >
                Review refreshed statement figures
              </button>
            </div>
          ) : null}
          <nav
            aria-label="Equipment preparation steps"
            className="flex flex-wrap gap-3 text-sm"
          >
            {[
              "Prior report",
              "Opening bridge",
              "Movements",
              "Policy",
              "Save and complete",
            ].map((label, index) => (
              <a
                key={label}
                href={`#${id}-step-${index + 1}`}
                aria-current={nextStep === index + 1 ? "step" : undefined}
                className="text-primary underline"
              >
                {index + 1}. {label}
                {nextStep === index + 1 ? " — next" : ""}
              </a>
            ))}
          </nav>
          <section
            id={`${id}-step-1`}
            className="space-y-2 scroll-mt-24"
            aria-label="Prior report evidence"
          >
            <h3 className="font-medium">1. Read the prior report</h3>
            <p className="text-sm">
              PDF, including scanned pages; English OCR runs on your device.
              Read one relevant page at a time. Figures are never automatically
              accepted. A prior audited report does not prove this year's policy
              or balances.
            </p>
            <label className="block">
              Available prior-year source
              <select
                className={inputClass}
                value={sourceMode}
                disabled={reading}
                onChange={(e) => {
                  setSourceMode(e.target.value as "pdf" | "reference");
                  setConfirmed(false);
                  setRead(null);
                  touch();
                }}
              >
                <option value="pdf">
                  Prior financial statements PDF or scan
                </option>
                <option value="reference">
                  Reviewed figure from another available record
                </option>
              </select>
            </label>
            {sourceMode === "reference" ? (
              <>
                <p className="text-sm">
                  Manual entry with a source reference; no original document
                  fingerprint or audited status is inferred. Keep the supporting
                  record separately.
                </p>
                <label className="block">
                  Prior figure source reference
                  <input
                    maxLength={100}
                    className={inputClass}
                    value={priorReference}
                    onChange={(e) => {
                      setPriorReference(e.target.value);
                      setConfirmed(false);
                      touch();
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="block">
                  Prior financial statements
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className={inputClass}
                    disabled={reading}
                    onChange={(e) => resetSource(e.target.files?.[0] ?? null)}
                  />
                </label>
                <label className="block">
                  Page containing the equipment note
                  <input
                    type="number"
                    min="1"
                    max="200"
                    className={inputClass}
                    value={page}
                    disabled={reading}
                    onChange={(e) => {
                      setPage(e.target.value);
                      setRead(null);
                      setConfirmed(false);
                      touch();
                    }}
                  />
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={forceOcr}
                    disabled={reading}
                    onChange={(e) => {
                      setForceOcr(e.target.checked);
                      setRead(null);
                      setConfirmed(false);
                      touch();
                    }}
                  />
                  <span>
                    Use OCR even if the page has some selectable text (for a
                    scanned table with a text heading)
                  </span>
                </label>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!file || reading}
                  onClick={() => void readPage()}
                >
                  Read this page locally
                </button>
                {reading ? (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => {
                      generation.current++;
                      activeRead.current?.abort();
                      setReading(false);
                      setNotice(
                        "Reading cancelled; no financial facts were recorded.",
                      );
                    }}
                  >
                    Cancel reading
                  </button>
                ) : null}
                {read ? (
                  <>
                    <p className="text-xs break-all">
                      {file?.name} · page {read.page} of {read.pages} ·{" "}
                      {read.method === "ocr"
                        ? "OCR — review required"
                        : "Extracted text — review required"}{" "}
                      · SHA-256 {read.sha256}
                    </p>
                    {image ? (
                      <img
                        src={image}
                        alt={`Original prior-report page ${read.page}; check the figure against this page`}
                        className="max-h-96 max-w-full border border-border object-contain"
                      />
                    ) : null}
                    <details>
                      <summary>Show extracted text</summary>
                      <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">
                        {read.text ||
                          "No readable text found. Read the image directly."}
                      </pre>
                    </details>
                  </>
                ) : null}
              </>
            )}
            <label className="block">
              Prior reporting date (from the report)
              <input
                type="date"
                className={inputClass}
                value={priorDate}
                onChange={(e) => {
                  setPriorDate(e.target.value);
                  setConfirmed(false);
                  touch();
                }}
              />
            </label>
            <label className="block">
              Equipment carrying amount as printed at that date
              <input
                inputMode="decimal"
                className={inputClass}
                value={priorAmount}
                onChange={(e) => {
                  setPriorAmount(e.target.value);
                  setConfirmed(false);
                  touch();
                }}
              />
            </label>
            <label className="block">
              Currency printed in the source
              <input
                maxLength={3}
                className={inputClass}
                value={priorCurrency}
                onChange={(e) => {
                  setPriorCurrency(e.target.value.toUpperCase());
                  setConfirmed(false);
                  touch();
                }}
              />
            </label>
            <label className="block">
              Units printed in the source
              <select
                className={inputClass}
                value={priorUnits}
                onChange={(e) => {
                  setPriorUnits(e.target.value);
                  setConfirmed(false);
                  touch();
                }}
              >
                <option value="">Check and choose</option>
                <option value="0">Whole currency units</option>
                <option value="3">Thousands</option>
                <option value="6">Millions</option>
              </select>
            </label>
            <p className="text-sm">
              Normalized amount:{" "}
              {prior === null
                ? "enter an exact amount and choose its printed units"
                : `${formatMinor(prior, p.exponent)} ${priorCurrency || "(currency not confirmed)"}`}
              .
            </p>
            <label className="flex gap-2">
              <input
                data-testid="confirm-prior-figure"
                type="checkbox"
                checked={confirmed}
                disabled={
                  !priorSourceReady ||
                  prior === null ||
                  !priorDate ||
                  !priorCurrency
                }
                onChange={(e) => {
                  setConfirmed(e.target.checked);
                  touch();
                }}
              />
              <span>
                I checked the{" "}
                {sourceMode === "pdf"
                  ? "original page"
                  : "referenced supporting record"}
                : {p.legalName}, reporting date, {p.currency}, units and
                equipment carrying amount. The normalized amount above correctly
                reflects the printed units.
              </span>
            </label>
          </section>
          <section
            id={`${id}-step-2`}
            className="space-y-2 scroll-mt-24"
            aria-label="Opening bridge"
          >
            <h3 className="font-medium">2. Explain the opening position</h3>
            <p className="text-sm">
              Use the opening ledger or reviewed asset register. Prior closing
              and current opening need a supported bridge; an unexplained
              residual is not automatically a receivable or asset.
            </p>
            <label className="block">
              Current opening carrying amount
              <input
                inputMode="decimal"
                className={inputClass}
                value={opening}
                onChange={(e) => {
                  setOpening(e.target.value);
                  touch(true);
                }}
              />
            </label>
            {adjustments.map((a, i) => (
              <fieldset className="border border-border p-2 space-y-2" key={i}>
                <legend>Opening adjustment {i + 1}</legend>
                {(["amount", "reason", "evidence"] as const).map((key) => (
                  <label className="block" key={key}>
                    {key === "amount"
                      ? "Signed adjustment amount"
                      : key === "reason"
                        ? "Reason"
                        : "Supporting record"}
                    <input
                      className={inputClass}
                      value={a[key]}
                      onChange={(e) => {
                        setAdjustments((old) =>
                          old.map((v, j) =>
                            j === i ? { ...v, [key]: e.target.value } : v,
                          ),
                        );
                        touch();
                      }}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    setAdjustments((old) => old.filter((_, j) => i !== j));
                    touch();
                  }}
                >
                  Remove adjustment {i + 1}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setAdjustments((old) => [
                  ...old,
                  { amount: "", reason: "", evidence: "" },
                ]);
                touch();
              }}
            >
              Add an explained opening adjustment
            </button>
            <p className="text-sm">
              Expected opening anchor date from saved period dates:{" "}
              {expectedPriorEnd ??
                "unavailable — record the period dates in Trial Balance intake before saving this workpaper schedule"}
              .
            </p>
            <p role="status">
              Opening bridge:{" "}
              {bridge.state === "agrees"
                ? "arithmetic agrees; evidence still requires review"
                : bridge.state === "difference"
                  ? `unexplained difference ${formatMinor(bridge.differenceMinor!, p.exponent)} ${p.currency}`
                  : "more information needed"}
            </p>
          </section>
          <section
            id={`${id}-step-3`}
            className="space-y-2 scroll-mt-24"
            aria-label="Equipment movements"
          >
            <h3 className="font-medium">3. Reconcile movements</h3>
            <p className="text-sm">
              Two trial balances show a net change, not automatically additions,
              disposals or cash flows. Use a register or ledger, or identify and
              review explicit movement accounts. Leave unused movement fields
              blank; enter a known zero as zero.
            </p>
            {definition.movements.map((m) => (
              <label key={m.kind} className="block">
                {m.label}
                {m.sign === "decrease"
                  ? " (positive amount for a decrease)"
                  : m.sign === "either"
                    ? " (signed amount)"
                    : ""}
                <input
                  inputMode="decimal"
                  className={inputClass}
                  value={movementValues[m.kind] ?? ""}
                  onChange={(e) => {
                    setMovementValues((old) => ({
                      ...old,
                      [m.kind]: e.target.value,
                    }));
                    touch(true);
                  }}
                />
              </label>
            ))}
            <label className="block">
              Closing carrying amount
              <input
                inputMode="decimal"
                className={inputClass}
                value={closing}
                onChange={(e) => {
                  setClosing(e.target.value);
                  touch(true);
                }}
              />
            </label>
            <label className="block">
              Register, ledger or reviewed movement-account working paper
              <input
                maxLength={100}
                className={inputClass}
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  touch(true);
                }}
              />
            </label>
            <label className="flex gap-2">
              <input
                data-testid="confirm-movement-coverage"
                type="checkbox"
                checked={movementCoverageConfirmed}
                onChange={(e) => {
                  setMovementCoverageConfirmed(e.target.checked);
                  setDirty(true);
                }}
              />
              <span>
                I checked that these movements cover every change. Blank
                movement types have no applicable movement, rather than missing
                information.
              </span>
            </label>
            <p className="text-sm">
              Server statement closing amount:{" "}
              {p.statementClosingMinor === null
                ? "unavailable — complete presentation assignments first"
                : `${formatMinor(p.statementClosingMinor, p.exponent)} ${p.currency}`}
            </p>
            <p role="status">
              Movement and statement checks:{" "}
              {rec.state === "agrees"
                ? "arithmetic agrees; evidence still requires review"
                : rec.problems.join(" ")}
            </p>
          </section>
          <section
            id={`${id}-step-4`}
            className="space-y-2 scroll-mt-24"
            aria-label="Equipment policy"
          >
            <h3 className="font-medium">4. Confirm the policy choices</h3>
            <p role="status" className="text-sm">
              Equipment preparation inputs: {missingPreparation} still need
              attention. Entered answers still require accounting review; this
              is not a compliance verdict.
            </p>
            <details open>
              <summary>Preparation questions and source references</summary>
              <p className="text-sm">
                SME 2015 only. These questions are original preparation
                guidance, not a complete compliance checklist. Independent
                accounting review is pending.
              </p>
              <ul className="space-y-3">
                {preparation.map((q) => (
                  <li key={q.id}>
                    <p className="font-medium">
                      {q.question} —{" "}
                      {q.entered
                        ? "input supplied; review required"
                        : "needs input"}
                    </p>
                    {q.usesExistingFields ? (
                      <p className="text-sm">
                        Answer using the measurement, estimates, movements or
                        gross-balance fields on this page.
                      </p>
                    ) : (
                      <label className="block">
                        Your answer and supporting record
                        <textarea
                          maxLength={2000}
                          aria-label={`${q.question} — answer and supporting record`}
                          className={inputClass}
                          value={judgements[q.id] ?? ""}
                          onChange={(e) => {
                            setJudgements((old) => ({
                              ...old,
                              [q.id]: e.target.value,
                            }));
                            touch();
                          }}
                        />
                      </label>
                    )}
                    <p className="text-sm">{q.evidence}</p>
                    <a
                      href={EQUIPMENT_SOURCE.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm underline"
                    >
                      Source reference: {q.refs.join(", ")}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
            <details>
              <summary>Gross amounts, depreciation and impairment</summary>
              <p className="text-sm">
                Enter accumulated deductions as positive amounts for this
                reconciliation. This does not change the original ledger credit
                signs. Blank is unknown; enter zero only when verified.
              </p>
              {(Object.keys(gross) as (keyof GrossBalances)[]).map((key) => (
                <label key={key} className="block">
                  {
                    {
                      openingGross: "Opening gross amount",
                      openingDepreciation: "Opening accumulated depreciation",
                      openingImpairment: "Opening accumulated impairment",
                      closingGross: "Closing gross amount",
                      closingDepreciation: "Closing accumulated depreciation",
                      closingImpairment: "Closing accumulated impairment",
                    }[key]
                  }
                  <input
                    inputMode="decimal"
                    className={inputClass}
                    value={gross[key]}
                    onChange={(e) => {
                      setGross((old) => ({ ...old, [key]: e.target.value }));
                      touch();
                    }}
                  />
                </label>
              ))}
              <p role="status">
                Gross-to-net checks:{" "}
                {grossResult.state === "agrees"
                  ? "opening and closing arithmetic agrees"
                  : grossResult.state === "incomplete"
                    ? "gross amounts or deductions are still missing"
                    : "gross amounts and deductions do not agree to the carrying amounts"}
                .
              </p>
              <p className="text-sm">
                This is additional preparation evidence. It does not turn a
                reconciled carrying-value schedule into a complete equipment
                disclosure.
              </p>
            </details>
            <p className="text-sm">
              No useful life or tax rate is assumed. Decide from expected use,
              condition, maintenance, obsolescence and legal limits. This draft
              covers equipment only, not all accounting policies or disclosures.
            </p>
            <label className="block">
              Asset class
              <input
                className={inputClass}
                value={policy.assetClass}
                onChange={(e) => editPolicy("assetClass", e.target.value)}
              />
            </label>
            <label className="block">
              Measurement basis
              <select
                className={inputClass}
                value={policy.basis}
                onChange={(e) => editPolicy("basis", e.target.value)}
              >
                <option value="">Choose after review</option>
                <option value="cost">Cost</option>
                <option value="revaluation">
                  Revaluation — separate valuation assessment required
                </option>
              </select>
            </label>
            <label className="block">
              Depreciation method
              <select
                className={inputClass}
                value={policy.method}
                onChange={(e) => editPolicy("method", e.target.value)}
              >
                <option value="">Choose after review</option>
                <option value="straight-line">Straight-line</option>
                <option value="reducing-balance">Reducing balance</option>
                <option value="units-of-production">Units of production</option>
              </select>
            </label>
            {(
              ["usefulLife", "residualValue", "rationale", "evidence"] as const
            ).map((key) => (
              <label className="block" key={key}>
                {
                  {
                    usefulLife: "Useful lives or supported ranges",
                    residualValue:
                      "Residual values and how they were estimated",
                    rationale: "Why these estimates reflect expected use",
                    evidence: "Evidence supporting these estimates",
                  }[key]
                }
                <textarea
                  className={inputClass}
                  value={policy[key]}
                  onChange={(e) => editPolicy(key, e.target.value)}
                />
              </label>
            ))}
            {draft.text ? (
              <>
                <h4 className="font-medium">Policy draft — review required</h4>
                <label className="block">
                  Equipment policy draft
                  <textarea
                    readOnly
                    className={inputClass}
                    rows={6}
                    value={draft.text}
                  />
                </label>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void copyPolicy()}
                >
                  Copy policy draft for review
                </button>
              </>
            ) : (
              <p className="text-sm">{draft.problems.join(" ")}</p>
            )}
          </section>
          <section id={`${id}-step-5`} className="space-y-2 scroll-mt-24">
            {equipmentNote ? (
              <label className="block">
                Equipment disclosure preview — review required
                <textarea
                  readOnly
                  rows={12}
                  className={inputClass}
                  value={equipmentNote}
                />
              </label>
            ) : (
              <p className="text-sm">
                Complete the equipment inputs and both reconciliations to
                prepare the disclosure preview. Saving a carrying-value schedule
                alone does not complete this note.
              </p>
            )}
            <h3 className="font-medium">
              5. Save the schedule, then complete the report
            </h3>
            <p className="text-sm">
              The server remains responsible for reconciliation and report
              readiness. A balanced workpaper does not establish IFRS or IPSAS
              compliance. Opening adjustments here do not amend approved
              comparatives; record and approve any required restatement through
              Comparatives.
            </p>
            {existingSchedule ? (
              <p className="text-sm" role="status">
                A PPE schedule already exists. This one-class worksheet cannot
                replace it. Keep this workpaper for reference and use the full
                schedule editor to preserve every asset class.
                {" "}<Link className="underline" to={p.hrefFor("fs-notes", p.reportVersion)}>Open the full schedule editor</Link>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                onClick={exportWorkpaper}
              >
                Download preparation workpaper
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={!ready || busy || reading}
                onClick={() => void save()}
              >
                {busy ? "Saving schedule…" : "Record equipment schedule"}
              </button>
            </div>
            {!ready ? (
              <p className="text-sm">
                Before recording: confirm the original figure and date, explain
                the opening bridge, name the asset class, and reconcile
                supported movements to the server statement.
              </p>
            ) : null}
            <Link
              className="block text-primary underline"
              to={p.hrefFor("fs-notes", p.reportVersion)}
            >
              Next: review accounting policies and equipment disclosures in
              Notes
            </Link>
            <Link
              className="block text-primary underline"
              to={p.hrefFor("fs-comparatives", p.reportVersion)}
            >
              Review comparative figures and any restatement
            </Link>
          </section>
          {p.db ? (
            <>
              <button
                type="button"
                className={buttonClass}
                disabled={
                  busy ||
                  !file ||
                  !read ||
                  !confirmed ||
                  !priorDate ||
                  !p.db.invokeForm
                }
                onClick={() => void retainSource()}
              >
                Store original PDF through checked intake
              </button>
              <EquipmentServerBridge
                key={`${p.companyId}:${p.periodYear}`}
                db={p.db}
                companyId={p.companyId}
                periodYear={p.periodYear}
                payload={buildWorkpaper()}
                canCommit={ready && missingPreparation === 0 && !reading}
                policy={draft.text}
                equipmentNote={equipmentNote}
                onRestore={restore}
                refresh={p.refresh}
                sourceDocumentId={sourceDocumentId}
              />
            </>
          ) : null}
          <Notice text={notice} />
        </fieldset>
      )}
    </section>
  );
}
