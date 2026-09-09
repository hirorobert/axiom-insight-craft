import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";

// ─────────────────────────────────────────────────────────────
// CFOClose — 60-Second Inline Product Tour
// 5 stages × 12s each. Auto-advances, pauses on hover/focus,
// click any stage to jump. All mockups are inline SVG/HTML —
// no external images, no marketing screenshots.
//
// Demo identity: MERIDIAN_HOLDINGS_TB_FY2025.CSV — explicitly
// fictional neutral fixture. USD currency display.
// ─────────────────────────────────────────────────────────────

const STAGE_MS = 12_000;
const TICK_MS  = 50;
const SKIP_STORAGE_KEY = "cfoclose.productTour.skipped";

type Stage = {
  id:       string;
  label:    string;
  title:    string;
  detail:   string;
  Frame:    React.FC;
};

// ── Stage 1 · Upload trial balance ─────────────────────────
// Fictional company: Meridian Holdings (FY2025). USD amounts.
const UploadFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] text-foreground/85 bg-muted/30">
    <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">MERIDIAN_HOLDINGS_TB_FY2025.csv</span>
      <span className="text-[10px] text-success">✓ 52 accounts · balanced</span>
    </div>
    <div className="grid grid-cols-[1fr_90px_90px] gap-x-4 gap-y-1">
      <span className="text-muted-foreground">Account</span>
      <span className="text-muted-foreground text-right">Dr (USD)</span>
      <span className="text-muted-foreground text-right">Cr (USD)</span>
      {[
        ["Cash and cash equivalents",  "312,480",    ""],
        ["Trade receivables",          "1,104,250",  ""],
        ["Property, plant & equipment","2,871,640",  ""],
        ["Trade payables",             "",           "684,920"],
        ["Long-term borrowings",       "",           "1,800,000"],
        ["Revenue",                    "",           "5,396,800"],
        ["Cost of sales",              "3,412,240",  ""],
      ].map(([a, d, c]) => (
        <Fragment key={a}>
          <span className="truncate">{a}</span>
          <span className="text-right tabular-nums">{d}</span>
          <span className="text-right tabular-nums">{c}</span>
        </Fragment>
      ))}
    </div>
    <div className="mt-3 pt-2 border-t border-border grid grid-cols-[1fr_90px_90px] gap-x-4 font-semibold">
      <span>Total</span>
      <span className="text-right tabular-nums">11,482,310</span>
      <span className="text-right tabular-nums">11,482,310</span>
    </div>
  </div>
);

// ── Stage 2 · Review & classify ────────────────────────────
const ReviewFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Account review · confidence graded · reviewer signature required
    </div>
    {[
      ["Cash and cash equivalents",  "Current Asset · Cash",       "99", "✓ Certified"],
      ["Trade receivables",          "Current Asset · AR",         "98", "✓ Certified"],
      ["Property, plant & equipment","Non-current · PPE",          "97", "✓ Certified"],
      ["Long-term borrowings",       "Non-current Liab · Loan",    "96", "✓ Certified"],
      ["Revenue",                    "Revenue · Operating",        "99", "Pending"],
      ["Cost of sales",              "Expense · COGS",             "98", "Pending"],
    ].map(([acct, cls, conf, status], i) => (
      <div key={i} className="grid grid-cols-[1.1fr_1.3fr_50px_70px] gap-3 py-1.5 border-b border-border/40 items-center">
        <span className="truncate">{acct}</span>
        <span className="text-primary/80">{cls}</span>
        <span className="text-right text-success tabular-nums">{conf}%</span>
        <span className={`text-right text-[9px] ${status.startsWith("✓") ? "text-success" : "text-muted-foreground"}`}>{status}</span>
      </div>
    ))}
    <div className="mt-3 pt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
      <span className="text-success">✓ Assets = Liabilities + Equity</span>
      <span className="text-muted-foreground">4 of 6 accounts certified</span>
    </div>
  </div>
);

