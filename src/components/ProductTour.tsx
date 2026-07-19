import { useEffect, useRef, useState, useCallback } from "react";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";

// ─────────────────────────────────────────────────────────────
// SAFF ERP — 60-Second Inline Product Tour
// 5 stages × 12s each. Auto-advances, pauses on hover/focus,
// click any stage to jump. All mockups are inline SVG/HTML —
// no external images, no marketing screenshots.
// ─────────────────────────────────────────────────────────────

const STAGE_MS = 12_000;
const TICK_MS  = 50;
const SKIP_STORAGE_KEY = "saff.productTour.skipped";

type Stage = {
  id:       string;
  label:    string;
  title:    string;
  detail:   string;
  Frame:    React.FC;
};

// ── Stage 1 · Upload trial balance ─────────────────────────
const UploadFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] text-foreground/85 bg-muted/30">
    <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">KAMANGA_MEDICS_TB_2025.csv</span>
      <span className="text-[10px] text-success">✓ 46 accounts · balanced</span>
    </div>
    <div className="grid grid-cols-[1fr_90px_90px] gap-x-4 gap-y-1">
      <span className="text-muted-foreground">Account</span>
      <span className="text-muted-foreground text-right">Dr (TZS)</span>
      <span className="text-muted-foreground text-right">Cr (TZS)</span>
      {[
        ["Cash at bank",              "412,180,000", ""],
        ["Trade receivables",         "1,204,050,300", ""],
        ["Property, plant & equipment","1,777,286,907", ""],
        ["Trade payables",            "", "684,220,150"],
        ["Long-term loan — NBC",      "", "2,140,000,000"],
        ["Sales revenue",             "", "9,396,638,868"],
        ["Cost of goods sold",        "5,812,440,220", ""],
      ].map(([a, d, c]) => (
        <>
          <span className="truncate">{a}</span>
          <span className="text-right tabular-nums">{d}</span>
          <span className="text-right tabular-nums">{c}</span>
        </>
      ))}
    </div>
    <div className="mt-3 pt-2 border-t border-border grid grid-cols-[1fr_90px_90px] gap-x-4 font-semibold">
      <span>Total</span>
      <span className="text-right tabular-nums">17,371,317,215</span>
      <span className="text-right tabular-nums">17,371,317,215</span>
    </div>
  </div>
);

// ── Stage 2 · Classify & validate ──────────────────────────
const ClassifyFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Account classification · confidence graded
    </div>
    {[
      ["Cash at bank",         "Current Asset · Cash",       "99"],
      ["Trade receivables",    "Current Asset · AR",         "98"],
      ["Property, plant & equipment","Non-current · PPE",    "97"],
      ["Long-term loan — NBC", "Non-current Liab · Loan",    "96"],
      ["Sales revenue",        "Revenue · Operating",        "99"],
      ["Cost of goods sold",   "Expense · COGS",             "98"],
    ].map(([acct, cls, conf], i) => (
      <div key={i} className="grid grid-cols-[1.2fr_1.4fr_60px] gap-3 py-1.5 border-b border-border/40 items-center">
        <span className="truncate">{acct}</span>
        <span className="text-primary/80">{cls}</span>
        <span className="text-right text-success tabular-nums">{conf}%</span>
      </div>
    ))}
    <div className="mt-3 pt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
      <span className="text-success">✓ Assets = Liabilities + Equity</span>
      <span className="text-success">✓ 0 unmapped accounts</span>
    </div>
  </div>
);

