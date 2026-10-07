/** The period form's client-side checks (the server decides everything else). Pure. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** What the form still needs, in plain words (the server decides everything else). Pure. */
export function periodFormProblems(f: { start: string; end: string; currency: string; withPrior: boolean; priorStart: string; priorEnd: string }): string[] {
  const out: string[] = [];
  if (!ISO.test(f.start) || !ISO.test(f.end)) out.push("Enter the period's start and end dates.");
  else if (f.start > f.end) out.push("The start date must be on or before the end date.");
  if (!f.currency) out.push("Choose the reporting currency.");
  if (f.withPrior) {
    if (!ISO.test(f.priorStart) || !ISO.test(f.priorEnd)) out.push("Enter the prior period's start and end dates, or leave the prior period out.");
    else if (ISO.test(f.start) && f.priorEnd >= f.start) out.push("The prior period must end before this period starts.");
  }
  return out;
}
