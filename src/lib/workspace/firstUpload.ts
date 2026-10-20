/**
 * firstUpload — the first-visit journey after the file is stored as a draft (Phase 2 §5.4–5.5, P2-3).
 *
 *   "Start trial balance check" runs, in order, each through its EXISTING authority:
 *     1. entity  create_entity (idempotent per request id; enforces the plan's entity capacity)
 *     2. period  open_engagement_with_period (explicit dates and currency; no defaults; needs prepare_close + a plan)
 *     3. add     the trial-balance-draft commit (bound to draft, entity, period and the confirmed context)
 *     4. check   process-trial-balance (the server reads the file: File read → Columns confirmed → Checks completed)
 *
 * Every identity is fixed before the first attempt (entity request id, commit key, check request id) and every id
 * obtained is kept in `progress`, so a retry resumes at the step that failed and repeats nothing: a second press can
 * neither create a second entity, add the file twice nor run the check twice. Nothing here decides an outcome; each
 * step reports the server's answer in words with the one safe next action.
 */

import type { CreateEntityOutcome } from "@/lib/commercial/entityCreation";
import type { PeriodOpenResult } from "./workspaceSetupClient";
import type { CheckOutcome } from "@/lib/ingestion/uploadFlow";

export type StartStep = "entity" | "period" | "add" | "check";

export const START_STEPS: readonly { id: StartStep; label: string }[] = Object.freeze([
  { id: "entity", label: "Entity saved" },
  { id: "period", label: "Period saved" },
  { id: "add", label: "File added to the entity" },
  { id: "check", label: "Trial balance checked" },
]);

/** What the user confirmed on the card. */
export interface ConfirmedStart {
  draftId: string;
  /** A new entity (created through create_entity), or an existing one the user chose (its authority is re-checked by
   *  open_engagement_with_period, the draft commit and the check — never by the card). */
  entity: { kind: "new"; name: string } | { kind: "existing"; companyId: string; name: string };
  period: { start: string; end: string; year: number; name: string };
  currency: string;
  /** Replace the period's active trial balance (chosen by the user after the server said one is active). */
  replaces?: { uploadId: string; expectedVersion: number } | null;
}

/** Fixed once per confirmation, before the first attempt. */
export interface StartKeys { entityRequestId: string; commitKey: string; checkRequestId: string }

/** What earlier attempts already obtained. */
export interface StartProgress { companyId?: string; engagementId?: string; periodId?: string; uploadId?: string; checked?: boolean }

export interface StartDeps {
  createEntity(a: { requestId: string; name: string; fiscalYearEnd: string; currency: string }): Promise<CreateEntityOutcome>;
  openPeriod(a: { companyId: string; start: string; end: string; currency: string }): Promise<PeriodOpenResult>;
  commit(a: { draftId: string; commitKey: string; companyId: string; periodYear: number; periodId: string; engagementId: string;
    confirmation: { entity: string; period: string; currency: string }; replaces?: { uploadId: string; expectedVersion: number } | null }): Promise<{ uploadId: string }>;
  check(a: { uploadId: string; requestId: string }): Promise<CheckOutcome>;
  /** After a refusal on an existing entity: this person's standing there (get_my_workspace_capabilities); null = unknown. */
  access?(companyId: string): Promise<{ hasCurrentPlan: boolean | null; canPrepare: boolean; manageBilling: boolean } | null>;
}

export type StartResult =
  | { kind: "checked"; progress: Required<Pick<StartProgress, "companyId" | "uploadId">> & StartProgress; periodYear: number }
  /** The file is added and its check is already running (another request owns it): open that upload to follow it. */
  | { kind: "running"; progress: Required<Pick<StartProgress, "companyId" | "uploadId">> & StartProgress; periodYear: number }
  | { kind: "failed"; step: StartStep; message: string; retryable: boolean; progress: StartProgress; next?: "choose_plan" | "choose_entity" | "upload_again" | "replace"; commitId?: string };

const msg = (e: unknown, fallback: string) => {
  const m = e instanceof Error ? e.message : null;
  return m && m.length < 300 ? m : fallback;
};
const retryableError = (e: unknown) => !(e && typeof e === "object" && "retryable" in e && (e as { retryable: unknown }).retryable === false);

