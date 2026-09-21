// Enquiry detail for platform staff: the full request and structured context, the complete event timeline, notification state,
// and the only three actions staff have — change status (server-validated against the transition matrix), assign, and add an
// append-only internal note. Internal notes are shown here and nowhere else; they are never sent to the requester.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { jurisdictionName } from "@/lib/jurisdiction/registry";
import { REPORT_TYPES, REPORTING_FREQUENCIES, SERVICE_CODES } from "@/lib/serviceEnquiry/contract";
import { REPORT_TYPE_LABELS, REPORTING_FREQUENCY_LABELS } from "@/lib/serviceEnquiry/copy";
import { FIELD_LABELS } from "@/lib/serviceEnquiry/formModel";
import {
  QueueError,
  SERVICE_LABELS,
  STATUS_LABELS,
  addEnquiryNote,
  assignEnquiry,
  getEnquiry,
  isEnquiryStatus,
  listStaff,
  notificationFailureNote,
  transitionEnquiry,
  type EnquiryDetail,
  type EnquiryStatus,
} from "@/lib/serviceEnquiry/staffQueue";
import { NotificationChip, StatusBadge } from "./StatusBadge";
import { SELECT_CLASS } from "../EnquiryFields";

const errorMessage = (e: unknown): string => {
  const kind = e instanceof QueueError ? e.kind : "unavailable";
  switch (kind) {
    case "forbidden":
      return "You no longer have permission to do this.";
    case "stale":
      return "Someone else changed this enquiry. It has been reloaded — please review it and try again.";
    case "invalid_transition":
      return "That status change is not permitted from the current status.";
    case "not_found":
      return "This enquiry could not be found.";
    case "invalid":
      return "Check the note: it must be 1–2000 characters without control characters.";
    default:
      return "Something went wrong. Please try again.";
  }
};

const labelledService = (code: string): string => {
  const known = SERVICE_CODES.find((c) => c === code);
  return known ? SERVICE_LABELS[known] : code;
};

