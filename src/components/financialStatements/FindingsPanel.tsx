/**
 * FindingsPanel — Phase 6: presents canonical rule-pack findings. Read-only:
 * it never re-evaluates or mutates a finding. Reviewer decisions are recorded
 * elsewhere through the canonical append-only decision model; a "resolved"
 * bucket only reflects a recorded decision and never hides the underlying
 * outcome, which stays visible on every row.
 */
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { affectedLineId, countByBucket, filterFindingViews, type FindingFilter, type FindingView } from "@/lib/financialStatementsWorkspace/findingsView";
import { formatMoney } from "@/lib/canonicalStatement/money";
import type { ObservedValue } from "@/lib/canonicalStatement/types";

const TABS: readonly { value: FindingFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "BLOCKING", label: "Blocking" },
  { value: "WARNING", label: "Warnings" },
  { value: "INSUFFICIENT_EVIDENCE", label: "Insufficient evidence" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "PASSED", label: "Passed controls" },
];

function renderObserved(value: ObservedValue): string {
  switch (value.kind) {
    case "MONEY":
      return value.value === null ? "missing" : `${value.value.currency} ${formatMoney(value.value)}`;
    case "COUNT":
    case "TEXT":
    case "PERIOD":
      return String(value.value);
  }
}

export function FindingsPanel({ views, onFocusLine }: { views: readonly FindingView[]; onFocusLine: (lineId: string) => void }) {
  const [filter, setFilter] = useState<FindingFilter>("ALL");
  const counts = useMemo(() => countByBucket(views), [views]);
  const visible = useMemo(() => filterFindingViews(views, filter), [views, filter]);

  return (
    <section aria-labelledby="fs-findings-heading" className="space-y-3">
      <h3 id="fs-findings-heading" className="text-base font-semibold text-foreground">
        Validation findings
      </h3>
      <Tabs value={filter} onValueChange={(v) => setFilter(v as FindingFilter)}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {t.value !== "ALL" && ` (${counts[t.value]})`}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings in this category.</p>
      ) : (
        <ul className="space-y-2">
          {visible.map(({ record, effectiveStatus, bucket }) => {
            const lineId = affectedLineId(record);
            return (
              <li key={record.evaluationId} className="border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={bucket === "BLOCKING" ? "destructive" : "secondary"}>{record.outcome.replace("_", " ")}</Badge>
                  <Badge variant="outline">{record.failureSeverity}</Badge>
                  <Badge variant="outline">{effectiveStatus.replace("_", " ")}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{record.ruleId}</span>
                </div>
                <p className="mt-2 text-foreground">{record.deterministicCalculation}</p>
                <p className="mt-1 text-xs text-muted-foreground">Expected: {record.expectedRelationship}</p>
                {Object.keys(record.observedValues).length > 0 && (
                  <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
                    {Object.entries(record.observedValues).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="tabular-nums text-foreground">{renderObserved(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {record.actionable && <p className="mt-2 text-xs text-foreground">{record.remediationGuidance}</p>}
                {lineId && (
                  <Button type="button" variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => onFocusLine(lineId)}>
                    Show affected line
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
