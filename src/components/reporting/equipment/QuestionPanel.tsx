import { questionKey, type EvaluatedQuestion } from "@/lib/preparation/equipmentQuestions";
import { emptyAnswer, type Answer, type AnswerStatus } from "@/lib/preparation/equipmentModel";
import type { AnswerRecord } from "@/lib/preparation/workpaperClient";

const input = "mt-1 block w-full rounded-md border border-input bg-background px-2 py-1 text-sm";
const button = "rounded-md border border-input px-2 py-1 text-sm disabled:opacity-50";
const STATUS_WORDS: Record<AnswerStatus, string> = { unresolved: "Not yet answered", answered: "Answered", none_with_basis: "None (with basis)", not_applicable: "Does not apply" };

/**
 * The applicable questions, unresolved first. Structured questions point to the fields that answer them; written
 * questions take a status, the answer, the evidence and, for "none", who checked. A prior-period answer can be reused
 * explicitly, never silently.
 */
export function QuestionPanel(p: {
  questions: readonly EvaluatedQuestion[];
  answerFor: (q: EvaluatedQuestion) => Answer | undefined;
  onAnswer: (q: EvaluatedQuestion, a: Answer) => void;
  priorAnswers: readonly AnswerRecord[];
}) {
  const unresolved = p.questions.filter((q) => !q.resolved), resolved = p.questions.filter((q) => q.resolved);
  const prior = (q: EvaluatedQuestion) => p.priorAnswers.find((a) => a.questionId === q.def.id && (q.classId ? a.classLabel === q.classLabel : a.classKey === null));
  const render = (q: EvaluatedQuestion) => {
    const a = p.answerFor(q) ?? emptyAnswer();
    const setA = (patch: Partial<Answer>) => p.onAnswer(q, { ...a, ...patch });
    const scope = q.classLabel ? `${q.classLabel}: ` : "";
    const pr = prior(q);
    return (
      <li key={questionKey(q)} className="rounded-md border border-border p-2" data-question={q.def.id} data-class={q.classId ?? ""} data-resolved={q.resolved}>
        <p className="font-medium">{scope}{q.def.question}</p>
        <p className="text-xs text-muted-foreground">Why: {q.def.purpose} Accepted evidence: {q.def.evidence} Standard: {q.def.refs.join(", ")} ({q.def.kind}).</p>
        {q.def.structured ? (
          <p className="text-sm">{q.resolved ? "Answered through the fields above." : `Answer through the fields above. ${q.problems.join(" ")}`}</p>
        ) : (
          <div className="space-y-1">
            {pr && a.status === "unresolved" ? (
              <p className="text-sm">Last year's answer: {STATUS_WORDS[pr.status as AnswerStatus] ?? pr.status}{typeof pr.answer.text === "string" && pr.answer.text ? ` — ${pr.answer.text}` : ""}.
                <button type="button" className={`ml-2 ${button}`} onClick={() => setA({ status: pr.status as AnswerStatus, text: String(pr.answer.text ?? ""), evidence: String(pr.answer.evidence ?? ""), checkedBy: String(pr.answer.checkedBy ?? ""), flags: (pr.answer.flags as Record<string, boolean>) ?? {} })}>Reuse last year's answer, then review it</button>
              </p>
            ) : null}
            <label className="block text-sm">Status
              <select className={input} aria-label={`${scope}${q.def.id} status`} value={a.status} onChange={(ev) => setA({ status: ev.target.value as AnswerStatus })}>
                {(["unresolved", "answered", "none_with_basis", "not_applicable"] as const).map((s) => <option key={s} value={s}>{STATUS_WORDS[s]}</option>)}
              </select>
            </label>
            {(q.def.flags ?? []).map((f) => (
              <label key={f.key} className="flex gap-2 text-sm">
                <input type="checkbox" aria-label={`${scope}${q.def.id} ${f.key}`} checked={a.flags[f.key] === true} onChange={(ev) => setA({ flags: { ...a.flags, [f.key]: ev.target.checked } })} />
                <span>{f.label}</span>
              </label>
            ))}
            {a.status === "answered" || a.status === "not_applicable" ? (
              <label className="block text-sm">{a.status === "answered" ? "Answer" : "Why it does not apply"}
                <textarea maxLength={2000} className={input} aria-label={`${scope}${q.def.id} answer`} value={a.text} onChange={(ev) => setA({ text: ev.target.value })} />
              </label>
            ) : null}
            {a.status === "none_with_basis" ? (
              <label className="block text-sm">Who checked, and when
                <input maxLength={200} className={input} aria-label={`${scope}${q.def.id} checked by`} value={a.checkedBy} onChange={(ev) => setA({ checkedBy: ev.target.value })} />
              </label>
            ) : null}
            {a.status !== "unresolved" ? (
              <label className="block text-sm">Supporting record (what was checked)
                <input maxLength={2000} className={input} aria-label={`${scope}${q.def.id} evidence`} value={a.evidence} onChange={(ev) => setA({ evidence: ev.target.value })} />
              </label>
            ) : null}
            {q.problems.length && a.status !== "unresolved" ? <p className="text-sm">{q.problems.join(" ")}</p> : null}
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm" data-testid="questions-summary">{unresolved.length === 0 ? "Every applicable question is answered; accounting review is still required." : `${unresolved.length} applicable question${unresolved.length === 1 ? "" : "s"} still need${unresolved.length === 1 ? "s" : ""} an answer.`}</p>
      {unresolved.length ? <ul className="space-y-2" aria-label="Unresolved questions">{unresolved.map(render)}</ul> : null}
      {resolved.length ? <details><summary className="text-sm">{resolved.length} answered question{resolved.length === 1 ? "" : "s"} (open to change one)</summary><ul className="mt-2 space-y-2" aria-label="Answered questions">{resolved.map(render)}</ul></details> : null}
    </div>
  );
}