/** Runs (or resumes) the start. `onStep` names the step about to run, for the progress list. */
export async function runStart(deps: StartDeps, c: ConfirmedStart, keys: StartKeys, from: StartProgress, onStep?: (s: StartStep) => void): Promise<StartResult> {
  const progress: StartProgress = { ...from };
  if (c.entity.kind === "existing") progress.companyId ??= c.entity.companyId;
  const fail = (step: StartStep, message: string, retryable: boolean, next?: "choose_plan" | "choose_entity" | "upload_again"): StartResult =>
    ({ kind: "failed", step, message, retryable, progress: { ...progress }, next });

  // 1. The entity.
  if (!progress.companyId) {
    onStep?.("entity");
    let o: CreateEntityOutcome;
    try {
      o = await deps.createEntity({ requestId: keys.entityRequestId, name: c.entity.name.trim(), fiscalYearEnd: c.period.end, currency: c.currency });
    } catch (e) {
      return fail("entity", msg(e, "The entity could not be saved. Try again."), retryableError(e));
    }
    if (o.kind === "capacity" && o.capacity.planCode === null) {
      // No current plan (complimentary access counts as one: the server decides). Nothing is charged or started here.
      return fail("entity", "Checking a trial balance needs a plan. Choose one; your file stays saved privately as a draft, and you can continue here afterwards.", false, "choose_plan");
    }
    if (o.kind === "capacity") return fail("entity", "Your plan's entity capacity is in use. Choose a larger plan to add this entity; your file stays saved as a draft.", false, "choose_plan");
    if (o.kind === "failed") return fail("entity", "The entity could not be saved. Try again.", true);
    progress.companyId = o.companyId;
  }

  // 2. The period (dated, in the confirmed currency).
  if (!progress.periodId || !progress.engagementId) {
    onStep?.("period");
    let p: PeriodOpenResult;
    try {
      p = await deps.openPeriod({ companyId: progress.companyId, start: c.period.start, end: c.period.end, currency: c.currency });
    } catch (e) {
      // NOT_AUTHORISED (42501): for an entity this user just created as its owner, the only missing prerequisite is an
      // active plan with named-user access (open_engagement_with_period requires prepare_close AND a current plan).
      if (e && typeof e === "object" && "kind" in e && (e as { kind: unknown }).kind === "NOT_AUTHORISED") {
        // An existing entity: the one refusal covers two causes (no plan on its account, or no permission here). Ask the
        // server which, and state only that one with its own action; when it cannot say, state both and offer no plan.
        if (c.entity.kind === "existing") {
          const a = deps.access ? await deps.access(c.entity.companyId).catch(() => null) : null;
          if (a?.hasCurrentPlan === false && a.manageBilling) return fail("period", "Your account has no active plan. Choose a plan to set up this period; your file stays saved as a draft.", false, "choose_plan");
          if (a?.hasCurrentPlan === false) return fail("period", "This entity's account has no active plan. Ask the account's owner to choose one, or choose another entity; your file stays saved as a draft.", false, "choose_entity");
          if (a?.hasCurrentPlan === true && !a.canPrepare) return fail("period", "You don't have permission to prepare this entity's trial balance. Ask the entity's owner for access, or choose another entity; your file stays saved as a draft.", false, "choose_entity");
          return fail("period", "You can't set up a period for this entity: it needs permission to prepare its trial balance and an active plan. Ask the entity's owner, or choose another entity; your file stays saved as a draft.", false, "choose_entity");
        }
        return fail("period", "Your account has no active plan. Choose a plan to set up this period; your entity and file stay saved.", false, "choose_plan");
      }
      const invalid = e && typeof e === "object" && "kind" in e && (e as { kind: unknown }).kind === "INVALID";
      return fail("period", msg(e, "The period could not be saved. Try again."), !invalid && retryableError(e));
    }
    if (p.outcome === "refused") return fail("period", p.message, false);
    progress.periodId = p.periodId;
    progress.engagementId = p.engagementId;
  }

  // 3. The file joins the entity (the draft commit; bound to exactly this entity, period and confirmation).
  if (!progress.uploadId) {
    onStep?.("add");
    try {
      const r = await deps.commit({
        draftId: c.draftId, commitKey: keys.commitKey, companyId: progress.companyId, periodYear: c.period.year,
        periodId: progress.periodId, engagementId: progress.engagementId,
        confirmation: { entity: c.entity.name.trim(), period: c.period.name, currency: c.currency }, replaces: c.replaces ?? null,
      });
      progress.uploadId = r.uploadId;
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      // The period already has an active trial balance: replacing it is a choice the user makes, never automatic.
      if (code === "active_upload_exists" && !c.replaces) {
        return { kind: "failed", step: "add", message: msg(e, "A trial balance is already active for this period."), retryable: false, progress: { ...progress }, next: "replace",
          commitId: (e as { commitId?: string }).commitId };
      }
      return fail("add", msg(e, "The file could not be added. Try again."), retryableError(e),
        code === "expired" || code === "content_mismatch" || code === "not_found" ? "upload_again" : undefined);
    }
  }

  // 4. The server's check.
  if (!progress.checked) {
    onStep?.("check");
    let k: CheckOutcome;
    try {
      k = await deps.check({ uploadId: progress.uploadId, requestId: keys.checkRequestId });
    } catch (e) {
      return fail("check", msg(e, "The file is saved, but the check could not be completed. Check again; it will not be counted twice."), true);
    }
    if (k.kind === "failed") {
      return fail("check", k.failure.message, k.failure.retry !== "none", k.failure.needsPlan ? "choose_plan" : undefined);
    }
    if (k.kind === "wait") return { kind: "running", progress: { ...progress, companyId: progress.companyId, uploadId: progress.uploadId }, periodYear: c.period.year };
    progress.checked = true;
  }
  return { kind: "checked", progress: { ...progress, companyId: progress.companyId, uploadId: progress.uploadId }, periodYear: c.period.year };
}