// ── Stage 3 · IFRS statements ──────────────────────────────
const StatementsFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30 grid grid-cols-2 gap-5">
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5 mb-2">
        IAS 1 · Statement of Financial Position
      </div>
      {[
        ["Non-current assets",  "1,777,286,907"],
        ["Current assets",      "1,616,230,300"],
        ["Total assets",        "3,393,517,207", true],
        ["Equity",              "569,297,057"],
        ["Non-current liab.",   "2,140,000,000"],
        ["Current liab.",       "684,220,150"],
        ["Total equity + liab.","3,393,517,207", true],
      ].map(([l, v, bold], i) => (
        <div key={i} className={`flex justify-between py-1 ${bold ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
          <span className="truncate pr-2">{l}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5 mb-2">
        IAS 1 · Statement of Comprehensive Income
      </div>
      {[
        ["Revenue",              "9,396,638,868"],
        ["Cost of sales",        "(5,812,440,220)"],
        ["Gross profit",         "3,584,198,648", true],
        ["Operating expenses",   "(3,244,227,852)"],
        ["Finance costs",        "(158,904,033)"],
        ["Profit before tax",    "181,066,763", true],
        ["Income tax expense",   "(54,320,029)"],
        ["Profit for the year",  "126,746,734", true],
      ].map(([l, v, bold], i) => (
        <div key={i} className={`flex justify-between py-1 ${bold ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
          <span className="truncate pr-2">{l}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  </div>
);

// ── Stage 4 · Tax computation ──────────────────────────────
const TaxFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Corporate income tax · ITA Cap.332 + Finance Act 2026
    </div>
    {[
      ["Profit before tax",                       "181,066,763"],
      ["Add: Accounting depreciation",            "158,904,033"],
      ["Less: ITA wear & tear (6 classes)",       "(158,904,033)"],
      ["Add: Non-deductible expenses",            "0"],
      ["Thin cap add-back (s.24A)",               "0"],
      ["Taxable income",                          "181,066,763", true],
      ["CIT @ 30%",                               "54,320,029",  true],
      ["Minimum tax gate (s.65) — 3yr loss check","not triggered"],
    ].map(([l, v, bold], i) => (
      <div key={i} className={`flex justify-between py-1.5 ${bold ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
        <span className="truncate pr-2">{l}</span>
        <span className="tabular-nums">{v}</span>
      </div>
    ))}
    <div className="mt-3 pt-2 text-[10px] text-muted-foreground">
      Every line traces to a mapped account. Every rate cites the statute section.
    </div>
  </div>
);

// ── Stage 5 · Filing package ───────────────────────────────
const FilingFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Filing package · TRA IDRAS ready
    </div>
    <div className="grid grid-cols-2 gap-3">
      {[
        ["Tax computation",  "PDF · TRA format",     "ready"],
        ["XBRL instance",    ".xbrl · schema-valid", "ready"],
        ["Financial stmts",  "PDF · IFRS notes",     "ready"],
        ["Wear & tear reg.", "PDF · 6 asset classes","ready"],
        ["Thin cap workpaper","PDF · s.24A trace",   "ready"],
        ["Filing checklist", "16/16 items",          "ready"],
      ].map(([name, kind, status], i) => (
        <div key={i} className="border border-border p-2.5">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold">{name}</span>
            <span className="text-[9px] text-success uppercase tracking-widest">✓ {status}</span>
          </div>
          <span className="text-[10px] text-muted-foreground">{kind}</span>
        </div>
      ))}
    </div>
    <div className="mt-4 text-[10px] text-muted-foreground">
      One verified trial balance in. IFRS statements, tax computation, and TRA filing package out.
    </div>
  </div>
);

const STAGES: Stage[] = [
  { id: "upload",     label: "01 · Upload",      title: "Import the trial balance",
    detail: "CSV or XLSX. Duplicate detection and balance check on ingest.", Frame: UploadFrame },
  { id: "classify",   label: "02 · Classify",    title: "Auto-map every account",
    detail: "Each account is classified and confidence-graded before it enters the statements.", Frame: ClassifyFrame },
  { id: "statements", label: "03 · Statements",  title: "IFRS statements generated",
    detail: "Statement of Financial Position and Statement of Comprehensive Income, from the mapped ledger.", Frame: StatementsFrame },
  { id: "tax",        label: "04 · Tax",         title: "Corporate tax computed",
    detail: "Wear & tear, thin capitalisation, and minimum tax gate applied line by line to the statute.", Frame: TaxFrame },
  { id: "filing",     label: "05 · Filing",      title: "TRA filing package ready",
    detail: "PDF tax computation, XBRL instance, and workpapers assembled in one archive.", Frame: FilingFrame },
];

export function ProductTour() {
  const [skipped, setSkipped] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(SKIP_STORAGE_KEY) === "1"; }
    catch { return false; }
  });
  const [active,  setActive]  = useState(0);
  const [elapsed, setElapsed] = useState(0);   // ms into current stage
  const [playing, setPlaying] = useState(true);
  const timerRef = useRef<number | null>(null);

  const clear = () => { if (timerRef.current) window.clearInterval(timerRef.current); timerRef.current = null; };

  useEffect(() => {
    if (!playing || skipped) { clear(); return; }
    timerRef.current = window.setInterval(() => {
      setElapsed((prev) => {
        const next = prev + TICK_MS;
        if (next >= STAGE_MS) {
          setActive((a) => (a + 1) % STAGES.length);
          return 0;
        }
        return next;
      });
    }, TICK_MS);
    return clear;
  }, [playing, skipped]);


  const jump = useCallback((i: number) => {
    setActive(i);
    setElapsed(0);
  }, []);

  const restart = useCallback(() => { setActive(0); setElapsed(0); setPlaying(true); }, []);

  const skip = useCallback(() => {
    try { window.localStorage.setItem(SKIP_STORAGE_KEY, "1"); } catch {}
    setSkipped(true);
  }, []);

  const resume = useCallback(() => {
    try { window.localStorage.removeItem(SKIP_STORAGE_KEY); } catch {}
    setSkipped(false);
    setActive(0);
    setElapsed(0);
    setPlaying(true);
  }, []);

  if (skipped) {
    return (
      <section
        id="tour"
        aria-label="Product tour skipped"
        className="px-6 py-10 border-b border-border bg-background"
      >
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Product tour hidden. We'll remember your choice on this device.
          </p>
          <button
            onClick={resume}
            className="text-[11px] font-mono uppercase tracking-widest px-3 py-2 border border-border hover:bg-muted transition-colors"
          >
            Show tour again
          </button>
        </div>
      </section>
    );
  }

  const stage = STAGES[active];
  const Frame = stage.Frame;
  const stageProgress = (elapsed / STAGE_MS) * 100;

  return (
    <section
      id="tour"
      aria-label="60-second product tour"
      className="px-6 py-20 border-b border-border bg-background"
      onMouseEnter={() => setPlaying(false)}
      onMouseLeave={() => setPlaying(true)}
      onFocus={() => setPlaying(false)}
      onBlur={() => setPlaying(true)}
    >
      <div className="max-w-7xl mx-auto">

        <div className="flex items-end justify-between mb-6">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-3">
              Product Tour · 60 seconds
            </p>
            <h2 className="text-xl font-bold text-foreground leading-snug">
              Trial balance to filing package, end to end.
            </h2>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause tour" : "Play tour"}
              className="w-8 h-8 flex items-center justify-center border border-border hover:bg-muted transition-colors"
            >
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button
              onClick={restart}
              aria-label="Restart tour"
              className="w-8 h-8 flex items-center justify-center border border-border hover:bg-muted transition-colors"
            >
              <RotateCcw size={13} />
            </button>
            <button
              onClick={skip}
              aria-label="Skip tour and remember choice"
              className="h-8 flex items-center gap-1.5 px-3 border border-border hover:bg-muted transition-colors text-[10px] font-mono uppercase tracking-widest"
            >
              <SkipForward size={12} />
              Skip tour
            </button>
          </div>
        </div>

        {/* Stage rail */}
        <div className="grid grid-cols-5 gap-0 border-t border-border">
          {STAGES.map((s, i) => {
            const isActive = i === active;
            const isDone   = i < active;
            const fill     = isActive ? stageProgress : isDone ? 100 : 0;
            return (
              <button
                key={s.id}
                onClick={() => jump(i)}
                aria-current={isActive ? "step" : undefined}
                className={`relative text-left px-4 py-4 border-r border-border last:border-r-0 transition-colors ${
                  isActive ? "bg-muted/40" : "hover:bg-muted/20"
                }`}
              >
                {/* progress bar at top */}
                <span className="absolute top-0 left-0 h-[2px] bg-primary transition-[width] duration-75 ease-linear"
                      style={{ width: `${fill}%` }} />
                <div className={`text-[10px] font-mono uppercase tracking-widest mb-1 ${
                  isActive ? "text-primary" : "text-muted-foreground/60"
                }`}>
                  {s.label}
                </div>
                <div className={`text-xs font-semibold leading-snug ${
                  isActive ? "text-foreground" : "text-muted-foreground"
                }`}>
                  {s.title}
                </div>
              </button>
            );
          })}
        </div>

        {/* Stage viewport */}
        <div className="grid grid-cols-1 lg:grid-cols-5 border-l border-r border-b border-border">
          <div className="lg:col-span-2 p-8 border-b lg:border-b-0 lg:border-r border-border">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary/70 mb-3">
              {stage.label}
            </p>
            <h3 className="text-lg font-bold text-foreground leading-snug mb-3">
              {stage.title}
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {stage.detail}
            </p>
          </div>
          <div className="lg:col-span-3 h-[360px] overflow-hidden">
            <div key={stage.id} className="w-full h-full animate-fade-in">
              <Frame />
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}

export default ProductTour;