function payloadValue(key: string, value: string): string {
  if (key === "report_type") {
    const known = REPORT_TYPES.find((t) => t === value);
    if (known) return REPORT_TYPE_LABELS[known];
  }
  if (key === "reporting_frequency") {
    const known = REPORTING_FREQUENCIES.find((f) => f === value);
    if (known) return REPORTING_FREQUENCY_LABELS[known];
  }
  return value;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

interface Props {
  id: string;
  onClose: () => void;
}

export function EnquiryDetailSheet({ id, onClose }: Props) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["enquiry", id], queryFn: () => getEnquiry(id), retry: false });
  const staff = useQuery({ queryKey: ["enquiry-staff"], queryFn: listStaff, retry: false, staleTime: 60_000 });
  const [transitionNote, setTransitionNote] = useState("");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["enquiry", id] });
    void qc.invalidateQueries({ queryKey: ["enquiry-list"] });
  };

  const move = useMutation({
    mutationFn: (to: EnquiryStatus) => transitionEnquiry(id, to, detail.data?.enquiry.status ?? "", transitionNote.trim() || null),
    onSuccess: () => {
      setTransitionNote("");
      toast.success("Status updated");
      refresh();
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refresh();
    },
  });
  const assign = useMutation({
    mutationFn: (who: string | null) => assignEnquiry(id, who, null),
    onSuccess: () => {
      toast.success("Assignment updated");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addNote = useMutation({
    mutationFn: () => addEnquiryNote(id, note.trim()),
    onSuccess: () => {
      setNote("");
      toast.success("Note added");
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d: EnquiryDetail | undefined = detail.data;
  const emailOf = (uid: string | null) => (uid ? (staff.data?.find((s) => s.user_id === uid)?.email ?? "another staff member") : "nobody");
  const currentAssignee = assignee ?? d?.enquiry.assigned_to_user_id ?? "";
  const busy = move.isPending || assign.isPending || addNote.isPending;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-testid="enquiry-detail">
        <SheetHeader className="text-left">
          <SheetTitle>{d ? d.enquiry.public_reference : "Enquiry"}</SheetTitle>
          <SheetDescription>{d ? d.enquiry.subject : "Loading the enquiry…"}</SheetDescription>
        </SheetHeader>

        {detail.isPending && (
          <div className="mt-6 space-y-3" role="status" aria-label="Loading enquiry">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {detail.isError && (
          <div className="mt-6 space-y-3" role="alert">
            <p className="text-sm text-destructive">{errorMessage(detail.error)}</p>
            <Button variant="outline" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {d && (
          <div className="mt-6 space-y-8">
            <section aria-labelledby="det-request" className="space-y-3">
              <h3 id="det-request" className="text-sm font-semibold text-foreground">
                Request
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={d.enquiry.status} />
                <span className="text-xs text-muted-foreground">Assigned to {emailOf(d.enquiry.assigned_to_user_id)}</span>
              </div>
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">Name</dt><dd>{d.enquiry.requester_name}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Email</dt><dd className="break-all">{d.enquiry.requester_email}{d.enquiry.requester_is_account ? " (signed-in account)" : ""}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Organisation</dt><dd>{d.enquiry.organization ?? "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Country</dt><dd>{d.enquiry.country_code ? jurisdictionName(d.enquiry.country_code) : "—"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Service</dt><dd>{labelledService(d.enquiry.service_code)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Received from</dt><dd>{d.enquiry.source_context.replace(/_/g, " ")}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Submitted</dt><dd>{when(d.enquiry.submitted_at)}</dd></div>
              </dl>
              <div>
                <p className="text-xs text-muted-foreground">Message</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm" data-testid="enquiry-message">{d.enquiry.message}</p>
              </div>
              {Object.keys(d.enquiry.payload).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Structured context (version {d.enquiry.payload_schema_version})</p>
                  <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-testid="enquiry-payload">
                    {Object.entries(d.enquiry.payload).map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-muted-foreground">{FIELD_LABELS[`payload.${k}`] ?? k}</dt>
                        <dd className="whitespace-pre-wrap break-words">{payloadValue(k, v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {d.notifications.map((n) => (
                  <NotificationChip key={n.kind} label={n.kind === "requester_acknowledgement" ? "Acknowledgement" : "Internal notice"} state={n.status} />
                ))}
              </div>
              {d.notifications.some((n) => notificationFailureNote(n.last_error_code)) && (
                <ul className="space-y-1 text-xs text-muted-foreground" data-testid="notification-notes">
                  {d.notifications.map((n) => {
                    const note = notificationFailureNote(n.last_error_code);
                    return note ? (
                      <li key={n.kind}>
                        {n.kind === "requester_acknowledgement" ? "Acknowledgement" : "Internal notice"}: {note}
                      </li>
                    ) : null;
                  })}
                </ul>
              )}
            </section>

            <section aria-labelledby="det-status" className="space-y-3">
              <h3 id="det-status" className="text-sm font-semibold text-foreground">Change status</h3>
              {d.allowed_transitions.length === 0 ? (
                <p className="text-sm text-muted-foreground">This status is final. No further changes are possible.</p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="det-transition-note">Reason or note (optional, internal)</Label>
                    <Textarea id="det-transition-note" rows={2} maxLength={2000} value={transitionNote} onChange={(e) => setTransitionNote(e.target.value)} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {d.allowed_transitions.filter(isEnquiryStatus).map((to) => (
                      <Button key={to} type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => move.mutate(to)}>
                        {move.isPending && move.variables === to && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                        Move to {STATUS_LABELS[to]}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section aria-labelledby="det-assign" className="space-y-3">
              <h3 id="det-assign" className="text-sm font-semibold text-foreground">Assignment</h3>
              <div className="space-y-1.5">
                <Label htmlFor="det-assignee">Assign to</Label>
                <select id="det-assignee" className={SELECT_CLASS} value={currentAssignee} onChange={(e) => setAssignee(e.target.value)} disabled={staff.isPending}>
                  <option value="">Nobody</option>
                  {staff.data?.map((s) => (
                    <option key={s.user_id} value={s.user_id}>
                      {s.email ?? s.user_id} ({s.staff_role === "manager" ? "manager" : "triage agent"})
                    </option>
                  ))}
                </select>
              </div>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy || currentAssignee === (d.enquiry.assigned_to_user_id ?? "")} onClick={() => assign.mutate(currentAssignee || null)}>
                Save assignment
              </Button>
            </section>

            <section aria-labelledby="det-note" className="space-y-3">
              <h3 id="det-note" className="text-sm font-semibold text-foreground">Internal note</h3>
              <p className="text-xs text-muted-foreground">Notes are append-only and visible to platform staff only. They are never shown or sent to the requester.</p>
              <div className="space-y-1.5">
                <Label htmlFor="det-note-text">Add a note</Label>
                <Textarea id="det-note-text" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <Button type="button" variant="outline" className="min-h-11" disabled={busy || note.trim() === ""} onClick={() => addNote.mutate()}>
                Add note
              </Button>
            </section>

            <section aria-labelledby="det-timeline" className="space-y-3">
              <h3 id="det-timeline" className="text-sm font-semibold text-foreground">Timeline</h3>
              <ol className="space-y-3" data-testid="enquiry-timeline">
                {d.events.map((ev) => (
                  <li key={ev.id} className="border-l-2 border-border pl-3 text-sm">
                    <p className="font-medium text-foreground">
                      {ev.event_kind === "submitted" && "Submitted"}
                      {ev.event_kind === "status_change" && `Status: ${labelOf(ev.previous_status)} → ${labelOf(ev.new_status)}`}
                      {ev.event_kind === "assignment" && `Assigned to ${emailOf(ev.assigned_to_user_id)}`}
                      {ev.event_kind === "note" && "Internal note"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ev.actor_kind === "staff" ? (ev.actor_email ?? "Staff") : ev.actor_kind === "requester" ? "Requester" : "System"} · {when(ev.created_at)}
                    </p>
                    {ev.note && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{ev.note}</p>}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

const labelOf = (s: string | null): string => (s && isEnquiryStatus(s) ? STATUS_LABELS[s] : (s ?? "—"));
