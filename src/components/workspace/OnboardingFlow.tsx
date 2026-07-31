/**
 * OnboardingFlow — the 3-step first-run path through the workspace.
 *
 *   1. Upload trial balance
 *   2. Set TIN / company details
 *   3. Generate statements
 *
 * Completion is DERIVED from the database (upload status, company.tin,
 * statements mission) — never invented locally. localStorage only remembers
 * where the user was and whether they dismissed the panel, so a refresh
 * resumes on the same step instead of restarting.
 *
 * Design law: exactly ONE primary button on screen. The current step owns it.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, Check, Upload, Building2, FileText, X } from "lucide-react";

export type OnboardingStepId = "upload" | "company" | "statements";

type Persisted = {
  /** Step the user was last working on — restored on refresh. */
  currentStep: OnboardingStepId;
  /** True once the user explicitly dismisses the guide. */
  dismissed: boolean;
  /** Steps the user has explicitly marked as reached, for resume ordering. */
  reached: OnboardingStepId[];
  updatedAt: string;
};

const STEP_ORDER: OnboardingStepId[] = ["upload", "company", "statements"];

function storageKey(companyId: string, periodYear: number) {
  return `saff.onboarding.v1.${companyId}.${periodYear}`;
}

function readPersisted(companyId: string, periodYear: number): Persisted {
  const fallback: Persisted = {
    currentStep: "upload",
    dismissed: false,
    reached: ["upload"],
    updatedAt: new Date().toISOString(),
  };
  try {
    const raw = localStorage.getItem(storageKey(companyId, periodYear));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      currentStep: STEP_ORDER.includes(parsed.currentStep as OnboardingStepId)
        ? (parsed.currentStep as OnboardingStepId)
        : fallback.currentStep,
      dismissed: parsed.dismissed === true,
      reached: Array.isArray(parsed.reached)
        ? parsed.reached.filter((s): s is OnboardingStepId => STEP_ORDER.includes(s as OnboardingStepId))
        : fallback.reached,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

function writePersisted(companyId: string, periodYear: number, value: Persisted) {
  try {
    localStorage.setItem(storageKey(companyId, periodYear), JSON.stringify(value));
  } catch {
    /* storage unavailable — progress simply won't persist */
  }
}

export default function OnboardingFlow({
  companyId,
  periodYear,
  basePath,
  uploadDone,
  uploadPending,
  companyDone,
  statementsDone,
  onSetTin,
}: {
  companyId: string;
  periodYear: number;
  basePath: string;
  /** Trial balance uploaded and validated. */
  uploadDone: boolean;
  /** Trial balance uploaded but still processing / needs attention. */
  uploadPending: boolean;
  /** TRA TIN present and well formed. */
  companyDone: boolean;
  /** Statements prepared (passed or signed). */
  statementsDone: boolean;
  onSetTin: () => void;
}) {
  const [persisted, setPersisted] = useState<Persisted>(() => readPersisted(companyId, periodYear));

  // Re-read when the engagement changes — progress is per company + year.
  useEffect(() => {
    setPersisted(readPersisted(companyId, periodYear));
  }, [companyId, periodYear]);

  const done: Record<OnboardingStepId, boolean> = useMemo(
    () => ({ upload: uploadDone, company: companyDone, statements: statementsDone }),
    [uploadDone, companyDone, statementsDone]
  );

  const allDone = STEP_ORDER.every((s) => done[s]);

  // The live step: first incomplete step, but never behind where the user
  // already was (so a resumed session lands where they left off).
  const firstIncomplete = STEP_ORDER.find((s) => !done[s]) ?? "statements";
  const rememberedIndex = STEP_ORDER.indexOf(persisted.currentStep);
  const incompleteIndex = STEP_ORDER.indexOf(firstIncomplete);
  const activeStep = STEP_ORDER[Math.max(incompleteIndex, done[persisted.currentStep] ? incompleteIndex : rememberedIndex)];

  // Persist the resolved position so a refresh restores it.
  useEffect(() => {
    if (persisted.currentStep === activeStep && persisted.reached.includes(activeStep)) return;
    const next: Persisted = {
      ...persisted,
      currentStep: activeStep,
      reached: Array.from(new Set([...persisted.reached, activeStep])),
      updatedAt: new Date().toISOString(),
    };
    setPersisted(next);
    writePersisted(companyId, periodYear, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, companyId, periodYear]);

  const dismiss = () => {
    const next: Persisted = { ...persisted, dismissed: true, updatedAt: new Date().toISOString() };
    setPersisted(next);
    writePersisted(companyId, periodYear, next);
  };

  if (persisted.dismissed || allDone) return null;

  const completedCount = STEP_ORDER.filter((s) => done[s]).length;

  const steps: Array<{
    id: OnboardingStepId;
    title: string;
    detail: string;
    icon: React.ReactNode;
    action: { label: string; href?: string; onClick?: () => void };
  }> = [
    {
      id: "upload",
      title: "Upload the trial balance",
      detail: uploadPending
        ? "Uploaded — validation is running. Status updates on its own."
        : "Excel or CSV. Validated against the Tanzania chart of accounts before anything else runs.",
      icon: <Upload className="w-4 h-4" />,
      action: { label: uploadPending ? "Open Prepare Data" : "Upload trial balance", href: `${basePath}/prepare` },
    },
    {
      id: "company",
      title: "Set the TIN and company details",
      detail: "The 9-digit TRA TIN is required before any filing pack or export can be produced.",
      icon: <Building2 className="w-4 h-4" />,
      action: { label: "Set TIN", onClick: onSetTin },
    },
    {
      id: "statements",
      title: "Generate the statements",
      detail: "Statement of financial position, profit or loss, and the disclosure notes.",
      icon: <FileText className="w-4 h-4" />,
      action: { label: "Open Statements", href: `${basePath}/statements` },
    },
  ];

  return (
    <section className="mb-14 border border-border">
      <header className="flex items-start justify-between gap-6 px-5 py-4 border-b border-border">
        <div>
          <p className="text-[10px] font-semibold text-primary tracking-[0.22em] uppercase">
            Getting started
          </p>
          <p className="mt-2 text-[15px] font-medium text-foreground tracking-tight">
            Three steps from trial balance to statements.
          </p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
            {completedCount} of {STEP_ORDER.length} done
          </span>
          <button
            type="button"
            onClick={dismiss}
            className="text-muted-foreground/60 hover:text-foreground transition-colors"
            title="Hide this guide"
            aria-label="Hide getting started guide"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Progress rail */}
      <div className="flex h-0.5">
        {STEP_ORDER.map((s) => (
          <div
            key={s}
            className={[
              "flex-1",
              done[s] ? "bg-success" : s === activeStep ? "bg-primary" : "bg-border",
            ].join(" ")}
          />
        ))}
      </div>

      <ol>
        {steps.map((step, i) => {
          const isDone = done[step.id];
          const isActive = !isDone && step.id === activeStep;
          const isFuture = !isDone && !isActive;

          return (
            <li key={step.id} className="border-b border-border last:border-b-0">
              <div className={[
                "grid grid-cols-[2rem_1fr] gap-4 px-5 py-4",
                isActive ? "bg-primary/[0.03]" : "",
              ].join(" ")}>
                <div className="pt-0.5">
                  <span className={[
                    "flex items-center justify-center w-7 h-7 border text-[11px] font-mono tabular-nums",
                    isDone
                      ? "border-success text-success"
                      : isActive
                        ? "border-primary text-primary font-semibold"
                        : "border-border text-muted-foreground/50",
                  ].join(" ")}>
                    {isDone ? <Check className="w-3.5 h-3.5" /> : String(i + 1).padStart(2, "0")}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={isDone ? "text-success" : isActive ? "text-primary" : "text-muted-foreground/40"}>
                      {step.icon}
                    </span>
                    <p className={[
                      "text-[15px] font-medium tracking-tight leading-tight",
                      isFuture ? "text-muted-foreground" : "text-foreground",
                    ].join(" ")}>
                      {step.title}
                    </p>
                    {isDone && (
                      <span className="text-[11px] text-success tracking-wide uppercase font-semibold">Done</span>
                    )}
                  </div>

                  {!isDone && (
                    <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed max-w-xl">
                      {step.detail}
                    </p>
                  )}

                  {isActive && (
                    <div className="mt-4">
                      {step.action.href ? (
                        <Button
                          asChild
                          size="lg"
                          className="h-11 px-5 text-[14px] font-semibold rounded-none shadow-none"
                        >
                          <Link to={step.action.href}>
                            <span className="mr-2">{step.action.label}</span>
                            <ArrowRight className="w-4 h-4" />
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          onClick={step.action.onClick}
                          size="lg"
                          className="h-11 px-5 text-[14px] font-semibold rounded-none shadow-none"
                        >
                          <span className="mr-2">{step.action.label}</span>
                          <ArrowRight className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="px-5 py-3 text-[11px] text-muted-foreground/70 border-t border-border">
        Progress is saved automatically — close the tab and you will come back to this step.
      </p>
    </section>
  );
}