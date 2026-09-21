// Queue filters. Every control writes to the URL (via onChange), so a filtered view can be shared, bookmarked and survives a
// refresh. Search commits on submit (not per keystroke) so typing never fires a query per character.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SERVICE_CODES } from "@/lib/serviceEnquiry/contract";
import { countryOptions } from "@/lib/serviceEnquiry/jurisdictionPathways";
import { DEFAULT_QUEUE_FILTERS, ENQUIRY_STATUSES, SERVICE_LABELS, STATUS_LABELS, type QueueFilters } from "@/lib/serviceEnquiry/staffQueue";
import { SELECT_CLASS } from "../EnquiryFields";

interface Props {
  filters: QueueFilters;
  onChange: (next: QueueFilters) => void;
}

const toggle = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

export function QueueFiltersPanel({ filters, onChange }: Props) {
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const countries = useMemo(() => countryOptions(), []);
  const active = filters.status.length + filters.service.length + (filters.country ? 1 : 0) + (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.q ? 1 : 0);

  const commit = (patch: Partial<QueueFilters>) => onChange({ ...filters, ...patch, page: 1, id: filters.id });

  return (
    <section aria-label="Filter enquiries" className="space-y-5 rounded-lg border border-border bg-card p-4" data-testid="queue-filters">
      <form
        role="search"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          commit({ q: q.trim() });
        }}
        className="space-y-1.5"
      >
        <Label htmlFor="queue-search">Search reference, organisation or email</Label>
        <div className="flex gap-2">
          <Input id="queue-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} autoComplete="off" className="min-h-11" />
          <Button type="submit" variant="outline" className="min-h-11 shrink-0" aria-label="Search">
            <Search className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </form>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Status</legend>
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {ENQUIRY_STATUSES.map((s) => (
            <label key={s} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={filters.status.includes(s)} onChange={() => commit({ status: toggle(filters.status, s) })} />
              {STATUS_LABELS[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Service</legend>
        {SERVICE_CODES.map((s) => (
          <label key={s} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={filters.service.includes(s)} onChange={() => commit({ service: toggle(filters.service, s) })} />
            {SERVICE_LABELS[s]}
          </label>
        ))}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="queue-country">Jurisdiction</Label>
        <select id="queue-country" className={SELECT_CLASS} value={filters.country} onChange={(e) => commit({ country: e.target.value })}>
          <option value="">Any jurisdiction</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="queue-from">Submitted from</Label>
          <Input id="queue-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => commit({ from: e.target.value })} className="min-h-11" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="queue-to">Submitted to</Label>
          <Input id="queue-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => commit({ to: e.target.value })} className="min-h-11" />
        </div>
      </div>

      <Button type="button" variant="ghost" className="min-h-11 w-full" disabled={active === 0} onClick={() => onChange({ ...DEFAULT_QUEUE_FILTERS, id: filters.id })}>
        Clear filters{active > 0 ? ` (${active})` : ""}
      </Button>
    </section>
  );
}