// ── Stage 3 · IFRS statements ──────────────────────────────
const StatementsFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30 grid grid-cols-2 gap-5">
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5 mb-2">
        Statement of Financial Position
      </div>
      {[
        ["Non-current assets",  "2,871,640"],
        ["Current assets",      "1,416,730"],
        ["Total assets",        "4,288,370", true],
        ["Equity",              "1,803,450"],
        ["Non-current liab.",   "1,800,000"],
        ["Current liab.",       "684,920"],
        ["Total equity + liab.","4,288,370", true],
      ].map(([l, v, bold], i) => (
        <div key={i} className={`flex justify-between py-1 ${bold ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
          <span className="truncate pr-2">{l}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5 mb-2">
        Statement of Comprehensive Income
      </div>
      {[
        ["Revenue",              "5,396,800"],
        ["Cost of sales",        "(3,412,240)"],
        ["Gross profit",         "1,984,560", true],
        ["Operating expenses",   "(1,524,310)"],
        ["Finance costs",        "(88,400)"],
        ["Profit before tax",    "371,850", true],
        ["Income tax expense",   "(111,555)"],
        ["Profit for the year",  "260,295", true],
      ].map(([l, v, bold], i) => (
        <div key={i} className={`flex justify-between py-1 ${bold ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
          <span className="truncate pr-2">{l}</span>
          <span className="tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  </div>
);

// ── Stage 4 · Reconcile & verify ───────────────────────────
const ReconcileFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Bank reconciliation · evidence verified · audit trail
    </div>
    {[
      ["Opening balance — per bank",  "USD 298,140",  "✓ Matched"],
      ["Total deposits",              "USD 1,884,300","✓ Matched"],
      ["Total withdrawals",           "(USD 1,869,960)","✓ Matched"],
      ["Outstanding cheques",         "(USD 0)",      "✓ Clear"],
      ["Closing balance — per bank",  "USD 312,480",  "✓ Agrees TB"],
    ].map(([label, value, status], i) => (
      <div key={i} className="grid grid-cols-[1.4fr_1fr_90px] gap-3 py-2 border-b border-border/40 items-center">
        <span className="truncate">{label}</span>
        <span className="text-right tabular-nums">{value}</span>
        <span className="text-right text-[9px] text-success">{status}</span>
      </div>
    ))}
    <div className="mt-3 pt-2 text-[10px] text-muted-foreground">
      Every reconciliation line carries a verifiable evidence reference. No silent adjustments.
    </div>
  </div>
);

// ── Stage 5 · Filing & monitoring ──────────────────────────
// Jurisdiction-neutral: shows workflow capability, not TRA-specific items.
const FilingFrame: React.FC = () => (
  <div className="w-full h-full p-6 font-mono text-[11px] bg-muted/30">
    <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-2 mb-3">
      Filing package · jurisdiction pack applied · monitoring active
    </div>
    <div className="grid grid-cols-2 gap-3">
      {[
        ["Tax computation",   "Jurisdiction pack format",   "ready"],
        ["XBRL instance",     "Schema-valid output",        "ready"],
        ["Financial stmts",   "IFRS-oriented, PDF",         "ready"],
        ["Workpapers",        "Full line-item trace",        "ready"],
        ["Filing checklist",  "16/16 items",                "ready"],
        ["Variance monitor",  "Comparative + alert rules",  "active"],
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
      One verified trial balance in. Statements, jurisdiction-specific filing package, and monitoring out.
    </div>
  </div>
);

const STAGES: Stage[] = [
  { id: "upload",    label: "01 · Upload",    title: "Import the trial balance",
    detail: "CSV or XLSX accepted. MERIDIAN_HOLDINGS_TB_FY2025.csv — fictional neutral fixture. Duplicate detection and balance check on ingest.", Frame: UploadFrame },
  { id: "review",   label: "02 · Review",    title: "Certify every account",
    detail: "Each account is classified, confidence-graded, and requires professional certification before it enters the statements.", Frame: ReviewFrame },
  { id: "report",   label: "03 · Report",    title: "IFRS-oriented statements",
    detail: "Statement of Financial Position and Statement of Comprehensive Income, from the certified ledger. Comparative periods included.", Frame: StatementsFrame },
  { id: "reconcile",label: "04 · Reconcile", title: "Bank reconciliation verified",
    detail: "Bank statement matched to the trial balance with a complete evidence trail. No silent adjustments.", Frame: ReconcileFrame },
  { id: "file",     label: "05 · File",      title: "Jurisdiction-aware filing",
    detail: "Filing package assembled from the verified statements. Jurisdiction pack applied. Monitoring alerts configured.", Frame: FilingFrame },
];

export function ProductTour() {
  const [skipped, setSkipped] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem(SKIP_STORAGE_KEY) === "1"; }
    catch { return false; }
  });
  const [active,  setActive]  = useState(0);
  const [elapsed, setElapsed] = useState(0);
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
    try { window.localStorage.setItem(SKIP_STORAGE_KEY, "1"); } catch (_e) { /* storage unavailable — ignored */ }
    setSkipped(true);
  }, []);

  const resume = useCallback(() => {
    try { window.localStorage.removeItem(SKIP_STORAGE_KEY); } catch (_e) { /* storage unavailable — ignored */ }
    setSkipped(false);
    setActive(0);
    setElapsed(0);
    setPlaying(true);
  }, []);

  useEffect(() => {
    const onReset = () => resume();
    window.addEventListener("cfoclose-reset-product-tour", onReset);
    return () => window.removeEventListener("cfoclose-reset-product-tour", onReset);
  }, [resume]);

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

        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-3">
              Product Tour · 60 seconds
            </p>
            <h2 className="text-xl font-bold text-foreground leading-snug">
              Trial balance to filing package, end to end.
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
        <div className="flex sm:grid sm:grid-cols-5 gap-0 border-t border-border overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STAGES.map((s, i) => {
            const isActive = i === active;
            const isDone   = i < active;
            const fill     = isActive ? stageProgress : isDone ? 100 : 0;
            return (
              <button
                key={s.id}
                onClick={() => jump(i)}
                aria-current={isActive ? "step" : undefined}
                className={`relative text-left px-4 py-4 border-r border-border last:border-r-0 transition-colors min-w-[9.5rem] sm:min-w-0 shrink-0 sm:shrink ${
                  isActive ? "bg-muted/40" : "hover:bg-muted/20"
                }`}
              >
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
          <div className="lg:col-span-2 p-6 sm:p-8 border-b lg:border-b-0 lg:border-r border-border">
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
          <div className="lg:col-span-3 h-[300px] sm:h-[360px] overflow-hidden">
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