/** The three stages the page shows, from the server's recorded milestones (tbIngestion MilestoneLog). */
export type StageId = "read" | "columns" | "checks";
export type StageStatus = "done" | "failed" | "needs_review" | "pending";
export const STAGES: readonly { id: StageId; label: string }[] = Object.freeze([
  { id: "read", label: "File read" },
  { id: "columns", label: "Columns confirmed" },
  { id: "checks", label: "Checks completed" },
]);

type Mark = { id: string; status: string };
/**
 * read ← milestone "read"; columns ← "columns"; checks ← every later milestone (rows, amounts, balance, classification,
 * recorded): failed if any failed, needs review if any needs review, done only when all passed. A milestone never
 * reached is pending — never shown as done.
 */
export function stagesFromMilestones(milestones: readonly Mark[] | null | undefined): Record<StageId, StageStatus> {
  const by = new Map((milestones ?? []).map((m) => [m.id, m.status]));
  const one = (id: string): StageStatus => {
    const s = by.get(id);
    return s === "passed" ? "done" : s === "failed" ? "failed" : s === "needs_review" ? "needs_review" : "pending";
  };
  const later = ["rows", "amounts", "balance", "classification", "recorded"].map(one);
  const checks: StageStatus = later.includes("failed") ? "failed" : later.includes("pending") ? "pending" : later.includes("needs_review") ? "needs_review" : "done";
  const read = one("read"), columns = one("columns");
  return { read, columns: read === "done" ? columns : "pending", checks: read === "done" && columns === "done" ? checks : "pending" };
}

/** The milestones the server recorded for an upload (processing_result.ingestion.milestones), or null when none. */
export function readMilestones(processingResult: unknown): Mark[] | null {
  const pr = processingResult && typeof processingResult === "object" && !Array.isArray(processingResult) ? processingResult as Record<string, unknown> : null;
  const ing = pr?.ingestion && typeof pr.ingestion === "object" && !Array.isArray(pr.ingestion) ? pr.ingestion as Record<string, unknown> : null;
  if (!ing || !Array.isArray(ing.milestones)) return null;
  return ing.milestones.filter((m): m is Mark => !!m && typeof m === "object" && typeof (m as Mark).id === "string" && typeof (m as Mark).status === "string");
}
