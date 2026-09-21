// Enquiry status as icon + word (never colour alone), plus the notification state chip. Notification state is deliberately a
// separate control from status: an unsent email says nothing about where the enquiry stands.

import { Archive, CheckCircle2, Clock, FileSearch, Inbox, Mail, MailWarning, Search, Send, ShieldAlert, Undo2, XCircle, type LucideIcon } from "lucide-react";
import { STATUS_LABELS, isEnquiryStatus, type EnquiryStatus } from "@/lib/serviceEnquiry/staffQueue";

const STATUS_ICON: Readonly<Record<EnquiryStatus, LucideIcon>> = {
  submitted: Inbox,
  triage: Search,
  awaiting_client: Clock,
  scoping: FileSearch,
  proposal_sent: Send,
  accepted: CheckCircle2,
  declined: XCircle,
  spam: ShieldAlert,
  withdrawn: Undo2,
  closed: Archive,
};

export function StatusBadge({ status }: { status: string }) {
  const known = isEnquiryStatus(status);
  const Icon = known ? STATUS_ICON[status] : Inbox;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-0.5 text-xs font-medium text-foreground" data-testid="status-badge" data-status={status}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {known ? STATUS_LABELS[status] : status}
    </span>
  );
}

const NOTIFICATION_WORDS: Readonly<Record<string, string>> = { sent: "sent", pending: "pending", unavailable: "unavailable", failed: "failed" };

export function NotificationChip({ label, state }: { label: string; state: string | null }) {
  const word = state ? (NOTIFICATION_WORDS[state] ?? state) : "none";
  const Icon = state === "sent" ? Mail : MailWarning;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="notification-chip" data-state={state ?? "none"}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {label}: {word}
    </span>
  );
}
